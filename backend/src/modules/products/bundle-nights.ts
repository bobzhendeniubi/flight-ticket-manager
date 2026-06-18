/**
 * 套餐「住宿晚数」的单一权威口径（single source of truth）。
 *
 * 历史问题：Bundle.hotelNights 可空，过去三处各自用 `hotelNights ?? <硬编码默认>` 解析，
 * 且默认值不一致（可售日期用 4、订单单人入住用 1），且都没回退到 HOTEL 组件的 qty
 * —— 而 HOTEL 组件 qty 才是真实晚数。结果：null-hotelNights 的套餐回程日期/可售回程段/
 * 单人入住房差按错误的晚数计算（财务 bug）。
 *
 * 统一规则（所有读取方必须走这里）：
 *   resolveBundleNights(items, hotelNights) =
 *     hotelNights ?? (items 里第一个 kind==='HOTEL' 的 qty) ?? DEFAULT_BUNDLE_NIGHTS
 *
 * 同时把过去两个常量（DEFAULT_BUNDLE_NIGHTS=4 / DEFAULT_BUNDLE_HOTEL_NIGHTS=1）
 * 合并为唯一一个 DEFAULT_BUNDLE_NIGHTS。取值 1（安全最小值）：HOTEL-qty 回退已覆盖所有
 * 真实套餐（每个套餐都带 HOTEL 组件），默认值只在「既无 hotelNights 又无 HOTEL 组件」的
 * 极端异常形状时兜底，宁可少算晚数也不超算（避免凭空多收单人入住房差 / 多推回程日期）。
 */

/** 套餐未配置 hotelNights 且无 HOTEL 组件时的兜底晚数（安全最小值）。 */
export const DEFAULT_BUNDLE_NIGHTS = 1;

/**
 * 从 items JSON 里取第一个 HOTEL 组件的 qty（即真实住宿晚数）。
 * 容错：items 非数组、元素非对象、kind 不是 HOTEL、qty 非数字/<1 → 跳过。
 * 找不到任何可用 HOTEL.qty → 返回 null（调用方落到 DEFAULT_BUNDLE_NIGHTS）。
 */
export function firstHotelQty(items: unknown): number | null {
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    if (it == null || typeof it !== 'object') continue;
    const rec = it as { kind?: unknown; qty?: unknown };
    if (rec.kind !== 'HOTEL') continue;
    if (typeof rec.qty !== 'number' || !Number.isFinite(rec.qty)) continue;
    const qty = Math.trunc(rec.qty);
    if (qty >= 1) return qty;
  }
  return null;
}

/**
 * 套餐住宿晚数的唯一权威解析口径（纯函数）。
 *
 *   hotelNights 显式配置 → 用之（仍做 ≥1 保底）；
 *   否则 → 第一个 HOTEL 组件的 qty（真实晚数）；
 *   再否则 → DEFAULT_BUNDLE_NIGHTS。
 *
 * 返回值恒为整数且 ≥1（住宿晚数下限保护）。
 *
 * @param items       Bundle.items（JSON，未知形状；内部安全解析）
 * @param hotelNights Bundle.hotelNights（可空）
 */
export function resolveBundleNights(items: unknown, hotelNights: number | null): number {
  const explicit =
    typeof hotelNights === 'number' && Number.isFinite(hotelNights)
      ? Math.trunc(hotelNights)
      : null;
  const raw = explicit ?? firstHotelQty(items) ?? DEFAULT_BUNDLE_NIGHTS;
  return Math.max(1, raw);
}
