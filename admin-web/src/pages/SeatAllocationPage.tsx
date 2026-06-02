/**
 * 切位（包位）管理 — Mock UI，演示业务逻辑。
 *
 * 业务规则（demo 时遇到追问就讲这些）：
 *   1. 一个班次的所有切位之和（按舱位）≤ 该舱位库存
 *   2. 任何切位：已售 ≤ 切位数
 *   3. 散客池 = 库存 - sum(各代理切位)
 *   4. 切位有截止回收时间：过了之后未售部分自动回散客池
 *   5. 不同舱位独立核算（经济/商务分别管）
 *
 * Demo 模式：所有变更只在当前会话生效，刷新后回到默认状态。
 * 真实接 API 后会写到新建的 SeatAllocation 表（agentId, scheduleId, cabin, allocatedSeats, soldSeats, releaseAt）。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type AdminFlight, type AdminSchedule } from '../lib/api';
import { airportLabel, CABIN_LABEL, formatLocalDate, formatLocalTime } from '../lib/airports';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';

interface SeatAllocation {
  id: string;
  scheduleId: string;         // 新增：关联班次
  agentName: string;
  agentTier: number;
  cabin: 'ECONOMY' | 'BUSINESS';
  allocated: number;
  sold: number;
  releaseAt: string; // ISO
}

// 默认 demo 切位数据（每个班次都套用一份）
const defaultAllocationsFor = (scheduleId: string): SeatAllocation[] => [
  { id: `${scheduleId}-a1`, scheduleId, agentName: '澳门岘港旅游总代', agentTier: 1, cabin: 'ECONOMY', allocated: 50, sold: 35, releaseAt: addDays(7) },
  { id: `${scheduleId}-a2`, scheduleId, agentName: '澳门岘港旅游总代', agentTier: 1, cabin: 'BUSINESS', allocated: 8, sold: 5, releaseAt: addDays(7) },
  { id: `${scheduleId}-a3`, scheduleId, agentName: '澳门欢乐旅行社', agentTier: 2, cabin: 'ECONOMY', allocated: 30, sold: 28, releaseAt: addDays(5) },
  { id: `${scheduleId}-a4`, scheduleId, agentName: '澳门威尼斯人门店', agentTier: 3, cabin: 'ECONOMY', allocated: 20, sold: 12, releaseAt: addDays(3) },
];

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

const DEMO_AGENTS = [
  { name: '澳门岘港旅游总代', tier: 1 },
  { name: '澳门欢乐旅行社', tier: 2 },
  { name: '澳门威尼斯人门店', tier: 3 },
];

export function SeatAllocationPage() {
  const tokens = useAuth((s) => s.tokens);
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [allSchedules, setAllSchedules] = useState<Record<string, AdminSchedule[]>>({});
  const [selectedScheduleId, setSelectedScheduleId] = useState<string>('');
  // 所有班次的切位都放同一个扁平数组；selected schedule 只是过滤出其中一部分。
  // 这样 bulk 批量创建可以跨班次生效 + 切回原班次仍看得到。
  const [allocations, setAllocations] = useState<SeatAllocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  // 加载航班 + 班次
  useEffect(() => {
    if (!tokens) return;
    (async () => {
      try {
        const r = await api.listAllFlights(tokens.accessToken);
        setFlights(r.flights);
        const map: Record<string, AdminSchedule[]> = {};
        await Promise.all(
          r.flights.map(async (f) => {
            const s = await api.listSchedules(tokens.accessToken, f.id);
            // 只看未来 30 天的班次（切位主要演示近期班次）
            const now = Date.now();
            const horizon = now + 30 * 86400000;
            map[f.id] = s.schedules.filter((x) => {
              const t = new Date(x.departureTime).getTime();
              return t >= now && t <= horizon;
            });
          }),
        );
        setAllSchedules(map);
        // 自动选第一个班次，并给所有班次套 demo 默认切位
        const flat = Object.values(map).flat();
        const first = flat[0];
        if (first) {
          setSelectedScheduleId(first.id);
          // 只给前 10 个班次预填默认切位（避免一上来 500 条记录）
          const seeded = flat.slice(0, 10).flatMap((s) => defaultAllocationsFor(s.id));
          setAllocations(seeded);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载航班失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [tokens]);

  // 当前选中班次
  const selected = useMemo(() => {
    for (const sList of Object.values(allSchedules)) {
      const found = sList.find((s) => s.id === selectedScheduleId);
      if (found) {
        const flight = flights.find((f) => f.id === found.flightId);
        return { schedule: found, flight };
      }
    }
    return null;
  }, [allSchedules, selectedScheduleId, flights]);

  // 当前班次的切位（从总列表过滤）
  const currentAllocations = useMemo(
    () => allocations.filter((a) => a.scheduleId === selectedScheduleId),
    [allocations, selectedScheduleId],
  );

  // 各舱位的切位汇总（只算当前班次）
  const cabinSummary = useMemo(() => {
    if (!selected) return null;
    const result: Record<'ECONOMY' | 'BUSINESS', { capacity: number; soldTotal: number; allocated: number; allocatedSold: number; pool: number }> = {
      ECONOMY: { capacity: 0, soldTotal: 0, allocated: 0, allocatedSold: 0, pool: 0 },
      BUSINESS: { capacity: 0, soldTotal: 0, allocated: 0, allocatedSold: 0, pool: 0 },
    };
    for (const c of selected.schedule.seatClasses) {
      if (c.cabin !== 'ECONOMY' && c.cabin !== 'BUSINESS') continue;
      result[c.cabin].capacity = c.capacity;
      result[c.cabin].soldTotal = c.sold;
    }
    for (const a of currentAllocations) {
      result[a.cabin].allocated += a.allocated;
      result[a.cabin].allocatedSold += a.sold;
    }
    for (const cabin of ['ECONOMY', 'BUSINESS'] as const) {
      result[cabin].pool = result[cabin].capacity - result[cabin].allocated;
    }
    return result;
  }, [selected, currentAllocations]);

  if (loading) return <div className="card text-slate-500">加载中…</div>;
  if (error) return <div className="card border-red-200 bg-red-50 text-red-700">{error}</div>;
  if (!selected) return <div className="card text-slate-500">没有可用的班次（数据库可能没 seed）</div>;

  /**
   * 回收一条切位 — 业务规则：
   *   只回收"未售"部分。如果 sold > 0，把切位收缩到 allocated = sold（保持已售记录），
   *   而不是整条删除（删除会破坏"已售 ≤ 切位数"不变量并造成超卖）。
   *   如果 sold === 0，直接删除。
   */
  const recycle = (id: string) => {
    setAllocations((prev) => {
      const target = prev.find((a) => a.id === id);
      if (!target) return prev;
      if (target.sold === 0) {
        return prev.filter((a) => a.id !== id);
      }
      // sold > 0 — 收缩到 allocated = sold，未售部分回散客池
      return prev.map((a) =>
        a.id === id ? { ...a, allocated: a.sold } : a,
      );
    });
    setSavedFlash('已回收未售部分（demo） · 已售部分保留为代理已占库存');
    setTimeout(() => setSavedFlash(null), 3500);
  };

  /**
   * 一键回收过期 — 同样的规则：每条过期切位收缩到 allocated = sold。
   * 不丢失已售记录，不破坏 "已售 ≤ 切位数" 不变量。
   */
  const recycleExpired = () => {
    let collapsedCount = 0;
    let releasedSeats = 0;
    setAllocations((prev) =>
      prev.flatMap((a) => {
        if (daysUntil(a.releaseAt) > 0) return [a]; // 未过期
        if (a.allocated === a.sold) return [a]; // 没有未售余量，无需回收
        const released = a.allocated - a.sold;
        releasedSeats += released;
        collapsedCount++;
        if (a.sold === 0) return []; // 完全回收（已售=0）
        return [{ ...a, allocated: a.sold }]; // 保留已售
      }),
    );
    setSavedFlash(
      collapsedCount === 0
        ? '没有需要回收的过期切位'
        : `已处理 ${collapsedCount} 条过期切位，释放 ${releasedSeats} 个未售座位回散客池（demo）`,
    );
    setTimeout(() => setSavedFlash(null), 3500);
  };

  return (
    <div className="space-y-5">
      <section>
        <h1 className="text-2xl font-bold text-slate-900">切位 / 包位管理</h1>
        <p className="mt-1 text-sm text-slate-600">
          为代理锁定特定班次的库存份额。代理负责销售并按月对账，未售出部分到期前回收回散客池。
        </p>
        <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
          ⓘ Demo 模式：切位变更仅在当前会话有效。真实环境会写入 SeatAllocation 表（待 M3 后端完善）。
        </div>
      </section>

      {/* 班次选择 */}
      <section className="card">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <div>
            <label className="label">选择班次（仅显示未来 30 天）</label>
            <select
              className="input"
              value={selectedScheduleId}
              onChange={(e) => setSelectedScheduleId(e.target.value)}
            >
              {flights.map((f) => {
                const list = allSchedules[f.id] ?? [];
                return (
                  <optgroup key={f.id} label={`${f.flightNumber} ${f.originCode} → ${f.destinationCode}`}>
                    {list.map((s) => (
                      <option key={s.id} value={s.id}>
                        {f.flightNumber} · {formatLocalDate(s.departureTime, s.departureTz)} {formatLocalTime(s.departureTime, s.departureTz)}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <button className="btn-secondary text-sm" onClick={recycleExpired}>
              一键回收过期切位
            </button>
            <button
              className="text-sm px-4 py-2 rounded-md border border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100"
              onClick={() => setShowBulk(true)}
            >
              📦 批量切位
            </button>
            <button className="btn-primary text-sm" onClick={() => setShowForm(true)}>
              + 新建切位
            </button>
          </div>
        </div>
      </section>

      {/* 库存汇总 */}
      {cabinSummary && (
        <section className="grid gap-3 md:grid-cols-2">
          {(['ECONOMY', 'BUSINESS'] as const).map((cabin) => {
            const s = cabinSummary[cabin];
            const allocatedPct = s.capacity > 0 ? (s.allocated / s.capacity) * 100 : 0;
            const poolPct = 100 - allocatedPct;
            return (
              <div key={cabin} className="card">
                <h3 className="font-semibold text-slate-900">{CABIN_LABEL[cabin]}（{cabin}）</h3>
                <p className="mt-1 text-sm text-slate-600">
                  总库存 <strong>{s.capacity}</strong> 座 · 已切给代理 <strong>{s.allocated}</strong> 座 · 散客池剩 <strong>{s.pool}</strong> 座
                </p>
                <div className="mt-3 flex h-3 rounded-full overflow-hidden bg-slate-100">
                  <div className="bg-brand" style={{ width: `${allocatedPct}%` }} title={`代理切位 ${s.allocated} 座`} />
                  <div className="bg-emerald-400" style={{ width: `${poolPct}%` }} title={`散客池 ${s.pool} 座`} />
                </div>
                <div className="mt-2 flex gap-3 text-xs text-slate-500">
                  <span>■ 代理切位</span>
                  <span className="text-emerald-600">■ 散客池</span>
                </div>
                {s.allocated > s.capacity && (
                  <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
                    ⚠️ 切位总和超过库存（违反 invariant），需调整
                  </p>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* 切位列表 */}
      <section className="card p-0 overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-3">
          <h3 className="font-semibold text-slate-900">
            {selected.flight?.flightNumber} · {formatLocalDate(selected.schedule.departureTime, selected.schedule.departureTz)}{' '}
            {formatLocalTime(selected.schedule.departureTime, selected.schedule.departureTz)} 切位明细
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {airportLabel(selected.flight?.originCode ?? '')} → {airportLabel(selected.flight?.destinationCode ?? '')}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left">代理</th>
                <th className="px-4 py-2 text-left">舱位</th>
                <th className="px-4 py-2 text-right">切位数</th>
                <th className="px-4 py-2 text-right">已售</th>
                <th className="px-4 py-2 text-right">余切位</th>
                <th className="px-4 py-2 text-left">回收倒计时</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {currentAllocations.map((a) => {
                const remaining = a.allocated - a.sold;
                const days = daysUntil(a.releaseAt);
                const overSold = a.sold > a.allocated;
                return (
                  <tr key={a.id} className={overSold ? 'bg-red-50' : ''}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-900">{a.agentName}</div>
                      <div className="text-xs text-slate-500">{a.agentTier} 级代理</div>
                    </td>
                    <td className="px-4 py-2">
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">
                        {CABIN_LABEL[a.cabin]}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-medium">{a.allocated}</td>
                    <td className="px-4 py-2 text-right">
                      {a.sold} <span className="text-xs text-slate-400">({((a.sold / a.allocated) * 100).toFixed(0)}%)</span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <span className={remaining === 0 ? 'text-red-600 font-medium' : ''}>{remaining}</span>
                    </td>
                    <td className="px-4 py-2">
                      {days > 0 ? (
                        <span className={`text-xs ${days <= 3 ? 'text-amber-700' : 'text-slate-600'}`}>
                          剩 {days} 天到期
                        </span>
                      ) : (
                        <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">已过期</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        className="text-xs text-red-600 hover:text-red-700 disabled:text-slate-300"
                        onClick={() => recycle(a.id)}
                        disabled={remaining <= 0}
                        title={
                          a.sold > 0
                            ? `切位收缩到 ${a.sold}（已售部分保留），${remaining} 个未售回散客池`
                            : '完全回收切位'
                        }
                      >
                        {a.sold > 0 ? `回收余 ${remaining} 座` : '回收'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {/* 散客池行 */}
              {(['ECONOMY', 'BUSINESS'] as const).map((cabin) => {
                if (!cabinSummary) return null;
                const s = cabinSummary[cabin];
                if (s.pool <= 0 && s.capacity === 0) return null;
                return (
                  <tr key={'pool-' + cabin} className="bg-emerald-50/40">
                    <td className="px-4 py-2">
                      <div className="font-medium text-emerald-700">📦 散客池</div>
                      <div className="text-xs text-slate-500">公共可售</div>
                    </td>
                    <td className="px-4 py-2">
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{CABIN_LABEL[cabin]}</span>
                    </td>
                    <td className="px-4 py-2 text-right">{s.pool}</td>
                    <td className="px-4 py-2 text-right text-slate-400">—</td>
                    <td className="px-4 py-2 text-right">{s.pool}</td>
                    <td className="px-4 py-2 text-xs text-slate-400">不回收</td>
                    <td></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {savedFlash && (
          <div className="border-t border-slate-200 bg-green-50 px-5 py-2 text-sm text-green-700">{savedFlash}</div>
        )}
      </section>

      {showForm && cabinSummary && selected && (
        <NewAllocationForm
          cabinSummary={cabinSummary}
          scheduleId={selected.schedule.id}
          onCancel={() => setShowForm(false)}
          onSubmit={(alloc) => {
            setAllocations((prev) => [...prev, { ...alloc, id: 'new-' + Date.now() }]);
            setShowForm(false);
            setSavedFlash('已新增切位（demo）');
            setTimeout(() => setSavedFlash(null), 2500);
          }}
        />
      )}

      {showBulk && (
        <BulkAllocationModal
          flights={flights}
          allSchedules={allSchedules}
          onCancel={() => setShowBulk(false)}
          onApply={(newRecords) => {
            setAllocations((prev) => [...prev, ...newRecords]);
            setShowBulk(false);
            setSavedFlash(`批量切位成功：共创建 ${newRecords.length} 条记录（demo）`);
            setTimeout(() => setSavedFlash(null), 4000);
          }}
        />
      )}
    </div>
  );
}

// ── 新建切位表单 ──
function NewAllocationForm({
  cabinSummary,
  scheduleId,
  onCancel,
  onSubmit,
}: {
  cabinSummary: Record<'ECONOMY' | 'BUSINESS', { capacity: number; allocated: number; pool: number }>;
  scheduleId: string;
  onCancel: () => void;
  onSubmit: (a: Omit<SeatAllocation, 'id'>) => void;
}) {
  const [agentIdx, setAgentIdx] = useState(0);
  const [cabin, setCabin] = useState<'ECONOMY' | 'BUSINESS'>('ECONOMY');
  const [seats, setSeats] = useState<number | null>(20);
  const [days, setDays] = useState(7);

  // Invariant: 申请切位 ≤ 散客池剩余
  const max = cabinSummary[cabin]?.pool ?? 0;
  const seatsNum = seats ?? 0;
  const valid = seatsNum > 0 && seatsNum <= max;
  const agent = DEMO_AGENTS[agentIdx];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-slate-200 px-5 py-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">新建切位</h2>
          <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onCancel}>×</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="label">代理</label>
            <select className="input" value={agentIdx} onChange={(e) => setAgentIdx(Number(e.target.value))}>
              {DEMO_AGENTS.map((a, i) => (
                <option key={a.name} value={i}>
                  [{a.tier} 级] {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">舱位</label>
            <select className="input" value={cabin} onChange={(e) => setCabin(e.target.value as 'ECONOMY' | 'BUSINESS')}>
              <option value="ECONOMY">经济舱</option>
              <option value="BUSINESS">商务舱</option>
            </select>
            <p className="mt-1 text-xs text-slate-500">
              当前散客池剩余 <strong>{max}</strong> 座可切
            </p>
          </div>
          <div>
            <label className="label">切位数（≤ 散客池剩余）</label>
            <NumberInput
              integerOnly
              min={1}
              max={max}
              className="input"
              value={seats}
              onChange={(n) => setSeats(n)}
            />
            {!valid && (
              <p className="mt-1 text-xs text-red-600">⚠️ 必须 1 ≤ 切位数 ≤ {max}（散客池上限）</p>
            )}
          </div>
          <div>
            <label className="label">回收倒计时</label>
            <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={3}>出发前 3 天回收</option>
              <option value={5}>出发前 5 天回收</option>
              <option value={7}>出发前 7 天回收</option>
              <option value={14}>出发前 14 天回收</option>
            </select>
          </div>
          <div className="flex justify-end gap-3">
            <button className="btn-secondary" onClick={onCancel}>取消</button>
            <button
              className="btn-primary"
              disabled={!valid}
              onClick={() =>
                onSubmit({
                  scheduleId,
                  agentName: agent.name,
                  agentTier: agent.tier,
                  cabin,
                  allocated: seatsNum,
                  sold: 0,
                  releaseAt: addDays(days),
                })
              }
            >
              确认切位
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// BulkAllocationModal — 批量切位（跨班次 × 跨日期 × 跨星期几）
//
// 使用场景：客服给某代理"每周五周六 MFM→DAD 经济舱切 30 座，为期 2 个月"。
// 传统单条新建要点 40+ 次；批量一次搞定。
//
// 选择维度：
//   1. 代理（从 DEMO_AGENTS 单选）
//   2. 航班（多选；默认全选）
//   3. 日期范围（from / to）
//   4. 星期几过滤（周一-周日多选；默认全选）
//   5. 舱位（经济 / 商务 / 两者）
//   6. 每班切多少座
//   7. 回收时机（出发前 N 天）
//
// 应用前先 preview：显示将匹配的班次数 + 总切位记录数。
// ─────────────────────────────────────────────────────────────────
function BulkAllocationModal({
  flights,
  allSchedules,
  onCancel,
  onApply,
}: {
  flights: AdminFlight[];
  allSchedules: Record<string, AdminSchedule[]>;
  onCancel: () => void;
  onApply: (records: SeatAllocation[]) => void;
}) {
  const [agentIdx, setAgentIdx] = useState(0);
  const [flightIds, setFlightIds] = useState<Set<string>>(() => new Set(flights.map((f) => f.id)));
  const todayStr = new Date().toISOString().slice(0, 10);
  const toDefault = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const [fromDate, setFromDate] = useState(todayStr);
  const [toDate, setToDate] = useState(toDefault);
  const [dowSet, setDowSet] = useState<Set<number>>(() => new Set([0, 1, 2, 3, 4, 5, 6]));
  const [econSeats, setEconSeats] = useState<number | null>(20);
  const [bizSeats, setBizSeats] = useState<number | null>(3);
  const [cabinMode, setCabinMode] = useState<'ECONOMY' | 'BUSINESS' | 'BOTH'>('ECONOMY');
  const [releaseDays, setReleaseDays] = useState(7);

  const agent = DEMO_AGENTS[agentIdx];
  const DOW_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

  // 预览：匹配的班次 + 将生成的记录
  const preview = useMemo(() => {
    const fromMs = new Date(`${fromDate}T00:00:00`).getTime();
    const toMs = new Date(`${toDate}T23:59:59`).getTime();

    const matchedSchedules: AdminSchedule[] = [];
    for (const fid of flightIds) {
      const list = allSchedules[fid] ?? [];
      for (const s of list) {
        const t = new Date(s.departureTime).getTime();
        if (t < fromMs || t > toMs) continue;
        const dow = new Date(s.departureTime).getDay();
        if (!dowSet.has(dow)) continue;
        matchedSchedules.push(s);
      }
    }

    const records: SeatAllocation[] = [];
    const cabins: Array<'ECONOMY' | 'BUSINESS'> =
      cabinMode === 'BOTH' ? ['ECONOMY', 'BUSINESS'] : [cabinMode];
    const now = Date.now();
    for (const s of matchedSchedules) {
      for (const c of cabins) {
        const seats = (c === 'ECONOMY' ? econSeats : bizSeats) ?? 0;
        if (seats <= 0) continue;
        // releaseAt = 班次出发前 releaseDays 天（不能早于 now）
        const depMs = new Date(s.departureTime).getTime();
        const releaseMs = Math.max(now + 60000, depMs - releaseDays * 86400000);
        records.push({
          id: `bulk-${s.id}-${c}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          scheduleId: s.id,
          agentName: agent.name,
          agentTier: agent.tier,
          cabin: c,
          allocated: seats,
          sold: 0,
          releaseAt: new Date(releaseMs).toISOString(),
        });
      }
    }
    return { matchedSchedules, records };
  }, [flightIds, fromDate, toDate, dowSet, cabinMode, econSeats, bizSeats, releaseDays, agent]);

  const valid = preview.records.length > 0 && new Date(fromDate) <= new Date(toDate);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 border-b border-slate-200 bg-white px-5 py-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">📦 批量切位</h2>
          <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          {/* 代理 */}
          <div>
            <label className="label">代理</label>
            <select
              className="input"
              value={agentIdx}
              onChange={(e) => setAgentIdx(Number(e.target.value))}
            >
              {DEMO_AGENTS.map((a, i) => (
                <option key={a.name} value={i}>
                  [{a.tier} 级] {a.name}
                </option>
              ))}
            </select>
          </div>

          {/* 航班多选 */}
          <div>
            <label className="label">航班（可多选）</label>
            <div className="flex flex-wrap gap-2">
              {flights.map((f) => {
                const checked = flightIds.has(f.id);
                return (
                  <label
                    key={f.id}
                    className={`flex items-center gap-1 px-3 py-1 rounded-md border cursor-pointer text-sm ${
                      checked ? 'border-brand bg-brand/10 text-brand' : 'border-slate-300'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setFlightIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(f.id)) next.delete(f.id);
                          else next.add(f.id);
                          return next;
                        });
                      }}
                    />
                    {f.flightNumber} {f.originCode}→{f.destinationCode}
                  </label>
                );
              })}
            </div>
          </div>

          {/* 日期范围 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">起始日期</label>
              <input
                type="date"
                className="input"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div>
              <label className="label">结束日期</label>
              <input
                type="date"
                className="input"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                min={fromDate}
              />
            </div>
          </div>

          {/* 星期几 */}
          <div>
            <label className="label">只匹配星期几（默认全选）</label>
            <div className="flex gap-2">
              {DOW_LABELS.map((label, i) => {
                const checked = dowSet.has(i);
                return (
                  <label
                    key={i}
                    className={`flex flex-col items-center justify-center w-12 h-12 rounded-md border cursor-pointer ${
                      checked ? 'border-brand bg-brand/10 text-brand font-semibold' : 'border-slate-300 text-slate-500'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="hidden"
                      checked={checked}
                      onChange={() => {
                        setDowSet((prev) => {
                          const next = new Set(prev);
                          if (next.has(i)) next.delete(i);
                          else next.add(i);
                          return next;
                        });
                      }}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </div>

          {/* 舱位模式 */}
          <div>
            <label className="label">舱位</label>
            <div className="flex gap-2">
              {(['ECONOMY', 'BUSINESS', 'BOTH'] as const).map((m) => (
                <label
                  key={m}
                  className={`flex-1 text-center px-3 py-2 rounded-md border cursor-pointer text-sm ${
                    cabinMode === m ? 'border-brand bg-brand/10 text-brand' : 'border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    className="hidden"
                    checked={cabinMode === m}
                    onChange={() => setCabinMode(m)}
                  />
                  {m === 'ECONOMY' ? '仅经济舱' : m === 'BUSINESS' ? '仅商务舱' : '经济 + 商务'}
                </label>
              ))}
            </div>
          </div>

          {/* 每班切几座 */}
          <div className="grid grid-cols-2 gap-3">
            {(cabinMode === 'ECONOMY' || cabinMode === 'BOTH') && (
              <div>
                <label className="label">经济舱每班切</label>
                <NumberInput
                  integerOnly
                  min={0}
                  max={180}
                  className="input"
                  value={econSeats}
                  onChange={(n) => setEconSeats(n)}
                />
              </div>
            )}
            {(cabinMode === 'BUSINESS' || cabinMode === 'BOTH') && (
              <div>
                <label className="label">商务舱每班切</label>
                <NumberInput
                  integerOnly
                  min={0}
                  max={20}
                  className="input"
                  value={bizSeats}
                  onChange={(n) => setBizSeats(n)}
                />
              </div>
            )}
          </div>

          {/* 回收时机 */}
          <div>
            <label className="label">回收时机</label>
            <select
              className="input"
              value={releaseDays}
              onChange={(e) => setReleaseDays(Number(e.target.value))}
            >
              <option value={3}>出发前 3 天回收</option>
              <option value={5}>出发前 5 天回收</option>
              <option value={7}>出发前 7 天回收</option>
              <option value={14}>出发前 14 天回收</option>
              <option value={30}>出发前 30 天回收</option>
            </select>
          </div>

          {/* 预览 */}
          <div className="rounded-md bg-purple-50 border border-purple-200 px-4 py-3 text-sm">
            <div className="font-medium text-purple-900">预览</div>
            <div className="mt-1 text-purple-800">
              将匹配 <strong>{preview.matchedSchedules.length}</strong> 个班次，创建{' '}
              <strong>{preview.records.length}</strong> 条切位记录
            </div>
            {preview.matchedSchedules.length > 0 && (
              <div className="mt-1 text-xs text-purple-700">
                首班：{formatLocalDate(preview.matchedSchedules[0].departureTime, preview.matchedSchedules[0].departureTz)} · 末班：
                {formatLocalDate(
                  preview.matchedSchedules[preview.matchedSchedules.length - 1].departureTime,
                  preview.matchedSchedules[preview.matchedSchedules.length - 1].departureTz,
                )}
              </div>
            )}
            {!valid && preview.records.length === 0 && (
              <div className="mt-1 text-xs text-amber-700">⚠️ 当前条件没有匹配到任何班次</div>
            )}
          </div>

          {/* 按钮 */}
          <div className="flex justify-end gap-3 pt-2 border-t border-slate-200">
            <button className="btn-secondary" onClick={onCancel}>
              取消
            </button>
            <button
              className="btn-primary"
              disabled={!valid}
              onClick={() => onApply(preview.records)}
            >
              应用到 {preview.records.length} 条记录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
