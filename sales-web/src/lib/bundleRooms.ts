/**
 * 套餐房间数（roomsNeeded）前台镜像 —— 与后端 orders.service.computeRoomsNeeded 一一对应。
 *
 * 业务口径（verbatim）：「选的人数一间房坐不下时，自动加房、加的房按房价收钱；
 * 房间数按房型能住几大人几小孩算。」
 *
 *   roomsNeeded = max( ceil(成人 / maxAdults), ceil(占座儿童 / maxChildren), 1 )
 *
 * - 婴儿不占床 → 不参与计算。
 * - 套餐没绑房型 / 容量缺失 → 回退默认 2 大 1 小（DEFAULT_ROOM_MAX_*）。
 * - maxChildren=0 且有占座儿童时：把儿童并入成人维度 ceil((成人+儿童)/maxAdults)（避免除 0）。
 * - 单人入住（singleCount）是独立自愿加价项，**不**计入 roomsNeeded —— 容量驱动房间数，
 *   单人入住是另算的 opt-in 房差。
 *
 * 仅作展示与价格镜像；下单时服务端 computeRoomsNeeded 重算为权威值。
 */

// 与后端常量一致（orders.service.DEFAULT_ROOM_MAX_*）。
export const DEFAULT_ROOM_MAX_ADULTS = 2;
export const DEFAULT_ROOM_MAX_CHILDREN = 1;

/** 套餐关联房型的容量口径（来自后端 serializer；缺省走兜底）。 */
export interface RoomCapacity {
  maxAdults?: number | null;
  maxChildren?: number | null;
}

/** 解析后的有效容量（兜底已应用，maxAdults≥1）。供展示文案"每间最多 X 大 Y 小"复用。 */
export interface ResolvedRoomCapacity {
  maxAdults: number;
  maxChildren: number;
}

/** 应用兜底，得到展示/计算用的有效容量（maxAdults≥1；maxChildren≥0）。 */
export function resolveRoomCapacity(capacity: RoomCapacity | null | undefined): ResolvedRoomCapacity {
  const maxAdults = Math.max(1, Math.trunc(capacity?.maxAdults ?? DEFAULT_ROOM_MAX_ADULTS));
  const maxChildren = Math.max(0, Math.trunc(capacity?.maxChildren ?? DEFAULT_ROOM_MAX_CHILDREN));
  return { maxAdults, maxChildren };
}

/**
 * 按房型容量算所需房间数。镜像 backend orders.service.computeRoomsNeeded（逐行对应）。
 * @param adultCount 成人（占座）
 * @param childCount 占座儿童
 * @param capacity   套餐关联房型容量（null/缺省 → 兜底 2 大 1 小）
 */
export function computeRoomsNeeded(
  adultCount: number,
  childCount: number,
  capacity: RoomCapacity | null | undefined,
): number {
  const { maxAdults, maxChildren } = resolveRoomCapacity(capacity);
  const adults = Math.max(0, adultCount);
  const children = Math.max(0, childCount);

  const adultRooms = Math.ceil(adults / maxAdults);
  // maxChildren=0 → 该房型不单独承载儿童；把儿童并入成人维度（lone-child packing edge case）。
  const childRooms =
    maxChildren > 0 ? Math.ceil(children / maxChildren) : Math.ceil((adults + children) / maxAdults);

  return Math.max(adultRooms, childRooms, 1);
}

// ── SOLO 拼房 / 独住（半间口径）─────────────────────────────────────────────
//
// 单人预订（1 成人、0 儿童）默认「拼房」——与同行客共用一间双人房，只占半间（0.5）。
// 后端权威口径（与并行开发的服务端一致）：
//   SOLO 且 singleCount==0 → 酒店按 0.5 间计价（拼房价 = 0.5 × 房价 × 晚）。
//   SOLO 且 singleCount==1 → 整间 + 单房差（full room + 单房差）。
// 非单人预订不受影响（照旧按容量推 roomsNeeded）。
//
// 前台据此镜像展示价，保证「买家看到的价 == 服务端实收」，避免拼房显示整间价却只收半价的口径撕裂。

/** 单人拼房占用的房间比例（半间）。与后端 0.5 半间口径一致。 */
export const SOLO_SHARED_ROOM_FRACTION = 0.5;

/** 是否为单人预订（1 成人、0 儿童）—— 拼房/独住口径只对单人生效（镜像后端 adultCount==1 && childCount==0）。 */
export function isSoloOccupancy(adultCount: number, childCount: number): boolean {
  return adultCount === 1 && childCount === 0;
}

/**
 * 计费房间比例（展示与提交口径一致）。
 * - 单人拼房（solo 且 singleCount==0）→ 0.5 间（拼房价）。
 * - 其余（含单人独住 singleCount≥1、多人）→ 走容量推的整数房间数 baseRooms。
 * @param adultCount  成人（占座）
 * @param childCount  占座儿童
 * @param singleCount 单人独住份数（0=拼房；≥1=独住）
 * @param baseRooms   按容量算出的整数房间数（computeRoomsNeeded 结果）
 */
export function resolveBundleRoomFactor(
  adultCount: number,
  childCount: number,
  singleCount: number,
  baseRooms: number,
): number {
  if (isSoloOccupancy(adultCount, childCount) && singleCount <= 0) {
    return SOLO_SHARED_ROOM_FRACTION;
  }
  return baseRooms;
}

// ── 套餐住宿晚数（nights）解析 ───────────────────────────────────────────────
//
// 单一口径，镜像后端（与 backend 对齐）：
//   nights = hotelNights ?? (第一条 HOTEL item 的 qty) ?? 默认 4 晚
//
// 背景：套餐真实晚数来自 HOTEL 行项的 qty（如 "凯悦 3 晚" → HOTEL qty=3）；
// 历史数据里 hotelNights 多为 null，直接回退默认 4 晚会让 1/3 晚的产品错显「4 晚」、
// 算错回程日期与单人入住晚数。故先取 hotelNights，缺省时回落到 HOTEL 行项 qty，再兜底。
//
// 仅作展示与价格镜像；下单时由服务端重算为权威值。

/** 套餐晚数兜底（最后才用；与展示口径一致）。 */
export const DEFAULT_NIGHTS = 4;

/** resolveBundleNights 所需的最小套餐视图结构（两处页面视图均已携带）。 */
export interface BundleNightsView {
  hotelNights?: number | null;
  items?: ReadonlyArray<{ kind: string; qty?: number | null }> | null;
}

/**
 * 解析套餐住宿晚数。
 * @returns hotelNights（非 null）→ 否则第一条 HOTEL item 的 qty（≥1）→ 否则 DEFAULT_NIGHTS。
 */
export function resolveBundleNights(b: BundleNightsView | null | undefined): number {
  if (b?.hotelNights != null) return b.hotelNights;
  const hotelItem = b?.items?.find((i) => i.kind === 'HOTEL');
  const hotelQty = hotelItem?.qty;
  if (hotelQty != null && hotelQty >= 1) return hotelQty;
  return DEFAULT_NIGHTS;
}
