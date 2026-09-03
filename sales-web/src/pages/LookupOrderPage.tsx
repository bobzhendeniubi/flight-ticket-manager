/**
 * 公开查单页（A4）。
 *
 * 无需登录：凭「订单号 + 手机号或邮箱」查询脱敏订单状态。
 * 对标 Klook/携程「查订单」：表单 → api.lookupOrder → 卡片展示状态/项目/出行日期/合计/脱敏出行人。
 * 命中 404 走友好的"未找到"态；其它异常走通用错误文案。
 */
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type MaskedOrder, type OrderStatus, type OrderItemKind } from '../lib/api';
import { Seo } from '../components/Seo';
import { Breadcrumb } from '../components/Breadcrumb';
import { PaymentPanel } from '../components/PaymentPanel';
import { Icon, type IconName } from '../components/Icon';
import { formatDateCn, formatPlainDate } from '../lib/datetime';
import { legStatusNote } from '../lib/legStatus';

// 订单状态中文标签（与 MyOrdersPage 保持一致）
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

const KIND_ICON: Record<string, IconName> = {
  FLIGHT: 'plane',
  HOTEL: 'hotel',
  TRANSFER: 'car',
  VISA: 'visa',
  INSURANCE: 'shield',
  FEE: 'info',
  DISCOUNT: 'ticket',
};

function kindIcon(kind: OrderItemKind | string): IconName {
  return KIND_ICON[kind] ?? 'package';
}

/** 金额渲染兜底：非法数值显示 '0' 而不是 NaN */
function fmt(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

/**
 * 出行日期格式化（null/非法时显示 '—'）。
 *
 * travelDate 是后端已折算好的纯日期串（酒店入住日按 @db.Date 切、航班出发日按出发地时区折），
 * 不能再交给 new Date(...).toLocaleDateString() 按设备时区渲染 —— 那会把 '2026-08-26'
 * 当成 UTC 午夜，在负时区设备（如美西 UTC−7）上整单出行日集体早一天。
 */
const fmtTravelDate = (iso: string | null) => formatPlainDate(iso);

type QueryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  // lookupKey = 命中时用的手机号/邮箱，原样传给收款面板做上传凭证的校验凭据
  | { kind: 'found'; order: MaskedOrder; lookupKey: string }
  | { kind: 'notFound' }
  | { kind: 'error'; message: string };

export default function LookupOrderPage() {
  const [orderNumber, setOrderNumber] = useState('');
  const [contact, setContact] = useState('');
  const [state, setState] = useState<QueryState>({ kind: 'idle' });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedOrder = orderNumber.trim();
    const trimmedContact = contact.trim();
    if (!trimmedOrder || !trimmedContact) {
      setState({ kind: 'error', message: '请填写订单号和手机号或邮箱' });
      return;
    }

    // 联系方式二选一：含 @ 视为邮箱，否则当手机号
    const isEmail = trimmedContact.includes('@');
    setState({ kind: 'loading' });
    try {
      const { order } = await api.lookupOrder({
        orderNumber: trimmedOrder,
        ...(isEmail ? { email: trimmedContact } : { phone: trimmedContact }),
      });
      setState({ kind: 'found', order, lookupKey: trimmedContact });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setState({ kind: 'notFound' });
      } else {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : '查询失败，请稍后再试',
        });
      }
    }
  };

  return (
    <main className="mx-auto max-w-3xl space-y-5">
      <Seo
        title="查询订单"
        description="无需登录，凭订单号 + 手机号或邮箱查询订单状态。"
        canonicalPath="/lookup"
      />

      <Breadcrumb items={[{ label: '首页', to: '/' }, { label: '查订单' }]} />

      <section className="animate-fade-up">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">查订单</h1>
        <p className="section-sub">
          无需登录，凭「订单号 + 下单手机号或邮箱」即可查看订单状态与进度。
        </p>
      </section>

      {/* 查询表单 */}
      <form onSubmit={onSubmit} className="card space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="lookup-order">订单号 *</label>
            <input
              id="lookup-order"
              className="input"
              required
              autoComplete="off"
              placeholder="如 CT2406140001"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="lookup-contact">手机号或邮箱 *</label>
            <input
              id="lookup-contact"
              className="input"
              required
              inputMode="text"
              placeholder="下单时填写的手机号或邮箱"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-muted">
            手机号或邮箱需与下单时一致；信息已脱敏展示，保护隐私。
          </p>
          <button
            type="submit"
            className="btn-primary inline-flex items-center gap-1.5"
            disabled={state.kind === 'loading'}
          >
            {state.kind === 'loading' ? '查询中…' : '查询订单'}
            {state.kind !== 'loading' && <Icon name="search" className="h-4 w-4" />}
          </button>
        </div>
      </form>

      {/* 错误态 */}
      {state.kind === 'error' && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-2xl border border-deal/30 bg-deal-light px-4 py-3 text-sm font-medium text-deal-dark"
        >
          <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{state.message}</span>
        </div>
      )}

      {/* 未找到态 */}
      {state.kind === 'notFound' && (
        <div className="card animate-fade-up py-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand">
            <Icon name="search" className="h-7 w-7" />
          </div>
          <p className="mt-3 text-base font-bold text-ink">未找到匹配的订单</p>
          <p className="mt-1 text-sm text-ink-soft">
            请核对订单号与联系方式（手机号或邮箱需与下单时一致）后重试。
          </p>
          <Link to="/help" className="btn-secondary mt-4 inline-flex">
            联系客服协助
          </Link>
        </div>
      )}

      {/* 命中态：脱敏订单卡片（未支付时附「收款方式 + 上传凭证」） */}
      {state.kind === 'found' && (
        <>
          <MaskedOrderCard order={state.order} />
          {state.order.status === 'PENDING_PAYMENT' && (
            <PaymentPanel
              orderNo={state.order.orderNumber}
              lookupKey={state.lookupKey}
              amountDueCny={Number(state.order.total) || 0}
              variant="detail"
            />
          )}
        </>
      )}

      {/* 底部回链 */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-2 text-sm">
        <Link to="/" className="font-medium text-brand-700 transition hover:text-brand-dark">
          ← 返回首页
        </Link>
        <Link to="/help" className="font-medium text-ink-muted transition hover:text-brand-700">
          需要帮助？
        </Link>
      </div>
    </main>
  );
}

function MaskedOrderCard({ order }: { order: MaskedOrder }) {
  const statusClass = STATUS_CLASS[order.status] ?? 'bg-slate-100 text-slate-600';
  const statusLabel = STATUS_LABEL[order.status] ?? order.status;

  return (
    <article className="card animate-fade-up space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-sm font-semibold text-ink nums">{order.orderNumber}</span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusClass}`}>
            {statusLabel}
          </span>
        </div>
        <div className="text-right">
          <div className="price text-lg">¥{fmt(order.total)}</div>
          <div className="text-xs text-ink-muted">
            下单于 {formatDateCn(order.createdAt)}
          </div>
        </div>
      </header>

      {/* 项目明细 */}
      <div>
        <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-muted">项目明细</div>
        <ul className="space-y-1.5">
          {order.items.map((it, idx) => {
            // 航段行的说明（回程待重新安排 / 已取消…）—— 未登机不再多说一句（见 lib/legStatus）。
            const legNote = legStatusNote(it.publicLegStatus);
            return (
            <li
              key={`${it.productName}-${idx}`}
              className="rounded-xl border border-slate-100 bg-surface px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex min-w-0 items-center gap-1.5 text-ink">
                  <Icon name={kindIcon(it.kind)} className="h-4 w-4 shrink-0 text-ink-muted" />
                  <span className="truncate">{it.productName}</span>
                  {it.quantity > 1 && <span className="shrink-0 text-ink-muted"> × {it.quantity}</span>}
                  {it.flightChanged && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-600">
                      航变
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {/* 出行日期：航段行暂无班次时留「—」，不让这一行变成光杆名字 */}
                  {(it.travelDate || it.kind === 'FLIGHT') && (
                    <span className="inline-flex items-center gap-1 text-xs text-ink-soft">
                      <Icon name="calendar" className="h-3.5 w-3.5" />{' '}
                      {it.travelDate ? fmtTravelDate(it.travelDate) : '—'}
                    </span>
                  )}
                  <span className="font-semibold text-ink nums">¥{fmt(it.amount)}</span>
                </div>
              </div>
              {it.flightChanged && (
                <div className="mt-1.5 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs leading-relaxed text-rose-700">
                  航班有调整，请留意新的起飞时间
                  {it.travelDate && <>：<span className="font-semibold">{fmtTravelDate(it.travelDate)}</span></>}
                </div>
              )}
              {legNote && (
                <div className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-sun-light px-2.5 py-1 text-xs font-medium text-amber-800">
                  <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
                  {legNote}
                </div>
              )}
            </li>
            );
          })}
        </ul>
      </div>

      {/* 脱敏出行人 */}
      {order.passengers.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-muted">出行人</div>
          <ul className="flex flex-wrap gap-2">
            {order.passengers.map((p, idx) => (
              <li
                key={`${p.name}-${idx}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-sm text-ink"
              >
                <Icon name="user" className="h-3.5 w-3.5 text-ink-muted" />
                {p.name}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="rounded-xl bg-canvas px-3 py-2.5 text-xs text-ink-muted">
        以上信息已脱敏展示。如需修改订单或了解付款进度，请联系客服并提供订单号。
      </p>
    </article>
  );
}
