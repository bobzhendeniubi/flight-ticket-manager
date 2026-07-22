/**
 * 座位账诚实收口 · 套餐含机票组件必须带机票航段行 · 服务级单测（vitest，mock Prisma + spy 定价）
 *
 * 背景：套餐定义（bundle.items）含 FLIGHT 组件时，若建单方漏发机票航段（前台购物车缺航段 id 的退路 /
 *   历史批量创单旧版 / 直连 API），会落一张「无航段、不占座、出发日期无从派生」的套餐单——签证台 /
 *   订单列表 / 详情 / 导出都推不出出发日期，且机位从未被占（座位账少一笔）。
 *
 * 收口点：priceAndValidateItems 的 BUNDLE 分支——含机票组件却无对应机票航段行 → 明确拒单，
 *   绝不静默落无航段单。真正扣座沿用既有 decrementSeat 链路（占/放对称），本断言不新增占/放座逻辑。
 *
 * 覆盖：
 *   1. 含机票组件 + 无机票航段行 → BadRequestError（明确话术）。
 *   2. 含机票组件 + 带机票航段行（打本套餐 bundleId 标）→ 通过，priced 保留 FLIGHT 行供扣座。
 *   3. 含机票组件 + 带未打标机票航段行（单笔录单口径）→ 通过（合法路径不误伤）。
 *   4. 纯地面套餐（无机票组件）+ 无机票航段行 → 通过（不触发收口）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    bundle: { findUnique: vi.fn() },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import type { OrderItemInput } from './orders.schemas.js';

const service = new OrderService();

// priceAndValidateItems 为 private——单测按既有惯例用括号访问穿透（不改可见性）。
type PriceFn = (
  items: OrderItemInput[],
  flightSettlementPriceCny?: number,
  passengers?: unknown,
  allowClientPricedGround?: boolean,
) => Promise<Array<{ kind: string; flightScheduleId?: string; amount: number }>>;
const priceItems = (
  service as unknown as { priceAndValidateItems: PriceFn }
).priceAndValidateItems.bind(service);

/** 套餐 fixture：hotelRoomTypeId=null（不触发房量前瞻闸）、无升舱/无折扣（跳过循环后处理）。 */
function bundleFixture(
  components: Array<{ kind: string; qty: number; unitPrice: number }>,
): unknown {
  return {
    items: components,
    groundDiscount: 0,
    discountPct: 0,
    isActive: true,
    hotelRoomTypeId: null,
    hotelNights: 2,
    singleSupplementCnyPerNight: 0,
    businessUpgradeCnyPerLeg: 0,
    childSeatDiscountCnyPerPerson: 0,
    infantPriceCny: 0,
    selfVisaDeductCny: 0,
    operationFeeCny: 0,
    legs: 2,
    hotelRoomType: null,
  };
}

const FLIGHT_COMPONENT = { kind: 'FLIGHT', qty: 1, unitPrice: 0 };
const GROUND_COMPONENTS = [
  { kind: 'HOTEL', qty: 2, unitPrice: 500 },
  { kind: 'VISA', qty: 1, unitPrice: 300 },
];

const bundleLine: OrderItemInput = {
  kind: 'BUNDLE',
  description: '岘港2天1晚四星随机',
  quantity: 1,
  bundleId: 'bundle-1',
  unitPrice: 0,
  adultCount: 1,
  childCount: 0,
  infantCount: 0,
} as unknown as OrderItemInput;

function flightLeg(bundleId?: string): OrderItemInput {
  return {
    kind: 'FLIGHT',
    description: '岘港2天1晚四星随机 · 去程（经济舱）',
    quantity: 1,
    flightScheduleId: 'sch-go',
    flightCabin: 'ECONOMY',
    ...(bundleId ? { bundleId } : {}),
  } as unknown as OrderItemInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  // FLIGHT 行动态定价：spy 实例上的 pricing.calculatePrice，返回稳定价（不依赖真 DB / 真定价链路）。
  vi.spyOn(
    (service as unknown as { pricing: { calculatePrice: (...a: unknown[]) => unknown } }).pricing,
    'calculatePrice',
  ).mockResolvedValue({
    averageUnitPrice: 1200,
    totalPrice: 1200,
    dateRank: 0,
    dateMultiplier: 1,
    perSeatBreakdown: [],
  });
});

describe('套餐含机票组件 → 必须带机票航段行（座位账诚实收口）', () => {
  it('含机票组件 + 无机票航段行 → 明确拒单（不静默落无航段单）', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValue(
      bundleFixture([FLIGHT_COMPONENT, ...GROUND_COMPONENTS]),
    );
    await expect(priceItems([bundleLine], undefined, undefined, true)).rejects.toThrow(
      /该套餐含机票.*未匹配到.*机票航段/,
    );
  });

  it('含机票组件 + 带机票航段行（打本套餐标）→ 通过，priced 保留 FLIGHT 行供扣座', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValue(
      bundleFixture([FLIGHT_COMPONENT, ...GROUND_COMPONENTS]),
    );
    const priced = await priceItems(
      [flightLeg('bundle-1'), bundleLine],
      undefined,
      undefined,
      true,
    );
    // 机票航段行原样进入定价结果（带 scheduleId）→ 事务里 decrementSeat 据此占座（占/放对称）。
    const flightRows = priced.filter((p) => p.kind === 'FLIGHT');
    expect(flightRows).toHaveLength(1);
    expect(flightRows[0].flightScheduleId).toBe('sch-go');
    expect(priced.some((p) => p.kind === 'BUNDLE')).toBe(true);
  });

  it('含机票组件 + 带未打标机票航段行（单笔录单口径）→ 通过（合法路径不误伤）', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValue(
      bundleFixture([FLIGHT_COMPONENT, ...GROUND_COMPONENTS]),
    );
    const priced = await priceItems([flightLeg(), bundleLine], undefined, undefined, true);
    expect(priced.filter((p) => p.kind === 'FLIGHT')).toHaveLength(1);
  });

  it('纯地面套餐（无机票组件）+ 无机票航段行 → 通过（不触发收口）', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValue(bundleFixture(GROUND_COMPONENTS));
    const priced = await priceItems([bundleLine], undefined, undefined, true);
    expect(priced.some((p) => p.kind === 'BUNDLE')).toBe(true);
    expect(priced.some((p) => p.kind === 'FLIGHT')).toBe(false);
  });
});
