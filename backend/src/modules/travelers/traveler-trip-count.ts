/**
 * 飞行次数的共享核心 —— 有效订单口径 + 老系统历史次数 + 「合计」加法，全站唯一一份。
 *
 * 谁在用：
 *   - 档案快照的重建与详情回写（traveler-profiles.service.ts）；
 *   - 导出三张表的「飞行次数」列（orders/orders.export-trip-stats.ts）：快照没命中的乘客现算兜底；
 *   - 录单/订单详情的「老客·已飞 N 次」徽章（lookupByDocuments）：快照没命中的证件号现算兜底。
 *
 * 铁律：合计 = 新系统已飞 + 老系统历史（±1 天活体去重）。加法只有 addLegacyTripCount 一处，
 * 兜底路径也必须把新系统那半边真算出来 —— 谁也不许另写一套加法，否则同一个人在导出和录单
 * 里会出现两个数字。
 *
 * 独立成文件（而非留在 traveler-profiles.service.ts）的原因：导出侧要用这份口径，而 service
 * 又是导出侧的下游（TravelerProfilesService/SNAPSHOT_STALE_MS），共用核心留在 service 里会成环。
 */
import { OrderStatus, Prisma, type DocumentType, type PrismaClient } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { businessDateISO } from '../../lib/business-time.js';
import {
  buildTravelerAggregates,
  docKey,
  isPlaceholderTraveler,
  type AggOrder,
  type TravelerAggregate,
} from './traveler-profiles.aggregate.js';

/**
 * 有效订单口径：排除草稿/超时未付/已取消/失败/全退。
 * 「待支付」**不在**排除集：后台单与代理单永不自动退位（paymentExpiresAt = null），
 * 待支付是能挂很久的正常业务状态，把它整个排掉会让大量真人一个档案都建不出来 ——
 * 那正是老客在导出「飞行次数」列里整列留空、录单也认不出的根因（2026-09-01 收口）。
 * 待支付单只进「这个人存不存在档案」与飞行次数口径；订单数/累计消费/首末次出行这些
 * 已消费语义的字段仍只认已付款单，切分在 traveler-profiles.aggregate.ts 的 countsTowardSpend。
 */
export const EXCLUDED_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.DRAFT,
  OrderStatus.PAYMENT_TIMEOUT,
  OrderStatus.CANCELLED,
  OrderStatus.FAILED,
  OrderStatus.REFUNDED,
];

/** 聚合所需的订单形状（档案重建、详情重算、现算兜底共用同一份 select，口径不分叉）。 */
export const orderSelect = {
  id: true,
  orderNumber: true,
  status: true,
  createdAt: true,
  paidAmount: true,
  passengers: {
    select: {
      fullName: true,
      chineseName: true,
      gender: true,
      documentType: true,
      documentNumber: true,
      dateOfBirth: true,
      nationality: true,
      passportExpiry: true,
      mealPreference: true,
      bedPref: true,
      needsWheelchair: true,
      singleRoom: true,
    },
  },
  items: {
    select: {
      kind: true,
      flightCabin: true,
      hotelCheckIn: true,
      hotelCheckOut: true,
      flightSchedule: {
        select: {
          departureTime: true,
          flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
        },
      },
      hotelRoomType: { select: { name: true, hotel: { select: { name: true } } } },
    },
  },
} satisfies Prisma.OrderSelect;

export type OrderRow = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;

export function toAggOrder(o: OrderRow): AggOrder {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    createdAt: o.createdAt,
    paidAmountCny: Number(o.paidAmount),
    passengers: o.passengers,
    items: o.items.map((i) => ({
      kind: i.kind,
      flightCabin: i.flightCabin,
      departureTime: i.flightSchedule?.departureTime ?? null,
      flightNumber: i.flightSchedule?.flight.flightNumber ?? null,
      originCode: i.flightSchedule?.flight.originCode ?? null,
      destinationCode: i.flightSchedule?.flight.destinationCode ?? null,
      hotelName: i.hotelRoomType?.hotel.name ?? null,
      roomTypeName: i.hotelRoomType?.name ?? null,
      hotelCheckIn: i.hotelCheckIn,
      hotelCheckOut: i.hotelCheckOut,
    })),
  };
}

/** 该聚合里新系统已飞行程的去程业务日（UTC+8）——喂给老系统 ±1 天活体去重。 */
export function aggregateFlownBusinessDates(aggregate: TravelerAggregate | undefined): string[] {
  if (!aggregate) return [];
  return aggregate.trips
    .filter((trip) => trip.flown && trip.departAt !== null)
    .map((trip) => businessDateISO(trip.departAt!));
}

export interface LegacyTripCountScope {
  /** 结果 Map 的 key；重建/详情用主档案 id，现算兜底用 docKey。 */
  key: string;
  /** 主证件号 + 合并链上的全部旧证件号，按 norm 匹配且不区分证件类型。 */
  documentNumbers: readonly string[];
  /** 该档案新系统已飞行程的去程业务日（UTC+8）。 */
  flownBusinessDates: readonly string[];
}

interface LegacyTripCountRow {
  documentNumberNorm: string | null;
  outboundDate: Date | null;
}

const BUSINESS_DAY_MS = 24 * 60 * 60 * 1000;

function toUtcBusinessDay(isoDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ? timestamp
    : null;
}

/**
 * 老系统票与新系统已飞行程的活体去重：去程业务日相差不超过 1 天即视为同一重录行程。
 * LegacyTicket.outboundDate 是 @db.Date，按 UTC 日期读取；新系统日期由 departAt 折成 UTC+8 业务日。
 */
export function isLegacyTripMatchedByFlownDate(
  outboundDate: Date | null,
  flownBusinessDates: readonly string[],
): boolean {
  if (!outboundDate) return false;
  const legacyDay = Date.UTC(
    outboundDate.getUTCFullYear(),
    outboundDate.getUTCMonth(),
    outboundDate.getUTCDate(),
  );
  return flownBusinessDates.some((businessDate) => {
    const flownDay = toUtcBusinessDay(businessDate);
    return flownDay !== null && Math.abs(legacyDay - flownDay) <= BUSINESS_DAY_MS;
  });
}

/**
 * 老系统历史飞行次数的唯一口径：
 *   - documentNumberNorm 命中档案全部证件号（trim + upper，不区分证件类型）；
 *   - isDeleted=false、supersededByOrderId IS NULL、stateRaw != 2（stateRaw 为 NULL 也计入）；
 *   - outboundDate IS NULL 或不晚于今天。老系统封笔后无日期的记录按历史购买计入；
 *   - 命中新系统该档案任一已飞去程业务日 ±1 天的老系统票活体去重，不依赖静态重录标记。
 *
 * 所有档案一次 findMany 批量查回两列，再按档案在内存过滤计数，不能在档案循环内逐人查询。
 */
export async function loadLegacyTripCounts(
  scopes: readonly LegacyTripCountScope[],
  today = new Date(),
  client: Pick<PrismaClient, 'legacyTicket'> = prisma,
): Promise<Map<string, number>> {
  const normalizedNumbers = [
    ...new Set(
      scopes.flatMap((scope) =>
        scope.documentNumbers.map((documentNumber) => documentNumber.trim().toUpperCase()),
      ).filter(Boolean),
    ),
  ];
  if (normalizedNumbers.length === 0) return new Map();

  const rows: LegacyTripCountRow[] = await client.legacyTicket.findMany({
    where: {
      documentNumberNorm: { in: normalizedNumbers },
      isDeleted: false,
      supersededByOrderId: null,
      // 显式保留 stateRaw=NULL；Prisma 的 not: 2 单独使用时不会命中 SQL NULL。
      OR: [{ stateRaw: null }, { stateRaw: { not: 2 } }],
      AND: [{ OR: [{ outboundDate: null }, { outboundDate: { lte: today } }] }],
    },
    select: { documentNumberNorm: true, outboundDate: true },
  });

  const rowsByNorm = new Map<string, LegacyTripCountRow[]>();
  for (const row of rows) {
    if (!row.documentNumberNorm) continue;
    const norm = row.documentNumberNorm.trim().toUpperCase();
    const matchingRows = rowsByNorm.get(norm);
    if (matchingRows) matchingRows.push(row);
    else rowsByNorm.set(norm, [row]);
  }

  return new Map(
    scopes.map((scope) => {
      const documentNorms = new Set(
        scope.documentNumbers
          .map((documentNumber) => documentNumber.trim().toUpperCase())
          .filter(Boolean),
      );
      let count = 0;
      for (const norm of documentNorms) {
        for (const row of rowsByNorm.get(norm) ?? []) {
          if (!isLegacyTripMatchedByFlownDate(row.outboundDate, scope.flownBusinessDates)) {
            count += 1;
          }
        }
      }
      return [scope.key, count] as const;
    }),
  );
}

/** 把档案的主证件与合并别名证件次数相加；同一 norm 只加一次。 */
export function sumLegacyTripCounts(
  documentNumbers: readonly string[],
  countsByNorm: ReadonlyMap<string, number>,
): number {
  let total = 0;
  const seen = new Set<string>();
  for (const documentNumber of documentNumbers) {
    const norm = documentNumber.trim().toUpperCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    total += countsByNorm.get(norm) ?? 0;
  }
  return total;
}

/**
 * 唯一的合计加数 helper：聚合结果是新系统已飞，加上老系统次数才是对外的「飞行次数」。
 * 快照写入、详情回写、现算兜底全部经过这里 —— 别处不许再出现 `a + b` 形式的飞行次数加法。
 */
export function addLegacyTripCount(
  aggregate: Pick<TravelerAggregate, 'tripCount'>,
  legacyTripCount: number,
): number {
  return aggregate.tripCount + legacyTripCount;
}

/** 现算兜底的入参：一组证件对（证件号原样传入，内部按 docKey 口径归一）。 */
export interface TripCountDocument {
  documentType: DocumentType;
  documentNumber: string;
}

/** 现算兜底的单条结果：合计飞行次数 + 在订未飞。 */
export interface CombinedTripCount {
  /** 合计 = 新系统已飞 + 老系统历史（±1 天活体去重后），与快照 tripCount 同口径。 */
  tripCount: number;
  /** 在订未飞（新系统口径；老系统已封笔，没有未来的单）。 */
  pendingTripCount: number;
}

/** 现算兜底要用到的两张表；注入以便单测用假 client 驱动。 */
export type TripCountPrismaClient = Pick<PrismaClient, 'order' | 'legacyTicket'>;

/**
 * 「没有档案快照也要给出合计飞行次数」的唯一实现（导出与录单徽章共用，谁也别自己拼一套）。
 *
 * 合计 = 新系统已飞（实时从有效订单聚合）+ 老系统历史（loadLegacyTripCounts）。
 * 老系统那半边的 ±1 天活体去重靠把**真实的新系统已飞业务日**传进 scope 保证生效 ——
 * 这正是「兜底时新系统按 0 算」不可取的另一个理由：那样去重会失效，次数还会虚高。
 *
 * 批量：一条 order.findMany（按全部证件对 OR 召回）+ 一条 legacyTicket.findMany，
 * 与证件数无关，绝不在循环里逐人查库。占位出行人（N/A / 空证件号）直接跳过，不返回条目。
 */
export async function computeCombinedTripCounts(
  documents: readonly TripCountDocument[],
  client: TripCountPrismaClient = prisma,
  now: Date = new Date(),
): Promise<Map<string, CombinedTripCount>> {
  const wanted = new Map<string, TripCountDocument>();
  for (const doc of documents) {
    if (isPlaceholderTraveler(doc.documentNumber)) continue;
    wanted.set(docKey(doc.documentType, doc.documentNumber), {
      documentType: doc.documentType,
      documentNumber: doc.documentNumber.trim(),
    });
  }
  if (wanted.size === 0) return new Map();

  // 证件号按 docKey 同口径归一后查询（trim + 忽略大小写）：乘客行里的大小写/空格变体
  // 不该让老客认不出来——那正是本兜底要服务的场景。
  const rows = await client.order.findMany({
    where: {
      deletedAt: null,
      status: { notIn: EXCLUDED_ORDER_STATUSES },
      passengers: {
        some: {
          OR: [...wanted.values()].map((doc) => ({
            documentType: doc.documentType,
            documentNumber: { equals: doc.documentNumber, mode: Prisma.QueryMode.insensitive },
          })),
        },
      },
    },
    select: orderSelect,
  });
  const aggregates = buildTravelerAggregates(rows.map(toAggOrder), now);

  const legacyCounts = await loadLegacyTripCounts(
    [...wanted].map(([key, doc]) => ({
      key,
      documentNumbers: [doc.documentNumber],
      flownBusinessDates: aggregateFlownBusinessDates(aggregates.get(key)),
    })),
    now,
    client,
  );

  return new Map(
    [...wanted.keys()].map((key) => {
      const aggregate = aggregates.get(key);
      return [
        key,
        {
          // 新系统那半边照样真算（没有订单才是 0），再走唯一的加法 helper 并上老系统。
          tripCount: addLegacyTripCount(
            { tripCount: aggregate?.tripCount ?? 0 },
            legacyCounts.get(key) ?? 0,
          ),
          pendingTripCount: aggregate?.pendingTripCount ?? 0,
        },
      ];
    }),
  );
}
