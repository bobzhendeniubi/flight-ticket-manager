/**
 * 订单成本口径 —— 财务汇总 / 订单毛利 / 月度趋势 / 三份财务导出共用的**唯一**判定。
 *
 * 已换人（SWAPPED）单的成本一律按 0（2026-09-30 口径）：
 *   · 位子和房让给了接手的新单，由新单承担并计成本；本单只剩换人费这一笔收入。再按本单明细行
 *     去算机票/房费/签证/车费/杂项，等于同一个座位、同一间房、同一本签证算两遍成本，毛利凭空压低；
 *   · 人次类**统计**（按航班导出的乘客数 / 需签乘客数）同理不计被换下的人（接手的人在新单上计）；
 *   · 按乘客一人一行的**核对明细**（finances.export）人数列照常显示（财务拍板：数字列不动，便于
 *     求和与对照），改在备注列打「已换人·被换下，不计人次、不计成本」标注（swappedOutRowNote）；
 *   · 「缺成本」也不算缺——没有成本可缺，毛利按「收入 − 0」给，不显示「未知」。
 * 收入侧不在这里管：换人费已经收敛进 total，各口径照常按各自的 COUNTED_STATUSES 计。
 *
 * 出口清单（新增成本出口必须走这里判，不许各写一份状态集合）：
 *   finances.service（getFinancesSummary / getOrderPnl / getOrderPnlDetail / getMonthlyTrend）、
 *   finances.export（按乘客核对表）、finances.export-by-flight（按航班 P&L）、
 *   finances.export-orders（经 getOrderPnl）。
 */
import { OrderStatus } from '@prisma/client';

/** 明细行成本（含 OrderCostItem 杂项）一律按 0 计的订单状态。 */
export const ZERO_COST_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.SWAPPED,
]);

/** 该单的成本是否一律按 0 计（见文件头口径）。 */
export function isZeroCostOrder(order: { status: OrderStatus }): boolean {
  return ZERO_COST_ORDER_STATUSES.has(order.status);
}

/** 核对明细里已换人单每一行的备注标注（文案进导出文件，财务按它筛被换下的行）。 */
export const SWAPPED_OUT_ROW_NOTE = '已换人·被换下，不计人次、不计成本';

/**
 * 核对明细备注列：已换人单在订单备注前面加上标注（有备注用「；」接上），其余状态原样返回备注。
 * 人数列照常显示、不在这里归零 —— 数字列保持可求和，标注放文字列。
 */
export function swappedOutRowNote(order: { status: OrderStatus; notes: string | null }): string {
  const notes = order.notes ?? '';
  if (!isZeroCostOrder(order)) return notes;
  return notes.trim() === '' ? SWAPPED_OUT_ROW_NOTE : `${SWAPPED_OUT_ROW_NOTE}；${notes}`;
}
