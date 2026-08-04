/**
 * 座位统计 — 接真后端 API（跨日期区间一次拉取，避免 N+1）。
 *
 * 数据口径（demo 时遇到追问可以这样回答）：
 *   - 已售 = FlightSeatClass.sold（订单确认占库存的那一刻 +1）
 *   - 余票 = available = capacity − sold − locked（后端权威口径，与前台一致）
 *   - 总座 = capacity
 *   - 占用率 = sold / capacity（超售时 > 100%，进度条封顶显示但标红）
 *   - 超售 = 余票为负时的欠座数（航司减配 / 换机型把容量压到已售之下）。
 *     销售侧照旧按容量拒卖，这里标红是提醒去与航司 / 操作部协调。
 *   - 日期区间为闭区间（between 起始/截止），服务端按 from/to 过滤
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type RangeSchedule } from '../lib/api';
import { airportLabel, CABIN_LABEL, formatLocalDate, formatLocalTime, localYmd, tzLabel } from '../lib/airports';
import { useAuth } from '../stores/auth';
import { useFlightSeats } from '../stores/flightSeats';

// 余位是否"紧张"：按容量比例判断，不用绝对张数——
// 一个 7 座商务舱剩 6 张不是紧张，一个 186 座经济舱剩 15 张才是。
// 地板 5 张兜住极小舱位（比例算出 0～1 张这种门槛没意义），门槛夹到 < capacity，
// 否则地板反超总容量，连"满仓"都会被误判紧张。口径与航班管理页一致。
function isSeatLow(remaining: number, capacity: number): boolean {
  const cutoff = Math.min(capacity - 1, Math.max(5, Math.ceil(capacity * 0.1)));
  return remaining <= cutoff;
}

// 余位三档色（红/琥珀/绿）：红门槛同 isSeatLow，琥珀门槛加宽一倍（同样夹到 < capacity）。
function seatTone(remaining: number, capacity: number): { text: string; low: boolean } {
  if (isSeatLow(remaining, capacity)) return { text: 'text-rose-600', low: true };
  const amberCut = Math.min(capacity - 1, Math.max(10, Math.ceil(capacity * 0.2)));
  if (remaining <= amberCut) return { text: 'text-amber-600', low: false };
  return { text: 'text-emerald-600', low: false };
}

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
  // 各舱位余位为负的部分之和 = 该班次欠了多少座（>0 即超售）。
  // 逐舱累加而不是看 totalAvailable：一舱超售、另一舱有余时净值可能仍为正，
  // 那也必须报出来。
  oversoldSeats: number;
  occupancy: number; // 0..1（超售时 > 1）
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
      const oversoldSeats = s.seatClasses.reduce((sum, c) => sum + Math.max(0, -c.available), 0);
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
        oversoldSeats,
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
          余票为负即<strong className="text-rose-700">超售</strong>（容量被调到已售之下，如航司减配 / 换机型），
          标红提醒协调；销售侧照旧按容量拒卖。
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
                      {s.seatClasses.map((c) => {
                        const cabinOversold = c.available < 0;
                        return (
                          <div key={c.id}>
                            <span className="text-ink-muted">{CABIN_LABEL[c.cabin] ?? c.cabin}:</span>{' '}
                            <span className={cabinOversold ? 'font-bold text-rose-700' : 'text-ink'}>
                              {c.sold}/{c.capacity}
                            </span>{' '}
                            {cabinOversold && (
                              <span
                                className="font-bold text-rose-700"
                                title="该舱位容量已低于已售 + 锁位，需与航司 / 操作部协调"
                              >
                                超售 {-c.available}{' '}
                              </span>
                            )}
                            <span className="text-ink-muted">¥{Number(c.basePrice).toFixed(0)}</span>
                          </div>
                        );
                      })}
                    </td>
                    <td className="text-right nums">{s.totalCapacity}</td>
                    <td className="text-right nums">{s.totalSold}</td>
                    {(() => {
                      const avail = s.totalAvailable;
                      const oversold = s.oversoldSeats > 0;
                      const tone = seatTone(avail, s.totalCapacity);
                      if (oversold) {
                        return (
                          <td
                            className="text-right nums font-bold text-rose-700"
                            title={`容量已低于已售：欠 ${s.oversoldSeats} 座（各舱位净余票合计 ${avail}）。销售侧照旧不再卖出，请与航司 / 操作部协调。`}
                          >
                            🔴 超售 {s.oversoldSeats}
                          </td>
                        );
                      }
                      return (
                        <td
                          className={`text-right nums ${tone.low ? 'font-bold' : ''} ${tone.text}`}
                          title={tone.low ? '余位不足总座 10%，建议关注/调价' : undefined}
                        >
                          {tone.low && '🔴 '}{avail}
                        </td>
                      );
                    })()}
                    <td>
                      <OccupancyBar occupancy={s.occupancy} oversold={s.oversoldSeats > 0} />
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

// 超售时 occupancy > 1：进度条封顶 100%（条本身没有"超过满"的画法），
// 但配超售红 + 百分比如实显示 >100%，不把这件事糊过去。
function OccupancyBar({ occupancy, oversold }: { occupancy: number; oversold: boolean }) {
  const pct = occupancy * 100;
  const barPct = Math.min(100, Math.max(pct, 2));
  const color = oversold
    ? 'bg-rose-600'
    : occupancy > 0.8
      ? 'bg-red-500'
      : occupancy > 0.6
        ? 'bg-amber-500'
        : 'bg-green-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${barPct}%` }} />
      </div>
      <span
        className={`text-xs tabular-nums w-12 text-right ${oversold ? 'font-bold text-rose-700' : 'text-slate-700'}`}
        title={pct > 100 ? '已售超过容量，占用率大于 100%' : undefined}
      >
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}
