import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type OrderSummary, type OrderItem, type OrderStatus } from '../lib/api';
import { useAuth } from '../stores/auth';
import {
  MOCK_FULFILLMENTS,
  type FulfillmentStatus,
} from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';

// 本地可视化用的状态子集（后端 OrderStatus 更全，这里只列出常用 7 个做 filter）
const STATUS_LABEL: Record<OrderStatus, string> = {
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

const STATUS_COLOR: Record<OrderStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-600',
  PENDING_PAYMENT: 'bg-amber-100 text-amber-700',
  PAID: 'bg-blue-100 text-blue-700',
  PROCESSING: 'bg-indigo-100 text-indigo-700',
  TICKETED: 'bg-green-100 text-green-700',
  COMPLETED: 'bg-slate-100 text-slate-700',
  PAYMENT_TIMEOUT: 'bg-orange-100 text-orange-700',
  CANCELLED: 'bg-slate-200 text-slate-500',
  REFUND_REQUESTED: 'bg-red-100 text-red-700',
  REFUNDED: 'bg-red-200 text-red-800',
  CHANGE_REQUESTED: 'bg-violet-100 text-violet-700',
  CHANGED: 'bg-violet-200 text-violet-800',
  FAILED: 'bg-rose-100 text-rose-700',
};

const FILTER_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT', 'PAID', 'PROCESSING', 'TICKETED', 'COMPLETED', 'CANCELLED', 'REFUND_REQUESTED',
];

type OrderItemKindLabel = OrderItem['kind'];
const KIND_LABEL: Record<OrderItemKindLabel, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '接送',
  VISA: '签证',
  INSURANCE: '保险',
  FEE: '附加费',
  DISCOUNT: '折扣',
};

// 佣金率（按产品类型，简化版 — 真实佣金由 CommissionRecord 表算）
const COMMISSION_RATE: Partial<Record<OrderItemKindLabel, number>> = {
  FLIGHT: 0.10, HOTEL: 0.08, TRANSFER: 0.15, VISA: 0.12,
};

// ── 辅助：从 OrderSummary 派生视图字段 ──────────────────────────────
function deriveView(o: OrderSummary) {
  const first = o.items[0];
  const itemKind: OrderItemKindLabel = first?.kind ?? 'FLIGHT';
  const summaryParts = o.items.map((it) =>
    it.quantity > 1 ? `${it.description} × ${it.quantity}` : it.description,
  );
  const itemSummary = summaryParts.join(' + ');
  const customerName = o.user.displayName ?? o.contactName;
  const agentName = o.agent?.companyName ?? o.agent?.contactName ?? null;
  const totalNum = Number(o.total);
  return { itemKind, itemSummary, customerName, agentName, totalNum };
}

export function OrdersPage() {
  const tokens = useAuth((s) => s.tokens);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'' | OrderStatus>('');
  const [kindFilter, setKindFilter] = useState<'' | OrderItemKindLabel>('');
  const [channelFilter, setChannelFilter] = useState<'' | 'direct' | 'agent'>('');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<OrderSummary | null>(null);

  // 拉取订单
  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.listOrders(tokens.accessToken, { pageSize: 200 })
      .then((res) => {
        if (cancelled) return;
        setOrders(res.orders);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : '加载订单失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [tokens?.accessToken]);

  // 视图层把 OrderSummary 映射成便于筛选/展示的数据
  const ordersView = useMemo(
    () => orders.map((o) => ({ order: o, view: deriveView(o) })),
    [orders],
  );

  // 所有代理名（去重）
  const agentNames = useMemo(() => {
    const set = new Set<string>();
    ordersView.forEach(({ view }) => { if (view.agentName) set.add(view.agentName); });
    return Array.from(set).sort();
  }, [ordersView]);

  const filtered = useMemo(() => {
    return ordersView.filter(({ order, view }) => {
      if (statusFilter && order.status !== statusFilter) return false;
      if (kindFilter && view.itemKind !== kindFilter) return false;
      if (channelFilter === 'direct' && view.agentName) return false;
      if (channelFilter === 'agent' && !view.agentName) return false;
      if (agentFilter && view.agentName !== agentFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !order.orderNumber.toLowerCase().includes(q) &&
          !view.customerName.toLowerCase().includes(q) &&
          !(view.agentName?.toLowerCase().includes(q) ?? false)
        )
          return false;
      }
      return true;
    });
  }, [ordersView, statusFilter, kindFilter, channelFilter, agentFilter, search]);

  // 代理维度统计
  const agentStats = useMemo(() => {
    const map = new Map<string, { orders: number; revenue: number; commission: number }>();
    const directStats = { orders: 0, revenue: 0, commission: 0 };
    filtered.forEach(({ order, view }) => {
      const paid = order.status === 'PAID' || order.status === 'TICKETED' || order.status === 'COMPLETED';
      if (!paid) return;
      const rate = COMMISSION_RATE[view.itemKind] ?? 0;
      const commission = view.totalNum * rate;
      if (view.agentName) {
        const cur = map.get(view.agentName) ?? { orders: 0, revenue: 0, commission: 0 };
        cur.orders++;
        cur.revenue += view.totalNum;
        cur.commission += commission;
        map.set(view.agentName, cur);
      } else {
        directStats.orders++;
        directStats.revenue += view.totalNum;
      }
    });
    return { byAgent: map, direct: directStats };
  }, [filtered]);

  const advance = async (order: OrderSummary, next: OrderStatus, reason?: string) => {
    if (!tokens?.accessToken) return;
    try {
      const res = await api.updateOrderStatus(tokens.accessToken, order.id, next, reason);
      setOrders((prev) => prev.map((o) => (o.id === order.id ? res.order : o)));
      setSelected((prev) => (prev && prev.id === order.id ? res.order : prev));
    } catch (err) {
      alert(err instanceof ApiError ? `操作失败：${err.message}` : '操作失败');
    }
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
          <span className="rounded bg-slate-100 px-3 py-1 text-xs text-slate-600">
            {loading ? '加载中…' : `共 ${filtered.length} 条`}
          </span>
          <button
            className="btn-secondary text-sm"
            disabled={loading}
            onClick={() =>
              exportToCSV(
                '订单列表',
                filtered.map(({ order, view }) => ({
                  orderNumber: order.orderNumber,
                  customerName: view.customerName,
                  contactPhone: order.contactPhone,
                  agentName: view.agentName ?? '直销',
                  itemKind: KIND_LABEL[view.itemKind],
                  itemSummary: view.itemSummary,
                  passengerCount: order.passengers.length,
                  total: view.totalNum,
                  status: STATUS_LABEL[order.status],
                  createdAt: new Date(order.createdAt).toLocaleString('zh-CN'),
                })),
                [
                  { key: 'orderNumber', label: '订单号' },
                  { key: 'customerName', label: '客户' },
                  { key: 'contactPhone', label: '电话' },
                  { key: 'agentName', label: '归属代理' },
                  { key: 'itemKind', label: '产品类型' },
                  { key: 'itemSummary', label: '订单内容' },
                  { key: 'passengerCount', label: '人数' },
                  { key: 'total', label: '金额', format: (v) => `¥${Number(v).toLocaleString()}` },
                  { key: 'status', label: '状态' },
                  { key: 'createdAt', label: '下单时间' },
                ],
              )
            }
          >
            📥 导出 CSV
          </button>
        </div>
      </section>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          ❌ {error}
        </div>
      )}

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
              onChange={(e) => setStatusFilter(e.target.value as '' | OrderStatus)}
            >
              <option value="">全部状态</option>
              {FILTER_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">产品类型</label>
            <select
              className="input"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as '' | OrderItemKindLabel)}
            >
              <option value="">全部类型</option>
              {(['FLIGHT', 'HOTEL', 'TRANSFER', 'VISA'] as OrderItemKindLabel[]).map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k]}</option>
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
                <th className="px-4 py-3 text-center">状态</th>
                <th className="px-4 py-3 text-left">下单时间</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(({ order, view }) => (
                <tr key={order.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">{order.orderNumber}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{view.customerName}</div>
                    <div className="text-xs text-slate-500">{order.contactPhone}</div>
                    {view.agentName && (
                      <div className="mt-0.5 inline-block rounded bg-brand/10 px-1.5 py-0.5 text-xs text-brand">
                        {view.agentName}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-slate-900 max-w-xs truncate" title={view.itemSummary}>
                      {view.itemSummary}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5">{KIND_LABEL[view.itemKind]}</span>
                      <span className="ml-2">{order.passengers.length} 人</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-900">
                    ¥{view.totalNum.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[order.status]}`}>
                      {STATUS_LABEL[order.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {new Date(order.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button className="text-sm text-brand hover:text-brand-dark" onClick={() => setSelected(order)}>
                      详情
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    没有符合条件的订单
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">加载中…</td>
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
          onAdvance={(next, reason) => advance(selected, next, reason)}
        />
      )}
    </div>
  );
}

// ── Drawer ─────────────────────────────────────────────────────────────
function OrderDrawer({
  order,
  onClose,
  onAdvance,
}: {
  order: OrderSummary;
  onClose: () => void;
  onAdvance: (next: OrderStatus, reason?: string) => void;
}) {
  const view = deriveView(order);
  // 可行的下一步状态（与 backend orders.service ALLOWED_TRANSITIONS 保持一致的子集）
  const nextSteps: Array<{ label: string; to: OrderStatus; style: string }> = (() => {
    switch (order.status) {
      case 'PENDING_PAYMENT':
        return [
          { label: '标记已支付', to: 'PAID', style: 'btn-primary' },
          { label: '取消订单', to: 'CANCELLED', style: 'btn-secondary' },
        ];
      case 'PAID':
        return [
          { label: '进入处理', to: 'PROCESSING', style: 'btn-primary' },
          { label: '直接出票', to: 'TICKETED', style: 'btn-secondary' },
        ];
      case 'PROCESSING':
        return [
          { label: '出票完成', to: 'TICKETED', style: 'btn-primary' },
          { label: '出票失败', to: 'FAILED', style: 'btn-secondary' },
        ];
      case 'TICKETED':
        return [
          { label: '订单完结', to: 'COMPLETED', style: 'btn-primary' },
          { label: '申请退款', to: 'REFUND_REQUESTED', style: 'btn-secondary' },
        ];
      case 'REFUND_REQUESTED':
        return [
          { label: '同意退款', to: 'REFUNDED', style: 'btn-primary' },
          { label: '驳回回退处理', to: 'PROCESSING', style: 'btn-secondary' },
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
                {KIND_LABEL[view.itemKind]}
              </span>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-medium text-slate-700">产品内容</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {order.items.map((it) => (
                <li key={it.id} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="text-slate-900">{it.description}</div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {KIND_LABEL[it.kind]} · 数量 {it.quantity} · 单价 ¥{Number(it.unitPrice).toLocaleString()}
                      </div>
                    </div>
                    <div className="text-sm font-medium text-slate-900">
                      ¥{Number(it.amount).toLocaleString()}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-500">共 {order.passengers.length} 位乘客</p>
          </section>

          <section>
            <h3 className="text-sm font-medium text-slate-700">乘客</h3>
            <ul className="mt-2 space-y-1 text-sm text-slate-700">
              {order.passengers.map((p) => (
                <li key={p.id} className="flex justify-between">
                  <span>{p.fullName}</span>
                  <span className="font-mono text-xs text-slate-500">{p.documentNumber}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-sm font-medium text-slate-700">客户信息</h3>
            <dl className="mt-2 space-y-1 text-sm">
              <Row label="联系人" value={order.contactName} />
              <Row label="联系电话" value={order.contactPhone} />
              {order.contactEmail && <Row label="邮箱" value={order.contactEmail} />}
              {view.agentName && <Row label="归属代理" value={view.agentName} />}
            </dl>
          </section>

          <section>
            <h3 className="text-sm font-medium text-slate-700">支付</h3>
            <dl className="mt-2 space-y-1 text-sm">
              <Row
                label="订单金额"
                value={<span className="text-lg font-bold text-red-600">¥{view.totalNum.toLocaleString()}</span>}
              />
              <Row label="已付" value={`¥${Number(order.paidAmount).toLocaleString()}`} />
              <Row label="下单时间" value={new Date(order.createdAt).toLocaleString('zh-CN')} />
            </dl>
          </section>

          {/* 履约 Fulfillment — 目前仍 mock，M6 接真实 FulfillmentTask 表 */}
          <FulfillmentSection orderId={order.id} />

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
              ⓘ 状态变更会真实写入数据库并记录操作事件。
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

// ═══════════════════════════════════════════════════════════════
// 履约 Fulfillment — 目前还是 mock（M6 接真实 FulfillmentTask）
// ═══════════════════════════════════════════════════════════════

const FF_STATUS_COLOR: Record<FulfillmentStatus, string> = {
  PENDING: 'bg-slate-100 text-slate-600',
  IN_PROGRESS: 'bg-blue-100 text-blue-700',
  CONFIRMED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-slate-200 text-slate-500',
  FAILED: 'bg-red-100 text-red-700',
};

const FF_STATUS_LABEL: Record<FulfillmentStatus, string> = {
  PENDING: '待处理', IN_PROGRESS: '处理中', CONFIRMED: '已确认', CANCELLED: '已取消', FAILED: '失败',
};

function FulfillmentSection({ orderId }: { orderId: string }) {
  // 真实订单 id 跟 mock 对不上，所以这里 demo 展示空态；M6 加真 API
  const ff = MOCK_FULFILLMENTS[orderId];
  if (!ff) {
    return (
      <section>
        <h3 className="text-sm font-medium text-slate-700">🚚 履约进度</h3>
        <div className="mt-2 rounded-md bg-slate-50 p-3 text-xs text-slate-500">
          暂无履约记录 · 真环境订单付款后自动触发 fulfillment 工作流（M6 接入）
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">🚚 履约进度</h3>
      </div>
      <div className="mt-2 space-y-2">
        {ff.flight && (
          <FfCard icon="✈️" label="机票出票" status={ff.flight.status}>
            <Row label="PNR" value={<span className="font-mono">{ff.flight.pnr ?? '（未生成）'}</span>} />
            <Row label="电子票号" value={<span className="font-mono">{ff.flight.eTicketNumber ?? '—'}</span>} />
          </FfCard>
        )}
        {ff.hotel && (
          <FfCard icon="🏨" label="酒店确认" status={ff.hotel.status}>
            <Row label="确认号" value={<span className="font-mono">{ff.hotel.confirmationNumber ?? '—'}</span>} />
          </FfCard>
        )}
        {ff.visa && (
          <FfCard icon="🛂" label="签证办理" status={ff.visa.status}>
            <Row label="申请号" value={<span className="font-mono">{ff.visa.applicationNumber ?? '—'}</span>} />
            <Row label="当前进度" value={ff.visa.progress} />
          </FfCard>
        )}
        {ff.transfer && (
          <FfCard icon="🚐" label="接送调度" status={ff.transfer.status}>
            <Row label="司机" value={ff.transfer.driverName ?? '（未分配）'} />
            <Row label="车牌" value={<span className="font-mono">{ff.transfer.vehicleNumber ?? '—'}</span>} />
          </FfCard>
        )}
      </div>
    </section>
  );
}

function FfCard({ icon, label, status, children }: { icon: string; label: string; status: FulfillmentStatus; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xl">{icon}</span>
          <span className="text-sm font-medium text-slate-900">{label}</span>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${FF_STATUS_COLOR[status]}`}>
          {FF_STATUS_LABEL[status]}
        </span>
      </div>
      <dl className="space-y-0.5 text-xs">{children}</dl>
    </div>
  );
}
