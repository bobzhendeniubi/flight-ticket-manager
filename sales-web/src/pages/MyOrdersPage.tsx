/**
 * 客户端 · 我的订单
 *
 * - 列出当前登录用户自己的订单（后端 RBAC 自动过滤）
 * - 每条卡片：订单号 / 状态 / 金额 / 加入时间 / 项目摘要
 * - 点开 → 详情：每个 item + 联系信息 + 出行人
 * - 可取消的状态（PAID/PROCESSING/TICKETED）：先看退款报价 → 确认才真正取消
 *
 * 后端复用：
 *   GET /orders                  → 列表（已 RBAC 过滤）
 *   GET /orders/:id              → 详情（用列表数据足够，不必再请求）
 *   GET /orders/:id/refund-quote → 退款报价（看一眼，不动状态）
 *   POST /orders/:id/cancel      → 申请取消（建 Refund + 状态 → REFUND_REQUESTED）
 *   PATCH /orders/:id/passengers/:pid → 出行人护照资料自助补录（弹窗见 PassengerPassportModal）
 *   POST /orders/:id/change-request   → 申请改签（状态 → CHANGE_REQUESTED，弹窗见 ChangeRequestDialog）
 *   GET /orders/:id/itinerary.pdf     → 下载行程单 PDF（fetch blob → 浏览器下载）
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  type MySeatLock,
  type MyWaitlistEntry,
  type OrderPassengerDetail,
  type OrderSummary,
  type OrderStatus,
  type RefundQuote,
  type WaitlistStatus,
} from '../lib/api';
import { CABIN_LABEL } from '../lib/airports';
import { useAuth } from '../stores/auth';
import { Icon, type IconName } from '../components/Icon';
import { Modal } from '../components/Modal';
import { PaymentPanel } from '../components/PaymentPanel';
import { WriteReviewForm, type WriteReviewFormData } from '../components/WriteReviewForm';
import { ChangeRequestDialog } from '../components/ChangeRequestDialog';
import { PassengerPassportModal } from '../components/PassengerPassportModal';

const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '已出票',
  COMPLETED: '已完成',
  PAYMENT_TIMEOUT: '支付超时',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '退款审核中',
  REFUNDED: '已退款',
  CHANGE_REQUESTED: '改签审核中',
  CHANGED: '已改签',
  FAILED: '失败',
};

const STATUS_CLASS: Record<OrderStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-600',
  PENDING_PAYMENT: 'bg-amber-100 text-amber-800',
  PAID: 'bg-emerald-100 text-emerald-700',
  PROCESSING: 'bg-brand-100 text-brand-700',
  TICKETED: 'bg-emerald-100 text-emerald-700',
  COMPLETED: 'bg-slate-100 text-slate-700',
  PAYMENT_TIMEOUT: 'bg-rose-100 text-rose-700',
  CANCELLED: 'bg-rose-100 text-rose-700',
  REFUND_REQUESTED: 'bg-amber-100 text-amber-800',
  REFUNDED: 'bg-slate-100 text-slate-600',
  CHANGE_REQUESTED: 'bg-amber-100 text-amber-800',
  CHANGED: 'bg-sky-100 text-sky-700',
  FAILED: 'bg-rose-100 text-rose-700',
};

// 订单条目按 kind 映射统一线性图标（取代散落的 emoji）
const KIND_ICON: Record<string, IconName> = {
  FLIGHT: 'plane',
  HOTEL: 'hotel',
  TRANSFER: 'car',
  VISA: 'visa',
  INSURANCE: 'shield',
  FEE: 'info',
  DISCOUNT: 'ticket',
};

/** 订单条目 kind 图标（未知 kind 兜底用 package） */
function KindIcon({ kind, className }: { kind: string; className?: string }) {
  return <Icon name={KIND_ICON[kind] ?? 'package'} className={className ?? 'h-3.5 w-3.5'} />;
}

// 航变标记：我们因航司航变为你调整了航班班次，落在该航段的 metadata.flightChanged。
type FlightChangedMark = { fromDeparture?: string | null };

/** 从订单项 metadata 读「航变」标记；无标记时返回 null。 */
function readFlightChanged(metadata: unknown): FlightChangedMark | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const mark = (metadata as { flightChanged?: unknown }).flightChanged;
  if (!mark || typeof mark !== 'object') return null;
  return mark as FlightChangedMark;
}

/** ISO 起飞时间 → "M月D日 HH:MM"（航变提示里展示原起飞时间）。 */
function formatDepart(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const CANCELLABLE = new Set<OrderStatus>(['PAID', 'PROCESSING', 'TICKETED']);
// 可申请改签的状态（与后端 POST /orders/:id/change-request 守卫一致）
const CHANGEABLE = new Set<OrderStatus>(['PAID', 'PROCESSING', 'TICKETED']);
// 可下载行程单的状态（与后端 GET /orders/:id/itinerary.pdf 守卫一致）
const ITINERARY_READY = new Set<OrderStatus>([
  'PAID',
  'PROCESSING',
  'TICKETED',
  'COMPLETED',
  'CHANGE_REQUESTED',
  'CHANGED',
]);
// 出行人护照资料可自助补录的状态（与后端 PATCH /orders/:id/passengers/:pid 守卫一致；
// 出票后（TICKETED 及之后）资料已锁定，改动请走客服）
const PASSENGER_EDITABLE = new Set<OrderStatus>(['PENDING_PAYMENT', 'PAID', 'PROCESSING']);
// 仍需付款的状态：订单未结清时露出收款方式 + 上传凭证（买家可稍后回来付）。
// 已取消 / 退款 / 失败 / 超时等终态不再展示收款入口。
const PAYABLE_STATUS = new Set<OrderStatus>([
  'DRAFT',
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'TICKETED',
]);

/** 应付余额（总额 − 已付）；≤0 视为已结清。money 字段是 Decimal 序列化的字符串。 */
function balanceDueCny(order: OrderSummary): number {
  const total = Number(order.total);
  const paid = Number(order.paidAmount);
  const due = (Number.isFinite(total) ? total : 0) - (Number.isFinite(paid) ? paid : 0);
  return due > 0 ? due : 0;
}
// 可写评价的订单状态：行程已完成（COMPLETED）。后端无 reviewed 字段，
// 本会话内用客户端 Set 记下已评价的订单，提交成功后禁用再次评价。
const REVIEWABLE = new Set<OrderStatus>(['COMPLETED']);

export function MyOrdersPage() {
  const { tokens } = useAuth();
  const token = tokens?.accessToken ?? '';
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // token 过期/无效时（401）→ 展示游客查单入口而非错误文案
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 详情缓存：listOrders 返回的 passenger 只有 {id, fullName}，
  // 展开时拉 GET /orders/:id 拿完整 documentType / documentNumber
  const [detailCache, setDetailCache] = useState<Record<string, OrderSummary>>({});

  // 取消流程状态
  const [cancelTarget, setCancelTarget] = useState<OrderSummary | null>(null);
  const [cancelQuote, setCancelQuote] = useState<RefundQuote | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);

  // 护照补录流程状态：target = 正在补录的 (orderId, passenger)；saved = 行内成功提示
  const [passportTarget, setPassportTarget] = useState<{
    orderId: string;
    passenger: OrderPassengerDetail;
  } | null>(null);
  const [passportSaved, setPassportSaved] = useState<{ orderId: string; fullName: string } | null>(
    null,
  );

  // 改签申请流程状态
  const [changeTarget, setChangeTarget] = useState<OrderSummary | null>(null);

  // 行程单下载状态：下载中的订单 id + 按订单的错误提示
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [itineraryErrors, setItineraryErrors] = useState<Record<string, string>>({});

  // 写评价流程状态
  const [reviewTarget, setReviewTarget] = useState<OrderSummary | null>(null);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  // 本会话内已评价的订单 id（提交成功后加入，用于禁用「写评价」按钮）
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(() => new Set());

  const openReview = (order: OrderSummary) => {
    setReviewTarget(order);
    setReviewError(null);
  };

  const submitReview = async (data: WriteReviewFormData) => {
    if (!reviewTarget) return;
    setReviewSubmitting(true);
    setReviewError(null);
    try {
      await api.createReview(
        reviewTarget.id,
        { rating: data.rating, body: data.body, title: data.title },
        token,
      );
      setReviewedIds((prev) => {
        const next = new Set(prev);
        next.add(reviewTarget.id);
        return next;
      });
      setReviewTarget(null);
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : '提交评价失败，请重试');
    } finally {
      setReviewSubmitting(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setTokenInvalid(false);
    api
      .listOrders(token)
      .then((r) => setOrders(r.orders))
      .catch((e) => {
        // 401 = token 过期/失效 → 展示游客查单入口，不显示原始错误文案
        if (e instanceof ApiError && e.status === 401) {
          setTokenInvalid(true);
        } else {
          setError(e instanceof Error ? e.message : '加载失败');
        }
      })
      .finally(() => setLoading(false));
  }, [token]);

  const toggleExpand = async (order: OrderSummary) => {
    if (expandedId === order.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(order.id);
    // 拉一次详情（拿完整 passengers.documentType/Number）— 已缓存就跳过
    if (!detailCache[order.id]) {
      try {
        const r = await api.getOrder(token, order.id);
        setDetailCache((prev) => ({ ...prev, [order.id]: r.order }));
      } catch {
        // 详情拉不到就用列表数据 fallback（passenger 只有 fullName）
      }
    }
  };

  /** 护照补录保存成功：更新 detailCache 里该乘客（含最新 hasPassportPhoto）→ 关弹窗 + 行内提示 */
  const handlePassportSaved = (orderId: string, updated: OrderPassengerDetail) => {
    setDetailCache((prev) => {
      const cur = prev[orderId];
      if (!cur) return prev;
      return {
        ...prev,
        [orderId]: {
          ...cur,
          passengers: cur.passengers.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)),
        },
      };
    });
    setPassportTarget(null);
    setPassportSaved({ orderId, fullName: updated.fullName });
  };

  /** 提交改签申请：成功就地更新订单状态（→ 改签审核中）；失败抛给弹窗内展示 */
  const submitChangeRequest = async (reason: string) => {
    if (!changeTarget) return;
    const r = await api.requestOrderChange(token, changeTarget.id, { reason });
    setOrders((prev) => prev.map((o) => (o.id === r.order.id ? { ...o, status: r.order.status } : o)));
    setDetailCache((prev) =>
      prev[r.order.id] ? { ...prev, [r.order.id]: { ...prev[r.order.id], status: r.order.status } } : prev,
    );
    setChangeTarget(null);
  };

  /** 下载行程单 PDF：fetch blob → 触发浏览器下载「行程单-{订单号}.pdf」 */
  const downloadItinerary = async (order: OrderSummary) => {
    setDownloadingId(order.id);
    setItineraryErrors((prev) => {
      if (!(order.id in prev)) return prev;
      const next = { ...prev };
      delete next[order.id];
      return next;
    });
    try {
      const blob = await api.downloadOrderItinerary(token, order.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `行程单-${order.orderNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      const msg =
        e instanceof ApiError && e.code === 'NO_FLIGHT_ITEMS'
          ? '该订单不含航班，暂不支持行程单'
          : e instanceof ApiError && e.code === 'ITINERARY_NOT_READY'
            ? '行程单还在准备中，请稍后再试'
            : '行程单下载失败，请稍后重试';
      setItineraryErrors((prev) => ({ ...prev, [order.id]: msg }));
    } finally {
      setDownloadingId(null);
    }
  };

  const startCancel = async (order: OrderSummary) => {
    setCancelTarget(order);
    setCancelQuote(null);
    setCancelReason('');
    setCancelError(null);
    setCancelLoading(true);
    try {
      const r = await api.getRefundQuote(token, order.id);
      setCancelQuote(r.quote);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : '加载退款报价失败');
    } finally {
      setCancelLoading(false);
    }
  };

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    setCancelLoading(true);
    setCancelError(null);
    try {
      const r = await api.cancelOrder(token, cancelTarget.id, cancelReason.trim() || undefined);
      // 把列表里这条更新成最新状态
      setOrders((prev) => prev.map((o) => (o.id === r.order.id ? r.order : o)));
      setCancelTarget(null);
      setCancelQuote(null);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : '取消失败');
    } finally {
      setCancelLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="card animate-fade-up py-16 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-brand-50 text-brand">
          <Icon name="search" className="h-9 w-9" />
        </div>
        <p className="mt-4 text-base font-semibold text-ink">游客订单查询</p>
        <p className="mt-1 text-sm text-ink-muted">
          游客下单后请用「订单号 + 手机号」查询订单进度，无需登录。
        </p>
        <div className="mt-5 flex flex-col items-center gap-3">
          <Link to="/lookup" className="btn-primary inline-flex items-center gap-1.5">
            <Icon name="search" className="h-4 w-4" />
            用订单号查询
          </Link>
          <Link to="/login?redirect=/orders" className="text-sm font-medium text-brand-700 transition hover:text-brand-dark">
            已有账号？去登录 →
          </Link>
        </div>
      </div>
    );
  }

  if (tokenInvalid) {
    return (
      <div className="card animate-fade-up py-16 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-sun-light text-amber-600">
          <Icon name="clock" className="h-9 w-9" />
        </div>
        <p className="mt-4 text-base font-semibold text-ink">登录已过期</p>
        <p className="mt-1 text-sm text-ink-muted">
          游客或会话过期后可用「订单号 + 手机号」查询订单，无需重新登录。
        </p>
        <div className="mt-5 flex flex-col items-center gap-3">
          <Link to="/lookup" className="btn-primary inline-flex items-center gap-1.5">
            <Icon name="search" className="h-4 w-4" />
            用订单号查询
          </Link>
          <Link to="/login?redirect=/orders" className="text-sm font-medium text-brand-700 transition hover:text-brand-dark">
            重新登录 →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">我的订单</h1>
          <p className="section-sub">
            一共 <span className="font-semibold text-ink nums">{orders.length}</span> 笔订单。可取消的订单点"申请取消"看退款明细。
          </p>
        </div>
        <Link to="/" className="whitespace-nowrap text-sm font-medium text-brand-700 transition hover:text-brand-dark">
          ← 继续逛
        </Link>
      </header>

      {/* 我的锁位 — 有 ACTIVE 锁位才显示，挂在订单列表上方 */}
      <SeatLocksSection token={token} />

      {/* 我的候补 — 有候补记录才显示，挂在锁位下方 */}
      <WaitlistSection token={token} />

      {loading && <div className="card py-8 text-center text-ink-muted">加载中…</div>}
      {error && <div className="card border-deal/30 bg-deal-light text-sm font-medium text-deal-dark">{error}</div>}

      {!loading && !error && orders.length === 0 && (
        <div className="card animate-fade-up py-12 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-brand">
            <Icon name="ticket" className="h-7 w-7" />
          </div>
          <p className="mt-3 text-base font-semibold text-ink">还没有订单</p>
          <p className="mt-1 text-sm text-ink-muted">挑一张机票或一价全含套餐，开启岘港之旅</p>
          <Link to="/" className="btn-primary mt-4 inline-flex items-center gap-1.5">
            去看看机票 <Icon name="arrowRight" className="h-4 w-4" />
          </Link>
        </div>
      )}

      {orders.map((o) => {
        const expanded = expandedId === o.id;
        const cancellable = CANCELLABLE.has(o.status);
        const changeable = CHANGEABLE.has(o.status);
        const itineraryReady = ITINERARY_READY.has(o.status);
        const passengerEditable = PASSENGER_EDITABLE.has(o.status);
        const reviewable = REVIEWABLE.has(o.status);
        const reviewed = reviewedIds.has(o.id);
        // 展开后用 detail（详情拉到的完整 passenger）；详情没拿到时 fallback 到列表
        const detail = detailCache[o.id] ?? o;
        // 缺护照人数：只有详情接口带 hasPassportPhoto（列表窄 select 没有）→ 未拉详情时算 0
        const missingPassportCount = detail.passengers.filter(
          (p) => p.hasPassportPhoto === false,
        ).length;
        return (
          <article key={o.id} className="card-interactive space-y-3 p-4 md:p-5">
            <header className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="font-mono text-sm font-semibold text-ink nums">{o.orderNumber}</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_CLASS[o.status]}`}
                >
                  {STATUS_LABEL[o.status]}
                </span>
              </div>
              <div className="text-right">
                <div className="price text-lg">
                  ¥{(Number(o.total) || 0).toLocaleString()}
                </div>
                <div className="text-xs text-ink-muted">
                  {new Date(o.createdAt).toLocaleString('zh-CN')}
                </div>
              </div>
            </header>

            <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-ink-soft">
              {o.items.slice(0, 3).map((it, i) => (
                <span key={it.id} className="inline-flex items-center gap-1">
                  <KindIcon kind={it.kind} /> {it.description}
                  {i < Math.min(2, o.items.length - 1) && ' ·'}
                </span>
              ))}
              {o.items.length > 3 && <span className="text-ink-muted">…等 {o.items.length} 项</span>}
            </div>

            {/* 改签审核中：给买家一个进度预期 */}
            {o.status === 'CHANGE_REQUESTED' && (
              <div className="flex items-center gap-1.5 rounded-xl bg-sky-50 px-3 py-2 text-xs font-medium text-sky-700">
                <Icon name="clock" className="h-3.5 w-3.5 shrink-0" />
                改签申请处理中，如需补充信息请联系客服
              </div>
            )}

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => toggleExpand(o)}
                className="text-sm font-medium text-brand-700 transition hover:text-brand-dark"
              >
                {expanded ? '收起 ↑' : '查看详情 →'}
              </button>
              <div className="flex items-center gap-2">
                {reviewable && (
                  reviewed ? (
                    <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700">
                      <Icon name="check" className="h-4 w-4" /> 已评价
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openReview(o)}
                      className="inline-flex items-center gap-1 rounded-lg border border-brand/40 bg-white px-3 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50"
                    >
                      <Icon name="star" className="h-4 w-4 text-sun" /> 写评价
                    </button>
                  )
                )}
                {itineraryReady && (
                  <button
                    type="button"
                    disabled={downloadingId === o.id}
                    onClick={() => downloadItinerary(o)}
                    className="inline-flex items-center gap-1 rounded-lg border border-brand/40 bg-white px-3 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50 disabled:opacity-50"
                  >
                    <Icon name="plane" className="h-4 w-4" />
                    {downloadingId === o.id ? '生成中…' : '下载行程单'}
                  </button>
                )}
                {changeable && (
                  <button
                    type="button"
                    onClick={() => setChangeTarget(o)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-ink-soft transition hover:bg-canvas hover:text-ink"
                  >
                    申请改签
                  </button>
                )}
                {cancellable && (
                  <button
                    type="button"
                    onClick={() => startCancel(o)}
                    className="rounded-lg border border-deal/40 bg-white px-3 py-1.5 text-sm font-medium text-deal transition hover:bg-deal-light"
                  >
                    申请取消
                  </button>
                )}
              </div>
            </footer>

            {/* 行程单下载失败提示（不含航班 / 未就绪 / 网络） */}
            {itineraryErrors[o.id] && (
              <div className="flex items-center gap-1.5 rounded-xl border border-sun/40 bg-sun-light px-3 py-2 text-xs font-medium text-amber-800" role="alert">
                <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
                {itineraryErrors[o.id]}
              </div>
            )}

            {expanded && (
              <div className="animate-fade-in space-y-3 border-t border-slate-100 pt-3 text-sm">
                {/* 缺护照横幅：详情已加载 + 订单可补录 + 有人缺护照图（出票需要护照资料） */}
                {passengerEditable && missingPassportCount > 0 && (
                  <div className="flex items-center gap-1.5 rounded-xl border border-sun/40 bg-sun-light px-3 py-2.5 text-xs font-medium text-amber-800">
                    <Icon name="info" className="h-4 w-4 shrink-0" />
                    待补护照资料 {missingPassportCount} 人 — 出票需要护照信息，请在下方出行人处点「补充护照资料」完成。
                  </div>
                )}

                {/* 联系人 */}
                <div className="rounded-xl bg-canvas p-3.5">
                  <div className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-muted">联系人</div>
                  <div className="text-ink">{o.contactName} · {o.contactPhone}</div>
                  {o.contactEmail && <div className="text-ink-soft">{o.contactEmail}</div>}
                </div>

                {/* 项目明细 */}
                <div>
                  <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-muted">项目明细</div>
                  <ul className="space-y-1.5">
                    {o.items.map((it) => {
                      const changed = readFlightChanged(it.metadata);
                      const oldDepart = changed ? formatDepart(changed.fromDeparture) : null;
                      const newDepart =
                        it.departureDate && it.departureTime
                          ? `${it.departureDate} ${it.departureTime}`
                          : it.departureDate ?? null;
                      return (
                        <li key={it.id} className="rounded-xl border border-slate-100 bg-surface px-3 py-2.5">
                          <div className="flex items-center justify-between">
                            <div className="inline-flex flex-wrap items-center gap-1.5 text-ink">
                              <KindIcon kind={it.kind} className="h-4 w-4 text-ink-muted" />
                              {it.description}
                              {it.quantity > 1 && <span className="text-ink-muted"> × {it.quantity}</span>}
                              {changed && (
                                <span className="inline-flex items-center gap-0.5 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-600">
                                  航变
                                </span>
                              )}
                            </div>
                          </div>
                          {changed && (
                            <div className="mt-1.5 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs leading-relaxed text-rose-700">
                              航班有调整，请留意新的起飞时间
                              {newDepart && <>：<span className="font-semibold">{newDepart}</span></>}
                              {oldDepart && <span className="text-rose-400"> · 原 {oldDepart}</span>}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {/* 打包展示订单总价（= 买家自己的结算价）；行级金额属我方内部口径，后端对 CUSTOMER 不下发，故不逐项拆价。 */}
                  <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2 text-sm">
                    <span className="text-ink-muted">订单总额</span>
                    <span className="price">¥{(Number(o.total) || 0).toLocaleString()}</span>
                  </div>
                </div>

                {/* 出行人（用 detail，因为列表只 select fullName，没有 documentType/Number）
                    护照资料徽章只在详情态渲染（hasPassportPhoto 仅详情接口带；列表 fallback 为 undefined 不显示） */}
                {detail.passengers.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-muted">出行人</div>
                    {passportSaved?.orderId === o.id && (
                      <div className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                        <Icon name="check" className="h-3.5 w-3.5" />
                        {passportSaved.fullName} 的护照资料已更新
                      </div>
                    )}
                    <ul className="space-y-1.5">
                      {detail.passengers.map((p) => (
                        <li
                          key={p.id}
                          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-ink-soft"
                        >
                          <span>
                            <span className="font-medium text-ink">{p.fullName}</span>
                            {p.documentNumber && (
                              <>
                                {' · '}
                                {p.documentType === 'PASSPORT' ? '护照' : p.documentType ?? '证件'} {p.documentNumber}
                              </>
                            )}
                          </span>
                          <span className="flex items-center gap-2">
                            {p.hasPassportPhoto === true && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                                <Icon name="check" className="h-3 w-3" /> 护照已上传
                              </span>
                            )}
                            {p.hasPassportPhoto === false && passengerEditable && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                                待补护照
                              </span>
                            )}
                            {p.hasPassportPhoto === false && !passengerEditable && (
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                                未上传护照
                              </span>
                            )}
                            {passengerEditable && p.hasPassportPhoto !== undefined && (
                              <button
                                type="button"
                                onClick={() => {
                                  setPassportSaved(null);
                                  setPassportTarget({ orderId: o.id, passenger: p });
                                }}
                                className="rounded-lg border border-brand/40 bg-white px-2.5 py-1 text-xs font-medium text-brand-700 transition hover:bg-brand-50"
                              >
                                {p.hasPassportPhoto ? '修改护照资料' : '补充护照资料'}
                              </button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* 收款方式 + 上传付款凭证：仅在订单仍有应付余额时露出（买家可稍后回来付） */}
                {PAYABLE_STATUS.has(o.status) && balanceDueCny(o) > 0 && (
                  <PaymentPanel
                    orderNo={o.orderNumber}
                    lookupKey={o.contactPhone}
                    amountDueCny={balanceDueCny(o)}
                    variant="detail"
                  />
                )}
              </div>
            )}
          </article>
        );
      })}

      {/* 取消订单弹窗 */}
      {cancelTarget && (
        <CancelDialog
          order={cancelTarget}
          quote={cancelQuote}
          loading={cancelLoading}
          error={cancelError}
          reason={cancelReason}
          onReasonChange={setCancelReason}
          onClose={() => {
            setCancelTarget(null);
            setCancelQuote(null);
            setCancelError(null);
          }}
          onConfirm={confirmCancel}
        />
      )}

      {/* 申请改签弹窗 */}
      {changeTarget && (
        <ChangeRequestDialog
          order={changeTarget}
          onClose={() => setChangeTarget(null)}
          onSubmit={submitChangeRequest}
        />
      )}

      {/* 护照资料补充弹窗（key 按乘客：每次打开都重新挂载、从最新 passenger 取初值） */}
      {passportTarget && (
        <PassengerPassportModal
          key={passportTarget.passenger.id}
          token={token}
          orderId={passportTarget.orderId}
          passenger={passportTarget.passenger}
          onClose={() => setPassportTarget(null)}
          onSaved={(p) => handlePassportSaved(passportTarget.orderId, p)}
        />
      )}

      {/* 写评价弹窗 */}
      <Modal
        open={reviewTarget !== null}
        onClose={() => {
          if (reviewSubmitting) return;
          setReviewTarget(null);
          setReviewError(null);
        }}
        title="写评价"
        size="md"
      >
        <div className="space-y-3 p-5">
          {reviewTarget && (
            <p className="text-sm text-ink-soft">
              订单 <span className="font-mono font-semibold text-ink">{reviewTarget.orderNumber}</span>
              {' · '}分享你的真实体验，帮助更多旅客。
            </p>
          )}
          {reviewError && (
            <p className="flex items-center gap-1.5 rounded-xl border border-deal/30 bg-deal-light px-3 py-2 text-sm font-medium text-deal-dark" role="alert">
              <Icon name="info" className="h-4 w-4 shrink-0" />
              {reviewError}
            </p>
          )}
          <WriteReviewForm onSubmit={submitReview} submitting={reviewSubmitting} />
        </div>
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SeatLocksSection — 我的锁位（下单前临时占座：≤9 张 / 10 分钟 / 到期自动回收）。
// 倒计时同 CheckoutPage HoldCountdown 思路（1s setInterval + cleanup）；
// 归零的锁位客户端直接剔除（服务端 worker 负责真正回收座位）。
// ─────────────────────────────────────────────────────────────────
function SeatLocksSection({ token }: { token: string }) {
  const [locks, setLocks] = useState<MySeatLock[]>([]);
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!token) return;
    api
      .listMyLocks(token)
      .then((r) => setLocks(r.locks))
      .catch(() => undefined); // 锁位加载失败不阻塞订单列表
  }, [token]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 倒计时归零 → 不再展示（座位已由服务端自动回收）
  const active = locks.filter((l) => new Date(l.expiresAt).getTime() > now);
  if (active.length === 0) return null;

  const release = async (id: string) => {
    setReleasingId(id);
    setError(null);
    try {
      await api.releaseSeatLock(token, id);
      const r = await api.listMyLocks(token);
      setLocks(r.locks);
    } catch (e) {
      setError(e instanceof Error ? e.message : '释放失败');
    } finally {
      setReleasingId(null);
    }
  };

  return (
    <section className="card space-y-2.5 border-sun/40 bg-sun-light/50">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-base font-bold text-ink">
          <Icon name="clock" className="h-4 w-4 text-amber-600" />我的锁位
        </h2>
        <span className="text-xs font-medium text-amber-800">锁定有效期内完成下单即自动使用该锁位</span>
      </header>
      {error && <div className="text-sm font-medium text-deal">{error}</div>}
      <ul className="space-y-2">
        {active.map((l) => {
          const leftMs = Math.max(0, new Date(l.expiresAt).getTime() - now);
          const mm = Math.floor(leftMs / 60000);
          const ss = Math.floor((leftMs % 60000) / 1000);
          return (
            <li
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sun/30 bg-surface px-3 py-2.5 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold text-ink">{l.flightNumber}</span>
                <span className="text-ink-muted">
                  {new Date(l.departureTime).toLocaleString('zh-CN')}
                </span>
                <span className="chip">
                  {CABIN_LABEL[l.cabin] ?? l.cabin}
                </span>
                <span className="font-medium text-ink-soft">× {l.qty} 张</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="rating inline-flex items-center gap-1 font-mono tabular-nums">
                  <Icon name="clock" className="h-3.5 w-3.5" />
                  {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
                </span>
                <button
                  type="button"
                  disabled={releasingId === l.id}
                  onClick={() => release(l.id)}
                  className="rounded-lg border border-deal/40 bg-white px-2.5 py-1.5 text-xs font-medium text-deal transition hover:bg-deal-light disabled:opacity-50"
                >
                  {releasingId === l.id ? '释放中…' : '释放'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// WaitlistSection — 我的候补（售罄舱位登记，座位释放后按先来先到通知）。
// 后端 GET /waitlist/mine 只返回 ACTIVE/NOTIFIED（仍在跟进中的），
// 取消成功后客户端直接剔除该行；没有记录时整块不渲染。
// ─────────────────────────────────────────────────────────────────
const WAITLIST_STATUS_LABEL: Partial<Record<WaitlistStatus, string>> = {
  ACTIVE: '等待中',
  NOTIFIED: '已通知',
};
const WAITLIST_STATUS_CLASS: Partial<Record<WaitlistStatus, string>> = {
  ACTIVE: 'bg-slate-100 text-slate-600',
  NOTIFIED: 'bg-emerald-100 text-emerald-700',
};

function WaitlistSection({ token }: { token: string }) {
  const [entries, setEntries] = useState<MyWaitlistEntry[]>([]);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api
      .listMyWaitlist(token)
      .then((r) => setEntries(r.entries))
      .catch(() => undefined); // 候补加载失败不阻塞订单列表
  }, [token]);

  if (entries.length === 0) return null;

  const cancel = async (id: string) => {
    setCancellingId(id);
    setError(null);
    try {
      await api.cancelWaitlist(token, id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '取消失败');
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <section className="card space-y-2.5 border-brand-200 bg-brand-50/40">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-base font-bold text-ink">
          <Icon name="clock" className="h-4 w-4 text-brand-700" />我的候补
        </h2>
        <span className="text-xs font-medium text-brand-700">座位释放后按登记顺序通知，请保持手机畅通</span>
      </header>
      {error && <div className="text-sm font-medium text-deal">{error}</div>}
      <ul className="space-y-2">
        {entries.map((e) => (
          <li
            key={e.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-200/70 bg-surface px-3 py-2.5 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold text-ink">{e.flightNumber}</span>
              <span className="text-ink-muted">
                {new Date(e.departureTime).toLocaleString('zh-CN')}
              </span>
              <span className="chip">
                {CABIN_LABEL[e.cabin] ?? e.cabin}
              </span>
              <span className="font-medium text-ink-soft">× {e.qty} 张</span>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${WAITLIST_STATUS_CLASS[e.status] ?? 'bg-slate-100 text-slate-600'}`}
              >
                {WAITLIST_STATUS_LABEL[e.status] ?? e.status}
              </span>
              <button
                type="button"
                disabled={cancellingId === e.id}
                onClick={() => cancel(e.id)}
                className="rounded-lg border border-deal/40 bg-white px-2.5 py-1.5 text-xs font-medium text-deal transition hover:bg-deal-light disabled:opacity-50"
              >
                {cancellingId === e.id ? '取消中…' : '取消'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface CancelDialogProps {
  order: OrderSummary;
  quote: RefundQuote | null;
  loading: boolean;
  error: string | null;
  reason: string;
  onReasonChange: (v: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

function CancelDialog({
  order,
  quote,
  loading,
  error,
  reason,
  onReasonChange,
  onClose,
  onConfirm,
}: CancelDialogProps) {
  const lossPercent = useMemo(() => {
    if (!quote || quote.paidAmount === 0) return 0;
    return Math.round((quote.totalFee / quote.paidAmount) * 100);
  }, [quote]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-lg animate-fade-up flex-col rounded-3xl bg-surface shadow-pop">
        <header className="flex items-center justify-between border-b border-slate-200/80 px-5 py-4">
          <h2 className="section-title text-base">申请取消订单</h2>
          <button onClick={onClose} className="text-2xl leading-none text-ink-muted transition hover:text-ink">×</button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-5 text-sm">
          <div className="text-ink-soft">
            订单 <span className="font-mono font-semibold text-ink">{order.orderNumber}</span>
          </div>

          {loading && !quote && <div className="py-6 text-center text-ink-muted">计算退款…</div>}

          {error && (
            <div className="rounded-xl border border-deal/30 bg-deal-light px-3 py-2 font-medium text-deal-dark">
              {error}
            </div>
          )}

          {quote && !quote.cancellable && (
            <div className="rounded-xl border border-sun/40 bg-sun-light px-3 py-2.5 text-amber-800">
              <div className="font-semibold">不可取消</div>
              <div>{quote.cancellableReason ?? '当前订单状态不允许取消，请联系客服。'}</div>
            </div>
          )}

          {quote && quote.cancellable && (
            <>
              <div className="space-y-1.5 rounded-2xl bg-canvas p-4">
                <div className="flex justify-between">
                  <span className="text-ink-muted">已支付</span>
                  <span className="text-ink nums">¥{quote.paidAmount.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-deal">
                  <span>取消手续费 ({lossPercent}%)</span>
                  <span className="nums">− ¥{quote.totalFee.toLocaleString()}</span>
                </div>
                <div className="flex justify-between border-t border-slate-200/80 pt-1.5 font-bold text-brand-700">
                  <span>预计可退</span>
                  <span className="nums">¥{quote.totalRefund.toLocaleString()}</span>
                </div>
              </div>

              <details className="text-xs">
                <summary className="cursor-pointer font-medium text-ink-muted">分项明细</summary>
                <ul className="mt-2 space-y-1.5">
                  {quote.items.map((it) => (
                    <li key={it.itemId} className="rounded-xl border border-slate-100 bg-surface px-2.5 py-2">
                      <div className="flex justify-between">
                        <span className="inline-flex items-center gap-1.5 text-ink">
                          <KindIcon kind={it.kind} className="h-3.5 w-3.5 text-ink-muted" />
                          {it.description}
                        </span>
                        <span className="text-ink nums">¥{it.refundAmount.toLocaleString()}</span>
                      </div>
                      <div className="text-ink-muted">{it.reason}</div>
                    </li>
                  ))}
                </ul>
              </details>

              <div>
                <label className="label text-xs">取消原因（可选）</label>
                <textarea
                  value={reason}
                  onChange={(e) => onReasonChange(e.target.value)}
                  rows={2}
                  className="input w-full"
                  placeholder="临时改行程 / 不去了 / 时间冲突…"
                  maxLength={500}
                />
              </div>

              <div className="text-xs text-ink-muted">
                提交后订单进入"退款审核"，审核通过后 1-3 个工作日原路退回。
              </div>
            </>
          )}
        </div>

        <footer className="flex justify-end gap-2 rounded-b-3xl border-t border-slate-200/80 bg-canvas px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="btn-secondary"
          >
            再想想
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading || !quote || !quote.cancellable}
            className="btn-deal"
          >
            {loading ? '提交中…' : '确认申请取消'}
          </button>
        </footer>
      </div>
    </div>
  );
}
