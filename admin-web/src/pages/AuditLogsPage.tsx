/**
 * 审计日志 — 运营治理核心
 * 记录所有敏感操作：谁什么时候在哪个 IP 改了什么
 *
 * 展示层用 lib/auditFormat 把后端的 SCREAMING_SNAKE action 和 JSON payload
 * 翻译成中文。新增 action / 字段在 auditFormat.ts 加一行即可。
 */
import { useEffect, useMemo, useState } from 'react';
import { exportToCSV } from '../lib/csvExport';
import { api, ApiError, type AuditLog } from '../lib/api';
import { useAuth } from '../stores/auth';
import { formatAction, formatPayloadDiff, summarizePayload, type DiffLine } from '../lib/auditFormat';
import { formatDateTimeSecCn, formatInBusinessTz } from '../lib/datetime';
import { Icon, type IconName } from '../components/Icon';
import { useDialogA11y } from '../components/Modal';

type Severity = AuditLog['severity'];
type TargetType = AuditLog['targetType'];

const SEVERITY_COLOR: Record<Severity, string> = {
  INFO: 'badge-neutral',
  WARNING: 'badge-warning',
  CRITICAL: 'badge-danger',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  INFO: '一般',
  WARNING: '警告',
  CRITICAL: '关键',
};

const TARGET_ICON: Record<TargetType, IconName> = {
  AGENT: 'handshake',
  ORDER: 'clipboard',
  FLIGHT: 'plane',
  CUSTOMER: 'user',
  PRICING: 'wallet',
  COMMISSION: 'wallet',
  TRAVELER: 'luggage',
  PRODUCT: 'package',
  AUTH: 'lock',
  SYSTEM: 'settings',
  SETTLEMENT: 'wallet',
};

const TARGET_LABEL: Record<TargetType, string> = {
  AGENT: '代理',
  ORDER: '订单',
  FLIGHT: '航班',
  CUSTOMER: '客户',
  PRICING: '定价',
  COMMISSION: '佣金',
  TRAVELER: '出行人',
  PRODUCT: '产品',
  AUTH: '登录',
  SYSTEM: '系统',
  SETTLEMENT: '结算',
};

interface AuditView {
  id: string;
  timestamp: string;
  actorUserId: string | null;
  actor: string;
  actorRole: string;
  ip: string;
  rawAction: string;
  actionLabel: string;
  actionIcon: IconName;
  targetType: TargetType;
  targetLabel: string;
  diffLines: DiffLine[];
  diffSummary: string;
  severity: Severity;
  before: unknown;
  after: unknown;
}

function toView(l: AuditLog): AuditView {
  const a = formatAction(l.action);
  return {
    id: l.id,
    timestamp: l.createdAt,
    actorUserId: l.actorUserId,
    actor: l.actorLabel ?? 'system',
    actorRole: l.actorRole ?? 'SYSTEM',
    ip: l.ipAddress ?? 'system',
    rawAction: l.action,
    actionLabel: a.label,
    actionIcon: a.icon,
    targetType: l.targetType,
    targetLabel: l.targetLabel ?? l.targetId ?? '—',
    diffLines: formatPayloadDiff(l.before, l.after, l.action),
    diffSummary: summarizePayload(l.action, l.before, l.after),
    severity: l.severity,
    before: l.before,
    after: l.after,
  };
}

// F-22：日期区间用浏览器本地日期（与仓库里 FinancesPage.tsx 的 todayStr/daysAgoStr
// 同一写法），仅用于 <input type="date"> 默认值，不涉及业务时区换算。
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const DEFAULT_WINDOW_DAYS = 90;
const PAGE_SIZE = 200;

export function AuditLogsPage() {
  const tokens = useAuth((s) => s.tokens);
  const [logs, setLogs] = useState<AuditView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // F-22：actorFilter 存 actorUserId（后端按 id 过滤），下拉候选见 actorOptions。
  const [actorFilter, setActorFilter] = useState('');
  const [targetFilter, setTargetFilter] = useState<'' | TargetType>('');
  const [severityFilter, setSeverityFilter] = useState<'' | Severity>('');
  // 到账日期区间默认「最近 90 天」，与下方 KPI 的「最近 90 天」文案对齐（可调窄/调宽）。
  const [from, setFrom] = useState(daysAgoStr(DEFAULT_WINDOW_DAYS - 1));
  const [to, setTo] = useState(todayStr());
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: PAGE_SIZE, total: 0 });
  // 见过的操作人集合，跨页/跨筛选累积（不是全量用户名单，只是「本次会话里见过的」）。
  const [actorOptions, setActorOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [selected, setSelected] = useState<AuditView | null>(null);
  const dialogRef = useDialogA11y(() => setSelected(null), selected !== null);

  // 筛选条件（不含 page 本身）变化时回到第 1 页，避免「翻到第 5 页后换筛选，结果是空的」。
  useEffect(() => {
    setPage(1);
  }, [search, actorFilter, targetFilter, severityFilter, from, to]);

  // F-22：from/to/actorUserId/targetType/severity/search 全部接后端查询参数（真分页），
  // 不再是"只在最新 200 条里筛"；search 防抖 300ms，避免每敲一个字都打后端。
  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      setError(null);
      const params: Record<string, string | number> = { page, pageSize: PAGE_SIZE };
      if (search.trim()) params.search = search.trim();
      if (actorFilter) params.actorUserId = actorFilter;
      if (targetFilter) params.targetType = targetFilter;
      if (severityFilter) params.severity = severityFilter;
      if (from) params.from = from;
      if (to) params.to = to;
      api
        .listAuditLogs(tokens.accessToken, params)
        .then((r) => {
          if (cancelled) return;
          const views = r.logs.map(toView);
          setLogs(views);
          setPagination(r.pagination);
          setActorOptions((prev) => {
            const byId = new Map(prev.map((a) => [a.id, a] as const));
            for (const l of views) {
              if (l.actorUserId) byId.set(l.actorUserId, { id: l.actorUserId, label: l.actor });
            }
            return Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label));
          });
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof ApiError ? e.message : '加载失败');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [tokens?.accessToken, page, search, actorFilter, targetFilter, severityFilter, from, to]);

  // 后端已按全部条件过滤+排序，这里不再做二次客户端过滤/排序（F-22 之前的口径）。
  const filtered = logs;

  // F-22：总日志数改用后端 pagination.total（当前筛选条件下的真实总数），
  // 不再是恒等于 min(实际总数,200) 的假总数；关键/警告/今日三个 KPI 仍是当前页近似值，
  // 和之前一样只覆盖本页，未在本次修复范围内改造成服务端聚合。
  const kpi = useMemo(
    () => ({
      total: pagination.total,
      critical: logs.filter((l) => l.severity === 'CRITICAL').length,
      warning: logs.filter((l) => l.severity === 'WARNING').length,
      today: logs.filter((l) => l.timestamp.startsWith(new Date().toISOString().slice(0, 10))).length,
    }),
    [logs, pagination.total],
  );

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">审计日志</h1>
          <p className="page-sub">
            所有敏感操作留痕 · 谁 / 何时 / 在哪 / 改了什么。合规与纠纷追责的基础。
          </p>
        </div>
        <button
          className="btn-secondary"
          onClick={() =>
            exportToCSV(
              '审计日志',
              filtered.map((l) => ({
                timestamp: formatDateTimeSecCn(l.timestamp),
                actor: l.actor,
                actorRole: l.actorRole,
                ip: l.ip,
                action: l.actionLabel,
                rawAction: l.rawAction,
                targetType: TARGET_LABEL[l.targetType],
                target: l.targetLabel,
                changes: l.diffLines.map((d) => `${d.prefix} ${d.text}`).join(' | '),
                severity: SEVERITY_LABEL[l.severity],
              })),
              [
                { key: 'timestamp', label: '时间' },
                { key: 'actor', label: '操作人' },
                { key: 'actorRole', label: '角色' },
                { key: 'ip', label: 'IP' },
                { key: 'action', label: '动作' },
                { key: 'rawAction', label: '动作代码' },
                { key: 'targetType', label: '对象类型' },
                { key: 'target', label: '对象' },
                { key: 'changes', label: '变更' },
                { key: 'severity', label: '严重度' },
              ],
            )
          }
        >
          <Icon name="download" /> 导出当前页 CSV
        </button>
      </section>

      {loading && (
        <div className="rounded-md bg-canvas px-3 py-2 text-xs text-ink-muted">加载中…</div>
      )}
      {error && (
        <div className="flex items-center gap-1 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700"><Icon name="alert" /> {error}</div>
      )}

      <section className="grid gap-3 md:grid-cols-4">
        {/* F-22：total 来自后端 pagination（当前筛选条件下的真实总数），sub 显示实际查询的日期区间，
            不再是恒等于 min(实际总数,200) 且文案写死"最近 90 天"的假 KPI */}
        <Kpi label="总日志数" value={kpi.total.toString()} sub={`${from || '不限'} ~ ${to || '不限'}`} />
        <Kpi label="关键事件" value={kpi.critical.toString()} sub="本页近似值" />
        <Kpi label="警告事件" value={kpi.warning.toString()} sub="本页近似值" />
        <Kpi label="今日动作" value={kpi.today.toString()} sub="本页近似值" />
      </section>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-6">
          <div className="md:col-span-2">
            <label className="label text-xs">搜索</label>
            <input
              className="input"
              placeholder="动作 / 对象 / 变更摘要"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label className="label text-xs">操作人</label>
            <select className="input" value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
              <option value="">全部</option>
              {actorOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label text-xs">对象类型</label>
            <select
              className="input"
              value={targetFilter}
              onChange={(e) => setTargetFilter(e.target.value as '' | TargetType)}
            >
              <option value="">全部</option>
              {(Object.keys(TARGET_LABEL) as TargetType[]).map((t) => (
                <option key={t} value={t}>
                  {TARGET_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label text-xs">严重度</label>
            <select
              className="input"
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value as '' | Severity)}
            >
              <option value="">全部</option>
              <option value="CRITICAL">关键</option>
              <option value="WARNING">警告</option>
              <option value="INFO">一般</option>
            </select>
          </div>
          <div>
            <label className="label text-xs">日期从</label>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label text-xs">日期到</label>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </section>

      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th className="text-left">时间</th>
                <th className="text-left">操作人</th>
                <th className="text-left">动作</th>
                <th className="text-left">对象</th>
                <th className="text-left">变更摘要</th>
                <th className="text-center">严重度</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id} className="cursor-pointer" onClick={() => setSelected(l)}>
                  <td className="text-xs font-mono text-ink-soft">
                    {formatInBusinessTz(l.timestamp, {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </td>
                  <td className="text-xs">
                    <div className="font-medium text-ink-soft">{l.actor}</div>
                    <div className="text-[10px] text-ink-muted">
                      {l.actorRole} · {l.ip}
                    </div>
                  </td>
                  <td className="text-sm">
                    <Icon name={l.actionIcon} className="mr-1.5 inline-block align-text-bottom" />
                    <span className="font-medium text-ink">{l.actionLabel}</span>
                    <div className="mt-0.5 font-mono text-[10px] text-ink-muted">{l.rawAction}</div>
                  </td>
                  <td className="text-xs">
                    <Icon name={TARGET_ICON[l.targetType]} className="mr-1 inline-block align-text-bottom" />
                    <span className="text-ink-soft">{l.targetLabel}</span>
                    <div className="mt-0.5 text-[10px] text-ink-muted">{TARGET_LABEL[l.targetType]}</div>
                  </td>
                  <td className="text-xs text-ink-soft">
                    <div className="max-w-md truncate" title={l.diffSummary}>
                      {l.diffSummary}
                    </div>
                  </td>
                  <td className="text-center">
                    <span className={SEVERITY_COLOR[l.severity]}>
                      {SEVERITY_LABEL[l.severity]}
                    </span>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink-muted">
                    没有符合条件的日志
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* F-22：真分页——之前固定拉 200 条，筛选/操作人搜索命中窗口外的记录会直接查不到且无提示 */}
      {pagination.total > 0 && (
        <div className="flex items-center justify-between text-xs text-ink-muted">
          <span>
            共 {pagination.total} 条 · 第 {pagination.page} / {Math.max(1, Math.ceil(pagination.total / pagination.pageSize))} 页
          </span>
          <div className="flex gap-2">
            <button
              className="btn-secondary px-2 py-1 text-xs disabled:opacity-50"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </button>
            <button
              className="btn-secondary px-2 py-1 text-xs disabled:opacity-50"
              disabled={page * pagination.pageSize >= pagination.total || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {selected && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="日志详情"
          tabIndex={-1}
          className="fixed inset-0 z-50 flex justify-end bg-slate-900/50"
          onClick={() => setSelected(null)}
        >
          <div
            className="h-full w-full max-w-md overflow-auto bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
              <h2 className="text-lg font-semibold">日志详情</h2>
              <button
                className="text-2xl leading-none text-slate-400 hover:text-slate-700"
                onClick={() => setSelected(null)}
                aria-label="关闭日志详情"
              >
                <Icon name="close" />
              </button>
            </div>
            <dl className="space-y-3 px-6 py-5 text-sm">
              <Field label="时间">
                <span className="font-mono text-xs">{formatDateTimeSecCn(selected.timestamp)}</span>
              </Field>
              <Field label="操作人">
                <div>{selected.actor}</div>
                <div className="text-xs text-slate-500">
                  {selected.actorRole} · IP {selected.ip}
                </div>
              </Field>
              <Field label="动作">
                <Icon name={selected.actionIcon} className="mr-1.5 inline-block align-text-bottom" />
                <span className="font-medium">{selected.actionLabel}</span>
                <span className="ml-2 font-mono text-[10px] text-slate-400">{selected.rawAction}</span>
              </Field>
              <Field label="对象">
                <Icon name={TARGET_ICON[selected.targetType]} className="mr-1 inline-block align-text-bottom" />
                <span>{selected.targetLabel}</span>
                <span className="ml-2 text-xs text-slate-500">({TARGET_LABEL[selected.targetType]})</span>
              </Field>
              <Field label="变更">
                {selected.diffLines.length === 0 ? (
                  <span className="text-slate-400">—</span>
                ) : (
                  <ul className="space-y-1 rounded-md bg-slate-50 px-3 py-2 text-xs">
                    {selected.diffLines.map((d, i) => (
                      <li
                        key={i}
                        className={
                          d.isAdded
                            ? 'text-green-700'
                            : d.isRemoved
                              ? 'text-red-600'
                              : 'text-slate-700'
                        }
                      >
                        <span className="mr-1.5 font-mono">{d.prefix}</span>
                        {d.text}
                      </li>
                    ))}
                  </ul>
                )}
              </Field>
              <Field label="严重度">
                <span className={SEVERITY_COLOR[selected.severity]}>
                  {SEVERITY_LABEL[selected.severity]}
                </span>
              </Field>
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700">
                  查看原始 JSON
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-slate-900 p-3 text-[11px] text-slate-100">
                  {JSON.stringify({ before: selected.before, after: selected.after }, null, 2)}
                </pre>
              </details>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{children}</dd>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>
    </div>
  );
}
