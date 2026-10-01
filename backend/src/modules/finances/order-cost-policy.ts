/**
 * 订单成本口径 —— 财务汇总 / 订单毛利 / 月度趋势 / 三份财务导出共用的**唯一**判定。
 *
 * 已换人（SWAPPED）单的成本一律按 0（2026-09-30 口径）：
 *   · 位子和房让给了接手的新单，由新单承担并计成本；本单只剩换人费这一笔收入。再按本单明细行
 *     去算机票/房费/签证/车费/杂项，等于同一个座位、同一间房、同一本签证算两遍成本，毛利凭空压低；
 *   · 乘客人数 / 人次类统计同理不计被换下的人（接手的人在新单上计）；
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

/** 人数口径：被换下的人不计人次（接手的人在新单上计）；其余状态照乘客数。 */
export function countedPassengerCount(order: {
  status: OrderStatus;
  passengers: ReadonlyArray<unknown>;
}): number {
  return isZeroCostOrder(order) ? 0 : order.passengers.length;
}
