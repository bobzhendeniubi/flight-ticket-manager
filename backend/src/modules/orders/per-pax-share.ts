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
