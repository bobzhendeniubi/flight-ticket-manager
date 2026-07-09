/**
 * 工单看板 · ADMIN/STAFF
 *
 * 数据源：backend /fulfillment-tasks/*（现有端点，无新增）
 * - 四列看板：待处理 / 进行中 / 已确认 / 失败，列内按出发时间升序（null 最后）
 * - SLA 标记：未完成且距出发 ≤48h 红 / ≤72h 琥珀 / 已过出发 红
 * - 勾选卡片 → 底部批量操作条 → batch-status（部分失败展示 failures）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type BatchFulfillmentStatusResult,
  type FulfillmentStatus,
  type FulfillmentTask,
  type FulfillmentType,
} from '../lib/api';
import { useAuth } from '../stores/auth';

const PAGE_SIZE = 200;
const HOUR_MS = 60 * 60 * 1000;
const SLA_RED_HOURS = 48;
const SLA_AMBER_HOURS = 72;

const TYPE_META: Record<FulfillmentType, { label: string; badge: string }> = {
  FLIGHT_TICKETING: { label: '出票', badge: 'badge-info' },
  HOTEL_BOOKING: { label: '酒店确认', badge: 'badge-success' },
  VISA_APPLICATION: { label: '签证送签', badge: 'badge-warning' },
  TRANSFER_DISPATCH: { label: '接送安排', badge: 'badge-neutral' },
  BUNDLE_COMPOSITE: { label: '套餐', badge: 'badge bg-brand text-white' },
};

const TYPE_ORDER: FulfillmentType[] = [
  'FLIGHT_TICKETING',
  'HOTEL_BOOKING',
  'VISA_APPLICATION',
  'TRANSFER_DISPATCH',
  'BUNDLE_COMPOSITE',
];

const COLUMNS: Array<{ status: FulfillmentStatus; label: string }> = [
  { status: 'PENDING', label: '待处理' },
  { status: 'IN_PROGRESS', label: '进行中' },
  { status: 'CONFIRMED', label: '已确认' },
  { status: 'FAILED', label: '失败' },
];

const BATCH_TARGETS: Array<{ value: FulfillmentStatus; label: string }> = [
  { value: 'IN_PROGRESS', label: '开始处理' },
  { value: 'CONFIRMED', label: '确认完成' },
  { value: 'FAILED', label: '标记失败' },
];

type TypeFilter = '' | FulfillmentType;

/** 出发时间按出发机场时区显示 MM-DD HH:mm；无航班 → — */
function fmtDeparture(iso: string | null | undefined, tz: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz ?? undefined,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(iso));
    const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return iso.slice(5, 16).replace('T', ' ');
  }
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type SlaLevel = 'overdue' | 'red48' | 'amber72' | null;

/** 未完成（PENDING/IN_PROGRESS）任务的 SLA 等级 */
function slaLevel(task: FulfillmentTask, nowMs: number): SlaLevel {
  if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS') return null;
  const dep = task.order?.departureTime;
  if (!dep) return null;
  const depMs = new Date(dep).getTime();
  if (!Number.isFinite(depMs)) return null;
  const diff = depMs - nowMs;
  if (diff < 0) return 'overdue';
  if (diff <= SLA_RED_HOURS * HOUR_MS) return 'red48';
  if (diff <= SLA_AMBER_HOURS * HOUR_MS) return 'amber72';
  return null;
}

export function FulfillmentBoardPage() {
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);
  const token = tokens?.accessToken ?? '';

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('');
  const [mineOnly, setMineOnly] = useState(false);

  const [tasks, setTasks] = useState<FulfillmentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchTarget, setBatchTarget] = useState<FulfillmentStatus>('IN_PROGRESS');
  const [batchResult, setBatchResult] = useState<BatchFulfillmentStatusResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setBatchResult(null);
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listFulfillmentTasks(token, {
        pageSize: PAGE_SIZE,
        type: typeFilter || undefined,
        assigneeUserId: mineOnly ? (user?.id ?? undefined) : undefined,
      })
      .then((res) => {
        if (cancelled) return;
        setTasks(res.tasks);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : '加载工单失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, typeFilter, mineOnly, user?.id, refreshNonce]);

  const nowMs = Date.now();

  // 各列（列内按出发时间升序，null 最后）
  const columns = useMemo(() => {
    const byDeparture = (a: FulfillmentTask, b: FulfillmentTask): number => {
      const ta = a.order?.departureTime ? new Date(a.order.departureTime).getTime() : Infinity;
      const tb = b.order?.departureTime ? new Date(b.order.departureTime).getTime() : Infinity;
      return ta - tb;
    };
    return COLUMNS.map((col) => ({
      ...col,
      tasks: tasks.filter((t) => t.status === col.status).sort(byDeparture),
    }));
  }, [tasks]);

  // 页头统计（按载入数据计算）
  const stats = useMemo(() => {
    const today = todayYmd();
    const pending = tasks.filter((t) => t.status === 'PENDING').length;
    const inProgress = tasks.filter((t) => t.status === 'IN_PROGRESS').length;
    const urgent48 = tasks.filter((t) => {
      const lvl = slaLevel(t, nowMs);
      return lvl === 'red48' || lvl === 'overdue';
    }).length;
    const confirmedToday = tasks.filter(
      (t) => t.status === 'CONFIRMED' && (t.completedAt ?? t.updatedAt).slice(0, 10) === today,
    ).length;
    return { pending, inProgress, urgent48, confirmedToday };
  }, [tasks, nowMs]);

  const toggleTask = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyBatch = async (): Promise<void> => {
    if (!token || selectedIds.size === 0 || submitting) return;
    const targetLabel = BATCH_TARGETS.find((t) => t.value === batchTarget)?.label ?? batchTarget;
    if (!window.confirm(`将 ${selectedIds.size} 个工单标记为「${targetLabel}」？`)) return;
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
    <div className="space-y-5 pb-24">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">工单看板</h1>
          <p className="page-sub">
            全类型履约工单四列流转（出票 / 酒店确认 / 签证送签 / 接送安排 / 套餐），距出发 72
            小时内未完成的自动标记
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setRefreshNonce((n) => n + 1)}
          disabled={loading}
        >
          {loading ? '刷新中…' : '⟳ 刷新'}
        </button>
      </header>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="stat-card">
          <div className="stat-label">待处理</div>
          <div className="stat-value">{stats.pending}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">48 小时内未完成</div>
          <div className={`stat-value ${stats.urgent48 > 0 ? 'text-rose-700' : ''}`}>
            {stats.urgent48}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">进行中</div>
          <div className="stat-value">{stats.inProgress}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">今日已确认</div>
          <div className="stat-value">{stats.confirmedToday}</div>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setTypeFilter('');
            clearSelection();
          }}
          className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
            typeFilter === ''
              ? 'border-brand bg-brand text-white'
              : 'border-slate-200 bg-white text-ink-soft hover:bg-slate-50'
          }`}
        >
          全部
        </button>
        {TYPE_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTypeFilter(t);
              clearSelection();
            }}
            className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
              typeFilter === t
                ? 'border-brand bg-brand text-white'
                : 'border-slate-200 bg-white text-ink-soft hover:bg-slate-50'
            }`}
          >
            {TYPE_META[t].label}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={mineOnly}
            onChange={(e) => {
              setMineOnly(e.target.checked);
              clearSelection();
            }}
          />
          只看指派给我的
        </label>
      </section>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">
          {error}
        </div>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {columns.map((col) => (
          <div key={col.status} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold text-ink">{col.label}</h2>
              <span className="badge-neutral nums">{col.tasks.length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {loading && (
                <div className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-xs text-ink-muted">
                  加载中…
                </div>
              )}
              {!loading && col.tasks.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-xs text-ink-muted">
                  空
                </div>
              )}
              {!loading &&
                col.tasks.map((task) => {
                  const lvl = slaLevel(task, nowMs);
                  const borderClass =
                    lvl === 'red48' || lvl === 'overdue'
                      ? 'border-red-300'
                      : lvl === 'amber72'
                        ? 'border-amber-300'
                        : 'border-slate-200';
                  const meta = TYPE_META[task.type];
                  return (
                    <div
                      key={task.id}
                      className={`rounded-xl border ${borderClass} bg-surface p-3 shadow-card`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={meta.badge}>{meta.label}</span>
                          {lvl === 'overdue' && <span className="badge-danger">已过出发</span>}
                          {lvl === 'red48' && <span className="badge-danger">⏰ ≤48h</span>}
                          {lvl === 'amber72' && <span className="badge-warning">⏰ ≤72h</span>}
                        </div>
                        <input
                          type="checkbox"
                          className="mt-0.5 shrink-0"
                          checked={selectedIds.has(task.id)}
                          onChange={() => toggleTask(task.id)}
                          aria-label="选择工单"
                        />
                      </div>
                      <div className="nums mt-2 text-sm font-medium text-ink">
                        {task.order?.orderNumber ?? '—'}
                      </div>
                      <div className="nums mt-0.5 text-xs text-ink-soft">
                        出发 {fmtDeparture(task.order?.departureTime, task.order?.departureTz)}
                      </div>
                      {task.notes && (
                        <div className="mt-1 truncate text-xs text-ink-muted" title={task.notes}>
                          {task.notes}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </section>

      {batchResult && (
        <section
          className={`rounded-lg border px-4 py-2.5 text-sm ${
            batchResult.failureCount === 0
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          <div className="flex items-center justify-between">
            <span>
              批量更新完成：成功 {batchResult.successCount} 条
              {batchResult.failureCount > 0 && `，失败 ${batchResult.failureCount} 条`}
            </span>
            <button
              type="button"
              className="text-xs hover:underline"
              onClick={() => setBatchResult(null)}
            >
              关闭
            </button>
          </div>
          {batchResult.failures.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-xs">
              {batchResult.failures.map((f) => (
                <li key={f.id}>
                  <span className="nums">{f.id.slice(0, 8)}…</span>：{f.error}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-surface/95 px-4 py-3 backdrop-blur lg:pl-[248px]">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-ink">
              已选 <span className="nums">{selectedIds.size}</span> 项
            </span>
            <select
              className="input w-auto py-1.5"
              value={batchTarget}
              onChange={(e) => setBatchTarget(e.target.value as FulfillmentStatus)}
            >
              {BATCH_TARGETS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-primary py-1.5"
              disabled={submitting}
              onClick={() => void applyBatch()}
            >
              {submitting ? '应用中…' : '应用'}
            </button>
            <button type="button" className="btn-ghost py-1.5" onClick={clearSelection}>
              取消选择
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
