/**
 * 套餐购物车行的散客展示价 —— 购物车页与结算页共用（F-9）。
 *
 * 之前 CartPage 永远用加购那一刻快照的 unitPrice×qty，CheckoutPage 却按「当前」
 * 散客优惠费率重算，两页在同一批已勾选商品上能看到不同总价（客诉"怎么价格变了"）。
 * 这里把 CheckoutPage 原有的算法与拉取当前费率的逻辑一起抽出来，两页都改用同一份，
 * 保证「加入购物车 → 结账」全程数字一致。
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import type { CartItem } from '../stores/cart';

/**
 * 套餐行金额：percent-off 后再扣公开优惠 × 出行人数。
 * BundleDetailPage 把 percentTotal/retailDiscountPerPersonCny 快照写入 meta；
 * 老购物车没有这些字段、或非 BUNDLE 行时沿用原 unitPrice×qty，行为保持不变。
 */
export function bundleLineTotal(item: CartItem, retailDiscountOverride?: number): number {
  const rawPercentTotal = Number(item.meta?.percentTotal);
  const percentTotal = Number.isFinite(rawPercentTotal)
    ? rawPercentTotal
    : item.kind === 'BUNDLE'
      ? Number(item.unitPrice)
      : Number.NaN;
  const rawRetailDiscount = retailDiscountOverride ?? Number(item.meta?.retailDiscountPerPersonCny);
  if (item.kind !== 'BUNDLE' || !Number.isFinite(percentTotal) || !Number.isFinite(rawRetailDiscount)) {
    return Number(item.unitPrice) * Number(item.qty) || 0;
  }
  const adult = Number(item.meta?.adultCount);
  const child = Number(item.meta?.childCount);
  const infant = Number(item.meta?.infantCount);
  const hasCounts = Number.isFinite(adult) || Number.isFinite(child) || Number.isFinite(infant);
  const pax = hasCounts
    ? Math.max(0, (Number.isFinite(adult) ? adult : 0) + (Number.isFinite(child) ? child : 0) + (Number.isFinite(infant) ? infant : 0))
    : Math.max(1, Number(item.meta?.pax) || 1);
  const perUnit = Math.max(0, Math.round(percentTotal - rawRetailDiscount * pax));
  return perUnit * Number(item.qty);
}

/**
 * 拉取购物车里各套餐行「当前」散客优惠费率（按出发日/档次/晚数实时查询），
 * 覆盖加购那一刻写入 meta 的旧快照——配合 bundleLineTotal 使用即可让购物车页
 * 与结算页对同一批商品算出一致的总价（F-9）。
 * 查询失败时保留详情页写入的快照（meta.retailDiscountPerPersonCny），不阻塞展示。
 */
export function useRetailDiscountByItemId(items: CartItem[]): Record<string, number> {
  const [retailDiscountByItemId, setRetailDiscountByItemId] = useState<Record<string, number>>({});

  useEffect(() => {
    const bundleItems = items.filter((item) => item.kind === 'BUNDLE' && item.meta?.goDate);
    if (bundleItems.length === 0) {
      setRetailDiscountByItemId({});
      return;
    }
    let cancelled = false;
    api
      .listBundles()
      .then(async ({ bundles }) => {
        const entries = await Promise.all(
          bundleItems.map(async (item) => {
            const bundle = bundles.find((candidate) => candidate.id === item.productId);
            if (!bundle?.settlementTier || bundle.settlementNights == null) return [item.id, 0] as const;
            const result = await api.getRetailSettlementDiscount({
              tier: bundle.settlementTier,
              nights: bundle.settlementNights,
              departDate: String(item.meta?.goDate),
            });
            if (!result) return null;
            return [item.id, result.discountPerPersonCny] as const;
          }),
        );
        if (!cancelled) {
          const successfulEntries = entries.filter(
            (entry): entry is readonly [string, number] => entry !== null,
          );
          setRetailDiscountByItemId(Object.fromEntries(successfulEntries));
        }
      })
      .catch(() => {
        if (!cancelled) setRetailDiscountByItemId({});
      });
    return () => {
      cancelled = true;
    };
  }, [items]);

  return retailDiscountByItemId;
}
