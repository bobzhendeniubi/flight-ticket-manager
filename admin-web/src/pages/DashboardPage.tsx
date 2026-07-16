import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type DashboardKpi, type DashboardWeeklyPoint, type DashboardTopAgent, type OrderSummary } from '../lib/api';
import { useAuth } from '../stores/auth';
import { RealtimeActivity } from '../components/RealtimeActivity';
import { PendingAgingCard } from '../components/dashboard/PendingAgingCard';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '出票完成',
  COMPLETED: '已完成',
  PAYMENT_TIMEOUT: '超时',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '退款申请中',
  REFUNDED: '已退款',
  CHANGE_REQUESTED: '改期申请中',
  CHANGED: '已改期',
  FAILED: '出票失败',
};
const STATUS_COLOR: Record<string, string> = {
  PENDING_PAYMENT: 'badge-warning',
  PAID: 'badge-info',
  PROCESSING: 'badge-info',
  TICKETED: 'badge-success',
  COMPLETED: 'badge-neutral',
  CANCELLED: 'badge-neutral',
  REFUND_REQUESTED: 'badge-danger',
  REFUNDED: 'badge-danger',
};

export function DashboardPage() {
  const tokens = useAuth((s) => s.tokens);
  const [kpi, setKpi] = useState<DashboardKpi | null>(null);
  const [weekly, setWeekly] = useState<DashboardWeeklyPoint[]>([]);
  const [topAgents, setTopAgents] = useState<DashboardTopAgent[]>([]);
  const [recent, setRecent] = useState<OrderSummary[]>([]);
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
      api.listOrders(tokens.accessToken, { pageSize: 5 }),
    ])
      .then(([k, w, t, o]) => {
        if (cancelled) return;
        setKpi(k.kpi);
        setWeekly(w.series);
        setTopAgents(t.agents);
        setRecent(o.orders);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tokens?.accessToken]);

  const maxRevenue = weekly.length > 0 ? Math.max(...weekly.map((d) => d.revenue), 1) : 1;

  return (
    <div className="space-y-6">
      <section className="flex items-center justify-between">
        <div>
          <h1 className="page-title">运营仪表盘</h1>
          <p className="page-sub">
            {kpi ? `截至 ${new Date(kpi.asOf).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '加载中…'}
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
          <div className="mt-5 flex items-end gap-2 h-48">
            {weekly.map((d) => (
              <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                <div className="nums text-xs text-ink-muted">
                  {d.revenue > 0 ? `¥${(d.revenue / 1000).toFixed(0)}k` : '—'}
                </div>
                <div
                  className="w-full rounded-t bg-brand/70 hover:bg-brand transition"
                  style={{ height: `${Math.max(2, (d.revenue / maxRevenue) * 80)}%` }}
                  title={`${d.date}  ¥${d.revenue.toLocaleString()}  (${d.orders} 单)`}
                />
                <div className="text-xs text-ink-soft">{d.date}</div>
              </div>
            ))}
            {weekly.length === 0 && (
              <div className="flex-1 text-center text-sm text-ink-muted">暂无数据</div>
            )}
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
                      {i === 0 && '🥇 '}
                      {i === 1 && '🥈 '}
                      {i === 2 && '🥉 '}
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

      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">最新订单</h2>
          <Link to="/orders" className="text-sm font-medium text-brand hover:text-brand-dark">查看全部 →</Link>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th className="text-left">订单号</th>
                <th className="text-left">客户</th>
                <th className="text-left">内容</th>
                <th className="text-right">金额</th>
                <th className="text-center">状态</th>
                <th className="text-left">时间</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((o) => {
                const summary = (o.items ?? []).map((it) => it.description).join(' + ');
                return (
                  <tr key={o.id}>
                    <td className="font-mono text-xs text-ink-soft">{o.orderNumber}</td>
                    <td className="text-ink">
                      {o.user?.displayName ?? o.contactName}
                      {o.agent && (
                        <span className="badge-info ml-2">
                          代理 · {o.agent.companyName ?? o.agent.contactName}
                        </span>
                      )}
                    </td>
                    <td className="max-w-xs truncate" title={summary}>{summary}</td>
                    <td className="nums text-right font-medium text-ink">¥{Number(o.total).toLocaleString()}</td>
                    <td className="text-center">
                      <span className={STATUS_COLOR[o.status] ?? 'badge-neutral'}>
                        {STATUS_LABEL[o.status] ?? o.status}
                      </span>
                    </td>
                    <td className="text-xs text-ink-muted">
                      {new Date(o.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                );
              })}
              {!loading && recent.length === 0 && (
                <tr><td colSpan={6} className="py-8 text-center text-ink-muted">暂无订单</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
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
