/**
 * 结算单 — 财务月结核心（接真后端）
 * 每个代理每月一张结算单：GMV / 应得佣金 / 分给下级 / 预付抵扣 / 应付
 */
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type SettlementSummary, type SettlementDetail, type SettlementStatus } from '../lib/api';
import { useAuth } from '../stores/auth';
import { exportToCSV } from '../lib/csvExport';

const STATUS_INFO: Record<SettlementStatus, { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: 'bg-slate-100 text-slate-600' },
  PENDING_APPROVAL: { label: '待审核', color: 'bg-amber-100 text-amber-700' },
  APPROVED: { label: '已核准', color: 'bg-blue-100 text-blue-700' },
  PAID: { label: '已支付', color: 'bg-green-100 text-green-700' },
  VOIDED: { label: '已作废', color: 'bg-slate-200 text-slate-500' },
};

function ymdNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function SettlementsPage() {
  const tokens = useAuth((s) => s.tokens);
  const [settlements, setSettlements] = useState<SettlementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [periodFilter, setPeriodFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | SettlementStatus>('');
  const [selected, setSelected] = useState<SettlementDetail | null>(null);
  const [generatePeriod, setGeneratePeriod] = useState(ymdNow());
  const [generating, setGenerating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // 拉列表
  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.listSettlements(tokens.accessToken, { pageSize: 200 })
      .then((res) => {
        if (!cancelled) setSettlements(res.settlements);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '加载结算单失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tokens?.accessToken, refreshKey]);

  const periods = useMemo(
    () => Array.from(new Set(settlements.map((s) => s.period))).sort().reverse(),
    [settlements],
  );
  const agents = useMemo(() => {
    const map = new Map<string, string>();
    settlements.forEach((s) => map.set(s.agentId, s.agent.companyName ?? s.agent.contactName));
    return Array.from(map.entries());
  }, [settlements]);

  const filtered = useMemo(() => {
    return settlements.filter((s) => {
      if (periodFilter && s.period !== periodFilter) return false;
      if (agentFilter && s.agentId !== agentFilter) return false;
      if (statusFilter && s.status !== statusFilter) return false;
      return true;
    }).sort((a, b) => b.period.localeCompare(a.period) || a.agent.tier - b.agent.tier);
  }, [settlements, periodFilter, agentFilter, statusFilter]);

  const kpi = useMemo(() => ({
    total: filtered.length,
    totalGMV: filtered.reduce((s, x) => s + Number(x.grossRevenue), 0),
    totalCommission: filtered.reduce((s, x) => s + Number(x.netCommission), 0),
    totalPayable: filtered.filter((x) => x.status !== 'PAID' && x.status !== 'VOIDED')
      .reduce((s, x) => s + Number(x.payableToAgent), 0),
    paidCount: filtered.filter((x) => x.status === 'PAID').length,
  }), [filtered]);

  const handleGenerate = async () => {
    if (!tokens?.accessToken) return;
    if (!/^\d{4}-\d{2}$/.test(generatePeriod)) {
      alert('请输入 YYYY-MM 格式，如 2026-04');
      return;
    }
    setGenerating(true);
    try {
      const res = await api.generateSettlements(tokens.accessToken, { period: generatePeriod, overwrite: true });
      const created = res.generated.filter((g) => g.action === 'created').length;
      const regen = res.generated.filter((g) => g.action === 'regenerated').length;
      const skipped = res.generated.filter((g) => g.action === 'skipped').length;
      alert(`✓ 已生成 ${created} 张新结算单 · 重算 ${regen} 张 · 跳过 ${skipped} 张（已核准/已支付不重算）`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      alert(err instanceof ApiError ? `生成失败：${err.message}` : '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const openDetail = async (s: SettlementSummary) => {
    if (!tokens?.accessToken) return;
    try {
      const res = await api.getSettlement(tokens.accessToken, s.id);
      setSelected(res.settlement);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : '加载详情失败');
    }
  };

  const advance = async (toStatus: SettlementStatus) => {
    if (!selected || !tokens?.accessToken) return;
    try {
      const res = await api.updateSettlementStatus(tokens.accessToken, selected.id, toStatus);
      setSelected(res.settlement);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      alert(err instanceof ApiError ? `状态流转失败：${err.message}` : '状态流转失败');
    }
  };

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-5">
        <Kpi label="结算单数" value={filtered.length.toString()} sub={`${kpi.paidCount} 已支付`} color="bg-brand" />
        <Kpi label="累计 GMV" value={`¥${(kpi.totalGMV / 10000).toFixed(1)}万`} sub="订单总额" color="bg-amber-500" />
        <Kpi label="累计净佣金" value={`¥${kpi.totalCommission.toLocaleString()}`} sub="各级代理合计" color="bg-green-600" />
        <Kpi label="待支付" value={`¥${kpi.totalPayable.toLocaleString()}`} sub="未结清金额" color="bg-red-600" />
        <div className="card p-3 flex flex-col justify-between">
          <p className="text-xs font-medium uppercase text-slate-500">生成结算单</p>
          <div className="flex gap-1 mt-2">
            <input
              className="input text-xs flex-1"
              placeholder="2026-04"
              value={generatePeriod}
              onChange={(e) => setGeneratePeriod(e.target.value)}
            />
            <button
              className="btn-primary text-xs whitespace-nowrap"
              onClick={handleGenerate}
              disabled={generating}
            >
              {generating ? '生成中…' : '生成/重算'}
            </button>
          </div>
          <button
            className="btn-secondary text-xs mt-1"
            disabled={filtered.length === 0}
            onClick={() => exportToCSV('结算单', filtered.map((s) => ({
              period: s.period,
              agent: s.agent.companyName ?? s.agent.contactName,
              tier: s.agent.tier,
              orderCount: s.orderCount,
              grossRevenue: Number(s.grossRevenue),
              commissionEarned: Number(s.commissionEarned),
              paidToChildren: Number(s.commissionPaidToChildren),
              netCommission: Number(s.netCommission),
              prepaymentOffset: Number(s.prepaymentOffset),
              payable: Number(s.payableToAgent),
              status: STATUS_INFO[s.status].label,
              paidAt: s.paidAt ? new Date(s.paidAt).toLocaleString('zh-CN') : '—',
            })), [
              { key: 'period', label: '月份' },
              { key: 'agent', label: '代理' },
              { key: 'tier', label: '层级' },
              { key: 'orderCount', label: '订单数' },
              { key: 'grossRevenue', label: 'GMV', format: (v) => `¥${Number(v).toLocaleString()}` },
              { key: 'commissionEarned', label: '应得佣金', format: (v) => `¥${Number(v).toLocaleString()}` },
              { key: 'paidToChildren', label: '分给下级', format: (v) => `¥${Number(v).toLocaleString()}` },
              { key: 'netCommission', label: '净佣金', format: (v) => `¥${Number(v).toLocaleString()}` },
              { key: 'prepaymentOffset', label: '预付抵扣', format: (v) => `¥${Number(v).toLocaleString()}` },
              { key: 'payable', label: '应付', format: (v) => `¥${Number(v).toLocaleString()}` },
              { key: 'status', label: '状态' },
              { key: 'paidAt', label: '支付时间' },
            ])}
          >📥 导出 CSV</button>
        </div>
      </section>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">❌ {error}</div>
      )}

      <section>
        <h1 className="text-2xl font-bold text-slate-900">结算单管理</h1>
        <p className="mt-1 text-sm text-slate-600">每月自动/手动生成每个代理的结算单 · GMV → 佣金 → 预付抵扣 → 应付</p>
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
            <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | SettlementStatus)}>
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
                <tr key={s.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => openDetail(s)}>
                  <td className="px-4 py-3 font-mono text-xs">{s.period}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{s.agent.companyName ?? s.agent.contactName}</div>
                    <div className="text-[10px] text-slate-500">{s.agent.tier} 级</div>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-amber-600">{s.orderCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums">¥{Number(s.grossRevenue).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums">¥{Number(s.commissionEarned).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-amber-700">-¥{Number(s.commissionPaidToChildren).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-green-700">¥{Number(s.netCommission).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-red-600">-¥{Number(s.prepaymentOffset).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-bold text-brand">¥{Number(s.payableToAgent).toLocaleString()}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_INFO[s.status].color}`}>{STATUS_INFO[s.status].label}</span>
                  </td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-500">没有结算单 · 点右上角"生成/重算"从订单数据生成</td></tr>
              )}
              {loading && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-400">加载中…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <SettlementDrawer
          settlement={selected}
          onClose={() => setSelected(null)}
          onAdvance={advance}
        />
      )}
    </div>
  );
}

function SettlementDrawer({
  settlement,
  onClose,
  onAdvance,
}: {
  settlement: SettlementDetail;
  onClose: () => void;
  onAdvance: (next: SettlementStatus) => void;
}) {
  const nextSteps: Array<{ label: string; to: SettlementStatus; style: string }> = (() => {
    switch (settlement.status) {
      case 'DRAFT': return [
        { label: '提交审核', to: 'PENDING_APPROVAL', style: 'btn-primary' },
        { label: '作废', to: 'VOIDED', style: 'btn-secondary' },
      ];
      case 'PENDING_APPROVAL': return [
        { label: '核准', to: 'APPROVED', style: 'btn-primary' },
        { label: '打回草稿', to: 'DRAFT', style: 'btn-secondary' },
      ];
      case 'APPROVED': return [
        { label: '💰 标记已支付', to: 'PAID', style: 'btn-primary' },
        { label: '撤回审核', to: 'PENDING_APPROVAL', style: 'btn-secondary' },
      ];
      default: return [];
    }
  })();

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-auto bg-white shadow-xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">结算单 #{settlement.id.slice(0, 8)}</h2>
          <button className="text-xl text-slate-400" onClick={onClose}>×</button>
        </div>

        <div className="rounded bg-slate-900 text-white p-4 mb-4">
          <div className="text-xs text-slate-300">结算期</div>
          <div className="text-2xl font-bold">{settlement.period}</div>
          <div className="mt-2 text-sm">{settlement.agent.companyName ?? settlement.agent.contactName} · {settlement.agent.tier} 级</div>
          <div className="mt-1">
            <span className={`inline-block rounded px-2 py-0.5 text-xs ${STATUS_INFO[settlement.status].color}`}>
              {STATUS_INFO[settlement.status].label}
            </span>
          </div>
        </div>

        <div className="space-y-1 text-sm">
          <Row label="本月订单数" value={settlement.orderCount.toString()} />
          <Row label="本月 GMV" value={`¥${Number(settlement.grossRevenue).toLocaleString()}`} />
          <Row label="应得佣金" value={<span className="text-green-700 font-medium">+¥{Number(settlement.commissionEarned).toLocaleString()}</span>} />
          <Row label="分给下级" value={<span className="text-amber-700">−¥{Number(settlement.commissionPaidToChildren).toLocaleString()}</span>} />
          <Row label="净佣金" value={<span className="font-bold text-green-700">¥{Number(settlement.netCommission).toLocaleString()}</span>} />
          <Row label="预付余额抵扣" value={<span className="text-red-600">−¥{Number(settlement.prepaymentOffset).toLocaleString()}</span>} />
          <div className="border-t-2 border-slate-300 pt-2 mt-2"></div>
          <Row label={<strong>应付给代理</strong>} value={<strong className="text-2xl text-brand">¥{Number(settlement.payableToAgent).toLocaleString()}</strong>} />
        </div>

        {settlement.commissions && settlement.commissions.length > 0 && (
          <div className="mt-5">
            <h3 className="text-sm font-semibold text-slate-700 mb-2">
              佣金明细 ({settlement.commissions.length} 条)
            </h3>
            <div className="max-h-72 overflow-auto rounded border border-slate-200">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-2 py-1 text-left">订单号</th>
                    <th className="px-2 py-1 text-left">产品</th>
                    <th className="px-2 py-1 text-right">基数</th>
                    <th className="px-2 py-1 text-right">费率</th>
                    <th className="px-2 py-1 text-right">金额</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {settlement.commissions.map((c) => (
                    <tr key={c.id}>
                      <td className="px-2 py-1 font-mono text-[10px]">{c.order.orderNumber}</td>
                      <td className="px-2 py-1">{c.productKind} (d{c.chainDepth})</td>
                      <td className="px-2 py-1 text-right">¥{Number(c.baseAmount).toLocaleString()}</td>
                      <td className="px-2 py-1 text-right">{(Number(c.rate) * 100).toFixed(2)}%</td>
                      <td className="px-2 py-1 text-right font-medium">¥{Number(c.amount).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="mt-4 text-xs text-slate-500">
          生成时间: {new Date(settlement.generatedAt).toLocaleString('zh-CN')}
          {settlement.approvedAt && <><br />核准时间: {new Date(settlement.approvedAt).toLocaleString('zh-CN')}</>}
          {settlement.paidAt && <><br />支付时间: {new Date(settlement.paidAt).toLocaleString('zh-CN')}</>}
        </div>

        {nextSteps.length > 0 && (
          <div className="mt-4 space-y-2">
            {nextSteps.map((s) => (
              <button key={s.to} className={`${s.style} text-sm w-full`} onClick={() => onAdvance(s.to)}>
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
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
