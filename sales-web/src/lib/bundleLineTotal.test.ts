/**
 * bundleLineTotal 单测（F-9）：购物车页与结算页共用同一份套餐算价，
 * 覆盖「有 percentTotal 快照走重算」「非 BUNDLE / 老数据缺字段时回退 unitPrice×qty」
 * 「retailDiscountOverride 优先于 meta 快照」三条分支——这正是修复前两页会算出
 * 不同总价的根因。
 */
import { describe, it, expect } from 'vitest';
import { bundleLineTotal } from './bundleLineTotal';
import type { CartItem } from '../stores/cart';

function makeBundleItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    id: 'row-1',
    kind: 'BUNDLE',
    productId: 'bundle-1',
    name: '岘港 4 天 3 晚',
    emoji: '🏝️',
    unitPrice: 3000, // 加购那一刻的旧快照（可能已过时）
    qty: 1,
    addedAt: '2026-09-01T00:00:00Z',
    meta: {
      percentTotal: 3000,
      retailDiscountPerPersonCny: 100,
      adultCount: 2,
      childCount: 0,
      infantCount: 0,
      goDate: '2026-10-01',
    },
    ...overrides,
  };
}

describe('bundleLineTotal', () => {
  it('BUNDLE 行按 percentTotal - 折扣×人数 重算，不用旧的 unitPrice 快照', () => {
    const item = makeBundleItem({ unitPrice: 9999 /* 故意留一个过时的旧总价 */ });
    // percentTotal(3000) - discount(100) * pax(2) = 2800
    expect(bundleLineTotal(item)).toBe(2800);
  });

  it('传入 retailDiscountOverride 时优先于 meta 里的旧折扣快照（结算页/购物车页拉到的「当前」费率）', () => {
    const item = makeBundleItem();
    // percentTotal(3000) - override(150) * pax(2) = 2700，而不是用 meta 里的 100
    expect(bundleLineTotal(item, 150)).toBe(2700);
  });

  it('购物车页与结算页对同一行传入相同参数时算出相同总价（回归 F-9 的核心诉求）', () => {
    const cartSideItem = makeBundleItem();
    const checkoutSideItem = makeBundleItem();
    const liveDiscount = 120; // 模拟两页各自向后端查到的「当前」折扣
    expect(bundleLineTotal(cartSideItem, liveDiscount)).toBe(
      bundleLineTotal(checkoutSideItem, liveDiscount),
    );
  });

  it('qty > 1 时按份数整体倍乘', () => {
    const item = makeBundleItem({ qty: 3 });
    // perUnit = 3000 - 100*2 = 2800；× qty 3 = 8400
    expect(bundleLineTotal(item)).toBe(8400);
  });

  it('非 BUNDLE 行永远回退 unitPrice×qty，不受 meta 影响', () => {
    const item = makeBundleItem({
      kind: 'HOTEL',
      unitPrice: 500,
      qty: 2,
      meta: { percentTotal: 3000, retailDiscountPerPersonCny: 100 },
    });
    expect(bundleLineTotal(item)).toBe(1000);
  });

  it('老购物车缺 percentTotal/折扣字段时回退 unitPrice×qty，行为保持不变', () => {
    const item = makeBundleItem({ unitPrice: 2600, qty: 1, meta: undefined });
    expect(bundleLineTotal(item)).toBe(2600);
  });

  it('折算结果不会为负数（哪怕折扣异常大于原价）', () => {
    const item = makeBundleItem({
      meta: { percentTotal: 100, retailDiscountPerPersonCny: 9999, adultCount: 1, childCount: 0, infantCount: 0 },
    });
    expect(bundleLineTotal(item)).toBe(0);
  });
});
