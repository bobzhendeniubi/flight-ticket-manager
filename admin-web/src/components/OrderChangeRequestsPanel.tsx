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
import { ORDER_CHANGE_REQUEST_KIND_LABEL } from './orderChangeRequestShared';

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
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decisionNoteById, setDecisionNoteById] = useState<Record<string, string>>({});
  const [approveErrorById, setApproveErrorById] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    if (!token || (!isAgentUser && !isOpsUser)) return () => {};
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    orderChangeRequestsApi
      .listOrderChangeRequests(token, { status: 'PENDING', orderId })
      .then((result) => { if (!cancelled) setRequests(result.requests); })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof ApiError ? e.message : '改单申请加载失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, orderId, isAgentUser, isOpsUser]);
  useEffect(() => load(), [load, refreshNonce]);

  const decide = async (request: OrderChangeRequest, action: 'approve' | 'reject'): Promise<void> => {
    if (!token || decidingId) return;
    const note = (decisionNoteById[request.id] ?? '').trim();
    const confirmed = await confirm({
      title: action === 'approve' ? '确认执行改单申请？' : '驳回改单申请？',
      body:
        action === 'approve'
          ? `确认后将按「${request.summary ?? ORDER_CHANGE_REQUEST_KIND_LABEL[request.kind]}」直接执行。`
          : '驳回后订单不变，代理会看到驳回原因。',
      tone: action === 'approve' ? 'default' : 'danger',
      confirmText: action === 'approve' ? '确认执行' : '驳回',
      cancelText: '取消',
    });
    if (!confirmed) return;
    setDecidingId(request.id);
    try {
      if (action === 'approve') {
        const result = await orderChangeRequestsApi.approveOrderChangeRequest(token, request.id);
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
      }
    } catch (e: unknown) {
      // 后端 400（如「已落位需先换酒店」等）原样透出；确认执行失败时申请仍留在 PENDING，行上留红字提示。
      const message = e instanceof ApiError ? e.message : '操作失败，请稍后重试';
      if (action === 'approve') {
        setApproveErrorById((prev) => ({ ...prev, [request.id]: message }));
      } else {
        alert(message);
      }
    } finally {
      setDecidingId(null);
    }
  };

  if (!isAgentUser && !isOpsUser) return null;
  if (!loading && !loadError && requests.length === 0) return null;

  return (
    <section id={id} className="scroll-mt-4 space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">改单申请 · 待处理</div>
      {loading && requests.length === 0 && <div className="text-xs text-ink-muted">加载中…</div>}
      {loadError && <div className="text-xs text-rose-600">{loadError}</div>}

      {requests.map((request) => {
        const applyError = approveErrorById[request.id] ?? request.applyError;
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
            {isAgentUser && (
              <div className="mt-1 text-[11px] text-amber-600">等待运营确认，确认前订单不变</div>
            )}
            {applyError && (
              <div className="mt-1.5 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">上次执行失败：{applyError}</div>
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
    </section>
  );
}
