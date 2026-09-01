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
import type { OrderRefund, OrderSummary, RefundQuote } from './api';

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

export interface FrozenRefundInfo {
  amountCny: number;
  isSwapRefund: boolean;
  swapFeeCny: number | null;
}

/** 退款申请已存在时，读取真正会被批准的冻结金额，而不是重新计算政策报价。 */
export function readRequestedRefund(
  order: Pick<OrderSummary, 'refunds'>,
): FrozenRefundInfo | null {
  const refund: OrderRefund | undefined = order.refunds?.find((item) => item.status === 'REQUESTED');
  if (!refund) return null;
  const amountCny = Number(refund.amount);
  if (!Number.isFinite(amountCny)) return null;
  const payload = refund.gatewayPayload;
  const isSwapRefund = payload?.swapRefund === true;
  const swapFeeCny = finiteOrNull(payload?.swapFeeCny);
  return { amountCny, isSwapRefund, swapFeeCny };
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

/** 退款申请已冻结时的批准提示：冻结金额是付款义务，实时政策报价只能作为参考。 */
export function refundApprovalFrozenWarning(
  orderNumber: string,
  frozen: FrozenRefundInfo,
  split: RefundSplit,
): string {
  const lines = [
    `订单 ${orderNumber}：本次按退款申请冻结金额 ${fmtRefundCny(frozen.amountCny)} 结算，不按实时政策报价打款。`,
  ];
  if (frozen.isSwapRefund) {
    const fee = frozen.swapFeeCny === null ? '未知' : fmtRefundCny(frozen.swapFeeCny);
    lines.push(`换人费 ${fee}（不退）／应退 ${fmtRefundCny(frozen.amountCny)}`);
  }
  if (split.available) {
    lines.push(`当前政策报价 ${fmtRefundCny(split.totalRefundCny)} 仅作参考，不作为本次打款依据。`);
    if (split.hasBalanceRefund) {
      lines.push(
        `当前政策参考拆分：退现金 ${fmtRefundCny(split.refundToCashCny)}，退回代理预存余额 ${fmtRefundCny(split.refundToBalanceCny)}。`,
      );
    }
  } else {
    lines.push('当前政策报价不可用；仍以退款申请上的冻结金额为准。');
  }
  lines.push('确认批准退款？');
  return lines.join('\n\n');
}

/**
 * 读不到报价时的确认弹窗正文：不阻断退款，但把风险如实说清楚。
 * （拆分取不到就默默放行，等于把「是否重复打款」交给运气。）
 */
export function refundApprovalUnknownWarning(
  orderNumber: string,
  errorText: string,
  frozen?: FrozenRefundInfo | null,
): string {
  const frozenLine = frozen
    ? `本次应按退款申请冻结金额 ${fmtRefundCny(frozen.amountCny)} 结算。${frozen.isSwapRefund && frozen.swapFeeCny !== null ? `换人费 ${fmtRefundCny(frozen.swapFeeCny)}（不退）。` : ''}\n\n`
    : '';
  return (
    `订单 ${orderNumber}：${frozenLine}暂时读不到退款拆分（${errorText}）。\n\n` +
    `若这单用过代理预存余额抵扣，批准后余额部分会自动退回代理账户、无需人工打款；` +
    `此时按应退合计全额打现金会重复退钱。\n\n` +
    `建议稍后重试并核对拆分。仍要继续批准退款吗？`
  );
}
