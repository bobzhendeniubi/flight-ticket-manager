import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type OrderSummary, type OrderItem, type OrderStatus, type FulfillmentTask, type FulfillmentStatus as ApiFfStatus, type AdminFlight, type AdminSchedule, type CabinClass, type BatchCreateOrdersResult, type InvoiceStatus, type PaymentMethod, type OrderPayment, type ListOrdersParams, type OrderExportTemplate } from '../lib/api';
import { useAuth } from '../stores/auth';
import {
  type FulfillmentStatus,
} from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';
import { NumberInput } from '../components/NumberInput';
import { OrderFinanceSection } from '../components/OrderFinanceSection';

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
  DRAFT: 'badge-neutral',
  PENDING_PAYMENT: 'badge-warning',
  PAID: 'badge-info',
  PROCESSING: 'badge-info',
  TICKETED: 'badge-success',
  COMPLETED: 'badge-neutral',
  PAYMENT_TIMEOUT: 'badge-warning',
  CANCELLED: 'badge-neutral',
  REFUND_REQUESTED: 'badge-danger',
  REFUNDED: 'badge-danger',
  CHANGE_REQUESTED: 'badge-info',
  CHANGED: 'badge-info',
  FAILED: 'badge-danger',
};

const FILTER_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT', 'PAID', 'PROCESSING', 'TICKETED', 'COMPLETED', 'CANCELLED', 'REFUND_REQUESTED',
];

type OrderItemKindLabel = OrderItem['kind'];
const KIND_LABEL: Record<OrderItemKindLabel, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '地面服务',
  VISA: '签证',
  BUNDLE: '套餐',
  INSURANCE: '保险',
  FEE: '附加费',
  DISCOUNT: '折扣',
  GUIDE: '导游',
  UPGRADE_CHANGE: '升舱/改期',
  OVERSALE: '超售',
};

// 佣金率（按产品类型，简化版 — 真实佣金由 CommissionRecord 表算）
const COMMISSION_RATE: Partial<Record<OrderItemKindLabel, number>> = {
  FLIGHT: 0.10, HOTEL: 0.08, TRANSFER: 0.15, VISA: 0.12,
};

// 开票状态
const INVOICE_LABEL: Record<string, string> = { NONE: '未开', REQUESTED: '待开', ISSUED: '已开' };
const INVOICE_COLOR: Record<string, string> = {
  NONE: 'bg-slate-100 text-slate-500',
  REQUESTED: 'bg-amber-100 text-amber-700',
  ISSUED: 'bg-emerald-100 text-emerald-700',
};
// 收款方式标签（线下确认收款用）
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  WECHAT_PAY: '微信', ALIPAY: '支付宝', BANK_CARD: '银行转账', AGENT_PREPAYMENT: '代理预付',
};

// 三模板筛选导出（全岗可用 / 票务专用 / 签证专用）
const TEMPLATE_LABEL: Record<OrderExportTemplate, string> = {
  full: '全岗可用',
  ticketing: '票务专用',
  visa: '签证专用',
};

// 签证状态复用下方 FF_STATUS_LABEL / FF_STATUS_COLOR（履约任务状态映射）

// 派生「签证状态」：订单有 VISA 项时，取其 VISA_APPLICATION 履约任务状态；无签证则 null
function deriveVisaStatus(o: OrderSummary): ApiFfStatus | null {
  const visaItem = o.items.find((i) => i.kind === 'VISA');
  if (!visaItem) return null;
  const task = visaItem.fulfillmentTasks?.find((t) => t.type === 'VISA_APPLICATION');
  return task?.status ?? 'PENDING';
}

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
  // 6/16 反馈（业务反馈）：按下单日期(createdAt)筛 — 用于"当天进单多少"的导出
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  // 5/20 反馈：按出行日期筛 + 是否已认领
  const [travelFrom, setTravelFrom] = useState('');
  const [travelTo, setTravelTo] = useState('');
  const [claimFilter, setClaimFilter] = useState<'' | 'unclaimed' | 'mine'>('');
  // ops 确认的三个筛选（航班号 / 乘客姓名 / 开票状态）— 后端过滤
  const [flightNumberFilter, setFlightNumberFilter] = useState('');
  const [passengerNameFilter, setPassengerNameFilter] = useState('');
  const [invoiceFilter, setInvoiceFilter] = useState<'' | InvoiceStatus>('');
  // 文本筛选防抖：停止输入 400ms 后才请求后端，避免每个键击打一次接口
  const [debouncedFlightNumber, setDebouncedFlightNumber] = useState('');
  const [debouncedPassengerName, setDebouncedPassengerName] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFlightNumber(flightNumberFilter), 400);
    return () => clearTimeout(t);
  }, [flightNumberFilter]);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedPassengerName(passengerNameFilter), 400);
    return () => clearTimeout(t);
  }, [passengerNameFilter]);
  // 三模板筛选导出（全岗可用/票务专用/签证专用）
  const [exportTemplate, setExportTemplate] = useState<OrderExportTemplate>('full');
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<OrderSummary | null>(null);
  // ── 批量管理状态 ─────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<OrderStatus | ''>('');
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkResult, setBulkResult] = useState<{
    successCount: number;
    failureCount: number;
    failures: Array<{ id: string; error?: string }>;
  } | null>(null);
  // 强制模式默认开（管理员手动改状态的核心场景就是绕开标准流转）
  const [forceMode, setForceMode] = useState(true);
  // 批量创单弹窗 + 列表刷新计数（建单后 +1 触发重新拉单）
  const [showBatchCreate, setShowBatchCreate] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // 拉取订单 — 下单日期/出行日期/claimFilter/航班号/乘客姓名/开票状态 变化时重拉（后端过滤）
  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query: ListOrdersParams = { pageSize: 200 };
    if (createdFrom) query.from = createdFrom; // 下单日期起（createdAt）
    if (createdTo) query.to = createdTo; // 下单日期止（createdAt）
    if (travelFrom) query.travelFrom = travelFrom;
    if (travelTo) query.travelTo = travelTo;
    if (claimFilter === 'unclaimed') query.unclaimedOnly = '1';
    if (debouncedFlightNumber.trim()) query.flightNumber = debouncedFlightNumber.trim();
    if (debouncedPassengerName.trim()) query.passengerName = debouncedPassengerName.trim();
    if (invoiceFilter) query.invoiceStatus = invoiceFilter;
    api.listOrders(tokens.accessToken, query)
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
  }, [tokens?.accessToken, createdFrom, createdTo, travelFrom, travelTo, claimFilter, debouncedFlightNumber, debouncedPassengerName, invoiceFilter, refreshNonce]);

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

  const advance = async (order: OrderSummary, next: OrderStatus, reason?: string, force?: boolean) => {
    if (!tokens?.accessToken) return;
    try {
      const res = await api.updateOrderStatus(tokens.accessToken, order.id, next, reason, force);
      setOrders((prev) => prev.map((o) => (o.id === order.id ? res.order : o)));
      setSelected((prev) => (prev && prev.id === order.id ? res.order : prev));
    } catch (err) {
      alert(err instanceof ApiError ? `操作失败：${err.message}` : '操作失败');
    }
  };

  const setInvoice = async (order: OrderSummary, invoiceStatus: InvoiceStatus) => {
    if (!tokens?.accessToken) return;
    try {
      await api.setInvoiceStatus(tokens.accessToken, order.id, invoiceStatus);
      setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, invoiceStatus } : o)));
    } catch (err) {
      alert(err instanceof ApiError ? `开票状态更新失败：${err.message}` : '开票状态更新失败');
    }
  };

  // ── 批量管理 helpers ─────────────────────────────────
  const visibleIds = useMemo(() => filtered.map(({ order }) => order.id), [filtered]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = !allVisibleSelected && visibleIds.some((id) => selectedIds.has(id));

  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const clearSelection = () => { setSelectedIds(new Set()); setBulkResult(null); };

  const applyBulkStatus = async () => {
    if (!tokens?.accessToken || !bulkStatus || selectedIds.size === 0) return;
    const confirmMsg = forceMode
      ? `强制将 ${selectedIds.size} 条订单改为「${STATUS_LABEL[bulkStatus as OrderStatus]}」？此操作绕过状态机校验。`
      : `按标准流转将 ${selectedIds.size} 条订单改为「${STATUS_LABEL[bulkStatus as OrderStatus]}」？不在允许路径的订单会失败。`;
    if (!window.confirm(confirmMsg)) return;
    setBulkSubmitting(true);
    setBulkResult(null);
    try {
      const ids = Array.from(selectedIds);
      const res = await api.batchUpdateOrderStatus(
        tokens.accessToken,
        ids,
        bulkStatus as OrderStatus,
        undefined,
        forceMode,
      );
      const updated = await api.listOrders(tokens.accessToken, { pageSize: 200 });
      setOrders(updated.orders);
      setBulkResult({
        successCount: res.successCount,
        failureCount: res.failureCount,
        failures: res.results.filter((r) => !r.success).map((r) => ({ id: r.id, error: r.error })),
      });
      if (res.failureCount === 0) {
        setSelectedIds(new Set());
        setBulkStatus('');
      }
    } catch (err) {
      alert(err instanceof ApiError ? `批量操作失败：${err.message}` : '批量操作失败');
    } finally {
      setBulkSubmitting(false);
    }
  };

  // 三模板筛选导出 — 用当前筛选条件调后端 xlsx，复用 createObjectURL 下载流
  const handleTemplateExport = async () => {
    if (!tokens?.accessToken) return;
    setExporting(true);
    try {
      const blob = await api.downloadOrdersTemplateExport(tokens.accessToken, {
        template: exportTemplate,
        status: statusFilter || undefined,
        kind: kindFilter || undefined,
        search: search.trim() || undefined,
        from: createdFrom || undefined, // 下单日期起（createdAt）— "当天进单多少"导出
        to: createdTo || undefined, // 下单日期止（createdAt）
        travelFrom: travelFrom || undefined,
        travelTo: travelTo || undefined,
        flightNumber: flightNumberFilter.trim() || undefined,
        passengerName: passengerNameFilter.trim() || undefined,
        invoiceStatus: invoiceFilter || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `订单导出-${TEMPLATE_LABEL[exportTemplate]}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      alert(err instanceof ApiError ? `导出失败：${err.message}` : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h1 className="page-title">订单管理</h1>
          <p className="page-sub">
            全渠道订单实时视图，可按状态和产品筛选，点击订单查看详情并操作状态流转。
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {(() => {
            const isFiltered = filtered.length !== orders.length;
            return (
              <span className={isFiltered ? 'badge-info' : 'badge-neutral'}>
                {loading
                  ? '加载中…'
                  : isFiltered
                    ? `${filtered.length} / ${orders.length} 条`
                    : `共 ${orders.length} 条`}
              </span>
            );
          })()}
          <button
            className="btn-primary text-sm"
            onClick={() => setShowBatchCreate(true)}
          >
            ＋ 批量创单
          </button>
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
          <select
            className="input max-w-[9.5rem] py-1.5 text-sm"
            value={exportTemplate}
            onChange={(e) => setExportTemplate(e.target.value as OrderExportTemplate)}
            disabled={exporting}
            title="选择导出模板（按当前筛选条件导出 xlsx）"
          >
            {(Object.keys(TEMPLATE_LABEL) as OrderExportTemplate[]).map((t) => (
              <option key={t} value={t}>《{TEMPLATE_LABEL[t]}》</option>
            ))}
          </select>
          <button
            className="btn-secondary text-sm"
            disabled={loading || exporting}
            onClick={() => void handleTemplateExport()}
            title="按当前筛选条件导出所选模板 xlsx"
          >
            {exporting ? '导出中…' : '📤 导出'}
          </button>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* 代理维度统计 */}
      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink">代理分销统计（仅含已付款订单）</h2>
          <span className="text-xs text-ink-muted">点击代理名称可过滤订单</span>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          <button
            className={`rounded-lg border p-3 text-left transition ${channelFilter === 'direct' && !agentFilter ? 'border-brand bg-brand-50 ring-1 ring-brand/20' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50/60'}`}
            onClick={() => { setChannelFilter('direct'); setAgentFilter(''); }}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-ink-soft">🏢 直销（散客/自营）</span>
              <span className="text-xs text-ink-muted">{agentStats.direct.orders} 单</span>
            </div>
            <div className="nums mt-1 text-lg font-semibold text-ink">¥{agentStats.direct.revenue.toLocaleString()}</div>
            <div className="text-xs text-ink-muted">无佣金</div>
          </button>
          {Array.from(agentStats.byAgent.entries()).slice(0, 2).map(([name, s]) => (
            <button
              key={name}
              className={`rounded-lg border p-3 text-left transition ${agentFilter === name ? 'border-brand bg-brand-50 ring-1 ring-brand/20' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50/60'}`}
              onClick={() => { setAgentFilter(agentFilter === name ? '' : name); setChannelFilter(''); }}
            >
              <div className="flex items-center justify-between">
                <span className="truncate text-sm font-medium text-ink-soft">🤝 {name}</span>
                <span className="text-xs text-ink-muted">{s.orders} 单</span>
              </div>
              <div className="nums mt-1 text-lg font-semibold text-ink">¥{s.revenue.toLocaleString()}</div>
              <div className="text-xs text-emerald-700">佣金 ¥{Math.round(s.commission).toLocaleString()}</div>
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
            <label className="label">下单时间 · 起始</label>
            <input
              type="date"
              className="input"
              value={createdFrom}
              max={createdTo || undefined}
              onChange={(e) => setCreatedFrom(e.target.value)}
              title="按下单日期（录入/创建时间）筛选，配合导出看当天进单量"
            />
          </div>
          <div>
            <label className="label">下单时间 · 截止</label>
            <input
              type="date"
              className="input"
              value={createdTo}
              min={createdFrom || undefined}
              onChange={(e) => setCreatedTo(e.target.value)}
              title="按下单日期（录入/创建时间）筛选，配合导出看当天进单量"
            />
          </div>
          <div>
            <label className="label">出行日期 · 起始</label>
            <input
              type="date"
              className="input"
              value={travelFrom}
              onChange={(e) => setTravelFrom(e.target.value)}
              title="按乘客实际出行日期筛选（与下单时间不同）"
            />
          </div>
          <div>
            <label className="label">出行日期 · 截止</label>
            <input
              type="date"
              className="input"
              value={travelTo}
              onChange={(e) => setTravelTo(e.target.value)}
              title="按乘客实际出行日期筛选（与下单时间不同）"
            />
          </div>
          <div>
            <label className="label">接单状态</label>
            <select
              className="input"
              value={claimFilter}
              onChange={(e) => setClaimFilter(e.target.value as '' | 'unclaimed' | 'mine')}
            >
              <option value="">全部</option>
              <option value="unclaimed">🆕 未接单</option>
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
          <div>
            <label className="label">航班号</label>
            <div className="relative">
              <input
                className="input"
                placeholder="如 VJ527"
                value={flightNumberFilter}
                onChange={(e) => setFlightNumberFilter(e.target.value)}
              />
              {flightNumberFilter !== debouncedFlightNumber && (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-muted">
                  搜索中…
                </span>
              )}
            </div>
          </div>
          <div>
            <label className="label">乘客姓名</label>
            <div className="relative">
              <input
                className="input"
                placeholder="模糊匹配"
                value={passengerNameFilter}
                onChange={(e) => setPassengerNameFilter(e.target.value)}
              />
              {passengerNameFilter !== debouncedPassengerName && (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-muted">
                  搜索中…
                </span>
              )}
            </div>
          </div>
          <div>
            <label className="label">开票状态</label>
            <select
              className="input"
              value={invoiceFilter}
              onChange={(e) => setInvoiceFilter(e.target.value as '' | InvoiceStatus)}
            >
              <option value="">全部</option>
              {(['NONE', 'REQUESTED', 'ISSUED'] as InvoiceStatus[]).map((s) => (
                <option key={s} value={s}>{INVOICE_LABEL[s]}</option>
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
        {(statusFilter || kindFilter || channelFilter || agentFilter || search || flightNumberFilter || passengerNameFilter || invoiceFilter || createdFrom || createdTo || travelFrom || travelTo) && (
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <span>显示 {filtered.length} 条订单</span>
            <button
              className="text-brand hover:text-brand-dark"
              onClick={() => {
                setStatusFilter(''); setKindFilter(''); setChannelFilter(''); setAgentFilter(''); setSearch('');
                setFlightNumberFilter(''); setPassengerNameFilter(''); setInvoiceFilter('');
                setCreatedFrom(''); setCreatedTo(''); setTravelFrom(''); setTravelTo('');
              }}
            >
              清除所有过滤
            </button>
          </div>
        )}
      </section>

      {/* ── 批量管理工具条 ───────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <section className="card border-brand bg-brand-50 ring-1 ring-brand/15">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-ink">
              已选 <span className="text-brand">{selectedIds.size}</span> 条订单
            </span>
            <span className="text-slate-300">|</span>
            <label className="text-sm text-ink-soft">改为：</label>
            <select
              className="input max-w-[10rem] py-1.5"
              value={bulkStatus}
              onChange={(e) => setBulkStatus(e.target.value as OrderStatus | '')}
              disabled={bulkSubmitting}
            >
              <option value="">选择目标状态…</option>
              {(Object.keys(STATUS_LABEL) as OrderStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-ink-soft">
              <input
                type="checkbox"
                className="accent-brand"
                checked={forceMode}
                onChange={(e) => setForceMode(e.target.checked)}
                disabled={bulkSubmitting}
              />
              <span>强制（绕过状态机校验）</span>
            </label>
            <button
              className="btn-primary text-sm py-1.5 disabled:opacity-50"
              onClick={() => void applyBulkStatus()}
              disabled={!bulkStatus || bulkSubmitting}
            >
              {bulkSubmitting ? '处理中…' : `应用到 ${selectedIds.size} 条`}
            </button>
            <button
              className="btn-ghost text-sm"
              onClick={clearSelection}
              disabled={bulkSubmitting}
            >
              清除选择
            </button>
          </div>
          {bulkResult && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
              <div className="text-ink-soft">
                ✓ 成功 {bulkResult.successCount} 条
                {bulkResult.failureCount > 0 && (
                  <span className="ml-3 text-rose-600">✗ 失败 {bulkResult.failureCount} 条</span>
                )}
              </div>
              {bulkResult.failures.length > 0 && (
                <ul className="mt-1 max-h-32 overflow-auto text-red-600">
                  {bulkResult.failures.map((f) => (
                    <li key={f.id} className="font-mono text-[11px]">· {f.id.slice(0, 8)}…：{f.error ?? '未知'}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th className="w-10 text-center">
                  <input
                    type="checkbox"
                    className="accent-brand"
                    aria-label="全选当前页"
                    checked={allVisibleSelected}
                    ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                    onChange={toggleAllVisible}
                  />
                </th>
                <th className="text-left">订单号</th>
                <th className="text-left">客户 / 代理</th>
                <th className="text-left">内容</th>
                <th className="text-right">金额</th>
                <th className="text-center">状态</th>
                <th className="text-center">签证</th>
                <th className="text-center">开票</th>
                <th className="text-left">下单时间</th>
                <th className="text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ order, view }) => (
                <tr key={order.id} className={selectedIds.has(order.id) ? 'bg-brand-50' : ''}>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      className="accent-brand"
                      aria-label={`选择订单 ${order.orderNumber}`}
                      checked={selectedIds.has(order.id)}
                      onChange={() => toggleRow(order.id)}
                    />
                  </td>
                  <td className="font-mono text-xs text-ink-soft">{order.orderNumber}</td>
                  <td>
                    <div className="font-medium text-ink">{view.customerName}</div>
                    <div className="text-xs text-ink-muted">{order.contactPhone}</div>
                    {view.agentName && (
                      <div className="badge-info mt-0.5">
                        {view.agentName}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="max-w-xs truncate text-ink" title={view.itemSummary}>
                      {view.itemSummary}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5">{KIND_LABEL[view.itemKind]}</span>
                      <span><span className="nums font-medium text-ink">{order.passengers.length}</span> 人</span>
                    </div>
                  </td>
                  <td className="nums text-right font-medium text-ink">
                    ¥{view.totalNum.toLocaleString()}
                  </td>
                  <td className="text-center">
                    <span className={STATUS_COLOR[order.status]}>
                      {STATUS_LABEL[order.status]}
                    </span>
                  </td>
                  <td className="text-center">
                    {(() => {
                      const vs = deriveVisaStatus(order);
                      return vs ? (
                        <span className={FF_STATUS_COLOR[vs]}>
                          {FF_STATUS_LABEL[vs] ?? vs}
                        </span>
                      ) : (
                        <span className="text-xs text-ink-muted">—</span>
                      );
                    })()}
                  </td>
                  <td className="text-center">
                    <select
                      className={`cursor-pointer rounded-md border-0 px-1.5 py-0.5 text-xs ${INVOICE_COLOR[order.invoiceStatus ?? 'NONE']}`}
                      value={order.invoiceStatus ?? 'NONE'}
                      onChange={(e) => void setInvoice(order, e.target.value as InvoiceStatus)}
                      title="开票状态（点击切换）"
                    >
                      {(['NONE', 'REQUESTED', 'ISSUED'] as InvoiceStatus[]).map((s) => (
                        <option key={s} value={s}>{INVOICE_LABEL[s]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="text-xs text-ink-muted">
                    {new Date(order.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                  <td>
                    <div className="flex items-center justify-end gap-2">
                      <select
                        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-ink-soft disabled:opacity-50"
                        value=""
                        onChange={(e) => {
                          const next = e.target.value as OrderStatus;
                          if (!next) return;
                          const msg = forceMode
                            ? `强制将 ${order.orderNumber} 改为「${STATUS_LABEL[next]}」？此操作绕过状态机校验。`
                            : `将 ${order.orderNumber} 改为「${STATUS_LABEL[next]}」？`;
                          if (window.confirm(msg)) void advance(order, next, undefined, forceMode);
                          e.target.value = '';
                        }}
                        title={forceMode ? '管理员强制改状态（绕过状态机）' : '按标准流转改状态'}
                      >
                        <option value="">改状态…</option>
                        {(Object.keys(STATUS_LABEL) as OrderStatus[])
                          .filter((s) => s !== order.status)
                          .map((s) => (
                            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                          ))}
                      </select>
                      <button className="text-sm font-medium text-brand hover:text-brand-dark" onClick={() => setSelected(order)}>
                        详情
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-ink-muted">
                    没有符合条件的订单
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-ink-muted">加载中…</td>
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
          onChanged={() => setRefreshNonce((n) => n + 1)}
        />
      )}

      {showBatchCreate && (
        <BatchCreateModal
          onClose={() => setShowBatchCreate(false)}
          onCreated={() => setRefreshNonce((n) => n + 1)}
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
  onChanged,
}: {
  order: OrderSummary;
  onClose: () => void;
  onAdvance: (next: OrderStatus, reason?: string) => void;
  onChanged?: () => void;
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
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <h2 className="text-base font-semibold text-ink">订单详情</h2>
          <button className="btn-ghost px-2 py-1 text-xl leading-none" onClick={onClose}>×</button>
        </div>

        <div className="px-6 py-5 space-y-6">
          <section>
            <div className="font-mono text-xs text-ink-muted">{order.orderNumber}</div>
            <div className="mt-2 flex items-center gap-2">
              <span className={STATUS_COLOR[order.status]}>
                {STATUS_LABEL[order.status]}
              </span>
              <span className="badge-neutral">
                {KIND_LABEL[view.itemKind]}
              </span>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">产品内容</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {order.items.map((it) => (
                <li key={it.id} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="text-ink">{it.description}</div>
                      <div className="mt-0.5 text-xs text-ink-muted">
                        {KIND_LABEL[it.kind]} · 数量 {it.quantity} · 单价 ¥{Number(it.unitPrice).toLocaleString()}
                      </div>
                    </div>
                    <div className="nums text-sm font-medium text-ink">
                      ¥{Number(it.amount).toLocaleString()}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-muted">共 {order.passengers.length} 位乘客</p>
          </section>

          <PassengersSection order={order} />

          <OpsToolbar order={order} onAdvance={onAdvance} />

          <NotesSection order={order} />

          <RemindersSection order={order} />

          {/* 财务/出纳：预期到账金额 + 订单杂项成本（仅 ADMIN/STAFF 可见，组件内做权限判断） */}
          <OrderFinanceSection
            orderId={order.id}
            initialExpectedAmountCny={order.expectedAmountCny}
            initialExpectedAmountLocked={order.expectedAmountLocked}
            onChanged={onChanged}
          />

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">客户信息</h3>
            <dl className="mt-2 space-y-1 text-sm">
              <Row label="联系人" value={order.contactName} />
              <Row label="联系电话" value={order.contactPhone} />
              {order.contactEmail && <Row label="邮箱" value={order.contactEmail} />}
              {view.agentName && <Row label="归属代理" value={view.agentName} />}
            </dl>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">支付</h3>
            <dl className="mt-2 space-y-1 text-sm">
              <Row
                label="订单金额"
                value={<span className="nums text-lg font-semibold text-ink">¥{view.totalNum.toLocaleString()}</span>}
              />
              <Row label="已付" value={<span className="nums">¥{Number(order.paidAmount).toLocaleString()}</span>} />
              <Row label="下单时间" value={new Date(order.createdAt).toLocaleString('zh-CN')} />
            </dl>
          </section>

          {/* 确认收款（线下收款 → 标记已付 + 上传截图）*/}
          <ConfirmPaymentSection
            orderId={order.id}
            total={view.totalNum}
            paidAmount={Number(order.paidAmount)}
            onChanged={onChanged}
          />

          {/* 履约 Fulfillment — 目前仍 mock，M6 接真实 FulfillmentTask 表 */}
          <FulfillmentSection orderId={order.id} />

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">状态流转</h3>
            <div className="mt-3 flex flex-col gap-2">
              {nextSteps.length === 0 && (
                <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-xs text-ink-muted">
                  当前状态下无可用操作
                </div>
              )}
              {nextSteps.map((s) => (
                <button key={s.to} className={`${s.style} text-sm`} onClick={() => onAdvance(s.to)}>
                  {s.label}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-ink-muted">
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
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right text-ink">{value}</dd>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 履约 Fulfillment — 目前还是 mock（M6 接真实 FulfillmentTask）
// ═══════════════════════════════════════════════════════════════

const FF_STATUS_COLOR: Record<FulfillmentStatus, string> = {
  PENDING: 'badge-neutral',
  IN_PROGRESS: 'badge-info',
  CONFIRMED: 'badge-success',
  CANCELLED: 'badge-neutral',
  FAILED: 'badge-danger',
};

const FF_STATUS_LABEL: Record<FulfillmentStatus, string> = {
  PENDING: '待处理', IN_PROGRESS: '处理中', CONFIRMED: '已确认', CANCELLED: '已取消', FAILED: '失败',
};

const FF_TYPE_LABEL: Record<FulfillmentTask['type'], { icon: string; label: string }> = {
  FLIGHT_TICKETING: { icon: '✈️', label: '机票出票' },
  HOTEL_BOOKING: { icon: '🏨', label: '酒店确认' },
  VISA_APPLICATION: { icon: '🛂', label: '签证办理' },
  TRANSFER_DISPATCH: { icon: '🚐', label: '地面服务调度' },
  BUNDLE_COMPOSITE: { icon: '🎁', label: '套餐履约' },
};

function FulfillmentSection({ orderId }: { orderId: string }) {
  const tokens = useAuth((s) => s.tokens);
  const [tasks, setTasks] = useState<FulfillmentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    api.listFulfillmentByOrder(tokens.accessToken, orderId)
      .then((r) => { if (!cancelled) setTasks(r.tasks); })
      .catch(() => {/* 忽略 */})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tokens?.accessToken, orderId]);

  const updateStatus = async (task: FulfillmentTask, status: ApiFfStatus, data?: Record<string, unknown>) => {
    if (!tokens?.accessToken) return;
    try {
      const body: Record<string, unknown> = { status };
      if (data) body.data = data;
      const res = await api.updateFulfillmentTask(tokens.accessToken, task.id, body);
      setTasks((prev) => prev.map((t) => (t.id === task.id ? res.task : t)));
      setEditing(null);
    } catch (e) {
      alert(e instanceof ApiError ? `操作失败：${e.message}` : '操作失败');
    }
  };

  if (loading) {
    return (
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">🚚 履约进度</h3>
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-xs text-ink-muted">加载中…</div>
      </section>
    );
  }
  if (tasks.length === 0) {
    return (
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">🚚 履约进度</h3>
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-xs text-ink-muted">
          暂无履约任务 · 订单转 PAID 时自动生成（按产品类型）
        </div>
      </section>
    );
  }

  const hasTicketed = tasks.some((t) => t.type === 'FLIGHT_TICKETING' && t.status === 'CONFIRMED');

  return (
    <section>
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">🚚 履约进度</h3>
        {hasTicketed && (
          <button
            className="text-xs rounded bg-blue-100 px-2 py-0.5 text-blue-700 hover:bg-blue-200"
            onClick={async () => {
              if (!tokens?.accessToken) return;
              try {
                const r = await api.resendItineraryEmail(tokens.accessToken, orderId);
                const res = r.result;
                if (res.status === 'sent') {
                  alert(`✓ 行程单已发送至 ${res.sentTo}`);
                } else if (res.status === 'not_all_ticketed') {
                  alert(`⚠ 还有 ${res.totalCount - res.ticketedCount} 段航班未出票，无法生成完整行程单。请等所有航段出票后再重发。`);
                } else if (res.status === 'smtp_disabled') {
                  alert(`⚠ SMTP 未配置，邮件未真发送（应发至 ${res.wouldSendTo}）。请联系运维配置 SMTP_HOST。`);
                } else if (res.status === 'no_flights') {
                  alert('该订单没有机票段，无行程单可发');
                } else {
                  alert('该订单没有联系邮箱，无法发送');
                }
              } catch (e) {
                alert(e instanceof ApiError ? `重发失败：${e.message}` : '重发失败');
              }
            }}
          >
            📧 重发行程单邮件
          </button>
        )}
      </div>
      <div className="mt-2 space-y-2">
        {tasks.map((t) => {
          const meta = FF_TYPE_LABEL[t.type];
          const data = (t.data as Record<string, string> | null) ?? {};
          const isEditing = editing === t.id;
          return (
            <FfCard key={t.id} icon={meta.icon} label={meta.label} status={t.status as FulfillmentStatus}>
              {t.type === 'FLIGHT_TICKETING' && !isEditing && (
                <>
                  <Row label="PNR" value={<span className="font-mono">{data.pnr ?? '（未生成）'}</span>} />
                  <Row label="电子票号" value={<span className="font-mono">{data.eTicketNumber ?? '—'}</span>} />
                </>
              )}
              {t.type === 'HOTEL_BOOKING' && !isEditing && (
                <Row label="确认号" value={<span className="font-mono">{data.confirmationNumber ?? '—'}</span>} />
              )}
              {t.type === 'VISA_APPLICATION' && !isEditing && (
                <>
                  <Row label="申请号" value={<span className="font-mono">{data.applicationNumber ?? '—'}</span>} />
                  <Row label="进度" value={data.progress ?? '—'} />
                </>
              )}
              {t.type === 'TRANSFER_DISPATCH' && !isEditing && (
                <>
                  <Row label="司机" value={data.driverName ?? '（未分配）'} />
                  <Row label="车牌" value={<span className="font-mono">{data.vehicleNumber ?? '—'}</span>} />
                </>
              )}
              {isEditing && (
                <FfEditForm
                  type={t.type}
                  initial={data}
                  onCancel={() => setEditing(null)}
                  onSave={(d) => updateStatus(t, 'CONFIRMED' as ApiFfStatus, d)}
                  draft={draft}
                  setDraft={setDraft}
                />
              )}
              {!isEditing && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {t.status === 'PENDING' && (
                    <button className="text-xs rounded bg-blue-100 px-2 py-0.5 text-blue-700 hover:bg-blue-200" onClick={() => updateStatus(t, 'IN_PROGRESS' as ApiFfStatus)}>▶ 开始处理</button>
                  )}
                  {(t.status === 'PENDING' || t.status === 'IN_PROGRESS') && (
                    <button className="text-xs rounded bg-green-100 px-2 py-0.5 text-green-700 hover:bg-green-200"
                      onClick={() => { setDraft(data); setEditing(t.id); }}>
                      ✓ 填数据并确认
                    </button>
                  )}
                  {t.status === 'IN_PROGRESS' && (
                    <button className="text-xs rounded bg-red-100 px-2 py-0.5 text-red-700 hover:bg-red-200" onClick={() => {
                      const reason = prompt('失败原因？');
                      if (reason !== null) updateStatus(t, 'FAILED' as ApiFfStatus);
                    }}>✗ 失败</button>
                  )}
                  {t.type === 'FLIGHT_TICKETING' && (t.status === 'CONFIRMED' || t.status === 'FAILED') && (
                    <button
                      className="text-xs rounded bg-amber-100 px-2 py-0.5 text-amber-700 hover:bg-amber-200"
                      onClick={async () => {
                        if (!tokens?.accessToken) return;
                        if (!confirm('强制重新出票？当前 PNR 会清空，任务重新排队执行。')) return;
                        try {
                          const res = await api.reissueFulfillmentTask(tokens.accessToken, t.id);
                          setTasks((prev) => prev.map((x) => (x.id === t.id ? res.task : x)));
                          alert('已重新排队，稍后刷新查看新 PNR');
                        } catch (e) {
                          alert(e instanceof ApiError ? `重出票失败：${e.message}` : '重出票失败');
                        }
                      }}
                    >
                      🔄 重新出票
                    </button>
                  )}
                </div>
              )}
            </FfCard>
          );
        })}
      </div>
    </section>
  );
}

function FfEditForm({ type, initial, onCancel, onSave, draft, setDraft }: {
  type: FulfillmentTask['type'];
  initial: Record<string, string>;
  onCancel: () => void;
  onSave: (data: Record<string, string>) => void;
  draft: Record<string, string>;
  setDraft: (d: Record<string, string>) => void;
}) {
  const fields: Array<{ key: string; label: string }> = type === 'FLIGHT_TICKETING'
    ? [{ key: 'pnr', label: 'PNR' }, { key: 'eTicketNumber', label: '电子票号' }]
    : type === 'HOTEL_BOOKING'
    ? [{ key: 'confirmationNumber', label: '酒店确认号' }]
    : type === 'VISA_APPLICATION'
    ? [{ key: 'applicationNumber', label: '签证申请号' }, { key: 'progress', label: '当前进度' }]
    : type === 'TRANSFER_DISPATCH'
    ? [{ key: 'driverName', label: '司机姓名' }, { key: 'vehicleNumber', label: '车牌' }]
    : [];

  return (
    <div className="mt-1 space-y-1">
      {fields.map((f) => (
        <div key={f.key} className="flex items-center gap-1">
          <label className="text-[10px] text-slate-500 w-16">{f.label}</label>
          <input
            className="flex-1 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
            defaultValue={initial[f.key] ?? ''}
            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
          />
        </div>
      ))}
      <div className="mt-1 flex gap-1">
        <button className="flex-1 text-xs rounded bg-brand px-2 py-1 text-white" onClick={() => onSave(draft)}>保存并确认</button>
        <button className="text-xs rounded bg-slate-100 px-2 py-1 text-slate-700" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

function FfCard({ icon, label, status, children }: { icon: string; label: string; status: FulfillmentStatus; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xl">{icon}</span>
          <span className="text-sm font-medium text-ink">{label}</span>
        </div>
        <span className={FF_STATUS_COLOR[status]}>
          {FF_STATUS_LABEL[status]}
        </span>
      </div>
      <dl className="space-y-0.5 text-xs">{children}</dl>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 5/20 反馈新增组件
// ═══════════════════════════════════════════════════════════════════════════

function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const today = new Date();
  return Math.floor((target.getTime() - today.getTime()) / 86400_000);
}

function PassengersSection({ order }: { order: OrderSummary }) {
  return (
    <section>
      <h3 className="text-sm font-medium text-slate-700">乘客 ({order.passengers.length})</h3>
      <ul className="mt-2 space-y-2 text-xs">
        {order.passengers.map((p) => {
          const passDaysLeft = daysUntil(p.passportExpiry);
          const passWarn = passDaysLeft !== null && passDaysLeft < 180;
          const passBlock = passDaysLeft !== null && passDaysLeft < 90;
          return (
            <li key={p.id} className="rounded-md border border-slate-200 bg-white p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="font-medium text-slate-900">
                    {p.fullName}
                    {p.gender && <span className="ml-2 text-xs text-slate-500">{p.gender === 'M' ? '男' : p.gender === 'F' ? '女' : '其他'}</span>}
                  </div>
                  <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
                    <dt>护照号</dt><dd className="font-mono">{p.documentNumber ?? '—'}</dd>
                    <dt>出生日期</dt><dd className="font-mono">{p.dateOfBirth?.slice(0, 10) ?? '—'}</dd>
                    <dt>国籍</dt><dd>{p.nationality ?? '—'}</dd>
                    <dt>类型</dt><dd>{p.passengerType ?? '—'}</dd>
                    {p.passportExpiry && (
                      <>
                        <dt>护照有效期</dt>
                        <dd className={`font-mono ${passBlock ? 'text-red-600 font-bold' : passWarn ? 'text-amber-600' : ''}`}>
                          {p.passportExpiry.slice(0, 10)}
                          {passDaysLeft !== null && (
                            <span className="ml-1 text-[10px]">
                              （剩 {passDaysLeft} 天{passBlock ? ' · 不足 3 月' : passWarn ? ' · 不足 6 月' : ''}）
                            </span>
                          )}
                        </dd>
                      </>
                    )}
                    {p.visaNumber && (
                      <>
                        <dt>签证号</dt><dd className="font-mono">{p.visaNumber}</dd>
                      </>
                    )}
                    {p.visaExpiry && (
                      <>
                        <dt>签证有效期</dt><dd className="font-mono">{p.visaExpiry.slice(0, 10)}</dd>
                      </>
                    )}
                  </dl>
                </div>
                {p.passportPhotoUrl && (
                  <a href={p.passportPhotoUrl} target="_blank" rel="noreferrer" className="shrink-0">
                    <img src={p.passportPhotoUrl} alt="passport" className="h-14 w-14 rounded border border-slate-300 object-cover" />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function OpsToolbar({ order }: { order: OrderSummary; onAdvance: (next: OrderStatus, reason?: string) => void }) {
  const tokens = useAuth((s) => s.tokens);
  const [busy, setBusy] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(order.claimedBy ?? null);

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handlePnr = async () => {
    if (!tokens?.accessToken) return;
    setBusy('pnr');
    try {
      const blob = await api.exportPnr(tokens.accessToken, order.id);
      downloadBlob(blob, `PNR_${order.orderNumber}.xlsx`);
    } catch (e) {
      alert(`导出失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setBusy(null);
    }
  };

  const handleZip = async () => {
    if (!tokens?.accessToken) return;
    setBusy('zip');
    try {
      const blob = await api.downloadPassportsZip(tokens.accessToken, order.id);
      downloadBlob(blob, `${order.orderNumber}-passports.zip`);
    } catch (e) {
      alert(`下载失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setBusy(null);
    }
  };

  const handleClaim = async () => {
    if (!tokens?.accessToken) return;
    setBusy('claim');
    try {
      const res = await api.claimOrder(tokens.accessToken, order.id);
      setClaimed(res.claimedBy);
    } catch (e) {
      alert(`认领失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-md border-2 border-brand/30 bg-brand/5 p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-brand">运营工具</h3>
        {claimed ? (
          <span className="text-xs text-slate-600">
            🤝 已认领 · {claimed.displayName ?? claimed.email ?? claimed.id}
          </span>
        ) : (
          <button
            className="rounded bg-amber-500 px-2 py-0.5 text-xs text-white hover:bg-amber-600 disabled:opacity-50"
            onClick={handleClaim}
            disabled={busy !== null}
          >
            {busy === 'claim' ? '认领中…' : '🙋 我接这单'}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          className="rounded bg-blue-600 px-2 py-1.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
          onClick={handlePnr}
          disabled={busy !== null}
        >
          {busy === 'pnr' ? '生成中…' : '📄 导出 PNR Excel'}
        </button>
        <button
          className="rounded bg-emerald-600 px-2 py-1.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
          onClick={handleZip}
          disabled={busy !== null}
        >
          {busy === 'zip' ? '打包中…' : '📦 打包护照图片'}
        </button>
      </div>
      <p className="mt-2 text-[10px] text-slate-500">
        PNR Excel = 航司提交格式（25 列）；护照 zip 含 README 列出缺照片的乘客。
      </p>
    </section>
  );
}

function NotesSection({ order }: { order: OrderSummary }) {
  const tokens = useAuth((s) => s.tokens);
  const [customerNotes, setCustomerNotes] = useState(order.notes ?? '');
  const [internalNotes, setInternalNotes] = useState(order.internalNotes ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = customerNotes !== (order.notes ?? '') || internalNotes !== (order.internalNotes ?? '');

  const save = async () => {
    if (!tokens?.accessToken) return;
    setSaving(true);
    try {
      await api.updateOrderNotes(tokens.accessToken, order.id, { notes: customerNotes, internalNotes });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      alert(`保存失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h3 className="text-sm font-medium text-slate-700">备注</h3>
      <div className="mt-2 space-y-2">
        <div>
          <label className="text-xs text-slate-500">客户备注（客户可见）</label>
          <textarea
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
            rows={2}
            value={customerNotes}
            onChange={(e) => setCustomerNotes(e.target.value)}
            placeholder="客户的特殊要求（如先发批文、酒店单过海关）"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">内部备注（仅运营可见）</label>
          <textarea
            className="mt-1 w-full rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs"
            rows={2}
            value={internalNotes}
            onChange={(e) => setInternalNotes(e.target.value)}
            placeholder="跨班次/跨部门的私下备忘"
          />
        </div>
        {dirty && (
          <div className="flex items-center gap-2">
            <button
              className="rounded bg-brand px-3 py-1 text-xs text-white disabled:opacity-50"
              onClick={save}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存备注'}
            </button>
            {saved && <span className="text-xs text-green-600">✓ 已保存</span>}
          </div>
        )}
      </div>
    </section>
  );
}

function RemindersSection({ order }: { order: OrderSummary }) {
  const tokens = useAuth((s) => s.tokens);
  const [reminders, setReminders] = useState(order.reminders ?? []);
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'>('NORMAL');
  const [newDueAt, setNewDueAt] = useState('');
  const [busy, setBusy] = useState(false);

  const addReminder = async () => {
    if (!tokens?.accessToken || !newTitle.trim()) return;
    setBusy(true);
    try {
      const res = await api.createReminder(tokens.accessToken, {
        orderId: order.id,
        title: newTitle.trim(),
        priority: newPriority,
        dueAt: newDueAt || undefined,
      });
      setReminders((prev) => [...prev, res.reminder]);
      setNewTitle('');
      setNewDueAt('');
    } catch (e) {
      alert(`新建失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (id: string, status: 'DONE' | 'SKIPPED') => {
    if (!tokens?.accessToken) return;
    try {
      const res = await api.resolveReminder(tokens.accessToken, id, { status });
      setReminders((prev) => prev.map((r) => (r.id === id ? { ...r, ...res.reminder } : r)));
    } catch (e) {
      alert(`操作失败：${e instanceof Error ? e.message : '未知错误'}`);
    }
  };

  const PRIORITY_LABEL: Record<string, string> = { LOW: '低', NORMAL: '中', HIGH: '高', CRITICAL: '🔴 紧急' };
  const STATUS_LABEL: Record<string, string> = { OPEN: '未处理', IN_PROGRESS: '处理中', DONE: '✓ 完成', SKIPPED: '⊘ 跳过' };

  return (
    <section>
      <h3 className="text-sm font-medium text-slate-700">待办 / 特殊提醒</h3>
      <ul className="mt-2 space-y-1">
        {reminders.length === 0 && <li className="text-xs text-slate-400">暂无待办</li>}
        {reminders.map((r) => (
          <li key={r.id} className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <span className={`mr-1 ${r.priority === 'CRITICAL' ? 'text-red-600 font-bold' : r.priority === 'HIGH' ? 'text-amber-600' : ''}`}>
                  [{PRIORITY_LABEL[r.priority]}]
                </span>
                <span>{r.title}</span>
                {r.dueAt && <span className="ml-1 text-[10px] text-slate-500">截止 {r.dueAt.slice(0, 10)}</span>}
                <div className="text-[10px] text-slate-400">{STATUS_LABEL[r.status]}</div>
              </div>
              {(r.status === 'OPEN' || r.status === 'IN_PROGRESS') && (
                <div className="flex gap-1">
                  <button
                    className="rounded bg-green-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-green-700"
                    onClick={() => resolve(r.id, 'DONE')}
                  >
                    ✓ 完成
                  </button>
                  <button
                    className="rounded bg-slate-400 px-1.5 py-0.5 text-[10px] text-white hover:bg-slate-500"
                    onClick={() => resolve(r.id, 'SKIPPED')}
                  >
                    ⊘ 跳过
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-2 rounded-md border border-dashed border-slate-300 p-2 space-y-1">
        <input
          className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
          placeholder="加一条待办，比如「2 日内拿批文」"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <div className="flex gap-1">
          <select
            className="rounded border border-slate-300 px-1.5 py-1 text-xs"
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value as 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL')}
          >
            <option value="LOW">低</option>
            <option value="NORMAL">中</option>
            <option value="HIGH">高</option>
            <option value="CRITICAL">🔴 紧急</option>
          </select>
          <input
            type="date"
            className="flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs"
            value={newDueAt}
            onChange={(e) => setNewDueAt(e.target.value)}
          />
          <button
            className="rounded bg-brand px-2 py-1 text-xs text-white disabled:opacity-50"
            onClick={addReminder}
            disabled={!newTitle.trim() || busy}
          >
            + 加待办
          </button>
        </div>
      </div>
    </section>
  );
}

// ── 批量散客建单弹窗 ────────────────────────────────────────────────
const CABIN_ZH: Record<string, string> = {
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '超级经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
};

interface BatchRow {
  fullName: string;
  documentNumber: string;
  dateOfBirth: string;
}

function BatchCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [flightId, setFlightId] = useState('');
  const [schedules, setSchedules] = useState<AdminSchedule[]>([]);
  const [scheduleId, setScheduleId] = useState('');
  const [cabin, setCabin] = useState<CabinClass | ''>('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<BatchRow[]>([{ fullName: '', documentNumber: '', dateOfBirth: '' }]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BatchCreateOrdersResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api
      .listAllFlights(token)
      .then((r) => setFlights(r.flights))
      .catch(() => setErr('航班列表加载失败'));
  }, [token]);

  useEffect(() => {
    if (!token || !flightId) {
      setSchedules([]);
      setScheduleId('');
      return;
    }
    api
      .listSchedules(token, flightId)
      .then((r) => setSchedules(r.schedules))
      .catch(() => setErr('班次加载失败'));
  }, [token, flightId]);

  const flight = flights.find((f) => f.id === flightId);
  const schedule = schedules.find((s) => s.id === scheduleId);
  const cabinOptions = schedule?.seatClasses ?? [];
  const validRows = rows.filter((r) => r.fullName.trim() && r.documentNumber.trim() && r.dateOfBirth);

  function setRow(i: number, patch: Partial<BatchRow>): void {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow(): void {
    setRows((prev) => [...prev, { fullName: '', documentNumber: '', dateOfBirth: '' }]);
  }
  function removeRow(i: number): void {
    setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));
  }
  function pasteNames(text: string): void {
    const names = text.split('\n').map((s) => s.trim()).filter(Boolean);
    if (names.length > 0) {
      setRows(names.map((n) => ({ fullName: n, documentNumber: '', dateOfBirth: '' })));
    }
  }

  async function submit(): Promise<void> {
    setErr(null);
    if (!scheduleId || !cabin) {
      setErr('请选择航班班次和舱位');
      return;
    }
    if (!contactName.trim() || !contactPhone.trim()) {
      setErr('请填联系人姓名和电话（全批次共享）');
      return;
    }
    if (validRows.length === 0) {
      setErr('至少要有一位完整乘客（姓名 + 护照号 + 出生日期）');
      return;
    }
    const departDate = schedule ? schedule.departureTime.slice(0, 10) : '';
    const description =
      `${flight?.flightNumber ?? ''} ${flight?.originCode ?? ''}→${flight?.destinationCode ?? ''} ${departDate} ${CABIN_ZH[cabin] ?? cabin}`.trim();
    setSubmitting(true);
    try {
      const res = await api.batchCreateOrders(token, {
        flightScheduleId: scheduleId,
        flightCabin: cabin,
        description,
        contactName: contactName.trim(),
        contactPhone: contactPhone.trim(),
        notes: notes.trim() || undefined,
        passengers: validRows.map((r) => ({
          fullName: r.fullName.trim(),
          documentNumber: r.documentNumber.trim(),
          dateOfBirth: r.dateOfBirth,
          nationality: 'CN',
        })),
      });
      setResult(res);
      if (res.successCount > 0) onCreated();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '批量创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="my-8 w-full max-w-3xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">批量创单（散客 · 每位乘客一单）</h2>
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose}>✕</button>
        </div>

        {result ? (
          <div className="space-y-4 p-5">
            <div className="rounded-md bg-slate-50 px-4 py-3 text-sm">
              成功 <b className="text-emerald-700">{result.successCount}</b> 单 ·
              失败 <b className="text-rose-700">{result.failureCount}</b> 单
            </div>
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th className="py-1.5 text-left font-normal">乘客</th>
                    <th className="py-1.5 text-left font-normal">结果</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((r) => (
                    <tr key={r.index} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 text-slate-900">{r.passengerName}</td>
                      <td className="py-1.5">
                        {r.success ? (
                          <span className="text-emerald-700">✓ {r.orderNumber}</span>
                        ) : (
                          <span className="text-rose-600">✕ {r.error}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <button
                className="btn-secondary text-sm"
                onClick={() => {
                  setResult(null);
                  setRows([{ fullName: '', documentNumber: '', dateOfBirth: '' }]);
                }}
              >
                再建一批
              </button>
              <button className="btn-primary text-sm" onClick={onClose}>完成</button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            {err && <div className="rounded-md bg-rose-50 px-4 py-2 text-sm text-rose-700">{err}</div>}

            {/* 航班 + 班次 + 舱位 */}
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-xs text-slate-500">
                航班
                <select
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  value={flightId}
                  onChange={(e) => setFlightId(e.target.value)}
                >
                  <option value="">选择航班…</option>
                  {flights.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.flightNumber} {f.originCode}→{f.destinationCode}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500">
                班次（出发日期）
                <select
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  value={scheduleId}
                  onChange={(e) => { setScheduleId(e.target.value); setCabin(''); }}
                  disabled={!flightId}
                >
                  <option value="">选择班次…</option>
                  {schedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.departureTime.slice(0, 16).replace('T', ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500">
                舱位
                <select
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  value={cabin}
                  onChange={(e) => setCabin(e.target.value as CabinClass)}
                  disabled={!scheduleId}
                >
                  <option value="">选择舱位…</option>
                  {cabinOptions.map((c) => (
                    <option key={c.id} value={c.cabin}>
                      {CABIN_ZH[c.cabin] ?? c.cabin}（余 {c.capacity - c.sold}）¥{Number(c.basePrice).toFixed(0)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* 共享联系人 */}
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-xs text-slate-500">
                联系人姓名（共享）
                <input className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" value={contactName} onChange={(e) => setContactName(e.target.value)} />
              </label>
              <label className="text-xs text-slate-500">
                联系电话（共享）
                <input className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
              </label>
              <label className="text-xs text-slate-500">
                备注（选填，写入每单）
                <input className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
            </div>

            {/* 快速粘贴姓名 */}
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">快速粘贴姓名（每行一个 → 自动生成行，护照号/生日再补）</summary>
              <textarea
                className="mt-2 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                rows={3}
                placeholder={'张三\n李四\n王五'}
                onChange={(e) => pasteNames(e.target.value)}
              />
            </details>

            {/* 乘客表格 */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">乘客名单（每位一单 · 共 {validRows.length} 位有效）</span>
                <button className="text-sm text-brand hover:text-brand-dark" onClick={addRow}>＋ 加一行</button>
              </div>
              <div className="max-h-60 overflow-y-auto rounded-md border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-normal">姓名</th>
                      <th className="px-2 py-1.5 text-left font-normal">护照号</th>
                      <th className="px-2 py-1.5 text-left font-normal">出生日期</th>
                      <th className="px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="px-2 py-1">
                          <input className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm" value={r.fullName} onChange={(e) => setRow(i, { fullName: e.target.value })} />
                        </td>
                        <td className="px-2 py-1">
                          <input className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm" value={r.documentNumber} onChange={(e) => setRow(i, { documentNumber: e.target.value })} />
                        </td>
                        <td className="px-2 py-1">
                          <input type="date" className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm" value={r.dateOfBirth} onChange={(e) => setRow(i, { dateOfBirth: e.target.value })} />
                        </td>
                        <td className="px-2 py-1 text-right">
                          <button className="text-xs text-slate-400 hover:text-rose-600" onClick={() => removeRow(i)} disabled={rows.length <= 1}>删</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 pt-3">
              <span className="text-xs text-slate-500">将创建 {validRows.length} 张订单（机票 × 1/人）</span>
              <div className="flex gap-2">
                <button className="btn-secondary text-sm" onClick={onClose}>取消</button>
                <button className="btn-primary text-sm disabled:opacity-50" onClick={submit} disabled={submitting}>
                  {submitting ? '创建中…' : `批量创建 ${validRows.length} 单`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 确认收款（线下收款 → 标记已付 + 上传截图）────────────────────────
function ConfirmPaymentSection({
  orderId,
  total,
  paidAmount,
  onChanged,
}: {
  orderId: string;
  total: number;
  paidAmount: number;
  onChanged?: () => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const [payments, setPayments] = useState<OrderPayment[]>([]);
  const [paid, setPaid] = useState(paidAmount);
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('BANK_CARD');
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const remaining = Math.max(0, Math.round((total - paid) * 100) / 100);

  // 拉订单详情拿现有收款记录 + 最新已付
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .getOrder(token, orderId)
      .then((r) => {
        if (cancelled) return;
        setPayments(r.order.payments ?? []);
        const p = Number(r.order.paidAmount);
        setPaid(p);
        const due = Math.max(0, Math.round((total - p) * 100) / 100);
        setAmount(due > 0 ? due : null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token, orderId, total]);

  function onFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) {
      setErr('截图过大（>4MB），请压缩后再传');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setProofUrl(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(f);
  }

  // 幂等键：同一次收款（含双击/网络重试）只入账一次；成功后换新键
  const makeIdemKey = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `mc-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const [idemKey, setIdemKey] = useState(makeIdemKey);

  async function confirm(): Promise<void> {
    if (!token || submitting) return;
    setErr(null);
    const amt = amount ?? undefined;
    if (amt !== undefined && (!Number.isFinite(amt) || amt <= 0)) {
      setErr('金额需为正数');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.confirmPayment(token, {
        orderId,
        amount: amt,
        method,
        proofUrl: proofUrl ?? undefined,
        note: note.trim() || undefined,
        idempotencyKey: idemKey,
      });
      setPaid(res.paidAmount);
      setProofUrl(null);
      setNote('');
      setIdemKey(makeIdemKey());
      const r = await api.getOrder(token, orderId);
      setPayments(r.order.payments ?? []);
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '确认收款失败');
    } finally {
      setSubmitting(false);
    }
  }

  const settled = remaining <= 0;

  return (
    <section>
      <h3 className="text-sm font-medium text-slate-700">收款</h3>
      <div className="mt-2 rounded-md border border-slate-200 p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-slate-500">已付 / 应收</span>
          <span>
            <b className="text-emerald-700">¥{paid.toLocaleString()}</b>
            <span className="text-slate-400"> / ¥{total.toLocaleString()}</span>
            {settled ? (
              <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">已结清</span>
            ) : (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">应收 ¥{remaining.toLocaleString()}</span>
            )}
          </span>
        </div>

        {/* 已记录收款 */}
        {payments.length > 0 && (
          <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-xs text-slate-600">
                <span>{PAYMENT_METHOD_LABEL[p.method] ?? p.method}</span>
                <span className="font-medium">¥{Number(p.amount).toLocaleString()}</span>
                <span className="text-slate-400">{p.paidAt ? new Date(p.paidAt).toLocaleDateString('zh-CN') : ''}</span>
                {p.proofUrl && (
                  <a href={p.proofUrl} target="_blank" rel="noreferrer" className="ml-auto">
                    <img src={p.proofUrl} alt="收款截图" className="h-8 w-8 rounded border border-slate-300 object-cover" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* 确认收款表单 */}
        {!settled && (
          <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
            {err && <div className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</div>}
            <div className="flex gap-2">
              <label className="flex-1 text-xs text-slate-500">
                收款金额
                <NumberInput
                  step={0.01}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                  value={amount}
                  onChange={(n) => setAmount(n)}
                  placeholder={`默认应收 ¥${remaining}`}
                />
              </label>
              <label className="flex-1 text-xs text-slate-500">
                收款方式
                <select
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                >
                  {(['BANK_CARD', 'WECHAT_PAY', 'ALIPAY', 'AGENT_PREPAYMENT'] as PaymentMethod[]).map((m) => (
                    <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block text-xs text-slate-500">
              备注（选填）
              <input
                className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <span className="rounded-md border border-slate-300 px-2 py-1 cursor-pointer hover:bg-slate-50">📷 上传收款截图</span>
                <input type="file" accept="image/*" className="hidden" onChange={onFile} />
                {proofUrl && <img src={proofUrl} alt="预览" className="h-8 w-8 rounded border border-slate-300 object-cover" />}
              </label>
              <button
                className="btn-primary text-sm disabled:opacity-50"
                onClick={confirm}
                disabled={submitting}
              >
                {submitting ? '确认中…' : '确认收款'}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
