/**
 * 提醒中心 · ADMIN/STAFF
 *
 * 数据源：backend /reminders/*
 * - 「生成今日提醒」→ POST /reminders/generate（按规则批量生成，幂等跳过已存在）
 * - 列表支持 状态/优先级/来源(auto|manual)/只看我认领的 筛选 + 分页
 * - 行操作：认领 / 完成 / 跳过（填原因）/ 释放
 */
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type OperationalReminder,
  type ReminderPriority,
  type ReminderStatus,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';

const PAGE_SIZE = 20;

const STATUS_LABEL: Record<ReminderStatus, string> = {
  OPEN: '待处理',
  IN_PROGRESS: '进行中',
  DONE: '已完成',
  SKIPPED: '已跳过',
};

const STATUS_BADGE: Record<ReminderStatus, string> = {
  OPEN: 'badge-warning',
  IN_PROGRESS: 'badge-info',
  DONE: 'badge-success',
  SKIPPED: 'badge-neutral',
};

const PRIORITY_LABEL: Record<ReminderPriority, string> = {
  CRITICAL: '紧急',
  HIGH: '高',
  NORMAL: '普通',
  LOW: '低',
};

const PRIORITY_BADGE: Record<ReminderPriority, string> = {
  CRITICAL: 'badge-danger',
  HIGH: 'badge-warning',
  NORMAL: 'badge-info',
  LOW: 'badge-neutral',
};

/** 自动生成规则键 → 中文（未知键原样显示） */
const RULE_LABEL: Record<string, string> = {
  BALANCE_DUE: '催尾款',
  DEPARTURE_SOON: '出行提醒',
  PASSPORT_EXPIRY: '护照有效期',
  VISA_MISSING: '签证缺件',
};

function ruleLabel(key: string): string {
  return RULE_LABEL[key] ?? key;
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** dueAt 是 @db.Date 序列化的完整 ISO 串 —— 显示/比较只取日期部分 */
function ymd(iso: string): string {
  return iso.slice(0, 10);
}

function personLabel(p: { displayName: string | null; email: string | null } | null): string {
  if (!p) return '—';
  return p.displayName ?? p.email ?? '—';
}

type StatusFilter = '' | ReminderStatus;
type PriorityFilter = '' | ReminderPriority;
type SourceFilter = '' | 'auto' | 'manual';

interface GenerateResult {
  created: number;
  skipped: number;
  byRule: Record<string, number>;
}

export function RemindersPage() {
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);
  const token = tokens?.accessToken ?? '';

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('');
  const [mineOnly, setMineOnly] = useState(false);
  const [page, setPage] = useState(1);

  const [reminders, setReminders] = useState<OperationalReminder[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<GenerateResult | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  // 行操作进行中的提醒 id（防重复点击）
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listReminders(token, {
        status: statusFilter || undefined,
        priority: priorityFilter || undefined,
        source: sourceFilter || undefined,
        mine: mineOnly || undefined,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((res) => {
        if (cancelled) return;
        setReminders(res.reminders);
        setTotal(res.pagination.total);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : '加载提醒失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, statusFilter, priorityFilter, sourceFilter, mineOnly, page, refreshNonce]);

  const refresh = () => setRefreshNonce((n) => n + 1);

  // 统计卡：由当前载入数据计算
  const stats = useMemo(() => {
    const today = todayYmd();
    return {
      open: reminders.filter((r) => r.status === 'OPEN').length,
      inProgress: reminders.filter((r) => r.status === 'IN_PROGRESS').length,
      createdToday: reminders.filter((r) => ymd(r.createdAt) === today).length,
      critical: reminders.filter(
        (r) => r.priority === 'CRITICAL' && (r.status === 'OPEN' || r.status === 'IN_PROGRESS'),
      ).length,
    };
  }, [reminders]);

  async function onGenerate(): Promise<void> {
    if (!token || generating) return;
    setGenerating(true);
    setGenResult(null);
    setGenError(null);
    try {
      const res = await api.generateReminders(token);
      setGenResult(res);
      setPage(1);
      refresh();
    } catch (e: unknown) {
      setGenError(e instanceof ApiError ? e.message : '生成提醒失败');
    } finally {
      setGenerating(false);
    }
  }

  async function runAction(id: string, action: () => Promise<unknown>): Promise<void> {
    if (busyId) return;
    setBusyId(id);
    try {
      await action();
      refresh();
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `操作失败：${e.message}` : '操作失败');
    } finally {
      setBusyId(null);
    }
  }

  const onClaim = (r: OperationalReminder) =>
    runAction(r.id, () => api.claimReminder(token, r.id));
  const onDone = (r: OperationalReminder) =>
    runAction(r.id, () => api.resolveReminder(token, r.id, { status: 'DONE' }));
  const onSkip = (r: OperationalReminder) => {
    const reason = window.prompt('跳过原因（必填）：');
    if (reason === null) return; // 取消
    const trimmed = reason.trim();
    if (!trimmed) {
      alert('请填写跳过原因');
      return;
    }
    void runAction(r.id, () =>
      api.resolveReminder(token, r.id, { status: 'SKIPPED', resolvedNote: trimmed }),
    );
  };
  const onRelease = (r: OperationalReminder) =>
    runAction(r.id, () => api.releaseReminder(token, r.id));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const today = todayYmd();

  const genSummary = useMemo(() => {
    if (!genResult) return null;
    const parts = Object.entries(genResult.byRule)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${ruleLabel(k)} ${n}`)
      .join(' · ');
    return `新增 ${genResult.created} 条提醒${parts ? `（${parts}）` : ''}，跳过 ${genResult.skipped} 条已存在`;
  }, [genResult]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">提醒中心</h1>
          <p className="page-sub">
            集中处理运营待办：催尾款 / 出行提醒 / 护照有效期 / 签证缺件等自动规则 + 手动提醒
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => void onGenerate()} disabled={generating}>
          {generating ? '生成中…' : <><Icon name="bolt" /> 生成今日提醒</>}
        </button>
      </header>

      {genSummary && (
        <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          <span>{genSummary}</span>
          <button
            type="button"
            className="text-xs text-emerald-700 hover:text-emerald-900"
            onClick={() => setGenResult(null)}
          >
            关闭
          </button>
        </div>
      )}
      {genError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">
          {genError}
        </div>
      )}

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="stat-card">
          <div className="stat-label">待处理</div>
          <div className="stat-value">{stats.open}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">进行中</div>
          <div className="stat-value">{stats.inProgress}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">今日新增</div>
          <div className="stat-value">{stats.createdToday}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">紧急（未完成）</div>
          <div className={`stat-value ${stats.critical > 0 ? 'text-rose-700' : ''}`}>
            {stats.critical}
          </div>
        </div>
      </section>

      <section className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label">状态</label>
          <select
            className="input py-1.5"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as StatusFilter);
              setPage(1);
            }}
          >
            <option value="">全部</option>
            {(Object.keys(STATUS_LABEL) as ReminderStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">优先级</label>
          <select
            className="input py-1.5"
            value={priorityFilter}
            onChange={(e) => {
              setPriorityFilter(e.target.value as PriorityFilter);
              setPage(1);
            }}
          >
            <option value="">全部</option>
            {(['CRITICAL', 'HIGH', 'NORMAL', 'LOW'] as ReminderPriority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">来源</label>
          <select
            className="input py-1.5"
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value as SourceFilter);
              setPage(1);
            }}
          >
            <option value="">全部</option>
            <option value="auto">自动生成</option>
            <option value="manual">手动创建</option>
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={mineOnly}
            onChange={(e) => {
              setMineOnly(e.target.checked);
              setPage(1);
            }}
          />
          只看我认领的
        </label>
      </section>

      <section className="card overflow-x-auto p-0">
        <table className="table-admin">
          <thead>
            <tr>
              <th>优先级</th>
              <th>标题</th>
              <th>关联订单</th>
              <th>内容</th>
              <th>到期日</th>
              <th>认领人</th>
              <th>状态</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="py-8 text-center text-ink-muted">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={8} className="py-8 text-center text-rose-600">
                  {error}
                </td>
              </tr>
            )}
            {!loading && !error && reminders.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8 text-center text-ink-muted">
                  暂无提醒 —— 点右上「生成今日提醒」按规则扫描一遍
                </td>
              </tr>
            )}
            {!loading &&
              !error &&
              reminders.map((r) => {
                const isMine = r.claimedBy?.id === user?.id;
                const isOpenLike = r.status === 'OPEN' || r.status === 'IN_PROGRESS';
                const overdue = isOpenLike && r.dueAt !== null && ymd(r.dueAt) < today;
                const rowBusy = busyId === r.id;
                return (
                  <tr key={r.id}>
                    <td>
                      <span className={PRIORITY_BADGE[r.priority]}>{PRIORITY_LABEL[r.priority]}</span>
                    </td>
                    <td className="max-w-[240px]">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium text-ink" title={r.title}>
                          {r.title}
                        </span>
                        {r.ruleKey && <span className="badge-neutral shrink-0">自动</span>}
                      </div>
                    </td>
                    <td className="nums">{r.order?.orderNumber ?? '—'}</td>
                    <td className="max-w-[280px]">
                      <span className="block truncate" title={r.body ?? undefined}>
                        {r.body ?? '—'}
                      </span>
                    </td>
                    <td className={`nums ${overdue ? 'font-semibold text-rose-600' : ''}`}>
                      {r.dueAt ? ymd(r.dueAt) : '—'}
                      {overdue && <span className="ml-1 text-xs">逾期</span>}
                    </td>
                    <td>{personLabel(r.claimedBy)}</td>
                    <td>
                      <span className={STATUS_BADGE[r.status]}>{STATUS_LABEL[r.status]}</span>
                    </td>
                    <td>
                      <div className="flex justify-end gap-1.5">
                        {isOpenLike && !r.claimedBy && (
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            disabled={rowBusy}
                            onClick={() => void onClaim(r)}
                          >
                            认领
                          </button>
                        )}
                        {isOpenLike && isMine && (
                          <>
                            <button
                              type="button"
                              className="btn-primary px-2.5 py-1 text-xs"
                              disabled={rowBusy}
                              onClick={() => void onDone(r)}
                            >
                              完成
                            </button>
                            <button
                              type="button"
                              className="btn-secondary px-2.5 py-1 text-xs"
                              disabled={rowBusy}
                              onClick={() => onSkip(r)}
                            >
                              跳过
                            </button>
                            <button
                              type="button"
                              className="btn-ghost px-2.5 py-1 text-xs"
                              disabled={rowBusy}
                              onClick={() => void onRelease(r)}
                            >
                              释放
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </section>

      <footer className="flex items-center justify-between text-sm text-ink-soft">
        <span>
          共 <span className="nums">{total}</span> 条 · 第 {page} / {totalPages} 页
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-xs"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            上一页
          </button>
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-xs"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            下一页
          </button>
        </div>
      </footer>
    </div>
  );
}
