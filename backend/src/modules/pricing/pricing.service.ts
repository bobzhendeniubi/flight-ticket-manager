/**
 * 动态定价引擎 — 两层模型。
 *
 * Layer 1 (日期等级): DateRanking 表 → A/B/C/D → 倍率
 * Layer 2 (余位阶梯): 每 BUCKET_SIZE 张票一个 bucket，从 BUCKET_START 线性递增到 BUCKET_END
 *
 * 最终单座价 = basePrice × 日期倍率 × bucket 倍率（取整）
 *
 * 跨 bucket 逻辑：遍历 sold+1 到 sold+qty，每个座位独立算 bucket index → 单价。
 * 这意味着一个订单里每张票可能价格不同（bucket 0 和 bucket 1 价格不同）。
 */
import { CabinClass } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';

// ── 配置常量 ──────────────────────────────────────────────────────
// 这些将来可以从 PricingConfig 表读取，目前用默认值。
const BUCKET_SIZE = 10; // 每 bucket 多少张票
const BUCKET_START_MULT = 0.7; // 最便宜的 bucket 倍率
const BUCKET_END_MULT = 1.55; // 最贵的 bucket 倍率

const RANK_MULTIPLIER: Record<string, number> = {
  A: 1.5,
  B: 1.2,
  C: 1.0,
  D: 0.8,
};

// ── 返回类型 ──────────────────────────────────────────────────────
export interface SeatBreakdown {
  seatIndex: number; // 1-based: 这是该班次的第几张票（sold+1, sold+2, ...）
  bucket: number; // 0-based bucket index
  bucketMultiplier: number;
  unitPrice: number; // = round(basePrice × dateMultiplier × bucketMultiplier)
}

export interface PriceResult {
  scheduleId: string;
  cabin: CabinClass;
  qty: number;
  basePrice: number;
  dateRank: string;
  dateMultiplier: number;
  bucketSize: number;
  totalBuckets: number;
  currentBucket: number; // 下一张票所在的 bucket（基于当前 sold）
  currentBucketRemaining: number; // 当前 bucket 剩余多少张
  perSeatBreakdown: SeatBreakdown[];
  totalPrice: number;
  averageUnitPrice: number; // = round(totalPrice / qty)
}

export class PricingService {
  /**
   * 计算指定班次、舱位、数量的动态价格。
   *
   * 不修改 sold — 只读查询。
   */
  async calculatePrice(
    scheduleId: string,
    cabin: CabinClass,
    qty: number,
  ): Promise<PriceResult> {
    // 1. 查 FlightSeatClass
    const seatClass = await prisma.flightSeatClass.findFirst({
      where: { scheduleId, cabin },
      include: { schedule: true },
    });
    if (!seatClass) {
      throw new NotFoundError(`班次 ${scheduleId} 的 ${cabin} 舱位不存在`);
    }

    const { capacity, sold, basePrice: basePriceDec } = seatClass;
    const basePrice = Number(basePriceDec);

    // 余票检查
    const available = capacity - sold;
    if (qty > available) {
      throw new BadRequestError(
        `${cabin} 余票仅 ${available} 张，不够 ${qty} 张。` +
          (available > 0 ? `最多可购 ${available} 张。` : '已售罄。'),
      );
    }

    // 2. Layer 1 — 日期等级
    // 从 schedule.departureTime 提取出发地本地日期（对 Asia/Ho_Chi_Minh=+7, Asia/Macau=+8）
    const depTz = seatClass.schedule.departureTz;
    const offsetHours = depTz === 'Asia/Macau' ? 8 : depTz === 'Asia/Ho_Chi_Minh' ? 7 : 8;
    const depUtc = seatClass.schedule.departureTime;
    const localMs = depUtc.getTime() + offsetHours * 3600000;
    const localDate = new Date(localMs);
    // 取 UTC midnight 作为 date 查找 key
    const dateLookup = new Date(
      Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate()),
    );

    const ranking = await prisma.dateRanking.findUnique({
      where: { date: dateLookup },
    });
    // Fallback: 按 DOW 算
    const dowFallback: Record<number, string> = {
      0: 'A', 1: 'C', 2: 'D', 3: 'D', 4: 'C', 5: 'B', 6: 'B',
    };
    const dateRank = ranking?.rank ?? dowFallback[localDate.getUTCDay()] ?? 'C';
    const dateMultiplier = RANK_MULTIPLIER[dateRank] ?? 1.0;

    // 3. Layer 2 — 余位阶梯
    const totalBuckets = Math.max(1, Math.ceil(capacity / BUCKET_SIZE));
    const getBucketMultiplier = (bucketIndex: number): number => {
      if (totalBuckets <= 1) return 1.0;
      const clamped = Math.min(bucketIndex, totalBuckets - 1);
      return (
        BUCKET_START_MULT +
        ((BUCKET_END_MULT - BUCKET_START_MULT) * clamped) / (totalBuckets - 1)
      );
    };

    // 当前 bucket（下一张票的 bucket）
    const currentBucket = Math.floor(sold / BUCKET_SIZE);
    const currentBucketEnd = (currentBucket + 1) * BUCKET_SIZE;
    const currentBucketRemaining = Math.min(currentBucketEnd, capacity) - sold;

    // 4. Per-seat breakdown
    const perSeatBreakdown: SeatBreakdown[] = [];
    let totalPrice = 0;

    for (let i = 0; i < qty; i++) {
      const seatIndex = sold + 1 + i; // 1-based
      const bucket = Math.floor((seatIndex - 1) / BUCKET_SIZE);
      const bucketMultiplier = getBucketMultiplier(bucket);
      const unitPrice = Math.round(basePrice * dateMultiplier * bucketMultiplier);
      perSeatBreakdown.push({ seatIndex, bucket, bucketMultiplier, unitPrice });
      totalPrice += unitPrice;
    }

    const averageUnitPrice = Math.round(totalPrice / qty);

    return {
      scheduleId,
      cabin,
      qty,
      basePrice,
      dateRank,
      dateMultiplier,
      bucketSize: BUCKET_SIZE,
      totalBuckets,
      currentBucket,
      currentBucketRemaining,
      perSeatBreakdown,
      totalPrice,
      averageUnitPrice,
    };
  }
}
