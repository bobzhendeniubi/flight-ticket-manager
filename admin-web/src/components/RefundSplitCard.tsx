/**
 * 退款拆分卡（订单详情抽屉，退款申请中/已退款的单）。
 *
 * 为什么必须有这块：退款记录上的金额是**含代理预存余额那部分的总额**。
 * 用余额抵扣过的单批准退款时，余额部分由系统自动退回代理账户；
 * 财务若照着总额全额打现金，就会和这笔自动回补**重复退钱**。
 * 所以这里把「要打的现金」和「自动回余额」分两行摆开，让打款金额一眼可读。
 *
 * 口径纪律：所有金额都直接读后端 GET /orders/:id/refund-quote 的字段，
 * 前端不做任何加减（拆分口径的唯一真源在后端）。后端没给拆分就如实说「拆分未知」。
 *
 * 注：报价接口的 cancellable 只表示「当前状态能否发起取消」——退款申请中的单本来就是 false，
 * 与金额无关，这里不展示、也不当错误处理。
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type OrderSummary, type RefundQuote } from '../lib/api';
import { useAuth } from '../stores/auth';
import { fmtRefundCny, readRefundSplit } from '../lib/refundSplit';
import { Icon } from './Icon';

/** 只在这些状态下有「要不要打款」的问题；其余状态不占抽屉空间。 */
const REFUND_VISIBLE_STATUSES = new Set(['REFUND_REQUESTED', 'REFUNDED']);

export function RefundSplitCard({ order }: { order: OrderSummary }) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const orderId = order.id;
  const visible = REFUND_VISIBLE_STATUSES.has(order.status);

  const [quote, setQuote] = useState<RefundQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .refundQuote(token, orderId)
      .then((res) => {
        if (!cancelled) setQuote(res.quote);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '读取退款拆分失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, token, orderId]);

  if (!visible) return null;

  const split = readRefundSplit(quote);
  const isApproved = order.status === 'REFUNDED';
  // 申请时冻结的应退总额：与实时报价对不上说明中途口径变了（实收变化/退改规则调整），
  // 后端批准退款按**退款记录上的金额**结算，此时照界面打款有风险 → 明确提示复核。
  const requested = order.refunds?.find((r) => r.status === 'REQUESTED');
  const requestedAmount = requested ? Number(requested.amount) : null;
  const drifted =
    split.available &&
    requestedAmount !== null &&
    Number.isFinite(requestedAmount) &&
    Math.abs(requestedAmount - split.totalRefundCny) > 0.01;

  return (
    <section className="rounded-xl border border-rose-200 bg-rose-50/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-rose-700">
          {isApproved ? '退款拆分（已批准）' : '退款拆分（打款依据）'}
        </h3>
        <span className="text-[11px] text-rose-400">按当前退改规则实时计算</span>
      </div>

      {loading && <div className="mt-2 text-xs text-ink-muted">正在读取退款拆分…</div>}

      {!loading && error && (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
          读不到退款拆分：{error}
          <div className="mt-1 text-[11px]">
            这单若用过代理预存余额抵扣，余额部分会自动退回代理账户、无需人工打款。
            打款前请刷新重试并核对拆分，别按应退合计全额打钱。
          </div>
        </div>
      )}

      {!loading && !error && !split.available && (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
          {split.totalRefundCny !== null ? (
            <>
              应退合计 <span className="nums font-semibold">{fmtRefundCny(split.totalRefundCny)}</span>
              ，但后端未给出「退现金 / 退回代理余额」拆分。
            </>
          ) : (
            <>后端未给出退款金额与拆分。</>
          )}
          <div className="mt-1 text-[11px]">
            打款前请联系技术确认：用余额抵扣过的单，余额部分会自动退回代理账户，全额打现金会重复退钱。
          </div>
        </div>
      )}

      {!loading && !error && split.available && (
        <>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xs text-ink-muted">应退合计</span>
            <span className="nums text-lg font-semibold text-rose-700">
              {fmtRefundCny(split.totalRefundCny)}
            </span>
          </div>

          {/* 余额回补为 0（散客单 / 没用余额抵扣，绝大多数）→ 不显示拆分两行，只留合计。 */}
          {split.hasBalanceRefund && (
            <>
              <ul className="mt-1.5 space-y-1 text-xs">
                <li className="flex items-baseline justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5">
                  <span className="font-medium text-ink">
                    退现金
                    <span className="ml-1 text-[11px] font-normal text-rose-600">← 财务按这个金额打款</span>
                  </span>
                  <span className="nums font-semibold text-rose-700">
                    {fmtRefundCny(split.refundToCashCny)}
                  </span>
                </li>
                <li className="flex items-baseline justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5">
                  <span className="font-medium text-ink-soft">
                    退回代理预存余额
                    <span className="ml-1 text-[11px] font-normal text-ink-muted">
                      （系统自动回补，无需打款）
                    </span>
                  </span>
                  <span className="nums font-semibold text-sky-700">
                    {fmtRefundCny(split.refundToBalanceCny)}
                  </span>
                </li>
              </ul>
              <p className="mt-1.5 text-[11px] font-medium text-rose-600">
                <Icon name="alert" /> 别按应退合计打款：其中 {fmtRefundCny(split.refundToBalanceCny)} 由系统退回代理账户，
                人工再打一次就是重复退钱。
              </p>
            </>
          )}

          {drifted && requestedAmount !== null && (
            <p className="mt-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
              退款申请上记的应退是 {fmtRefundCny(requestedAmount)}，与当前实时口径
              {fmtRefundCny(split.totalRefundCny)} 不一致（期间实收或退改规则变过）。
              批准退款按申请上的金额结算，打款前请先与财务核对。
            </p>
          )}
        </>
      )}
    </section>
  );
}
