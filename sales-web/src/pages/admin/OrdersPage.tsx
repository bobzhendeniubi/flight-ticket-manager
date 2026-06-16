import { useMemo, useState } from 'react';
import {
  MOCK_ORDERS,
  STATUS_COLOR,
  STATUS_LABEL,
  type MockOrder,
  type MockOrderStatus,
} from '../../lib/mockData';

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
  TRANSFER: '地面服务',
  VISA: '签证',
  COMBO: '打包',
};

export function AdminOrdersPage() {
  const [orders, setOrders] = useState<MockOrder[]>(MOCK_ORDERS);
  const [statusFilter, setStatusFilter] = useState<'' | MockOrderStatus>('');
  const [kindFilter, setKindFilter] = useState<'' | MockOrder['itemKind']>('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<MockOrder | null>(null);

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      if (statusFilter && o.status !== statusFilter) return false;
      if (kindFilter && o.itemKind !== kindFilter) return false;
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
  }, [orders, statusFilter, kindFilter, search]);

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
        <span className="rounded bg-slate-100 px-3 py-1 text-xs text-slate-600">共 {filtered.length} 条</span>
      </section>

      <section className="card">
        <div className="grid gap-4 md:grid-cols-4">
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
          <div className="md:col-span-2">
            <label className="label">搜索（订单号 / 客户 / 代理）</label>
            <input
              className="input"
              placeholder="如 FTM2026 或 张伟 或 总代"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
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
