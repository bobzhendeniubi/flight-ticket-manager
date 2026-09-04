/**
 * 改单申请队列（运营专属）——OrdersPage 头部「改单申请」按钮打开，镜像已有的
 * BundleChangeRequestQueueModal（套餐改档申请队列）交互：表格 + 逐行确认执行/驳回 + 多选批量确认执行，
 * 但这里额外带 PENDING/APPROVED/REJECTED 三个筛选 tab（改单申请量通常比套餐改档申请大得多，
 * 运营需要回看已处理的），并且是游标分页（GET /order-change-requests 用 cursor，不是 page/pageSize）。
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, orderChangeRequestsApi, type OrderChangeRequest, type OrderChangeRequestStatus, type OrderSummary } from '../lib/api';
import { useAuth } from '../stores/auth';
import { useConfirm } from './ConfirmDialog';
import { Modal } from './Modal';
import { formatDateTimeSecCn } from '../lib/datetime';
import { ORDER_CHANGE_REQUEST_KIND_LABEL } from './orderChangeRequestShared';

const STATUS_TABS: Array<{ value: OrderChangeRequestStatus; label: string }> = [
  { value: 'PENDING', label: '待处理' },
  { value: 'APPROVED', label: '已执行' },
  { value: 'REJECTED', label: '已驳回' },
];

const PAGE_LIMIT = 50;

export interface OrderChangeRequestQueueModalProps {
  onClose: () => void;
  /** 确认执行/驳回后回调；确认执行成功时带上刷新后的整单，方便调用方就地更新列表/抽屉。 */
  onDecided?: (order?: OrderSummary) => void;
  onOpenOrder: (orderId: string) => void;
}

export function OrderChangeRequestQueueModal({ onClose, onDecided, onOpenOrder }: OrderChangeRequestQueueModalProps) {
  const token = useAuth((s) => s.tokens)?.accessToken ?? '';
  const confirm = useConfirm();

  const [statusTab, setStatusTab] = useState<OrderChangeRequestStatus>('PENDING');
  const [items, setItems] = useState<OrderChangeRequest[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decisionNoteById, setDecisionNoteById] = useState<Record<string, string>>({});
  const [rowErrorById, setRowErrorById] = useState<Record<string, string>>({});
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState<{ approved: number; failed: number } | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setLoadError(null);
    setSelectedIds(new Set());
    setBatchResult(null);
    orderChangeRequestsApi
      .listOrderChangeRequests(token, { status: statusTab, limit: PAGE_LIMIT })
      .then((result) => {
        setItems(result.requests);
        setNextCursor(result.nextCursor);
      })
      .catch((e: unknown) => setLoadError(e instanceof ApiError ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [token, statusTab]);
  useEffect(() => { load(); }, [load]);

  const loadMore = async (): Promise<void> => {
    if (!token || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await orderChangeRequestsApi.listOrderChangeRequests(token, {
        status: statusTab,
        limit: PAGE_LIMIT,
        cursor: nextCursor,
      });
      setItems((prev) => [...prev, ...result.requests]);
      setNextCursor(result.nextCursor);
    } catch (e: unknown) {
      setLoadError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const decide = async (item: OrderChangeRequest, action: 'approve' | 'reject'): Promise<void> => {
    if (!token || decidingId) return;
    const note = (decisionNoteById[item.id] ?? '').trim();
    const confirmed = await confirm({
      title: action === 'approve' ? '确认执行改单申请？' : '驳回改单申请？',
      body:
        action === 'approve'
          ? `订单 ${item.orderNumber ?? item.orderId}：确认后将按「${item.summary ?? ORDER_CHANGE_REQUEST_KIND_LABEL[item.kind]}」直接执行。`
          : `订单 ${item.orderNumber ?? item.orderId}：驳回后订单不变，代理会看到驳回原因。`,
      tone: action === 'approve' ? 'default' : 'danger',
      confirmText: action === 'approve' ? '确认执行' : '驳回',
      cancelText: '取消',
    });
    if (!confirmed) return;
    setDecidingId(item.id);
    try {
      if (action === 'approve') {
        const result = await orderChangeRequestsApi.approveOrderChangeRequest(token, item.id);
        setItems((prev) => prev.filter((candidate) => candidate.id !== item.id));
        setRowErrorById((prev) => {
          if (!(item.id in prev)) return prev;
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        onDecided?.(result.order);
      } else {
        await orderChangeRequestsApi.rejectOrderChangeRequest(token, item.id, note || undefined);
        setItems((prev) => prev.filter((candidate) => candidate.id !== item.id));
        onDecided?.();
      }
    } catch (e: unknown) {
      // 400（如「已落位需先换酒店」）留在原地：申请仍是 PENDING，行上标红字，别让运营以为已经处理。
      const message = e instanceof ApiError ? e.message : '操作失败，请稍后重试';
      if (action === 'approve') {
        setRowErrorById((prev) => ({ ...prev, [item.id]: message }));
      } else {
        alert(message);
      }
    } finally {
      setDecidingId(null);
    }
  };

  const batchApprove = async (): Promise<void> => {
    if (!token || selectedIds.size === 0 || batchSubmitting) return;
    const ids = [...selectedIds];
    const confirmed = await confirm({
      title: '批量确认执行？',
      body: `确认后将逐条执行所选 ${ids.length} 条改单申请；单条失败不影响其余，失败的会留在待处理列表并标红原因。`,
      confirmText: '批量确认执行',
      cancelText: '取消',
    });
    if (!confirmed) return;
    setBatchSubmitting(true);
    try {
      const res = await orderChangeRequestsApi.batchApproveOrderChangeRequests(token, ids);
      setBatchResult({ approved: res.approved, failed: res.failed });
      const nextRowErrors: Record<string, string> = {};
      const failedIds = new Set<string>();
      for (const row of res.results) {
        if (!row.ok) {
          failedIds.add(row.id);
          if (row.error) nextRowErrors[row.id] = row.error;
        }
      }
      setItems((prev) => prev.filter((item) => failedIds.has(item.id)));
      setRowErrorById((prev) => ({ ...prev, ...nextRowErrors }));
      setSelectedIds(new Set());
      onDecided?.();
    } catch (e: unknown) {
      alert(e instanceof ApiError ? e.message : '批量确认执行失败，请稍后重试');
    } finally {
      setBatchSubmitting(false);
    }
  };

  const isPendingTab = statusTab === 'PENDING';

  return (
    <Modal open onClose={onClose} title="改单申请" size="xl">
      <div className="max-h-[75vh] overflow-auto px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                statusTab === tab.value ? 'bg-brand text-white' : 'bg-slate-100 text-ink-soft hover:bg-slate-200'
              }`}
              onClick={() => setStatusTab(tab.value)}
            >
              {tab.label}
            </button>
          ))}
          {isPendingTab && selectedIds.size > 0 && (
            <button
              type="button"
              className="btn-primary ml-auto text-xs disabled:cursor-not-allowed disabled:opacity-50"
              disabled={batchSubmitting}
              onClick={() => void batchApprove()}
            >
              {batchSubmitting ? '处理中…' : `批量确认执行（${selectedIds.size}）`}
            </button>
          )}
        </div>

        {batchResult && (
          <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            批量确认执行完成：成功 {batchResult.approved} 条，失败 {batchResult.failed} 条（失败原因见对应行）。
          </div>
        )}

        {loading && items.length === 0 && <div className="text-sm text-ink-muted">加载中…</div>}
        {loadError && <div className="text-sm text-rose-600">{loadError}</div>}
        {!loading && !loadError && items.length === 0 && (
          <div className="text-sm text-ink-muted">当前没有{STATUS_TABS.find((t) => t.value === statusTab)?.label}的改单申请。</div>
        )}

        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  {isPendingTab && <th className="pb-2 pr-2"></th>}
                  <th className="pb-2 pr-3">订单号</th>
                  <th className="pb-2 pr-3">代理</th>
                  <th className="pb-2 pr-3">类型</th>
                  <th className="pb-2 pr-3">摘要</th>
                  <th className="pb-2 pr-3">备注</th>
                  <th className="pb-2 pr-3">提交时间</th>
                  {isPendingTab && <th className="pb-2 pr-3">操作</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`ocr-queue-${item.id}`} className="border-t border-slate-100 align-top">
                    {isPendingTab && (
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(item.id)}
                          onChange={() => toggleSelected(item.id)}
                          disabled={decidingId === item.id || batchSubmitting}
                        />
                      </td>
                    )}
                    <td className="py-2 pr-3">
                      <button
                        type="button"
                        className="font-mono text-xs font-medium text-brand hover:text-brand-dark"
                        onClick={() => onOpenOrder(item.orderId)}
                      >
                        {item.orderNumber ?? item.orderId}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-xs text-ink-soft">{item.agentName ?? item.requestedByLabel ?? '—'}</td>
                    <td className="py-2 pr-3 text-xs text-ink-soft">{ORDER_CHANGE_REQUEST_KIND_LABEL[item.kind]}</td>
                    <td className="py-2 pr-3 text-xs text-ink-soft">
                      <div className="max-w-[220px]" title={item.summary ?? undefined}>{item.summary ?? '—'}</div>
                      {rowErrorById[item.id] && (
                        <div className="mt-1 rounded bg-rose-50 px-1.5 py-1 text-[11px] text-rose-700">
                          上次执行失败：{rowErrorById[item.id]}
                        </div>
                      )}
                      {!rowErrorById[item.id] && item.applyError && (
                        <div className="mt-1 rounded bg-rose-50 px-1.5 py-1 text-[11px] text-rose-700">
                          上次执行失败：{item.applyError}
                        </div>
                      )}
                      {!isPendingTab && item.decisionNote && (
                        <div className="mt-1 text-[11px] text-slate-500">
                          {item.status === 'REJECTED' ? '驳回原因' : '确认备注'}：{item.decisionNote}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-ink-soft">
                      <div className="max-w-[150px] truncate" title={item.note ?? undefined}>{item.note ?? '—'}</div>
                      {isPendingTab && (
                        <input
                          className="input mt-1 w-36 text-[11px]"
                          placeholder="确认/驳回备注"
                          maxLength={200}
                          value={decisionNoteById[item.id] ?? ''}
                          onChange={(e) => setDecisionNoteById((prev) => ({ ...prev, [item.id]: e.target.value }))}
                          disabled={decidingId === item.id}
                        />
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-ink-soft">{formatDateTimeSecCn(item.createdAt)}</td>
                    {isPendingTab && (
                      <td className="py-2 pr-3">
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            className="btn-primary px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={decidingId === item.id}
                            onClick={() => void decide(item, 'approve')}
                          >
                            确认执行
                          </button>
                          <button
                            type="button"
                            className="btn-danger px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={decidingId === item.id}
                            onClick={() => void decide(item, 'reject')}
                          >
                            驳回
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {nextCursor && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              className="btn-secondary text-xs disabled:opacity-50"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
