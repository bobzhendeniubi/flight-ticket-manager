/**
 * 提醒中心 · ADMIN/STAFF
 *
 * 数据源：backend /reminders/*
 * - 「生成今日提醒」→ POST /reminders/generate（按规则批量生成，幂等跳过已存在）
 * - 列表支持 状态/优先级/来源(auto|manual)/只看我认领的 筛选 + 分页
 * - 行操作：认领 / 完成 / 跳过（填原因）/ 释放
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  type OperationalReminder,
  type ReminderPriority,
  type ReminderStatus,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';
import { TRAVELER_PROFILE_LINK_TITLE, travelerProfileLinkProps } from '../lib/travelerProfileLink';

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
  HOLD_INSTALLMENT_DUE: '占位单催款',
  TICKET_MISSING: '临近出发未出票',
  VISA_NOT_SUBMITTED: '临近出发未送签',
  ROOM_UNASSIGNED: '临近入住未分房',
  ROOM_PARTIALLY_UNASSIGNED: '临近入住部分未分房',
  RECEIPT_UNVERIFIED: '到账待核实',
  RANDOM_TIER_SHORTFALL: '随机档缺口需加房',
  NO_SHOW_RETURN_RELEASED: '回程已释放待跟进',
  UPGRADE_REDEEM_PENDING: '次数升级待核销',
  TRIP_BALANCE_NEGATIVE: '可用次数为负',
};

function ruleLabel(key: string): string {
  return RULE_LABEL[key] ?? key;
}

/**
 * 「次数升级待核销」的档案直达链接。
 *
 * 档案 id 以前放在 ruleKey 末段，但档案会因「先没档案后建档」「档案连续合并」变来变去，
 * 键里带着它等于同一件事随时换身份（旧条永久挂在待办列表）。现在 ruleKey 只放稳定的
 * 「乘客 + 航段」，列表接口按乘客证件号现算出**当前**主档案 id，随行返回 redeemProfileId
 * （见 backend reminders.routes.ts）。查不到档案时为 null —— 那种提醒照常显示，只是没有
 * 直达链接，正文里写了怎么先建档。
 */
function upgradeRedeemProfileId(reminder: OperationalReminder): string | null {
  // redeemProfileId 是列表接口的派生字段（不在 OperationalReminder 的公共类型里）
  const profileId = (reminder as { redeemProfileId?: string | null }).redeemProfileId;
  return profileId?.trim() ? profileId : null;
}

/**
 * 「可用次数为负」的档案直达链接：ruleKey 固定形如 `TRIPNEG:{profileId}`（不随改名/改档变化，
 * 直接取末段即可，不用像升级待核销那样现算）。格式不对就当没有，不强行拼一个假链接。
 */
function tripBalanceNegativeProfileId(reminder: OperationalReminder): string | null {
  const key = reminder.ruleKey?.trim();
  if (!key?.startsWith('TRIPNEG:')) return null;
  const profileId = key.slice('TRIPNEG:'.length).trim();
  return profileId || null;
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
                const redeemProfileId = upgradeRedeemProfileId(r);
                // 「可用次数为负」也带档案直达，但不是「去核销」——只有升级待核销才是要去扣一次；
                // 可用为负多半是退改把已飞次数拉回来了，链接是给运营去看一眼，不是去操作。
                const balanceProfileId = redeemProfileId ? null : tripBalanceNegativeProfileId(r);
                const directProfileId = redeemProfileId ?? balanceProfileId;
                // 当前单号带过去：档案页打开后自动展开核销表单并预选这张单（只对「去核销」有意义，
                // 「去看档案」场景同样带上无妨，档案页自己判断要不要用）。
                const directLink = directProfileId
                  ? travelerProfileLinkProps({ profileId: directProfileId, orderId: r.order?.id })
                  : null;
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
                        {directLink && (
                          <Link
                            to={directLink.to}
                            className="shrink-0 text-xs text-brand-700 underline decoration-dotted"
                            title={
                              redeemProfileId
                                ? `去常旅客档案「核销权益」扣一次 · ${TRAVELER_PROFILE_LINK_TITLE}`
                                : `去常旅客档案看可用次数为负的原因 · ${TRAVELER_PROFILE_LINK_TITLE}`
                            }
                          >
                            {redeemProfileId ? '去核销' : '去看档案'}
                          </Link>
                        )}
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
