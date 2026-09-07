/**
 * 改单申请队列（运营专属）——OrdersPage 头部「改单申请」按钮打开，镜像已有的
 * BundleChangeRequestQueueModal（套餐改档申请队列）交互：表格 + 逐行确认执行/驳回 + 多选批量确认执行，
 * 但这里额外带 PENDING/APPROVED/REJECTED 三个筛选 tab（改单申请量通常比套餐改档申请大得多，
 * 运营需要回看已处理的），并且是游标分页（GET /order-change-requests 用 cursor，不是 page/pageSize）。
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, orderChangeRequestsApi, type OrderChangeExecution, type OrderChangeRequest, type OrderChangeRequestStatus, type OrderSummary } from '../lib/api';
import { useAuth } from '../stores/auth';
import { useConfirm } from './ConfirmDialog';
import { Modal } from './Modal';
import { formatDateTimeSecCn } from '../lib/datetime';
import {
  formatSignedCny,
  isStarMismatchApproveError,
  ORDER_CHANGE_REQUEST_KIND_LABEL,
  STAR_MISMATCH_REASON_MAX,
} from './orderChangeRequestShared';

const STATUS_TABS: Array<{ value: OrderChangeRequestStatus; label: string }> = [
  { value: 'PENDING', label: '待处理' },
  { value: 'APPROVED', label: '已执行' },
  { value: 'REJECTED', label: '已驳回' },
];

const PAGE_LIMIT = 50;

/** 缺省费用名目，与改期表单一致。 */
const RESCHEDULE_FEE_LABEL = '改期费';

/**
 * 改班次申请的执行方式草稿（每行各一份）。
 * 缺省纠错：本来就该录成这班，差价恒 0、不撤立减、不推状态 —— 与这个队列一直以来的行为一致。
 * 选「按售后改期」才是行程真的变了：收改期费、撤套餐立减、按售后语义推状态。
 */
interface ExecutionDraft {
  mode: 'CORRECTION' | 'AFTER_SALES';
  /** 文本态：空 = 不收费（0）；提交前校验成非负整数。 */
  feeCny: string;
  feeLabel: string;
  note: string;
}

const DEFAULT_EXECUTION: ExecutionDraft = {
  mode: 'CORRECTION',
  feeCny: '',
  feeLabel: RESCHEDULE_FEE_LABEL,
  note: '',
};

const FEE_INVALID_MESSAGE = '改期费请填 0 或正整数（元）';

/**
 * 草稿 → 请求字段。返回 null 表示按老路子走（不带 execution，服务端即纠错执行）。
 * 校验不过抛出一句人话，由调用方标在行上（不发请求）。
 */
function buildExecution(item: OrderChangeRequest, draft: ExecutionDraft): OrderChangeExecution | null {
  if (item.kind !== 'FLIGHT' || draft.mode !== 'AFTER_SALES') return null;
  const feeText = draft.feeCny.trim();
  const feeCny = feeText === '' ? 0 : Number(feeText);
  if (!Number.isInteger(feeCny) || feeCny < 0) throw new Error(FEE_INVALID_MESSAGE);
  const feeLabel = draft.feeLabel.trim() || RESCHEDULE_FEE_LABEL;
  const note = draft.note.trim();
  return { mode: 'AFTER_SALES', feeCny, feeLabel, ...(note ? { note } : {}) };
}

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
  // 改班次申请的执行方式（仅 FLIGHT 行有入口）：默认纠错执行，选售后改期才展开费用字段。
  const [executionById, setExecutionById] = useState<Record<string, ExecutionDraft>>({});
  const [rowErrorById, setRowErrorById] = useState<Record<string, string>>({});
  const [rowRejectErrorById, setRowRejectErrorById] = useState<Record<string, string>>({});
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState<{ approved: number; failed: number } | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setLoadError(null);
    setSelectedIds(new Set());
    setBatchResult(null);
    setBatchError(null);
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

  const executionOf = (id: string): ExecutionDraft => executionById[id] ?? DEFAULT_EXECUTION;
  const patchExecution = (id: string, patch: Partial<ExecutionDraft>) =>
    setExecutionById((prev) => ({ ...prev, [id]: { ...(prev[id] ?? DEFAULT_EXECUTION), ...patch } }));

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 确认执行，途中若命中「放行原因」类 400（指定酒店星级与套餐档次不符），弹窗补填理由后原样重试一次。 */
  const approveWithStarMismatchRetry = async (
    item: OrderChangeRequest,
    decisionNote: string,
    execution: OrderChangeExecution | null,
  ) => {
    const base = {
      decisionNote: decisionNote || undefined,
      ...(execution ? { execution } : {}),
    };
    try {
      return await orderChangeRequestsApi.approveOrderChangeRequest(token, item.id, base);
    } catch (e: unknown) {
      if (!(e instanceof ApiError) || !isStarMismatchApproveError(e.message)) throw e;
      const reason = window.prompt(
        `${e.message}\n请填写「套餐档次与酒店星级不符 · 放行原因」（必填，${STAR_MISMATCH_REASON_MAX} 字以内，随订单留档备查）：`,
        '',
      );
      if (reason === null) throw e; // 取消 = 维持原错误，不重试
      const reasonText = reason.trim();
      if (!reasonText || reasonText.length > STAR_MISMATCH_REASON_MAX) throw e;
      return await orderChangeRequestsApi.approveOrderChangeRequest(token, item.id, {
        ...base,
        designatedHotelStarMismatchReason: reasonText,
      });
    }
  };

  const decide = async (item: OrderChangeRequest, action: 'approve' | 'reject'): Promise<void> => {
    if (!token || decidingId) return;
    const note = (decisionNoteById[item.id] ?? '').trim();
    // 执行方式（仅改班次有入口）：校验不过就地标红，一个请求都不发。
    let execution: OrderChangeExecution | null = null;
    if (action === 'approve') {
      try {
        execution = buildExecution(item, executionOf(item.id));
      } catch (e: unknown) {
        setRowErrorById((prev) => ({ ...prev, [item.id]: e instanceof Error ? e.message : FEE_INVALID_MESSAGE }));
        return;
      }
    }
    const moneyLine =
      action === 'approve' && execution
        ? `\n将按售后改期执行：加收${execution.feeLabel ?? RESCHEDULE_FEE_LABEL} ¥${(execution.feeCny ?? 0).toLocaleString()}（计入应收），并将撤销套餐立减、按售后改期推状态。`
        : action === 'approve' && item.kind === 'CABIN' && item.amountCny != null
          ? `\n确认执行后将向本单加收 ¥${item.amountCny.toLocaleString()} 升舱差价（计入应收）。`
          : action === 'approve' && item.kind === 'HOTEL' && item.costDeltaCny != null
            ? `\n本单成本变化 ${formatSignedCny(item.costDeltaCny)}。`
            : '';
    const confirmed = await confirm({
      title: action === 'approve' ? '确认执行改单申请？' : '驳回改单申请？',
      body:
        action === 'approve'
          ? `订单 ${item.orderNumber ?? item.orderId}：确认后将按「${item.summary ?? ORDER_CHANGE_REQUEST_KIND_LABEL[item.kind]}」直接执行。${moneyLine}`
          : `订单 ${item.orderNumber ?? item.orderId}：驳回后订单不变，代理会看到驳回原因。`,
      tone: action === 'approve' && execution ? 'danger' : action === 'approve' ? 'default' : 'danger',
      confirmText: action === 'approve' ? '确认执行' : '驳回',
      cancelText: '取消',
    });
    if (!confirmed) return;
    setDecidingId(item.id);
    try {
      if (action === 'approve') {
        const result = await approveWithStarMismatchRetry(item, note, execution);
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
        setRowRejectErrorById((prev) => {
          if (!(item.id in prev)) return prev;
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        onDecided?.();
      }
    } catch (e: unknown) {
      // 400（如「已落位需先换酒店」）留在原地：申请仍是 PENDING，行上标红字，别让运营以为已经处理。
      const message = e instanceof ApiError ? e.message : '操作失败，请稍后重试';
      if (action === 'approve') {
        setRowErrorById((prev) => ({ ...prev, [item.id]: message }));
      } else {
        setRowRejectErrorById((prev) => ({ ...prev, [item.id]: message }));
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
      body: `确认后将逐条执行所选 ${ids.length} 条改单申请；单条失败不影响其余，失败的会留在待处理列表并标红原因。批量一律按纠错执行（不动钱），要收改期费请逐条确认。`,
      confirmText: '批量确认执行',
      cancelText: '取消',
    });
    if (!confirmed) return;
    setBatchSubmitting(true);
    setBatchError(null);
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
      // 只摘掉「本次选中且成功」的行——未选中的行、以及选中但失败的行都要留在列表里，
      // 之前 filter(failedIds.has(...)) 把没选的行也一并冲掉了（H3）。
      const selectedIdSet = new Set(ids);
      setItems((prev) => prev.filter((item) => !selectedIdSet.has(item.id) || failedIds.has(item.id)));
      setRowErrorById((prev) => ({ ...prev, ...nextRowErrors }));
      setSelectedIds(new Set());
      onDecided?.();
    } catch (e: unknown) {
      setBatchError(e instanceof ApiError ? e.message : '批量确认执行失败，请稍后重试');
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
        {batchError && (
          <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {batchError}
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
                      {item.kind === 'CABIN' && item.amountCny != null && (
                        <div className="mt-1 text-[11px] font-medium text-indigo-700">
                          补差 ¥{item.amountCny.toLocaleString()}（计入应收）
                        </div>
                      )}
                      {item.kind === 'HOTEL' && item.costDeltaCny != null && (
                        <div className="mt-1 text-[11px] font-medium text-amber-700">
                          成本 {formatSignedCny(item.costDeltaCny)}
                        </div>
                      )}
                      {isPendingTab && item.kind === 'FLIGHT' && (
                        <div className="mt-1.5 rounded border border-slate-200 bg-slate-50 px-1.5 py-1">
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                            <label className="flex items-center gap-1 text-[11px] text-ink-soft">
                              <input
                                type="radio"
                                name={`ocr-exec-${item.id}`}
                                checked={executionOf(item.id).mode === 'CORRECTION'}
                                onChange={() => patchExecution(item.id, { mode: 'CORRECTION' })}
                                disabled={decidingId === item.id || batchSubmitting}
                              />
                              纠错执行（不动钱）
                            </label>
                            <label className="flex items-center gap-1 text-[11px] text-ink-soft">
                              <input
                                type="radio"
                                name={`ocr-exec-${item.id}`}
                                checked={executionOf(item.id).mode === 'AFTER_SALES'}
                                onChange={() => patchExecution(item.id, { mode: 'AFTER_SALES' })}
                                disabled={decidingId === item.id || batchSubmitting}
                              />
                              按售后改期执行
                            </label>
                          </div>
                          {executionOf(item.id).mode === 'AFTER_SALES' && (
                            <div className="mt-1 space-y-1">
                              <div className="flex flex-wrap gap-1">
                                <input
                                  className="input w-20 text-[11px]"
                                  inputMode="numeric"
                                  placeholder="改期费"
                                  value={executionOf(item.id).feeCny}
                                  onChange={(e) => patchExecution(item.id, { feeCny: e.target.value })}
                                  disabled={decidingId === item.id}
                                />
                                <input
                                  className="input w-24 text-[11px]"
                                  placeholder="费用名目"
                                  maxLength={120}
                                  value={executionOf(item.id).feeLabel}
                                  onChange={(e) => patchExecution(item.id, { feeLabel: e.target.value })}
                                  disabled={decidingId === item.id}
                                />
                                <input
                                  className="input w-32 text-[11px]"
                                  placeholder="改期备注（随订单留档）"
                                  maxLength={500}
                                  value={executionOf(item.id).note}
                                  onChange={(e) => patchExecution(item.id, { note: e.target.value })}
                                  disabled={decidingId === item.id}
                                />
                              </div>
                              <div className="text-[11px] text-amber-700">
                                改期费计入应收（留空 = 不收费）；将撤销套餐立减并按售后改期推状态。
                              </div>
                            </div>
                          )}
                        </div>
                      )}
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
                      {rowRejectErrorById[item.id] && (
                        <div className="mt-1 rounded bg-rose-50 px-1.5 py-1 text-[11px] text-rose-700">
                          上次驳回失败：{rowRejectErrorById[item.id]}
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
