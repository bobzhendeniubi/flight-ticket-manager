/**
 * 我的分成 / 佣金 — 代理自助查看
 *
 * 后端 RBAC：
 *   AGENT 看自己 + 全部下级（任意层级）的结算单
 *   ADMIN/STAFF 看全部
 *
 * 关键概念：
 *   - 结算单按月（period = YYYY-MM）逐个代理生成一张
 *   - commissionEarned   = 这一期我作为代理拿到的净佣金
 *   - commissionPaidToChildren = 我从客户的总佣金中分给下级的部分（信息字段）
 *   - netCommission      = 应得佣金（records 已是净额；与 commissionEarned 同）
 *   - prepaymentOffset   = 预付余额抵扣
 *   - payableToAgent     = 实际打给我的钱 = netCommission - prepaymentOffset
 *
 * 状态机：DRAFT → PENDING_APPROVAL → APPROVED → PAID（或 VOIDED）
 */
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type SettlementSummary,
  type SettlementDetail,
  type SettlementStatus,
} from '../lib/api';
import { formatDateTimeCn } from '../lib/datetime';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';

const STATUS_LABEL: Record<SettlementStatus, string> = {
  DRAFT: '草稿',
  PENDING_APPROVAL: '待审批',
  APPROVED: '已核准',
  PAID: '已支付',
  VOIDED: '已作废',
};

const STATUS_COLOR: Record<SettlementStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-600',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-blue-100 text-blue-700',
  PAID: 'bg-green-100 text-green-700',
  VOIDED: 'bg-slate-200 text-slate-500',
};

const PRODUCT_LABEL: Record<'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA', string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '地面服务',
  VISA: '签证',
};

const TIER_LABEL: Record<number, string> = {
  1: '一级代理',
  2: '二级代理',
  3: '三级代理',
  4: '四级代理',
};

function fmtMoney(s: string | number): string {
  const n = typeof s === 'string' ? Number(s) : s;
  if (!Number.isFinite(n)) return '¥0.00';
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtRate(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

function periodOptions(months = 6): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    out.push(`${y}-${m}`);
  }
  return out;
}

export function MyCommissionsPage() {
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);
  const [settlements, setSettlements] = useState<SettlementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'' | SettlementStatus>('');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'self' | 'downstream'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SettlementDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listSettlements(tokens.accessToken, { pageSize: 100 })
      .then((r) => {
        if (!cancelled) setSettlements(r.settlements);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载结算失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tokens?.accessToken]);

  useEffect(() => {
    if (!selectedId || !tokens?.accessToken) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    api
      .getSettlement(tokens.accessToken, selectedId)
      .then((r) => {
        if (!cancelled) setDetail(r.settlement);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, tokens?.accessToken]);

  // 是否是我自己 — agent.email 与登录 user.email 比对
  const isSelf = (s: SettlementSummary): boolean => {
    if (!user?.email || !s.agent.email) return false;
    return s.agent.email.toLowerCase() === user.email.toLowerCase();
  };

  const filtered = useMemo(() => {
    return settlements
      .filter((s) => {
        if (period && s.period !== period) return false;
        if (statusFilter && s.status !== statusFilter) return false;
        if (scopeFilter === 'self' && !isSelf(s)) return false;
        if (scopeFilter === 'downstream' && isSelf(s)) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.period !== b.period) return b.period.localeCompare(a.period);
        return (a.agent.tier ?? 99) - (b.agent.tier ?? 99);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlements, period, statusFilter, scopeFilter, user?.email]);

  const kpi = useMemo(() => {
    const totals = { grossRevenue: 0, commissionEarned: 0, payableToAgent: 0, paidThisPeriod: 0 };
    const myTotals = { ...totals };
    const downstream = { ...totals };
    settlements.forEach((s) => {
      const earned = Number(s.commissionEarned);
      const payable = Number(s.payableToAgent);
      const gross = Number(s.grossRevenue);
      const paid = s.status === 'PAID' ? payable : 0;
      const target = isSelf(s) ? myTotals : downstream;
      target.grossRevenue += gross;
      target.commissionEarned += earned;
      target.payableToAgent += payable;
      target.paidThisPeriod += paid;
      totals.grossRevenue += gross;
      totals.commissionEarned += earned;
      totals.payableToAgent += payable;
      totals.paidThisPeriod += paid;
    });
    return { totals, myTotals, downstream };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlements, user?.email]);

  return (
    <div className="space-y-5">
      <section className="animate-fade-up">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">我的分成 · 佣金</h1>
        <p className="section-sub">
          按月查看自己 + 下级代理的佣金结算。结算单状态：草稿 → 待审批 → 已核准 → 已支付。
        </p>
      </section>

      {error && (
        <div className="inline-flex items-center gap-1.5 rounded-xl border border-deal/30 bg-deal-light px-3 py-2 text-sm font-medium text-deal-dark">
          <Icon name="info" className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-4">
        <Kpi
          label="我的应得佣金"
          value={fmtMoney(kpi.myTotals.commissionEarned)}
          sub={`已支付 ${fmtMoney(kpi.myTotals.paidThisPeriod)}`}
          tone="brand"
        />
        <Kpi
          label="下级累计佣金"
          value={fmtMoney(kpi.downstream.commissionEarned)}
          sub={`下级 GMV ${fmtMoney(kpi.downstream.grossRevenue)}`}
          tone="indigo"
        />
        <Kpi
          label="待打款金额"
          value={fmtMoney(kpi.totals.payableToAgent - kpi.totals.paidThisPeriod)}
          sub="未打款的应付合计"
          tone="amber"
        />
        <Kpi
          label="结算单总数"
          value={settlements.length.toString()}
          sub={`含 ${settlements.filter((s) => s.status === 'PAID').length} 张已支付`}
          tone="slate"
        />
      </section>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="label text-xs">期次</label>
            <select className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="">全部期次</option>
              {periodOptions(12).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label text-xs">状态</label>
            <select
              className="input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as '' | SettlementStatus)}
            >
              <option value="">全部状态</option>
              {(Object.keys(STATUS_LABEL) as SettlementStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label text-xs">范围</label>
            <select
              className="input"
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value as 'all' | 'self' | 'downstream')}
            >
              <option value="all">自己 + 下级</option>
              <option value="self">仅自己</option>
              <option value="downstream">仅下级</option>
            </select>
          </div>
          <div className="flex items-end">
            <span className="text-sm text-ink-muted">显示 <span className="font-semibold text-ink nums">{filtered.length}</span> 条</span>
          </div>
        </div>
      </section>

      <section className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 text-sm">
            <thead className="bg-canvas text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">期次</th>
                <th className="px-4 py-3 text-left font-semibold">代理</th>
                <th className="px-4 py-3 text-right font-semibold">订单数</th>
                <th className="px-4 py-3 text-right font-semibold">销售额（GMV）</th>
                <th className="px-4 py-3 text-right font-semibold">应得佣金</th>
                <th className="px-4 py-3 text-right font-semibold">分给下级</th>
                <th className="px-4 py-3 text-right font-semibold">应付</th>
                <th className="px-4 py-3 text-center font-semibold">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-ink-muted">
                    加载中…
                  </td>
                </tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-ink-muted">
                    {settlements.length === 0
                      ? '暂无结算单 — 月底由管理员生成后会自动出现在这里'
                      : '没有符合条件的结算单'}
                  </td>
                </tr>
              )}
              {filtered.map((s) => {
                const self = isSelf(s);
                return (
                  <tr
                    key={s.id}
                    className={`cursor-pointer transition-colors hover:bg-brand-50/50 ${self ? 'bg-brand-50/60' : ''}`}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-ink-soft nums">{s.period}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-ink">
                          {s.agent.companyName ?? s.agent.contactName}
                        </span>
                        {self && (
                          <span className="badge-deal text-[10px]">
                            我自己
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-muted">
                        {TIER_LABEL[s.agent.tier] ?? `${s.agent.tier} 级代理`} · {s.agent.email ?? '—'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-ink nums">{s.orderCount}</td>
                    <td className="px-4 py-3 text-right text-sm text-ink-soft nums">
                      {fmtMoney(s.grossRevenue)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-semibold text-emerald-700 nums">
                      {fmtMoney(s.commissionEarned)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-ink-muted nums">
                      {Number(s.commissionPaidToChildren) > 0
                        ? fmtMoney(s.commissionPaidToChildren)
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-ink nums">
                      {fmtMoney(s.payableToAgent)}
                      {Number(s.prepaymentOffset) > 0 && (
                        <div className="text-[10px] font-normal text-amber-700">
                          预付抵 −{fmtMoney(s.prepaymentOffset)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLOR[s.status]}`}>
                        {STATUS_LABEL[s.status]}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {selectedId && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-ink/40 backdrop-blur-sm"
          onClick={() => setSelectedId(null)}
        >
          <div
            className="h-full w-full max-w-xl animate-fade-in overflow-auto bg-surface shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200/80 bg-surface/95 px-6 py-4 backdrop-blur-xl">
              <h2 className="section-title text-base">结算单详情</h2>
              <button
                className="text-2xl leading-none text-ink-muted transition hover:text-ink"
                onClick={() => setSelectedId(null)}
              >
                ×
              </button>
            </div>
            {detailLoading ? (
              <div className="px-6 py-8 text-center text-ink-muted">加载中…</div>
            ) : !detail ? (
              <div className="px-6 py-8 text-center text-ink-muted">无法加载详情</div>
            ) : (
              <div className="space-y-5 px-6 py-5">
                <section>
                  <div className="font-mono text-xs text-ink-muted nums">{detail.period}</div>
                  <div className="mt-1 text-lg font-bold text-ink">
                    {detail.agent.companyName ?? detail.agent.contactName}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="chip">
                      {TIER_LABEL[detail.agent.tier] ?? `${detail.agent.tier} 级代理`}
                    </span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLOR[detail.status]}`}>
                      {STATUS_LABEL[detail.status]}
                    </span>
                  </div>
                </section>

                <section className="space-y-1.5 rounded-2xl border border-slate-200/80 bg-canvas p-4 text-sm">
                  <Row k="销售额（直销 GMV）" v={fmtMoney(detail.grossRevenue)} />
                  <Row k="应得佣金（已扣下级分成）" v={fmtMoney(detail.commissionEarned)} highlight="emerald" />
                  {Number(detail.commissionPaidToChildren) > 0 && (
                    <Row k="分给下级" v={fmtMoney(detail.commissionPaidToChildren)} subtle />
                  )}
                  <Row k="净佣金" v={fmtMoney(detail.netCommission)} />
                  {Number(detail.prepaymentOffset) > 0 && (
                    <Row k="预付余额抵扣" v={`−${fmtMoney(detail.prepaymentOffset)}`} subtle />
                  )}
                  <div className="flex items-center justify-between border-t border-slate-200/80 pt-2">
                    <span className="text-sm font-medium text-ink-soft">实际应付</span>
                    <span className="text-xl font-bold text-ink nums">
                      {fmtMoney(detail.payableToAgent)}
                    </span>
                  </div>
                </section>

                <section className="space-y-0.5 text-xs text-ink-muted">
                  <div>生成于：{formatDateTimeCn(detail.generatedAt)}</div>
                  {detail.approvedAt && <div>核准于：{formatDateTimeCn(detail.approvedAt)}</div>}
                  {detail.paidAt && <div>支付于：{formatDateTimeCn(detail.paidAt)}</div>}
                  {detail.notes && <div>备注：{detail.notes}</div>}
                </section>

                <section>
                  <h3 className="mb-2 section-title text-sm">
                    佣金明细（{detail.commissions.length} 笔）
                  </h3>
                  {detail.commissions.length === 0 ? (
                    <div className="rounded-xl bg-canvas px-3 py-4 text-center text-xs text-ink-muted">
                      本期无佣金记录
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-200/80">
                      <table className="min-w-full divide-y divide-slate-100 text-xs">
                        <thead className="bg-canvas text-[10px] uppercase tracking-wide text-ink-muted">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">订单</th>
                            <th className="px-3 py-2 text-left font-semibold">产品</th>
                            <th className="px-3 py-2 text-right font-semibold">基数</th>
                            <th className="px-3 py-2 text-right font-semibold">费率</th>
                            <th className="px-3 py-2 text-right font-semibold">金额</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {detail.commissions.map((c) => (
                            <tr key={c.id}>
                              <td className="px-3 py-2 font-mono text-[11px] text-ink-soft nums">
                                {c.order.orderNumber}
                                {c.chainDepth > 0 && (
                                  <div className="text-[10px] text-ink-muted">
                                    下级 +{c.chainDepth} 层
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2 text-ink-soft">{PRODUCT_LABEL[c.productKind]}</td>
                              <td className="px-3 py-2 text-right text-ink-soft nums">
                                {fmtMoney(c.baseAmount)}
                              </td>
                              <td className="px-3 py-2 text-right text-ink-soft nums">{fmtRate(c.rate)}</td>
                              <td className="px-3 py-2 text-right font-semibold text-emerald-700 nums">
                                {fmtMoney(c.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  k,
  v,
  highlight,
  subtle,
}: {
  k: string;
  v: string;
  highlight?: 'emerald';
  subtle?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between ${subtle ? 'text-ink-muted' : ''}`}>
      <span className="text-ink-soft">{k}</span>
      <span className={highlight === 'emerald' ? 'font-semibold text-emerald-700 nums' : 'text-ink nums'}>
        {v}
      </span>
    </div>
  );
}

type KpiTone = 'brand' | 'indigo' | 'amber' | 'slate';

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: KpiTone }) {
  const bar: Record<KpiTone, string> = {
    brand: 'bg-brand',
    indigo: 'bg-brand-400',
    amber: 'bg-sun',
    slate: 'bg-ink-muted',
  };
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <span className={`h-8 w-1 rounded-full ${bar[tone]}`}></span>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      </div>
      <p className="mt-2 text-xl font-extrabold text-ink nums">{value}</p>
      <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>
    </div>
  );
}
