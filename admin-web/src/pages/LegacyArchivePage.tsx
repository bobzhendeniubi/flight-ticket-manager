import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type LegacyDashboard, type LegacyTicketListItem, type LegacyTicketRecord } from '../lib/api';
import { useAuth } from '../stores/auth';

function dateText(value: string | null): string {
  return value ? value.slice(0, 10) : '—';
}

function dateTimeText(value: string | null): string {
  return value ? value.replace('T', ' ').slice(0, 16) : '—';
}

function moneyText(value: string | null): string {
  if (value === null) return '—';
  return `¥${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function LegacyArchivePage() {
  const token = useAuth((state) => state.tokens?.accessToken);
  const [searchParams] = useSearchParams();
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [orgId, setOrgId] = useState('');
  const [paymentConfirmed, setPaymentConfirmed] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [applied, setApplied] = useState(() => ({
    q: searchParams.get('q') ?? '', dateFrom: '', dateTo: '', orgId: '', paymentConfirmed: '',
    dataIssue: searchParams.get('dataIssue') ?? '', includeDeleted: false,
  }));
  const [rows, setRows] = useState<LegacyTicketListItem[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0 });
  const [page, setPage] = useState(1);
  const [dashboard, setDashboard] = useState<LegacyDashboard | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listRequestId = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++listRequestId.current;
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.listLegacyTickets(token, {
        q: applied.q || undefined,
        dateFrom: applied.dateFrom || undefined,
        dateTo: applied.dateTo || undefined,
        orgId: applied.orgId || undefined,
        paymentConfirmed: applied.paymentConfirmed === '' ? undefined : applied.paymentConfirmed === 'true',
        dataIssue: applied.dataIssue || undefined,
        includeDeleted: applied.includeDeleted,
        page,
        pageSize: 20,
      });
      if (requestId !== listRequestId.current) return;
      setRows(result.items);
      setPagination(result.pagination);
    } catch {
      if (requestId !== listRequestId.current) return;
      setError('历史档案加载失败，请稍后重试');
    } finally {
      if (requestId === listRequestId.current) setLoading(false);
    }
  }, [applied, page, token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!token) return;
    api.getLegacyDashboard(token).then(setDashboard).catch(() => undefined);
  }, [token]);

  function submitFilters(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setPage(1);
    setApplied({ q: q.trim(), dateFrom, dateTo, orgId: orgId.trim(), paymentConfirmed, dataIssue: applied.dataIssue, includeDeleted });
  }

  function toggleDataIssue(issue: string): void {
    setPage(1);
    setApplied((current) => ({ ...current, dataIssue: current.dataIssue === issue ? '' : issue }));
  }

  return (
    <div>
      <div className="mb-5 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
        <div className="font-semibold">岘港老系统历史数据 · 封笔于 2026-08-24 · 只读</div>
        <div className="mt-0.5 text-xs text-sky-700">历史档案与当前订单相互隔离；“已转入新系统”仅表示去重核查标记。</div>
      </div>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">历史档案</h1>
          <p className="page-sub">旧系统封存记录查询</p>
        </div>
      </div>

      {dashboard && (
        <LegacyOverview
          dashboard={dashboard}
          expanded={overviewOpen}
          activeIssue={applied.dataIssue}
          onToggle={() => setOverviewOpen((open) => !open)}
          onSelectIssue={toggleDataIssue}
        />
      )}

      <form className="card mb-4 grid gap-3 md:grid-cols-12" onSubmit={submitFilters}>
        <label className="md:col-span-4">
          <span className="label">姓名 / 拼音 / 护照号 / 老订单号 / 团号</span>
          <input className="input" value={q} onChange={(event) => setQ(event.target.value)} placeholder="输入关键词" />
        </label>
        <label className="md:col-span-2">
          <span className="label">下单起始</span>
          <input className="input" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <label className="md:col-span-2">
          <span className="label">下单结束</span>
          <input className="input" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </label>
        <label className="md:col-span-2">
          <span className="label">代理 / 组织 ID</span>
          <input className="input" value={orgId} onChange={(event) => setOrgId(event.target.value)} placeholder="可选" />
        </label>
        <label className="md:col-span-2">
          <span className="label">认款状态</span>
          <select className="input" value={paymentConfirmed} onChange={(event) => setPaymentConfirmed(event.target.value)}>
            <option value="">全部</option>
            <option value="true">已认款</option>
            <option value="false">未认款</option>
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={includeDeleted} onChange={(event) => setIncludeDeleted(event.target.checked)} />
            包含已作废
          </label>
          <button className="btn-primary" type="submit">查询</button>
          {applied.dataIssue && (
            <span className="flex items-center gap-2 text-xs text-amber-700">
              数据质量筛选：<span className="badge-warning">{applied.dataIssue}</span>
              <button
                type="button"
                className="text-brand hover:text-brand-dark"
                onClick={() => {
                  setPage(1);
                  setApplied((current) => ({ ...current, dataIssue: '' }));
                }}
              >
                清除
              </button>
            </span>
          )}
          <span className="text-xs text-ink-muted">共 {pagination.total.toLocaleString()} 条</span>
        </div>
      </form>

      {error && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="table-admin min-w-[1100px]">
            <thead>
              <tr>
                <th>老订单号</th><th>乘客</th><th>护照号</th><th>去程</th><th>返程</th>
                <th>结算价</th><th>到账</th><th>认款</th><th>代理</th><th>下单时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="cursor-pointer" onClick={() => setSelectedId(row.id)}>
                  <td className="font-mono text-xs text-ink">{row.bookingNo ?? '—'}</td>
                  <td><div className="font-medium text-ink">{row.chineseName || '—'}</div><div className="text-xs">{row.fullName || '—'}</div></td>
                  <td className="font-mono text-xs">{row.documentNumberNorm || row.documentNumber || '—'}</td>
                  <td><div className="font-medium text-ink">{row.outboundFlightNo || '—'}</div><div className="text-xs">{dateText(row.outboundDate)}</div></td>
                  <td><div className="font-medium text-ink">{row.returnFlightNo || '—'}</div><div className="text-xs">{dateText(row.returnDate)}</div></td>
                  <td className="nums">{moneyText(row.finalPrice)}</td>
                  <td className="nums">{moneyText(row.truePrice)}</td>
                  <td>{row.paymentConfirmed ? <span className="badge-success">已认款</span> : <span className="badge-neutral">未认款</span>}</td>
                  <td>{row.orgName || row.orgId || '—'}</td>
                  <td className="text-xs">{dateTimeText(row.legacyCreateTime)}{row.supersededByOrderId && <div className="mt-1"><span className="badge-info">已转入新系统</span></div>}{row.isDeleted && <div className="mt-1"><span className="badge-danger">已作废</span></div>}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && <tr><td colSpan={10} className="py-12 text-center text-ink-muted">暂无档案</td></tr>}
              {loading && <tr><td colSpan={10} className="py-12 text-center text-ink-muted">加载中…</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-ink-muted">
          <span>第 {pagination.page} 页 · 每页 {pagination.pageSize} 条</span>
          <div className="flex gap-2">
            <button className="btn-secondary py-1.5" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>上一页</button>
            <button className="btn-secondary py-1.5" disabled={page * pagination.pageSize >= pagination.total || loading} onClick={() => setPage((current) => current + 1)}>下一页</button>
          </div>
        </div>
      </div>

      {selectedId && token && <LegacyDetailDrawer token={token} id={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function percent(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 1000) / 10}%` : '0%';
}

function LegacyOverview({
  dashboard,
  expanded,
  activeIssue,
  onToggle,
  onSelectIssue,
}: {
  dashboard: LegacyDashboard;
  expanded: boolean;
  activeIssue: string;
  onToggle: () => void;
  onSelectIssue: (issue: string) => void;
}) {
  const total = dashboard.payment.confirmed + dashboard.payment.unconfirmed;
  const maxMonthly = Math.max(1, ...dashboard.monthly.map((row) => row.count));
  const maxOrg = Math.max(1, ...dashboard.topOrgs.map((row) => row.count));
  const maxFlight = Math.max(1, ...dashboard.topFlights.map((row) => row.count));

  return (
    <section className="card mb-5 overflow-hidden p-0">
      <button
        type="button"
        className="flex w-full items-center justify-between border-b border-slate-200 px-4 py-3 text-left hover:bg-slate-50"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span>
          <span className="font-semibold text-ink">档案总览</span>
          <span className="ml-2 text-xs text-ink-muted">只读聚合 · 排除已作废档案</span>
        </span>
        <span className="text-xs text-ink-muted">{expanded ? '收起 ▲' : '展开 ▼'}</span>
      </button>

      {expanded && (
        <div className="space-y-4 p-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <OverviewStat label="档案单数" value={total.toLocaleString()} />
            <OverviewStat label="结算价合计" value={moneyText(dashboard.totals.finalPriceSum)} />
            <OverviewStat label="实际到账合计" value={moneyText(dashboard.totals.truePriceSum)} />
            <OverviewStat label="收款流水" value={`${dashboard.totals.receiptCount.toLocaleString()} 笔`} sub={moneyText(dashboard.totals.receiptAmountSum)} />
            <OverviewStat label="已认款" value={`${dashboard.payment.confirmed.toLocaleString()} 单`} sub={percent(dashboard.payment.confirmed, total)} />
            <OverviewStat label="已重录" value={`${dashboard.superseded.toLocaleString()} 单`} sub={percent(dashboard.superseded, total)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr_1fr]">
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="section-title mb-0">月度单量趋势</h3>
                <span className="text-[11px] text-ink-muted">按下单月</span>
              </div>
              {dashboard.monthly.length > 0 ? (
                <div className="flex h-40 items-end gap-1 border-b border-slate-100 px-1 pt-2">
                  {dashboard.monthly.map((row) => (
                    <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" key={row.month} title={`${row.month} · ${row.count} 单 · ${moneyText(row.finalPriceSum)}`}>
                      <span className="text-[10px] text-ink-muted nums">{row.count}</span>
                      <div
                        className="w-full max-w-7 rounded-t bg-brand/75 transition-all"
                        style={{ height: `${Math.max(4, (row.count / maxMonthly) * 100)}%` }}
                      />
                      <span className="text-[10px] text-ink-muted">{row.month.slice(2)}</span>
                    </div>
                  ))}
                </div>
              ) : <div className="flex h-40 items-center justify-center text-xs text-ink-muted">暂无月度数据</div>}
            </div>

            <OverviewRankCard
              title="代理 TOP"
              empty="暂无代理归属"
              rows={dashboard.topOrgs.map((row) => ({
                key: `${row.orgId ?? 'none'}-${row.orgName ?? ''}`,
                label: row.orgName || row.orgId || '未归属',
                count: row.count,
                sub: moneyText(row.finalPriceSum),
              }))}
              maxCount={maxOrg}
            />
            <OverviewRankCard
              title="去程航班 TOP"
              empty="暂无航班数据"
              rows={dashboard.topFlights.map((row) => ({
                key: row.flightNo,
                label: row.flightNo,
                count: row.count,
              }))}
              maxCount={maxFlight}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="section-title mb-0">数据质量</h3>
                {activeIssue && <span className="text-xs text-amber-700">已筛选</span>}
              </div>
              {dashboard.dataIssues.length > 0 ? (
                <div className="grid gap-1 sm:grid-cols-2">
                  {dashboard.dataIssues.map((row) => (
                    <button
                      type="button"
                      key={row.issue}
                      onClick={() => onSelectIssue(row.issue)}
                      className={`flex items-center justify-between rounded px-2 py-1.5 text-left text-xs ${activeIssue === row.issue ? 'bg-amber-100 ring-1 ring-amber-300' : 'bg-slate-50 hover:bg-amber-50'}`}
                    >
                      <span className="truncate text-ink-soft">{row.issue}</span>
                      <span className="ml-2 font-semibold nums text-ink">{row.count}</span>
                    </button>
                  ))}
                </div>
              ) : <div className="py-5 text-center text-xs text-ink-muted">暂无数据质量标记</div>}
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <h3 className="section-title mb-2">认款与重录比例</h3>
              <div className="space-y-3">
                <RatioRow label="已认款" value={dashboard.payment.confirmed} total={total} tone="bg-emerald-500" />
                <RatioRow label="未认款" value={dashboard.payment.unconfirmed} total={total} tone="bg-slate-400" />
                <RatioRow label="已重录" value={dashboard.superseded} total={total} tone="bg-indigo-500" />
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function OverviewStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="text-[10px] text-ink-muted">{label}</div>
      <div className="mt-0.5 whitespace-nowrap text-sm font-semibold text-ink nums">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-ink-muted nums">{sub}</div>}
    </div>
  );
}

function OverviewRankCard({
  title,
  empty,
  rows,
  maxCount,
}: {
  title: string;
  empty: string;
  rows: Array<{ key: string; label: string; count: number; sub?: string }>;
  maxCount: number;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <h3 className="section-title mb-2">{title}</h3>
      {rows.length > 0 ? rows.map((row) => (
        <div className="mb-2 last:mb-0" key={row.key}>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate text-ink-soft">{row.label}</span>
            <span className="shrink-0 font-semibold nums text-ink">{row.count} 单</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-brand/70" style={{ width: `${Math.max(3, (row.count / maxCount) * 100)}%` }} />
          </div>
          {row.sub && <div className="mt-0.5 text-right text-[10px] text-ink-muted nums">{row.sub}</div>}
        </div>
      )) : <div className="py-5 text-center text-xs text-ink-muted">{empty}</div>}
    </div>
  );
}

function RatioRow({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-ink-soft">
        <span>{label}</span><span className="nums">{value} · {percent(value, total)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${total > 0 ? (value / total) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

function LegacyDetailDrawer({ token, id, onClose }: { token: string; id: string; onClose: () => void }) {
  const [ticket, setTicket] = useState<LegacyTicketRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTicket(null);
    setError(null);
    api.getLegacyTicket(token, id)
      .then((result) => {
        if (!cancelled) setTicket(result.item);
      })
      .catch(() => {
        if (!cancelled) setError('详情加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [id, token]);

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} aria-hidden />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col bg-surface shadow-pop">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div><h2 className="text-base font-semibold text-ink">历史档案详情</h2><p className="mt-0.5 text-xs text-ink-muted">只读 · {id}</p></div>
          <button className="btn-ghost px-2 text-xl" onClick={onClose} aria-label="关闭详情">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
          {!ticket && !error && <div className="py-12 text-center text-sm text-ink-muted">加载中…</div>}
          {ticket && <LegacyDetail ticket={ticket} />}
        </div>
      </aside>
    </div>
  );
}

function LegacyDetail({ ticket }: { ticket: LegacyTicketRecord }) {
  return (
    <div className="space-y-5 text-sm">
      {ticket.supersededByOrderId && (
        <div className="flex items-center justify-between rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-indigo-900">
          <span className="font-medium">该档案已转入新系统</span>
          <Link className="btn-primary py-1.5" to={`/orders?legacyOrderId=${encodeURIComponent(ticket.supersededByOrderId)}`}>查看新系统对应订单</Link>
        </div>
      )}
      <section><h3 className="section-title">订单与乘客</h3><dl className="detail-grid">
        <Detail label="老订单号" value={ticket.bookingNo} mono /><Detail label="团号" value={ticket.teamNo} mono />
        <Detail label="拼音姓名" value={ticket.fullName} /><Detail label="中文姓名" value={ticket.chineseName} />
        <Detail label="证件姓名" value={ticket.documentName} /><Detail label="证件号" value={ticket.documentNumber} mono />
        <Detail label="证件类型（原值）" value={ticket.documentTypeRaw} /><Detail label="性别" value={ticket.gender} />
        <Detail label="出生日期" value={dateText(ticket.birthDate)} mono /><Detail label="国籍" value={ticket.nationality} />
        <Detail label="出生地" value={ticket.birthPlace} /><Detail label="乘客类型" value={ticket.passengerType} />
        <Detail label="签发日期" value={dateText(ticket.issueDate)} mono /><Detail label="有效期" value={dateText(ticket.expiryDate)} mono />
        <Detail label="组织" value={ticket.orgName || ticket.orgId} /><Detail label="下单时间" value={dateTimeText(ticket.legacyCreateTime)} mono />
      </dl></section>
      <section><h3 className="section-title">金额明细</h3><dl className="detail-grid">
        <Detail label="结算价" value={moneyText(ticket.finalPrice)} /><Detail label="实际到账" value={moneyText(ticket.truePrice)} />
        <Detail label="定金" value={moneyText(ticket.depositPrice)} /><Detail label="单房差" value={moneyText(ticket.hotelPrice)} />
        <Detail label="签证" value={moneyText(ticket.visaPrice)} /><Detail label="优惠" value={moneyText(ticket.discountPrice)} />
        <Detail label="抵扣" value={moneyText(ticket.deductionPrice)} /><Detail label="状态原值" value={ticket.stateRaw == null ? null : String(ticket.stateRaw)} />
      </dl></section>
      <section><h3 className="section-title">开票与状态</h3><div className="flex flex-wrap gap-2"><StateBadge label="去程" value={ticket.outboundTicketed} /><StateBadge label="回程" value={ticket.returnTicketed} /><StateBadge label="系统" value={ticket.systemTicketed} /><StateBadge label="认款" value={ticket.paymentConfirmed} /></div></section>
      <section><h3 className="section-title">航段</h3><div className="space-y-2">{ticket.flights.map((link) => <div className="rounded-lg border border-slate-200 bg-white p-3" key={link.id}><div className="flex justify-between font-medium text-ink"><span>{link.legType === 0 ? '去程' : '回程'} · {link.flight.flightNo || '—'}</span><span>{dateText(link.flight.departDate)}</span></div><div className="mt-1 text-xs text-ink-soft">{link.flight.originCode || '—'} → {link.flight.destCode || '—'} · {link.flight.departTime || '—'} / {link.flight.arriveTime || '—'}</div></div>)}{ticket.flights.length === 0 && <div className="text-ink-muted">暂无航段关联</div>}</div></section>
      <section><h3 className="section-title">收款流水</h3><div className="overflow-x-auto"><table className="table-admin min-w-[500px]"><thead><tr><th>金额</th><th>时间</th><th>渠道码</th><th>次序</th></tr></thead><tbody>{ticket.receipts.map((receipt) => <tr key={receipt.id}><td>{moneyText(receipt.amount)}</td><td>{dateTimeText(receipt.receivedAt)}</td><td>{receipt.channelCode ?? '—'}</td><td>{receipt.sequence ?? '—'}</td></tr>)}{ticket.receipts.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-ink-muted">暂无收款流水</td></tr>}</tbody></table></div></section>
      <section><h3 className="section-title">备注与数据质量</h3><div className="rounded-lg border border-slate-200 bg-white p-3 text-ink-soft whitespace-pre-wrap">{ticket.remark || '—'}</div>{ticket.dataIssues.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{ticket.dataIssues.map((issue) => <span className="badge-warning" key={issue}>{issue}</span>)}</div>}</section>
    </div>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return <div><dt className="text-[11px] text-ink-muted">{label}</dt><dd className={`mt-0.5 text-ink ${mono ? 'font-mono' : ''}`}>{value || '—'}</dd></div>;
}

function StateBadge({ label, value }: { label: string; value: boolean }) {
  return value ? <span className="badge-success">{label}已开/已确认</span> : <span className="badge-neutral">{label}未开</span>;
}
