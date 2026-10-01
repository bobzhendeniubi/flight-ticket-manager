/**
 * 改期弹窗「房是否一起变动」的住宿预览（仅展示；后端 planFollowTripHotelStay 是权威，规则同源）。
 *
 * 与后端对齐的两处口径：
 *   · 占房行 = hotelCheckIn 非空 **且**（hotelRoomTypeId 非空 或 randomStarTier 非空），不看 kind
 *     （后端 rescheduleOrderItem 的 hotelRows 查询就是这三个条件；没盖房型也没挂随机档的行后端不动，
 *     预览若把它算进窗口会报出一个后端不会写的日期）；
 *   · 航段顺序按班次 **UTC 时刻** 升序（后端 determineFlightLegItems 按 departureTime 排），item 上带
 *     departureAt（ISO 瞬间）就用它；老后端没有这个字段时回落到「当地出发日 + 时刻」字串比较。
 */
import type { OrderItem } from './api';

/** YYYY-MM-DD 加 N 天（UTC date-only，与后端 addDaysToYmd 同口径）。 */
export function addDaysYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 两个 YYYY-MM-DD 的整天数差（b − a）。 */
export function daysBetweenYmd(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);
}

/** 两个 YYYY-MM-DD 之间的晚数；非法/退房不晚于入住 → null（调用方据此拦提交）。 */
export function countNightsBetween(checkIn: string, checkOut: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) return null;
  const start = Date.parse(`${checkIn}T00:00:00.000Z`);
  const end = Date.parse(`${checkOut}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.round((end - start) / 86_400_000);
}

export interface RescheduleStayPreview {
  /** 当前整单占房窗口（最早入住 ~ 最晚离店）。 */
  current: { checkIn: string; checkOut: string | null; nights: number };
  /** 房跟着新行程走：入住/离店锚定新去程/回程日（保留原相对偏移）。null = 还没选新班次或单程单（退化为整体平移）。 */
  followTrip: { checkIn: string; checkOut: string | null; nights: number } | null;
  /** 整体平移保晚数（最早出发日平移了几天，住宿同移几天）。null = 还没选新班次。 */
  shift: { checkIn: string; checkOut: string | null; nights: number } | null;
}

/** 预览要读的订单行字段（真实入参是 OrderItem，这里只列用到的，便于单测喂最小对象）。 */
export type RescheduleStayPreviewItem = Pick<
  OrderItem,
  | 'id'
  | 'kind'
  | 'flightScheduleId'
  | 'departureDate'
  | 'departureTime'
  | 'departureAt'
  | 'hotelCheckIn'
  | 'hotelCheckOut'
  | 'hotelRoomTypeId'
  | 'randomStarTier'
>;

/** 被改那一段的新班次：当地出发日（按 departureTz 折）+ UTC 瞬间（ISO，可缺）。 */
export interface RescheduleNewLeg {
  date: string;
  at: string | null;
}

/** 与后端 hotelRows 同一份筛选：hotelCheckIn 非空且（盖了房型 或 挂了随机档）。 */
export function isReschedulePreviewHotelRow(it: RescheduleStayPreviewItem): boolean {
  return Boolean(it.hotelCheckIn) && (Boolean(it.hotelRoomTypeId) || it.randomStarTier != null);
}

type LegRow = { id: string; date: string; time: string; at: string | null };

/**
 * 航段升序：全部航段都带 UTC 瞬间 → 按瞬间比（与后端 determineFlightLegItems 同口径）；
 * 否则回落到「当地出发日 + 时刻」字串比较。同刻再按 id 固化。
 */
function sortLegs(rows: LegRow[]): LegRow[] {
  const useInstant = rows.length > 0 && rows.every((r) => r.at != null && Number.isFinite(Date.parse(r.at)));
  return [...rows].sort((a, b) => {
    const primary = useInstant
      ? Date.parse(a.at!) - Date.parse(b.at!)
      : `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`);
    return primary || a.id.localeCompare(b.id);
  });
}

export function previewRescheduleStay(
  orderItems: RescheduleStayPreviewItem[],
  changedItemId: string,
  newLeg: RescheduleNewLeg | null,
): RescheduleStayPreview | null {
  const hotelRows = orderItems.filter(isReschedulePreviewHotelRow);
  if (hotelRows.length === 0) return null;
  const checkIns = hotelRows.map((it) => (it.hotelCheckIn ?? '').slice(0, 10)).sort();
  const checkOuts = hotelRows.flatMap((it) => (it.hotelCheckOut ? [it.hotelCheckOut.slice(0, 10)] : [])).sort();
  const windowStart = checkIns[0];
  const windowEnd = checkOuts.length > 0 ? checkOuts[checkOuts.length - 1] : null;
  const nightsOf = (checkIn: string, checkOut: string | null) =>
    checkOut ? (countNightsBetween(checkIn, checkOut) ?? 0) : 0;
  const current = { checkIn: windowStart, checkOut: windowEnd, nights: nightsOf(windowStart, windowEnd) };
  if (!newLeg) return { current, followTrip: null, shift: null };
  const legs: LegRow[] = orderItems
    .filter((it) => it.kind === 'FLIGHT' && it.flightScheduleId && it.departureDate)
    .map((it) => ({ id: it.id, date: it.departureDate ?? '', time: it.departureTime ?? '', at: it.departureAt ?? null }));
  const before = sortLegs(legs);
  const after = sortLegs(legs.map((l) => (l.id === changedItemId ? { ...l, date: newLeg.date, at: newLeg.at } : l)));
  if (before.length === 0 || after.length === 0) return { current, followTrip: null, shift: null };
  const delta = daysBetweenYmd(before[0].date, after[0].date);
  const shift = {
    checkIn: addDaysYmd(windowStart, delta),
    checkOut: windowEnd ? addDaysYmd(windowEnd, delta) : null,
    nights: current.nights,
  };
  if (before.length < 2 || after.length < 2) return { current, followTrip: null, shift };
  const newStart = addDaysYmd(after[0].date, daysBetweenYmd(before[0].date, windowStart));
  const newEnd = windowEnd ? addDaysYmd(after[1].date, daysBetweenYmd(before[1].date, windowEnd)) : null;
  return { current, shift, followTrip: { checkIn: newStart, checkOut: newEnd, nights: nightsOf(newStart, newEnd) } };
}
