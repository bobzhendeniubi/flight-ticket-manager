/**
 * 新建应付账单弹窗。
 *
 * 期次三选一（按班次 / 按月 / 自定义区间）——它决定对账时圈哪一段的系统侧成本，填错了对账没法比。
 * 币种与汇率当场折算成人民币并在建单时固化：之后谁改汇率表都不追溯这张账单。
 * 新账单默认草稿：先录进来，跟供应商对上了再确认，确认之后才谈付款。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FinanceScheduleRow } from '../../lib/api';
import { businessTzParts } from '../../lib/datetime';
import { formatLocalTime } from '../../lib/airports';
import {
  supplierPayablesApi,
  type Supplier,
  type SupplierInvoiceCreateInput,
  type SupplierInvoicePeriodKind,
} from '../../lib/payablesApi';
import { fmtCny } from '../../lib/payablesView';
import { Modal } from '../../components/Modal';
import { NumberInput } from '../../components/NumberInput';

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
