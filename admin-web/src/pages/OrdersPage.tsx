import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, duplicatePassengerConflictOrderNumbers, duplicateAmountDetails, SETTLEMENT_MODE_LABEL, PRICE_ADJUSTMENT_REASON_OPTIONS, PRICE_ADJUSTMENT_REASON_LABEL, type PriceAdjustmentReason, type OrderSummary, type OrderItem, type OrderStatus, type FulfillmentTask, type FulfillmentStatus as ApiFfStatus, type AdminFlight, type AdminSchedule, type CabinClass, type BatchCreateOrdersResult, type InvoiceLeg, type PaymentMethod, type OrderPayment, type ListOrdersParams, type OrderExportTemplate, type SettlementMode, type VisaStatusInput, VISA_STATUS_LABEL, type BatchProductType, type Bundle, type DeletedOrderSummary, type AuditLog, type Visa, type Hotel } from '../lib/api';
import { useAuth } from '../stores/auth';
import { useFlightSeats } from '../stores/flightSeats';
import {
  type FulfillmentStatus,
} from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';
import { AIRPORTS } from '../lib/airports';
import { NumberInput } from '../components/NumberInput';
import { parseOtaRoster } from '../lib/parseOtaRoster';
import type { AgentListItem, OrderImportParseResult } from '../lib/api';
import { OrderFinanceSection } from '../components/OrderFinanceSection';
import { OrderAuditTrail } from '../components/OrderAuditTrail';
import { SingleOrderModal } from '../components/SingleOrderModal';
import { RoomingEditor, type RoomingPassenger } from '../components/RoomingEditor';
import { HotelSwapModal } from '../components/HotelSwapModal';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect';
import type { RoomGroup } from '../lib/api';
import { countryIso3ToIso2 } from '../lib/passportOcr';

// 本地可视化用的状态子集（后端 OrderStatus 更全，这里只列出常用 7 个做 filter）
const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  // 订单履约阶段，与航段级「去程/回程已出票」（开票进度）不是一回事——
  // 叫「出票完成」以免运营在整单状态里误当成航段开票标记。
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

// 批量开票下拉的六个选项（票务岗 0715 反馈）：按航段/系统三个布尔位各自「标已开/标未开」，
// 对应逐单调用 setInvoiceFlags 时传的 flags 字段。
type BulkInvoiceFlagOption = 'OUT_ON' | 'OUT_OFF' | 'RET_ON' | 'RET_OFF' | 'SYS_ON' | 'SYS_OFF';
const BULK_INVOICE_FLAG_OPTIONS: Array<{
  value: BulkInvoiceFlagOption;
  label: string;
  flags: { outboundInvoiced?: boolean; returnInvoiced?: boolean; systemInvoiced?: boolean };
}> = [
  { value: 'OUT_ON', label: '去程标已开', flags: { outboundInvoiced: true } },
  { value: 'OUT_OFF', label: '去程标未开', flags: { outboundInvoiced: false } },
  { value: 'RET_ON', label: '回程标已开', flags: { returnInvoiced: true } },
  { value: 'RET_OFF', label: '回程标未开', flags: { returnInvoiced: false } },
  { value: 'SYS_ON', label: '系统标已开', flags: { systemInvoiced: true } },
  { value: 'SYS_OFF', label: '系统标未开', flags: { systemInvoiced: false } },
];

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

// ── 状态机：标准流转允许的目标状态 ──────────────────────────────────────
// 这里**不再手抄**后端的 ALLOWED_TRANSITIONS —— 手抄版漂移过四行（PAID/PROCESSING 少
// CHANGE_REQUESTED、CHANGE_REQUESTED 少 PAID/PROCESSING、CHANGED 少 PROCESSING/TICKETED），
// 结果后端合法的流转在前端被当成「需要管理员强制」，运营被迫走 force 通道，把正常操作
// 污染成 FORCE_ORDER_STATUS + WARNING 的强制审计记录，真正该警觉的强制反而被淹没。
// 真源在后端 orders.service.ts 的 ALLOWED_TRANSITIONS，经 serializeOrder 逐单下发到
// order.allowedTransitions；抽屉直接消费它（见 allowedNextOf）。改状态机只需改后端一处。
//
// 缺省空集（fail-closed）：老后端/窄接口没下发时，宁可少给几个「标准流转」按钮
//（管理员仍可用强制通道兜底），也不谎报某个流转合法、让运营点了才被后端拒。
const allowedNextOf = (o: Pick<OrderSummary, 'allowedTransitions'>): OrderStatus[] =>
  o.allowedTransitions ?? [];

// 改状态动作的按钮文案（按「目标状态」）。个别流转的语义取决于来源状态（如退款申请中→处理中
// 其实是「驳回退款」），用 TRANSITION_LABEL_FROM 覆盖；其余用通用文案。
const TRANSITION_LABEL: Record<OrderStatus, string> = {
  DRAFT: '退回草稿',
  PENDING_PAYMENT: '恢复待支付',
  PAID: '标记已支付',
  PROCESSING: '进入处理',
  TICKETED: '出票完成',
  COMPLETED: '订单完结',
  PAYMENT_TIMEOUT: '标记支付超时',
  CANCELLED: '取消订单',
  REFUND_REQUESTED: '申请退款',
  REFUNDED: '同意退款',
  CHANGE_REQUESTED: '申请改期',
  CHANGED: '标记已改期',
  FAILED: '出票失败',
};

// 来源状态相关的特殊文案（覆盖 TRANSITION_LABEL）。
const TRANSITION_LABEL_FROM: Partial<Record<OrderStatus, Partial<Record<OrderStatus, string>>>> = {
  REFUND_REQUESTED: { PROCESSING: '驳回退款（回退处理）' },
  CHANGE_REQUESTED: { TICKETED: '驳回改期（回退出票）' },
  FAILED: { PROCESSING: '重新处理' },
};

function transitionLabel(from: OrderStatus, to: OrderStatus): string {
  return TRANSITION_LABEL_FROM[from]?.[to] ?? TRANSITION_LABEL[to];
}

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

// 客户端分页每页条数（票务反馈）：默认 50 —— 开票一次最多 50 张的口径，一页正好一批。
const PAGE_SIZE_OPTIONS = [20, 30, 40, 50] as const;
const DEFAULT_PAGE_SIZE = 50;

// 列表「签证」列主显（签证岗反馈）：录单时的签证要求 order.visaStatus，而非履约任务进度。
// NOT_NEEDED → 空白（不需要签证的单不占视觉）；其余映射为短徽标。履约进度改为次要小字附注。
const VISA_REQUIREMENT_BADGE: Record<VisaStatusInput, { label: string; cls: string } | null> = {
  NOT_NEEDED: null,
  NEEDED: { label: '需要签证', cls: 'badge-warning' },
  E_VISA: { label: '电子签', cls: 'badge-info' },
  HAS_VISA: { label: '已签证', cls: 'badge-success' },
};

// 性别小标（列表乘客名后缀）：M→♂ F→♀，其余（X/未录）不标。
function genderMark(g?: string | null): string {
  if (g === 'M') return '♂';
  if (g === 'F') return '♀';
  return '';
}

// 备注预览（票务反馈：线上单靠备注判断是否单独编码出票）：取 notes → internalNotes 的首个非空行
// 做行内截断展示；title 悬浮给两段全文。无备注返回 null。
function deriveNotesPreview(o: OrderSummary): { firstLine: string; fullText: string } | null {
  const notes = (o.notes ?? '').trim();
  const internal = (o.internalNotes ?? '').trim();
  if (!notes && !internal) return null;
  const source = notes || internal;
  const firstLine = source.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!firstLine) return null;
  const fullText = [notes && `备注：${notes}`, internal && `内部备注：${internal}`]
    .filter(Boolean)
    .join('\n');
  return { firstLine, fullText };
}

// 搜索分词（与后端 search 分词口径一致）：按 空格/半角逗号/中文逗号/顿号 切词，词间 AND。
function splitSearchTerms(raw: string): string[] {
  return raw.trim().toLowerCase().split(/[\s,，、]+/).filter(Boolean);
}

// 六态开票筛选（组合式）：维度(去程/回程/系统) × 已开/未开。
// value = `${leg}:${invoiced}`，'' = 全部。票务岗「7/10 去程未开」= 'outbound:false'。
const INVOICE_LEG_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  { value: 'outbound:false', label: '去程未开' },
  { value: 'outbound:true', label: '去程已开' },
  { value: 'return:false', label: '回程未开' },
  { value: 'return:true', label: '回程已开' },
  { value: 'system:false', label: '系统未开' },
  { value: 'system:true', label: '系统已开' },
];
/** 把组合值拆成 { invoiceLeg, invoiced }；空/非法值返回 null（不筛选）。 */
function parseInvoiceLegFilter(v: string): { invoiceLeg: InvoiceLeg; invoiced: boolean } | null {
  if (!v) return null;
  const [leg, inv] = v.split(':');
  if (leg !== 'outbound' && leg !== 'return' && leg !== 'system') return null;
  return { invoiceLeg: leg, invoiced: inv === 'true' };
}
// 出行日期筛选的唯一口径 — 主列表 / 三模板导出 / 全岗总表导出三处共用，
// 保证「导出＝列表所见」，不会因为导出走了另一套日期语义而多带或漏掉订单。
// 两个框各自独立生效，端点就是端点：只填「从」＝从那天起的全部订单；只填「到」＝那天及之前
// 的全部订单；两项都填＝闭区间；两项填同一天＝只看那一天（筛选区的「只看某一天」按钮即做这件事）。
function travelDateRange(from: string, to: string): { travelFrom?: string; travelTo?: string } {
  return { travelFrom: from || undefined, travelTo: to || undefined };
}
// 日期筛选回显 — 用大白话说清「现在到底在筛什么」，尤其是只填一个框时的开区间，
// 免得填了「从」拿到一堆更晚的订单还以为筛选没生效。无筛选返回 null。
function describeDateRange(from: string, to: string): string | null {
  if (!from && !to) return null;
  if (from && to) return from === to ? `${from} 当天` : `${from} 至 ${to}`;
  if (from) return `${from} 起（未设截止）`;
  return `${to} 及之前（未设起始）`;
}
/** 订单含几个航段（FLIGHT 行且有班次）；≥2 视为往返（有回程）。 */
function flightLegCount(order: OrderSummary): number {
  return (order.items ?? []).filter((it) => it.kind === 'FLIGHT' && it.flightScheduleId).length;
}
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

// 派生「签证状态」：扫描全单履约任务里的 VISA_APPLICATION（不限 item kind——签证任务常挂在
// BUNDLE 行或首个订单项上，套餐订单没有独立 VISA 行；只看 kind==='VISA' 会漏掉套餐签证单）。
// 无签证任务 → null（显示「—」）；有「已确认」→ CONFIRMED（已签证）；否则取首个签证任务状态。
// 与后端 signed/unsigned 筛选同源，保证「列表所见 = 筛选所得」。
function deriveVisaStatus(o: OrderSummary): ApiFfStatus | null {
  const visaTasks = (o.items ?? []).flatMap((i) =>
    (i.fulfillmentTasks ?? []).filter((t) => t.type === 'VISA_APPLICATION'),
  );
  if (visaTasks.length === 0) return null;
  if (visaTasks.some((t) => t.status === 'CONFIRMED')) return 'CONFIRMED';
  return visaTasks[0].status ?? 'PENDING';
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

// 列表「开票」列：六态紧凑三点式显示（去 / 回 / 系，✓已开、✗未开）。只读——切换在订单详情里。
// 回程点仅在订单含 ≥2 航段时显示；无机票的订单只显示系统点。
function InvoiceDots({ order }: { order: OrderSummary }) {
  const legs = flightLegCount(order);
  const dot = (label: string, on: boolean) => (
    <span
      className={`inline-flex items-center rounded px-1 text-[11px] font-medium ${
        on ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'
      }`}
    >
      {label}
      {on ? '✓' : '✗'}
    </span>
  );
  return (
    <div className="flex items-center justify-center gap-0.5" title="开票：去程 / 回程 / 系统（在订单详情里切换）">
      {legs >= 1 && dot('去', !!order.outboundInvoiced)}
      {legs >= 2 && dot('回', !!order.returnInvoiced)}
      {dot('系', !!order.systemInvoiced)}
    </div>
  );
}

export function OrdersPage() {
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);
  const bumpSeats = useFlightSeats((s) => s.bumpSeats);
  const isAdmin = user?.role === 'ADMIN';
  // 深链承接：从签证台等页面带 ?q=订单号 跳入时用于填充搜索框并自动开详情抽屉
  const [searchParams] = useSearchParams();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 回收站（仅 ADMIN）：已软删订单弹窗 + 恢复
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [deletedOrders, setDeletedOrders] = useState<DeletedOrderSummary[]>([]);
  const [recycleLoading, setRecycleLoading] = useState(false);
  const [recycleError, setRecycleError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // 回收站搜索：订单号/联系人名/乘客姓名（含中文名），走后端 search 参数模糊匹配
  const [recycleSearch, setRecycleSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | OrderStatus>('');
  const [kindFilter, setKindFilter] = useState<'' | OrderItemKindLabel>('');
  const [channelFilter, setChannelFilter] = useState<'' | 'direct' | 'agent'>('');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  // 公测反馈：中文名/拼音名搜不到 —— 搜索改接后端（防抖后透传 search，匹配订单号/联系人/乘客中英文名）。
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // 客户端分页（票务反馈）：数据仍一次拉 200（后端 search/筛选生效），渲染按页切片。
  // 默认每页 50 = 开票一次最多 50 张的口径；筛选/搜索变化时回到第 1 页（见下方 effect）。
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);
  // 6/16 反馈（业务反馈）：按下单日期(createdAt)筛 — 用于"当天进单多少"的导出
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  // 公测反馈：下单时间可精确到几点几分（统计某时段进单）。日期旁配可选时间输入（HH:mm）；
  // 留空＝整天（历史口径）。快捷预设仍只设日期，时间留空。
  const [createdFromTime, setCreatedFromTime] = useState('');
  const [createdToTime, setCreatedToTime] = useState('');
  // 5/20 反馈：按出行日期筛 + 是否已认领
  const [travelFrom, setTravelFrom] = useState('');
  const [travelTo, setTravelTo] = useState('');
  const [claimFilter, setClaimFilter] = useState<'' | 'unclaimed' | 'mine'>('');
  // ops 确认的筛选（航班号 / 乘客姓名 / 六态开票）— 后端过滤
  const [flightNumberFilter, setFlightNumberFilter] = useState('');
  const [passengerNameFilter, setPassengerNameFilter] = useState('');
  // 六态开票筛选：组合值 `${leg}:${invoiced}`（如 'outbound:false'=去程未开），''=全部
  const [invoiceLegFilter, setInvoiceLegFilter] = useState('');
  // 签证办理状态筛选（后端过滤，与列表「签证」列的**办理进度小字**同源——列主徽标已改为录单签证要求）：
  // ''=全部 / signed=已签证 / unsigned=未签证
  const [visaFilter, setVisaFilter] = useState<'' | 'signed' | 'unsigned'>('');
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
  // 搜索防抖 300ms 后透传后端（乘客中英文名可搜）；深链 ?q= 也走这条，命中订单会被后端召回。
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  // 下单时间起/止：日期 + 可选时间（HH:mm）→ datetime-local 口径 YYYY-MM-DDTHH:mm；无时间＝纯日期（整天）。
  const createdFromParam = createdFrom ? (createdFromTime ? `${createdFrom}T${createdFromTime}` : createdFrom) : '';
  const createdToParam = createdTo ? (createdToTime ? `${createdTo}T${createdToTime}` : createdTo) : '';
  // 列表/导出共用的后端筛选（不含仅前端的 status/kind/channel/agent，与三模板/全岗导出口径一致）。
  const filterQuery = useMemo<ListOrdersParams>(() => {
    const q: ListOrdersParams = {};
    if (createdFromParam) q.from = createdFromParam;
    if (createdToParam) q.to = createdToParam;
    const resolvedTravel = travelDateRange(travelFrom, travelTo);
    if (resolvedTravel.travelFrom) q.travelFrom = resolvedTravel.travelFrom;
    if (resolvedTravel.travelTo) q.travelTo = resolvedTravel.travelTo;
    if (claimFilter === 'unclaimed') q.unclaimedOnly = '1';
    if (debouncedFlightNumber.trim()) q.flightNumber = debouncedFlightNumber.trim();
    if (debouncedPassengerName.trim()) q.passengerName = debouncedPassengerName.trim();
    const invoiceLegParsed = parseInvoiceLegFilter(invoiceLegFilter);
    if (invoiceLegParsed) {
      q.invoiceLeg = invoiceLegParsed.invoiceLeg;
      q.invoiced = invoiceLegParsed.invoiced;
    }
    if (visaFilter) q.visaFulfillmentStatus = visaFilter;
    if (debouncedSearch.trim()) q.search = debouncedSearch.trim();
    return q;
  }, [createdFromParam, createdToParam, travelFrom, travelTo, claimFilter, debouncedFlightNumber, debouncedPassengerName, invoiceLegFilter, visaFilter, debouncedSearch]);
  // 三模板筛选导出（全岗可用/票务专用/签证专用）
  const [exportTemplate, setExportTemplate] = useState<OrderExportTemplate>('full');
  const [exporting, setExporting] = useState(false);
  // 全岗总表导出（一行/乘客·字段全）
  const [exportingMaster, setExportingMaster] = useState(false);
  // 进单统计导出（公测反馈·票务：出发日期 × 产品/团期 × 人数）
  const [exportingIntake, setExportingIntake] = useState(false);
  // 票务开票快捷导出 — 某日某航段需开票订单（《票务专用》= 航司 PNR 模板）
  const [showTicketingQuick, setShowTicketingQuick] = useState(false);
  const [tkDate, setTkDate] = useState(''); // 出发日期（必填）
  const [tkLeg, setTkLeg] = useState<InvoiceLeg>('outbound'); // 航段，默认去程
  const [tkInvoiced, setTkInvoiced] = useState(false); // 开票状态，默认「未开」
  const [tkFlightNumber, setTkFlightNumber] = useState(''); // 航班号（选填，缩小同日多航班范围）
  const [tkKind, setTkKind] = useState<'' | 'FLIGHT' | 'BUNDLE'>(''); // 订单类型（选填：机票单/套餐单，避免同航班混单）
  const [tkExporting, setTkExporting] = useState(false);
  // 票务快捷面板预览（票务反馈 T4）：字段变化时防抖查一次「匹配 N 条」，导出前就能确认范围对不对，
  // 而不是导出完打开表格才发现——面板本身此前不触发任何查询，是「筛了没生效」错觉的另一个来源。
  const [tkPreviewLoading, setTkPreviewLoading] = useState(false);
  const [tkPreviewError, setTkPreviewError] = useState<string | null>(null);
  const [tkPreviewTotal, setTkPreviewTotal] = useState<number | null>(null);
  const [tkPreviewOrders, setTkPreviewOrders] = useState<OrderSummary[]>([]);
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
  // 批量开票（票务岗 0715 反馈）：按航段/系统三个布尔位批量翻转，逐单复用单条开票的上限校验。
  const [bulkInvoiceFlag, setBulkInvoiceFlag] = useState<BulkInvoiceFlagOption | ''>('');
  const [bulkInvoiceSubmitting, setBulkInvoiceSubmitting] = useState(false);
  const [bulkInvoiceResult, setBulkInvoiceResult] = useState<{
    succeeded: number;
    failed: number;
    failures: Array<{ id: string; error?: string }>;
  } | null>(null);
  // 强制模式默认关：强制把已取消/超时等「非占座」订单拉回 PAID/PROCESSING 等「占座」状态时会
  // 重新占座（余位不足会被拒绝），必须是运营每次主动勾选的动作，不能默认开着让人顺手误触。
  const [forceMode, setForceMode] = useState(false);
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
    api.listOrders(tokens.accessToken, { ...filterQuery, pageSize: 200 })
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
  }, [tokens?.accessToken, filterQuery, refreshNonce]);

  // 勾选随后端筛选结果收敛（票务反馈 T2）：筛选变化重新拉单后，勾选集合里若还留着不在新结果中的
  // id，会被悄悄带进导出（例如先宽筛选全选，再收窄筛选，导出仍按旧勾选出全团期订单，含已开票的）。
  // 每次后端订单列表更新后收敛为交集，「已选 N 条」提示条和三个导出按钮据此天然保持准确。
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(orders.map((o) => o.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [orders]);

  // 票务快捷面板预览（票务反馈 T4）：面板打开且未勾选订单时，出发日期/航段/开票状态/航班号/
  // 订单类型任一变化，400ms 防抖后查一次匹配数——面板本身不参与主列表筛选，之前完全没有反馈。
  useEffect(() => {
    if (!showTicketingQuick || !tokens?.accessToken) return;
    if (selectedIds.size > 0) {
      // 有勾选就按勾选导出，忽略面板筛选，不用查预览。
      setTkPreviewTotal(null);
      setTkPreviewOrders([]);
      setTkPreviewError(null);
      setTkPreviewLoading(false);
      return;
    }
    if (!tkDate) {
      setTkPreviewTotal(null);
      setTkPreviewOrders([]);
      setTkPreviewError(null);
      setTkPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setTkPreviewLoading(true);
    const t = setTimeout(() => {
      const query: ListOrdersParams = { pageSize: 5, travelFrom: tkDate, travelTo: tkDate, invoiceLeg: tkLeg, invoiced: tkInvoiced };
      const trimmedFlightNumber = tkFlightNumber.trim();
      if (trimmedFlightNumber) query.flightNumber = trimmedFlightNumber;
      if (tkKind) query.kind = tkKind;
      api.listOrders(tokens.accessToken as string, query)
        .then((res) => {
          if (cancelled) return;
          setTkPreviewTotal(res.pagination.total);
          setTkPreviewOrders(res.orders.slice(0, 5));
          setTkPreviewError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setTkPreviewError(err instanceof ApiError ? err.message : '预览失败');
          setTkPreviewTotal(null);
          setTkPreviewOrders([]);
        })
        .finally(() => {
          if (!cancelled) setTkPreviewLoading(false);
        });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [showTicketingQuick, tokens?.accessToken, tkDate, tkLeg, tkInvoiced, tkFlightNumber, tkKind, selectedIds]);

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
      if (search.trim()) {
        // 与后端 search 口径对齐的超集（订单号/客户/联系人/电话/代理/乘客中英文名+证件号/六段备注），
        // 保证后端召回的单不会被前端二次过滤误藏；并为已加载页补上即时匹配。
        // 分词口径与后端一致：空格/逗号/中文逗号/顿号切词，词间 AND（每个词命中任一字段即可）。
        const terms = splitSearchTerms(search);
        const hay = [
          order.orderNumber,
          view.customerName,
          order.contactName,
          order.contactPhone,
          view.agentName ?? '',
          order.notes ?? '',
          order.internalNotes ?? '',
          order.noteHotel ?? '',
          order.noteVisa ?? '',
          order.notePayment ?? '',
          order.noteSpecial ?? '',
          ...order.passengers.flatMap((p) => [p.fullName, p.chineseName ?? '', p.documentNumber ?? '']),
        ].map((s) => s.toLowerCase());
        // 列表接口目前不回传乘客证件号（窄 select）：按护照号搜索时后端能召回、前端 hay 却看不见。
        // 该情况下对「后端已核验过的词」（已进防抖 debouncedSearch 的词）放行，宁可短暂多显示，
        // 绝不把后端召回的单误藏。待列表接口补回 documentNumber 后此回退自然失效（docsKnown=true）。
        const docsUnknown =
          order.passengers.length > 0 && order.passengers.every((p) => p.documentNumber === undefined);
        const backendVetted = docsUnknown ? splitSearchTerms(debouncedSearch) : [];
        if (
          !terms.every(
            (t) => hay.some((s) => s.includes(t)) || (docsUnknown && backendVetted.includes(t)),
          )
        ) {
          return false;
        }
      }
      return true;
    });
  }, [ordersView, statusFilter, kindFilter, channelFilter, agentFilter, search, debouncedSearch]);

  // 筛选/搜索一变就回第 1 页（含后端筛选 filterQuery：出行日期/航班号/开票状态等）。
  useEffect(() => {
    setPage(1);
  }, [statusFilter, kindFilter, channelFilter, agentFilter, search, filterQuery, pageSize]);

  // 客户端分页切片：page 越界时（筛选后条数变少）钳到最后一页，保证永远有内容可看。
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const paged = useMemo(
    () => filtered.slice(pageStart, pageStart + pageSize),
    [filtered, pageStart, pageSize],
  );

  // ── 深链承接（?q=订单号）─────────────────────────────────────
  // 从签证台订单号点入时：先把订单号填进搜索框（前端过滤已支持订单号），
  // 待列表加载完且过滤后唯一/精确命中时自动打开详情抽屉；命中不在默认查询范围时后端兜底查一次。
  const deepLinkSearchRef = useRef(false); // 只填一次搜索框，之后不覆盖用户输入
  const deepLinkOpenRef = useRef(false); // 只自动开一次抽屉
  useEffect(() => {
    const q = searchParams.get('q')?.trim();
    if (!q || deepLinkSearchRef.current) return;
    deepLinkSearchRef.current = true;
    setSearch(q);
  }, [searchParams]);
  useEffect(() => {
    const q = searchParams.get('q')?.trim();
    if (!q || deepLinkOpenRef.current || loading) return;
    // 等 setSearch 生效、filtered 已按订单号收敛后再判定
    if (search.trim().toLowerCase() !== q.toLowerCase()) return;
    const exact = filtered.find(
      ({ order }) => order.orderNumber.toLowerCase() === q.toLowerCase(),
    );
    if (exact || filtered.length === 1) {
      deepLinkOpenRef.current = true;
      setSelected((exact ?? filtered[0]).order);
      return;
    }
    if (filtered.length === 0) {
      // 不在默认查询范围 → 后端按订单号精确查一次兜底（只查一次）
      deepLinkOpenRef.current = true;
      const t = tokens?.accessToken;
      if (!t) return;
      api
        .listOrders(t, { search: q, pageSize: 20 })
        .then((res) => {
          const found =
            res.orders.find((o) => o.orderNumber.toLowerCase() === q.toLowerCase()) ?? null;
          if (found) setSelected(found);
        })
        .catch(() => {
          /* 深链兜底失败静默：不打断主列表 */
        });
    }
    // filtered.length > 1 且无精确命中：保留搜索结果，不自动开抽屉（用户手动挑）
  }, [searchParams, search, loading, filtered, tokens?.accessToken]);

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
      // 状态流转可能占用/释放机位（确认占座、取消/退款回收）→ 广播座位变更。
      bumpSeats();
    } catch (err) {
      alert(err instanceof ApiError ? `操作失败：${err.message}` : '操作失败');
    }
  };

  // 删除订单（仅 ADMIN）：取消 + 释放机位/酒店库存
  const deleteOrder = async (order: OrderSummary) => {
    if (!tokens?.accessToken) return;
    const confirmed = window.confirm(
      `删除订单 ${order.orderNumber}？\n\n` +
        `软删除：订单从所有列表/导出/统计里消失，数据保留可追溯（审计记录），不影响座位账。\n` +
        `注意：仍占座的订单需先取消订单释放座位，才能删除。`,
    );
    if (!confirmed) return;
    try {
      await api.deleteOrder(tokens.accessToken, order.id);
      // 软删后该单从列表隐藏 → 从本地列表移除，并关闭抽屉（若打开的是这单）。
      setOrders((prev) => prev.filter((o) => o.id !== order.id));
      setSelected((prev) => (prev && prev.id === order.id ? null : prev));
      // 软删不触碰库存/座位账，无需广播座位变更。
    } catch (err) {
      // 占座守卫等 4xx 的后端提示（如「请先取消订单释放座位，再删除」）直接透传。
      alert(err instanceof ApiError ? `删除失败：${err.message}` : '删除失败');
    }
  };

  // 拉已软删订单列表；search 非空时走后端模糊匹配（订单号/联系人名/乘客姓名含中文名）。
  const fetchDeletedOrders = async (search: string) => {
    if (!tokens?.accessToken) return;
    setRecycleLoading(true);
    setRecycleError(null);
    try {
      const res = await api.listDeletedOrders(tokens.accessToken, {
        pageSize: 200,
        search: search.trim() || undefined,
      });
      setDeletedOrders(res.orders);
    } catch (err) {
      setRecycleError(err instanceof ApiError ? err.message : '加载回收站失败');
    } finally {
      setRecycleLoading(false);
    }
  };

  // 打开回收站（仅 ADMIN）→ 重置搜索框 + 拉已软删订单列表
  const openRecycleBin = async () => {
    setShowRecycleBin(true);
    setRecycleSearch('');
    await fetchDeletedOrders('');
  };

  // 搜索框输入变化后 400ms 防抖重查；仅在弹窗打开时生效，关闭后不空跑。
  useEffect(() => {
    if (!showRecycleBin) return;
    const timer = setTimeout(() => {
      void fetchDeletedOrders(recycleSearch);
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recycleSearch, showRecycleBin]);

  // 恢复一单：deletedAt 置回 null → 从回收站表移除 + 刷新主列表（恢复的单重新出现）。
  // 软删/恢复都不触碰座位账，无需广播座位变更。
  const restoreOrder = async (o: DeletedOrderSummary) => {
    if (!tokens?.accessToken) return;
    const confirmed = window.confirm(
      `恢复订单 ${o.orderNumber}？\n\n` +
        `恢复后订单回到删除前状态（${STATUS_LABEL[o.status]}），重新出现在列表/导出/统计。不影响座位账。`,
    );
    if (!confirmed) return;
    setRestoringId(o.id);
    try {
      await api.restoreOrder(tokens.accessToken, o.id);
      setDeletedOrders((prev) => prev.filter((d) => d.id !== o.id));
      setRefreshNonce((n) => n + 1);
    } catch (err) {
      alert(err instanceof ApiError ? `恢复失败：${err.message}` : '恢复失败');
    } finally {
      setRestoringId(null);
    }
  };

  // ── 批量管理 helpers ─────────────────────────────────
  // 「全选」只作用于**当前页**可见行（客户端分页后语义收窄）：避免批量改状态/开票/到账
  // 时把翻页后看不见的行一起带进去误伤；跨页多选可翻页后继续勾，勾选集合跨页保留。
  const visibleIds = useMemo(() => paged.map(({ order }) => order.id), [paged]);
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
  const clearSelection = () => { setSelectedIds(new Set()); setBulkResult(null); setBulkInvoiceResult(null); };

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
  // 已选订单的乘客总人数（票务开票凑人数用：套票几十人一起开票，选够 46 人不用手算）。
  const selectedPax = useMemo(
    () => selectedOrders.reduce((sum, o) => sum + o.passengers.length, 0),
    [selectedOrders],
  );

  const applyBulkStatus = async () => {
    if (!tokens?.accessToken || !bulkStatus || selectedIds.size === 0) return;
    const confirmMsg = forceMode
      ? `强制将 ${selectedIds.size} 条订单改为「${STATUS_LABEL[bulkStatus as OrderStatus]}」？此操作绕过状态机校验。\n\n强制把已取消/超时的订单拉回持有状态会重新占座（余位不足会被拒绝，订单状态不变）；此前版本存在不占座的漏洞，请确认余位充足后再操作。`
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
      if (res.failureCount > 0) {
        window.alert(
          `有 ${res.failureCount} 条订单未能变更为「${STATUS_LABEL[bulkStatus as OrderStatus]}」。\n` +
          `原因通常是状态机不允许该跳转（例如"待支付"须先变为"已支付"才能到"出票完成"）。\n` +
          `如确需强制变更，请勾选「强制」后重试。具体失败原因见下方列表。`,
        );
      }
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

  // 批量开票（票务岗 0715 反馈）：逐单复用单条 setInvoiceFlags 的班次开票上限校验，
  // 单单超限失败不影响其余单；结果展示与 applyBulkStatus 同款（成功/失败汇总 + 失败清单）。
  const applyBulkInvoiceFlags = async () => {
    if (!tokens?.accessToken || !bulkInvoiceFlag || selectedIds.size === 0) return;
    const opt = BULK_INVOICE_FLAG_OPTIONS.find((o) => o.value === bulkInvoiceFlag);
    if (!opt) return;
    if (!window.confirm(`将 ${selectedIds.size} 条订单批量「${opt.label}」？`)) return;
    setBulkInvoiceSubmitting(true);
    setBulkInvoiceResult(null);
    try {
      const ids = Array.from(selectedIds);
      const res = await api.batchInvoiceFlags(tokens.accessToken, ids, opt.flags);
      const updated = await api.listOrders(tokens.accessToken, { pageSize: 200 });
      setOrders(updated.orders);
      setBulkInvoiceResult({
        succeeded: res.succeeded,
        failed: res.failed,
        failures: res.results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error })),
      });
      if (res.failed > 0) {
        window.alert(
          `有 ${res.failed} 条订单未能「${opt.label}」。\n` +
          `常见原因是超出该班次的开票上限。具体失败原因见下方列表。`,
        );
      }
      if (res.failed === 0) {
        setSelectedIds(new Set());
        setBulkInvoiceFlag('');
      }
    } catch (err) {
      alert(err instanceof ApiError ? `批量开票失败：${err.message}` : '批量开票失败');
    } finally {
      setBulkInvoiceSubmitting(false);
    }
  };

  const applyBulkSettlementLock = async (lock: boolean) => {
    if (!tokens?.accessToken || selectedIds.size === 0) return;
    if (!window.confirm(`将${lock ? '锁定' : '解锁'}所选 ${selectedIds.size} 单的结算价？`)) return;
    setBulkSubmitting(true);
    try {
      const res = await api.batchSettlementLock(tokens.accessToken, Array.from(selectedIds), lock);
      setRefreshNonce((n) => n + 1);
      setSelectedIds(new Set());
      if (res.skipped > 0) {
        window.alert(`已${lock ? '锁定' : '解锁'} ${res.updated} 单，跳过 ${res.skipped} 单（订单不存在或已在回收站）。`);
      }
    } catch (err) {
      alert(err instanceof ApiError ? `批量${lock ? '锁定' : '解锁'}失败：${err.message}` : `批量${lock ? '锁定' : '解锁'}失败`);
    } finally {
      setBulkSubmitting(false);
    }
  };

  // 三模板筛选导出 — 用当前筛选条件调后端 xlsx，复用 createObjectURL 下载流
  const handleTemplateExport = async () => {
    if (!tokens?.accessToken) return;
    setExporting(true);
    try {
      // 有勾选就只导勾选的这批（后端以 id 集合为准，忽略下面的筛选条件）。
      const selected = Array.from(selectedIds);
      // 出行日期：与主列表同一条口径（travelDateRange），保证「导出＝列表所见」。
      const resolvedTravel = travelDateRange(travelFrom, travelTo);
      const blob = await api.downloadOrdersTemplateExport(tokens.accessToken, {
        template: exportTemplate,
        // 不透传列表的"状态"筛选：整班/名单导出要覆盖全部「占座」订单（含未支付那单），
        // 否则会漏单（如 4 人分 2 单、只翻了 3 人单为已支付时漏掉 1 人单）。
        // 后端已限定在 COUNTED_STATUSES（占座状态）范围内。
        kind: kindFilter || undefined,
        search: search.trim() || undefined,
        from: createdFromParam || undefined, // 下单时间起（createdAt，可带时间到分）— "当天进单多少"导出
        to: createdToParam || undefined, // 下单时间止（createdAt，可带时间到分）
        travelFrom: resolvedTravel.travelFrom,
        travelTo: resolvedTravel.travelTo,
        flightNumber: flightNumberFilter.trim() || undefined,
        passengerName: passengerNameFilter.trim() || undefined,
        // 六态开票筛选（与列表同源）——票务岗「7/10 去程未开 → 导出」就走这条。
        invoiceLeg: parseInvoiceLegFilter(invoiceLegFilter)?.invoiceLeg,
        invoiced: parseInvoiceLegFilter(invoiceLegFilter)?.invoiced,
        // 签证办理状态（与列表「签证」筛选同源）——保持「导出=列表所见」一致。
        visaFulfillmentStatus: visaFilter || undefined,
        orderIds: selected.length > 0 ? selected : undefined,
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

  // 票务开票快捷导出 — 出发日=某日 + 航段 + 开票状态 → 一键调《票务专用》(ticketing) 三模板导出（航司 PNR 27 列）。
  // 有勾选订单时，优先只导勾选的这批（后端以 id 集合为准，忽略下面的出发日/航段/开票状态等筛选）。
  const handleTicketingQuickExport = async () => {
    if (!tokens?.accessToken) return;
    const selected = Array.from(selectedIds);
    if (selected.length === 0 && !tkDate) {
      alert('请先选择出发日期，或先勾选要导出的订单');
      return;
    }
    setTkExporting(true);
    try {
      const trimmedFlightNumber = tkFlightNumber.trim();
      const blob = await api.downloadOrdersTemplateExport(tokens.accessToken, {
        template: 'ticketing',
        travelFrom: tkDate || undefined, // 出发日当天（起=止）
        travelTo: tkDate || undefined,
        invoiceLeg: tkLeg, // 去程 / 回程
        invoiced: tkInvoiced, // 未开 / 已开
        flightNumber: trimmedFlightNumber || undefined, // 航班号（选填，缩小同日多航班范围）
        kind: tkKind || undefined, // 订单类型（选填：机票单/套餐单，避免同航班混单）
        orderIds: selected.length > 0 ? selected : undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `订单导出-${TEMPLATE_LABEL.ticketing}-${tkDate || new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      alert(err instanceof ApiError ? `导出失败：${err.message}` : '导出失败');
    } finally {
      setTkExporting(false);
    }
  };

  // 全岗总表导出 — 一行/乘客·字段全（PRIMARY 综合台账）。按上方「出行日期」区间选单；无日期=全部。
  const handleMasterExport = async () => {
    if (!tokens?.accessToken) return;
    setExportingMaster(true);
    try {
      // 有勾选就只导勾选的这批（后端以 id 集合为准，忽略 from/to）。
      const selected = Array.from(selectedIds);
      // 出行日期：与主列表/三模板导出同一条口径（travelDateRange）。
      const resolvedTravel = travelDateRange(travelFrom, travelTo);
      const blob = await api.exportMaster(tokens.accessToken, {
        from: resolvedTravel.travelFrom,
        to: resolvedTravel.travelTo,
        role: 'all',
        orderIds: selected.length > 0 ? selected : undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const rangeLabel = selected.length > 0
        ? `勾选${selected.length}条`
        : resolvedTravel.travelFrom || resolvedTravel.travelTo
          ? `${resolvedTravel.travelFrom || '全部'}_${resolvedTravel.travelTo || '全部'}`
          : '全部_全部';
      a.download = `全岗总表_${rangeLabel}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      alert(err instanceof ApiError ? `导出失败：${err.message}` : '导出失败');
    } finally {
      setExportingMaster(false);
    }
  };

  // 进单统计导出（公测反馈·票务）— 按当前筛选（尤其下单时间窗口）导出「出发日期 × 产品/团期」进单表。
  const handleIntakeExport = async () => {
    if (!tokens?.accessToken) return;
    setExportingIntake(true);
    try {
      // 与列表同源的后端筛选（含下单时间可到分钟）；勾选场景不适用（进单统计是按筛选统计，不按勾选）。
      const blob = await api.exportIntake(tokens.accessToken, filterQuery);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const rangeLabel = createdFromParam || createdToParam
        ? `${(createdFromParam || '起始').replace(/:/g, '-')}_${(createdToParam || '至今').replace(/:/g, '-')}`
        : '全部';
      a.download = `进单统计_${rangeLabel}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      alert(err instanceof ApiError ? `导出失败：${err.message}` : '导出失败');
    } finally {
      setExportingIntake(false);
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
            // 筛选是否生效的徽标（票务反馈 T1）：此前只看前端二次过滤（状态/产品/渠道/代理/搜索），
            // 而出行日期/开票/签证/航班号/乘客名等大多在后端过滤——只用这些字段时 filtered.length
            // 始终等于 orders.length，徽标误报「未筛选」，让人以为筛选没生效。这里把后端筛选参数
            // 也纳入判定，只要任一条件生效就高亮显示「已筛选」。
            const hasBackendFilter = Boolean(
              createdFrom || createdTo || travelFrom || travelTo ||
              flightNumberFilter.trim() || passengerNameFilter.trim() ||
              invoiceLegFilter || visaFilter || claimFilter,
            );
            const hasFrontendFilter = filtered.length !== orders.length;
            const isFiltered = hasBackendFilter || hasFrontendFilter;
            return (
              <span className={isFiltered ? 'badge-info' : 'badge-neutral'}>
                {loading
                  ? '加载中…'
                  : isFiltered
                    ? `已筛选 · ${filtered.length} 条`
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
          {/* 录入周期快捷预设：一键设上方「下单时间」起止，导出按此周期（佣金/提成/客户统计） */}
          {([
            ['thisMonth', '本月'],
            ['lastMonth', '上月'],
            ['last30', '近30天'],
          ] as [CreatedPreset, string][]).map(([preset, label]) => (
            <button
              key={preset}
              type="button"
              className="btn-ghost text-sm"
              onClick={() => {
                const [f, t] = createdRangePreset(preset);
                setCreatedFrom(f);
                setCreatedTo(t);
              }}
              title={`设「下单时间」为${label}（导出/统计按此录入周期）`}
            >
              {label}
            </button>
          ))}
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
            title={
              selectedIds.size > 0
                ? `只导出已勾选的 ${selectedIds.size} 条订单`
                : '导出按上方「下单时间」周期（录入日期），用于佣金/提成/客户统计'
            }
          >
            {exporting
              ? '导出中…'
              : selectedIds.size > 0
                ? `📤 导出（已选 ${selectedIds.size} 条）`
                : '📤 导出'}
          </button>
          <button
            className="btn-primary text-sm"
            disabled={loading || exportingMaster}
            onClick={() => void handleMasterExport()}
            title={
              selectedIds.size > 0
                ? `只导出已勾选的 ${selectedIds.size} 条订单（全岗综合台账）`
                : '全岗综合台账：一行一位乘客，涵盖机票/酒店/签证/付款全字段。按上方「出行日期」区间选单，不填=全部。'
            }
          >
            {exportingMaster
              ? '导出中…'
              : selectedIds.size > 0
                ? `📊 导出全岗总表（已选 ${selectedIds.size} 条）`
                : '📊 导出全岗总表'}
          </button>
          <button
            className="btn-secondary text-sm"
            disabled={loading || exportingIntake}
            onClick={() => void handleIntakeExport()}
            title="进单统计：按当前筛选（尤其上方「下单时间」窗口，可精确到分）导出「出发日期 × 产品/团期」的订单数、人数，末行总计。按筛选统计，不按勾选。"
          >
            {exportingIntake ? '导出中…' : '📈 进单统计'}
          </button>
          <button
            type="button"
            className={showTicketingQuick ? 'btn-primary text-sm' : 'btn-secondary text-sm'}
            aria-expanded={showTicketingQuick}
            onClick={() => setShowTicketingQuick((v) => !v)}
            title="导出某日某航段需开票的订单（航司 PNR 模板）"
          >
            🎫 票务开票导出
          </button>
          {isAdmin && (
            <button
              type="button"
              className="btn-ghost text-sm"
              onClick={() => void openRecycleBin()}
              title="查看已删除（软删）的订单，可恢复"
            >
              🗑 回收站
            </button>
          )}
          <p className="w-full text-right text-xs text-ink-muted">
            {selectedIds.size > 0
              ? `已勾选 ${selectedIds.size} 条：三个导出都只导勾选的这些订单（忽略上方筛选）；取消勾选恢复按筛选导出`
              : '《导出》按上方「下单时间」周期（佣金/提成/客户统计）；《全岗总表》按「出行日期」区间（综合台账，不填=全部）；《票务开票导出》按出发日/航段/开票状态'}
          </p>
          {/* 票务开票快捷入口：某日某航段需开票订单一键导《票务专用》（航司 PNR） */}
          {showTicketingQuick && (
            <div className="w-full rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-xs text-ink-muted">
                  出发日期（必填）
                  <input
                    type="date"
                    className="input py-1.5 text-sm"
                    value={tkDate}
                    onChange={(e) => setTkDate(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-ink-muted">
                  航段
                  <select
                    className="input py-1.5 text-sm"
                    value={tkLeg}
                    onChange={(e) => setTkLeg(e.target.value as InvoiceLeg)}
                  >
                    <option value="outbound">去程</option>
                    <option value="return">回程</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-ink-muted">
                  开票状态
                  <select
                    className="input py-1.5 text-sm"
                    value={tkInvoiced ? 'true' : 'false'}
                    onChange={(e) => setTkInvoiced(e.target.value === 'true')}
                  >
                    <option value="false">未开</option>
                    <option value="true">已开</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-ink-muted">
                  航班号（选填）
                  <input
                    type="text"
                    className="input py-1.5 text-sm"
                    placeholder="如 QH9588"
                    value={tkFlightNumber}
                    onChange={(e) => setTkFlightNumber(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-ink-muted">
                  订单类型
                  <select
                    className="input py-1.5 text-sm"
                    value={tkKind}
                    onChange={(e) => setTkKind(e.target.value as '' | 'FLIGHT' | 'BUNDLE')}
                  >
                    <option value="">全部</option>
                    <option value="FLIGHT">仅机票单</option>
                    <option value="BUNDLE">仅套餐单</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="btn-primary text-sm"
                  disabled={(!tkDate && selectedIds.size === 0) || tkExporting}
                  onClick={() => void handleTicketingQuickExport()}
                  title={
                    selectedIds.size > 0
                      ? `只导出已勾选的 ${selectedIds.size} 条订单（航司 PNR 模板，忽略下方出发日/航段等筛选）`
                      : '导出某日某航段需开票的订单（航司 PNR 模板）'
                  }
                >
                  {tkExporting
                    ? '导出中…'
                    : selectedIds.size > 0
                      ? `📤 一键导出（已选 ${selectedIds.size} 条）`
                      : '📤 一键导出'}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-ink-muted">
                {selectedIds.size > 0
                  ? `已勾选优先：三个导出按钮都只导出勾选的订单，下方出发日/航段/开票状态等筛选此时不生效；取消勾选恢复按筛选导出。`
                  : '按「出发日期」当天 + 所选航段 + 开票状态导出《票务专用》（航司 PNR）模板，可再按航班号/订单类型缩小范围。'}
              </p>
              {/* 匹配预览（票务反馈 T4）：导出前先看清楚范围，而不是导出完打开表格才发现筛多了/筛少了。 */}
              <p className="mt-1 text-xs">
                {selectedIds.size > 0 ? (
                  <span className="font-medium text-brand">将按勾选导出 {selectedIds.size} 条（忽略上方筛选）</span>
                ) : !tkDate ? (
                  <span className="text-ink-muted">请先选择出发日期以预览匹配订单</span>
                ) : tkPreviewLoading ? (
                  <span className="text-ink-muted">匹配中…</span>
                ) : tkPreviewError ? (
                  <span className="text-rose-600">预览失败：{tkPreviewError}</span>
                ) : (
                  <>
                    <span className={tkPreviewTotal === 0 ? 'font-medium text-amber-600' : 'font-medium text-brand'}>
                      匹配 {tkPreviewTotal ?? 0} 条
                    </span>
                    {tkPreviewOrders.length > 0 && (
                      <span className="ml-2 text-ink-muted">
                        {tkPreviewOrders.map((o) => o.orderNumber).join('、')}
                        {(tkPreviewTotal ?? 0) > tkPreviewOrders.length ? ' 等' : ''}
                      </span>
                    )}
                    {tkPreviewTotal === 0 && (
                      <span className="ml-2 text-ink-muted">没有匹配订单，检查上方筛选条件后再导出</span>
                    )}
                  </>
                )}
              </p>
            </div>
          )}
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
            <div className="flex gap-1">
              <input
                type="date"
                className="input flex-1"
                value={createdFrom}
                max={createdTo || undefined}
                onChange={(e) => setCreatedFrom(e.target.value)}
                title="按下单日期（录入/创建时间）筛选，配合导出看当天进单量"
              />
              {/* 可选时间（HH:mm）：留空＝当天 00:00 起；填了＝精确到分统计某时段进单 */}
              <input
                type="time"
                className="input w-24"
                value={createdFromTime}
                disabled={!createdFrom}
                onChange={(e) => setCreatedFromTime(e.target.value)}
                title="可选：起始时间（几点几分）。留空＝当天 00:00 起。需先选起始日期"
              />
            </div>
          </div>
          <div>
            <label className="label">下单时间 · 截止</label>
            <div className="flex gap-1">
              <input
                type="date"
                className="input flex-1"
                value={createdTo}
                min={createdFrom || undefined}
                onChange={(e) => setCreatedTo(e.target.value)}
                title="按下单日期（录入/创建时间）筛选，配合导出看当天进单量"
              />
              {/* 可选时间（HH:mm）：留空＝当天 23:59 止；填了＝精确到分 */}
              <input
                type="time"
                className="input w-24"
                value={createdToTime}
                disabled={!createdTo}
                onChange={(e) => setCreatedToTime(e.target.value)}
                title="可选：截止时间（几点几分）。留空＝当天 23:59 止。需先选截止日期"
              />
            </div>
          </div>
          <div>
            <label className="label">出行日期（从）</label>
            <input
              type="date"
              className="input"
              value={travelFrom}
              max={travelTo || undefined}
              onChange={(e) => setTravelFrom(e.target.value)}
              title="按乘客实际出行日期筛选（与下单时间不同）。只填这一项＝这天起的全部订单；只想看某一天，用右边的「只看某一天」"
            />
          </div>
          <div>
            <label className="label">出行日期（到）</label>
            <input
              type="date"
              className="input"
              value={travelTo}
              min={travelFrom || undefined}
              onChange={(e) => setTravelTo(e.target.value)}
              title="按乘客实际出行日期筛选（与下单时间不同）。只填这一项＝这天及之前的全部订单；只想看某一天，用下面的「只看某一天」"
            />
            {/* 「只看某一天」— 高频场景做成一等公民：把两个框都设成同一天，而不是让「从」偷偷变成单日。 */}
            <button
              type="button"
              className="mt-1 text-xs text-brand hover:text-brand-dark disabled:cursor-not-allowed disabled:text-slate-300"
              disabled={!travelFrom && !travelTo}
              title={travelFrom || travelTo ? '把「从」和「到」都设成这一天，只看当天出行的订单' : '先在「从」或「到」里选一个日期'}
              onClick={() => {
                const day = travelFrom || travelTo;
                if (!day) return;
                setTravelFrom(day);
                setTravelTo(day);
              }}
            >
              只看某一天
            </button>
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
            <label className="label">开票筛选</label>
            <select
              className="input"
              value={invoiceLegFilter}
              onChange={(e) => setInvoiceLegFilter(e.target.value)}
              title="按航段/系统的开票状态筛选（六态）：可筛「去程/回程/系统 × 已开/未开」。票务岗「出行日期 + 去程未开」即用此项。"
            >
              {INVOICE_LEG_FILTER_OPTIONS.map((o) => (
                <option key={o.value || 'all'} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">签证状态</label>
            <select
              className="input"
              value={visaFilter}
              onChange={(e) => setVisaFilter(e.target.value as '' | 'signed' | 'unsigned')}
              title="按签证办理状态筛选（与列表「签证」列一致）：已签证=签证办理已确认；未签证=含签证但尚未确认。无签证的订单不计入。"
            >
              <option value="">全部</option>
              <option value="signed">已签证</option>
              <option value="unsigned">未签证</option>
            </select>
          </div>
          <div className="md:col-span-5">
            <label className="label">搜索（订单号 / 客户 / 乘客中英文名 / 代理）</label>
            <input
              className="input"
              placeholder="如 FTM2026 或 张伟 或 总代"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        {(statusFilter || kindFilter || channelFilter || agentFilter || search || flightNumberFilter || passengerNameFilter || invoiceLegFilter || visaFilter || createdFrom || createdTo || travelFrom || travelTo) && (
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            {/* 日期筛选回显 — 两个框各自独立生效，只填一个就是开区间；把当前生效的条件和命中单数
                摊开写清楚，填了「从」却看到更晚的订单时一眼就知道为什么，不用猜。 */}
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>显示 {filtered.length} 条订单</span>
              {(() => {
                const travelEcho = describeDateRange(travelFrom, travelTo);
                const createdEcho = describeDateRange(createdFrom, createdTo);
                return (
                  <>
                    {travelEcho && (
                      <span className="rounded bg-brand-50 px-1.5 py-0.5 font-medium text-brand">
                        出行日期：{travelEcho} · 命中 {filtered.length} 单
                      </span>
                    )}
                    {createdEcho && (
                      <span className="rounded bg-brand-50 px-1.5 py-0.5 font-medium text-brand">
                        下单时间：{createdEcho}
                      </span>
                    )}
                  </>
                );
              })()}
            </span>
            <button
              className="text-brand hover:text-brand-dark"
              onClick={() => {
                setStatusFilter(''); setKindFilter(''); setChannelFilter(''); setAgentFilter(''); setSearch('');
                setFlightNumberFilter(''); setPassengerNameFilter(''); setInvoiceLegFilter(''); setVisaFilter('');
                setCreatedFrom(''); setCreatedTo(''); setCreatedFromTime(''); setCreatedToTime(''); setTravelFrom(''); setTravelTo('');
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
              {' · 共 '}
              <span className="text-brand">{selectedPax}</span> 人
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
              {/* 票务按航段批量开票（见下方「批量开票」控件），整单「出票完成」不在批量目标状态里放开——
                  票务岗口径：批量只做"去程/回程已出票"这类航段级标记，整单终态仍走逐单详情页确认。 */}
              {(Object.keys(STATUS_LABEL) as OrderStatus[])
                .filter((s) => s !== 'TICKETED')
                .map((s) => (
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
              className="btn-secondary text-sm py-1.5 disabled:opacity-50"
              onClick={() => void applyBulkSettlementLock(true)}
              disabled={bulkSubmitting || bulkInvoiceSubmitting}
            >
              锁结算价
            </button>
            <button
              className="btn-secondary text-sm py-1.5 disabled:opacity-50"
              onClick={() => void applyBulkSettlementLock(false)}
              disabled={bulkSubmitting || bulkInvoiceSubmitting}
            >
              解锁结算价
            </button>
            <button
              className="btn-ghost text-sm"
              onClick={clearSelection}
              disabled={bulkSubmitting}
            >
              清除选择
            </button>
          </div>
          {/* 批量开票（票务岗 0715 反馈）：单条详情页逐个翻转太麻烦，这里一次给勾选的这批订单
              统一打航段/系统开票标记；单单超班次开票上限会失败，其余单不受影响。 */}
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-brand/15 pt-3">
            <label className="text-sm text-ink-soft">批量开票：</label>
            <select
              className="input max-w-[10rem] py-1.5"
              value={bulkInvoiceFlag}
              onChange={(e) => setBulkInvoiceFlag(e.target.value as BulkInvoiceFlagOption | '')}
              disabled={bulkInvoiceSubmitting}
            >
              <option value="">选择开票标记…</option>
              {BULK_INVOICE_FLAG_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <button
              className="btn-primary text-sm py-1.5 disabled:opacity-50"
              onClick={() => void applyBulkInvoiceFlags()}
              disabled={!bulkInvoiceFlag || bulkInvoiceSubmitting}
            >
              {bulkInvoiceSubmitting ? '处理中…' : `应用到 ${selectedIds.size} 条`}
            </button>
          </div>
          {bulkInvoiceResult && (
            <div
              className={`mt-3 rounded-lg border-2 px-4 py-3 text-sm ${
                bulkInvoiceResult.failed > 0
                  ? 'border-rose-300 bg-rose-50'
                  : 'border-emerald-200 bg-emerald-50'
              }`}
            >
              <div
                className={`font-semibold ${
                  bulkInvoiceResult.failed > 0 ? 'text-rose-700' : 'text-emerald-700'
                }`}
              >
                ✓ 成功 {bulkInvoiceResult.succeeded} 条
                {bulkInvoiceResult.failed > 0 && (
                  <span className="ml-3">✗ 失败 {bulkInvoiceResult.failed} 条</span>
                )}
              </div>
              {bulkInvoiceResult.failed > 0 && (
                <div className="mt-1 text-xs text-rose-700">
                  失败订单常见原因是超出该班次的开票上限，详见下方列表。
                </div>
              )}
              {bulkInvoiceResult.failures.length > 0 && (
                <ul className="mt-2 max-h-40 overflow-auto rounded border border-rose-200 bg-white px-2 py-1.5 text-red-600">
                  {bulkInvoiceResult.failures.map((f) => {
                    const orderNo = orders.find((o) => o.id === f.id)?.orderNumber ?? `${f.id.slice(0, 8)}…`;
                    return (
                      <li key={f.id} className="py-0.5 text-[11px]">
                        · <span className="font-mono">{orderNo}</span>：{f.error ?? '未知原因'}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
          {bulkResult && (
            <div
              className={`mt-3 rounded-lg border-2 px-4 py-3 text-sm ${
                bulkResult.failureCount > 0
                  ? 'border-rose-300 bg-rose-50'
                  : 'border-emerald-200 bg-emerald-50'
              }`}
            >
              <div
                className={`font-semibold ${
                  bulkResult.failureCount > 0 ? 'text-rose-700' : 'text-emerald-700'
                }`}
              >
                ✓ 成功 {bulkResult.successCount} 条
                {bulkResult.failureCount > 0 && (
                  <span className="ml-3">✗ 失败 {bulkResult.failureCount} 条</span>
                )}
              </div>
              {bulkResult.failureCount > 0 && (
                <div className="mt-1 text-xs text-rose-700">
                  失败订单未按状态机允许路径流转（例如"待支付"须先变为"已支付"才能到"出票完成"）。如需强制变更，请勾选上方「强制」后重试。
                </div>
              )}
              {bulkResult.failures.length > 0 && (
                <ul className="mt-2 max-h-40 overflow-auto rounded border border-rose-200 bg-white px-2 py-1.5 text-red-600">
                  {bulkResult.failures.map((f) => {
                    const orderNo = orders.find((o) => o.id === f.id)?.orderNumber ?? `${f.id.slice(0, 8)}…`;
                    return (
                      <li key={f.id} className="py-0.5 text-[11px]">
                        · <span className="font-mono">{orderNo}</span>：{f.error ?? '未知原因'}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <section className="card p-0 overflow-hidden">
        {/* 分页工具条（票务反馈）：每页 20/30/40/50（默认 50 = 一次开票上限口径）+ 上一页/下一页
            + 「第 x-y 条 / 共 N 条」。数据仍一次拉全（≤200），只是渲染分页。 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-2 text-sm text-ink-soft">
          <div className="flex items-center gap-2">
            <span>每页</span>
            <select
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              aria-label="每页条数"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>{n} 条</option>
              ))}
            </select>
            <span className="text-xs text-ink-muted">表头「全选」只选当前页，翻页后可继续勾选累加</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="nums text-xs text-ink-muted">
              {filtered.length === 0
                ? '共 0 条'
                : `第 ${pageStart + 1}-${Math.min(pageStart + pageSize, filtered.length)} 条 / 共 ${filtered.length} 条`}
            </span>
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-sm disabled:opacity-40"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
            >
              上一页
            </button>
            <span className="nums text-xs">{currentPage} / {totalPages}</span>
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-sm disabled:opacity-40"
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
            >
              下一页
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th className="w-10 text-center">
                  <input
                    type="checkbox"
                    className="accent-brand"
                    aria-label="全选当前页"
                    title="全选当前页（不含其它页）"
                    checked={allVisibleSelected}
                    ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                    onChange={toggleAllVisible}
                  />
                </th>
                <th className="w-12 text-center">序号</th>
                <th className="text-left">订单号</th>
                <th className="text-left">客户 / 代理</th>
                <th className="text-left">内容</th>
                <th className="whitespace-nowrap text-left">出发日期</th>
                <th className="text-right">金额</th>
                <th className="text-center">尾款</th>
                <th className="text-center">状态</th>
                <th className="text-center">签证</th>
                <th className="text-center">开票</th>
                <th className="text-left">下单时间</th>
                <th className="whitespace-nowrap text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {paged.map(({ order, view }, idx) => (
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
                  {/* 序号随当前排序/筛选跨页连续编号（第 2 页从 pageSize+1 起），方便对照人数/口头沟通 */}
                  <td className="nums text-center text-xs text-ink-muted">{pageStart + idx + 1}</td>
                  <td className="text-xs">
                    <button
                      type="button"
                      className="font-mono text-brand hover:text-brand-dark hover:underline"
                      onClick={() => setSelected(order)}
                      title="查看详情"
                    >
                      {order.orderNumber}
                    </button>
                  </td>
                  <td>
                    <div className="font-medium text-ink">{view.customerName}</div>
                    <div className="text-xs text-ink-muted">{order.contactPhone}</div>
                    {view.agentName && (
                      <div className="badge-info mt-0.5">
                        {view.agentName}
                      </div>
                    )}
                    {/* 备注预览（票务反馈）：线上单靠备注判断是否单独编码出票，行内给首行截断，悬浮看全文 */}
                    {(() => {
                      const np = deriveNotesPreview(order);
                      return np ? (
                        <div
                          className="mt-0.5 max-w-[11rem] truncate text-[11px] text-amber-700"
                          title={np.fullText}
                        >
                          📝 {np.firstLine}
                        </div>
                      ) : null;
                    })()}
                  </td>
                  <td>
                    <div className="max-w-xs truncate text-ink" title={view.itemSummary}>
                      {view.itemSummary}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5">{KIND_LABEL[view.itemKind]}</span>
                      <span><span className="nums font-medium text-ink">{order.passengers.length}</span> 人</span>
                    </div>
                    {order.passengers.length > 0 && (() => {
                      // 姓名后缀性别小标（♂/♀；列表接口未回传性别时自然不标，不占位）
                      const names = order.passengers.map((p) => {
                        const base = p.chineseName?.trim() || p.fullName;
                        const g = genderMark(p.gender);
                        return g ? `${base}${g}` : base;
                      });
                      const terms = splitSearchTerms(search);
                      // 搜索命中某乘客时优先展示命中者（「张三 +3 同行」），不再平铺全部同行人。
                      // 分词后任一词命中即算命中（与 filtered 的 AND 口径不同：这里只挑「展示谁」）。
                      const hitIdx = terms.length
                        ? order.passengers.findIndex((p) =>
                            terms.some(
                              (t) =>
                                (p.chineseName?.toLowerCase().includes(t) ?? false) ||
                                p.fullName.toLowerCase().includes(t) ||
                                (p.documentNumber?.toLowerCase().includes(t) ?? false),
                            ),
                          )
                        : -1;
                      if (hitIdx >= 0) {
                        const companions = names.length - 1;
                        return (
                          <div className="mt-0.5 max-w-xs truncate text-[11px] text-ink-muted" title={names.join('、')}>
                            <span className="font-medium text-brand">{names[hitIdx]}</span>
                            {companions > 0 ? ` +${companions} 同行` : ''}
                          </div>
                        );
                      }
                      const shown = names.slice(0, 3);
                      const hasMore = names.length > shown.length;
                      return (
                        <div className="mt-0.5 max-w-xs truncate text-[11px] text-ink-muted" title={names.join('、')}>
                          {shown.join('、')}{hasMore ? ` 等${names.length}人` : ''}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="nums whitespace-nowrap text-left text-xs text-ink-soft">
                    {order.departDate ?? <span className="text-ink-muted">—</span>}
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
                      // 签证列语义（签证岗反馈）：主显**录单签证要求** order.visaStatus
                      // （需要签证/电子签/已签证；不需要=空白），签证岗一眼看出哪些单要办签。
                      // 履约任务进度降为次要小字附注（办理中/已确认…），两层信息主次分明。
                      const requirement = order.visaStatus ? VISA_REQUIREMENT_BADGE[order.visaStatus] : undefined;
                      const progress = deriveVisaStatus(order);
                      if (!requirement && !progress) {
                        // NOT_NEEDED → 空白（不需要签证的单不占视觉）；未录签证要求的老单 → 维持「—」占位
                        return order.visaStatus === 'NOT_NEEDED'
                          ? null
                          : <span className="text-xs text-ink-muted">—</span>;
                      }
                      return (
                        <div className="flex flex-col items-center gap-0.5">
                          {requirement && <span className={requirement.cls}>{requirement.label}</span>}
                          {progress && (
                            <span className="text-[10px] text-ink-muted" title="签证履约任务进度">
                              办理：{FF_STATUS_LABEL[progress] ?? progress}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="text-center">
                    <InvoiceDots order={order} />
                  </td>
                  <td className="text-xs text-ink-muted">
                    {new Date(order.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                  <td className="whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      <select
                        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-ink-soft disabled:opacity-50"
                        value=""
                        onChange={(e) => {
                          const next = e.target.value as OrderStatus;
                          if (!next) return;
                          const msg = forceMode
                            ? `强制将 ${order.orderNumber} 改为「${STATUS_LABEL[next]}」？此操作绕过状态机校验。\n\n强制把已取消/超时的订单拉回持有状态会重新占座（余位不足会被拒绝，订单状态不变）；此前版本存在不占座的漏洞，请确认余位充足后再操作。`
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
                      <button className="whitespace-nowrap text-sm font-medium text-brand hover:text-brand-dark" onClick={() => setSelected(order)}>
                        详情
                      </button>
                      {isAdmin && (
                        <button
                          className="whitespace-nowrap text-xs text-rose-500 hover:text-rose-700"
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
                  <td colSpan={13} className="py-8 text-center text-ink-muted">
                    没有符合条件的订单
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={13} className="py-8 text-center text-ink-muted">加载中…</td>
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
          onAdvance={(next, reason, force) => advance(selected, next, reason, force)}
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
          onCreated={() => {
            setRefreshNonce((n) => n + 1);
            bumpSeats();
          }}
        />
      )}

      {showSingleCreate && (
        <SingleOrderModal
          onClose={() => setShowSingleCreate(false)}
          onCreated={() => {
            setRefreshNonce((n) => n + 1);
            bumpSeats();
          }}
        />
      )}

      {/* 回收站（仅 ADMIN）：已软删订单表 + 每行恢复 */}
      {showRecycleBin && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setShowRecycleBin(false)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-6 py-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-ink">🗑 订单回收站</h2>
                <p className="mt-0.5 text-xs text-ink-muted">
                  已删除的订单（不出现在列表/导出/统计）。恢复后回到删除前状态，重新可见；不影响座位账。
                </p>
              </div>
              <button
                className="btn-ghost px-2 py-1 text-xl leading-none"
                onClick={() => setShowRecycleBin(false)}
              >
                ×
              </button>
            </div>
            <div className="border-b border-slate-200 px-6 py-3">
              <input
                type="search"
                value={recycleSearch}
                onChange={(e) => setRecycleSearch(e.target.value)}
                placeholder="搜索订单号 / 乘客姓名…"
                className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
              />
            </div>
            <div className="flex-1 overflow-auto px-6 py-5">
              {recycleLoading ? (
                <p className="py-8 text-center text-sm text-ink-muted">载入中…</p>
              ) : recycleError ? (
                <p className="py-8 text-center text-sm text-rose-600">{recycleError}</p>
              ) : deletedOrders.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-muted">
                  {recycleSearch ? '没有匹配的已删除订单' : '回收站为空'}
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-ink-muted">
                      <th className="py-2 pr-3 font-medium">订单号</th>
                      <th className="py-2 pr-3 font-medium">客户 / 乘客</th>
                      <th className="py-2 pr-3 font-medium">出发日期</th>
                      <th className="py-2 pr-3 font-medium">金额</th>
                      <th className="py-2 pr-3 font-medium">原状态</th>
                      <th className="py-2 pr-3 font-medium">删除时间</th>
                      <th className="py-2 pr-3 font-medium text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deletedOrders.map((o) => {
                      const names = o.passengerNames ?? [];
                      const shownNames = names.slice(0, 3);
                      const hasMoreNames = names.length > shownNames.length;
                      return (
                        <tr key={o.id} className="border-b border-slate-100">
                          <td className="py-2 pr-3 font-mono text-xs">{o.orderNumber}</td>
                          <td className="py-2 pr-3">
                            <div>{o.customerName}</div>
                            {names.length > 0 && (
                              <div
                                className="mt-0.5 max-w-[220px] truncate text-[11px] text-ink-muted"
                                title={names.join('、')}
                              >
                                {shownNames.join('、')}{hasMoreNames ? ` 等${names.length}人` : ''}
                              </div>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-xs text-ink-muted">
                            {o.departDate ?? '—'}
                          </td>
                          <td className="nums py-2 pr-3">¥{Number(o.total).toLocaleString()}</td>
                          <td className="py-2 pr-3">
                            <span className={STATUS_COLOR[o.status]}>{STATUS_LABEL[o.status]}</span>
                          </td>
                          <td className="py-2 pr-3 text-xs text-ink-muted">
                            {o.deletedAt ? new Date(o.deletedAt).toLocaleString('zh-CN') : '—'}
                            {o.deletedBy ? (
                              <span className="block text-[11px]">操作人：{o.deletedBy}</span>
                            ) : null}
                          </td>
                          <td className="py-2 pr-3 text-right">
                            <button
                              type="button"
                              className="btn-secondary text-xs"
                              disabled={restoringId === o.id}
                              onClick={() => void restoreOrder(o)}
                            >
                              {restoringId === o.id ? '恢复中…' : '恢复'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 酒店 / 分房派生（详情「酒店情况」+ 应分房未分房判定，与房控页同口径）──────
// 订单要显示的酒店中文名。优先取后端联查落的 item.hotelName（HOTEL 行或 BUNDLE 行盖章的
// hotelRoomTypeId 均可命中，套餐订单没有独立 HOTEL 行时也能取到），
// 回退到 HOTEL 行 description（形如「酒店名 · 房型 · …」，取 ' · ' 前段），
// 再回退到已存分房组里带的 hotelName；都取不到返回 null。
function hotelNameFromOrder(order: OrderSummary): string | null {
  const items = (order.items ?? []) as Array<{ hotelName?: string | null; kind?: string; description?: string }>;
  const fromHotelName = items.find((it) => it.hotelName)?.hotelName?.trim();
  if (fromHotelName) return fromHotelName;
  const hotelItem = order.items?.find((it) => it.kind === 'HOTEL');
  const fromItem = hotelItem?.description.split(' · ')[0]?.trim();
  if (fromItem) return fromItem;
  const fromGroup = order.roomAssignment?.roomGroups?.find((g) => g.hotelName)?.hotelName?.trim();
  return fromGroup || null;
}

// 该订单是否「应分房」：含 HOTEL 行，或套餐（BUNDLE）关联了酒店（description 含「酒店」/「N晚」）。
function orderNeedsRooming(order: OrderSummary): boolean {
  const items = order.items ?? [];
  if (items.some((it) => it.kind === 'HOTEL')) return true;
  const bundle = items.find((it) => it.kind === 'BUNDLE');
  if (bundle && /酒店|晚/.test(bundle.description)) return true;
  return false;
}

// 是否已分房（分房表里至少一个含出行人的房间组）。
function orderHasRooming(order: OrderSummary): boolean {
  const groups = order.roomAssignment?.roomGroups ?? [];
  return groups.some((g) => (g.passengerIds?.length ?? 0) > 0);
}

// 占位出行人（纯酒店/接送用联系人占位 documentNumber='N/A'）不进分房池。与房控页同口径。
function toRoomingPassengers(order: OrderSummary): RoomingPassenger[] {
  return order.passengers
    .filter((p) => p.documentNumber !== 'N/A')
    .map((p) => ({ id: p.id, name: p.fullName, gender: p.gender ?? null }));
}

// 分房情况一句话摘要（详情「酒店情况」用；等价旧系统备注里的拼房说明）。
function roomingSummary(order: OrderSummary): string {
  const groups = (order.roomAssignment?.roomGroups ?? []).filter((g) => (g.passengerIds?.length ?? 0) > 0);
  if (groups.length === 0) return '未分房';
  const nameById = new Map(order.passengers.map((p) => [p.id, p.fullName]));
  return groups
    .map((g) => {
      const names = g.passengerIds.map((id) => nameById.get(id) ?? '?').join('、');
      const frac = g.roomFraction === 0.5 ? '半间(拼房)' : '整间';
      const type = g.roomType ? ` ${g.roomType}` : '';
      return `${frac}${type}：${names}`;
    })
    .join('；');
}

// 推导住宿晚数（补收单房差表单的「晚数」默认值，可改）。
// 优先 HOTEL 行 checkIn/checkOut 日差 → 回退任意行描述里的「N晚」→ 兜底 1。
function deriveStayNights(order: OrderSummary): number {
  const items = order.items ?? [];
  const hotel = items.find((it) => it.kind === 'HOTEL' && it.hotelCheckIn && it.hotelCheckOut);
  if (hotel?.hotelCheckIn && hotel?.hotelCheckOut) {
    const nights = Math.round(
      (new Date(hotel.hotelCheckOut).getTime() - new Date(hotel.hotelCheckIn).getTime()) / 86_400_000,
    );
    if (nights >= 1) return nights;
  }
  for (const it of items) {
    const m = /(\d+)\s*晚/.exec(it.description ?? '');
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 60) return n;
    }
  }
  return 1;
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
  onAdvance: (next: OrderStatus, reason?: string, force?: boolean) => void;
  onChanged?: () => void;
  /** 售后改期/换人后用更新后的订单就地刷新抽屉与列表 */
  onOrderUpdated?: (order: OrderSummary) => void;
  /** 删除订单（ADMIN 专用） */
  onDelete?: () => void;
  isAdmin?: boolean;
}) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const role = useAuth((s) => s.user?.role);
  // 内部角色（ADMIN/STAFF）才看逐项拆价折叠区；AGENT/CUSTOMER 只看「产品内容 + 订单总价」，不露内部金额明细。
  const canSeeInternal = role === 'ADMIN' || role === 'STAFF';
  // #8 修复：列表行的 passengers 只有 {id, fullName}（后端 listOrders select 精简），护照号/生日/国籍/类型
  // 恒显示「—」。抽屉打开时用 getOrder 拉全量详情，之后所有子区块都读 hydrated（拿不到时兜底列表行）。
  const [hydrated, setHydrated] = useState<OrderSummary | null>(null);
  const [hydrating, setHydrating] = useState(false);
  // 补水失败不能静默吞掉——否则用户对着列表快照（护照/备注等字段陈旧）编辑还以为是最新。
  // 记一个失败标记，在抽屉里给出轻量提示 + 重试；重试复用同一 loader。
  const [hydrateFailed, setHydrateFailed] = useState(false);
  const hydrate = useCallback(() => {
    if (!token) return () => {};
    let cancelled = false;
    setHydrating(true);
    setHydrateFailed(false);
    api.getOrder(token, order.id)
      .then((r) => { if (!cancelled) setHydrated(r.order); })
      .catch(() => { if (!cancelled) setHydrateFailed(true); })
      .finally(() => { if (!cancelled) setHydrating(false); });
    return () => { cancelled = true; };
  }, [token, order.id]);
  useEffect(() => hydrate(), [hydrate]);
  // 详情各区块统一读 o（详情优先，兜底列表行）。售后改期/换人后用返回的整单同步 hydrated + 列表行。
  const o = hydrated ?? order;
  const view = deriveView(o);
  const bal = deriveBalance(o);
  // 子组件（改期/换人/改价）拿到更新后的整单 → 同步抽屉本地 hydrated + 冒泡给父级刷列表。
  const handleOrderUpdated = (updated: OrderSummary) => {
    setHydrated(updated);
    onOrderUpdated?.(updated);
  };

  // #4/#5 分房：应分房未分房 → 显示「分房」按钮；已分房 → 摘要 + 「调整分房」。
  const hotelName = hotelNameFromOrder(o);
  const needsRooming = orderNeedsRooming(o);
  const hasRooming = orderHasRooming(o);
  const [roomingOpen, setRoomingOpen] = useState(false);
  // 运营专属（ADMIN/STAFF）：更改归属代理 + 事后补收单房差。复用上面已解析的 role。
  const isOps = role === 'ADMIN' || role === 'STAFF';
  const [agentEditOpen, setAgentEditOpen] = useState(false);
  const [roomSupplementOpen, setRoomSupplementOpen] = useState(false);
  const [groundItemKind, setGroundItemKind] = useState<'VISA' | 'HOTEL' | null>(null);

  const saveRooming = async (groups: RoomGroup[]): Promise<void> => {
    if (!token) return;
    const res = await api.updateRoomAssignment(token, o.id, groups);
    // B10：金额分叉 / 混性别 / 多酒店行提示——运营必须看见，但不阻断保存。
    if (res.warnings?.length) alert(res.warnings.join('\n\n'));
    // 重拉详情让「酒店情况」摘要与按钮态即时刷新
    const r = await api.getOrder(token, o.id);
    setHydrated(r.order);
    setRoomingOpen(false);
    onChanged?.();
  };

  // 可行的下一步状态：直接消费后端逐单下发的 allowedTransitions（状态机真源），列出当前状态的
  // 全部合法流转，而非手抄一份（抄的会漂移——漂移后合法流转被逼进 force 通道，污染强制审计）。
  const allowedNext = allowedNextOf(o);
  const nextSteps: Array<{ label: string; to: OrderStatus; style: string }> = allowedNext.map(
    (to, i) => ({ label: transitionLabel(o.status, to), to, style: i === 0 ? 'btn-primary' : 'btn-secondary' }),
  );
  // 终态 = 后端下发的合法流转为空（据此说明「为何没有可用操作」，而不是渲染空白工具条）。
  const isTerminal = allowedNext.length === 0;
  // 管理员强制可选的「越过状态机」目标：所有其它状态里、不在标准流转内的（标准流转已经是普通按钮）。
  const forceTargets: OrderStatus[] = isAdmin
    ? (Object.keys(STATUS_LABEL) as OrderStatus[]).filter(
        (s) => s !== o.status && !allowedNext.includes(s),
      )
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头：订单号 + 状态/类型/签证 徽章 一行看全 */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-ink">订单详情</h2>
              <span className="font-mono text-xs text-ink-muted">{o.orderNumber}</span>
              {hydrating && <span className="text-[11px] text-ink-muted">· 载入详情…</span>}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className={STATUS_COLOR[o.status]}>{STATUS_LABEL[o.status]}</span>
              <span className="badge-neutral">{KIND_LABEL[view.itemKind]}</span>
              {o.visaStatus && (
                <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${VISA_STATUS_BADGE[o.visaStatus]}`}>
                  签证：{VISA_STATUS_LABEL[o.visaStatus]}
                </span>
              )}
              {(() => {
                {/* 签证进度与签证台同源（履约任务派生）——录单级 visaStatus 只表达「要不要签」，
                    流转进度必须读任务状态，否则签证台标了已送签/已签证这里永远不动。 */}
                const vs = deriveVisaStatus(o);
                return vs ? (
                  <span className={FF_STATUS_COLOR[vs]}>签证进度：{FF_STATUS_LABEL[vs] ?? vs}</span>
                ) : null;
              })()}
              <BalanceBadge balance={bal.balance} settlementMode={o.agent?.settlementMode} />
            </div>
          </div>
          <button className="btn-ghost px-2 py-1 text-xl leading-none" onClick={onClose}>×</button>
        </div>

        <div className="flex-1 space-y-5 overflow-auto px-6 py-5">
          {/* 补水失败提示：明确告知展示的是列表快照（可能陈旧），提供重试，避免用户对着旧数据编辑 */}
          {hydrateFailed && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span>详情加载失败，当前展示的是列表快照，可能不是最新——请重试后再编辑。</span>
              <button
                type="button"
                className="shrink-0 font-medium text-amber-900 underline hover:text-amber-950"
                onClick={() => hydrate()}
              >
                重试
              </button>
            </div>
          )}

          {/* 乘客（读 hydrated → 护照号/生日/国籍/类型 真实显示）*/}
          <PassengersSection order={o} onOrderUpdated={handleOrderUpdated} />

          {/* 开票（六态：去程 / 回程 / 系统 三个独立开关）*/}
          <InvoiceFlagsSection order={o} onOrderUpdated={handleOrderUpdated} />

          {/* ── 酒店：拼房卡 + 酒店备注（紧跟乘客区，运营排序需求）── */}
          <section className="space-y-3">
            {/* 酒店情况（酒店中文名 + 拼房/整间 摘要 = 旧系统备注）*/}
            {(needsRooming || hotelName) && (
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">酒店情况 · 拼房</div>
                  <div className="flex items-center gap-2">
                    {/* 事后补收单房差（仅 ADMIN/STAFF）：X元/晚 × N晚，记账、房控可见 */}
                    {isOps && (
                      <button
                        type="button"
                        className="text-[11px] font-medium text-amber-700 hover:text-amber-800"
                        onClick={() => setRoomSupplementOpen(true)}
                        title="按每晚金额 × 晚数补收单房差，计入订单应收/尾款"
                      >
                        补收单房差
                      </button>
                    )}
                    {needsRooming && (
                      hasRooming ? (
                        <button
                          className="text-[11px] font-medium text-brand hover:text-brand-dark"
                          onClick={() => setRoomingOpen(true)}
                        >
                          调整分房
                        </button>
                      ) : (
                        <button
                          className="rounded bg-brand px-2 py-0.5 text-[11px] font-medium text-white hover:bg-brand-dark"
                          onClick={() => setRoomingOpen(true)}
                          title="该订单含酒店但尚未分房 — 点此分房（拖名字到房间）"
                        >
                          🛏 分房
                        </button>
                      )
                    )}
                  </div>
                </div>
                <div className="mt-1.5 text-sm font-medium text-ink">🏨 {hotelName ?? '（未识别酒店名）'}</div>
                <div className={`mt-0.5 text-xs ${hasRooming ? 'text-ink-soft' : 'text-amber-700'}`}>
                  {needsRooming && !hasRooming ? '应分房 · 尚未分房' : roomingSummary(o)}
                </div>
              </div>
            )}

            {o.noteHotel && (
              <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-ink-soft sm:col-span-2">
                <span className="text-ink-muted">酒店备注：</span>{o.noteHotel}
              </div>
            )}
          </section>

          {/* 客户备注 —— key 含补水态：列表快照→补水完成会重挂载，让备注初值对齐服务端权威值
              （补水只在抽屉打开时一次性发生，之后 hydrated 值更新不会改变 key、不打断编辑）。 */}
          <NotesSection
            key={`${o.id}:${hydrated ? 'h' : 'l'}`}
            order={o}
            onOrderUpdated={handleOrderUpdated}
          />

          {/* ── 付款：付款情况卡 + 收款操作（相邻摆放，运营排序需求）── */}
          <section className="space-y-3">
            {/* 付款情况（与列表尾款/状态一致；抵扣读 notePayment）*/}
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">付款情况</div>
              <div className="mt-1.5 flex items-baseline gap-1 text-sm">
                <span className="nums text-lg font-semibold text-emerald-700">¥{bal.paid.toLocaleString()}</span>
                <span className="text-ink-muted"> / 应收 ¥{(bal.total + bal.adjustment).toLocaleString()}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <BalanceBadge balance={bal.balance} settlementMode={o.agent?.settlementMode} />
                {bal.adjustment !== 0 && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700">含售后费 ¥{bal.adjustment.toLocaleString()}</span>
                )}
              </div>
              {o.notePayment && (
                <div className="mt-1.5 rounded bg-white px-2 py-1 text-[11px] text-ink-soft">
                  <span className="text-ink-muted">抵扣/备注：</span>{o.notePayment}
                </div>
              )}
            </div>

            {/* 收款（确认收款 / 代理余额抵扣 / 多付处理）*/}
            <ConfirmPaymentSection
              orderId={o.id}
              total={view.totalNum + (Number(o.adjustmentCny) || 0)}
              paidAmount={Number(o.paidAmount)}
              agent={o.agent}
              onChanged={onChanged}
            />
          </section>

          {/* 财务/出纳：预期到账金额 + 订单杂项成本（仅 ADMIN/STAFF 可见，组件内做权限判断） */}
          <OrderFinanceSection
            orderId={o.id}
            initialExpectedAmountCny={o.expectedAmountCny}
            initialExpectedAmountLocked={o.expectedAmountLocked}
            payableCny={Number(o.total) + Number(o.adjustmentCny ?? 0)}
            onChanged={onChanged}
          />

          {/* 结构化地面项：收入金额从 VISA/HOTEL 行聚合，录入时售价默认带出产品成本。 */}
          <GroundItemsCard
            order={o}
            canEdit={isOps}
            onAdd={(kind) => setGroundItemKind(kind)}
          />

          {/* 产品内容 */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">产品内容</h3>
            {isBundleOrder(o) ? (
              <>
                <div className="mt-2">
                  <BundleItineraryCard items={o.items ?? []} order={o} />
                </div>
                {/* 套餐订单：原始行金额明细折叠隐藏（公测反馈原始金额行「不太实用」），
                    默认收起，点开仍可见 + 改期/改结算价 操作照旧可用。非套餐订单不受影响（见下方 else 分支）。
                    对外脱敏：整段是逐项拆价（我方内部口径），仅内部角色可见；AGENT/CUSTOMER 只看上方产品内容 + 订单总价。 */}
                {canSeeInternal && (
                  <details className="mt-2 rounded-lg border border-slate-200 bg-white">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-ink-muted hover:text-ink">
                      金额明细（点开）
                    </summary>
                    <ul className="space-y-2 border-t border-slate-100 p-3 text-sm">
                      {(o.items ?? []).map((it) => (
                        <OrderItemRow
                          key={it.id}
                          orderId={o.id}
                          item={it}
                          onOrderUpdated={handleOrderUpdated}
                          canEditSettlementPrice={isOps}
                          settlementLocked={o.settlementLocked === true}
                        />
                      ))}
                    </ul>
                  </details>
                )}
              </>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {(o.items ?? []).map((it) => (
                  <OrderItemRow
                    key={it.id}
                    orderId={o.id}
                    item={it}
                    onOrderUpdated={handleOrderUpdated}
                    canEditSettlementPrice={isOps}
                    settlementLocked={o.settlementLocked === true}
                  />
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-ink-muted">
              共 {o.passengers.length} 位乘客
              {o.passengers.length > 0 && (
                <>：{o.passengers.map((p) => p.chineseName?.trim() || p.fullName).join('、')}</>
              )}
            </p>
          </section>

          <PriceAdjustmentSection order={o} onOrderUpdated={handleOrderUpdated} />

          <AdjustmentsSection order={o} />

          <OpsToolbar order={o} onAdvance={onAdvance} />

          {/* 客户（含归属代理 + 更改；运营排序需求置底部区）*/}
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">客户</div>
            <div className="mt-1.5 text-sm font-medium text-ink">{view.customerName}</div>
            <div className="text-xs text-ink-soft">{o.contactPhone}</div>
            {o.contactEmail && <div className="truncate text-xs text-ink-muted">{o.contactEmail}</div>}
            {/* 归属代理徽标 + 更改（仅 ADMIN/STAFF；口径 C 任何状态都能改，留审计） */}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {view.agentName ? (
                <span className="badge-info">{view.agentName}</span>
              ) : (
                <span className="text-[11px] text-ink-muted">直客（无代理）</span>
              )}
              {isOps && (
                <button
                  type="button"
                  className="text-[11px] font-medium text-brand hover:text-brand-dark"
                  onClick={() => setAgentEditOpen(true)}
                >
                  更改
                </button>
              )}
            </div>
            <div className="mt-1 text-[11px] text-ink-muted">下单 {new Date(o.createdAt).toLocaleString('zh-CN')}</div>
          </div>

          <RemindersSection order={o} />

          {/* 操作记录（审计轨迹）：什么时间、哪个账号、改了什么。默认收起，展开才拉数据。 */}
          <OrderAuditTrail orderId={o.id} />

          {/* 更多操作：状态流转 + 管理员强制改状态（运营要求收进默认折叠块；展开后行为与权限逻辑不变） */}
          <details className="rounded-xl border border-slate-200 bg-white">
            <summary className="cursor-pointer select-none px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-muted hover:text-ink">
              更多操作（状态流转）
            </summary>
            <div className="border-t border-slate-100 px-4 pb-4">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">状态流转</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {nextSteps.length === 0 && (
                <div className="w-full rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-xs text-ink-muted">
                  {isTerminal
                    ? `当前为终态「${STATUS_LABEL[o.status]}」，没有后续流转。${
                        isAdmin ? '如需异常订正，可用下方「管理员强制改状态」。' : ''
                      }`
                    : `「${STATUS_LABEL[o.status]}」状态下无标准流转操作。${
                        isAdmin ? '如需异常订正，可用下方「管理员强制改状态」。' : ''
                      }`}
                </div>
              )}
              {nextSteps.map((s) => (
                <button
                  key={s.to}
                  className={`${s.style} flex-1 text-sm`}
                  onClick={() => onAdvance(s.to)}
                  title={`按标准流转：${STATUS_LABEL[o.status]} → ${STATUS_LABEL[s.to]}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-ink-muted">
              ⓘ 状态变更会真实写入数据库并记录操作事件。仅显示当前状态允许的流转；不在此列的目标需管理员强制。
            </p>

            {/* 管理员强制改状态：越过状态机的目标（异常订正用）。被安全规则拦下的操作（如已退款订单
                拉回占座、余位不足重新占座）后端会拒绝并弹出具体原因，不会静默失败。 */}
            {isAdmin && forceTargets.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs font-medium text-amber-800">管理员强制改状态</label>
                  <select
                    className="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs text-ink-soft"
                    value=""
                    title="绕过状态机校验，用于异常订正。仍受安全规则约束（如已退款订单不能拉回占座、重新占座需余位充足），被拒时会弹出具体原因。"
                    onChange={(e) => {
                      const to = e.target.value as OrderStatus;
                      e.currentTarget.value = '';
                      if (!to) return;
                      const ok = window.confirm(
                        `强制将该订单从「${STATUS_LABEL[o.status]}」改为「${STATUS_LABEL[to]}」？\n\n` +
                          '此操作绕过状态机校验，仅供异常订正。若目标为占座状态（已支付/处理中/出票等），' +
                          '会重新占座（余位不足将被拒绝，状态不变）；被安全规则拦下的操作会弹出具体原因。',
                      );
                      if (ok) onAdvance(to, undefined, true);
                    }}
                  >
                    <option value="">强制改为…</option>
                    {forceTargets.map((s) => (
                      <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                    ))}
                  </select>
                </div>
                <p className="mt-1.5 text-[11px] text-amber-700">
                  绕过状态机校验；若被安全规则拦下（如已退款订单不能拉回占座），会弹出具体原因。
                </p>
              </div>
            )}
          </section>
            </div>
          </details>

          {isAdmin && onDelete && (
            <section className="border-t border-rose-100 pt-3">
              <button
                className="w-full rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
                onClick={onDelete}
              >
                删除订单（ADMIN）
              </button>
              <p className="mt-1 text-[11px] text-rose-400">
                软删除：从列表/导出/统计隐藏，数据可追溯，不影响座位账。仍占座需先取消订单释放座位。
              </p>
            </section>
          )}
        </div>
      </div>

      {/* #4 分房弹窗：复用房控页同款 RoomingEditor / updateRoomAssignment 路径 */}
      {roomingOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setRoomingOpen(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <RoomingEditor
              key={o.id}
              passengers={toRoomingPassengers(o)}
              initial={o.roomAssignment?.roomGroups}
              hotelName={hotelName ?? undefined}
              onSave={saveRooming}
              onClose={() => setRoomingOpen(false)}
            />
          </div>
        </div>
      )}

      {/* 更改归属代理弹窗（ADMIN/STAFF） */}
      {agentEditOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setAgentEditOpen(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-auto rounded-2xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <ChangeAgentPanel
              orderId={o.id}
              currentAgentId={o.agentId ?? null}
              onCancel={() => setAgentEditOpen(false)}
              onSaved={(updated, warning) => {
                handleOrderUpdated(updated);
                setAgentEditOpen(false);
                onChanged?.();
                if (warning) alert(warning);
              }}
            />
          </div>
        </div>
      )}

      {/* 事后补收单房差弹窗（ADMIN/STAFF） */}
      {roomSupplementOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setRoomSupplementOpen(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-auto rounded-2xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <RoomSupplementForm
              orderId={o.id}
              defaultNights={deriveStayNights(o)}
              passengers={(o.passengers ?? []).map((p) => ({
                id: p.id,
                fullName: p.fullName,
                singleRoom: (p as { singleRoom?: boolean }).singleRoom,
              }))}
              onCancel={() => setRoomSupplementOpen(false)}
              onSaved={async () => {
                // 重拉详情（保留联查酒店名等），刷新金额/尾款/售后费用区
                if (token) {
                  const r = await api.getOrder(token, o.id);
                  setHydrated(r.order);
                }
                setRoomSupplementOpen(false);
                onChanged?.();
              }}
            />
          </div>
        </div>
      )}

      {groundItemKind && (
        <GroundItemModal
          kind={groundItemKind}
          orderId={o.id}
          passengerCount={o.passengers.length}
          onCancel={() => setGroundItemKind(null)}
          onSaved={async () => {
            if (token) {
              const r = await api.getOrder(token, o.id);
              setHydrated(r.order);
            }
            setGroundItemKind(null);
            onChanged?.();
          }}
        />
      )}
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

function GroundItemsCard({
  order,
  canEdit,
  onAdd,
}: {
  order: OrderSummary;
  canEdit: boolean;
  onAdd: (kind: 'VISA' | 'HOTEL') => void;
}) {
  const sum = (kind: 'VISA' | 'HOTEL') => {
    const rows = (order.items ?? []).filter((item) => item.kind === kind && item.amount != null);
    return rows.length > 0 ? rows.reduce((total, item) => total + Number(item.amount), 0) : null;
  };
  const visaTotal = sum('VISA');
  const hotelTotal = sum('HOTEL');
  const money = (value: number | null) => (value == null ? '—' : `¥${value.toLocaleString('zh-CN')}`);

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">地面项金额</div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <button type="button" className="text-[11px] font-medium text-brand hover:text-brand-dark" onClick={() => onAdd('VISA')}>
              + 签证
            </button>
            <button type="button" className="text-[11px] font-medium text-brand hover:text-brand-dark" onClick={() => onAdd('HOTEL')}>
              + 房费
            </button>
          </div>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-white px-3 py-2">
          <dt className="text-xs text-ink-muted">签证金额合计</dt>
          <dd className="nums mt-0.5 font-semibold text-ink">{money(visaTotal)}</dd>
        </div>
        <div className="rounded-lg bg-white px-3 py-2">
          <dt className="text-xs text-ink-muted">房费金额合计</dt>
          <dd className="nums mt-0.5 font-semibold text-ink">{money(hotelTotal)}</dd>
        </div>
      </dl>
    </section>
  );
}

function GroundItemModal({
  kind,
  orderId,
  passengerCount,
  onCancel,
  onSaved,
}: {
  kind: 'VISA' | 'HOTEL';
  orderId: string;
  passengerCount: number;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const [visas, setVisas] = useState<Visa[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [selectedVisaId, setSelectedVisaId] = useState('');
  const [selectedRoomTypeId, setSelectedRoomTypeId] = useState('');
  const [quantity, setQuantity] = useState(Math.max(1, passengerCount));
  const [nights, setNights] = useState(1);
  const [rooms, setRooms] = useState(1);
  const [checkIn, setCheckIn] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const request = kind === 'VISA' ? api.listVisas(true, token) : api.listHotels(true, token);
    request
      .then((result) => {
        if (cancelled) return;
        if (kind === 'VISA') {
          const list = (result as { visas: Visa[] }).visas;
          setVisas(list);
          setSelectedVisaId(list[0]?.id ?? '');
        } else {
          const list = (result as { hotels: Hotel[] }).hotels;
          setHotels(list);
          const first = list.flatMap((hotel) => hotel.roomTypes)[0];
          setSelectedRoomTypeId(first?.id ?? '');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '产品加载失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kind, token]);

  const roomOptions = useMemo(
    () => hotels.flatMap((hotel) => hotel.roomTypes.map((roomType) => ({ ...roomType, hotelName: hotel.name }))),
    [hotels],
  );
  const selectedVisa = visas.find((visa) => visa.id === selectedVisaId) ?? null;
  const selectedRoomType = roomOptions.find((roomType) => roomType.id === selectedRoomTypeId) ?? null;
  const selectedProductKey = kind === 'VISA' ? selectedVisa?.id : selectedRoomType?.id;
  const selectedCost = kind === 'VISA' ? selectedVisa?.costPriceCny : selectedRoomType?.costPriceCny;

  useEffect(() => {
    setUnitPrice(selectedCost ?? '');
  }, [selectedProductKey, selectedCost]);

  const priceNumber = Number(unitPrice);
  const previewQuantity = kind === 'VISA' ? quantity : nights * rooms;
  const previewTotal = Number.isFinite(priceNumber) && priceNumber >= 0
    ? Math.round(priceNumber * previewQuantity)
    : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!token) return;
    if (kind === 'VISA' && !selectedVisaId) {
      setError('请选择签证产品');
      return;
    }
    if (kind === 'HOTEL' && !selectedRoomTypeId) {
      setError('请选择酒店房型');
      return;
    }
    if (kind === 'VISA' && (!Number.isInteger(quantity) || quantity < 1)) {
      setError('人数至少为 1');
      return;
    }
    if (kind === 'HOTEL' && (!Number.isInteger(nights) || nights < 1 || !Number.isFinite(rooms) || rooms < 0.5 || Math.round(rooms * 2) !== rooms * 2)) {
      setError('请填写有效的晚数和间数（间数按 0.5 递增）');
      return;
    }
    if (!Number.isFinite(priceNumber) || priceNumber < 0) {
      setError('请填写非负售价；产品无成本价时售价为必填');
      return;
    }
    setSaving(true);
    try {
      if (kind === 'VISA') {
        await api.addGroundItem(token, orderId, {
          kind,
          visaId: selectedVisaId,
          quantity,
          unitPriceCny: priceNumber,
          note: note.trim() || undefined,
        });
      } else {
        await api.addGroundItem(token, orderId, {
          kind,
          hotelRoomTypeId: selectedRoomTypeId,
          nights,
          rooms,
          checkIn: checkIn || undefined,
          unitPriceCny: priceNumber,
          note: note.trim() || undefined,
        });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}>
      <form className="max-h-[90vh] w-full max-w-md overflow-auto rounded-2xl bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-ink">补录{kind === 'VISA' ? '签证' : '房费'}</h3>
          <button type="button" className="btn-ghost px-2 text-xl leading-none" onClick={onCancel}>×</button>
        </div>
        {loading ? (
          <div className="py-8 text-center text-sm text-ink-muted">加载产品中…</div>
        ) : (
          <div className="mt-4 space-y-3">
            {kind === 'VISA' ? (
              <label className="block text-sm text-ink-soft">
                签证产品
                <select className="input mt-1 w-full" value={selectedVisaId} onChange={(event) => setSelectedVisaId(event.target.value)}>
                  <option value="">请选择</option>
                  {visas.map((visa) => <option key={visa.id} value={visa.id}>{visa.visaName ?? visa.visaType} · {visa.country ?? visa.destinationCountry}</option>)}
                </select>
              </label>
            ) : (
              <label className="block text-sm text-ink-soft">
                酒店房型
                <select className="input mt-1 w-full" value={selectedRoomTypeId} onChange={(event) => setSelectedRoomTypeId(event.target.value)}>
                  <option value="">请选择</option>
                  {roomOptions.map((roomType) => <option key={roomType.id} value={roomType.id}>{roomType.hotelName} · {roomType.name}</option>)}
                </select>
              </label>
            )}
            {kind === 'VISA' ? (
              <label className="block text-sm text-ink-soft">
                人数
                <input className="input mt-1 w-full" type="number" min={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} />
              </label>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm text-ink-soft">
                  入住晚数
                  <input className="input mt-1 w-full" type="number" min={1} value={nights} onChange={(event) => setNights(Number(event.target.value))} />
                </label>
                <label className="block text-sm text-ink-soft">
                  房间数
                  <input className="input mt-1 w-full" type="number" min={0.5} step={0.5} value={rooms} onChange={(event) => setRooms(Number(event.target.value))} />
                </label>
              </div>
            )}
            {kind === 'HOTEL' && (
              <label className="block text-sm text-ink-soft">
                入住日期（可选）
                <input className="input mt-1 w-full" type="date" value={checkIn} onChange={(event) => setCheckIn(event.target.value)} />
              </label>
            )}
            <label className="block text-sm text-ink-soft">
              售价（¥{kind === 'VISA' ? '人' : '间/晚'}）
              <input className="input mt-1 w-full" type="number" min={0} step={0.01} value={unitPrice} placeholder={selectedCost == null ? '产品无成本价，请手动填写' : undefined} onChange={(event) => setUnitPrice(event.target.value)} required />
            </label>
            <div className="rounded-lg border border-brand/20 bg-brand/5 px-3 py-2 text-sm text-brand-dark">
              共 <span className="nums font-semibold">{previewTotal == null ? '—' : `¥${previewTotal.toLocaleString('zh-CN')}`}</span>
            </div>
            <label className="block text-sm text-ink-soft">
              备注（可选）
              <textarea className="input mt-1 min-h-16 w-full" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
            </label>
            {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary" disabled={loading || saving}>{saving ? '保存中…' : '确认补录'}</button>
        </div>
      </form>
    </div>
  );
}

// ── 更改归属代理小面板（ADMIN/STAFF）──────────────────────────────────────────
// 代理搜索下拉（参考建单归属选择器）+ 原因输入 + 确认（提示财务不回溯口径）。
// agentId='' = 直客/无代理。保存成功由父级同步整单 + 弹 warning（若曾用原代理余额抵扣）。
function ChangeAgentPanel({
  orderId,
  currentAgentId,
  onCancel,
  onSaved,
}: {
  orderId: string;
  currentAgentId: string | null;
  onCancel: () => void;
  onSaved: (order: OrderSummary, warning: string | null) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentId, setAgentId] = useState<string>(currentAgentId ?? '');
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api.listAgents(token)
      .then((r) => { if (!cancelled) setAgents(r.agents); })
      .catch(() => { if (!cancelled) setErr('代理列表加载失败'); });
    return () => { cancelled = true; };
  }, [token]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? agents.filter((a) =>
          [a.companyName, a.contactName, a.contactPhone]
            .filter(Boolean)
            .some((s) => String(s).toLowerCase().includes(q)),
        )
      : agents;
    return base.slice(0, 50);
  }, [agents, search]);

  const submit = async () => {
    if (!token || submitting) return;
    const next = agentId || null;
    if (next === (currentAgentId ?? null)) { setErr('归属代理未变化'); return; }
    if (
      !confirm(
        '确认更改归属代理？\n\n财务不回溯：已发生的收款 / 代理余额抵扣 / 佣金流水按原归属保留，不回滚；变更后新产生的按新归属。',
      )
    ) {
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      const res = await api.changeOrderAgent(token, orderId, {
        agentId: next,
        reason: reason.trim() || undefined,
      });
      onSaved(res.order, res.warning);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '更改失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="text-base font-semibold text-ink">更改归属代理</div>
      <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
        财务不回溯：已发生的收款 / 代理余额抵扣 / 佣金流水按原归属保留；变更后新产生的按新归属。
      </p>
      <label className="block text-xs text-ink-muted">
        搜索代理
        <input
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          placeholder="公司名 / 联系人 / 电话"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <label className="block text-xs text-ink-muted">
        归属代理
        <select
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">— 直客 / 无代理 —</option>
          {filtered.map((a) => (
            <option key={a.id} value={a.id}>
              {a.companyName ? `${a.companyName} · ` : ''}{a.contactName}（{a.contactPhone}）
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-ink-muted">
        更改原因（选填）
        <input
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          placeholder="如：归属订正 / 客户改由代理下单"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {err && <div className="text-xs text-rose-600">{err}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost text-sm" onClick={onCancel} disabled={submitting}>取消</button>
        <button type="button" className="btn-primary text-sm disabled:opacity-50" onClick={submit} disabled={submitting}>
          {submitting ? '保存中…' : '确认更改'}
        </button>
      </div>
    </div>
  );
}

// ── 事后补收单房差小表单（ADMIN/STAFF）───────────────────────────────────────
// 每晚金额 × 晚数（默认=套餐晚数，可改）+ 备注；显示自动算的合计；确认后后端新增 FEE 行 + 重算尾款。
function RoomSupplementForm({
  orderId,
  defaultNights,
  passengers,
  onCancel,
  onSaved,
}: {
  orderId: string;
  defaultNights: number;
  /** 本单出行人（A15：可选择「谁转单住」联动房控；singleRoom=true 的置灰防重复） */
  passengers: Array<{ id: string; fullName: string; singleRoom?: boolean }>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const [perNightCny, setPerNightCny] = useState<number | null>(null);
  const [nights, setNights] = useState<number>(defaultNights >= 1 ? defaultNights : 1);
  const [note, setNote] = useState('');
  // 转单住乘客（可选）：选了则后端同事务标记 singleRoom + 重算套餐行计费房数（房控/分房自动跟）。
  const [passengerId, setPassengerId] = useState('');
  // 幂等键：表单打开生成一次，双击/超时重发同 key 只入账一次（配合 N8 后端回放）。
  const [idempotencyKey] = useState(() => `rs-${crypto.randomUUID()}`);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const amount = (perNightCny ?? 0) * (nights || 0);

  const submit = async () => {
    if (!token || submitting) return;
    setErr(null);
    if (!perNightCny || perNightCny <= 0 || !Number.isInteger(perNightCny)) {
      setErr('请填写每晚金额（大于 0 的整数）');
      return;
    }
    if (!nights || nights < 1 || nights > 60 || !Number.isInteger(nights)) {
      setErr('晚数需为 1–60 的整数');
      return;
    }
    if (!confirm(`确认补收单房差 ¥${perNightCny}/晚 × ${nights}晚 = ¥${amount}？\n\n将新增一条费用行并计入订单应收/尾款。`)) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.addRoomSupplement(token, orderId, {
        perNightCny,
        nights,
        note: note.trim() || undefined,
        idempotencyKey,
        ...(passengerId ? { passengerId } : {}),
      });
      if (res.roomControl) alert(res.roomControl); // 房控联动结果（谁转单住、计费房数变化）
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '补收失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="text-base font-semibold text-ink">补收单房差</div>
      <p className="text-xs text-ink-muted">按「每晚金额 × 晚数」补收；后端新增一条费用行并计入应收/尾款，房控可见。</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-xs text-ink-muted">
          每晚金额（¥）
          <input
            type="number"
            min={1}
            step={1}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            value={perNightCny ?? ''}
            onChange={(e) => setPerNightCny(e.target.value ? Math.trunc(Number(e.target.value)) : null)}
            placeholder="如 300"
          />
        </label>
        <label className="block text-xs text-ink-muted">
          晚数（默认=套餐晚数）
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            value={nights}
            onChange={(e) => setNights(e.target.value ? Math.trunc(Number(e.target.value)) : 0)}
          />
        </label>
      </div>
      <label className="block text-xs text-ink-muted">
        转单住乘客（选填 · 联动房控）
        <select
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          value={passengerId}
          onChange={(e) => setPassengerId(e.target.value)}
        >
          <option value="">不联动（仅收钱，房控不变）</option>
          {passengers.map((p) => (
            <option key={p.id} value={p.id} disabled={p.singleRoom === true}>
              {p.fullName}
              {p.singleRoom === true ? '（已单住）' : ''}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[11px] text-ink-muted">
          选择后该乘客标记为单人入住，套餐计费房数按「独住各占一间」重算，房控/分房自动跟进。
        </span>
      </label>
      <label className="block text-xs text-ink-muted">
        备注（选填）
        <input
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="如：客户单人入住"
        />
      </label>
      <div className="rounded-md bg-slate-50 px-3 py-2 text-sm">
        合计：<span className="nums font-semibold text-emerald-700">¥{amount.toLocaleString()}</span>
        <span className="ml-1 text-xs text-ink-muted">（{perNightCny ?? 0} × {nights || 0}）</span>
      </div>
      {err && <div className="text-xs text-rose-600">{err}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost text-sm" onClick={onCancel} disabled={submitting}>取消</button>
        <button type="button" className="btn-primary text-sm disabled:opacity-50" onClick={submit} disabled={submitting}>
          {submitting ? '补收中…' : '确认补收'}
        </button>
      </div>
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

// 履约进度已按运营要求移出订单详情抽屉；组件保留（导出以备后续页面复用，也避免未引用告警）。
export function FulfillmentSection({ orderId }: { orderId: string }) {
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
                  <Row
                    label="PNR"
                    value={
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-mono">{data.pnr ?? '（未生成）'}</span>
                        {data.pnr && (
                          <span
                            className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                            title="此 PNR/电子票号为系统演示自动出票生成，非真实航司 PNR；正式对接航司后以真实出票为准。"
                          >
                            演示自动出票
                          </span>
                        )}
                      </span>
                    }
                  />
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

// 本地日期 YYYY-MM-DD（用 getFullYear/getMonth/getDate，避免 toISOString 的 UTC 偏移）
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 录入周期快捷预设 → 返回 [起, 止]（闭区间，本地日期）
type CreatedPreset = 'thisMonth' | 'lastMonth' | 'last30';
function createdRangePreset(preset: CreatedPreset): [string, string] {
  const now = new Date();
  if (preset === 'thisMonth') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return [localDateStr(first), localDateStr(last)];
  }
  if (preset === 'lastMonth') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return [localDateStr(first), localDateStr(last)];
  }
  // last30：含今天在内的最近 30 天
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
  return [localDateStr(start), localDateStr(now)];
}

// 班次展示文案：起飞→到达（本地时间）
function scheduleLabel(s: AdminSchedule): string {
  const dep = new Date(s.departureTime).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const arr = new Date(s.arrivalTime).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${dep} → ${arr}`;
}

// ── 套餐行程单卡片（订单详情「产品内容」板块，套餐订单专属，展示在原始金额行上方）────
// 人类可读的行程摘要，方便运营截图发给地接/客人核对，而非逐行读金额。非套餐订单不渲染。

/** M月D日（departureDate 为 YYYY-MM-DD） */
function formatMonthDayZh(dateOnly: string): string {
  const [, m, d] = dateOnly.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

/** IATA 代码 → 中文城市名；查不到原样返回代码（兜底，不阻断展示） */
function cityNameFor(code: string): string {
  return AIRPORTS[code]?.name ?? code;
}

/** route 形如 "MFM→DAD" → "澳门 → 岘港"（IATA 换成城市名，箭头前后各加空格） */
function routeCityLabel(route: string): string {
  const [from, to] = route.split('→');
  if (!from || !to) return route;
  return `${cityNameFor(from)} → ${cityNameFor(to)}`;
}

/** 出发日 + stayDays → 签证生效/失效预计日期（YYYY-MM-DD + N 天，简单加法，不处理时区/闰年之外的精度） */
function addDaysToDateOnly(dateOnly: string, days: number): string {
  const d = new Date(`${dateOnly}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 本单是否套餐订单（含至少一条 BUNDLE 行）——产品内容卡片 v2 / 金额明细折叠 共用判定。 */
function isBundleOrder(order: OrderSummary): boolean {
  return (order.items ?? []).some((it) => it.kind === 'BUNDLE');
}

function BundleItineraryCard({ items, order }: { items: OrderItem[]; order: OrderSummary }) {
  const bundleLine = items.find((it) => it.kind === 'BUNDLE');
  if (!bundleLine) return null;

  // 航班信息来源 = 本单「所有」FLIGHT 行，按出发时间排序 —— 不再按 bundleId 匹配过滤。
  // 根因（公测截图：套餐订单卡片只有产品名/人数/酒店，航班/机票/签证/服务内容全部缺失）：
  // 老订单的 BUNDLE 行与 FLIGHT 行的 bundleId 经常有一边是 null（历史数据，早于 bundleId 打标
  // 上线），v1 版本按 `flightLine.bundleId === bundleLine.bundleId` 过滤，两边 null 时 `null === null`
  // 恒真没问题，但 bundleLine.bundleId 为 null 时 v1 直接把 group 收窄成 `[bundleLine]`（见旧代码
  // `bundleId ? items.filter(...) : [bundleLine]`），FLIGHT 行被整段排除在外。
  // 套餐订单目前不支持"一单多套餐"，本单的 FLIGHT 行本来就都属于同一趟行程，直接取全部更稳健。
  const flightLegs = [...items]
    .filter((it) => it.kind === 'FLIGHT' && it.flightNumber)
    .sort((a, b) => {
      const da = a.departureDate && a.departureTime ? `${a.departureDate}T${a.departureTime}` : '';
      const db = b.departureDate && b.departureTime ? `${b.departureDate}T${b.departureTime}` : '';
      return da.localeCompare(db);
    });

  // 签证/接送/服务内容一律来自套餐定义（bundle.items / bundleTransfers / bundleVisa / serviceNotes），
  // 不是订单行 —— 套餐订单通常只有机票腿 + 一条 BUNDLE 地面行，不会有独立的 VISA/TRANSFER 行。
  const bundleKinds = bundleLine.bundleKinds ?? [];
  const transfers = bundleLine.bundleTransfers ?? [];
  const visa = bundleLine.bundleVisa ?? null;
  const serviceNoteLines = (bundleLine.serviceNotes ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // 产品名称 = 前台产品名（Bundle.name，与商城展示一致，不可改——业务口径）。
  // 仅当套餐名缺失（历史数据/套餐被删）才回退：按组件自动拼装 → 行描述快照。
  const originCode = flightLegs[0]?.route?.split('→')[0];
  const destCode = flightLegs[0]?.route?.split('→')[1];
  const routeLabel = originCode && destCode ? `${cityNameFor(originCode)}-${cityNameFor(destCode)}` : null;
  const componentParts: string[] = [];
  if (bundleKinds.includes('FLIGHT') || flightLegs.length > 0) componentParts.push('往返机票');
  if (bundleKinds.includes('HOTEL') || bundleLine.roomTypeName || bundleLine.hotelName) componentParts.push('酒店');
  if (bundleKinds.includes('VISA') || visa) componentParts.push('签证');
  if (bundleKinds.includes('TRANSFER') || transfers.length > 0) componentParts.push('接送机服务');
  const productName =
    bundleLine.bundleName?.trim() ||
    (routeLabel ? `${routeLabel}${componentParts.join('+')}` : bundleLine.description);

  const adultCount = order.adultCount ?? 0;
  const childCount = order.childCount ?? 0;
  const infantCount = order.infantCount ?? 0;
  const totalCount = adultCount + childCount + infantCount;

  // 签证生效/失效预计日期：去程出发日 + stayDays（都存在时才推算；标注「预计/以实际出签为准」）。
  const outboundDate = flightLegs[0]?.departureDate ?? null;
  const visaStayDays = visa?.stayDays ?? null;
  const visaEffectiveDate = outboundDate && visaStayDays ? outboundDate : null;
  const visaExpiryDate = outboundDate && visaStayDays ? addDaysToDateOnly(outboundDate, visaStayDays) : null;

  // 乘客级选项统计（自备签证）：基数 = 本单乘客数；用于产品名/签证段标注。
  const passengerBase = order.passengers.length;
  const visaExemptCount = order.passengers.filter((p) => p.visaExempt).length;
  // 全员自备（需真有乘客且全部自备）→ 签证段改「无需送签」；部分自备 → 拆分随团/自备人数。
  const allVisaExempt = passengerBase > 0 && visaExemptCount === passengerBase;
  const partialVisaExempt = visaExemptCount > 0 && !allVisaExempt;

  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-3 text-sm">
      <div>
        <div className="text-xs font-medium text-ink-muted">产品名称</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="font-semibold text-ink">{productName}</span>
          {visaExemptCount > 0 && (
            <span className="badge-warning text-[10px]">含 {visaExemptCount} 人自备签</span>
          )}
        </div>
      </div>

      <dl className="mt-2.5 space-y-1.5 text-xs text-ink-soft">
        {/* 人数：总数 ／ 按年龄段分列。运营要求产品内容展示不露每人价格与均摊口径——只改展示，
            订单上的分龄单价数据（adult/child/infantUnitPriceCny）原样保留，金额明细折叠区仍可查。 */}
        <div>
          <dt className="font-medium text-ink-muted">人数</dt>
          <dd className="mt-0.5">
            {totalCount}
            {' ／ '}成人：{adultCount}位
            {' ／ '}2-12岁儿童：{childCount}位
            {' ／ '}2岁以下婴儿：{infantCount}位
          </dd>
        </div>

        {flightLegs.length > 0 && (
          <div>
            <dt className="font-medium text-ink-muted">航班信息</dt>
            <dd className="mt-0.5 space-y-0.5">
              {flightLegs.map((leg) => (
                <div key={leg.id}>
                  {leg.departureDate && `${formatMonthDayZh(leg.departureDate)} `}
                  {leg.route && routeCityLabel(leg.route)}
                  {leg.flightNumber && ` ${leg.flightNumber}`}
                  {leg.departureTime && leg.arrivalTime && ` ${leg.departureTime}-${leg.arrivalTime}`}
                </div>
              ))}
            </dd>
          </div>
        )}
        {flightLegs.length > 0 && (
          <div>
            <dt className="font-medium text-ink-muted">机票</dt>
            <dd className="mt-0.5">
              {CABIN_ZH[flightLegs[0].cabin ?? flightLegs[0].flightCabin ?? ''] ?? '经济舱'} × {adultCount + childCount}人
            </dd>
          </div>
        )}
        {/* 「酒店：xxx」文字行已按运营要求移除——与抽屉上方可操作的「酒店情况 · 拼房」卡重复；
            仅去展示，下单时盖章的酒店快照数据（hotelName/roomTypeName/roomsBilled/入退日期）原样保留。 */}
        {visa && (
          <div>
            <dt className="font-medium text-ink-muted">签证</dt>
            <dd className="mt-0.5">
              {visa.name}
              {visaStayDays != null && `；最多可停留：${visaStayDays}天`}
              {/* 全员自备时预计生效/失效日期不适用，避免与「无需送签」矛盾 */}
              {!allVisaExempt && visaEffectiveDate && visaExpiryDate && (
                <span className="ml-1 text-ink-muted">
                  （签证生效日期(预计)={visaEffectiveDate}、失效日期(预计)={visaExpiryDate}，以实际出签为准）
                </span>
              )}
              {allVisaExempt && (
                <div className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
                  全员自备签证 · 无需送签（生效/失效日期不适用）
                </div>
              )}
              {partialVisaExempt && (
                <div className="mt-1 text-ink-muted">
                  {passengerBase - visaExemptCount} 人随团办理 / {visaExemptCount} 人自备（详见下方乘客名单）
                </div>
              )}
            </dd>
          </div>
        )}
        {serviceNoteLines.length > 0 && (
          <div>
            <dt className="font-medium text-ink-muted">服务内容</dt>
            <dd className="mt-0.5">
              <ul className="list-disc space-y-0.5 pl-4">
                {serviceNoteLines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {transfers.length > 0 && (
          <div>
            <dt className="font-medium text-ink-muted">接送</dt>
            <dd className="mt-0.5 space-y-0.5">
              {transfers.map((t, i) => (
                <div key={i}>{t.name} × {t.qty}趟</div>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

// 航变标记（后端 rescheduleOrderItem 换班次时落在该 FLIGHT 行 metadata.flightChanged）
type FlightChangedMark = {
  at?: string;
  fromFlightNumber?: string | null;
  fromDeparture?: string | null;
  toScheduleId?: string | null;
};

/** 从订单行 metadata 读「航变」标记；无标记或结构不符时返回 null。 */
function readFlightChanged(metadata: unknown): FlightChangedMark | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const mark = (metadata as { flightChanged?: unknown }).flightChanged;
  if (!mark || typeof mark !== 'object') return null;
  return mark as FlightChangedMark;
}

/** ISO → "M月D日 HH:MM"（航变悬浮里展示原起飞时间）；无值时返回「原班次」。 */
function formatChangedDeparture(iso?: string | null): string {
  if (!iso) return '原班次';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '原班次';
  return d.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── 金额明细「怎么算出来的」轻量说明：读 metadata 里 backend 落的计价痕迹，字段缺失一律不显示 ──

/** BUNDLE 行操作费 metadata（backend orders.service.ts 写入 {perPaxCny,pax,totalCny}）；结构不符返回 null。 */
function readOperationFee(metadata: unknown): { perPaxCny: number; pax: number; totalCny: number } | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const fee = (metadata as { operationFee?: unknown }).operationFee;
  if (!fee || typeof fee !== 'object') return null;
  const { perPaxCny, pax, totalCny } = fee as Record<string, unknown>;
  if (typeof perPaxCny !== 'number' || typeof pax !== 'number' || typeof totalCny !== 'number') return null;
  return { perPaxCny, pax, totalCny };
}

/** BUNDLE 行加项明细（单房差/升舱/儿童优惠/自备签证减免等，来自 metadata.addOns 即 BundleAddOnBreakdown）；解析失败返回空数组。 */
function readAddOnLines(metadata: unknown): Array<{ label: string; amount: number }> {
  if (!metadata || typeof metadata !== 'object') return [];
  const addOns = (metadata as { addOns?: unknown }).addOns;
  if (!addOns || typeof addOns !== 'object') return [];
  const b = addOns as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const lines: Array<{ label: string; amount: number }> = [];
  if (num(b.singleSupplementTotal) > 0) lines.push({ label: '单房差', amount: num(b.singleSupplementTotal) });
  if (num(b.businessUpgradeTotal) > 0) lines.push({ label: '升舱', amount: num(b.businessUpgradeTotal) });
  if (num(b.infantPriceTotal) > 0) lines.push({ label: '婴儿费用', amount: num(b.infantPriceTotal) });
  if (num(b.childSeatDiscountTotal) > 0) lines.push({ label: '儿童优惠', amount: -num(b.childSeatDiscountTotal) });
  if (num(b.selfVisaDeductTotal) > 0) lines.push({ label: '自备签证减免', amount: -num(b.selfVisaDeductTotal) });
  return lines;
}

/** BUNDLE/FLIGHT 行套餐折扣百分比（metadata.bundleDiscountPct，0..100）；缺失或非法值返回 0。 */
function readBundleDiscountPct(metadata: unknown): number {
  if (!metadata || typeof metadata !== 'object') return 0;
  const pct = (metadata as { bundleDiscountPct?: unknown }).bundleDiscountPct;
  return typeof pct === 'number' && Number.isFinite(pct) && pct > 0 ? pct : 0;
}

/** FLIGHT 行价格来源：metadata.priceOverride==='TEAM_SETTLEMENT' → 团队议价结算价；否则按出发日实时舱位价。 */
function readIsTeamSettlementPrice(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as { priceOverride?: unknown }).priceOverride === 'TEAM_SETTLEMENT';
}

// ── 按乘客调价（0722 公测反馈）：金额明细逐人可解释 ─────────────────────────
/** 读 priceAdjustment 差额行的原因码（backend metadata.priceAdjustment=true 打标；非调价行返回 null）。 */
function readPriceAdjustmentReason(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as { priceAdjustment?: unknown; reasonCode?: unknown };
  if (m.priceAdjustment !== true) return null;
  return typeof m.reasonCode === 'string' ? m.reasonCode : null;
}

interface OrderAdjLine {
  itemId: string;
  amountCny: number;
  reasonCode: string | null;
  description: string;
}
/**
 * 把订单里的 priceAdjustment 差额行按 passengerId 分桶（与后端 groupPassengerAdjustments 同口径）：
 *   byPassenger[pid] = 该乘客名下调整行 + 净额；wholeOrder = 整单调整行（passengerId 空）+ 净额。
 * 只做展示分组，不改任何金额（这些行本就计入 total）。
 */
function groupOrderAdjustments(items: readonly OrderItem[]): {
  byPassenger: Map<string, { lines: OrderAdjLine[]; netCny: number }>;
  wholeOrder: { lines: OrderAdjLine[]; netCny: number };
} {
  const byPassenger = new Map<string, { lines: OrderAdjLine[]; netCny: number }>();
  const wholeOrder = { lines: [] as OrderAdjLine[], netCny: 0 };
  for (const it of items) {
    if (!isPriceAdjustmentItem(it.metadata)) continue;
    const reasonCode = readPriceAdjustmentReason(it.metadata);
    const line: OrderAdjLine = {
      itemId: it.id,
      amountCny: Number(it.amount) || 0,
      reasonCode,
      description: it.description,
    };
    const pid = it.passengerId ?? null;
    if (pid) {
      const bucket = byPassenger.get(pid) ?? { lines: [], netCny: 0 };
      bucket.lines.push(line);
      bucket.netCny += line.amountCny;
      byPassenger.set(pid, bucket);
    } else {
      wholeOrder.lines.push(line);
      wholeOrder.netCny += line.amountCny;
    }
  }
  return { byPassenger, wholeOrder };
}
/** metadata.priceAdjustment === true（含 SETTLEMENT/ROOM_DIFF 等所有调价行）。 */
function isPriceAdjustmentItem(metadata: unknown): boolean {
  return (
    metadata != null &&
    typeof metadata === 'object' &&
    (metadata as { priceAdjustment?: unknown }).priceAdjustment === true
  );
}
/** 调价原因码 → 中文 label（未知码回退，绝不显示 undefined）。 */
function adjustmentReasonLabel(reasonCode: string | null): string {
  if (!reasonCode) return '价格调整';
  const label = (PRICE_ADJUSTMENT_REASON_LABEL as Record<string, string>)[reasonCode];
  return label ?? '价格调整';
}
/** 带符号金额展示：+¥200 / −¥80。 */
function signedCny(amountCny: number): string {
  const sign = amountCny < 0 ? '−' : '+';
  return `${sign}¥${Math.abs(amountCny).toLocaleString()}`;
}

// ── 产品内容行：FLIGHT 项可「改期」（换班次/日期 + 改舱位 + 改期费）──────
function OrderItemRow({
  orderId,
  item,
  onOrderUpdated,
  canEditSettlementPrice,
  settlementLocked,
}: {
  orderId: string;
  item: OrderItem;
  onOrderUpdated?: (order: OrderSummary) => void;
  /** 改结算价：后端 PATCH settlement-price 放行 ADMIN/STAFF，这里同口径（非纯 ADMIN） */
  canEditSettlementPrice?: boolean;
  settlementLocked?: boolean;
}) {
  const [rescheduling, setRescheduling] = useState(false);
  const [editingPrice, setEditingPrice] = useState(false);
  const [swappingHotel, setSwappingHotel] = useState(false);
  const isFlight = item.kind === 'FLIGHT';
  // HOTEL 行，或已盖章酒店房型的 BUNDLE 行（套餐没有独立 HOTEL 行，酒店盖在 BUNDLE 行上）
  const isHotelRow = item.kind === 'HOTEL' || (item.kind === 'BUNDLE' && Boolean(item.hotelRoomTypeId));
  // 航变：管理员因航变换过班次的机票行，标红醒目提示，悬浮看原班次→新班次
  const flightChanged = readFlightChanged(item.metadata);
  const changedHint = flightChanged
    ? `航变：原 ${flightChanged.fromFlightNumber ?? '班次'}（${formatChangedDeparture(
        flightChanged.fromDeparture,
      )}）→ 现 ${item.flightNumber ?? '新班次'}${
        item.departureDate ? `（${item.departureDate}${item.departureTime ? ` ${item.departureTime}` : ''}）` : ''
      }`
    : '';
  // 金额明细「怎么算出来的」：只在字段真实存在时展示，绝不臆测口径。
  const operationFee = readOperationFee(item.metadata);
  const addOnLines = readAddOnLines(item.metadata);
  const bundleDiscountPct = readBundleDiscountPct(item.metadata);
  const isTeamSettlementPrice = isFlight && readIsTeamSettlementPrice(item.metadata);
  const hasPriceExplain =
    (operationFee !== null && operationFee.totalCny > 0) || addOnLines.length > 0 || bundleDiscountPct > 0 || isFlight;

  return (
    <li className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-ink">
            <span>{item.description}</span>
            {flightChanged && (
              <span
                className="inline-flex items-center gap-0.5 rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[11px] font-semibold text-red-600"
                title={changedHint}
              >
                ✈ 航变
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">
            {KIND_LABEL[item.kind]} · 数量 {item.quantity}
            {/* 单价是逐项拆价，属我方内部口径：后端对 AGENT/CUSTOMER 不下发 unitPrice，缺失时不渲染（避免 ¥undefined/¥NaN）。 */}
            {item.unitPrice != null && <> · 单价 ¥{Number(item.unitPrice).toLocaleString()}</>}
            {item.flightCabin && <> · {CABIN_ZH[item.flightCabin] ?? item.flightCabin}</>}
          </div>
          {hasPriceExplain && (
            <div className="mt-0.5 space-y-0.5 text-[11px] leading-snug text-ink-muted">
              {operationFee && operationFee.totalCny > 0 && (
                <div>
                  含操作费 ¥{operationFee.perPaxCny.toLocaleString()}/人 × {operationFee.pax}人 = ¥
                  {operationFee.totalCny.toLocaleString()}
                </div>
              )}
              {addOnLines.map((line) => (
                <div key={line.label}>
                  {line.label} {line.amount < 0 ? '−' : ''}¥{Math.abs(line.amount).toLocaleString()}
                </div>
              ))}
              {bundleDiscountPct > 0 && <div>已按套餐折扣 {bundleDiscountPct}% 计价</div>}
              {isFlight && <div>{isTeamSettlementPrice ? '团队议价结算价' : '按出发日实时舱位价'}</div>}
            </div>
          )}
          {flightChanged && (
            <div className="mt-1 text-[11px] leading-snug text-red-600">{changedHint}</div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          {/* 行级小计同属内部拆价口径：AGENT/CUSTOMER 只看订单总价，行级金额缺失时不渲染。 */}
          {item.amount != null && (
            <div className="nums text-sm font-medium text-ink">¥{Number(item.amount).toLocaleString()}</div>
          )}
          {isFlight && !rescheduling && !editingPrice && (
            <button
              className="text-[11px] font-medium text-brand hover:text-brand-dark"
              onClick={() => setRescheduling(true)}
            >
              改期
            </button>
          )}
          {isFlight && canEditSettlementPrice && !rescheduling && !editingPrice && (
            <>
              <button
                className="text-[11px] font-medium text-amber-600 hover:text-amber-800 disabled:cursor-not-allowed disabled:text-slate-400"
                onClick={() => setEditingPrice(true)}
                disabled={settlementLocked}
                title={settlementLocked ? '结算价已锁定，请先解锁再修改' : undefined}
              >
                改结算价
              </button>
              {settlementLocked && <span className="text-[11px] text-slate-500">已锁定</span>}
            </>
          )}
          {isHotelRow && (
            <button
              className="text-[11px] font-medium text-brand hover:text-brand-dark"
              onClick={() => setSwappingHotel(true)}
            >
              换酒店
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
      {isHotelRow && swappingHotel && (
        <HotelSwapModal
          orderId={orderId}
          item={{
            id: item.id,
            kind: item.kind,
            hotelRoomTypeId: item.hotelRoomTypeId,
            hotelCheckIn: item.hotelCheckIn,
            hotelCheckOut: item.hotelCheckOut,
            roomsBilled: item.roomsBilled,
            quantity: item.quantity,
            hotelName: item.hotelName,
            roomTypeName: item.roomTypeName,
          }}
          onClose={() => setSwappingHotel(false)}
          onSwapped={(updated) => {
            setSwappingHotel(false);
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
      // B12：已付款单改价的资金后果（多付/新尾款）——后端算清楚，这里必须让运营看见。
      if (res.warning) alert(res.warning);
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

// ── 售后费用（改期费 / 换人费 / 换酒店差价）明细展示 ───────────────────────────────
// 运行时结构见 lib/api.ts 的 OrderAdjustment（= 后端 OrderAdjustmentEntry）：
// { type, label, amountCny(number), at(ISO), by, note? }，无 id / createdAt。
function AdjustmentsSection({ order }: { order: OrderSummary }) {
  const adjustments = order.adjustments ?? [];
  if (adjustments.length === 0) return null;
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">售后费用</h3>
      <ul className="mt-2 space-y-1.5 text-sm">
        {adjustments.map((a, i) => {
          const amountCny = Number(a.amountCny);
          const sign = amountCny < 0 ? '-' : '+';
          return (
            <li
              key={`${a.at}-${a.type}-${i}`}
              className="flex items-start justify-between gap-2 rounded-md border border-amber-200 bg-amber-50/60 p-2.5"
            >
              <div className="flex-1">
                <div className="text-ink">{a.label}</div>
                {a.note && <div className="mt-0.5 text-xs text-ink-muted">{a.note}</div>}
                <div className="mt-0.5 text-[11px] text-ink-muted">{new Date(a.at).toLocaleString('zh-CN')}</div>
              </div>
              <div className="nums text-sm font-medium text-amber-700">
                {sign}¥{Math.abs(amountCny).toLocaleString()}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── 事后调价（0722 公测反馈「按乘客调价」；ADMIN/STAFF）─────────────────────
// 一张多人订单内，给「整单」或「指定乘客」挂一笔结算价差额（正=补收/负=优惠）+原因，走后端
// POST /orders/:id/price-adjustment（与录单调价同路径：追加一条差额行，金额进 total）。
// 金额明细按乘客分组展示（逐人可解释），下方是录入口。绝不做「手填每人价格」——只走差额通道。
function PriceAdjustmentSection({
  order,
  onOrderUpdated,
}: {
  order: OrderSummary;
  onOrderUpdated?: (order: OrderSummary) => void;
}) {
  const role = useAuth((s) => s.user?.role);
  const token = useAuth((s) => s.tokens)?.accessToken ?? '';
  const isOps = role === 'ADMIN' || role === 'STAFF';

  const [scope, setScope] = useState<string>('WHOLE'); // 'WHOLE' 或 passengerId
  const [amount, setAmount] = useState<number | null>(null);
  const [reasonCode, setReasonCode] = useState<PriceAdjustmentReason>('MISC_FEE');
  const [reasonText, setReasonText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // 金额明细分组（byPassenger + wholeOrder），逐人可解释；纯展示，不改金额。
  const grouped = useMemo(() => groupOrderAdjustments(order.items ?? []), [order.items]);
  const passengerById = useMemo(
    () => new Map(order.passengers.map((p) => [p.id, p.chineseName?.trim() || p.fullName])),
    [order.passengers],
  );
  const hasAnyAdjustment = grouped.wholeOrder.lines.length > 0 || grouped.byPassenger.size > 0;

  // 内部角色才可见（对外脱敏时后端也不下发逐项金额；这里再做一道前端权限门）。
  if (!isOps) return null;

  async function submit(): Promise<void> {
    setErr(null);
    if (amount === null || !Number.isInteger(amount) || amount === 0) {
      setErr('请输入非 0 的整数金额（正=补收 / 负=优惠）');
      return;
    }
    if (reasonCode === 'OTHER' && !reasonText.trim()) {
      setErr('选择「其它」时必须填写调整原因说明');
      return;
    }
    const targetName = scope === 'WHOLE' ? '整单' : passengerById.get(scope) ?? '该乘客';
    if (!window.confirm(`确认给「${targetName}」${signedCny(amount)}（${adjustmentReasonLabel(reasonCode)}）？\n将追加一条价格调整行，计入订单应收/尾款，全程审计留痕。`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await api.addOrderPriceAdjustment(token, order.id, {
        amountCny: amount,
        reasonCode,
        reasonText: reasonText.trim() || undefined,
        passengerId: scope === 'WHOLE' ? undefined : scope,
      });
      onOrderUpdated?.(res.order);
      // 复位录入框（保留作用范围，方便连续给同一人调多笔）
      setAmount(null);
      setReasonText('');
      setOpen(false);
    } catch (e) {
      setErr(e instanceof ApiError ? `调价失败：${e.message}` : '调价失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">价格调整（按乘客 / 整单）</h3>

      {/* 金额明细：按乘客分组展示（逐人可解释）+ 整单调整 */}
      {hasAnyAdjustment && (
        <div className="mt-2 space-y-2 text-sm">
          {[...grouped.byPassenger.entries()].map(([pid, bucket]) => (
            <div key={pid} className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">{passengerById.get(pid) ?? '（已移除乘客）'}</span>
                <span className={`nums text-sm font-semibold ${bucket.netCny < 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                  净 {signedCny(bucket.netCny)}
                </span>
              </div>
              <ul className="mt-1 space-y-0.5">
                {bucket.lines.map((l) => (
                  <li key={l.itemId} className="flex items-center justify-between gap-2 text-xs text-ink-muted">
                    <span>{adjustmentReasonLabel(l.reasonCode)}</span>
                    <span className="nums">{signedCny(l.amountCny)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {grouped.wholeOrder.lines.length > 0 && (
            <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">整单调整</span>
                <span className={`nums text-sm font-semibold ${grouped.wholeOrder.netCny < 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                  净 {signedCny(grouped.wholeOrder.netCny)}
                </span>
              </div>
              <ul className="mt-1 space-y-0.5">
                {grouped.wholeOrder.lines.map((l) => (
                  <li key={l.itemId} className="flex items-center justify-between gap-2 text-xs text-ink-muted">
                    <span>{adjustmentReasonLabel(l.reasonCode)}</span>
                    <span className="nums">{signedCny(l.amountCny)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* 录入口（默认收起，点开录入一笔差额） */}
      {!open ? (
        <button
          type="button"
          className="mt-2 text-[11px] font-medium text-brand hover:text-brand-dark"
          onClick={() => setOpen(true)}
        >
          + 添加价格调整
        </button>
      ) : (
        <div className="mt-2 space-y-2 rounded-lg border border-brand/30 bg-brand/5 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="text-[11px] font-medium text-ink-muted">作用范围</span>
              <select
                className="input mt-0.5 w-full"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="WHOLE">整单（所有乘客共担）</option>
                {order.passengers.map((p) => (
                  <option key={p.id} value={p.id}>
                    指定乘客：{p.chineseName?.trim() || p.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] font-medium text-ink-muted">原因</span>
              <select
                className="input mt-0.5 w-full"
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value as PriceAdjustmentReason)}
              >
                {PRICE_ADJUSTMENT_REASON_OPTIONS.map((rc) => (
                  <option key={rc} value={rc}>
                    {PRICE_ADJUSTMENT_REASON_LABEL[rc]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-[11px] font-medium text-ink-muted">金额（CNY，正=补收 / 负=优惠）</span>
            <NumberInput
              value={amount}
              onChange={setAmount}
              integerOnly
              allowNegative
              placeholder="如 200 或 -80"
              className="input mt-0.5 w-full"
            />
          </label>
          {reasonCode === 'OTHER' && (
            <label className="block">
              <span className="text-[11px] font-medium text-ink-muted">原因说明（「其它」必填）</span>
              <input
                className="input mt-0.5 w-full"
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                maxLength={200}
                placeholder="简述调整原因"
              />
            </label>
          )}
          <p className="text-[11px] leading-snug text-ink-muted">
            只在系统权威价上加减一笔差额并留审计记录；不会改动机票/酒店等基础项价格。订单总额 = 系统价 + Σ调整。
          </p>
          {err && <div className="text-[11px] text-red-600">{err}</div>}
          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={submit}>
              {busy ? '提交中…' : '确认调价'}
            </button>
            <button
              type="button"
              className="text-[11px] text-ink-muted hover:text-ink"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setErr(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** 护照姓名按航司/证件口径显示为「姓/名」斜线格式（大写），无拆分时回退全名 */
function toSlashName(p: { lastName?: string | null; firstName?: string | null; fullName: string }): string {
  const last = (p.lastName ?? '').trim().toUpperCase();
  const first = (p.firstName ?? '').trim().toUpperCase();
  if (last && first) return `${last}/${first}`;
  if (last || first) return last || first;
  return p.fullName;
}

/** 性别徽标文案（缺失显示 —，OCR 未取到时不留空） */
function genderLabel(gender?: 'M' | 'F' | 'X' | null): string {
  if (gender === 'M') return '男';
  if (gender === 'F') return '女';
  if (gender === 'X') return '其他';
  return '—';
}

// 换人历史一条记录的形状（从 SWAP_ORDER_PASSENGER 审计的 before/after 读；旧记录字段可能缺）
type SwapHistoryEntry = {
  id: string;
  at: string; // ISO 时间
  actor: string | null; // 经手（actorLabel）
  passengerId?: string;
  beforeName?: string;
  beforeDoc?: string;
  afterName?: string;
  afterDoc?: string;
};

// 从审计 payload 安全取字段（旧记录可能缺 fullName/documentNumber，缺了就不显示，不造数据）
function readSwapSide(payload: unknown): { name?: string; doc?: string; passengerId?: string } {
  if (!payload || typeof payload !== 'object') return {};
  const p = payload as Record<string, unknown>;
  return {
    name: typeof p.fullName === 'string' ? p.fullName : undefined,
    doc: typeof p.documentNumber === 'string' ? p.documentNumber : undefined,
    passengerId: typeof p.passengerId === 'string' ? p.passengerId : undefined,
  };
}

function auditToSwapHistory(logs: AuditLog[]): SwapHistoryEntry[] {
  return logs
    .filter((l) => l.action === 'SWAP_ORDER_PASSENGER')
    .map((l) => {
      const before = readSwapSide(l.before);
      const after = readSwapSide(l.after);
      return {
        id: l.id,
        at: l.createdAt,
        actor: l.actorLabel,
        passengerId: before.passengerId,
        beforeName: before.name,
        beforeDoc: before.doc,
        afterName: after.name,
        afterDoc: after.doc,
      };
    });
}

function fmtSwapTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 单个乘客卡下方的换人历史（时间 · 旧人姓名/证件号 → 新人 · 经手；含多次换人，最新在上）
function PassengerSwapHistory({ entries }: { entries: SwapHistoryEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <details className="mt-2 rounded border border-slate-200 bg-slate-50/70 px-2 py-1 text-[11px]">
      <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-700">
        换人历史（{entries.length} 次）
      </summary>
      <ul className="mt-1 space-y-1.5">
        {entries.map((e) => (
          <li key={e.id} className="border-l-2 border-amber-300 pl-2">
            <div className="text-slate-400">{fmtSwapTime(e.at)}{e.actor ? ` · 经手 ${e.actor}` : ''}</div>
            <div className="text-slate-700">
              <span className="text-slate-500">换前：</span>
              <span className="font-medium">{e.beforeName ?? '—'}</span>
              {e.beforeDoc && <span className="ml-1 font-mono text-slate-500">{e.beforeDoc}</span>}
            </div>
            <div className="text-slate-700">
              <span className="text-slate-500">换后：</span>
              <span className="font-medium">{e.afterName ?? '—'}</span>
              {e.afterDoc && <span className="ml-1 font-mono text-slate-500">{e.afterDoc}</span>}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PassengersSection({ order, onOrderUpdated }: { order: OrderSummary; onOrderUpdated?: (order: OrderSummary) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ photoUrl: string; title: string } | null>(null);
  // B1：签证日期内联编辑（订单侧入口——HAS_VISA/全员自备签的单进不了签证台，这里是它们唯一可达的录入口）
  const [visaEditId, setVisaEditId] = useState<string | null>(null);

  // 换人历史：读订单维度的 SWAP_ORDER_PASSENGER 审计（before/after 已含旧/新姓名+证件号、经手、时间）。
  // 复用已有 audit 数据源，无需后端改动；按 before.passengerId 归到各乘客卡下方。
  const token = useAuth((s) => s.tokens)?.accessToken ?? '';
  const [swapHistory, setSwapHistory] = useState<SwapHistoryEntry[]>([]);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .listAuditLogs(token, {
        targetType: 'ORDER',
        targetId: order.id,
        action: 'SWAP_ORDER_PASSENGER',
        pageSize: 100,
      })
      .then((r) => {
        if (!cancelled) setSwapHistory(auditToSwapHistory(r.logs));
      })
      .catch(() => {
        /* 历史读取失败不阻断详情展示 */
      });
    return () => {
      cancelled = true;
    };
  }, [token, order.id, historyReloadKey]);

  // 按乘客净调价（0722）：读订单调价差额行，给每张乘客卡挂一个醒目净额小标（如「调整 +200」）。
  const adjustmentByPassenger = useMemo(
    () => groupOrderAdjustments(order.items ?? []).byPassenger,
    [order.items],
  );

  return (
    <section>
      <h3 className="text-sm font-medium text-slate-700">乘客 ({order.passengers.length})</h3>
      <ul className="mt-2 space-y-2 text-xs">
        {order.passengers.map((p) => {
          const passDaysLeft = daysUntil(p.passportExpiry);
          const adjNet = adjustmentByPassenger.get(p.id)?.netCny ?? 0;
          const passWarn = passDaysLeft !== null && passDaysLeft < 180;
          const passBlock = passDaysLeft !== null && passDaysLeft < 90;
          if (visaEditId === p.id) {
            return (
              <li key={p.id} className="rounded-md border border-sky-300 bg-sky-50/50 p-3">
                <PassengerVisaDatesInline
                  orderId={order.id}
                  passenger={p}
                  onCancel={() => setVisaEditId(null)}
                  onSaved={(updated) => {
                    setVisaEditId(null);
                    onOrderUpdated?.(updated);
                  }}
                />
              </li>
            );
          }
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
                    setHistoryReloadKey((k) => k + 1); // 换人后重拉换人历史
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
                    <span className="font-mono tracking-wide">{toSlashName(p)}</span>
                    {p.chineseName && <span className="ml-2 font-normal text-slate-600">{p.chineseName}</span>}
                    <span className="ml-2 text-xs font-normal text-slate-500">{genderLabel(p.gender)}</span>
                    {/* 套餐乘客级选项徽标（购物车模式：每人各选住宿方式 + 签证） */}
                    {p.singleRoom && (
                      <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">单住</span>
                    )}
                    {p.visaExempt && (
                      <span className="ml-2 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 ring-1 ring-sky-200">自备签</span>
                    )}
                    {/* 按乘客净调价小标（0722）：正=补收（琥珀）、负=优惠（绿）；0 不显示。 */}
                    {adjNet !== 0 && (
                      <span
                        className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${
                          adjNet < 0
                            ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                            : 'bg-amber-50 text-amber-700 ring-amber-200'
                        }`}
                        title="该乘客名下的价格调整净额（详见下方「价格调整」区）"
                      >
                        调整 {signedCny(adjNet)}
                      </span>
                    )}
                    <button
                      className="ml-2 text-[11px] font-normal text-brand hover:text-brand-dark"
                      onClick={() => setEditingId(p.id)}
                    >
                      换人/编辑
                    </button>
                    <button
                      className="ml-2 text-[11px] font-normal text-sky-700 hover:text-sky-900"
                      onClick={() => setVisaEditId(p.id)}
                      title="出签日/生效日/有效期——已持签/自备签乘客的唯一录入口（不进签证台）"
                    >
                      签证日期
                    </button>
                  </div>
                  {!p.chineseName && (
                    <div className="mt-0.5 text-xs">
                      <span className="text-slate-400">未录中文名</span>
                    </div>
                  )}
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
                  <button
                    type="button"
                    className="shrink-0 cursor-zoom-in rounded border border-slate-300 transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand/50"
                    title="点击放大核对护照信息（可拖动 / 缩放）"
                    onClick={() =>
                      setLightbox({
                        photoUrl: p.passportPhotoUrl!,
                        title: [toSlashName(p), p.chineseName, p.documentNumber].filter(Boolean).join(' · '),
                      })
                    }
                  >
                    <img src={p.passportPhotoUrl} alt="护照" className="h-14 w-14 rounded object-cover" />
                  </button>
                )}
              </div>
              <PassengerSwapHistory entries={swapHistory.filter((h) => h.passengerId === p.id)} />
            </li>
          );
        })}
      </ul>
      {lightbox && (
        <PassportLightbox
          photoUrl={lightbox.photoUrl}
          title={lightbox.title}
          onClose={() => setLightbox(null)}
        />
      )}
    </section>
  );
}

// ── 护照大图查看层（可拖动定位 + 缩放，便于挪到一侧对照乘客信息核对）─────────────
// 采用「浮动面板」而非全屏遮罩：不遮挡抽屉里的乘客信息，方便左右并排核对。
function PassportLightbox({
  photoUrl,
  title,
  onClose,
}: {
  photoUrl: string;
  title: string;
  onClose: () => void;
}) {
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 5;
  const SCALE_STEP = 0.25;
  const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  // 面板初始落在偏右位置，避免开局就压住左侧乘客信息
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: typeof window !== 'undefined' ? Math.round(window.innerWidth * 0.52) : 400,
    y: 72,
  }));
  const [scale, setScale] = useState(1);
  // 顺时针旋转角（0/90/180/270）；护照有时扫描/拍照方向不对，需要转正才能核对
  const [rotation, setRotation] = useState(0);
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function startDrag(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y };
  }
  function onDrag(e: React.PointerEvent<HTMLDivElement>): void {
    const d = dragRef.current;
    if (!d) return;
    setPos({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) });
  }
  function endDrag(e: React.PointerEvent<HTMLDivElement>): void {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }
  function onWheel(e: React.WheelEvent<HTMLDivElement>): void {
    setScale((s) => clampScale(s + (e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP)));
  }
  // 顺时针转 90°，360° 归零（浮点安全：整数取模）
  function rotate(): void {
    setRotation((r) => (r + 90) % 360);
  }

  const btnCls =
    'flex h-6 w-6 items-center justify-center rounded text-white/90 hover:bg-white/20 disabled:opacity-40';

  return (
    <div
      className="fixed z-50 flex max-h-[82vh] w-[min(440px,88vw)] flex-col overflow-hidden rounded-lg border border-white/10 bg-slate-900/95 shadow-2xl"
      style={{ left: pos.x, top: pos.y }}
    >
      {/* 拖动条：按住此处可把大图挪到任意位置，与左侧信息并排核对 */}
      <div
        className="flex cursor-move items-center gap-1 bg-slate-800 px-2 py-1.5 text-white select-none"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="mr-auto max-w-[200px] truncate text-xs font-medium" title={title}>
          {title || '护照'}
        </span>
        <button type="button" className={btnCls} title="缩小" onClick={() => setScale((s) => clampScale(s - SCALE_STEP))}>
          −
        </button>
        <span className="w-10 text-center text-[11px] tabular-nums text-white/80">{Math.round(scale * 100)}%</span>
        <button type="button" className={btnCls} title="放大" onClick={() => setScale((s) => clampScale(s + SCALE_STEP))}>
          +
        </button>
        <button type="button" className={btnCls} title="顺时针旋转 90°" onClick={rotate}>
          ⟳
        </button>
        <button
          type="button"
          className={`${btnCls} w-auto px-1.5 text-[11px]`}
          title="复位"
          onClick={() => { setScale(1); setRotation(0); }}
        >
          复位
        </button>
        <a
          href={photoUrl}
          download="passport.jpg"
          className={`${btnCls} w-auto px-1.5 text-[11px]`}
          title="下载此护照图"
        >
          下载
        </a>
        <button type="button" className={btnCls} title="关闭（Esc）" onClick={onClose}>
          ✕
        </button>
      </div>
      {/* 图片区：溢出可滚动（含旋转后的视觉溢出）；滚轮缩放 */}
      <div className="min-h-0 flex-1 overflow-auto bg-slate-950/40 p-6" onWheel={onWheel}>
        <img
          src={photoUrl}
          alt="护照大图"
          draggable={false}
          style={{ width: `${scale * 100}%`, transform: `rotate(${rotation}deg)` }}
          className="mx-auto block max-w-none rounded transition-transform"
        />
      </div>
      <p className="bg-slate-800 px-2 py-1 text-center text-[10px] text-white/60 select-none">
        拖动标题栏移动 · 滚轮或 +/− 缩放 · ⟳ 旋转 · Esc 关闭
      </p>
    </div>
  );
}

// ── B1 签证日期内联编辑（订单侧入口）─────────────────────────────────
// 签证台三日期编辑器只覆盖「有签证任务」的单；HAS_VISA（已持签）与全员自备签的单不建任务，
// 那些乘客的签证日期此前无处可录。本组件挂在订单抽屉乘客卡上，任何乘客可达，调同一端点。
function PassengerVisaDatesInline({
  orderId,
  passenger,
  onCancel,
  onSaved,
}: {
  orderId: string;
  passenger: { id: string; fullName: string; visaIssueDate?: string | null; visaEffectiveDate?: string | null; visaExpiry?: string | null };
  onCancel: () => void;
  onSaved: (updated: OrderSummary) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const d10 = (v: string | null | undefined) => (v ? v.slice(0, 10) : '');
  const [issueDate, setIssueDate] = useState(d10(passenger.visaIssueDate));
  const [effectiveDate, setEffectiveDate] = useState(d10(passenger.visaEffectiveDate));
  const [expiry, setExpiry] = useState(d10(passenger.visaExpiry));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!token || saving) return;
    setSaving(true);
    setErr(null);
    try {
      await api.updatePassengerVisaDates(token, orderId, passenger.id, {
        visaIssueDate: issueDate || null,
        visaEffectiveDate: effectiveDate || null,
        visaExpiry: expiry || null,
      });
      const r = await api.getOrder(token, orderId); // 重拉整单让抽屉/列表同步
      onSaved(r.order);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'mt-0.5 w-full rounded-md border border-slate-300 px-2 py-1 text-xs';
  return (
    <div className="space-y-2 text-xs">
      <div className="font-medium text-slate-900">签证日期 · {passenger.fullName}</div>
      <div className="grid grid-cols-3 gap-2">
        <label className="block text-[11px] text-slate-500">
          出签日
          <input type="date" className={inputCls} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
        </label>
        <label className="block text-[11px] text-slate-500">
          生效日
          <input type="date" className={inputCls} value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
        </label>
        <label className="block text-[11px] text-slate-500">
          有效期至
          <input type="date" className={inputCls} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
      </div>
      <p className="text-[11px] text-slate-400">留空 = 清除该字段；仅改填写的字段。</p>
      {err && <div className="text-[11px] text-rose-600">{err}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={onCancel} disabled={saving}>取消</button>
        <button type="button" className="btn-primary text-xs disabled:opacity-50" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
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
  const [chineseName, setChineseName] = useState(passenger.chineseName ?? '');
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

  // 护照有效期（可见字段；换人后经补录通道随新人写回）+ OCR 识别到的其余护照资料（隐藏携带）。
  const [passportExpiry, setPassportExpiry] = useState(passenger.passportExpiry?.slice(0, 10) ?? '');
  const [passportPhotoUrl, setPassportPhotoUrl] = useState<string | null>(passenger.passportPhotoUrl ?? null);
  const [passportIssueDate, setPassportIssueDate] = useState<string | null>(null);
  const [passportIssuePlace, setPassportIssuePlace] = useState<string | null>(null);
  const [passportIssueCountry, setPassportIssueCountry] = useState<string | null>(null);

  // OCR 状态（与录单同款：进度/阶段/引擎标签）
  const [ocrPct, setOcrPct] = useState<number | null>(null);
  const [ocrStage, setOcrStage] = useState<string>('');
  const [ocrEngine, setOcrEngine] = useState<'ai' | 'local' | 'ai-fallback' | null>(null);
  const ocrInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * 换人表单护照 OCR：与录单（SingleOrderModal）完全一致的流程与交互——
   * 先压缩存库图 → 尝试后端 AI 识别（POST /ocr/passport）→ 未配置/失败回退本地 Tesseract。
   * 识别结果预填 姓/名/全名/中文名/证件号/出生日期/性别/国籍/护照有效期；
   * 护照图 + 签发日/签发地/签发国 作为「补录资料」随提交（换人后经补录通道写回新人）。
   */
  const applyOcrSuggested = (s: {
    lastName?: string;
    firstName?: string;
    fullName?: string;
    chineseName?: string;
    documentNumber?: string;
    dateOfBirth?: string;
    gender?: 'M' | 'F' | 'X';
    nationality?: string;
    passportExpiry?: string;
    passportIssueDate?: string;
    passportIssuePlace?: string;
    passportIssueCountry?: string;
  }, iso3: boolean) => {
    if (s.lastName) setLastName(s.lastName);
    if (s.firstName) setFirstName(s.firstName);
    if (s.fullName) setFullName(s.fullName);
    if (s.chineseName) setChineseName(s.chineseName);
    if (s.documentNumber) setDocumentNumber(s.documentNumber);
    if (s.dateOfBirth) setDob(s.dateOfBirth);
    if (s.gender) setGender(s.gender);
    // AI 返回 ISO-3 国籍/签发国 → 转 ISO-2（本地 OCR 已是 ISO-2，原样用）
    if (s.nationality) setNationality(iso3 ? countryIso3ToIso2(s.nationality) : s.nationality);
    if (s.passportExpiry) setPassportExpiry(s.passportExpiry);
    if (s.passportIssueDate) setPassportIssueDate(s.passportIssueDate);
    if (s.passportIssuePlace) setPassportIssuePlace(s.passportIssuePlace);
    if (s.passportIssueCountry) {
      const iso2 = iso3 ? countryIso3ToIso2(s.passportIssueCountry) : s.passportIssueCountry;
      setPassportIssueCountry(iso2.length === 2 ? iso2 : null); // 补录通道要 ISO-2，转不出就不带
    }
  };

  const handleOcrFile = async (file: File) => {
    setErr(null);
    setOcrPct(0);
    setOcrStage('加载中…');
    setOcrEngine(null);
    // 存库图压缩
    let dataUrl = '';
    try {
      const { passportPhotoToDataUrl } = await import('../lib/passportOcr');
      dataUrl = await passportPhotoToDataUrl(file);
    } catch {
      dataUrl = '';
    }
    if (dataUrl) setPassportPhotoUrl(dataUrl);

    // 本地 Tesseract 兜底
    const runLocal = async (engine: 'local' | 'ai-fallback') => {
      try {
        const { ocrPassport } = await import('../lib/passportOcr');
        const result = await ocrPassport(file, (pct, stage) => {
          setOcrPct(20 + Math.round(pct * 0.8));
          setOcrStage(stage);
        });
        const s = result.suggested;
        applyOcrSuggested(
          {
            fullName: s.fullName,
            documentNumber: s.passportNumber,
            dateOfBirth: s.dateOfBirth,
            gender: s.gender,
            nationality: s.nationality,
            passportExpiry: s.passportExpiry,
            passportIssueCountry: s.passportIssueCountry,
          },
          false,
        );
        setOcrPct(100);
        setOcrStage(result.success ? '识别完成，请核对' : '识别不完整，请核对');
        setOcrEngine(engine);
      } catch {
        setOcrPct(null);
        setOcrStage('');
        setOcrEngine(null);
        setErr('护照识别失败，请手工填写');
      }
    };

    // 优先后端 AI 识别
    if (token) {
      try {
        setOcrPct(20);
        setOcrStage('AI 识别中…');
        const imageDataUrl =
          dataUrl ||
          (await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取失败'));
            reader.onerror = () => reject(new Error('读取失败'));
            reader.readAsDataURL(file);
          }));
        const aiRes = await api.ocrPassportAi(token, imageDataUrl);
        if (!aiRes.configured) {
          await runLocal('local');
          return;
        }
        if (aiRes.suggested) {
          applyOcrSuggested(aiRes.suggested, true);
          setOcrPct(100);
          setOcrStage('识别完成，请核对');
          setOcrEngine('ai');
          return;
        }
        await runLocal('ai-fallback');
        return;
      } catch {
        await runLocal('ai-fallback');
        return;
      }
    }
    await runLocal('local');
  };

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
    // 证件号变化 = 真换人：后端会清除旧出行人残留的护照/签证信息，需显式二次确认防误清。
    const newDoc = documentNumber.trim();
    const isRealSwap = newDoc !== '' && newDoc !== (passenger.documentNumber ?? '');
    if (isRealSwap) {
      if (!confirm('确认换人？证件号已变更，原出行人的护照/签证信息（护照照片、签发地、有效期、签证号等）将被清除，仅保留本次填写的新值。此操作会记入审计。')) return;
    } else {
      if (!confirm('确认保存出行人改动？如勾选了重置开票/签证将清除对应状态，填了换人费将计入订单尾款。')) return;
    }
    // 护照有效期填了就要合法（YYYY-MM-DD）
    const expiryValue = passportExpiry.trim();
    if (expiryValue && !/^\d{4}-\d{2}-\d{2}$/.test(expiryValue)) {
      setErr('护照有效期格式不正确（示例：2030-01-01）');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.updateOrderPassenger(token, orderId, passenger.id, {
        lastName: lastName.trim() || undefined,
        firstName: firstName.trim() || undefined,
        fullName: fullName.trim() || undefined,
        chineseName: chineseName.trim() || undefined,
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

      // 换人本身会清空旧人护照资料；这里把 OCR 识别到的新人护照资料（护照图/有效期/签发日/签发地/签发国）
      // 经「补录」通道写回，不削弱换人的清除语义。只在确有新护照资料时才发第二次请求。
      // 与旧值一致的字段不重复提交（passportPhotoUrl 是 data-URL，与旧照相同则跳过）。
      const supplement: {
        passportPhotoUrl?: string;
        passportExpiry?: string;
        passportIssueDate?: string;
        passportIssuePlace?: string;
        passportIssueCountry?: string;
      } = {};
      if (passportPhotoUrl && passportPhotoUrl !== (passenger.passportPhotoUrl ?? null)) {
        supplement.passportPhotoUrl = passportPhotoUrl;
      }
      if (expiryValue && expiryValue !== (passenger.passportExpiry?.slice(0, 10) ?? '')) {
        supplement.passportExpiry = expiryValue;
      }
      if (passportIssueDate) supplement.passportIssueDate = passportIssueDate;
      if (passportIssuePlace) supplement.passportIssuePlace = passportIssuePlace;
      if (passportIssueCountry) supplement.passportIssueCountry = passportIssueCountry;

      if (Object.keys(supplement).length > 0) {
        try {
          await api.supplementOrderPassengerPassport(token, orderId, passenger.id, supplement);
          const refreshed = await api.getOrder(token, orderId);
          onSaved(refreshed.order);
          return;
        } catch {
          // 换人已成功，仅护照资料补录失败：不回滚，提示可稍后在「补录护照」重试。
          setErr('换人已保存，但护照资料补录失败，请稍后重新上传护照。');
          onSaved(res.order);
          return;
        }
      }
      onSaved(res.order);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = 'mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs';
  const ocring = ocrPct !== null && ocrPct < 100;
  const ocrEngineLabel =
    ocrEngine === 'ai' ? 'AI 识别' : ocrEngine === 'local' ? '本地识别' : ocrEngine === 'ai-fallback' ? 'AI 失败·本地兜底' : '';

  return (
    <div className="space-y-2 text-xs">
      <div className="font-medium text-brand">换人/编辑 · {passenger.fullName}</div>

      {/* 护照 OCR：上传照片自动识别并预填下方字段（与录单同款，AI 优先、本地兜底）。用户可改后提交。 */}
      <div className="flex items-center gap-2 rounded border border-dashed border-brand/40 bg-brand/5 px-2 py-1.5">
        <input
          type="file"
          accept="image/*"
          ref={ocrInputRef}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ''; // 允许重复选同一文件
            if (f) void handleOcrFile(f);
          }}
        />
        {ocring ? (
          <div className="flex-1">
            <div className="h-1.5 w-full overflow-hidden rounded bg-slate-200">
              <div className="h-full bg-brand transition-all" style={{ width: `${ocrPct ?? 0}%` }} />
            </div>
            <span className="text-[10px] text-slate-400">{ocrStage}</span>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="rounded bg-brand px-2 py-1 font-medium text-white disabled:opacity-50"
              onClick={() => ocrInputRef.current?.click()}
              disabled={submitting}
            >
              📷 上传护照识别
            </button>
            {passportPhotoUrl && (
              <img src={passportPhotoUrl} alt="护照" className="h-8 w-8 rounded object-cover" />
            )}
            {ocrEngineLabel && <span className="text-[10px] text-slate-500">{ocrEngineLabel}</span>}
            <span className="ml-auto text-[10px] text-slate-400">识别结果可修改后提交</span>
          </>
        )}
      </div>

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
        <span className="text-slate-500">中文姓名（选填）</span>
        <input className={inputCls} value={chineseName} onChange={(e) => setChineseName(e.target.value)} placeholder="如：庄宇" />
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

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-slate-500">国籍（ISO，如 CN）</span>
          <input className={inputCls} value={nationality} onChange={(e) => setNationality(e.target.value)} placeholder="CN" />
        </label>
        <label className="block">
          <span className="text-slate-500">护照有效期</span>
          <input className={`${inputCls} font-mono`} value={passportExpiry} onChange={(e) => setPassportExpiry(e.target.value)} placeholder="2030-01-01" />
        </label>
      </div>

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

/** YYYY-MM-DD → DDMON（如 2026-07-25 → 25JUL）；解析不出返回 null。用于 PNR 导出文件名带出发日。 */
const MON_ABBR_EN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function formatDdMon(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const m = isoDate.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[3]}${MON_ABBR_EN[month - 1]}`;
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
      // 文件名带去程出发日（DDMON）；取不到出发日回退订单号-only。
      const ddmon = formatDdMon(order.departDate);
      const filename = ddmon ? `${ddmon}_${order.orderNumber}.xlsx` : `${order.orderNumber}.xlsx`;
      downloadBlob(blob, filename);
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
      alert(`接单失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-md border-2 border-brand/30 bg-brand/5 p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-brand">运营工具</h3>
        {claimed ? (
          <span
            className="text-xs text-slate-600"
            title="该订单已由此人负责跟进（出票/签证/联系客户）"
          >
            🙋 已接单 · 负责人 {claimed.displayName ?? claimed.email ?? claimed.id}
          </span>
        ) : (
          <button
            className="rounded bg-amber-500 px-2 py-0.5 text-xs text-white hover:bg-amber-600 disabled:opacity-50"
            onClick={handleClaim}
            disabled={busy !== null}
            title="接下这单，成为负责人跟进出票/签证/联系客户（避免多人重复处理或漏单）"
          >
            {busy === 'claim' ? '接单中…' : '🙋 我来接单'}
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

// ── 开票（六态：去程 / 回程 / 系统 三个独立开关）───────────────────────────
// 每个开关独立 PATCH /orders/:id/invoice-flags；翻某航段为已开时后端校验班次开票上限（超限 422）。
// 去程/回程开关仅在订单含对应航段时显示（单程只有去程）；系统开关恒显示。
function InvoiceFlagsSection({
  order,
  onOrderUpdated,
}: {
  order: OrderSummary;
  onOrderUpdated: (updated: OrderSummary) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const [saving, setSaving] = useState<null | 'outbound' | 'return' | 'system'>(null);
  const legs = flightLegCount(order);

  const toggle = async (
    key: 'outboundInvoiced' | 'returnInvoiced' | 'systemInvoiced',
    which: 'outbound' | 'return' | 'system',
  ) => {
    if (!tokens?.accessToken || saving) return;
    const next = !order[key];
    setSaving(which);
    try {
      const res = await api.setInvoiceFlags(tokens.accessToken, order.id, { [key]: next });
      onOrderUpdated({
        ...order,
        outboundInvoiced: res.outboundInvoiced,
        returnInvoiced: res.returnInvoiced,
        systemInvoiced: res.systemInvoiced,
      });
    } catch (err) {
      alert(err instanceof ApiError ? `开票状态更新失败：${err.message}` : '开票状态更新失败');
    } finally {
      setSaving(null);
    }
  };

  const Switch = ({
    label,
    on,
    busy,
    onClick,
  }: {
    label: string;
    on: boolean;
    busy: boolean;
    onClick: () => void;
  }) => (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
        on
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-slate-200 bg-white text-ink-soft hover:bg-slate-50'
      }`}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-300'}`} />
      {label}：{on ? '已开' : '未开'}
    </button>
  );

  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">开票</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {legs >= 1 && (
          <Switch
            label="去程"
            on={!!order.outboundInvoiced}
            busy={saving === 'outbound'}
            onClick={() => void toggle('outboundInvoiced', 'outbound')}
          />
        )}
        {legs >= 2 && (
          <Switch
            label="回程"
            on={!!order.returnInvoiced}
            busy={saving === 'return'}
            onClick={() => void toggle('returnInvoiced', 'return')}
          />
        )}
        <Switch
          label="系统"
          on={!!order.systemInvoiced}
          busy={saving === 'system'}
          onClick={() => void toggle('systemInvoiced', 'system')}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-ink-muted">
        去程 / 回程按航段分别开票；翻为「已开」时会校验该班次开票上限。
      </p>
    </section>
  );
}

function NotesSection({
  order,
  onOrderUpdated,
}: {
  order: OrderSummary;
  /** 保存成功后把回读的整单冒泡给抽屉（同步 hydrated + 列表行），与其它区块一致 */
  onOrderUpdated?: (order: OrderSummary) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const role = useAuth((s) => s.user?.role);
  const [customerNotes, setCustomerNotes] = useState(order.notes ?? '');
  const [internalNotes, setInternalNotes] = useState(order.internalNotes ?? '');
  // 订单 visaStatus 为 null = 未设置/不需要，初值不得回落成 NEEDED（否则顺手保存会把 null 静默升级成"需要"）。
  const [visaStatus, setVisaStatus] = useState<VisaStatusInput>(order.visaStatus ?? 'NOT_NEEDED');
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
    visaStatus !== (order.visaStatus ?? 'NOT_NEEDED') ||
    structured.noteHotel !== (order.noteHotel ?? '') ||
    structured.noteVisa !== (order.noteVisa ?? '') ||
    structured.notePayment !== (order.notePayment ?? '') ||
    structured.noteSpecial !== (order.noteSpecial ?? '');

  const save = async () => {
    if (!tokens?.accessToken) return;
    // 只发相对基线（=补水后的权威 order）真正改动的字段，其余字段不传。
    // 后端 PATCH /orders/:id/notes 对每个字段做 `!== undefined` 的部分更新，因此不传即不动——
    // 这样本人只改一栏时不会用旧快照盲覆盖别人（或补水后服务端）刚写进去的其它字段。
    const body: Parameters<typeof api.updateOrderNotes>[2] = {};
    if (customerNotes !== (order.notes ?? '')) body.notes = customerNotes;
    if (internalNotes !== (order.internalNotes ?? '')) body.internalNotes = internalNotes;
    // visaStatus 未改就不发：避免把服务端 null 静默升级成 'NOT_NEEDED'，也不覆盖签证台的进度口径。
    if (visaStatus !== (order.visaStatus ?? 'NOT_NEEDED')) body.visaStatus = visaStatus;
    if (structured.noteHotel !== (order.noteHotel ?? '')) body.noteHotel = structured.noteHotel;
    if (structured.noteVisa !== (order.noteVisa ?? '')) body.noteVisa = structured.noteVisa;
    if (structured.notePayment !== (order.notePayment ?? '')) body.notePayment = structured.notePayment;
    if (structured.noteSpecial !== (order.noteSpecial ?? '')) body.noteSpecial = structured.noteSpecial;
    if (Object.keys(body).length === 0) return; // 无改动，不发空 PATCH
    setSaving(true);
    try {
      await api.updateOrderNotes(tokens.accessToken, order.id, body);
      // 该 PATCH 只返回 { ok }，故保存成功后回读整单，把基线收敛到服务端真值。
      const r = await api.getOrder(tokens.accessToken, order.id);
      // 本地基线也同步到回读值：本人改过的字段=刚存进去的值，未动的字段=服务端最新（含并发同事写入），
      // 这样 dirty 干净归零，且未动字段不会用本地旧值再次盲覆盖。
      setCustomerNotes(r.order.notes ?? '');
      setInternalNotes(r.order.internalNotes ?? '');
      setVisaStatus(r.order.visaStatus ?? 'NOT_NEEDED');
      setStructured({
        noteHotel: r.order.noteHotel ?? '',
        noteVisa: r.order.noteVisa ?? '',
        notePayment: r.order.notePayment ?? '',
        noteSpecial: r.order.noteSpecial ?? '',
      });
      // 冒泡给抽屉 → 同步 hydrated + 列表行，让其它区块与列表跟着刷新。
      onOrderUpdated?.(r.order);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      alert(`保存失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  // 签证状态 / 内部备注（含内部备注、结构化四栏）只对内部角色开放；AGENT/CUSTOMER 整块不渲染
  //（后端对这些角色本就不下发 internalNotes/note* 等字段，前端再挡一层，避免代理误看/误改内部口径）。
  if (role !== 'ADMIN' && role !== 'STAFF') return null;

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
        {(dirty || saved) && (
          <div className="flex items-center gap-2">
            {dirty && (
              <button
                className="rounded bg-brand px-3 py-1 text-xs text-white disabled:opacity-50"
                onClick={save}
                disabled={saving}
              >
                {saving ? '保存中…' : '保存备注'}
              </button>
            )}
            {saved && <span className="text-xs text-green-600">✓ 已保存</span>}
          </div>
        )}
      </div>
    </section>
  );
}

function RemindersSection({ order }: { order: OrderSummary }) {
  const tokens = useAuth((s) => s.tokens);
  const role = useAuth((s) => s.user?.role);
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

  // 运营待办/提醒是内部协作口径，只对内部角色开放；AGENT/CUSTOMER 整块不渲染（后端对其也不下发 reminders）。
  if (role !== 'ADMIN' && role !== 'STAFF') return null;

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
  /** 该乘客的个别备注（选填）：客人各自的特殊要求，随本人订单单独存。留空则只写整批备注。 */
  note?: string;
  // ── OTA 名单解析带出的护照字段（选填；粘贴导入时填充，随提交发给后端）──────
  lastName?: string;
  firstName?: string;
  gender?: 'M' | 'F';
  /** 2 位国家码（如 CN） */
  nationality?: string;
  /** 护照签发国（2 位国家码，如 CN） */
  passportIssueCountry?: string;
  /** 护照有效期（YYYY-MM-DD） */
  passportExpiry?: string;
  /** 订座编码（PNR）：OTA 名单识别到唯一编码时全员同值（一码多人），随提交落 Passenger.pnr。 */
  pnr?: string;
  // ── 旧系统表格导入带出的补充字段（选填；随提交发给后端）─────────────────
  /** 中文姓名（表格导入「中文姓名」列；fullName 可能是 PNR 姓名时单独保留） */
  chineseName?: string;
  /** 护照签发日期（YYYY-MM-DD，表格导入「签发日期」列） */
  passportIssueDate?: string;
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

  // 幂等 batchId：同一次批量提交（含双击/网络重试）每张子单只建一次；成功后换新（与批量到账同款模式）。
  const makeBatchId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `bc-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const [batchId, setBatchId] = useState(makeBatchId);

  // ── 航班：出港（单程 + 往返）+ 回程（仅往返）────────────────────────────
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [flightsErr, setFlightsErr] = useState<string | null>(null);
  const [flightsLoading, setFlightsLoading] = useState(false);

  const [outboundFlightId, setOutboundFlightId] = useState('');
  const [outboundSchedules, setOutboundSchedules] = useState<AdminSchedule[]>([]);
  const [outboundScheduleId, setOutboundScheduleId] = useState('');
  // 起飞日期过滤（YYYY-MM-DD）：先选/手输日期，再从当日班次里挑，避免班次下拉过长。留空=显示全部班次。
  const [outboundDate, setOutboundDate] = useState('');

  const [returnFlightId, setReturnFlightId] = useState('');
  const [returnSchedules, setReturnSchedules] = useState<AdminSchedule[]>([]);
  const [returnScheduleId, setReturnScheduleId] = useState('');
  const [returnDate, setReturnDate] = useState('');

  // 默认经济舱（③拍板）：弹窗打开与 OTA 导入均默认经济舱，用户可手动改（含商务舱）。
  const [cabin, setCabin] = useState<CabinClass | ''>('ECONOMY');

  // ── 套餐 ──────────────────────────────────────────────────────────────────
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [bundleId, setBundleId] = useState('');
  // 套餐出发日期（YYYY-MM-DD）：后端据此匹配套餐绑定航班的当日班次，注入去/回程机票航段行 → 真正扣座 + 房控盖章。
  // 留空则后端回落套餐默认出发日期；两者都无 → 该批逐单优雅失败（提示配置出发日期/排班）。
  const [bundleDepartDate, setBundleDepartDate] = useState('');
  const [bundleNights, setBundleNights] = useState<number | null>(null);
  const [bundleSingleCount, setBundleSingleCount] = useState<number | null>(null);
  const [bundleBusinessCount, setBundleBusinessCount] = useState<number | null>(null);
  // 人群区分：批量模式每乘客一单，这三个值描述本批整体的人群结构
  const [bundleAdultCount, setBundleAdultCount] = useState<number | null>(1);
  const [bundleChildCount, setBundleChildCount] = useState<number | null>(0);
  const [bundleInfantCount, setBundleInfantCount] = useState<number | null>(0);
  // 仅 ADMIN/STAFF 可用运营专属能力（手动结算单价、代为归属代理）。
  const isOps = user?.role === 'ADMIN' || user?.role === 'STAFF';

  // ── 结算价（FLIGHT 类型专用）+ 团期备注 ──────────────────────────────────
  const [settlementPriceCny, setSettlementPriceCny] = useState<number | null>(null);
  const [groupNote, setGroupNote] = useState('');

  // ── OTA 手动结算单价（仅 ADMIN/STAFF）：不覆盖机票权威价，后端按差额追加调整行调到此价 ──
  const [manualUnitPriceCny, setManualUnitPriceCny] = useState<number | null>(null);

  // ── 归属代理（ADMIN/STAFF 代为录单；'' = 直客/无代理）───────────────────────
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentId, setAgentId] = useState('');
  const [agentSearch, setAgentSearch] = useState('');

  // ── OTA 名单粘贴导入（📋）：文本 → parseOtaRoster → 填乘客 + 选航班/班次 + 预填结算价 ──
  const [otaText, setOtaText] = useState('');
  // 解析出的班次日期：待出港班次加载后自动选中当日班次（复用按日过滤交互）。
  const [pendingSchedDate, setPendingSchedDate] = useState('');

  // ── 备注 ──────────────────────────────────────────────────────────────────
  const [notes, setNotes] = useState('');

  // ── 名单 ──────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<BatchRow[]>([{ fullName: '', documentNumber: '', dateOfBirth: '', nationality: 'CN' }]);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterWarnings, setRosterWarnings] = useState<string[]>([]);

  // ── 旧系统表格导入（单程 16 列 / 往返 18 列模版）─────────────────────────
  const [importBusy, setImportBusy] = useState(false);
  // 行级错误（红字）：查无班次 / 缺必填 / 日期歧义等，修正前不宜提交
  const [importErrors, setImportErrors] = useState<string[]>([]);
  // 往返模版导入后回程班次自动选中（与出港 pendingSchedDate 同款机制）
  const [pendingReturnSchedDate, setPendingReturnSchedDate] = useState('');

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

  // 代理列表（仅 ADMIN/STAFF 需要；用于归属选择。无代理不致命）
  useEffect(() => {
    if (!token || !isOps) return;
    api.listAgents(token).then((r) => setAgents(r.agents)).catch(() => undefined);
  }, [token, isOps]);

  const filteredAgents = useMemo(() => {
    const q = agentSearch.trim().toLowerCase();
    const base = !q
      ? agents.slice(0, 50)
      : agents
          .filter((a) =>
            [a.companyName, a.contactName, a.contactPhone]
              .filter(Boolean)
              .some((s) => String(s).toLowerCase().includes(q)),
          )
          .slice(0, 50);
    // 已选代理（如词条自动预填）不在截断列表里时补进来，否则下拉会显示成「直客」
    if (agentId && !base.some((a) => a.id === agentId)) {
      const selected = agents.find((a) => a.id === agentId);
      if (selected) return [selected, ...base];
    }
    return base;
  }, [agents, agentSearch, agentId]);

  // 出港班次
  useEffect(() => {
    if (!token || !outboundFlightId) { setOutboundSchedules([]); setOutboundScheduleId(''); setOutboundDate(''); return; }
    api.listSchedules(token, outboundFlightId)
      .then((r) => setOutboundSchedules(r.schedules))
      .catch(() => setErr('出港班次加载失败'));
  }, [token, outboundFlightId]);

  // 回程班次
  useEffect(() => {
    if (!token || !returnFlightId) { setReturnSchedules([]); setReturnScheduleId(''); setReturnDate(''); return; }
    api.listSchedules(token, returnFlightId)
      .then((r) => setReturnSchedules(r.schedules))
      .catch(() => setErr('回程班次加载失败'));
  }, [token, returnFlightId]);

  // 切换产品类型时清空相关选择
  function switchProductType(pt: BatchProductType): void {
    setProductType(pt);
    setOutboundFlightId(''); setOutboundScheduleId(''); setOutboundSchedules([]); setOutboundDate('');
    setReturnFlightId(''); setReturnScheduleId(''); setReturnSchedules([]); setReturnDate('');
    setCabin('');
    setBundleId(''); setBundleNights(null); setBundleSingleCount(null); setBundleBusinessCount(null);
    setBundleAdultCount(1); setBundleChildCount(0); setBundleInfantCount(0);
    setSettlementPriceCny(null); setGroupNote('');
    setManualUnitPriceCny(null); setPendingSchedDate('');
    setErr(null);
  }

  const outboundFlight = flights.find((f) => f.id === outboundFlightId);
  const outboundSchedule = outboundSchedules.find((s) => s.id === outboundScheduleId);
  const returnFlight = flights.find((f) => f.id === returnFlightId);

  // 按起飞日期过滤班次；日期留空则显示全部（保留原有能力）。
  const outboundSchedulesForDate = useMemo(
    () => (outboundDate ? outboundSchedules.filter((s) => s.departureTime.slice(0, 10) === outboundDate) : outboundSchedules),
    [outboundSchedules, outboundDate],
  );
  const returnSchedulesForDate = useMemo(
    () => (returnDate ? returnSchedules.filter((s) => s.departureTime.slice(0, 10) === returnDate) : returnSchedules),
    [returnSchedules, returnDate],
  );

  // OTA 导入后自动选中当日出港班次：班次异步加载完成后触发一次。
  //   当日恰 1 班 → 直接选中；多班 → 留给运营手动选并提示；无班 → 提示换日期。
  useEffect(() => {
    if (!pendingSchedDate || outboundScheduleId) return;
    const sameDay = outboundSchedules.filter((s) => s.departureTime.slice(0, 10) === pendingSchedDate);
    if (outboundSchedules.length === 0) return; // 班次尚未加载，等下次
    if (sameDay.length === 1) {
      setOutboundScheduleId(sameDay[0].id);
    } else if (sameDay.length > 1) {
      setRosterWarnings((prev) => [...prev, `${pendingSchedDate} 有多个班次，请手动选择班次`]);
    } else {
      setRosterWarnings((prev) => [...prev, `未找到 ${pendingSchedDate} 的班次，请换个日期或手动选择`]);
    }
    setPendingSchedDate('');
  }, [outboundSchedules, pendingSchedDate, outboundScheduleId]);

  // 表格导入后自动选中当日回程班次（与出港同款：恰 1 班选中 / 多班或无班提示）。
  useEffect(() => {
    if (!pendingReturnSchedDate || returnScheduleId) return;
    if (returnSchedules.length === 0) return; // 班次尚未加载，等下次
    const sameDay = returnSchedules.filter((s) => s.departureTime.slice(0, 10) === pendingReturnSchedDate);
    if (sameDay.length === 1) {
      setReturnScheduleId(sameDay[0].id);
    } else if (sameDay.length > 1) {
      setRosterWarnings((prev) => [...prev, `${pendingReturnSchedDate} 回程有多个班次，请手动选择班次`]);
    } else {
      setRosterWarnings((prev) => [...prev, `未找到 ${pendingReturnSchedDate} 的回程班次，请换个日期或手动选择`]);
    }
    setPendingReturnSchedDate('');
  }, [returnSchedules, pendingReturnSchedDate, returnScheduleId]);
  const cabinOptions = outboundSchedule?.seatClasses ?? [];
  const selectedBundle = bundles.find((b) => b.id === bundleId);

  // 套餐搜索下拉（W3）：套餐多时原生 select 找不到，换 SearchSelect 按名称/编号搜索；
  // priceLabel 用折后起价/人 = originalPerPaxCny ×(1−discountPct/100)，与套餐页卡片口径一致。
  const bundleOptions: SearchSelectOption[] = useMemo(
    () =>
      bundles.map((b) => ({
        id: b.id,
        label: `${b.code ? `[${b.code}] ` : ''}${b.name}`,
        priceLabel: String(Math.round((b.originalPerPaxCny ?? 0) * (1 - (b.discountPct ?? 0) / 100))),
      })),
    [bundles],
  );

  const validRows = rows.filter((r) => r.fullName.trim() && r.documentNumber.trim() && parseDob(r.dateOfBirth));

  function setRow(i: number, patch: Partial<BatchRow>): void {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow(): void { setRows((prev) => [...prev, { fullName: '', documentNumber: '', dateOfBirth: '', nationality: 'CN' }]); }
  function removeRow(i: number): void { setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev)); }

  function pasteRows(text: string): void {
    const parsed = text
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .map((line) => {
        const cols = line.split(/[,，\t]+|\s{2,}|\s+/).map((c) => c.trim()).filter(Boolean);
        return { fullName: cols[0] ?? '', documentNumber: cols[1] ?? '', dateOfBirth: cols[2] ?? '', nationality: 'CN' };
      })
      .filter((r) => r.fullName);
    if (parsed.length > 0) setRows(parsed);
  }

  // 📋 OTA 名单粘贴导入：解析 → 填乘客行（含护照字段）+ 选航班/起飞日 + 预填结算单价 + 展示解析提醒。
  // 已选代理且登记了名单格式 → 按其推导日期读法（冒号多行·日-月-年 → DMY）；并做两类防呆
  // （格式不符 / 撞到别家识别词条）+ 未选代理时按词条唯一命中自动预填（只提示，绝不静默改已选代理）。
  function importOtaRoster(): void {
    setErr(null);
    const agentDisplayName = (a: AgentListItem | undefined): string =>
      a ? (a.companyName ?? a.contactName) : '未知代理';
    const selectedAgent = agents.find((a) => a.id === agentId);
    const dateOrder =
      selectedAgent?.rosterFormat === 'COLON_MULTILINE_DMY'
        ? ('DMY' as const)
        : selectedAgent?.rosterFormat
          ? ('YMD' as const)
          : undefined;
    const result = parseOtaRoster(otaText, dateOrder ? { dateOrder } : undefined);
    const warnings = [...result.warnings];

    // 防呆①：命中格式与所选代理登记的名单格式不符（比不出来就不比，不误报）
    if (selectedAgent?.rosterFormat && result.passengerFormat) {
      const expectedFormat =
        selectedAgent.rosterFormat === 'INLINE_NUMBERED' ? 'INLINE_NUMBERED' : 'COLON_MULTILINE';
      if (result.passengerFormat !== expectedFormat) {
        warnings.push('这份名单的格式与所选代理登记的名单格式不符，请确认归属代理没选错');
      }
    }

    // 防呆②③：识别词条扫描（词条全局唯一，一词只归一家）
    const keywordHits = agents.filter((a) =>
      (a.rosterKeywords ?? []).some((kw) => kw && otaText.includes(kw)),
    );
    if (agentId) {
      for (const other of keywordHits.filter((a) => a.id !== agentId)) {
        warnings.push(
          `名单中出现了代理「${agentDisplayName(other)}」的识别词条，当前归属为「${agentDisplayName(selectedAgent)}」，请确认`,
        );
      }
    } else if (keywordHits.length === 1) {
      // 尚未选代理且唯一命中 → 自动预填（仅预填 + 提示，绝不静默改已选代理）
      setAgentId(keywordHits[0].id);
      warnings.push(`已按识别词条自动选择归属代理「${agentDisplayName(keywordHits[0])}」，请确认`);
    }

    if (result.passengers.length > 0) {
      setRows(
        result.passengers.map((p) => ({
          fullName: p.fullName,
          documentNumber: p.documentNumber ?? '',
          dateOfBirth: p.dateOfBirth ?? '',
          lastName: p.lastName,
          firstName: p.firstName,
          gender: p.gender,
          nationality: p.nationality,
          passportIssueCountry: p.passportIssueCountry,
          passportExpiry: p.passportExpiry,
          pnr: p.pnr, // 唯一编码 token → 全员同 PNR（一码多人）
          note: p.note,
        })),
      );
    }

    // 结算单价预填（仅 ADMIN/STAFF 可见/可用该字段）
    if (isOps && result.settlementUnitPriceCny !== undefined) {
      setManualUnitPriceCny(result.settlementUnitPriceCny);
    }

    // 航班/班次自动选中：OTA 名单是单程机票 → 若当前为套餐，切回单程机票。
    const f = result.flight;
    if (f?.flightNumber) {
      if (productType === 'BUNDLE') setProductType('FLIGHT_ONEWAY');
      const match = flights.find((x) => {
        if (x.flightNumber.toUpperCase() !== f.flightNumber.toUpperCase()) return false;
        // origin/dest 有解析到就一并校验，避免同号不同航段误选
        if (f.origin && x.originCode.toUpperCase() !== f.origin) return false;
        if (f.destination && x.destinationCode.toUpperCase() !== f.destination) return false;
        return true;
      });
      if (match) {
        setOutboundFlightId(match.id);
        setOutboundScheduleId('');
        setCabin('ECONOMY'); // 舱位默认经济舱（③拍板），OTA 未解析出舱位时兜底，用户可手动改
        if (f.departDate) {
          setOutboundDate(f.departDate);
          setPendingSchedDate(f.departDate); // 班次加载后由下方 effect 自动选中当日班次
        }
      } else {
        warnings.push(`名单航班 ${f.flightNumber}${f.origin && f.destination ? `（${f.origin}→${f.destination}）` : ''} 未在航班库中找到，请手动选择航班`);
      }
    }

    setRosterWarnings(warnings);
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

  // ── 旧系统表格导入：解析结果 → 灌进批量创单表单（乘客行 + 航班/班次/舱位/代理/结算价）──
  // 后端只做解析+匹配预览，创建仍走下方 submit 的 POST /orders/batch；行级错误红字展示，
  // 操作人当场在表格里修正后再提交。
  function applyOrderImport(res: OrderImportParseResult): void {
    const warnings = [...res.warnings];
    const errors: string[] = [];
    for (const row of res.rows) {
      for (const msg of row.errors) errors.push(`第 ${row.rowNumber} 行：${msg}`);
      for (const msg of row.warnings) warnings.push(`第 ${row.rowNumber} 行：${msg}`);
    }

    // 产品类型：模版决定（单程/往返）；切换会清空旧选择，再由下方逐项填入
    const pt: BatchProductType = res.template === 'ROUNDTRIP' ? 'FLIGHT_ROUNDTRIP' : 'FLIGHT_ONEWAY';
    if (productType !== pt) switchProductType(pt);

    // 乘客行：含中文姓名/签发日期/有效期等补充字段；婴儿同行成人并入备注
    setRows(
      res.rows.map((r) => ({
        fullName: r.passenger.fullName ?? '',
        documentNumber: r.passenger.documentNumber ?? '',
        dateOfBirth: r.passenger.dateOfBirth ?? '',
        nationality: r.passenger.nationality ?? 'CN',
        chineseName: r.passenger.chineseName,
        lastName: r.passenger.lastName,
        firstName: r.passenger.firstName,
        gender: r.passenger.gender,
        passportIssueDate: r.passenger.passportIssueDate,
        passportExpiry: r.passenger.passportExpiry,
        note:
          [r.passenger.note, r.passenger.infantCompanion ? `婴儿同行成人：${r.passenger.infantCompanion}` : '']
            .filter(Boolean)
            .join('；') || undefined,
      })),
    );

    // 航班/班次：出港（班次加载后由 pendingSchedDate effect 自动选中当日班次）
    const ob = res.batch.outbound;
    if (ob?.flightId) {
      setOutboundFlightId(ob.flightId);
      setOutboundScheduleId('');
      setOutboundDate(ob.date);
      setPendingSchedDate(ob.date);
    } else if (ob) {
      warnings.push(`航班 ${ob.flightNo} ${ob.date} 未在航班库中找到，请手动选择航班与班次`);
    }
    // 回程（仅往返模版）
    const ib = res.batch.inbound;
    if (pt === 'FLIGHT_ROUNDTRIP') {
      if (ib?.flightId) {
        setReturnFlightId(ib.flightId);
        setReturnScheduleId('');
        setReturnDate(ib.date);
        setPendingReturnSchedDate(ib.date);
      } else if (ib) {
        warnings.push(`回程航班 ${ib.flightNo} ${ib.date} 未在航班库中找到，请手动选择`);
      }
    }

    // 舱位：解析结果；表格未填/未识别 → 默认经济舱（行级提醒已列）
    setCabin(res.batch.cabin ?? 'ECONOMY');

    // 归属代理：唯一匹配才自动选中（歧义/无匹配只提醒，绝不猜）；仅 ADMIN/STAFF
    if (isOps && res.batch.agent?.agentId) {
      setAgentId(res.batch.agent.agentId);
      warnings.push(`已按表格「选择代理」自动选择归属代理，请确认`);
    }

    // 结算价：仅 ADMIN/STAFF 灌入团队结算价字段（代理上传时后端已忽略该列并提示）
    if (isOps && res.batch.settlementPriceCny !== null) {
      setSettlementPriceCny(res.batch.settlementPriceCny);
    }

    setImportErrors(errors);
    setRosterWarnings(warnings);
  }

  function onImportTemplateFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !token) return;
    if (/\.xls$/i.test(f.name)) {
      setErr('旧版 .xls 文件请先在 Excel 里「另存为 .xlsx」再上传');
      return;
    }
    if (f.size > 2 * 1024 * 1024) {
      setErr('表格文件过大（>2MB），请精简后再传');
      return;
    }
    setErr(null); setRosterWarnings([]); setImportErrors([]); setImportBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
      if (!base64) { setErr('文件读取失败'); setImportBusy(false); return; }
      api.parseOrderImport(token, base64)
        .then((res) => applyOrderImport(res))
        .catch((e2: unknown) => {
          setErr(e2 instanceof ApiError ? `表格导入解析失败：${e2.message}` : '表格导入解析失败');
        })
        .finally(() => setImportBusy(false));
    };
    reader.onerror = () => { setErr('文件读取失败'); setImportBusy(false); };
    reader.readAsDataURL(f);
  }

  async function submit(): Promise<void> {
    setErr(null);
    if (validRows.length === 0) { setErr('至少要有一位完整乘客（姓名 + 护照号 + 出生日期）'); return; }

    // 性别必填（业务拍板）：姓名/护照号/出生日期均已填的有效行不许缺性别，阻断提交并指明具体行号。
    const missingGenderLines = rows
      .map((r, idx) => ({ r, line: idx + 1 }))
      .filter(({ r }) => r.fullName.trim() && r.documentNumber.trim() && parseDob(r.dateOfBirth) && !r.gender)
      .map(({ line }) => line);
    if (missingGenderLines.length > 0) {
      setErr(`第 ${missingGenderLines.join('、')} 行乘客未选择性别，请补全后再提交`);
      return;
    }

    // 护照有效期必填（后端 schema 已必填）：有效行缺填/格式错在前端先拦，指明具体行号，
    // 免得整批提交被后端逐单打回才发现。
    const badExpiryLines = rows
      .map((r, idx) => ({ r, line: idx + 1 }))
      .filter(
        ({ r }) =>
          r.fullName.trim() && r.documentNumber.trim() && parseDob(r.dateOfBirth) &&
          (!r.passportExpiry?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(r.passportExpiry.trim())),
      )
      .map(({ line }) => line);
    if (badExpiryLines.length > 0) {
      setErr(`第 ${badExpiryLines.join('、')} 行护照有效期未填或格式不正确（示例：2030-01-01），批量创单必填`);
      return;
    }

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

    // OTA 手动结算单价（仅 ADMIN/STAFF）：与团队议价结算价互斥（后端也会 400）——前端先友好拦截。
    const manualPrice =
      isOps && productType !== 'BUNDLE' &&
      manualUnitPriceCny !== null && Number.isFinite(manualUnitPriceCny) && manualUnitPriceCny > 0
        ? manualUnitPriceCny : undefined;
    if (teamPrice !== undefined && manualPrice !== undefined) {
      setErr('「结算单价（手动）」与「团队议价结算价」二选一，请只填其中一个');
      return;
    }
    // 手填价复读确认（A17）：肥指错误（¥1000 打成 ¥100/¥0）靠让录单人重读一遍数字拦一道。
    // 服务端另有硬闸：低于系统参考价 10% 一律拒绝；±50% 外的偏离会写进调整行审计文本。
    if (manualPrice !== undefined) {
      const ok = window.confirm(
        `请确认 OTA 结算单价：每人 ¥${manualPrice}\n\n` +
          `将按此价生成价格调整行（差额=手动价−系统价，全程留痕）。\n数字打错是最常见的录入事故，请再看一眼。`,
      );
      if (!ok) return;
    }

    const batchPayload = {
      productType,
      ...(productType === 'FLIGHT_ONEWAY' || productType === 'FLIGHT_ROUNDTRIP'
        ? {
            outboundScheduleId,
            ...(productType === 'FLIGHT_ROUNDTRIP' ? { returnScheduleId } : {}),
            flightCabin: cabin as CabinClass,
          }
        : {
            bundleId,
            ...(bundleDepartDate ? { bundleDepartDate } : {}),
            ...(bundleNights !== null ? { bundleNights } : {}),
            ...(bundleSingleCount !== null ? { bundleSingleCount } : {}),
            ...(bundleBusinessCount !== null ? { bundleBusinessCount } : {}),
            ...(bundleAdultCount !== null ? { adultCount: bundleAdultCount } : {}),
            ...(bundleChildCount !== null ? { childCount: bundleChildCount } : {}),
            ...(bundleInfantCount !== null ? { infantCount: bundleInfantCount } : {}),
          }),
      description,
      notes: notes.trim() || undefined,
      // 归属代理（ADMIN/STAFF 代为录单；直客留空）。非 ops 不发。
      ...(isOps && agentId ? { agentId } : {}),
      passengers: validRows.map((r) => ({
        fullName: r.fullName.trim(),
        documentNumber: r.documentNumber.trim(),
        dateOfBirth: parseDob(r.dateOfBirth) ?? '',
        // 优先用 OTA 解析出的国籍/签发国；缺省回落 CN（与既有默认一致）。
        nationality: r.nationality?.trim() || 'CN',
        ...(r.lastName?.trim() ? { lastName: r.lastName.trim() } : {}),
        ...(r.firstName?.trim() ? { firstName: r.firstName.trim() } : {}),
        ...(r.gender ? { gender: r.gender } : {}),
        ...(r.passportIssueCountry?.trim() ? { passportIssueCountry: r.passportIssueCountry.trim() } : {}),
        ...(r.passportExpiry?.trim() ? { passportExpiry: r.passportExpiry.trim() } : {}),
        // 表格导入带出的补充字段（手录时通常为空）
        ...(r.chineseName?.trim() ? { chineseName: r.chineseName.trim() } : {}),
        ...(r.passportIssueDate?.trim() ? { passportIssueDate: r.passportIssueDate.trim() } : {}),
        ...(r.pnr?.trim() ? { pnr: r.pnr.trim().toUpperCase() } : {}),
        note: r.note?.trim() || undefined,
      })),
      ...(teamPrice !== undefined
        ? { settlementPriceCny: teamPrice, groupNote: groupNote.trim() || undefined }
        : {}),
      ...(manualPrice !== undefined ? { manualUnitPriceCny: manualPrice } : {}),
      // 幂等 batchId：整批重试/双击每张子单只建一次（后端派生 `batch:{batchId}:{index}`）。
      batchId,
    };

    setSubmitting(true);
    try {
      let res;
      try {
        res = await api.batchCreateOrders(token, batchPayload);
      } catch (e: unknown) {
        // 重复乘客：后端稳定 code=DUPLICATE_PASSENGER（不靠中文文案匹配）。整批预检命中会整批拒；
        // 客人重复订票且已付款场景：二次确认后带 allowDuplicatePassengers 强录一次（透传每张子单）。
        if (e instanceof ApiError && e.code === 'DUPLICATE_PASSENGER') {
          const orderNos = duplicatePassengerConflictOrderNumbers(e);
          const msg = orderNos.length
            ? `名单中有乘客与订单 ${orderNos.join('、')} 同班次重复。确认仍要录入吗？（客人重复订票、已付款场景）`
            : '名单中有乘客与已有订单同班次重复。确认仍要录入吗？（客人重复订票、已付款场景）';
          if (!window.confirm(msg)) {
            setSubmitting(false);
            return;
          }
          res = await api.batchCreateOrders(token, {
            ...batchPayload,
            allowDuplicatePassengers: true,
          });
        } else {
          throw e;
        }
      }
      setResult(res);
      // 成功后换新 batchId：下一批提交是全新的一批，不复用上一批的幂等键。
      setBatchId(makeBatchId());
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
                  setRows([{ fullName: '', documentNumber: '', dateOfBirth: '', nationality: 'CN' }]);
                  setRosterWarnings([]);
                  setImportErrors([]);
                  setOtaText('');
                  setManualUnitPriceCny(null);
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

            {/* A 产品类型选择 */}
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

            {/* B 归属代理（ADMIN/STAFF 代为录单；直客/OTA 代理账号在此选） */}
            {isOps && (
              <div className="text-xs text-slate-500">
                归属代理（代为录单；直客留空）
                <input
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  placeholder="搜索代理：公司名 / 联系人 / 电话"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                />
                <select
                  className="mt-2 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                >
                  <option value="">— 无代理 / 直客 —</option>
                  {filteredAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.companyName ? `${a.companyName} · ` : ''}{a.contactName}（{a.contactPhone}）
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* C 航班类型：出港 + 回程 */}
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
                  <div className="grid gap-3 md:grid-cols-4">
                    <label className="text-xs text-slate-500">
                      航班
                      <select
                        className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                        value={outboundFlightId}
                        onChange={(e) => { setOutboundFlightId(e.target.value); setOutboundScheduleId(''); setOutboundDate(''); setCabin(''); }}
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
                      起飞日期（可手输）
                      <input
                        type="date"
                        className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                        value={outboundDate}
                        onChange={(e) => { setOutboundDate(e.target.value); setOutboundScheduleId(''); setCabin(''); }}
                        disabled={!outboundFlightId}
                      />
                    </label>
                    <label className="text-xs text-slate-500">
                      班次（出发时间）
                      <select
                        className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                        value={outboundScheduleId}
                        onChange={(e) => { setOutboundScheduleId(e.target.value); setCabin(''); }}
                        disabled={!outboundFlightId}
                      >
                        <option value="">{outboundDate ? '选择当日班次…' : '选择班次…'}</option>
                        {outboundSchedulesForDate.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.departureTime.slice(0, 16).replace('T', ' ')}
                          </option>
                        ))}
                      </select>
                      {outboundFlightId && outboundDate && outboundSchedulesForDate.length === 0 && (
                        <span className="mt-1 block text-[11px] text-amber-600">该日期无班次，请换个日期或清空日期查看全部。</span>
                      )}
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
                            {CABIN_ZH[c.cabin] ?? c.cabin}（余 {c.available}）¥{Number(c.basePrice).toFixed(0)}
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
                    <div className="grid gap-3 md:grid-cols-3">
                      <label className="text-xs text-slate-500">
                        航班
                        <select
                          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                          value={returnFlightId}
                          onChange={(e) => { setReturnFlightId(e.target.value); setReturnScheduleId(''); setReturnDate(''); }}
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
                        起飞日期（可手输）
                        <input
                          type="date"
                          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                          value={returnDate}
                          onChange={(e) => { setReturnDate(e.target.value); setReturnScheduleId(''); }}
                          disabled={!returnFlightId}
                        />
                      </label>
                      <label className="text-xs text-slate-500">
                        班次（出发时间）
                        <select
                          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                          value={returnScheduleId}
                          onChange={(e) => setReturnScheduleId(e.target.value)}
                          disabled={!returnFlightId}
                        >
                          <option value="">{returnDate ? '选择当日班次…' : '选择班次…'}</option>
                          {returnSchedulesForDate.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.departureTime.slice(0, 16).replace('T', ' ')}
                            </option>
                          ))}
                        </select>
                        {returnFlightId && returnDate && returnSchedulesForDate.length === 0 && (
                          <span className="mt-1 block text-[11px] text-amber-600">该日期无班次，请换个日期或清空日期查看全部。</span>
                        )}
                      </label>
                    </div>
                    <p className="mt-1.5 text-[11px] text-slate-400">
                      回程与出港可以是不同航班，共用同一舱位等级。
                    </p>
                  </div>
                )}
              </>
            )}

            {/* C 套餐类型 */}
            {productType === 'BUNDLE' && (
              <div className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 text-xs font-medium text-slate-600">套餐</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs text-slate-500">
                    选择套餐
                    <SearchSelect
                      className="mt-1"
                      options={bundleOptions}
                      value={bundleId}
                      onChange={setBundleId}
                      placeholder="搜索套餐：编号 / 名称…"
                    />
                  </label>
                  <label className="text-xs text-slate-500">
                    出发日期（选填）
                    <input
                      type="date"
                      className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      value={bundleDepartDate}
                      onChange={(e) => setBundleDepartDate(e.target.value)}
                    />
                    <span className="mt-1 block text-[11px] leading-tight text-slate-400">
                      按此匹配套餐航班当日班次并占座；留空则用套餐默认出发日期
                    </span>
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

            {/* D 乘客名单：乘客表格 */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">乘客名单（每位一单 · 共 {validRows.length} 位有效）</span>
                <button className="text-sm text-brand hover:text-brand-dark" onClick={addRow}>＋ 加一行</button>
              </div>
              <div className="scrollbar-visible max-h-60 overflow-x-auto overflow-y-auto rounded-md border border-slate-200">
                <table className="min-w-[900px] w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="min-w-[130px] whitespace-nowrap px-2 py-1.5 text-left font-normal">姓名</th>
                      <th className="min-w-[120px] whitespace-nowrap px-2 py-1.5 text-left font-normal">护照号</th>
                      <th className="min-w-[70px] whitespace-nowrap px-2 py-1.5 text-left font-normal">性别</th>
                      <th className="min-w-[64px] whitespace-nowrap px-2 py-1.5 text-left font-normal">国籍</th>
                      <th className="min-w-[110px] whitespace-nowrap px-2 py-1.5 text-left font-normal">出生日期</th>
                      <th className="min-w-[130px] whitespace-nowrap px-2 py-1.5 text-left font-normal">
                        护照有效期 <span className="text-rose-500">*必填</span>
                      </th>
                      <th className="min-w-[130px] whitespace-nowrap px-2 py-1.5 text-left font-normal">备注（选填）</th>
                      <th className="min-w-[36px] px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="px-2 py-1 align-top">
                          <input className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm" value={r.fullName} onChange={(e) => setRow(i, { fullName: e.target.value })} />
                          {r.passportIssueCountry && (
                            <span className="mt-0.5 block text-[10px] text-slate-400">签发国 {r.passportIssueCountry}</span>
                          )}
                        </td>
                        <td className="px-2 py-1 align-top">
                          <input className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm" value={r.documentNumber} onChange={(e) => setRow(i, { documentNumber: e.target.value })} />
                        </td>
                        <td className="px-2 py-1 align-top">
                          <select
                            className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm"
                            value={r.gender ?? ''}
                            onChange={(e) => setRow(i, { gender: (e.target.value || undefined) as 'M' | 'F' | undefined })}
                          >
                            <option value="">未选</option>
                            <option value="M">男</option>
                            <option value="F">女</option>
                          </select>
                        </td>
                        <td className="px-2 py-1 align-top">
                          {(() => {
                            const nat = (r.nationality ?? '').trim();
                            const natBad = nat.length > 0 && !/^[A-Z]{2}$/.test(nat);
                            return (
                              <>
                                <input
                                  className={`w-full rounded border px-1.5 py-1 text-sm uppercase ${natBad ? 'border-rose-400 bg-rose-50' : 'border-slate-300'}`}
                                  maxLength={2}
                                  placeholder="CN"
                                  value={r.nationality ?? ''}
                                  onChange={(e) => setRow(i, { nationality: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })}
                                />
                                {natBad && <span className="mt-0.5 block text-[11px] text-rose-500">2 位国家码</span>}
                              </>
                            );
                          })()}
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
                        <td className="px-2 py-1 align-top">
                          {(() => {
                            // 护照有效期必填（后端 schema 已必填，这里给行级友好提示）：
                            // 行基础信息（姓名+护照号+生日）齐了才提示，避免空白新行满屏飘红。
                            const expiryVal = (r.passportExpiry ?? '').trim();
                            const rowActive =
                              r.fullName.trim() && r.documentNumber.trim() && parseDob(r.dateOfBirth) !== null;
                            const expiryBad =
                              Boolean(rowActive) &&
                              (!expiryVal || !/^\d{4}-\d{2}-\d{2}$/.test(expiryVal));
                            return (
                              <>
                                <input
                                  type="date"
                                  className={`w-full rounded border px-1.5 py-1 text-sm ${expiryBad ? 'border-rose-400 bg-rose-50' : 'border-slate-300'}`}
                                  value={r.passportExpiry ?? ''}
                                  onChange={(e) => setRow(i, { passportExpiry: e.target.value || undefined })}
                                />
                                {expiryBad && (
                                  <span className="mt-0.5 block text-[11px] text-rose-500">
                                    {expiryVal ? '格式如 2030-01-01' : '必填（如 2030-01-01）'}
                                  </span>
                                )}
                              </>
                            );
                          })()}
                        </td>
                        <td className="px-2 py-1 align-top">
                          <input
                            className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm"
                            placeholder="靠窗 / 素食 / 换人…"
                            value={r.note ?? ''}
                            onChange={(e) => setRow(i, { note: e.target.value })}
                          />
                        </td>
                        <td className="px-2 py-1 text-right align-top">
                          <button className="text-xs text-slate-400 hover:text-rose-600" onClick={() => removeRow(i)} disabled={rows.length <= 1}>删</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* D 表格导入行级错误（红字）：修正前不宜提交 */}
            {importErrors.length > 0 && (
              <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                <div className="font-medium">表格导入行级错误（{importErrors.length} 条）——请在上方名单中修正后再提交：</div>
                <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-auto pl-5">
                  {importErrors.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {/* D 解析提醒 */}
            {rosterWarnings.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <div className="font-medium">名单解析提醒（{rosterWarnings.length} 条）：</div>
                <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-auto pl-5">
                  {rosterWarnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {/* E 📋 OTA 名单粘贴导入：首行航段 + 每位乘客段 + 结算价，一键解析填充 */}
            <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">📋 粘贴名单导入（OTA 线上单）</span>
                <button
                  type="button"
                  className="btn-primary text-xs disabled:opacity-50"
                  onClick={importOtaRoster}
                  disabled={!otaText.trim()}
                >
                  解析并填充
                </button>
              </div>
              <textarea
                className="block w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs"
                rows={5}
                value={otaText}
                onChange={(e) => setOtaText(e.target.value)}
                placeholder={'QH9588 DAD-MFM 2026-08-15\n乘机人：WU/FEILAI\n性别：男\n出生年月：1983-09-20\n护照：EB9452866\n签发国：CN\n有效期：2028-01-02\n乘机人：WANG/LIQING\n...\n结算价1000元X10个。'}
              />
              <p className="mt-1 text-[11px] text-slate-400">
                自动识别：首行航班/航段/日期 → 选中航班与当日班次（舱位默认经济舱，如商务舱请手动改选）；每位乘客姓名(LAST/FIRST)、性别、出生日期、护照号、签发国、有效期；结算价 → 预填 OTA 结算单价。解析问题会在下方提醒里逐条列出。
              </p>
            </div>

            {/* E 快速粘贴 */}
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

            {/* F 名单导入：下载模版 / 上传名单 */}
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
              <label className="btn-secondary cursor-pointer text-sm">
                {importBusy ? '解析中…' : '导入表格（旧系统模版）'}
                <input
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="hidden"
                  onChange={onImportTemplateFile}
                  disabled={importBusy}
                />
              </label>
              <span className="text-[11px] text-slate-400">
                上传后自动填充下方名单；也可手动录入。旧系统模版（单程 16 列 / 往返 18 列）自动带出航班/舱位/代理/结算价；旧 .xls 请先在 Excel 里另存为 .xlsx。
              </span>
            </div>

            {/* G 价格（选填）：旅游团结算价 / OTA 线上单结算价 */}
            {(productType === 'FLIGHT_ONEWAY' || productType === 'FLIGHT_ROUNDTRIP') && (
              <>
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

                {/* OTA 结算单价（手动录入 · 仅 ADMIN/STAFF）——与上方团队结算价二选一 */}
                {isOps && (
                  <div className="rounded-md border border-slate-200 bg-sky-50/50 p-3">
                    <div className="mb-2 text-sm font-medium text-slate-700">OTA 线上单（选填）</div>
                    <label className="block text-xs text-slate-500 md:w-1/2">
                      结算单价（¥/人 · 手动录入）
                      <NumberInput
                        className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                        value={manualUnitPriceCny}
                        onChange={setManualUnitPriceCny}
                        min={0}
                        step={1}
                        integerOnly
                        placeholder="OTA 名单结算价，如 1000"
                      />
                    </label>
                    <p className="mt-2 text-[11px] text-sky-700">
                      ⓘ 不改机票权威价：仍按系统价建单，再按差额自动加一条价格调整行把订单总额调到此结算单价（系统价/差额可追溯、审计留痕）。与上方「团队议价结算价」二选一。
                    </p>
                  </div>
                )}
              </>
            )}

            {/* H 录入人 + 整批备注 */}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="text-xs text-slate-500">
                录入人
                <div className="mt-1 flex h-[34px] items-center rounded-md bg-slate-50 px-2.5 text-sm text-slate-700">
                  {recorderLabel}
                  <span className="ml-2 text-xs text-slate-400">（系统自动记录）</span>
                </div>
              </div>
              <label className="text-xs text-slate-500">
                整批备注（选填，写入每单）
                <input className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="全团共用；每位乘客可在下方名单里单独补充" />
              </label>
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
  // 代理预存余额本地副本（抵扣/存入后即时刷新展示，不必等父级 onChanged 重拉）。
  // 对外脱敏：后端对 AGENT/CUSTOMER 不下发 prepaymentBalance，Number(undefined)=NaN，故用 || 0 兜底避免 ¥NaN。
  const [agentBalance, setAgentBalance] = useState<number>(agent ? Number(agent.prepaymentBalance) || 0 : 0);
  useEffect(() => {
    setAgentBalance(agent ? Number(agent.prepaymentBalance) || 0 : 0);
  }, [agent]);
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('BANK_CARD');
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 收款复核锁：财务/出纳对账无误后锁定本单收款；锁定态隐藏录款表单并禁止再录。
  const [paymentsLocked, setPaymentsLocked] = useState(false);
  const [lockBusy, setLockBusy] = useState(false);

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
        setPaymentsLocked(r.order.paymentsLocked ?? false);
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

  async function confirm(confirmDuplicate = false): Promise<void> {
    if (!token || submitting) return;
    // 锁定态兜底（表单已隐藏，这里再挡一次，防误触）：锁定后不许录新收款。
    if (paymentsLocked) {
      setErr('收款已锁定（财务复核完成），请先解锁再录收款');
      return;
    }
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
        confirmDuplicate: confirmDuplicate || undefined,
      });
      setPaid(res.paidAmount);
      setProofUrl(null);
      setNote('');
      setIdemKey(makeIdemKey());
      const r = await api.getOrder(token, orderId);
      setPayments(r.order.payments ?? []);
      onChanged?.();
    } catch (e: unknown) {
      // 同额软闸：近 windowMinutes 分钟内同订单已录过等额收款 → 二次确认后带 confirmDuplicate 重发。
      // 硬闸(400 超收) / 其它错误：直接把服务端 message 原样展示在错误条。
      const dup = duplicateAmountDetails(e);
      if (dup && !confirmDuplicate) {
        setSubmitting(false);
        const okToProceed = window.confirm(
          `该订单 ${dup.windowMinutes} 分钟内已录过一笔 ¥${dup.amount.toLocaleString()}，确定这是另一笔新收款吗？`,
        );
        if (okToProceed) await confirm(true);
        return;
      }
      setErr(e instanceof ApiError ? e.message : '确认收款失败');
    } finally {
      setSubmitting(false);
    }
  }

  // 收款复核锁：财务/出纳对账无误后锁定本单收款（锁定后禁止人工录新收款）；解锁需二次确认。
  async function toggleLock(): Promise<void> {
    if (!token || lockBusy) return;
    const next = !paymentsLocked;
    if (!next && !window.confirm('解锁后可再次录入收款，确定解锁吗？')) return;
    setErr(null);
    setLockBusy(true);
    try {
      const res = await api.setOrderPaymentsLock(token, orderId, next);
      setPaymentsLocked(res.paymentsLocked);
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : next ? '锁定失败' : '解锁失败');
    } finally {
      setLockBusy(false);
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
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">
          收款
          {paymentsLocked && (
            <span className="ml-2 inline-flex items-center rounded bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-600">
              🔒 已锁定
            </span>
          )}
        </h3>
        <button
          className="btn-secondary text-xs px-2 py-1 disabled:opacity-50"
          onClick={toggleLock}
          disabled={lockBusy}
          title={paymentsLocked ? '解锁后可再次录入收款' : '对账复核无误后锁定本单收款'}
        >
          {lockBusy ? '处理中…' : paymentsLocked ? '解锁收款' : '锁定收款'}
        </button>
      </div>
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
                {p.reconciled ? (
                  <span
                    className="inline-flex items-center rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700"
                    title="来自收款对账台认款的进账"
                  >
                    已认款{(p.externalTxnId || p.receiptNo) ? ` · 流水${p.externalTxnId || p.receiptNo}` : ''}
                  </span>
                ) : (
                  <span className="text-slate-400">手工确认</span>
                )}
                {p.proofUrl && (
                  <a href={p.proofUrl} target="_blank" rel="noreferrer" className="ml-auto">
                    <img src={p.proofUrl} alt="收款截图" className="h-8 w-8 rounded border border-slate-300 object-cover" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* 收款已锁定：财务复核完成，隐藏录款表单；要再录需先解锁 */}
        {paymentsLocked ? (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              🔒 收款已锁定（财务复核完成），如需继续录入收款请先解锁。
            </div>
            {err && <div className="mt-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</div>}
          </div>
        ) : (
        /* 确认收款表单（始终可补录：允许多付/追加收款，后端已放开 ≤尾款 限制）*/
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
                onClick={() => confirm()}
                disabled={submitting}
              >
                {submitting ? '确认中…' : '确认收款'}
              </button>
            </div>
          </div>
        </div>
        )}
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

  // 幂等 batchId：同一次批量提交（含双击/网络重试）只入账一次；成功后换新
  const makeBatchId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `bc-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const [batchId, setBatchId] = useState(makeBatchId);

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
        batchId,
      });
      setResults(res.results);
      setBatchId(makeBatchId());
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
