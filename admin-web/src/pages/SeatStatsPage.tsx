/**
 * 座位统计 — 接真后端 API（跨日期区间一次拉取，避免 N+1）。
 *
 * 数据口径（demo 时遇到追问可以这样回答）：
 *   - 已售 = FlightSeatClass.sold（订单确认占库存的那一刻 +1）
 *   - 占位 = 占位单余座 Σ(占位数 − 已转正 − 已减员)。占位单是无名单库存实体（团队留位 /
 *     代理切位），建单即压住座位但不进「已售」——所以只看「已售」会觉得"位置没少"，
 *     真正少掉的座位在这一列。转正成订单后从占位挪进已售，不会两头重复计。
 *   - 余票 = available = capacity − sold − locked − held（后端权威口径，与前台一致）
 *   - 总座 = capacity
 *   - 总占用率 = (已售 + 占位) / 总座 —— 全页唯一口径（KPI 卡与进度条百分比都走
 *     totalOccupancyRate）。占位压住的座位一样卖不出去，只算已售会把「被占位压满的
 *     班次」画成 1.1% 这种数字，容易被读成"没卖"。进度条按两段分色：实心 = 已售，
 *     斜纹琥珀 = 占位，两段相加封顶 100%；超售时百分比如实 > 100%（条封顶但标红）。
 *   - 超售 = 余票为负时的欠座数（航司减配 / 换机型把容量压到已售之下）。
 *     销售侧照旧按容量拒卖，这里标红是提醒去与航司 / 操作部协调。
 *   - 行底色只区分航向（去程 = 澳门出发，默认白底；回程 = 淡靛蓝底），不带状态语义——
 *     状态色（超售红 / 占位琥珀）留给行内文字，底色不去抢它们。
 *   - 日期区间为闭区间（between 起始/截止），服务端按 from/to 过滤
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type RangeSchedule } from '../lib/api';
import { airportLabel, CABIN_LABEL, formatLocalDate, formatLocalTime, localYmd, tzLabel } from '../lib/airports';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';
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

// 总占用率的唯一入口：(已售 + 占位) / 总座。KPI 卡与进度条都调这一个，
// 避免"卡片一个口径、进度条另一个口径"的漂移。超售时 > 1，不封顶（封顶交给画条的人）。
function totalOccupancyRate(sold: number, held: number, capacity: number): number {
  return capacity > 0 ? (sold + held) / capacity : 0;
}

// 业务上澳门（MFM）出发 = 去程，其余 = 回程。排序与行底色共用这一个判断。
function isOutbound(originCode: string): boolean {
  return originCode === 'MFM';
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
  totalHeld: number;
  totalAvailable: number;
  // 各舱位余位为负的部分之和 = 该班次欠了多少座（>0 即超售）。
  // 逐舱累加而不是看 totalAvailable：一舱超售、另一舱有余时净值可能仍为正，
  // 那也必须报出来。
  oversoldSeats: number;
  // 占用率不再存成派生字段：总占用率 = (已售 + 占位) / 总座，
  // 由 totalOccupancyRate 按需算（KPI 卡、进度条同一个函数），避免两处各存一份走岔。
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
      const totalHeld = s.seatClasses.reduce((sum, c) => sum + c.held, 0);
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
        totalHeld,
        totalAvailable,
        oversoldSeats,
      };
    });
    // 同一天内统一「先去后回」排列
    const directionRank = (originCode: string) => (isOutbound(originCode) ? 0 : 1);
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
    const totalHeld = filtered.reduce((s, x) => s + x.totalHeld, 0);
    // 与进度条同一个口径：含占位。空舱率夹到 0——占位把班次压过满时算出负数没意义。
    const avgOcc = totalOccupancyRate(totalSold, totalHeld, totalCap);
    const avgEmpty = Math.max(0, 1 - avgOcc);
    return { totalCap, totalSold, totalHeld, avgOcc, avgEmpty, count: filtered.length };
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
          实时统计自营航班的座位占用情况。余票口径：总座位 − 已售 − 锁位 − 占位（与前台一致）。
          「占位」是占位单压住的座位（团队留位 / 代理切位），建单即占座但不进「已售」——
          只看已售会以为位置没少，少掉的座位在占位列。
          余票为负即<strong className="text-rose-700">超售</strong>（容量被调到已售之下，如航司减配 / 换机型），
          标红提醒协调；销售侧照旧按容量拒卖。
          占用率按<strong>总占用 =（已售 + 占位）÷ 总座</strong>算，进度条实心段是已售、斜纹段是占位，
          被占位压住的班次不会再显示成「几乎没卖」。
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <KpiCard label="班次数" value={summary.count.toString()} />
        <KpiCard label="总座位数" value={summary.totalCap.toLocaleString()} />
        <KpiCard
          label="已售座位"
          value={summary.totalSold.toLocaleString()}
          sub={`平均总占用率 ${(summary.avgOcc * 100).toFixed(1)}%（含占位 ${summary.totalHeld.toLocaleString()} 座）`}
        />
        <KpiCard
          label="平均空舱率"
          value={`${(summary.avgEmpty * 100).toFixed(1)}%`}
          sub="1 − 平均总占用率（已扣占位，即真正还能卖的比例）"
        />
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
        {/* 行底色图例：底色只表航向，不表状态，图例摆在表格上方免得被当成告警色 */}
        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
          <span>显示 {filtered.length} 条</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm border border-slate-300 bg-surface" aria-hidden />
            去程（澳门出发）
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm border border-brand-200 bg-brand-50" aria-hidden />
            回程
          </span>
        </p>
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
                <th className="text-right" title="占位单压住的座位：团队留位 / 代理切位，还没转成订单，所以不计入已售">占位</th>
                <th className="text-right">余票</th>
                <th className="w-48" title="总占用率 =（已售 + 占位）÷ 总座；实心段为已售，斜纹段为占位">
                  总占用率
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-ink-muted">
                    加载中…
                  </td>
                </tr>
              )}
              {!loading &&
                filtered.map((s) => (
                  // 回程整行淡靛蓝底（Console 的品牌色系，避免另起一套颜色）。
                  // 只到 brand-50 这个浓度，行内 rose/amber 语义色照旧压得住；
                  // hover 用 ! 提权，否则被 .table-admin tbody tr:hover 的 slate 底盖掉、
                  // 鼠标一扫底色就没了。
                  <tr
                    key={s.id}
                    className={isOutbound(s.origin) ? undefined : 'bg-brand-50/70 hover:!bg-brand-100/60'}
                  >
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
                            {c.held > 0 && (
                              <span className="font-semibold text-amber-700" title="该舱位被占位单压住的座位（团队留位 / 代理切位），不计入已售">
                                占{c.held}{' '}
                              </span>
                            )}
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
                    {/* 占位：0 用淡色，非 0 加重——「余票少了但已售没动」的答案就在这一列 */}
                    <td className={`text-right nums ${s.totalHeld > 0 ? 'font-semibold text-amber-700' : 'text-ink-muted'}`}>
                      {s.totalHeld}
                    </td>
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
                            <Icon name="alert" /> 超售 {s.oversoldSeats}
                          </td>
                        );
                      }
                      return (
                        <td
                          className={`text-right nums ${tone.low ? 'font-bold' : ''} ${tone.text}`}
                          title={tone.low ? '余位不足总座 10%，建议关注/调价' : undefined}
                        >
                          {tone.low && <Icon name="alert" />}{avail}
                        </td>
                      );
                    })()}
                    <td>
                      <OccupancyBar
                        sold={s.totalSold}
                        held={s.totalHeld}
                        capacity={s.totalCapacity}
                        oversold={s.oversoldSeats > 0}
                      />
                    </td>
                  </tr>
                ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-ink-muted">
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

// 占位段的斜纹：琥珀色系与行内「占N」标签一致，斜纹表示"暂占、还没转成订单"，
// 也免得和已售段 60–80% 档的琥珀糊成一条看不出分界。
// （amber-400 / amber-200，写死十六进制是因为 Tailwind 生不出重复渐变。）
const HELD_STRIPES = {
  backgroundImage: 'repeating-linear-gradient(45deg, #fbbf24 0 3px, #fde68a 3px 6px)',
} as const;

// 双色分段条：实心 = 已售，斜纹琥珀 = 占位，两段相加封顶 100%
// （条本身没有"超过满"的画法）。百分比走总占用口径，超售时如实显示 > 100% 并标红，
// 不把这件事糊过去。
function OccupancyBar({
  sold,
  held,
  capacity,
  oversold,
}: {
  sold: number;
  held: number;
  capacity: number;
  oversold: boolean;
}) {
  const occupancy = totalOccupancyRate(sold, held, capacity);
  const pct = occupancy * 100;
  const soldPct = capacity > 0 ? (sold / capacity) * 100 : 0;
  const heldPct = capacity > 0 ? (held / capacity) * 100 : 0;
  // 非 0 的极小占比给 2% 地板，否则一条几乎看不见的线等于没画；真 0 就画 0，不骗人。
  const soldWidth = soldPct > 0 ? Math.min(100, Math.max(soldPct, 2)) : 0;
  const heldWidth = heldPct > 0 ? Math.min(100 - soldWidth, Math.max(heldPct, 2)) : 0;
  // 已售段沿用原三档热度色（>80% 红 / >60% 琥珀 / 其余绿），档位按总占用判定——
  // 决定"这班还剩多少可卖"的是已售 + 占位，不是已售一项。
  const soldColor = oversold
    ? 'bg-rose-600'
    : occupancy > 0.8
      ? 'bg-red-500'
      : occupancy > 0.6
        ? 'bg-amber-500'
        : 'bg-green-500';
  const title =
    `总占用 ${pct.toFixed(1)}%：已售 ${sold} · 占位 ${held} / 总座 ${capacity}` +
    (oversold ? '（已超容量，条封顶 100%）' : '');
  return (
    <div className="flex items-center gap-2" title={title}>
      <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full shrink-0 ${soldColor}`} style={{ width: `${soldWidth}%` }} />
        <div className="h-full shrink-0" style={{ ...HELD_STRIPES, width: `${heldWidth}%` }} />
      </div>
      <span
        className={`w-12 text-right text-xs tabular-nums ${oversold ? 'font-bold text-rose-700' : 'text-slate-700'}`}
      >
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}
