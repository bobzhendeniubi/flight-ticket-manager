/**
 * 套餐可售日期（公开端点用）— 一个套餐在某出发日 D 是否可售：
 *
 *   sellable(D) = 去程有余位(D) ∩ 回程有余位(D+nights) ∩ 酒店有房[D..D+nights) − 运营 blackout(D)
 *
 * 判定口径（与前台 BundlesPage 解析方式一致）：
 *   1. BLACKOUT 优先（不查库）：D ∈ bundle.blackoutDates → 不可售 reason='BLACKOUT'，其余跳过。
 *   2. 机票：套餐 FLIGHT 组件只有自由文本 productName，无班次/航线引用。
 *      固定航线 MFM⇌DAD（与前台/AI 助手一致），去程 D、回程 D+nights；
 *      nights = bundle.hotelNights ?? DEFAULT_BUNDLE_NIGHTS。
 *      舱位：任一 FLIGHT 组件 productName 含「商务」→ BUSINESS，否则 ECONOMY。
 *      可售要求去/回两段所选舱位档位均 ≠ 'SOLD_OUT'（口径同六档余位 computeAvailabilityTier）。
 *   3. 酒店：bundle.hotelRoomTypeId 已配置 → 取 [D, D+nights) 整段最差一晚档位：
 *      tier==='SOLD_OUT' → 不可售 reason='HOTEL_SOLD_OUT'；
 *      tier===null（整段未配置任何包房周期）→ 不拦截；未关联房型 → 永不拦截。
 *   4. sellable = !blackout && flightsOk && hotelOk。
 *
 * 性能（强约束，绝不逐日跑重查询）：
 *   - 机票：getRouteSeatTiersByDate 一次 flightSchedule.findMany（出发时间窗）+ 一次 seatLock.groupBy，
 *     JS 内按日折算 capacity−sold−locked → 档位。完全跳过动态定价（可售只看档位不看价）。
 *   - 酒店：getHotelNightlyRemaining 一次跨 [from .. to+nights] 拉周期 + 占房，JS 内切每日窗口。
 *   - 总查询数 O(2~3)，与日期跨度无关。
 *
 * 公开端点纪律：只回 { sellable, reason, flightTier, hotelTier }，不暴露任何原始库存数字。
 */
import { CabinClass, SeatLockStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import {
  computeAvailabilityTier,
  type AvailabilityTier,
} from '../flights/flights.service.js';
import { getHotelNightlyRemaining } from '../hotel-control/hotel-control.service.js';
import {
  computeHotelAvailabilityTier,
  type HotelAvailabilityTier,
} from './hotel-availability.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 套餐固定航线（与前台 BundlesPage / AI 助手一致：澳门 ⇌ 岘港）。*/
export const BUNDLE_ROUTE = { origin: 'MFM', destination: 'DAD' } as const;

/** 套餐未配置 hotelNights 时的默认住宿晚数（与前台 DEFAULT_NIGHTS 一致）。*/
export const DEFAULT_BUNDLE_NIGHTS = 4;

export type BundleSellableReason =
  | 'BLACKOUT'
  | 'FLIGHT_SOLD_OUT'
  | 'HOTEL_SOLD_OUT'
  | null;

export interface BundleDayAvailability {
  dateISO: string;
  sellable: boolean;
  reason: BundleSellableReason;
  /** 去/回两段所选舱位里更差的一档；查不到任何航段 = null。*/
  flightTier: AvailabilityTier | null;
  /** 整段住宿最差一晚档位；未关联房型 / 未配置房控 = null。*/
  hotelTier: HotelAvailabilityTier | null;
}

// ── UTC date-only helpers（与 hotel-control 口径一致，避免 off-by-one）──────
function toMidnightMs(dateISO: string): number {
  return Date.parse(`${dateISO}T00:00:00.000Z`);
}
function addDaysISO(dateISO: string, days: number): string {
  return new Date(toMidnightMs(dateISO) + days * DAY_MS).toISOString().slice(0, 10);
}
/** from..to（含两端）展开为 YYYY-MM-DD。*/
function buildDateRange(from: string, to: string): string[] {
  const fromMs = toMidnightMs(from);
  const toMs = toMidnightMs(to);
  const days = Math.floor((toMs - fromMs) / DAY_MS) + 1;
  return Array.from({ length: Math.max(0, days) }, (_, i) =>
    new Date(fromMs + i * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * 把出发地本地日（假定 Asia/Shanghai, UTC+8）折算为 UTC 出发时间窗 [start, end)。
 * 与 FlightService.search 的日期口径完全一致：本地 00:00 = UTC 前一天 16:00。
 */
function localDateToUtcWindow(dateISO: string): { start: Date; end: Date } {
  const [y, m, d] = dateISO.split('-').map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, d, -8, 0, 0)),
    end: new Date(Date.UTC(y, m - 1, d + 1, -8, 0, 0)),
  };
}
/** UTC 出发时间 → 出发地本地日（Asia/Shanghai）YYYY-MM-DD。*/
function utcToLocalDateISO(departureTime: Date): string {
  return new Date(departureTime.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * 批量取一条航线在 [fromDate, toDate]（出发地本地日）各日、指定舱位的余位档位。
 * 一次 findMany（按出发时间窗）+ 一次 seatLock.groupBy；JS 内按本地日聚合。
 *
 * 同一本地日可能有多个班次 → 取该日可售量之和后折档（只要该日整体还有座即视为有位；
 * 与销售端"该日是否可售"语义一致）。
 *
 * 返回 Map<本地日, 档位>；该日无任何班次 → 不在 Map 里（调用方按 null 处理）。
 */
export async function getRouteSeatTiersByDate(
  origin: string,
  dest: string,
  fromDate: string,
  toDate: string,
  cabin: CabinClass,
  client: PrismaClient = defaultPrisma,
): Promise<Map<string, AvailabilityTier>> {
  const winStart = localDateToUtcWindow(fromDate).start;
  const winEnd = localDateToUtcWindow(toDate).end;

  const schedules = await client.flightSchedule.findMany({
    where: {
      isActive: true,
      flight: { isActive: true, originCode: origin, destinationCode: dest },
      departureTime: { gte: winStart, lt: winEnd },
      seatClasses: { some: { cabin } },
    },
    select: {
      departureTime: true,
      seatClasses: {
        where: { cabin },
        select: { id: true, capacity: true, sold: true },
      },
    },
  });

  const seatClassIds = schedules.flatMap((s) => s.seatClasses.map((c) => c.id));
  const now = new Date();
  const lockSums =
    seatClassIds.length > 0
      ? await client.seatLock.groupBy({
          by: ['seatClassId'],
          where: {
            seatClassId: { in: seatClassIds },
            status: SeatLockStatus.ACTIVE,
            expiresAt: { gt: now },
          },
          _sum: { qty: true },
        })
      : [];
  const lockedBySeatClass = new Map(lockSums.map((r) => [r.seatClassId, r._sum.qty ?? 0]));

  // 按本地日聚合可售量（同日多班次 → 取和；"该日还有座"即可售）
  const availByDate = new Map<string, number>();
  for (const s of schedules) {
    const localDate = utcToLocalDateISO(s.departureTime);
    let dayAvail = availByDate.get(localDate) ?? 0;
    for (const c of s.seatClasses) {
      const locked = lockedBySeatClass.get(c.id) ?? 0;
      dayAvail += Math.max(0, c.capacity - c.sold - locked);
    }
    availByDate.set(localDate, dayAvail);
  }

  const tiers = new Map<string, AvailabilityTier>();
  for (const [date, avail] of availByDate) {
    tiers.set(date, computeAvailabilityTier(avail));
  }
  return tiers;
}

/** 套餐 FLIGHT 组件含「商务」→ BUSINESS，否则 ECONOMY。*/
function resolveCabin(items: unknown): CabinClass {
  if (!Array.isArray(items)) return CabinClass.ECONOMY;
  const isBiz = items.some(
    (it) =>
      it != null &&
      typeof it === 'object' &&
      (it as { kind?: unknown }).kind === 'FLIGHT' &&
      typeof (it as { productName?: unknown }).productName === 'string' &&
      ((it as { productName: string }).productName).includes('商务'),
  );
  return isBiz ? CabinClass.BUSINESS : CabinClass.ECONOMY;
}

/** 解析 blackoutDates JSON → 出发日集合（容错：忽略非法形状）。*/
function parseBlackoutSet(blackoutDates: unknown): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(blackoutDates)) return set;
  for (const entry of blackoutDates) {
    if (entry == null) continue;
    const date =
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && typeof (entry as { date?: unknown }).date === 'string'
          ? (entry as { date: string }).date
          : null;
    if (date && /^\d{4}-\d{2}-\d{2}$/u.test(date)) set.add(date);
  }
  return set;
}

/**
 * 计算套餐在 [from, to]（出发日）逐日可售性。
 * 总查询：bundle.findUnique(1) + 去/回程航段各一次（getRouteSeatTiersByDate，各 2 query）
 * + 酒店 roomType.findUnique(1) + getHotelNightlyRemaining(2 query) ≈ 8 query 固定，与跨度无关。
 */
export async function getBundleSellableDates(
  bundleId: string,
  from: string,
  to: string,
  client: PrismaClient = defaultPrisma,
): Promise<BundleDayAvailability[]> {
  const bundle = await client.bundle.findUnique({
    where: { id: bundleId },
    select: {
      items: true,
      blackoutDates: true,
      hotelNights: true,
      hotelRoomTypeId: true,
    },
  });
  if (!bundle) throw new NotFoundError('套餐不存在');

  const dates = buildDateRange(from, to);
  if (dates.length === 0) return [];

  const nights = bundle.hotelNights ?? DEFAULT_BUNDLE_NIGHTS;
  const cabin = resolveCabin(bundle.items);
  const blackoutSet = parseBlackoutSet(bundle.blackoutDates);

  // ── 机票：去程在 [from, to]；回程在 [from+nights, to+nights] ──────────────
  const retFrom = addDaysISO(from, nights);
  const retTo = addDaysISO(to, nights);
  const [goTiers, retTiers] = await Promise.all([
    getRouteSeatTiersByDate(BUNDLE_ROUTE.origin, BUNDLE_ROUTE.destination, from, to, cabin, client),
    getRouteSeatTiersByDate(BUNDLE_ROUTE.destination, BUNDLE_ROUTE.origin, retFrom, retTo, cabin, client),
  ]);

  // ── 酒店：一次性拉 [from .. to+nights-1] 的逐晚余量，JS 内切每日窗口 ──────────
  // 最后一个出发日 to 的住宿窗口是 [to, to+nights)，最晚一晚 = to+nights-1。
  let hotelRemaining: number[] = [];
  let hotelHasBlock = false;
  let hotelNightDates: string[] = [];
  if (bundle.hotelRoomTypeId) {
    const roomType = await client.hotelRoomType.findUnique({
      where: { id: bundle.hotelRoomTypeId },
      select: { hotelId: true },
    });
    if (roomType) {
      hotelNightDates = buildDateRange(from, addDaysISO(to, nights - 1));
      const res = await getHotelNightlyRemaining(roomType.hotelId, hotelNightDates, client);
      hotelRemaining = res.remaining;
      hotelHasBlock = res.hasBlock;
    }
  }
  const nightIndex = new Map(hotelNightDates.map((d, i) => [d, i]));

  return dates.map((dateISO) => {
    // 1. BLACKOUT 优先
    if (blackoutSet.has(dateISO)) {
      return { dateISO, sellable: false, reason: 'BLACKOUT', flightTier: null, hotelTier: null };
    }

    // 2. 机票：去/回两段取更差一档
    const goTier = goTiers.get(dateISO) ?? null;
    const retTier = retTiers.get(addDaysISO(dateISO, nights)) ?? null;
    const flightTier = worseFlightTier(goTier, retTier);
    const flightsOk =
      goTier !== null && goTier !== 'SOLD_OUT' && retTier !== null && retTier !== 'SOLD_OUT';

    // 3. 酒店：整段最差一晚（未配置房控 hasBlock=false → 不拦截）
    let hotelTier: HotelAvailabilityTier | null = null;
    let hotelOk = true;
    if (hotelHasBlock) {
      let minRemaining = Number.POSITIVE_INFINITY;
      for (let i = 0; i < nights; i++) {
        const idx = nightIndex.get(addDaysISO(dateISO, i));
        const rem = idx === undefined ? 0 : hotelRemaining[idx];
        if (rem < minRemaining) minRemaining = rem;
      }
      hotelTier = computeHotelAvailabilityTier(minRemaining);
      hotelOk = hotelTier !== 'SOLD_OUT';
    }

    if (!flightsOk) {
      return { dateISO, sellable: false, reason: 'FLIGHT_SOLD_OUT', flightTier, hotelTier };
    }
    if (!hotelOk) {
      return { dateISO, sellable: false, reason: 'HOTEL_SOLD_OUT', flightTier, hotelTier };
    }
    return { dateISO, sellable: true, reason: null, flightTier, hotelTier };
  });
}

const FLIGHT_TIER_RANK: Record<AvailabilityTier, number> = {
  SOLD_OUT: 0,
  VERY_LOW: 1,
  LOW: 2,
  TIGHT: 3,
  AMPLE: 4,
};

/** 去/回两段里"更差"的一档；任一段为 null（无班次）→ 返回另一段（仍可能 null）。*/
function worseFlightTier(
  a: AvailabilityTier | null,
  b: AvailabilityTier | null,
): AvailabilityTier | null {
  if (a === null) return b;
  if (b === null) return a;
  return FLIGHT_TIER_RANK[a] <= FLIGHT_TIER_RANK[b] ? a : b;
}
