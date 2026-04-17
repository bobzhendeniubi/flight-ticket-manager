import { useMemo, useState } from 'react';
import {
  MOCK_ORDERS,
  STATUS_COLOR,
  STATUS_LABEL,
  type MockOrder,
  type MockOrderStatus,
} from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';

const ALL_STATUSES: MockOrderStatus[] = [
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'TICKETED',
  'COMPLETED',
  'CANCELLED',
  'REFUND_REQUESTED',
];

const KIND_LABEL: Record<MockOrder['itemKind'], string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '接送',
  VISA: '签证',
  COMBO: '打包',
};

// 佣金率（按产品类型）
const COMMISSION_RATE: Record<MockOrder['itemKind'], number> = {
  FLIGHT: 0.10,
  HOTEL: 0.08,
  TRANSFER: 0.15,
  VISA: 0.12,
  COMBO: 0.10,
};

export function OrdersPage() {
  const [orders, setOrders] = useState<MockOrder[]>(MOCK_ORDERS);
  const [statusFilter, setStatusFilter] = useState<'' | MockOrderStatus>('');
  const [kindFilter, setKindFilter] = useState<'' | MockOrder['itemKind']>('');
  const [channelFilter, setChannelFilter] = useState<'' | 'direct' | 'agent'>('');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<MockOrder | null>(null);

  // 所有代理名（去重）
  const agentNames = useMemo(() => {
    const set = new Set<string>();
    orders.forEach((o) => { if (o.agentName) set.add(o.agentName); });
    return Array.from(set).sort();
  }, [orders]);

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      if (statusFilter && o.status !== statusFilter) return false;
      if (kindFilter && o.itemKind !== kindFilter) return false;
      if (channelFilter === 'direct' && o.agentName) return false;
      if (channelFilter === 'agent' && !o.agentName) return false;
      if (agentFilter && o.agentName !== agentFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !o.orderNumber.toLowerCase().includes(q) &&
          !o.customerName.toLowerCase().includes(q) &&
          !(o.agentName?.toLowerCase().includes(q) ?? false)
        )
          return false;
      }
      return true;
    });
  }, [orders, statusFilter, kindFilter, channelFilter, agentFilter, search]);

  // 汇总：代理维度统计
  const agentStats = useMemo(() => {
    const map = new Map<string, { orders: number; revenue: number; commission: number }>();
    const directStats = { orders: 0, revenue: 0, commission: 0 };
    filtered.forEach((o) => {
      const paid = o.status === 'PAID' || o.status === 'TICKETED' || o.status === 'COMPLETED';
      if (!paid) return;
      const commission = o.total * COMMISSION_RATE[o.itemKind];
      if (o.agentName) {
        const cur = map.get(o.agentName) ?? { orders: 0, revenue: 0, commission: 0 };
        cur.orders++;
        cur.revenue += o.total;
        cur.commission += commission;
        map.set(o.agentName, cur);
      } else {
        directStats.orders++;
        directStats.revenue += o.total;
      }
    });
    return { byAgent: map, direct: directStats };
  }, [filtered]);

  const advance = (order: MockOrder, next: MockOrderStatus) => {
    setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, status: next } : o)));
    setSelected((prev) => (prev && prev.id === order.id ? { ...prev, status: next } : prev));
  };

  return (
    <div className="space-y-6">
      <section className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">订单管理</h1>
          <p className="mt-1 text-sm text-slate-600">
            全渠道订单实时视图，可按状态和产品筛选，点击订单查看详情并操作状态流转。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded bg-slate-100 px-3 py-1 text-xs text-slate-600">共 {filtered.length} 条</span>
          <button
            className="btn-secondary text-sm"
            onClick={() =>
              exportToCSV('订单列表', filtered, [
                { key: 'orderNumber', label: '订单号' },
                { key: 'customerName', label: '客户' },
                { key: 'contactPhone', label: '电话' },
                { key: 'agentName', label: '归属代理', format: (v) => String(v ?? '直销') },
                { key: 'itemKind', label: '产品类型', format: (v) => KIND_LABEL[v as MockOrder['itemKind']] },
                { key: 'itemSummary', label: '订单内容' },
                { key: 'passengerCount', label: '人数' },
                { key: 'total', label: '金额', format: (v) => `¥${Number(v).toLocaleString()}` },
                { key: 'paymentMethod', label: '支付方式', format: (v) => String(v ?? '—') },
                { key: 'status', label: '状态', format: (v) => STATUS_LABEL[v as MockOrderStatus] },
                { key: 'createdAt', label: '下单时间', format: (v) => new Date(String(v)).toLocaleString('zh-CN') },
              ])
            }
          >
            📥 导出 CSV
          </button>
        </div>
      </section>

      {/* 代理维度统计 */}
      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-900">代理分销统计（仅含已付款订单）</h2>
          <span className="text-xs text-slate-500">点击代理名称可过滤订单</span>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          <button
            className={`rounded-md border-2 p-3 text-left transition ${channelFilter === 'direct' && !agentFilter ? 'border-brand bg-brand/5' : 'border-slate-200 hover:border-slate-300'}`}
            onClick={() => { setChannelFilter('direct'); setAgentFilter(''); }}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">🏢 直销（散客/自营）</span>
              <span className="text-xs text-slate-500">{agentStats.direct.orders} 单</span>
            </div>
            <div className="mt-1 text-lg font-bold text-slate-900">¥{agentStats.direct.revenue.toLocaleString()}</div>
            <div className="text-xs text-slate-500">无佣金</div>
          </button>
          {Array.from(agentStats.byAgent.entries()).slice(0, 2).map(([name, s]) => (
            <button
              key={name}
              className={`rounded-md border-2 p-3 text-left transition ${agentFilter === name ? 'border-brand bg-brand/5' : 'border-slate-200 hover:border-slate-300'}`}
              onClick={() => { setAgentFilter(agentFilter === name ? '' : name); setChannelFilter(''); }}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700 truncate">🤝 {name}</span>
                <span className="text-xs text-slate-500">{s.orders} 单</span>
              </div>
              <div className="mt-1 text-lg font-bold text-slate-900">¥{s.revenue.toLocaleString()}</div>
              <div className="text-xs text-green-700">佣金 ¥{Math.round(s.commission).toLocaleString()}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="grid gap-4 md:grid-cols-5">
          <div>
            <label className="label">状态</label>
            <select
              className="input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as '' | MockOrderStatus)}
            >
              <option value="">全部状态</option>
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">产品类型</label>
            <select
              className="input"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as '' | MockOrder['itemKind'])}
            >
              <option value="">全部类型</option>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">渠道</label>
            <select
              className="input"
              value={channelFilter}
              onChange={(e) => { setChannelFilter(e.target.value as '' | 'direct' | 'agent'); setAgentFilter(''); }}
            >
              <option value="">全部渠道</option>
              <option value="direct">🏢 直销</option>
              <option value="agent">🤝 代理</option>
            </select>
          </div>
          <div>
            <label className="label">代理</label>
            <select
              className="input"
              value={agentFilter}
              onChange={(e) => { setAgentFilter(e.target.value); if (e.target.value) setChannelFilter(''); }}
            >
              <option value="">全部代理</option>
              {agentNames.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-5">
            <label className="label">搜索（订单号 / 客户 / 代理）</label>
            <input
              className="input"
              placeholder="如 FTM2026 或 张伟 或 总代"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        {(statusFilter || kindFilter || channelFilter || agentFilter || search) && (
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <span>显示 {filtered.length} 条订单</span>
            <button
              className="text-brand hover:text-brand-dark"
              onClick={() => {
                setStatusFilter(''); setKindFilter(''); setChannelFilter(''); setAgentFilter(''); setSearch('');
              }}
            >
              清除所有过滤
            </button>
          </div>
        )}
      </section>

      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3 text-left">订单号</th>
                <th className="px-4 py-3 text-left">客户 / 代理</th>
                <th className="px-4 py-3 text-left">内容</th>
                <th className="px-4 py-3 text-right">金额</th>
                <th className="px-4 py-3 text-center">支付方式</th>
                <th className="px-4 py-3 text-center">状态</th>
                <th className="px-4 py-3 text-left">下单时间</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((o) => (
                <tr key={o.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">{o.orderNumber}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{o.customerName}</div>
                    <div className="text-xs text-slate-500">{o.contactPhone}</div>
                    {o.agentName && (
                      <div className="mt-0.5 inline-block rounded bg-brand/10 px-1.5 py-0.5 text-xs text-brand">
                        {o.agentName}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-slate-900">{o.itemSummary}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5">{KIND_LABEL[o.itemKind]}</span>
                      <span className="ml-2">{o.passengerCount} 人</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-900">¥{o.total.toLocaleString()}</td>
                  <td className="px-4 py-3 text-center text-xs text-slate-600">{o.paymentMethod ?? '—'}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[o.status]}`}>
                      {STATUS_LABEL[o.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {new Date(o.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button className="text-sm text-brand hover:text-brand-dark" onClick={() => setSelected(o)}>
                      详情
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                    没有符合条件的订单
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <OrderDrawer
          order={selected}
          onClose={() => setSelected(null)}
          onAdvance={(next) => advance(selected, next)}
        />
      )}
    </div>
  );
}

function OrderDrawer({
  order,
  onClose,
  onAdvance,
}: {
  order: MockOrder;
  onClose: () => void;
  onAdvance: (next: MockOrderStatus) => void;
}) {
  // 可行的下一步状态（demo 逻辑）
  const nextSteps: Array<{ label: string; to: MockOrderStatus; style: string }> = (() => {
    switch (order.status) {
      case 'PENDING_PAYMENT':
        return [
          { label: '标记已支付', to: 'PAID', style: 'btn-primary' },
          { label: '取消订单', to: 'CANCELLED', style: 'btn-secondary' },
        ];
      case 'PAID':
        return [{ label: '进入处理', to: 'PROCESSING', style: 'btn-primary' }];
      case 'PROCESSING':
        return [{ label: '出票完成', to: 'TICKETED', style: 'btn-primary' }];
      case 'TICKETED':
        return [{ label: '订单完结', to: 'COMPLETED', style: 'btn-primary' }];
      case 'REFUND_REQUESTED':
        return [
          { label: '同意退款', to: 'CANCELLED', style: 'btn-primary' },
          { label: '驳回退款', to: 'TICKETED', style: 'btn-secondary' },
        ];
      default:
        return [];
    }
  })();

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-auto bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">订单详情</h2>
          <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>×</button>
        </div>

        <div className="px-6 py-5 space-y-6">
          <section>
            <div className="font-mono text-xs text-slate-500">{order.orderNumber}</div>
            <div className="mt-2 flex items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[order.status]}`}>
                {STATUS_LABEL[order.status]}
              </span>
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {order.itemKind}
              </span>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-medium text-slate-700">产品内容</h3>
            <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
              <p className="text-slate-900">{order.itemSummary}</p>
              <p className="mt-1 text-xs text-slate-500">{order.passengerCount} 人</p>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-medium text-slate-700">客户信息</h3>
            <dl className="mt-2 space-y-1 text-sm">
              <Row label="姓名" value={order.customerName} />
              <Row label="联系电话" value={order.contactPhone} />
              {order.agentName && <Row label="归属代理" value={order.agentName} />}
            </dl>
          </section>

          <section>
            <h3 className="text-sm font-medium text-slate-700">支付</h3>
            <dl className="mt-2 space-y-1 text-sm">
              <Row label="支付方式" value={order.paymentMethod ?? '—'} />
              <Row
                label="订单金额"
                value={<span className="text-lg font-bold text-red-600">¥{order.total.toLocaleString()}</span>}
              />
              <Row label="下单时间" value={new Date(order.createdAt).toLocaleString('zh-CN')} />
            </dl>
          </section>

          <section>
            <h3 className="text-sm font-medium text-slate-700">状态流转</h3>
            <div className="mt-3 flex flex-col gap-2">
              {nextSteps.length === 0 && (
                <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-500">
                  当前状态下无可用操作
                </div>
              )}
              {nextSteps.map((s) => (
                <button key={s.to} className={`${s.style} text-sm`} onClick={() => onAdvance(s.to)}>
                  {s.label}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-400">
              ⓘ demo 模式：状态变更仅在当前会话生效，刷新后复原。
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-900">{value}</dd>
    </div>
  );
}
