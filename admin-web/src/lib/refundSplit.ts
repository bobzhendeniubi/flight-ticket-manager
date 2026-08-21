/**
 * 退款拆分读取器（纯函数，无 IO）。
 *
 * 背景：一张用代理预存余额抵扣过的订单退款时，「应退合计」里有一部分并不需要财务打款——
 * 批准退款时后端会自动写一笔余额回补流水退回代理账户。财务若照着合计全额打现金，
 * 就会和这笔自动回补**重复退钱**。所以凡是展示应退金额的地方都要显示拆分。
 *
 * 铁律：本模块**只读后端字段，绝不自己算金额**。
 * 拆分口径唯一真源在 backend/src/lib/cancellation.ts 的 splitRefundBetweenCashAndBalance，
 * 前端用减法「补」出来的数字一旦与后端口径漂移，就是又一次重复退钱。
 * 后端没给拆分（老部署/字段缺失）→ 返回 available:false，界面如实说「拆分未知」，不猜。
 */
import type { RefundQuote } from './api';

/** 后端给了完整拆分 */
export interface RefundSplitAvailable {
  available: true;
  totalRefundCny: number;
  /** 财务实际要打款的现金 */
  refundToCashCny: number;
  /** 系统自动退回代理预存余额的部分，无需打款 */
  refundToBalanceCny: number;
  /** true = 有余额回补，界面必须显示拆分与防重复打款提示 */
  hasBalanceRefund: boolean;
}

/** 后端未下发拆分字段：只知道合计 */
export interface RefundSplitUnavailable {
  available: false;
  totalRefundCny: number | null;
}

export type RefundSplit = RefundSplitAvailable | RefundSplitUnavailable;

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 从退款报价里读出拆分。三个金额字段任一缺失/非法 → available:false（不猜、不补算）。
 */
export function readRefundSplit(
  quote:
    | Pick<RefundQuote, 'totalRefund' | 'refundToCashCny' | 'refundToBalanceCny'>
    | null
    | undefined,
): RefundSplit {
  const total = finiteOrNull(quote?.totalRefund);
  const cash = finiteOrNull(quote?.refundToCashCny);
  const balance = finiteOrNull(quote?.refundToBalanceCny);
  if (total === null || cash === null || balance === null) {
    return { available: false, totalRefundCny: total };
  }
  return {
    available: true,
    totalRefundCny: total,
    refundToCashCny: cash,
    refundToBalanceCny: balance,
    hasBalanceRefund: balance > 0,
  };
}

/** ¥ 金额展示：整数不带小数，有零头显示两位。 */
export function fmtRefundCny(n: number): string {
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/**
 * 「批准退款」确认弹窗的正文。
 *
 * 返回 null = 无需额外确认（散客单 / 没用余额抵扣的单，绝大多数）：不给日常操作添噪音。
 * 返回字符串 = 这单有余额回补，必须让人看见「别重复打款」再点确定。
 */
export function refundApprovalWarning(orderNumber: string, split: RefundSplit): string | null {
  if (!split.available || !split.hasBalanceRefund) return null;
  return (
    `订单 ${orderNumber}：应退合计 ${fmtRefundCny(split.totalRefundCny)}，其中\n\n` +
    `　• 退现金 ${fmtRefundCny(split.refundToCashCny)} ← 财务只打这个金额\n` +
    `　• 退回代理预存余额 ${fmtRefundCny(split.refundToBalanceCny)}（批准后系统自动退回代理账户）\n\n` +
    `⚠️ 余额部分无需人工打款，请勿按应退合计重复退钱。\n\n确认批准退款？`
  );
}

/**
 * 读不到报价时的确认弹窗正文：不阻断退款，但把风险如实说清楚。
 * （拆分取不到就默默放行，等于把「是否重复打款」交给运气。）
 */
export function refundApprovalUnknownWarning(orderNumber: string, errorText: string): string {
  return (
    `订单 ${orderNumber}：暂时读不到退款拆分（${errorText}）。\n\n` +
    `若这单用过代理预存余额抵扣，批准后余额部分会自动退回代理账户、无需人工打款；` +
    `此时按应退合计全额打现金会重复退钱。\n\n` +
    `建议稍后重试并核对拆分。仍要继续批准退款吗？`
  );
}
