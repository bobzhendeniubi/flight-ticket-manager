/**
 * 退款待打款队列 + 实付登记 · 单测（vitest，mock Prisma）
 *
 * 钉死的是「钱会不会被打两次」这件事：
 *   · 队列只收「已核准且没登记过打款」的退款，账龄从核准日算、长的排前面；
 *   · 登记幂等**且拒绝**——重复标记返回 409 并把上一次的登记时间带出来，绝不静默成功
 *     （静默成功等于把「打了一次」和「打了两次」抹成同一个界面）；
 *   · 状态闸 fail-closed：在途 / 被拒的退款一律不许登记打款；
 *   · 登记只写那五列，绝不碰 status / amount。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import {
  listPendingRefundPayouts,
  markRefundPaid,
  PAYOUT_OVERDUE_DAYS,
} from './finances.refund-payout.js';

const NOW = new Date('2026-09-05T02:00:00.000Z');

interface RefundRowFixture {
  id: string;
  amount: number;
  reason?: string | null;
  createdAt: string;
  processedAt?: string | null;
  swapRefund?: boolean;
  orderNumber: string;
  contactName?: string;
  agency?: { companyName: string | null; contactName: string } | null;
}

function refundRow(f: RefundRowFixture) {
  return {
    id: f.id,
    amount: f.amount,
    reason: f.reason ?? null,
    createdAt: new Date(f.createdAt),
    processedAt: f.processedAt ? new Date(f.processedAt) : null,
    gatewayPayload: f.swapRefund ? { swapRefund: true, swapFeeCny: 300 } : null,
    order: {
      id: `order-of-${f.id}`,
      orderNumber: f.orderNumber,
      contactName: f.contactName ?? '张客人',
      agent: f.agency ?? null,
    },
  };
}

function queueClient(rows: ReturnType<typeof refundRow>[]) {
  return { refund: { findMany: vi.fn(async () => rows) } } as unknown as PrismaClient;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('listPendingRefundPayouts · 待打款队列', () => {
  it('带出单号/金额/申请日/核准日/账龄，账龄按核准日算并给出超期笔数', async () => {
    const client = queueClient([
      refundRow({
        id: 'rf-old',
        amount: 1200,
        orderNumber: 'FTM-A1',
        createdAt: '2026-08-18T02:00:00.000Z',
        processedAt: '2026-08-20T02:00:00.000Z', // 距 9/5 共 16 天
        agency: { companyName: '某某旅行社', contactName: '联系人' },
      }),
      refundRow({
        id: 'rf-new',
        amount: 800.5,
        orderNumber: 'FTM-A2',
        createdAt: '2026-09-01T02:00:00.000Z',
        processedAt: '2026-09-03T02:00:00.000Z', // 2 天
        swapRefund: true,
      }),
    ]);

    const res = await listPendingRefundPayouts(client, NOW);
    expect(res.rows).toHaveLength(2);

    const old = res.rows[0];
    expect(old.orderNumber).toBe('FTM-A1');
    expect(old.amountCny).toBe(1200);
    expect(old.requestedAt).toBe('2026-08-18T02:00:00.000Z');
    expect(old.approvedAt).toBe('2026-08-20T02:00:00.000Z');
    expect(old.ageDays).toBe(16);
    expect(old.agencyLabel).toBe('某某旅行社');
    expect(old.isSwapRefund).toBe(false);

    const fresh = res.rows[1];
    expect(fresh.ageDays).toBe(2);
    expect(fresh.agencyLabel).toBeNull(); // 直客
    expect(fresh.isSwapRefund).toBe(true);

    expect(res.totalAmountCny).toBe(2000.5);
    expect(res.overdueCount).toBe(1); // 只有 16 天那笔达到阈值
    expect(PAYOUT_OVERDUE_DAYS).toBe(7);
  });

  it('只查「已核准 + 未登记打款 + 订单未删」，条件写死在查询里', async () => {
    const findMany = vi.fn(async () => []);
    const client = { refund: { findMany } } as unknown as PrismaClient;
    await listPendingRefundPayouts(client, NOW);
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = (findMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where;
    expect(where).toMatchObject({
      status: 'COMPLETED',
      paidAt: null,
      order: { deletedAt: null },
    });
  });

  it('没有核准日的老数据用申请日算账龄，不当成 0 天', async () => {
    const client = queueClient([
      refundRow({
        id: 'rf-legacy',
        amount: 100,
        orderNumber: 'FTM-OLD',
        createdAt: '2026-08-26T02:00:00.000Z',
        processedAt: null,
      }),
    ]);
    const res = await listPendingRefundPayouts(client, NOW);
    expect(res.rows[0].approvedAt).toBeNull();
    expect(res.rows[0].ageDays).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * markRefundPaid 的 Prisma 替身：$transaction 把自己交回去，
 * $queryRaw 返回 FOR UPDATE 查到的那一行（由 state 决定），update 落回 state。
 */
function payoutClient(state: {
  status: string;
  paidAt: Date | null;
  paidByUserId?: string | null;
  matches?: boolean;
}) {
  const updateSpy = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    state.paidAt = data.paidAt as Date;
    return {
      id: 'rf-1',
      amount: 1200,
      paidAt: data.paidAt as Date,
      paidMethod: data.paidMethod as string,
      paidTxnRef: (data.paidTxnRef as string | null) ?? null,
      paidNote: (data.paidNote as string | null) ?? null,
      order: { orderNumber: 'FTM-A1' },
    };
  });
  const client = {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
    $queryRaw: vi.fn(async () =>
      state.matches === false
        ? []
        : [
            {
              id: 'rf-1',
              status: state.status,
              paidAt: state.paidAt,
              paidByUserId: state.paidByUserId ?? null,
            },
          ],
    ),
    refund: { update: updateSpy },
  };
  return { client: client as unknown as PrismaClient, updateSpy };
}

const INPUT = {
  orderId: 'order-1',
  refundId: 'rf-1',
  paidMethod: 'BANK' as const,
  paidTxnRef: '  TXN-0000-0042  ',
  paidNote: '  原路退回  ',
  paidByUserId: 'usr-finance',
};

beforeEach(() => vi.clearAllMocks());

describe('markRefundPaid · 实付登记', () => {
  it('首次登记成功：只写打款五列，trim 后落库，status / amount 一个字不改', async () => {
    const { client, updateSpy } = payoutClient({ status: 'COMPLETED', paidAt: null });
    const res = await markRefundPaid(
      { ...INPUT, paidAt: new Date('2026-09-04T02:00:00.000Z') },
      client,
    );
    expect(res).toMatchObject({
      refundId: 'rf-1',
      orderNumber: 'FTM-A1',
      amountCny: 1200,
      paidAt: '2026-09-04T02:00:00.000Z',
      paidMethod: 'BANK',
      paidTxnRef: 'TXN-0000-0042',
      paidNote: '原路退回',
    });
    const data = (updateSpy.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(Object.keys(data).sort()).toEqual(
      ['paidAt', 'paidByUserId', 'paidMethod', 'paidNote', 'paidTxnRef'].sort(),
    );
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('amount');
  });

  it('重复标记 → 409 拒绝，并带出上一次的登记时间与登记人（不静默成功）', async () => {
    const already = new Date('2026-09-03T02:00:00.000Z');
    const { client, updateSpy } = payoutClient({
      status: 'COMPLETED',
      paidAt: already,
      paidByUserId: 'usr-other',
    });
    await expect(markRefundPaid(INPUT, client)).rejects.toMatchObject({
      statusCode: 409,
      details: { paidAt: already.toISOString(), paidByUserId: 'usr-other' },
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('同一笔连点两次：第二次被自己写下的 paidAt 拦住（行锁 + 幂等闸）', async () => {
    const { client, updateSpy } = payoutClient({ status: 'COMPLETED', paidAt: null });
    await markRefundPaid(INPUT, client);
    await expect(markRefundPaid(INPUT, client)).rejects.toMatchObject({ statusCode: 409 });
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('未核准 / 已拒绝的退款不许登记打款（fail-closed）', async () => {
    for (const status of ['REQUESTED', 'APPROVED', 'PROCESSING', 'REJECTED']) {
      const { client, updateSpy } = payoutClient({ status, paidAt: null });
      await expect(markRefundPaid(INPUT, client)).rejects.toMatchObject({ statusCode: 400 });
      expect(updateSpy).not.toHaveBeenCalled();
    }
  });

  it('退款不属于这张订单 → 404（用 orderId + refundId 双条件锁行）', async () => {
    const { client } = payoutClient({ status: 'COMPLETED', paidAt: null, matches: false });
    await expect(markRefundPaid(INPUT, client)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('打款时间填到未来 → 400（钱不可能在未来打出去）', async () => {
    const { client } = payoutClient({ status: 'COMPLETED', paidAt: null });
    await expect(
      markRefundPaid({ ...INPUT, paidAt: new Date(Date.now() + 3 * 60 * 60 * 1000) }, client),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('流水号/备注留空 → 落 null，不存空字符串', async () => {
    const { client } = payoutClient({ status: 'COMPLETED', paidAt: null });
    const res = await markRefundPaid({ ...INPUT, paidTxnRef: '   ', paidNote: undefined }, client);
    expect(res.paidTxnRef).toBeNull();
    expect(res.paidNote).toBeNull();
  });
});
