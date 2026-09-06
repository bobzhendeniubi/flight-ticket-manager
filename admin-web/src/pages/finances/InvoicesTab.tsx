/**
 * 财务页「发票」页签 —— 给客户 / 代理开的**真发票**（专票 / 普票 / 收据）。
 *
 * ⚠️ 与订单上的「开票」三个勾（去程 / 回程 / 系统）没有任何关系。那三个勾是票务岗的**出票**
 *    进度，口径一个字不动；本页签管的是抬头、税号、发票号、开具日、金额。两件事只是中文
 *    撞了名字，任何一侧联动另一侧都是 bug。
 *
 * 状态机三态、终局唯一：待开具 —开具→ 已开具；待开具 / 已开具 —作废→ 已作废（终局，必须填原因）。
 * 作废之后那几张订单可以重新申请；未作废前同一张订单不许挂第二张有效发票。
 *
 * 金额一律由服务端按订单应收算，前端既不传也不给可编辑的金额框 ——
 * 发票金额不能由申请方或经办人说了算。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../lib/api';
import { businessTzParts, formatDateTimeCn } from '../../lib/datetime';
import {
  INVOICE_RECORD_STATUS_LABEL,
  INVOICE_RECORD_STATUS_TONE,
  INVOICE_TYPES,
  INVOICE_TYPE_LABEL,
  invoicesApi,
  type InvoiceRecord,
  type InvoiceRecordStatus,
  type InvoiceType,
} from '../../lib/payablesApi';
import { fmtCny } from '../../lib/payablesView';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';

const STATUS_OPTIONS: InvoiceRecordStatus[] = ['REQUESTED', 'ISSUED', 'VOID'];

function businessToday(): string {
  const p = businessTzParts(new Date());
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

export function InvoicesTab({ token }: { token: string }) {
  const [rows, setRows] = useState<InvoiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 默认只看待开具：这个页签首先是一条**队列**，「还有谁等着我开票」才是财务打开它的理由
  const [status, setStatus] = useState<'' | InvoiceRecordStatus>('REQUESTED');
  const [type, setType] = useState<'' | InvoiceType>('');
  const [orderNumber, setOrderNumber] = useState('');
  const [issuing, setIssuing] = useState<InvoiceRecord | null>(null);
  const [voiding, setVoiding] = useState<InvoiceRecord | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await invoicesApi.list(token, {
        status: status || undefined,
        type: type || undefined,
        orderNumber: orderNumber.trim() || undefined,
      });
      setRows(r.invoices);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '加载发票失败');
    } finally {
      setLoading(false);
    }
  }, [token, status, type, orderNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = useMemo(() => rows.filter((r) => r.status === 'REQUESTED'), [rows]);
  const pendingCny = useMemo(() => pending.reduce((s, r) => s + r.amountCny, 0), [pending]);

  return (
    <section className="space-y-4">
      <div className="flex items-start gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-ink-soft">
        <Icon name="info" />
        <span>
          这里是给客户 / 代理开的<strong className="font-semibold">发票</strong>
          （专票 / 普票 / 收据）。跟订单上的「开票」三个勾（去程 / 回程 / 系统出票进度）
          是两回事，两边互不联动。
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard
          label="待开具"
          value={`${pending.length} 张`}
          sub="客户 / 代理已申请，等财务开票号"
          tone={pending.length > 0 ? 'warn' : undefined}
        />
        <StatCard label="待开具金额" value={fmtCny(pendingCny)} sub="按关联订单应收合计" />
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface shadow-card">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
          <div>
            <h2 className="section-title">发票</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              开具即定死票号与开具日；开错了走「作废」并填原因，客户可以重新申请——不提供改票号。
            </p>
          </div>
        </header>

        <div className="flex flex-wrap items-end gap-2 border-b border-slate-100 px-5 py-3">
          <div>
            <label className="label" htmlFor="fp-status">
              状态
            </label>
            <select
              id="fp-status"
              className="input py-1.5"
              value={status}
              onChange={(e) => setStatus(e.target.value as '' | InvoiceRecordStatus)}
            >
              <option value="">全部</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {INVOICE_RECORD_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="fp-type">
              发票类型
            </label>
            <select
              id="fp-type"
              className="input py-1.5"
              value={type}
              onChange={(e) => setType(e.target.value as '' | InvoiceType)}
            >
              <option value="">全部</option>
              {INVOICE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {INVOICE_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="fp-order">
              订单号
            </label>
            <input
              id="fp-order"
              className="input py-1.5"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              placeholder="查「这张单开票了没」"
            />
          </div>
          <button type="button" className="btn-secondary mb-0.5 text-xs" onClick={() => void load()}>
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
                <th>抬头 / 税号</th>
                <th>类型</th>
                <th>关联订单</th>
                <th className="text-right">金额</th>
                <th>申请方</th>
                <th>申请时间</th>
                <th>状态</th>
                <th>票号 / 开具日</th>
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
                    {status === 'REQUESTED' ? '没有等着开的发票' : '没有符合条件的发票'}
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="font-medium text-ink">{r.title}</div>
                    <div className="font-mono text-xs text-ink-muted">{r.taxNo ?? '—'}</div>
                  </td>
                  <td className="text-xs">{r.typeLabel}</td>
                  <td className="text-xs">
                    <div className="font-mono">{r.orders.map((o) => o.orderNumber).join('、')}</div>
                    {r.orders.length > 1 && (
                      <div className="text-ink-muted">共 {r.orders.length} 张</div>
                    )}
                  </td>
                  <td className="text-right nums">{fmtCny(r.amountCny)}</td>
                  <td className="text-xs">{r.agentLabel ?? '直客'}</td>
                  <td className="text-xs text-ink-muted">{formatDateTimeCn(r.createdAt)}</td>
                  <td>
                    <span className={INVOICE_RECORD_STATUS_TONE[r.status]}>{r.statusLabel}</span>
                    {r.status === 'VOID' && r.voidReason && (
                      <div
                        className="mt-0.5 max-w-[10rem] truncate text-xs text-ink-muted"
                        title={r.voidReason}
                      >
                        {r.voidReason}
                      </div>
                    )}
                  </td>
                  <td className="text-xs">
                    <div className="font-mono">{r.invoiceNo ?? '—'}</div>
                    <div className="text-ink-muted nums">{r.issuedAt ?? ''}</div>
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {r.status === 'REQUESTED' && (
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() => setIssuing(r)}
                      >
                        开具
                      </button>
                    )}
                    {(r.status === 'REQUESTED' || r.status === 'ISSUED') && (
                      <button
                        type="button"
                        className="btn-ghost-danger text-xs"
                        onClick={() => setVoiding(r)}
                      >
                        作废
                      </button>
                    )}
                    {r.attachmentUrl && (
                      <a
                        className="btn-ghost text-xs"
                        href={r.attachmentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        附件
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {issuing && (
        <IssueModal
          token={token}
          invoice={issuing}
          onClose={() => setIssuing(null)}
          onDone={async () => {
            setIssuing(null);
            await load();
          }}
        />
      )}

      {voiding && (
        <VoidModal
          token={token}
          invoice={voiding}
          onClose={() => setVoiding(null)}
          onDone={async () => {
            setVoiding(null);
            await load();
          }}
        />
      )}
    </section>
  );
}

function IssueModal({
  token,
  invoice,
  onClose,
  onDone,
}: {
  token: string;
  invoice: InvoiceRecord;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [invoiceNo, setInvoiceNo] = useState('');
  const [issuedAt, setIssuedAt] = useState(businessToday);
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (saving) return;
    if (!invoiceNo.trim()) {
      setErr('发票号不能为空');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await invoicesApi.issue(token, invoice.id, {
        invoiceNo: invoiceNo.trim(),
        issuedAt: issuedAt || undefined,
        attachmentUrl: attachmentUrl.trim() || null,
      });
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '开具失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="开具发票"
      size="md"
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
            {saving ? '开具中…' : '确认开具'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium text-ink">{invoice.title}</span>
            <span className="text-lg font-bold text-ink nums">{fmtCny(invoice.amountCny)}</span>
          </div>
          <div className="mt-1 text-xs text-ink-muted">
            {invoice.typeLabel}
            {invoice.taxNo ? ` · 税号 ${invoice.taxNo}` : ''} ·{' '}
            {invoice.orders.map((o) => o.orderNumber).join('、')}
          </div>
          {invoice.requestNote && (
            <div className="mt-1 text-xs text-ink-soft">申请备注：{invoice.requestNote}</div>
          )}
        </div>

        <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <Icon name="alert" />
          <span>
            金额由系统按关联订单的应收算死，这里改不了。开具后票号与开具日定死——开错只能作废重开。
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="issue-no">
              发票号 *
            </label>
            <input
              id="issue-no"
              className="input"
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              placeholder="开票系统里的发票号码"
            />
          </div>
          <div>
            <label className="label" htmlFor="issue-at">
              开具日
            </label>
            <input
              id="issue-at"
              type="date"
              className="input"
              value={issuedAt}
              onChange={(e) => setIssuedAt(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="issue-attach">
            发票附件链接
          </label>
          <input
            id="issue-attach"
            className="input"
            value={attachmentUrl}
            onChange={(e) => setAttachmentUrl(e.target.value)}
            placeholder="PDF / 图片链接，选填"
          />
        </div>

        {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}
      </div>
    </Modal>
  );
}

function VoidModal({
  token,
  invoice,
  onClose,
  onDone,
}: {
  token: string;
  invoice: InvoiceRecord;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (saving) return;
    if (!reason.trim()) {
      setErr('作废必须填原因');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await invoicesApi.void(token, invoice.id, reason.trim());
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '作废失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="作废发票"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={() => void submit()}
            disabled={saving}
          >
            {saving ? '作废中…' : '确认作废'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <div className="font-medium text-ink">{invoice.title}</div>
          <div className="mt-1 text-xs text-ink-muted">
            {invoice.typeLabel} · {fmtCny(invoice.amountCny)}
            {invoice.invoiceNo ? ` · 票号 ${invoice.invoiceNo}` : ''}
          </div>
        </div>

        <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <Icon name="alert" />
          <span>
            作废是终局，撤不回。作废之后这几张订单可以重新申请发票。
            纸质票 / 电子票在开票系统里的作废另外做，这里只记系统状态。
          </span>
        </div>

        <div>
          <label className="label" htmlFor="void-reason">
            作废原因 *
          </label>
          <input
            id="void-reason"
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="如：抬头写错，客户要求重开"
          />
          <p className="mt-1 text-xs text-ink-muted">
            一张开出去的票被作废，事后一定有人要问「为什么」——原因写清楚。
          </p>
        </div>

        {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}
      </div>
    </Modal>
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
