/**
 * 定价 · 纯函数
 *
 * 把 PricingService.calculatePrice 里的座位定价数学抽出来，方便单测。
 * 没有 DB 依赖，全部输入参数化。
 *
 * 两种模式（所见即所得 — 仓位价/底价就是最终成交价）：
 *   AUTO（无仓位阶梯）：单价 = round(basePrice)，固定底价，无日期倍率、无余位倍率。
 *   LADDER（配了仓位阶梯）：按显式档位卖，仓位价即成交价（见下方 computeLadderBreakdown）。
 *
 * 历史说明：旧版 AUTO 曾叠加「日期等级 × 余位 bucket」两层自动倍率（动态定价老页）。
 * 应业主要求退役 —— 定价统一到仓位阶梯，无阶梯则固定底价。dateRank 仍计算供运营内部参考，
 * 但不再参与定价。DateRanking 表保留（休眠），只是不再应用其倍率。
 */

export interface SeatBreakdown {
  /** 1-based: 这是该班次的第几张票（sold+1, sold+2, ...） */
  seatIndex: number;
  /** 0-based bucket index（AUTO 模式恒为 0；LADDER 模式为所属档位） */
  bucket: number;
  /** 保留字段（同形）：AUTO/LADDER 均恒为 1（无倍率概念） */
  bucketMultiplier: number;
  /** = round(basePrice)（AUTO 固定底价）或该档仓位价（LADDER） */
  unitPrice: number;
}

export interface BreakdownInput {
  basePrice: number;
  /** 仍接收（供 service 透传运营内部参考），但不参与定价 */
  dateRank: string;
  capacity: number;
  /** 该 cabin 已售张数 */
  sold: number;
  qty: number;
}

export interface BreakdownResult {
  breakdown: SeatBreakdown[];
  totalPrice: number;
  /** AUTO 固定底价模式：恒为 1（不再按容量分档） */
  totalBuckets: number;
  /** AUTO 固定底价模式：恒为 1（不再叠日期倍率） */
  dateMultiplier: number;
  /** 下一张票所在的 bucket（AUTO 恒 0） */
  currentBucket: number;
  /** 当前 bucket 剩余多少张（AUTO = capacity − sold，整段一个 bucket） */
  currentBucketRemaining: number;
  averageUnitPrice: number;
}

/**
 * 给定（basePrice、capacity、sold、qty）算每张票价 + 总价。
 * 所见即所得：无仓位阶梯 → 每张票都是固定底价 round(basePrice)。
 * 不再应用日期等级 / 余位 bucket 倍率（dateMultiplier=1, bucketMultiplier=1, totalBuckets=1）。
 * Pure — 不查库、不改库。
 */
export function computePerSeatBreakdown(input: BreakdownInput): BreakdownResult {
  const { basePrice, capacity, sold, qty } = input;
  if (qty <= 0) {
    throw new Error('qty 必须 >= 1');
  }
  if (sold < 0 || sold > capacity) {
    throw new Error(`sold (${sold}) 必须在 [0, capacity=${capacity}] 区间`);
  }

  // 固定底价：每张票同价 = round(basePrice)，无任何倍率。
  const unitPrice = Math.round(basePrice);

  const breakdown: SeatBreakdown[] = [];
  let totalPrice = 0;
  for (let i = 0; i < qty; i++) {
    const seatIndex = sold + 1 + i;
    breakdown.push({ seatIndex, bucket: 0, bucketMultiplier: 1, unitPrice });
    totalPrice += unitPrice;
  }

  // 不再分档：整个容量视作一个 bucket，剩余 = capacity − sold。
  const currentBucket = 0;
  const currentBucketRemaining = capacity - sold;
  const averageUnitPrice = Math.round(totalPrice / qty);

  return {
    breakdown,
    totalPrice,
    totalBuckets: 1,
    dateMultiplier: 1,
    currentBucket,
    currentBucketRemaining,
    averageUnitPrice,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 仓位阶梯（显式动态加价）· 纯函数
//
// 一个阶梯 = 有序的档位列表，最便宜的在前；卖空一档自动开下一档。
//   fareBuckets = [ { quota: 20, price: 1280 }, { quota: 30, price: 1480 }, … ]
//
// 按 sold 定价：第 (sold+1+i) 张票落在「累计 quota 首次覆盖它」的那一档，
// 单价 = 该档 price。超过 Σquota 的座位 → clamp 到最后一档 price。
// 一个跨档订单按 per-seat 混合计价（和旧引擎同形）。
//
// 与旧版区别：没有日期倍率、没有自动余位倍率 —— 仓位价就是最终成交价。
// ════════════════════════════════════════════════════════════════════════════

/** 单个仓位档位：quota=本档多少张，price=本档单座成交价 */
export interface FareBucket {
  quota: number;
  price: number;
}

export interface LadderBreakdownInput {
  /** 有序档位，index 0 最先卖（最便宜） */
  fareBuckets: FareBucket[];
  /** 该 cabin 已售张数 */
  sold: number;
  qty: number;
}

export interface LadderBreakdownResult {
  breakdown: SeatBreakdown[];
  totalPrice: number;
  averageUnitPrice: number;
  /** 阶梯档位总数 */
  totalBuckets: number;
  /** 下一张票（基于当前 sold）落在第几档（0-based，clamp 到最后一档） */
  currentBucket: number;
  /** 当前档剩余多少张（驱动"还剩 X 张就涨价"）；最后一档售罄后为 0 */
  currentBucketRemaining: number;
}

/**
 * 给定座位 index（1-based）定位它落在哪一档（0-based）。
 * 累计 quota 首次 >= seatIndex 的那一档。超出 Σquota → 最后一档（clamp）。
 */
export function bucketOfSeatInLadder(seatIndex: number, fareBuckets: FareBucket[]): number {
  let cumulative = 0;
  for (let i = 0; i < fareBuckets.length; i++) {
    cumulative += fareBuckets[i].quota;
    if (seatIndex <= cumulative) return i;
  }
  return fareBuckets.length - 1; // clamp 到最后一档
}

/**
 * 仓位阶梯 per-seat 定价。Pure — 不查库、不改库。
 * 注意：余票/容量检查不在这里做（由 service 层用 capacity−sold 把关，保持原行为）。
 */
export function computeLadderBreakdown(input: LadderBreakdownInput): LadderBreakdownResult {
  const { fareBuckets, sold, qty } = input;
  if (qty <= 0) {
    throw new Error('qty 必须 >= 1');
  }
  if (sold < 0) {
    throw new Error(`sold (${sold}) 必须 >= 0`);
  }
  if (!Array.isArray(fareBuckets) || fareBuckets.length === 0) {
    throw new Error('fareBuckets 必须是非空数组');
  }

  const totalBuckets = fareBuckets.length;
  const lastPrice = fareBuckets[totalBuckets - 1].price;
  const totalQuota = fareBuckets.reduce((s, b) => s + b.quota, 0);

  const breakdown: SeatBreakdown[] = [];
  let totalPrice = 0;
  for (let i = 0; i < qty; i++) {
    const seatIndex = sold + 1 + i; // 1-based
    const bucket = bucketOfSeatInLadder(seatIndex, fareBuckets);
    // 超出 Σquota → 最后一档价（clamp）；否则用所属档的价
    const unitPrice = seatIndex > totalQuota ? lastPrice : fareBuckets[bucket].price;
    // 仓位模式没有倍率概念，bucketMultiplier 填 1（保持 SeatBreakdown 同形）
    breakdown.push({ seatIndex, bucket, bucketMultiplier: 1, unitPrice });
    totalPrice += unitPrice;
  }

  // 当前档（下一张票落在哪一档）+ 当前档剩余张数（基于 sold）
  const nextSeatIndex = sold + 1;
  const currentBucket = bucketOfSeatInLadder(nextSeatIndex, fareBuckets);
  // 当前档累计上界
  let cumulativeUpTo = 0;
  for (let i = 0; i <= currentBucket; i++) cumulativeUpTo += fareBuckets[i].quota;
  // 已超过 Σquota（落在最后一档且 sold>=totalQuota）→ 当前档已无剩余
  const currentBucketRemaining = Math.max(0, cumulativeUpTo - sold);

  const averageUnitPrice = Math.round(totalPrice / qty);

  return {
    breakdown,
    totalPrice,
    averageUnitPrice,
    totalBuckets,
    currentBucket,
    currentBucketRemaining,
  };
}
