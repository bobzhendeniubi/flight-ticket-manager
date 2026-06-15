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
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type MySeatLock,
  type MyWaitlistEntry,
  type OrderSummary,
  type OrderStatus,
  type RefundQuote,
  type WaitlistStatus,
} from '../lib/api';
import { CABIN_LABEL } from '../lib/airports';
import { useAuth } from '../stores/auth';
import { Icon, type IconName } from '../components/Icon';

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

const CANCELLABLE = new Set<OrderStatus>(['PAID', 'PROCESSING', 'TICKETED']);

export function MyOrdersPage() {
  const { tokens } = useAuth();
  const token = tokens?.accessToken ?? '';
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api
      .listOrders(token)
      .then((r) => setOrders(r.orders))
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
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
          <Icon name="user" className="h-9 w-9" />
        </div>
        <p className="mt-4 text-base font-semibold text-ink">请先登录</p>
        <p className="mt-1 text-sm text-ink-muted">登录后即可查看订单、锁位与候补</p>
        <Link to="/login?redirect=/orders" className="btn-primary mt-5 inline-flex items-center gap-1.5">
          去登录 <Icon name="arrowRight" className="h-4 w-4" />
        </Link>
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
        // 展开后用 detail（详情拉到的完整 passenger）；详情没拿到时 fallback 到列表
        const detail = detailCache[o.id] ?? o;
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
                  ¥{Number(o.total).toLocaleString()}
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

            <footer className="flex items-center justify-between border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => toggleExpand(o)}
                className="text-sm font-medium text-brand-700 transition hover:text-brand-dark"
              >
                {expanded ? '收起 ↑' : '查看详情 →'}
              </button>
              {cancellable && (
                <button
                  type="button"
                  onClick={() => startCancel(o)}
                  className="rounded-lg border border-deal/40 bg-white px-3 py-1.5 text-sm font-medium text-deal transition hover:bg-deal-light"
                >
                  申请取消
                </button>
              )}
            </footer>

            {expanded && (
              <div className="animate-fade-in space-y-3 border-t border-slate-100 pt-3 text-sm">
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
                    {o.items.map((it) => (
                      <li key={it.id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-surface px-3 py-2.5">
                        <div className="inline-flex items-center gap-1.5 text-ink">
                          <KindIcon kind={it.kind} className="h-4 w-4 text-ink-muted" />
                          {it.description}
                          {it.quantity > 1 && <span className="text-ink-muted"> × {it.quantity}</span>}
                        </div>
                        <div className="font-semibold text-ink nums">
                          ¥{Number(it.amount).toLocaleString()}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* 出行人（用 detail，因为列表只 select fullName，没有 documentType/Number） */}
                {detail.passengers.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-muted">出行人</div>
                    <ul className="space-y-1">
                      {detail.passengers.map((p) => (
                        <li key={p.id} className="text-ink-soft">
                          <span className="font-medium text-ink">{p.fullName}</span>
                          {p.documentNumber && (
                            <>
                              {' · '}
                              {p.documentType === 'PASSPORT' ? '护照' : p.documentType ?? '证件'} {p.documentNumber}
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
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
