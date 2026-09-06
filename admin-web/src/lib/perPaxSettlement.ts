/**
 * 每人结算价（派生展示，D2）——纯函数，不落库、不改任何金额计算，只把订单已有的权威金额
 * （order.total / order.adjustmentCny）与「按乘客调价」净额（PriceAdjustmentSection 已用的
 * groupOrderAdjustments byPassenger）重新摊到每个乘客身上，给票务一眼看出「补办签证只多收她 800」。
 *
 * 公式（与调用方约定一致，禁止在别处重算）：
 *   可摊调整额 spreadableAdjCny = (adjustmentCny ?? 0) − Σ adjustments 中 excludeFromPerPax===true 的条目
 *   应收总额 payableCny = totalCny + spreadableAdjCny
 *   基准每人 baseCny    = (payableCny − Σ 全部乘客调整净额) / 乘客数
 *   每人结算价           = 基准每人 + 该乘客调整净额
 * 全员合计恒等于 payableCny（用「分」做整数运算，余数兜给最后一位乘客，避免浮点/四舍五入导致
 * 合计对不上）。
 *
 * excludeFromPerPax（换人差价/换人费批次新增）：这类条目挂在已离开订单的被换人身上
 * （Order.adjustments 里带 passengerName/passengerDocument 快照，passengerId 已不在
 * order.passengers 里），不该摊给还在同行的乘客——从摊入基数里剔除，payableCny 相应减少，
 * 调用方用 excludedCny 渲染一行「含被换人承担的换人费/差价 ¥X（不摊入同行人）」脚注。
 *
 * 绝不是「手填每人价格」的新口子——每人结算价完全由 total/adjustmentCny/调价净额派生，
 * 换算过程不接受任何独立输入。
 */

export interface PerPaxSettlementRow {
  passengerId: string;
  /** 该乘客名下「按乘客调价」净额（CNY，正=补收/负=优惠），无调价记录则为 0 */
  netCny: number;
  /** 该乘客的每人结算价（CNY），= 应收均摊 + netCny */
  settlementCny: number;
}

export interface PerPaxSettlementResult {
  /** 与入参 passengerIds 同序 */
  rows: PerPaxSettlementRow[];
  /** 应收总额 = totalCny + spreadableAdjustmentCny(adjustmentCny, adjustments)，等于 Σ rows[].settlementCny */
  payableCny: number;
  /** Σ adjustments 中 excludeFromPerPax===true 条目的金额（CNY）；0 = 无排除项，调用方据此决定是否展示脚注 */
  excludedCny: number;
}

/** Order.adjustments 条目的最小结构（结构兼容 lib/api.ts 的 OrderAdjustment，可直接传入）。 */
export interface SpreadableAdjustmentEntry {
  amountCny: number;
  /** true = 挂给已离开订单的被换人（换人差价/换人费等），不摊入还在同行的乘客 */
  excludeFromPerPax?: boolean;
}

export interface PerPaxSettlementInput {
  /** 订单 total（CNY） */
  totalCny: number;
  /** 售后费用合计（改期费/换人费等，CNY），未启用时按 0 处理 */
  adjustmentCny?: number | null;
  /** order.adjustments 原始条目（用于剔除 excludeFromPerPax===true 的部分）；缺省视为空 */
  adjustments?: readonly SpreadableAdjustmentEntry[];
  /** 乘客 ID 列表，决定输出顺序（通常传 order.passengers 顺序） */
  passengerIds: readonly string[];
  /** 乘客 → 「按乘客调价」净额（CNY）；不在此 Map 中的乘客视为净额 0 */
  netByPassenger: ReadonlyMap<string, number>;
}

/** CNY → 分（四舍五入到整分，避免浮点误差传播）。 */
function toCents(cny: number): number {
  return Math.round(cny * 100);
}

/**
 * 运行时校验单条 adjustment 是否可安全计入「排除摊入」——与后端同名口径镜像的防呆
 * （typeof e === 'object' && e !== null && typeof e.amountCny === 'number' &&
 * Number.isFinite(e.amountCny) && e.excludeFromPerPax === true）。TS 类型标注不保证运行时
 * 数据真的长这样（脏数据、null 条目都可能混进 order.adjustments），漏了这层防呆会把
 * amountCny 非数字的条目算进 toCents() 产出 NaN，进而污染 payableCny/每人结算价全表。
 */
function isExcludableAdjustment(a: unknown): a is SpreadableAdjustmentEntry & { amountCny: number } {
  return (
    typeof a === 'object' &&
    a !== null &&
    typeof (a as { amountCny?: unknown }).amountCny === 'number' &&
    Number.isFinite((a as { amountCny: number }).amountCny) &&
    (a as { excludeFromPerPax?: unknown }).excludeFromPerPax === true
  );
}

/** Σ adjustments 中 excludeFromPerPax===true 条目的金额（分）。 */
function excludedAdjustmentCents(adjustments: readonly SpreadableAdjustmentEntry[]): number {
  return adjustments
    .filter(isExcludableAdjustment)
    .reduce((sum, a) => sum + toCents(a.amountCny), 0);
}

/**
 * 可摊入同行乘客的调整额（CNY）= adjustmentCny − Σ excludeFromPerPax===true 条目金额。
 * 与后端同名口径镜像：那部分钱已经挂给被换人本人，不进「基准每人」的分母池。
 */
export function spreadableAdjustmentCny(
  adjustmentCny: number | null | undefined,
  adjustments: readonly SpreadableAdjustmentEntry[],
): number {
  const cents = toCents(adjustmentCny ?? 0) - excludedAdjustmentCents(adjustments);
  return cents / 100;
}

/**
 * 计算每人结算价。乘客数为 0 时返回空行（调用方应只在乘客数 ≥ 2 时展示这张表）。
 */
export function computePerPaxSettlement(input: PerPaxSettlementInput): PerPaxSettlementResult {
  const { totalCny, adjustmentCny, adjustments, passengerIds, netByPassenger } = input;
  const excludedCents = excludedAdjustmentCents(adjustments ?? []);
  const payableCents = toCents(totalCny) + toCents(adjustmentCny ?? 0) - excludedCents;
  const payableCny = payableCents / 100;
  const excludedCny = excludedCents / 100;

  const n = passengerIds.length;
  if (n === 0) {
    return { rows: [], payableCny, excludedCny };
  }

  const netCentsById = new Map<string, number>(
    passengerIds.map((pid) => [pid, toCents(netByPassenger.get(pid) ?? 0)]),
  );
  const sumNetCents = [...netCentsById.values()].reduce((acc, v) => acc + v, 0);

  const remainderBaseCents = payableCents - sumNetCents;
  const baseCents = Math.trunc(remainderBaseCents / n);
  // 余数（可能为负）全部兜给最后一位乘客，保证合计恰好等于 payableCents。
  const lastRemainderCents = remainderBaseCents - baseCents * n;

  const rows: PerPaxSettlementRow[] = passengerIds.map((pid, i) => {
    const netCents = netCentsById.get(pid) ?? 0;
    const rowBaseCents = baseCents + (i === n - 1 ? lastRemainderCents : 0);
    const settlementCents = rowBaseCents + netCents;
    return {
      passengerId: pid,
      netCny: netCents / 100,
      settlementCny: settlementCents / 100,
    };
  });

  return { rows, payableCny, excludedCny };
}

// ── 读后端落库份额（R1）─────────────────────────────────────────────────────

/** 后端 OrderPassengerShare 行的最小形状（与 lib/api.ts 的 PassengerShare 结构兼容）。 */
export interface PersistedPassengerShareLike {
  passengerId: string;
  settlementCny: number;
  adjustmentCny: number;
}

export type PerPaxSettlementSource = 'PERSISTED' | 'DERIVED';

export interface ResolvedPerPaxSettlement extends PerPaxSettlementResult {
  /** PERSISTED = 行来自后端落库的 order.passengerShares；DERIVED = 后端没给、前端按上面的算法现算（旧后端 / 窄接口）。 */
  source: PerPaxSettlementSource;
}

export interface ResolvePerPaxSettlementInput extends PerPaxSettlementInput {
  /** 后端下发的按人份额；缺省 / 不完整（少任何一位在单乘客）时退回前端算法。 */
  passengerShares?: readonly PersistedPassengerShareLike[] | null;
}

/**
 * 每人结算价的**唯一取数入口**：先用后端落库的份额（order.passengerShares，每位在单乘客一行），
 * 没有才退回 computePerPaxSettlement 现算。两条支路的 payableCny / excludedCny 同一口径
 *（应收 = total + 可摊调整额，excluded = 换人费等不摊条目），只是「每人多少」一个来自库、一个现算。
 * 之所以优先读库：库里那套是写路径落的事实（拆单搬钱 / 导出 / 对账单读的同一份），前端自算
 * 只是旧后端兼容——两边余数兜底的乘客顺序不同，同一张单在详情页与导出里那一分钱会落到不同人头上。
 */
export function resolvePerPaxSettlement(input: ResolvePerPaxSettlementInput): ResolvedPerPaxSettlement {
  const { passengerShares, passengerIds } = input;
  const derived = computePerPaxSettlement(input);
  if (!Array.isArray(passengerShares) || passengerIds.length === 0) {
    return { ...derived, source: 'DERIVED' };
  }
  const byPid = new Map<string, PersistedPassengerShareLike>();
  for (const s of passengerShares) {
    if (
      s &&
      typeof s.passengerId === 'string' &&
      Number.isFinite(s.settlementCny) &&
      Number.isFinite(s.adjustmentCny)
    ) {
      byPid.set(s.passengerId, s);
    }
  }
  const rows: PerPaxSettlementRow[] = [];
  for (const pid of passengerIds) {
    const s = byPid.get(pid);
    if (!s) return { ...derived, source: 'DERIVED' };
    rows.push({ passengerId: pid, netCny: s.adjustmentCny, settlementCny: s.settlementCny });
  }
  return { rows, payableCny: derived.payableCny, excludedCny: derived.excludedCny, source: 'PERSISTED' };
}
