/**
 * 机票行「占座数」的唯一口径（婴儿不占座）。
 *
 * 背景（运营公测反馈）：婴儿单独一张单录进去也占了 1 座。根因是纯机票单的 FLIGHT 行
 * `quantity` = 出行人数（含婴儿），而座位账（扣座 CAS / 取消回加 / 改期搬座 / 座位统计）
 * 一直直接吃 `quantity`。套餐路径早已区分 seatPax（成人+儿童）与 headCount，唯独纯机票
 * 路径没有这层。
 *
 * 为什么不直接把 quantity 改成「不含婴儿」：
 *   · createOrder 的乘客数校验要求 max(FLIGHT quantity) === passengers.length，婴儿单
 *     quantity=0 过不了校验；
 *   · 金额 = unitPrice × quantity，改 quantity 就动了钱的口径。
 * 所以把「占座数」从 quantity 里独立出来，落在 `metadata.seatQuantity`：
 *   · 建单时由服务端按派生后的 passengerType 算出并写入（客户端传值一律剥掉）；
 *   · 所有座位账站点读 `flightSeatQuantity(item)`，金额 / 乘客数校验 / 出票额度 / PNR 导出一概不动；
 *   · 历史行没有这个键 → 回落 quantity（现状），由只读脚本 scan-infant-seat-orders 另行清查。
 */

/** FLIGHT 行 metadata 上的占座数键。 */
export const FLIGHT_SEAT_QUANTITY_KEY = 'seatQuantity';
/** FLIGHT 行 metadata 上的「本单婴儿数」键（审计 / 排障用，不参与座位账）。 */
export const FLIGHT_INFANT_COUNT_KEY = 'infantCount';

export interface FlightSeatItemLike {
  quantity: number;
  metadata?: unknown;
}

function readNonNegativeInt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = Math.trunc(raw);
  return n >= 0 ? n : null;
}

/**
 * 这一条机票行**占几座**：`metadata.seatQuantity`（夹在 [0, quantity]）；缺省 / 畸形 → quantity。
 *
 * 上限夹到 quantity：座位数绝不能比行数量还多（否则释放会多放）；下限 0：婴儿单独一单。
 */
export function flightSeatQuantity(item: FlightSeatItemLike): number {
  const quantity = Math.max(0, Math.trunc(item.quantity));
  const meta = item.metadata;
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return quantity;
  const explicit = readNonNegativeInt((meta as Record<string, unknown>)[FLIGHT_SEAT_QUANTITY_KEY]);
  if (explicit == null) return quantity;
  return Math.min(explicit, quantity);
}

/** 这一行的 metadata 里有没有显式写过占座数（脚本判「缺省」用）。 */
export function hasExplicitFlightSeatQuantity(item: FlightSeatItemLike): boolean {
  const meta = item.metadata;
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return false;
  return readNonNegativeInt((meta as Record<string, unknown>)[FLIGHT_SEAT_QUANTITY_KEY]) != null;
}

/**
 * 建单时算这一行的占座数 = min(quantity, 本单非婴儿出行人数)，夹在 [0, quantity]。
 *
 * 用 min 而不是 `quantity − 婴儿数`，是为了让三条建单路径共用一个公式：
 *   · 纯机票（单笔录单 / 批量）：quantity = 出行人数 → 占座 = 非婴儿人数；
 *   · 套餐机票腿：quantity 已经是 seatPax（成人+儿童）= 非婴儿人数 → 占座 = quantity（不重复扣）；
 *   · 婴儿单独一单：quantity 1、非婴儿 0 → 占座 0。
 */
export function resolveFlightSeatQuantity(quantity: number, nonInfantPax: number): number {
  const qty = Math.max(0, Math.trunc(quantity));
  const seats = Math.max(0, Math.trunc(nonInfantPax));
  return Math.min(qty, seats);
}

/** 建单落库前给 FLIGHT 行 metadata 盖上占座数与婴儿数（覆盖同名键）。 */
export function withFlightSeatMetadata(
  metadata: Record<string, unknown> | undefined,
  stamp: { seatQuantity: number; infantCount: number },
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [FLIGHT_SEAT_QUANTITY_KEY]: Math.max(0, Math.trunc(stamp.seatQuantity)),
    [FLIGHT_INFANT_COUNT_KEY]: Math.max(0, Math.trunc(stamp.infantCount)),
  };
}

/**
 * 剥掉客户端塞进来的占座数 / 婴儿数键：占座数只能由服务端按派生后的乘客类型写入，
 * 否则匿名可达的 POST /orders 传 `seatQuantity: 0` 就能下一张不占座的单。
 */
export function stripClientFlightSeatMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const {
    [FLIGHT_SEAT_QUANTITY_KEY]: _clientSeatQuantity,
    [FLIGHT_INFANT_COUNT_KEY]: _clientInfantCount,
    ...rest
  } = metadata;
  return rest;
}
