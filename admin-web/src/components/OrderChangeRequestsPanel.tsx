/**
 * 订单详情抽屉——本单待处理改单申请（FLIGHT/VISA/HOTEL/CABIN）小列表。
 * 与 BundleChangeRequestSection（套餐改档申请）并排摆放，同样是「代理只读进度 / 运营就地确认执行·驳回」，
 * 但这里改的是套餐之外的四类字段，运营确认执行走 approve 端点直接调用既有的纠错改航班/换酒店/升舱等动作。
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, orderChangeRequestsApi, type OrderChangeRequest, type OrderSummary } from '../lib/api';
import { useAuth } from '../stores/auth';
import { useConfirm } from './ConfirmDialog';
import { formatDateTimeSecCn } from '../lib/datetime';
import {
  ACKNOWLEDGEMENT_REQUIRED_CODE,
  extraKindConfirmHint,
  formatSignedCny,
  isStarMismatchApproveError,
  ORDER_CHANGE_REQUEST_KIND_LABEL,
  STAR_MISMATCH_REASON_MAX,
} from './orderChangeRequestShared';

const DECIDED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const DECIDED_STATUS_LABEL: Record<'APPROVED' | 'REJECTED', string> = {
  APPROVED: '已执行',
  REJECTED: '已驳回',
};

export interface OrderChangeRequestsPanelProps {
  id?: string;
  orderId: string;
  role?: string;
  /** 运营确认执行成功后，用返回的整单就地刷新抽屉与列表。 */
  onOrderUpdated?: (order: OrderSummary) => void;
  /** 外部（如刚提交完申请的 ChangeRequestModal）想让本面板重新拉一次时，改变这个值即可。 */
  refreshNonce?: number;
}

export function OrderChangeRequestsPanel({
  id,
  orderId,
  role,
  onOrderUpdated,
  refreshNonce,
}: OrderChangeRequestsPanelProps) {
  const token = useAuth((s) => s.tokens)?.accessToken ?? '';
  const confirm = useConfirm();
  const isOpsUser = role === 'ADMIN' || role === 'STAFF';
  const isAgentUser = role === 'AGENT';

  const [requests, setRequests] = useState<OrderChangeRequest[]>([]);
  /** 最近 7 天内已处理（已执行/已驳回）的申请——次日起改单不再当场生效，代理得能回看结果，尤其是驳回原因。 */
  const [decidedRequests, setDecidedRequests] = useState<OrderChangeRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decisionNoteById, setDecisionNoteById] = useState<Record<string, string>>({});
  const [approveErrorById, setApproveErrorById] = useState<Record<string, string>>({});
  const [rejectErrorById, setRejectErrorById] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    if (!token || (!isAgentUser && !isOpsUser)) return () => {};
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const since = new Date(Date.now() - DECIDED_LOOKBACK_MS).toISOString();
    Promise.all([
      orderChangeRequestsApi.listOrderChangeRequests(token, { status: 'PENDING', orderId }),
      orderChangeRequestsApi.listOrderChangeRequests(token, { status: 'APPROVED', orderId, since }),
      orderChangeRequestsApi.listOrderChangeRequests(token, { status: 'REJECTED', orderId, since }),
    ])
      .then(([pending, approved, rejected]) => {
        if (cancelled) return;
        setRequests(pending.requests);
        setDecidedRequests(
          [...approved.requests, ...rejected.requests].sort((a, b) =>
            (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''),
          ),
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof ApiError ? e.message : '改单申请加载失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, orderId, isAgentUser, isOpsUser]);
  useEffect(() => load(), [load, refreshNonce]);

  /**
   * 确认执行，带两条补料重试：
   *   · 「放行原因」类 400（指定酒店星级与套餐档次不符）→ 弹窗补填理由后原样重试；
   *   · ACKNOWLEDGEMENT_REQUIRED（取消单程，多为该段已出票）→ 把提示原文摆出来，
   *     二次确认后带 acknowledgeWarnings 重试。按稳定 code 判，不匹配中文文案。
   * 两条都只补一次料、重试一次；补不上就把原错误原样抛出去，绝不静默放行。
   */
  const approveWithStarMismatchRetry = async (request: OrderChangeRequest, decisionNote: string) => {
    try {
      return await orderChangeRequestsApi.approveOrderChangeRequest(token, request.id, {
        decisionNote: decisionNote || undefined,
      });
    } catch (e: unknown) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code === ACKNOWLEDGEMENT_REQUIRED_CODE) {
        const acknowledged = await confirm({
          title: '这一步需要善后，确认继续？',
          body: `${e.message}\n\n确认后仍会执行取消，请记得跟进后续处理。`,
          tone: 'danger',
          confirmText: '我已知悉，继续',
          cancelText: '取消',
        });
        if (!acknowledged) throw e; // 没勾 = 维持原错误
        return await orderChangeRequestsApi.approveOrderChangeRequest(token, request.id, {
          decisionNote: decisionNote || undefined,
          acknowledgeWarnings: true,
        });
      }
      if (!isStarMismatchApproveError(e.message)) throw e;
      const reason = window.prompt(
        `${e.message}\n请填写「套餐档次与酒店星级不符 · 放行原因」（必填，${STAR_MISMATCH_REASON_MAX} 字以内，随订单留档备查）：`,
        '',
      );
      if (reason === null) throw e; // 取消 = 维持原错误，不重试
      const reasonText = reason.trim();
      if (!reasonText || reasonText.length > STAR_MISMATCH_REASON_MAX) throw e;
      return await orderChangeRequestsApi.approveOrderChangeRequest(token, request.id, {
        decisionNote: decisionNote || undefined,
        designatedHotelStarMismatchReason: reasonText,
      });
    }
  };

  const decide = async (request: OrderChangeRequest, action: 'approve' | 'reject'): Promise<void> => {
    if (!token || decidingId) return;
    const note = (decisionNoteById[request.id] ?? '').trim();
    const moneyLine =
      action === 'approve' && request.kind === 'CABIN' && request.amountCny != null
        ? `\n确认执行后将向本单加收 ¥${request.amountCny.toLocaleString()} 升舱差价（计入应收）。`
        : action === 'approve' && isOpsUser && request.kind === 'HOTEL' && request.costDeltaCny != null
          ? `\n本单成本变化 ${formatSignedCny(request.costDeltaCny)}。`
          : '';
    const confirmed = await confirm({
      title: action === 'approve' ? '确认执行改单申请？' : '驳回改单申请？',
      body:
        action === 'approve'
          ? `确认后将按「${request.summary ?? ORDER_CHANGE_REQUEST_KIND_LABEL[request.kind]}」直接执行。${moneyLine}${extraKindConfirmHint(request.kind)}`
          : '驳回后订单不变，代理会看到驳回原因。',
      tone: action === 'approve' ? 'default' : 'danger',
      confirmText: action === 'approve' ? '确认执行' : '驳回',
      cancelText: '取消',
    });
    if (!confirmed) return;
    setDecidingId(request.id);
    try {
      if (action === 'approve') {
        const result = await approveWithStarMismatchRetry(request, note);
        setRequests((prev) => prev.filter((item) => item.id !== result.request.id));
        setApproveErrorById((prev) => {
          if (!(request.id in prev)) return prev;
          const next = { ...prev };
          delete next[request.id];
          return next;
        });
        onOrderUpdated?.(result.order);
      } else {
        await orderChangeRequestsApi.rejectOrderChangeRequest(token, request.id, note || undefined);
        setRequests((prev) => prev.filter((item) => item.id !== request.id));
        setRejectErrorById((prev) => {
          if (!(request.id in prev)) return prev;
          const next = { ...prev };
          delete next[request.id];
          return next;
        });
      }
    } catch (e: unknown) {
      // 后端 400（如「已落位需先换酒店」等）原样透出；确认执行失败时申请仍留在 PENDING，行上留红字提示。
      const message = e instanceof ApiError ? e.message : '操作失败，请稍后重试';
      if (action === 'approve') {
        setApproveErrorById((prev) => ({ ...prev, [request.id]: message }));
      } else {
        setRejectErrorById((prev) => ({ ...prev, [request.id]: message }));
      }
    } finally {
      setDecidingId(null);
    }
  };

  if (!isAgentUser && !isOpsUser) return null;
  if (!loading && !loadError && requests.length === 0 && decidedRequests.length === 0) return null;

  return (
    <section id={id} className="scroll-mt-4 space-y-3">
      {loading && requests.length === 0 && decidedRequests.length === 0 && (
        <div className="text-xs text-ink-muted">加载中…</div>
      )}
      {loadError && <div className="text-xs text-rose-600">{loadError}</div>}

      {requests.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">改单申请 · 待处理</div>
          {requests.map((request) => {
            const applyError = approveErrorById[request.id] ?? request.applyError;
            const rejectError = rejectErrorById[request.id];
            return (
              <div key={`ocr-${request.id}`} className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                    {ORDER_CHANGE_REQUEST_KIND_LABEL[request.kind]}
                  </span>
                  <span className="font-medium text-amber-900">{request.summary ?? '（无摘要）'}</span>
                  <span className="text-[11px] text-amber-700">{formatDateTimeSecCn(request.createdAt)}</span>
                </div>
                {isOpsUser && (
                  <div className="mt-1 text-xs text-amber-700">申请人：{request.agentName ?? request.requestedByLabel ?? '—'}</div>
                )}
                {request.note && <div className="mt-1 text-xs text-amber-800">备注：{request.note}</div>}
                {request.kind === 'CABIN' && request.amountCny != null && (
                  <div className="mt-1 text-xs font-medium text-indigo-700">
                    补差 ¥{request.amountCny.toLocaleString()}（计入应收）
                  </div>
                )}
                {isOpsUser && request.kind === 'HOTEL' && request.costDeltaCny != null && (
                  <div className="mt-1 text-xs font-medium text-amber-800">
                    成本 {formatSignedCny(request.costDeltaCny)}
                  </div>
                )}
                {isAgentUser && (
                  <div className="mt-1 text-[11px] text-amber-600">等待运营确认，确认前订单不变</div>
                )}
                {applyError && (
                  <div className="mt-1.5 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">上次执行失败：{applyError}</div>
                )}
                {rejectError && (
                  <div className="mt-1.5 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">上次驳回失败：{rejectError}</div>
                )}
                {isOpsUser && (
                  <>
                    <input
                      className="input mt-2 w-full text-xs"
                      placeholder="确认/驳回备注（选填）"
                      maxLength={200}
                      value={decisionNoteById[request.id] ?? ''}
                      onChange={(e) => setDecisionNoteById((prev) => ({ ...prev, [request.id]: e.target.value }))}
                      disabled={decidingId === request.id}
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        className="btn-primary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={decidingId === request.id}
                        onClick={() => void decide(request, 'approve')}
                      >
                        确认执行
                      </button>
                      <button
                        type="button"
                        className="btn-danger text-xs disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={decidingId === request.id}
                        onClick={() => void decide(request, 'reject')}
                      >
                        驳回
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {decidedRequests.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">改单申请 · 最近处理</div>
          {decidedRequests.map((request) => (
            <div key={`ocr-decided-${request.id}`} className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-ink-soft">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                    request.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                  }`}
                >
                  {request.status === 'APPROVED' || request.status === 'REJECTED'
                    ? DECIDED_STATUS_LABEL[request.status]
                    : request.status}
                </span>
                <span className="font-medium text-ink">{ORDER_CHANGE_REQUEST_KIND_LABEL[request.kind]}</span>
                <span>{request.summary ?? '（无摘要）'}</span>
                {request.decidedAt && <span className="text-slate-400">{formatDateTimeSecCn(request.decidedAt)}</span>}
              </div>
              {request.decisionNote && (
                <div className="mt-1 text-slate-500">
                  {request.status === 'REJECTED' ? '驳回原因' : '确认备注'}：{request.decisionNote}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
