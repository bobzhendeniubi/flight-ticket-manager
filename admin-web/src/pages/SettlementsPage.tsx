/**
 * 结算单 — 财务月结核心
 * 每个代理每月一张结算单：GMV / 应得佣金 / 分给下级 / 预付抵扣 / 应付
 */
import { useMemo, useState } from 'react';
import { MOCK_SETTLEMENTS, type MockSettlement } from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';

const STATUS_INFO: Record<MockSettlement['status'], { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: 'bg-slate-100 text-slate-600' },
  PENDING_APPROVAL: { label: '待审核', color: 'bg-amber-100 text-amber-700' },
  APPROVED: { label: '已核准', color: 'bg-blue-100 text-blue-700' },
  PAID: { label: '已支付', color: 'bg-green-100 text-green-700' },
};

export function SettlementsPage() {
  const [periodFilter, setPeriodFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | MockSettlement['status']>('');
  const [selected, setSelected] = useState<MockSettlement | null>(null);

  const periods = useMemo(() => Array.from(new Set(MOCK_SETTLEMENTS.map((s) => s.period))).sort().reverse(), []);
  const agents = useMemo(() => {
    const map = new Map<string, string>();
    MOCK_SETTLEMENTS.forEach((s) => map.set(s.agentId, s.agentName));
    return Array.from(map.entries());
  }, []);

  const filtered = useMemo(() => {
    return MOCK_SETTLEMENTS.filter((s) => {
      if (periodFilter && s.period !== periodFilter) return false;
      if (agentFilter && s.agentId !== agentFilter) return false;
      if (statusFilter && s.status !== statusFilter) return false;
      return true;
    }).sort((a, b) => b.period.localeCompare(a.period) || a.agentTier - b.agentTier);
  }, [periodFilter, agentFilter, statusFilter]);

  const kpi = useMemo(() => ({
    total: filtered.length,
    totalGMV: filtered.reduce((s, x) => s + x.grossRevenue, 0),
    totalCommission: filtered.reduce((s, x) => s + x.netCommission, 0),
    totalPayable: filtered.filter(x => x.status !== 'PAID').reduce((s, x) => s + x.payableToAgent, 0),
    paidCount: filtered.filter(x => x.status === 'PAID').length,
  }), [filtered]);

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-5">
        <Kpi label="结算单数" value={filtered.length.toString()} sub={`${kpi.paidCount} 已支付`} color="bg-brand" />
        <Kpi label="累计 GMV" value={`¥${(kpi.totalGMV / 10000).toFixed(1)}万`} sub="订单总额" color="bg-amber-500" />
        <Kpi label="累计净佣金" value={`¥${kpi.totalCommission.toLocaleString()}`} sub="各级代理合计" color="bg-green-600" />
        <Kpi label="待支付" value={`¥${kpi.totalPayable.toLocaleString()}`} sub="未结清金额" color="bg-red-600" />
        <div className="card p-3 flex flex-col justify-between">
          <p className="text-xs font-medium uppercase text-slate-500">操作</p>
          <div className="flex gap-1 mt-2">
            <button className="btn-primary text-xs flex-1" onClick={() => alert('生成本月结算单（demo）')}>生成本月</button>
            <button
              className="btn-secondary text-xs"
              onClick={() => exportToCSV('结算单', filtered, [
                { key: 'period', label: '月份' },
                { key: 'agentName', label: '代理' },
                { key: 'agentTier', label: '层级' },
                { key: 'orderCount', label: '订单数' },
                { key: 'grossRevenue', label: 'GMV', format: (v) => `¥${Number(v).toLocaleString()}` },
                { key: 'commissionEarned', label: '应得佣金', format: (v) => `¥${Number(v).toLocaleString()}` },
                { key: 'commissionPaidToChildren', label: '分给下级', format: (v) => `¥${Number(v).toLocaleString()}` },
                { key: 'netCommission', label: '净佣金', format: (v) => `¥${Number(v).toLocaleString()}` },
                { key: 'prepaymentOffset', label: '预付抵扣', format: (v) => `¥${Number(v).toLocaleString()}` },
                { key: 'payableToAgent', label: '应付', format: (v) => `¥${Number(v).toLocaleString()}` },
                { key: 'status', label: '状态', format: (v) => STATUS_INFO[v as MockSettlement['status']].label },
                { key: 'paidAt', label: '支付时间', format: (v) => v ? new Date(String(v)).toLocaleString('zh-CN') : '—' },
              ])}
            >
              📥
            </button>
          </div>
        </div>
      </section>

      <section>
        <h1 className="text-2xl font-bold text-slate-900">结算单管理</h1>
        <p className="mt-1 text-sm text-slate-600">每月自动生成每个代理的结算单 · GMV → 佣金 → 预付抵扣 → 应付</p>
      </section>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="label text-xs">结算月份</label>
            <select className="input" value={periodFilter} onChange={(e) => setPeriodFilter(e.target.value)}>
              <option value="">全部</option>
              {periods.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="label text-xs">代理</label>
            <select className="input" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
              <option value="">全部代理</option>
              {agents.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
          <div>
            <label className="label text-xs">状态</label>
            <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | MockSettlement['status'])}>
              <option value="">全部</option>
              {Object.entries(STATUS_INFO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
        </div>
      </section>

      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3 text-left">月份</th>
                <th className="px-4 py-3 text-left">代理</th>
                <th className="px-4 py-3 text-right">订单</th>
                <th className="px-4 py-3 text-right">GMV</th>
                <th className="px-4 py-3 text-right">应得</th>
                <th className="px-4 py-3 text-right">分下级</th>
                <th className="px-4 py-3 text-right">净佣金</th>
                <th className="px-4 py-3 text-right">预付抵</th>
                <th className="px-4 py-3 text-right">应付</th>
                <th className="px-4 py-3 text-center">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setSelected(s)}>
                  <td className="px-4 py-3 font-mono text-xs">{s.period}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{s.agentName}</div>
                    <div className="text-[10px] text-slate-500">{s.agentTier} 级</div>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-amber-600">{s.orderCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums">¥{s.grossRevenue.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums">¥{s.commissionEarned.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-amber-700">-¥{s.commissionPaidToChildren.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-green-700">¥{s.netCommission.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-red-600">-¥{s.prepaymentOffset.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-bold text-brand">¥{s.payableToAgent.toLocaleString()}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_INFO[s.status].color}`}>{STATUS_INFO[s.status].label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={() => setSelected(null)}>
          <div className="h-full w-full max-w-md overflow-auto bg-white shadow-xl p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">结算单 #{selected.id}</h2>
              <button className="text-xl text-slate-400" onClick={() => setSelected(null)}>×</button>
            </div>

            <div className="rounded bg-slate-900 text-white p-4 mb-4">
              <div className="text-xs text-slate-300">结算期</div>
              <div className="text-2xl font-bold">{selected.period}</div>
              <div className="mt-2 text-sm">{selected.agentName} · {selected.agentTier} 级</div>
            </div>

            <div className="space-y-1 text-sm">
              <Row label="本月订单数" value={selected.orderCount.toString()} />
              <Row label="本月 GMV" value={`¥${selected.grossRevenue.toLocaleString()}`} />
              <Row label="应得佣金" value={<span className="text-green-700 font-medium">+¥{selected.commissionEarned.toLocaleString()}</span>} />
              <Row label="分给下级" value={<span className="text-amber-700">−¥{selected.commissionPaidToChildren.toLocaleString()}</span>} />
              <Row label="净佣金" value={<span className="font-bold text-green-700">¥{selected.netCommission.toLocaleString()}</span>} />
              <Row label="预付余额抵扣" value={<span className="text-red-600">−¥{selected.prepaymentOffset.toLocaleString()}</span>} />
              <div className="border-t-2 border-slate-300 pt-2 mt-2"></div>
              <Row label={<strong>应付给代理</strong>} value={<strong className="text-2xl text-brand">¥{selected.payableToAgent.toLocaleString()}</strong>} />
            </div>

            <div className="mt-4 text-xs text-slate-500">
              生成时间: {new Date(selected.generatedAt).toLocaleString('zh-CN')}
              {selected.paidAt && <><br />支付时间: {new Date(selected.paidAt).toLocaleString('zh-CN')}</>}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button className="btn-secondary text-sm" onClick={() => alert('下载 PDF（demo）')}>📄 PDF</button>
              {selected.status !== 'PAID' && (
                <button className="btn-primary text-sm" onClick={() => alert('确认支付（demo）')}>💰 标记已支付</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-baseline py-1.5 border-b border-slate-100">
      <dt className="text-slate-600 text-sm">{label}</dt>
      <dd className="text-right">{value}</dd>
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
