/**
 * 应付账单的两个弹窗：新建账单、账单详情（含付款登记 / 撤销）。
 *
 * 两条口径在界面上必须说清楚，否则财务会按收款那套习惯来操作：
 *   · **核销按原币比**。欠 1000 美金就要付够 1000 美金，中间汇率怎么动都不改变「付清没有」；
 *     CNY 侧只是实付折人民币的记录（做现金流用，不做清偿判断）。
 *   · **状态分人工态与派生态**。草稿 / 已确认 / 有争议是人点的；部分付款 / 已付清由付款合计
 *     推导，点不了也改不动——撤销一笔付款状态会自动退回去。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FinanceScheduleRow } from '../../lib/api';
import { businessTzParts } from '../../lib/datetime';
import { formatLocalTime } from '../../lib/airports';
import {
  SUPPLIER_INVOICE_STATUS_TONE,
  SUPPLIER_PAY_METHODS,
  SUPPLIER_PAY_METHOD_LABEL,
  supplierPayablesApi,
  type Supplier,
  type SupplierInvoice,
  type SupplierInvoiceCreateInput,
  type SupplierInvoicePeriodKind,
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

function businessThisMonth(): string {
  const p = businessTzParts(new Date());
  return p ? `${p.year}-${p.month}` : '';
}

const PERIOD_KINDS: Array<{ value: SupplierInvoicePeriodKind; label: string; hint: string }> = [
  { value: 'FLIGHT_SCHEDULE', label: '按航班班次', hint: '包机款一班一结，选班次最准' },
  { value: 'MONTH', label: '按月', hint: '酒店 / 签证公司的月结账单' },
  { value: 'CUSTOM', label: '自定义区间', hint: '半月结、跨月批次等' },
];

// ── 新建账单 ─────────────────────────────────────────────────────────────────

export interface SupplierInvoiceCreateModalProps {
  token: string;
  suppliers: Supplier[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

export function SupplierInvoiceCreateModal({
  token,
  suppliers,
  onClose,
  onDone,
}: SupplierInvoiceCreateModalProps) {
  const active = suppliers.filter((s) => s.isActive);
  const [supplierId, setSupplierId] = useState(active[0]?.id ?? '');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [periodKind, setPeriodKind] = useState<SupplierInvoicePeriodKind>('MONTH');
  const [flightScheduleId, setFlightScheduleId] = useState('');
  const [periodMonth, setPeriodMonth] = useState(businessThisMonth);
  const [periodFrom, setPeriodFrom] = useState(businessToday);
  const [periodTo, setPeriodTo] = useState(businessToday);
  const [currency, setCurrency] = useState(active[0]?.currency ?? 'CNY');
  const [amount, setAmount] = useState<number | null>(null);
  const [fxRate, setFxRate] = useState<number | null>(null);
  const [status, setStatus] = useState<'DRAFT' | 'CONFIRMED'>('DRAFT');
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [schedules, setSchedules] = useState<FinanceScheduleRow[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);

  // 选供应商时把币种带过来（单张账单仍可另填 —— 同一家偶尔开美金账单是真事）
  const onPickSupplier = (id: string): void => {
    setSupplierId(id);
    const s = suppliers.find((x) => x.id === id);
    if (s) setCurrency(s.currency);
  };

  // 班次列表只在真选「按班次」时才拉，别为一个用不上的下拉每次打开弹窗都发请求
  useEffect(() => {
    if (periodKind !== 'FLIGHT_SCHEDULE' || !token || schedules.length > 0) return;
    let cancelled = false;
    setSchedulesLoading(true);
    api
      .listFinanceSchedules(token)
      .then((r) => {
        if (!cancelled) setSchedules(r.schedules);
      })
      .catch(() => {
        if (!cancelled) setSchedules([]);
      })
      .finally(() => {
        if (!cancelled) setSchedulesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [periodKind, token, schedules.length]);

  const isCny = currency.trim().toUpperCase() === 'CNY';
  const amountCny = amount == null ? null : isCny ? amount : fxRate == null ? null : amount * fxRate;

  const submit = useCallback(async (): Promise<void> => {
    if (saving) return;
    if (!supplierId) {
      setErr('先选一家供应商');
      return;
    }
    if (amount == null || amount <= 0) {
      setErr('账单金额必须大于 0');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body: SupplierInvoiceCreateInput = {
        supplierId,
        invoiceNo: invoiceNo.trim() || null,
        periodKind,
        flightScheduleId: periodKind === 'FLIGHT_SCHEDULE' ? flightScheduleId || null : null,
        periodMonth: periodKind === 'MONTH' ? periodMonth || null : null,
        periodFrom: periodKind === 'CUSTOM' ? periodFrom || null : null,
        periodTo: periodKind === 'CUSTOM' ? periodTo || null : null,
        currency: currency.trim().toUpperCase() || 'CNY',
        amount,
        // 人民币账单不许带汇率（后端会拒），这里直接不发
        fxRate: isCny ? null : fxRate,
        status,
        attachmentUrl: attachmentUrl.trim() || null,
        note: note.trim() || null,
      };
      await supplierPayablesApi.createInvoice(token, body);
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '建单失败');
    } finally {
      setSaving(false);
    }
  }, [
    saving,
    supplierId,
    amount,
    invoiceNo,
    periodKind,
    flightScheduleId,
    periodMonth,
    periodFrom,
    periodTo,
    currency,
    isCny,
    fxRate,
    status,
    attachmentUrl,
    note,
    token,
    onDone,
  ]);

  return (
    <Modal
      open
      onClose={onClose}
      title="新建应付账单"
      size="lg"
      footer={
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
            {saving ? '保存中…' : '建单'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="inv-supplier">
              供应商 *
            </label>
            <select
              id="inv-supplier"
              className="input"
              value={supplierId}
              onChange={(e) => onPickSupplier(e.target.value)}
            >
              <option value="">请选择</option>
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.typeLabel} · {s.name}
                </option>
              ))}
            </select>
            {active.length === 0 && (
              <p className="mt-1 text-xs text-amber-700">
                还没有启用中的供应商，先在上面「新建供应商」。
              </p>
            )}
          </div>
          <div>
            <label className="label" htmlFor="inv-no">
              账单号 / 发票号
            </label>
            <input
              id="inv-no"
              className="input"
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              placeholder="供应商账单上印的号，选填"
            />
          </div>
        </div>

        <fieldset>
          <legend className="label">期次 *</legend>
          <div className="flex flex-wrap gap-2">
            {PERIOD_KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                onClick={() => setPeriodKind(k.value)}
                className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                  periodKind === k.value
                    ? 'border-brand bg-brand-100 font-semibold text-brand-700'
                    : 'border-slate-200 bg-white text-ink-soft hover:bg-slate-50'
                }`}
                title={k.hint}
              >
                {k.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {PERIOD_KINDS.find((k) => k.value === periodKind)?.hint} ·
            期次决定对账时圈哪一段的系统侧成本，填错了对账就没法比。
          </p>

          <div className="mt-2">
            {periodKind === 'FLIGHT_SCHEDULE' && (
              <select
                className="input"
                value={flightScheduleId}
                onChange={(e) => setFlightScheduleId(e.target.value)}
                aria-label="航班班次"
              >
                <option value="">{schedulesLoading ? '加载班次中…' : '请选择班次'}</option>
                {schedules.map((s) => (
                  <option key={s.scheduleId} value={s.scheduleId}>
                    {s.flightNumber} · {s.localDepartureDate}{' '}
                    {formatLocalTime(s.departureTime, s.departureTz)} · {s.originCode}→
                    {s.destinationCode}
                  </option>
                ))}
              </select>
            )}
            {periodKind === 'MONTH' && (
              <input
                type="month"
                className="input"
                value={periodMonth}
                onChange={(e) => setPeriodMonth(e.target.value)}
                aria-label="账单月份"
              />
            )}
            {periodKind === 'CUSTOM' && (
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  className="input"
                  value={periodFrom}
                  onChange={(e) => setPeriodFrom(e.target.value)}
                  aria-label="区间起始日"
                />
                <span className="text-xs text-ink-muted">至</span>
                <input
                  type="date"
                  className="input"
                  value={periodTo}
                  onChange={(e) => setPeriodTo(e.target.value)}
                  aria-label="区间截止日"
                />
              </div>
            )}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="inv-currency">
              币种
            </label>
            <input
              id="inv-currency"
              className="input uppercase"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="inv-amount">
              账单金额（原币）*
            </label>
            <NumberInput id="inv-amount" value={amount} onChange={setAmount} min={0} />
          </div>
          <div>
            <label className="label" htmlFor="inv-fx">
              汇率（原币→人民币）
            </label>
            <NumberInput
              id="inv-fx"
              value={fxRate}
              onChange={setFxRate}
              min={0}
              disabled={isCny}
              placeholder={isCny ? '人民币账单不填' : '如 7.12'}
            />
          </div>
        </div>

        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-soft">
          折人民币入账：
          <span className="ml-1 font-semibold text-ink nums">
            {amountCny == null ? '—（外币账单必须填汇率）' : fmtCny(amountCny)}
          </span>
          <span className="ml-2 text-ink-muted">
            折算结果建单时就固化，之后谁改汇率表都不会追溯这张账单。
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="inv-status">
              初始状态
            </label>
            <select
              id="inv-status"
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as 'DRAFT' | 'CONFIRMED')}
            >
              <option value="DRAFT">草稿（还没跟供应商对上）</option>
              <option value="CONFIRMED">已确认（对过了，可以付款）</option>
            </select>
            <p className="mt-1 text-xs text-ink-muted">草稿状态不能登记付款。</p>
          </div>
          <div>
            <label className="label" htmlFor="inv-attach">
              账单附件链接
            </label>
            <input
              id="inv-attach"
              className="input"
              value={attachmentUrl}
              onChange={(e) => setAttachmentUrl(e.target.value)}
              placeholder="扫描件 / 网盘链接，选填"
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="inv-note">
            备注
          </label>
          <input
            id="inv-note"
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如：含 3 间 no-show 房费，对方同意后补减免"
          />
        </div>

        {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}
      </div>
    </Modal>
  );
}

// ── 账单详情 + 付款 ──────────────────────────────────────────────────────────

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
