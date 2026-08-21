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
const receiptAggregate = vi.fn();
const orderFindMany = vi.fn();

vi.mock('../../db/prisma.js', () => ({
  prisma: {
    receipt: {
      findMany: (...args: unknown[]) => receiptFindMany(...args),
      aggregate: (...args: unknown[]) => receiptAggregate(...args),
    },
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
  receiptAggregate.mockReset();
  orderFindMany.mockReset();
  orderFindMany.mockResolvedValue([]);
  receiptAggregate.mockResolvedValue({
    _count: { _all: 0 },
    _sum: { amountCny: null, allocatedCny: null },
  });
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

  /**
   * 退款后「未认余额」必须归零。
   * refund() 只翻 status 不动 allocatedCny，所以 amount − allocated 仍是正数——
   * 这笔钱已经退回客户了，再算作「待认领」财务就会把挂账池余额当成比实际多。
   * （界面 KPI 早就排除了 REFUNDED，导出没排除 → 两处口径打架，更容易误导。）
   */
  it('已退款进账：未认余额归零（钱已退回客户，不再是待认领）', () => {
    const out = serializeReceipt(
      receiptRow({
        id: 'r-refunded',
        receiptNo: 'RCP20260801RRRR',
        amountCny: 1000,
        allocatedCny: 300, // 认了 300 给订单，剩下 700 退回客户
        status: ReceiptStatus.REFUNDED,
        allocations: [{ id: 'a1', orderId: 'o1', amountCny: 300 }],
      }),
    );
    expect(out.remainingCny).toBe('0.00');
    // 已认金额保持诚实：退款不是认领，绝不把 300 抬成 1000（那会与「认到订单」列自相矛盾）
    expect(out.allocatedCny).toBe('300');
    expect(out.allocations).toHaveLength(1);
  });

  it('未退款进账：未认余额照旧 = 金额 − 已认（归零只对 REFUNDED 生效）', () => {
    const out = serializeReceipt(
      receiptRow({
        id: 'r-partial',
        receiptNo: 'RCP20260801PPPP',
        amountCny: 1000,
        allocatedCny: 300,
        status: ReceiptStatus.PARTIALLY_ALLOCATED,
      }),
    );
    expect(out.remainingCny).toBe('700.00');
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

    const { receipts: rows } = await service.list({});

    expect(orderFindMany).toHaveBeenCalledTimes(1);
    expect([...orderFindMany.mock.calls[0][0].where.id.in].sort()).toEqual(['o1', 'o2', 'o3']);
    expect(rows[0].allocations.map((a) => a.orderNumber)).toEqual([
      'FT20260801001',
      'FT20260801002',
    ]);
    expect(rows[1].hintOrderNumber).toBe('FT20260801003');
    // 原始 id 保留（前端 title 显示完整 id，订单号缺失时也能回落）
    expect(rows[1].orderHintId).toBe('o3');
    // 同一条进账被「最近窗口」与「未认领全量」两条查询同时取到时只出现一次（合并去重）
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2']);
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

    const { receipts: rows } = await service.list({});
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

/**
 * 挂账池「未认领的钱不许静默消失」——核对表导出早就为此做了全量分页，
 * 列表/KPI 这侧此前还停在「按到账时间倒序取最近 500 条**任意状态**」。
 * 流水导入每天几百行时，已认款记录很快占满窗口，更早的未认款流水就从
 * 「待认领」页签和「挂账余额」KPI 里无声消失，那笔钱等于不存在了。
 */
describe('ReceiptsService.list · 未认领流水不被最近窗口挤掉', () => {
  /** 按 where.status 分流：最近窗口（无 status 收窄）vs 未认领子集查询。 */
  function routeFindMany(recent: unknown[], unallocated: unknown[]): void {
    receiptFindMany.mockImplementation((args: { where?: { status?: { in?: string[] } } }) => {
      const statusIn = args?.where?.status?.in;
      const isUnallocatedQuery =
        Array.isArray(statusIn) && statusIn.includes(ReceiptStatus.OPEN);
      return Promise.resolve(isUnallocatedQuery ? unallocated : recent);
    });
  }

  it('最近窗口被已认款记录占满时，更早的未认款流水仍然出现在列表里', async () => {
    // 最近窗口里全是已认款记录（模拟 500 条窗口被占满）
    const recent = [
      receiptRow({
        id: 'r-new',
        receiptNo: 'RCP20260810NEW0',
        amountCny: 100,
        allocatedCny: 100,
        status: ReceiptStatus.ALLOCATED,
      }),
    ];
    // 窗口之外、更早的一笔未认款流水 —— 修复前它根本回不来
    const older = receiptRow({
      id: 'r-old-open',
      receiptNo: 'RCP20260701OLD0',
      amountCny: 700,
      status: ReceiptStatus.OPEN,
    });
    older.receivedAt = new Date('2026-07-01T02:00:00.000Z');
    routeFindMany(recent, [older]);

    const { receipts } = await service.list({});
    expect(receipts.map((r) => r.id)).toContain('r-old-open');
    // 到账时间倒序：新的在前，被捞回来的旧未认款在后
    expect(receipts.map((r) => r.id)).toEqual(['r-new', 'r-old-open']);
  });

  it('挂账余额 KPI 走服务端全量聚合（Σ金额 − Σ已认），不在被截断的行上求和', async () => {
    routeFindMany([], []);
    receiptAggregate.mockResolvedValue({
      _count: { _all: 137 },
      _sum: { amountCny: new Prisma.Decimal(98_000), allocatedCny: new Prisma.Decimal(1_500) },
    });

    const { receipts, summary } = await service.list({});
    // 行一条没回，合计照样是全量真值 —— 这正是「KPI 不能在行上求和」的意思
    expect(receipts).toHaveLength(0);
    expect(summary.unallocatedCount).toBe(137);
    expect(summary.unallocatedRemainingCny).toBe('96500.00');
    expect(summary.unallocatedTruncated).toBe(false);
    // 聚合只统计未认完状态，不含已认款/已退款
    expect(receiptAggregate.mock.calls[0][0].where.status).toEqual({
      in: [ReceiptStatus.OPEN, ReceiptStatus.PARTIALLY_ALLOCATED],
    });
  });

  it('未认领行超过返回上限 → unallocatedTruncated=true 明说，绝不静默截断', async () => {
    // 服务端多取 1 条用于探顶：给它 1001 条即触顶
    const many = Array.from({ length: 1001 }, (_, i) =>
      receiptRow({ id: `u${i}`, receiptNo: `RCP2026080${i}`, amountCny: 1 }),
    );
    routeFindMany([], many);

    const { receipts, summary } = await service.list({});
    expect(summary.unallocatedTruncated).toBe(true);
    expect(receipts).toHaveLength(1000); // 探顶用的那条不进结果
  });

  it('显式筛「已认款」时不强塞未认领行，也不跑未认领聚合（尊重筛选）', async () => {
    routeFindMany([], []);
    const { summary } = await service.list({ status: ReceiptStatus.ALLOCATED });
    expect(receiptFindMany).toHaveBeenCalledTimes(1); // 只有最近窗口那一次
    expect(receiptAggregate).not.toHaveBeenCalled();
    expect(summary.unallocatedCount).toBe(0);
    expect(summary.unallocatedRemainingCny).toBe('0.00');
  });
});
