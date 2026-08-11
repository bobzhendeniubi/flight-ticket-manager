/**
 * 本单结算总价（settlementTotalCny）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 业务口径：代理单与代理谈定整单一口价，录单时直接填「本单结算总价」，系统照此收钱。
 * 实现口径：服务端权威定价不破坏——绝不改各明细行价格，只按「结算价 − 权威合计」自动生成
 *           一条 reasonCode=SETTLEMENT 的差额调价行（原价/差额留痕可审计），总额=Σitems 不变。
 *
 * 覆盖：
 *   1. buildSettlementTotalItem：负差额=DISCOUNT / 正差额=FEE，描述可读，metadata 打标。
 *   2. schema：settlementTotalCny 负数/三位小数拒绝；人工调价下拉不得出现 SETTLEMENT。
 *   3. 权限：游客 / CUSTOMER / AGENT 携带 settlementTotalCny 一律 BadRequestError（400）。
 *   4. 互斥：settlementTotalCny 与 priceAdjustment 同时传 → BadRequestError（400）。
 *   5. 全链路（mock Prisma）：负/正差额生成对应行且总额=结算价；diff=0 不生成行；超 cap 拒绝。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 在 import OrderService 之前 mock 依赖（vi.mock 会被 hoist） ──
const { mockPrisma } = vi.hoisted(() => {
  const prisma = {
    // update：syncOrderHasReturnLeg 在建单事务内回写物化列 hasReturnLeg
    order: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    orderItem: { findMany: vi.fn() },
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

import { OrderService, buildSettlementTotalItem } from './orders.service.js';
import { BadRequestError } from '../../lib/errors.js';
import {
  createOrderBodySchema,
  priceAdjustmentSchema,
  PRICE_ADJUSTMENT_CAP_CNY,
  type CreateOrderBody,
} from './orders.schemas.js';

const ADMIN = { userId: 'u-admin', role: 'ADMIN' } as const;

const baseBody = {
  contactName: '联系人',
  contactPhone: '13800000000',
  items: [{ kind: 'TRANSFER', description: '接送', quantity: 1, unitPrice: 150 }],
  passengers: [
    { fullName: '张三', documentNumber: 'E1234567', dateOfBirth: '1990-01-01', nationality: 'CN' },
  ],
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
};

function itemsPassedToCreate(): CreatedItemRow[] {
  const call = mockPrisma.order.create.mock.calls[0];
  return (call[0] as { data: { items: { create: CreatedItemRow[] } } }).data.items.create;
}

function totalPassedToCreate(): number {
  const call = mockPrisma.order.create.mock.calls[0];
  return Number((call[0] as { data: { total: { toString(): string } } }).data.total.toString());
}

function findSettlementRow(items: CreatedItemRow[]): CreatedItemRow | undefined {
  return items.find(
    (it) => (it.metadata as Record<string, unknown> | undefined)?.reasonCode === 'SETTLEMENT',
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
  mockPrisma.auditLog.create.mockResolvedValue({});
  // createVisaTaskAtCreation（best-effort）：无订单项 → 直接 return []
  mockPrisma.order.findUnique.mockResolvedValue(null);
  mockPrisma.orderItem.findMany.mockResolvedValue([]);
  // tx.order.create 回显传入 data，供事务后审计/返回值读取
  mockPrisma.order.create.mockImplementation(
    async (args: {
      data: {
        orderNumber: string;
        total: unknown;
        paymentExpiresAt: Date | null;
        items: { create: unknown[] };
        passengers: { create: unknown[] };
      };
    }) => ({
      id: 'order-1',
      orderNumber: args.data.orderNumber,
      total: args.data.total,
      paymentExpiresAt: args.data.paymentExpiresAt,
      items: args.data.items.create,
      passengers: args.data.passengers.create,
      statusEvents: [],
    }),
  );
});

describe('buildSettlementTotalItem', () => {
  it('负差额 → DISCOUNT 行，描述用负号（−），metadata 打标结算快照', () => {
    const row = buildSettlementTotalItem({
      diffCny: -5684,
      authoritativeTotalCny: 7402,
      settlementTotalCny: 1718,
    });
    expect(row.kind).toBe('DISCOUNT');
    expect(row.amount).toBe(-5684);
    expect(row.unitPrice).toBe(-5684);
    expect(row.quantity).toBe(1);
    expect(row.description).toBe('价格调整：代理结算价（−¥5684）');
    expect(row.metadata).toMatchObject({
      priceAdjustment: true,
      reasonCode: 'SETTLEMENT',
      settlementPrice: true,
      authoritativeTotalCny: 7402,
      settlementTotalCny: 1718,
    });
  });

  it('正差额 → FEE 行，描述用加号', () => {
    const row = buildSettlementTotalItem({
      diffCny: 300,
      authoritativeTotalCny: 1500,
      settlementTotalCny: 1800,
    });
    expect(row.kind).toBe('FEE');
    expect(row.amount).toBe(300);
    expect(row.description).toBe('价格调整：代理结算价（+¥300）');
  });

  it('成本侧显式落 0（结算差额是纯价格调整，无采购成本，不留 NULL）', () => {
    expect(
      buildSettlementTotalItem({ diffCny: -5684, authoritativeTotalCny: 7402, settlementTotalCny: 1718 })
        .totalCostCny,
    ).toBe(0);
    expect(
      buildSettlementTotalItem({ diffCny: 300, authoritativeTotalCny: 1500, settlementTotalCny: 1800 })
        .totalCostCny,
    ).toBe(0);
  });
});

describe('createOrderBodySchema.settlementTotalCny 校验', () => {
  const withSettlement = (v: unknown) => ({
    ...(baseBody as unknown as Record<string, unknown>),
    settlementTotalCny: v,
  });

  it('负数拒绝', () => {
    expect(createOrderBodySchema.safeParse(withSettlement(-1)).success).toBe(false);
  });

  it('三位小数拒绝', () => {
    expect(createOrderBodySchema.safeParse(withSettlement(1718.125)).success).toBe(false);
  });

  it('两位小数通过；0 通过（结算价可以为 0）', () => {
    expect(createOrderBodySchema.safeParse(withSettlement(1718.25)).success).toBe(true);
    expect(createOrderBodySchema.safeParse(withSettlement(0)).success).toBe(true);
  });

  it('人工调价下拉不得出现 SETTLEMENT（只能系统生成）', () => {
    const result = priceAdjustmentSchema.safeParse({ amountCny: -100, reasonCode: 'SETTLEMENT' });
    expect(result.success).toBe(false);
  });
});

describe('createOrder · settlementTotalCny 权限与互斥（服务端按认证身份判）', () => {
  const bodyWithSettlement = {
    ...(baseBody as unknown as Record<string, unknown>),
    settlementTotalCny: 1718,
  } as unknown as CreateOrderBody;
  const service = new OrderService();

  it('游客携带 settlementTotalCny → BadRequestError，且未触库', async () => {
    await expect(
      service.createOrder(bodyWithSettlement, { guest: { name: '游客', phone: '13800000000' } }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('CUSTOMER 携带 settlementTotalCny → BadRequestError', async () => {
    await expect(
      service.createOrder(bodyWithSettlement, { userId: 'u-cust', role: 'CUSTOMER' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('AGENT 携带 settlementTotalCny → BadRequestError', async () => {
    await expect(
      service.createOrder(bodyWithSettlement, { userId: 'u-agent', role: 'AGENT', agentId: 'a1' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('与 priceAdjustment 同时传 → BadRequestError（互斥，避免双重调价）', async () => {
    const both = {
      ...(bodyWithSettlement as unknown as Record<string, unknown>),
      priceAdjustment: { amountCny: -100, reasonCode: 'DISCOUNT' },
    } as unknown as CreateOrderBody;
    await expect(service.createOrder(both, ADMIN)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('createOrder · settlementTotalCny 差额行生成（ADMIN，mock 全链路）', () => {
  it('结算价 < 系统价 → 生成 DISCOUNT 差额行，总额=结算价，审计 WARNING 落库', async () => {
    const service = makeService(7402);
    const body = {
      ...(baseBody as unknown as Record<string, unknown>),
      settlementTotalCny: 1718,
    } as unknown as CreateOrderBody;
    await service.createOrder(body, ADMIN);

    const settlementRow = findSettlementRow(itemsPassedToCreate());
    expect(settlementRow).toBeDefined();
    expect(settlementRow!.kind).toBe('DISCOUNT');
    expect(Number(settlementRow!.amount.toString())).toBe(-5684);
    expect(settlementRow!.description).toBe('价格调整：代理结算价（−¥5684）');
    expect(settlementRow!.metadata).toMatchObject({
      settlementPrice: true,
      authoritativeTotalCny: 7402,
      settlementTotalCny: 1718,
    });
    expect(totalPassedToCreate()).toBe(1718);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'APPLY_SETTLEMENT_TOTAL', severity: 'WARNING' }),
      }),
    );
  });

  it('结算价 > 系统价 → 生成 FEE 差额行，总额=结算价', async () => {
    const service = makeService(1500);
    const body = {
      ...(baseBody as unknown as Record<string, unknown>),
      settlementTotalCny: 1800,
    } as unknown as CreateOrderBody;
    await service.createOrder(body, ADMIN);

    const settlementRow = findSettlementRow(itemsPassedToCreate());
    expect(settlementRow).toBeDefined();
    expect(settlementRow!.kind).toBe('FEE');
    expect(Number(settlementRow!.amount.toString())).toBe(300);
    expect(totalPassedToCreate()).toBe(1800);
  });

  it('结算价 = 系统价（diff=0）→ 不生成差额行，也不写结算审计', async () => {
    const service = makeService(1718);
    const body = {
      ...(baseBody as unknown as Record<string, unknown>),
      settlementTotalCny: 1718,
    } as unknown as CreateOrderBody;
    await service.createOrder(body, ADMIN);

    expect(findSettlementRow(itemsPassedToCreate())).toBeUndefined();
    expect(totalPassedToCreate()).toBe(1718);
    const auditActions = mockPrisma.auditLog.create.mock.calls.map(
      (c) => (c[0] as { data: { action: string } }).data.action,
    );
    expect(auditActions.filter((a) => a === 'APPLY_SETTLEMENT_TOTAL')).toHaveLength(0);
  });

  it('差额超出调价上限 → BadRequestError（可读中文报错），不开事务', async () => {
    const service = makeService(1000);
    const body = {
      ...(baseBody as unknown as Record<string, unknown>),
      settlementTotalCny: 1000 + PRICE_ADJUSTMENT_CAP_CNY + 1,
    } as unknown as CreateOrderBody;
    await expect(service.createOrder(body, ADMIN)).rejects.toThrowError(/超出调价上限/);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('优惠调价导致最终总额为负 → 拒绝建单并提示核对优惠金额', async () => {
    const service = makeService(50);
    const body = {
      ...(baseBody as unknown as Record<string, unknown>),
      priceAdjustment: { amountCny: -100, reasonCode: 'DISCOUNT' },
    } as unknown as CreateOrderBody;
    await expect(service.createOrder(body, ADMIN)).rejects.toThrow('优惠金额超过订单应收，请核对');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
