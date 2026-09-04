/**
 * 批量收款复核锁 + 批量事后调价 · 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. 入参口径：orderIds 1~500、重复 id 收敛成一份、按人调价的原因/金额沿用单单那套校验。
 *   2. batchSetPaymentsLock：不存在 / 回收站 / 已是目标状态逐单跳过，其余照改（不整批失败）。
 *   3. batchAddPriceAdjustment：PER_PAX 按占座人数乘（婴儿不计）、锁价单与死单跳过、
 *      乘出来顶破单笔上限的单跳过、非运营身份直接 403。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus, PassengerType, Prisma, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    order: { findUnique: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
    orderItem: { create: vi.fn() },
    passenger: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import { ForbiddenError } from '../../lib/errors.js';
import {
  batchPaymentsLockBodySchema,
  batchPriceAdjustmentBodySchema,
} from './orders.schemas.js';

const service = new OrderService();
const OPS = { userId: 'staff-1', role: UserRole.STAFF };

/** 事务替身：$transaction(cb, opts) 直接把 tx 交给回调（真实事务语义由集成测试覆盖）。 */
function runInTx(tx: unknown): void {
  mockPrisma.$transaction.mockImplementation(
    async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('批量入参口径', () => {
  it('orderIds 1~500，重复 id 收敛成一份（勾选列表重复带上来不是错误）', () => {
    expect(() => batchPaymentsLockBodySchema.parse({ orderIds: [], locked: true })).toThrow();
    expect(() =>
      batchPaymentsLockBodySchema.parse({
        orderIds: Array.from({ length: 501 }, (_, i) => `o${i}`),
        locked: true,
      }),
    ).toThrow();
    expect(
      batchPaymentsLockBodySchema.parse({ orderIds: ['o1', 'o1', 'o2'], locked: true }).orderIds,
    ).toEqual(['o1', 'o2']);
  });

  it('locked 必须是布尔值', () => {
    expect(() => batchPaymentsLockBodySchema.parse({ orderIds: ['o1'], locked: 'true' })).toThrow();
  });

  it('批量调价沿用单单那套金额/原因口径（0 金额拒绝、其它必须写说明）', () => {
    const base = { orderIds: ['o1'], mode: 'PER_PAX' as const };
    expect(() =>
      batchPriceAdjustmentBodySchema.parse({ ...base, amountCny: 0, reasonCode: 'MISC_FEE' }),
    ).toThrow();
    expect(() =>
      batchPriceAdjustmentBodySchema.parse({ ...base, amountCny: 40, reasonCode: 'OTHER' }),
    ).toThrow();
    expect(() =>
      batchPriceAdjustmentBodySchema.parse({ ...base, amountCny: 40, reasonCode: 'MISC_FEE' }),
    ).not.toThrow();
    expect(() =>
      batchPriceAdjustmentBodySchema.parse({
        ...base,
        mode: 'WHATEVER',
        amountCny: 40,
        reasonCode: 'MISC_FEE',
      }),
    ).toThrow();
  });
});

describe('OrderService.batchSetPaymentsLock', () => {
  interface LockRow {
    id: string;
    orderNumber: string;
    paymentsLocked: boolean;
    deletedAt: Date | null;
  }

  function txFor(rows: Record<string, LockRow>) {
    return {
      $queryRaw: vi.fn(async (_strings: TemplateStringsArray, id: string) =>
        rows[id] ? [rows[id]] : [],
      ),
      order: { update: mockPrisma.order.update },
    };
  }

  it('混合批：可改的改、其余逐单带回跳过原因（不整批失败）', async () => {
    const tx = txFor({
      o1: { id: 'o1', orderNumber: 'ORD-001', paymentsLocked: false, deletedAt: null },
      o2: { id: 'o2', orderNumber: 'ORD-002', paymentsLocked: true, deletedAt: null },
      o3: { id: 'o3', orderNumber: 'ORD-003', paymentsLocked: false, deletedAt: new Date() },
    });
    runInTx(tx);
    mockPrisma.order.update.mockResolvedValue({});

    const res = await service.batchSetPaymentsLock(['o2', 'missing', 'o1', 'o3'], true, 'staff-1');

    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(3);
    expect(mockPrisma.order.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o1' },
        data: expect.objectContaining({ paymentsLocked: true, paymentsLockedBy: 'staff-1' }),
      }),
    );
    const byId = Object.fromEntries(res.results.map((r) => [r.orderId, r]));
    expect(byId.o1).toMatchObject({ ok: true, orderNumber: 'ORD-001', beforeLocked: false });
    expect(byId.o2).toMatchObject({ ok: false, reason: '收款已是锁定状态' });
    expect(byId.o3).toMatchObject({ ok: false, reason: '订单在回收站，请先恢复' });
    expect(byId.missing).toMatchObject({ ok: false, orderNumber: null, reason: '订单不存在' });
  });

  it('已是解锁状态的单在 locked=false 时跳过，只改真正需要改的那一单', async () => {
    const tx = txFor({
      o1: { id: 'o1', orderNumber: 'ORD-001', paymentsLocked: false, deletedAt: null },
      o2: { id: 'o2', orderNumber: 'ORD-002', paymentsLocked: true, deletedAt: null },
    });
    runInTx(tx);
    mockPrisma.order.update.mockResolvedValue({});

    const res = await service.batchSetPaymentsLock(['o1', 'o2'], false, 'staff-1');

    expect(res).toMatchObject({ updated: 1, skipped: 1 });
    expect(mockPrisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o2' },
        data: { paymentsLocked: false, paymentsLockedAt: null, paymentsLockedBy: null },
      }),
    );
    expect(res.results.find((r) => r.orderId === 'o1')).toMatchObject({
      ok: false,
      reason: '收款已是解锁状态',
    });
  });

  it('按 id 排序后逐单加锁（并发批次排队而不是交叉死锁）', async () => {
    const tx = txFor({
      a1: { id: 'a1', orderNumber: 'ORD-A', paymentsLocked: false, deletedAt: null },
      b2: { id: 'b2', orderNumber: 'ORD-B', paymentsLocked: false, deletedAt: null },
      c3: { id: 'c3', orderNumber: 'ORD-C', paymentsLocked: false, deletedAt: null },
    });
    runInTx(tx);
    mockPrisma.order.update.mockResolvedValue({});

    await service.batchSetPaymentsLock(['c3', 'a1', 'b2'], true, 'staff-1');

    expect(tx.$queryRaw.mock.calls.map((c) => c[1])).toEqual(['a1', 'b2', 'c3']);
  });
});

describe('OrderService.batchAddPriceAdjustment', () => {
  interface OrderFixture {
    orderNumber: string;
    status?: OrderStatus;
    deletedAt?: Date | null;
    settlementLocked?: boolean;
    subtotal?: number;
    passengers?: PassengerType[];
  }

  function txFor(orders: Record<string, OrderFixture>) {
    return {
      $queryRaw: vi.fn(async (_strings: TemplateStringsArray, id: string) =>
        orders[id] ? [{ id, orderNumber: orders[id].orderNumber }] : [],
      ),
      order: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          const o = orders[where.id];
          if (!o) return null;
          const subtotal = o.subtotal ?? 1000;
          return {
            id: where.id,
            orderNumber: o.orderNumber,
            status: o.status ?? OrderStatus.PAID,
            deletedAt: o.deletedAt ?? null,
            subtotal: new Prisma.Decimal(subtotal),
            total: new Prisma.Decimal(subtotal),
            adjustments: null,
            settlementLocked: o.settlementLocked ?? false,
            items: [{ id: `${where.id}-i1`, amount: new Prisma.Decimal(subtotal) }],
          };
        }),
        update: mockPrisma.order.update,
      },
      orderItem: { create: mockPrisma.orderItem.create },
      passenger: {
        findMany: vi.fn(async ({ where }: { where: { orderId: string } }) =>
          (orders[where.orderId]?.passengers ?? [PassengerType.ADULT]).map((t) => ({
            passengerType: t,
          })),
        ),
        findUnique: mockPrisma.passenger.findUnique,
      },
    };
  }

  const feeInput = { mode: 'PER_PAX' as const, amountCny: 40, reasonCode: 'MISC_FEE' as const };

  beforeEach(() => {
    mockPrisma.orderItem.create.mockImplementation(async () => ({ id: 'item-new' }));
    mockPrisma.order.update.mockResolvedValue({});
  });

  it('PER_PAX 按占座人数乘：成人+占座儿童算钱，婴儿不占座不收', async () => {
    const tx = txFor({
      o1: {
        orderNumber: 'ORD-001',
        passengers: [PassengerType.ADULT, PassengerType.CHILD, PassengerType.INFANT],
      },
    });
    runInTx(tx);

    const res = await service.batchAddPriceAdjustment(['o1'], feeInput, OPS);

    // 3 位出行人里只有 2 位占座 → 40 × 2 = 80（按 3 人算就是当场多收一个婴儿的钱）
    expect(res).toMatchObject({ updated: 1, skipped: 0 });
    expect(res.results[0]).toMatchObject({ orderId: 'o1', ok: true, appliedAmountCny: 80 });
    const created = mockPrisma.orderItem.create.mock.calls[0][0];
    expect(Number(created.data.amount.toString())).toBe(80);
    expect(created.data.passengerId).toBeNull();
    // 差额行进 subtotal/total：1000 + 80
    expect(mockPrisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o1' },
        data: expect.objectContaining({ subtotal: new Prisma.Decimal(1080) }),
      }),
    );
  });

  it('PER_ORDER 按整单一笔，不乘人数', async () => {
    const tx = txFor({
      o1: {
        orderNumber: 'ORD-001',
        passengers: [PassengerType.ADULT, PassengerType.ADULT, PassengerType.ADULT],
      },
    });
    runInTx(tx);

    const res = await service.batchAddPriceAdjustment(
      ['o1'],
      { ...feeInput, mode: 'PER_ORDER' },
      OPS,
    );

    expect(res.results[0]).toMatchObject({ ok: true, appliedAmountCny: 40 });
    expect(tx.passenger.findMany).not.toHaveBeenCalled();
    expect(Number(mockPrisma.orderItem.create.mock.calls[0][0].data.amount.toString())).toBe(40);
  });

  it('混合批：锁价单 / 死单 / 回收站单 / 找不到的 id 逐单跳过，其余照做', async () => {
    const tx = txFor({
      o1: { orderNumber: 'ORD-001' },
      o2: { orderNumber: 'ORD-002', settlementLocked: true },
      o3: { orderNumber: 'ORD-003', status: OrderStatus.CANCELLED },
      o4: { orderNumber: 'ORD-004', deletedAt: new Date() },
    });
    runInTx(tx);

    const res = await service.batchAddPriceAdjustment(
      ['o1', 'o2', 'o3', 'o4', 'missing'],
      feeInput,
      OPS,
    );

    expect(res).toMatchObject({ updated: 1, skipped: 4 });
    expect(mockPrisma.orderItem.create).toHaveBeenCalledTimes(1);
    const byId = Object.fromEntries(res.results.map((r) => [r.orderId, r]));
    expect(byId.o1).toMatchObject({ ok: true, appliedAmountCny: 40 });
    expect(byId.o2).toMatchObject({ ok: false, reason: '结算价已锁定，请先解锁再修改' });
    expect(byId.o3.reason).toContain('不能记录收款');
    expect(byId.o4.reason).toContain('回收站');
    expect(byId.missing).toMatchObject({ ok: false, orderNumber: null, reason: '订单不存在' });
    // 跳过的单一律不落金额
    for (const id of ['o2', 'o3', 'o4', 'missing']) {
      expect(byId[id].appliedAmountCny).toBeNull();
    }
  });

  it('全是婴儿的单没有占座人数 → 跳过（按人调价无从计算）', async () => {
    const tx = txFor({ o1: { orderNumber: 'ORD-001', passengers: [PassengerType.INFANT] } });
    runInTx(tx);

    const res = await service.batchAddPriceAdjustment(['o1'], feeInput, OPS);

    expect(res).toMatchObject({ updated: 0, skipped: 1 });
    expect(res.results[0].reason).toContain('没有占座客人');
    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
  });

  it('每人金额乘出来顶破单笔上限 → 跳过（单单入口会拒的金额，批量不能悄悄写进去）', async () => {
    const tx = txFor({
      o1: {
        orderNumber: 'ORD-001',
        passengers: Array.from({ length: 4 }, () => PassengerType.ADULT),
      },
    });
    runInTx(tx);

    const res = await service.batchAddPriceAdjustment(
      ['o1'],
      { ...feeInput, amountCny: 30_000 },
      OPS,
    );

    expect(res).toMatchObject({ updated: 0, skipped: 1 });
    expect(res.results[0].reason).toContain('超出单笔调整上限');
    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
  });

  // ── 按人口径的单价还原位（M4）────────────────────────────────────────────
  // 落库的是乘出来的合计。事后只看「+¥80」，财务与客服都答不上「每人多少 × 几个人」——
  // 单价必须同时写进调整行描述（客人在详情页看得到）与批量回执（路由据此写审计）。
  it('PER_PAX：调整行描述带「每人 ¥X × N 人」，回执带 unitAmountCny / seatPax', async () => {
    const tx = txFor({
      o1: {
        orderNumber: 'ORD-001',
        passengers: [PassengerType.ADULT, PassengerType.CHILD, PassengerType.INFANT],
      },
    });
    runInTx(tx);

    const res = await service.batchAddPriceAdjustment(['o1'], feeInput, OPS);

    expect(mockPrisma.orderItem.create.mock.calls[0][0].data.description).toBe(
      '价格调整：补收杂费（+¥80）（每人 ¥40 × 2 人）',
    );
    expect(res.results[0]).toMatchObject({ unitAmountCny: 40, seatPax: 2 });
  });

  it('PER_PAX 负数（按人优惠）：描述里的单价取绝对值，方向由合计的减号表达', async () => {
    const tx = txFor({
      o1: { orderNumber: 'ORD-001', passengers: [PassengerType.ADULT, PassengerType.ADULT] },
    });
    runInTx(tx);

    await service.batchAddPriceAdjustment(
      ['o1'],
      { mode: 'PER_PAX', amountCny: -200, reasonCode: 'DISCOUNT', reasonText: '老客回馈' },
      OPS,
    );

    expect(mockPrisma.orderItem.create.mock.calls[0][0].data.description).toBe(
      '价格调整：优惠（−¥400）（每人 ¥200 × 2 人）：老客回馈',
    );
  });

  it('PER_ORDER：描述一字不变（整单口径本来就没有「每人」），回执两位还原位为 null', async () => {
    const tx = txFor({
      o1: { orderNumber: 'ORD-001', passengers: [PassengerType.ADULT, PassengerType.ADULT] },
    });
    runInTx(tx);

    const res = await service.batchAddPriceAdjustment(
      ['o1'],
      { ...feeInput, mode: 'PER_ORDER' },
      OPS,
    );

    expect(mockPrisma.orderItem.create.mock.calls[0][0].data.description).toBe(
      '价格调整：补收杂费（+¥40）',
    );
    expect(res.results[0]).toMatchObject({ unitAmountCny: null, seatPax: null });
  });

  it('跳过的单也带回单价还原位：顶破上限时能看出「每人多少 × 几个人」才顶破的', async () => {
    const tx = txFor({
      o1: {
        orderNumber: 'ORD-001',
        passengers: Array.from({ length: 4 }, () => PassengerType.ADULT),
      },
    });
    runInTx(tx);

    const res = await service.batchAddPriceAdjustment(
      ['o1'],
      { ...feeInput, amountCny: 30_000 },
      OPS,
    );

    expect(res.results[0]).toMatchObject({ ok: false, unitAmountCny: 30_000, seatPax: 4 });
  });

  it.each([UserRole.AGENT, UserRole.CUSTOMER])('role=%s 直接拒绝，且不开事务', async (role) => {
    await expect(
      service.batchAddPriceAdjustment(['o1'], feeInput, { userId: 'u1', role }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
