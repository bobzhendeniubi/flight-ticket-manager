/**
 * bundle-pricing · 套餐定价纯函数单测（vitest，无需 mock，不连 DB）
 *
 * 聚焦「起价 / 人」唯一权威公式（本次改版核心）：
 *   originalPerPaxCny = flightRoundTripPerPax + 0.5 × hotelNightly × nights + transferTotal + visaPerPax
 * 即 1 人 · 半间房（拼房 twin-share）——与订单侧 computeBundleRoomsCharged 的 isSoloSharing
 * 半间床位价口径完全对应（起价就是把那个下单场景的价格摆到卡片上）。
 *
 * 同时回归 computeBundleOriginalAllInCny（整包原价锚点，本次改版未变）不因新增的
 * 防御性 items 非数组兜底而变化行为。
 */
import { describe, it, expect } from 'vitest';
import {
  computeBundleOriginalPerPaxCny,
  computeBundleOriginalAllInCny,
  type BundleItemPriceInput,
} from './bundle-pricing.js';

describe('computeBundleOriginalPerPaxCny · 起价/人（1人半间房）', () => {
  const items: BundleItemPriceInput[] = [
    { kind: 'FLIGHT', qty: 1, unitPrice: 0 },
    { kind: 'HOTEL', qty: 3, unitPrice: 2162 }, // HOTEL 行的 unitPrice 在本函数里不直接用——夜价来自单独参数
    { kind: 'TRANSFER', qty: 2, unitPrice: 188 },
    { kind: 'VISA', qty: 2, unitPrice: 280 },
  ];

  it('完整公式：flightRoundTripPerPax + 0.5×hotelNightly×nights + transferTotal + visaPerPax（操作费=0 时回归旧公式）', () => {
    const result = computeBundleOriginalPerPaxCny({
      items,
      nights: 3,
      hotelRoomTypeNightlyCny: 2162,
      flightRoundTripPerPaxCny: 1380,
      operationFeePerPaxCny: 0,
    });
    // 1380 + 0.5×2162×3 + (2×188) + 280 = 1380 + 3243 + 376 + 280 = 5279
    expect(result).toBe(5279);
  });

  it('operationFeePerPaxCny：默认 ¥20 直接加一次（起价已是 1 人口径，不再乘人数）', () => {
    const result = computeBundleOriginalPerPaxCny({
      items,
      nights: 3,
      hotelRoomTypeNightlyCny: 2162,
      flightRoundTripPerPaxCny: 1380,
      operationFeePerPaxCny: 20,
    });
    // 旧公式 5279 + 操作费 20 = 5299
    expect(result).toBe(5299);
  });

  it('operationFeePerPaxCny 按套餐可配置（如 ¥30）→ 起价对应上调', () => {
    const result = computeBundleOriginalPerPaxCny({
      items: [],
      nights: 1,
      hotelRoomTypeNightlyCny: null,
      flightRoundTripPerPaxCny: null,
      operationFeePerPaxCny: 30,
    });
    expect(result).toBe(30);
  });

  it('transferTotal 按 Σ(qty×unitPrice)（多条 TRANSFER 组件累加，不按人头拆分）', () => {
    const twoTransfers: BundleItemPriceInput[] = [
      { kind: 'TRANSFER', qty: 2, unitPrice: 188 }, // 机场接送来回
      { kind: 'TRANSFER', qty: 1, unitPrice: 588 }, // 加购一日包车
    ];
    const result = computeBundleOriginalPerPaxCny({
      items: twoTransfers,
      nights: 1,
      hotelRoomTypeNightlyCny: null,
      flightRoundTripPerPaxCny: null,
      operationFeePerPaxCny: 0,
    });
    // (2×188) + (1×588) = 964，其余项 0（无机票参考/无房型/无操作费）
    expect(result).toBe(964);
  });

  it('visaPerPax 按 Σ(unitPrice)（忽略 qty —— qty 表达人数，起价只为 1 人定价）', () => {
    const twoVisaComponents: BundleItemPriceInput[] = [
      { kind: 'VISA', qty: 2, unitPrice: 280 }, // 2 人份越南签证，但起价只算 1 人的单价
      { kind: 'VISA', qty: 4, unitPrice: 50 }, // 另一国签证组件（同样忽略 qty）
    ];
    const result = computeBundleOriginalPerPaxCny({
      items: twoVisaComponents,
      nights: 1,
      hotelRoomTypeNightlyCny: null,
      flightRoundTripPerPaxCny: null,
      operationFeePerPaxCny: 0,
    });
    expect(result).toBe(280 + 50);
  });

  it('无关联房型（hotelRoomTypeNightlyCny=null）→ 住宿项按 0 计，不影响其余各项', () => {
    const result = computeBundleOriginalPerPaxCny({
      items: [{ kind: 'TRANSFER', qty: 1, unitPrice: 100 }],
      nights: 5, // 即便 nights>0，没有房型夜价就无从计价，不应凭空产生费用
      hotelRoomTypeNightlyCny: null,
      flightRoundTripPerPaxCny: 1000,
      operationFeePerPaxCny: 0,
    });
    expect(result).toBe(1000 + 100);
  });

  it('无可估机票（flightRoundTripPerPaxCny=null）→ 机票项按 0 计（不是报错，只是该项归零）', () => {
    const result = computeBundleOriginalPerPaxCny({
      items: [],
      nights: 2,
      hotelRoomTypeNightlyCny: 1000,
      flightRoundTripPerPaxCny: null,
      operationFeePerPaxCny: 0,
    });
    expect(result).toBe(0.5 * 1000 * 2);
  });

  it('items 非数组等畸形形状 → 安全兜底为空（不抛错），只剩机票+住宿两项', () => {
    const result = computeBundleOriginalPerPaxCny({
      items: 'garbage' as unknown as BundleItemPriceInput[],
      nights: 2,
      hotelRoomTypeNightlyCny: 1000,
      flightRoundTripPerPaxCny: 500,
      operationFeePerPaxCny: 0,
    });
    expect(result).toBe(500 + 0.5 * 1000 * 2);
  });

  it('结果四舍五入取整（CNY 不留小数）', () => {
    const result = computeBundleOriginalPerPaxCny({
      items: [],
      nights: 1,
      hotelRoomTypeNightlyCny: 1, // 0.5×1×1 = 0.5 → 四舍五入
      flightRoundTripPerPaxCny: null,
      operationFeePerPaxCny: 0,
    });
    expect(Number.isInteger(result)).toBe(true);
  });
});

describe('computeBundleOriginalAllInCny · 整包原价锚点（本次改版未变的既有口径回归）', () => {
  it('地面合计（非 FLIGHT 行 Σqty×unitPrice）+ 来回机票×flightPax', () => {
    const items: BundleItemPriceInput[] = [
      { kind: 'FLIGHT', qty: 1, unitPrice: 0 },
      { kind: 'HOTEL', qty: 3, unitPrice: 1880 },
      { kind: 'TRANSFER', qty: 2, unitPrice: 188 },
    ];
    // 地面 = 3×1880 + 2×188 = 5640+376 = 6016；机票 = 1380×2 = 2760；合计 8776
    expect(computeBundleOriginalAllInCny(items, 2, 1380)).toBe(8776);
  });

  it('flightRefRoundTripCny=null → 仅返回地面合计', () => {
    const items: BundleItemPriceInput[] = [{ kind: 'HOTEL', qty: 1, unitPrice: 500 }];
    expect(computeBundleOriginalAllInCny(items, 2, null)).toBe(500);
  });

  it('items 非数组 → 安全兜底为 0 地面合计（防御脏数据，不抛错）', () => {
    expect(computeBundleOriginalAllInCny(null as unknown as BundleItemPriceInput[], 2, 1000)).toBe(2000);
  });
});
