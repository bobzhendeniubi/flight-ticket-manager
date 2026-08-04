import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AdminFlight, type BaggagePolicyInput, type CabinClass, type FareBucket, type FlightBaggagePolicy } from '../lib/api';
import { AIRPORT_OPTIONS, CABIN_LABEL, airportLabel, formatLocalDate, formatLocalTime, tzLabel } from '../lib/airports';
import { useAuth } from '../stores/auth';
import { useFlightSeats } from '../stores/flightSeats';
import { NumberInput } from '../components/NumberInput';

interface ScheduleSeat {
  id: string;
  cabin: CabinClass;
  capacity: number;
  sold: number;
  // 后端权威口径：available = capacity − sold − locked（与前台一致）。
  locked: number;
  available: number;
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
  const seatsVersion = useFlightSeats((s) => s.seatsVersion);
  const bumpSeats = useFlightSeats((s) => s.bumpSeats);

  const [flights, setFlights] = useState<AdminFlight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [schedulesByFlight, setSchedulesByFlight] = useState<Record<string, AdminSchedule[]>>({});
  const [showNewFlight, setShowNewFlight] = useState(false);
  // 批量删除班次 / +新班次 / 批量加班次 三个内联面板互斥：同一时间全站只允许一个展开。
  const [activePanel, setActivePanel] = useState<{
    id: string;
    panel: 'bulkDelete' | 'addOne' | 'bulkAdd' | 'businessLink';
  } | null>(null);
  const [baggageFor, setBaggageFor] = useState<string | null>(null);

  const togglePanel = (id: string, panel: 'bulkDelete' | 'addOne' | 'bulkAdd' | 'businessLink') => {
    setActivePanel((prev) => (prev && prev.id === id && prev.panel === panel ? null : { id, panel }));
  };

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

  const refreshSchedules = useCallback(
    async (flightId: string) => {
      if (!tokens) return;
      const res = await api.listSchedules(tokens.accessToken, flightId);
      setSchedulesByFlight((prev) => ({ ...prev, [flightId]: res.schedules as AdminSchedule[] }));
    },
    [tokens],
  );

  // 班次发生改价/改容量/新增等会影响余位的修改后：刷新本页 + 广播座位变更信号。
  const refreshSchedulesAndBump = useCallback(
    async (flightId: string) => {
      await refreshSchedules(flightId);
      bumpSeats();
    },
    [refreshSchedules, bumpSeats],
  );

  const toggleExpand = async (flightId: string) => {
    if (expanded === flightId) {
      setExpanded(null);
      return;
    }
    setExpanded(flightId);
    // 每次展开都重新拉取该航班班次余位（不再缓存），避免在别处建单后余位读数过期。
    try {
      await refreshSchedules(flightId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载班次失败');
    }
  };

  // 座位变更信号：任一已展开航班在他处发生建单/退订后，重新拉取其余位。
  useEffect(() => {
    if (seatsVersion === 0 || !expanded) return;
    refreshSchedules(expanded).catch(() => undefined);
  }, [seatsVersion, expanded, refreshSchedules]);

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
                <button
                  type="button"
                  className="btn-secondary text-sm"
                  title="按出发日区间批量删除该航班班次（已售班次自动跳过）"
                  onClick={() => togglePanel(f.id, 'bulkDelete')}
                >
                  🗑️ 批量删除班次
                </button>
                {user.role === 'ADMIN' && (
                  <>
                    <button
                      type="button"
                      className="btn-secondary text-sm"
                      title="设置升舱差价（¥/程/座）与商务舱价格联动经济舱"
                      onClick={() => togglePanel(f.id, 'businessLink')}
                    >
                      💺 升舱/联动{f.businessPriceLinked ? '（已联动）' : ''}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-sm"
                      onClick={() => togglePanel(f.id, 'addOne')}
                    >
                      + 新班次
                    </button>
                    <button
                      type="button"
                      className="btn-primary text-sm"
                      onClick={() => togglePanel(f.id, 'bulkAdd')}
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

            {activePanel?.id === f.id && activePanel.panel === 'addOne' && (
              <NewScheduleForm
                flight={f}
                onCancel={() => setActivePanel(null)}
                onCreated={async () => {
                  setActivePanel(null);
                  await reload();
                  if (expanded === f.id) await refreshSchedules(f.id);
                  bumpSeats();
                }}
              />
            )}

            {activePanel?.id === f.id && activePanel.panel === 'bulkAdd' && (
              <BulkScheduleForm
                flight={f}
                onCancel={() => setActivePanel(null)}
                onCreated={async () => {
                  setActivePanel(null);
                  await reload();
                  if (expanded === f.id) await refreshSchedules(f.id);
                  bumpSeats();
                }}
              />
            )}

            {activePanel?.id === f.id && activePanel.panel === 'bulkDelete' && (
              <BatchDeleteScheduleForm
                flight={f}
                onCancel={() => setActivePanel(null)}
                onDone={async () => {
                  await reload();
                  if (expanded === f.id) await refreshSchedules(f.id);
                  bumpSeats();
                }}
                onClose={() => setActivePanel(null)}
              />
            )}

            {activePanel?.id === f.id && activePanel.panel === 'businessLink' && (
              <FlightBusinessLinkEditor
                flight={f}
                onCancel={() => setActivePanel(null)}
                onSaved={async () => {
                  setActivePanel(null);
                  await reload();
                  if (expanded === f.id) await refreshSchedulesAndBump(f.id);
                }}
              />
            )}

            {baggageFor === f.id && (
              <BaggagePolicyEditor flight={f} onClose={() => setBaggageFor(null)} />
            )}

            {expanded === f.id && (
              <SchedulesList
                flight={f}
                schedules={schedulesByFlight[f.id] ?? null}
                flightNumber={f.flightNumber}
                originCode={f.originCode}
                destinationCode={f.destinationCode}
                canEdit={user.role === 'ADMIN'}
                onRefresh={() => refreshSchedulesAndBump(f.id)}
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

// 单舱位余位是否"紧张"：按容量比例判断，不再用绝对 20 张——
// 一个 20 座（甚至 2、7 座）商务舱订满时 remaining === capacity，绝不该判紧张。
// 地板 5 张兜住极小舱位（避免比例算出 0～1 张这种没意义的门槛），但门槛本身
// 夹到 < capacity——否则地板反超总容量，连"满仓"都会被误判紧张（真实发生过：
// 2 座舱位满仓时 max(5, ceil(2*0.1))=5 ≥ capacity，2 <= 5 恒真）。
function isSeatLow(remaining: number, capacity: number): boolean {
  const cutoff = Math.min(capacity - 1, Math.max(5, Math.ceil(capacity * 0.1)));
  return remaining <= cutoff;
}

// 舱位余位三档色（红/琥珀/绿）：红门槛与 isSeatLow 同口径，琥珀门槛加宽一倍（同样夹到 < capacity）。
// 比例在 180~200 座经济舱下约等于旧版固定 20/40（基本不变行为）；
// 小舱位（商务舱 2~20 座）不再因为绝对数字小而常年误报"紧张"。
// 余位为负（超售）走更深的红，与"仅仅紧张"区分开。
function seatTone(remaining: number, capacity: number): { text: string; dot: string } {
  if (remaining < 0) return { text: 'text-rose-700', dot: 'bg-rose-600' };
  if (isSeatLow(remaining, capacity)) return { text: 'text-rose-600', dot: 'bg-rose-500' };
  const amberCut = Math.min(capacity - 1, Math.max(10, Math.ceil(capacity * 0.2)));
  if (remaining <= amberCut) return { text: 'text-amber-600', dot: 'bg-amber-500' };
  return { text: 'text-emerald-600', dot: 'bg-emerald-500' };
}

// 余位读数文案：负数不是"负几张票"，而是欠了几座 —— 一律写成「超售 N」。
// 容量被航司减配/换机型压到已售之下时会出现（销售侧照旧按容量拒卖）。
function seatRemainingText(remaining: number): string {
  return remaining < 0 ? `超售 ${-remaining}` : String(remaining);
}

// 余位为负时的统一悬浮说明（列表 / 月历 / 班次卡共用一句话）。
const OVERSOLD_HINT = '容量已低于已售 + 锁位，需与航司 / 操作部协调；销售侧照旧不再卖出。';

function getCabin(s: AdminSchedule, cabin: CabinClass): ScheduleSeat | undefined {
  return (s.seatClasses ?? []).find((c) => c.cabin === cabin);
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
// || 0 兜住 basePrice 为空串/null 时 Number(...) 产生 NaN，避免渲染抛错。
function seatCurrentPrice(seat: ScheduleSeat): number {
  return hasLadder(seat.fareBuckets)
    ? currentLadderPrice(seat.fareBuckets, seat.sold)
    : (Number(seat.basePrice) || 0);
}

// 商务舱价格联动经济舱的派生现价（镜像后端 PricingService.calculatePrice 单一口径）：
//   航班开了 businessPriceLinked 且本舱位是商务舱时：现价 = 经济舱当前售价 + 航班升舱差价；
//   经济舱缺价（无经济舱舱位 / 现价 ≤0）→ fallback（回退商务舱自身现价，调用方据此提示）。
//   非联动 / 非商务舱 → 返回 null，调用方走原有 seatCurrentPrice / basePrice 逻辑。
function linkedBusinessPrice(
  flight: AdminFlight,
  schedule: AdminSchedule,
  seat: ScheduleSeat,
): { price: number; fallback: boolean } | null {
  if (seat.cabin !== 'BUSINESS' || !flight.businessPriceLinked) return null;
  const econ = getCabin(schedule, 'ECONOMY');
  const econUnit = econ ? seatCurrentPrice(econ) : 0;
  if (econUnit > 0) return { price: econUnit + flight.businessUpgradeCnyPerLeg, fallback: false };
  return { price: seatCurrentPrice(seat), fallback: true };
}

// 一个班次是否有阶梯（任一舱位设了 fareBuckets 即视为"阶梯"定价）。
function scheduleHasLadder(s: AdminSchedule): boolean {
  return (s.seatClasses ?? []).some((c) => hasLadder(c.fareBuckets));
}

// ── 售罄 vs 已下架：两个状态，两套判据，互不替代 ───────────────────────────
// 售罄 = 派生：所有舱位余位 ≤ 0（与后端余位档位 available ≤ 0 → SOLD_OUT 同源）。
//        机位卖完即售罄，没有、也不需要人工开关。
// 已下架 = 人工：isActive === false。运营主动收起，前台不可售，可调价后重新上架。
// 两者可以同时成立（卖完了、又被下架），因此徽标并存而不互斥。
function isScheduleSoldOut(s: AdminSchedule): boolean {
  const seats = s.seatClasses ?? [];
  return seats.length > 0 && seats.every((c) => c.available <= 0);
}

// 月历格「无在售」的原因：售罄与已下架是两件事，据实说明是哪一种。
function noSaleReason(daySchedules: AdminSchedule[]): string {
  const soldOut = daySchedules.filter(isScheduleSoldOut).length;
  if (soldOut === daySchedules.length) return '当天所有班次均已售罄';
  if (soldOut === 0) return '当天所有班次均已下架';
  return '当天所有班次已售罄或已下架';
}

// 月历格用：在「在售」班次里取经济舱当前售价区间。
// 关键修复：已下架班次绝不参与价格展示，避免显示已关班次的高价。
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
// 用于展示"已全部下架"的余位读数）。
function dayEconRemaining(daySchedules: AdminSchedule[]): number {
  const active = daySchedules.filter((s) => s.isActive);
  const pool = active.length > 0 ? active : daySchedules;
  return pool.reduce((sum, s) => {
    const econ = getCabin(s, 'ECONOMY');
    return sum + (econ ? econ.available : 0);
  }, 0);
}

// 月历格用：经济舱容量合计——与 dayEconRemaining 同一个班次池，配对喂给 seatTone
// 做"占比"判断（而不是让色阶继续用绝对张数）。
function dayEconCapacity(daySchedules: AdminSchedule[]): number {
  const active = daySchedules.filter((s) => s.isActive);
  const pool = active.length > 0 ? active : daySchedules;
  return pool.reduce((sum, s) => {
    const econ = getCabin(s, 'ECONOMY');
    return sum + (econ ? econ.capacity : 0);
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
  flight,
  schedules,
  flightNumber,
  originCode,
  destinationCode,
  canEdit,
  onRefresh,
}: {
  flight: AdminFlight;
  schedules: AdminSchedule[] | null;
  flightNumber: string;
  originCode: string;
  destinationCode: string;
  canEdit: boolean;
  onRefresh: () => Promise<void> | void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [showBulk, setShowBulk] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportingFull, setExportingFull] = useState(false);
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

  // 导出该班次「全岗可用」名单（full 模板：分人金额 + 票务/签证补列）。按班次出发日过滤，避免导出全部日期。
  async function downloadFullTemplateByFlight(scheduleId: string, departureDate: string): Promise<void> {
    if (!tokens || exportingFull) return;
    setExportingFull(true);
    setExportErr(null);
    try {
      // 精确按班次导出，只含该班次当天订单（travelFrom/travelTo 会 ±1 天放宽，漏进相邻日）。
      const blob = await api.downloadOrdersTemplateExport(tokens.accessToken, {
        template: 'full',
        flightNumber,
        scheduleId,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `整班全岗_${flightNumber}_${departureDate || new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setExportErr(e instanceof ApiError ? e.message : '导出失败');
    } finally {
      setExportingFull(false);
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
          flight={flight}
          schedules={schedules}
          byDay={byDay}
          canEdit={canEdit}
          onRefresh={onRefresh}
          exportingId={exporting}
          onExport={downloadOrdersBySchedule}
          exportingFull={exportingFull}
          onExportFull={downloadFullTemplateByFlight}
        />
      ) : (
        <SchedulesTable
          flight={flight}
          schedules={schedules}
          originCode={originCode}
          destinationCode={destinationCode}
          exportingId={exporting}
          onExport={downloadOrdersBySchedule}
          exportingFull={exportingFull}
          onExportFull={downloadFullTemplateByFlight}
        />
      )}
    </div>
  );
}

// ── 列表视图（保留原表格，行为不变）─────────────────────────────────────
function SchedulesTable({
  flight,
  schedules,
  originCode,
  destinationCode,
  exportingId,
  onExport,
  exportingFull,
  onExportFull,
}: {
  flight: AdminFlight;
  schedules: AdminSchedule[];
  originCode: string;
  destinationCode: string;
  exportingId: string | null;
  onExport: (scheduleId: string, departureDate: string) => void;
  exportingFull: boolean;
  onExportFull: (scheduleId: string, departureDate: string) => void;
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
                    <div className="text-xs text-ink-muted">
                      {airportLabel(originCode)}
                      <span className="ml-1 text-[10px] text-ink-muted/70">({tzLabel(s.departureTz)})</span>
                    </div>
                  </td>
                  <td>
                    <div className="font-medium text-ink">
                      {formatLocalDate(s.arrivalTime, s.arrivalTz)} {formatLocalTime(s.arrivalTime, s.arrivalTz)}
                    </div>
                    <div className="text-xs text-ink-muted">
                      {airportLabel(destinationCode)}
                      <span className="ml-1 text-[10px] text-ink-muted/70">({tzLabel(s.arrivalTz)})</span>
                    </div>
                  </td>
                  <td>
                    <ul className="space-y-0.5">
                      {(s.seatClasses ?? []).map((c) => {
                        const remaining = c.available;
                        const oversold = remaining < 0;
                        const isLow = isSeatLow(remaining, c.capacity);
                        const linked = linkedBusinessPrice(flight, s, c);
                        const priceText = linked
                          ? `¥${linked.price.toFixed(0)}`
                          : `¥${(Number(c.basePrice) || 0).toFixed(0)}`;
                        return (
                          <li key={c.id}>
                            {CABIN_LABEL[c.cabin] ?? c.cabin}:{' '}
                            <span
                              className={
                                oversold
                                  ? 'font-bold text-rose-700'
                                  : isLow
                                    ? 'font-medium text-rose-600'
                                    : 'font-medium text-ink'
                              }
                              title={oversold ? OVERSOLD_HINT : undefined}
                            >
                              {seatRemainingText(remaining)}
                            </span>
                            /<span className="font-medium text-ink">{c.capacity}</span> · {priceText}
                            {linked && !linked.fallback && (
                              <span
                                className="ml-1 text-[10px] text-brand"
                                title="商务舱价格联动经济舱：经济舱现价 + 航班升舱差价"
                              >
                                联动
                              </span>
                            )}
                            {linked?.fallback && (
                              <span
                                className="ml-1 text-[10px] text-amber-600"
                                title="经济舱缺价，已回退商务舱自身价"
                              >
                                联动回退
                              </span>
                            )}
                            {isLow && <span className="ml-1 text-xs text-rose-600">余位紧张</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </td>
                  <td>
                    {/* 售罄（余位卖完，派生）与已下架（人工收起）分开渲染，可同时出现 */}
                    <div className="flex flex-wrap items-center gap-1">
                      {isScheduleSoldOut(s) && (
                        <span className="badge-neutral" title="机位已售完（自动判定，无需人工操作）">
                          售罄
                        </span>
                      )}
                      {!s.isActive && (
                        <span className="badge-neutral" title="已下架：前台不可售，可调价后重新上架">
                          已下架
                        </span>
                      )}
                      {s.isActive && !isScheduleSoldOut(s) && <span className="badge-success">在售</span>}
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        className="btn-secondary text-xs whitespace-nowrap"
                        disabled={isExporting}
                        title="下载该班次的所有订单明细（xlsx，不含成本）"
                        onClick={() => onExport(s.id, departureDate)}
                      >
                        {isExporting ? '导出中…' : '📋 导出整班订单'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary text-xs whitespace-nowrap"
                        disabled={exportingFull}
                        title="导出该班次「全岗可用」名单（分人金额 + 票务/签证补列，xlsx）"
                        onClick={() => onExportFull(s.id, departureDate)}
                      >
                        {exportingFull ? '导出中…' : '📋 导出整班·全岗'}
                      </button>
                    </div>
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
  flight,
  schedules,
  byDay,
  canEdit,
  onRefresh,
  exportingId,
  onExport,
  exportingFull,
  onExportFull,
}: {
  flight: AdminFlight;
  schedules: AdminSchedule[];
  byDay: Map<string, AdminSchedule[]>;
  canEdit: boolean;
  onRefresh: () => Promise<void> | void;
  exportingId: string | null;
  onExport: (scheduleId: string, departureDate: string) => void;
  exportingFull: boolean;
  onExportFull: (scheduleId: string, departureDate: string) => void;
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

          // 多班次时：价格/余位只看「在售」班次，已下架班次绝不参与展示
          // （修复 700/800 在售阶梯被 1480 已关班次盖掉的 bug）。
          const allInactive = daySchedules.every((s) => !s.isActive);
          const remaining = dayEconRemaining(daySchedules);
          const tone = seatTone(remaining, dayEconCapacity(daySchedules));
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
                    <span className="text-[10px] leading-none text-slate-400" title="当天所有班次均已下架">
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
              <div className="mt-1 flex items-center gap-1" title={remaining < 0 ? OVERSOLD_HINT : undefined}>
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                <span className={`text-sm font-semibold ${tone.text}`}>
                  {seatRemainingText(remaining)}
                </span>
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
                <div className="text-[11px] text-slate-400" title={noSaleReason(daySchedules)}>
                  无在售
                </div>
              )}
            </button>
          );
        })}
      </div>

      {selectedDay && (byDay.get(selectedDay)?.length ?? 0) > 0 && (
        <DayCellEditor
          flight={flight}
          ymd={selectedDay}
          schedules={byDay.get(selectedDay) ?? []}
          canEdit={canEdit}
          onClose={() => setSelectedDay(null)}
          onSaved={onRefresh}
          exportingId={exportingId}
          onExport={onExport}
          exportingFull={exportingFull}
          onExportFull={onExportFull}
        />
      )}
    </div>
  );
}

// ── 某一天的内联编辑器（改经济/商务价 + 下架/重新上架 + 导出整班订单）────────
function DayCellEditor({
  flight,
  ymd,
  schedules,
  canEdit,
  onClose,
  onSaved,
  exportingId,
  onExport,
  exportingFull,
  onExportFull,
}: {
  flight: AdminFlight;
  ymd: string;
  schedules: AdminSchedule[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  exportingId: string | null;
  onExport: (scheduleId: string, departureDate: string) => void;
  exportingFull: boolean;
  onExportFull: (scheduleId: string, departureDate: string) => void;
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
            flight={flight}
            schedule={s}
            canEdit={canEdit}
            onSaved={onSaved}
            exportingId={exportingId}
            onExport={onExport}
            exportingFull={exportingFull}
            onExportFull={onExportFull}
          />
        ))}
      </div>
    </section>
  );
}

function DaySchedule({
  flight,
  schedule,
  canEdit,
  onSaved,
  exportingId,
  onExport,
  exportingFull,
  onExportFull,
}: {
  flight: AdminFlight;
  schedule: AdminSchedule;
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
  exportingId: string | null;
  onExport: (scheduleId: string, departureDate: string) => void;
  exportingFull: boolean;
  onExportFull: (scheduleId: string, departureDate: string) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const econ = getCabin(schedule, 'ECONOMY');
  const biz = getCabin(schedule, 'BUSINESS');
  // 商务舱价格联动经济舱：开启后商务舱 basePrice 不参与计价（派生 = 经济舱现价 + 航班升舱差价）。
  const bizLinked = biz ? linkedBusinessPrice(flight, schedule, biz) : null;

  const [econPrice, setEconPrice] = useState<number | null>(econ ? (Number(econ.basePrice) || 0) : null);
  const [bizPrice, setBizPrice] = useState<number | null>(biz ? (Number(biz.basePrice) || 0) : null);
  const [econCapacity, setEconCapacity] = useState<number | null>(econ ? econ.capacity : null);
  const [bizCapacity, setBizCapacity] = useState<number | null>(biz ? biz.capacity : null);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // 改时刻弹窗
  const [showTimeEdit, setShowTimeEdit] = useState(false);
  const [timeDep, setTimeDep] = useState('');
  const [timeArr, setTimeArr] = useState('');
  const [timeSaving, setTimeSaving] = useState(false);
  const [timeErr, setTimeErr] = useState<string | null>(null);
  const [timeMsg, setTimeMsg] = useState<string | null>(null);

  // 该班次的总已售（任一舱位 sold>0 即视为"已有销售"，禁止删除）。
  const totalSold = (schedule.seatClasses ?? []).reduce((sum, c) => sum + c.sold, 0);

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

  const econRemaining = econ ? econ.available : 0;
  const tone = seatTone(econRemaining, econ ? econ.capacity : 0);
  // 售罄是算出来的（余位卖完），与人工的「已下架」(isActive) 无关，两者可同时成立。
  const soldOut = isScheduleSoldOut(schedule);
  const isExporting = exportingId === schedule.id;
  const departureDate = utcYmd(schedule.departureTime);

  // 保存价格 + 容量（同一个按钮一次 PATCH）。
  // 容量允许低于已售（航司减配 / 换机型的真实场景）：服务端照写并记 WARNING 审计，
  // 库存变成账面欠座，因此保存前先要一次显式确认，避免手滑把容量打小。
  const onSaveSeatChanges = async () => {
    if (!tokens || saving) return;
    const oversoldParts: string[] = [];
    if (econ && econCapacity != null && econCapacity < econ.sold) {
      oversoldParts.push(`经济舱 ${econCapacity} < 已售 ${econ.sold}（超售 ${econ.sold - econCapacity}）`);
    }
    if (biz && bizCapacity != null && bizCapacity < biz.sold) {
      oversoldParts.push(`商务舱 ${bizCapacity} < 已售 ${biz.sold}（超售 ${biz.sold - bizCapacity}）`);
    }
    if (
      oversoldParts.length > 0 &&
      !window.confirm(
        `容量低于已售，保存后该班次将标记超售：\n${oversoldParts.join('\n')}\n\n` +
          '销售侧照旧不再卖出，但已售出的座位需要与航司 / 操作部协调（加座、改期或退改）。确认保存？',
      )
    ) {
      return;
    }
    setSaving(true);
    setErr(null);
    setSavedMsg(null);
    try {
      const seatClasses: Array<{ cabin: CabinClass; basePrice?: number; capacity?: number }> = [];
      if (econ) {
        const entry: { cabin: CabinClass; basePrice?: number; capacity?: number } = { cabin: 'ECONOMY' };
        if (econPrice != null) entry.basePrice = econPrice;
        if (econCapacity != null) entry.capacity = econCapacity;
        if (entry.basePrice !== undefined || entry.capacity !== undefined) seatClasses.push(entry);
      }
      if (biz) {
        const entry: { cabin: CabinClass; basePrice?: number; capacity?: number } = { cabin: 'BUSINESS' };
        if (bizPrice != null) entry.basePrice = bizPrice;
        if (bizCapacity != null) entry.capacity = bizCapacity;
        if (entry.basePrice !== undefined || entry.capacity !== undefined) seatClasses.push(entry);
      }
      if (seatClasses.length === 0) {
        setErr('没有可保存的舱位价格/容量');
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
      setErr('已有销售，不能删除（请用下架）');
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

  // 将 ISO 字符串转成 datetime-local 输入框的默认值（本地时区，保留到分）。
  const isoToLocal = (iso: string): string => {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // 打开改时刻弹窗，预填当前值。
  const openTimeEdit = () => {
    setTimeDep(isoToLocal(schedule.departureTime));
    setTimeArr(isoToLocal(schedule.arrivalTime));
    setTimeErr(null);
    setTimeMsg(null);
    setShowTimeEdit(true);
  };

  // 提交改时刻——只传两个字段，校验由后端负责（到达早于出发会返回 400）。
  const onSaveTime = async () => {
    if (!tokens || timeSaving) return;
    if (!timeDep || !timeArr) {
      setTimeErr('请填写出发和到达时刻');
      return;
    }
    setTimeSaving(true);
    setTimeErr(null);
    setTimeMsg(null);
    try {
      // datetime-local 值形如 "2026-07-01T10:30"，附加系统时区偏移后传给后端。
      const toIso = (local: string) => new Date(local).toISOString();
      const body = { departureTime: toIso(timeDep), arrivalTime: toIso(timeArr) };
      try {
        await api.updateSchedule(tokens.accessToken, schedule.id, body);
      } catch (e) {
        // A11：已售班次改点被后端拦下（400 报文含影响面）→ 弹确认，确认后带标志重试。
        if (e instanceof ApiError && e.message.includes('已售') && e.message.includes('改时刻')) {
          if (!window.confirm(`${e.message}\n\n确认仍要修改时刻？`)) {
            setTimeSaving(false);
            return;
          }
          await api.updateSchedule(tokens.accessToken, schedule.id, {
            ...body,
            confirmSoldTimeChange: true,
          });
        } else {
          throw e;
        }
      }
      setTimeMsg('✅ 时刻已更新');
      setShowTimeEdit(false);
      await onSaved();
    } catch (e) {
      setTimeErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setTimeSaving(false);
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
          {/* 售罄（余位卖完，派生）与已下架（人工收起）分开渲染，可同时出现 */}
          {soldOut && (
            <span className="badge-neutral" title="机位已售完（自动判定，无需人工操作）">
              售罄
            </span>
          )}
          {!schedule.isActive && (
            <span className="badge-neutral" title="已下架：前台不可售，可调价后重新上架">
              已下架
            </span>
          )}
          {schedule.isActive && !soldOut && <span className="badge-success">在售</span>}
        </div>
      </div>

      {/* 余位/已售（只读）*/}
      <div className="mt-2 flex flex-wrap gap-4 text-xs">
        {econ && (
          <span title={econRemaining < 0 ? OVERSOLD_HINT : undefined}>
            经济舱余位{' '}
            <span className={`font-semibold ${tone.text}`}>{seatRemainingText(econRemaining)}</span> /{' '}
            {econ.capacity}
            <span className="ml-1 text-ink-muted">（已售 {econ.sold}）</span>
          </span>
        )}
        {biz && (
          <span title={biz.available < 0 ? OVERSOLD_HINT : undefined}>
            商务舱余位{' '}
            {/* 商务舱这里向来只报数不上色，唯独超售必须扎眼 */}
            <span className={`font-semibold ${biz.available < 0 ? 'text-rose-700' : 'text-ink'}`}>
              {seatRemainingText(biz.available)}
            </span>{' '}
            /{' '}
            {biz.capacity}
            <span className="ml-1 text-ink-muted">（已售 {biz.sold}）</span>
          </span>
        )}
      </div>

      {/* 当前售价（醒目）：镜像后端 —— 有阶梯则显示当前档价 + 第N档，否则显示固定价。
          直接回答"我写多少就卖多少？"：固定价=是；阶梯=以当前档为准。 */}
      {(econ || biz) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {[econ, biz].filter((c): c is ScheduleSeat => Boolean(c)).map((seat) => {
            // 商务舱联动开启：现价由「经济舱现价 + 航班升舱差价」派生，不看自身阶梯/basePrice。
            const linked = linkedBusinessPrice(flight, schedule, seat);
            const ladder = !linked && hasLadder(seat.fareBuckets);
            const price = linked ? linked.price : seatCurrentPrice(seat);
            const tierIdx =
              !linked && hasLadder(seat.fareBuckets)
                ? currentLadderTierIndex(seat.fareBuckets, seat.sold)
                : -1;
            return (
              <span
                key={seat.cabin}
                className={`inline-flex items-baseline gap-1 rounded-md px-2.5 py-1 text-xs ${
                  linked
                    ? 'bg-indigo-50 text-indigo-800'
                    : ladder
                      ? 'bg-brand-50 text-brand-800'
                      : 'bg-emerald-50 text-emerald-800'
                }`}
              >
                <span className="text-ink-muted">{CABIN_LABEL[seat.cabin] ?? seat.cabin}当前售价</span>
                <span className="text-sm font-bold">¥{price.toFixed(0)}</span>
                {linked && !linked.fallback && (
                  <span
                    className="text-[11px] font-medium"
                    title={`= 经济舱现价 + 升舱差价 ¥${flight.businessUpgradeCnyPerLeg}`}
                  >
                    · 联动经济舱
                  </span>
                )}
                {linked?.fallback && (
                  <span className="text-[11px] font-medium text-amber-700" title="经济舱缺价，已回退商务舱自身价">
                    · 联动回退
                  </span>
                )}
                {!linked && ladder && <span className="text-[11px] font-medium">· 阶梯第{tierIdx + 1}档</span>}
                {!linked && !ladder && <span className="text-[11px] font-medium">· 固定价</span>}
              </span>
            );
          })}
        </div>
      )}

      {/* 改价 / 改容量（仅 ADMIN）：有阶梯时基础价不是现售价，标注清楚避免误改 */}
      {canEdit && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {econ && (
            <div className="space-y-2">
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
              <div>
                <label className="label">经济舱容量（已售 {econ.sold}）</label>
                <NumberInput
                  min={0}
                  className="input"
                  value={econCapacity}
                  onChange={(n) => setEconCapacity(n)}
                  integerOnly
                />
                {econCapacity != null && econCapacity < econ.sold ? (
                  <p className="mt-0.5 text-[11px] font-medium text-rose-700">
                    低于已售 {econ.sold} 张，保存后将标记超售 {econ.sold - econCapacity}。
                  </p>
                ) : (
                  <p className="mt-0.5 text-[11px] text-ink-muted">
                    可低于已售（航司减配 / 换机型），保存后按超售标红。
                  </p>
                )}
              </div>
            </div>
          )}
          {biz && (
            <div className="space-y-2">
              <div>
                <label className="label">
                  {bizLinked
                    ? '商务舱价（联动经济舱，只读）(¥)'
                    : hasLadder(biz.fareBuckets)
                      ? '商务舱基础价（未设阶梯时生效）(¥)'
                      : '商务舱价 (¥)'}
                </label>
                <NumberInput
                  min={0}
                  className="input"
                  value={bizLinked ? bizLinked.price : bizPrice}
                  onChange={(n) => setBizPrice(n)}
                  disabled={Boolean(bizLinked)}
                />
                {bizLinked && !bizLinked.fallback && (
                  <p className="mt-0.5 text-[11px] text-indigo-700">
                    已联动经济舱：现价 = 经济舱现价 + 升舱差价 ¥{flight.businessUpgradeCnyPerLeg}（在「💺 升舱/联动」里改）。
                  </p>
                )}
                {bizLinked?.fallback && (
                  <p className="mt-0.5 text-[11px] text-amber-700">
                    已开联动但经济舱缺价，暂回退商务舱自身价。请先给经济舱设价。
                  </p>
                )}
                {!bizLinked && hasLadder(biz.fareBuckets) && (
                  <p className="mt-0.5 text-[11px] text-ink-muted">
                    当前按阶梯出售，此价仅在清除阶梯后才生效。
                  </p>
                )}
              </div>
              <div>
                <label className="label">商务舱容量（已售 {biz.sold}）</label>
                <NumberInput
                  min={0}
                  className="input"
                  value={bizCapacity}
                  onChange={(n) => setBizCapacity(n)}
                  integerOnly
                />
                {bizCapacity != null && bizCapacity < biz.sold ? (
                  <p className="mt-0.5 text-[11px] font-medium text-rose-700">
                    低于已售 {biz.sold} 张，保存后将标记超售 {biz.sold - bizCapacity}。
                  </p>
                ) : (
                  <p className="mt-0.5 text-[11px] text-ink-muted">
                    可低于已售（航司减配 / 换机型），保存后按超售标红。
                  </p>
                )}
              </div>
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
        <button
          type="button"
          className="btn-secondary text-xs whitespace-nowrap"
          disabled={exportingFull}
          title="导出该班次「全岗可用」名单（分人金额 + 票务/签证补列，xlsx）"
          onClick={() => onExportFull(schedule.id, departureDate)}
        >
          {exportingFull ? '导出中…' : '📋 导出整班·全岗'}
        </button>
        {canEdit && (
          <>
            <button
              type="button"
              className="btn-secondary text-xs text-rose-600 hover:bg-rose-50 disabled:text-slate-300 disabled:hover:bg-transparent"
              title={totalSold > 0 ? '已有销售，不能删除（请用下架）' : '彻底删除该班次（不可恢复）'}
              disabled={deleting || totalSold > 0}
              onClick={onDelete}
            >
              {deleting ? '删除中…' : '删除班次'}
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              title="下架后前台不可售，可调价后重新上架（只对该单个班次）"
              disabled={toggling}
              onClick={onToggle}
            >
              {toggling ? '处理中…' : schedule.isActive ? '下架' : '重新上架'}
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              title="修改该班次的出发/到达时刻（航司改点）"
              onClick={openTimeEdit}
            >
              改时刻
            </button>
            <button type="button" className="btn-primary text-xs" disabled={saving} onClick={onSaveSeatChanges}>
              {saving ? '保存中…' : '保存价格/容量'}
            </button>
          </>
        )}
      </div>

      {/* 改时刻弹窗 */}
      {showTimeEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl">
            <h3 className="mb-4 text-sm font-semibold text-ink">修改班次时刻</h3>
            <div className="space-y-3">
              <div>
                <label className="label">出发时刻</label>
                <input
                  type="datetime-local"
                  className="input w-full"
                  value={timeDep}
                  onChange={(e) => setTimeDep(e.target.value)}
                />
              </div>
              <div>
                <label className="label">到达时刻</label>
                <input
                  type="datetime-local"
                  className="input w-full"
                  value={timeArr}
                  onChange={(e) => setTimeArr(e.target.value)}
                />
              </div>
            </div>
            {timeErr && (
              <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{timeErr}</div>
            )}
            {timeMsg && <div className="mt-3 text-xs text-emerald-700">{timeMsg}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={timeSaving}
                onClick={() => setShowTimeEdit(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary text-xs"
                disabled={timeSaving}
                onClick={onSaveTime}
              >
                {timeSaving ? '保存中…' : '保存时刻'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 批量改价 / 批量仓位阶梯（日期范围 + 星期几 + 进度条；镜像 BulkScheduleForm）─
// 注：批量「售罄/恢复销售」已移除——售罄是余位卖完后自动派生的，从来就没有开关可调。
// 留下的那个人工开关是「下架/重新上架」(isActive)，是另一件事，按钮保留在 DaySchedule。
type BulkAction = 'setPrice' | 'addAmount' | 'addPercent' | 'setLadder' | 'clearLadder' | 'setCapacity';
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
  // 批量改容量：经济/商务各一个目标值，留空 = 不改该舱位（走专用批量接口，非逐班次循环）
  const [capEcon, setCapEcon] = useState<number | null>(null);
  const [capBiz, setCapBiz] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, errors: 0, skipped: 0 });
  const [result, setResult] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const isPriceAction = action === 'setPrice' || action === 'addAmount' || action === 'addPercent';
  const isLadderAction = action === 'setLadder' || action === 'clearLadder';
  const isCapacityAction = action === 'setCapacity';

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

  // 改价类操作（设为指定价/涨¥X/涨X%）只写 basePrice，而配了仓位阶梯的班次按阶梯出售、
  // 永远不看 basePrice —— 对这些班次改价等于没改。所以先把命中班次分成两组：
  //   fixed  = 固定价班次，本次改价真正生效
  //   ladder = 阶梯班次，本次改价无效 → 显式跳过（完全不写 basePrice）
  // 为什么是"跳过"而不是"写了但不生效"：basePrice 在阶梯班次上并非死值，一旦有人点
  // 「清除仓位阶梯」，basePrice 会立刻变成成交价。若这里偷偷写入一个当时没生效的新价，
  // 它会潜伏到某次清除阶梯时突然跳出来，变成一次没人预期的价格变动。宁可不写。
  const priceSplit = useMemo(() => {
    if (!isPriceAction) return { fixed: matched, ladder: [] as AdminSchedule[] };
    const fixed: AdminSchedule[] = [];
    const ladder: AdminSchedule[] = [];
    for (const s of matched) (scheduleHasLadder(s) ? ladder : fixed).push(s);
    return { fixed, ladder };
  }, [matched, isPriceAction]);

  const toggleWeekday = (day: number) => {
    setWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  const cabinsToEdit = (s: AdminSchedule): CabinClass[] => {
    if (cabinPick === 'ALL') return (s.seatClasses ?? []).map((c) => c.cabin);
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
    // 阶梯班次不接受改价：声明式挡在这里，确保跳过 = 一个字节都不写 basePrice。
    // （onSubmit 已按 priceSplit 分流并计数，这一行是第二道闸，防止日后新增调用点漏掉分流。）
    if (!isLadderAction && scheduleHasLadder(s)) return null;
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
    if (action === 'setCapacity') {
      const parts: string[] = [];
      if (capEcon != null) parts.push(`经济舱→${capEcon}`);
      if (capBiz != null) parts.push(`商务舱→${capBiz}`);
      return parts.length > 0
        ? `改容量：${parts.join('，')}（低于已售的班次照改并标记超售）`
        : '改容量（尚未填目标值）';
    }
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
    if (action === 'setCapacity' && capEcon == null && capBiz == null) {
      setErrMsg('请至少填一个舱位的目标容量');
      return;
    }
    // 改价撞上阶梯班次：先把"有多少个改不动"摆到运营面前，再让他决定要不要对其余的执行。
    if (isPriceAction && priceSplit.ladder.length > 0) {
      if (priceSplit.fixed.length === 0) {
        setErrMsg(
          `命中的 ${matched.length} 个班次都在用仓位阶梯，改价对它们无效。` +
            `要调阶梯班次的价格，请用「设置仓位阶梯」重设各档价格。`,
        );
        return;
      }
      const names = priceSplit.ladder
        .slice(0, 5)
        .map((s) => localYmd(s.departureTime, s.departureTz))
        .join('、');
      const more = priceSplit.ladder.length > 5 ? ` 等 ${priceSplit.ladder.length} 个` : '';
      if (
        !confirm(
          `命中 ${matched.length} 个班次，其中 ${priceSplit.ladder.length} 个在用仓位阶梯，` +
            `本次改价对它们无效（阶梯班次请用「设置仓位阶梯」）。\n\n` +
            `将跳过：${names}${more}\n\n` +
            `要继续对其余 ${priceSplit.fixed.length} 个执行「${actionLabel()}」吗？`,
        )
      ) {
        return;
      }
    } else if (!confirm(`将对 ${matched.length} 个班次执行：${actionLabel()}，确认？`)) {
      return;
    }

    setErrMsg(null);
    setResult(null);
    setSubmitting(true);
    setProgress({ done: 0, total: matched.length, errors: 0, skipped: 0 });

    // ── 改容量：走专用批量接口（服务端一次事务处理），不是逐班次循环调用。
    //    目标容量低于已售的班次照改并回报 oversold 明细（航司减配 / 换机型），
    //    skipped 只剩"班次不存在 / 没有匹配舱位"这类真的没改成的。
    if (action === 'setCapacity') {
      const seatClasses: Array<{ cabin: CabinClass; capacity: number }> = [];
      if (capEcon != null) seatClasses.push({ cabin: 'ECONOMY', capacity: capEcon });
      if (capBiz != null) seatClasses.push({ cabin: 'BUSINESS', capacity: capBiz });
      try {
        const { result: capResult } = await api.batchUpdateCapacity(tokens.accessToken, {
          scheduleIds: matched.map((s) => s.id),
          seatClasses,
        });
        setProgress({
          done: capResult.applied,
          total: matched.length,
          errors: 0,
          skipped: capResult.skipped.length,
        });
        const preview = capResult.skipped.slice(0, 3).map((s) => s.reason);
        // 超售不是失败，但必须当面说清楚：改了几个、其中几个欠座、一共欠多少
        const oversold = capResult.oversold ?? [];
        const oversoldSeats = oversold.reduce((sum, o) => sum + o.oversoldBy, 0);
        setResult(
          `${oversold.length > 0 ? '⚠️' : '✅'} 完成：改了 ${capResult.applied} 个${
            capResult.skipped.length > 0
              ? ` · 跳过 ${capResult.skipped.length} 个（${preview.join('；')}${
                  capResult.skipped.length > preview.length ? ' 等' : ''
                }）`
              : ''
          }${
            oversold.length > 0
              ? ` · 其中 ${oversold.length} 个舱位容量低于已售，共超售 ${oversoldSeats} 座，请与航司 / 操作部协调`
              : ''
          }`,
        );
      } catch (e2) {
        setErrMsg(e2 instanceof ApiError ? e2.message : '批量改容量失败');
      } finally {
        setSubmitting(false);
      }
      await onDone();
      return;
    }

    // ── 改价 / 仓位阶梯：仍逐班次调用（每班次当前价/校验各不相同，沿用既有循环）
    // 计数分三档，互不混淆：done=真的改了、skipped*=没调接口、errors=调了但失败。
    // 旧写法把"跳过"算进 done，于是进度条走满变绿、运营以为改完了 —— 这正是要杜绝的假绿。
    let done = 0;
    let errors = 0;
    let skippedLadder = 0; // 阶梯班次：改价对它无效，完全不写 basePrice
    let skippedNoCabin = 0; // 该班次没有所选舱位
    let lastError = '';
    const bump = () =>
      setProgress({
        done: done + errors + skippedLadder + skippedNoCabin,
        total: matched.length,
        errors,
        skipped: skippedLadder + skippedNoCabin,
      });
    for (const s of matched) {
      const body = buildBody(s);
      if (!body) {
        // buildBody 只在两种情况下返回 null，分开记账，结果条才敢说实话。
        if (isPriceAction && scheduleHasLadder(s)) skippedLadder++;
        else skippedNoCabin++;
        bump();
        continue;
      }
      try {
        await api.updateSchedule(tokens.accessToken, s.id, body);
        done++;
      } catch (e2) {
        errors++;
        lastError = e2 instanceof ApiError ? e2.message : '失败';
      }
      bump();
    }

    setSubmitting(false);
    const parts = [`已改 ${done} 个`];
    if (skippedLadder > 0) parts.push(`跳过 ${skippedLadder} 个（阶梯班次，改价对它们无效）`);
    if (skippedNoCabin > 0) parts.push(`跳过 ${skippedNoCabin} 个（无所选舱位）`);
    if (errors > 0) parts.push(`失败 ${errors} 个（${lastError}）`);
    setResult(`${errors > 0 ? '⚠️' : '✅'} 完成：${parts.join(' · ')}`);
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
            <option value="setCapacity">批量改容量</option>
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
        {isCapacityAction && (
          <>
            <div>
              <label className="label">经济舱目标容量</label>
              <NumberInput
                min={0}
                className="input"
                value={capEcon}
                onChange={(n) => setCapEcon(n)}
                integerOnly
                placeholder="留空=不改"
              />
            </div>
            <div>
              <label className="label">商务舱目标容量</label>
              <NumberInput
                min={0}
                className="input"
                value={capBiz}
                onChange={(n) => setCapBiz(n)}
                integerOnly
                placeholder="留空=不改"
              />
            </div>
            <div className="md:col-span-4 text-[11px] text-ink-muted">
              容量可以低于已售（航司减配 / 换机型）：这类班次照改并标记超售，下方会显示改了几个、其中几个超售。
              销售侧照旧按容量拒卖，超售部分需与航司 / 操作部协调。
            </div>
          </>
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
          {/* 改价撞上阶梯班次：点「执行」之前就把改不动的数量摆出来，别等结果条才说 */}
          {isPriceAction && priceSplit.ladder.length > 0 && (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              其中 <b>{priceSplit.ladder.length} 个</b>班次在用仓位阶梯，按各档价格出售，
              <b>本次改价对它们无效</b>，会自动跳过（价格保持不变）。
              实际生效：<b>{priceSplit.fixed.length} 个</b>固定价班次。
              <div className="mt-1 text-amber-800">
                要调阶梯班次的价格，请把操作换成「设置仓位阶梯」重设各档价格。
              </div>
            </div>
          )}
          {submitting && (
            <div className="mt-2">
              <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand transition-all"
                  style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
                />
              </div>
              <div className="text-xs text-slate-500 mt-1">
                进度: {progress.done} / {progress.total}
                {progress.skipped > 0 && ` · 跳过 ${progress.skipped}`}
                {progress.errors > 0 && ` · 失败 ${progress.errors}`}
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

// ── 航班级：升舱差价（单一配置源）+ 商务舱价格联动开关 ──
function FlightBusinessLinkEditor({
  flight,
  onCancel,
  onSaved,
}: {
  flight: AdminFlight;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const [upgrade, setUpgrade] = useState<number | null>(flight.businessUpgradeCnyPerLeg);
  const [linked, setLinked] = useState<boolean>(flight.businessPriceLinked);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tokens || saving) return;
    setErr(null);
    setSaving(true);
    try {
      await api.updateFlight(tokens.accessToken, flight.id, {
        businessUpgradeCnyPerLeg: upgrade ?? 0,
        businessPriceLinked: linked,
      });
      await onSaved();
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-3 rounded-lg border border-brand/30 bg-slate-50 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-slate-900">升舱差价 / 商务舱价格联动 · {flight.flightNumber}</h3>
        <button type="button" className="text-slate-400 hover:text-slate-700 text-xl" onClick={onCancel}>
          ×
        </button>
      </div>
      <form className="mt-3 grid gap-4 sm:grid-cols-2" onSubmit={onSubmit}>
        <div>
          <label className="label">升舱差价（¥/程/座）</label>
          <NumberInput min={0} className="input" value={upgrade} onChange={(n) => setUpgrade(n)} integerOnly />
          <p className="mt-0.5 text-[11px] text-ink-muted">
            经济舱→商务舱每航段加价。既用于本航班商务舱价格联动，也是「跟随航班」套餐升舱的取值来源（一处配置、两处生效）。
          </p>
        </div>
        <div>
          <label className="label">商务舱价格联动经济舱</label>
          <label className="mt-1 flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
            开启后，本航班所有班次的商务舱现价 = 经济舱当前售价 + 升舱差价
          </label>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            开启后无需再逐班次改商务舱价；改经济舱价，商务舱自动跟随。经济舱缺价时暂回退商务舱自身价。
          </p>
        </div>
        {err && <div className="sm:col-span-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}
        <div className="sm:col-span-2 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? '保存中…' : '保存'}
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
          <label className="label" htmlFor="originCode">出发机场（航线起点）</label>
          <select className="input" id="originCode" value={originCode} onChange={(e) => setOriginCode(e.target.value)}>
            {AIRPORT_OPTIONS.map((a) => (
              <option key={a.code} value={a.code}>
                {a.name} ({a.code}){a.active ? '' : ' · 未来航线'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="destinationCode">到达机场（航线终点）</label>
          <select className="input" id="destinationCode" value={destinationCode} onChange={(e) => setDestinationCode(e.target.value)}>
            {AIRPORT_OPTIONS.map((a) => (
              <option key={a.code} value={a.code}>
                {a.name} ({a.code}){a.active ? '' : ' · 未来航线'}
              </option>
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
        {/* 航线预览：新增航线（如 澳门⇌胡志明 / 河内）时一眼确认起终点，避免选反。 */}
        <div className="md:col-span-4 -mt-1 text-sm text-ink-soft">
          航线：<span className="font-medium text-ink">{airportLabel(originCode)}</span>
          <span className="mx-1.5 text-brand">→</span>
          <span className="font-medium text-ink">{airportLabel(destinationCode)}</span>
          {originCode === destinationCode && (
            <span className="ml-2 text-rose-600">出发和到达不能是同一机场</span>
          )}
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

// ── 批量删除班次（按出发日区间；已售班次自动跳过）────────────────────────
// 场景：一天两班、整月排期，运营想按出发日区间删掉某一档班次，又不想逐个点。
// 后端逐条守 sold>0/有订单：已售班次跳过（不删），返回 { deleted, skipped }。
function BatchDeleteScheduleForm({
  flight,
  onCancel,
  onDone,
  onClose,
}: {
  flight: AdminFlight;
  onCancel: () => void;
  onDone: () => Promise<void> | void;
  onClose: () => void;
}) {
  const tokens = useAuth((s) => s.tokens);

  function addDays(offset: number): string {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  const [from, setFrom] = useState(addDays(0));
  const [to, setTo] = useState(addDays(30));
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ deleted: number; skipped: number } | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tokens || submitting) return;
    if (!from || !to) {
      setErr('请填写出发日期区间');
      return;
    }
    if (to < from) {
      setErr('结束日期不能早于开始日期');
      return;
    }
    if (
      !confirm(
        `将删除 ${flight.flightNumber} 在 ${from} ~ ${to} 之间的未售班次（已售班次自动跳过），确认？`,
      )
    )
      return;

    setSubmitting(true);
    setErr(null);
    setResult(null);
    try {
      const res = await api.batchDeleteSchedules(tokens.accessToken, {
        flightId: flight.id,
        from,
        to,
      });
      setResult({ deleted: res.result.deleted, skipped: res.result.skipped.length });
      await onDone();
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : '批量删除失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mt-4 rounded-lg border-2 border-rose-300 bg-rose-50/60 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900">
          🗑️ 批量删除 <span className="text-brand">{flight.flightNumber}</span> 班次
        </h3>
        <button type="button" className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="text-xs text-slate-500 mt-0.5">
        按出发日区间删除；已有销售（已售座位 / 关联订单）的班次会自动跳过，不会被删。
      </p>

      <form className="mt-4 grid gap-3 md:grid-cols-4" onSubmit={onSubmit}>
        <div>
          <label className="label">起始日期（出发本地日）</label>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">结束日期（含当天）</label>
          <input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>

        {err && (
          <div className="md:col-span-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>
        )}
        {result && (
          <div className="md:col-span-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            ✅ 完成：删除 {result.deleted} 班
            {result.skipped > 0 && ` · 跳过 ${result.skipped} 班（已售）`}
          </div>
        )}

        <div className="md:col-span-4 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {result ? '关闭' : '取消'}
          </button>
          <button
            type="submit"
            className="btn-primary bg-rose-600 hover:bg-rose-700"
            disabled={submitting}
          >
            {submitting ? '删除中…' : '批量删除'}
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
