/**
 * 「价格调整」商品行按乘客分组 —— 纯函数、无依赖的叶子模块。
 *
 * 原先住在 orders.service.ts（2.5 万行）里。它是每人份额三口径（lib/order-money.ts）的输入，
 * 而 order-money 作为 lib 不能反向 import 整个 orders.service（会绕出 lib → orders.service →
 * lib 的环），所以把它单独抽成叶子；orders.service 原样 re-export，所有既有 import 路径不变。
 * 算法一个字未动（0722 公测反馈「金额明细逐人可解释」时定的口径）。
 */

export interface AdjustmentLine {
  itemId: string;
  amountCny: number;
  reasonCode: string | null;
  description: string;
  passengerId: string | null;
}

/** 金额保留 2 位小数（CNY，避免浮点累计误差）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 按乘客把「价格调整」商品行分组（0722 公测反馈「金额明细逐人可解释」）。纯函数、导出供单测。
 *
 * 只认 metadata.priceAdjustment === true 的行（录单调价 / 事后调价 / 结算价差额 / 补房差都打了这个标）；
 * 其它商品行（机票/酒店/套餐基础价）一律忽略。按行的 passengerId 分桶：
 *   - byPassenger[pid] = 该乘客名下所有调整行 + 净额（Σamount，可正可负）；
 *   - wholeOrder       = passengerId 为空的整单调整行 + 净额（现行为不变）。
 * 「订单总额 = 系统价 + Σ调整」是既有口径（这些行本就计入 subtotal/total）；本函数只做展示层分组，
 * 不改任何金额，故与整单调价同一真值（把每行金额如实归到某乘客或整单）。
 */
export function groupPassengerAdjustments(
  items: ReadonlyArray<{
    id: string;
    amount: number;
    description: string;
    passengerId?: string | null;
    metadata?: unknown;
  }>,
): {
  byPassenger: Record<string, { lines: AdjustmentLine[]; netCny: number }>;
  wholeOrder: { lines: AdjustmentLine[]; netCny: number };
} {
  const byPassenger: Record<string, { lines: AdjustmentLine[]; netCny: number }> = {};
  const wholeOrder = { lines: [] as AdjustmentLine[], netCny: 0 };
  for (const it of items) {
    const md = it.metadata;
    const isAdjust =
      md != null && typeof md === 'object' && (md as { priceAdjustment?: unknown }).priceAdjustment === true;
    if (!isAdjust) continue;
    const reasonCode =
      md != null && typeof md === 'object' && typeof (md as { reasonCode?: unknown }).reasonCode === 'string'
        ? ((md as { reasonCode: string }).reasonCode)
        : null;
    const line: AdjustmentLine = {
      itemId: it.id,
      amountCny: it.amount,
      reasonCode,
      description: it.description,
      passengerId: it.passengerId ?? null,
    };
    if (line.passengerId) {
      const bucket = byPassenger[line.passengerId] ?? { lines: [], netCny: 0 };
      bucket.lines.push(line);
      bucket.netCny = round2(bucket.netCny + line.amountCny);
      byPassenger[line.passengerId] = bucket;
    } else {
      wholeOrder.lines.push(line);
      wholeOrder.netCny = round2(wholeOrder.netCny + line.amountCny);
    }
  }
  return { byPassenger, wholeOrder };
}
