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
  PROCESSING: 'bg-sky-100 text-sky-700',
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

const KIND_EMOJI: Record<string, string> = {
  FLIGHT: '✈️',
  HOTEL: '🏨',
  TRANSFER: '🚗',
  VISA: '🛂',
  INSURANCE: '🛡️',
  FEE: '💰',
  DISCOUNT: '🎟️',
};

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
      <div className="card text-center py-16">
        <p className="text-slate-600">请先登录</p>
        <Link to="/login?redirect=/orders" className="btn-primary mt-3 inline-block">
          去登录
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">我的订单</h1>
          <p className="text-sm text-slate-500">
            一共 {orders.length} 笔订单。可取消的订单点"申请取消"看退款明细。
          </p>
        </div>
        <Link to="/" className="text-sm text-blue-600 hover:underline">
          ← 继续逛
        </Link>
      </header>

      {/* 我的锁位 — 有 ACTIVE 锁位才显示，挂在订单列表上方 */}
      <SeatLocksSection token={token} />

      {/* 我的候补 — 有候补记录才显示，挂在锁位下方 */}
      <WaitlistSection token={token} />

      {loading && <div className="card text-center py-8 text-slate-500">加载中…</div>}
      {error && <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700">{error}</div>}

      {!loading && !error && orders.length === 0 && (
        <div className="card text-center py-12">
          <div className="text-3xl mb-2">🎒</div>
          <p className="text-slate-600 mb-3">还没有订单</p>
          <Link to="/" className="btn-primary inline-block">
            去看看机票
          </Link>
        </div>
      )}

      {orders.map((o) => {
        const expanded = expandedId === o.id;
        const cancellable = CANCELLABLE.has(o.status);
        // 展开后用 detail（详情拉到的完整 passenger）；详情没拿到时 fallback 到列表
        const detail = detailCache[o.id] ?? o;
        return (
          <article key={o.id} className="card space-y-2">
            <header className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm text-slate-700">{o.orderNumber}</span>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[o.status]}`}
                >
                  {STATUS_LABEL[o.status]}
                </span>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold text-red-600">
                  ¥{Number(o.total).toLocaleString()}
                </div>
                <div className="text-xs text-slate-500">
                  {new Date(o.createdAt).toLocaleString('zh-CN')}
                </div>
              </div>
            </header>

            <div className="text-sm text-slate-600">
              {o.items.slice(0, 3).map((it, i) => (
                <span key={it.id} className="mr-3 inline-block">
                  {KIND_EMOJI[it.kind] ?? '📦'} {it.description}
                  {i < Math.min(2, o.items.length - 1) && ' ·'}
                </span>
              ))}
              {o.items.length > 3 && <span className="text-slate-400">…等 {o.items.length} 项</span>}
            </div>

            <footer className="flex items-center justify-between border-t border-slate-100 pt-2">
              <button
                type="button"
                onClick={() => toggleExpand(o)}
                className="text-sm text-blue-600 hover:underline"
              >
                {expanded ? '收起' : '查看详情'}
              </button>
              {cancellable && (
                <button
                  type="button"
                  onClick={() => startCancel(o)}
                  className="text-sm rounded-md border border-rose-300 bg-white px-3 py-1 text-rose-700 hover:bg-rose-50"
                >
                  申请取消
                </button>
              )}
            </footer>

            {expanded && (
              <div className="space-y-3 border-t border-slate-100 pt-3 text-sm">
                {/* 联系人 */}
                <div className="rounded-md bg-slate-50 p-3">
                  <div className="text-xs font-semibold text-slate-500 mb-1">联系人</div>
                  <div>{o.contactName} · {o.contactPhone}</div>
                  {o.contactEmail && <div className="text-slate-500">{o.contactEmail}</div>}
                </div>

                {/* 项目明细 */}
                <div>
                  <div className="text-xs font-semibold text-slate-500 mb-1">项目明细</div>
                  <ul className="space-y-1.5">
                    {o.items.map((it) => (
                      <li key={it.id} className="flex items-center justify-between rounded-md bg-white border border-slate-100 px-3 py-2">
                        <div>
                          <span className="mr-1">{KIND_EMOJI[it.kind] ?? '📦'}</span>
                          {it.description}
                          {it.quantity > 1 && <span className="text-slate-400"> × {it.quantity}</span>}
                        </div>
                        <div className="font-medium text-slate-700">
                          ¥{Number(it.amount).toLocaleString()}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* 出行人（用 detail，因为列表只 select fullName，没有 documentType/Number） */}
                {detail.passengers.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-slate-500 mb-1">出行人</div>
                    <ul className="space-y-1">
                      {detail.passengers.map((p) => (
                        <li key={p.id} className="text-slate-700">
                          {p.fullName}
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
    <section className="card space-y-2 border-amber-200 bg-amber-50/50">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-900">🔒 我的锁位</h2>
        <span className="text-xs text-amber-700">锁定有效期内完成下单即自动使用该锁位</span>
      </header>
      {error && <div className="text-sm text-rose-700">{error}</div>}
      <ul className="space-y-1.5">
        {active.map((l) => {
          const leftMs = Math.max(0, new Date(l.expiresAt).getTime() - now);
          const mm = Math.floor(leftMs / 60000);
          const ss = Math.floor((leftMs % 60000) / 1000);
          return (
            <li
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-100 bg-white px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold text-slate-800">{l.flightNumber}</span>
                <span className="text-slate-500">
                  {new Date(l.departureTime).toLocaleString('zh-CN')}
                </span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                  {CABIN_LABEL[l.cabin] ?? l.cabin}
                </span>
                <span className="text-slate-700">× {l.qty} 张</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono tabular-nums text-amber-700">
                  ⏱ {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
                </span>
                <button
                  type="button"
                  disabled={releasingId === l.id}
                  onClick={() => release(l.id)}
                  className="rounded-md border border-rose-300 bg-white px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
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
    <section className="card space-y-2 border-sky-200 bg-sky-50/50">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-900">🕐 我的候补</h2>
        <span className="text-xs text-sky-700">座位释放后按登记顺序通知，请保持手机畅通</span>
      </header>
      {error && <div className="text-sm text-rose-700">{error}</div>}
      <ul className="space-y-1.5">
        {entries.map((e) => (
          <li
            key={e.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-100 bg-white px-3 py-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold text-slate-800">{e.flightNumber}</span>
              <span className="text-slate-500">
                {new Date(e.departureTime).toLocaleString('zh-CN')}
              </span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                {CABIN_LABEL[e.cabin] ?? e.cabin}
              </span>
              <span className="text-slate-700">× {e.qty} 张</span>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${WAITLIST_STATUS_CLASS[e.status] ?? 'bg-slate-100 text-slate-600'}`}
              >
                {WAITLIST_STATUS_LABEL[e.status] ?? e.status}
              </span>
              <button
                type="button"
                disabled={cancellingId === e.id}
                onClick={() => cancel(e.id)}
                className="rounded-md border border-rose-300 bg-white px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
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
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-lg shadow-xl flex flex-col max-h-[90vh]">
        <header className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="font-semibold">申请取消订单</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
          <div className="text-slate-600">
            订单 <span className="font-mono">{order.orderNumber}</span>
          </div>

          {loading && !quote && <div className="text-center py-6 text-slate-500">计算退款…</div>}

          {error && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
              {error}
            </div>
          )}

          {quote && !quote.cancellable && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
              <div className="font-semibold">不可取消</div>
              <div>{quote.cancellableReason ?? '当前订单状态不允许取消，请联系客服。'}</div>
            </div>
          )}

          {quote && quote.cancellable && (
            <>
              <div className="rounded-md bg-slate-50 p-3 space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">已支付</span>
                  <span>¥{quote.paidAmount.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-rose-700">
                  <span>取消手续费 ({lossPercent}%)</span>
                  <span>− ¥{quote.totalFee.toLocaleString()}</span>
                </div>
                <div className="flex justify-between font-semibold text-emerald-700 border-t border-slate-200 pt-1">
                  <span>预计可退</span>
                  <span>¥{quote.totalRefund.toLocaleString()}</span>
                </div>
              </div>

              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500">分项明细</summary>
                <ul className="mt-2 space-y-1.5">
                  {quote.items.map((it) => (
                    <li key={it.itemId} className="rounded bg-white border border-slate-100 px-2 py-1.5">
                      <div className="flex justify-between">
                        <span className="text-slate-700">{KIND_EMOJI[it.kind] ?? '📦'} {it.description}</span>
                        <span className="text-slate-700">¥{it.refundAmount.toLocaleString()}</span>
                      </div>
                      <div className="text-slate-400">{it.reason}</div>
                    </li>
                  ))}
                </ul>
              </details>

              <div>
                <label className="text-xs text-slate-500 mb-1 block">取消原因（可选）</label>
                <textarea
                  value={reason}
                  onChange={(e) => onReasonChange(e.target.value)}
                  rows={2}
                  className="input w-full"
                  placeholder="临时改行程 / 不去了 / 时间冲突…"
                  maxLength={500}
                />
              </div>

              <div className="text-xs text-slate-400">
                提交后订单进入"退款审核"，审核通过后 1-3 个工作日原路退回。
              </div>
            </>
          )}
        </div>

        <footer className="flex justify-end gap-2 px-4 py-3 border-t bg-slate-50 rounded-b-lg">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-sm border border-slate-300 rounded-md hover:bg-white"
          >
            再想想
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading || !quote || !quote.cancellable}
            className="px-4 py-2 text-sm bg-rose-600 text-white rounded-md hover:bg-rose-700 disabled:bg-slate-300"
          >
            {loading ? '提交中…' : '确认申请取消'}
          </button>
        </footer>
      </div>
    </div>
  );
}
