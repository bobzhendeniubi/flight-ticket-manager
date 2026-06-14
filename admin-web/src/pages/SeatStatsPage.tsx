/**
 * 座位统计 — 接真后端 API。
 *
 * 数据口径（demo 时遇到追问可以这样回答）：
 *   - 已售 = FlightSeatClass.sold（订单确认占库存的那一刻 +1，目前 demo 数据里 sold=0）
 *   - 余票 = capacity - sold
 *   - 占用率 = sold / capacity
 *   - 不区分 PAID / TICKETED / CANCELLED 状态 — 现阶段以"占库存"为准
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AdminFlight, type AdminSchedule } from '../lib/api';
import { airportLabel, CABIN_LABEL, formatLocalDate, formatLocalTime } from '../lib/airports';
import { useAuth } from '../stores/auth';

// 余位低于此值标红（反馈：李萍 — 方便及时调价 / 关注余位）
const LOW_SEAT_THRESHOLD = 20;

interface ScheduleStat extends AdminSchedule {
  flightNumber: string;
  origin: string;
  dest: string;
  totalCapacity: number;
  totalSold: number;
  occupancy: number; // 0..1
}

export function SeatStatsPage() {
  const tokens = useAuth((s) => s.tokens);
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [schedulesByFlight, setSchedulesByFlight] = useState<Record<string, AdminSchedule[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [flightFilter, setFlightFilter] = useState<string>('');
  const [monthFilter, setMonthFilter] = useState<string>('upcoming30');

  const load = useCallback(async () => {
    if (!tokens) return;
    setLoading(true);
    try {
      const f = await api.listAllFlights(tokens.accessToken);
      setFlights(f.flights);
      const map: Record<string, AdminSchedule[]> = {};
      await Promise.all(
        f.flights.map(async (flight) => {
          const r = await api.listSchedules(tokens.accessToken, flight.id);
          map[flight.id] = r.schedules;
        }),
      );
      setSchedulesByFlight(map);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [tokens]);

  useEffect(() => {
    load();
  }, [load]);

  const allStats = useMemo<ScheduleStat[]>(() => {
    const result: ScheduleStat[] = [];
    for (const flight of flights) {
      const schedules = schedulesByFlight[flight.id] ?? [];
      for (const s of schedules) {
        const totalCapacity = s.seatClasses.reduce((sum, c) => sum + c.capacity, 0);
        const totalSold = s.seatClasses.reduce((sum, c) => sum + c.sold, 0);
        result.push({
          ...s,
          flightNumber: flight.flightNumber,
          origin: flight.originCode,
          dest: flight.destinationCode,
          totalCapacity,
          totalSold,
          occupancy: totalCapacity > 0 ? totalSold / totalCapacity : 0,
        });
      }
    }
    return result.sort((a, b) => a.departureTime.localeCompare(b.departureTime));
  }, [flights, schedulesByFlight]);

  const months = useMemo(
    () => Array.from(new Set(allStats.map((s) => s.departureTime.slice(0, 7)))).sort(),
    [allStats],
  );

  const now = new Date();
  const thirtyDaysLater = new Date(now.getTime() + 30 * 86400000);

  const filtered = allStats.filter((s) => {
    if (flightFilter && s.flightNumber !== flightFilter) return false;
    if (monthFilter === 'upcoming30') {
      const d = new Date(s.departureTime);
      if (d < now || d > thirtyDaysLater) return false;
    } else if (monthFilter !== 'all' && !s.departureTime.startsWith(monthFilter)) {
      return false;
    }
    return true;
  });

  // 汇总
  const summary = useMemo(() => {
    const totalCap = filtered.reduce((s, x) => s + x.totalCapacity, 0);
    const totalSold = filtered.reduce((s, x) => s + x.totalSold, 0);
    const avgOcc = totalCap > 0 ? totalSold / totalCap : 0;
    return { totalCap, totalSold, avgOcc, count: filtered.length };
  }, [filtered]);

  if (error) return <div className="card border-rose-200 bg-rose-50 text-rose-700">{error}</div>;
  if (loading) return <div className="card text-ink-muted">加载中…</div>;

  return (
    <div className="space-y-5">
      <section>
        <h1 className="page-title">航班座位统计</h1>
        <p className="page-sub">
          实时统计自营航班的座位占用情况。数据口径：FlightSeatClass.sold（占库存即计入）。
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <KpiCard label="班次数" value={summary.count.toString()} />
        <KpiCard label="总座位数" value={summary.totalCap.toLocaleString()} />
        <KpiCard label="已售座位" value={summary.totalSold.toLocaleString()} sub={`平均占用率 ${(summary.avgOcc * 100).toFixed(1)}%`} />
        <KpiCard label="平均空舱率" value={`${((1 - summary.avgOcc) * 100).toFixed(1)}%`} sub="(1 - 平均占用率)" />
      </section>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="label">航班</label>
            <select className="input" value={flightFilter} onChange={(e) => setFlightFilter(e.target.value)}>
              <option value="">全部航班</option>
              {flights.map((f) => (
                <option key={f.id} value={f.flightNumber}>
                  {f.flightNumber} ({f.originCode} → {f.destinationCode})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">日期范围</label>
            <select className="input" value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)}>
              <option value="upcoming30">未来 30 天</option>
              <option value="all">全部 (共 {allStats.length} 条)</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {m} ({allStats.filter((s) => s.departureTime.startsWith(m)).length})
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <p className="text-sm text-slate-500">显示 {filtered.length} 条</p>
          </div>
        </div>
      </section>

      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th className="text-left">出发</th>
                <th className="text-left">航班 / 路线</th>
                <th className="text-left">舱位明细</th>
                <th className="text-right">总座位</th>
                <th className="text-right">已售</th>
                <th className="text-right">余票</th>
                <th className="w-48">占用率</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="font-medium text-ink">
                      {formatLocalDate(s.departureTime, s.departureTz)}
                    </div>
                    <div className="text-xs text-ink-muted">
                      {formatLocalTime(s.departureTime, s.departureTz)} {s.departureTz}
                    </div>
                  </td>
                  <td>
                    <div className="font-mono text-brand">{s.flightNumber}</div>
                    <div className="text-xs text-ink-muted">
                      {airportLabel(s.origin)} → {airportLabel(s.dest)}
                    </div>
                  </td>
                  <td className="text-xs">
                    {s.seatClasses.map((c) => (
                      <div key={c.id}>
                        <span className="text-ink-muted">{CABIN_LABEL[c.cabin] ?? c.cabin}:</span>{' '}
                        <span className="text-ink">
                          {c.sold}/{c.capacity}
                        </span>{' '}
                        <span className="text-ink-muted">¥{Number(c.basePrice).toFixed(0)}</span>
                      </div>
                    ))}
                  </td>
                  <td className="text-right nums">{s.totalCapacity}</td>
                  <td className="text-right nums">{s.totalSold}</td>
                  {(() => {
                    const avail = s.totalCapacity - s.totalSold;
                    const low = avail < LOW_SEAT_THRESHOLD;
                    return (
                      <td
                        className={`text-right nums ${low ? 'font-bold text-rose-600' : ''}`}
                        title={low ? `余位不足 ${LOW_SEAT_THRESHOLD}，建议关注/调价` : undefined}
                      >
                        {low && '🔴 '}{avail}
                      </td>
                    );
                  })()}
                  <td>
                    <OccupancyBar occupancy={s.occupancy} />
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-ink-muted">
                    没有数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-muted">{sub}</p>}
    </div>
  );
}

function OccupancyBar({ occupancy }: { occupancy: number }) {
  const pct = occupancy * 100;
  const color = occupancy > 0.8 ? 'bg-red-500' : occupancy > 0.6 ? 'bg-amber-500' : 'bg-green-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <span className="text-xs text-slate-700 tabular-nums w-12 text-right">{pct.toFixed(1)}%</span>
    </div>
  );
}
