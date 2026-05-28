/**
 * 财务模块 · ADMIN-only · 业务 P&L
 *
 * 数据源：backend/src/modules/finances/*  （依赖各产品的 costPriceCny 字段）
 * 路由：
 *   GET /finances/summary  - 概览（KPI + 按品类拆分）
 *   GET /finances/flights  - 按航班分组的 P&L（含空座沉没成本）
 *   GET /finances/orders   - 按订单分组的 P&L
 *   GET /finances/monthly  - 最近 N 个月趋势
 *
 * 成本更新：未填的 cost 由 backend/scripts/backfill-finance-costs.ts 用 demo 估算回填；
 * 真实生产应由 staff 在 Flights/Hotels/Visa/Transfer 管理页录入。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type FinanceSummary,
  type FlightPnlRow,
  type OrderPnlRow,
  type MonthlyPoint,
} from '../lib/api';
import { useAuth } from '../stores/auth';

type Tab = 'summary' | 'flights' | 'orders' | 'monthly';

const KIND_LABEL: Record<string, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '接送',
  VISA: '签证',
  BUNDLE: '套餐',
  INSURANCE: '保险',
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '已出票',
  COMPLETED: '已完成',
  PAYMENT_TIMEOUT: '支付超时',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '退款中',
  REFUNDED: '已退款',
  CHANGE_REQUESTED: '改期中',
  CHANGED: '已改期',
  FAILED: '失败',
};

// ── helpers ────────────────────────────────────────────────────────────────
function fmtCny(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}
function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtMonth(s: string): string {
  const [y, m] = s.split('-');
  return `${y} 年 ${parseInt(m ?? '0', 10)} 月`;
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

// ── shared UI atoms ────────────────────────────────────────────────────────
function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'pos' | 'neg' | 'neutral' | 'warn';
}) {
  const toneClass =
    tone === 'pos'
      ? 'text-emerald-700'
      : tone === 'neg'
        ? 'text-rose-700'
        : tone === 'warn'
          ? 'text-amber-700'
          : 'text-slate-900';
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

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
      className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
        active
          ? 'bg-slate-900 text-white border-slate-900'
          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

function ProgressBar({ pct, tone }: { pct: number; tone?: 'pos' | 'neg' }) {
  const safe = Math.max(0, Math.min(1, pct));
  const color = tone === 'neg' ? 'bg-rose-500' : tone === 'pos' ? 'bg-emerald-500' : 'bg-slate-500';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full ${color}`} style={{ width: `${safe * 100}%` }} />
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export function FinancesPage() {
  const tokens = useAuth((s) => s.tokens);
  const [tab, setTab] = useState<Tab>('summary');
  const [from, setFrom] = useState(daysAgoStr(29));
  const [to, setTo] = useState(todayStr());

  const range = useMemo(() => ({ from, to }), [from, to]);
  const token = tokens?.accessToken ?? '';

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">财务</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            收入 / 成本 / 毛利按航班和订单实时核算 ·{' '}
            <span className="text-amber-700">⚠ 财务数据敏感，访问会记录到审计日志</span>
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs text-slate-500">
            起始
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="block mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-slate-500">
            截止
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="block mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => {
                setFrom(daysAgoStr(29));
                setTo(todayStr());
              }}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              最近 30 天
            </button>
            <button
              type="button"
              onClick={() => {
                setFrom(daysAgoStr(89));
                setTo(todayStr());
              }}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              最近 90 天
            </button>
          </div>
        </div>
      </header>

      <nav className="flex flex-wrap gap-2">
        <TabBtn active={tab === 'summary'} onClick={() => setTab('summary')}>
          概览
        </TabBtn>
        <TabBtn active={tab === 'flights'} onClick={() => setTab('flights')}>
          航班毛利
        </TabBtn>
        <TabBtn active={tab === 'orders'} onClick={() => setTab('orders')}>
          订单毛利
        </TabBtn>
        <TabBtn active={tab === 'monthly'} onClick={() => setTab('monthly')}>
          月度趋势
        </TabBtn>
      </nav>

      {tab === 'summary' && <SummaryTab token={token} range={range} />}
      {tab === 'flights' && <FlightsTab token={token} range={range} />}
      {tab === 'orders' && <OrdersTab token={token} range={range} />}
      {tab === 'monthly' && <MonthlyTab token={token} />}
    </div>
  );
}

// ── Summary tab ────────────────────────────────────────────────────────────
function SummaryTab({ token, range }: { token: string; range: { from: string; to: string } }) {
  const [data, setData] = useState<FinanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return () => {};
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .getFinanceSummary(token, range)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, range]);

  useEffect(() => load(), [load]);

  if (loading && !data) return <div className="text-sm text-slate-500">加载中…</div>;
  if (err) return <div className="text-sm text-rose-600">加载失败：{err}</div>;
  if (!data) return null;

  const marginTone =
    data.grossMarginCny > 0 ? 'pos' : data.grossMarginCny < 0 ? 'neg' : 'neutral';
  const netTone = data.netMarginCny > 0 ? 'pos' : data.netMarginCny < 0 ? 'neg' : 'neutral';

  return (
    <section className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="区间内收入"
          value={fmtCny(data.revenueCny)}
          hint={`${data.orderCount} 笔订单 · 按 OrderItem.amount 合计`}
        />
        <KpiCard
          label="区间内成本"
          value={fmtCny(data.costCny)}
          hint={data.missingCostItemCount > 0 ? `${data.missingCostItemCount} 条目缺成本` : '全部已锁定'}
          tone={data.missingCostItemCount > 0 ? 'warn' : 'neutral'}
        />
        <KpiCard
          label="毛利（含未售空座）"
          value={fmtCny(data.grossMarginCny)}
          hint={`毛利率 ${fmtPct(data.marginPct)}`}
          tone={marginTone}
        />
        <KpiCard
          label="净利（扣空座沉没）"
          value={fmtCny(data.netMarginCny)}
          hint={`空座沉没 ${fmtCny(-data.emptySeatSunkCostCny)}`}
          tone={netTone}
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-medium text-slate-700">按品类拆分</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">品类</th>
              <th className="py-2 text-right font-normal">收入</th>
              <th className="py-2 text-right font-normal">成本</th>
              <th className="py-2 text-right font-normal">毛利</th>
              <th className="py-2 text-right font-normal">毛利率</th>
              <th className="py-2 text-right font-normal">条目</th>
            </tr>
          </thead>
          <tbody>
            {data.categories.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-slate-400">
                  区间内没有订单数据
                </td>
              </tr>
            )}
            {data.categories.map((c) => {
              const tone = c.grossMarginCny < 0 ? 'text-rose-700' : 'text-emerald-700';
              return (
                <tr key={c.kind} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 text-slate-900">
                    {KIND_LABEL[c.kind] ?? c.kind}
                  </td>
                  <td className="py-2 text-right tabular-nums">{fmtCny(c.revenueCny)}</td>
                  <td className="py-2 text-right tabular-nums">{fmtCny(c.costCny)}</td>
                  <td className={`py-2 text-right tabular-nums font-medium ${tone}`}>
                    {fmtCny(c.grossMarginCny)}
                  </td>
                  <td className="py-2 text-right tabular-nums">{fmtPct(c.marginPct)}</td>
                  <td className="py-2 text-right text-slate-500">{c.orderItemCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400">
        说明：收入按 OrderItem.amount 汇总（不含税费/折扣）；成本按 OrderItem.totalCostCny。
        空座沉没成本 = (整包机座位数 − 已售) × 单座分摊成本，仅对填了 charterCostCny 的航班计算。
      </p>
    </section>
  );
}

// ── Flights tab ────────────────────────────────────────────────────────────
function FlightsTab({ token, range }: { token: string; range: { from: string; to: string } }) {
  const [rows, setRows] = useState<FlightPnlRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .getFinanceFlights(token, range)
      .then((d) => {
        if (!cancelled) setRows(d.rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, range]);

  if (loading) return <div className="text-sm text-slate-500">加载中…</div>;
  if (err) return <div className="text-sm text-rose-600">加载失败：{err}</div>;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-medium text-slate-700">按航班 P&L（最多 100 条）</h2>
      <p className="mt-1 text-xs text-slate-500">
        机票成本按"卖出座位 × (包机总成本 / 总座位数)"分摊；空座沉没 = 剩余座位 × 单座分摊。
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">航班</th>
              <th className="py-2 text-left font-normal">出发</th>
              <th className="py-2 text-right font-normal">座位</th>
              <th className="py-2 text-right font-normal">载客率</th>
              <th className="py-2 text-right font-normal">收入</th>
              <th className="py-2 text-right font-normal">包机成本</th>
              <th className="py-2 text-right font-normal">空座沉没</th>
              <th className="py-2 text-right font-normal">净利</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="py-4 text-center text-slate-400">
                  区间内没有航班
                </td>
              </tr>
            )}
            {rows.map((f) => {
              const netTone =
                f.netMarginCny == null
                  ? 'text-slate-400'
                  : f.netMarginCny < 0
                    ? 'text-rose-700'
                    : 'text-emerald-700';
              const loadTone = f.loadPct >= 0.7 ? 'pos' : f.loadPct >= 0.4 ? undefined : 'neg';
              return (
                <tr key={f.scheduleId} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 font-medium text-slate-900">
                    {f.flightNumber}
                    <div className="text-xs text-slate-500">
                      {f.origin} → {f.destination}
                    </div>
                  </td>
                  <td className="py-2 text-slate-600">{fmtDate(f.departureTime)}</td>
                  <td className="py-2 text-right tabular-nums text-slate-600">
                    {f.soldSeats} / {f.totalSeats}
                  </td>
                  <td className="py-2 text-right tabular-nums text-slate-600">
                    <div className="flex items-center justify-end gap-2">
                      <span className="w-12">{fmtPct(f.loadPct)}</span>
                      <div className="w-16">
                        <ProgressBar pct={f.loadPct} tone={loadTone} />
                      </div>
                    </div>
                  </td>
                  <td className="py-2 text-right tabular-nums">{fmtCny(f.revenueCny)}</td>
                  <td className="py-2 text-right tabular-nums text-slate-600">
                    {fmtCny(f.charterCostCny)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-rose-600">
                    {f.emptySeatSunkCostCny == null ? '—' : `-${fmtCny(f.emptySeatSunkCostCny)}`}
                  </td>
                  <td className={`py-2 text-right tabular-nums font-medium ${netTone}`}>
                    {fmtCny(f.netMarginCny)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Orders tab ─────────────────────────────────────────────────────────────
function OrdersTab({ token, range }: { token: string; range: { from: string; to: string } }) {
  const [rows, setRows] = useState<OrderPnlRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .getFinanceOrders(token, range)
      .then((d) => {
        if (!cancelled) setRows(d.rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, range]);

  if (loading) return <div className="text-sm text-slate-500">加载中…</div>;
  if (err) return <div className="text-sm text-rose-600">加载失败：{err}</div>;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-medium text-slate-700">按订单 P&L（最多 100 条）</h2>
      <p className="mt-1 text-xs text-slate-500">
        毛利 = 订单总价 − Σ(OrderItem.totalCostCny)。某一条目没填成本则全单跳过成本统计。
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">订单</th>
              <th className="py-2 text-left font-normal">状态</th>
              <th className="py-2 text-left font-normal">联系人</th>
              <th className="py-2 text-right font-normal">下单时间</th>
              <th className="py-2 text-right font-normal">收入</th>
              <th className="py-2 text-right font-normal">成本</th>
              <th className="py-2 text-right font-normal">毛利</th>
              <th className="py-2 text-right font-normal">毛利率</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="py-4 text-center text-slate-400">
                  区间内没有订单
                </td>
              </tr>
            )}
            {rows.map((o) => {
              const tone =
                o.grossMarginCny == null
                  ? 'text-slate-400'
                  : o.grossMarginCny < 0
                    ? 'text-rose-700'
                    : 'text-emerald-700';
              return (
                <tr key={o.orderId} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 font-medium text-slate-900">
                    {o.orderNumber}
                    <div className="text-xs text-slate-500">{o.itemCount} 项</div>
                  </td>
                  <td className="py-2 text-slate-600">
                    {STATUS_LABEL[o.status] ?? o.status}
                  </td>
                  <td className="py-2 text-slate-600">{o.contactName}</td>
                  <td className="py-2 text-right text-slate-600 text-xs">
                    {fmtDate(o.createdAt)}
                  </td>
                  <td className="py-2 text-right tabular-nums">{fmtCny(o.totalCny)}</td>
                  <td className="py-2 text-right tabular-nums text-slate-600">
                    {o.costCny == null ? (
                      <span className="text-amber-600">缺 {o.missingCostItemCount}</span>
                    ) : (
                      fmtCny(o.costCny)
                    )}
                  </td>
                  <td className={`py-2 text-right tabular-nums font-medium ${tone}`}>
                    {fmtCny(o.grossMarginCny)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-slate-600">
                    {fmtPct(o.marginPct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Monthly tab ────────────────────────────────────────────────────────────
function MonthlyTab({ token }: { token: string }) {
  const [points, setPoints] = useState<MonthlyPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [months, setMonths] = useState(6);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .getFinanceMonthly(token, months)
      .then((d) => {
        if (!cancelled) setPoints(d.points);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, months]);

  const maxRevenue = useMemo(
    () => Math.max(1, ...points.map((p) => p.revenueCny)),
    [points],
  );

  if (loading) return <div className="text-sm text-slate-500">加载中…</div>;
  if (err) return <div className="text-sm text-rose-600">加载失败：{err}</div>;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-700">月度趋势</h2>
        <select
          value={months}
          onChange={(e) => setMonths(parseInt(e.target.value, 10))}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs"
        >
          <option value={3}>最近 3 个月</option>
          <option value={6}>最近 6 个月</option>
          <option value={12}>最近 12 个月</option>
          <option value={24}>最近 24 个月</option>
        </select>
      </div>

      <div className="mt-4 space-y-3">
        {points.length === 0 && (
          <div className="text-sm text-slate-400">没有数据</div>
        )}
        {points.map((p) => {
          const revenuePct = p.revenueCny / maxRevenue;
          const costPct = p.costCny / maxRevenue;
          const marginTone = p.grossMarginCny < 0 ? 'text-rose-700' : 'text-emerald-700';
          return (
            <div key={p.month} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700">{fmtMonth(p.month)}</span>
                <span className="text-slate-500">
                  收入 {fmtCny(p.revenueCny)} · 成本 {fmtCny(p.costCny)} ·{' '}
                  <span className={marginTone}>毛利 {fmtCny(p.grossMarginCny)}</span> ·{' '}
                  {p.orderCount} 单
                </span>
              </div>
              <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="absolute inset-y-0 left-0 bg-emerald-200"
                  style={{ width: `${revenuePct * 100}%` }}
                />
                <div
                  className="absolute inset-y-0 left-0 bg-rose-300"
                  style={{ width: `${costPct * 100}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-slate-400">
        柱图：浅绿 = 收入；红色覆盖部分 = 成本；露出的浅绿尾巴 = 毛利。
      </p>
    </section>
  );
}
