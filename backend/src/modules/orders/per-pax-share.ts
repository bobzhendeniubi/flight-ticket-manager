/**
 * 每人份额权威口径（后端端口）—— admin-web/src/lib/perPaxSettlement.ts 的逐行等价移植。
 *
 * 拆单（split PNR 售后逃生门）的顶层哲学：
 *   1. 拆单是搬钱不是算钱：unitPrice 全冻结，只动 quantity 与显式差额行；
 *   2. 绝不动库存：座位 sold 一分不动（拆前拆后逐班次舱位 Σquantity 恒等）；
 *   3. fail-closed：任何守恒断言不平即抛错回滚。
 * 本模块只负责第 1 条里「每人该分多少钱」的权威口径 —— 与前端展示用的
 * computePerPaxSettlement 必须逐分（cent）一致，否则运营在详情页看到的每人价
 * 与拆单实际搬走的钱对不上。改动本文件必须同步改前端并跑双向对拍单测。
 *
 * 公式（与前端约定一致，禁止在别处重算）：
 *   应收总额 payableCny = totalCny + (adjustmentCny ?? 0)
 *   基准每人 baseCny    = (payableCny − Σ 全部乘客调整净额) / 乘客数
 *   每人份额             = 基准每人 + 该乘客调整净额
 * 全员合计恒等于 payableCny（用「分」做整数运算，余数兜给最后一位乘客，避免
 * 浮点/四舍五入导致合计对不上）。
 */

export interface PerPaxShareRow {
  passengerId: string;
  /** 该乘客名下「按乘客调价」净额（CNY，正=补收/负=优惠），无调价记录则为 0 */
  netCny: number;
  /** 该乘客的每人份额（CNY），= 应收均摊 + netCny */
  shareCny: number;
}

export interface PerPaxShareResult {
  /** 与入参 passengerIds 同序 */
  rows: PerPaxShareRow[];
  /** 应收总额 = totalCny + adjustmentCny，恒等于 Σ rows[].shareCny */
  payableCny: number;
}

export interface PerPaxShareInput {
  /** 订单 total（CNY） */
  totalCny: number;
  /** 售后费用合计（改期费/换人费等，CNY），未启用时按 0 处理 */
  adjustmentCny?: number | null;
  /** 乘客 ID 列表，决定输出顺序（通常传 order.passengers 顺序） */
  passengerIds: readonly string[];
  /** 乘客 → 「按乘客调价」净额（CNY）；不在此 Map 中的乘客视为净额 0 */
  netByPassenger: ReadonlyMap<string, number>;
}

/** CNY → 分（四舍五入到整分，避免浮点误差传播）。 */
function toCents(cny: number): number {
  return Math.round(cny * 100);
}

/** Order.adjustments 里一条流水的最小形状（本模块只关心金额与「摊不摊」这一位）。 */
export interface SpreadableAdjustmentEntryLike {
  amountCny?: unknown;
  /** true = 这笔钱挂在某个**已经不在这单上**的人头上，不参与每人均摊（见下方口径）。 */
  excludeFromPerPax?: unknown;
}

/**
 * 可摊售后费（喂给 computePerPaxShares 的 adjustmentCny）。
 *
 * 口径（换人重算结算价，2026-09 拍板）：**被换人的钱不是同行人的钱**。
 * 换人时收的换人费（SWAP_FEE）与旧客留下的差价（SWAP_PRICE_DIFF），账记在**被换下去
 * 的那个人**头上——他已经不在这张单的乘客名单里了。若照旧把它们并进 adjustmentCny 一起
 * 均摊，这笔钱会摊到留下来的同行人和换进来的新客身上：新客的每人结算价凭空高出一截，
 * 同行人什么都没做也要多付，导出与详情页的「每人结算价」从此对不上谈定的价。
 * 所以这类流水写入时打 `excludeFromPerPax: true`，均摊基数把它们扣掉；
 * 钱本身仍留在 order.adjustmentCny 里（应收/尾款一分不少），只是不参与「每人多少」的分配。
 *
 * 为什么**不夹逼**：这是一道减法，不是估算。拆单侧已经改成「排除条目整条留在源单、
 * 只按可摊基数劈」（见 orders.service.ts 拆单段的 movedAdjustmentCny），流水与 adjustmentCny
 * 天然对得齐；再夹一次只会在真出现脏数据时把差额静默吞掉，让两侧份额之和不再等于应收。
 * 结果为负是合法的（改到便宜班次退差等场景本来就有负的售后费），照实返回。
 * 与前端 admin-web/src/lib/perPaxSettlement.ts 的同名口径逐行等价 —— 两边都不夹。
 *
 * **切换生效日口径（2026-09 拍板，复审 M5）：只往前看，不回填历史。**
 * `excludeFromPerPax` 这一位是本批才开始写的。上线之前产生的 SWAP_FEE 流水没有这一位，
 * 因此照旧参与均摊（老单的每人份额维持它一直以来的样子）。**刻意不做数据回填**：
 *   · 回填会让已经导出过、已经跟代理对过账的老单每人份额当场变一个数，对账口径凭空断层；
 *   · 换人本身是低频动作，上线前的存量样本极少，人工核对比批量改库安全得多。
 * 所以看到「老单摊了换人费、新单没摊」不是 bug，是这条切换线两侧的正常差异。
 */
export function spreadableAdjustmentCny(order: {
  adjustmentCny?: number | null;
  adjustments?: unknown;
}): number {
  const adjustmentCny = order.adjustmentCny ?? 0;
  const entries = Array.isArray(order.adjustments)
    ? (order.adjustments as SpreadableAdjustmentEntryLike[])
    : [];
  let excludedCents = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object' || e.excludeFromPerPax !== true) continue;
    const amt = typeof e.amountCny === 'number' && Number.isFinite(e.amountCny) ? e.amountCny : 0;
    excludedCents += toCents(amt);
  }
  if (excludedCents === 0) return adjustmentCny;
  return (toCents(adjustmentCny) - excludedCents) / 100;
}

/**
 * 计算每人份额。乘客数为 0 时返回空行。
 * 与前端 computePerPaxSettlement 逐行等价（字段名 settlementCny → shareCny）。
 */
export function computePerPaxShares(input: PerPaxShareInput): PerPaxShareResult {
  const { totalCny, adjustmentCny, passengerIds, netByPassenger } = input;
  const payableCents = toCents(totalCny) + toCents(adjustmentCny ?? 0);
  const payableCny = payableCents / 100;

  const n = passengerIds.length;
  if (n === 0) {
    return { rows: [], payableCny };
  }

  const netCentsById = new Map<string, number>(
    passengerIds.map((pid) => [pid, toCents(netByPassenger.get(pid) ?? 0)]),
  );
  const sumNetCents = [...netCentsById.values()].reduce((acc, v) => acc + v, 0);

  const remainderBaseCents = payableCents - sumNetCents;
  const baseCents = Math.trunc(remainderBaseCents / n);
  // 余数（可能为负）全部兜给最后一位乘客，保证合计恰好等于 payableCents。
  const lastRemainderCents = remainderBaseCents - baseCents * n;

  const rows: PerPaxShareRow[] = passengerIds.map((pid, i) => {
    const netCents = netCentsById.get(pid) ?? 0;
    const rowBaseCents = baseCents + (i === n - 1 ? lastRemainderCents : 0);
    const shareCents = rowBaseCents + netCents;
    return {
      passengerId: pid,
      netCny: netCents / 100,
      shareCny: shareCents / 100,
    };
  });

  return { rows, payableCny };
}
