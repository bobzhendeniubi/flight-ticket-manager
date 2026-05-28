import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AdminFlight, type CabinClass } from '../lib/api';
import { AIRPORT_OPTIONS, CABIN_LABEL, airportLabel, formatLocalDate, formatLocalTime } from '../lib/airports';
import { useAuth } from '../stores/auth';

interface ScheduleSeat {
  id: string;
  cabin: CabinClass;
  capacity: number;
  sold: number;
  basePrice: string;
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
  charterCostCny: string | null;
  airportTaxDepCny: string | null;
  airportTaxArrCny: string | null;
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
    return <div className="card text-slate-600">仅管理员/运营可访问此页面。</div>;
  }

  if (error) {
    return <div className="card border-red-200 bg-red-50 text-red-700">{error}</div>;
  }
  if (!flights) {
    return <div className="card text-slate-500">加载中…</div>;
  }

  return (
    <div className="space-y-6">
      <section className="card">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">航班管理</h1>
            <p className="mt-1 text-sm text-slate-600">维护自营航班、班次和舱位。</p>
          </div>
          {user.role === 'ADMIN' && (
            <button type="button" className="btn-primary" onClick={() => setShowNewFlight(true)}>
              + 新建航班
            </button>
          )}
        </div>
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
        {flights.length === 0 && <div className="card text-slate-500">暂无航班，点右上角创建。</div>}
        {flights.map((f) => (
          <div key={f.id} className="card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <span className="inline-flex items-center rounded bg-brand/10 px-2 py-0.5 text-sm font-semibold text-brand">
                  {f.flightNumber}
                </span>
                <div>
                  <div className="font-medium text-slate-900">
                    {airportLabel(f.originCode)} → {airportLabel(f.destinationCode)}
                  </div>
                  <div className="text-xs text-slate-500">
                    机型：{f.aircraftType ?? '—'} · 共 {f.scheduleCount} 个班次
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!f.isActive && (
                  <span className="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-600">已停用</span>
                )}
                <button type="button" className="btn-secondary text-sm" onClick={() => toggleExpand(f.id)}>
                  {expanded === f.id ? '收起' : '查看班次'}
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
                      onClick={() => onToggleFlight(f.id)}
                    >
                      {f.isActive ? '停用' : '启用'}
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

            {expanded === f.id && (
              <SchedulesList
                schedules={schedulesByFlight[f.id] ?? null}
                originTz={null}
              />
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

function SchedulesList({
  schedules,
}: {
  schedules: AdminSchedule[] | null;
  originTz: string | null;
}) {
  const [monthFilter, setMonthFilter] = useState<string>('upcoming30');

  if (schedules === null) return <div className="mt-3 text-sm text-slate-500">加载班次中…</div>;
  if (schedules.length === 0) return <div className="mt-3 text-sm text-slate-500">还没有班次。</div>;

  // 构造可筛选的月份列表 (YYYY-MM)
  const months = Array.from(
    new Set(schedules.map((s) => s.departureTime.slice(0, 7))),
  ).sort();

  const now = new Date();
  const thirtyDaysLater = new Date(now.getTime() + 30 * 86400000);

  const filtered = schedules.filter((s) => {
    if (monthFilter === 'all') return true;
    if (monthFilter === 'upcoming30') {
      const d = new Date(s.departureTime);
      return d >= now && d <= thirtyDaysLater;
    }
    return s.departureTime.startsWith(monthFilter);
  });

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-600">共 {schedules.length} 个班次</span>
        <span className="text-slate-300">·</span>
        <label className="text-sm text-slate-600">筛选:</label>
        <select
          className="input max-w-[200px]"
          value={monthFilter}
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
        <span className="text-xs text-slate-500">显示 {filtered.length} 条</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-medium uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2">出发</th>
            <th className="px-3 py-2">到达</th>
            <th className="px-3 py-2">舱位 / 余票 / 价格</th>
            <th className="px-3 py-2">成本（包机 / 机场税CNY）</th>
            <th className="px-3 py-2">状态</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {filtered.map((s) => (
            <tr key={s.id}>
              <td className="px-3 py-2">
                <div className="font-medium text-slate-900">
                  {formatLocalDate(s.departureTime, s.departureTz)} {formatLocalTime(s.departureTime, s.departureTz)}
                </div>
                <div className="text-xs text-slate-500">{s.departureTz}</div>
              </td>
              <td className="px-3 py-2">
                <div className="font-medium text-slate-900">
                  {formatLocalDate(s.arrivalTime, s.arrivalTz)} {formatLocalTime(s.arrivalTime, s.arrivalTz)}
                </div>
                <div className="text-xs text-slate-500">{s.arrivalTz}</div>
              </td>
              <td className="px-3 py-2">
                <ul className="space-y-0.5">
                  {s.seatClasses.map((c) => (
                    <li key={c.id}>
                      {CABIN_LABEL[c.cabin] ?? c.cabin}: {c.capacity - c.sold}/{c.capacity} · ¥{Number(c.basePrice).toFixed(0)}
                    </li>
                  ))}
                </ul>
              </td>
              <td className="px-3 py-2">
                <ScheduleCostEditor schedule={s} />
              </td>
              <td className="px-3 py-2">
                {s.isActive ? (
                  <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">在售</span>
                ) : (
                  <span className="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-600">已停</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

// ── 班次成本内联编辑（包机总成本 / 机场税 CNY）──
function ScheduleCostEditor({ schedule }: { schedule: AdminSchedule }) {
  const tokens = useAuth((s) => s.tokens);
  const [charter, setCharter] = useState(schedule.charterCostCny ?? '');
  const [taxDep, setTaxDep] = useState(schedule.airportTaxDepCny ?? '');
  const [taxArr, setTaxArr] = useState(schedule.airportTaxArrCny ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toNum = (v: string): number | null => (v.trim() === '' ? null : Number(v));

  async function save(): Promise<void> {
    if (!tokens) return;
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      await api.patchFlightScheduleCost(tokens.accessToken, schedule.id, {
        charterCostCny: toNum(charter),
        airportTaxDepCny: toNum(taxDep),
        airportTaxArrCny: toNum(taxArr),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'w-24 rounded border border-slate-300 px-1.5 py-0.5 text-right text-xs';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-slate-400">¥</span>
        <input className={inputCls} type="number" step="1" placeholder="包机总成本" value={charter} onChange={(e) => setCharter(e.target.value)} />
        <input className={inputCls} type="number" step="0.01" placeholder="机场税(去程, CNY)" value={taxDep} onChange={(e) => setTaxDep(e.target.value)} />
        <input className={inputCls} type="number" step="0.01" placeholder="机场税(回程, CNY)" value={taxArr} onChange={(e) => setTaxArr(e.target.value)} />
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {saving ? '…' : saved ? '✓' : '保存'}
        </button>
      </div>
      {err && <span className="text-xs text-rose-600">{err}</span>}
    </div>
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
  const [durationHours, setDurationHours] = useState(2);
  const [econCapacity, setEconCapacity] = useState(150);
  const [econPrice, setEconPrice] = useState(800);
  const [bizCapacity, setBizCapacity] = useState(20);
  const [bizPrice, setBizPrice] = useState(3000);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tokens) return;
    setErr(null);
    setSubmitting(true);
    try {
      // Asia/Shanghai (UTC+8) — 把本地 date+time 换算到 UTC ISO
      const [y, m, d] = date.split('-').map(Number);
      const [h, mi] = departTime.split(':').map(Number);
      const depUTC = new Date(Date.UTC(y, m - 1, d, h - 8, mi, 0)).toISOString();
      const arrUTC = new Date(
        Date.UTC(y, m - 1, d, h - 8, mi, 0) + durationHours * 3600 * 1000,
      ).toISOString();

      await api.createSchedule(tokens.accessToken, {
        flightId: flight.id,
        departureTime: depUTC,
        arrivalTime: arrUTC,
        departureTz: 'Asia/Shanghai',
        arrivalTz: 'Asia/Shanghai',
        seatClasses: [
          { cabin: 'ECONOMY', capacity: econCapacity, basePrice: econPrice },
          ...(bizCapacity > 0
            ? [{ cabin: 'BUSINESS' as const, capacity: bizCapacity, basePrice: bizPrice }]
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
          <input
            type="number"
            step={0.5}
            min={0.5}
            max={20}
            className="input"
            value={durationHours}
            onChange={(e) => setDurationHours(Number(e.target.value) || 1)}
          />
        </div>
        <div>
          <label className="label">经济舱座位</label>
          <input
            type="number"
            min={0}
            className="input"
            value={econCapacity}
            onChange={(e) => setEconCapacity(Number(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className="label">经济舱价 (¥)</label>
          <input
            type="number"
            min={0}
            className="input"
            value={econPrice}
            onChange={(e) => setEconPrice(Number(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className="label">商务舱座位</label>
          <input
            type="number"
            min={0}
            className="input"
            value={bizCapacity}
            onChange={(e) => setBizCapacity(Number(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className="label">商务舱价 (¥)</label>
          <input
            type="number"
            min={0}
            className="input"
            value={bizPrice}
            onChange={(e) => setBizPrice(Number(e.target.value) || 0)}
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
  const [durationMinutes, setDurationMinutes] = useState(105);
  const [econCapacity, setEconCapacity] = useState(180);
  const [econPrice, setEconPrice] = useState(1380);
  const [bizCapacity, setBizCapacity] = useState(20);
  const [bizPrice, setBizPrice] = useState(4280);
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

    for (let d = new Date(s); d <= e2; d.setDate(d.getDate() + 1)) {
      if (!weekdays.has(d.getDay())) continue;
      try {
        const y = d.getFullYear();
        const m = d.getMonth();
        const day = d.getDate();
        const depUTC = new Date(Date.UTC(y, m, day, hour - offsetHours, minute, 0)).toISOString();
        const arrUTC = new Date(Date.UTC(y, m, day, hour - offsetHours, minute, 0) + durationMinutes * 60 * 1000).toISOString();
        await api.createSchedule(tokens.accessToken, {
          flightId: flight.id,
          departureTime: depUTC,
          arrivalTime: arrUTC,
          departureTz: depTz,
          arrivalTz: arrTz,
          seatClasses: [
            { cabin: 'ECONOMY', capacity: econCapacity, basePrice: econPrice },
            ...(bizCapacity > 0 ? [{ cabin: 'BUSINESS' as const, capacity: bizCapacity, basePrice: bizPrice }] : []),
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
          <input type="number" min={30} max={600} className="input" value={durationMinutes} onChange={(e) => setDurationMinutes(Number(e.target.value) || 0)} />
        </div>
        <div>
          <label className="label">经济座位 / 单价</label>
          <div className="flex gap-1">
            <input type="number" min={0} className="input" value={econCapacity} onChange={(e) => setEconCapacity(Number(e.target.value) || 0)} />
            <input type="number" min={0} className="input" placeholder="¥" value={econPrice} onChange={(e) => setEconPrice(Number(e.target.value) || 0)} />
          </div>
        </div>
        <div>
          <label className="label">商务座位 / 单价</label>
          <div className="flex gap-1">
            <input type="number" min={0} className="input" value={bizCapacity} onChange={(e) => setBizCapacity(Number(e.target.value) || 0)} />
            <input type="number" min={0} className="input" placeholder="¥" value={bizPrice} onChange={(e) => setBizPrice(Number(e.target.value) || 0)} />
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
