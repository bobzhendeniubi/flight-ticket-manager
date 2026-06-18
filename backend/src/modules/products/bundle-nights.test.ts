/**
 * resolveBundleNights · 套餐住宿晚数单一权威口径（vitest 纯函数单测）
 *
 * 覆盖三条核心规则（与历史 bug 修复直接对应）：
 *   1. hotelNights 显式配置 → 用之（不被 HOTEL 组件 qty 覆盖）
 *   2. hotelNights 为 null → 回退首个 HOTEL 组件的 qty（真实晚数，legacy null 行自愈口径）
 *   3. 既无 hotelNights 又无 HOTEL 组件 → DEFAULT_BUNDLE_NIGHTS（=1，安全最小值）
 * 另含 firstHotelQty 的容错分支与 ≥1 下限保护。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveBundleNights,
  firstHotelQty,
  DEFAULT_BUNDLE_NIGHTS,
} from './bundle-nights.js';

describe('resolveBundleNights', () => {
  const hotelItems = [
    { kind: 'FLIGHT', qty: 1 },
    { kind: 'HOTEL', qty: 3 },
    { kind: 'TRANSFER', qty: 1 },
  ];

  it('hotelNights 显式配置 → 用之（即便 HOTEL 组件 qty 不同也不被覆盖）', () => {
    // 显式 5 晚，HOTEL 组件 qty=3 → 取显式 5
    expect(resolveBundleNights(hotelItems, 5)).toBe(5);
  });

  it('hotelNights 为 null → 回退首个 HOTEL 组件的 qty（真实晚数）', () => {
    // 这是 legacy null 行的自愈口径：null → HOTEL.qty=3
    expect(resolveBundleNights(hotelItems, null)).toBe(3);
  });

  it('既无 hotelNights 又无 HOTEL 组件 → DEFAULT_BUNDLE_NIGHTS（=1）', () => {
    const noHotel = [
      { kind: 'FLIGHT', qty: 1 },
      { kind: 'TRANSFER', qty: 1 },
    ];
    expect(resolveBundleNights(noHotel, null)).toBe(DEFAULT_BUNDLE_NIGHTS);
    expect(DEFAULT_BUNDLE_NIGHTS).toBe(1);
  });

  it('显式 hotelNights ≥1 下限保护：0 / 负数回到 1', () => {
    expect(resolveBundleNights(hotelItems, 0)).toBe(1);
    expect(resolveBundleNights(hotelItems, -2)).toBe(1);
  });

  it('显式小数 hotelNights → 截断取整（2.9 → 2）', () => {
    expect(resolveBundleNights(hotelItems, 2.9)).toBe(2);
  });

  it('items 非数组 / 畸形 + 无 hotelNights → 落到默认 1（不抛错）', () => {
    expect(resolveBundleNights(null, null)).toBe(1);
    expect(resolveBundleNights('garbage' as never, null)).toBe(1);
    expect(resolveBundleNights([{ kind: 'HOTEL' }], null)).toBe(1); // qty 缺失 → 跳过 → 默认
  });
});

describe('firstHotelQty', () => {
  it('取第一个合法 HOTEL 组件的 qty', () => {
    expect(
      firstHotelQty([
        { kind: 'HOTEL', qty: 2 },
        { kind: 'HOTEL', qty: 4 },
      ]),
    ).toBe(2);
  });

  it('跳过非 HOTEL / 非数字 qty / qty<1，找不到 → null', () => {
    expect(firstHotelQty([{ kind: 'FLIGHT', qty: 9 }])).toBeNull();
    expect(firstHotelQty([{ kind: 'HOTEL', qty: 'x' }])).toBeNull();
    expect(firstHotelQty([{ kind: 'HOTEL', qty: 0 }])).toBeNull();
    expect(firstHotelQty([])).toBeNull();
    expect(firstHotelQty(undefined)).toBeNull();
  });

  it('小数 qty 截断取整（HOTEL qty=3.7 → 3）', () => {
    expect(firstHotelQty([{ kind: 'HOTEL', qty: 3.7 }])).toBe(3);
  });
});
