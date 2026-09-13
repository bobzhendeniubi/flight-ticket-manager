/**
 * 出行人「界面展示名」——中文名优先、回落拼音全名。
 *
 * 口径与分房表导出的「中文名称」列（backend/src/modules/orders/orders.export-room-allocation.ts
 * 的 resolveChineseName）对齐：
 *   1. chineseName（OCR 识别或手工填写），trim 后非空才采用；
 *   2. 否则用 fullName——直客常直接把中文名录进 fullName，这一支同样能显示中文；
 *   3. 国际票的 fullName 是拼音（如 "YANG/MIAOMIAO"）时，界面上仍要能认人，
 *      所以这里回落显示拼音，而不像导出那样留空。
 *
 * 用途：分房相关界面（分房编辑器的名字 chip、房控页候选订单、订单详情的分房摘要、拆房组
 * 名单）统一走这里，别各写一份，免得几处口径漂移。拼音全名不丢——放进 title 提示，
 * 鼠标悬停能跟护照对上。
 */

/** 展示名：中文名优先，回落拼音全名；两者皆空返回空串（调用方自行兜 '—' / '?'）。 */
export function passengerDisplayName(
  fullName?: string | null,
  chineseName?: string | null,
): string {
  return chineseName?.trim() || fullName?.trim() || '';
}

/**
 * 悬停提示用的拼音全名：只有在展示名 ≠ 拼音全名（即真的显示了中文名）时才返回，
 * 避免 tooltip 与可见文字重复。
 */
export function passengerNameTitle(
  fullName?: string | null,
  chineseName?: string | null,
): string | undefined {
  const latin = fullName?.trim() ?? '';
  if (!latin) return undefined;
  return latin === passengerDisplayName(fullName, chineseName) ? undefined : latin;
}
