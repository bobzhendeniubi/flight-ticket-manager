/**
 * 每人结算价（派生展示，D2）——纯函数，不落库、不改任何金额计算，只把订单已有的权威金额
 * （order.total / order.adjustmentCny）与「按乘客调价」净额（PriceAdjustmentSection 已用的
 * groupOrderAdjustments byPassenger）重新摊到每个乘客身上，给票务一眼看出「补办签证只多收她 800」。
 *
 * 公式（与调用方约定一致，禁止在别处重算）：
 *   应收总额 payableCny = totalCny + (adjustmentCny ?? 0)
 *   基准每人 baseCny    = (payableCny − Σ 全部乘客调整净额) / 乘客数
 *   每人结算价           = 基准每人 + 该乘客调整净额
 * 全员合计恒等于 payableCny（用「分」做整数运算，余数兜给最后一位乘客，避免浮点/四舍五入导致
 * 合计对不上）。
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
  /** 应收总额 = totalCny + adjustmentCny，等于 Σ rows[].settlementCny */
  payableCny: number;
}

export interface PerPaxSettlementInput {
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
 * 计算每人结算价。乘客数为 0 时返回空行（调用方应只在乘客数 ≥ 2 时展示这张表）。
 */
export function computePerPaxSettlement(input: PerPaxSettlementInput): PerPaxSettlementResult {
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

  return { rows, payableCny };
}
