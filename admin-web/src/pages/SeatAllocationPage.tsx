/**
 * 切位（包位）管理 — 真实持久化（后端 seat-allocation 模块）。
 *
 * 业务规则：
 *   1. 一个班次某舱位的所有 ACTIVE 切位之和 ≤ 该舱位散客池余量（后端强校验，绝不超切）
 *   2. 散客池余量 = capacity − sold − 未过期锁位 − Σ(ACTIVE 切位 seats)
 *   3. 切位有回收截止（出发前 N 天）：过期后由运营回收，未售部分归还散客池
 *   4. 不同舱位独立核算
 *
 * 切位以「单程班次」（flightScheduleId）为单位：出发日期 + 航班号即可定位一个班次，
 * 无返程日期维度（往返各自是独立班次）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type AdminFlight,
  type AdminSchedule,
  type AgentListItem,
  type CabinClass,
  type SeatAllocationListItem,
} from '../lib/api';
import { airportLabel, CABIN_LABEL, formatLocalDate, formatLocalTime } from '../lib/airports';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';

// 切位覆盖的舱位（与 CabinClass 一致；下拉展示全部四个舱等）
const CABIN_OPTIONS: CabinClass[] = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'];

// 回收时机选项（出发前 N 天）
const RECLAIM_DAYS_OPTIONS = [3, 5, 7, 14, 30];

function localDateOf(iso: string, tz: string): string {
  // 用班次时区把 ISO 折成 YYYY-MM-DD（用于「出发日期」筛选）
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function agentLabel(a: Pick<AgentListItem, 'companyName' | 'contactName' | 'tier'>): string {
  const name = a.companyName?.trim() || a.contactName;
  return `[${a.tier} 级] ${name}`;
}

export function SeatAllocationPage() {
  const tokens = useAuth((s) => s.tokens);
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [allSchedules, setAllSchedules] = useState<Record<string, AdminSchedule[]>>({});
  const [agents, setAgents] = useState<AgentListItem[]>([]);

  // 拆分的班次选择：出发日期 + 航班号 → 解析出 selectedScheduleId
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedFlightId, setSelectedFlightId] = useState<string>('');
  const [selectedScheduleId, setSelectedScheduleId] = useState<string>('');

  const [allocations, setAllocations] = useState<SeatAllocationListItem[]>([]);
  const [allocLoading, setAllocLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flash = useCallback((msg: string, ms = 3500) => {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(null), ms);
  }, []);

  // 加载航班 + 班次 + 代理
  useEffect(() => {
    if (!tokens) return;
    (async () => {
      try {
        const [flightsRes, agentsRes] = await Promise.all([
          api.listAllFlights(tokens.accessToken),
          api.listAgents(tokens.accessToken),
        ]);
        setFlights(flightsRes.flights);
        setAgents(agentsRes.agents.filter((a) => a.isActive));

        const map: Record<string, AdminSchedule[]> = {};
        await Promise.all(
          flightsRes.flights.map(async (f) => {
            const s = await api.listSchedules(tokens.accessToken, f.id);
            // 只看未来 30 天的班次（切位主要针对近期班次）
            const now = Date.now();
            const horizon = now + 30 * 86400000;
            map[f.id] = s.schedules.filter((x) => {
              const t = new Date(x.departureTime).getTime();
              return t >= now && t <= horizon;
            });
          }),
        );
        setAllSchedules(map);

        // 默认选第一个班次，并回填出发日期 + 航班号
        const flat = flightsRes.flights.flatMap((f) => (map[f.id] ?? []).map((s) => ({ f, s })));
        flat.sort((a, b) => a.s.departureTime.localeCompare(b.s.departureTime));
        const first = flat[0];
        if (first) {
          setSelectedFlightId(first.f.id);
          setSelectedDate(localDateOf(first.s.departureTime, first.s.departureTz));
          setSelectedScheduleId(first.s.id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载航班/代理失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [tokens]);

  // 出发日期可选项（所有班次的本地日，去重排序）
  const dateOptions = useMemo(() => {
    const set = new Set<string>();
    for (const list of Object.values(allSchedules)) {
      for (const s of list) set.add(localDateOf(s.departureTime, s.departureTz));
    }
    return [...set].sort();
  }, [allSchedules]);

  // 选定出发日期后，可选航班（该日有班次的航班）
  const flightOptions = useMemo(() => {
    if (!selectedDate) return flights;
    return flights.filter((f) =>
      (allSchedules[f.id] ?? []).some((s) => localDateOf(s.departureTime, s.departureTz) === selectedDate),
    );
  }, [flights, allSchedules, selectedDate]);

  // 出发日期 + 航班号 → 当天该航班的所有班次（同日同航班可能多班，用班次时刻下拉细分）
  const daySchedules = useMemo(() => {
    if (!selectedFlightId || !selectedDate) return [];
    return (allSchedules[selectedFlightId] ?? [])
      .filter((s) => localDateOf(s.departureTime, s.departureTz) === selectedDate)
      .sort((a, b) => a.departureTime.localeCompare(b.departureTime));
  }, [allSchedules, selectedFlightId, selectedDate]);

  // selectedDate / selectedFlightId 变化时，把 selectedScheduleId 收敛到当天该航班的一个有效班次
  useEffect(() => {
    if (daySchedules.length === 0) {
      setSelectedScheduleId('');
      return;
    }
    if (!daySchedules.some((s) => s.id === selectedScheduleId)) {
      setSelectedScheduleId(daySchedules[0].id);
    }
  }, [daySchedules, selectedScheduleId]);

  // 当前选中班次
  const selected = useMemo(() => {
    const flight = flights.find((f) => f.id === selectedFlightId);
    const schedule = daySchedules.find((s) => s.id === selectedScheduleId);
    if (!schedule) return null;
    return { schedule, flight };
  }, [flights, selectedFlightId, daySchedules, selectedScheduleId]);

  // 拉当前班次的切位列表（真实持久化）
  const refetchAllocations = useCallback(async () => {
    if (!tokens || !selectedScheduleId) {
      setAllocations([]);
      return;
    }
    setAllocLoading(true);
    try {
      const r = await api.listSeatAllocations(tokens.accessToken, {
        flightScheduleId: selectedScheduleId,
      });
      setAllocations(r.allocations);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载切位失败');
    } finally {
      setAllocLoading(false);
    }
  }, [tokens, selectedScheduleId]);

  useEffect(() => {
    void refetchAllocations();
  }, [refetchAllocations]);

  // 只在列表里看 ACTIVE 切位参与散客池扣减；RECLAIMED 已归还
  const activeAllocations = useMemo(
    () => allocations.filter((a) => a.status === 'ACTIVE'),
    [allocations],
  );

  // 各舱位散客池余量：available（=capacity−sold−locked，后端权威）− Σ(本页 ACTIVE 切位 seats)。
  // available 已扣锁位；切位 seats 由本页汇总扣，得到剩余可切座位。
  const cabinSummary = useMemo(() => {
    if (!selected) return null;
    const result: Record<
      string,
      { cabin: CabinClass; capacity: number; sold: number; available: number; allocated: number; pool: number }
    > = {};
    for (const c of selected.schedule.seatClasses) {
      result[c.cabin] = {
        cabin: c.cabin,
        capacity: c.capacity,
        sold: c.sold,
        available: c.available,
        allocated: 0,
        pool: c.available,
      };
    }
    for (const a of activeAllocations) {
      const row = result[a.cabin];
      if (!row) continue;
      row.allocated += a.seats;
      row.pool = Math.max(0, row.available - row.allocated);
    }
    return result;
  }, [selected, activeAllocations]);

  const cabinRows = useMemo(
    () => (cabinSummary ? Object.values(cabinSummary) : []),
    [cabinSummary],
  );

  // ── 回收一条切位（ACTIVE → RECLAIMED）──
  const recycle = async (id: string) => {
    if (!tokens) return;
    setBusy(true);
    try {
      await api.reclaimSeatAllocation(tokens.accessToken, id);
      await refetchAllocations();
      flash('已回收该切位，未售部分归还散客池');
    } catch (err) {
      flash(err instanceof Error ? err.message : '回收失败', 5000);
    } finally {
      setBusy(false);
    }
  };

  // ── 一键回收过期切位：对当前班次所有「已过期」ACTIVE 切位逐条回收 ──
  const recycleExpired = async () => {
    if (!tokens) return;
    const expired = activeAllocations.filter((a) => a.expired);
    if (expired.length === 0) {
      flash('没有需要回收的过期切位');
      return;
    }
    setBusy(true);
    try {
      let ok = 0;
      let released = 0;
      for (const a of expired) {
        try {
          await api.reclaimSeatAllocation(tokens.accessToken, a.id);
          ok++;
          released += a.seats;
        } catch {
          // 单条失败（如已被回收）跳过，继续处理其余
        }
      }
      await refetchAllocations();
      flash(`已回收 ${ok} 条过期切位，释放约 ${released} 座回散客池`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="card text-ink-muted">加载中…</div>;
  if (error) return <div className="card border-rose-200 bg-rose-50 text-rose-700">{error}</div>;
  if (flights.length === 0)
    return <div className="card text-ink-muted">没有可用的班次（数据库可能没 seed）</div>;

  return (
    <div className="space-y-5">
      <section>
        <h1 className="page-title">切位 / 包位管理</h1>
        <p className="page-sub">
          为代理锁定特定班次的库存份额。代理负责销售并按月对账，未售出部分到期前回收回散客池。
        </p>
      </section>

      {/* 班次选择：拆分为 出发日期 + 航班号 + 班次时刻（切位以单程班次为单位，无返程维度） */}
      <section className="card">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
          <div>
            <label className="label">出发日期</label>
            <select
              className="input"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            >
              {dateOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">航班号</label>
            <select
              className="input"
              value={selectedFlightId}
              onChange={(e) => setSelectedFlightId(e.target.value)}
            >
              {flightOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.flightNumber} · {f.originCode} → {f.destinationCode}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">班次时刻</label>
            <select
              className="input"
              value={selectedScheduleId}
              onChange={(e) => setSelectedScheduleId(e.target.value)}
              disabled={daySchedules.length === 0}
            >
              {daySchedules.length === 0 && <option value="">该日无班次</option>}
              {daySchedules.map((s) => (
                <option key={s.id} value={s.id}>
                  {formatLocalTime(s.departureTime, s.departureTz)} 出发
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <button className="btn-secondary text-sm" onClick={recycleExpired} disabled={busy}>
              一键回收过期切位
            </button>
            <button className="btn-secondary text-sm" onClick={() => setShowBulk(true)} disabled={busy}>
              📦 批量切位
            </button>
            <button
              className="btn-primary text-sm"
              onClick={() => setShowForm(true)}
              disabled={busy || !selected}
            >
              + 新建切位
            </button>
          </div>
        </div>
      </section>

      {/* 库存汇总（各舱位散客池余量） */}
      {cabinRows.length > 0 && (
        <section className="grid gap-3 md:grid-cols-2">
          {cabinRows.map((s) => {
            const total = s.available + s.allocated;
            const allocatedPct = total > 0 ? (s.allocated / total) * 100 : 0;
            const poolPct = 100 - allocatedPct;
            return (
              <div key={s.cabin} className="card">
                <h3 className="font-semibold text-slate-900">
                  {CABIN_LABEL[s.cabin] ?? s.cabin}（{s.cabin}）
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  已切给代理 <strong>{s.allocated}</strong> 座 · 散客池剩{' '}
                  <strong>{s.pool}</strong> 座 · 已售 <strong>{s.sold}</strong> 座
                </p>
                <div className="mt-3 flex h-3 rounded-full overflow-hidden bg-slate-100">
                  <div className="bg-brand" style={{ width: `${allocatedPct}%` }} title={`代理切位 ${s.allocated} 座`} />
                  <div className="bg-emerald-400" style={{ width: `${poolPct}%` }} title={`散客池 ${s.pool} 座`} />
                </div>
                <div className="mt-2 flex gap-3 text-xs text-slate-500">
                  <span>■ 代理切位</span>
                  <span className="text-emerald-600">■ 散客池</span>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* 切位列表 */}
      <section className="card p-0 overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-3">
          <h3 className="font-semibold text-slate-900">
            {selected?.flight?.flightNumber} ·{' '}
            {selected &&
              `${formatLocalDate(selected.schedule.departureTime, selected.schedule.departureTz)} ${formatLocalTime(selected.schedule.departureTime, selected.schedule.departureTz)}`}{' '}
            切位明细
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {airportLabel(selected?.flight?.originCode ?? '')} → {airportLabel(selected?.flight?.destinationCode ?? '')}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th className="text-left">代理</th>
                <th className="text-left">舱位</th>
                <th className="text-right">切位数</th>
                <th className="text-right">约定单价</th>
                <th className="text-left">回收条件</th>
                <th className="text-left">状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {allocLoading && (
                <tr>
                  <td colSpan={7} className="text-center text-ink-muted py-4">
                    加载切位中…
                  </td>
                </tr>
              )}
              {!allocLoading && allocations.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-ink-muted py-4">
                    该班次暂无切位记录
                  </td>
                </tr>
              )}
              {allocations.map((a) => {
                const isActive = a.status === 'ACTIVE';
                return (
                  <tr key={a.id} className={a.expired ? 'bg-amber-50' : ''}>
                    <td>
                      <div className="font-medium text-ink">
                        {a.agent.companyName?.trim() || a.agent.contactName}
                      </div>
                      <div className="text-xs text-ink-muted">
                        {a.agent.tier} 级代理 · {a.agent.contactName}
                      </div>
                    </td>
                    <td>
                      <span className="badge-neutral">{CABIN_LABEL[a.cabin] ?? a.cabin}</span>
                    </td>
                    <td className="text-right font-medium nums">{a.seats}</td>
                    <td className="text-right nums">
                      {a.unitPriceCny != null ? `¥${a.unitPriceCny}` : <span className="text-ink-muted">常规售价</span>}
                    </td>
                    <td>
                      <span className="text-xs text-ink-soft">出发前 {a.reclaimDaysBefore} 天回收</span>
                      {a.notes && <div className="text-xs text-ink-muted mt-0.5">{a.notes}</div>}
                    </td>
                    <td>
                      {a.status === 'RECLAIMED' ? (
                        <span className="badge-neutral">已回收</span>
                      ) : a.expired ? (
                        <span className="badge-danger">已过期·待回收</span>
                      ) : (
                        <span className="badge-neutral text-emerald-700">生效中</span>
                      )}
                    </td>
                    <td className="text-right">
                      <button
                        className="text-xs font-medium text-rose-600 hover:text-rose-700 disabled:text-ink-muted"
                        onClick={() => recycle(a.id)}
                        disabled={!isActive || busy}
                        title={isActive ? '回收该切位，未售部分归还散客池' : '已回收'}
                      >
                        {isActive ? '回收' : '—'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {/* 散客池行（每个舱位一行） */}
              {cabinRows.map((s) => (
                <tr key={'pool-' + s.cabin} className="bg-emerald-50/40">
                  <td>
                    <div className="font-medium text-emerald-700">📦 散客池</div>
                    <div className="text-xs text-ink-muted">公共可售</div>
                  </td>
                  <td>
                    <span className="badge-neutral">{CABIN_LABEL[s.cabin] ?? s.cabin}</span>
                  </td>
                  <td className="text-right nums">{s.pool}</td>
                  <td className="text-right text-ink-muted">—</td>
                  <td className="text-xs text-ink-muted">不回收</td>
                  <td className="text-xs text-ink-muted">公共</td>
                  <td></td>
                </tr>
              ))}
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
          agents={agents}
          departureLabel={`${selected.flight?.flightNumber ?? ''} · ${formatLocalDate(selected.schedule.departureTime, selected.schedule.departureTz)} ${formatLocalTime(selected.schedule.departureTime, selected.schedule.departureTz)}`}
          onCancel={() => setShowForm(false)}
          onSubmit={async (input) => {
            if (!tokens) return;
            setBusy(true);
            try {
              await api.createSeatAllocation(tokens.accessToken, {
                flightScheduleId: selected.schedule.id,
                cabin: input.cabin,
                agentId: input.agentId,
                seats: input.seats,
                unitPriceCny: input.unitPriceCny,
                reclaimDaysBefore: input.reclaimDaysBefore,
                notes: input.notes,
              });
              setShowForm(false);
              await refetchAllocations();
              flash('已新建切位');
            } catch (err) {
              // 把后端真实错误抛回表单（如「可切位余量不足…」）
              throw err instanceof Error ? err : new Error('新建切位失败');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {showBulk && (
        <BulkAllocationModal
          flights={flights}
          allSchedules={allSchedules}
          agents={agents}
          onCancel={() => setShowBulk(false)}
          onApply={async (plan) => {
            if (!tokens) return { created: 0, failed: [] };
            let created = 0;
            const failed: string[] = [];
            for (const rec of plan) {
              try {
                await api.createSeatAllocation(tokens.accessToken, rec.body);
                created++;
              } catch (err) {
                failed.push(`${rec.label}：${err instanceof Error ? err.message : '失败'}`);
              }
            }
            await refetchAllocations();
            return { created, failed };
          }}
        />
      )}
    </div>
  );
}

// ── 新建切位表单 ──
interface NewAllocationSubmit {
  cabin: CabinClass;
  agentId: string;
  seats: number;
  unitPriceCny: number | null;
  reclaimDaysBefore: number;
  notes: string | null;
}

function NewAllocationForm({
  cabinSummary,
  agents,
  departureLabel,
  onCancel,
  onSubmit,
}: {
  cabinSummary: Record<string, { cabin: CabinClass; pool: number }>;
  agents: AgentListItem[];
  departureLabel: string;
  onCancel: () => void;
  onSubmit: (input: NewAllocationSubmit) => Promise<void>;
}) {
  const cabinChoices = Object.values(cabinSummary).map((c) => c.cabin);
  const [cabin, setCabin] = useState<CabinClass>(cabinChoices[0] ?? 'ECONOMY');
  const [agentId, setAgentId] = useState<string>(agents[0]?.id ?? '');
  const [seats, setSeats] = useState<number | null>(10);
  const [price, setPrice] = useState<number | null>(null);
  const [reclaimDays, setReclaimDays] = useState(7);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const max = cabinSummary[cabin]?.pool ?? 0;
  const seatsNum = seats ?? 0;
  const valid = seatsNum > 0 && seatsNum <= max && !!agentId && (price == null || price >= 0);

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit({
        cabin,
        agentId,
        seats: seatsNum,
        unitPriceCny: price,
        reclaimDaysBefore: reclaimDays,
        notes: notes.trim() ? notes.trim() : null,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '新建切位失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-slate-200 px-5 py-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">新建切位</h2>
          <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onCancel}>×</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            班次：<strong>{departureLabel}</strong>
          </div>
          <div>
            <label className="label">代理</label>
            <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.length === 0 && <option value="">（无可用代理）</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {agentLabel(a)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">舱位</label>
            <select className="input" value={cabin} onChange={(e) => setCabin(e.target.value as CabinClass)}>
              {(cabinChoices.length > 0 ? cabinChoices : CABIN_OPTIONS).map((c) => (
                <option key={c} value={c}>
                  {CABIN_LABEL[c] ?? c}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              当前散客池剩余 <strong>{max}</strong> 座可切
            </p>
          </div>
          <div>
            <label className="label">人数（切位数，≤ 散客池剩余）</label>
            <NumberInput
              integerOnly
              min={1}
              max={max}
              className="input"
              value={seats}
              onChange={(n) => setSeats(n)}
            />
            {seatsNum > max && (
              <p className="mt-1 text-xs text-red-600">⚠️ 必须 1 ≤ 切位数 ≤ {max}（散客池上限）</p>
            )}
          </div>
          <div>
            <label className="label">约定单价（每人 CNY，选填）</label>
            <NumberInput
              integerOnly
              min={0}
              className="input"
              value={price}
              onChange={(n) => setPrice(n)}
            />
            <p className="mt-1 text-xs text-slate-500">留空 = 按常规售价结算</p>
          </div>
          <div>
            <label className="label">切位条件（回收时机）</label>
            <select className="input" value={reclaimDays} onChange={(e) => setReclaimDays(Number(e.target.value))}>
              {RECLAIM_DAYS_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  出发前 {d} 天回收
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">备注（选填）</label>
            <input
              className="input"
              value={notes}
              maxLength={500}
              placeholder="如：整团包位 / 特殊约定"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {formError && (
            <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{formError}</p>
          )}
          <div className="flex justify-end gap-3">
            <button className="btn-secondary" onClick={onCancel} disabled={submitting}>取消</button>
            <button className="btn-primary" disabled={!valid || submitting} onClick={submit}>
              {submitting ? '提交中…' : '确认切位'}
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
// 后端无批量创建端点：本模态按选择条件展开为「每班次×每舱位一条」计划，
// 逐条调用 createSeatAllocation 落库（真实持久化）。单条失败（如某班余量不足）
// 会被收集展示，不影响其余成功入库。
// ─────────────────────────────────────────────────────────────────
interface BulkRecordPlan {
  label: string;
  body: {
    flightScheduleId: string;
    cabin: CabinClass;
    agentId: string;
    seats: number;
    reclaimDaysBefore: number;
  };
}

function BulkAllocationModal({
  flights,
  allSchedules,
  agents,
  onCancel,
  onApply,
}: {
  flights: AdminFlight[];
  allSchedules: Record<string, AdminSchedule[]>;
  agents: AgentListItem[];
  onCancel: () => void;
  onApply: (plan: BulkRecordPlan[]) => Promise<{ created: number; failed: string[] }>;
}) {
  const [agentId, setAgentId] = useState<string>(agents[0]?.id ?? '');
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
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ created: number; failed: string[] } | null>(null);

  const DOW_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

  // 预览：匹配的班次 + 将生成的计划记录
  const preview = useMemo(() => {
    const fromMs = new Date(`${fromDate}T00:00:00`).getTime();
    const toMs = new Date(`${toDate}T23:59:59`).getTime();

    const matchedSchedules: Array<{ flight: AdminFlight; schedule: AdminSchedule }> = [];
    for (const f of flights) {
      if (!flightIds.has(f.id)) continue;
      for (const s of allSchedules[f.id] ?? []) {
        const t = new Date(s.departureTime).getTime();
        if (t < fromMs || t > toMs) continue;
        const dow = new Date(s.departureTime).getDay();
        if (!dowSet.has(dow)) continue;
        matchedSchedules.push({ flight: f, schedule: s });
      }
    }

    const cabins: CabinClass[] = cabinMode === 'BOTH' ? ['ECONOMY', 'BUSINESS'] : [cabinMode];
    const plan: BulkRecordPlan[] = [];
    for (const { flight, schedule } of matchedSchedules) {
      for (const c of cabins) {
        const seats = (c === 'ECONOMY' ? econSeats : bizSeats) ?? 0;
        if (seats <= 0) continue;
        // 该班次该舱位存在才排入计划
        if (!schedule.seatClasses.some((sc) => sc.cabin === c)) continue;
        plan.push({
          label: `${flight.flightNumber} ${formatLocalDate(schedule.departureTime, schedule.departureTz)} ${CABIN_LABEL[c] ?? c}`,
          body: {
            flightScheduleId: schedule.id,
            cabin: c,
            agentId,
            seats,
            reclaimDaysBefore: releaseDays,
          },
        });
      }
    }
    return { matchedSchedules, plan };
  }, [flights, flightIds, fromDate, toDate, dowSet, cabinMode, econSeats, bizSeats, releaseDays, agentId, allSchedules]);

  const valid =
    preview.plan.length > 0 && !!agentId && new Date(fromDate) <= new Date(toDate);

  const apply = async () => {
    if (!valid) return;
    setSubmitting(true);
    try {
      const r = await onApply(preview.plan);
      setResult(r);
    } finally {
      setSubmitting(false);
    }
  };

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
            <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.length === 0 && <option value="">（无可用代理）</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {agentLabel(a)}
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
            <label className="label">回收时机（切位条件）</label>
            <select
              className="input"
              value={releaseDays}
              onChange={(e) => setReleaseDays(Number(e.target.value))}
            >
              {RECLAIM_DAYS_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  出发前 {d} 天回收
                </option>
              ))}
            </select>
          </div>

          {/* 预览 */}
          <div className="rounded-md bg-purple-50 border border-purple-200 px-4 py-3 text-sm">
            <div className="font-medium text-purple-900">预览</div>
            <div className="mt-1 text-purple-800">
              将匹配 <strong>{preview.matchedSchedules.length}</strong> 个班次，创建{' '}
              <strong>{preview.plan.length}</strong> 条切位记录
            </div>
            {preview.matchedSchedules.length > 0 && (
              <div className="mt-1 text-xs text-purple-700">
                首班：
                {formatLocalDate(
                  preview.matchedSchedules[0].schedule.departureTime,
                  preview.matchedSchedules[0].schedule.departureTz,
                )}{' '}
                · 末班：
                {formatLocalDate(
                  preview.matchedSchedules[preview.matchedSchedules.length - 1].schedule.departureTime,
                  preview.matchedSchedules[preview.matchedSchedules.length - 1].schedule.departureTz,
                )}
              </div>
            )}
            {preview.plan.length === 0 && (
              <div className="mt-1 text-xs text-amber-700">⚠️ 当前条件没有匹配到任何班次/舱位</div>
            )}
          </div>

          {/* 结果 */}
          {result && (
            <div className="rounded-md border border-slate-200 px-4 py-3 text-sm">
              <div className="font-medium text-slate-900">
                成功创建 {result.created} 条{result.failed.length > 0 ? `，失败 ${result.failed.length} 条` : ''}
              </div>
              {result.failed.length > 0 && (
                <ul className="mt-1 max-h-32 overflow-auto text-xs text-rose-700 space-y-0.5">
                  {result.failed.slice(0, 20).map((f, i) => (
                    <li key={i}>· {f}</li>
                  ))}
                  {result.failed.length > 20 && <li>· …其余 {result.failed.length - 20} 条</li>}
                </ul>
              )}
            </div>
          )}

          {/* 按钮 */}
          <div className="flex justify-end gap-3 pt-2 border-t border-slate-200">
            <button className="btn-secondary" onClick={onCancel} disabled={submitting}>
              {result ? '关闭' : '取消'}
            </button>
            {!result && (
              <button className="btn-primary" disabled={!valid || submitting} onClick={apply}>
                {submitting ? '提交中…' : `应用到 ${preview.plan.length} 条记录`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
