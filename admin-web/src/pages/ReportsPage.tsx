/**
 * 经营报表 · ADMIN-only
 *
 * 数据源：backend /reports/*
 * - 销售毛利：GET /reports/sales?from&to&dim=kind|channel|agent
 * - 应收账龄：GET /reports/receivables（rows 上限 500，汇总为全量）
 * - 代理欠款：GET /reports/agent-debts
 * - 导出：GET /reports/export?from&to → xlsx
 */
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type AgentDebtsReport,
  type ReceivablesBucket,
  type ReceivablesReport,
  type SalesReport,
  type SalesReportDim,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';
import { orderStatusBadgeClass, orderStatusLabel } from '../lib/orderStatus';

type Tab = 'sales' | 'receivables' | 'agentDebts';

const BUCKET_META: Record<ReceivablesBucket, { label: string; badge: string }> = {
  '0-7': { label: '0–7 天', badge: 'badge-info' },
  '8-30': { label: '8–30 天', badge: 'badge-warning' },
  '31-60': { label: '31–60 天', badge: 'badge-warning' },
  '61+': { label: '61 天以上', badge: 'badge-danger' },
};

const BUCKET_ORDER: ReceivablesBucket[] = ['0-7', '8-30', '31-60', '61+'];

const DIM_LABEL: Record<SalesReportDim, string> = {
  kind: '产品线',
  channel: '渠道',
  agent: '销售代理',
};

// ── helpers ────────────────────────────────────────────────────────────────
function fmtCny(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(fraction: number | null | undefined): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(1)}%`;
}
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthStartStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// ── shared UI atoms ────────────────────────────────────────────────────────
function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3.5 py-1.5 text-sm font-medium transition ${
        active
          ? 'border-brand bg-brand text-white'
          : 'border-slate-200 bg-white text-ink-soft hover:bg-slate-50 hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

/** 手写条形（占比 0–1） */
function ShareBar({ pct, tone }: { pct: number; tone?: 'neg' }) {
  const safe = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
  return (
    <div className="h-1.5 w-full min-w-[80px] overflow-hidden rounded-full bg-slate-100">
      <div
        className={`h-full ${tone === 'neg' ? 'bg-rose-500' : 'bg-brand/70'}`}
        style={{ width: `${safe * 100}%` }}
      />
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export function ReportsPage() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const [tab, setTab] = useState<Tab>('sales');
  const [from, setFrom] = useState(daysAgoStr(29));
  const [to, setTo] = useState(todayStr());

  const range = useMemo(() => ({ from, to }), [from, to]);

  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);

  async function onExport(): Promise<void> {
    if (!token || exporting) return;
    setExporting(true);
    setExportErr(null);
    try {
      const blob = await api.downloadReportsXlsx(token, range);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `经营报表-${range.from}_${range.to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setExportErr(e instanceof ApiError ? e.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">经营报表</h1>
          <p className="page-sub">销售毛利 / 应收账龄 / 代理欠款 —— 财务口径统一人民币</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label">起始</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="input py-1.5"
            />
          </div>
          <div>
            <label className="label">截止</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="input py-1.5"
            />
          </div>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              className="btn-secondary px-2 py-1 text-xs"
              onClick={() => {
                setFrom(daysAgoStr(29));
                setTo(todayStr());
              }}
            >
              最近 30 天
            </button>
            <button
              type="button"
              className="btn-secondary px-2 py-1 text-xs"
              onClick={() => {
                setFrom(daysAgoStr(89));
                setTo(todayStr());
              }}
            >
              最近 90 天
            </button>
            <button
              type="button"
              className="btn-secondary px-2 py-1 text-xs"
              onClick={() => {
                setFrom(monthStartStr());
                setTo(todayStr());
              }}
            >
              本月
            </button>
          </div>
          <div className="flex flex-col items-end gap-1">
            <button type="button" className="btn-secondary" onClick={() => void onExport()} disabled={exporting}>
              {exporting ? '导出中…' : '⬇ 导出 xlsx'}
            </button>
            {exportErr && <span className="text-xs text-rose-600">{exportErr}</span>}
          </div>
        </div>
      </header>

      <nav className="flex flex-wrap gap-2">
        <TabBtn active={tab === 'sales'} onClick={() => setTab('sales')}>
          销售毛利
        </TabBtn>
        <TabBtn active={tab === 'receivables'} onClick={() => setTab('receivables')}>
          应收账龄
        </TabBtn>
        <TabBtn active={tab === 'agentDebts'} onClick={() => setTab('agentDebts')}>
          代理欠款
        </TabBtn>
      </nav>

      {tab === 'sales' && <SalesTab token={token} range={range} />}
      {tab === 'receivables' && <ReceivablesTab token={token} />}
      {tab === 'agentDebts' && <AgentDebtsTab token={token} />}
    </div>
  );
}

// ── 销售毛利 tab ────────────────────────────────────────────────────────────
function SalesTab({ token, range }: { token: string; range: { from: string; to: string } }) {
  const [dim, setDim] = useState<SalesReportDim>('kind');
  const [report, setReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getSalesReport(token, { from: range.from, to: range.to, dim })
      .then((res) => {
        if (!cancelled) setReport(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载销售毛利失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, range.from, range.to, dim]);

  // 条形基准：正毛利行里的最大值
  const maxMargin = useMemo(() => {
    if (!report) return 0;
    return report.rows.reduce((m, r) => Math.max(m, r.grossMarginCny), 0);
  }, [report]);

  return (
    <section className="space-y-4">
      <div className="inline-flex overflow-hidden rounded-lg border border-slate-200">
        {(['kind', 'channel', 'agent'] as SalesReportDim[]).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDim(d)}
            className={`px-3.5 py-1.5 text-sm font-medium transition ${
              dim === d ? 'bg-brand text-white' : 'bg-white text-ink-soft hover:bg-slate-50'
            }`}
          >
            {DIM_LABEL[d]}
          </button>
        ))}
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="table-admin">
          <thead>
            <tr>
              <th>{DIM_LABEL[dim]}</th>
              <th className="text-right">订单数</th>
              <th className="text-right">收入</th>
              <th className="text-right">成本</th>
              <th className="text-right">毛利</th>
              <th className="text-right">毛利率</th>
              <th className="w-[140px]">毛利占比</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-ink-muted">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-rose-600">
                  {error}
                </td>
              </tr>
            )}
            {!loading && !error && report && report.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-ink-muted">
                  区间内暂无数据
                </td>
              </tr>
            )}
            {!loading &&
              !error &&
              report?.rows.map((r) => (
                <tr key={r.key}>
                  <td className="font-medium text-ink">{r.label}</td>
                  <td className="nums text-right">{r.orderCount}</td>
                  <td className="nums text-right">{fmtCny(r.revenueCny)}</td>
                  <td className="nums text-right">{fmtCny(r.costCny)}</td>
                  <td
                    className={`nums text-right font-medium ${
                      r.grossMarginCny < 0 ? 'text-rose-600' : 'text-emerald-700'
                    }`}
                  >
                    {fmtCny(r.grossMarginCny)}
                  </td>
                  <td className="nums text-right">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {fmtPct(r.marginPct)}
                      {r.missingCostItemCount > 0 && (
                        <span
                          className="badge-warning"
                          title="部分成本未录入，毛利率偏高，仅供参考"
                        >
                          <Icon name="alert" /> 缺{r.missingCostItemCount}项成本
                        </span>
                      )}
                    </span>
                  </td>
                  <td>
                    <ShareBar
                      pct={maxMargin > 0 ? r.grossMarginCny / maxMargin : 0}
                      tone={r.grossMarginCny < 0 ? 'neg' : undefined}
                    />
                  </td>
                </tr>
              ))}
          </tbody>
          {!loading && !error && report && (
            <tfoot>
              <tr className="border-t-2 border-slate-200 font-semibold text-ink">
                <td className="px-3 py-2.5">合计</td>
                <td className="nums px-3 py-2.5 text-right">{report.totals.orderCount}</td>
                <td className="nums px-3 py-2.5 text-right">{fmtCny(report.totals.revenueCny)}</td>
                <td className="nums px-3 py-2.5 text-right">{fmtCny(report.totals.costCny)}</td>
                <td
                  className={`nums px-3 py-2.5 text-right ${
                    report.totals.grossMarginCny < 0 ? 'text-rose-600' : 'text-emerald-700'
                  }`}
                >
                  {fmtCny(report.totals.grossMarginCny)}
                </td>
                <td className="nums px-3 py-2.5 text-right">
                  <span className="inline-flex items-center justify-end gap-1.5">
                    {fmtPct(report.totals.marginPct)}
                    {report.totals.missingCostItemCount > 0 && (
                      <span className="badge-warning">
                        <Icon name="alert" /> 缺{report.totals.missingCostItemCount}项成本
                      </span>
                    )}
                  </span>
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}

// ── 应收账龄 tab ────────────────────────────────────────────────────────────
function ReceivablesTab({ token }: { token: string }) {
  const [report, setReport] = useState<ReceivablesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getReceivablesReport(token)
      .then((res) => {
        if (!cancelled) setReport(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载应收账龄失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) return <div className="card py-10 text-center text-ink-muted">加载中…</div>;
  if (error) return <div className="card py-10 text-center text-rose-600">{error}</div>;
  if (!report) return null;

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <div className="stat-card">
          <div className="stat-label">总应收</div>
          <div className="stat-value text-rose-700">{fmtCny(report.summary.totalBalanceCny)}</div>
        </div>
        {BUCKET_ORDER.map((b) => {
          const bucket = report.summary.buckets[b];
          return (
            <div key={b} className="stat-card">
              <div className="stat-label">账龄 {BUCKET_META[b].label}</div>
              <div className="stat-value">{bucket ? bucket.count : 0} 单</div>
              <div className="nums mt-1 text-xs text-ink-muted">
                {fmtCny(bucket ? bucket.amountCny : 0)}
              </div>
            </div>
          );
        })}
      </div>

      {report.summary.truncated && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          仅显示前 500 条，汇总为全量
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="table-admin">
          <thead>
            <tr>
              <th>订单号</th>
              <th>联系人</th>
              <th>渠道</th>
              <th>状态</th>
              <th className="text-right">应收合计</th>
              <th className="text-right">已收</th>
              <th className="text-right">余额</th>
              <th className="text-right">账龄</th>
              <th>桶</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-8 text-center text-ink-muted">
                  暂无应收余额订单
                </td>
              </tr>
            )}
            {report.rows.map((r) => (
              <tr key={r.orderId}>
                <td className="nums font-medium text-ink">{r.orderNumber}</td>
                <td>{r.contactName}</td>
                <td>{r.agentLabel}</td>
                <td>
                  <span className={orderStatusBadgeClass(r.status)}>{orderStatusLabel(r.status)}</span>
                </td>
                <td className="nums text-right">{fmtCny(r.totalCny)}</td>
                <td className="nums text-right">{fmtCny(r.paidCny)}</td>
                <td className="nums text-right font-semibold text-rose-600">{fmtCny(r.balanceCny)}</td>
                <td className="nums text-right">{r.ageDays} 天</td>
                <td>
                  <span className={BUCKET_META[r.bucket].badge}>{BUCKET_META[r.bucket].label}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── 代理欠款 tab ────────────────────────────────────────────────────────────
function AgentDebtsTab({ token }: { token: string }) {
  const [report, setReport] = useState<AgentDebtsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getAgentDebtsReport(token)
      .then((res) => {
        if (!cancelled) setReport(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载代理欠款失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const rows = useMemo(() => {
    if (!report) return [];
    return [...report.rows].sort((a, b) => b.outstandingCny - a.outstandingCny);
  }, [report]);

  const maxOutstanding = rows.reduce((m, r) => Math.max(m, r.outstandingCny), 0);

  if (loading) return <div className="card py-10 text-center text-ink-muted">加载中…</div>;
  if (error) return <div className="card py-10 text-center text-rose-600">{error}</div>;

  return (
    <section className="card overflow-x-auto p-0">
      <table className="table-admin">
        <thead>
          <tr>
            <th>代理</th>
            <th className="text-right">欠款订单数</th>
            <th className="text-right">应收余额</th>
            <th className="text-right">预存余额</th>
            <th className="w-[160px]">欠款占比</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-8 text-center text-ink-muted">
                暂无代理欠款
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.agentId}>
              <td className="font-medium text-ink">{r.agentLabel}</td>
              <td className="nums text-right">{r.orderCount}</td>
              <td className="nums text-right font-semibold text-rose-600">
                {fmtCny(r.outstandingCny)}
              </td>
              <td className="nums text-right">{fmtCny(r.prepaymentBalanceCny)}</td>
              <td>
                <ShareBar pct={maxOutstanding > 0 ? r.outstandingCny / maxOutstanding : 0} tone="neg" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
