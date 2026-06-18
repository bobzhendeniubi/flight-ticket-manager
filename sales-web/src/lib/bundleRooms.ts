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
