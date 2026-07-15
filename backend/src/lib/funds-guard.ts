import { OrderStatus, Prisma, RefundStatus } from '@prisma/client';

import { BadRequestError } from './errors.js';

/**
 * 资金入口统一状态闸。
 *
 * 背景（系统审计）：订单状态机主干守卫很严，但「资金旁路入口」各自为政——
 * 人工确认收款 / 到账认领分配 / 代理余额抵扣 / 多付转存 / 多付转挂账池，
 * 全都只认 paidAmount 一个数字，既不看订单状态、也不看软删、也不看已成立的退款义务。
 * 结果：钱能记到已取消/已退款/回收站里的订单上（永远没有出口），
 * 多付还能「先退款、再转存代理余额」被取两次。
 *
 * 本模块把三道闸收敛到一处，供所有资金入口复用：
 *   1. 订单存活（未软删）
 *   2. 订单状态允许该类资金动作
 *   3. 多付处置扣除已完成退款（不重复处置同一笔钱）
 */

/**
 * 拒绝「增加已付金额」类操作（人工收款 / 到账认领 / 代理余额抵扣）的订单状态。
 *
 *   CANCELLED / REFUNDED —— 终态死单：钱进来没有任何出口（退款流程只受理 PAID/PROCESSING/TICKETED）。
 *   PAYMENT_TIMEOUT      —— 座位已释放：先恢复到待付款重新占座，再收款，否则收了钱也没座位。
 *   DRAFT                —— 订单尚未成形（草稿），不应挂真实资金。
 *
 * FAILED 不在闸内：出票失败单客户通常已付款、仍在等运营处置（可回 PROCESSING），
 * 补款/抵扣属正常业务，不拦。
 */
export const FUNDS_CREDIT_BLOCKED_STATUSES: OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.PAYMENT_TIMEOUT,
  OrderStatus.DRAFT,
];

/**
 * 拒绝「处置订单资金」类操作（多付转存代理余额 / 多付转挂账池 / 改结算价）的订单状态。
 *
 * 比收款闸更严：软删单与取消族终态一律不许再动钱，避免账实分叉后无人对得平。
 */
export const FUNDS_DISPOSE_BLOCKED_STATUSES: OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.PAYMENT_TIMEOUT,
  OrderStatus.DRAFT,
  OrderStatus.FAILED,
];

const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待付款',
  PAID: '已付款',
  PROCESSING: '处理中',
  TICKETED: '已出票',
  COMPLETED: '已完成',
  PAYMENT_TIMEOUT: '支付超时',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '退款申请中',
  REFUNDED: '已退款',
  CHANGE_REQUESTED: '改签申请中',
  CHANGED: '已改签',
  FAILED: '出票失败',
};

export interface FundsGuardOrder {
  orderNumber: string;
  status: OrderStatus;
  deletedAt: Date | null;
}

/**
 * 收款闸：订单是否可以接收资金（增加 paidAmount）。
 * 软删单一律拒绝——回收站里的单不进任何列表/导出/统计，收了钱账就永久对不平。
 */
export function assertOrderAcceptsFunds(order: FundsGuardOrder): void {
  if (order.deletedAt) {
    throw new BadRequestError(
      `订单 ${order.orderNumber} 已在回收站，不能记录收款。请先恢复订单再操作。`,
    );
  }
  if (FUNDS_CREDIT_BLOCKED_STATUSES.includes(order.status)) {
    throw new BadRequestError(
      `订单 ${order.orderNumber} 当前状态为「${STATUS_LABEL[order.status]}」，不能记录收款。` +
        `如客户确实已付款，请先将订单恢复到可收款状态（如待付款），或把这笔钱登记到挂账池再认领。`,
    );
  }
}

/**
 * 处置闸：订单是否可以处置自身资金（多付转存/转挂账池、改结算价）。
 */
export function assertOrderAllowsFundsDisposal(order: FundsGuardOrder, action: string): void {
  if (order.deletedAt) {
    throw new BadRequestError(`订单 ${order.orderNumber} 已在回收站，不能${action}。请先恢复订单。`);
  }
  if (FUNDS_DISPOSE_BLOCKED_STATUSES.includes(order.status)) {
    throw new BadRequestError(
      `订单 ${order.orderNumber} 当前状态为「${STATUS_LABEL[order.status]}」，不能${action}。`,
    );
  }
}

/**
 * 该订单已完成的退款总额。
 *
 * 多付处置必须先扣掉它：退款完成不减 paidAmount（REFUNDED 流转只翻 Refund 状态），
 * 所以「已退给客户的钱」在 paidAmount 里仍然看得见。不扣就会把同一笔多付
 * 先按退款退给客户、再按多付转进代理余额，公司净损失。
 */
export async function sumCompletedRefundsWithinTx(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<number> {
  const agg = await tx.refund.aggregate({
    where: { orderId, status: RefundStatus.COMPLETED },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}
