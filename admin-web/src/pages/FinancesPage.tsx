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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatLocalTime } from '../lib/airports';
import { formatDateTimeSecCn, formatInBusinessTz } from '../lib/datetime';
import { Icon } from '../components/Icon';
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
  type HotelRoomTypeCostPeriodDto,
  type HotelRoomTypeCostPeriodWriteInput,
  type FxCurrency,
  type FxRateDto,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';
import { UsdRateInput } from '../components/UsdRateInput';
import { useConfirm } from '../components/ConfirmDialog';
import { useDialogA11y } from '../components/Modal';

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
/** 录入/更新时刻，固定北京时间（原先用 getHours 等取浏览器时区，境外看会跟导出差几小时）。 */
function fmtDate(iso: string): string {
  return formatInBusinessTz(iso, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
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

/**
 * 「同步到配对航班」的机场税互换。
 *
 * airportTaxDepCny / airportTaxArrCny 是按**出发地 / 目的地**分的（见 schema 与按航班导出的
 * 「机场税去 / 机场税回」两列）。配对航班是反向班次——它的出发机场正是本航班的到达机场，
 * 所以原样照抄会让配对那一行的两个数字对调。这里在发出前先换回来。
 * （两者之和不变，总毛利/单座成本不受影响，错的只是细分口径。）
 */
function swapAirportTaxForPair<
  T extends { airportTaxDepCny?: number | null; airportTaxArrCny?: number | null },
>(body: T): T {
  return {
    ...body,
    airportTaxDepCny: body.airportTaxArrCny ?? null,
    airportTaxArrCny: body.airportTaxDepCny ?? null,
  };
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
            <span className="inline-flex items-center gap-1 text-amber-700"><Icon name="alert" /> 财务数据敏感，访问会记录到审计日志</span>
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
      <FxRateEditor token={token} />

      <FlightCostPeriodsEditor token={token} />

      <FlightScheduleCostEditors token={token} />

      <ProductCostEditors token={token} />

      <p className="text-xs text-ink-muted">
        说明：成本入账统一人民币；酒店净房价可录越南盾，系统按所选汇率行逐晚折算。「班次」= 某一天的一趟具体航班（同一航班号不同出发日期就是不同班次）。航班按班次维护「包机/机场税/燃油/旺季附加/机型调整/起降折扣」，系统按财务口径实时算出单座成本（包机费 ÷ 全部座位）和空座成本。班次留空则回退到所匹配「周期」的默认值。
      </p>
    </section>
  );
}

// ── 汇率表（命名清单：汇率名称 × 币种 × 生效日）──────────────────────────────
/**
 * 汇率跟供应商合同走：一个供应商一条名称（签证公司名 / 「酒店越南盾」…），汇率变了按生效日加新行；
 * 区间由同名称同币种下一条的生效日隐含，因此无空洞、无重叠。名称留空 = 该币种通用行，只在该名称没有汇率时兜底。
 * 记法按财务习惯：USD 行 = 1 美金折多少人民币；VND 行 = 多少越南盾折 1 人民币。
 * 签证台按签证公司名自动带 USD 汇率；酒店成本录越南盾时选用 VND 汇率行。折算值**当场固化**在业务单据上——
 * 之后改这张表不会追溯已入账的旧单据。
 */
const FX_GENERIC_KEY = '';
const FX_NAME_DATALIST_ID = 'fx-name-options';
const FX_CURRENCY_LABEL: Record<FxCurrency, string> = { USD: '美金', VND: '越南盾' };
const FX_CURRENCIES: readonly FxCurrency[] = ['USD', 'VND'];

function fxRateHint(currency: FxCurrency): string {
  return currency === 'VND' ? '多少越南盾 = 1 人民币（如 3740）' : '1 美金 = 多少人民币（如 7.2）';
}

/** 某名称在目标日生效的汇率行（先名称行、再同币种通用行）；与后端 getFxRate 同口径。 */
function effectiveFxRate(
  rates: readonly FxRateDto[],
  currency: FxCurrency,
  name: string | null | undefined,
  date: string,
): FxRateDto | null {
  const pick = (n: string | null): FxRateDto | null =>
    rates
      .filter((r) => r.currency === currency && (r.name ?? null) === n && r.effectiveFrom <= date)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
  const trimmed = name?.trim() || null;
  return (trimmed ? pick(trimmed) : null) ?? pick(null);
}

/** 越南盾 → 人民币（VND 记法：rate 越南盾 = 1 人民币），两位小数；汇率 ≤ 0 → null。 */
function vndToCny(vnd: number, rate: number): number | null {
  if (!(rate > 0) || !Number.isFinite(vnd)) return null;
  return Math.round((vnd / rate) * 100) / 100;
}

/** 金额展示：最多两位小数（净房价 / 折算预览用）。 */
function fmtCostAmount(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function FxRateEditor({ token }: { token: string }) {
  const [rates, setRates] = useState<FxRateDto[]>([]);
  const [nameOptions, setNameOptions] = useState<Record<FxCurrency, string[]>>({ USD: [], VND: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newCurrency, setNewCurrency] = useState<FxCurrency>('USD');
  const [newFrom, setNewFrom] = useState(todayStr());
  const [newRate, setNewRate] = useState<number | null>(null);
  const [newNote, setNewNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    if (!token) return () => {};
    let cancelled = false;
    setLoading(true);
    setErr(null);
    Promise.all([api.listFxRates(token), api.listFxNameOptions(token)])
      .then(([ratesRes, optionsRes]) => {
        if (cancelled) return;
        setRates(ratesRes.rates);
        setNameOptions(optionsRes.options);
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

  /**
   * 按币种再按名称分组（后端已按币种、名称、生效日倒序排好，这里只切组）；每组「当前生效」= 生效日 ≤ 今天的最新一条。
   * 通用行（name null）在各币种内排最后——它只是兜底。
   */
  const groups = useMemo(() => {
    const today = todayStr();
    const byKey = new Map<string, FxRateDto[]>();
    for (const r of rates) {
      const key = `${r.currency}|${r.name ?? FX_GENERIC_KEY}`;
      const list = byKey.get(key) ?? [];
      byKey.set(key, [...list, r]);
    }
    return [...byKey.entries()].map(([key, rows]) => ({
      key,
      currency: rows[0].currency,
      name: rows[0].name,
      rows,
      currentId: rows.find((r) => r.effectiveFrom <= today)?.id ?? null,
    }));
  }, [rates]);

  // 输入候选 = 后端候选（按币种）∪ 汇率表里已有的同币种名称（自由输入仍允许）
  const datalistOptions = useMemo(() => {
    const names = new Set<string>(nameOptions[newCurrency] ?? []);
    for (const r of rates) if (r.currency === newCurrency && r.name) names.add(r.name);
    return [...names];
  }, [nameOptions, rates, newCurrency]);

  async function save(): Promise<void> {
    if (newRate == null || newRate <= 0) {
      setErr('汇率需大于 0');
      return;
    }
    const name = newName.trim() === '' ? null : newName.trim();
    // 同名称同币种同一生效日已有记录时按覆盖处理（后端按名称 × 币种 × 生效日幂等 upsert）
    const existing = rates.find(
      (r) => r.currency === newCurrency && (r.name ?? null) === name && r.effectiveFrom === newFrom,
    );
    if (
      existing &&
      !confirm(
        `${FX_CURRENCY_LABEL[newCurrency]} ${name ?? '通用'} ${newFrom} 已有汇率 ${existing.rate}，确认覆盖为 ${newRate}？`,
      )
    ) {
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.upsertFxRate(token, {
        name,
        currency: newCurrency,
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
        <h2 className="text-sm font-semibold text-ink">汇率表（按汇率名称 × 币种 × 生效日）</h2>
        {groups.length > 0 && (
          <span className="text-xs text-ink-soft">
            当前生效：
            {groups.map((g) => {
              const cur = g.rows.find((r) => r.id === g.currentId);
              return (
                <span key={g.key} className="ml-2">
                  {FX_CURRENCY_LABEL[g.currency]}·{g.name ?? '通用'}{' '}
                  <span className="font-semibold text-ink nums">{cur ? cur.rate : '—'}</span>
                </span>
              );
            })}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        汇率跟供应商合同走，一个供应商一条，汇率变了按生效日加新行；签证台按签证公司名自动带，酒店成本录越南盾时选用。
        只填生效日，不填结束日 —— 区间由同名称同币种下一条的生效日隐含；名称留空的通用行只在该名称没有汇率时兜底。
        记法：美金 = 1 美金折多少人民币；越南盾 = 多少越南盾折 1 人民币。
        <span className="font-medium text-amber-700">新汇率只影响此后的折算，已入账单据不受影响。</span>
      </p>

      {err && <div className="mt-2 text-xs text-rose-600">{err}</div>}

      {/* 新增 / 覆盖一行 */}
      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
        <div>
          <label className="label" htmlFor="fx-name">
            汇率名称（留空 = 通用）
          </label>
          <input
            id="fx-name"
            type="text"
            list={FX_NAME_DATALIST_ID}
            className="input w-40 py-1.5 text-sm"
            placeholder="签证公司 / 酒店越南盾…"
            value={newName}
            disabled={saving}
            onChange={(e) => setNewName(e.target.value)}
          />
          <datalist id={FX_NAME_DATALIST_ID}>
            {datalistOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="label" htmlFor="fx-currency">
            币种
          </label>
          <select
            id="fx-currency"
            className="input py-1.5 text-sm"
            value={newCurrency}
            disabled={saving}
            onChange={(e) => setNewCurrency(e.target.value as FxCurrency)}
          >
            {FX_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c} {FX_CURRENCY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
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
            汇率（{fxRateHint(newCurrency)}）
          </label>
          <NumberInput
            id="fx-rate"
            step={newCurrency === 'VND' ? 1 : 0.0001}
            value={newRate}
            onChange={setNewRate}
            disabled={saving}
            className="w-36 rounded-lg border border-slate-200 px-2 py-1.5 text-right text-sm nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
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
            placeholder="如 对方通知调整"
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
      ) : groups.length === 0 ? (
        <div className="mt-3 text-sm text-ink-muted">尚未维护任何汇率（签证台的汇率格需手填；酒店越南盾成本将按缺汇率记空）</div>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">币种</th>
              <th className="py-2 text-left font-normal">汇率名称</th>
              <th className="py-2 text-left font-normal">生效日</th>
              <th className="py-2 text-right font-normal">汇率</th>
              <th className="py-2 text-left font-normal">备注</th>
              <th className="py-2 text-left font-normal">最近更新</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) =>
              g.rows.map((r, i) => (
                <tr
                  key={r.id}
                  className={
                    i === 0 && g.key !== groups[0].key
                      ? 'border-t-2 border-slate-200 border-b border-b-slate-100 last:border-b-0'
                      : 'border-b border-slate-100 last:border-0'
                  }
                >
                  <td className="py-2 text-slate-900">{i === 0 ? `${r.currency} ${FX_CURRENCY_LABEL[r.currency]}` : ''}</td>
                  <td className="py-2 text-slate-900">
                    {i === 0 ? (g.name ?? <span className="text-ink-muted">通用（兜底）</span>) : ''}
                  </td>
                  <td className="py-2 text-slate-900 nums">
                    {r.effectiveFrom}
                    {g.currentId === r.id && <span className="badge-success ml-2">当前生效</span>}
                  </td>
                  <td className="py-2 text-right tabular-nums text-slate-900" title={fxRateHint(r.currency)}>
                    {r.rate}
                  </td>
                  <td className="py-2 text-ink-soft">{r.note ?? '—'}</td>
                  <td className="py-2 text-xs text-ink-muted">
                    {fmtDate(r.updatedAt)}
                    {r.updatedBy && ` · ${r.updatedBy.slice(0, 8)}…`}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── 航班成本周期 ─────────────────────────────────────────────────────────────
function FlightCostPeriodsEditor({ token }: { token: string }) {
  const confirm = useConfirm();
  const confirmLockRef = useRef(false);
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
    if (confirmLockRef.current) return;
    confirmLockRef.current = true;
    if (!(await confirm({
      title: '确认删除该周期？',
      body: '删除后该航班该日期段会回退到「无默认」。',
      tone: 'danger',
    }))) {
      confirmLockRef.current = false;
      return;
    }
    try {
      await api.deleteCostPeriod(token, id);
      load();
    } catch (e: unknown) {
      alert(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      confirmLockRef.current = false;
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
          // 配对航班的出发机场 = 本航班的到达机场，机场税两列必须对调后再发。
          await api.createCostPeriod(token, { ...swapAirportTaxForPair(body), flightId: pairedFlight.id });
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
          // 配对航班的出发机场 = 本航班的到达机场，机场税两列必须对调后再发。
          await api.updateCostPeriod(token, pairedPeriod.id, swapAirportTaxForPair(body));
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
            className="btn-ghost-danger px-2 py-1 text-xs"
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
          // 配对班次的出发机场 = 本班次的到达机场，机场税两列必须对调后再发。
          await api.patchFlightScheduleCost(token, pairedRow.scheduleId, swapAirportTaxForPair(body));
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
    ? `成本已锁定于 ${formatDateTimeSecCn(row.costLockedAt)}`
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
            <Icon name="lock" /> 已锁定
          </span>
        )}
      </td>
      <td className="py-2 text-slate-600">
        {row.origin} → {row.destination}
      </td>
      <td className="py-2 text-slate-600 text-xs">
        {/* 起飞时刻按出发地时区折算（用浏览器时区会让越南航段差 1 小时） */}
        {row.localDepartureDate} {formatLocalTime(row.departureTime, row.departureTz)}
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
          {lockBusy ? '…' : row.costLocked ? <><Icon name="unlock" /> 解锁</> : <><Icon name="lock" /> 锁定成本</>}
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
  // VND 汇率行：酒店录越南盾时选用哪条 + 「≈ ¥」预览
  const [vndRates, setVndRates] = useState<FxRateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  // 首次加载才显示「加载中」占位；保存后的静默刷新不卸载表格，否则行内的「已保存」提示会被冲掉。
  const hasLoadedRef = useRef(false);

  const load = useCallback(() => {
    let cancelled = false;
    if (!hasLoadedRef.current) setLoading(true);
    // 必须带 token：后端对匿名请求整列剥掉 costPriceCny（成本防泄漏），不带就永远显示空白。
    Promise.all([
      api.listHotels(false, token),
      api.listVisas(false, token),
      api.listTransfers(false, token),
      api.listFxRates(token),
    ])
      .then(([h, v, t, fx]) => {
        if (cancelled) return;
        setHotels(h.hotels);
        setVisas(v.visas);
        setTransfers(t.transfers);
        setVndRates(fx.rates.filter((r) => r.currency === 'VND'));
      })
      .catch(() => {
        if (!cancelled) setMsg('产品列表加载失败');
      })
      .finally(() => {
        if (cancelled) return;
        hasLoadedRef.current = true;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => load(), [load]);

  if (loading) return <div className="text-sm text-slate-500">加载产品成本…</div>;

  return (
    <div className="space-y-4">
      {msg && <div className="text-xs text-rose-600">{msg}</div>}

      {/* 酒店房型 */}
      <div className="card">
        <h2 className="text-sm font-semibold text-ink">酒店净房价（按房型）</h2>
        <p className="mt-1 text-xs text-slate-500">
          按日期区间设了净房价的日子按区间算，没设的日子用缺省值；可录人民币或越南盾（越南盾按所选汇率行逐晚折人民币，
          当晚没有汇率则该晚成本记空）；录单时按入住每晚累加进成本快照，已录订单的快照不追溯。
        </p>
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">酒店 / 房型</th>
              <th className="py-2 text-right font-normal">挂牌价(CNY)</th>
              <th className="py-2 text-right font-normal">缺省净房价（人民币或越南盾）/晚</th>
              <th className="py-2 text-right font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {hotels.flatMap((h) =>
              (h.roomTypes ?? []).map((rt) => (
                <HotelRoomTypeCostRows
                  key={rt.id}
                  token={token}
                  roomTypeId={rt.id}
                  label={`${h.name} · ${rt.name}`}
                  basePrice={rt.basePrice}
                  costPriceCny={rt.costPriceCny}
                  costPriceVnd={rt.costPriceVnd ?? null}
                  costFxName={rt.costFxName ?? null}
                  vndRates={vndRates}
                  onSaveDefault={async (vals) => {
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
                label={`${v.country ?? v.destinationCountry} · ${v.visaName ?? v.visaType}`}
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
        <p className="mt-1 text-xs text-ink-muted">
          可录人民币或越南盾（越南盾按所选汇率行、按订单去程出发日的汇率折人民币，缺汇率时成本记空）。
        </p>
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="py-2 text-left font-normal">车型 / 线路</th>
              <th className="py-2 text-right font-normal">挂牌价(CNY)</th>
              <th className="py-2 text-right font-normal">结算价（人民币或越南盾）</th>
              <th className="py-2 text-right font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <TransferCostRow
                key={t.id}
                label={`${t.name} · ${t.originArea}→${t.destArea}`}
                basePrice={t.basePrice}
                costPriceCny={t.costPriceCny}
                costPriceVnd={t.costPriceVnd ?? null}
                costFxName={t.costFxName ?? null}
                vndRates={vndRates}
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

/** 车队越南盾结算价默认选用的汇率名称（与汇率表的建议候选一致）。 */
const TRANSFER_VND_FX_NAME = '车队越南盾';

/** 车队一行：结算价（人民币或越南盾二选一）+ 保存；交互照抄酒店房型缺省价行（无日期区间）。 */
function TransferCostRow({
  label,
  basePrice,
  costPriceCny,
  costPriceVnd,
  costFxName,
  vndRates,
  onSave,
}: {
  label: string;
  basePrice: string | null;
  costPriceCny: string | null;
  costPriceVnd: string | null;
  costFxName: string | null;
  vndRates: readonly FxRateDto[];
  onSave: (vals: { costPriceCny: number | null; costPriceVnd: number | null; costFxName: string | null }) => Promise<void>;
}) {
  const [draft, setDraft] = useState<CostPriceValue>(() => costPriceValueOf({ costPriceCny, costPriceVnd, costFxName }));
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save(): Promise<void> {
    setSaving(true);
    setSaveErr(null);
    try {
      await onSave(costPricePatchOf(draft));
      setSavedAt(Date.now());
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
      <td className="py-2 text-right">
        <CostPriceFields
          value={draft}
          onChange={setDraft}
          vndRates={vndRates}
          disabled={saving}
          unitLabel="份"
          defaultFxName={TRANSFER_VND_FX_NAME}
        />
      </td>
      <td className="py-2 text-right">
        <button type="button" onClick={() => void save()} disabled={saving} className="btn-secondary px-2 py-1 text-xs">
          {saving ? '…' : '保存'}
        </button>
        {saveErr && <div className="mt-0.5 text-xs text-rose-600">{saveErr}</div>}
        {!saveErr && savedAt != null && <div className="mt-0.5 text-xs text-emerald-600">已保存</div>}
      </td>
    </tr>
  );
}

interface CostField {
  key: string;
  value: string | null;
}

type CostCurrency = 'CNY' | 'VND';

interface CostPriceValue {
  currency: CostCurrency;
  cny: number | null;
  vnd: number | null;
  /** 越南盾按哪条 VND 汇率行折算；'' = 通用行 */
  fxName: string;
}

/** 房型 / 区间上的三列 → 编辑态初值（两边都有数以越南盾为准，与后端取价口径一致）。 */
function costPriceValueOf(src: {
  costPriceCny: number | string | null | undefined;
  costPriceVnd: number | string | null | undefined;
  costFxName: string | null | undefined;
}): CostPriceValue {
  const cny = src.costPriceCny == null || src.costPriceCny === '' ? null : Number(src.costPriceCny);
  const vnd = src.costPriceVnd == null || src.costPriceVnd === '' ? null : Number(src.costPriceVnd);
  return { currency: vnd != null ? 'VND' : 'CNY', cny, vnd, fxName: src.costFxName ?? '' };
}

/** 编辑态 → PATCH / 写入体（人民币或越南盾二选一；越南盾行才带汇率名称）。 */
function costPricePatchOf(v: CostPriceValue): {
  costPriceCny: number | null;
  costPriceVnd: number | null;
  costFxName: string | null;
} {
  if (v.currency === 'VND') {
    return { costPriceCny: null, costPriceVnd: v.vnd, costFxName: v.vnd == null ? null : v.fxName.trim() || null };
  }
  return { costPriceCny: v.cny, costPriceVnd: null, costFxName: null };
}

/** VND 汇率名称候选 = VND 行的名称去重（通用行另列）。 */
function vndFxNameOptions(vndRates: readonly FxRateDto[]): string[] {
  const names = new Set<string>();
  for (const r of vndRates) if (r.name) names.add(r.name);
  return [...names];
}

/** 「≈ ¥xxx 按 <汇率名> 3740（今日）」灰字；缺汇率 → 琥珀提示去汇率表维护。 */
function VndCnyPreview({ vnd, fxName, vndRates }: { vnd: number | null; fxName: string; vndRates: readonly FxRateDto[] }) {
  if (vnd == null) return null;
  const fx = effectiveFxRate(vndRates, 'VND', fxName, todayStr());
  if (!fx) {
    return (
      <span className="text-[11px] text-amber-700">
        汇率表里没有「{fxName.trim() || '通用'}」的越南盾汇率，成本将按缺汇率记空
      </span>
    );
  }
  const cny = vndToCny(vnd, fx.rate);
  return (
    <span className="text-[11px] text-ink-muted">
      ≈ ¥{cny == null ? '—' : fmtCostAmount(cny)} 按 {fx.name ?? '通用'} {fx.rate}（今日）
    </span>
  );
}

/** 只读展示：¥x 或 ₫x（按 <汇率名> 3740 ≈ ¥y）。 */
function CostPriceText({ value, vndRates }: { value: CostPriceValue; vndRates: readonly FxRateDto[] }) {
  if (value.currency === 'VND') {
    if (value.vnd == null) return <span className="text-ink-muted">—</span>;
    const fx = effectiveFxRate(vndRates, 'VND', value.fxName, todayStr());
    const cny = fx ? vndToCny(value.vnd, fx.rate) : null;
    return (
      <span>
        ₫{fmtCostAmount(value.vnd)}
        <span className="ml-1 text-[11px] text-ink-muted">
          {fx ? `按 ${fx.name ?? '通用'} ${fx.rate} ≈ ¥${cny == null ? '—' : fmtCostAmount(cny)}` : `「${value.fxName.trim() || '通用'}」缺汇率`}
        </span>
      </span>
    );
  }
  return <span>{value.cny == null ? '—' : `¥${fmtCostAmount(value.cny)}`}</span>;
}

/**
 * 成本价输入组（酒店净房价 / 车队结算价共用）：币种切换（人民币 / 越南盾）+ 金额 +（越南盾时）汇率名称下拉 + ≈ ¥ 预览。
 *   unitLabel     金额占位的计量单位（酒店「晚」、车队「份」）
 *   defaultFxName 切到越南盾且尚未选汇率名时的默认候选（车队 =「车队越南盾」）；汇率表暂无也列出来可选
 */
function CostPriceFields({
  value,
  onChange,
  vndRates,
  disabled,
  size = 'sm',
  unitLabel = '晚',
  defaultFxName,
}: {
  value: CostPriceValue;
  onChange: (next: CostPriceValue) => void;
  vndRates: readonly FxRateDto[];
  disabled?: boolean;
  size?: 'sm' | 'xs';
  unitLabel?: string;
  defaultFxName?: string;
}) {
  const inputCls =
    size === 'xs'
      ? 'rounded-lg border border-slate-200 px-1.5 py-0.5 text-right text-xs nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20'
      : 'rounded-lg border border-slate-200 px-2 py-1 text-right text-sm nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
  const selectCls =
    size === 'xs'
      ? 'rounded-lg border border-slate-200 px-1.5 py-0.5 text-xs focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20'
      : 'rounded-lg border border-slate-200 px-2 py-1 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
  const tableOptions = vndFxNameOptions(vndRates);
  // 默认候选（如「车队越南盾」）汇率表里还没有也列出来，选了会在预览里提示去汇率表维护
  const fxOptions =
    defaultFxName && !tableOptions.includes(defaultFxName) ? [...tableOptions, defaultFxName] : tableOptions;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <select
        className={selectCls}
        value={value.currency}
        disabled={disabled}
        onChange={(e) => {
          const currency = e.target.value as CostCurrency;
          // 切到越南盾且还没选汇率名 → 带上默认候选；切回人民币不动汇率名（来回切不丢选择）
          const fxName = currency === 'VND' && !value.fxName && defaultFxName ? defaultFxName : value.fxName;
          onChange({ ...value, currency, fxName });
        }}
        title="人民币或越南盾二选一"
      >
        <option value="CNY">人民币 ¥</option>
        <option value="VND">越南盾 ₫</option>
      </select>
      {value.currency === 'CNY' ? (
        <NumberInput
          step={0.01}
          value={value.cny}
          disabled={disabled}
          onChange={(n) => onChange({ ...value, cny: n })}
          className={`w-28 ${inputCls}`}
          placeholder={`CNY/${unitLabel}`}
        />
      ) : (
        <>
          <NumberInput
            step={1}
            value={value.vnd}
            disabled={disabled}
            onChange={(n) => onChange({ ...value, vnd: n })}
            className={`w-32 ${inputCls}`}
            placeholder={`VND/${unitLabel}`}
          />
          <select
            className={selectCls}
            value={value.fxName}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, fxName: e.target.value })}
            title="按哪条越南盾汇率行折算"
          >
            <option value="">通用汇率</option>
            {fxOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            {value.fxName && !fxOptions.includes(value.fxName) && (
              <option value={value.fxName}>{value.fxName}（汇率表暂无）</option>
            )}
          </select>
          <VndCnyPreview vnd={value.vnd} fxName={value.fxName} vndRates={vndRates} />
        </>
      )}
    </div>
  );
}

/**
 * 酒店房型一行：缺省净房价（人民币或越南盾）+ 「按日期区间 ▸」展开的区间列表/编辑面板。
 * 展开面板挂在下一行（colSpan 撑满），只在展开时才拉该房型的区间，列表不预加载。
 */
function HotelRoomTypeCostRows({
  token,
  roomTypeId,
  label,
  basePrice,
  costPriceCny,
  costPriceVnd,
  costFxName,
  vndRates,
  onSaveDefault,
}: {
  token: string;
  roomTypeId: string;
  label: string;
  basePrice: string | null;
  costPriceCny: string | null;
  costPriceVnd: string | null;
  costFxName: string | null;
  vndRates: readonly FxRateDto[];
  onSaveDefault: (vals: { costPriceCny: number | null; costPriceVnd: number | null; costFxName: string | null }) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<CostPriceValue>(() =>
    costPriceValueOf({ costPriceCny, costPriceVnd, costFxName }),
  );
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save(): Promise<void> {
    setSaving(true);
    setSaveErr(null);
    try {
      await onSaveDefault(costPricePatchOf(draft));
      setSavedAt(Date.now());
    } catch (e: unknown) {
      setSaveErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <tr className="border-b border-slate-100 last:border-0">
        <td className="py-2 text-slate-900">
          {label}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="ml-2 text-xs text-brand hover:underline"
          >
            按日期区间 {expanded ? '▾' : '▸'}
          </button>
        </td>
        <td className="py-2 text-right tabular-nums text-slate-500">
          {basePrice ? `¥${Number(basePrice).toLocaleString('zh-CN')}` : '—'}
        </td>
        <td className="py-2 text-right">
          <CostPriceFields value={draft} onChange={setDraft} vndRates={vndRates} disabled={saving} />
        </td>
        <td className="py-2 text-right">
          <button type="button" onClick={() => void save()} disabled={saving} className="btn-secondary px-2 py-1 text-xs">
            {saving ? '…' : '保存'}
          </button>
          {saveErr && <div className="mt-0.5 text-xs text-rose-600">{saveErr}</div>}
          {!saveErr && savedAt != null && <div className="mt-0.5 text-xs text-emerald-600">已保存</div>}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-slate-100 last:border-0">
          <td colSpan={4} className="pb-3 pt-0">
            <HotelRoomTypeCostPeriodsPanel token={token} roomTypeId={roomTypeId} vndRates={vndRates} />
          </td>
        </tr>
      )}
    </>
  );
}

/** 某房型的净房价区间列表 + 行内新增/编辑/删除（交互照抄航班成本周期编辑器）。 */
function HotelRoomTypeCostPeriodsPanel({
  token,
  roomTypeId,
  vndRates,
}: {
  token: string;
  roomTypeId: string;
  vndRates: readonly FxRateDto[];
}) {
  const confirm = useConfirm();
  const confirmLockRef = useRef(false);
  const [periods, setPeriods] = useState<HotelRoomTypeCostPeriodDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setErr(null);
    api
      .listHotelRoomTypeCostPeriods(token, roomTypeId)
      .then((d) => {
        if (!cancelled) setPeriods([...d.periods].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)));
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '净房价区间加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, roomTypeId]);

  useEffect(() => load(), [load]);

  async function onDelete(id: string): Promise<void> {
    if (confirmLockRef.current) return;
    confirmLockRef.current = true;
    if (!(await confirm({
      title: '确认删除该净房价区间？',
      body: '删除后这段日期回退到房型缺省净房价；已录订单的成本快照不受影响。',
      tone: 'danger',
    }))) {
      confirmLockRef.current = false;
      return;
    }
    try {
      await api.deleteHotelRoomTypeCostPeriod(token, id);
      load();
    } catch (e: unknown) {
      alert(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      confirmLockRef.current = false;
    }
  }

  return (
    <div className="ml-4 rounded-lg border border-slate-200 bg-canvas p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-soft">
          按日期区间的净房价（含结束日当晚；区间之间不得重叠；每段人民币或越南盾二选一）
        </span>
        <button
          type="button"
          onClick={() => setShowNew((v) => !v)}
          className={showNew ? 'btn-secondary py-1 text-xs' : 'btn-primary py-1 text-xs'}
        >
          {showNew ? '× 取消' : '+ 新增区间'}
        </button>
      </div>

      {showNew && (
        <HotelRoomTypeCostPeriodForm
          initial={null}
          vndRates={vndRates}
          onSubmit={async (body) => {
            await api.createHotelRoomTypeCostPeriod(token, roomTypeId, body);
            setShowNew(false);
            load();
          }}
          onCancel={() => setShowNew(false)}
        />
      )}

      {loading ? (
        <div className="mt-2 text-xs text-slate-500">加载区间…</div>
      ) : err ? (
        <div className="mt-2 text-xs text-rose-600">{err}</div>
      ) : (
        <table className="mt-2 w-full text-xs">
          <thead className="text-ink-muted">
            <tr className="border-b border-slate-200">
              <th className="min-w-[104px] py-1 text-left font-normal">起始</th>
              <th className="min-w-[104px] py-1 text-left font-normal">结束</th>
              <th className="min-w-[160px] py-1 text-right font-normal">净房价（人民币或越南盾）/晚</th>
              <th className="min-w-[132px] py-1 text-left font-normal">备注</th>
              <th className="min-w-[96px] py-1 text-right font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {periods.length === 0 && (
              <tr>
                <td colSpan={5} className="py-2 text-center text-ink-muted">
                  暂无区间 · 所有日期都用缺省净房价
                </td>
              </tr>
            )}
            {periods.map((p) => (
              <HotelRoomTypeCostPeriodRow
                key={p.id}
                period={p}
                token={token}
                vndRates={vndRates}
                onSaved={load}
                onDelete={() => onDelete(p.id)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function HotelRoomTypeCostPeriodRow({
  period,
  token,
  vndRates,
  onSaved,
  onDelete,
}: {
  period: HotelRoomTypeCostPeriodDto;
  token: string;
  vndRates: readonly FxRateDto[];
  onSaved: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <tr className="border-b border-slate-100 last:border-0">
        <td colSpan={5} className="py-1">
          <HotelRoomTypeCostPeriodForm
            initial={period}
            vndRates={vndRates}
            onSubmit={async (body) => {
              await api.updateHotelRoomTypeCostPeriod(token, period.id, body);
              setEditing(false);
              onSaved();
            }}
            onCancel={() => setEditing(false)}
          />
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-1 text-slate-600">{period.effectiveFrom}</td>
      <td className="py-1 text-slate-600">{period.effectiveTo}</td>
      <td className="py-1 text-right tabular-nums">
        <CostPriceText value={costPriceValueOf(period)} vndRates={vndRates} />
      </td>
      <td className="py-1 text-ink-muted">{period.note ?? '—'}</td>
      <td className="py-1 text-right">
        <button type="button" onClick={() => setEditing(true)} className="btn-secondary px-2 py-0.5 text-xs">
          改
        </button>{' '}
        <button type="button" onClick={onDelete} className="btn-secondary px-2 py-0.5 text-xs text-rose-600">
          删
        </button>
      </td>
    </tr>
  );
}

/** 区间新增/编辑表单（行内）：起止日 + 净房价（人民币或越南盾）+ 备注；重叠/起止倒置由后端 409 报回来原样展示。 */
function HotelRoomTypeCostPeriodForm({
  initial,
  vndRates,
  onSubmit,
  onCancel,
}: {
  initial: HotelRoomTypeCostPeriodDto | null;
  vndRates: readonly FxRateDto[];
  onSubmit: (body: HotelRoomTypeCostPeriodWriteInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState<string>(initial?.effectiveFrom ?? todayStr());
  const [to, setTo] = useState<string>(initial?.effectiveTo ?? todayStr());
  const [price, setPrice] = useState<CostPriceValue>(() =>
    initial ? costPriceValueOf(initial) : { currency: 'CNY', cny: null, vnd: null, fxName: '' },
  );
  const [note, setNote] = useState<string>(initial?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const amount = price.currency === 'VND' ? price.vnd : price.cny;
    if (amount == null) {
      setErr('请填写该区间的净房价');
      return;
    }
    if (from > to) {
      setErr('起始日不能晚于结束日');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await onSubmit({
        effectiveFrom: from,
        effectiveTo: to,
        ...costPricePatchOf(price),
        note: note.trim() === '' ? null : note.trim(),
      });
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : initial ? '保存失败' : '创建失败');
    } finally {
      setSaving(false);
    }
  }

  const dateCls = 'w-[120px] rounded-lg border border-slate-200 px-1.5 py-0.5 text-xs focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
  const textCls = 'w-[160px] rounded-lg border border-slate-200 px-1.5 py-0.5 text-xs focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-surface p-2">
      <label className="text-xs text-ink-soft">
        起始
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${dateCls} mt-0.5 block`} />
      </label>
      <label className="text-xs text-ink-soft">
        结束（含当晚）
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${dateCls} mt-0.5 block`} />
      </label>
      <div className="text-xs text-ink-soft">
        净房价/晚
        <div className="mt-0.5">
          <CostPriceFields value={price} onChange={setPrice} vndRates={vndRates} disabled={saving} size="xs" />
        </div>
      </div>
      <label className="text-xs text-ink-soft">
        备注
        <input
          type="text"
          value={note}
          maxLength={200}
          placeholder="如：国庆 / 周末价"
          onChange={(e) => setNote(e.target.value)}
          className={`${textCls} mt-0.5 block`}
        />
      </label>
      <button type="button" onClick={submit} disabled={saving} className="btn-primary px-2 py-1 text-xs">
        {saving ? '…' : initial ? '保存' : '创建'}
      </button>
      <button type="button" onClick={onCancel} disabled={saving} className="btn-secondary px-2 py-1 text-xs">
        取消
      </button>
      {err && <div className="w-full text-xs text-rose-600">{err}</div>}
    </div>
  );
}

function CostRow({
  label,
  basePrice,
  fields,
  onSave,
  labelExtra,
}: {
  label: string;
  basePrice: string | null;
  fields: CostField[];
  onSave: (vals: Record<string, number | null>) => Promise<void>;
  /** 名称后追加的小控件（如「按日期区间 ▸」展开钮）。 */
  labelExtra?: ReactNode;
}) {
  const [draft, setDraft] = useState<Record<string, number | null>>(
    Object.fromEntries(fields.map((f) => [f.key, f.value == null || f.value === '' ? null : Number(f.value)])),
  );
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save(): Promise<void> {
    setSaving(true);
    setSaveErr(null);
    try {
      const vals: Record<string, number | null> = {};
      for (const f of fields) {
        vals[f.key] = draft[f.key] ?? null;
      }
      await onSave(vals);
      setSavedAt(Date.now());
    } catch (e: unknown) {
      setSaveErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 text-slate-900">
        {label}
        {labelExtra}
      </td>
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
        {!saveErr && savedAt != null && <div className="mt-0.5 text-xs text-emerald-600">已保存</div>}
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
  const dialogRef = useDialogA11y(onClose);
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
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="订单收支明细"
      tabIndex={-1}
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
            <Icon name="close" />
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
