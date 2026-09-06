/**
 * 财务页「供应商应付」页签 —— 钱付出去那一侧的账。
 *
 * 补的是此前唯一没有系统痕迹的一段：收进来的钱有 Payment / Receipt 两本账，付出去的钱
 * （航司包机款、酒店净房账单、签证公司美金账单）全在 Excel 和微信里。
 *
 * 本页签**不改任何成本口径**：毛利照旧由各产品自己的成本字段算，账单金额与它们各算各的。
 * 「对账」把两边并排放，差多少由人看，系统不替谁改数。
 *
 * 权限：整个财务页已挂在 finances.view 能力后面（App.tsx 的 Protected），后端每个口
 * 另有 requireFinanceAccess 兜底，所以这里不再自己判角色。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../lib/api';
import { businessTzParts } from '../../lib/datetime';
import {
  SUPPLIER_INVOICE_STATUS_LABEL,
  SUPPLIER_INVOICE_STATUS_TONE,
  supplierPayablesApi,
  type Supplier,
  type SupplierInvoice,
  type SupplierInvoiceListResult,
  type SupplierInvoiceStatus,
} from '../../lib/payablesApi';
import {
  fmtCny,
  fmtMoney,
  payProgress,
  payProgressBarClass,
  payProgressLabel,
} from '../../lib/payablesView';
import { Icon } from '../../components/Icon';
import { SupplierDirectory } from './SupplierDirectory';
import { SupplierInvoiceCreateModal, SupplierInvoiceDetailModal } from './SupplierInvoiceModals';
import { SupplierReconcileDrawer } from './SupplierReconcileDrawer';

const STATUS_OPTIONS: SupplierInvoiceStatus[] = [
  'DRAFT',
  'CONFIRMED',
  'PARTIALLY_PAID',
  'PAID',
  'DISPUTED',
];

/** 北京业务日往前推 n 天的 YYYY-MM-DD。 */
function businessDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = businessTzParts(d);
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

function businessToday(): string {
  const p = businessTzParts(new Date());
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

export function SupplierPayablesTab({ token }: { token: string }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [suppliersLoading, setSuppliersLoading] = useState(true);
  const [suppliersErr, setSuppliersErr] = useState<string | null>(null);

  const [data, setData] = useState<SupplierInvoiceListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 应付账的默认窗口比毛利页宽：账单是「还没做完的事」，窗口太窄会把更早的漏账藏起来
  const [supplierId, setSupplierId] = useState('');
  const [status, setStatus] = useState<'' | SupplierInvoiceStatus>('');
  const [from, setFrom] = useState(() => businessDaysAgo(89));
  const [to, setTo] = useState(businessToday);
  const [onlyUnpaid, setOnlyUnpaid] = useState(false);

  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reconcileId, setReconcileId] = useState<string | null>(null);

  const loadSuppliers = useCallback(async (): Promise<void> => {
    if (!token) return;
    setSuppliersLoading(true);
    setSuppliersErr(null);
    try {
      const r = await supplierPayablesApi.listSuppliers(token);
      setSuppliers(r.suppliers);
    } catch (e) {
      setSuppliersErr(e instanceof ApiError ? e.message : '加载供应商失败');
    } finally {
      setSuppliersLoading(false);
    }
  }, [token]);

  const loadInvoices = useCallback(async (): Promise<void> => {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await supplierPayablesApi.listInvoices(token, {
        supplierId: supplierId || undefined,
        status: status || undefined,
        from: from || undefined,
        to: to || undefined,
      });
      setData(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '加载应付账单失败');
    } finally {
      setLoading(false);
    }
  }, [token, supplierId, status, from, to]);

  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  // 「只看还欠着的」是本地过滤：合计卡片仍按服务端返回的整段算，
  // 否则勾一下 KPI 就变了，运营会以为欠款金额少了。
  const rows: SupplierInvoice[] = useMemo(() => {
    const all = data?.rows ?? [];
    return onlyUnpaid ? all.filter((r) => r.outstandingAmount > 0) : all;
  }, [data, onlyUnpaid]);

  return (
    <section className="space-y-4">
      <SupplierDirectory
        token={token}
        suppliers={suppliers}
        loading={suppliersLoading}
        error={suppliersErr}
        onChanged={async () => {
          await loadSuppliers();
          await loadInvoices();
        }}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="未付合计"
          value={fmtCny(data?.outstandingCny ?? 0)}
          sub="现在一共欠出去多少（按账单汇率折人民币）"
          tone={(data?.outstandingCny ?? 0) > 0 ? 'warn' : undefined}
        />
        <StatCard
          label="账单总额"
          value={fmtCny(data?.totalCny ?? 0)}
          sub={`筛选区间内 ${data?.rows.length ?? 0} 张账单`}
        />
        <StatCard
          label="已付合计"
          value={fmtCny(data?.paidCny ?? 0)}
          sub="按每笔付款当日汇率折算的实付"
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface shadow-card">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
          <div>
            <h2 className="section-title">应付账单</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              核销按<strong className="font-semibold">原币</strong>比：欠 1000 美金就要付够 1000
              美金，中间汇率怎么动都不改变「付清没有」。人民币侧只是实付记录，不做清偿判断。
            </p>
          </div>
          <button type="button" className="btn-primary text-xs" onClick={() => setCreating(true)}>
            <Icon name="plus" /> 新建账单
          </button>
        </header>

        <div className="flex flex-wrap items-end gap-2 border-b border-slate-100 px-5 py-3">
          <div>
            <label className="label" htmlFor="ap-supplier">
              供应商
            </label>
            <select
              id="ap-supplier"
              className="input py-1.5"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              <option value="">全部</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ap-status">
              状态
            </label>
            <select
              id="ap-status"
              className="input py-1.5"
              value={status}
              onChange={(e) => setStatus(e.target.value as '' | SupplierInvoiceStatus)}
            >
              <option value="">全部</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {SUPPLIER_INVOICE_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ap-from">
              期次起
            </label>
            <input
              id="ap-from"
              type="date"
              className="input py-1.5"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="ap-to">
              期次止
            </label>
            <input
              id="ap-to"
              type="date"
              className="input py-1.5"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={onlyUnpaid}
              onChange={(e) => setOnlyUnpaid(e.target.checked)}
            />
            只看还欠着的
          </label>
          <button
            type="button"
            className="btn-secondary mb-0.5 text-xs"
            onClick={() => void loadInvoices()}
          >
            <Icon name="refresh" /> 刷新
          </button>
        </div>

        {err && (
          <div className="mx-5 my-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>
        )}

        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th>供应商</th>
                <th>期次</th>
                <th>账单号</th>
                <th className="text-right">账单金额</th>
                <th className="text-right">折人民币</th>
                <th className="w-48">核销进度</th>
                <th className="text-right">未付</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-ink-muted">
                    加载中…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-ink-muted">
                    这段期次里没有应付账单
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="font-medium text-ink">{r.supplierName}</div>
                    <div className="text-xs text-ink-muted">{r.supplierTypeLabel}</div>
                  </td>
                  <td>
                    <div>{r.periodLabel}</div>
                    <div className="text-xs text-ink-muted">{r.periodKindLabel}</div>
                  </td>
                  <td className="font-mono text-xs">{r.invoiceNo ?? '—'}</td>
                  <td className="text-right nums">{fmtMoney(r.amount, r.currency)}</td>
                  <td className="text-right nums">{fmtCny(r.amountCny)}</td>
                  <td>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full ${payProgressBarClass(r.paidAmount, r.amount)}`}
                        style={{ width: `${payProgress(r.paidAmount, r.amount) * 100}%` }}
                      />
                    </div>
                    <div className="mt-1 text-xs text-ink-muted nums">
                      {payProgressLabel(r.paidAmount, r.amount, r.currency)}
                    </div>
                  </td>
                  <td
                    className={`text-right nums ${
                      r.outstandingAmount > 0 ? 'font-semibold text-amber-700' : 'text-ink-muted'
                    }`}
                  >
                    {fmtMoney(r.outstandingAmount, r.currency)}
                  </td>
                  <td>
                    <span className={SUPPLIER_INVOICE_STATUS_TONE[r.status]}>{r.statusLabel}</span>
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => setDetailId(r.id)}
                    >
                      详情 / 付款
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => setReconcileId(r.id)}
                    >
                      对账
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {creating && (
        <SupplierInvoiceCreateModal
          token={token}
          suppliers={suppliers}
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false);
            await loadInvoices();
          }}
        />
      )}

      {detailId && (
        <SupplierInvoiceDetailModal
          token={token}
          invoiceId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={loadInvoices}
        />
      )}

      {reconcileId && (
        <SupplierReconcileDrawer
          token={token}
          invoiceId={reconcileId}
          onClose={() => setReconcileId(null)}
        />
      )}
    </section>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'warn';
}) {
  return (
    <div
      className={`rounded-xl border p-4 shadow-card ${
        tone === 'warn' ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-surface'
      }`}
    >
      <p className="stat-label">{label}</p>
      <p className={`stat-value ${tone === 'warn' ? 'text-amber-800' : ''}`}>{value}</p>
      <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>
    </div>
  );
}
