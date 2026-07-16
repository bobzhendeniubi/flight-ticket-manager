/**
 * 待支付订单账龄 —— 让「占着机位、又没有支付时限」的单第一天就看得见。
 *
 * 背景（为什么要分桶，而不是一个裸计数）：
 *   后台/代理录入的单 paymentExpiresAt = null（不设支付时限），但它是 PENDING_PAYMENT，
 *   在座位账里是实打实占座的。系统没有任何定时任务会退它 —— 只能由运营手动释放。
 *   所以一张录错的单会一直冻着机位，直到有人想起来去翻订单列表。
 *   仪表盘原来只有一个「待支付订单 N」的裸计数：看不出这 N 单里哪些已经躺了一周、
 *   哪些根本没有时限。分桶 + 单独标出「无支付时限」，就是把这件事摆到台面上。
 *
 * 口径：
 *   - 账龄 = now − createdAt（下单时刻起算），与订单列表的「下单时间」同源。
 *   - 只看 PENDING_PAYMENT + 未软删。这是待支付里真正占座的那一档。
 *   - 分桶右开左闭：24h / 3d / 7d 整点归入更老的一档（躺满 24h 就算「1-3 天」，不粉饰）。
 *   - 「无支付时限」= paymentExpiresAt IS NULL，即不会自动退机位、只能手动释放的单。
 *
 * 本模块只做「看得见」：不回收、不杀单、不改任何订单状态。
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 账龄分桶（由新到老） */
export const PENDING_AGING_BUCKETS = ['LT_24H', 'D1_3', 'D3_7', 'GT_7D'] as const;
export type PendingAgingBucket = (typeof PENDING_AGING_BUCKETS)[number];

/** 只统计「待支付且未软删」——待支付里真正占座的那一档 */
const PENDING_BASE: Prisma.OrderWhereInput = { deletedAt: null, status: 'PENDING_PAYMENT' };

export interface PendingAgingBucketStat {
  bucket: PendingAgingBucket;
  orders: number;
  /** 其中无支付时限（paymentExpiresAt IS NULL）的单数——不会自动退机位 */
  noClockOrders: number;
}

export interface PendingAgingSummary {
  buckets: PendingAgingBucketStat[];
  totalOrders: number;
  totalNoClockOrders: number;
  asOf: string;
}

export interface PendingAgingOrderRow {
  id: string;
  orderNumber: string;
  createdAt: string;
  /** 账龄小时数（向下取整） */
  ageHours: number;
  bucket: PendingAgingBucket;
  /** true = 无支付时限，机位不会自动退，只能手动释放 */
  noClock: boolean;
  agentId: string | null;
  /** 代理名（无代理=直客单则为 null） */
  agentName: string | null;
  contactName: string;
  /** 最早出发日（YYYY-MM-DD，UTC）；无航班/酒店行程则为 null */
  departureDate: string | null;
  /** 占座人数：该单含机票行时=乘客数，否则 0（酒店/签证单不占机位） */
  seats: number;
}

/**
 * 账龄分桶的 createdAt 边界。now−24h / now−3d / now−7d。
 * 单独抽出来是为了让分桶边界可单测，不必碰数据库。
 */
export function agingBoundaries(now: Date): { h24: Date; d3: Date; d7: Date } {
  return {
    h24: new Date(now.getTime() - DAY_MS),
    d3: new Date(now.getTime() - 3 * DAY_MS),
    d7: new Date(now.getTime() - 7 * DAY_MS),
  };
}

/**
 * 账龄毫秒数 → 分桶。
 * 边界归入更老的一档（右开左闭）：正好 24h → D1_3，正好 3d → D3_7，正好 7d → GT_7D。
 * 负账龄（createdAt 在未来，时钟漂移）按最新一档处理，不会漏进老桶里吓人。
 */
export function bucketForAgeMs(ageMs: number): PendingAgingBucket {
  if (ageMs < DAY_MS) return 'LT_24H';
  if (ageMs < 3 * DAY_MS) return 'D1_3';
  if (ageMs < 7 * DAY_MS) return 'D3_7';
  return 'GT_7D';
}

/** 下单时刻 + 当前时刻 → 分桶 */
export function bucketForCreatedAt(createdAt: Date, now: Date): PendingAgingBucket {
  return bucketForAgeMs(now.getTime() - createdAt.getTime());
}

/**
 * 分桶 → createdAt 查询条件。与 bucketForAgeMs 严格互为镜像（同一套边界，同样右开左闭），
 * 否则「卡片数字」与「点进去的列表」会对不上——那正是这个功能要根治的病。
 */
export function bucketCreatedAtWhere(bucket: PendingAgingBucket, now: Date): Prisma.DateTimeFilter {
  const { h24, d3, d7 } = agingBoundaries(now);
  switch (bucket) {
    case 'LT_24H':
      return { gt: h24 };
    case 'D1_3':
      return { gt: d3, lte: h24 };
    case 'D3_7':
      return { gt: d7, lte: d3 };
    case 'GT_7D':
      return { lte: d7 };
  }
}

type ItemLike = {
  kind: string;
  hotelCheckIn: Date | null;
  flightSchedule: { departureTime: Date } | null;
};

/**
 * 订单行 → 最早出发日（YYYY-MM-DD, UTC）。
 * 机票行取 departureTime，没有机票行则退到酒店入住日；都没有 → null。
 * 与订单列表的出行日期口径同源（FLIGHT: departureTime；HOTEL: hotelCheckIn）。
 */
export function departureDateOf(items: ItemLike[]): string | null {
  const times: number[] = [];
  for (const it of items) {
    if (it.flightSchedule) times.push(it.flightSchedule.departureTime.getTime());
  }
  if (times.length === 0) {
    for (const it of items) {
      if (it.hotelCheckIn) times.push(it.hotelCheckIn.getTime());
    }
  }
  if (times.length === 0) return null;
  return new Date(Math.min(...times)).toISOString().slice(0, 10);
}

/**
 * 占座人数：只有含机票行的单才冻着机位。
 * 乘客数即占座人数（建单时已校验「所需出行人数 = 乘客数」，往返同一批人不重复计）。
 * 纯酒店/签证单不占机位 → 0。
 */
export function seatsOf(items: ItemLike[], passengerCount: number): number {
  return items.some((it) => it.kind === 'FLIGHT') ? passengerCount : 0;
}

export class PendingAgingService {
  /** 四档账龄各有多少单、其中多少是无支付时限的单 */
  async getSummary(now: Date = new Date()): Promise<PendingAgingSummary> {
    const buckets = await Promise.all(
      PENDING_AGING_BUCKETS.map(async (bucket): Promise<PendingAgingBucketStat> => {
        const createdAt = bucketCreatedAtWhere(bucket, now);
        const [orders, noClockOrders] = await Promise.all([
          prisma.order.count({ where: { ...PENDING_BASE, createdAt } }),
          prisma.order.count({ where: { ...PENDING_BASE, createdAt, paymentExpiresAt: null } }),
        ]);
        return { bucket, orders, noClockOrders };
      }),
    );

    return {
      buckets,
      totalOrders: buckets.reduce((sum, b) => sum + b.orders, 0),
      totalNoClockOrders: buckets.reduce((sum, b) => sum + b.noClockOrders, 0),
      asOf: now.toISOString(),
    };
  }

  /**
   * 下钻：某一档（或全部）待支付单的明细，最老的排最前。
   * bucket 省略 = 不限账龄；noClockOnly = 只看不会自动退机位的单。
   */
  async listOrders(
    params: {
      bucket?: PendingAgingBucket;
      noClockOnly?: boolean;
      page: number;
      pageSize: number;
    },
    now: Date = new Date(),
  ): Promise<{ orders: PendingAgingOrderRow[]; total: number; page: number; pageSize: number }> {
    const { bucket, noClockOnly, page, pageSize } = params;
    const where: Prisma.OrderWhereInput = {
      ...PENDING_BASE,
      ...(bucket ? { createdAt: bucketCreatedAtWhere(bucket, now) } : {}),
      ...(noClockOnly ? { paymentExpiresAt: null } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'asc' }, // 躺得最久的排最前——这是要先处理的
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          orderNumber: true,
          createdAt: true,
          paymentExpiresAt: true,
          contactName: true,
          agentId: true,
          agent: { select: { companyName: true, contactName: true } },
          _count: { select: { passengers: true } },
          items: {
            select: {
              kind: true,
              hotelCheckIn: true,
              flightSchedule: { select: { departureTime: true } },
            },
          },
        },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      orders: rows.map((r) => ({
        id: r.id,
        orderNumber: r.orderNumber,
        createdAt: r.createdAt.toISOString(),
        ageHours: Math.max(0, Math.floor((now.getTime() - r.createdAt.getTime()) / HOUR_MS)),
        bucket: bucketForCreatedAt(r.createdAt, now),
        noClock: r.paymentExpiresAt === null,
        agentId: r.agentId,
        agentName: r.agent ? (r.agent.companyName ?? r.agent.contactName) : null,
        contactName: r.contactName,
        departureDate: departureDateOf(r.items),
        seats: seatsOf(r.items, r._count.passengers),
      })),
    };
  }
}
