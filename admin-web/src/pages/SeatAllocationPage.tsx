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

interface SeatAllocation {
  id: string;
  agentName: string;
  agentTier: number;
  cabin: 'ECONOMY' | 'BUSINESS';
  allocated: number;
  sold: number;
  releaseAt: string; // ISO
}

// 默认 demo 切位数据（每个班次都套用一份）
const DEFAULT_ALLOCATIONS = (): SeatAllocation[] => [
  { id: 'a1', agentName: '港澳岘港旅游总代', agentTier: 1, cabin: 'ECONOMY', allocated: 50, sold: 35, releaseAt: addDays(7) },
  { id: 'a2', agentName: '港澳岘港旅游总代', agentTier: 1, cabin: 'BUSINESS', allocated: 8, sold: 5, releaseAt: addDays(7) },
  { id: 'a3', agentName: '澳门欢乐旅行社', agentTier: 2, cabin: 'ECONOMY', allocated: 30, sold: 28, releaseAt: addDays(5) },
  { id: 'a4', agentName: '澳门威尼斯人门店', agentTier: 3, cabin: 'ECONOMY', allocated: 20, sold: 12, releaseAt: addDays(3) },
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
  { name: '港澳岘港旅游总代', tier: 1 },
  { name: '澳门欢乐旅行社', tier: 2 },
  { name: '澳门威尼斯人门店', tier: 3 },
];

export function SeatAllocationPage() {
  const tokens = useAuth((s) => s.tokens);
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [allSchedules, setAllSchedules] = useState<Record<string, AdminSchedule[]>>({});
  const [selectedScheduleId, setSelectedScheduleId] = useState<string>('');
  const [allocations, setAllocations] = useState<SeatAllocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
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
        // 自动选第一个班次
        const first = Object.values(map).flat()[0];
        if (first) {
          setSelectedScheduleId(first.id);
          setAllocations(DEFAULT_ALLOCATIONS());
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

  // 切换班次时，重置 demo 切位
  useEffect(() => {
    if (selectedScheduleId) setAllocations(DEFAULT_ALLOCATIONS());
  }, [selectedScheduleId]);

  // 各舱位的切位汇总
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
    for (const a of allocations) {
      result[a.cabin].allocated += a.allocated;
      result[a.cabin].allocatedSold += a.sold;
    }
    for (const cabin of ['ECONOMY', 'BUSINESS'] as const) {
      result[cabin].pool = result[cabin].capacity - result[cabin].allocated;
    }
    return result;
  }, [selected, allocations]);

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
          <div className="flex items-end gap-2">
            <button className="btn-secondary text-sm" onClick={recycleExpired}>
              一键回收过期切位
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
              {allocations.map((a) => {
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

      {showForm && cabinSummary && (
        <NewAllocationForm
          cabinSummary={cabinSummary}
          onCancel={() => setShowForm(false)}
          onSubmit={(alloc) => {
            setAllocations((prev) => [...prev, { ...alloc, id: 'new-' + Date.now() }]);
            setShowForm(false);
            setSavedFlash('已新增切位（demo）');
            setTimeout(() => setSavedFlash(null), 2500);
          }}
        />
      )}
    </div>
  );
}

// ── 新建切位表单 ──
function NewAllocationForm({
  cabinSummary,
  onCancel,
  onSubmit,
}: {
  cabinSummary: Record<'ECONOMY' | 'BUSINESS', { capacity: number; allocated: number; pool: number }>;
  onCancel: () => void;
  onSubmit: (a: Omit<SeatAllocation, 'id'>) => void;
}) {
  const [agentIdx, setAgentIdx] = useState(0);
  const [cabin, setCabin] = useState<'ECONOMY' | 'BUSINESS'>('ECONOMY');
  const [seats, setSeats] = useState(20);
  const [days, setDays] = useState(7);

  // Invariant: 申请切位 ≤ 散客池剩余
  const max = cabinSummary[cabin]?.pool ?? 0;
  const valid = seats > 0 && seats <= max;
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
            <input
              type="number"
              min={1}
              max={max}
              className="input"
              value={seats}
              onChange={(e) => setSeats(Number(e.target.value) || 0)}
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
                  agentName: agent.name,
                  agentTier: agent.tier,
                  cabin,
                  allocated: seats,
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
