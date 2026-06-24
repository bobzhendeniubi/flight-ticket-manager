import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, SETTLEMENT_MODE_LABEL, type OrderSummary, type OrderItem, type OrderStatus, type FulfillmentTask, type FulfillmentStatus as ApiFfStatus, type AdminFlight, type AdminSchedule, type CabinClass, type BatchCreateOrdersResult, type InvoiceStatus, type PaymentMethod, type OrderPayment, type ListOrdersParams, type OrderExportTemplate, type SettlementMode, type VisaStatusInput, VISA_STATUS_LABEL, type BatchProductType, type Bundle } from '../lib/api';
import { useAuth } from '../stores/auth';
import {
  type FulfillmentStatus,
} from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';
import { NumberInput } from '../components/NumberInput';
import { OrderFinanceSection } from '../components/OrderFinanceSection';
import { SingleOrderModal } from '../components/SingleOrderModal';

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
  const visaItem = (o.items ?? []).find((i) => i.kind === 'VISA');
  if (!visaItem) return null;
  const task = visaItem.fulfillmentTasks?.find((t) => t.type === 'VISA_APPLICATION');
  return task?.status ?? 'PENDING';
}

// ── 辅助：从 OrderSummary 派生视图字段 ──────────────────────────────
function deriveView(o: OrderSummary) {
  const first = (o.items ?? [])[0];
  const itemKind: OrderItemKindLabel = first?.kind ?? 'FLIGHT';
  const summaryParts = (o.items ?? []).map((it) =>
    it.quantity > 1 ? `${it.description} × ${it.quantity}` : it.description,
  );
  const itemSummary = summaryParts.join(' + ');
  const customerName = o.user?.displayName ?? o.contactName;
  const agentName = o.agent?.companyName ?? o.agent?.contactName ?? null;
  const totalNum = Number(o.total);
  return { itemKind, itemSummary, customerName, agentName, totalNum };
}

// 尾款 = 应收(total + 售后费用 adjustmentCny) − 已到账(paidAmount)。
// 正=欠款(少付)、0=已结清、负=多付。用 2 位小数四舍五入避免浮点毛刺。
function deriveBalance(o: OrderSummary): { total: number; adjustment: number; paid: number; balance: number } {
  const total = Number(o.total) || 0;
  const adjustment = Number(o.adjustmentCny) || 0;
  const paid = Number(o.paidAmount) || 0;
  const balance = Math.round((total + adjustment - paid) * 100) / 100;
  return { total, adjustment, paid, balance };
}

// 尾款徽标：少付=琥珀(欠款)、结清=绿、多付=蓝(highlight)。
// 月结代理：尾款>0 不按欠款告警，改为中性蓝「月结挂账」（月末统一对账）。
function BalanceBadge({ balance, settlementMode }: { balance: number; settlementMode?: SettlementMode }) {
  if (balance > 0) {
    if (settlementMode === 'MONTHLY') {
      return (
        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700">
          月结挂账 ¥{balance.toLocaleString()}
        </span>
      );
    }
    return (
      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
        欠 ¥{balance.toLocaleString()}
      </span>
    );
  }
  if (balance < 0) {
    return (
      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700">
        多付 ¥{Math.abs(balance).toLocaleString()}
      </span>
    );
  }
  return (
    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
      已结清
    </span>
  );
}

export function OrdersPage() {
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);
  const isAdmin = user?.role === 'ADMIN';
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
  // 批量到账弹窗（选多单 → 逐单录到账金额 + 共享水单）
  const [showBatchPay, setShowBatchPay] = useState(false);
  // 批量创单弹窗 + 单笔录单弹窗 + 列表刷新计数（建单后 +1 触发重新拉单）
  const [showBatchCreate, setShowBatchCreate] = useState(false);
  const [showSingleCreate, setShowSingleCreate] = useState(false);
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

  // 删除订单（仅 ADMIN）：取消 + 释放机位/酒店库存
  const deleteOrder = async (order: OrderSummary) => {
    if (!tokens?.accessToken) return;
    const confirmed = window.confirm(
      `删除订单 ${order.orderNumber}？\n\n删除后机位/酒店将退回库存，且不可恢复。`,
    );
    if (!confirmed) return;
    try {
      const res = await api.updateOrderStatus(
        tokens.accessToken,
        order.id,
        'CANCELLED',
        '录入错误删除',
        true, // force
      );
      setOrders((prev) => prev.map((o) => (o.id === order.id ? res.order : o)));
      setSelected((prev) => (prev && prev.id === order.id ? res.order : prev));
    } catch (err) {
      alert(err instanceof ApiError ? `删除失败：${err.message}` : '删除失败');
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

  // 当前选中的订单对象（批量到账弹窗用）
  const selectedOrders = useMemo(
    () => orders.filter((o) => selectedIds.has(o.id)),
    [orders, selectedIds],
  );
  // 可批量到账的订单 = 还没结清的（尾款 > 0）。已结清/多付的不重复到账。
  const payableSelected = useMemo(
    () => selectedOrders.filter((o) => deriveBalance(o).balance > 0),
    [selectedOrders],
  );

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
            onClick={() => setShowSingleCreate(true)}
            title="按产品类型录一笔订单（机票/酒店/签证/套餐/接送）"
          >
            ＋ 录单
          </button>
          <button
            className="btn-secondary text-sm"
            onClick={() => setShowBatchCreate(true)}
            title="按航班班次批量录散客机票（每位乘客一单）"
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
            <span className="text-slate-300">|</span>
            <button
              className="btn-secondary text-sm py-1.5 disabled:opacity-50"
              onClick={() => setShowBatchPay(true)}
              disabled={bulkSubmitting || payableSelected.length === 0}
              title={
                payableSelected.length === 0
                  ? '所选订单均已结清，无需到账'
                  : '逐单录入到账金额（默认=尾款）+ 共享水单'
              }
            >
              💰 批量到账（{payableSelected.length} 条待收）
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
                <th className="text-center">尾款</th>
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
                    <BalanceBadge balance={deriveBalance(order).balance} />
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
                      {isAdmin && (
                        <button
                          className="text-xs text-rose-500 hover:text-rose-700"
                          title="删除订单（ADMIN）"
                          onClick={() => void deleteOrder(order)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-ink-muted">
                    没有符合条件的订单
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-ink-muted">加载中…</td>
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
          onOrderUpdated={(updated) => {
            setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
            setSelected((prev) => (prev && prev.id === updated.id ? updated : prev));
          }}
          onDelete={() => {
            void deleteOrder(selected);
          }}
          isAdmin={isAdmin}
        />
      )}

      {showBatchPay && (
        <BatchPayModal
          orders={payableSelected}
          onClose={() => setShowBatchPay(false)}
          onDone={(succeededIds) => {
            setRefreshNonce((n) => n + 1);
            // 成功到账的从选择集移除，避免重复操作
            if (succeededIds.length > 0) {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                succeededIds.forEach((id) => next.delete(id));
                return next;
              });
            }
          }}
        />
      )}

      {showBatchCreate && (
        <BatchCreateModal
          onClose={() => setShowBatchCreate(false)}
          onCreated={() => setRefreshNonce((n) => n + 1)}
        />
      )}

      {showSingleCreate && (
        <SingleOrderModal
          onClose={() => setShowSingleCreate(false)}
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
  onOrderUpdated,
  onDelete,
  isAdmin,
}: {
  order: OrderSummary;
  onClose: () => void;
  onAdvance: (next: OrderStatus, reason?: string) => void;
  onChanged?: () => void;
  /** 售后改期/换人后用更新后的订单就地刷新抽屉与列表 */
  onOrderUpdated?: (order: OrderSummary) => void;
  /** 删除订单（ADMIN 专用） */
  onDelete?: () => void;
  isAdmin?: boolean;
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
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={STATUS_COLOR[order.status]}>
                {STATUS_LABEL[order.status]}
              </span>
              <span className="badge-neutral">
                {KIND_LABEL[view.itemKind]}
              </span>
              {order.visaStatus && (
                <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${VISA_STATUS_BADGE[order.visaStatus]}`}>
                  签证：{VISA_STATUS_LABEL[order.visaStatus]}
                </span>
              )}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">产品内容</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {(order.items ?? []).map((it) => (
                <OrderItemRow
                  key={it.id}
                  orderId={order.id}
                  item={it}
                  onOrderUpdated={onOrderUpdated}
                  isAdmin={isAdmin}
                />
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-muted">共 {order.passengers.length} 位乘客</p>
          </section>

          <AdjustmentsSection order={order} />

          <PassengersSection order={order} onOrderUpdated={onOrderUpdated} />

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
            {(() => {
              const bal = deriveBalance(order);
              return (
                <dl className="mt-2 space-y-1 text-sm">
                  <Row
                    label="订单金额"
                    value={<span className="nums text-lg font-semibold text-ink">¥{view.totalNum.toLocaleString()}</span>}
                  />
                  {bal.adjustment !== 0 && (
                    <Row
                      label="售后费用"
                      value={<span className="nums text-ink">¥{bal.adjustment.toLocaleString()}</span>}
                    />
                  )}
                  <Row label="已付" value={<span className="nums">¥{bal.paid.toLocaleString()}</span>} />
                  <Row
                    label="尾款"
                    value={<BalanceBadge balance={bal.balance} settlementMode={order.agent?.settlementMode} />}
                  />
                  <Row label="下单时间" value={new Date(order.createdAt).toLocaleString('zh-CN')} />
                </dl>
              );
            })()}
          </section>

          {/* 确认收款（线下收款 → 标记已付 + 上传截图）。应收 = 订单金额 + 售后费用 */}
          <ConfirmPaymentSection
            orderId={order.id}
            total={view.totalNum + (Number(order.adjustmentCny) || 0)}
            paidAmount={Number(order.paidAmount)}
            agent={order.agent}
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

          {isAdmin && onDelete && (
            <section className="border-t border-rose-100 pt-3">
              <button
                className="w-full rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
                onClick={onDelete}
              >
                删除订单（ADMIN）
              </button>
              <p className="mt-1 text-[11px] text-rose-400">
                删除后机位/酒店将退回库存，且不可恢复。
              </p>
            </section>
          )}
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

// 班次展示文案：起飞→到达（本地时间）
function scheduleLabel(s: AdminSchedule): string {
  const dep = new Date(s.departureTime).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const arr = new Date(s.arrivalTime).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${dep} → ${arr}`;
}

// ── 产品内容行：FLIGHT 项可「改期」（换班次/日期 + 改舱位 + 改期费）──────
function OrderItemRow({
  orderId,
  item,
  onOrderUpdated,
  isAdmin,
}: {
  orderId: string;
  item: OrderItem;
  onOrderUpdated?: (order: OrderSummary) => void;
  isAdmin?: boolean;
}) {
  const [rescheduling, setRescheduling] = useState(false);
  const [editingPrice, setEditingPrice] = useState(false);
  const isFlight = item.kind === 'FLIGHT';

  return (
    <li className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="text-ink">{item.description}</div>
          <div className="mt-0.5 text-xs text-ink-muted">
            {KIND_LABEL[item.kind]} · 数量 {item.quantity} · 单价 ¥{Number(item.unitPrice).toLocaleString()}
            {item.flightCabin && <> · {CABIN_ZH[item.flightCabin] ?? item.flightCabin}</>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="nums text-sm font-medium text-ink">¥{Number(item.amount).toLocaleString()}</div>
          {isFlight && !rescheduling && !editingPrice && (
            <button
              className="text-[11px] font-medium text-brand hover:text-brand-dark"
              onClick={() => setRescheduling(true)}
            >
              改期
            </button>
          )}
          {isFlight && isAdmin && !rescheduling && !editingPrice && (
            <button
              className="text-[11px] font-medium text-amber-600 hover:text-amber-800"
              onClick={() => setEditingPrice(true)}
            >
              改结算价
            </button>
          )}
        </div>
      </div>
      {isFlight && rescheduling && (
        <RescheduleForm
          orderId={orderId}
          item={item}
          onCancel={() => setRescheduling(false)}
          onSaved={(updated) => {
            setRescheduling(false);
            onOrderUpdated?.(updated);
          }}
        />
      )}
      {isFlight && editingPrice && (
        <SettlementPriceForm
          orderId={orderId}
          itemId={item.id}
          currentPrice={Number(item.unitPrice)}
          onCancel={() => setEditingPrice(false)}
          onSaved={(updated) => {
            setEditingPrice(false);
            onOrderUpdated?.(updated);
          }}
        />
      )}
    </li>
  );
}

function RescheduleForm({
  orderId,
  item,
  onCancel,
  onSaved,
}: {
  orderId: string;
  item: OrderItem;
  onCancel: () => void;
  onSaved: (order: OrderSummary) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [flightId, setFlightId] = useState('');
  const [schedules, setSchedules] = useState<AdminSchedule[]>([]);
  const [newScheduleId, setNewScheduleId] = useState('');
  const [newCabin, setNewCabin] = useState<CabinClass | ''>(item.flightCabin ?? '');
  const [feeCny, setFeeCny] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [loadingSchedules, setLoadingSchedules] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api.listAllFlights(token)
      .then((r) => { if (!cancelled) setFlights(r.flights); })
      .catch(() => { if (!cancelled) setErr('航班列表加载失败'); });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (!token || !flightId) { setSchedules([]); setNewScheduleId(''); return; }
    let cancelled = false;
    setLoadingSchedules(true);
    api.listSchedules(token, flightId)
      .then((r) => { if (!cancelled) setSchedules(r.schedules.filter((s) => s.isActive)); })
      .catch(() => { if (!cancelled) setErr('班次加载失败'); })
      .finally(() => { if (!cancelled) setLoadingSchedules(false); });
    return () => { cancelled = true; };
  }, [token, flightId]);

  const selectedSchedule = schedules.find((s) => s.id === newScheduleId);
  const cabinOptions = selectedSchedule?.seatClasses ?? [];

  const submit = async () => {
    if (!token || submitting) return;
    setErr(null);
    if (!newScheduleId) { setErr('请选择新班次'); return; }
    if (!confirm('确认改期？座位会移动到新班次（新班次售罄会被拒绝），如填了改期费将计入订单尾款。')) return;
    setSubmitting(true);
    try {
      const res = await api.rescheduleOrder(token, orderId, {
        orderItemId: item.id,
        newScheduleId,
        newCabin: newCabin || undefined,
        feeCny: feeCny != null && feeCny > 0 ? feeCny : undefined,
        feeLabel: feeCny != null && feeCny > 0 ? '改期费' : undefined,
        note: note.trim() || undefined,
      });
      onSaved(res.order);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '改期失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 space-y-2 rounded-md border border-brand/40 bg-white p-3 text-xs">
      <div className="font-medium text-brand">改期 · 当前：{item.description}{item.flightCabin && ` · ${CABIN_ZH[item.flightCabin] ?? item.flightCabin}`}</div>

      <label className="block">
        <span className="text-slate-500">选航班</span>
        <select
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
          value={flightId}
          onChange={(e) => setFlightId(e.target.value)}
        >
          <option value="">选择航班…</option>
          {flights.map((f) => (
            <option key={f.id} value={f.id}>
              {f.flightNumber} · {f.originCode}→{f.destinationCode}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-slate-500">新班次{loadingSchedules && '（加载中…）'}</span>
        <select
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
          value={newScheduleId}
          onChange={(e) => setNewScheduleId(e.target.value)}
          disabled={!flightId || loadingSchedules}
        >
          <option value="">选择班次…</option>
          {schedules.map((s) => (
            <option key={s.id} value={s.id}>{scheduleLabel(s)}</option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-slate-500">新舱位（可选）</span>
        <select
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
          value={newCabin}
          onChange={(e) => setNewCabin(e.target.value as CabinClass | '')}
          disabled={!selectedSchedule}
        >
          <option value="">沿用原舱位</option>
          {cabinOptions.map((c) => (
            <option key={c.id} value={c.cabin}>{CABIN_ZH[c.cabin] ?? c.cabin}</option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-slate-500">改期费（¥，可选）</span>
        <NumberInput
          value={feeCny}
          onChange={setFeeCny}
          integerOnly
          placeholder="不收改期费则留空"
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
        />
      </label>

      <label className="block">
        <span className="text-slate-500">备注（可选）</span>
        <input
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="如：客户主动改期 / 航变"
        />
      </label>

      {err && <div className="rounded bg-red-50 px-2 py-1 text-red-700">{err}</div>}

      <div className="flex gap-2 pt-1">
        <button
          className="flex-1 rounded bg-brand px-2 py-1.5 font-medium text-white disabled:opacity-50"
          onClick={submit}
          disabled={submitting || !newScheduleId}
        >
          {submitting ? '改期中…' : '确认改期'}
        </button>
        <button
          className="rounded bg-slate-100 px-3 py-1.5 text-slate-700 disabled:opacity-50"
          onClick={onCancel}
          disabled={submitting}
        >
          取消
        </button>
      </div>
    </div>
  );
}

// ── 改结算价（ADMIN）: 修订机票行单价 → 后端重算 order.total ────────────
function SettlementPriceForm({
  orderId,
  itemId,
  currentPrice,
  onCancel,
  onSaved,
}: {
  orderId: string;
  itemId: string;
  currentPrice: number;
  onCancel: () => void;
  onSaved: (order: OrderSummary) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const [newPrice, setNewPrice] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (newPrice === null || newPrice <= 0) {
      setErr('请输入大于 0 的结算价');
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      const res = await api.updateItemSettlementPrice(token, orderId, itemId, {
        unitPriceCny: newPrice,
        reason: reason.trim() || undefined,
      });
      onSaved(res.order);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '改价失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded border border-amber-200 bg-amber-50/60 p-2 text-xs">
      <div className="font-medium text-amber-800">改结算价（ADMIN）· 当前 ¥{currentPrice.toLocaleString()}</div>
      <label className="block">
        <span className="text-slate-500">新单价（¥，必填，大于 0）</span>
        <NumberInput
          value={newPrice}
          onChange={setNewPrice}
          min={1}
          integerOnly
          placeholder="如 1580"
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
        />
      </label>
      <label className="block">
        <span className="text-slate-500">原因（可选）</span>
        <input
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="如：补录团队价"
        />
      </label>
      {err && <div className="rounded bg-rose-50 px-2 py-1 text-rose-700">{err}</div>}
      <div className="flex gap-2 pt-1">
        <button
          className="flex-1 rounded bg-amber-600 px-2 py-1.5 font-medium text-white disabled:opacity-50"
          onClick={submit}
          disabled={submitting || newPrice === null || newPrice <= 0}
        >
          {submitting ? '保存中…' : '确认改价'}
        </button>
        <button
          className="rounded bg-slate-100 px-3 py-1.5 text-slate-700 disabled:opacity-50"
          onClick={onCancel}
          disabled={submitting}
        >
          取消
        </button>
      </div>
      <p className="text-[11px] text-amber-700">
        ⓘ 改价直接修订订单行单价并重算订单总金额（非售后附加费）。
      </p>
    </div>
  );
}

// ── 售后费用（改期费 / 换人费）明细展示 ───────────────────────────────
function AdjustmentsSection({ order }: { order: OrderSummary }) {
  const adjustments = order.adjustments ?? [];
  if (adjustments.length === 0) return null;
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">售后费用</h3>
      <ul className="mt-2 space-y-1.5 text-sm">
        {adjustments.map((a) => (
          <li key={a.id} className="flex items-start justify-between gap-2 rounded-md border border-amber-200 bg-amber-50/60 p-2.5">
            <div className="flex-1">
              <div className="text-ink">{a.label}</div>
              {a.note && <div className="mt-0.5 text-xs text-ink-muted">{a.note}</div>}
              <div className="mt-0.5 text-[11px] text-ink-muted">{new Date(a.createdAt).toLocaleString('zh-CN')}</div>
            </div>
            <div className="nums text-sm font-medium text-amber-700">+¥{Number(a.amountCny).toLocaleString()}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PassengersSection({ order, onOrderUpdated }: { order: OrderSummary; onOrderUpdated?: (order: OrderSummary) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <section>
      <h3 className="text-sm font-medium text-slate-700">乘客 ({order.passengers.length})</h3>
      <ul className="mt-2 space-y-2 text-xs">
        {order.passengers.map((p) => {
          const passDaysLeft = daysUntil(p.passportExpiry);
          const passWarn = passDaysLeft !== null && passDaysLeft < 180;
          const passBlock = passDaysLeft !== null && passDaysLeft < 90;
          if (editingId === p.id) {
            return (
              <li key={p.id} className="rounded-md border border-brand/40 bg-brand/5 p-3">
                <PassengerEditForm
                  orderId={order.id}
                  passenger={p}
                  onCancel={() => setEditingId(null)}
                  onSaved={(updated) => {
                    setEditingId(null);
                    onOrderUpdated?.(updated);
                  }}
                />
              </li>
            );
          }
          return (
            <li key={p.id} className="rounded-md border border-slate-200 bg-white p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="font-medium text-slate-900">
                    {p.fullName}
                    {p.gender && <span className="ml-2 text-xs text-slate-500">{p.gender === 'M' ? '男' : p.gender === 'F' ? '女' : '其他'}</span>}
                    <button
                      className="ml-2 text-[11px] font-normal text-brand hover:text-brand-dark"
                      onClick={() => setEditingId(p.id)}
                    >
                      换人/编辑
                    </button>
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

// ── 换人/编辑出行人（改身份 + 可选重置开票/签证 + 换人费）─────────────
function PassengerEditForm({
  orderId,
  passenger,
  onCancel,
  onSaved,
}: {
  orderId: string;
  passenger: OrderSummary['passengers'][number];
  onCancel: () => void;
  onSaved: (order: OrderSummary) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const [lastName, setLastName] = useState(passenger.lastName ?? '');
  const [firstName, setFirstName] = useState(passenger.firstName ?? '');
  const [fullName, setFullName] = useState(passenger.fullName ?? '');
  const [documentNumber, setDocumentNumber] = useState(passenger.documentNumber ?? '');
  const [dob, setDob] = useState(passenger.dateOfBirth?.slice(0, 10) ?? '');
  const [gender, setGender] = useState<'M' | 'F' | 'X' | ''>(passenger.gender ?? '');
  const [nationality, setNationality] = useState(passenger.nationality ?? '');
  const [resetInvoice, setResetInvoice] = useState(false);
  const [resetVisa, setResetVisa] = useState(false);
  const [feeCny, setFeeCny] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!token || submitting) return;
    setErr(null);
    // 生日填了就必须解析合法
    let dobValue: string | undefined;
    if (dob.trim()) {
      const parsed = parseDob(dob);
      if (!parsed) { setErr('出生日期格式不正确（示例：1990-01-01）'); return; }
      dobValue = parsed;
    }
    if (!confirm('确认保存出行人改动？如勾选了重置开票/签证将清除对应状态，填了换人费将计入订单尾款。')) return;
    setSubmitting(true);
    try {
      const res = await api.updateOrderPassenger(token, orderId, passenger.id, {
        lastName: lastName.trim() || undefined,
        firstName: firstName.trim() || undefined,
        fullName: fullName.trim() || undefined,
        documentNumber: documentNumber.trim() || undefined,
        dateOfBirth: dobValue,
        gender: gender || undefined,
        nationality: nationality.trim() || undefined,
        resetInvoice: resetInvoice || undefined,
        resetVisa: resetVisa || undefined,
        feeCny: feeCny != null && feeCny > 0 ? feeCny : undefined,
        feeLabel: feeCny != null && feeCny > 0 ? '换人费' : undefined,
        note: note.trim() || undefined,
      });
      onSaved(res.order);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = 'mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs';

  return (
    <div className="space-y-2 text-xs">
      <div className="font-medium text-brand">换人/编辑 · {passenger.fullName}</div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-slate-500">姓（Last）</span>
          <input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-slate-500">名（First）</span>
          <input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </label>
      </div>

      <label className="block">
        <span className="text-slate-500">全名</span>
        <input className={inputCls} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="如未拆姓/名可直接填全名" />
      </label>

      <label className="block">
        <span className="text-slate-500">护照号</span>
        <input className={`${inputCls} font-mono`} value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-slate-500">出生日期</span>
          <input className={`${inputCls} font-mono`} value={dob} onChange={(e) => setDob(e.target.value)} placeholder="1990-01-01" />
        </label>
        <label className="block">
          <span className="text-slate-500">性别</span>
          <select className={inputCls} value={gender} onChange={(e) => setGender(e.target.value as 'M' | 'F' | 'X' | '')}>
            <option value="">未填</option>
            <option value="M">男</option>
            <option value="F">女</option>
            <option value="X">其他</option>
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-slate-500">国籍（ISO，如 CN）</span>
        <input className={inputCls} value={nationality} onChange={(e) => setNationality(e.target.value)} placeholder="CN" />
      </label>

      <div className="space-y-1 rounded border border-slate-200 bg-white p-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={resetInvoice} onChange={(e) => setResetInvoice(e.target.checked)} />
          <span>重置开票状态（开票 → 未开）</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={resetVisa} onChange={(e) => setResetVisa(e.target.checked)} />
          <span>重置签证状态（签证任务 → 待处理）</span>
        </label>
      </div>

      <label className="block">
        <span className="text-slate-500">换人费（¥，可选）</span>
        <NumberInput
          value={feeCny}
          onChange={setFeeCny}
          integerOnly
          placeholder="不收换人费则留空"
          className={inputCls}
        />
      </label>

      <label className="block">
        <span className="text-slate-500">备注（可选）</span>
        <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：客户更换出行人" />
      </label>

      {err && <div className="rounded bg-red-50 px-2 py-1 text-red-700">{err}</div>}

      <div className="flex gap-2 pt-1">
        <button
          className="flex-1 rounded bg-brand px-2 py-1.5 font-medium text-white disabled:opacity-50"
          onClick={submit}
          disabled={submitting}
        >
          {submitting ? '保存中…' : '保存'}
        </button>
        <button
          className="rounded bg-slate-100 px-3 py-1.5 text-slate-700 disabled:opacity-50"
          onClick={onCancel}
          disabled={submitting}
        >
          取消
        </button>
      </div>
    </div>
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

// 签证状态徽标色（录单口径 enum；不同于履约任务状态）
const VISA_STATUS_BADGE: Record<VisaStatusInput, string> = {
  NOT_NEEDED: 'bg-slate-100 text-slate-500',
  NEEDED: 'bg-amber-100 text-amber-700',
  E_VISA: 'bg-sky-100 text-sky-700',
  HAS_VISA: 'bg-emerald-100 text-emerald-700',
};

// 结构化备注录入口径展示顺序：酒店 → 签证 → 付款 → 特殊
const STRUCTURED_NOTE_FIELDS = [
  { key: 'noteHotel', label: '酒店情况', placeholder: '房型/入住时间/特殊安排' },
  { key: 'noteVisa', label: '签证情况', placeholder: '材料进度/批文/送签情况' },
  { key: 'notePayment', label: '付款情况', placeholder: '收款进度/尾款/退款备注' },
  { key: 'noteSpecial', label: '特殊要求', placeholder: '客户其它特殊要求' },
] as const;

function NotesSection({ order }: { order: OrderSummary }) {
  const tokens = useAuth((s) => s.tokens);
  const [customerNotes, setCustomerNotes] = useState(order.notes ?? '');
  const [internalNotes, setInternalNotes] = useState(order.internalNotes ?? '');
  const [visaStatus, setVisaStatus] = useState<VisaStatusInput>(order.visaStatus ?? 'NEEDED');
  const [structured, setStructured] = useState({
    noteHotel: order.noteHotel ?? '',
    noteVisa: order.noteVisa ?? '',
    notePayment: order.notePayment ?? '',
    noteSpecial: order.noteSpecial ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty =
    customerNotes !== (order.notes ?? '') ||
    internalNotes !== (order.internalNotes ?? '') ||
    visaStatus !== (order.visaStatus ?? 'NEEDED') ||
    structured.noteHotel !== (order.noteHotel ?? '') ||
    structured.noteVisa !== (order.noteVisa ?? '') ||
    structured.notePayment !== (order.notePayment ?? '') ||
    structured.noteSpecial !== (order.noteSpecial ?? '');

  const save = async () => {
    if (!tokens?.accessToken) return;
    setSaving(true);
    try {
      await api.updateOrderNotes(tokens.accessToken, order.id, {
        notes: customerNotes,
        internalNotes,
        visaStatus,
        noteHotel: structured.noteHotel,
        noteVisa: structured.noteVisa,
        notePayment: structured.notePayment,
        noteSpecial: structured.noteSpecial,
      });
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
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-slate-700">签证状态 / 备注</h3>
        <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${VISA_STATUS_BADGE[visaStatus]}`}>
          {VISA_STATUS_LABEL[visaStatus]}
        </span>
      </div>
      <div className="mt-2 space-y-2">
        <div>
          <label className="text-xs text-slate-500">签证状态</label>
          <select
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
            value={visaStatus}
            onChange={(e) => setVisaStatus(e.target.value as VisaStatusInput)}
          >
            {(Object.keys(VISA_STATUS_LABEL) as VisaStatusInput[]).map((v) => (
              <option key={v} value={v}>{VISA_STATUS_LABEL[v]}</option>
            ))}
          </select>
        </div>
        {STRUCTURED_NOTE_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="text-xs text-slate-500">{f.label}</label>
            <textarea
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
              rows={2}
              value={structured[f.key]}
              maxLength={300}
              onChange={(e) => setStructured((prev) => ({ ...prev, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
            />
          </div>
        ))}
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
  /** 用户原始输入（如 1990-01-01 / 1990/1/1），提交时统一解析为 ISO。 */
  dateOfBirth: string;
}

/**
 * 把宽松输入的生日解析成后端要的 YYYY-MM-DD。
 * 接受 1990-01-01 / 1990/1/1 / 1990.1.1 等分隔符；非法返回 null。
 */
function parseDob(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // 真实日历校验（拦掉 2 月 30 日之类）
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function BatchCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);
  const token = tokens?.accessToken ?? '';
  const recorderLabel = user?.displayName || user?.email || '当前账号';

  // ── 产品类型 ──────────────────────────────────────────────────────────────
  const [productType, setProductType] = useState<BatchProductType>('FLIGHT_ONEWAY');

  // ── 航班：出港（单程 + 往返）+ 回程（仅往返）────────────────────────────
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [flightsErr, setFlightsErr] = useState<string | null>(null);
  const [flightsLoading, setFlightsLoading] = useState(false);

  const [outboundFlightId, setOutboundFlightId] = useState('');
  const [outboundSchedules, setOutboundSchedules] = useState<AdminSchedule[]>([]);
  const [outboundScheduleId, setOutboundScheduleId] = useState('');

  const [returnFlightId, setReturnFlightId] = useState('');
  const [returnSchedules, setReturnSchedules] = useState<AdminSchedule[]>([]);
  const [returnScheduleId, setReturnScheduleId] = useState('');

  const [cabin, setCabin] = useState<CabinClass | ''>('');

  // ── 套餐 ──────────────────────────────────────────────────────────────────
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [bundleId, setBundleId] = useState('');
  const [bundleNights, setBundleNights] = useState<number | null>(null);
  const [bundleSingleCount, setBundleSingleCount] = useState<number | null>(null);
  const [bundleBusinessCount, setBundleBusinessCount] = useState<number | null>(null);
  // 人群区分：批量模式每乘客一单，这三个值描述本批整体的人群结构
  const [bundleAdultCount, setBundleAdultCount] = useState<number | null>(1);
  const [bundleChildCount, setBundleChildCount] = useState<number | null>(0);
  const [bundleInfantCount, setBundleInfantCount] = useState<number | null>(0);

  // ── 结算价（FLIGHT 类型专用）+ 团期备注 ──────────────────────────────────
  const [settlementPriceCny, setSettlementPriceCny] = useState<number | null>(null);
  const [groupNote, setGroupNote] = useState('');

  // ── 备注 ──────────────────────────────────────────────────────────────────
  const [notes, setNotes] = useState('');

  // ── 名单 ──────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<BatchRow[]>([{ fullName: '', documentNumber: '', dateOfBirth: '' }]);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterWarnings, setRosterWarnings] = useState<string[]>([]);

  // ── 提交 ──────────────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BatchCreateOrdersResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // ── 加载航班列表（带重试）────────────────────────────────────────────────
  function loadFlights(): void {
    if (!token) return;
    setFlightsLoading(true);
    setFlightsErr(null);
    api
      .listAllFlights(token)
      .then((r) => setFlights(r.flights))
      .catch((e: unknown) => {
        const isPermErr = e instanceof ApiError && (e.status === 401 || e.status === 403);
        setFlightsErr(isPermErr ? '无权限加载航班列表，请刷新页面重新登录' : '航班列表加载失败，请点击重试');
      })
      .finally(() => setFlightsLoading(false));
  }

  useEffect(() => { loadFlights(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // 加载套餐列表
  useEffect(() => {
    if (!token || productType !== 'BUNDLE') return;
    api.listBundles(false).then((r) => setBundles(r.bundles)).catch(() => {/* 忽略，套餐下拉空白时用户可重选 */});
  }, [token, productType]);

  // 出港班次
  useEffect(() => {
    if (!token || !outboundFlightId) { setOutboundSchedules([]); setOutboundScheduleId(''); return; }
    api.listSchedules(token, outboundFlightId)
      .then((r) => setOutboundSchedules(r.schedules))
      .catch(() => setErr('出港班次加载失败'));
  }, [token, outboundFlightId]);

  // 回程班次
  useEffect(() => {
    if (!token || !returnFlightId) { setReturnSchedules([]); setReturnScheduleId(''); return; }
    api.listSchedules(token, returnFlightId)
      .then((r) => setReturnSchedules(r.schedules))
      .catch(() => setErr('回程班次加载失败'));
  }, [token, returnFlightId]);

  // 切换产品类型时清空相关选择
  function switchProductType(pt: BatchProductType): void {
    setProductType(pt);
    setOutboundFlightId(''); setOutboundScheduleId(''); setOutboundSchedules([]);
    setReturnFlightId(''); setReturnScheduleId(''); setReturnSchedules([]);
    setCabin('');
    setBundleId(''); setBundleNights(null); setBundleSingleCount(null); setBundleBusinessCount(null);
    setBundleAdultCount(1); setBundleChildCount(0); setBundleInfantCount(0);
    setSettlementPriceCny(null); setGroupNote('');
    setErr(null);
  }

  const outboundFlight = flights.find((f) => f.id === outboundFlightId);
  const outboundSchedule = outboundSchedules.find((s) => s.id === outboundScheduleId);
  const returnFlight = flights.find((f) => f.id === returnFlightId);
  const cabinOptions = outboundSchedule?.seatClasses ?? [];
  const selectedBundle = bundles.find((b) => b.id === bundleId);

  const validRows = rows.filter((r) => r.fullName.trim() && r.documentNumber.trim() && parseDob(r.dateOfBirth));

  function setRow(i: number, patch: Partial<BatchRow>): void {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow(): void { setRows((prev) => [...prev, { fullName: '', documentNumber: '', dateOfBirth: '' }]); }
  function removeRow(i: number): void { setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev)); }

  function pasteRows(text: string): void {
    const parsed = text
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .map((line) => {
        const cols = line.split(/[,，\t]+|\s{2,}|\s+/).map((c) => c.trim()).filter(Boolean);
        return { fullName: cols[0] ?? '', documentNumber: cols[1] ?? '', dateOfBirth: cols[2] ?? '' };
      })
      .filter((r) => r.fullName);
    if (parsed.length > 0) setRows(parsed);
  }

  async function downloadTemplate(): Promise<void> {
    if (!token) return;
    setErr(null); setTemplateBusy(true);
    try {
      const blob = await api.downloadRosterTemplate(token);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `名单模版-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? `模版下载失败：${e.message}` : '模版下载失败');
    } finally { setTemplateBusy(false); }
  }

  function onRosterFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !token) return;
    if (f.size > 4 * 1024 * 1024) { setErr('名单文件过大（>4MB），请精简后再传'); return; }
    setErr(null); setRosterWarnings([]); setRosterBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
      if (!base64) { setErr('文件读取失败'); setRosterBusy(false); return; }
      api.parseRoster(token, base64)
        .then((res) => {
          const parsed: BatchRow[] = res.rows
            .filter((r) => (r.fullName ?? r.name)?.trim())
            .map((r) => ({
              fullName: (r.fullName ?? r.name ?? '').trim(),
              documentNumber: (r.documentNumber ?? r.passportNo ?? '').trim(),
              dateOfBirth: (r.dateOfBirth ?? r.dob ?? '').trim(),
            }));
          if (parsed.length > 0) setRows(parsed);
          else setErr('名单未解析出任何乘客，请检查文件格式');
          setRosterWarnings(res.warnings ?? []);
        })
        .catch((e: unknown) => { setErr(e instanceof ApiError ? `名单解析失败：${e.message}` : '名单解析失败'); })
        .finally(() => setRosterBusy(false));
    };
    reader.onerror = () => { setErr('文件读取失败'); setRosterBusy(false); };
    reader.readAsDataURL(f);
  }

  async function submit(): Promise<void> {
    setErr(null);
    if (validRows.length === 0) { setErr('至少要有一位完整乘客（姓名 + 护照号 + 出生日期）'); return; }

    let description = '';
    if (productType === 'FLIGHT_ONEWAY') {
      if (!outboundScheduleId || !cabin) { setErr('请选择出港班次和舱位'); return; }
      const dep = outboundSchedule?.departureTime.slice(0, 10) ?? '';
      description = `${outboundFlight?.flightNumber ?? ''} ${outboundFlight?.originCode ?? ''}→${outboundFlight?.destinationCode ?? ''} ${dep} ${CABIN_ZH[cabin] ?? cabin}`.trim();
    } else if (productType === 'FLIGHT_ROUNDTRIP') {
      if (!outboundScheduleId || !returnScheduleId || !cabin) { setErr('请选择出港班次、回程班次和舱位'); return; }
      const dep = outboundSchedule?.departureTime.slice(0, 10) ?? '';
      const ret = returnSchedules.find((s) => s.id === returnScheduleId)?.departureTime.slice(0, 10) ?? '';
      description = `${outboundFlight?.flightNumber ?? ''}去 ${dep} / ${returnFlight?.flightNumber ?? ''}回 ${ret} ${CABIN_ZH[cabin] ?? cabin}`.trim();
    } else {
      if (!bundleId) { setErr('请选择套餐'); return; }
      description = selectedBundle?.name ?? bundleId;
    }

    const teamPrice =
      productType !== 'BUNDLE' &&
      settlementPriceCny !== null && Number.isFinite(settlementPriceCny) && settlementPriceCny > 0
        ? settlementPriceCny : undefined;

    setSubmitting(true);
    try {
      const res = await api.batchCreateOrders(token, {
        productType,
        ...(productType === 'FLIGHT_ONEWAY' || productType === 'FLIGHT_ROUNDTRIP'
          ? {
              outboundScheduleId,
              ...(productType === 'FLIGHT_ROUNDTRIP' ? { returnScheduleId } : {}),
              flightCabin: cabin as CabinClass,
            }
          : {
              bundleId,
              ...(bundleNights !== null ? { bundleNights } : {}),
              ...(bundleSingleCount !== null ? { bundleSingleCount } : {}),
              ...(bundleBusinessCount !== null ? { bundleBusinessCount } : {}),
              ...(bundleAdultCount !== null ? { adultCount: bundleAdultCount } : {}),
              ...(bundleChildCount !== null ? { childCount: bundleChildCount } : {}),
              ...(bundleInfantCount !== null ? { infantCount: bundleInfantCount } : {}),
            }),
        description,
        notes: notes.trim() || undefined,
        passengers: validRows.map((r) => ({
          fullName: r.fullName.trim(),
          documentNumber: r.documentNumber.trim(),
          dateOfBirth: parseDob(r.dateOfBirth) ?? '',
          nationality: 'CN',
        })),
        ...(teamPrice !== undefined
          ? { settlementPriceCny: teamPrice, groupNote: groupNote.trim() || undefined }
          : {}),
      });
      setResult(res);
      if (res.successCount > 0) onCreated();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '批量创建失败');
    } finally { setSubmitting(false); }
  }

  const productTypeLabel: Record<BatchProductType, string> = {
    FLIGHT_ONEWAY: '单程机票',
    FLIGHT_ROUNDTRIP: '往返机票',
    BUNDLE: '套餐',
  };
  const orderCountLabel = productType === 'BUNDLE' ? '套餐订单' : '机票订单';

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
                  setRosterWarnings([]);
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

            {/* 产品类型选择 */}
            <div>
              <div className="mb-1.5 text-xs font-medium text-slate-500">产品类型</div>
              <div className="flex gap-2">
                {(['FLIGHT_ONEWAY', 'FLIGHT_ROUNDTRIP', 'BUNDLE'] as BatchProductType[]).map((pt) => (
                  <button
                    key={pt}
                    type="button"
                    className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                      productType === pt
                        ? 'border-brand bg-brand text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:border-brand hover:text-brand'
                    }`}
                    onClick={() => switchProductType(pt)}
                  >
                    {productTypeLabel[pt]}
                  </button>
                ))}
              </div>
            </div>

            {/* ── 航班类型：出港 ── */}
            {(productType === 'FLIGHT_ONEWAY' || productType === 'FLIGHT_ROUNDTRIP') && (
              <>
                {flightsErr && (
                  <div className="flex items-center gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
                    <span>{flightsErr}</span>
                    <button
                      type="button"
                      className="ml-auto rounded border border-rose-300 px-2 py-0.5 text-xs hover:bg-rose-100"
                      onClick={loadFlights}
                      disabled={flightsLoading}
                    >
                      {flightsLoading ? '加载中…' : '重试'}
                    </button>
                  </div>
                )}

                <div className="rounded-md border border-slate-200 p-3">
                  <div className="mb-2 text-xs font-medium text-slate-600">
                    {productType === 'FLIGHT_ROUNDTRIP' ? '出港航班' : '航班'}
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <label className="text-xs text-slate-500">
                      航班
                      <select
                        className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                        value={outboundFlightId}
                        onChange={(e) => { setOutboundFlightId(e.target.value); setOutboundScheduleId(''); setCabin(''); }}
                        disabled={flightsLoading}
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
                        value={outboundScheduleId}
                        onChange={(e) => { setOutboundScheduleId(e.target.value); setCabin(''); }}
                        disabled={!outboundFlightId}
                      >
                        <option value="">选择班次…</option>
                        {outboundSchedules.map((s) => (
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
                        disabled={!outboundScheduleId}
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
                </div>

                {/* 回程航班（仅往返） */}
                {productType === 'FLIGHT_ROUNDTRIP' && (
                  <div className="rounded-md border border-slate-200 p-3">
                    <div className="mb-2 text-xs font-medium text-slate-600">回程航班</div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="text-xs text-slate-500">
                        航班
                        <select
                          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                          value={returnFlightId}
                          onChange={(e) => { setReturnFlightId(e.target.value); setReturnScheduleId(''); }}
                          disabled={flightsLoading}
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
                          value={returnScheduleId}
                          onChange={(e) => setReturnScheduleId(e.target.value)}
                          disabled={!returnFlightId}
                        >
                          <option value="">选择班次…</option>
                          {returnSchedules.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.departureTime.slice(0, 16).replace('T', ' ')}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <p className="mt-1.5 text-[11px] text-slate-400">
                      回程与出港可以是不同航班，共用同一舱位等级。
                    </p>
                  </div>
                )}

                {/* 结算价（FLIGHT 专用） */}
                <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3">
                  <div className="mb-2 text-sm font-medium text-slate-700">旅游团（选填）</div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="text-xs text-slate-500">
                      结算价/人（¥）
                      <NumberInput
                        className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                        value={settlementPriceCny}
                        onChange={setSettlementPriceCny}
                        min={0}
                        step={1}
                        integerOnly
                        placeholder="留空 = 按动态定价"
                      />
                    </label>
                    <label className="text-xs text-slate-500">
                      团期备注
                      <input
                        className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                        value={groupNote}
                        onChange={(e) => setGroupNote(e.target.value)}
                        placeholder="如 2026 春节团 7 日"
                      />
                    </label>
                  </div>
                  <p className="mt-2 text-[11px] text-amber-700">
                    ⓘ 填了结算价后，每位乘客按此价建单，覆盖仓位阶梯 / 自动定价。
                  </p>
                </div>
              </>
            )}

            {/* ── 套餐类型 ── */}
            {productType === 'BUNDLE' && (
              <div className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 text-xs font-medium text-slate-600">套餐</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs text-slate-500">
                    选择套餐
                    <select
                      className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      value={bundleId}
                      onChange={(e) => setBundleId(e.target.value)}
                    >
                      <option value="">选择套餐…</option>
                      {bundles.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.code ? `[${b.code}] ` : ''}{b.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-500">
                    入住晚数（选填）
                    <NumberInput
                      className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      value={bundleNights}
                      onChange={setBundleNights}
                      min={1}
                      max={30}
                      step={1}
                      integerOnly
                      placeholder={selectedBundle?.hotelNights ? `默认 ${selectedBundle.hotelNights} 晚` : '晚数'}
                    />
                  </label>
                  <label className="text-xs text-slate-500">
                    单人入住人数（选填）
                    <NumberInput
                      className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      value={bundleSingleCount}
                      onChange={setBundleSingleCount}
                      min={0}
                      max={20}
                      step={1}
                      integerOnly
                      placeholder="0"
                    />
                  </label>
                  <label className="text-xs text-slate-500">
                    升舱商务人数（选填）
                    <NumberInput
                      className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      value={bundleBusinessCount}
                      onChange={setBundleBusinessCount}
                      min={0}
                      max={20}
                      step={1}
                      integerOnly
                      placeholder="0"
                    />
                  </label>
                  <label className="text-xs text-slate-500">
                    成人人数
                    <NumberInput
                      className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      value={bundleAdultCount}
                      onChange={setBundleAdultCount}
                      min={1}
                      max={50}
                      step={1}
                      integerOnly
                      placeholder="1"
                    />
                  </label>
                  <label className="text-xs text-slate-500">
                    儿童人数（选填）
                    <NumberInput
                      className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      value={bundleChildCount}
                      onChange={setBundleChildCount}
                      min={0}
                      max={20}
                      step={1}
                      integerOnly
                      placeholder="0"
                    />
                  </label>
                  <label className="text-xs text-slate-500">
                    婴儿人数（选填）
                    <NumberInput
                      className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      value={bundleInfantCount}
                      onChange={setBundleInfantCount}
                      min={0}
                      max={10}
                      step={1}
                      integerOnly
                      placeholder="0"
                    />
                  </label>
                </div>
              </div>
            )}

            {/* 录入人 + 备注 */}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="text-xs text-slate-500">
                录入人
                <div className="mt-1 flex h-[34px] items-center rounded-md bg-slate-50 px-2.5 text-sm text-slate-700">
                  {recorderLabel}
                  <span className="ml-2 text-xs text-slate-400">（系统自动记录）</span>
                </div>
              </div>
              <label className="text-xs text-slate-500">
                备注（选填，写入每单）
                <input className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
            </div>

            {/* 名单导入 */}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-secondary text-sm disabled:opacity-50"
                onClick={() => void downloadTemplate()}
                disabled={templateBusy}
              >
                {templateBusy ? '生成中…' : '下载名单模版'}
              </button>
              <label className="btn-secondary cursor-pointer text-sm">
                {rosterBusy ? '解析中…' : '上传名单 Excel'}
                <input
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="hidden"
                  onChange={onRosterFile}
                  disabled={rosterBusy}
                />
              </label>
              <span className="text-[11px] text-slate-400">上传后自动填充下方名单；也可手动录入。</span>
            </div>

            {rosterWarnings.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <div className="font-medium">名单解析提醒（{rosterWarnings.length} 条）：</div>
                <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-auto pl-5">
                  {rosterWarnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">快速粘贴（每行一位：姓名 — 或 姓名,护照号,生日）</summary>
              <textarea
                className="mt-2 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                rows={3}
                placeholder={'张三\n李四,E12345678,1990-01-01\n王五  G87654321  1985/12/3'}
                onChange={(e) => pasteRows(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-slate-400">分隔符支持逗号 / Tab / 空格；只填姓名也行，护照号、生日可留空后续手录。</p>
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
                        <td className="px-2 py-1 align-top">
                          {(() => {
                            const dobTouched = r.dateOfBirth.trim().length > 0;
                            const dobValid = parseDob(r.dateOfBirth) !== null;
                            const dobBad = dobTouched && !dobValid;
                            return (
                              <>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  className={`w-full rounded border px-1.5 py-1 text-sm ${dobBad ? 'border-rose-400 bg-rose-50' : 'border-slate-300'}`}
                                  placeholder="YYYY-MM-DD"
                                  value={r.dateOfBirth}
                                  onChange={(e) => setRow(i, { dateOfBirth: e.target.value })}
                                />
                                {dobBad && <span className="mt-0.5 block text-[11px] text-rose-500">格式如 1990-01-01</span>}
                              </>
                            );
                          })()}
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
              <span className="text-xs text-slate-500">将创建 {validRows.length} 张{orderCountLabel}（1/人）</span>
              <div className="flex gap-2">
                <button className="btn-secondary text-sm" onClick={onClose}>取消</button>
                <button className="btn-primary text-sm disabled:opacity-50" onClick={() => void submit()} disabled={submitting}>
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
  agent,
  onChanged,
}: {
  orderId: string;
  total: number;
  paidAmount: number;
  agent: OrderSummary['agent'];
  onChanged?: () => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const [payments, setPayments] = useState<OrderPayment[]>([]);
  const [paid, setPaid] = useState(paidAmount);
  // 代理预存余额本地副本（抵扣/存入后即时刷新展示，不必等父级 onChanged 重拉）
  const [agentBalance, setAgentBalance] = useState<number>(agent ? Number(agent.prepaymentBalance) : 0);
  useEffect(() => {
    setAgentBalance(agent ? Number(agent.prepaymentBalance) : 0);
  }, [agent]);
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('BANK_CARD');
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 尾款 = 应收 − 已付。正=欠款(少付)、0=已结清、负=多付（不再 clamp，多付要看得见）。
  const balance = Math.round((total - paid) * 100) / 100;

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
        const due = Math.round((total - p) * 100) / 100;
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

  const settled = balance === 0;
  const overpaid = balance < 0;
  const isMonthly = agent?.settlementMode === 'MONTHLY';

  // 多付存入代理余额：把 paidAmount−total 转入代理预存，订单回到刚好结清。
  async function creditOverpay(): Promise<void> {
    if (!token || !agent || submitting) return;
    setErr(null);
    setSubmitting(true);
    try {
      const res = await api.creditOverpayToAgent(token, orderId);
      setPaid(Number(res.order.paidAmount));
      if (res.order.agent) setAgentBalance(Number(res.order.agent.prepaymentBalance));
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '存入代理余额失败');
    } finally {
      setSubmitting(false);
    }
  }

  // 多付转挂账池：把 paidAmount−total 转入挂账池（生成一条 ORDER_OVERPAY 进账），
  // 订单回到刚好结清。散客 / 代理订单都可用（与「存入代理余额」区别：钱进对账台待认领，
  // 不绑定某个代理）。
  async function moveToPool(): Promise<void> {
    if (!token || submitting) return;
    if (!window.confirm(`确认把多付的 ¥${Math.abs(balance).toLocaleString()} 转入挂账池？转入后订单回到刚好结清，这笔钱将在收款对账台待认领。`))
      return;
    setErr(null);
    setSubmitting(true);
    try {
      const res = await api.overpayOrderToPool(token, orderId);
      setPaid(res.newPaidAmount);
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '转挂账池失败');
    } finally {
      setSubmitting(false);
    }
  }

  // 用代理余额抵尾款：amount ≤ 尾款 且 ≤ 代理余额；覆盖则翻 PAID。
  async function applyBalance(amt: number): Promise<void> {
    if (!token || !agent || submitting) return;
    setErr(null);
    setSubmitting(true);
    try {
      const res = await api.applyAgentBalance(token, orderId, amt);
      setPaid(Number(res.order.paidAmount));
      if (res.order.agent) setAgentBalance(Number(res.order.agent.prepaymentBalance));
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '抵扣失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-slate-700">收款</h3>
      <div className="mt-2 rounded-md border border-slate-200 p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-slate-500">已付 / 应收</span>
          <span>
            <b className="text-emerald-700">¥{paid.toLocaleString()}</b>
            <span className="text-slate-400"> / ¥{total.toLocaleString()}</span>
            <span className="ml-2">
              <BalanceBadge balance={balance} settlementMode={agent?.settlementMode} />
            </span>
          </span>
        </div>

        {/* 代理 + 余额 + 结算方式 */}
        {agent && (
          <div className={`mt-2 rounded-md border p-2 text-xs ${isMonthly ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-slate-50'}`}>
            <div className="flex items-center justify-between">
              <span className="text-slate-600">
                代理 <b className="text-slate-800">{agent.companyName ?? agent.contactName}</b>
              </span>
              <span className={`rounded px-1.5 py-0.5 font-medium ${isMonthly ? 'bg-blue-100 text-blue-700' : 'bg-slate-200 text-slate-600'}`}>
                {SETTLEMENT_MODE_LABEL[agent.settlementMode]}
              </span>
            </div>
            <div className="mt-1 text-slate-600">
              代理余额 <b className="text-emerald-700">¥{agentBalance.toLocaleString()}</b>
            </div>
          </div>
        )}

        {/* 月结挂账说明（月结代理尾款>0 不催款）*/}
        {agent && isMonthly && balance > 0 && (
          <div className="mt-2 rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs text-blue-700">
            🗓 月结代理：尾款 ¥{balance.toLocaleString()} 计入月结挂账，月末统一对账，无需逐单催款。
          </div>
        )}

        {/* 多付 → 存入代理余额（仅代理订单） */}
        {agent && overpaid && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs">
            <span className="text-blue-700">多付 ¥{Math.abs(balance).toLocaleString()} 可存入代理余额</span>
            <button
              className="btn-secondary text-xs px-2 py-1 disabled:opacity-50"
              onClick={creditOverpay}
              disabled={submitting}
            >
              存入代理余额
            </button>
          </div>
        )}

        {/* 多付 → 转挂账池（散客 / 代理均可；钱进收款对账台待认领） */}
        {overpaid && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs">
            <span className="text-amber-800">
              多付 ¥{Math.abs(balance).toLocaleString()} 可转挂账池（在收款对账台待认领）
            </span>
            <button
              className="btn-secondary text-xs px-2 py-1 disabled:opacity-50"
              onClick={moveToPool}
              disabled={submitting}
            >
              转挂账池
            </button>
          </div>
        )}

        {/* 欠款 + 代理有余额 → 用代理余额抵 */}
        {agent && balance > 0 && agentBalance > 0 && (
          <ApplyAgentBalanceRow
            balance={balance}
            agentBalance={agentBalance}
            submitting={submitting}
            onApply={applyBalance}
          />
        )}

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

        {/* 确认收款表单（始终可补录：允许多付/追加收款，后端已放开 ≤尾款 限制）*/}
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          {settled && (
            <p className="text-xs text-slate-400">已结清；如需追加收款（多付）可继续录入。</p>
          )}
          <div className="space-y-2">
            {err && <div className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</div>}
            <div className="flex gap-2">
              <label className="flex-1 text-xs text-slate-500">
                收款金额
                <NumberInput
                  step={0.01}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                  value={amount}
                  onChange={(n) => setAmount(n)}
                  placeholder={balance > 0 ? `默认尾款 ¥${balance}` : '输入收款金额'}
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
        </div>
      </div>
    </section>
  );
}

// 用代理余额抵尾款：金额默认 = min(尾款, 代理余额)，可改；提交受后端 ≤尾款 且 ≤余额 守门。
function ApplyAgentBalanceRow({
  balance,
  agentBalance,
  submitting,
  onApply,
}: {
  balance: number;
  agentBalance: number;
  submitting: boolean;
  onApply: (amount: number) => void | Promise<void>;
}) {
  const max = Math.round(Math.min(balance, agentBalance) * 100) / 100;
  const [amount, setAmount] = useState<number | null>(max);
  const amt = amount ?? 0;
  const valid = amt > 0 && amt <= max;

  return (
    <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-2 text-xs">
      <div className="text-emerald-800">用代理余额抵尾款（最多 ¥{max.toLocaleString()}）</div>
      <div className="mt-1.5 flex items-center gap-2">
        <NumberInput
          step={0.01}
          min={0}
          max={max}
          className="block w-28 rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={amount}
          onChange={(n) => setAmount(n)}
          placeholder={`默认 ¥${max}`}
        />
        <button
          className="btn-primary text-xs px-2 py-1 disabled:opacity-50"
          onClick={() => onApply(amt)}
          disabled={submitting || !valid}
        >
          用代理余额抵
        </button>
      </div>
    </div>
  );
}

// ── 批量到账（选多单 → 逐单录入到账金额 + 共享水单 + 备注）──────────────
// 流程：操作员勾选若干未结清订单 → 打开此弹窗 → 每单默认到账=尾款（可改）
// → 选一个共享收款方式 + 可选共享水单（截图/URL）+ 备注 → 提交 →
// 逐单入账（单条失败不影响其它），结果显示每单成功/失败。
interface BatchPayRow {
  orderId: string;
  orderNumber: string;
  customerName: string;
  total: number;
  paid: number;
  balance: number;
  /** 本次到账金额（默认 = 尾款）；null = 空 */
  amount: number | null;
}

function BatchPayModal({
  orders,
  onClose,
  onDone,
}: {
  orders: OrderSummary[];
  onClose: () => void;
  onDone: (succeededIds: string[]) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [rows, setRows] = useState<BatchPayRow[]>(() =>
    orders.map((o) => {
      const { total, paid, balance } = deriveBalance(o);
      const { customerName } = deriveView(o);
      return {
        orderId: o.id,
        orderNumber: o.orderNumber,
        customerName,
        total,
        paid,
        balance,
        amount: balance > 0 ? balance : null,
      };
    }),
  );
  const [method, setMethod] = useState<PaymentMethod>('BANK_CARD');
  const [sharedProofUrl, setSharedProofUrl] = useState<string | null>(null);
  const [sharedNote, setSharedNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<
    Array<{ orderId: string; ok: boolean; error?: string; paidAmount: number; status: OrderStatus }> | null
  >(null);

  function setRowAmount(orderId: string, amount: number | null): void {
    setRows((prev) => prev.map((r) => (r.orderId === orderId ? { ...r, amount } : r)));
  }

  function onSharedFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) {
      setErr('截图过大（>4MB），请压缩后再传');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setSharedProofUrl(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(f);
  }

  // 有效行 = 填了正数金额的行
  const validRows = rows.filter((r) => r.amount !== null && Number.isFinite(r.amount) && (r.amount as number) > 0);

  async function submit(): Promise<void> {
    if (!token || submitting) return;
    setErr(null);
    if (validRows.length === 0) {
      setErr('请至少为一笔订单填写到账金额（正数）');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.batchConfirmPayments(token, {
        items: validRows.map((r) => ({
          orderId: r.orderId,
          amount: r.amount as number,
          method,
          note: sharedNote.trim() || undefined,
        })),
        sharedProofUrl: sharedProofUrl ?? undefined,
      });
      setResults(res.results);
      const succeeded = res.results.filter((r) => r.ok).map((r) => r.orderId);
      onDone(succeeded);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '批量到账失败');
    } finally {
      setSubmitting(false);
    }
  }

  const totalToReceive = validRows.reduce((sum, r) => sum + (r.amount as number), 0);
  const resultById = useMemo(() => {
    const m = new Map<string, { ok: boolean; error?: string; paidAmount: number; status: OrderStatus }>();
    results?.forEach((r) => m.set(r.orderId, r));
    return m;
  }, [results]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="my-8 w-full max-w-3xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">批量到账（{rows.length} 笔订单）</h2>
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose}>✕</button>
        </div>

        <div className="space-y-4 p-5">
          {err && <div className="rounded-md bg-rose-50 px-4 py-2 text-sm text-rose-700">{err}</div>}

          {/* 共享：收款方式 + 水单 + 备注（应用到本批所有单）*/}
          <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3">
            <div className="mb-2 text-xs font-medium text-slate-600">本批共享信息（应用到下列每一单）</div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs text-slate-500">
                收款方式
                <select
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                  disabled={submitting || results !== null}
                >
                  {(['BANK_CARD', 'WECHAT_PAY', 'ALIPAY', 'AGENT_PREPAYMENT'] as PaymentMethod[]).map((m) => (
                    <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500">
                备注（选填，写入每单）
                <input
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  value={sharedNote}
                  onChange={(e) => setSharedNote(e.target.value)}
                  disabled={submitting || results !== null}
                />
              </label>
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
              <span className="rounded-md border border-slate-300 px-2 py-1 cursor-pointer hover:bg-slate-50">📷 上传共享水单（选填）</span>
              <input type="file" accept="image/*" className="hidden" onChange={onSharedFile} disabled={submitting || results !== null} />
              {sharedProofUrl && <img src={sharedProofUrl} alt="水单预览" className="h-8 w-8 rounded border border-slate-300 object-cover" />}
            </label>
          </div>

          {/* 逐单到账金额（默认 = 尾款）*/}
          <div className="max-h-80 overflow-y-auto rounded-md border border-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-1.5 text-left font-normal">订单 / 客户</th>
                  <th className="px-3 py-1.5 text-right font-normal">应收</th>
                  <th className="px-3 py-1.5 text-right font-normal">已付</th>
                  <th className="px-3 py-1.5 text-right font-normal">尾款</th>
                  <th className="px-3 py-1.5 text-right font-normal">本次到账</th>
                  {results !== null && <th className="px-3 py-1.5 text-left font-normal">结果</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const res = resultById.get(r.orderId);
                  return (
                    <tr key={r.orderId} className="border-t border-slate-100">
                      <td className="px-3 py-1.5">
                        <div className="font-mono text-xs text-ink-soft">{r.orderNumber}</div>
                        <div className="text-xs text-ink-muted">{r.customerName}</div>
                      </td>
                      <td className="nums px-3 py-1.5 text-right text-slate-600">¥{r.total.toLocaleString()}</td>
                      <td className="nums px-3 py-1.5 text-right text-slate-600">¥{r.paid.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right">
                        <BalanceBadge balance={r.balance} />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <NumberInput
                          step={0.01}
                          className="block w-28 rounded-md border border-slate-300 px-2 py-1 text-right text-sm"
                          value={r.amount}
                          onChange={(n) => setRowAmount(r.orderId, n)}
                          placeholder="不收"
                          disabled={submitting || results !== null}
                        />
                      </td>
                      {results !== null && (
                        <td className="px-3 py-1.5 text-xs">
                          {res ? (
                            res.ok ? (
                              <span className="text-emerald-700">✓ 已到账（已付 ¥{res.paidAmount.toLocaleString()}）</span>
                            ) : (
                              <span className="text-rose-600">✕ {res.error ?? '失败'}</span>
                            )
                          ) : (
                            <span className="text-slate-400">未提交</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-slate-200 pt-3">
            <span className="text-xs text-slate-500">
              {results !== null
                ? `成功 ${results.filter((r) => r.ok).length} 笔 · 失败 ${results.filter((r) => !r.ok).length} 笔`
                : `将为 ${validRows.length} 笔订单入账，合计 ¥${totalToReceive.toLocaleString()}`}
            </span>
            <div className="flex gap-2">
              {results !== null ? (
                <button className="btn-primary text-sm" onClick={onClose}>完成</button>
              ) : (
                <>
                  <button className="btn-secondary text-sm" onClick={onClose} disabled={submitting}>取消</button>
                  <button
                    className="btn-primary text-sm disabled:opacity-50"
                    onClick={() => void submit()}
                    disabled={submitting || validRows.length === 0}
                  >
                    {submitting ? '入账中…' : `确认到账 ${validRows.length} 笔`}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
