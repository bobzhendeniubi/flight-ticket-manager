/**
 * 应付对账抽屉 —— 「系统算出来的成本」对「供应商开过来的账单」，差多少摆在一起看。
 *
 * **全程只读**：不改成本口径、不回写账单、绝不「自动调平」。差额大不大由人判断，
 * 系统只负责标出来。对不上通常是三种原因，界面上分开说：
 *   ① 供应商账单本身开错（找对方核）
 *   ② 系统里成本没维护全（缺成本条数单列）
 *   ③ 产品没挂供应商，系统侧根本没捞到东西（提示去挂）
 *
 * 差额分级的阈值只有后端一份（reconcile 的 diffLevel），这里只把 level 翻成人话，
 * 不在前端再判一次——两处判定必然漂移。
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import {
  DIFF_LEVEL_LABEL,
  DIFF_LEVEL_TONE,
  supplierPayablesApi,
  type SupplierInvoiceReconcile,
} from '../../lib/payablesApi';
import { diffSummary, fmtAmount, fmtCny, fmtMoney } from '../../lib/payablesView';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';

export interface SupplierReconcileDrawerProps {
  token: string;
  invoiceId: string;
  onClose: () => void;
}

export function SupplierReconcileDrawer({
  token,
  invoiceId,
  onClose,
}: SupplierReconcileDrawerProps) {
  const [data, setData] = useState<SupplierInvoiceReconcile | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      setData(await supplierPayablesApi.reconcile(token, invoiceId));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '对账失败');
    } finally {
      setLoading(false);
    }
  }, [token, invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = data
    ? diffSummary(
        data.diff.level,
        data.diff.amountCny,
        data.diff.pct,
        DIFF_LEVEL_LABEL,
        DIFF_LEVEL_TONE,
      )
    : null;

  return (
    <Modal
      open
      onClose={onClose}
      title="应付对账"
      size="xl"
      footer={
        <div className="flex justify-end">
          <button type="button" className="btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      }
    >
      {loading && <div className="py-8 text-center text-ink-muted">对账中…</div>}
      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}

      {data && summary && (
        <div className="space-y-4">
          <header className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-ink">{data.invoice.supplierName}</div>
                <div className="mt-0.5 text-xs text-ink-soft">
                  {data.invoice.periodKindLabel} · {data.invoice.periodLabel}
                </div>
              </div>
              <span className={summary.tone}>{summary.label}</span>
            </div>

            {/* 两边并排：左=系统算的，右=供应商要的 */}
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-xs text-ink-muted">系统侧成本（{data.systemSide.basisLabel}）</p>
                <p className="mt-0.5 text-xl font-semibold text-ink nums">
                  {data.systemSide.totalCny == null ? '无口径' : fmtCny(data.systemSide.totalCny)}
                </p>
                {data.systemSide.sourceAmount != null && (
                  <p className="text-xs text-ink-muted nums">
                    原币侧 {fmtAmount(data.systemSide.sourceAmount)}{' '}
                    {data.systemSide.sourceCurrency}
                  </p>
                )}
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-xs text-ink-muted">供应商账单</p>
                <p className="mt-0.5 text-xl font-semibold text-ink nums">
                  {fmtCny(data.invoice.amountCny)}
                </p>
                <p className="text-xs text-ink-muted nums">
                  {fmtMoney(data.invoice.amount, data.invoice.currency)}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-xs text-ink-muted">差额（账单 − 系统）</p>
                <p className="mt-0.5 text-xl font-semibold text-ink nums">
                  {data.diff.amountCny == null ? '—' : fmtCny(data.diff.amountCny)}
                </p>
                <p className="text-xs text-ink-muted">{summary.text}</p>
              </div>
            </div>

            <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-white px-3 py-2 text-xs text-ink-soft">
              <Icon name="info" />
              <span>{summary.hint}</span>
            </div>
          </header>

          {data.systemSide.missingCostCount > 0 && (
            <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <Icon name="alert" />
              <span>
                期内有 {data.systemSide.missingCostCount} 条捞到了但取不到成本，未计入系统侧合计。
                差额很可能就出在这儿——先把成本维护上再判断账单对不对。
              </span>
            </div>
          )}

          <section>
            <h3 className="section-title mb-1.5">系统侧成本明细</h3>
            <div className="overflow-x-auto">
              <table className="table-admin">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th className="text-right">数量</th>
                    <th className="text-right">金额（折人民币）</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {data.systemSide.lines.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-ink-muted">
                        期内没捞到系统侧成本
                      </td>
                    </tr>
                  )}
                  {data.systemSide.lines.map((l, i) => (
                    <tr key={`${l.label}-${i}`}>
                      <td className="font-medium text-ink">{l.label}</td>
                      <td className="text-right nums">
                        {l.quantity == null ? '—' : `${l.quantity}${l.unit ?? ''}`}
                      </td>
                      <td className="text-right nums">{fmtCny(l.amountCny)}</td>
                      <td className="text-xs text-ink-muted">{l.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {data.systemSide.notes.length > 0 && (
            <section className="rounded-lg border border-slate-200 p-3">
              <h3 className="section-title mb-1.5">口径说明</h3>
              <ul className="list-disc space-y-1 pl-4 text-xs text-ink-soft">
                {data.systemSide.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </section>
          )}

          <p className="text-xs text-ink-muted">
            对账只读：它不改成本口径、不回写账单，也不会替谁把数字调平。对不上就按上面的提示逐条查，
            该找供应商核的找供应商，该补成本的补成本。
          </p>
        </div>
      )}
    </Modal>
  );
}
