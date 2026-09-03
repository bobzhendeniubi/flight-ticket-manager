/**
 * 按乘客调价（0722 公测反馈）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. groupPassengerAdjustments 纯函数：按乘客分桶 + 净额、整单调价归 wholeOrder、忽略非调价商品行。
 *   2. orderPriceAdjustmentBodySchema：金额/原因/passengerId 边界；「其它」须补说明。
 *   3. addPriceAdjustment 权限：CUSTOMER / 未带内部标的 AGENT → ForbiddenError（未触库）；
 *      带 viaAgentSelfSettlement 内部标的 AGENT（代理自助改结算价通道）→ 放行。
 *   4. addPriceAdjustment passengerId 归属校验：乘客不属于本单 → BadRequestError（事务内早拦）。
 *   5. addPriceAdjustment 结算价锁闸：锁定的单 → ConflictError（所有调用方共用这道闸）。
 *
 * 「计入 total / 审计流水追加 / 整单调价回归」需真 DB 全链路 —— 见
 * orders.passenger-adjustment.integration.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { create: vi.fn() },
    passenger: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService, groupPassengerAdjustments } from './orders.service.js';
import { BadRequestError, ConflictError, ForbiddenError } from '../../lib/errors.js';
import { orderPriceAdjustmentBodySchema } from './orders.schemas.js';

const service = new OrderService();

beforeEach(() => {
  vi.clearAllMocks();
});

// priceAdjustment 商品行的 metadata 打标（与 buildPriceAdjustmentItem 一致）。
function adjMeta(reasonCode: string) {
  return { priceAdjustment: true, reasonCode };
}

describe('groupPassengerAdjustments（纯函数）', () => {
  it('按乘客分桶 + 净额；整单调价归 wholeOrder；净额可正可负', () => {
    const items = [
      { id: 'i0', amount: 5000, description: '机票 A', passengerId: null, metadata: null }, // 基础行：忽略
      { id: 'i1', amount: 200, description: '价格调整：补收杂费（+¥200）', passengerId: 'p1', metadata: adjMeta('MISC_FEE') },
      { id: 'i2', amount: -80, description: '价格调整：优惠（−¥80）', passengerId: 'p1', metadata: adjMeta('DISCOUNT') },
      { id: 'i3', amount: 300, description: '价格调整：变更改期费（+¥300）', passengerId: 'p2', metadata: adjMeta('CHANGE') },
      { id: 'i4', amount: -500, description: '价格调整：优惠（−¥500）', passengerId: null, metadata: adjMeta('DISCOUNT') },
    ];
    const { byPassenger, wholeOrder } = groupPassengerAdjustments(items);

    expect(Object.keys(byPassenger).sort()).toEqual(['p1', 'p2']);
    expect(byPassenger.p1.netCny).toBe(120); // 200 − 80
    expect(byPassenger.p1.lines).toHaveLength(2);
    expect(byPassenger.p2.netCny).toBe(300);
    expect(wholeOrder.netCny).toBe(-500);
    expect(wholeOrder.lines).toHaveLength(1);
    // 每行归属如实保留（供前端「乘客卡片净调整小标」用）。
    expect(byPassenger.p1.lines[0].reasonCode).toBe('MISC_FEE');
  });

  it('无任何 priceAdjustment 行 → 空分组（纯基础行不误计入）', () => {
    const { byPassenger, wholeOrder } = groupPassengerAdjustments([
      { id: 'i0', amount: 5000, description: '机票', passengerId: null, metadata: { bundleDiscountPct: 10 } },
    ]);
    expect(Object.keys(byPassenger)).toHaveLength(0);
    expect(wholeOrder.lines).toHaveLength(0);
    expect(wholeOrder.netCny).toBe(0);
  });
});

describe('orderPriceAdjustmentBodySchema', () => {
  it('合法：正数 + MISC_FEE + passengerId', () => {
    const r = orderPriceAdjustmentBodySchema.safeParse({
      amountCny: 200,
      reasonCode: 'MISC_FEE',
      passengerId: 'p1',
    });
    expect(r.success).toBe(true);
  });

  it('合法：负数整单调价（不带 passengerId）', () => {
    const r = orderPriceAdjustmentBodySchema.safeParse({ amountCny: -500, reasonCode: 'DISCOUNT' });
    expect(r.success).toBe(true);
  });

  it('拒绝：金额为 0', () => {
    expect(orderPriceAdjustmentBodySchema.safeParse({ amountCny: 0, reasonCode: 'DISCOUNT' }).success).toBe(false);
  });

  it('拒绝：非整数金额', () => {
    expect(orderPriceAdjustmentBodySchema.safeParse({ amountCny: 12.5, reasonCode: 'MISC_FEE' }).success).toBe(false);
  });

  it('拒绝：「其它」原因未补说明', () => {
    expect(orderPriceAdjustmentBodySchema.safeParse({ amountCny: 100, reasonCode: 'OTHER' }).success).toBe(false);
    expect(
      orderPriceAdjustmentBodySchema.safeParse({ amountCny: 100, reasonCode: 'OTHER', reasonText: '手工核减' }).success,
    ).toBe(true);
  });
});

/** addPriceAdjustment 事务内用的 tx mock：一张 5000 元、未锁价的在售单。 */
function makeTx(orderOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'order-1' }]),
    order: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'order-1',
        orderNumber: 'FT-1',
        status: 'PENDING_PAYMENT',
        deletedAt: null,
        subtotal: new Prisma.Decimal(5000),
        total: new Prisma.Decimal(5000),
        adjustments: [],
        settlementLocked: false,
        items: [{ id: 'i0', amount: new Prisma.Decimal(5000) }],
        ...orderOverrides,
      }),
      update: vi.fn(),
    },
    orderItem: { create: vi.fn().mockResolvedValue({ id: 'i-new' }) },
    passenger: { findUnique: vi.fn() },
  };
}

describe('addPriceAdjustment · 权限与归属', () => {
  it('CUSTOMER → ForbiddenError（权限在事务外最先断言，绝不触库）', async () => {
    await expect(
      service.addPriceAdjustment('order-1', { amountCny: 200, reasonCode: 'MISC_FEE' }, {
        userId: 'u-customer',
        role: 'CUSTOMER' as never,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('AGENT 未带内部标 → ForbiddenError（公开的 POST /orders/:id/price-adjustment 照旧拒代理）', async () => {
    await expect(
      service.addPriceAdjustment('order-1', { amountCny: -200, reasonCode: 'DISCOUNT' }, {
        userId: 'u-agent',
        role: 'AGENT' as never,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('AGENT + viaAgentSelfSettlement → 放行（代理自助改结算价的内部通道）', async () => {
    const tx = makeTx();
    mockPrisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'FT-1',
      total: new Prisma.Decimal(4300),
      subtotal: new Prisma.Decimal(4300),
      taxesAndFees: new Prisma.Decimal(0),
      discountTotal: new Prisma.Decimal(0),
      paidAmount: new Prisma.Decimal(0),
      prepaymentOffset: new Prisma.Decimal(0),
      adjustmentCny: 0,
      items: [],
      passengers: [],
    });

    const result = await service.addPriceAdjustment(
      'order-1',
      { amountCny: -700, reasonCode: 'DISCOUNT', reasonText: '代理自助改结算价' },
      { userId: 'u-agent', role: 'AGENT' as never },
      { viaAgentSelfSettlement: true },
    );

    expect(tx.orderItem.create).toHaveBeenCalledTimes(1);
    expect(result.audit.amountCny).toBe(-700);
    // 差额行进 total：5000 − 700 = 4300
    expect(result.audit.after.total).toBe('4300');
  });

  it('结算价已锁定 → ConflictError，绝不落调整行（运营事后调价/议价确认/代理自助共用这道闸）', async () => {
    const tx = makeTx({ settlementLocked: true });
    mockPrisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));

    await expect(
      service.addPriceAdjustment('order-1', { amountCny: -200, reasonCode: 'DISCOUNT' }, {
        userId: 'u-staff',
        role: 'STAFF' as never,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(tx.orderItem.create).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('passengerId 不属于本单 → BadRequestError（事务内早拦，绝不落调整行）', async () => {
    // $transaction 直接以 tx mock 调用回调。
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'order-1' }]),
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'order-1',
          orderNumber: 'FT-1',
          status: 'PENDING_PAYMENT',
          deletedAt: null,
          subtotal: new Prisma.Decimal(5000),
          total: new Prisma.Decimal(5000),
          adjustments: [],
          items: [{ id: 'i0', amount: new Prisma.Decimal(5000) }],
        }),
        update: vi.fn(),
      },
      orderItem: { create: vi.fn() },
      // 关键：乘客属于另一张单 → service 应抛 BadRequestError。
      passenger: { findUnique: vi.fn().mockResolvedValue({ id: 'p-x', orderId: 'order-OTHER', fullName: '张三' }) },
    };
    mockPrisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));

    await expect(
      service.addPriceAdjustment('order-1', { amountCny: 200, reasonCode: 'MISC_FEE', passengerId: 'p-x' }, {
        userId: 'u-staff',
        role: 'STAFF' as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    // 归属校验失败 → 绝不创建调整行、绝不改单。
    expect(tx.orderItem.create).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});
