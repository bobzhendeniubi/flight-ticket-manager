/**
 * 挂账池列表 · 单元测试（vitest，fake prisma）
 *
 * 覆盖财务反馈的两处口径：
 *   - 认领明细 / 疑似归属订单要带**订单号**（对账台此前只显示订单 id 前 8 位，对不上单）；
 *     订单号一次批量查（IN），不是逐条 N+1；订单查不到时回 null 由前端回落。
 *   - orderHintId 精确筛：订单详情要问「挂账池里有没有本单待认领的流水」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const receiptFindMany = vi.fn();
const orderFindMany = vi.fn();

vi.mock('../../db/prisma.js', () => ({
  prisma: {
    receipt: { findMany: (...args: unknown[]) => receiptFindMany(...args) },
    order: { findMany: (...args: unknown[]) => orderFindMany(...args) },
  },
}));

import { Prisma, PaymentMethod, ReceiptSource, ReceiptStatus } from '@prisma/client';
import { ReceiptsService, loadOrderNumbers, serializeReceipt } from './receipts.service.js';

const service = new ReceiptsService();

/** 一条挂账池进账行（含认领明细），字段与 prisma include:{allocations:true} 同形。 */
function receiptRow(over: {
  id: string;
  receiptNo: string;
  amountCny: number;
  allocatedCny?: number;
  orderHintId?: string | null;
  status?: ReceiptStatus;
  allocations?: Array<{ id: string; orderId: string; amountCny: number }>;
}) {
  return {
    id: over.id,
    receiptNo: over.receiptNo,
    amountCny: new Prisma.Decimal(over.amountCny),
    allocatedCny: new Prisma.Decimal(over.allocatedCny ?? 0),
    method: PaymentMethod.WECHAT_PAY,
    proofUrl: null,
    payerNote: null,
    externalTxnId: null,
    orderHintId: over.orderHintId ?? null,
    receivedAt: new Date('2026-08-01T02:00:00.000Z'),
    source: ReceiptSource.STATEMENT_IMPORT,
    status: over.status ?? ReceiptStatus.OPEN,
    refundNote: null,
    createdById: null,
    createdAt: new Date('2026-08-01T02:00:00.000Z'),
    updatedAt: new Date('2026-08-01T02:00:00.000Z'),
    allocations: (over.allocations ?? []).map((a) => ({
      id: a.id,
      receiptId: over.id,
      orderId: a.orderId,
      amountCny: new Prisma.Decimal(a.amountCny),
      createdById: null,
      createdAt: new Date('2026-08-01T03:00:00.000Z'),
    })),
  };
}

beforeEach(() => {
  receiptFindMany.mockReset();
  orderFindMany.mockReset();
  orderFindMany.mockResolvedValue([]);
});

describe('loadOrderNumbers', () => {
  it('去重 + 过滤空值后一次 IN 查询；空列表不打库', async () => {
    orderFindMany.mockResolvedValue([{ id: 'o1', orderNumber: 'FT20260801001' }]);
    const map = await loadOrderNumbers(['o1', 'o1', null, undefined, '']);
    expect(orderFindMany).toHaveBeenCalledTimes(1);
    expect(orderFindMany.mock.calls[0][0].where.id.in).toEqual(['o1']);
    expect(map.get('o1')).toBe('FT20260801001');

    orderFindMany.mockClear();
    const empty = await loadOrderNumbers([null, undefined]);
    expect(orderFindMany).not.toHaveBeenCalled();
    expect(empty.size).toBe(0);
  });
});

describe('serializeReceipt', () => {
  it('无映射时订单号回 null（不编造），既有字段口径不变', () => {
    const out = serializeReceipt(
      receiptRow({
        id: 'r1',
        receiptNo: 'RCP20260801AAAA',
        amountCny: 1000,
        allocatedCny: 400,
        orderHintId: 'o1',
        allocations: [{ id: 'a1', orderId: 'o1', amountCny: 400 }],
      }),
    );
    expect(out.hintOrderNumber).toBeNull();
    expect(out.allocations[0].orderNumber).toBeNull();
    expect(out.allocations[0].orderId).toBe('o1');
    expect(out.remainingCny).toBe('600.00');
  });
});

describe('ReceiptsService.list', () => {
  it('认领明细与疑似归属订单都带上订单号，且订单只批量查一次', async () => {
    receiptFindMany.mockResolvedValue([
      receiptRow({
        id: 'r1',
        receiptNo: 'RCP20260801AAAA',
        amountCny: 1000,
        allocatedCny: 1000,
        status: ReceiptStatus.ALLOCATED,
        allocations: [
          { id: 'a1', orderId: 'o1', amountCny: 600 },
          { id: 'a2', orderId: 'o2', amountCny: 400 },
        ],
      }),
      receiptRow({ id: 'r2', receiptNo: 'RCP20260801BBBB', amountCny: 500, orderHintId: 'o3' }),
    ]);
    orderFindMany.mockResolvedValue([
      { id: 'o1', orderNumber: 'FT20260801001' },
      { id: 'o2', orderNumber: 'FT20260801002' },
      { id: 'o3', orderNumber: 'FT20260801003' },
    ]);

    const rows = await service.list({});

    expect(orderFindMany).toHaveBeenCalledTimes(1);
    expect([...orderFindMany.mock.calls[0][0].where.id.in].sort()).toEqual(['o1', 'o2', 'o3']);
    expect(rows[0].allocations.map((a) => a.orderNumber)).toEqual([
      'FT20260801001',
      'FT20260801002',
    ]);
    expect(rows[1].hintOrderNumber).toBe('FT20260801003');
    // 原始 id 保留（前端 title 显示完整 id，订单号缺失时也能回落）
    expect(rows[1].orderHintId).toBe('o3');
  });

  it('订单已被删除 / 查不到时订单号回 null，不影响这条流水返回', async () => {
    receiptFindMany.mockResolvedValue([
      receiptRow({
        id: 'r1',
        receiptNo: 'RCP20260801AAAA',
        amountCny: 100,
        allocatedCny: 100,
        allocations: [{ id: 'a1', orderId: 'gone', amountCny: 100 }],
      }),
    ]);
    orderFindMany.mockResolvedValue([]);

    const rows = await service.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0].allocations[0].orderNumber).toBeNull();
    expect(rows[0].allocations[0].orderId).toBe('gone');
  });

  it('orderHintId 精确筛进 where（等值，不是模糊匹配）', async () => {
    receiptFindMany.mockResolvedValue([]);
    await service.list({ orderHintId: 'o1' });
    expect(receiptFindMany.mock.calls[0][0].where.orderHintId).toBe('o1');
  });

  it('orderHintId 与 unallocatedOnly 可叠加：只回未认完且疑似本单的流水', async () => {
    receiptFindMany.mockResolvedValue([]);
    await service.list({ orderHintId: 'o1', unallocatedOnly: '1' });
    const where = receiptFindMany.mock.calls[0][0].where;
    expect(where.orderHintId).toBe('o1');
    expect(where.status).toEqual({
      in: [ReceiptStatus.OPEN, ReceiptStatus.PARTIALLY_ALLOCATED],
    });
  });

  it('不传 orderHintId 时不加该过滤（列表口径不变）', async () => {
    receiptFindMany.mockResolvedValue([]);
    await service.list({ q: 'RCP' });
    expect(receiptFindMany.mock.calls[0][0].where.orderHintId).toBeUndefined();
  });
});
