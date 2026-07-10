/**
 * 座位统计 — 接真后端 API（跨日期区间一次拉取，避免 N+1）。
 *
 * 数据口径（demo 时遇到追问可以这样回答）：
 *   - 已售 = FlightSeatClass.sold（订单确认占库存的那一刻 +1）
 *   - 余票 = available = capacity − sold − locked（后端权威口径，与前台一致）
 *   - 总座 = capacity
 *   - 占用率 = sold / capacity
 *   - 日期区间为闭区间（between 起始/截止），服务端按 from/to 过滤
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type RangeSchedule } from '../lib/api';
import { airportLabel, CABIN_LABEL, formatLocalDate, formatLocalTime, localYmd, tzLabel } from '../lib/airports';
import { useAuth } from '../stores/auth';
import { useFlightSeats } from '../stores/flightSeats';

// 余位低于此值标红（方便及时调价 / 关注余位）
const LOW_SEAT_THRESHOLD = 20;

// 本地日期 YYYY-MM-DD（用 getFullYear/getMonth/getDate，避免 toISOString 的 UTC 偏移）
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysFromTodayStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface ScheduleStat {
  id: string;
  flightNumber: string;
  origin: string;
  dest: string;
  departureTime: string;
  departureTz: string;
  seatClasses: RangeSchedule['seatClasses'];
  totalCapacity: number;
  totalSold: number;
  totalAvailable: number;
  occupancy: number; // 0..1
}

export function SeatStatsPage() {
  const tokens = useAuth((s) => s.tokens);
  const seatsVersion = useFlightSeats((s) => s.seatsVersion);
  const [schedules, setSchedules] = useState<RangeSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [flightFilter, setFlightFilter] = useState<string>('');
  // 默认显示未来 30 天
  const [from, setFrom] = useState<string>(todayStr());
  const [to, setTo] = useState<string>(daysFromTodayStr(30));

  const load = useCallback(async () => {
    if (!tokens) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.listSchedulesInRange(tokens.accessToken, {
        from: from || undefined,
        to: to || undefined,
      });
      setSchedules(r.schedules);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
    // seatsVersion 入参：任一座位变更后自动重拉
  }, [tokens, from, to, seatsVersion]);

  useEffect(() => {
    load();
  }, [load]);

  const allStats = useMemo<ScheduleStat[]>(() => {
    const result = schedules.map((s) => {
      const totalCapacity = s.seatClasses.reduce((sum, c) => sum + c.capacity, 0);
      const totalSold = s.seatClasses.reduce((sum, c) => sum + c.sold, 0);
      const totalAvailable = s.seatClasses.reduce((sum, c) => sum + c.available, 0);
      return {
        id: s.id,
        flightNumber: s.flightNumber,
        origin: s.originCode,
        dest: s.destinationCode,
        departureTime: s.departureTime,
        departureTz: s.departureTz,
        seatClasses: s.seatClasses,
        totalCapacity,
        totalSold,
        totalAvailable,
        occupancy: totalCapacity > 0 ? totalSold / totalCapacity : 0,
      };
    });
    // 业务上澳门（MFM）出发 = 去程，其余 = 回程；同一天内统一「先去后回」排列
    const directionRank = (originCode: string) => (originCode === 'MFM' ? 0 : 1);
    return result.sort(
      (a, b) =>
        // 主键用含年份的本地日期 YYYY-MM-DD，跨月/跨年才不会乱序（formatLocalDate 无年份）
        localYmd(a.departureTime, a.departureTz).localeCompare(
          localYmd(b.departureTime, b.departureTz),
        ) ||
        directionRank(a.origin) - directionRank(b.origin) ||
        a.departureTime.localeCompare(b.departureTime) ||
        a.flightNumber.localeCompare(b.flightNumber),
    );
  }, [schedules]);

  // 航班下拉来源：当前区间内出现过的航班号
  const flightNumbers = useMemo(
    () => Array.from(new Set(allStats.map((s) => s.flightNumber))).sort(),
    [allStats],
  );

  const filtered = useMemo(
    () => allStats.filter((s) => !flightFilter || s.flightNumber === flightFilter),
    [allStats, flightFilter],
  );

  // 汇总
  const summary = useMemo(() => {
    const totalCap = filtered.reduce((s, x) => s + x.totalCapacity, 0);
    const totalSold = filtered.reduce((s, x) => s + x.totalSold, 0);
    const avgOcc = totalCap > 0 ? totalSold / totalCap : 0;
    return { totalCap, totalSold, avgOcc, count: filtered.length };
  }, [filtered]);

  const setNext30 = () => {
    setFrom(todayStr());
    setTo(daysFromTodayStr(30));
  };

  return (
    <div className="space-y-5">
      <section>
        <h1 className="page-title">航班座位统计</h1>
        <p className="page-sub">
          实时统计自营航班的座位占用情况。余票口径：capacity − 已售 − 锁位（与前台一致）。
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <KpiCard label="班次数" value={summary.count.toString()} />
        <KpiCard label="总座位数" value={summary.totalCap.toLocaleString()} />
        <KpiCard label="已售座位" value={summary.totalSold.toLocaleString()} sub={`平均占用率 ${(summary.avgOcc * 100).toFixed(1)}%`} />
        <KpiCard label="平均空舱率" value={`${((1 - summary.avgOcc) * 100).toFixed(1)}%`} sub="(1 - 平均占用率)" />
      </section>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="label">航班</label>
            <select className="input" value={flightFilter} onChange={(e) => setFlightFilter(e.target.value)}>
              <option value="">全部航班</option>
              {flightNumbers.map((fn) => (
                <option key={fn} value={fn}>
                  {fn}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">出发日期 · 起始</label>
            <input
              type="date"
              className="input"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="label">出发日期 · 截止</label>
            <input
              type="date"
              className="input"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2">
            <button type="button" className="btn-secondary text-sm" onClick={setNext30}>
              未来 30 天
            </button>
            <button type="button" className="btn-secondary text-sm" onClick={() => load()}>
              刷新
            </button>
          </div>
        </div>
        <p className="mt-2 text-sm text-slate-500">显示 {filtered.length} 条</p>
      </section>

      {error && <div className="card border-rose-200 bg-rose-50 text-rose-700">{error}</div>}

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
              {loading && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-ink-muted">
                    加载中…
                  </td>
                </tr>
              )}
              {!loading &&
                filtered.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="font-medium text-ink">
                        {formatLocalDate(s.departureTime, s.departureTz)}
                      </div>
                      <div className="text-xs text-ink-muted">
                        {formatLocalTime(s.departureTime, s.departureTz)} {tzLabel(s.departureTz)}
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
                      const avail = s.totalAvailable;
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
              {!loading && filtered.length === 0 && (
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
