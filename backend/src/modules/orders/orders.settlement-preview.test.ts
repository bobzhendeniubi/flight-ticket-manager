/** 录单试算的结算价日历预览：只读服务级测试。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockPrisma,
  mockGetFlightSettlementRate,
  mockGetSettlementRate,
  mockResolveAgentSettlementDiscount,
  mockResolveRetailSettlementDiscount,
} = vi.hoisted(() => ({
  mockPrisma: {
    bundle: { findMany: vi.fn() },
    flightSchedule: { findMany: vi.fn() },
    settlementDiscountRule: {},
  },
  mockGetFlightSettlementRate: vi.fn(),
  mockGetSettlementRate: vi.fn(),
  mockResolveAgentSettlementDiscount: vi.fn(),
  mockResolveRetailSettlementDiscount: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../settlement-rates/flight-settlement-rates.service.js', () => ({
  getFlightSettlementRate: mockGetFlightSettlementRate,
}));
vi.mock('../settlement-rates/settlement-rates.service.js', () => ({
  getSettlementRate: mockGetSettlementRate,
}));
vi.mock('../settlement-discounts/settlement-discounts.service.js', () => ({
  resolveAgentSettlementDiscount: mockResolveAgentSettlementDiscount,
  resolveRetailSettlementDiscount: mockResolveRetailSettlementDiscount,
}));
vi.mock('../finances/finances.cost.service.js', () => ({
  localDate: vi.fn((date: Date) => date.toISOString().slice(0, 10)),
}));

import { OrderService } from './orders.service.js';

const flightItem = {
  kind: 'FLIGHT' as const,
  description: '去程',
  quantity: 1,
  flightScheduleId: 'schedule-1',
  flightCabin: 'ECONOMY' as const,
};

function stubPricing(service: OrderService, priced: unknown[]): void {
  vi.spyOn(service as never, 'priceAndValidateItems' as never).mockResolvedValue(priced as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockPrisma.bundle.findMany.mockResolvedValue([]);
  mockPrisma.flightSchedule.findMany.mockResolvedValue([
    {
      id: 'schedule-1',
      departureTime: new Date('2026-09-01T00:30:00Z'),
      departureTz: 'Asia/Macau',
      flight: { flightNumber: 'QH9589' },
    },
  ]);
  mockGetFlightSettlementRate.mockResolvedValue({ pricePerPersonCny: 1200 });
  mockGetSettlementRate.mockResolvedValue({ pricePerPersonCny: 1500 });
  mockResolveAgentSettlementDiscount.mockResolvedValue(null);
  mockResolveRetailSettlementDiscount.mockResolvedValue(null);
});

describe('OrderService.quoteOrder · settlementPreview', () => {
  it('纯机票全命中 → 返回 FLIGHT 日历预览', async () => {
    const service = new OrderService();
    stubPricing(service, [{ ...flightItem, unitPrice: 1800, amount: 1800 }]);

    const result = await service.quoteOrder({ items: [flightItem] });

    expect(result.settlementPreview).toEqual({
      ok: true,
      source: 'FLIGHT',
      totalCny: 1200,
      lines: [
        expect.objectContaining({ pricePerPersonCny: 1200, pax: 1, note: expect.stringContaining('QH9589') }),
      ],
    });
  });

  it('纯机票未全命中 → settlementPreview 为 null，不把动态价误报成日历价', async () => {
    const service = new OrderService();
    stubPricing(service, [{ ...flightItem, unitPrice: 1800, amount: 1800 }]);
    mockGetFlightSettlementRate.mockResolvedValue(null);

    const result = await service.quoteOrder({ items: [flightItem] });

    expect(result.settlementPreview).toBeNull();
  });

  it('套餐命中日历且有加项 → 返回 GROUND 预览并包含加项后的总价', async () => {
    const bundleItem = {
      kind: 'BUNDLE' as const,
      description: '套餐',
      quantity: 1,
      bundleId: 'bundle-1',
      unitPrice: 0,
      adultCount: 1,
      childCount: 0,
      infantCount: 0,
      metadata: { goDate: '2026-09-01' },
    };
    mockPrisma.bundle.findMany.mockResolvedValue([
      { id: 'bundle-1', name: '套餐', settlementTier: 'THREE_STAR', settlementNights: 1 },
    ]);
    const service = new OrderService();
    stubPricing(service, [
      { ...flightItem, bundleId: 'bundle-1', unitPrice: 900, amount: 900 },
      { ...bundleItem, unitPrice: 700, amount: 740, settlementAddOnCny: 40 },
    ]);

    const result = await service.quoteOrder({ items: [flightItem, bundleItem] });

    expect(result.settlementPreview).toMatchObject({
      ok: true,
      source: 'GROUND',
      totalCny: 1540,
      departDate: '2026-09-01',
      lines: [{ pricePerPersonCny: 1500, pax: 1, addOnCny: 40 }],
    });
  });

  it('套餐已配置日历但当日缺价 → 返回 ok:false，试算不抛错', async () => {
    const bundleItem = {
      kind: 'BUNDLE' as const,
      description: '套餐',
      quantity: 1,
      bundleId: 'bundle-1',
      unitPrice: 0,
      adultCount: 1,
      childCount: 0,
      infantCount: 0,
      metadata: { goDate: '2026-09-01' },
    };
    mockPrisma.bundle.findMany.mockResolvedValue([
      { id: 'bundle-1', name: '套餐', settlementTier: 'THREE_STAR', settlementNights: 1 },
    ]);
    mockGetSettlementRate.mockResolvedValue(null);
    const service = new OrderService();
    stubPricing(service, [
      { ...flightItem, bundleId: 'bundle-1', unitPrice: 900, amount: 900 },
      { ...bundleItem, unitPrice: 700, amount: 700, settlementAddOnCny: 0 },
    ]);

    const result = await service.quoteOrder({ items: [flightItem, bundleItem] });

    expect(result.settlementPreview).toEqual({
      ok: false,
      reason: '该出发日期的结算价未维护，请联系运营',
    });
  });

  it('代理套餐命中规则 → 预览追加立减行并从日历结算总价扣除', async () => {
    const bundleItem = {
      kind: 'BUNDLE' as const,
      description: '套餐',
      quantity: 1,
      bundleId: 'bundle-1',
      unitPrice: 0,
      adultCount: 2,
      childCount: 0,
      infantCount: 0,
      metadata: { goDate: '2026-09-01' },
    };
    mockPrisma.bundle.findMany.mockResolvedValue([
      { id: 'bundle-1', name: '套餐', settlementTier: 'THREE_STAR', settlementNights: 1 },
    ]);
    mockResolveAgentSettlementDiscount.mockResolvedValue({
      ruleId: 'discount-1',
      kind: 'AGENT',
      discountPerPersonCny: 100,
    });
    const service = new OrderService();
    stubPricing(service, [
      { ...flightItem, bundleId: 'bundle-1', unitPrice: 900, amount: 900 },
      { ...bundleItem, unitPrice: 700, amount: 740, settlementAddOnCny: 40 },
    ]);

    const result = await service.quoteOrder({ items: [flightItem, bundleItem], agentId: 'agent-1' });

    expect(result.items).toContainEqual(expect.objectContaining({
      kind: 'DISCOUNT',
      amount: -200,
    }));
    expect(result.settlementPreview).toMatchObject({
      ok: true,
      source: 'GROUND',
      totalCny: 2840,
      autoDiscount: {
        hits: [{ ruleId: 'discount-1', kind: 'AGENT', perPersonCny: 100, pax: 2 }],
        pax: 2,
        totalCny: 200,
      },
    });
    expect(result.settlementPreview && result.settlementPreview.ok
      ? result.settlementPreview.lines.at(-1)
      : null).toMatchObject({ pricePerPersonCny: -100, pax: 2, note: '同业立减' });
  });

  it('多个不同出发日的散客套餐行 → 各自按 goDate 命中对应 RETAIL 规则', async () => {
    const bundleItemA = {
      kind: 'BUNDLE' as const,
      description: '套餐 A',
      quantity: 1,
      bundleId: 'bundle-a',
      unitPrice: 0,
      adultCount: 1,
      childCount: 0,
      infantCount: 0,
      metadata: { goDate: '2026-09-01' },
    };
    const bundleItemB = {
      ...bundleItemA,
      description: '套餐 B',
      bundleId: 'bundle-b',
      adultCount: 2,
      metadata: { goDate: '2026-09-15' },
    };
    mockPrisma.bundle.findMany.mockResolvedValue([
      { id: 'bundle-a', name: '套餐 A', settlementTier: 'THREE_STAR', settlementNights: 1 },
      { id: 'bundle-b', name: '套餐 B', settlementTier: 'FOUR_STAR', settlementNights: 2 },
    ]);
    mockResolveRetailSettlementDiscount.mockImplementation(async (_tier, _nights, departDate) => ({
      ruleId: departDate === '2026-09-01' ? 'retail-a' : 'retail-b',
      kind: 'RETAIL',
      discountPerPersonCny: departDate === '2026-09-01' ? 80 : 120,
    }));
    const service = new OrderService();
    stubPricing(service, [
      { ...flightItem, bundleId: 'bundle-a', unitPrice: 900, amount: 900 },
      { ...bundleItemA, unitPrice: 700, amount: 700, settlementAddOnCny: 0 },
      { ...flightItem, flightScheduleId: 'schedule-2', bundleId: 'bundle-b', unitPrice: 900, amount: 900 },
      { ...bundleItemB, unitPrice: 1400, amount: 1400, settlementAddOnCny: 0 },
    ]);

    const result = await service.quoteOrder({
      items: [
        { ...flightItem, bundleId: 'bundle-a' },
        bundleItemA,
        { ...flightItem, flightScheduleId: 'schedule-2', bundleId: 'bundle-b' },
        bundleItemB,
      ],
    });

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'DISCOUNT', amount: -80 }),
      expect.objectContaining({ kind: 'DISCOUNT', amount: -240 }),
    ]));
    expect(mockResolveRetailSettlementDiscount).toHaveBeenNthCalledWith(
      1,
      'THREE_STAR',
      1,
      '2026-09-01',
    );
    expect(mockResolveRetailSettlementDiscount).toHaveBeenNthCalledWith(
      2,
      'FOUR_STAR',
      2,
      '2026-09-15',
    );
  });

  it('结算价日历未维护但 RETAIL 命中 → quote 总价仍包含散客立减', async () => {
    const bundleItem = {
      kind: 'BUNDLE' as const,
      description: '套餐',
      quantity: 1,
      bundleId: 'bundle-1',
      unitPrice: 0,
      adultCount: 1,
      childCount: 0,
      infantCount: 0,
      metadata: { goDate: '2026-09-01' },
    };
    mockPrisma.bundle.findMany.mockResolvedValue([
      { id: 'bundle-1', name: '套餐', settlementTier: 'THREE_STAR', settlementNights: 1 },
    ]);
    mockGetSettlementRate.mockResolvedValue(null);
    mockResolveRetailSettlementDiscount.mockResolvedValue({
      ruleId: 'retail-discount-1',
      kind: 'RETAIL',
      discountPerPersonCny: 100,
    });
    const service = new OrderService();
    stubPricing(service, [
      { ...flightItem, bundleId: 'bundle-1', unitPrice: 900, amount: 900 },
      { ...bundleItem, unitPrice: 700, amount: 700, settlementAddOnCny: 0 },
    ]);

    const result = await service.quoteOrder({ items: [flightItem, bundleItem] });

    expect(result.total).toBe(1500);
    expect(result.items).toContainEqual(expect.objectContaining({ kind: 'DISCOUNT', amount: -100 }));
    expect(result.settlementPreview).toEqual({
      ok: false,
      reason: '该出发日期的结算价未维护，请联系运营',
    });
  });

  it('散客套餐 RETAIL 命中 → 立减行进入 percent-off 后的试算明细', async () => {
    const bundleItem = {
      kind: 'BUNDLE' as const,
      description: '套餐',
      quantity: 1,
      bundleId: 'bundle-1',
      unitPrice: 0,
      adultCount: 1,
      childCount: 0,
      infantCount: 0,
      metadata: { goDate: '2026-09-01' },
    };
    mockPrisma.bundle.findMany.mockResolvedValue([
      { id: 'bundle-1', name: '套餐', settlementTier: 'THREE_STAR', settlementNights: 1 },
    ]);
    mockResolveRetailSettlementDiscount.mockResolvedValue({
      ruleId: 'retail-discount-1',
      kind: 'RETAIL',
      discountPerPersonCny: 100,
    });
    const service = new OrderService();
    stubPricing(service, [
      { ...flightItem, bundleId: 'bundle-1', unitPrice: 900, amount: 900 },
      { ...bundleItem, unitPrice: 700, amount: 740, settlementAddOnCny: 40 },
    ]);

    const result = await service.quoteOrder({ items: [flightItem, bundleItem] });

    expect(result.items).toContainEqual(expect.objectContaining({ kind: 'DISCOUNT', amount: -100 }));
    expect(result.total).toBe(1540);
  });

  it('日历试算发生非 BadRequestError → 记录日志并返回 null，不透出底层异常', async () => {
    const bundleItem = {
      kind: 'BUNDLE' as const,
      description: '套餐',
      quantity: 1,
      bundleId: 'bundle-1',
      unitPrice: 0,
      adultCount: 1,
      childCount: 0,
      infantCount: 0,
      metadata: { goDate: '2026-09-01' },
    };
    mockPrisma.bundle.findMany.mockRejectedValue(new Error('Prisma 内部错误: secret'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new OrderService();
    stubPricing(service, [
      { ...flightItem, bundleId: 'bundle-1', unitPrice: 900, amount: 900 },
      { ...bundleItem, unitPrice: 700, amount: 700, settlementAddOnCny: 0 },
    ]);

    const result = await service.quoteOrder({ items: [flightItem, bundleItem], agentId: 'agent-1' });

    expect(result.settlementPreview).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[orders] settlement calendar quote failed',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
