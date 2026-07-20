/**
 * 旅客档案聚合 —— 纯函数，无 IO。
 *
 * 输入：有效订单（含乘机人 + 订单行摘要），输出：按证件号归拢的档案聚合。
 * 「有效订单」口径由 service 层过滤（deletedAt=null 且状态不在排除集）；
 * 本文件只负责归拢与统计，方便单测直接驱动。
 *
 * 口径（proposal 拍板前的默认值，见 docs/常旅客计划-proposal.md 第七节）：
 *   - 行程（trip）按订单计：一张含机票的订单 = 1 次行程，取最早起飞的航段为「去程」；
 *     tripCount 只数去程已起飞的行程（「飞过多少次」）。
 *   - 人均消费 = 订单实付 ÷ 乘机人数，平摊（含儿童/婴儿）。
 *   - 偏好取最近值（床型/餐食/单住）或众数（舱位）；轮椅任一次为真即真。
 */
import type { CabinClass, DocumentType, Gender, OrderItemKind, OrderStatus } from '@prisma/client';

// ── 输入形状（service 从 prisma 查询后映射；测试直接构造）──

export interface AggPassenger {
  fullName: string;
  chineseName: string | null;
  gender: Gender | null;
  documentType: DocumentType;
  documentNumber: string;
  dateOfBirth: Date | null;
  nationality: string | null;
  passportExpiry: Date | null;
  mealPreference: string | null;
  bedPref: string | null;
  needsWheelchair: boolean;
  singleRoom: boolean;
}

export interface AggOrderItem {
  kind: OrderItemKind;
  flightCabin: CabinClass | null;
  departureTime: Date | null; // flightSchedule.departureTime（UTC）
  flightNumber: string | null;
  originCode: string | null;
  destinationCode: string | null;
  hotelName: string | null; // hotelRoomType.hotel.name
  roomTypeName: string | null; // hotelRoomType.name
  hotelCheckIn: Date | null;
  hotelCheckOut: Date | null;
}

export interface AggOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  createdAt: Date;
  paidAmountCny: number;
  passengers: AggPassenger[];
  items: AggOrderItem[];
}

// ── 输出形状 ──

export interface HotelStay {
  hotelName: string;
  roomType: string | null;
  checkIn: string | null; // YYYY-MM-DD
  checkOut: string | null;
  orderNumber: string;
}

export interface Companion {
  documentType: DocumentType;
  documentNumber: string;
  fullName: string;
  tripsTogether: number;
}

export interface TripSummary {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  departAt: Date | null; // 去程起飞（无机票单为 null）
  returnAt: Date | null; // 第二航段起飞（单程/无机票为 null）
  route: string | null; // "MFM→DAD"
  flightNumbers: string[];
  cabin: CabinClass | null;
  hotels: HotelStay[];
  paxCount: number;
  spendShareCny: number;
  flown: boolean;
}

export interface TravelerAggregate {
  documentType: DocumentType;
  documentNumber: string;
  fullName: string;
  chineseName: string | null;
  gender: Gender | null;
  dateOfBirth: Date | null;
  nationality: string | null;
  passportExpiry: Date | null;
  tripCount: number;
  orderCount: number;
  firstTripAt: Date | null;
  lastTripAt: Date | null;
  nextTripAt: Date | null;
  totalSpendCny: number;
  prefCabin: CabinClass | null;
  prefBed: string | null;
  prefMeal: string | null;
  prefSingleRoom: boolean;
  needsWheelchair: boolean;
  hotelHistory: HotelStay[];
  companions: Companion[];
  trips: TripSummary[]; // 按去程时间倒序（无航班的排最后）
}

const HOTEL_HISTORY_CAP = 20;
const COMPANIONS_CAP = 12;

export function docKey(documentType: DocumentType, documentNumber: string): string {
  return `${documentType}|${documentNumber.trim().toUpperCase()}`;
}

/**
 * 占位出行人：纯酒店/接送单无真实乘机人时，前端会塞一位 documentNumber='N/A' 的占位行
 * （见 admin-web SingleOrderModal）。这不是真人，绝不能进画像聚合——否则不同客户的占位行
 * 会按同一个 'N/A' 证件 key 串成一个假人，把各自的消费/姓名/同行关系全聚到一起。
 * 空证件号同理无法作为人键，一并排除。
 */
export function isPlaceholderTraveler(documentNumber: string | null | undefined): boolean {
  const n = (documentNumber ?? '').trim().toUpperCase();
  return n === '' || n === 'N/A';
}

/**
 * 别名解析：docKey → 最终主档案 docKey。
 * service 层构建 aliasMap 时已解析到最终主档案，但这里仍按链循环跟随并防环 ——
 * 数据上不该有链/环，健壮性兜底（脏数据只会归拢不全，不会死循环）。
 */
function resolveCanonical(key: string, aliasMap?: Map<string, string>): string {
  if (!aliasMap) return key;
  let current = key;
  const seen = new Set<string>([current]);
  for (;;) {
    const next = aliasMap.get(current);
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

function toDateStr(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 单张订单的行程摘要（对每位乘机人相同；spendShare 已是人均） */
function summarizeOrder(order: AggOrder, now: Date): TripSummary {
  const flightItems = order.items
    .filter((i): i is AggOrderItem & { departureTime: Date } => i.departureTime !== null)
    .sort((a, b) => a.departureTime.getTime() - b.departureTime.getTime());
  const depart = flightItems[0] ?? null;
  const ret = flightItems[1] ?? null;
  const hotels: HotelStay[] = order.items
    .filter((i): i is AggOrderItem & { hotelName: string } => i.hotelName !== null)
    .map((i) => ({
      hotelName: i.hotelName,
      roomType: i.roomTypeName,
      checkIn: toDateStr(i.hotelCheckIn),
      checkOut: toDateStr(i.hotelCheckOut),
      orderNumber: order.orderNumber,
    }));
  const paxCount = Math.max(1, order.passengers.length);
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    departAt: depart?.departureTime ?? null,
    returnAt: ret?.departureTime ?? null,
    route:
      depart?.originCode && depart?.destinationCode
        ? `${depart.originCode}→${depart.destinationCode}`
        : null,
    flightNumbers: flightItems.map((i) => i.flightNumber).filter((n): n is string => n !== null),
    cabin: depart?.flightCabin ?? null,
    hotels,
    paxCount,
    spendShareCny: round2(order.paidAmountCny / paxCount),
    flown: depart !== null && depart.departureTime <= now,
  };
}

/**
 * 把有效订单集合归拢成「证件号 → 档案聚合」。
 * 同一订单里同证件号出现多次（强录回补）只计一次。
 *
 * aliasMap（可选）：docKey → 主档案 docKey（档案合并，同人换证归一）。
 * 提供时累计/同行人/identity 全按 canonical key 归组：
 *   - 结果 Map 的 key 是 canonical key；
 *   - 同一人旧证的乘机人行不算「自己」的同行人（canonical 后同 key 即排除）；
 *   - 证件字段（documentType/documentNumber/passportExpiry）取主档案证件下最近的乘机人行 ——
 *     旧证号/旧证有效期回写到主档案没有意义；其余身份字段（姓名/性别/生日）同人不分证，取全局最近。
 */
export function buildTravelerAggregates(
  orders: AggOrder[],
  now: Date,
  aliasMap?: Map<string, string>,
): Map<string, TravelerAggregate> {
  const summaries = new Map<string, TripSummary>();
  for (const o of orders) summaries.set(o.id, summarizeOrder(o, now));

  interface Acc {
    latestOrderAt: Date;
    latest: AggPassenger;
    /** canonical 证件本尊（raw docKey === canonical key）的最近乘机人行；无别名时恒等于 latest */
    latestCanonicalDoc: { at: Date; p: AggPassenger } | null;
    latestBed: { at: Date; v: string } | null;
    latestMeal: { at: Date; v: string } | null;
    latestSingleRoom: { at: Date; v: boolean };
    wheelchair: boolean;
    cabinVotes: Map<CabinClass, number>;
    companionOrders: Map<string, { p: AggPassenger; count: number; at: Date }>;
    orders: AggOrder[];
  }
  const byDoc = new Map<string, Acc>();

  for (const order of orders) {
    // 同单同证件号去重（强录回补会出现重复）；canonical 后同 key 也视为重复（旧证+新证同录一单）
    const seen = new Set<string>();
    const uniquePassengers = order.passengers.filter((p) => {
      // 占位出行人（N/A / 空证件号）不进画像：既不建档案，也不算别人的同行人（下方同行人遍历同一数组）。
      if (isPlaceholderTraveler(p.documentNumber)) return false;
      const k = resolveCanonical(docKey(p.documentType, p.documentNumber), aliasMap);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    for (const p of uniquePassengers) {
      const rawKey = docKey(p.documentType, p.documentNumber);
      const key = resolveCanonical(rawKey, aliasMap);
      let acc = byDoc.get(key);
      if (!acc) {
        acc = {
          latestOrderAt: order.createdAt,
          latest: p,
          latestCanonicalDoc: null,
          latestBed: null,
          latestMeal: null,
          latestSingleRoom: { at: order.createdAt, v: p.singleRoom },
          wheelchair: false,
          cabinVotes: new Map(),
          companionOrders: new Map(),
          orders: [],
        };
        byDoc.set(key, acc);
      }
      acc.orders.push(order);
      if (order.createdAt >= acc.latestOrderAt) {
        acc.latestOrderAt = order.createdAt;
        acc.latest = p;
      }
      if (
        rawKey === key &&
        (!acc.latestCanonicalDoc || order.createdAt >= acc.latestCanonicalDoc.at)
      ) {
        acc.latestCanonicalDoc = { at: order.createdAt, p };
      }
      if (p.bedPref && (!acc.latestBed || order.createdAt >= acc.latestBed.at)) {
        acc.latestBed = { at: order.createdAt, v: p.bedPref };
      }
      if (p.mealPreference && (!acc.latestMeal || order.createdAt >= acc.latestMeal.at)) {
        acc.latestMeal = { at: order.createdAt, v: p.mealPreference };
      }
      if (order.createdAt >= acc.latestSingleRoom.at) {
        acc.latestSingleRoom = { at: order.createdAt, v: p.singleRoom };
      }
      if (p.needsWheelchair) acc.wheelchair = true;

      const cabin = summaries.get(order.id)?.cabin ?? null;
      if (cabin) acc.cabinVotes.set(cabin, (acc.cabinVotes.get(cabin) ?? 0) + 1);

      // 同行人：同单的其他乘机人（按共同订单数计）；canonical 后同 key 即本人（旧证行不算自己的同行人）
      for (const other of uniquePassengers) {
        const otherKey = resolveCanonical(docKey(other.documentType, other.documentNumber), aliasMap);
        if (otherKey === key) continue;
        const c = acc.companionOrders.get(otherKey);
        if (c) {
          c.count += 1;
          if (order.createdAt >= c.at) {
            c.p = other;
            c.at = order.createdAt;
          }
        } else {
          acc.companionOrders.set(otherKey, { p: other, count: 1, at: order.createdAt });
        }
      }
    }
  }

  const result = new Map<string, TravelerAggregate>();
  for (const [key, acc] of byDoc) {
    const trips = acc.orders
      .map((o) => summaries.get(o.id)!)
      .sort((a, b) => (b.departAt?.getTime() ?? 0) - (a.departAt?.getTime() ?? 0));

    const flown = trips.filter((t) => t.flown && t.departAt);
    const upcoming = trips.filter((t) => !t.flown && t.departAt && t.departAt > now);
    const firstTripAt = flown.length
      ? new Date(Math.min(...flown.map((t) => t.departAt!.getTime())))
      : null;
    const lastTripAt = flown.length
      ? new Date(Math.max(...flown.map((t) => t.departAt!.getTime())))
      : null;
    const nextTripAt = upcoming.length
      ? new Date(Math.min(...upcoming.map((t) => t.departAt!.getTime())))
      : null;

    // 舱位众数（票数高优先；同票按枚举名稳定序）
    let prefCabin: CabinClass | null = null;
    let best = 0;
    const sortedVotes = [...acc.cabinVotes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [cabin, votes] of sortedVotes) {
      if (votes > best) {
        best = votes;
        prefCabin = cabin;
      }
    }

    const hotelHistory = trips
      .flatMap((t) => t.hotels)
      .sort((a, b) => (b.checkIn ?? '').localeCompare(a.checkIn ?? ''))
      .slice(0, HOTEL_HISTORY_CAP);

    const companions: Companion[] = [...acc.companionOrders.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, COMPANIONS_CAP)
      .map((c) => ({
        documentType: c.p.documentType,
        documentNumber: c.p.documentNumber,
        fullName: c.p.fullName,
        tripsTogether: c.count,
      }));

    // 证件字段取 canonical 本证的最近行（合并后不能被旧证覆盖）；订单里从未出现过主证时才退回全局最近
    const idDoc = acc.latestCanonicalDoc?.p ?? acc.latest;
    result.set(key, {
      documentType: idDoc.documentType,
      documentNumber: idDoc.documentNumber,
      fullName: acc.latest.fullName,
      chineseName: acc.latest.chineseName,
      gender: acc.latest.gender,
      dateOfBirth: acc.latest.dateOfBirth,
      nationality: acc.latest.nationality,
      passportExpiry: idDoc.passportExpiry,
      tripCount: flown.length,
      orderCount: acc.orders.length,
      firstTripAt,
      lastTripAt,
      nextTripAt,
      totalSpendCny: round2(trips.reduce((s, t) => s + t.spendShareCny, 0)),
      prefCabin,
      prefBed: acc.latestBed?.v ?? null,
      prefMeal: acc.latestMeal?.v ?? null,
      prefSingleRoom: acc.latestSingleRoom.v,
      needsWheelchair: acc.wheelchair,
      hotelHistory,
      companions,
      trips,
    });
  }
  return result;
}
