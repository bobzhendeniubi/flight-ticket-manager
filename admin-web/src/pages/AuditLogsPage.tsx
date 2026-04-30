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

type Severity = AuditLog['severity'];
type TargetType = AuditLog['targetType'];

const SEVERITY_COLOR: Record<Severity, string> = {
  INFO: 'bg-slate-100 text-slate-600',
  WARNING: 'bg-amber-100 text-amber-700',
  CRITICAL: 'bg-red-100 text-red-700',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  INFO: '一般',
  WARNING: '警告',
  CRITICAL: '关键',
};

const TARGET_ICON: Record<TargetType, string> = {
  AGENT: '🤝',
  ORDER: '📋',
  FLIGHT: '✈️',
  CUSTOMER: '👤',
  PRICING: '💰',
  COMMISSION: '💼',
  TENANT: '🏢',
  TRAVELER: '🧳',
  PRODUCT: '📦',
  AUTH: '🔐',
  SYSTEM: '⚙️',
  SETTLEMENT: '💳',
};

const TARGET_LABEL: Record<TargetType, string> = {
  AGENT: '代理',
  ORDER: '订单',
  FLIGHT: '航班',
  CUSTOMER: '客户',
  PRICING: '定价',
  COMMISSION: '佣金',
  TENANT: '租户',
  TRAVELER: '出行人',
  PRODUCT: '产品',
  AUTH: '登录',
  SYSTEM: '系统',
  SETTLEMENT: '结算',
};

interface AuditView {
  id: string;
  timestamp: string;
  actor: string;
  actorRole: string;
  ip: string;
  rawAction: string;
  actionLabel: string;
  actionEmoji: string;
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
    actor: l.actorLabel ?? 'system',
    actorRole: l.actorRole ?? 'SYSTEM',
    ip: l.ipAddress ?? 'system',
    rawAction: l.action,
    actionLabel: a.label,
    actionEmoji: a.emoji,
    targetType: l.targetType,
    targetLabel: l.targetLabel ?? l.targetId ?? '—',
    diffLines: formatPayloadDiff(l.before, l.after),
    diffSummary: summarizePayload(l.action, l.before, l.after),
    severity: l.severity,
    before: l.before,
    after: l.after,
  };
}

export function AuditLogsPage() {
  const tokens = useAuth((s) => s.tokens);
  const [logs, setLogs] = useState<AuditView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [targetFilter, setTargetFilter] = useState<'' | TargetType>('');
  const [severityFilter, setSeverityFilter] = useState<'' | Severity>('');
  const [selected, setSelected] = useState<AuditView | null>(null);

  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    api
      .listAuditLogs(tokens.accessToken, { pageSize: 200 })
      .then((r) => {
        if (!cancelled) setLogs(r.logs.map(toView));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tokens?.accessToken]);

  const actors = useMemo(() => {
    const set = new Set<string>();
    logs.forEach((l) => set.add(l.actor));
    return Array.from(set).sort();
  }, [logs]);

  const filtered = useMemo(() => {
    return logs
      .filter((l) => {
        if (search) {
          const q = search.toLowerCase();
          const haystack = [l.rawAction, l.actionLabel, l.targetLabel, l.diffSummary]
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        if (actorFilter && l.actor !== actorFilter) return false;
        if (targetFilter && l.targetType !== targetFilter) return false;
        if (severityFilter && l.severity !== severityFilter) return false;
        return true;
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [logs, search, actorFilter, targetFilter, severityFilter]);

  const kpi = useMemo(
    () => ({
      total: logs.length,
      critical: logs.filter((l) => l.severity === 'CRITICAL').length,
      warning: logs.filter((l) => l.severity === 'WARNING').length,
      today: logs.filter((l) => l.timestamp.startsWith(new Date().toISOString().slice(0, 10))).length,
    }),
    [logs],
  );

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-5">
        <Kpi label="总日志数" value={kpi.total.toString()} sub="最近 90 天" color="bg-brand" />
        <Kpi label="关键事件" value={kpi.critical.toString()} sub="支付 / 结算 / 权限" color="bg-red-600" />
        <Kpi label="警告事件" value={kpi.warning.toString()} sub="退款 / 强制改状态" color="bg-amber-500" />
        <Kpi label="今日动作" value={kpi.today.toString()} sub="截至现在" color="bg-green-600" />
        <div className="card p-3 flex flex-col justify-between">
          <p className="text-xs font-medium uppercase text-slate-500">导出</p>
          <button
            className="btn-primary text-sm mt-2"
            onClick={() =>
              exportToCSV(
                '审计日志',
                filtered.map((l) => ({
                  timestamp: new Date(l.timestamp).toLocaleString('zh-CN'),
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
            📥 导出 CSV
          </button>
        </div>
      </section>

      <section>
        <h1 className="text-2xl font-bold text-slate-900">审计日志</h1>
        <p className="mt-1 text-sm text-slate-600">
          所有敏感操作留痕 · 谁 / 何时 / 在哪 / 改了什么。合规与纠纷追责的基础。
        </p>
        {loading && (
          <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">加载中…</div>
        )}
        {error && (
          <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">❌ {error}</div>
        )}
      </section>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-5">
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
              {actors.map((a) => (
                <option key={a} value={a}>
                  {a}
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
                  {TARGET_ICON[t]} {TARGET_LABEL[t]}
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
              <option value="CRITICAL">🔴 关键</option>
              <option value="WARNING">🟡 警告</option>
              <option value="INFO">⚪ 一般</option>
            </select>
          </div>
        </div>
      </section>

      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3 text-left">时间</th>
                <th className="px-4 py-3 text-left">操作人</th>
                <th className="px-4 py-3 text-left">动作</th>
                <th className="px-4 py-3 text-left">对象</th>
                <th className="px-4 py-3 text-left">变更摘要</th>
                <th className="px-4 py-3 text-center">严重度</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setSelected(l)}>
                  <td className="px-4 py-3 text-xs font-mono text-slate-600">
                    {new Date(l.timestamp).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div className="font-medium text-slate-700">{l.actor}</div>
                    <div className="text-[10px] text-slate-400">
                      {l.actorRole} · {l.ip}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span className="mr-1.5">{l.actionEmoji}</span>
                    <span className="font-medium text-slate-800">{l.actionLabel}</span>
                    <div className="mt-0.5 font-mono text-[10px] text-slate-400">{l.rawAction}</div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className="mr-1">{TARGET_ICON[l.targetType]}</span>
                    <span className="text-slate-700">{l.targetLabel}</span>
                    <div className="mt-0.5 text-[10px] text-slate-400">{TARGET_LABEL[l.targetType]}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    <div className="max-w-md truncate" title={l.diffSummary}>
                      {l.diffSummary}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_COLOR[l.severity]}`}>
                      {SEVERITY_LABEL[l.severity]}
                    </span>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    没有符合条件的日志
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <div
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
              >
                ×
              </button>
            </div>
            <dl className="space-y-3 px-6 py-5 text-sm">
              <Field label="时间">
                <span className="font-mono text-xs">{new Date(selected.timestamp).toLocaleString('zh-CN')}</span>
              </Field>
              <Field label="操作人">
                <div>{selected.actor}</div>
                <div className="text-xs text-slate-500">
                  {selected.actorRole} · IP {selected.ip}
                </div>
              </Field>
              <Field label="动作">
                <span className="mr-1.5">{selected.actionEmoji}</span>
                <span className="font-medium">{selected.actionLabel}</span>
                <span className="ml-2 font-mono text-[10px] text-slate-400">{selected.rawAction}</span>
              </Field>
              <Field label="对象">
                <span className="mr-1">{TARGET_ICON[selected.targetType]}</span>
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
                <span className={`rounded px-2 py-0.5 text-xs ${SEVERITY_COLOR[selected.severity]}`}>
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

function Kpi({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="card p-3">
      <div className="flex items-center gap-2">
        <span className={`h-8 w-1 rounded ${color}`}></span>
        <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      </div>
      <p className="mt-1.5 text-2xl font-bold text-slate-900">{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
    </div>
  );
}
