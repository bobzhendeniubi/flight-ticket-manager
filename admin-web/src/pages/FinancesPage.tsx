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
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';

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
      <FlightCostPeriodsEditor token={token} />

      <FlightScheduleCostEditors token={token} />

      <ProductCostEditors token={token} />

      <p className="text-xs text-ink-muted">
        说明：成本统一人民币。「班次」= 某一天的一趟具体航班（同一航班号不同出发日期就是不同班次）。航班按班次维护「包机/机场税/燃油/旺季附加/机型调整/起降折扣」，系统实时算出"单座(已售)成本"供定价参考。班次留空则回退到所匹配「周期」的默认值。
      </p>
    </section>
  );
}

// ── 航班成本周期 ─────────────────────────────────────────────────────────────
function FlightCostPeriodsEditor({ token }: { token: string }) {
  const [periods, setPeriods] = useState<CostPeriodDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [flightOptions, setFlightOptions] = useState<{ id: string; label: string }[]>([]);
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
        const map = new Map<string, string>();
        for (const r of d.schedules) {
          if (!map.has(r.flightId)) {
            map.set(r.flightId, `${r.flightNumber} · ${r.origin}→${r.destination}`);
          }
        }
        const opts = Array.from(map.entries())
          .map(([id, label]) => ({ id, label }))
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
            <thead className="text-xs uppercase tracking-wide text-ink-muted">
              <tr className="border-b border-slate-200">
                <th className="py-2 text-left font-normal">航班号</th>
                <th className="py-2 text-left font-normal">路线</th>
                <th className="py-2 text-left font-normal">起始</th>
                <th className="py-2 text-left font-normal">结束</th>
                <th className="py-2 text-right font-normal">包机</th>
                <th className="py-2 text-right font-normal">机场税去</th>
                <th className="py-2 text-right font-normal">机场税回</th>
                <th className="py-2 text-right font-normal">燃油</th>
                <th className="py-2 text-right font-normal">旺季附加</th>
                <th className="py-2 text-right font-normal">机型调整</th>
                <th className="py-2 text-right font-normal">起降折扣（机场补贴）</th>
                <th className="py-2 text-left font-normal">备注</th>
                <th className="py-2 text-right font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {periods.length === 0 && (
                <tr>
                  <td colSpan={13} className="py-4 text-center text-ink-muted">
                    暂无周期 · 点击右上「+ 新增周期」开始
                  </td>
                </tr>
              )}
              {periods.map((p) => (
                <CostPeriodRow
                  key={p.id}
                  period={p}
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
  flightOptions: { id: string; label: string }[];
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
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
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
        {/* A2 汇率四元组（选填）：记下包机 CNY 数是按哪天哪个汇率从哪种原币折来的 */}
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
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <label className="text-xs text-ink-soft">
          包机总额(¥)
          <NumberInput
            className={`mt-1 block w-full ${numCls}`}
            step={1}
            value={charter}
            onChange={setCharter}
          />
        </label>
        <label className="text-xs text-ink-soft">
          去程机场税(¥/座)
          <NumberInput
            className={`mt-1 block w-full ${numCls}`}
            step={0.01}
            value={taxDep}
            onChange={setTaxDep}
          />
        </label>
        <label className="text-xs text-ink-soft">
          返程机场税(¥/座)
          <NumberInput
            className={`mt-1 block w-full ${numCls}`}
            step={0.01}
            value={taxArr}
            onChange={setTaxArr}
          />
        </label>
        <label className="text-xs text-ink-soft">
          燃油附加(¥/座)
          <NumberInput
            className={`mt-1 block w-full ${numCls}`}
            step={0.01}
            value={fuel}
            onChange={setFuel}
          />
        </label>
        <label className="text-xs text-ink-soft">
          旺季附加(¥/座)
          <NumberInput
            className={`mt-1 block w-full ${numCls}`}
            step={0.01}
            value={peak}
            onChange={setPeak}
          />
        </label>
        <label className="text-xs text-ink-soft">
          机型调整(¥/座)
          <NumberInput
            className={`mt-1 block w-full ${numCls}`}
            step={0.01}
            allowNegative
            value={aircraft}
            onChange={setAircraft}
          />
        </label>
        <label className="text-xs text-ink-soft">
          起降折扣(¥/座，机场补贴)
          <NumberInput
            className={`mt-1 block w-full ${numCls}`}
            step={0.01}
            allowNegative
            value={takeoff}
            onChange={setTakeoff}
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        提示：「包机总额」是跟航司结算的整包价（一次性）；其余几项都按「每座」填。机型调整/起降折扣可填负数（少收或补贴）。
      </p>
      <div className="mt-3 flex items-center gap-2">
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
  token,
  onSaved,
  onDelete,
}: {
  period: CostPeriodDto;
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
  const [note, setNote] = useState<string>(period.note ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    setNote(period.note ?? '');
    setErr(null);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setErr(null);
    try {
      await api.updateCostPeriod(token, period.id, {
        effectiveFrom: from,
        effectiveTo: to,
        charterCostCny: charter,
        airportTaxDepCny: taxDep,
        airportTaxArrCny: taxArr,
        fuelCostCny: fuel,
        peakSurchargeCny: peak,
        aircraftAdjustCny: aircraft,
        takeoffDiscountCny: takeoff,
        note: note.trim() === '' ? null : note.trim(),
      });
      setEditing(false);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const numCls = 'w-20 rounded-lg border border-slate-200 px-1.5 py-0.5 text-right text-xs nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
  const dateCls = 'w-32 rounded-lg border border-slate-200 px-1.5 py-0.5 text-xs focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
  const textCls = 'w-32 rounded-lg border border-slate-200 px-1.5 py-0.5 text-xs focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';

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
      <td className="py-2 text-right"><NumberInput className={numCls} step={1} value={charter} onChange={setCharter} /></td>
      <td className="py-2 text-right"><NumberInput className={numCls} step={0.01} value={taxDep} onChange={setTaxDep} /></td>
      <td className="py-2 text-right"><NumberInput className={numCls} step={0.01} value={taxArr} onChange={setTaxArr} /></td>
      <td className="py-2 text-right"><NumberInput className={numCls} step={0.01} value={fuel} onChange={setFuel} /></td>
      <td className="py-2 text-right"><NumberInput className={numCls} step={0.01} value={peak} onChange={setPeak} /></td>
      <td className="py-2 text-right"><NumberInput className={numCls} step={0.01} allowNegative value={aircraft} onChange={setAircraft} /></td>
      <td className="py-2 text-right"><NumberInput className={numCls} step={0.01} allowNegative value={takeoff} onChange={setTakeoff} /></td>
      <td className="py-2"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} className={textCls} placeholder="备注" /></td>
      <td className="py-2 text-right">
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
      </td>
    </tr>
  );
}

// ── 航班成本（按班次）─ 编辑包机/机场税，并实时显示「单座(已售)成本」─────────
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
        编辑包机/机场税/燃油/旺季附加/机型调整/起降折扣。空白时显示周期默认值（灰字 placeholder）。系统会算出「单座(已售)成本 = 包机总额 ÷ 已售座位数」——帮你定价时看保本线（卖价低于它就亏）。
      </p>

      {loading ? (
        <div className="mt-3 text-sm text-slate-500">加载航班成本…</div>
      ) : err ? (
        <div className="mt-3 text-sm text-rose-600">{err}</div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-muted">
              <tr className="border-b border-slate-200">
                <th className="py-2 text-left font-normal">航班号</th>
                <th className="py-2 text-left font-normal">路线</th>
                <th className="py-2 text-left font-normal">出发日期</th>
                <th className="py-2 text-right font-normal">包机(¥)</th>
                <th className="py-2 text-right font-normal">机场税去(¥)</th>
                <th className="py-2 text-right font-normal">机场税回(¥)</th>
                <th className="py-2 text-right font-normal">燃油(¥)</th>
                <th className="py-2 text-right font-normal">旺季附加(¥)</th>
                <th className="py-2 text-right font-normal">机型调整(¥)</th>
                <th className="py-2 text-right font-normal">起降折扣/机场补贴(¥)</th>
                <th className="py-2 text-right font-normal">已售/总座</th>
                <th className="py-2 text-right font-normal text-blue-700">
                  单座(已售)成本(¥)
                  <span className="block font-normal normal-case tracking-normal text-ink-muted">= 包机总额 ÷ 已售座位（定价参考）</span>
                </th>
                <th className="py-2 text-right font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={13} className="py-4 text-center text-ink-muted">
                    暂无班次
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <FlightScheduleCostRow
                  key={r.scheduleId}
                  row={r}
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
  token,
  onSaved,
}: {
  row: FinanceScheduleRow;
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

  const inputCls = 'w-20 rounded-lg border border-slate-200 px-1.5 py-0.5 text-right text-xs nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';

  async function save(): Promise<void> {
    if (!token) return;
    setSaving(true);
    setSaveErr(null);
    try {
      await api.patchFlightScheduleCost(token, row.scheduleId, {
        charterCostCny: charter,
        airportTaxDepCny: taxDep,
        airportTaxArrCny: taxArr,
        fuelCostCny: fuel,
        peakSurchargeCny: peak,
        aircraftAdjustCny: aircraft,
        takeoffDiscountCny: takeoff,
      });
      onSaved();
    } catch (e: unknown) {
      setSaveErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const perSeatTooltip = row.perSoldSeatCostCny == null
    ? (row.charterCostCny == null ? '包机成本未填' : '还没卖出')
    : '';

  const ph = (period: number | null): string => (period == null ? '' : String(period));

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 font-medium text-slate-900">{row.flightNumber}</td>
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
        <NumberInput
          className={inputCls}
          step={1}
          value={charter}
          placeholder={ph(row.charterCostCnyPeriod)}
          onChange={(n) => setCharter(n)}
        />
      </td>
      <td className="py-2 text-right">
        <NumberInput
          className={inputCls}
          step={0.01}
          value={taxDep}
          placeholder={ph(row.airportTaxDepCnyPeriod)}
          onChange={(n) => setTaxDep(n)}
        />
      </td>
      <td className="py-2 text-right">
        <NumberInput
          className={inputCls}
          step={0.01}
          value={taxArr}
          placeholder={ph(row.airportTaxArrCnyPeriod)}
          onChange={(n) => setTaxArr(n)}
        />
      </td>
      <td className="py-2 text-right">
        <NumberInput
          className={inputCls}
          step={0.01}
          value={fuel}
          placeholder={ph(row.fuelCostCnyPeriod)}
          onChange={(n) => setFuel(n)}
        />
      </td>
      <td className="py-2 text-right">
        <NumberInput
          className={inputCls}
          step={0.01}
          value={peak}
          placeholder={ph(row.peakSurchargeCnyPeriod)}
          onChange={(n) => setPeak(n)}
        />
      </td>
      <td className="py-2 text-right">
        <NumberInput
          className={inputCls}
          step={0.01}
          allowNegative
          value={aircraft}
          placeholder={ph(row.aircraftAdjustCnyPeriod)}
          onChange={(n) => setAircraft(n)}
        />
      </td>
      <td className="py-2 text-right">
        <NumberInput
          className={inputCls}
          step={0.01}
          allowNegative
          value={takeoff}
          placeholder={ph(row.takeoffDiscountCnyPeriod)}
          onChange={(n) => setTakeoff(n)}
        />
      </td>
      <td className="py-2 text-right tabular-nums text-slate-600">
        {row.soldSeats} / {row.totalSeats}
      </td>
      <td
        className="py-2 text-right tabular-nums font-semibold text-blue-700"
        title={perSeatTooltip}
      >
        {fmtCny(row.perSoldSeatCostCny)}
      </td>
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

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const vals: Record<string, number | null> = {};
      for (const f of fields) {
        vals[f.key] = draft[f.key] ?? null;
      }
      await onSave(vals);
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
        机票成本按"卖出座位 × (包机总成本 / 总座位数)"分摊；空座损失（空座沉没）= 剩余空座 × 单座成本，负数=亏损。
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
              <th className="py-2 text-right font-normal text-blue-700">单座(已售)成本</th>
              <th className="py-2 text-right font-normal" title="卖不掉的空座 × 单座成本；负数=亏损">空座损失</th>
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
                    {fmtCny(f.perSoldSeatCostCny)}
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
            毛利 = 订单总价 − Σ(OrderItem.totalCostCny)。某一条目没填成本则全单跳过成本统计。点「明细」看逐项收支。
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
