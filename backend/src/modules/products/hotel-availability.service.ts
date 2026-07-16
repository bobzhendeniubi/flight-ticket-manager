/**
 * 前台酒店余量（公开端点用）— 复用房控销控板口径，只回档位不回数字。
 *
 * 口径（床位口径，经 getHotelNightlyRemaining 复用）：
 *   block(d)     = SUM(该酒店包房周期 rooms，dateFrom <= d <= dateTo)
 *   used(d)      = 当晚占房订单行数（COUNTED_STATUSES，[checkIn, checkOut) 半开区间）
 *   remaining(d) = block(d) - used(d)
 *
 * ⚠️ 这里**故意**用床位口径、**不**套物理房间前瞻闸（assertHotelPhysicalFit）。两层口径分工：
 *   · 日历（本文件）= **乐观提示**：浏览商城的买家还没填性别，无从判断他能否与当晚的落单拼房客
 *     配对。硬套物理闸会把「还能卖给同性买家的那半间」一律判死 → 大面积少卖。
 *     床位口径恰好等价于「physicalRemaining >= 1 或 当晚存在未配对落单」这个乐观条件：
 *     只要还剩半间，要么有整间空着、要么有落单可拼，对**某些**买家就是可售的。
 *   · 下单闸（orders.service createOrder）= **权威拒绝**：那时性别已知，按物理口径重算后拒绝。
 * 即：日历可能显示可售、下单时被拒（性别撞了）——这是有意为之的取舍，不是 bug。
 *
 * 档位取整段住宿的最差一晚（MIN remaining）：
 *   <=0 SOLD_OUT；<=2 LOW；<=5 TIGHT；其余 AMPLE。
 * 酒店整段未配置任何包房周期 → tier=null（前台不展示余量，也不拦截销售）。
 *
 * 公开端点纪律：响应只含 { tier, nights }，绝不暴露原始库存数字（与六档余位一致）。
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { getHotelNightlyRemaining } from '../hotel-control/hotel-control.service.js';
import { nightsBetween, type HotelAvailabilityQuery } from './products.schemas.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type HotelAvailabilityTier = 'SOLD_OUT' | 'LOW' | 'TIGHT' | 'AMPLE';

/** 档位阈值（按整段最差一晚的余量）。*/
export const HOTEL_TIER_THRESHOLDS = {
  SOLD_OUT_MAX: 0,
  LOW_MAX: 2,
  TIGHT_MAX: 5,
} as const;

export interface HotelAvailabilityResult {
  tier: HotelAvailabilityTier | null;
  nights: number;
}

export function computeHotelAvailabilityTier(minRemaining: number): HotelAvailabilityTier {
  if (minRemaining <= HOTEL_TIER_THRESHOLDS.SOLD_OUT_MAX) return 'SOLD_OUT';
  if (minRemaining <= HOTEL_TIER_THRESHOLDS.LOW_MAX) return 'LOW';
  if (minRemaining <= HOTEL_TIER_THRESHOLDS.TIGHT_MAX) return 'TIGHT';
  return 'AMPLE';
}

/** [checkIn, checkOut) 逐晚展开为 YYYY-MM-DD（晚数已由 schema 限制在 1..30）。*/
function buildNightDates(checkIn: string, checkOut: string): string[] {
  const fromMs = Date.parse(`${checkIn}T00:00:00.000Z`);
  const nights = nightsBetween(checkIn, checkOut);
  return Array.from({ length: nights }, (_, i) =>
    new Date(fromMs + i * DAY_MS).toISOString().slice(0, 10),
  );
}

export async function getHotelAvailability(
  query: HotelAvailabilityQuery,
  client: PrismaClient = defaultPrisma,
): Promise<HotelAvailabilityResult> {
  const roomType = await client.hotelRoomType.findUnique({
    where: { id: query.hotelRoomTypeId },
    select: { hotelId: true },
  });
  if (!roomType) throw new NotFoundError('房型不存在');

  const nightDates = buildNightDates(query.checkIn, query.checkOut);
  const { remaining, hasBlock } = await getHotelNightlyRemaining(
    roomType.hotelId,
    nightDates,
    client,
  );
  if (!hasBlock) return { tier: null, nights: nightDates.length };

  return {
    tier: computeHotelAvailabilityTier(Math.min(...remaining)),
    nights: nightDates.length,
  };
}
