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
 * 成本更新：demo 估算回填脚本已删除（2026-07-17 审计 #19：按售价比例伪造成本是给事故写邀请函）——缺成本一律如实留空/标未知；
 * 真实生产应由 staff 在 Flights/Hotels/Visa/Transfer 管理页录入。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type FinanceSummary,
  type FlightPnlRow,
  type OrderPnlRow,
  type OrderPnlDetail,
  type MonthlyPoint,
  type Hotel,
  type Visa,
  type Transfer,
  type FinanceScheduleRow,
  type CostPeriodDto,
  type CostPeriodWriteInput,
  type UsdFxRateDto,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';
import { UsdRateInput } from '../components/UsdRateInput';

type Tab = 'summary' | 'flights' | 'orders' | 'monthly' | 'costs';

const KIND_LABEL: Record<string, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '地面服务',
  VISA: '签证',
  BUNDLE: '套餐',
  INSURANCE: '保险',
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '出票完成',
  COMPLETED: '已完成',
  PAYMENT_TIMEOUT: '支付超时',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '退款中',
  REFUNDED: '已退款',
  CHANGE_REQUESTED: '改期中',
  CHANGED: '已改期',
  FAILED: '失败',
};

// 订单项类型标签（覆盖收支明细里可能出现的全部 kind，含调价 FEE/DISCOUNT）
const ITEM_KIND_LABEL: Record<string, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '地面服务',
  VISA: '签证',
  BUNDLE: '套餐',
  INSURANCE: '保险',
  GUIDE: '导游',
  UPGRADE_CHANGE: '升舱/改期',
  OVERSALE: '超售',
  FEE: '加价',
  DISCOUNT: '优惠',
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
/** 原币金额+币种合并展示，如 "USD 12,000"；两者都缺时显示 —。 */
function fmtFxAmount(currency: string | null, amount: number | null): string {
  if (currency == null && amount == null) return '—';
  const amt = amount == null ? '—' : amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return currency ? `${currency} ${amt}` : amt;
}
function fmtFxRate(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
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

type FlightOption = {
  id: string;
  label: string;
  flightNumber: string;
  originCode: string;
  destinationCode: string;
};

function reversePeriod(
  period: CostPeriodDto,
  periods: CostPeriodDto[],
  effectiveFrom = period.effectiveFrom,
  effectiveTo = period.effectiveTo,
): CostPeriodDto | null {
  const matches = periods.filter(
    (candidate) =>
      candidate.flightId !== period.flightId &&
      candidate.origin === period.destination &&
      candidate.destination === period.origin &&
      candidate.effectiveFrom === effectiveFrom &&
      candidate.effectiveTo === effectiveTo,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function reverseFlightOption(flightId: string, options: FlightOption[]): FlightOption | null {
  const current = options.find((option) => option.id === flightId);
  if (!current) return null;
  const matches = options.filter(
    (option) =>
      option.id !== flightId &&
      option.originCode === current.destinationCode &&
      option.destinationCode === current.originCode,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function reverseSchedule(
  row: FinanceScheduleRow,
  rows: FinanceScheduleRow[],
): FinanceScheduleRow | null {
  // 「同一天」按出发地时区的当地出发日比较——本线澳门/岘港航班常在 UTC 午夜附近起飞，
  // 用 UTC 日期切片会把去/回程劈到两天，配错或配不上。
  const matches = rows.filter(
    (candidate) =>
      candidate.scheduleId !== row.scheduleId &&
      candidate.localDepartureDate === row.localDepartureDate &&
      candidate.originCode === row.destinationCode &&
      candidate.destinationCode === row.originCode,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function UsdCostInput({
  value,
  onChange,
  placeholder,
  className,
  allowNegative = false,
  disabled = false,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  placeholder?: string;
  className: string;
  allowNegative?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex items-center gap-0.5">
      <NumberInput
        className={className}
        step={0.01}
        value={value}
        placeholder={placeholder}
        allowNegative={allowNegative}
        disabled={disabled}
        onChange={onChange}
      />
      <button
        type="button"
        aria-label="美元换算"
        title="按美元×汇率折算填入(¥)"
        className="rounded border border-slate-200 px-1 py-0.5 text-xs font-medium text-brand hover:bg-brand-50"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        $
      </button>
      {open && (
        <span className="absolute right-0 top-full z-20 mt-1 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <UsdRateInput onFill={onChange} />
        </span>
      )}
    </span>
  );
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
          : 'text-ink';
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-muted">{hint}</div>}
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
          <h1 className="page-title">财务</h1>
          <p className="page-sub">
            收入 / 成本 / 毛利按航班和订单实时核算 ·{' '}
            <span className="text-amber-700">⚠ 财务数据敏感，访问会记录到审计日志</span>
          </p>
        </div>
        <div className="flex items-end gap-2">
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
              onClick={() => {
                setFrom(daysAgoStr(29));
                setTo(todayStr());
              }}
              className="btn-secondary px-2 py-1 text-xs"
            >
              最近 30 天
            </button>
            <button
              type="button"
              onClick={() => {
                setFrom(daysAgoStr(89));
                setTo(todayStr());
              }}
              className="btn-secondary px-2 py-1 text-xs"
            >
              最近 90 天
            </button>
          </div>
          <ExportButton token={token} range={range} />
          <ExportByFlightButton token={token} range={range} />
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
        <TabBtn active={tab === 'costs'} onClick={() => setTab('costs')}>
          成本维护
        </TabBtn>
      </nav>

      {tab === 'summary' && <SummaryTab token={token} range={range} />}
      {tab === 'flights' && <FlightsTab token={token} range={range} />}
      {tab === 'orders' && <OrdersTab token={token} range={range} />}
      {tab === 'monthly' && <MonthlyTab token={token} />}
      {tab === 'costs' && <CostsTab token={token} />}
    </div>
  );
}

// ── Export button ──────────────────────────────────────────────────────────
function ExportButton({ token, range }: { token: string; range: { from: string; to: string } }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onClick(): Promise<void> {
    if (!token || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const blob = await api.downloadFinanceExport(token, range);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `财务核对_${range.from}_${range.to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="btn-primary"
        title="每位乘客一行的全量明细汇总"
      >
        {busy ? '导出中…' : '⬇ 全量汇总（按乘客）'}
      </button>
      {err && <span className="text-xs text-rose-600">{err}</span>}
    </div>
  );
}

// ── Export by flight button ────────────────────────────────────────────────
function ExportByFlightButton({ token, range }: { token: string; range: { from: string; to: string } }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onClick(): Promise<void> {
    if (!token || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const blob = await api.downloadFinanceExportByFlight(token, range);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `按航班_${range.from}_${range.to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="btn-secondary"
        title="按航班分组汇总，每个航班一块"
      >
        {busy ? '导出中…' : '⬇ 按航班分组'}
      </button>
      {err && <span className="text-xs text-rose-600">{err}</span>}
    </div>
  );
}

// ── Costs maintenance tab ────────────────────────────────────────────────────
function CostsTab({ token }: { token: string }) {
  return (
    <section className="space-y-5">
      <UsdFxRateEditor token={token} />

      <FlightCostPeriodsEditor token={token} />

      <FlightScheduleCostEditors token={token} />

      <ProductCostEditors token={token} />

      <p className="text-xs text-ink-muted">
        说明：成本统一人民币。「班次」= 某一天的一趟具体航班（同一航班号不同出发日期就是不同班次）。航班按班次维护「包机/机场税/燃油/旺季附加/机型调整/起降折扣」，系统按财务口径实时算出单座成本（包机费 ÷ 全部座位）和空座成本。班次留空则回退到所匹配「周期」的默认值。
      </p>
    </section>
  );
}

// ── 美金汇率（按生效日）──────────────────────────────────────────────────────
/**
 * 财务维护「某日起 USD→CNY 用哪个汇率」。只填生效日、不填结束日：
 * 区间由下一条的生效日隐含，因此无空洞、无重叠。
 * 签证台设金额时自动带出当日生效汇率，折算值**当场固化**在任务上——
 * 之后改这张表不会追溯已入账的旧任务。
 */
function UsdFxRateEditor({ token }: { token: string }) {
  const [rates, setRates] = useState<UsdFxRateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [newFrom, setNewFrom] = useState(todayStr());
  const [newRate, setNewRate] = useState<number | null>(null);
  const [newNote, setNewNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    if (!token) return () => {};
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .listUsdFxRates(token)
      .then((d) => {
        if (!cancelled) setRates(d.rates);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '汇率列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => load(), [load]);

  // 当前生效的那条 = 生效日 ≤ 今天的最新一条（列表已按生效日倒序）
  const current = useMemo(() => {
    const today = todayStr();
    return rates.find((r) => r.effectiveFrom <= today) ?? null;
  }, [rates]);

  async function save(): Promise<void> {
    if (newRate == null || newRate <= 0) {
      setErr('汇率需大于 0');
      return;
    }
    // 同一生效日已有记录时按覆盖处理（后端按生效日幂等 upsert）
    const existing = rates.find((r) => r.effectiveFrom === newFrom);
    if (
      existing &&
      !confirm(`${newFrom} 已有汇率 ${existing.rate}，确认覆盖为 ${newRate}？`)
    ) {
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.upsertUsdFxRate(token, {
        effectiveFrom: newFrom,
        rate: newRate,
        note: newNote.trim() === '' ? null : newNote.trim(),
      });
      setNewRate(null);
      setNewNote('');
      load();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">美金汇率（按生效日）</h2>
        {current && (
          <span className="text-xs text-ink-soft">
            当前生效：<span className="font-semibold text-ink nums">{current.rate}</span>
            （{current.effectiveFrom} 起）
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        只填生效日，不填结束日 —— 区间由下一条的生效日隐含，不会有空洞或重叠。签证台设金额时自动带出当日汇率。
        <span className="font-medium text-amber-700">
          新汇率只影响此后的折算，已入账任务不受影响。
        </span>
      </p>

      {err && <div className="mt-2 text-xs text-rose-600">{err}</div>}

      {/* 新增 / 覆盖一行 */}
      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
        <div>
          <label className="label" htmlFor="fx-effective-from">
            生效日
          </label>
          <input
            id="fx-effective-from"
            type="date"
            className="input py-1.5 text-sm"
            value={newFrom}
            disabled={saving}
            onChange={(e) => setNewFrom(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="fx-rate">
            汇率（1 美金 = ? 人民币）
          </label>
          <NumberInput
            id="fx-rate"
            step={0.0001}
            value={newRate}
            onChange={setNewRate}
            disabled={saving}
            className="w-32 rounded-lg border border-slate-200 px-2 py-1.5 text-right text-sm nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
          />
        </div>
        <div className="min-w-[10rem] flex-1">
          <label className="label" htmlFor="fx-note">
            备注（选填）
          </label>
          <input
            id="fx-note"
            type="text"
            className="input py-1.5 text-sm"
            placeholder="如 月初挂牌"
            value={newNote}
            disabled={saving}
            onChange={(e) => setNewNote(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn-primary py-1.5"
          onClick={() => void save()}
          disabled={saving || newRate == null}
        >
          {saving ? '保存中…' : '保存汇率'}
        </button>
      </div>

      {loading ? (
        <div className="mt-3 text-sm text-slate-500">加载汇率…</div>
      ) : rates.length === 0 ? (
        <div className="mt-3 text-sm text-ink-muted">尚未维护任何汇率（签证台的汇率格需手填）</div>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">生效日</th>
              <th className="py-2 text-right font-normal">汇率</th>
              <th className="py-2 text-left font-normal">备注</th>
              <th className="py-2 text-left font-normal">最近更新</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="py-2 text-slate-900 nums">
                  {r.effectiveFrom}
                  {current?.id === r.id && <span className="badge-success ml-2">当前生效</span>}
                </td>
                <td className="py-2 text-right tabular-nums text-slate-900">{r.rate}</td>
                <td className="py-2 text-ink-soft">{r.note ?? '—'}</td>
                <td className="py-2 text-xs text-ink-muted">
                  {fmtDate(r.updatedAt)}
                  {r.updatedBy && ` · ${r.updatedBy.slice(0, 8)}…`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── 航班成本周期 ─────────────────────────────────────────────────────────────
function FlightCostPeriodsEditor({ token }: { token: string }) {
  const [periods, setPeriods] = useState<CostPeriodDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [flightOptions, setFlightOptions] = useState<FlightOption[]>([]);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(() => {
    if (!token) return () => {};
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .listCostPeriods(token)
      .then((d) => {
        if (cancelled) return;
        const sorted = [...d.periods].sort((a, b) => {
          if (a.flightNumber !== b.flightNumber) return a.flightNumber.localeCompare(b.flightNumber);
          return a.effectiveFrom.localeCompare(b.effectiveFrom);
        });
        setPeriods(sorted);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '周期列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 拉航班下拉：用 listFinanceSchedules 提取唯一 flightId/flightNumber
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .listFinanceSchedules(token)
      .then((d) => {
        if (cancelled) return;
        const map = new Map<string, FlightOption>();
        for (const r of d.schedules) {
          if (!map.has(r.flightId)) {
            map.set(r.flightId, {
              id: r.flightId,
              label: `${r.flightNumber} · ${r.origin}→${r.destination}`,
              flightNumber: r.flightNumber,
              originCode: r.originCode,
              destinationCode: r.destinationCode,
            });
          }
        }
        const opts = Array.from(map.values())
          .sort((a, b) => a.label.localeCompare(b.label));
        setFlightOptions(opts);
      })
      .catch(() => {
        // 静默：下拉空时表单按钮会禁用
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => load(), [load]);

  async function onDelete(id: string): Promise<void> {
    if (!confirm('确认删除该周期？删除后该航班该日期段会回退到「无默认」。')) return;
    try {
      await api.deleteCostPeriod(token, id);
      load();
    } catch (e: unknown) {
      alert(e instanceof ApiError ? e.message : '删除失败');
    }
  }

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            航班成本周期（按 航班 × 日期段 定包机/机场税/4 个新成本字段；班次可单独覆盖）
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            为某一航班在某段日期定一组默认成本。班次有自己的「覆盖」值就用覆盖，否则回退到所匹配周期。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowNew((v) => !v)}
          className={showNew ? 'btn-secondary py-1.5 text-xs' : 'btn-primary py-1.5 text-xs'}
        >
          {showNew ? '× 取消' : '+ 新增周期'}
        </button>
      </div>

      {showNew && (
        <CostPeriodNewForm
          token={token}
          flightOptions={flightOptions}
          onSaved={() => {
            setShowNew(false);
            load();
          }}
          onCancel={() => setShowNew(false)}
        />
      )}

      {loading ? (
        <div className="mt-3 text-sm text-slate-500">加载周期…</div>
      ) : err ? (
        <div className="mt-3 text-sm text-rose-600">{err}</div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-14 z-10 bg-surface text-xs uppercase tracking-wide text-ink-muted">
              <tr className="border-b border-slate-200">
                <th className="min-w-[76px] py-2 text-left font-normal">航班号</th>
                <th className="min-w-[104px] py-2 text-left font-normal">路线</th>
                <th className="min-w-[104px] py-2 text-left font-normal">起始</th>
                <th className="min-w-[104px] py-2 text-left font-normal">结束</th>
                <th className="min-w-[104px] py-2 text-right font-normal">包机(¥·整包)</th>
                <th className="min-w-[104px] py-2 text-right font-normal">机场税去(¥/座)</th>
                <th className="min-w-[104px] py-2 text-right font-normal">机场税回(¥/座)</th>
                <th className="min-w-[88px] py-2 text-right font-normal">燃油(¥/座)</th>
                <th className="min-w-[96px] py-2 text-right font-normal">旺季附加(¥/座)</th>
                <th className="min-w-[96px] py-2 text-right font-normal">机型调整(¥/座)</th>
                <th className="min-w-[132px] py-2 text-right font-normal">起降折扣/机场补贴(¥/座)</th>
                <th className="min-w-[112px] py-2 text-right font-normal">原币金额(币种)</th>
                <th className="min-w-[88px] py-2 text-right font-normal">汇率</th>
                <th className="min-w-[104px] py-2 text-left font-normal">折算/付款日</th>
                <th className="min-w-[132px] py-2 text-left font-normal">备注</th>
                <th className="min-w-[110px] py-2 text-right font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {periods.length === 0 && (
                <tr>
                  <td colSpan={16} className="py-4 text-center text-ink-muted">
                    暂无周期 · 点击右上「+ 新增周期」开始
                  </td>
                </tr>
              )}
              {periods.map((p) => (
                <CostPeriodRow
                  key={p.id}
                  period={p}
                  periods={periods}
                  token={token}
                  onSaved={load}
                  onDelete={() => onDelete(p.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CostPeriodNewForm({
  token,
  flightOptions,
  onSaved,
  onCancel,
}: {
  token: string;
  flightOptions: FlightOption[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [flightId, setFlightId] = useState<string>(flightOptions[0]?.id ?? '');
  const [from, setFrom] = useState<string>(todayStr());
  const [to, setTo] = useState<string>(todayStr());
  const [charter, setCharter] = useState<number | null>(null);
  const [taxDep, setTaxDep] = useState<number | null>(null);
  const [taxArr, setTaxArr] = useState<number | null>(null);
  const [fuel, setFuel] = useState<number | null>(null);
  const [peak, setPeak] = useState<number | null>(null);
  const [aircraft, setAircraft] = useState<number | null>(null);
  const [takeoff, setTakeoff] = useState<number | null>(null);
  const [note, setNote] = useState<string>('');
  // A2 汇率四元组（选填审计留痕）：包机原币/金额/汇率/折算日；CNY 仍是入账口径
  const [fxCurrency, setFxCurrency] = useState('');
  const [fxAmount, setFxAmount] = useState<number | null>(null);
  const [fxRate, setFxRate] = useState<number | null>(null);
  const [fxDate, setFxDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [syncPair, setSyncPair] = useState(true);

  const pairedFlight = reverseFlightOption(flightId, flightOptions);

  // 默认下拉同步
  useEffect(() => {
    if (!flightId && flightOptions.length > 0) {
      setFlightId(flightOptions[0]!.id);
    }
  }, [flightOptions, flightId]);

  async function submit(): Promise<void> {
    if (!flightId) {
      setErr('请选择航班');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body: CostPeriodWriteInput = {
        flightId,
        effectiveFrom: from,
        effectiveTo: to,
        charterCostCny: charter,
        airportTaxDepCny: taxDep,
        airportTaxArrCny: taxArr,
        fuelCostCny: fuel,
        peakSurchargeCny: peak,
        aircraftAdjustCny: aircraft,
        takeoffDiscountCny: takeoff,
        charterSourceCurrency: fxCurrency.trim() === '' ? null : fxCurrency.trim().toUpperCase(),
        charterSourceAmount: fxAmount,
        charterFxRate: fxRate,
        charterFxDate: fxDate === '' ? null : fxDate,
        note: note.trim() === '' ? null : note.trim(),
      };
      await api.createCostPeriod(token, body);
      if (syncPair && pairedFlight) {
        try {
          await api.createCostPeriod(token, { ...body, flightId: pairedFlight.id });
        } catch (e: unknown) {
          setErr(
            `已保存 ${flightOptions.find((option) => option.id === flightId)?.flightNumber ?? flightId}，同步 ${pairedFlight.flightNumber} 失败：${e instanceof ApiError ? e.message : '保存失败'}`,
          );
          return;
        }
      }
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '创建失败');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'rounded-lg border border-slate-200 px-2 py-1 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
  const numCls = 'w-24 rounded-lg border border-slate-200 px-1.5 py-0.5 text-right text-xs nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-canvas p-3">
      {/* 字段顺序对齐下方表格列序：航班/起始/结束 → 金额组 → 汇率组 → 备注，
          避免"标题行与选填日期分隔开、看不出下一格填什么"（财务反馈） */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-xs text-ink-soft">
          航班
          <select
            value={flightId}
            onChange={(e) => setFlightId(e.target.value)}
            className={`mt-1 block w-full ${inputCls}`}
          >
            {flightOptions.length === 0 && <option value="">（无可用航班）</option>}
            {flightOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-soft">
          起始日
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={`mt-1 block w-full ${inputCls}`}
          />
        </label>
        <label className="text-xs text-ink-soft">
          结束日
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={`mt-1 block w-full ${inputCls}`}
          />
        </label>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <label className="text-xs text-ink-soft">
          包机总额(¥·整包)
          <UsdCostInput
            className={`mt-1 block w-full ${numCls}`}
            value={charter}
            onChange={setCharter}
          />
        </label>
        <label className="text-xs text-ink-soft">
          去程机场税(¥/座)
          <UsdCostInput
            className={`mt-1 block w-full ${numCls}`}
            value={taxDep}
            onChange={setTaxDep}
          />
        </label>
        <label className="text-xs text-ink-soft">
          返程机场税(¥/座)
          <UsdCostInput
            className={`mt-1 block w-full ${numCls}`}
            value={taxArr}
            onChange={setTaxArr}
          />
        </label>
        <label className="text-xs text-ink-soft">
          燃油附加(¥/座)
          <UsdCostInput
            className={`mt-1 block w-full ${numCls}`}
            value={fuel}
            onChange={setFuel}
          />
        </label>
        <label className="text-xs text-ink-soft">
          旺季附加(¥/座)
          <UsdCostInput
            className={`mt-1 block w-full ${numCls}`}
            value={peak}
            onChange={setPeak}
          />
        </label>
        <label className="text-xs text-ink-soft">
          机型调整(¥/座)
          <UsdCostInput
            className={`mt-1 block w-full ${numCls}`}
            allowNegative
            value={aircraft}
            onChange={setAircraft}
          />
        </label>
        <label className="text-xs text-ink-soft">
          起降折扣(¥/座，机场补贴)
          <UsdCostInput
            className={`mt-1 block w-full ${numCls}`}
            allowNegative
            value={takeoff}
            onChange={setTakeoff}
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        提示：「包机总额」是跟航司结算的整包价（一次性）；其余几项都按「每座」填。机型调整/起降折扣可填负数（少收或补贴）。
      </p>
      {/* A2 汇率四元组（选填审计留痕）：记下包机 CNY 数是按哪天哪个汇率从哪种原币折来的；
          CNY 仍是入账口径，这 4 项在下方列表/行内编辑均已回显、可改 */}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-xs text-ink-soft">
          包机原币种（选填）
          <input type="text" maxLength={3} placeholder="USD/VND/MOP" value={fxCurrency}
            onChange={(e) => setFxCurrency(e.target.value.toUpperCase())}
            className={`mt-1 block w-full ${inputCls}`} />
        </label>
        <label className="text-xs text-ink-soft">
          原币金额（选填）
          <input type="number" min={0} value={fxAmount ?? ''} placeholder="如 96000"
            onChange={(e) => setFxAmount(e.target.value === '' ? null : Number(e.target.value))}
            className={`mt-1 block w-full ${inputCls}`} />
        </label>
        <label className="text-xs text-ink-soft">
          折算汇率（原币→CNY，选填）
          <input type="number" min={0} step="0.000001" value={fxRate ?? ''} placeholder="如 7.25"
            onChange={(e) => setFxRate(e.target.value === '' ? null : Number(e.target.value))}
            className={`mt-1 block w-full ${inputCls}`} />
        </label>
        <label className="text-xs text-ink-soft">
          折算/付款日（选填）
          <input type="date" value={fxDate} onChange={(e) => setFxDate(e.target.value)}
            className={`mt-1 block w-full ${inputCls}`} />
        </label>
        <label className="text-xs text-ink-soft">
          备注
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="可空"
            className={`mt-1 block w-full ${inputCls}`}
          />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <label
          className="flex items-center gap-1 text-xs text-ink-soft"
          title={pairedFlight ? `将同步到 ${pairedFlight.flightNumber}` : '未找到当日配对班次'}
        >
          <input
            type="checkbox"
            checked={syncPair && pairedFlight != null}
            disabled={pairedFlight == null}
            onChange={(e) => setSyncPair(e.target.checked)}
          />
          同步到配对航班
        </label>
        {pairedFlight == null && <span className="text-xs text-amber-600">未找到当日配对班次</span>}
        <button
          type="button"
          onClick={submit}
          disabled={saving || !flightId}
          className="btn-primary py-1.5"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn-secondary py-1.5"
        >
          取消
        </button>
        {err && <span className="text-xs text-rose-600">{err}</span>}
      </div>
    </div>
  );
}

function CostPeriodRow({
  period,
  periods,
  token,
  onSaved,
  onDelete,
}: {
  period: CostPeriodDto;
  periods: CostPeriodDto[];
  token: string;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [from, setFrom] = useState<string>(period.effectiveFrom);
  const [to, setTo] = useState<string>(period.effectiveTo);
  const [charter, setCharter] = useState<number | null>(period.charterCostCny);
  const [taxDep, setTaxDep] = useState<number | null>(period.airportTaxDepCny);
  const [taxArr, setTaxArr] = useState<number | null>(period.airportTaxArrCny);
  const [fuel, setFuel] = useState<number | null>(period.fuelCostCny);
  const [peak, setPeak] = useState<number | null>(period.peakSurchargeCny);
  const [aircraft, setAircraft] = useState<number | null>(period.aircraftAdjustCny);
  const [takeoff, setTakeoff] = useState<number | null>(period.takeoffDiscountCny);
  // A2 汇率四元组（选填审计留痕）：包机原币/金额/汇率/折算日；CNY 仍是入账口径
  const [fxCurrency, setFxCurrency] = useState<string>(period.charterSourceCurrency ?? '');
  const [fxAmount, setFxAmount] = useState<number | null>(period.charterSourceAmount);
  const [fxRate, setFxRate] = useState<number | null>(period.charterFxRate);
  const [fxDate, setFxDate] = useState<string>(period.charterFxDate ?? '');
  const [note, setNote] = useState<string>(period.note ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [syncPair, setSyncPair] = useState(true);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  // 用周期「原始」日期段找反向配对——若用编辑中的 from/to，对方还是旧日期会配不上，
  // 同步勾选会静默失效只写单边；保存时把编辑后的日期段同时写进双方。
  const pairedPeriod = reversePeriod(period, periods);

  function reset(): void {
    setFrom(period.effectiveFrom);
    setTo(period.effectiveTo);
    setCharter(period.charterCostCny);
    setTaxDep(period.airportTaxDepCny);
    setTaxArr(period.airportTaxArrCny);
    setFuel(period.fuelCostCny);
    setPeak(period.peakSurchargeCny);
    setAircraft(period.aircraftAdjustCny);
    setTakeoff(period.takeoffDiscountCny);
    setFxCurrency(period.charterSourceCurrency ?? '');
    setFxAmount(period.charterSourceAmount);
    setFxRate(period.charterFxRate);
    setFxDate(period.charterFxDate ?? '');
    setNote(period.note ?? '');
    setErr(null);
    setSaveNotice(null);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setErr(null);
    setSaveNotice(null);
    try {
      const body: Partial<Omit<CostPeriodWriteInput, 'flightId'>> = {
        effectiveFrom: from,
        effectiveTo: to,
        charterCostCny: charter,
        airportTaxDepCny: taxDep,
        airportTaxArrCny: taxArr,
        fuelCostCny: fuel,
        peakSurchargeCny: peak,
        aircraftAdjustCny: aircraft,
        takeoffDiscountCny: takeoff,
        charterSourceCurrency: fxCurrency.trim() === '' ? null : fxCurrency.trim().toUpperCase(),
        charterSourceAmount: fxAmount,
        charterFxRate: fxRate,
        charterFxDate: fxDate === '' ? null : fxDate,
        note: note.trim() === '' ? null : note.trim(),
      };
      await api.updateCostPeriod(token, period.id, body);
      if (syncPair && pairedPeriod) {
        try {
          await api.updateCostPeriod(token, pairedPeriod.id, body);
        } catch (e: unknown) {
          setSaveNotice(
            '已保存 ' + period.flightNumber + '，同步 ' + pairedPeriod.flightNumber + ' 失败：' +
              (e instanceof ApiError ? e.message : '保存失败'),
          );
          setEditing(false);
          onSaved();
          return;
        }
        setSaveNotice('已保存 ' + period.flightNumber + '，并同步保存 ' + pairedPeriod.flightNumber);
      } else {
        setSaveNotice('已保存 ' + period.flightNumber);
      }
      setEditing(false);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  // 宽度与上方 <thead> 各列 min-width 对齐，减少「改」进出编辑态时的列宽跳动
  const numCls = 'w-[92px] rounded-lg border border-slate-200 px-1.5 py-0.5 text-right text-xs nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
  const dateCls = 'w-[96px] rounded-lg border border-slate-200 px-1.5 py-0.5 text-xs focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
  const textCls = 'w-[124px] rounded-lg border border-slate-200 px-1.5 py-0.5 text-xs focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';

  if (!editing) {
    return (
      <tr className="border-b border-slate-100 last:border-0">
        <td className="py-2 font-medium text-slate-900">{period.flightNumber}</td>
        <td className="py-2 text-slate-600">{period.origin} → {period.destination}</td>
        <td className="py-2 text-slate-600">{period.effectiveFrom}</td>
        <td className="py-2 text-slate-600">{period.effectiveTo}</td>
        <td className="py-2 text-right tabular-nums">{fmtCny(period.charterCostCny)}</td>
        <td className="py-2 text-right tabular-nums">{fmtCny(period.airportTaxDepCny)}</td>
        <td className="py-2 text-right tabular-nums">{fmtCny(period.airportTaxArrCny)}</td>
        <td className="py-2 text-right tabular-nums">{fmtCny(period.fuelCostCny)}</td>
        <td className="py-2 text-right tabular-nums">{fmtCny(period.peakSurchargeCny)}</td>
        <td className="py-2 text-right tabular-nums">{fmtCny(period.aircraftAdjustCny)}</td>
        <td className="py-2 text-right tabular-nums">{fmtCny(period.takeoffDiscountCny)}</td>
        <td className="py-2 text-right tabular-nums text-xs">{fmtFxAmount(period.charterSourceCurrency, period.charterSourceAmount)}</td>
        <td className="py-2 text-right tabular-nums text-xs">{fmtFxRate(period.charterFxRate)}</td>
        <td className="py-2 text-xs text-ink-muted">{period.charterFxDate ?? '—'}</td>
        <td className="py-2 text-xs text-ink-muted">{period.note ?? '—'}</td>
        <td className="py-2 text-right">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="btn-secondary px-2 py-1 text-xs"
          >
            改
          </button>{' '}
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg border border-rose-200 px-2 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
          >
            删
          </button>
          {saveNotice && <div className={`text-xs mt-0.5 ${saveNotice.includes('失败') ? 'text-rose-600' : 'text-emerald-600'}`}>{saveNotice}</div>}
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-slate-100 last:border-0 bg-brand-50/50">
      <td className="py-2 font-medium text-ink">{period.flightNumber}</td>
      <td className="py-2 text-ink-soft">{period.origin} → {period.destination}</td>
      <td className="py-2"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={dateCls} /></td>
      <td className="py-2"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={dateCls} /></td>
      <td className="py-2 text-right"><UsdCostInput className={numCls} value={charter} onChange={setCharter} /></td>
      <td className="py-2 text-right"><UsdCostInput className={numCls} value={taxDep} onChange={setTaxDep} /></td>
      <td className="py-2 text-right"><UsdCostInput className={numCls} value={taxArr} onChange={setTaxArr} /></td>
      <td className="py-2 text-right"><UsdCostInput className={numCls} value={fuel} onChange={setFuel} /></td>
      <td className="py-2 text-right"><UsdCostInput className={numCls} value={peak} onChange={setPeak} /></td>
      <td className="py-2 text-right"><UsdCostInput className={numCls} allowNegative value={aircraft} onChange={setAircraft} /></td>
      <td className="py-2 text-right"><UsdCostInput className={numCls} allowNegative value={takeoff} onChange={setTakeoff} /></td>
      <td className="py-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <input
            type="text"
            maxLength={3}
            value={fxCurrency}
            onChange={(e) => setFxCurrency(e.target.value.toUpperCase())}
            placeholder="币种"
            className="w-12 rounded-lg border border-slate-200 px-1 py-0.5 text-right text-xs uppercase focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
          />
          <input
            type="number"
            min={0}
            value={fxAmount ?? ''}
            placeholder="金额"
            onChange={(e) => setFxAmount(e.target.value === '' ? null : Number(e.target.value))}
            className={numCls}
          />
        </div>
      </td>
      <td className="py-2 text-right">
        <input
          type="number"
          min={0}
          step="0.000001"
          value={fxRate ?? ''}
          placeholder="汇率"
          onChange={(e) => setFxRate(e.target.value === '' ? null : Number(e.target.value))}
          className={numCls}
        />
      </td>
      <td className="py-2">
        <input type="date" value={fxDate} onChange={(e) => setFxDate(e.target.value)} className={dateCls} />
      </td>
      <td className="py-2"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} className={textCls} placeholder="备注" /></td>
      <td className="py-2 text-right">
        <label
          className="mb-1 flex items-center justify-end gap-1 text-xs text-ink-soft"
          title={pairedPeriod ? '将同步到 ' + pairedPeriod.flightNumber + ' 的同日期段周期' : '未找到配对航班的同日期段周期'}
        >
          <input
            type="checkbox"
            checked={syncPair && pairedPeriod != null}
            disabled={pairedPeriod == null}
            onChange={(e) => setSyncPair(e.target.checked)}
          />
          同步到配对航班的同日期段周期
        </label>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="btn-primary px-2 py-1 text-xs"
        >
          {saving ? '…' : '保存'}
        </button>{' '}
        <button
          type="button"
          onClick={() => { reset(); setEditing(false); }}
          className="btn-secondary px-2 py-1 text-xs"
        >
          取消
        </button>
        {err && <div className="text-xs text-rose-600 mt-0.5">{err}</div>}
        {saveNotice && <div className={`text-xs mt-0.5 ${saveNotice.includes('失败') ? 'text-rose-600' : 'text-emerald-600'}`}>{saveNotice}</div>}
      </td>
    </tr>
  );
}

// ── 航班成本（按班次）─ 编辑包机/机场税，并实时显示「单座成本(÷总座)」─────────
function FlightScheduleCostEditors({ token }: { token: string }) {
  const [rows, setRows] = useState<FinanceScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return () => {};
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .listFinanceSchedules(token)
      .then((d) => {
        if (!cancelled) setRows(d.schedules);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '航班成本列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => load(), [load]);

  return (
    <div className="card">
      <h2 className="text-sm font-semibold text-ink">航班成本（按班次）</h2>
      <p className="mt-1 text-xs text-slate-500">
        编辑包机/机场税/燃油/旺季附加/机型调整/起降折扣。空白时显示周期默认值（灰字 placeholder）。单座成本按财务口径计算：包机总额 ÷ 全部座位，空座成本单列。
      </p>

      {loading ? (
        <div className="mt-3 text-sm text-slate-500">加载航班成本…</div>
      ) : err ? (
        <div className="mt-3 text-sm text-rose-600">{err}</div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-14 z-10 bg-surface text-xs uppercase tracking-wide text-ink-muted">
              <tr className="border-b border-slate-200">
                <th className="min-w-[76px] py-2 text-left font-normal">航班号</th>
                <th className="min-w-[104px] py-2 text-left font-normal">路线</th>
                <th className="min-w-[112px] py-2 text-left font-normal">出发日期</th>
                <th className="min-w-[104px] py-2 text-right font-normal">包机(¥·整包)</th>
                <th className="min-w-[104px] py-2 text-right font-normal">机场税去(¥/座)</th>
                <th className="min-w-[104px] py-2 text-right font-normal">机场税回(¥/座)</th>
                <th className="min-w-[88px] py-2 text-right font-normal">燃油(¥/座)</th>
                <th className="min-w-[96px] py-2 text-right font-normal">旺季附加(¥/座)</th>
                <th className="min-w-[96px] py-2 text-right font-normal">机型调整(¥/座)</th>
                <th className="min-w-[132px] py-2 text-right font-normal">起降折扣/机场补贴(¥/座)</th>
                <th className="min-w-[88px] py-2 text-right font-normal">已售/总座</th>
                <th className="min-w-[140px] py-2 text-right font-normal text-blue-700">
                  单座成本(÷总座)(¥)
                  <span className="block font-normal normal-case tracking-normal text-ink-muted">= 包机总额 ÷ 全部座位</span>
                </th>
                <th className="min-w-[104px] py-2 text-right font-normal">空座成本(¥)</th>
                <th className="min-w-[160px] py-2 text-right font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={14} className="py-4 text-center text-ink-muted">
                    暂无班次
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <FlightScheduleCostRow
                  key={`${r.scheduleId}-${r.costLocked ? 'locked' : 'open'}`}
                  row={r}
                  pairedRow={reverseSchedule(r, rows)}
                  token={token}
                  onSaved={load}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FlightScheduleCostRow({
  row,
  pairedRow,
  token,
  onSaved,
}: {
  row: FinanceScheduleRow;
  pairedRow: FinanceScheduleRow | null;
  token: string;
  onSaved: () => void;
}) {
  const [charter, setCharter] = useState<number | null>(row.charterCostCnyOverride);
  const [taxDep, setTaxDep] = useState<number | null>(row.airportTaxDepCnyOverride);
  const [taxArr, setTaxArr] = useState<number | null>(row.airportTaxArrCnyOverride);
  const [fuel, setFuel] = useState<number | null>(row.fuelCostCnyOverride);
  const [peak, setPeak] = useState<number | null>(row.peakSurchargeCnyOverride);
  const [aircraft, setAircraft] = useState<number | null>(row.aircraftAdjustCnyOverride);
  const [takeoff, setTakeoff] = useState<number | null>(row.takeoffDiscountCnyOverride);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [syncPair, setSyncPair] = useState(true);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  const [lockErr, setLockErr] = useState<string | null>(null);

  const inputCls = 'w-[92px] rounded-lg border border-slate-200 px-1.5 py-0.5 text-right text-xs nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';

  async function toggleCostLock(): Promise<void> {
    if (!token || lockBusy) return;
    const nextLocked = !row.costLocked;
    if (
      nextLocked &&
      !window.confirm(
        `将按当前生效值固化并锁定 ${row.flightNumber} ${row.localDepartureDate} 的成本？锁定后修改需先解锁。`,
      )
    ) {
      return;
    }
    if (!nextLocked && !window.confirm(`确定解锁 ${row.flightNumber} ${row.localDepartureDate} 的成本吗？`)) {
      return;
    }
    setLockBusy(true);
    setLockErr(null);
    try {
      await api.setFlightScheduleCostLock(token, row.scheduleId, nextLocked);
      onSaved();
    } catch (e: unknown) {
      setLockErr(e instanceof ApiError ? e.message : '锁定状态更新失败');
    } finally {
      setLockBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!token || row.costLocked) return;
    setSaving(true);
    setSaveErr(null);
    setSaveNotice(null);
    try {
      const body = {
        charterCostCny: charter,
        airportTaxDepCny: taxDep,
        airportTaxArrCny: taxArr,
        fuelCostCny: fuel,
        peakSurchargeCny: peak,
        aircraftAdjustCny: aircraft,
        takeoffDiscountCny: takeoff,
      };
      await api.patchFlightScheduleCost(token, row.scheduleId, body);
      if (syncPair && pairedRow) {
        if (pairedRow.costLocked) {
          setSaveNotice(`已保存 ${row.flightNumber}，配对班次已锁定，未同步`);
          onSaved();
          return;
        }
        try {
          await api.patchFlightScheduleCost(token, pairedRow.scheduleId, body);
        } catch (e: unknown) {
          if (e instanceof ApiError && e.status === 409) {
            setSaveNotice(`已保存 ${row.flightNumber}，配对班次已锁定，未同步`);
            onSaved();
            return;
          }
          setSaveNotice(
            '已保存 ' + row.flightNumber + '，同步 ' + pairedRow.flightNumber + ' 失败：' +
              (e instanceof ApiError ? e.message : '保存失败'),
          );
          onSaved();
          return;
        }
        setSaveNotice('已保存 ' + row.flightNumber + '，并同步保存 ' + pairedRow.flightNumber);
      } else {
        setSaveNotice('已保存 ' + row.flightNumber);
      }
      onSaved();
    } catch (e: unknown) {
      setSaveErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const perSeatTooltip = row.perSeatCostCny == null
    ? (row.charterCostCny == null ? '包机成本未填' : '总座位数为 0')
    : '';

  const ph = (period: number | null): string => (period == null ? '' : String(period));
  const lockedAtTitle = row.costLockedAt
    ? `成本已锁定于 ${new Date(row.costLockedAt).toLocaleString('zh-CN')}`
    : undefined;

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 font-medium text-slate-900">
        {row.flightNumber}
        {row.costLocked && (
          <span
            className="ml-1 inline-flex items-center rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700"
            title={lockedAtTitle}
          >
            🔒 已锁定
          </span>
        )}
      </td>
      <td className="py-2 text-slate-600">
        {row.origin} → {row.destination}
      </td>
      <td className="py-2 text-slate-600 text-xs">
        {new Date(row.departureTime).toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </td>
      <td className="py-2 text-right">
        <UsdCostInput
          className={inputCls}
          value={charter}
          placeholder={ph(row.charterCostCnyPeriod)}
          disabled={row.costLocked}
          onChange={(n) => setCharter(n)}
        />
      </td>
      <td className="py-2 text-right">
        <UsdCostInput
          className={inputCls}
          value={taxDep}
          placeholder={ph(row.airportTaxDepCnyPeriod)}
          disabled={row.costLocked}
          onChange={setTaxDep}
        />
      </td>
      <td className="py-2 text-right">
        <UsdCostInput
          className={inputCls}
          value={taxArr}
          placeholder={ph(row.airportTaxArrCnyPeriod)}
          disabled={row.costLocked}
          onChange={setTaxArr}
        />
      </td>
      <td className="py-2 text-right">
        <UsdCostInput
          className={inputCls}
          value={fuel}
          placeholder={ph(row.fuelCostCnyPeriod)}
          disabled={row.costLocked}
          onChange={setFuel}
        />
      </td>
      <td className="py-2 text-right">
        <UsdCostInput
          className={inputCls}
          value={peak}
          placeholder={ph(row.peakSurchargeCnyPeriod)}
          disabled={row.costLocked}
          onChange={setPeak}
        />
      </td>
      <td className="py-2 text-right">
        <UsdCostInput
          className={inputCls}
          allowNegative
          value={aircraft}
          placeholder={ph(row.aircraftAdjustCnyPeriod)}
          disabled={row.costLocked}
          onChange={setAircraft}
        />
      </td>
      <td className="py-2 text-right">
        <UsdCostInput
          className={inputCls}
          allowNegative
          value={takeoff}
          placeholder={ph(row.takeoffDiscountCnyPeriod)}
          disabled={row.costLocked}
          onChange={setTakeoff}
        />
      </td>
      <td className="py-2 text-right tabular-nums text-slate-600">
        {row.soldSeats} / {row.totalSeats}
      </td>
      <td
        className="py-2 text-right tabular-nums font-semibold text-blue-700"
        title={perSeatTooltip}
      >
        {fmtCny(row.perSeatCostCny)}
      </td>
      <td className="py-2 text-right tabular-nums text-slate-600">
        {fmtCny(row.emptySeatCostCny)}
      </td>
      <td className="py-2 text-right">
        <label
          className="mb-1 flex items-center justify-end gap-1 text-xs text-ink-soft"
          title={pairedRow ? '将同步到 ' + pairedRow.flightNumber : '未找到当日配对班次'}
        >
          <input
            type="checkbox"
            checked={syncPair && pairedRow != null}
            disabled={pairedRow == null || pairedRow.costLocked}
            onChange={(e) => setSyncPair(e.target.checked)}
          />
          同步写入当日配对班次{pairedRow?.costLocked ? '（已锁定，保存时跳过）' : ''}
        </label>
        <button
          type="button"
          onClick={save}
          disabled={saving || row.costLocked}
          className="btn-secondary px-2 py-1 text-xs"
        >
          {saving ? '…' : row.costLocked ? '已锁定' : '保存'}
        </button>
        <button
          type="button"
          onClick={toggleCostLock}
          disabled={lockBusy || saving}
          className="ml-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          title={lockedAtTitle}
        >
          {lockBusy ? '…' : row.costLocked ? '🔓 解锁' : '🔒 锁定成本'}
        </button>
        {saveErr && <div className="text-xs text-rose-600 mt-0.5">{saveErr}</div>}
        {lockErr && <div className="text-xs text-rose-600 mt-0.5">{lockErr}</div>}
        {saveNotice && <div className={`text-xs mt-0.5 ${saveNotice.includes('失败') ? 'text-rose-600' : 'text-emerald-600'}`}>{saveNotice}</div>}
        {pairedRow == null && <div className="text-xs text-amber-600 mt-0.5">未找到当日配对班次</div>}
      </td>
    </tr>
  );
}

// ── 产品成本编辑（酒店 / 签证 / 接送）──────────────────────────────────────────
function ProductCostEditors({ token }: { token: string }) {
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [visas, setVisas] = useState<Visa[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.listHotels(false), api.listVisas(false), api.listTransfers(false)])
      .then(([h, v, t]) => {
        if (cancelled) return;
        setHotels(h.hotels);
        setVisas(v.visas);
        setTransfers(t.transfers);
      })
      .catch(() => {
        if (!cancelled) setMsg('产品列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  if (loading) return <div className="text-sm text-slate-500">加载产品成本…</div>;

  return (
    <div className="space-y-4">
      {msg && <div className="text-xs text-rose-600">{msg}</div>}

      {/* 酒店房型 */}
      <div className="card">
        <h2 className="text-sm font-semibold text-ink">酒店净房价（按房型）</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">酒店 / 房型</th>
              <th className="py-2 text-right font-normal">挂牌价(CNY)</th>
              <th className="py-2 text-right font-normal">净房价(CNY/晚)</th>
              <th className="py-2 text-right font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {hotels.flatMap((h) =>
              (h.roomTypes ?? []).map((rt) => (
                <CostRow
                  key={rt.id}
                  label={`${h.name} · ${rt.name}`}
                  basePrice={rt.basePrice}
                  fields={[
                    { key: 'costPriceCny', value: rt.costPriceCny },
                  ]}
                  onSave={async (vals) => {
                    await api.patchHotelRoomTypeCost(token, rt.id, vals);
                    load();
                  }}
                />
              )),
            )}
          </tbody>
        </table>
      </div>

      {/* 签证 */}
      <div className="card">
        <h2 className="text-sm font-semibold text-ink">签证成本</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">签证</th>
              <th className="py-2 text-right font-normal">挂牌价(CNY)</th>
              <th className="py-2 text-right font-normal">成本(CNY)</th>
              <th className="py-2 text-right font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {visas.map((v) => (
              <CostRow
                key={v.id}
                label={`${v.flag ?? ''} ${v.country ?? v.destinationCountry} · ${v.visaName ?? v.visaType}`}
                basePrice={v.basePrice}
                fields={[
                  { key: 'costPriceCny', value: v.costPriceCny },
                ]}
                onSave={async (vals) => {
                  await api.patchVisaCost(token, v.id, vals);
                  load();
                }}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* 接送 */}
      <div className="card">
        <h2 className="text-sm font-semibold text-ink">地面服务车队结算价</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">车型 / 线路</th>
              <th className="py-2 text-right font-normal">挂牌价(CNY)</th>
              <th className="py-2 text-right font-normal">结算价(CNY)</th>
              <th className="py-2 text-right font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <CostRow
                key={t.id}
                label={`${t.name} · ${t.originArea}→${t.destArea}`}
                basePrice={t.basePrice}
                fields={[{ key: 'costPriceCny', value: t.costPriceCny }]}
                onSave={async (vals) => {
                  await api.patchTransferCost(token, t.id, vals);
                  load();
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface CostField {
  key: string;
  value: string | null;
}

function CostRow({
  label,
  basePrice,
  fields,
  onSave,
}: {
  label: string;
  basePrice: string | null;
  fields: CostField[];
  onSave: (vals: Record<string, number | null>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, number | null>>(
    Object.fromEntries(fields.map((f) => [f.key, f.value == null || f.value === '' ? null : Number(f.value)])),
  );
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  async function save(): Promise<void> {
    setSaving(true);
    setSaveErr(null);
    try {
      const vals: Record<string, number | null> = {};
      for (const f of fields) {
        vals[f.key] = draft[f.key] ?? null;
      }
      await onSave(vals);
    } catch (e: unknown) {
      setSaveErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 text-slate-900">{label}</td>
      <td className="py-2 text-right tabular-nums text-slate-500">
        {basePrice ? `¥${Number(basePrice).toLocaleString('zh-CN')}` : '—'}
      </td>
      {fields.map((f) => (
        <td key={f.key} className="py-2 text-right">
          <NumberInput
            step={0.01}
            value={draft[f.key] ?? null}
            onChange={(n) => setDraft((d) => ({ ...d, [f.key]: n }))}
            className="w-28 rounded-lg border border-slate-200 px-2 py-1 text-right text-sm nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
          />
        </td>
      ))}
      <td className="py-2 text-right">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="btn-secondary px-2 py-1 text-xs"
        >
          {saving ? '…' : '保存'}
        </button>
        {saveErr && <div className="text-xs text-rose-600 mt-0.5">{saveErr}</div>}
      </td>
    </tr>
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

  // A5：缺成本时后端毛利/净利返回 null（未知）——KPI 卡如实标「未知」，不显示虚高数字。
  const marginUnknown = data.grossMarginCny == null;
  const marginTone = marginUnknown
    ? 'warn'
    : data.grossMarginCny! > 0 ? 'pos' : data.grossMarginCny! < 0 ? 'neg' : 'neutral';
  const netTone = marginUnknown
    ? 'warn'
    : data.netMarginCny! > 0 ? 'pos' : data.netMarginCny! < 0 ? 'neg' : 'neutral';

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
          value={marginUnknown ? '未知' : fmtCny(data.grossMarginCny!)}
          hint={marginUnknown ? `缺 ${data.missingCostItemCount} 项成本，补录后显示` : `毛利率 ${fmtPct(data.marginPct)}`}
          tone={marginTone}
        />
        <KpiCard
          label="航班贡献毛利（扣空座损失）"
          value={marginUnknown ? '未知' : fmtCny(data.netMarginCny!)}
          hint={marginUnknown ? '毛利未知时不推算' : `空座损失 ${fmtCny(-data.emptySeatSunkCostCny)}（卖不掉的空座 × 单座成本）`}
          tone={netTone}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RevenueBreakdownTable data={data} />
        <CostBreakdownTable data={data} />
      </div>

      <details className="card">
        <summary className="cursor-pointer text-sm font-semibold text-ink">
          原始视图（按品类 kind 简表）
        </summary>
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
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
                <td colSpan={6} className="py-4 text-center text-ink-muted">
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
      </details>

      <p className="text-xs text-ink-muted">
        说明：收入按 OrderItem.amount 汇总（不含税费/折扣）；成本按 OrderItem.totalCostCny。
        空座损失（空座沉没）= (整包机座位数 − 已售) × 单座分摊成本，即卖不掉的空座白白承担的成本，仅对填了包机价的航班计算。
      </p>
    </section>
  );
}

// ── Summary · 收入细分（财务口径 10 项）─────────────────────────────────────
const REVENUE_ITEMS: { key: keyof Omit<FinanceSummary['revenueBreakdown'], 'uncategorized' | 'refund' | 'total'>; label: string }[] = [
  { key: 'outboundFlight', label: '去程机票收入' },
  { key: 'returnFlight', label: '返程机票收入' },
  { key: 'outboundTax', label: '去程机场税(过手)' },
  { key: 'returnTax', label: '返程机场税(过手)' },
  { key: 'hotel', label: '房收入' },
  { key: 'visa', label: '签证收入' },
  { key: 'transfer', label: '车收入' },
  { key: 'guide', label: '导游收入' },
  { key: 'upgradeChange', label: '升舱+改期收入' },
  { key: 'oversale', label: '超售收入' },
];

function RevenueBreakdownTable({ data }: { data: FinanceSummary }) {
  const rb = data.revenueBreakdown;
  const denom = rb.total || data.revenueCny || 0;
  const pct = (n: number): number | null => (denom > 0 ? n / denom : null);
  return (
    <div className="card">
      <h2 className="text-sm font-semibold text-ink">收入细分</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">项目</th>
              <th className="py-2 text-right font-normal">金额</th>
              <th className="py-2 text-right font-normal">占比</th>
            </tr>
          </thead>
          <tbody>
            {REVENUE_ITEMS.map((it) => (
              <tr key={it.key} className="border-b border-slate-100">
                <td className="py-1.5 text-slate-900">{it.label}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtCny(rb[it.key])}</td>
                <td className="py-1.5 text-right tabular-nums text-slate-500">{fmtPct(pct(rb[it.key]))}</td>
              </tr>
            ))}
            <tr className="border-b border-slate-100 text-slate-500">
              <td className="py-1.5 italic">其他/未分类</td>
              <td className="py-1.5 text-right tabular-nums">{fmtCny(rb.uncategorized)}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtPct(pct(rb.uncategorized))}</td>
            </tr>
            <tr className="border-b border-slate-100 text-slate-500">
              <td className="py-1.5 italic" title="先收后退的净退款额">退款（净）</td>
              <td className="py-1.5 text-right tabular-nums">{fmtCny(rb.refund)}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtPct(pct(rb.refund))}</td>
            </tr>
            <tr className="border-t-2 border-slate-300 font-semibold text-slate-900">
              <td className="py-2">合计</td>
              <td className="py-2 text-right tabular-nums">{fmtCny(rb.total)}</td>
              <td className="py-2 text-right tabular-nums">100.0%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        退款（净）= 先收后退的净退款额（已收 − 已完成退款，逐单累加）；与上面各行相加 = 合计。
      </p>
    </div>
  );
}

// ── Summary · 成本细分（财务口径 16 项）─────────────────────────────────────
const COST_ITEMS: { key: keyof Omit<FinanceSummary['costBreakdown'], 'total'>; label: string }[] = [
  { key: 'outboundCharter', label: '去程包机分摊' },
  { key: 'returnCharter', label: '返程包机分摊' },
  { key: 'outboundTax', label: '去程机场税' },
  { key: 'returnTax', label: '返程机场税' },
  { key: 'peakSurcharge', label: '旺季附加' },
  { key: 'fuel', label: '燃油' },
  { key: 'aircraftAdjust', label: '机型调整' },
  { key: 'takeoffDiscount', label: '起降折扣（机场补贴）' },
  { key: 'hotel', label: '房费' },
  { key: 'visa', label: '签证费' },
  { key: 'transfer', label: '车费' },
  { key: 'guideService', label: '导游服务费' },
  { key: 'compGift', label: '赠送费用' },
  { key: 'handlingFee', label: '手续费（结算）' },
  { key: 'operationFee', label: '操作费' },
  { key: 'other', label: '其他' },
];

function CostBreakdownTable({ data }: { data: FinanceSummary }) {
  const cb = data.costBreakdown;
  const denom = cb.total || data.costCny || 0;
  const pct = (n: number): number | null => (denom > 0 ? n / denom : null);
  return (
    <div className="card">
      <h2 className="text-sm font-semibold text-ink">成本细分</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">项目</th>
              <th className="py-2 text-right font-normal">金额</th>
              <th className="py-2 text-right font-normal">占比</th>
            </tr>
          </thead>
          <tbody>
            {COST_ITEMS.map((it) => {
              const v = cb[it.key];
              const tone = v < 0 ? 'text-emerald-700' : '';
              return (
                <tr key={it.key} className="border-b border-slate-100">
                  <td className="py-1.5 text-slate-900">{it.label}</td>
                  <td className={`py-1.5 text-right tabular-nums ${tone}`}>{fmtCny(v)}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">{fmtPct(pct(v))}</td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-slate-300 font-semibold text-slate-900">
              <td className="py-2">合计</td>
              <td className="py-2 text-right tabular-nums">{fmtCny(cb.total)}</td>
              <td className="py-2 text-right tabular-nums">100.0%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
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
    <section className="card">
      <h2 className="text-sm font-semibold text-ink">按航班 P&L（最多 100 条）</h2>
      <p className="mt-1 text-xs text-slate-500">
        机票成本按财务口径分摊：卖出座位 ×（包机总成本 ÷ 全部座位）；空座成本单列为剩余空座 × 单座成本，并从航班贡献毛利中扣除。
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">航班</th>
              <th className="py-2 text-left font-normal">出发</th>
              <th className="py-2 text-right font-normal">座位</th>
              <th className="py-2 text-right font-normal">载客率</th>
              <th className="py-2 text-right font-normal">收入</th>
              <th className="py-2 text-right font-normal">包机成本</th>
              <th className="py-2 text-right font-normal text-blue-700">单座成本(÷总座)</th>
              <th className="py-2 text-right font-normal" title="空座数 × 单座成本">空座成本</th>
              <th className="py-2 text-right font-normal">航班贡献毛利</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-4 text-center text-ink-muted">
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
                  <td className="py-2 text-right tabular-nums font-semibold text-blue-700">
                    {fmtCny(f.perSeatCostCny)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-slate-600">
                    {fmtCny(f.emptySeatCostCny)}
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
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);

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
    <section className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">按订单 P&L（最多 100 条）</h2>
          <p className="mt-1 text-xs text-slate-500">
            毛利 = 订单总价 − 订单项成本；机票成本按班次实时口径计算，其他条目沿用成本快照。某一条目缺成本则全单显示未知。点「明细」看逐项收支。
          </p>
        </div>
        <ExportByOrderButton token={token} range={range} />
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">订单</th>
              <th className="py-2 text-left font-normal">状态</th>
              <th className="py-2 text-left font-normal">联系人</th>
              <th className="py-2 text-right font-normal">下单时间</th>
              <th className="py-2 text-right font-normal">收入</th>
              <th className="py-2 text-right font-normal">成本</th>
              <th className="py-2 text-right font-normal">毛利</th>
              <th className="py-2 text-right font-normal">毛利率</th>
              <th className="py-2 text-right font-normal">明细</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-4 text-center text-ink-muted">
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
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setDetailOrderId(o.orderId)}
                      className="text-blue-700 hover:underline"
                    >
                      明细
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {detailOrderId && (
        <OrderPnlDetailModal
          token={token}
          orderId={detailOrderId}
          onClose={() => setDetailOrderId(null)}
        />
      )}
    </section>
  );
}

// ── 按订单导出按钮 ───────────────────────────────────────────────────────────
function ExportByOrderButton({ token, range }: { token: string; range: { from: string; to: string } }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onClick(): Promise<void> {
    if (!token || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const blob = await api.downloadFinanceExportByOrder(token, range);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `按订单毛利_${range.from}_${range.to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="btn-secondary whitespace-nowrap"
        title="区间内每张订单一行的毛利汇总"
      >
        {busy ? '导出中…' : '⬇ 按订单导出'}
      </button>
      {err && <span className="text-xs text-rose-600">{err}</span>}
    </div>
  );
}

// ── 单订单收支明细弹层 ───────────────────────────────────────────────────────
function OrderPnlDetailModal({
  token,
  orderId,
  onClose,
}: {
  token: string;
  orderId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<OrderPnlDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .getFinanceOrderPnlDetail(token, orderId)
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
  }, [token, orderId]);

  const marginTone = (v: number | null): string =>
    v == null ? 'text-slate-400' : v < 0 ? 'text-rose-700' : 'text-emerald-700';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="mt-10 w-full max-w-3xl rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-ink">订单收支明细</h3>
            {data && (
              <p className="mt-0.5 text-xs text-slate-500">
                {data.orderNumber} · {STATUS_LABEL[data.status] ?? data.status} · {data.contactName}
                {data.agentName ? ` · ${data.agentName}` : ''}
                {data.departureDate ? ` · 出发 ${data.departureDate}` : ''}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {loading && <div className="mt-4 text-sm text-slate-500">加载中…</div>}
        {err && <div className="mt-4 text-sm text-rose-600">加载失败：{err}</div>}

        {data && !loading && (
          <div className="mt-4 grid gap-5 md:grid-cols-2">
            {/* 收入表 */}
            <div>
              <h4 className="text-sm font-semibold text-ink">收入构成</h4>
              <table className="mt-2 w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-ink-muted">
                  <tr className="border-b border-slate-200">
                    <th className="py-1.5 text-left font-normal">项目</th>
                    <th className="py-1.5 text-right font-normal">数量</th>
                    <th className="py-1.5 text-right font-normal">单价</th>
                    <th className="py-1.5 text-right font-normal">小计</th>
                  </tr>
                </thead>
                <tbody>
                  {data.income.rows.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5">
                        <span className={r.isAdjustment ? 'text-violet-700' : 'text-slate-800'}>
                          {r.label}
                        </span>
                        <span className="ml-1 text-xs text-slate-400">
                          {ITEM_KIND_LABEL[r.kind] ?? r.kind}
                        </span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-500">{r.quantity}</td>
                      <td className="py-1.5 text-right tabular-nums text-slate-500">
                        {fmtCny(r.unitPriceCny)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{fmtCny(r.subtotalCny)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-300 font-medium">
                    <td className="py-1.5" colSpan={3}>
                      订单总收入
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmtCny(data.income.totalCny)}</td>
                  </tr>
                </tfoot>
              </table>
              {Math.abs(data.income.itemsSumCny - data.income.totalCny) > 0.01 && (
                <p className="mt-1 text-xs text-slate-400">
                  注：各行小计合计 {fmtCny(data.income.itemsSumCny)}，订单总价以「订单总收入」为准。
                </p>
              )}
            </div>

            {/* 成本表 */}
            <div>
              <h4 className="text-sm font-semibold text-ink">成本构成</h4>
              <table className="mt-2 w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-ink-muted">
                  <tr className="border-b border-slate-200">
                    <th className="py-1.5 text-left font-normal">项目</th>
                    <th className="py-1.5 text-right font-normal">数量</th>
                    <th className="py-1.5 text-right font-normal">成本</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cost.itemRows.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5">
                        <span className="text-slate-800">{r.label}</span>
                        <span className="ml-1 text-xs text-slate-400">
                          {ITEM_KIND_LABEL[r.kind] ?? r.kind}
                        </span>
                        {r.isRealtime && (
                          <span className="ml-1 text-[10px] text-blue-600">·实时</span>
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-500">{r.quantity}</td>
                      <td className="py-1.5 text-right tabular-nums text-slate-600">
                        {r.totalCostCny == null ? (
                          <span className="text-amber-600">缺</span>
                        ) : (
                          fmtCny(r.totalCostCny)
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.cost.miscRows.length > 0 && (
                    <tr>
                      <td colSpan={3} className="pt-2 text-xs text-ink-muted">
                        订单杂项成本
                      </td>
                    </tr>
                  )}
                  {data.cost.miscRows.map((r, i) => (
                    <tr key={`m${i}`} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5">
                        <span className="text-slate-800">{r.label}</span>
                        {r.note && <span className="ml-1 text-xs text-slate-400">{r.note}</span>}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-500">—</td>
                      <td className="py-1.5 text-right tabular-nums text-slate-600">
                        {fmtCny(r.amountCny)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200">
                    <td className="py-1.5 text-slate-500" colSpan={2}>
                      订单项成本小计
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-600">
                      {data.cost.itemCostCny == null ? (
                        <span className="text-amber-600">缺 {data.cost.missingCostItemCount}</span>
                      ) : (
                        fmtCny(data.cost.itemCostCny)
                      )}
                    </td>
                  </tr>
                  {data.cost.miscRows.length > 0 && (
                    <>
                      <tr>
                        <td className="py-1.5 text-slate-500" colSpan={2}>
                          杂项成本小计
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-slate-600">
                          {fmtCny(data.cost.miscCostCny)}
                        </td>
                      </tr>
                      <tr className="border-t border-slate-300 font-medium">
                        <td className="py-1.5" colSpan={2}>
                          成本合计（含杂项）
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {data.cost.totalWithMiscCny == null ? (
                            <span className="text-amber-600">未知</span>
                          ) : (
                            fmtCny(data.cost.totalWithMiscCny)
                          )}
                        </td>
                      </tr>
                    </>
                  )}
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {data && !loading && (
          <div className="mt-5 rounded-md bg-slate-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-sm">
              <span className="text-slate-600">
                毛利（订单口径，与列表一致）
                <span className={`ml-2 font-semibold tabular-nums ${marginTone(data.grossMarginCny)}`}>
                  {data.grossMarginCny == null ? '未知' : fmtCny(data.grossMarginCny)}
                </span>
                <span className="ml-1 text-xs text-slate-400">{fmtPct(data.marginPct)}</span>
              </span>
              {data.cost.miscRows.length > 0 && (
                <span className="text-slate-600">
                  含杂项毛利（参考）
                  <span
                    className={`ml-2 font-semibold tabular-nums ${marginTone(data.grossMarginWithMiscCny)}`}
                  >
                    {data.grossMarginWithMiscCny == null ? '未知' : fmtCny(data.grossMarginWithMiscCny)}
                  </span>
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              「毛利（订单口径）」= 订单总收入 − 订单项成本，不含杂项成本，与「订单毛利」列表/导出严格一致；杂项成本（导游/操作费等）单列，含杂项毛利仅供参考。
            </p>
          </div>
        )}
      </div>
    </div>
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
    <section className="card">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">月度趋势</h2>
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
          <div className="text-sm text-ink-muted">没有数据</div>
        )}
        {points.map((p) => {
          const revenuePct = p.revenueCny / maxRevenue;
          const costPct = p.costCny / maxRevenue;
          // 毛利 null = 本月有订单项缺成本快照 → 显示「未知」而非 ¥0（0 和未知是两件事）。
          const margin = p.grossMarginCny;
          const marginTone =
            margin == null
              ? 'text-slate-400'
              : margin < 0
                ? 'text-rose-700'
                : 'text-emerald-700';
          return (
            <div key={p.month} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700">{fmtMonth(p.month)}</span>
                <span className="text-slate-500">
                  收入 {fmtCny(p.revenueCny)} · 成本 {fmtCny(p.costCny)} ·{' '}
                  <span className={marginTone}>
                    毛利 {margin != null ? fmtCny(margin) : '未知'}
                  </span>
                  {margin == null && (
                    <span className="text-slate-400">（{p.missingCostItemCount} 项缺成本）</span>
                  )}{' '}
                  · {p.orderCount} 单
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

      <p className="mt-4 text-xs text-ink-muted">
        柱图：浅绿 = 收入；红色覆盖部分 = 成本；露出的浅绿尾巴 = 毛利。
      </p>
    </section>
  );
}
