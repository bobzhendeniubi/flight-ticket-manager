/**
 * 已付款族「钱已撤干净」直接取消 · 纯判定 + 批量判定 + 状态机元数据下发（vitest）
 *
 * 口径：PAID / PROCESSING / TICKETED / CHANGE_REQUESTED / CHANGED 的单，当且仅当
 * 净收款 ≤ 0、无进行中退款、预存余额抵扣已退回，才允许运营不带强制改为「已取消」。
 */
import { describe, it, expect, vi } from 'vitest';
import { OrderStatus, PrepaymentTxType, Prisma, RefundStatus } from '@prisma/client';

// orders.service 顶层引用 prisma —— mock 掉，避免测试连库（serializeOrder 本身不查库）。
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  PAID_FAMILY_DIRECT_CANCEL_FROM,
  assessPaidDirectCancel,
  findPaidDirectCancelEligibleIds,
  type PaidDirectCancelFacts,
} from './paid-direct-cancel.js';
import { ALLOWED_TRANSITIONS, serializeOrder } from './orders.service.js';

const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);

function facts(overrides: Partial<PaidDirectCancelFacts> = {}): PaidDirectCancelFacts {
  return {
    status: OrderStatus.PAID,
    paidAmount: dec(0),
    prepaymentOffset: dec(0),
    completedRefundsCny: 0,
    openRefundCount: 0,
    balanceOffsetOutstandingCny: 0,
    ...overrides,
  };
}

describe('assessPaidDirectCancel · 纯判定', () => {
  it.each(PAID_FAMILY_DIRECT_CANCEL_FROM)('%s：净收 0 + 无退款 + 无余额抵扣 → 可直接取消', (status) => {
    expect(assessPaidDirectCancel(facts({ status }))).toEqual({ ok: true });
  });

  it('已收 1000、已完成退款 1000 → 净收 0，可直接取消', () => {
    expect(
      assessPaidDirectCancel(facts({ paidAmount: dec(1000), completedRefundsCny: 1000 })),
    ).toEqual({ ok: true });
  });

  it('净收款 > 0 → 拒，原因写明还剩多少钱并指向退款通道', () => {
    const v = assessPaidDirectCancel(facts({ paidAmount: dec(500) }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('¥500.00');
    expect(v.reason).toMatch(/退款/);
  });

  it('只差一分钱也不放行', () => {
    expect(assessPaidDirectCancel(facts({ paidAmount: dec(0.01) })).ok).toBe(false);
  });

  it('旧列 prepaymentOffset 同样算钱在单上（与已收净额唯一口径一致）', () => {
    expect(assessPaidDirectCancel(facts({ prepaymentOffset: dec(200) })).ok).toBe(false);
  });

  it('有进行中退款 → 拒（即使净收为 0）', () => {
    const v = assessPaidDirectCancel(facts({ openRefundCount: 1 }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/进行中的退款申请/);
  });

  it('代理余额抵扣未退回 → 拒（即使 paidAmount 已被压到 0）', () => {
    const v = assessPaidDirectCancel(facts({ balanceOffsetOutstandingCny: 300 }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('¥300.00');
    expect(v.reason).toMatch(/预存余额/);
  });

  it.each([
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.REFUND_REQUESTED,
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
  ])('%s 不在已付款族：不适用本口径', (status) => {
    expect(assessPaidDirectCancel(facts({ status })).ok).toBe(false);
  });
});

type RefundGroup = {
  orderId: string;
  status: RefundStatus;
  _sum: { amount: Prisma.Decimal | null };
  _count: { _all: number };
};
type LedgerRow = { orderId: string | null; type: PrepaymentTxType; amount: Prisma.Decimal };

function fakeDb(refundGroups: RefundGroup[], ledger: LedgerRow[]) {
  const refundGroupBy = vi.fn(async () => refundGroups);
  const ledgerFindMany = vi.fn(async ({ where }: { where: { orderId: { in: string[] } } }) =>
    ledger.filter((r) => r.orderId && where.orderId.in.includes(r.orderId)),
  );
  const db = {
    refund: { groupBy: refundGroupBy },
    prepaymentTransaction: { findMany: ledgerFindMany },
  } as unknown as Parameters<typeof findPaidDirectCancelEligibleIds>[0];
  return { db, refundGroupBy, ledgerFindMany };
}

const row = (id: string, status: OrderStatus, paid: number) => ({
  id,
  status,
  paidAmount: dec(paid),
  prepaymentOffset: dec(0),
});

describe('findPaidDirectCancelEligibleIds · 列表批量判定', () => {
  it('没有已付款族的行 → 零查询', async () => {
    const { db, refundGroupBy, ledgerFindMany } = fakeDb([], []);
    const ids = await findPaidDirectCancelEligibleIds(db, [
      row('a', OrderStatus.PENDING_PAYMENT, 0),
      row('b', OrderStatus.CANCELLED, 0),
    ]);
    expect(ids.size).toBe(0);
    expect(refundGroupBy).not.toHaveBeenCalled();
    expect(ledgerFindMany).not.toHaveBeenCalled();
  });

  it('全部行净收款 > 0 → 只发退款聚合一条，不查余额流水', async () => {
    const { db, refundGroupBy, ledgerFindMany } = fakeDb([], []);
    const ids = await findPaidDirectCancelEligibleIds(db, [
      row('a', OrderStatus.PAID, 1000),
      row('b', OrderStatus.TICKETED, 20),
    ]);
    expect(ids.size).toBe(0);
    expect(refundGroupBy).toHaveBeenCalledTimes(1);
    expect(ledgerFindMany).not.toHaveBeenCalled();
  });

  it('详情已联查 refunds → 直接用，不发退款聚合（进行中退款照样拦）', async () => {
    const { db, refundGroupBy } = fakeDb([], []);
    const ids = await findPaidDirectCancelEligibleIds(db, [
      { ...row('clean', OrderStatus.PAID, 0), refunds: [] },
      {
        ...row('refunding', OrderStatus.PAID, 0),
        refunds: [{ status: RefundStatus.APPROVED, amount: dec(0) }],
      },
      {
        ...row('refunded-flat', OrderStatus.TICKETED, 500),
        refunds: [
          { status: RefundStatus.COMPLETED, amount: dec(500) },
          { status: RefundStatus.REJECTED, amount: dec(500) },
        ],
      },
    ]);
    expect([...ids].sort()).toEqual(['clean', 'refunded-flat']);
    expect(refundGroupBy).not.toHaveBeenCalled();
  });

  it('逐单按口径判定：净收 0 放行、有钱/有进行中退款/余额抵扣未退回的拒、已退平的放行', async () => {
    const { db, ledgerFindMany } = fakeDb(
      [
        { orderId: 'refunding', status: RefundStatus.REQUESTED, _sum: { amount: dec(0) }, _count: { _all: 1 } },
        { orderId: 'refunded-flat', status: RefundStatus.COMPLETED, _sum: { amount: dec(800) }, _count: { _all: 1 } },
      ],
      [
        { orderId: 'offset-open', type: PrepaymentTxType.OFFSET, amount: dec(-300) },
        { orderId: 'offset-back', type: PrepaymentTxType.OFFSET, amount: dec(-300) },
        { orderId: 'offset-back', type: PrepaymentTxType.REFUND, amount: dec(300) },
      ],
    );
    const ids = await findPaidDirectCancelEligibleIds(db, [
      row('clean', OrderStatus.PAID, 0),
      row('money', OrderStatus.PROCESSING, 100),
      row('refunding', OrderStatus.PAID, 0),
      row('refunded-flat', OrderStatus.CHANGED, 800),
      row('offset-open', OrderStatus.PAID, 0),
      row('offset-back', OrderStatus.CHANGE_REQUESTED, 0),
      row('pending', OrderStatus.PENDING_PAYMENT, 0),
    ]);
    expect([...ids].sort()).toEqual(['clean', 'offset-back', 'refunded-flat']);
    // 余额流水只查通过前两条口径的幸存行
    const queried = (ledgerFindMany.mock.calls[0][0] as { where: { orderId: { in: string[] } } }).where
      .orderId.in;
    expect([...queried].sort()).toEqual(['clean', 'offset-back', 'offset-open', 'refunded-flat']);
  });
});

function buildOrder(status: OrderStatus) {
  return {
    id: 'ord_1',
    orderNumber: 'CO-TEST-1',
    status,
    subtotal: dec(1000),
    taxesAndFees: dec(0),
    discountTotal: dec(0),
    total: dec(1000),
    paidAmount: dec(0),
    prepaymentOffset: dec(0),
    adjustmentCny: 0,
    items: [],
    passengers: [],
  };
}

describe('serializeOrder · allowedTransitions 按单附加「已取消」', () => {
  it('命中可直接取消集合 → 在权威表之外附加 CANCELLED（前端下拉自动出现「已取消」）', () => {
    const out = serializeOrder(buildOrder(OrderStatus.PAID), {
      paidDirectCancelEligibleIds: new Set(['ord_1']),
    }) as Record<string, unknown>;
    expect(out.allowedTransitions).toEqual([...ALLOWED_TRANSITIONS.PAID, OrderStatus.CANCELLED]);
  });

  it('未命中 / 未传集合 → 与权威表逐条一致（fail-closed）', () => {
    const miss = serializeOrder(buildOrder(OrderStatus.PAID), {
      paidDirectCancelEligibleIds: new Set(['other']),
    }) as Record<string, unknown>;
    expect(miss.allowedTransitions).toEqual(ALLOWED_TRANSITIONS.PAID);
    const none = serializeOrder(buildOrder(OrderStatus.TICKETED)) as Record<string, unknown>;
    expect(none.allowedTransitions).toEqual(ALLOWED_TRANSITIONS.TICKETED);
  });

  it('非已付款族即使误入集合也不附加（终态仍是空集）', () => {
    const out = serializeOrder(buildOrder(OrderStatus.COMPLETED), {
      paidDirectCancelEligibleIds: new Set(['ord_1']),
    }) as Record<string, unknown>;
    expect(out.allowedTransitions).toEqual([]);
  });
});
