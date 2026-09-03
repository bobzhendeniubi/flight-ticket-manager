/**
 * 存量半间行的**拆单配对键回填** —— 判定内核（纯函数，零 IO，可单测）。
 *
 * 背景：一间房被拆单劈成两张单的两个半间时，现在两侧会写同一个 `splitPairKey`
 *（见 split-move-strategies 的 splitPairKeyOf / orders.service 的 splitMixedRoomGroup），
 * 房控的 expandSplitPairedByDate 据此把它们**配回一间**。
 * 配对键是后加的：在它之前拆出来的存量行没有这把键，房控只能退回按房型/性别推算 ——
 * 夫妻拼房被拆开正是「一男一女各半间」，性别口径会把本来的一间算成两间，凭空多占房。
 *
 * 本文件只回答一个问题：**这两行（这两个房组）到底是不是同一间房被劈开的两半？**
 * 判据必须严到「宁可不配，也绝不错配」—— 错配会把两间真实的半间房强行并成一间，
 * 房控看到的可用房量凭空多出来一间，直接导致超卖。所以要求全部满足：
 *
 *   1. 新行 metadata 上有 `splitFromItemId`（确实是拆出来的行）；
 *   2. 新行与源行 **roomsBilled 都恰好是 0.5**（真的是各占半间）；
 *   3. 同 kind（HOTEL ↔ HOTEL、BUNDLE ↔ BUNDLE）、且分属两张不同的订单；
 *   4. 同酒店房型（hotelRoomTypeId 相等；都为空时星级随机档 randomStarTier 也要相等）；
 *   5. 同入住区间（checkIn / checkOut 逐日相等）；
 *   6. 两侧都**还没有** splitPairKey（已经有的一律不碰，避免覆盖真实拆单写下的键）。
 *
 * 房组侧同理：两张单各自的分房表里，符合「半间 + 无配对键 + **显式归属这一行**」的房组
 * **各恰好一个**时才配对 —— 有两个以上就无从判断谁配谁，一律跳过交人工。
 * 没写 orderItemId 的老房组一个都不碰（原因 ROOM_GROUP_UNOWNED_REASON）：一张单有两行住宿时，
 * 「按本单兜底」会把另一行的半房组配过来，两间真房并成一间，房量凭空多一间 = 超卖。
 */

import { OrderItemKind } from '@prisma/client';

/** 回填要看的订单行最小形状（roomsBilled 已由调用方转成 number）。 */
export interface BackfillItemView {
  id: string;
  orderId: string;
  kind: OrderItemKind;
  hotelRoomTypeId: string | null;
  randomStarTier: number | null;
  hotelCheckIn: Date | string | null;
  hotelCheckOut: Date | string | null;
  roomsBilled: number | null;
  metadata: unknown;
}

/** 分房表里的一个房组（只列本回填用到的字段）。 */
export interface BackfillRoomGroupView {
  id?: unknown;
  hotelName?: unknown;
  roomType?: unknown;
  passengerIds?: unknown;
  roomFraction?: unknown;
  splitPairKey?: unknown;
  orderItemId?: unknown;
}

export type PairDecision = { ok: true; splitPairKey: string } | { ok: false; reason: string };

// ── 小工具 ──────────────────────────────────────────────────────────────────

function readObject(raw: unknown): Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** date-only 归一化：`@db.Date` 过 Prisma 是 Date、过 JSON 是完整 ISO 串，统一切到 YYYY-MM-DD。 */
export function dateOnly(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  return typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : null;
}

/** 恰好半间（按 0.5 网格判定，消除 Decimal → number 的浮点尾数）。 */
export function isHalfRoom(rooms: number | null | undefined): boolean {
  if (rooms == null || !Number.isFinite(rooms)) return false;
  return Math.round(rooms * 2) === 1;
}

/** 该行/该房组是否已经有配对键（有就一律不碰）。 */
function hasPairKey(source: unknown): boolean {
  const key = readObject(source).splitPairKey;
  return typeof key === 'string' && key !== '';
}

/** 拆出来的行指向的源行 id（不是拆出来的行 → null）。 */
export function splitFromItemIdOf(metadata: unknown): string | null {
  const id = readObject(metadata).splitFromItemId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** 回填键：`源行id:backfill-<拆单记录 requestToken 或 新行 id>`。 */
export function buildBackfillPairKey(
  sourceItemId: string,
  requestToken: string | null | undefined,
  splitItemId: string,
): string {
  const suffix = requestToken != null && requestToken !== '' ? requestToken : splitItemId;
  return `${sourceItemId}:backfill-${suffix}`;
}

// ── 订单行配对判定 ──────────────────────────────────────────────────────────

/** 可参与回填的行类型（只有住宿相关的行才有「半间」这回事）。 */
const PAIRABLE_KINDS: OrderItemKind[] = [OrderItemKind.HOTEL, OrderItemKind.BUNDLE];

/**
 * 这两行是不是同一间房被劈开的两半？是 → 给出该写的 splitPairKey。
 *
 * @param splitItem    带 splitFromItemId 的那一行（拆出来的新行）
 * @param sourceItem   splitFromItemId 指向的源行（找不到传 null）
 * @param requestToken 该次拆单记录的 requestToken（取不到传 null，键里回落到新行 id）
 */
export function decideItemPair(
  splitItem: BackfillItemView,
  sourceItem: BackfillItemView | null,
  requestToken: string | null,
): PairDecision {
  const sourceId = splitFromItemIdOf(splitItem.metadata);
  if (sourceId == null) return { ok: false, reason: '新行没有 splitFromItemId（不是拆出来的行）' };
  if (!PAIRABLE_KINDS.includes(splitItem.kind)) {
    return { ok: false, reason: `行类型 ${splitItem.kind} 不参与房间配对` };
  }
  if (!isHalfRoom(splitItem.roomsBilled)) {
    return { ok: false, reason: `新行 roomsBilled=${splitItem.roomsBilled ?? 'null'} 不是半间` };
  }
  if (sourceItem == null) return { ok: false, reason: `源行 ${sourceId} 不存在（可能已被删除）` };
  if (sourceItem.id !== sourceId) return { ok: false, reason: '源行 id 与 splitFromItemId 不一致' };
  if (sourceItem.orderId === splitItem.orderId) {
    // 同一张单内的两个半间不需要配对键：房控本来就按同单同房型合并。
    return { ok: false, reason: '源行与新行在同一张订单里（不是跨单的两个半间）' };
  }
  if (sourceItem.kind !== splitItem.kind) {
    return { ok: false, reason: `源行类型 ${sourceItem.kind} 与新行 ${splitItem.kind} 不一致` };
  }
  if (!isHalfRoom(sourceItem.roomsBilled)) {
    return { ok: false, reason: `源行 roomsBilled=${sourceItem.roomsBilled ?? 'null'} 不是半间` };
  }
  if (sourceItem.hotelRoomTypeId !== splitItem.hotelRoomTypeId) {
    return { ok: false, reason: '两行不是同一个酒店房型' };
  }
  if (
    sourceItem.hotelRoomTypeId == null &&
    (sourceItem.randomStarTier ?? null) !== (splitItem.randomStarTier ?? null)
  ) {
    return { ok: false, reason: '两行的星级随机档不一致' };
  }
  const inA = dateOnly(sourceItem.hotelCheckIn);
  const inB = dateOnly(splitItem.hotelCheckIn);
  const outA = dateOnly(sourceItem.hotelCheckOut);
  const outB = dateOnly(splitItem.hotelCheckOut);
  if (inA == null || inB == null || inA !== inB || outA == null || outB == null || outA !== outB) {
    return { ok: false, reason: '两行的入住区间不一致（或缺失）' };
  }
  if (hasPairKey(sourceItem.metadata) || hasPairKey(splitItem.metadata)) {
    return { ok: false, reason: '两行中已有配对键（不覆盖）' };
  }
  return { ok: true, splitPairKey: buildBackfillPairKey(sourceItem.id, requestToken, splitItem.id) };
}

// ── 房组配对判定 ────────────────────────────────────────────────────────────

/** 半房组的粗筛：有出行人、没配对键、占半间。归属另算（见 classifyGroup）。 */
function isHalfCandidateGroup(group: BackfillRoomGroupView): boolean {
  const ids = group.passengerIds;
  if (!Array.isArray(ids) || ids.length === 0) return false;
  if (hasPairKey(group)) return false;
  const fraction = group.roomFraction == null ? 1 : Number(group.roomFraction);
  return isHalfRoom(fraction);
}

/**
 * 该半房组与这一行的关系。
 *
 * `OWNED` 才参与回填 —— **只认显式写了 orderItemId 的房组**。
 * 老分房表（没写归属）曾经按「属于本单那一行」放行：一张单有两行住宿（比如前后两段酒店）
 * 时，这个「兜底」会把另一行的半房组当成这一行的，两侧各挑一个一拍即合，
 * 把两间真房并成一间 —— 房控看到的可用房量凭空多一间，直接超卖。
 * 宁可少配、留给人工，也不能错配。
 */
type GroupOwnership = 'OWNED' | 'UNOWNED' | 'FOREIGN';

function classifyGroup(group: BackfillRoomGroupView, itemId: string): GroupOwnership {
  const owner = group.orderItemId;
  if (typeof owner !== 'string' || owner === '') return 'UNOWNED';
  return owner === itemId ? 'OWNED' : 'FOREIGN';
}

/** 房组上可能带的入住区间（老/新分房表字段名都试一遍；没有就当没写）。 */
function groupStayRange(group: BackfillRoomGroupView): { checkIn: string | null; checkOut: string | null } {
  const raw = group as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = raw[key];
      if (value instanceof Date || typeof value === 'string') {
        const iso = dateOnly(value);
        if (iso != null) return iso;
      }
    }
    return null;
  };
  return {
    checkIn: pick('checkIn', 'hotelCheckIn', 'checkInDate'),
    checkOut: pick('checkOut', 'hotelCheckOut', 'checkOutDate'),
  };
}

/** 两个房组都写了日期时必须一致（只有一侧写了 → 不拿它否决，交给订单行那一层的区间判据）。 */
function stayRangeConflicts(a: BackfillRoomGroupView, b: BackfillRoomGroupView): boolean {
  const ra = groupStayRange(a);
  const rb = groupStayRange(b);
  if (ra.checkIn != null && rb.checkIn != null && ra.checkIn !== rb.checkIn) return true;
  return ra.checkOut != null && rb.checkOut != null && ra.checkOut !== rb.checkOut;
}

function groupLabel(group: BackfillRoomGroupView): string {
  const hotel = typeof group.hotelName === 'string' ? group.hotelName : '';
  const roomType = typeof group.roomType === 'string' ? group.roomType : '';
  return `${hotel}|${roomType}`;
}

export type RoomGroupPairDecision =
  | { ok: true; sourceIndex: number; splitIndex: number }
  | { ok: false; reason: string };

/** 房组无行归属时的跳过原因（脚本按这句归并计数，改动请连脚本一起改）。 */
export const ROOM_GROUP_UNOWNED_REASON = '房组无行归属，交人工';

/** 一侧分房表的扫描结果：归属本行的下标 + 没写归属的半房组个数。 */
function scanGroups(
  groups: readonly BackfillRoomGroupView[],
  itemId: string,
): { owned: number[]; unowned: number } {
  const owned: number[] = [];
  let unowned = 0;
  groups.forEach((g, i) => {
    if (!isHalfCandidateGroup(g)) return;
    const ownership = classifyGroup(g, itemId);
    if (ownership === 'OWNED') owned.push(i);
    else if (ownership === 'UNOWNED') unowned += 1;
  });
  return { owned, unowned };
}

/**
 * 两张单的分房表里各挑出**恰好一个**可配对的半房组 → 它们就是同一间房的两半。
 *
 * 三条硬条件：
 *   · 只认**显式写了 orderItemId** 的房组：老房组（没写归属）一律跳过交人工 ——
 *     一单两行住宿时，「按本单兜底」会把另一行的半房组配过来，两间真房并成一间 = 超卖；
 *   · 「各恰一个」：一侧有两个以上时无从判断谁配谁；
 *   · 酒店名 + 房型对得上；房组自己带了入住区间的话，区间也要对得上
 *     （订单行那一层已经比过一次区间，这里是房组自带日期时的加保）。
 */
export function decideRoomGroupPair(
  sourceGroups: readonly BackfillRoomGroupView[],
  splitGroups: readonly BackfillRoomGroupView[],
  sourceItemId: string,
  splitItemId: string,
): RoomGroupPairDecision {
  const src = scanGroups(sourceGroups, sourceItemId);
  const dst = scanGroups(splitGroups, splitItemId);

  if (src.owned.length === 0 || dst.owned.length === 0) {
    const unowned = src.unowned + dst.unowned;
    return { ok: false, reason: unowned > 0 ? ROOM_GROUP_UNOWNED_REASON : '一侧没有可配对的半房组' };
  }
  if (src.owned.length > 1 || dst.owned.length > 1) {
    return {
      ok: false,
      reason: `可配对的半房组不唯一（源单 ${src.owned.length} 个 / 新单 ${dst.owned.length} 个），交人工核对`,
    };
  }
  const sourceGroup = sourceGroups[src.owned[0]];
  const splitGroup = splitGroups[dst.owned[0]];
  if (groupLabel(sourceGroup) !== groupLabel(splitGroup)) {
    return { ok: false, reason: '两个半房组的酒店 / 房型对不上' };
  }
  if (stayRangeConflicts(sourceGroup, splitGroup)) {
    return { ok: false, reason: '两个半房组的入住区间对不上' };
  }
  return { ok: true, sourceIndex: src.owned[0], splitIndex: dst.owned[0] };
}

/** 防御式读分房表里的 roomGroups 数组（形状不符按无分房处理）。 */
export function readBackfillRoomGroups(roomAssignment: unknown): BackfillRoomGroupView[] {
  const groups = readObject(roomAssignment).roomGroups;
  if (!Array.isArray(groups)) return [];
  return groups.filter(
    (g): g is BackfillRoomGroupView => g != null && typeof g === 'object' && !Array.isArray(g),
  );
}

/** 把配对键写进指定下标的房组，返回**新的** roomAssignment（原对象不改）。 */
export function withGroupPairKey(
  roomAssignment: unknown,
  index: number,
  splitPairKey: string,
): Record<string, unknown> {
  const base = readObject(roomAssignment);
  const groups = readBackfillRoomGroups(roomAssignment);
  return {
    ...base,
    roomGroups: groups.map((g, i) => (i === index ? { ...g, splitPairKey } : g)),
  };
}
