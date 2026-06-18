import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AdminFlight, type BaggagePolicyInput, type CabinClass, type FareBucket, type FlightBaggagePolicy } from '../lib/api';
import { AIRPORT_OPTIONS, CABIN_LABEL, airportLabel, formatLocalDate, formatLocalTime } from '../lib/airports';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';

// 余位低于此数时高亮提醒（与订单页座位预警口径一致）
const LOW_SEAT_THRESHOLD = 20;

interface ScheduleSeat {
  id: string;
  cabin: CabinClass;
  capacity: number;
  sold: number;
  basePrice: string;
  fareBuckets: FareBucket[] | null;
}

interface AdminSchedule {
  id: string;
  flightId: string;
  departureTime: string;
  arrivalTime: string;
  departureTz: string;
  arrivalTz: string;
  isActive: boolean;
  seatClasses: ScheduleSeat[];
}

export function FlightsPage() {
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);

  const [flights, setFlights] = useState<AdminFlight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [schedulesByFlight, setSchedulesByFlight] = useState<Record<string, AdminSchedule[]>>({});
  const [showNewFlight, setShowNewFlight] = useState(false);
  const [addingScheduleFor, setAddingScheduleFor] = useState<string | null>(null);
  const [bulkAddingFor, setBulkAddingFor] = useState<string | null>(null);
  const [baggageFor, setBaggageFor] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!tokens) return;
    try {
      const res = await api.listAllFlights(tokens.accessToken);
      setFlights(res.flights);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载航班失败');
    }
  }, [tokens]);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggleExpand = async (flightId: string) => {
    if (expanded === flightId) {
      setExpanded(null);
      return;
    }
    setExpanded(flightId);
    if (!schedulesByFlight[flightId] && tokens) {
      try {
        const res = await api.listSchedules(tokens.accessToken, flightId);
        setSchedulesByFlight((prev) => ({
          ...prev,
          [flightId]: res.schedules as AdminSchedule[],
        }));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '加载班次失败');
      }
    }
  };

  const refreshSchedules = async (flightId: string) => {
    if (!tokens) return;
    const res = await api.listSchedules(tokens.accessToken, flightId);
    setSchedulesByFlight((prev) => ({ ...prev, [flightId]: res.schedules as AdminSchedule[] }));
  };

  const onToggleFlight = async (flightId: string) => {
    if (!tokens) return;
    try {
      await api.toggleFlight(tokens.accessToken, flightId);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
    }
  };

  if (user?.role !== 'ADMIN' && user?.role !== 'STAFF') {
    return <div className="card text-ink-soft">仅管理员/运营可访问此页面。</div>;
  }

  if (error) {
    return <div className="card border-rose-200 bg-rose-50 text-rose-700">{error}</div>;
  }
  if (!flights) {
    return <div className="card text-ink-muted">加载中…</div>;
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">航班管理</h1>
          <p className="page-sub">维护自营航班、班次和舱位。</p>
        </div>
        {user.role === 'ADMIN' && (
          <button type="button" className="btn-primary" onClick={() => setShowNewFlight(true)}>
            + 新建航班
          </button>
        )}
      </section>

      {showNewFlight && (
        <NewFlightForm
          onCancel={() => setShowNewFlight(false)}
          onCreated={async () => {
            setShowNewFlight(false);
            await reload();
          }}
        />
      )}

      <section className="space-y-3">
        {flights.length === 0 && <div className="card text-ink-muted">暂无航班，点右上角创建。</div>}
        {flights.map((f) => (
          <div key={f.id} className="card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <span className="inline-flex items-center rounded-md bg-brand-50 px-2 py-0.5 text-sm font-semibold text-brand-700">
                  {f.flightNumber}
                </span>
                <div>
                  <div className="font-medium text-ink">
                    {airportLabel(f.originCode)} → {airportLabel(f.destinationCode)}
                  </div>
                  <div className="text-xs text-ink-muted">
                    机型：{f.aircraftType ?? '—'} · 共 {f.scheduleCount} 个班次
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!f.isActive && (
                  <span className="badge-neutral">整线停售</span>
                )}
                <button type="button" className="btn-secondary text-sm" onClick={() => toggleExpand(f.id)}>
                  {expanded === f.id ? '收起' : '查看班次'}
                </button>
                <button
                  type="button"
                  className="btn-secondary text-sm"
                  onClick={() => setBaggageFor((prev) => (prev === f.id ? null : f.id))}
                >
                  🧳 行李规则
                </button>
                {user.role === 'ADMIN' && (
                  <>
                    <button
                      type="button"
                      className="btn-secondary text-sm"
                      onClick={() => setAddingScheduleFor(f.id)}
                    >
                      + 新班次
                    </button>
                    <button
                      type="button"
                      className="btn-primary text-sm"
                      onClick={() => setBulkAddingFor(f.id)}
                    >
                      📅 批量加班次
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-sm"
                      title="对整条航线（所有班次）停售或恢复"
                      onClick={() => onToggleFlight(f.id)}
                    >
                      {f.isActive ? '整线停售' : '整线恢复'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {addingScheduleFor === f.id && (
              <NewScheduleForm
                flight={f}
                onCancel={() => setAddingScheduleFor(null)}
                onCreated={async () => {
                  setAddingScheduleFor(null);
                  await reload();
                  if (expanded === f.id) await refreshSchedules(f.id);
                }}
              />
            )}

            {bulkAddingFor === f.id && (
              <BulkScheduleForm
                flight={f}
                onCancel={() => setBulkAddingFor(null)}
                onCreated={async () => {
                  setBulkAddingFor(null);
                  await reload();
                  if (expanded === f.id) await refreshSchedules(f.id);
                }}
              />
            )}

            {baggageFor === f.id && (
              <BaggagePolicyEditor flight={f} onClose={() => setBaggageFor(null)} />
            )}

            {expanded === f.id && (
              <SchedulesList
                schedules={schedulesByFlight[f.id] ?? null}
                flightNumber={f.flightNumber}
                canEdit={user.role === 'ADMIN'}
                onRefresh={() => refreshSchedules(f.id)}
              />
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

// ── 日期工具：按时区取本地 YYYY-MM-DD（班次落到日历格用的 key）──────────
// 班次 departureTime 是 UTC ISO；departureTz 决定它属于哪一"天"。
// 用 Intl parts 取本地年月日，跟 formatLocalDate 同口径，避免 UTC slice 跨日错位。
function localYmd(iso: string, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(iso));
    const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const d = parts.find((p) => p.type === 'day')?.value ?? '01';
    return `${y}-${m}-${d}`;
  } catch {
    return iso.slice(0, 10);
  }
}

// 出发文件名用日期（与后端 ordersExportFilename 一致：按 UTC 转日期）
function utcYmd(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// 经济舱余位的三档色：≤20 红 / ≤40 琥珀 / 其余 绿
function seatTone(remaining: number): { text: string; dot: string } {
  if (remaining <= LOW_SEAT_THRESHOLD) return { text: 'text-rose-600', dot: 'bg-rose-500' };
  if (remaining <= 40) return { text: 'text-amber-600', dot: 'bg-amber-500' };
  return { text: 'text-emerald-600', dot: 'bg-emerald-500' };
}

function getCabin(s: AdminSchedule, cabin: CabinClass): ScheduleSeat | undefined {
  return s.seatClasses.find((c) => c.cabin === cabin);
}

// ── 仓位阶梯：常量与工具 ───────────────────────────────────────────────
const MAX_FARE_TIERS = 20;

function hasLadder(buckets: FareBucket[] | null | undefined): buckets is FareBucket[] {
  return Array.isArray(buckets) && buckets.length > 0;
}

// 当前现价：按已售张数 sold 自顶向下走档 —— 第 i 档卖满（Σ前 i 档张数 ≤ sold）
// 就跳到下一档；卖超 Σ张数后停在最后一档价（与后端 per-seat 出售语义一致）。
function currentLadderPrice(buckets: FareBucket[], sold: number): number {
  let cumulative = 0;
  for (const b of buckets) {
    cumulative += b.quota;
    if (sold < cumulative) return b.price;
  }
  return buckets[buckets.length - 1]?.price ?? 0;
}

// 当前停在第几档（0-based）：与 currentLadderPrice 同口径；卖超停在最后一档。
function currentLadderTierIndex(buckets: FareBucket[], sold: number): number {
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    cumulative += buckets[i].quota;
    if (sold < cumulative) return i;
  }
  return Math.max(0, buckets.length - 1);
}

// 某舱位的"当前售价"（镜像后端定价）：有阶梯→当前档价；否则→固定 basePrice。
function seatCurrentPrice(seat: ScheduleSeat): number {
  return hasLadder(seat.fareBuckets)
    ? currentLadderPrice(seat.fareBuckets, seat.sold)
    : Number(seat.basePrice);
}

// 一个班次是否有阶梯（任一舱位设了 fareBuckets 即视为"阶梯"定价）。
function scheduleHasLadder(s: AdminSchedule): boolean {
  return s.seatClasses.some((c) => hasLadder(c.fareBuckets));
}

// 月历格用：在「在售」班次里取经济舱当前售价区间。
// 关键修复：售罄/停售班次绝不参与价格展示，避免显示已关班次的高价。
function activeEconPriceRange(daySchedules: AdminSchedule[]): {
  min: number;
  max: number;
  count: number;
} | null {
  const prices: number[] = [];
  for (const s of daySchedules) {
    if (!s.isActive) continue; // 只看在售班次
    const econ = getCabin(s, 'ECONOMY');
    if (econ) prices.push(seatCurrentPrice(econ));
  }
  if (prices.length === 0) return null;
  return { min: Math.min(...prices), max: Math.max(...prices), count: prices.length };
}

// 月历格用：在「在售」班次里取经济舱余位合计（无在售班次则回退到全部班次的合计，
// 用于展示"已全部售罄"的余位读数）。
function dayEconRemaining(daySchedules: AdminSchedule[]): number {
  const active = daySchedules.filter((s) => s.isActive);
  const pool = active.length > 0 ? active : daySchedules;
  return pool.reduce((sum, s) => {
    const econ = getCabin(s, 'ECONOMY');
    return sum + (econ ? econ.capacity - econ.sold : 0);
  }, 0);
}

// ── 仓位阶梯行编辑器（单点 & 批量复用）──────────────────────────────────
// 受控组件：父持有 FareBucket[] 草稿，这里只负责"加一档 / 改张数 / 改价 / 删除"。
function FareLadderEditor({
  buckets,
  capacity,
  onChange,
  disabled,
}: {
  buckets: FareBucket[];
  // 容量用于 Σ张数 对比提示；批量场景下未知则传 null（不显示对比）。
  capacity: number | null;
  onChange: (next: FareBucket[]) => void;
  disabled?: boolean;
}) {
  const sumQuota = buckets.reduce((sum, b) => sum + (b.quota || 0), 0);
  const mismatch = capacity != null && buckets.length > 0 && sumQuota !== capacity;

  const updateRow = (idx: number, patch: Partial<FareBucket>) => {
    onChange(buckets.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  };
  const removeRow = (idx: number) => {
    onChange(buckets.filter((_, i) => i !== idx));
  };
  const addRow = () => {
    if (buckets.length >= MAX_FARE_TIERS) return;
    const last = buckets[buckets.length - 1];
    onChange([...buckets, { quota: 0, price: last ? last.price : 0 }]);
  };

  return (
    <div className="space-y-1.5">
      {buckets.length === 0 ? (
        <p className="text-xs text-ink-muted">暂无阶梯，点「+ 加一档」开始；从最便宜的一档往后加。</p>
      ) : (
        buckets.map((b, idx) => (
          <div key={idx} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex h-6 w-12 shrink-0 items-center justify-center rounded bg-slate-100 font-medium text-slate-600">
              第{idx + 1}档
            </span>
            <span className="text-ink-muted">张数</span>
            <NumberInput
              min={1}
              className="input h-8 w-20 py-1"
              value={b.quota || null}
              onChange={(n) => updateRow(idx, { quota: n ?? 0 })}
              disabled={disabled}
              integerOnly
            />
            <span className="text-ink-muted">价格 ¥</span>
            <NumberInput
              min={0}
              className="input h-8 w-24 py-1"
              value={b.price ?? null}
              onChange={(n) => updateRow(idx, { price: n ?? 0 })}
              disabled={disabled}
            />
            <button
              type="button"
              className="text-rose-500 hover:text-rose-700 disabled:opacity-40"
              disabled={disabled}
              title="删除该档"
              onClick={() => removeRow(idx)}
            >
              删除
            </button>
          </div>
        ))
      )}
      <div className="flex flex-wrap items-center gap-3 pt-0.5">
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={disabled || buckets.length >= MAX_FARE_TIERS}
          onClick={addRow}
        >
          + 加一档
        </button>
        {buckets.length >= MAX_FARE_TIERS && (
          <span className="text-[11px] text-ink-muted">最多 {MAX_FARE_TIERS} 档</span>
        )}
        {mismatch && (
          <span className="text-[11px] text-amber-600">
            各档张数合计 {sumQuota}，舱位容量 {capacity}（不等也可，卖超按最后一档价）
          </span>
        )}
      </div>
    </div>
  );
}

// 校验阶梯草稿 → 可提交的 FareBucket[]；不合法返回错误文案。
function validateLadder(buckets: FareBucket[]): { ok: true; value: FareBucket[] } | { ok: false; error: string } {
  if (buckets.length === 0) return { ok: false, error: '请至少加一档，或点「清除阶梯」恢复自动定价' };
  if (buckets.length > MAX_FARE_TIERS) return { ok: false, error: `最多 ${MAX_FARE_TIERS} 档` };
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (!Number.isInteger(b.quota) || b.quota < 1) {
      return { ok: false, error: `第${i + 1}档张数需为 ≥1 的整数` };
    }
    if (!Number.isFinite(b.price) || b.price < 0) {
      return { ok: false, error: `第${i + 1}档价格需为 ≥0 的数字` };
    }
  }
  return { ok: true, value: buckets };
}

const WEEK_HEAD = ['日', '一', '二', '三', '四', '五', '六'];

function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// ── 班次：月历库存视图 + 列表（替代原"每天一行"长表）──────────────────
function SchedulesList({
  schedules,
  flightNumber,
  canEdit,
  onRefresh,
}: {
  schedules: AdminSchedule[] | null;
  flightNumber: string;
  canEdit: boolean;
  onRefresh: () => Promise<void> | void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [showBulk, setShowBulk] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);

  // 班次按本地出发日分桶（一天一般一班，但允许一天多班 → 数组）
  const byDay = useMemo(() => {
    const map = new Map<string, AdminSchedule[]>();
    for (const s of schedules ?? []) {
      const key = localYmd(s.departureTime, s.departureTz);
      const arr = map.get(key);
      if (arr) arr.push(s);
      else map.set(key, [s]);
    }
    return map;
  }, [schedules]);

  async function downloadOrdersBySchedule(scheduleId: string, departureDate: string): Promise<void> {
    if (!tokens || exporting) return;
    setExporting(scheduleId);
    setExportErr(null);
    try {
      const blob = await api.downloadOrdersBySchedule(tokens.accessToken, scheduleId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `订单明细_${flightNumber}_${departureDate}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setExportErr(e instanceof ApiError ? e.message : '导出失败');
    } finally {
      setExporting(null);
    }
  }

  if (schedules === null) return <div className="mt-3 text-sm text-ink-muted">加载班次中…</div>;
  if (schedules.length === 0) return <div className="mt-3 text-sm text-ink-muted">还没有班次。</div>;

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-600">共 {schedules.length} 个班次</span>
        <span className="text-slate-300">·</span>
        {/* 视图切换 月历 / 列表 */}
        <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5">
          <button
            type="button"
            className={`px-3 py-1 text-sm rounded transition-colors ${view === 'calendar' ? 'bg-brand text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            onClick={() => setView('calendar')}
          >
            📅 月历
          </button>
          <button
            type="button"
            className={`px-3 py-1 text-sm rounded transition-colors ${view === 'list' ? 'bg-brand text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            onClick={() => setView('list')}
          >
            📋 列表
          </button>
        </div>
        {canEdit && (
          <button
            type="button"
            className="btn-secondary text-sm"
            onClick={() => setShowBulk((v) => !v)}
          >
            {showBulk ? '收起批量操作' : '⚡ 批量改价 / 仓位阶梯'}
          </button>
        )}
      </div>

      {exportErr && (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {exportErr}
        </div>
      )}

      {showBulk && canEdit && (
        <BulkEditPanel
          flightNumber={flightNumber}
          schedules={schedules}
          onClose={() => setShowBulk(false)}
          onDone={onRefresh}
        />
      )}

      {view === 'calendar' ? (
        <MonthCalendar
          schedules={schedules}
          byDay={byDay}
          canEdit={canEdit}
          onRefresh={onRefresh}
          exportingId={exporting}
          onExport={downloadOrdersBySchedule}
        />
      ) : (
        <SchedulesTable
          schedules={schedules}
          exportingId={exporting}
          onExport={downloadOrdersBySchedule}
        />
      )}
    </div>
  );
}

// ── 列表视图（保留原表格，行为不变）─────────────────────────────────────
function SchedulesTable({
  schedules,
  exportingId,
  onExport,
}: {
  schedules: AdminSchedule[];
  exportingId: string | null;
  onExport: (scheduleId: string, departureDate: string) => void;
}) {
  const [monthFilter, setMonthFilter] = useState<string>('upcoming30');
  // 具体日期筛选（按本地出发日）。非空时优先生效，覆盖"月份"下拉。
  const [dateFilter, setDateFilter] = useState<string>('');

  const months = Array.from(new Set(schedules.map((s) => s.departureTime.slice(0, 7)))).sort();
  const now = new Date();
  const thirtyDaysLater = new Date(now.getTime() + 30 * 86400000);

  const filtered = schedules.filter((s) => {
    // 选了具体日期：只看那天（本地出发日），其余筛选忽略
    if (dateFilter) return localYmd(s.departureTime, s.departureTz) === dateFilter;
    if (monthFilter === 'all') return true;
    if (monthFilter === 'upcoming30') {
      const d = new Date(s.departureTime);
      return d >= now && d <= thirtyDaysLater;
    }
    return s.departureTime.startsWith(monthFilter);
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-600">月份:</label>
        <select
          className="input max-w-[200px]"
          value={monthFilter}
          disabled={!!dateFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
        >
          <option value="upcoming30">未来 30 天</option>
          <option value="all">全部（共 {schedules.length} 条）</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {m} ({schedules.filter((s) => s.departureTime.startsWith(m)).length} 条)
            </option>
          ))}
        </select>
        <span className="text-slate-300">·</span>
        <label className="text-sm text-slate-600">具体日期:</label>
        <input
          type="date"
          className="input max-w-[160px]"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
        />
        {dateFilter && (
          <button
            type="button"
            className="text-xs text-brand underline-offset-2 hover:underline"
            onClick={() => setDateFilter('')}
          >
            清除日期
          </button>
        )}
        <span className="text-xs text-slate-500">显示 {filtered.length} 条</span>
      </div>
      <div className="overflow-x-auto">
        <table className="table-admin">
          <thead>
            <tr>
              <th className="text-left">出发</th>
              <th className="text-left">到达</th>
              <th className="text-left">舱位 / 余票 / 价格</th>
              <th className="text-left">状态</th>
              <th className="text-left">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => {
              const departureDate = utcYmd(s.departureTime);
              const isExporting = exportingId === s.id;
              return (
                <tr key={s.id}>
                  <td>
                    <div className="font-medium text-ink">
                      {formatLocalDate(s.departureTime, s.departureTz)} {formatLocalTime(s.departureTime, s.departureTz)}
                    </div>
                    <div className="text-xs text-ink-muted">{s.departureTz}</div>
                  </td>
                  <td>
                    <div className="font-medium text-ink">
                      {formatLocalDate(s.arrivalTime, s.arrivalTz)} {formatLocalTime(s.arrivalTime, s.arrivalTz)}
                    </div>
                    <div className="text-xs text-ink-muted">{s.arrivalTz}</div>
                  </td>
                  <td>
                    <ul className="space-y-0.5">
                      {s.seatClasses.map((c) => {
                        const remaining = c.capacity - c.sold;
                        const isLow = remaining <= LOW_SEAT_THRESHOLD;
                        return (
                          <li key={c.id}>
                            {CABIN_LABEL[c.cabin] ?? c.cabin}:{' '}
                            <span className={isLow ? 'font-medium text-rose-600' : 'font-medium text-ink'}>
                              {remaining}
                            </span>
                            /<span className="font-medium text-ink">{c.capacity}</span> · ¥{Number(c.basePrice).toFixed(0)}
                            {isLow && <span className="ml-1 text-xs text-rose-600">余位紧张</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </td>
                  <td>
                    {s.isActive ? (
                      <span className="badge-success">在售</span>
                    ) : (
                      <span className="badge-neutral">售罄/暂停销售</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-secondary text-xs whitespace-nowrap"
                      disabled={isExporting}
                      title="下载该班次的所有订单明细（xlsx，不含成本）"
                      onClick={() => onExport(s.id, departureDate)}
                    >
                      {isExporting ? '导出中…' : '📋 导出整班订单'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 月历视图（一次一个月，◀ ▶ 切月）─────────────────────────────────────
function MonthCalendar({
  schedules,
  byDay,
  canEdit,
  onRefresh,
  exportingId,
  onExport,
}: {
  schedules: AdminSchedule[];
  byDay: Map<string, AdminSchedule[]>;
  canEdit: boolean;
  onRefresh: () => Promise<void> | void;
  exportingId: string | null;
  onExport: (scheduleId: string, departureDate: string) => void;
}) {
  // 默认月份：当前月若有班次则当前月，否则最近一个有班次的月份
  const defaultMonth = useMemo(() => {
    const today = new Date();
    const thisMonth = monthKeyOf(today);
    const monthsWithData = Array.from(byDay.keys()).map((d) => d.slice(0, 7));
    if (monthsWithData.includes(thisMonth)) return new Date(today.getFullYear(), today.getMonth(), 1);
    const future = monthsWithData.filter((m) => m >= thisMonth).sort();
    const pick = future[0] ?? monthsWithData.sort()[monthsWithData.length - 1] ?? thisMonth;
    const [y, m] = pick.split('-').map(Number);
    return new Date(y, m - 1, 1);
  }, [byDay]);

  const [cursor, setCursor] = useState<Date>(defaultMonth);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const year = cursor.getFullYear();
  const month = cursor.getMonth(); // 0-based
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay(); // 0 = 周日
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // 拼出 7×N 网格的每个格子（前补空、后补空）
  const cells: Array<{ ymd: string; day: number } | null> = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const ymd = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ ymd, day: d });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const monthCount = schedules.filter(
    (s) => localYmd(s.departureTime, s.departureTz).slice(0, 7) === monthKeyOf(cursor),
  ).length;

  const todayYmd = localYmd(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="btn-secondary text-sm"
          onClick={() => {
            setSelectedDay(null);
            setCursor(new Date(year, month - 1, 1));
          }}
        >
          ◀
        </button>
        <div className="text-center">
          <div className="text-base font-semibold text-ink">
            {year} 年 {month + 1} 月
          </div>
          <div className="text-xs text-ink-muted">本月 {monthCount} 个班次</div>
        </div>
        <button
          type="button"
          className="btn-secondary text-sm"
          onClick={() => {
            setSelectedDay(null);
            setCursor(new Date(year, month + 1, 1));
          }}
        >
          ▶
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {WEEK_HEAD.map((w) => (
          <div key={w} className="py-1 text-center text-xs font-medium text-ink-muted">
            {w}
          </div>
        ))}
        {cells.map((cell, idx) => {
          if (!cell) return <div key={`empty-${idx}`} className="min-h-[64px] rounded-md bg-slate-50/40" />;
          const daySchedules = byDay.get(cell.ymd) ?? [];
          const hasData = daySchedules.length > 0;
          const isToday = cell.ymd === todayYmd;
          const isSelected = selectedDay === cell.ymd;

          if (!hasData) {
            return (
              <div
                key={cell.ymd}
                className={`min-h-[64px] rounded-md border border-slate-100 bg-white p-1.5 text-xs text-ink-muted ${isToday ? 'ring-1 ring-brand/40' : ''}`}
              >
                <span className={isToday ? 'font-semibold text-brand' : ''}>{cell.day}</span>
              </div>
            );
          }

          // 多班次时：价格/余位只看「在售」班次，售罄/停售班次绝不参与展示
          // （修复 700/800 在售阶梯被 1480 已关班次盖掉的 bug）。
          const allInactive = daySchedules.every((s) => !s.isActive);
          const remaining = dayEconRemaining(daySchedules);
          const tone = seatTone(remaining);
          const priceRange = activeEconPriceRange(daySchedules); // null = 无在售班次
          // 「阶梯/固定价」一眼可辨：以在售班次为准（无在售时回退看全部）。
          const ladderPool = allInactive ? daySchedules : daySchedules.filter((s) => s.isActive);
          const dayHasLadder = ladderPool.some(scheduleHasLadder);

          return (
            <button
              type="button"
              key={cell.ymd}
              onClick={() => setSelectedDay(isSelected ? null : cell.ymd)}
              className={`min-h-[64px] rounded-md border p-1.5 text-left transition-shadow hover:shadow-md ${
                isSelected ? 'border-brand ring-2 ring-brand/40' : 'border-slate-200'
              } ${allInactive ? 'bg-slate-100 opacity-70' : 'bg-white'}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className={`text-xs ${isToday ? 'font-semibold text-brand' : 'text-ink-muted'}`}>
                  {cell.day}
                </span>
                <span className="flex items-center gap-0.5">
                  {/* 阶梯 / 固定价 一眼可辨 */}
                  {dayHasLadder ? (
                    <span
                      className="rounded bg-brand-50 px-1 text-[9px] font-medium text-brand-700"
                      title="按仓位阶梯出售（手动分档定价），价格随已售推进"
                    >
                      阶梯
                    </span>
                  ) : (
                    <span
                      className="rounded bg-slate-100 px-1 text-[9px] font-medium text-slate-500"
                      title="固定价（未设阶梯）：写多少卖多少"
                    >
                      固定价
                    </span>
                  )}
                  {allInactive && (
                    <span className="text-[10px] leading-none text-slate-400" title="售罄/暂停销售">
                      ✕
                    </span>
                  )}
                  {daySchedules.length > 1 && (
                    <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">
                      {daySchedules.length}班
                    </span>
                  )}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                <span className={`text-sm font-semibold ${tone.text}`}>{remaining}</span>
                <span className="text-[10px] text-ink-muted">余位</span>
              </div>
              {/* 售价只取在售班次（已关班次不参与），多班在售取最低～最高 */}
              {priceRange ? (
                <div className="flex items-center gap-1 text-[11px] text-ink-soft">
                  <span>
                    ¥{priceRange.min.toFixed(0)}
                    {priceRange.max > priceRange.min && `～${priceRange.max.toFixed(0)}`}
                  </span>
                  {priceRange.count > 1 && (
                    <span className="text-[9px] text-ink-muted" title="取在售班次的最低～最高经济舱售价">
                      在售{priceRange.count}班
                    </span>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-slate-400" title="当天所有班次均已售罄/停售">
                  无在售
                </div>
              )}
            </button>
          );
        })}
      </div>

      {selectedDay && (byDay.get(selectedDay)?.length ?? 0) > 0 && (
        <DayCellEditor
          ymd={selectedDay}
          schedules={byDay.get(selectedDay) ?? []}
          canEdit={canEdit}
          onClose={() => setSelectedDay(null)}
          onSaved={onRefresh}
          exportingId={exportingId}
          onExport={onExport}
        />
      )}
    </div>
  );
}

// ── 某一天的内联编辑器（改经济/商务价 + 售罄/恢复销售 + 导出整班订单）────────
function DayCellEditor({
  ymd,
  schedules,
  canEdit,
  onClose,
  onSaved,
  exportingId,
  onExport,
}: {
  ymd: string;
  schedules: AdminSchedule[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  exportingId: string | null;
  onExport: (scheduleId: string, departureDate: string) => void;
}) {
  return (
    <section className="rounded-lg border border-brand/30 bg-slate-50 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-slate-900">{ymd} · {schedules.length} 个班次</h3>
        <button type="button" className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="mt-3 space-y-3">
        {schedules.map((s) => (
          <DaySchedule
            key={s.id}
            schedule={s}
            canEdit={canEdit}
            onSaved={onSaved}
            exportingId={exportingId}
            onExport={onExport}
          />
        ))}
      </div>
    </section>
  );
}

function DaySchedule({
  schedule,
  canEdit,
  onSaved,
  exportingId,
  onExport,
}: {
  schedule: AdminSchedule;
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
  exportingId: string | null;
  onExport: (scheduleId: string, departureDate: string) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const econ = getCabin(schedule, 'ECONOMY');
  const biz = getCabin(schedule, 'BUSINESS');

  const [econPrice, setEconPrice] = useState<number | null>(econ ? Number(econ.basePrice) : null);
  const [bizPrice, setBizPrice] = useState<number | null>(biz ? Number(biz.basePrice) : null);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // 该班次的总已售（任一舱位 sold>0 即视为"已有销售"，禁止删除）。
  const totalSold = schedule.seatClasses.reduce((sum, c) => sum + c.sold, 0);

  // 仓位阶梯草稿（按舱位）—— 初值取自该舱位已有阶梯，深拷贝避免改到 props。
  const [econLadder, setEconLadder] = useState<FareBucket[]>(
    econ?.fareBuckets ? econ.fareBuckets.map((b) => ({ ...b })) : [],
  );
  const [bizLadder, setBizLadder] = useState<FareBucket[]>(
    biz?.fareBuckets ? biz.fareBuckets.map((b) => ({ ...b })) : [],
  );
  const [ladderBusy, setLadderBusy] = useState<CabinClass | null>(null);
  const [ladderErr, setLadderErr] = useState<string | null>(null);
  const [ladderMsg, setLadderMsg] = useState<string | null>(null);

  const econRemaining = econ ? econ.capacity - econ.sold : 0;
  const tone = seatTone(econRemaining);
  const isExporting = exportingId === schedule.id;
  const departureDate = utcYmd(schedule.departureTime);

  const onSavePrices = async () => {
    if (!tokens || saving) return;
    setSaving(true);
    setErr(null);
    setSavedMsg(null);
    try {
      const seatClasses: Array<{ cabin: CabinClass; basePrice?: number }> = [];
      if (econ && econPrice != null) seatClasses.push({ cabin: 'ECONOMY', basePrice: econPrice });
      if (biz && bizPrice != null) seatClasses.push({ cabin: 'BUSINESS', basePrice: bizPrice });
      if (seatClasses.length === 0) {
        setErr('没有可保存的舱位价格');
        setSaving(false);
        return;
      }
      await api.updateSchedule(tokens.accessToken, schedule.id, { seatClasses });
      setSavedMsg('✅ 已保存');
      await onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const onToggle = async () => {
    if (!tokens || toggling) return;
    setToggling(true);
    setErr(null);
    setSavedMsg(null);
    try {
      await api.updateSchedule(tokens.accessToken, schedule.id, { isActive: !schedule.isActive });
      await onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      setToggling(false);
    }
  };

  // 删除班次：已有销售（sold>0）时按钮本就 disabled；这里再兜底拦一次。
  // 后端对有订单关联的班次也会拒绝/转停用，按返回信息提示。
  const onDelete = async () => {
    if (!tokens || deleting) return;
    if (totalSold > 0) {
      setErr('已有销售，不能删除（请用售罄）');
      return;
    }
    const depTime = formatLocalTime(schedule.departureTime, schedule.departureTz);
    if (!confirm(`确认删除该班次（出发 ${depTime}）？此操作不可恢复。`)) return;
    setDeleting(true);
    setErr(null);
    setSavedMsg(null);
    try {
      await api.deleteSchedule(tokens.accessToken, schedule.id);
      await onSaved();
    } catch (e) {
      // 后端 sold>0 / 有订单关联会回 400，把其信息透传给操作员。
      setErr(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  // 保存某舱位的仓位阶梯（数组）。单独传 fareBuckets 即有效修改。
  const onSaveLadder = async (cabin: CabinClass, draft: FareBucket[]) => {
    if (!tokens || ladderBusy) return;
    const v = validateLadder(draft);
    if (!v.ok) {
      setLadderErr(`${CABIN_LABEL[cabin] ?? cabin}：${v.error}`);
      return;
    }
    setLadderBusy(cabin);
    setLadderErr(null);
    setLadderMsg(null);
    try {
      await api.updateSchedule(tokens.accessToken, schedule.id, {
        seatClasses: [{ cabin, fareBuckets: v.value }],
      });
      setLadderMsg(`✅ ${CABIN_LABEL[cabin] ?? cabin}阶梯已保存`);
      await onSaved();
    } catch (e) {
      setLadderErr(e instanceof ApiError ? e.message : '保存阶梯失败');
    } finally {
      setLadderBusy(null);
    }
  };

  // 清除某舱位的阶梯（传 [] → 后端清空，恢复自动定价）。
  const onClearLadder = async (cabin: CabinClass) => {
    if (!tokens || ladderBusy) return;
    setLadderBusy(cabin);
    setLadderErr(null);
    setLadderMsg(null);
    try {
      await api.updateSchedule(tokens.accessToken, schedule.id, {
        seatClasses: [{ cabin, fareBuckets: [] }],
      });
      if (cabin === 'ECONOMY') setEconLadder([]);
      else if (cabin === 'BUSINESS') setBizLadder([]);
      setLadderMsg(`✅ ${CABIN_LABEL[cabin] ?? cabin}已恢复自动定价`);
      await onSaved();
    } catch (e) {
      setLadderErr(e instanceof ApiError ? e.message : '清除阶梯失败');
    } finally {
      setLadderBusy(null);
    }
  };

  // 渲染单个舱位的阶梯小节（经济总有；商务存在才显示）。
  const renderLadderSection = (cabin: CabinClass, seat: ScheduleSeat, draft: FareBucket[], setDraft: (next: FareBucket[]) => void) => {
    const liveHint = hasLadder(seat.fareBuckets)
      ? `当前现价 ¥${currentLadderPrice(seat.fareBuckets, seat.sold).toFixed(0)}`
      : '当前无阶梯（自动定价）';
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-ink">
            {CABIN_LABEL[cabin] ?? cabin}仓位阶梯
            <span className="ml-2 font-normal text-ink-muted">{liveHint}</span>
          </span>
          <button
            type="button"
            className="text-xs text-ink-muted underline-offset-2 hover:text-rose-600 hover:underline disabled:opacity-40"
            disabled={ladderBusy != null || !hasLadder(seat.fareBuckets)}
            title="清除阶梯，恢复自动定价"
            onClick={() => onClearLadder(cabin)}
          >
            清除阶梯（恢复自动定价）
          </button>
        </div>
        <div className="mt-2">
          <FareLadderEditor
            buckets={draft}
            capacity={seat.capacity}
            onChange={setDraft}
            disabled={ladderBusy != null}
          />
        </div>
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            className="btn-primary text-xs"
            disabled={ladderBusy != null}
            onClick={() => onSaveLadder(cabin, draft)}
          >
            {ladderBusy === cabin ? '保存中…' : '保存阶梯'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-medium text-ink">
            出发 {formatLocalTime(schedule.departureTime, schedule.departureTz)}
          </span>
          <span className="mx-1 text-slate-300">·</span>
          <span className="text-ink-muted">到达 {formatLocalTime(schedule.arrivalTime, schedule.arrivalTz)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {/* 阶梯 / 固定价：一眼看出这个班次有没有在用仓位阶梯定价 */}
          {scheduleHasLadder(schedule) ? (
            <span
              className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700"
              title="按仓位阶梯出售（手动分档定价）"
            >
              阶梯
            </span>
          ) : (
            <span
              className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500"
              title="固定价（未设阶梯）：写多少卖多少"
            >
              固定价
            </span>
          )}
          {schedule.isActive ? (
            <span className="badge-success">在售</span>
          ) : (
            <span className="badge-neutral">售罄/暂停销售</span>
          )}
        </div>
      </div>

      {/* 余位/已售（只读）*/}
      <div className="mt-2 flex flex-wrap gap-4 text-xs">
        {econ && (
          <span>
            经济舱余位 <span className={`font-semibold ${tone.text}`}>{econRemaining}</span> / {econ.capacity}
            <span className="ml-1 text-ink-muted">（已售 {econ.sold}）</span>
          </span>
        )}
        {biz && (
          <span>
            商务舱余位 <span className="font-semibold text-ink">{biz.capacity - biz.sold}</span> / {biz.capacity}
            <span className="ml-1 text-ink-muted">（已售 {biz.sold}）</span>
          </span>
        )}
      </div>

      {/* 当前售价（醒目）：镜像后端 —— 有阶梯则显示当前档价 + 第N档，否则显示固定价。
          直接回答"我写多少就卖多少？"：固定价=是；阶梯=以当前档为准。 */}
      {(econ || biz) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {[econ, biz].filter((c): c is ScheduleSeat => Boolean(c)).map((seat) => {
            const ladder = hasLadder(seat.fareBuckets);
            const price = seatCurrentPrice(seat);
            const tierIdx = hasLadder(seat.fareBuckets)
              ? currentLadderTierIndex(seat.fareBuckets, seat.sold)
              : -1;
            return (
              <span
                key={seat.cabin}
                className={`inline-flex items-baseline gap-1 rounded-md px-2.5 py-1 text-xs ${
                  ladder ? 'bg-brand-50 text-brand-800' : 'bg-emerald-50 text-emerald-800'
                }`}
              >
                <span className="text-ink-muted">{CABIN_LABEL[seat.cabin] ?? seat.cabin}当前售价</span>
                <span className="text-sm font-bold">¥{price.toFixed(0)}</span>
                {ladder ? (
                  <span className="text-[11px] font-medium">· 阶梯第{tierIdx + 1}档</span>
                ) : (
                  <span className="text-[11px] font-medium">· 固定价</span>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* 改价（仅 ADMIN）：有阶梯时基础价不是现售价，标注清楚避免误改 */}
      {canEdit && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {econ && (
            <div>
              <label className="label">
                {hasLadder(econ.fareBuckets) ? '经济舱基础价（未设阶梯时生效）(¥)' : '经济舱价 (¥)'}
              </label>
              <NumberInput min={0} className="input" value={econPrice} onChange={(n) => setEconPrice(n)} />
              {hasLadder(econ.fareBuckets) && (
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  当前按阶梯出售，此价仅在清除阶梯后才生效。
                </p>
              )}
            </div>
          )}
          {biz && (
            <div>
              <label className="label">
                {hasLadder(biz.fareBuckets) ? '商务舱基础价（未设阶梯时生效）(¥)' : '商务舱价 (¥)'}
              </label>
              <NumberInput min={0} className="input" value={bizPrice} onChange={(n) => setBizPrice(n)} />
              {hasLadder(biz.fareBuckets) && (
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  当前按阶梯出售，此价仅在清除阶梯后才生效。
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 仓位阶梯（仅 ADMIN）：每个有座的舱位一个小节 —— 每档几张 + 价格，自顶向下卖 */}
      {canEdit && (econ || biz) && (
        <div className="mt-3 space-y-2">
          <div className="text-xs font-medium text-ink-soft">仓位阶梯（按仓位卖：每档几张 + 价格；卖满跳下一档）</div>
          {econ && renderLadderSection('ECONOMY', econ, econLadder, setEconLadder)}
          {biz && renderLadderSection('BUSINESS', biz, bizLadder, setBizLadder)}
          {ladderErr && <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{ladderErr}</div>}
          {ladderMsg && <div className="text-xs text-emerald-700">{ladderMsg}</div>}
        </div>
      )}

      {err && <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {savedMsg && <span className="text-xs text-emerald-700">{savedMsg}</span>}
        <button
          type="button"
          className="btn-secondary text-xs whitespace-nowrap"
          disabled={isExporting}
          title="下载该班次的所有订单明细（xlsx，不含成本）"
          onClick={() => onExport(schedule.id, departureDate)}
        >
          {isExporting ? '导出中…' : '📋 导出整班订单'}
        </button>
        {canEdit && (
          <>
            <button
              type="button"
              className="btn-secondary text-xs text-rose-600 hover:bg-rose-50 disabled:text-slate-300 disabled:hover:bg-transparent"
              title={totalSold > 0 ? '已有销售，不能删除（请用售罄）' : '彻底删除该班次（不可恢复）'}
              disabled={deleting || totalSold > 0}
              onClick={onDelete}
            >
              {deleting ? '删除中…' : '删除班次'}
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              title="只对该单个班次售罄或恢复销售"
              disabled={toggling}
              onClick={onToggle}
            >
              {toggling ? '处理中…' : schedule.isActive ? '售罄' : '恢复销售'}
            </button>
            <button type="button" className="btn-primary text-xs" disabled={saving} onClick={onSavePrices}>
              {saving ? '保存中…' : '保存价格'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── 批量改价 / 批量仓位阶梯（日期范围 + 星期几 + 进度条；镜像 BulkScheduleForm）─
// 注：批量「售罄/恢复销售」已移除（机位卖完即售罄，不需手动批量调）；
// 单班次的售罄/恢复按钮保留在 DaySchedule。
type BulkAction = 'setPrice' | 'addAmount' | 'addPercent' | 'setLadder' | 'clearLadder';
type BulkCabinPick = 'ECONOMY' | 'BUSINESS' | 'ALL';

function BulkEditPanel({
  flightNumber,
  schedules,
  onClose,
  onDone,
}: {
  flightNumber: string;
  schedules: AdminSchedule[];
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const tokens = useAuth((s) => s.tokens);

  function addDays(offset: number): string {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  const [startDate, setStartDate] = useState(addDays(0));
  const [endDate, setEndDate] = useState(addDays(30));
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4, 5, 6]));
  const [action, setAction] = useState<BulkAction>('setPrice');
  const [cabinPick, setCabinPick] = useState<BulkCabinPick>('ECONOMY');
  const [amount, setAmount] = useState<number | null>(0);
  // 批量设阶梯用的统一阶梯草稿 + 舱位（仅经济/商务，不支持"全部"）
  const [ladderDraft, setLadderDraft] = useState<FareBucket[]>([]);
  const [ladderCabin, setLadderCabin] = useState<CabinClass>('ECONOMY');
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, errors: 0 });
  const [result, setResult] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const isPriceAction = action === 'setPrice' || action === 'addAmount' || action === 'addPercent';
  const isLadderAction = action === 'setLadder' || action === 'clearLadder';

  // 命中的班次：本地出发日 ∈ [start,end] 且 星期几被选中
  const matched = useMemo(() => {
    if (!startDate || !endDate) return [];
    return schedules.filter((s) => {
      const ymd = localYmd(s.departureTime, s.departureTz);
      if (ymd < startDate || ymd > endDate) return false;
      const [y, m, d] = ymd.split('-').map(Number);
      const dow = new Date(y, m - 1, d).getDay();
      return weekdays.has(dow);
    });
  }, [schedules, startDate, endDate, weekdays]);

  const toggleWeekday = (day: number) => {
    setWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  const cabinsToEdit = (s: AdminSchedule): CabinClass[] => {
    if (cabinPick === 'ALL') return s.seatClasses.map((c) => c.cabin);
    return getCabin(s, cabinPick) ? [cabinPick] : [];
  };

  const buildBody = (s: AdminSchedule):
    | { seatClasses: Array<{ cabin: CabinClass; basePrice?: number; fareBuckets?: FareBucket[] | null }> }
    | null => {
    // 阶梯类操作：只动选定的单一舱位（经济/商务），该班次没有此舱位则跳过
    if (isLadderAction) {
      if (!getCabin(s, ladderCabin)) return null;
      if (action === 'clearLadder') return { seatClasses: [{ cabin: ladderCabin, fareBuckets: [] }] };
      return { seatClasses: [{ cabin: ladderCabin, fareBuckets: ladderDraft }] };
    }
    const cabins = cabinsToEdit(s);
    if (cabins.length === 0) return null;
    const amt = amount ?? 0;
    const seatClasses = cabins.map((cabin) => {
      const seat = getCabin(s, cabin)!;
      const cur = Number(seat.basePrice);
      let next = cur;
      if (action === 'setPrice') next = amt;
      else if (action === 'addAmount') next = cur + amt;
      else if (action === 'addPercent') next = Math.round(cur * (1 + amt / 100));
      return { cabin, basePrice: Math.max(0, next) };
    });
    return { seatClasses };
  };

  const actionLabel = (): string => {
    const cab = cabinPick === 'ALL' ? '全部舱位' : CABIN_LABEL[cabinPick];
    const ladderCab = CABIN_LABEL[ladderCabin] ?? ladderCabin;
    if (action === 'setPrice') return `把 ${cab} 价设为 ¥${amount ?? 0}`;
    if (action === 'addAmount') return `${cab} 价上调 ¥${amount ?? 0}`;
    if (action === 'addPercent') return `${cab} 价上调 ${amount ?? 0}%`;
    if (action === 'setLadder') return `把 ${ladderCab} 设为 ${ladderDraft.length} 档仓位阶梯`;
    return `清除 ${ladderCab} 仓位阶梯（恢复自动定价）`;
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tokens) return;
    if (matched.length === 0) {
      setErrMsg('没有命中的班次，检查日期范围和星期几');
      return;
    }
    if (action === 'setLadder') {
      const v = validateLadder(ladderDraft);
      if (!v.ok) {
        setErrMsg(v.error);
        return;
      }
    }
    if (!confirm(`将对 ${matched.length} 个班次执行：${actionLabel()}，确认？`)) return;

    setErrMsg(null);
    setResult(null);
    setSubmitting(true);
    setProgress({ done: 0, total: matched.length, errors: 0 });

    let done = 0;
    let errors = 0;
    let lastError = '';
    for (const s of matched) {
      const body = buildBody(s);
      if (!body) {
        done++;
        setProgress({ done: done + errors, total: matched.length, errors });
        continue;
      }
      try {
        await api.updateSchedule(tokens.accessToken, s.id, body);
        done++;
      } catch (e2) {
        errors++;
        lastError = e2 instanceof ApiError ? e2.message : '失败';
      }
      setProgress({ done: done + errors, total: matched.length, errors });
    }

    setSubmitting(false);
    setResult(`✅ 完成：成功 ${done} 个${errors > 0 ? ` · 失败 ${errors} 个（${lastError}）` : ''}`);
    await onDone();
  };

  return (
    <section className="rounded-lg border-2 border-brand/50 bg-brand/5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900">
          ⚡ 批量操作 <span className="text-brand">{flightNumber}</span> 班次
        </h3>
        <button type="button" className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="text-xs text-slate-500 mt-0.5">按日期范围 + 星期几，批量改价 / 设置或清除仓位阶梯</p>

      <form className="mt-4 grid gap-3 md:grid-cols-4" onSubmit={onSubmit}>
        <div>
          <label className="label">起始日期</label>
          <input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <label className="label">结束日期</label>
          <input type="date" className="input" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <label className="label">适用星期</label>
          <div className="flex gap-1">
            {WEEK_HEAD.map((d, i) => (
              <button
                key={i}
                type="button"
                className={`flex-1 py-2 rounded text-sm ${weekdays.has(i) ? 'bg-brand text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                onClick={() => toggleWeekday(i)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">操作</label>
          <select className="input" value={action} onChange={(e) => setAction(e.target.value as BulkAction)}>
            <option value="setPrice">设为指定价</option>
            <option value="addAmount">在原价上涨 ¥X</option>
            <option value="addPercent">涨 X%</option>
            <option value="setLadder">设置仓位阶梯</option>
            <option value="clearLadder">清除仓位阶梯</option>
          </select>
        </div>
        {isPriceAction && (
          <>
            <div>
              <label className="label">舱位</label>
              <select className="input" value={cabinPick} onChange={(e) => setCabinPick(e.target.value as BulkCabinPick)}>
                <option value="ECONOMY">经济舱</option>
                <option value="BUSINESS">商务舱</option>
                <option value="ALL">全部</option>
              </select>
            </div>
            <div>
              <label className="label">
                {action === 'setPrice' ? '目标价 (¥)' : action === 'addPercent' ? '涨幅 (%)' : '涨价 (¥)'}
              </label>
              <NumberInput min={0} className="input" value={amount} onChange={(n) => setAmount(n)} />
            </div>
          </>
        )}
        {isLadderAction && (
          <div>
            <label className="label">舱位</label>
            <select className="input" value={ladderCabin} onChange={(e) => setLadderCabin(e.target.value as CabinClass)}>
              <option value="ECONOMY">经济舱</option>
              <option value="BUSINESS">商务舱</option>
            </select>
          </div>
        )}
        {action === 'setLadder' && (
          <div className="md:col-span-4 rounded-md border border-slate-200 bg-white p-3">
            <div className="mb-2 text-xs font-medium text-ink-soft">
              统一仓位阶梯（每档几张 + 价格，自顶向下卖；将套用到所有命中班次的{CABIN_LABEL[ladderCabin] ?? ladderCabin}）
            </div>
            {/* 批量场景容量因班次而异，传 null 不显示 Σ对比 */}
            <FareLadderEditor buckets={ladderDraft} capacity={null} onChange={setLadderDraft} disabled={submitting} />
          </div>
        )}

        <div className="md:col-span-4 rounded-md bg-white border border-slate-200 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600">命中班次数</span>
            <span className="text-2xl font-bold text-brand">{matched.length} 个</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">将执行：{actionLabel()}</div>
          {submitting && (
            <div className="mt-2">
              <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand transition-all"
                  style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
                />
              </div>
              <div className="text-xs text-slate-500 mt-1">
                进度: {progress.done} / {progress.total} · 失败 {progress.errors}
              </div>
            </div>
          )}
          {result && <div className="mt-2 text-sm text-green-700">{result}</div>}
          {errMsg && <div className="mt-2 text-sm text-rose-700">{errMsg}</div>}
        </div>

        <div className="md:col-span-4 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onClose}>取消</button>
          <button type="submit" className="btn-primary" disabled={submitting || matched.length === 0}>
            {submitting ? `处理中 ${progress.done}/${progress.total}...` : `执行（${matched.length} 个班次）`}
          </button>
        </div>
      </form>
    </section>
  );
}

// ── 创建航班 ──
function NewFlightForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const tokens = useAuth((s) => s.tokens);
  const [flightNumber, setFlightNumber] = useState('');
  const [originCode, setOriginCode] = useState('DAD');
  const [destinationCode, setDestinationCode] = useState('MFM');
  const [aircraftType, setAircraftType] = useState('Airbus A321-211');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tokens) return;
    setErr(null);
    setSubmitting(true);
    try {
      await api.createFlight(tokens.accessToken, {
        flightNumber,
        originCode,
        destinationCode,
        aircraftType: aircraftType || undefined,
      });
      onCreated();
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card border-brand/30">
      <h2 className="text-lg font-semibold text-slate-900">新建航班</h2>
      <form className="mt-4 grid gap-4 md:grid-cols-4" onSubmit={onSubmit}>
        <div>
          <label className="label" htmlFor="flightNumber">航班号 *</label>
          <input
            id="flightNumber"
            required
            className="input"
            placeholder="如 FT2001"
            value={flightNumber}
            onChange={(e) => setFlightNumber(e.target.value.toUpperCase())}
          />
        </div>
        <div>
          <label className="label" htmlFor="originCode">出发机场</label>
          <select className="input" id="originCode" value={originCode} onChange={(e) => setOriginCode(e.target.value)}>
            {AIRPORT_OPTIONS.map((a) => (
              <option key={a.code} value={a.code}>{a.name} ({a.code})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="destinationCode">到达机场</label>
          <select className="input" id="destinationCode" value={destinationCode} onChange={(e) => setDestinationCode(e.target.value)}>
            {AIRPORT_OPTIONS.map((a) => (
              <option key={a.code} value={a.code}>{a.name} ({a.code})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="aircraftType">机型</label>
          <input
            id="aircraftType"
            className="input"
            value={aircraftType}
            onChange={(e) => setAircraftType(e.target.value)}
          />
        </div>
        {err && <div className="md:col-span-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="md:col-span-4 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </form>
    </section>
  );
}

// ── 创建班次 ──
function NewScheduleForm({
  flight,
  onCancel,
  onCreated,
}: {
  flight: AdminFlight;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const tokens = useAuth((s) => s.tokens);

  function defaultDate(offsetDays = 7): string {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  }

  const [date, setDate] = useState(defaultDate());
  const [departTime, setDepartTime] = useState('09:00');
  const [durationHours, setDurationHours] = useState<number | null>(2);
  const [econCapacity, setEconCapacity] = useState<number | null>(150);
  const [econPrice, setEconPrice] = useState<number | null>(800);
  const [bizCapacity, setBizCapacity] = useState<number | null>(20);
  const [bizPrice, setBizPrice] = useState<number | null>(3000);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tokens) return;
    setErr(null);
    setSubmitting(true);
    try {
      const dHours = durationHours ?? 1;
      const econCap = econCapacity ?? 0;
      const econPr = econPrice ?? 0;
      const bizCap = bizCapacity ?? 0;
      const bizPr = bizPrice ?? 0;
      // Asia/Shanghai (UTC+8) — 把本地 date+time 换算到 UTC ISO
      const [y, m, d] = date.split('-').map(Number);
      const [h, mi] = departTime.split(':').map(Number);
      const depUTC = new Date(Date.UTC(y, m - 1, d, h - 8, mi, 0)).toISOString();
      const arrUTC = new Date(
        Date.UTC(y, m - 1, d, h - 8, mi, 0) + dHours * 3600 * 1000,
      ).toISOString();

      await api.createSchedule(tokens.accessToken, {
        flightId: flight.id,
        departureTime: depUTC,
        arrivalTime: arrUTC,
        departureTz: 'Asia/Shanghai',
        arrivalTz: 'Asia/Shanghai',
        seatClasses: [
          { cabin: 'ECONOMY', capacity: econCap, basePrice: econPr },
          ...(bizCap > 0
            ? [{ cabin: 'BUSINESS' as const, capacity: bizCap, basePrice: bizPr }]
            : []),
        ],
      });
      onCreated();
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mt-4 rounded-lg border border-brand/30 bg-slate-50 p-4">
      <h3 className="font-medium text-slate-900">
        为 <span className="text-brand">{flight.flightNumber}</span> 添加新班次
      </h3>
      <form className="mt-3 grid gap-3 md:grid-cols-6" onSubmit={onSubmit}>
        <div className="md:col-span-2">
          <label className="label">出发日期（本地）</label>
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">出发时间</label>
          <input type="time" className="input" value={departTime} onChange={(e) => setDepartTime(e.target.value)} />
        </div>
        <div>
          <label className="label">飞行时长 (小时)</label>
          <NumberInput
            step={0.5}
            min={0.5}
            max={20}
            className="input"
            value={durationHours}
            onChange={(n) => setDurationHours(n)}
          />
        </div>
        <div>
          <label className="label">经济舱座位</label>
          <NumberInput
            min={0}
            className="input"
            value={econCapacity}
            onChange={(n) => setEconCapacity(n)}
            integerOnly
          />
        </div>
        <div>
          <label className="label">经济舱价 (¥)</label>
          <NumberInput
            min={0}
            className="input"
            value={econPrice}
            onChange={(n) => setEconPrice(n)}
          />
        </div>
        <div>
          <label className="label">商务舱座位</label>
          <NumberInput
            min={0}
            className="input"
            value={bizCapacity}
            onChange={(n) => setBizCapacity(n)}
            integerOnly
          />
        </div>
        <div>
          <label className="label">商务舱价 (¥)</label>
          <NumberInput
            min={0}
            className="input"
            value={bizPrice}
            onChange={(n) => setBizPrice(n)}
          />
        </div>

        {err && <div className="md:col-span-6 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

        <div className="md:col-span-6 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? '创建中…' : '添加班次'}
          </button>
        </div>
      </form>
    </section>
  );
}

// ── 批量创建班次 ────────────────────────────────────────────────
function BulkScheduleForm({
  flight,
  onCancel,
  onCreated,
}: {
  flight: AdminFlight;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const tokens = useAuth((s) => s.tokens);

  function addDays(offset: number): string {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  const [startDate, setStartDate] = useState(addDays(30));
  const [endDate, setEndDate] = useState(addDays(90));
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4, 5, 6])); // 全选
  const [departTime, setDepartTime] = useState('11:40');
  const [durationMinutes, setDurationMinutes] = useState<number | null>(105);
  const [econCapacity, setEconCapacity] = useState<number | null>(180);
  const [econPrice, setEconPrice] = useState<number | null>(1380);
  const [bizCapacity, setBizCapacity] = useState<number | null>(20);
  const [bizPrice, setBizPrice] = useState<number | null>(4280);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, errors: 0 });
  const [result, setResult] = useState<string | null>(null);

  // 预估将创建的班次数
  const previewCount = useMemo(() => {
    if (!startDate || !endDate) return 0;
    const s = new Date(startDate);
    const e = new Date(endDate);
    if (e < s) return 0;
    let count = 0;
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      if (weekdays.has(d.getDay())) count++;
    }
    return count;
  }, [startDate, endDate, weekdays]);

  const toggleWeekday = (day: number) => {
    setWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tokens) return;
    if (previewCount === 0) { alert('没有日期可创建，检查日期范围和星期几'); return; }
    if (!confirm(`将创建 ${previewCount} 个班次，确认？`)) return;

    setSubmitting(true);
    setProgress({ done: 0, total: previewCount, errors: 0 });

    const s = new Date(startDate);
    const e2 = new Date(endDate);
    let done = 0, errors = 0;

    const depTz = flight.originCode === 'DAD' ? 'Asia/Ho_Chi_Minh' : 'Asia/Macau';
    const arrTz = flight.destinationCode === 'DAD' ? 'Asia/Ho_Chi_Minh' : 'Asia/Macau';
    const [hour, minute] = departTime.split(':').map(Number);
    const offsetHours = depTz === 'Asia/Macau' ? 8 : 7;
    const dMin = durationMinutes ?? 0;
    const econCap = econCapacity ?? 0;
    const econPr = econPrice ?? 0;
    const bizCap = bizCapacity ?? 0;
    const bizPr = bizPrice ?? 0;

    for (let d = new Date(s); d <= e2; d.setDate(d.getDate() + 1)) {
      if (!weekdays.has(d.getDay())) continue;
      try {
        const y = d.getFullYear();
        const m = d.getMonth();
        const day = d.getDate();
        const depUTC = new Date(Date.UTC(y, m, day, hour - offsetHours, minute, 0)).toISOString();
        const arrUTC = new Date(Date.UTC(y, m, day, hour - offsetHours, minute, 0) + dMin * 60 * 1000).toISOString();
        await api.createSchedule(tokens.accessToken, {
          flightId: flight.id,
          departureTime: depUTC,
          arrivalTime: arrUTC,
          departureTz: depTz,
          arrivalTz: arrTz,
          seatClasses: [
            { cabin: 'ECONOMY', capacity: econCap, basePrice: econPr },
            ...(bizCap > 0 ? [{ cabin: 'BUSINESS' as const, capacity: bizCap, basePrice: bizPr }] : []),
          ],
        });
        done++;
      } catch {
        errors++;
      }
      setProgress({ done: done + errors, total: previewCount, errors });
    }

    setSubmitting(false);
    setResult(`✅ 完成：成功 ${done} 个${errors > 0 ? ` · 失败 ${errors} 个（已存在或冲突）` : ''}`);
    if (errors < previewCount) setTimeout(onCreated, 2000);
  };

  const DOW_LABEL = ['日', '一', '二', '三', '四', '五', '六'];

  return (
    <section className="mt-4 rounded-lg border-2 border-brand/50 bg-brand/5 p-4">
      <h3 className="font-semibold text-slate-900">
        📅 批量添加 <span className="text-brand">{flight.flightNumber}</span> 班次
      </h3>
      <p className="text-xs text-slate-500 mt-0.5">按日期范围 + 星期几，批量生成相同时刻的班次</p>

      <form className="mt-4 grid gap-3 md:grid-cols-4" onSubmit={onSubmit}>
        <div>
          <label className="label">起始日期</label>
          <input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <label className="label">结束日期</label>
          <input type="date" className="input" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <label className="label">适用星期</label>
          <div className="flex gap-1">
            {DOW_LABEL.map((d, i) => (
              <button
                key={i}
                type="button"
                className={`flex-1 py-2 rounded text-sm ${weekdays.has(i) ? 'bg-brand text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                onClick={() => toggleWeekday(i)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">出发时间（本地）</label>
          <input type="time" className="input" value={departTime} onChange={(e) => setDepartTime(e.target.value)} />
        </div>
        <div>
          <label className="label">飞行时长（分钟）</label>
          <NumberInput min={30} max={600} className="input" value={durationMinutes} onChange={(n) => setDurationMinutes(n)} integerOnly />
        </div>
        <div>
          <label className="label">经济座位 / 单价</label>
          <div className="flex gap-1">
            <NumberInput min={0} className="input" value={econCapacity} onChange={(n) => setEconCapacity(n)} integerOnly />
            <NumberInput min={0} className="input" placeholder="¥" value={econPrice} onChange={(n) => setEconPrice(n)} />
          </div>
        </div>
        <div>
          <label className="label">商务座位 / 单价</label>
          <div className="flex gap-1">
            <NumberInput min={0} className="input" value={bizCapacity} onChange={(n) => setBizCapacity(n)} integerOnly />
            <NumberInput min={0} className="input" placeholder="¥" value={bizPrice} onChange={(n) => setBizPrice(n)} />
          </div>
        </div>

        <div className="md:col-span-4 rounded-md bg-white border border-slate-200 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600">预计创建班次数</span>
            <span className="text-2xl font-bold text-brand">{previewCount} 个</span>
          </div>
          {submitting && (
            <div className="mt-2">
              <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                <div className="h-full bg-brand transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
              </div>
              <div className="text-xs text-slate-500 mt-1">进度: {progress.done} / {progress.total} · 失败 {progress.errors}</div>
            </div>
          )}
          {result && <div className="mt-2 text-sm text-green-700">{result}</div>}
        </div>

        <div className="md:col-span-4 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary" disabled={submitting || previewCount === 0}>
            {submitting ? `创建中 ${progress.done}/${progress.total}...` : `批量创建 ${previewCount} 个班次`}
          </button>
        </div>
      </form>
    </section>
  );
}

// ── 行李规则（航班 × 舱等；ADMIN/STAFF 维护）────────────────────────────
const BAGGAGE_CABINS: CabinClass[] = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'];

interface BaggageRowDraft {
  enabled: boolean;
  checkedKg: number | null;
  checkedPieces: number | null;
  carryOnKg: number | null;
  note: string;
}

function policiesToDraft(policies: FlightBaggagePolicy[]): Record<CabinClass, BaggageRowDraft> {
  const draft = {} as Record<CabinClass, BaggageRowDraft>;
  for (const cabin of BAGGAGE_CABINS) {
    const p = policies.find((x) => x.cabin === cabin);
    draft[cabin] = {
      enabled: !!p,
      checkedKg: p?.checkedKg ?? null,
      checkedPieces: p?.checkedPieces ?? null,
      carryOnKg: p?.carryOnKg ?? null,
      note: p?.note ?? '',
    };
  }
  return draft;
}

function BaggagePolicyEditor({ flight, onClose }: { flight: AdminFlight; onClose: () => void }) {
  const tokens = useAuth((s) => s.tokens);
  const [rows, setRows] = useState<Record<CabinClass, BaggageRowDraft> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!tokens) return;
    api
      .getBaggagePolicies(tokens.accessToken, flight.id)
      .then((res) => {
        if (!cancelled) setRows(policiesToDraft(res.policies));
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '加载行李规则失败');
      });
    return () => {
      cancelled = true;
    };
  }, [tokens, flight.id]);

  const updateRow = (cabin: CabinClass, patch: Partial<BaggageRowDraft>) => {
    setRows((prev) => (prev ? { ...prev, [cabin]: { ...prev[cabin], ...patch } } : prev));
    setSavedMsg(null);
  };

  const onSave = async () => {
    if (!tokens || !rows || saving) return;
    setSaving(true);
    setErr(null);
    setSavedMsg(null);
    try {
      const items: BaggagePolicyInput[] = BAGGAGE_CABINS.filter((c) => rows[c].enabled).map((c) => ({
        cabin: c,
        checkedKg: rows[c].checkedKg,
        checkedPieces: rows[c].checkedPieces,
        carryOnKg: rows[c].carryOnKg,
        note: rows[c].note.trim() ? rows[c].note.trim() : null,
      }));
      const res = await api.saveBaggagePolicies(tokens.accessToken, flight.id, items);
      setRows(policiesToDraft(res.policies));
      setSavedMsg('✅ 已保存');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-4 rounded-lg border border-brand/30 bg-slate-50 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-slate-900">
          🧳 <span className="text-brand">{flight.flightNumber}</span> 行李规则（按舱等配置；kg / 件数 / 手提可分别留空）
        </h3>
        <button type="button" className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>×</button>
      </div>

      {err && <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
      {!rows && !err && <div className="mt-3 text-sm text-slate-500">加载行李规则中…</div>}

      {rows && (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="table-admin">
              <thead>
                <tr>
                  <th className="text-left">舱等</th>
                  <th className="text-left">启用</th>
                  <th className="text-left">托运 (kg/人)</th>
                  <th className="text-left">托运件数 (件/人)</th>
                  <th className="text-left">手提 (kg/人)</th>
                  <th className="text-left">补充说明</th>
                </tr>
              </thead>
              <tbody>
                {BAGGAGE_CABINS.map((cabin) => {
                  const row = rows[cabin];
                  return (
                    <tr key={cabin} className={row.enabled ? '' : 'opacity-50'}>
                      <td className="font-medium text-ink whitespace-nowrap">
                        {CABIN_LABEL[cabin] ?? cabin}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          onChange={(e) => updateRow(cabin, { enabled: e.target.checked })}
                        />
                      </td>
                      <td>
                        <NumberInput
                          min={0}
                          max={999}
                          className="input w-24"
                          placeholder="如 23"
                          value={row.checkedKg}
                          onChange={(n) => updateRow(cabin, { checkedKg: n })}
                          disabled={!row.enabled}
                          integerOnly
                        />
                      </td>
                      <td>
                        <NumberInput
                          min={0}
                          max={99}
                          className="input w-24"
                          placeholder="如 1"
                          value={row.checkedPieces}
                          onChange={(n) => updateRow(cabin, { checkedPieces: n })}
                          disabled={!row.enabled}
                          integerOnly
                        />
                      </td>
                      <td>
                        <NumberInput
                          min={0}
                          max={99}
                          className="input w-24"
                          placeholder="如 7"
                          value={row.carryOnKg}
                          onChange={(n) => updateRow(cabin, { carryOnKg: n })}
                          disabled={!row.enabled}
                          integerOnly
                        />
                      </td>
                      <td>
                        <input
                          className="input w-full min-w-[180px]"
                          maxLength={500}
                          placeholder="如 超件 ¥200/件"
                          value={row.note}
                          onChange={(e) => updateRow(cabin, { note: e.target.value })}
                          disabled={!row.enabled}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-end gap-3">
            {savedMsg && <span className="text-sm text-emerald-700">{savedMsg}</span>}
            <span className="text-xs text-ink-muted">未启用的舱等保存后将删除其规则</span>
            <button type="button" className="btn-secondary" onClick={onClose}>关闭</button>
            <button type="button" className="btn-primary" disabled={saving} onClick={onSave}>
              {saving ? '保存中…' : '保存行李规则'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
