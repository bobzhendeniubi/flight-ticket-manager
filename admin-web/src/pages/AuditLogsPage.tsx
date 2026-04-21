/**
 * 审计日志 — 运营治理核心
 * 记录所有敏感操作：谁什么时候在哪个 IP 改了什么
 */
import { useMemo, useState } from 'react';
import { MOCK_AUDIT_LOGS, type MockAuditLog } from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';

const SEVERITY_COLOR: Record<MockAuditLog['severity'], string> = {
  INFO: 'bg-slate-100 text-slate-600',
  WARNING: 'bg-amber-100 text-amber-700',
  CRITICAL: 'bg-red-100 text-red-700',
};

const TARGET_ICON: Record<MockAuditLog['targetType'], string> = {
  AGENT: '🤝', ORDER: '📋', FLIGHT: '✈️', CUSTOMER: '👤', PRICING: '💰', COMMISSION: '💼', TENANT: '🏢',
};

export function AuditLogsPage() {
  const [search, setSearch] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [targetFilter, setTargetFilter] = useState<'' | MockAuditLog['targetType']>('');
  const [severityFilter, setSeverityFilter] = useState<'' | MockAuditLog['severity']>('');
  const [selected, setSelected] = useState<MockAuditLog | null>(null);

  const actors = useMemo(() => {
    const set = new Set<string>();
    MOCK_AUDIT_LOGS.forEach((l) => set.add(l.actor));
    return Array.from(set).sort();
  }, []);

  const filtered = useMemo(() => {
    return MOCK_AUDIT_LOGS.filter((l) => {
      if (search) {
        const q = search.toLowerCase();
        if (!l.action.toLowerCase().includes(q) && !l.target.toLowerCase().includes(q) && !l.after.toLowerCase().includes(q)) return false;
      }
      if (actorFilter && l.actor !== actorFilter) return false;
      if (targetFilter && l.targetType !== targetFilter) return false;
      if (severityFilter && l.severity !== severityFilter) return false;
      return true;
    }).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [search, actorFilter, targetFilter, severityFilter]);

  const kpi = useMemo(() => ({
    total: MOCK_AUDIT_LOGS.length,
    critical: MOCK_AUDIT_LOGS.filter((l) => l.severity === 'CRITICAL').length,
    warning: MOCK_AUDIT_LOGS.filter((l) => l.severity === 'WARNING').length,
    today: MOCK_AUDIT_LOGS.filter((l) => l.timestamp.startsWith(new Date().toISOString().slice(0, 10))).length,
  }), []);

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-5">
        <Kpi label="总日志数" value={kpi.total.toString()} sub="最近 90 天" color="bg-brand" />
        <Kpi label="CRITICAL" value={kpi.critical.toString()} sub="余额/租户/权限变更" color="bg-red-600" />
        <Kpi label="WARNING" value={kpi.warning.toString()} sub="定价/佣金/退款" color="bg-amber-500" />
        <Kpi label="今日动作" value={kpi.today.toString()} sub="截至现在" color="bg-green-600" />
        <div className="card p-3 flex flex-col justify-between">
          <p className="text-xs font-medium uppercase text-slate-500">导出</p>
          <button
            className="btn-primary text-sm mt-2"
            onClick={() => exportToCSV('审计日志', filtered, [
              { key: 'timestamp', label: '时间' },
              { key: 'actor', label: '操作人' },
              { key: 'actorRole', label: '角色' },
              { key: 'action', label: '动作' },
              { key: 'targetType', label: '对象类型' },
              { key: 'target', label: '对象' },
              { key: 'before', label: '变更前', format: (v) => String(v ?? '—') },
              { key: 'after', label: '变更后' },
              { key: 'ip', label: 'IP' },
              { key: 'severity', label: '严重度' },
            ])}
          >
            📥 导出 CSV
          </button>
        </div>
      </section>

      <section>
        <h1 className="text-2xl font-bold text-slate-900">审计日志</h1>
        <p className="mt-1 text-sm text-slate-600">所有敏感操作留痕 · 谁 / 何时 / 在哪 / 改了什么。合规与纠纷追责的基础。</p>
      </section>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-5">
          <div className="md:col-span-2">
            <label className="label text-xs">搜索</label>
            <input className="input" placeholder="动作 / 对象 / 变更内容" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div>
            <label className="label text-xs">操作人</label>
            <select className="input" value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
              <option value="">全部</option>
              {actors.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label className="label text-xs">对象类型</label>
            <select className="input" value={targetFilter} onChange={(e) => setTargetFilter(e.target.value as '' | MockAuditLog['targetType'])}>
              <option value="">全部</option>
              <option value="AGENT">🤝 代理</option>
              <option value="ORDER">📋 订单</option>
              <option value="FLIGHT">✈️ 航班</option>
              <option value="CUSTOMER">👤 客户</option>
              <option value="PRICING">💰 定价</option>
              <option value="COMMISSION">💼 佣金</option>
              <option value="TENANT">🏢 租户</option>
            </select>
          </div>
          <div>
            <label className="label text-xs">严重度</label>
            <select className="input" value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value as '' | MockAuditLog['severity'])}>
              <option value="">全部</option>
              <option value="CRITICAL">🔴 CRITICAL</option>
              <option value="WARNING">🟡 WARNING</option>
              <option value="INFO">⚪ INFO</option>
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
                <th className="px-4 py-3 text-left">变更</th>
                <th className="px-4 py-3 text-center">严重度</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setSelected(l)}>
                  <td className="px-4 py-3 text-xs font-mono">{new Date(l.timestamp).toLocaleString('zh-CN')}</td>
                  <td className="px-4 py-3 text-xs">
                    <div className="font-medium text-slate-700">{l.actor}</div>
                    <div className="text-[10px] text-slate-400">{l.actorRole} · {l.ip}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-brand">{l.action}</td>
                  <td className="px-4 py-3 text-xs">
                    <span className="mr-1">{TARGET_ICON[l.targetType]}</span>
                    {l.target}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {l.before && <div className="text-red-600">− {l.before}</div>}
                    <div className="text-green-700">+ {l.after}</div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_COLOR[l.severity]}`}>
                      {l.severity}
                    </span>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">没有符合条件的日志</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={() => setSelected(null)}>
          <div className="h-full w-full max-w-md overflow-auto bg-white shadow-xl p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">日志详情</h2>
              <button className="text-xl text-slate-400" onClick={() => setSelected(null)}>×</button>
            </div>
            <dl className="space-y-2 text-sm">
              <div><dt className="text-xs text-slate-500">时间</dt><dd className="font-mono">{selected.timestamp}</dd></div>
              <div><dt className="text-xs text-slate-500">操作人</dt><dd>{selected.actor} · {selected.actorRole}</dd></div>
              <div><dt className="text-xs text-slate-500">IP 地址</dt><dd className="font-mono">{selected.ip}</dd></div>
              <div><dt className="text-xs text-slate-500">动作</dt><dd className="font-mono text-brand">{selected.action}</dd></div>
              <div><dt className="text-xs text-slate-500">对象</dt><dd>{TARGET_ICON[selected.targetType]} {selected.target}</dd></div>
              <div><dt className="text-xs text-slate-500">变更前</dt><dd className="bg-red-50 p-2 rounded text-xs">{selected.before ?? '（新建）'}</dd></div>
              <div><dt className="text-xs text-slate-500">变更后</dt><dd className="bg-green-50 p-2 rounded text-xs">{selected.after}</dd></div>
              <div><dt className="text-xs text-slate-500">严重度</dt><dd><span className={`rounded px-2 py-0.5 text-xs ${SEVERITY_COLOR[selected.severity]}`}>{selected.severity}</span></dd></div>
            </dl>
          </div>
        </div>
      )}
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
