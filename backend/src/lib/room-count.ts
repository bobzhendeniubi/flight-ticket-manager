/**
 * 「这一级到底有没有填房量」的统一判据。
 *
 * 房量取值是多级回落的（订单行 roomsBilled → metadata.roomsNeeded → metadata.rooms →
 * 兜底按人头），而 **0 是真值**：拆单会稳定产出「明说了不占房」的行（典型是只拆不占座
 * 也不占房的婴儿）。所以判据必须是「填没填」，不能是「大不大于 0」。
 *
 * 但反过来，`Number(v)` 松得离谱 —— `Number('') === 0`、`Number(false) === 0`、
 * `Number([]) === 0`。历史脏元数据一撞上就被读成「明确 0 间」，那一行从房量里凭空消失：
 * 销控板少算已用房、超售硬拦截放行、分房表对不上。
 *
 * 口径：
 *   · number 且有限且 ≥ 0 → 就是它（含 0 与 0.5 半间）；
 *   · 纯数字字符串（`/^\d+(\.\d+)?$/`，老行里存过 "0" / "2"）→ 转成数字；
 *   · 其余一律「没填」（''、空白串、boolean、数组、对象、负数、NaN、Infinity、
 *     '1e3' 这类指数写法、null / undefined）→ null，交给下一级回落。
 */
export function readExplicitRoomCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
