import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type DashboardKpi, type DashboardWeeklyPoint, type DashboardTopAgent, type OrderSummary } from '../lib/api';
import { useAuth } from '../stores/auth';
import { RealtimeActivity } from '../components/RealtimeActivity';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '已出票',
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
  PENDING_PAYMENT: 'bg-amber-100 text-amber-700',
  PAID: 'bg-blue-100 text-blue-700',
  PROCESSING: 'bg-indigo-100 text-indigo-700',
  TICKETED: 'bg-green-100 text-green-700',
  COMPLETED: 'bg-slate-100 text-slate-700',
  CANCELLED: 'bg-slate-200 text-slate-500',
  REFUND_REQUESTED: 'bg-red-100 text-red-700',
  REFUNDED: 'bg-red-200 text-red-800',
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
          <h1 className="text-2xl font-bold text-slate-900">运营仪表盘</h1>
          <p className="mt-1 text-sm text-slate-600">
            {kpi ? `截至 ${new Date(kpi.asOf).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '加载中…'}
            {!loading && !error && kpi && ' · 实时数据'}
          </p>
        </div>
        <span className="rounded bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">● 系统运行中</span>
      </section>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">❌ {error}</div>
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
          change="需人工跟进"
          sub="PENDING_PAYMENT 状态"
        />
        <KpiCard
          title="活跃代理"
          value={kpi ? kpi.activeAgents.toString() : '—'}
          change="最近 30 天下过单"
          sub="含所有层级"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-900">近 7 天营收</h2>
            <span className="text-xs text-slate-500">
              本月累计 ¥{kpi ? kpi.monthRevenue.toLocaleString() : '—'}
              {kpi && kpi.monthRevenueChangePct !== 0 && (
                <span className={`ml-2 ${kpi.monthRevenueChangePct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  ({kpi.monthRevenueChangePct >= 0 ? '+' : ''}{kpi.monthRevenueChangePct}% vs 上月)
                </span>
              )}
            </span>
          </div>
          <div className="mt-5 flex items-end gap-2 h-48">
            {weekly.map((d) => (
              <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                <div className="text-xs text-slate-500">
                  {d.revenue > 0 ? `¥${(d.revenue / 1000).toFixed(0)}k` : '—'}
                </div>
                <div
                  className="w-full rounded-t bg-brand/70 hover:bg-brand transition"
                  style={{ height: `${Math.max(2, (d.revenue / maxRevenue) * 80)}%` }}
                  title={`${d.date}  ¥${d.revenue.toLocaleString()}  (${d.orders} 单)`}
                />
                <div className="text-xs text-slate-600">{d.date}</div>
              </div>
            ))}
            {weekly.length === 0 && (
              <div className="flex-1 text-center text-sm text-slate-400">暂无数据</div>
            )}
          </div>
        </div>

        <div className="card">
          <h2 className="font-semibold text-slate-900">Top 代理（本月）</h2>
          <p className="mt-1 text-xs text-slate-500">按 GMV 排名 Top 5</p>
          <div className="mt-4 space-y-3">
            {topAgents.length === 0 && (
              <div className="text-xs text-slate-400 py-4 text-center">暂无数据</div>
            )}
            {topAgents.map((a, i) => {
              const max = topAgents[0]?.revenue || 1;
              const pct = Math.round((a.revenue / max) * 100);
              return (
                <div key={a.agentId}>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-700 truncate">
                      {i === 0 && '🥇 '}
                      {i === 1 && '🥈 '}
                      {i === 2 && '🥉 '}
                      {a.companyName ?? a.contactName}
                      <span className="ml-1 text-xs text-slate-400">T{a.tier}</span>
                    </span>
                    <span className="font-medium text-slate-900">¥{a.revenue.toLocaleString()}</span>
                  </div>
                  <div className="mt-1 h-2 w-full rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-[10px] text-slate-400">{a.orderCount} 单</div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <RealtimeActivity />

      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">最新订单</h2>
          <Link to="/orders" className="text-sm text-brand hover:text-brand-dark">查看全部 →</Link>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">订单号</th>
                <th className="px-3 py-2 text-left">客户</th>
                <th className="px-3 py-2 text-left">内容</th>
                <th className="px-3 py-2 text-right">金额</th>
                <th className="px-3 py-2 text-center">状态</th>
                <th className="px-3 py-2 text-left">时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {recent.map((o) => {
                const summary = o.items.map((it) => it.description).join(' + ');
                return (
                  <tr key={o.id}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">{o.orderNumber}</td>
                    <td className="px-3 py-2 text-slate-900">
                      {o.user.displayName ?? o.contactName}
                      {o.agent && (
                        <span className="ml-2 rounded bg-brand/10 px-1.5 py-0.5 text-xs text-brand">
                          代理 · {o.agent.companyName ?? o.agent.contactName}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-700 max-w-xs truncate" title={summary}>{summary}</td>
                    <td className="px-3 py-2 text-right font-medium text-slate-900">¥{Number(o.total).toLocaleString()}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[o.status] ?? 'bg-slate-100 text-slate-600'}`}>
                        {STATUS_LABEL[o.status] ?? o.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {new Date(o.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                );
              })}
              {!loading && recent.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">暂无订单</td></tr>
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
    <div className="card">
      <p className="text-xs font-medium uppercase text-slate-500">{title}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
      <p className={`mt-1 text-xs ${positive ? 'text-green-600' : 'text-amber-600'}`}>
        {positive && change.startsWith('+') ? '↑ ' : ''}{change}
      </p>
      <p className="mt-0.5 text-xs text-slate-400">{sub}</p>
    </div>
  );
}
