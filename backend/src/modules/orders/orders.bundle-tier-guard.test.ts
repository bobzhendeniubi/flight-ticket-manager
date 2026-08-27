/**
 * 套餐档次两件事 · 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 *   A. 指定酒店「星级不匹配」闸（block-with-override）——
 *      套餐按 Bundle.settlementTier 收钱，指定/换入酒店却是别的星级时，此前系统完全不知情
 *      （只校验房型存在 + 在架）。现在：对外身份硬拒，运营必须写明放行原因，放行留 WARNING 审计。
 *   B. 套餐改档端点（change-bundle）——
 *      行业口径 amendment：改档 → 按新档重新计价 → 差价落一条 bundleChange 差额行 → 审计。
 *      行价冻结、已收款不动、机票行/座位不动；酒店已落位的单先走换酒店。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderItemKind, Prisma, UserRole } from '@prisma/client';

const { mockPrisma, mockGetSettlementRate, mockAgentDiscount } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    bundle: { findUnique: vi.fn(), findMany: vi.fn() },
    hotelRoomType: { findUnique: vi.fn() },
    flightSchedule: { findMany: vi.fn() },
    passenger: { findMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
  mockGetSettlementRate: vi.fn(),
  mockAgentDiscount: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../settlement-rates/settlement-rates.service.js', () => ({
  getSettlementRate: mockGetSettlementRate,
}));
vi.mock('../settlement-discounts/settlement-discounts.service.js', () => ({
  resolveAgentSettlementDiscount: mockAgentDiscount,
  resolveRetailSettlementDiscount: vi.fn(async () => null),
}));

import {
  OrderService,
  isSettlementTierStarMismatch,
  resolveHotelSettlementTier,
  type DesignatedHotelStarMismatchOverride,
} from './orders.service.js';
import type { OrderItemInput, SwapItemHotelBody } from './orders.schemas.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const STAFF = { userId: 'staff-1', role: UserRole.STAFF } as const;

/** priceAndValidateItems 是私有的（录单权威定价入口）—— 单测按既有惯例走类型断言直接调。 */
type StarGate = { role: UserRole | null; overrides: DesignatedHotelStarMismatchOverride[] };
const priceItems = (items: OrderItemInput[], gate?: StarGate): Promise<unknown> =>
  (
    service as unknown as {
      priceAndValidateItems: (
        i: OrderItemInput[],
        f: undefined,
        p: undefined,
        a: boolean,
        g?: StarGate,
      ) => Promise<unknown>;
    }
  ).priceAndValidateItems(items, undefined, undefined, true, gate);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(null);
  mockAgentDiscount.mockResolvedValue(null);
});

// ══════════════════════════════════════════════════════════════════════════
// A. 星级不匹配闸
// ══════════════════════════════════════════════════════════════════════════

describe('结算档次 ↔ 酒店星级映射（唯一权威口径）', () => {
  it('市区档按整数星级一一对上；国际五星单独成档', () => {
    expect(resolveHotelSettlementTier({ starRating: 3, intlFiveStar: false })).toBe('CITY_3STAR');
    expect(resolveHotelSettlementTier({ starRating: 4, intlFiveStar: false })).toBe('CITY_4STAR');
    expect(resolveHotelSettlementTier({ starRating: 5, intlFiveStar: false })).toBe('CITY_5STAR');
    expect(resolveHotelSettlementTier({ starRating: 5, intlFiveStar: true })).toBe('INTL_5STAR');
  });

  it('星级缺失 / 1~2 星（映射不到任何档）→ 一律视为不匹配（保守口径）', () => {
    expect(resolveHotelSettlementTier({ starRating: null })).toBeNull();
    expect(isSettlementTierStarMismatch('CITY_4STAR', { starRating: null })).toBe(true);
    expect(isSettlementTierStarMismatch('CITY_3STAR', { starRating: 2 })).toBe(true);
  });

  it('国际五星与市区五星互为不同档（另行报价），互相视为不匹配', () => {
    expect(isSettlementTierStarMismatch('CITY_5STAR', { starRating: 5, intlFiveStar: true })).toBe(
      true,
    );
    expect(isSettlementTierStarMismatch('INTL_5STAR', { starRating: 5, intlFiveStar: false })).toBe(
      true,
    );
    expect(isSettlementTierStarMismatch('INTL_5STAR', { starRating: 5, intlFiveStar: true })).toBe(
      false,
    );
  });
});

describe('录单指定酒店 · 星级不匹配闸', () => {
  /** 四星档纯地面套餐（无 FLIGHT 组件、不绑房型 → 不触发库存闸，聚焦星级判定）。 */
  function mountBundle(settlementTier: string | null = 'CITY_4STAR') {
    mockPrisma.bundle.findUnique.mockResolvedValue({
      name: '四星 3天2晚',
      settlementTier,
      items: [{ kind: 'HOTEL', qty: 2, unitPrice: 800 }],
      groundDiscount: 0,
      discountPct: 0,
      isActive: true,
      hotelRoomTypeId: null,
      hotelNights: 2,
      singleSupplementCnyPerNight: 0,
      businessUpgradeCnyPerLeg: 0,
      outboundFlight: null,
      returnFlight: null,
      childSeatDiscountCnyPerPerson: 0,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      operationFeeCny: 0,
      legs: 2,
      hotelRoomType: null,
    });
  }

  function mountDesignatedHotel(hotel: {
    starRating: number | null;
    intlFiveStar?: boolean;
    randomTierPlaceholder?: number | null;
  }) {
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue({
      id: 'rt-designated',
      hotelId: 'h-designated',
      maxAdults: 2,
      maxChildren: 1,
      hotel: {
        name: '某三星酒店',
        isActive: true,
        designationSurchargeCnyPerPerson: 0,
        randomTierPlaceholder: hotel.randomTierPlaceholder ?? null,
        starRating: hotel.starRating,
        intlFiveStar: hotel.intlFiveStar ?? false,
      },
    });
  }

  const bundleRow = (reason?: string): OrderItemInput[] =>
    [
      {
        kind: 'BUNDLE',
        description: '四星 3天2晚',
        quantity: 1,
        unitPrice: 0,
        bundleId: 'b-4star',
        adultCount: 2,
        childCount: 0,
        infantCount: 0,
        designatedHotelRoomTypeId: 'rt-designated',
        ...(reason ? { designatedHotelStarMismatchReason: reason } : {}),
      },
    ] as unknown as OrderItemInput[];

  it('AGENT 指定低星酒店 → 直接拒单（对外身份没有越权定价的口子）', async () => {
    mountBundle();
    mountDesignatedHotel({ starRating: 3 });
    const gate: StarGate = { role: UserRole.AGENT, overrides: [] };
    await expect(priceItems(bundleRow(), gate)).rejects.toThrow(/该套餐为4星档/);
    await expect(priceItems(bundleRow('随便写点'), gate)).rejects.toThrow(/该套餐为4星档/);
    expect(gate.overrides).toHaveLength(0);
  });

  it('游客（无角色）同样硬拒', async () => {
    mountBundle();
    mountDesignatedHotel({ starRating: 3 });
    const gate: StarGate = { role: null, overrides: [] };
    await expect(priceItems(bundleRow(), gate)).rejects.toThrow(/请改选对应档次套餐或联系运营/);
  });

  it('STAFF 不填放行原因 → 拒单，并提示要填原因', async () => {
    mountBundle();
    mountDesignatedHotel({ starRating: 3 });
    const gate: StarGate = { role: STAFF.role, overrides: [] };
    await expect(priceItems(bundleRow(), gate)).rejects.toThrow(/请填写放行原因/);
    expect(gate.overrides).toHaveLength(0);
  });

  it('STAFF 填了放行原因 → 放行，并留下审计明细（档次/星级/原因）', async () => {
    mountBundle();
    mountDesignatedHotel({ starRating: 3 });
    const gate: StarGate = { role: STAFF.role, overrides: [] };
    await expect(priceItems(bundleRow('客人指定该店，差价已另行议定'), gate)).resolves.toBeTruthy();
    expect(gate.overrides).toHaveLength(1);
    expect(gate.overrides[0]).toMatchObject({
      bundleId: 'b-4star',
      bundleTier: 'CITY_4STAR',
      bundleTierStar: 4,
      hotelRoomTypeId: 'rt-designated',
      hotelStarRating: 3,
      hotelIntlFiveStar: false,
      reason: '客人指定该店，差价已另行议定',
    });
  });

  it('星级对得上 → 不判、不留痕（ADMIN 无需填原因）', async () => {
    mountBundle();
    mountDesignatedHotel({ starRating: 4 });
    const gate: StarGate = { role: ADMIN.role, overrides: [] };
    await expect(priceItems(bundleRow(), gate)).resolves.toBeTruthy();
    expect(gate.overrides).toHaveLength(0);
  });

  it('指到随机档占位酒店（不是真房源）→ 本闸不适用', async () => {
    mountBundle();
    mountDesignatedHotel({ starRating: 3, randomTierPlaceholder: 3 });
    const gate: StarGate = { role: UserRole.AGENT, overrides: [] };
    await expect(priceItems(bundleRow(), gate)).resolves.toBeTruthy();
    expect(gate.overrides).toHaveLength(0);
  });

  it('套餐未配结算档次 → 无基准可比，本闸不适用', async () => {
    mountBundle(null);
    mountDesignatedHotel({ starRating: 3 });
    const gate: StarGate = { role: UserRole.AGENT, overrides: [] };
    await expect(priceItems(bundleRow(), gate)).resolves.toBeTruthy();
  });

  it('不传 starGate（纯试算/内部预算路径）→ 行为与扩展前一致，不判', async () => {
    mountBundle();
    mountDesignatedHotel({ starRating: 3 });
    await expect(priceItems(bundleRow())).resolves.toBeTruthy();
  });
});

describe('售后换酒店 · 星级不匹配闸（BUNDLE 行）', () => {
  const SENTINEL = new Error('__reached_transaction__');

  function mountSwap(newHotelStar: number, bundleTier: string | null = 'CITY_4STAR') {
    mockPrisma.orderItem.findUnique.mockResolvedValue({
      id: 'item-bundle',
      orderId: 'ord-1',
      kind: OrderItemKind.BUNDLE,
      description: '四星 3天2晚',
      quantity: 1,
      hotelRoomTypeId: 'rt-old',
      randomStarTier: null,
      bundleId: 'b-4star',
      hotelCheckIn: null,
      hotelCheckOut: null,
      roomsBilled: new Prisma.Decimal(1),
      unitCostCny: null,
      totalCostCny: null,
    });
    mockPrisma.hotelRoomType.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === 'rt-old'
          ? {
              id: 'rt-old',
              name: '旧房型',
              hotelId: 'h-old',
              // 旧房型是真实酒店（randomTierPlaceholder 为空）→ 不触发既有的
              // 「随机档不许降级交付」那条闸，本组用例专测新加的「套餐档次 ↔ 星级」闸。
              hotel: { name: '旧酒店', randomTierPlaceholder: null },
            }
          : {
              id: 'rt-new',
              name: '标准双床',
              hotelId: 'h-new',
              costPriceCny: null,
              hotel: {
                name: '某酒店',
                isActive: true,
                starRating: newHotelStar,
                intlFiveStar: false,
                randomTierPlaceholder: null,
              },
            },
    );
    mockPrisma.bundle.findUnique.mockResolvedValue({
      id: 'b-4star',
      name: '四星 3天2晚',
      settlementTier: bundleTier,
    });
    // 闸放行后就会进事务 —— 用哨兵错误证明「确实走过去了」，不必把整条写链路都搭起来。
    mockPrisma.$transaction.mockRejectedValue(SENTINEL);
  }

  const body = (reason?: string): SwapItemHotelBody =>
    ({
      newHotelRoomTypeId: 'rt-new',
      ...(reason ? { designatedHotelStarMismatchReason: reason } : {}),
    }) as SwapItemHotelBody;

  it('换入酒店星级与套餐档次对不上、又没填原因 → 拒单', async () => {
    // 四星档 → 换到五星店：升级也算「钱与货对不上」，同样要有人签字。
    mountSwap(5);
    await expect(service.swapItemHotel('ord-1', 'item-bundle', body(), STAFF)).rejects.toThrow(
      /请填写放行原因/,
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('填了放行原因 → 闸放行（继续走换酒店主流程）', async () => {
    mountSwap(3);
    await expect(
      service.swapItemHotel(
        'ord-1',
        'item-bundle',
        body('我方缺四星房，客人同意改住三星并退差价'),
        STAFF,
      ),
    ).rejects.toBe(SENTINEL);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('星级对得上 → 不判，直接走主流程', async () => {
    mountSwap(4);
    await expect(service.swapItemHotel('ord-1', 'item-bundle', body(), STAFF)).rejects.toBe(
      SENTINEL,
    );
  });

  it('套餐未配结算档次 → 本闸不适用', async () => {
    mountSwap(3, null);
    await expect(service.swapItemHotel('ord-1', 'item-bundle', body(), STAFF)).rejects.toBe(
      SENTINEL,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B. 套餐改档（change-bundle）
// ══════════════════════════════════════════════════════════════════════════

describe('changeOrderBundle · 套餐改档', () => {
  /** 未落位的两人套餐单：总额 ¥4000，套餐行 ¥4000，无独立酒店行、无航段（出发日走酒店入住日）。 */
  function orderFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ord-1',
      orderNumber: 'FTM-0001',
      status: 'PAID',
      deletedAt: null,
      agentId: null,
      total: new Prisma.Decimal(4000),
      items: [
        {
          id: 'item-bundle',
          kind: OrderItemKind.BUNDLE,
          quantity: 1,
          amount: new Prisma.Decimal(4000),
          bundleId: 'b-3star',
          hotelRoomTypeId: null,
          hotelCheckIn: new Date('2026-09-01T00:00:00.000Z'),
          hotelCheckOut: new Date('2026-09-03T00:00:00.000Z'),
          visaIntendedDate: null,
          metadata: {
            addOns: {
              adultCount: 2,
              childCount: 0,
              infantCount: 0,
              singleCount: 0,
              businessCountOutbound: 0,
              businessCountReturn: 0,
              selfProvidedVisaCount: 0,
            },
          },
          hotelRoomType: null,
          flightSchedule: null,
        },
      ],
      ...overrides,
    };
  }
  function mountOrder(overrides: Record<string, unknown> = {}) {
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture(overrides));
  }

  /** 目标四星套餐：地面 2 晚 × ¥2500 = ¥5000（不绑房型 → 1 间，不触发库存闸）。 */
  function mountNewBundle(extra: Record<string, unknown> = {}) {
    mockPrisma.bundle.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'b-4star'
        ? {
            id: 'b-4star',
            name: '四星 3天2晚',
            isActive: true,
            items: [{ kind: 'HOTEL', qty: 2, unitPrice: 2500 }],
            discountPct: 0,
            hotelRoomTypeId: null,
            hotelNights: 2,
            singleSupplementCnyPerNight: 0,
            businessUpgradeCnyPerLeg: 0,
            outboundFlight: null,
            returnFlight: null,
            childSeatDiscountCnyPerPerson: 0,
            infantPriceCny: 0,
            selfVisaDeductCny: 0,
            operationFeeCny: 0,
            legs: 2,
            settlementTier: null,
            settlementNights: null,
            hotelRoomType: null,
            ...extra,
          }
        : { id: 'b-3star', name: '三星 3天2晚', settlementTier: 'CITY_3STAR', settlementNights: 2 },
    );
  }

  /** 事务替身：暴露 orderItem.update/create 与 order.update 供断言。 */
  function mountTx(sumAfterCny: number) {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'ord-1' }]),
      order: {
        findUnique: vi.fn(async () => ({
          id: 'ord-1',
          orderNumber: 'FTM-0001',
          status: 'PAID',
          deletedAt: null,
          subtotal: new Prisma.Decimal(4000),
          total: new Prisma.Decimal(4000),
          adjustments: [],
          items: [{ id: 'item-bundle', amount: new Prisma.Decimal(4000), bundleId: 'b-3star' }],
        })),
        update: vi.fn(async () => ({})),
      },
      orderItem: {
        update: vi.fn(async () => ({ id: 'item-bundle' })),
        create: vi.fn(async () => ({ id: 'item-diff' })),
        aggregate: vi.fn(async () => ({ _sum: { amount: new Prisma.Decimal(sumAfterCny) } })),
      },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    return tx;
  }

  it('正常改档：套餐行换绑（金额冻结）+ 差额行金额正确 + 总额收敛', async () => {
    mountOrder();
    mountNewBundle();
    const tx = mountTx(5000);

    await service
      .changeOrderBundle('ord-1', { bundleId: 'b-4star', note: '客人升四星' }, STAFF)
      .catch(() => undefined);

    // 1. 套餐行只换绑，不改金额（行价冻结）——data 里根本不出现 amount/unitPrice。
    const rowUpdate = tx.orderItem.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(rowUpdate.where.id).toBe('item-bundle');
    expect(rowUpdate.data.bundleId).toBe('b-4star');
    expect(rowUpdate.data.description).toBe('四星 3天2晚');
    expect(rowUpdate.data).not.toHaveProperty('amount');
    expect(rowUpdate.data).not.toHaveProperty('unitPrice');
    expect((rowUpdate.data.metadata as Record<string, unknown>).bundleChange).toMatchObject({
      fromBundleId: 'b-3star',
      toBundleId: 'b-4star',
      pricingSource: 'BUNDLE_PRICE',
      diffCny: 1000,
      reasonText: '客人升四星',
    });

    // 2. 差额行 = 新应收(4000 + (5000 − 4000)) − 原应收 4000 = +¥1000 → FEE 行。
    const diffRow = tx.orderItem.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(diffRow.data.kind).toBe(OrderItemKind.FEE);
    expect(diffRow.data.amount).toEqual(new Prisma.Decimal(1000));
    expect(String(diffRow.data.description)).toContain('套餐改档差额');
    expect((diffRow.data.metadata as Record<string, unknown>).bundleChange).toBe(true);

    // 3. 总额按 Σ items 收敛（已收款一分不动 —— 这里根本不碰 paidAmount）。
    const orderUpdate = tx.order.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(orderUpdate.data.total).toEqual(new Prisma.Decimal(5000));
    expect(orderUpdate.data.subtotal).toEqual(new Prisma.Decimal(5000));
    expect(orderUpdate.data).not.toHaveProperty('paidAmount');
  });

  it('降档（新档更便宜）→ 差额行为负、落 DISCOUNT 行', async () => {
    mountOrder();
    mountNewBundle({ items: [{ kind: 'HOTEL', qty: 2, unitPrice: 1500 }] });
    const tx = mountTx(3000);

    await service.changeOrderBundle('ord-1', { bundleId: 'b-4star' }, STAFF).catch(() => undefined);

    // 新套餐行价 3000 → 新应收 4000 + (3000 − 4000) = 3000；差额 −1000。
    const diffRow = tx.orderItem.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(diffRow.data.kind).toBe(OrderItemKind.DISCOUNT);
    expect(diffRow.data.amount).toEqual(new Prisma.Decimal(-1000));
  });

  it('代理单 + 目标套餐配了日历键 → 走结算价日历取价（每人价 × 人数）', async () => {
    mountOrder({ agentId: 'ag-1' });
    mountNewBundle({ settlementTier: 'CITY_4STAR', settlementNights: 2 });
    mockGetSettlementRate.mockResolvedValue({ pricePerPersonCny: 3000 });
    const tx = mountTx(6000);

    await service.changeOrderBundle('ord-1', { bundleId: 'b-4star' }, ADMIN).catch(() => undefined);

    expect(mockGetSettlementRate).toHaveBeenCalledWith('CITY_4STAR', 2, '2026-09-01');
    // 日历总价 3000 × 2 人 = 6000；原应收 4000 → 差额 +2000。
    const diffRow = tx.orderItem.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(diffRow.data.amount).toEqual(new Prisma.Decimal(2000));
    expect((diffRow.data.metadata as Record<string, unknown>).pricingSource).toBe(
      'SETTLEMENT_CALENDAR',
    );
  });

  it('代理单命中立减 → 从日历总价里减（口径同录单）', async () => {
    mountOrder({ agentId: 'ag-1' });
    mountNewBundle({ settlementTier: 'CITY_4STAR', settlementNights: 2 });
    mockGetSettlementRate.mockResolvedValue({ pricePerPersonCny: 3000 });
    mockAgentDiscount.mockResolvedValue({ ruleId: 'r-1', kind: 'AGENT', discountPerPersonCny: 200 });
    const tx = mountTx(5600);

    await service.changeOrderBundle('ord-1', { bundleId: 'b-4star' }, ADMIN).catch(() => undefined);

    // (3000 − 200) × 2 = 5600；原应收 4000 → 差额 +1600。
    const diffRow = tx.orderItem.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(diffRow.data.amount).toEqual(new Prisma.Decimal(1600));
  });

  it('代理单日历价当日未维护 → 拒单（宁可不改，也不按错价成交）', async () => {
    mountOrder({ agentId: 'ag-1' });
    mountNewBundle({ settlementTier: 'CITY_4STAR', settlementNights: 2 });
    mockGetSettlementRate.mockResolvedValue(null);
    mountTx(4000);

    await expect(service.changeOrderBundle('ord-1', { bundleId: 'b-4star' }, ADMIN)).rejects.toThrow(
      /结算价未维护/,
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('酒店已落位到真实酒店 → 拒单，提示先走换酒店', async () => {
    const settled = orderFixture();
    settled.items[0].hotelRoomTypeId = 'rt-real';
    (settled.items[0] as Record<string, unknown>).hotelRoomType = {
      hotel: { name: '某真实酒店', randomTierPlaceholder: null },
    };
    mockPrisma.order.findUnique.mockResolvedValue(settled);
    mountNewBundle();

    await expect(service.changeOrderBundle('ord-1', { bundleId: 'b-4star' }, STAFF)).rejects.toThrow(
      /已落位/,
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('取消族订单 → 拒单（死单不许再改应收）', async () => {
    mountOrder({ status: 'CANCELLED' });
    mountNewBundle();
    await expect(service.changeOrderBundle('ord-1', { bundleId: 'b-4star' }, STAFF)).rejects.toThrow(
      /不可改档/,
    );
  });

  it('回收站单（已软删）→ 拒单', async () => {
    mountOrder({ deletedAt: new Date() });
    mountNewBundle();
    await expect(service.changeOrderBundle('ord-1', { bundleId: 'b-4star' }, STAFF)).rejects.toThrow(
      /回收站/,
    );
  });

  it('目标套餐与当前相同 → 拒单', async () => {
    mountOrder();
    mountNewBundle();
    await expect(service.changeOrderBundle('ord-1', { bundleId: 'b-3star' }, STAFF)).rejects.toThrow(
      /无需改档/,
    );
  });

  it('目标套餐已下架 → 拒单', async () => {
    mountOrder();
    mockPrisma.bundle.findUnique.mockResolvedValue({
      id: 'b-4star',
      name: '四星 3天2晚',
      isActive: false,
      items: [],
      discountPct: 0,
      hotelRoomTypeId: null,
      hotelNights: 2,
      singleSupplementCnyPerNight: 0,
      businessUpgradeCnyPerLeg: 0,
      childSeatDiscountCnyPerPerson: 0,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      operationFeeCny: 0,
      legs: 2,
      settlementTier: null,
      settlementNights: null,
      hotelRoomType: null,
    });
    await expect(service.changeOrderBundle('ord-1', { bundleId: 'b-4star' }, STAFF)).rejects.toThrow(
      /已下架/,
    );
  });

  it('本单不含套餐行 → 拒单', async () => {
    mountOrder({ items: [] });
    mountNewBundle();
    await expect(service.changeOrderBundle('ord-1', { bundleId: 'b-4star' }, STAFF)).rejects.toThrow(
      /不含套餐行/,
    );
  });

  it('AGENT 不可用（仅运营/管理员可改档）', async () => {
    await expect(
      service.changeOrderBundle('ord-1', { bundleId: 'b-4star' }, {
        userId: 'agent-1',
        role: UserRole.AGENT,
      }),
    ).rejects.toThrow(/仅运营\/管理员/);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });
});
