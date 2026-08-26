/**
 * 「已收」统一口径 —— 只读侧唯一入口
 *
 * 背景：同一个「这张单收了多少钱」在报表/导出/资金三处曾有三种算法，两处漏扣了已完成退款，
 * 于是「先收后退」的订单在应收账龄里余额偏小（甚至被判成已清账），在资金侧却是对的。
 * 管理层看的钱不能有两个数，这里把口径固定成一条：
 *
 *   已收净额 = paidAmount + prepaymentOffset − Σ COMPLETED Refund
 *
 * 三个组成部分的口径说明：
 *
 * 1) paidAmount —— 订单累计现金入账（人工确认收款 / 流水认款都累加到这里）。
 * 2) prepaymentOffset —— 代理用预存余额抵付这张单的金额。同样是客户付出的钱，必须算已收。
 *    ⚠️ 现状：全库该字段恒为 0（没有任何写入路径往上加），所以它今天不影响任何数字；
 *    保留在公式里是为了将来「余额抵尾款」真的落到订单上时不必再改一遍读侧。
 * 3) Σ COMPLETED Refund —— 只扣已完成的退款。退款完成不回冲 paidAmount（只翻 Refund 状态），
 *    不在这里扣，同一笔钱就会被当成还在公司账上。REQUESTED/APPROVED/PROCESSING/REJECTED
 *    一律不扣：钱还没出去，扣了会把在途退款当成已经退完。
 *
 * 取舍：预存流水（PrepaymentTransaction，type=OFFSET）**不**并入本口径。
 *   理由：OFFSET 流水是代理余额池侧的账，与订单是多对多（一笔充值可摊到多单、一单可被多笔抵），
 *   订单侧真正的抵扣结果已经物化在 Order.prepaymentOffset 上。两边都算会把同一笔抵扣计两次。
 *   若将来余额抵扣改为只记流水、不物化到订单，要改的是这里的第 2 项，而不是各调用方。
 *
 * 本模块只做读侧口径，不写任何资金字段。资金写入侧（收款/认款/退款/多付处置）的超收闸与
 * 守恒断言另有实现，两边共用同一个公式但各自求和，互不依赖。
 */
import type { Prisma } from '@prisma/client';

/** Decimal / number / 空值 统一转 number（空 = 0） */
type MoneyLike = Prisma.Decimal | number | null | undefined;

function toNumber(value: MoneyLike): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 已收口径需要的订单字段（Prisma 查询里 select 出这两个即可） */
export interface NetReceivedOrderShape {
  paidAmount: MoneyLike;
  /** 代理预存余额抵扣额；现状恒 0，见文件头注释第 2 项 */
  prepaymentOffset?: MoneyLike;
}

/** 已完成退款行（查询时按 status='COMPLETED' 过滤后传进来） */
export interface CompletedRefundShape {
  amount: MoneyLike;
}

/**
 * 汇总已完成退款金额。
 * 传入的数组必须已经按 status='COMPLETED' 过滤（Prisma 侧 `refunds: { where: { status: 'COMPLETED' } }`）；
 * 本函数不认识状态字段，不做二次过滤。undefined/null 视为「这张单没有退款」返回 0。
 */
export function sumCompletedRefundCny(
  refunds: readonly CompletedRefundShape[] | null | undefined,
): number {
  if (refunds == null) return 0;
  return round2(refunds.reduce((sum, r) => sum + toNumber(r.amount), 0));
}

/**
 * 已收净额 = paidAmount + prepaymentOffset − 已完成退款。
 *
 * @param order         至少含 paidAmount（prepaymentOffset 缺省按 0）
 * @param refundsSumCny 该订单已完成退款合计，用 sumCompletedRefundCny 算
 */
export function netReceivedCny(order: NetReceivedOrderShape, refundsSumCny: number): number {
  return round2(toNumber(order.paidAmount) + toNumber(order.prepaymentOffset) - refundsSumCny);
}
