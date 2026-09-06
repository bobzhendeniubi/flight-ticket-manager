/**
 * 应付账单详情弹窗：账单头、明细行、付款记录，以及登记 / 撤销付款。
 *
 * 两条口径在界面上必须说清楚，否则财务会按收款那套习惯来操作：
 *   · **核销按原币比**。欠 1000 美金就要付够 1000 美金，中间汇率怎么动都不改变「付清没有」；
 *     CNY 侧只是实付折人民币的记录（做现金流用，不做清偿判断）。
 *   · **状态分人工态与派生态**。草稿 / 已确认 / 有争议是人点的；部分付款 / 已付清由付款合计
 *     推导，界面不给按钮也改不动——撤销一笔付款状态会自动退回去。
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { businessTzParts } from '../../lib/datetime';
import {
  SUPPLIER_INVOICE_STATUS_TONE,
  SUPPLIER_PAY_METHODS,
  SUPPLIER_PAY_METHOD_LABEL,
  supplierPayablesApi,
  type SupplierInvoice,
  type SupplierPayMethod,
} from '../../lib/payablesApi';
import {
  canRegisterPayment,
  fmtCny,
  fmtMoney,
  payDisabledReason,
  payProgress,
  payProgressBarClass,
  payProgressLabel,
} from '../../lib/payablesView';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { NumberInput } from '../../components/NumberInput';
import { useConfirm } from '../../components/ConfirmDialog';

/** 北京业务日的 YYYY-MM-DD。别用 d.getFullYear() 手拼——那取的是浏览器时区。 */
function businessToday(): string {
  const p = businessTzParts(new Date());
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

export interface SupplierInvoiceDetailModalProps {
  token: string;
  invoiceId: string;
  onClose: () => void;
  /** 付款 / 改状态之后让列表重拉（合计卡片要跟着变） */
  onChanged: () => void | Promise<void>;
}

export function SupplierInvoiceDetailModal({
  token,
  invoiceId,
  onClose,
  onChanged,
}: SupplierInvoiceDetailModalProps) {
  const confirm = useConfirm();
  const [invoice, setInvoice] = useState<SupplierInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 付款表单
  const [paidOn, setPaidOn] = useState(businessToday);
  const [payAmount, setPayAmount] = useState<number | null>(null);
  const [payFxRate, setPayFxRate] = useState<number | null>(null);
  const [method, setMethod] = useState<SupplierPayMethod>('BANK');
  const [reference, setReference] = useState('');
  const [payerLabel, setPayerLabel] = useState('');
  const [payNote, setPayNote] = useState('');

  const load = useCallback(async (): Promise<void> => {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await supplierPayablesApi.getInvoice(token, invoiceId);
      setInvoice(r.invoice);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '加载账单失败');
    } finally {
      setLoading(false);
    }
  }, [token, invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    async (fn: () => Promise<{ invoice: SupplierInvoice }>): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setErr(null);
      try {
        const r = await fn();
        setInvoice(r.invoice);
        await onChanged();
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : '操作失败');
      } finally {
        setBusy(false);
      }
    },
    [busy, onChanged],
  );

  const isCny = invoice?.currency === 'CNY';
  const payable = invoice ? canRegisterPayment(invoice.status) : false;
  const disabledReason = invoice ? payDisabledReason(invoice.status) : null;

  const submitPayment = async (): Promise<void> => {
    if (!invoice) return;
    if (payAmount == null || payAmount <= 0) {
      setErr('付款金额必须大于 0');
      return;
    }
    await apply(() =>
      supplierPayablesApi.addPayment(token, invoice.id, {
        paidOn,
        amount: payAmount,
        fxRate: isCny ? null : payFxRate,
        method,
        reference: reference.trim() || null,
        payerLabel: payerLabel.trim() || null,
        note: payNote.trim() || null,
      }),
    );
    setPayAmount(null);
    setReference('');
    setPayNote('');
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="应付账单详情"
      size="xl"
      footer={
        <div className="flex justify-end">
          <button type="button" className="btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      }
    >
      {loading && <div className="py-8 text-center text-ink-muted">加载中…</div>}
      {err && (
        <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>
      )}

      {invoice && (
        <div className="space-y-4">
          <header className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-ink">
                  {invoice.supplierName}
                  <span className="ml-2 text-xs font-normal text-ink-muted">
                    {invoice.supplierTypeLabel}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-ink-soft">
                  {invoice.periodKindLabel} · {invoice.periodLabel}
                  {invoice.invoiceNo ? ` · 账单号 ${invoice.invoiceNo}` : ''}
                </div>
              </div>
              <span className={SUPPLIER_INVOICE_STATUS_TONE[invoice.status]}>
                {invoice.statusLabel}
              </span>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Figure
                label="账单金额"
                value={fmtMoney(invoice.amount, invoice.currency)}
                sub={fmtCny(invoice.amountCny)}
              />
              <Figure
                label="已付"
                value={fmtMoney(invoice.paidAmount, invoice.currency)}
                sub={`实付折人民币 ${fmtCny(invoice.paidAmountCny)}`}
              />
              <Figure
                label="未付"
                value={fmtMoney(invoice.outstandingAmount, invoice.currency)}
                sub={invoice.outstandingAmount > 0 ? '还欠这么多' : '已结清'}
                tone={invoice.outstandingAmount > 0 ? 'warn' : 'ok'}
              />
            </div>

            <div className="mt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className={`h-full ${payProgressBarClass(invoice.paidAmount, invoice.amount)}`}
                  style={{ width: `${payProgress(invoice.paidAmount, invoice.amount) * 100}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-ink-muted nums">
                核销进度 {payProgressLabel(invoice.paidAmount, invoice.amount, invoice.currency)}
                {!isCny && ' · 按原币比，汇率涨跌不改变「付清没有」'}
              </p>
            </div>

            {invoice.note && <p className="mt-2 text-xs text-ink-soft">备注：{invoice.note}</p>}
          </header>

          {/* 人工态切换。派生态（部分付款 / 已付清）不给按钮——那是付款合计说了算的。 */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-muted">状态：</span>
            {invoice.status === 'DRAFT' && (
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={busy}
                onClick={() =>
                  void apply(() =>
                    supplierPayablesApi.updateInvoice(token, invoice.id, { status: 'CONFIRMED' }),
                  )
                }
              >
                确认账单（之后才能付款）
              </button>
            )}
            {(invoice.status === 'CONFIRMED' || invoice.status === 'DISPUTED') && (
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={busy}
                onClick={() =>
                  void apply(() =>
                    supplierPayablesApi.updateInvoice(token, invoice.id, {
                      status: invoice.status === 'DISPUTED' ? 'CONFIRMED' : 'DISPUTED',
                    }),
                  )
                }
              >
                {invoice.status === 'DISPUTED' ? '消除争议，改回已确认' : '标记有争议（挂起不付）'}
              </button>
            )}
            {invoice.attachmentUrl && (
              <a
                className="btn-ghost text-xs"
                href={invoice.attachmentUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="file" /> 看账单附件
              </a>
            )}
          </div>

          {/* 明细行（建单时录了才有） */}
          {invoice.lines.length > 0 && (
            <section>
              <h3 className="section-title mb-1.5">账单明细</h3>
              <div className="overflow-x-auto">
                <table className="table-admin">
                  <thead>
                    <tr>
                      <th>项目</th>
                      <th className="text-right">数量</th>
                      <th className="text-right">金额</th>
                      <th className="text-right">折人民币</th>
                      <th>备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.lines.map((l) => (
                      <tr key={l.id}>
                        <td>{l.label}</td>
                        <td className="text-right nums">{l.quantity ?? '—'}</td>
                        <td className="text-right nums">{fmtMoney(l.amount, invoice.currency)}</td>
                        <td className="text-right nums">{fmtCny(l.amountCny)}</td>
                        <td className="text-xs text-ink-muted">{l.note ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* 付款记录 */}
          <section>
            <h3 className="section-title mb-1.5">付款记录</h3>
            <div className="overflow-x-auto">
              <table className="table-admin">
                <thead>
                  <tr>
                    <th>付款日</th>
                    <th className="text-right">金额</th>
                    <th className="text-right">汇率</th>
                    <th className="text-right">折人民币</th>
                    <th>渠道</th>
                    <th>流水号</th>
                    <th>付款人</th>
                    <th className="text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.payments.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-6 text-center text-ink-muted">
                        还没付过款
                      </td>
                    </tr>
                  )}
                  {invoice.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="nums">{p.paidOn}</td>
                      <td className="text-right nums">{fmtMoney(p.amount, invoice.currency)}</td>
                      <td className="text-right nums">{p.fxRate ?? '—'}</td>
                      <td className="text-right nums">{fmtCny(p.amountCny)}</td>
                      <td>{p.methodLabel}</td>
                      <td className="font-mono text-xs">{p.reference ?? '—'}</td>
                      <td className="text-xs">{p.payerLabel ?? '—'}</td>
                      <td className="text-right">
                        <button
                          type="button"
                          className="btn-ghost-danger text-xs"
                          disabled={busy}
                          onClick={() => {
                            void (async () => {
                              const ok = await confirm({
                                title: '撤销这笔付款？',
                                body: '只在「这笔付款录错了」时撤销——钱真打出去了就别撤。撤销后账单状态会自动退回（已付清 → 部分付款 / 已确认）。',
                                confirmText: '确认撤销',
                                tone: 'danger',
                              });
                              if (!ok) return;
                              await apply(() =>
                                supplierPayablesApi.deletePayment(token, invoice.id, p.id),
                              );
                            })();
                          }}
                        >
                          撤销
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 登记付款 */}
          <section className="rounded-lg border border-slate-200 p-3">
            <h3 className="section-title mb-2">登记付款</h3>
            {disabledReason ? (
              <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <Icon name="alert" />
                <span>{disabledReason}</span>
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <label className="label" htmlFor="pay-on">
                      付款日 *
                    </label>
                    <input
                      id="pay-on"
                      type="date"
                      className="input"
                      value={paidOn}
                      onChange={(e) => setPaidOn(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="pay-amount">
                      付款金额（{invoice.currency}）*
                    </label>
                    <NumberInput id="pay-amount" value={payAmount} onChange={setPayAmount} min={0} />
                    <p className="mt-1 text-xs text-ink-muted nums">
                      还欠 {fmtMoney(invoice.outstandingAmount, invoice.currency)}；付超会被拒。
                    </p>
                  </div>
                  <div>
                    <label className="label" htmlFor="pay-fx">
                      当日汇率
                    </label>
                    <NumberInput
                      id="pay-fx"
                      value={payFxRate}
                      onChange={setPayFxRate}
                      min={0}
                      disabled={isCny}
                      placeholder={isCny ? '人民币不填' : '这一笔的汇率'}
                    />
                  </div>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div>
                    <label className="label" htmlFor="pay-method">
                      付款渠道 *
                    </label>
                    <select
                      id="pay-method"
                      className="input"
                      value={method}
                      onChange={(e) => setMethod(e.target.value as SupplierPayMethod)}
                    >
                      {SUPPLIER_PAY_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {SUPPLIER_PAY_METHOD_LABEL[m]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="pay-ref">
                      流水号
                    </label>
                    <input
                      id="pay-ref"
                      className="input"
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      placeholder="银行回单号 / 支付单号"
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="pay-payer">
                      付款人 / 付款账户
                    </label>
                    <input
                      id="pay-payer"
                      className="input"
                      value={payerLabel}
                      onChange={(e) => setPayerLabel(e.target.value)}
                      placeholder="哪个账户付的"
                    />
                  </div>
                </div>

                <div className="mt-3">
                  <label className="label" htmlFor="pay-note">
                    备注
                  </label>
                  <input
                    id="pay-note"
                    className="input"
                    value={payNote}
                    onChange={(e) => setPayNote(e.target.value)}
                    placeholder="如：分两笔付，本条为第一笔"
                  />
                </div>

                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    className="btn-primary text-xs"
                    disabled={busy || !payable}
                    onClick={() => void submitPayment()}
                  >
                    {busy ? '登记中…' : '登记这笔付款'}
                  </button>
                </div>
              </>
            )}
          </section>

          <p className="text-xs text-ink-muted">
            核销状态（部分付款 / 已付清）由付款合计自动推导，不能手工点。撤销一笔付款状态会跟着退回去——
            账要能退，否则一次手滑就永久假装付清了。
          </p>
        </div>
      )}
    </Modal>
  );
}

function Figure({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'warn' | 'ok';
}) {
  return (
    <div>
      <p className="text-xs text-ink-muted">{label}</p>
      <p
        className={`mt-0.5 text-lg font-semibold nums ${
          tone === 'warn' ? 'text-amber-700' : tone === 'ok' ? 'text-emerald-700' : 'text-ink'
        }`}
      >
        {value}
      </p>
      <p className="text-xs text-ink-muted nums">{sub}</p>
    </div>
  );
}
