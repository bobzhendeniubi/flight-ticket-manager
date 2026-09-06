/**
 * 我的订单 · 申请发票
 *
 * 此前客户想要发票只能「在下单备注里写一句或找客服」，谁申请过、开到哪一步全靠人记。
 * 这里给一个自助入口：挑自家订单、填抬头税号、提交，然后就能在同一块里看到进度。
 *
 * 归属闸在后端（只能挑自家订单，有一张不是就整批拒）；金额也由后端按订单应收算，
 * 前端连输入框都不给——发票金额不能由申请方说了算。
 *
 * 攒单开票是常态（一家公司几张单开一张票），所以订单是多选。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, type OrderStatus, type OrderSummary } from '../lib/api';
import {
  INVOICE_STATUS_CLASS,
  INVOICE_TYPES,
  INVOICE_TYPE_LABEL,
  invoicesApi,
  lockedOrderIds,
  type InvoiceRecord,
  type InvoiceType,
} from '../lib/invoicesApi';
import { formatDateTimeCn } from '../lib/datetime';
import { Icon } from './Icon';
import { Modal } from './Modal';

/**
 * 能开票的订单状态。没付过钱、或者钱已经退回去的单不该出现在勾选列表里——
 * 后端不按状态拦（它只认归属与应收），但让客户勾一张已取消的单再被拒是白折腾。
 */
const INVOICEABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'PAID',
  'PROCESSING',
  'TICKETED',
  'COMPLETED',
  'CHANGED',
  'CHANGE_REQUESTED',
]);

function fmtCny(n: number): string {
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface InvoiceRequestSectionProps {
  token: string;
  orders: OrderSummary[];
}

export function InvoiceRequestSection({ token, orders }: InvoiceRequestSectionProps) {
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await invoicesApi.list(token);
      setInvoices(r.invoices);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '加载发票失败');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const locked = useMemo(() => lockedOrderIds(invoices), [invoices]);
  const selectable = useMemo(() => orders.filter((o) => INVOICEABLE.has(o.status)), [orders]);
  const available = useMemo(
    () => selectable.filter((o) => !locked.has(o.id)),
    [selectable, locked],
  );

  // 一张能开的都没有、也一张都没申请过 —— 整块不显示，别在页面上放一个点了就说「没订单」的按钮
  if (!loading && invoices.length === 0 && selectable.length === 0) return null;

  return (
    <section className="card space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="section-title">发票</h2>
          <p className="section-sub">
            需要发票就在这里申请，开好了这里能看到票号。攒几张单开一张票也可以。
          </p>
        </div>
        <button
          type="button"
          className="btn-primary shrink-0 text-sm"
          disabled={available.length === 0}
          onClick={() => setAsking(true)}
          title={available.length === 0 ? '没有可以申请开票的订单' : undefined}
        >
          申请发票
        </button>
      </header>

      {err && (
        <div className="inline-flex items-center gap-1.5 rounded-xl border border-deal/30 bg-deal-light px-3 py-2 text-sm font-medium text-deal-dark">
          <Icon name="info" className="h-4 w-4 shrink-0" />
          {err}
        </div>
      )}

      {available.length === 0 && selectable.length > 0 && (
        <p className="text-xs text-ink-muted">
          现有订单都已经申请过发票了。要重开请联系客服作废原发票，作废后可以重新申请。
        </p>
      )}

      {loading && <p className="text-sm text-ink-muted">加载中…</p>}

      {!loading && invoices.length === 0 && (
        <p className="text-sm text-ink-muted">还没有申请过发票。</p>
      )}

      {invoices.map((inv) => (
        <article key={inv.id} className="rounded-xl border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-ink">{inv.title}</div>
              <div className="mt-0.5 text-xs text-ink-muted">
                {inv.typeLabel}
                {inv.taxNo ? ` · ${inv.taxNo}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-ink nums">{fmtCny(inv.amountCny)}</span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${INVOICE_STATUS_CLASS[inv.status]}`}
              >
                {inv.statusLabel}
              </span>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            <span className="font-mono">{inv.orders.map((o) => o.orderNumber).join('、')}</span>
            <span>申请于 {formatDateTimeCn(inv.createdAt)}</span>
            {inv.invoiceNo && (
              <span className="font-mono text-ink-soft">
                票号 {inv.invoiceNo}
                {inv.issuedAt ? ` · ${inv.issuedAt}` : ''}
              </span>
            )}
          </div>

          {inv.status === 'VOID' && inv.voidReason && (
            <p className="mt-1.5 text-xs text-ink-muted">作废原因：{inv.voidReason}</p>
          )}

          {inv.attachmentUrl && inv.status === 'ISSUED' && (
            <a
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-700 transition hover:text-brand-dark"
              href={inv.attachmentUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看发票 <Icon name="arrowRight" className="h-3.5 w-3.5" />
            </a>
          )}
        </article>
      ))}

      {asking && (
        <RequestInvoiceModal
          token={token}
          orders={available}
          onClose={() => setAsking(false)}
          onDone={async () => {
            setAsking(false);
            await load();
          }}
        />
      )}
    </section>
  );
}

function RequestInvoiceModal({
  token,
  orders,
  onClose,
  onDone,
}: {
  token: string;
  orders: OrderSummary[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [type, setType] = useState<InvoiceType>('VAT_GENERAL');
  const [title, setTitle] = useState('');
  const [taxNo, setTaxNo] = useState('');
  const [billingInfo, setBillingInfo] = useState('');
  const [requestNote, setRequestNote] = useState('');
  const [picked, setPicked] = useState<string[]>(() => (orders.length === 1 ? [orders[0].id] : []));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string): void => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // 只是给客户一个心里数：真正的开票金额由后端按应收（含调价）算，可能与这里略有出入
  const roughTotal = orders
    .filter((o) => picked.includes(o.id))
    .reduce((s, o) => s + Number(o.total), 0);

  const submit = async (): Promise<void> => {
    if (saving) return;
    if (picked.length === 0) {
      setErr('至少选一张订单');
      return;
    }
    if (!title.trim()) {
      setErr('发票抬头不能为空');
      return;
    }
    if (type === 'VAT_SPECIAL' && !taxNo.trim()) {
      setErr('增值税专用发票必须填纳税人识别号');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await invoicesApi.request(token, {
        orderIds: picked,
        title: title.trim(),
        taxNo: taxNo.trim() || null,
        billingInfo: billingInfo.trim() || null,
        type,
        requestNote: requestNote.trim() || null,
      });
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '申请失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="申请发票" size="lg">
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="fp-type">
            发票类型
          </label>
          <select
            id="fp-type"
            className="input"
            value={type}
            onChange={(e) => setType(e.target.value as InvoiceType)}
          >
            {INVOICE_TYPES.map((t) => (
              <option key={t} value={t}>
                {INVOICE_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="fp-title">
            发票抬头 *
          </label>
          <input
            id="fp-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="公司全称，或个人姓名"
          />
        </div>

        <div>
          <label className="label" htmlFor="fp-taxno">
            纳税人识别号{type === 'VAT_SPECIAL' ? ' *' : ''}
          </label>
          <input
            id="fp-taxno"
            className="input"
            value={taxNo}
            onChange={(e) => setTaxNo(e.target.value)}
            placeholder={type === 'VAT_SPECIAL' ? '专用发票必填' : '开公司抬头时填'}
          />
        </div>

        {type === 'VAT_SPECIAL' && (
          <div>
            <label className="label" htmlFor="fp-billing">
              开票信息
            </label>
            <textarea
              id="fp-billing"
              className="input min-h-[4.5rem]"
              value={billingInfo}
              onChange={(e) => setBillingInfo(e.target.value)}
              placeholder="注册地址、电话、开户行及账号"
            />
          </div>
        )}

        <div>
          <span className="label">选择订单 *</span>
          <p className="-mt-1 mb-2 text-xs text-ink-muted">
            可以多选，几张单合开一张票。已经申请过发票的订单不在这里。
          </p>
          <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-xl border border-slate-200 p-2">
            {orders.length === 0 && (
              <p className="px-1 py-3 text-center text-sm text-ink-muted">没有可申请的订单</p>
            )}
            {orders.map((o) => (
              <label
                key={o.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={picked.includes(o.id)}
                  onChange={() => toggle(o.id)}
                />
                <span className="flex-1 font-mono text-sm text-ink nums">{o.orderNumber}</span>
                <span className="text-sm text-ink-soft nums">{fmtCny(Number(o.total))}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="label" htmlFor="fp-note">
            备注
          </label>
          <input
            id="fp-note"
            className="input"
            value={requestNote}
            onChange={(e) => setRequestNote(e.target.value)}
            placeholder="如：发票请发到这个邮箱"
          />
        </div>

        <div className="flex items-start gap-1.5 rounded-xl bg-brand-50/70 px-3 py-2 text-xs text-ink-soft">
          <Icon name="info" className="h-4 w-4 shrink-0" />
          <span>
            已选 {picked.length} 张，订单金额约 {fmtCny(roughTotal)}。
            实际开票金额以订单应收为准，由我们核对后开具。
          </span>
        </div>

        {err && (
          <div className="rounded-xl border border-deal/30 bg-deal-light px-3 py-2 text-sm font-medium text-deal-dark">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void submit()}
            disabled={saving}
          >
            {saving ? '提交中…' : '提交申请'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
