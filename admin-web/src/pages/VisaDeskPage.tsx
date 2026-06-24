/**
 * 签证台 · ADMIN/STAFF — 签证履约任务批量状态流转（批量标"已送签"）
 *
 * 数据源：backend/src/modules/fulfillment/*
 *   GET  /fulfillment-tasks?type=VISA_APPLICATION&status=   任务列表（含 passengers[]）
 *   POST /fulfillment-tasks/batch-status                    批量改状态（部分失败返回 failures）
 *   GET  /orders/:id/passport-photos.zip                   下载护照包（送签用）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type FulfillmentStatus,
  type FulfillmentTask,
  type VisaTaskPassenger,
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

// 状态徽章映射到 Console badge-* 体系（克制配色，仅状态用色）
const VISA_STATUS_BADGE: Record<FulfillmentStatus, string> = {
  PENDING: 'badge-neutral',
  IN_PROGRESS: 'badge-info',
  CONFIRMED: 'badge-success',
  CANCELLED: 'badge-neutral',
  FAILED: 'badge-danger',
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

// ── 乘客行：名称 / 护照号 / 照片缩略图 ─────────────────────────────────────
interface PassengerRowProps {
  passenger: VisaTaskPassenger;
}
function PassengerRow({ passenger }: PassengerRowProps) {
  const [enlarged, setEnlarged] = useState(false);

  return (
    <div className="flex items-center gap-3 py-1 text-xs">
      {/* 护照照片区 */}
      <div className="w-8 shrink-0">
        {passenger.passportPhotoUrl ? (
          <>
            <button
              type="button"
              onClick={() => setEnlarged(true)}
              title="点击查看大图"
              className="block h-8 w-8 overflow-hidden rounded border border-slate-200 hover:opacity-80 transition-opacity"
            >
              <img
                src={passenger.passportPhotoUrl}
                alt={`${passenger.fullName} 护照`}
                className="h-full w-full object-cover"
              />
            </button>
            {enlarged && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
                onClick={() => setEnlarged(false)}
              >
                <div className="relative max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
                  <img
                    src={passenger.passportPhotoUrl}
                    alt={`${passenger.fullName} 护照`}
                    className="max-h-[85vh] max-w-[85vw] rounded-lg shadow-2xl"
                  />
                  <div className="mt-2 flex justify-center gap-3">
                    <a
                      href={passenger.passportPhotoUrl}
                      download={`passport-${passenger.documentNumber}.jpg`}
                      className="btn-secondary text-xs py-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      下载此照片
                    </a>
                    <button
                      type="button"
                      className="btn-ghost text-xs py-1"
                      onClick={() => setEnlarged(false)}
                    >
                      关闭
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded border border-rose-200 bg-rose-50 text-[9px] font-semibold text-rose-600">
            缺
          </div>
        )}
      </div>

      {/* 姓名 / 护照号 */}
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink truncate">{passenger.fullName || '—'}</div>
        <div className="font-mono text-ink-muted truncate">{passenger.documentNumber || '—'}</div>
      </div>

      {/* 缺护照标记 */}
      {!passenger.hasPhoto && (
        <span className="badge-danger shrink-0 text-[10px]">缺护照</span>
      )}
    </div>
  );
}

// ── 可展开的任务行 ────────────────────────────────────────────────────────────
interface TaskRowProps {
  task: FulfillmentTask;
  selected: boolean;
  onToggle: () => void;
  token: string;
}
function TaskRow({ task, selected, onToggle, token }: TaskRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const passengers = task.passengers ?? [];
  const missingCount = passengers.filter((p) => !p.hasPhoto).length;
  const orderId = task.item.orderId;

  const handleDownloadZip = async () => {
    if (!orderId) return;
    setDownloading(true);
    try {
      const blob = await api.downloadPassportsZip(token, orderId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `passports-${task.order?.orderNumber ?? orderId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `下载失败：${e.message}` : '下载失败，请重试');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <tr className={selected ? 'bg-brand-50/70' : ''}>
        <td className="text-center">
          <input
            type="checkbox"
            aria-label={`选择订单 ${task.order?.orderNumber ?? task.id}`}
            checked={selected}
            onChange={onToggle}
          />
        </td>
        <td className="font-mono text-xs text-ink">
          {task.order?.orderNumber ?? '—'}
        </td>
        <td className="text-right nums">{task.item.quantity}</td>
        <td className="text-xs text-ink-muted">
          <div className="max-w-xs truncate" title={task.order?.notes ?? undefined}>
            {task.order?.notes ?? '—'}
          </div>
        </td>
        <td className="text-center">
          <span className={VISA_STATUS_BADGE[task.status]}>
            {VISA_STATUS_LABEL[task.status]}
          </span>
        </td>
        <td className="text-center">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="btn-ghost py-0.5 px-2 text-xs"
            title={expanded ? '收起乘客信息' : '查看乘客 / 护照'}
          >
            {expanded ? '收起' : `乘客${passengers.length > 0 ? `(${passengers.length})` : ''}`}
            {missingCount > 0 && (
              <span className="badge-danger ml-1 text-[10px]">缺 {missingCount}</span>
            )}
          </button>
        </td>
      </tr>

      {expanded && (
        <tr className="bg-slate-50">
          <td colSpan={6} className="px-4 pb-3 pt-2">
            {passengers.length === 0 ? (
              <p className="text-xs text-ink-muted">无乘客数据</p>
            ) : (
              <div className="max-w-lg divide-y divide-slate-100">
                {passengers.map((p) => (
                  <PassengerRow key={p.id} passenger={p} />
                ))}
              </div>
            )}

            {passengers.length > 0 && (
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  className="btn-secondary text-xs py-1.5"
                  onClick={() => void handleDownloadZip()}
                  disabled={downloading}
                >
                  {downloading ? '打包中…' : '下载护照(送签)'}
                </button>
                {missingCount > 0 && (
                  <span className="text-xs text-rose-600">
                    注意：{missingCount} 名乘客缺少护照照片
                  </span>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── 主页面 ────────────────────────────────────────────────────────────────────
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
          <h1 className="page-title">签证台</h1>
          <p className="page-sub">
            签证履约任务批量流转：勾选订单后一键标记
            <span className="badge-info mx-1">已送签材料准备</span>
            或
            <span className="badge-success mx-1">已送签</span>
            。点击"乘客"可展开护照信息及下载按钮。
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
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* ── 批量操作工具条 ───────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <section className="card border-brand-200 bg-brand-50/60">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-ink">
              已选 <span className="text-brand">{selectedIds.size}</span> 条签证任务
            </span>
            <span className="text-slate-300">|</span>
            <label className="text-sm text-ink-soft">批量标记为：</label>
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
              className="btn-primary py-1.5"
              onClick={() => void applyBatch()}
              disabled={submitting}
            >
              {submitting ? '处理中…' : '执行'}
            </button>
            <button
              className="btn-ghost py-1.5"
              onClick={clearSelection}
              disabled={submitting}
            >
              清除选择
            </button>
          </div>
          {batchResult && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
              <div className="text-ink-soft">
                成功 {batchResult.successCount} 条
                {batchResult.failureCount > 0 && (
                  <span className="ml-3 text-rose-600">失败 {batchResult.failureCount} 条</span>
                )}
              </div>
              {batchResult.failures.length > 0 && (
                <ul className="mt-1 max-h-32 overflow-auto text-rose-600">
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
          <table className="table-admin">
            <thead>
              <tr>
                <th className="w-10 text-center">
                  <input
                    type="checkbox"
                    aria-label="全选当前列表"
                    checked={allVisibleSelected}
                    ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                    onChange={toggleAllVisible}
                  />
                </th>
                <th>订单号</th>
                <th className="text-right">乘客数</th>
                <th>备注</th>
                <th className="text-center">当前状态</th>
                <th className="text-center">护照信息</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-ink-muted">加载签证任务…</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-ink-muted">
                    该筛选条件下暂无签证任务
                  </td>
                </tr>
              ) : (
                filtered.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    selected={selectedIds.has(task.id)}
                    onToggle={() => toggleRow(task.id)}
                    token={token}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
