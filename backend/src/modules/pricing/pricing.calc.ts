/**
 * 动态定价 · 纯函数
 *
 * 把 PricingService.calculatePrice 里的 bucket 数学抽出来，方便单测。
 * 没有 DB 依赖，全部输入参数化。
 *
 * 两层模型：
 *   Layer 1（dateRank）：A 黄金 ×1.5 / B 高峰 ×1.2 / C 平峰 ×1.0 / D 优惠 ×0.8
 *   Layer 2（bucket）：每 BUCKET_SIZE 张票一档，从 0.7 线性升到 1.55
 *
 * 跨 bucket：买 6 张但当前 bucket 只剩 3 张 → 前 3 张当前价，后 3 张下一 bucket 价
 *   （这是为什么要 per-seat 算 — 一个订单不同票价格不同）
 */

export const BUCKET_SIZE = 10;
export const BUCKET_START_MULT = 0.7;
export const BUCKET_END_MULT = 1.55;

export const RANK_MULTIPLIER: Record<string, number> = {
  A: 1.5,
  B: 1.2,
  C: 1.0,
  D: 0.8,
};

/** 给定 bucket index 算倍率（线性 START → END，clamp 到 totalBuckets-1） */
export function getBucketMultiplier(bucketIndex: number, totalBuckets: number): number {
  if (totalBuckets <= 1) return 1.0;
  const clamped = Math.min(bucketIndex, totalBuckets - 1);
  return (
    BUCKET_START_MULT +
    ((BUCKET_END_MULT - BUCKET_START_MULT) * clamped) / (totalBuckets - 1)
  );
}

/** dateRank → 倍率（未知 rank 默认 1.0） */
export function getDateMultiplier(rank: string): number {
  return RANK_MULTIPLIER[rank] ?? 1.0;
}

/** 给定座位 index（1-based），算它属于哪个 bucket（0-based） */
export function bucketOfSeat(seatIndex: number): number {
  return Math.floor((seatIndex - 1) / BUCKET_SIZE);
}

/** 给定容量，算总共有多少 bucket */
export function totalBucketsForCapacity(capacity: number): number {
  return Math.max(1, Math.ceil(capacity / BUCKET_SIZE));
}

export interface SeatBreakdown {
  /** 1-based: 这是该班次的第几张票（sold+1, sold+2, ...） */
  seatIndex: number;
  /** 0-based bucket index */
  bucket: number;
  bucketMultiplier: number;
  /** = round(basePrice × dateMultiplier × bucketMultiplier) */
  unitPrice: number;
}

export interface BreakdownInput {
  basePrice: number;
  dateRank: string;
  capacity: number;
  /** 该 cabin 已售张数 */
  sold: number;
  qty: number;
}

export interface BreakdownResult {
  breakdown: SeatBreakdown[];
  totalPrice: number;
  totalBuckets: number;
  dateMultiplier: number;
  /** 下一张票所在的 bucket（基于当前 sold） */
  currentBucket: number;
  /** 当前 bucket 剩余多少张 */
  currentBucketRemaining: number;
  averageUnitPrice: number;
}

/**
 * 给定（basePrice、dateRank、capacity、sold、qty）算每张票价 + 总价
 * Pure — 不查库、不改库
 */
export function computePerSeatBreakdown(input: BreakdownInput): BreakdownResult {
  const { basePrice, dateRank, capacity, sold, qty } = input;
  if (qty <= 0) {
    throw new Error('qty 必须 >= 1');
  }
  if (sold < 0 || sold > capacity) {
    throw new Error(`sold (${sold}) 必须在 [0, capacity=${capacity}] 区间`);
  }

  const dateMultiplier = getDateMultiplier(dateRank);
  const totalBuckets = totalBucketsForCapacity(capacity);

  const breakdown: SeatBreakdown[] = [];
  let totalPrice = 0;
  for (let i = 0; i < qty; i++) {
    const seatIndex = sold + 1 + i;
    const bucket = bucketOfSeat(seatIndex);
    const bucketMultiplier = getBucketMultiplier(bucket, totalBuckets);
    const unitPrice = Math.round(basePrice * dateMultiplier * bucketMultiplier);
    breakdown.push({ seatIndex, bucket, bucketMultiplier, unitPrice });
    totalPrice += unitPrice;
  }

  const currentBucket = Math.floor(sold / BUCKET_SIZE);
  const currentBucketEnd = (currentBucket + 1) * BUCKET_SIZE;
  const currentBucketRemaining = Math.min(currentBucketEnd, capacity) - sold;
  const averageUnitPrice = Math.round(totalPrice / qty);

  return {
    breakdown,
    totalPrice,
    totalBuckets,
    dateMultiplier,
    currentBucket,
    currentBucketRemaining,
    averageUnitPrice,
  };
}
