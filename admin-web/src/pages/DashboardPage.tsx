import { useEffect, useState } from 'react';
import { api, ApiError, type DashboardKpi, type DashboardWeeklyPoint, type DashboardTopAgent } from '../lib/api';
import { useAuth } from '../stores/auth';
import { formatInBusinessTz } from '../lib/datetime';
import { RealtimeActivity } from '../components/RealtimeActivity';
import { PendingAgingCard } from '../components/dashboard/PendingAgingCard';
import { WeeklyRevenueChart } from '../components/dashboard/WeeklyRevenueChart';

export function DashboardPage() {
  const tokens = useAuth((s) => s.tokens);
  const [kpi, setKpi] = useState<DashboardKpi | null>(null);
  const [weekly, setWeekly] = useState<DashboardWeeklyPoint[]>([]);
  const [topAgents, setTopAgents] = useState<DashboardTopAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.getDashboardKpi(tokens.accessToken),
      api.getDashboardWeekly(tokens.accessToken, 7),
      api.getDashboardTopAgents(tokens.accessToken),
    ])
      .then(([k, w, t]) => {
        if (cancelled) return;
        setKpi(k.kpi);
        setWeekly(w.series);
        setTopAgents(t.agents);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tokens?.accessToken]);

  return (
    <div className="space-y-6">
      <section className="flex items-center justify-between">
        <div>
          <h1 className="page-title">运营仪表盘</h1>
          <p className="page-sub">
            {kpi ? `截至 ${formatInBusinessTz(kpi.asOf, { hour: '2-digit', minute: '2-digit' })}` : '加载中…'}
            {!loading && !error && kpi && ' · 实时数据'}
          </p>
        </div>
        <span className="badge-success">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 系统运行中
        </span>
      </section>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      )}

      <section className="grid gap-4 md:grid-cols-4">
        <KpiCard
          title="今日营收"
          value={kpi ? `¥${kpi.todayRevenue.toLocaleString()}` : '—'}
          change={kpi ? `${kpi.revenueChangePct >= 0 ? '+' : ''}${kpi.revenueChangePct}%` : ''}
          positive={kpi ? kpi.revenueChangePct >= 0 : true}
          sub="对比昨日"
        />
        <KpiCard
          title="今日订单"
          value={kpi ? kpi.todayOrders.toString() : '—'}
          change={kpi ? `${kpi.ordersChangePct >= 0 ? '+' : ''}${kpi.ordersChangePct}%` : ''}
          positive={kpi ? kpi.ordersChangePct >= 0 : true}
          sub="对比昨日"
        />
        <KpiCard
          title="待支付订单"
          value={kpi ? kpi.pendingOrders.toString() : '—'}
          change="都在占着机位"
          sub="账龄明细见下方卡片"
        />
        <KpiCard
          title="活跃代理"
          value={kpi ? kpi.activeAgents.toString() : '—'}
          change="最近 30 天下过单"
          sub="含所有层级"
        />
      </section>

      <PendingAgingCard />

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">近 7 天营收</h2>
            <span className="text-xs text-ink-muted">
              本月累计 <span className="nums text-ink-soft">¥{kpi ? kpi.monthRevenue.toLocaleString() : '—'}</span>
              {kpi && kpi.monthRevenueChangePct !== 0 && (
                <span className={`ml-2 font-medium ${kpi.monthRevenueChangePct >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                  ({kpi.monthRevenueChangePct >= 0 ? '+' : ''}{kpi.monthRevenueChangePct}% vs 上月)
                </span>
              )}
            </span>
          </div>
          <div className="mt-5">
            <WeeklyRevenueChart data={weekly} />
          </div>
        </div>

        <div className="card">
          <h2 className="text-sm font-semibold text-ink">Top 代理（本月）</h2>
          <p className="mt-1 text-xs text-ink-muted">按 GMV 排名 Top 5</p>
          <div className="mt-4 space-y-3">
            {topAgents.length === 0 && (
              <div className="py-4 text-center text-xs text-ink-muted">暂无数据</div>
            )}
            {topAgents.map((a, i) => {
              const max = topAgents[0]?.revenue || 1;
              const pct = Math.round((a.revenue / max) * 100);
              return (
                <div key={a.agentId}>
                  <div className="flex justify-between text-sm">
                    <span className="truncate text-ink-soft">
                      {i < 3 && (
                        <span
                          className={`mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold ${
                            i === 0 ? 'border-brand text-brand' : 'border-slate-300 text-slate-500'
                          }`}
                          aria-label={`第 ${i + 1} 名`}
                        >
                          {i + 1}
                        </span>
                      )}
                      {a.companyName ?? a.contactName}
                      <span className="ml-1 text-xs text-ink-muted">T{a.tier}</span>
                    </span>
                    <span className="nums font-medium text-ink">¥{a.revenue.toLocaleString()}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-0.5 text-[10px] text-ink-muted">{a.orderCount} 单</div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <RealtimeActivity />
    </div>
  );
}

function KpiCard({
  title,
  value,
  change,
  sub,
  positive,
}: {
  title: string;
  value: string;
  change: string;
  sub: string;
  positive?: boolean;
}) {
  return (
    <div className="stat-card">
      <p className="stat-label">{title}</p>
      <p className="stat-value">{value}</p>
      <p className={`mt-1 text-xs font-medium ${positive ? 'text-emerald-600' : 'text-amber-600'}`}>
        {positive && change.startsWith('+') ? '↑ ' : ''}{change}
      </p>
      <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>
    </div>
  );
}
