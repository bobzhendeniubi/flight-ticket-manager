/**
 * 签证台 · ADMIN/STAFF — 签证履约任务批量状态流转（批量标"已送签"）
 *
 * 数据源：backend/src/modules/fulfillment/*
 *   GET  /fulfillment-tasks?type=VISA_APPLICATION&status=   任务列表
 *   POST /fulfillment-tasks/batch-status                    批量改状态（部分失败返回 failures）
 *
 * 口径：IN_PROGRESS = 已送签材料准备；CONFIRMED = 已送签。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type FulfillmentStatus,
  type FulfillmentTask,
} from '../lib/api';
import { useAuth } from '../stores/auth';

// 签证语境的状态文案（IN_PROGRESS/CONFIRMED 与批量操作下拉一致）
const VISA_STATUS_LABEL: Record<FulfillmentStatus, string> = {
  PENDING: '待处理',
  IN_PROGRESS: '已送签材料准备',
  CONFIRMED: '已送签',
  CANCELLED: '已取消',
  FAILED: '失败',
};

const VISA_STATUS_COLOR: Record<FulfillmentStatus, string> = {
  PENDING: 'bg-slate-100 text-slate-600',
  IN_PROGRESS: 'bg-blue-100 text-blue-700',
  CONFIRMED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-slate-200 text-slate-500',
  FAILED: 'bg-red-100 text-red-700',
};

// 批量流转的目标状态（签证台只做"材料准备 / 已送签"两档）
const BATCH_TARGETS: Array<{ value: FulfillmentStatus; label: string }> = [
  { value: 'IN_PROGRESS', label: '已送签材料准备' },
  { value: 'CONFIRMED', label: '已送签' },
];

// 后端 batch-status 单次最多 100 条
const BATCH_LIMIT = 100;

// 状态筛选：OPEN = 待处理 + 材料准备（默认）；ALL = 全部
type StatusFilter = 'OPEN' | 'ALL' | FulfillmentStatus;

const FILTER_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'OPEN', label: '待处理 + 材料准备（默认）' },
  { value: 'PENDING', label: '仅待处理' },
  { value: 'IN_PROGRESS', label: '仅已送签材料准备' },
  { value: 'CONFIRMED', label: '仅已送签' },
  { value: 'CANCELLED', label: '仅已取消' },
  { value: 'FAILED', label: '仅失败' },
  { value: 'ALL', label: '全部状态' },
];

export function VisaDeskPage() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [tasks, setTasks] = useState<FulfillmentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN');

  // ── 批量选择 / 流转状态 ─────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchTarget, setBatchTarget] = useState<FulfillmentStatus>('CONFIRMED');
  const [submitting, setSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState<{
    successCount: number;
    failureCount: number;
    failures: Array<{ id: string; error: string }>;
  } | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // 拉签证任务 — 单状态筛选直接走后端；OPEN/ALL 拉全量后前端过滤
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const backendStatus =
      statusFilter === 'OPEN' || statusFilter === 'ALL' ? undefined : statusFilter;
    api
      .listFulfillmentTasks(token, {
        type: 'VISA_APPLICATION',
        status: backendStatus,
        pageSize: 200,
      })
      .then((res) => {
        if (cancelled) return;
        setTasks(res.tasks);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '签证任务加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, statusFilter, refreshNonce]);

  const filtered = useMemo(() => {
    if (statusFilter === 'OPEN') {
      return tasks.filter((t) => t.status === 'PENDING' || t.status === 'IN_PROGRESS');
    }
    return tasks;
  }, [tasks, statusFilter]);

  // ── 勾选 helpers（镜像 OrdersPage 批量管理）────────────────
  const visibleIds = useMemo(() => filtered.map((t) => t.id), [filtered]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = !allVisibleSelected && visibleIds.some((id) => selectedIds.has(id));

  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setBatchResult(null);
  }, []);

  const applyBatch = async () => {
    if (!token || selectedIds.size === 0) return;
    if (selectedIds.size > BATCH_LIMIT) {
      alert(`单次最多批量处理 ${BATCH_LIMIT} 条，请分批操作（当前已选 ${selectedIds.size} 条）`);
      return;
    }
    const targetLabel = VISA_STATUS_LABEL[batchTarget];
    if (!window.confirm(`将 ${selectedIds.size} 条签证任务标记为「${targetLabel}」？`)) return;
    setSubmitting(true);
    setBatchResult(null);
    try {
      const res = await api.batchUpdateFulfillmentStatus(token, Array.from(selectedIds), batchTarget);
      setBatchResult(res);
      if (res.failureCount === 0) setSelectedIds(new Set());
      setRefreshNonce((n) => n + 1);
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `批量操作失败：${e.message}` : '批量操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">签证台</h1>
          <p className="mt-1 text-sm text-slate-600">
            签证履约任务批量流转：勾选订单后一键标记
            <span className="mx-1 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">已送签材料准备</span>
            或
            <span className="mx-1 rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700">已送签</span>
            。
          </p>
        </div>
        <div>
          <label className="label">状态筛选</label>
          <select
            className="input max-w-[16rem] py-1.5"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as StatusFilter);
              clearSelection();
            }}
          >
            {FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </section>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          ❌ {error}
        </div>
      )}

      {/* ── 批量操作工具条 ───────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <section className="card border-2 border-brand bg-brand/5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-slate-900">
              已选 <span className="text-brand">{selectedIds.size}</span> 条签证任务
            </span>
            <span className="text-slate-300">|</span>
            <label className="text-sm text-slate-600">批量标记为：</label>
            <select
              className="input max-w-[12rem] py-1.5"
              value={batchTarget}
              onChange={(e) => setBatchTarget(e.target.value as FulfillmentStatus)}
              disabled={submitting}
            >
              {BATCH_TARGETS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <button
              className="btn-primary text-sm py-1.5 disabled:opacity-50"
              onClick={() => void applyBatch()}
              disabled={submitting}
            >
              {submitting ? '处理中…' : '执行'}
            </button>
            <button
              className="text-sm text-slate-600 hover:text-slate-900"
              onClick={clearSelection}
              disabled={submitting}
            >
              清除选择
            </button>
          </div>
          {batchResult && (
            <div className="mt-3 rounded-md bg-white px-3 py-2 text-xs">
              <div className="text-slate-700">
                ✓ 成功 {batchResult.successCount} 条
                {batchResult.failureCount > 0 && (
                  <span className="ml-3 text-red-600">✗ 失败 {batchResult.failureCount} 条</span>
                )}
              </div>
              {batchResult.failures.length > 0 && (
                <ul className="mt-1 max-h-32 overflow-auto text-red-600">
                  {batchResult.failures.map((f) => (
                    <li key={f.id} className="font-mono text-[11px]">· {f.id.slice(0, 8)}…：{f.error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── 任务列表 ─────────────────────────────────────────── */}
      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3 text-center w-10">
                  <input
                    type="checkbox"
                    aria-label="全选当前列表"
                    checked={allVisibleSelected}
                    ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                    onChange={toggleAllVisible}
                  />
                </th>
                <th className="px-4 py-3 text-left">订单号</th>
                <th className="px-4 py-3 text-right">乘客数</th>
                <th className="px-4 py-3 text-left">备注</th>
                <th className="px-4 py-3 text-center">当前状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">加载签证任务…</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                    该筛选条件下暂无签证任务
                  </td>
                </tr>
              ) : (
                filtered.map((task) => (
                  <tr
                    key={task.id}
                    className={`hover:bg-slate-50 ${selectedIds.has(task.id) ? 'bg-brand/5' : ''}`}
                  >
                    <td className="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        aria-label={`选择订单 ${task.order?.orderNumber ?? task.id}`}
                        checked={selectedIds.has(task.id)}
                        onChange={() => toggleRow(task.id)}
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">
                      {task.order?.orderNumber ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{task.item.quantity}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      <div className="max-w-xs truncate" title={task.order?.notes ?? undefined}>
                        {task.order?.notes ?? '—'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${VISA_STATUS_COLOR[task.status]}`}>
                        {VISA_STATUS_LABEL[task.status]}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
