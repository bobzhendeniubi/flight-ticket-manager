import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  type DashboardKpi,
  type DashboardWeeklyPoint,
  type DashboardTopAgent,
  type DashboardAlertsSummary,
} from '../lib/api';
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
  const [alerts, setAlerts] = useState<DashboardAlertsSummary | null>(null);
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
    // 预警汇总独立加载：失败只静默不渲染，不挡 KPI 区
    api
      .getDashboardAlertsSummary(tokens.accessToken)
      .then((r) => { if (!cancelled) setAlerts(r.summary); })
      .catch(() => {});
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

      <AlertsSummaryBar alerts={alerts} />

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
                      {a.companyName?.trim() || a.contactName}
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

/**
 * 今日预警条：把散在各页的预警数聚成一眼可见的一条（提醒中心待办 + 房控四类）。
 * 全为 0 时渲染一条安静的绿色状态；加载失败/未返回时整条不渲染（不挡仪表盘）。
 * 数字点击即跳对应页面看明细——这里只做汇总，不重复各页口径。
 */
function AlertsSummaryBar({ alerts }: { alerts: DashboardAlertsSummary | null }) {
  if (!alerts) return null;
  const chips: Array<{ label: string; count: number; to: string; critical?: boolean }> = [
    { label: '紧急待办', count: alerts.reminders.critical, to: '/reminders', critical: true },
    // 普通待办 = 总待办 − 紧急，两枚 chip 相加即总数（不重复计数）
    { label: '待办提醒', count: alerts.reminders.pending - alerts.reminders.critical, to: '/reminders' },
    { label: '超卖加房', count: alerts.hotel.oversold, to: '/hotel-control', critical: true },
    { label: '富余退房', count: alerts.hotel.surplusSoon, to: '/hotel-control' },
    { label: '班次超员', count: alerts.hotel.overCapacitySchedules, to: '/hotel-control', critical: true },
    { label: '拼房落单', count: alerts.hotel.sharedOddNear, to: '/hotel-control' },
  ];
  const active = chips.filter((c) => c.count > 0);
  const hasCritical = active.some((c) => c.critical);
  if (active.length === 0) {
    return (
      <section className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        今日预警：暂无 —— 待办与房控预警均已清零。
        <Link to="/reminders" className="ml-auto text-xs text-emerald-700 underline underline-offset-2 hover:text-emerald-900">
          去提醒中心生成今日提醒
        </Link>
      </section>
    );
  }
  return (
    <section
      className={`flex flex-wrap items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${
        hasCritical ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-amber-200 bg-amber-50 text-amber-800'
      }`}
    >
      <span className="font-medium">今日预警</span>
      {active.map((c) => (
        <Link
          key={c.label}
          to={c.to}
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 transition hover:opacity-80 ${
            c.critical
              ? 'bg-rose-100 text-rose-700 ring-rose-300'
              : 'bg-amber-100 text-amber-800 ring-amber-300'
          }`}
        >
          {c.label}
          <span className="font-semibold">{c.count}</span>
        </Link>
      ))}
      <span className="ml-auto text-xs opacity-70">点击数字进对应页面处理</span>
    </section>
  );
}
