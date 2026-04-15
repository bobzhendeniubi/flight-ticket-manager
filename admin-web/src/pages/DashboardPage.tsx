import { Link } from 'react-router-dom';
import {
  DASHBOARD_KPIS,
  DASHBOARD_WEEKLY,
  MOCK_ORDERS,
  STATUS_COLOR,
  STATUS_LABEL,
} from '../lib/mockData';

export function DashboardPage() {
  const maxRevenue = Math.max(...DASHBOARD_WEEKLY.map((d) => d.revenue));
  const recent = MOCK_ORDERS.slice(0, 5);

  return (
    <div className="space-y-6">
      <section className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">运营仪表盘</h1>
          <p className="mt-1 text-sm text-slate-600">
            截至 {new Date().toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 的实时数据（demo）
          </p>
        </div>
        <span className="rounded bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">● 系统运行中</span>
      </section>

      <section className="grid gap-4 md:grid-cols-4">
        <KpiCard
          title="今日营收"
          value={`¥${DASHBOARD_KPIS.todayRevenue.toLocaleString()}`}
          change={`+${DASHBOARD_KPIS.revenueChangePct}%`}
          positive
          sub="对比昨日"
        />
        <KpiCard
          title="今日订单"
          value={DASHBOARD_KPIS.todayOrders.toString()}
          change={`+${DASHBOARD_KPIS.ordersChangePct}%`}
          positive
          sub="对比昨日"
        />
        <KpiCard
          title="待处理订单"
          value={DASHBOARD_KPIS.pendingOrders.toString()}
          change="需人工跟进"
          sub="含待支付 + 待出票"
        />
        <KpiCard
          title="活跃代理"
          value={DASHBOARD_KPIS.activeAgents.toString()}
          change="本月下单代理数"
          sub="含所有层级"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-900">近 7 天营收</h2>
            <span className="text-xs text-slate-500">本月累计 ¥{DASHBOARD_KPIS.monthRevenue.toLocaleString()}</span>
          </div>
          <div className="mt-5 flex items-end gap-2 h-48">
            {DASHBOARD_WEEKLY.map((d) => (
              <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                <div className="text-xs text-slate-500">¥{(d.revenue / 1000).toFixed(0)}k</div>
                <div
                  className="w-full rounded-t bg-brand/70 hover:bg-brand transition"
                  style={{ height: `${(d.revenue / maxRevenue) * 80}%` }}
                  title={`${d.date}  ¥${d.revenue.toLocaleString()}  (${d.orders} 单)`}
                />
                <div className="text-xs text-slate-600">{d.date}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h2 className="font-semibold text-slate-900">产品结构</h2>
          <p className="mt-1 text-xs text-slate-500">本月订单按产品类型分布</p>
          <div className="mt-4 space-y-3">
            {[
              { label: '机票', pct: 62, color: 'bg-brand' },
              { label: '酒店', pct: 18, color: 'bg-indigo-500' },
              { label: '签证', pct: 13, color: 'bg-amber-500' },
              { label: '机场接送', pct: 7, color: 'bg-pink-500' },
            ].map((p) => (
              <div key={p.label}>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-700">{p.label}</span>
                  <span className="font-medium text-slate-900">{p.pct}%</span>
                </div>
                <div className="mt-1 h-2 w-full rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${p.color}`} style={{ width: `${p.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">最新订单</h2>
          <Link to="/orders" className="text-sm text-brand hover:text-brand-dark">
            查看全部 →
          </Link>
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
              {recent.map((o) => (
                <tr key={o.id}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-700">{o.orderNumber}</td>
                  <td className="px-3 py-2 text-slate-900">
                    {o.customerName}
                    {o.agentName && (
                      <span className="ml-2 rounded bg-brand/10 px-1.5 py-0.5 text-xs text-brand">
                        代理 · {o.agentName}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{o.itemSummary}</td>
                  <td className="px-3 py-2 text-right font-medium text-slate-900">¥{o.total.toLocaleString()}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[o.status]}`}>
                      {STATUS_LABEL[o.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {new Date(o.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                </tr>
              ))}
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
        {positive && '↑ '}{change}
      </p>
      <p className="mt-0.5 text-xs text-slate-400">{sub}</p>
    </div>
  );
}
