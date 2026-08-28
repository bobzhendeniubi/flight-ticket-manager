/**
 * 每人结算价（perPassengerSettlementCny）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 业务口径（票务反馈）：同单多人结算价不同，录单逐人填价，不必先均摊再到订单详情逐人补差。
 * 实现口径：**不是手填每人价格的口子**——落库仍走差额模型：取 min(每人价) 为基准，
 *   · 整单按「Σ每人价」走既有 SETTLEMENT 收敛（整单差额行）；
 *   · 逐人挂「该人价 − min」的非负 SETTLEMENT 差额行（metadata.perPassenger，事务内回填 passengerId）。
 * 订单详情「每人结算价」派生口径（基准每人 = (total − Σ按乘客净额)/人数）恰好还原所填逐人价。
 *
 * 覆盖：
 *   1. buildPerPassengerSettlementItem：FEE 行、描述可读、metadata 打标（perPassenger/快照/序号）。
 *   2. schema：负元素 / 三位小数 / 空数组拒绝；合法数组通过。
 *   3. 权限：游客 / CUSTOMER / AGENT 携带 → 无权调整订单价格（400），不触库。
 *   4. 互斥/等长：与 settlementTotalCny、priceAdjustment 同时传 → 400；与 passengers 数不一致 → 400。
 *   5. 全链路（mock Prisma）：差额分解正确（逐人行 + 整单收敛行 + 总额 = Σ每人价）、
 *      passengerId 事务内回填到正确乘客、全员同价不生成逐人行、逐人差额超 cap 拒绝。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 在 import OrderService 之前 mock 依赖（vi.mock 会被 hoist） ──
const { mockPrisma } = vi.hoisted(() => {
  const prisma = {
    order: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    orderItem: { findMany: vi.fn(), update: vi.fn() },
    orderCostItem: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    seatLock: { aggregate: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    fulfillmentTask: { findFirst: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { mockPrisma: prisma };
});

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../queues/queue.js', () => ({
  scheduleSeatHoldRelease: vi.fn(),
  cancelSeatLockExpiry: vi.fn(),
}));

import { OrderService, buildPerPassengerSettlementItem } from './orders.service.js';
import { BadRequestError } from '../../lib/errors.js';
import {
  createOrderBodySchema,
  PRICE_ADJUSTMENT_CAP_CNY,
  type CreateOrderBody,
} from './orders.schemas.js';

const ADMIN = { userId: 'u-admin', role: 'ADMIN' } as const;

// 三位乘客（重名重证件场景另测）：与 perPassengerSettlementCny 同序。
const threePax = [
  { fullName: '张三', documentNumber: 'E1000001', dateOfBirth: '1990-01-01', nationality: 'CN' },
  { fullName: '李四', documentNumber: 'E1000002', dateOfBirth: '1991-01-01', nationality: 'CN' },
  { fullName: '王五', documentNumber: 'E1000003', dateOfBirth: '1992-01-01', nationality: 'CN' },
];

const baseBody = {
  contactName: '联系人',
  contactPhone: '13800000000',
  items: [{ kind: 'TRANSFER', description: '接送', quantity: 3, unitPrice: 1000 }],
  passengers: threePax,
} as unknown as CreateOrderBody;

/** 建 service 并 spy 掉定价/护照/查重，权威合计固定为 authoritativeTotal。 */
function makeService(authoritativeTotal: number): OrderService {
  const service = new OrderService();
  const priced = [
    {
      kind: 'TRANSFER' as const,
      description: '接送',
      quantity: 1,
      unitPrice: authoritativeTotal,
      amount: authoritativeTotal,
    },
  ];
  const anyService = service as unknown as Record<string, unknown>;
  vi.spyOn(anyService as never, 'assertNoDuplicatePassengersOnFlights' as never).mockResolvedValue(
    [] as never,
  );
  vi.spyOn(anyService as never, 'priceAndValidateItems' as never).mockResolvedValue(priced as never);
  vi.spyOn(anyService as never, 'applyPassportExpiryRule' as never).mockResolvedValue(
    undefined as never,
  );
  return service;
}

type CreatedItemRow = {
  kind: string;
  description: string;
  amount: { toString(): string };
  metadata?: Record<string, unknown>;
  passengerId?: string | null;
};

function itemsPassedToCreate(): CreatedItemRow[] {
  const call = mockPrisma.order.create.mock.calls[0];
  return (call[0] as { data: { items: { create: CreatedItemRow[] } } }).data.items.create;
}

function totalPassedToCreate(): number {
  const call = mockPrisma.order.create.mock.calls[0];
  return Number((call[0] as { data: { total: { toString(): string } } }).data.total.toString());
}

function perPaxRows(items: CreatedItemRow[]): CreatedItemRow[] {
  return items.filter((it) => it.metadata?.perPassenger === true);
}

function wholeSettlementRow(items: CreatedItemRow[]): CreatedItemRow | undefined {
  return items.find(
    (it) => it.metadata?.reasonCode === 'SETTLEMENT' && it.metadata?.perPassenger !== true,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma),
  );
  mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });
  mockPrisma.seatLock.findMany.mockResolvedValue([]);
  mockPrisma.orderCostItem.create.mockResolvedValue({});
  mockPrisma.orderItem.update.mockResolvedValue({});
  mockPrisma.auditLog.create.mockResolvedValue({});
  // createVisaTaskAtCreation（best-effort）：无订单项 → 直接 return []
  mockPrisma.order.findUnique.mockResolvedValue(null);
  mockPrisma.orderItem.findMany.mockResolvedValue([]);
  // tx.order.create 回显传入 data，并给行/乘客补 id —— passengerId 回填按
  // 「fullName|documentNumber」匹配落库乘客，回显必须带 id 才能走到 update。
  mockPrisma.order.create.mockImplementation(
    async (args: {
      data: {
        orderNumber: string;
        total: unknown;
        paymentExpiresAt: Date | null;
        items: { create: Array<Record<string, unknown>> };
        passengers: { create: Array<Record<string, unknown>> };
      };
    }) => ({
      id: 'order-1',
      orderNumber: args.data.orderNumber,
      total: args.data.total,
      paymentExpiresAt: args.data.paymentExpiresAt,
      items: args.data.items.create.map((it, i) => ({ ...it, id: `item-${i}` })),
      passengers: args.data.passengers.create.map((px, i) => ({ ...px, id: `pax-${i}` })),
      statusEvents: [],
    }),
  );
});

describe('buildPerPassengerSettlementItem', () => {
  it('FEE 行、描述可读、metadata 打标（perPassenger + 快照 + 序号）', () => {
    const row = buildPerPassengerSettlementItem({
      diffCny: 48,
      settlementPerPaxCny: 1348,
      basePerPaxCny: 1300,
      perPaxIndex: 1,
    });
    expect(row.kind).toBe('FEE');
    expect(row.amount).toBe(48);
    expect(row.unitPrice).toBe(48);
    expect(row.quantity).toBe(1);
    expect(row.totalCostCny).toBe(0);
    expect(row.description).toBe('价格调整：代理结算价（+¥48）');
    expect(row.metadata).toMatchObject({
      priceAdjustment: true,
      reasonCode: 'SETTLEMENT',
      settlementPrice: true,
      perPassenger: true,
      settlementPerPaxCny: 1348,
      basePerPaxCny: 1300,
      perPaxIndex: 1,
    });
  });
});

describe('createOrderBodySchema.perPassengerSettlementCny 校验', () => {
  const withPerPax = (v: unknown) => ({
    ...(baseBody as unknown as Record<string, unknown>),
    perPassengerSettlementCny: v,
  });

  it('合法数组通过（整数与两位小数混填、0 允许）', () => {
    expect(createOrderBodySchema.safeParse(withPerPax([1300, 1348.5, 0])).success).toBe(true);
  });

  it('负元素拒绝', () => {
    expect(createOrderBodySchema.safeParse(withPerPax([1300, -1, 1400])).success).toBe(false);
  });

  it('三位小数拒绝', () => {
    expect(createOrderBodySchema.safeParse(withPerPax([1300.125, 1348, 1400])).success).toBe(false);
  });

  it('空数组拒绝（要么不传，传了至少一项）', () => {
    expect(createOrderBodySchema.safeParse(withPerPax([])).success).toBe(false);
  });
});

describe('createOrder · perPassengerSettlementCny 权限与互斥/等长（服务端按认证身份判）', () => {
  const bodyWithPerPax = {
    ...(baseBody as unknown as Record<string, unknown>),
    perPassengerSettlementCny: [1300, 1348, 1400],
  } as unknown as CreateOrderBody;
  const service = new OrderService();

  it('游客携带 → 无权调整订单价格，且未触库', async () => {
    await expect(
      service.createOrder(bodyWithPerPax, { guest: { name: '游客', phone: '13800000000' } }),
    ).rejects.toThrow('无权调整订单价格');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('CUSTOMER 携带 → 无权调整订单价格', async () => {
    await expect(
      service.createOrder(bodyWithPerPax, { userId: 'u-cust', role: 'CUSTOMER' }),
    ).rejects.toThrow('无权调整订单价格');
  });

  it('AGENT 携带 → 无权调整订单价格（代理不能自定逐人价）', async () => {
    await expect(
      service.createOrder(bodyWithPerPax, { userId: 'u-agent', role: 'AGENT', agentId: 'a1' }),
    ).rejects.toThrow('无权调整订单价格');
  });

  it('与 settlementTotalCny 同时传 → 400（互斥）', async () => {
    const both = {
      ...(bodyWithPerPax as unknown as Record<string, unknown>),
      settlementTotalCny: 4048,
    } as unknown as CreateOrderBody;
    await expect(service.createOrder(both, ADMIN)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('与 priceAdjustment 同时传 → 400（互斥，避免双重调价）', async () => {
    const both = {
      ...(bodyWithPerPax as unknown as Record<string, unknown>),
      priceAdjustment: { amountCny: -100, reasonCode: 'DISCOUNT' },
    } as unknown as CreateOrderBody;
    await expect(service.createOrder(both, ADMIN)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('数组长度 ≠ 乘客数 → 400（钱会挂错人，直接拒）', async () => {
    const mismatch = {
      ...(baseBody as unknown as Record<string, unknown>),
      perPassengerSettlementCny: [1300, 1348],
    } as unknown as CreateOrderBody;
    await expect(service.createOrder(mismatch, ADMIN)).rejects.toThrow('一一对应');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('createOrder · perPassengerSettlementCny 差额分解（ADMIN，mock 全链路）', () => {
  it('逐人价 [1300,1348,1400] · 系统价 3000 → 逐人 +48/+100 行 + 整单收敛行 900，总额 4048', async () => {
    const service = makeService(3000);
    const body = {
      ...(baseBody as unknown as Record<string, unknown>),
      perPassengerSettlementCny: [1300, 1348, 1400],
    } as unknown as CreateOrderBody;

    await service.createOrder(body, ADMIN);

    const items = itemsPassedToCreate();
    const perPax = perPaxRows(items);
    // min=1300 基准：张三无差额不生成行；李四 +48（序号 1）、王五 +100（序号 2）
    expect(perPax).toHaveLength(2);
    expect(perPax.map((r) => Number(r.amount.toString()))).toEqual([48, 100]);
    expect(perPax.map((r) => r.metadata?.perPaxIndex)).toEqual([1, 2]);
    expect(perPax.map((r) => r.metadata?.settlementPerPaxCny)).toEqual([1348, 1400]);
    expect(perPax.every((r) => r.metadata?.basePerPaxCny === 1300)).toBe(true);

    // 整单 SETTLEMENT 收敛行：diff = Σ每人价 − (系统价 + Σ逐人差额) = 4048 − 3148 = 900
    const whole = wholeSettlementRow(items);
    expect(whole).toBeTruthy();
    expect(Number(whole!.amount.toString())).toBe(900);

    // 总额 = Σ每人价；派生口径还原：基准每人 = (4048 − 148)/3 = 1300 = min ✓
    expect(totalPassedToCreate()).toBe(4048);
  });

  it('passengerId 事务内回填：逐人行 update 到与提交数组同序的落库乘客', async () => {
    const service = makeService(3000);
    const body = {
      ...(baseBody as unknown as Record<string, unknown>),
      perPassengerSettlementCny: [1300, 1348, 1400],
    } as unknown as CreateOrderBody;

    await service.createOrder(body, ADMIN);

    // 回显乘客 id 为 pax-0/1/2（与提交同序）；李四(序号1)→pax-1、王五(序号2)→pax-2。
    const updates = mockPrisma.orderItem.update.mock.calls.map(
      (c) => c[0] as { where: { id: string }; data: { passengerId: string } },
    );
    expect(updates).toHaveLength(2);
    expect(updates.map((u) => u.data.passengerId).sort()).toEqual(['pax-1', 'pax-2']);
  });

  it('全员同价 → 不生成逐人行，整单按 Σ每人价收敛（与 settlementTotalCny 同口径）', async () => {
    const service = makeService(3000);
    const body = {
      ...(baseBody as unknown as Record<string, unknown>),
      perPassengerSettlementCny: [1200, 1200, 1200],
    } as unknown as CreateOrderBody;

    await service.createOrder(body, ADMIN);

    const items = itemsPassedToCreate();
    expect(perPaxRows(items)).toHaveLength(0);
    const whole = wholeSettlementRow(items);
    expect(Number(whole!.amount.toString())).toBe(600); // 3600 − 3000
    expect(totalPassedToCreate()).toBe(3600);
    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
  });

  it('逐人差额超调价上限 → 400，不建单', async () => {
    const service = makeService(3000);
    const body = {
      ...(baseBody as unknown as Record<string, unknown>),
      perPassengerSettlementCny: [0, 0, PRICE_ADJUSTMENT_CAP_CNY + 1],
    } as unknown as CreateOrderBody;

    await expect(service.createOrder(body, ADMIN)).rejects.toThrow('超出调价上限');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('重名重证件的两位乘客：逐人行仍能各自落到不同乘客（多重集匹配，不因撞 key 跳过回填）', async () => {
    const service = makeService(2000);
    const body = {
      ...(baseBody as unknown as Record<string, unknown>),
      items: [{ kind: 'TRANSFER', description: '接送', quantity: 2, unitPrice: 1000 }],
      passengers: [
        { fullName: '张三', documentNumber: 'E1000001', dateOfBirth: '1990-01-01', nationality: 'CN' },
        { fullName: '张三', documentNumber: 'E1000001', dateOfBirth: '1990-01-01', nationality: 'CN' },
      ],
      perPassengerSettlementCny: [1100, 1300],
    } as unknown as CreateOrderBody;

    await service.createOrder(body, ADMIN);

    // min=1100：只有第二位有 +200 差额行；重名两人可互换（金额一致），但必须真挂上乘客。
    const updates = mockPrisma.orderItem.update.mock.calls.map(
      (c) => c[0] as { data: { passengerId: string } },
    );
    expect(updates).toHaveLength(1);
    expect(['pax-0', 'pax-1']).toContain(updates[0].data.passengerId);
  });
});
