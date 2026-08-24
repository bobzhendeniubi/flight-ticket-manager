/**
 * 占位单管理 — 占位单是无乘客名单的库存实体。
 *
 * 后端统一保证：可售余量 = capacity − sold − 未过期 ACTIVE 锁位 − 占位余座。
 * 本页覆盖占位单库存、收款计划、挂账认款与减员清算，不创建乘客名单。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type AdminFlight,
  type AdminSchedule,
  type AgentListItem,
  type CabinClass,
  type HoldOrderListItem,
  type HoldOrderStatus,
  type HoldOwnerType,
  type HoldOrderConfig,
  type HoldInstallment,
  type HoldReductionPreview,
  type Receipt,
} from '../lib/api';
import { CABIN_LABEL, formatLocalDate, formatLocalTime } from '../lib/airports';
import { useAuth } from '../stores/auth';

const CABINS: CabinClass[] = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'];
const STATUS_LABEL: Record<HoldOrderStatus, string> = {
  PENDING: '待生效',
  HOLDING: '占座中',
  OVERDUE: '逾期占座',
  FULLY_PAID: '已全款',
  CONVERTED: '已转正',
  RELEASED: '已释放',
  CANCELLED: '已取消',
};
const STATUS_BADGE: Record<HoldOrderStatus, string> = {
  PENDING: 'badge-neutral',
  HOLDING: 'badge-success',
  OVERDUE: 'badge-warning',
  FULLY_PAID: 'badge-info',
  CONVERTED: 'badge-info',
  RELEASED: 'badge-neutral',
  CANCELLED: 'badge-danger',
};

function localDateOf(iso: string, tz: string): string {
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

async function fetchScheduleMap(
  accessToken: string,
  flightList: AdminFlight[],
): Promise<Record<string, AdminSchedule[]>> {
  const map: Record<string, AdminSchedule[]> = {};
  const now = Date.now();
  const horizon = now + 60 * 86400000;
  await Promise.all(
    flightList.map(async (flight) => {
      const result = await api.listSchedules(accessToken, flight.id);
      map[flight.id] = result.schedules.filter((s) => {
        const time = new Date(s.departureTime).getTime();
        return time >= now && time <= horizon;
      });
    }),
  );
  return map;
}

function agentLabel(agent: Pick<AgentListItem, 'companyName' | 'contactName' | 'tier'>): string {
  return `[${agent.tier} 级] ${agent.companyName?.trim() || agent.contactName}`;
}

function ownerLabel(order: HoldOrderListItem): string {
  if (order.ownerType === 'AGENT') {
    return order.agent?.companyName?.trim() || order.agent?.contactName || '代理';
  }
  return order.groupName || '直客';
}

export function HoldOrdersPage() {
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [allSchedules, setAllSchedules] = useState<Record<string, AdminSchedule[]>>({});
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedFlightId, setSelectedFlightId] = useState('');
  const [selectedScheduleId, setSelectedScheduleId] = useState('');
  const [orders, setOrders] = useState<HoldOrderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [priceOrder, setPriceOrder] = useState<HoldOrderListItem | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reduceOrder, setReduceOrder] = useState<HoldOrderListItem | null>(null);
  const [allocateTarget, setAllocateTarget] = useState<{ order: HoldOrderListItem; installment: HoldInstallment } | null>(null);
  const [holdConfig, setHoldConfig] = useState<HoldOrderConfig | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const notify = useCallback((message: string) => {
    setFlash(message);
    window.setTimeout(() => setFlash(null), 3500);
  }, []);

  useEffect(() => {
    if (!tokens) return;
    (async () => {
      try {
        const [flightResult, agentResult] = await Promise.all([
          api.listAllFlights(tokens.accessToken),
          api.listAgents(tokens.accessToken),
        ]);
        setFlights(flightResult.flights);
        setAgents(agentResult.agents.filter((a) => a.isActive));
        if (user?.role === 'ADMIN' || user?.role === 'STAFF') {
          try { setHoldConfig((await api.getHoldOrderConfig(tokens.accessToken)).config); } catch { /* 配置入口仍可稍后重试 */ }
        }
        const map = await fetchScheduleMap(tokens.accessToken, flightResult.flights);
        setAllSchedules(map);
        const first = flightResult.flights
          .flatMap((flight) => (map[flight.id] ?? []).map((schedule) => ({ flight, schedule })))
          .sort((a, b) => a.schedule.departureTime.localeCompare(b.schedule.departureTime))[0];
        if (first) {
          setSelectedFlightId(first.flight.id);
          setSelectedDate(localDateOf(first.schedule.departureTime, first.schedule.departureTz));
          setSelectedScheduleId(first.schedule.id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载航班/代理失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [tokens, user]);

  const dateOptions = useMemo(() => {
    const dates = new Set<string>();
    Object.values(allSchedules).forEach((schedules) => {
      schedules.forEach((s) => dates.add(localDateOf(s.departureTime, s.departureTz)));
    });
    return [...dates].sort();
  }, [allSchedules]);

  const flightOptions = useMemo(
    () => flights.filter((f) => (allSchedules[f.id] ?? []).some((s) => localDateOf(s.departureTime, s.departureTz) === selectedDate)),
    [flights, allSchedules, selectedDate],
  );

  // 日期切换后旧航班可能不在新日期的选项中；同步切到该日期的第一班，避免页面停在空数据状态。
  useEffect(() => {
    if (flightOptions.length > 0 && !flightOptions.some((flight) => flight.id === selectedFlightId)) {
      setSelectedFlightId(flightOptions[0].id);
    }
  }, [flightOptions, selectedFlightId]);

  const daySchedules = useMemo(
    () => (allSchedules[selectedFlightId] ?? [])
      .filter((s) => localDateOf(s.departureTime, s.departureTz) === selectedDate)
      .sort((a, b) => a.departureTime.localeCompare(b.departureTime)),
    [allSchedules, selectedFlightId, selectedDate],
  );

  useEffect(() => {
    if (daySchedules.length > 0 && !daySchedules.some((s) => s.id === selectedScheduleId)) {
      setSelectedScheduleId(daySchedules[0].id);
    }
  }, [daySchedules, selectedScheduleId]);

  const selectedSchedule = daySchedules.find((s) => s.id === selectedScheduleId);
  const selectedFlight = flights.find((f) => f.id === selectedFlightId);

  const reloadSchedules = useCallback(async () => {
    if (!tokens || flights.length === 0) return;
    setAllSchedules(await fetchScheduleMap(tokens.accessToken, flights));
  }, [tokens, flights]);

  const reload = useCallback(async () => {
    if (!tokens || !selectedScheduleId) {
      setOrders([]);
      return;
    }
    setListLoading(true);
    try {
      const result = await api.listHoldOrders(tokens.accessToken, { flightScheduleId: selectedScheduleId });
      setOrders(result.holdOrders);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载占位单失败');
    } finally {
      setListLoading(false);
    }
  }, [tokens, selectedScheduleId]);

  useEffect(() => { void reload(); }, [reload]);

  const cabinRows = useMemo(() => selectedSchedule?.seatClasses ?? [], [selectedSchedule]);

  const runAction = async (order: HoldOrderListItem, action: 'release' | 'cancel') => {
    if (!tokens || !window.confirm(`确认${action === 'release' ? '释放' : '取消'}占位单 ${order.holdNo}？座位将回到公共库存。`)) return;
    setBusy(true);
    try {
      if (action === 'release') await api.releaseHoldOrder(tokens.accessToken, order.id);
      else await api.cancelHoldOrder(tokens.accessToken, order.id);
      await Promise.all([reload(), reloadSchedules()]);
      notify(action === 'release' ? '占位单已释放，座位已回池' : '占位单已取消，座位已回池');
    } catch (err) {
      notify(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const retryOccupy = async (order: HoldOrderListItem) => {
    if (!tokens) return;
    setBusy(true);
    try {
      await api.retryHoldOccupy(tokens.accessToken, order.id);
      await Promise.all([reload(), reloadSchedules()]);
      notify('占位单已成功转入占座');
    } catch (err) {
      notify(err instanceof Error ? err.message : '重试占座失败');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="card text-ink-muted">加载中…</div>;
  if (error) return <div className="card border-rose-200 bg-rose-50 text-rose-700">{error}</div>;
  if (flights.length === 0) return <div className="card text-ink-muted">没有可用的班次</div>;

  return (
    <div className="space-y-5">
      <section>
        <div className="flex items-center justify-between gap-3"><h1 className="page-title">占位单管理</h1>{user?.role === 'ADMIN' && <button className="btn-secondary text-sm" disabled={!holdConfig} onClick={() => setShowConfig(true)}>收款模板设置</button>}</div>
        <p className="page-sub">为旅游团、代理或直客临时锁定无名单库存；释放或取消后座位回到公共库存。</p>
      </section>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
          <div>
            <label className="label">出发日期</label>
            <select className="input" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)}>
              {dateOptions.map((date) => <option key={date} value={date}>{date}</option>)}
            </select>
          </div>
          <div>
            <label className="label">航班号</label>
            <select className="input" value={selectedFlightId} onChange={(e) => setSelectedFlightId(e.target.value)}>
              {flightOptions.map((flight) => <option key={flight.id} value={flight.id}>{flight.flightNumber} · {flight.originCode} → {flight.destinationCode}</option>)}
            </select>
          </div>
          <div>
            <label className="label">班次时刻</label>
            <select className="input" value={selectedScheduleId} onChange={(e) => setSelectedScheduleId(e.target.value)}>
              {daySchedules.map((schedule) => <option key={schedule.id} value={schedule.id}>{formatLocalTime(schedule.departureTime, schedule.departureTz)} 出发</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button className="btn-primary text-sm" onClick={() => setShowForm(true)} disabled={!selectedSchedule}>+ 新建占位单</button>
          </div>
        </div>
      </section>

      {selectedSchedule && (
        <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {cabinRows.map((cabin) => (
            <div key={cabin.id} className="card">
              <h3 className="font-semibold">{CABIN_LABEL[cabin.cabin] ?? cabin.cabin}</h3>
              <p className="mt-1 text-sm text-ink-soft">可售余量 <strong>{cabin.available}</strong> 座</p>
              <p className="mt-1 text-xs text-ink-muted">已售 {cabin.sold} · 锁位 {cabin.locked} · 占位 {cabin.held}</p>
            </div>
          ))}
        </section>
      )}

      <section className="card p-0 overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-3">
          <h3 className="font-semibold">{selectedFlight?.flightNumber} · {selectedSchedule ? `${formatLocalDate(selectedSchedule.departureTime, selectedSchedule.departureTz)} ${formatLocalTime(selectedSchedule.departureTime, selectedSchedule.departureTz)}` : ''} 占位单</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead><tr><th className="text-left">单号</th><th className="text-left">归属</th><th className="text-left">舱位</th><th className="text-right">占位数</th><th className="text-right">锁价</th><th className="text-left">状态</th><th className="text-left">建单时间</th><th></th></tr></thead>
            <tbody>
              {listLoading && <tr><td colSpan={8} className="py-5 text-center text-ink-muted">加载占位单中…</td></tr>}
              {!listLoading && orders.length === 0 && <tr><td colSpan={8} className="py-5 text-center text-ink-muted">该班次暂无占位单</td></tr>}
              {orders.map((order) => {
                const holding = order.status === 'HOLDING' || order.status === 'OVERDUE' || order.status === 'FULLY_PAID';
                const canRelease = order.status === 'PENDING' || holding;
                const canCancel = order.status === 'PENDING' || holding;
                const canReduce = order.status === 'PENDING' || holding;
                const waitingOccupy = order.status === 'PENDING' && order.occupyOn === 'FULL_PAYMENT' && order.installments.length > 0 && order.installments.every((item) => item.amountCny === 0 || item.allocations.filter((allocation) => !allocation.reversedAt).reduce((sum, allocation) => sum + Number(allocation.amountCny), 0) >= item.amountCny);
                return (
                  <Fragment key={order.id}>
                  <tr className={order.status === 'OVERDUE' ? 'bg-rose-50' : undefined}>
                    <td className="font-mono text-xs">{order.holdNo}</td>
                    <td><div className="font-medium">{ownerLabel(order)}</div><div className="text-xs text-ink-muted">{order.ownerType === 'AGENT' ? '代理' : '直客'}</div></td>
                    <td><span className="badge-neutral">{CABIN_LABEL[order.seatClass.cabin] ?? order.seatClass.cabin}</span></td>
                    <td className="text-right nums">{order.seats - order.seatsConverted - order.seatsCancelled}/{order.seats}</td>
                    <td className="text-right nums">¥{order.perSeatPriceCny}/人</td>
                    <td><button type="button" className={STATUS_BADGE[order.status]} onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}>{STATUS_LABEL[order.status]} · 期表</button>{waitingOccupy && <div className="mt-1 text-xs font-semibold text-amber-700">已收全款，待占座</div>}</td>
                    <td className="text-xs text-ink-muted">{new Date(order.createdAt).toLocaleString('zh-CN')}</td>
                    <td className="whitespace-nowrap text-right">
                      <button className="mr-2 text-xs font-medium text-brand-700 disabled:text-ink-muted" disabled={!holding || busy} onClick={() => setPriceOrder(order)}>改价</button>
                      <button className="mr-2 text-xs font-medium text-amber-700 disabled:text-ink-muted" disabled={!canRelease || busy} onClick={() => void runAction(order, 'release')}>释放</button>
                      <button className="mr-2 text-xs font-medium text-brand-700 disabled:text-ink-muted" disabled={!canReduce || busy} onClick={() => setReduceOrder(order)}>减员</button>
                      {waitingOccupy && <button className="mr-2 text-xs font-semibold text-amber-700 disabled:text-ink-muted" disabled={busy} onClick={() => void retryOccupy(order)}>重试占座</button>}
                      <button className="text-xs font-medium text-rose-600 disabled:text-ink-muted" disabled={!canCancel || busy} onClick={() => void runAction(order, 'cancel')}>取消</button>
                    </td>
                  </tr>
                  {expandedId === order.id && (
                    <tr className={order.status === 'OVERDUE' ? 'bg-rose-50/70' : 'bg-slate-50/70'}>
                      <td colSpan={8} className="px-5 py-3">
                        <InstallmentTable order={order} onAllocate={(installment) => setAllocateTarget({ order, installment })} onReload={reload} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {flash && <div className="border-t border-slate-200 bg-green-50 px-5 py-2 text-sm text-green-700">{flash}</div>}
      </section>

      {showForm && selectedSchedule && (
        <CreateHoldModal
          schedule={selectedSchedule}
          agents={agents}
          onCancel={() => setShowForm(false)}
          onSubmit={async (body) => {
            if (!tokens) return;
            setBusy(true);
            try {
              await api.createHoldOrder(tokens.accessToken, { ...body, flightScheduleId: selectedSchedule.id });
              setShowForm(false);
              await Promise.all([reload(), reloadSchedules()]);
              notify(body.mode === 'ALLOTMENT' ? '切位占位单已创建，付款前不占公共座位' : '占位单已创建，座位已计入占用');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {priceOrder && (
        <PriceModal
          order={priceOrder}
          onCancel={() => setPriceOrder(null)}
          onSubmit={async (price, reason) => {
            if (!tokens) return;
            setBusy(true);
            try {
              await api.updateHoldOrderPrice(tokens.accessToken, priceOrder.id, { perSeatPriceCny: price, reason });
              setPriceOrder(null);
              await Promise.all([reload(), reloadSchedules()]);
              notify('锁定结算价已更新，变更已留痕');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {reduceOrder && tokens && (
        <ReduceModal order={reduceOrder} token={tokens.accessToken} onCancel={() => setReduceOrder(null)} onDone={async () => { setReduceOrder(null); await Promise.all([reload(), reloadSchedules()]); notify('减员清算已完成，座位已回池'); }} />
      )}
      {allocateTarget && tokens && (
        <AllocateModal order={allocateTarget.order} installment={allocateTarget.installment} token={tokens.accessToken} onCancel={() => setAllocateTarget(null)} onDone={async (warning) => { setAllocateTarget(null); await reload(); notify(warning ?? '认款已记录'); }} />
      )}
      {showConfig && holdConfig && tokens && (
        <ConfigModal config={holdConfig} token={tokens.accessToken} onCancel={() => setShowConfig(false)} onDone={(config) => { setHoldConfig(config); setShowConfig(false); notify('收款模板已保存'); }} />
      )}
    </div>
  );
}

function CreateHoldModal({
  schedule,
  agents,
  onCancel,
  onSubmit,
}: {
  schedule: AdminSchedule;
  agents: AgentListItem[];
  onCancel: () => void;
  onSubmit: (body: { cabin: CabinClass; seats: number; perSeatPriceCny: number; ownerType: HoldOwnerType; mode: 'RESERVE' | 'ALLOTMENT'; installmentsOverride?: Array<{ label: string; perPersonCny?: number; dueDate: string }>; agentId?: string; groupName?: string; freeCancelRatio?: number; notes?: string }) => Promise<void>;
}) {
  const tokens = useAuth((s) => s.tokens);
  const [cabin, setCabin] = useState<CabinClass>(schedule.seatClasses[0]?.cabin ?? 'ECONOMY');
  const [seats, setSeats] = useState(1);
  const [price, setPrice] = useState(0);
  const [mode, setMode] = useState<'RESERVE' | 'ALLOTMENT'>('RESERVE');
  const [ownerType, setOwnerType] = useState<HoldOwnerType>('AGENT');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [groupName, setGroupName] = useState('');
  const [ratio, setRatio] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [planRows, setPlanRows] = useState<Array<{ seq: number; label: string; amountRule: 'PER_PERSON_FIXED' | 'REMAINDER'; perPersonCny: number | null; amountCny: number; dueDate: string }>>([]);
  const [planLoading, setPlanLoading] = useState(false);
  const seat = schedule.seatClasses.find((c) => c.cabin === cabin);
  const max = Math.max(0, seat?.available ?? 0);
  const [dueDates, setDueDates] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!tokens || seats < 1 || price < 0) return;
    let cancelled = false;
    setPlanLoading(true);
    setFormError(null);
    api.previewHoldPlan(tokens.accessToken, { flightScheduleId: schedule.id, cabin, seats, perSeatPriceCny: price, mode })
      .then((result) => { if (!cancelled) { setPlanRows(result.plan.installments); setDueDates({}); } })
      .catch((err) => { if (!cancelled) { setPlanRows([]); setFormError(err instanceof Error ? err.message : '收款计划预览失败'); } })
      .finally(() => { if (!cancelled) setPlanLoading(false); });
    return () => { cancelled = true; };
  }, [tokens, schedule.id, cabin, seats, price, mode]);
  const visibleRows = planRows.map((row) => ({ ...row, key: String(row.seq), dueDate: dueDates[String(row.seq)] ?? row.dueDate }));
  const valid = seats >= 1 && (mode === 'ALLOTMENT' || seats <= max) && price >= 0 && !planLoading && planRows.length > 0 && planRows.every((row) => row.amountCny >= 0) && (ownerType === 'AGENT' ? !!agentId : !!groupName.trim()) && (ratio === '' || (ratio >= 0 && ratio <= 50));

  const submit = async () => {
    if (!valid) return;
    setFormError(null);
    try {
      await onSubmit({
        cabin,
        seats,
        perSeatPriceCny: price,
        ownerType,
        mode,
        ...(mode === 'RESERVE' && Object.keys(dueDates).length > 0 ? { installmentsOverride: visibleRows.map((row) => row.perPersonCny != null ? ({ label: row.label, perPersonCny: row.perPersonCny, dueDate: row.dueDate }) : ({ label: row.label, dueDate: row.dueDate })) } : {}),
        ...(ownerType === 'AGENT' ? { agentId } : { groupName: groupName.trim() }),
        ...(ratio !== '' ? { freeCancelRatio: ratio / 100 } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '创建失败');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}>
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">新建占位单</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div>
        <div className="space-y-4 px-5 py-4">
          <div className="rounded bg-slate-50 px-3 py-2 text-xs text-ink-muted">班次：{formatLocalDate(schedule.departureTime, schedule.departureTz)} {formatLocalTime(schedule.departureTime, schedule.departureTz)}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label">舱位</label><select className="input" value={cabin} onChange={(e) => setCabin(e.target.value as CabinClass)}>{CABINS.filter((c) => schedule.seatClasses.some((s) => s.cabin === c)).map((c) => <option key={c} value={c}>{CABIN_LABEL[c] ?? c}</option>)}</select><p className="mt-1 text-xs text-ink-muted">当前可售余量 {max} 座</p></div>
            <div><label className="label">占位座位数</label><input className="input" type="number" min={1} max={600} value={seats} onChange={(e) => setSeats(Number(e.target.value))} /></div>
            <div><label className="label">锁定结算价（元/人）</label><input className="input" type="number" min={0} value={price} onChange={(e) => setPrice(Number(e.target.value))} /></div>
            <div><label className="label">归属</label><select className="input" value={ownerType} onChange={(e) => setOwnerType(e.target.value as HoldOwnerType)}><option value="AGENT">代理</option><option value="CUSTOMER">直客</option></select></div>
            <div><label className="label">占位模式</label><select className="input" value={mode} onChange={(e) => setMode(e.target.value as 'RESERVE' | 'ALLOTMENT')}><option value="RESERVE">留位（建单即占座）</option><option value="ALLOTMENT">切位（全款才占座）</option></select></div>
          </div>
          {ownerType === 'AGENT' ? <div><label className="label">代理</label><select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>{agents.length === 0 && <option value="">暂无可用代理</option>}{agents.map((a) => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}</select></div> : <div><label className="label">团名 / 客户备注名</label><input className="input" maxLength={120} value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="例如：春季团队" /></div>}
          <div className="grid gap-3 sm:grid-cols-2"><div><label className="label">免损比例（%，选填）</label><input className="input" type="number" min={0} max={50} step={1} value={ratio} onChange={(e) => setRatio(e.target.value === '' ? '' : Number(e.target.value))} /></div><div><label className="label">备注（选填）</label><input className="input" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></div></div>
          <div><p className="label">收款计划预览（服务端计算，截止日可手调）</p>{planLoading ? <p className="rounded bg-slate-50 px-3 py-2 text-sm text-ink-muted">计算收款计划…</p> : <div className="overflow-x-auto rounded border border-slate-200"><table className="w-full text-xs"><thead><tr className="bg-slate-50"><th className="px-2 py-1 text-left">期</th><th className="px-2 py-1 text-right">应收</th><th className="px-2 py-1 text-left">截止</th></tr></thead><tbody>{visibleRows.map((row) => <tr key={row.key}><td className="px-2 py-1">{row.label}</td><td className="px-2 py-1 text-right">¥{row.amountCny.toLocaleString()}</td><td className="px-2 py-1"><input className="input h-7 py-0 text-xs" type="date" value={row.dueDate} onChange={(e) => setDueDates((old) => ({ ...old, [row.key]: e.target.value }))} /></td></tr>)}</tbody></table></div>}</div>
          {mode === 'RESERVE' && seats > max && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">占位数不能超过当前可售余量 {max} 座</p>}
          {formError && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{formError}</p>}
          <div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" disabled={!valid} onClick={() => void submit()}>确认建单</button></div>
        </div>
      </div>
    </div>
  );
}

function InstallmentTable({ order, onAllocate, onReload }: { order: HoldOrderListItem; onAllocate: (installment: HoldInstallment) => void; onReload: () => Promise<void> }) {
  const tokens = useAuth((s) => s.tokens);
  const [busyId, setBusyId] = useState<string | null>(null);
  const rows = order.installments ?? [];
  const activeAmount = (row: HoldInstallment) => row.allocations.filter((a) => !a.reversedAt).reduce((sum, a) => sum + Number(a.amountCny), 0);
  const reverse = async (row: HoldInstallment, allocationId: string) => {
    if (!tokens) return;
    const reason = window.prompt('请输入撤销认款原因（必填）', '认款挂接错误');
    if (!reason?.trim()) return;
    setBusyId(allocationId);
    try { await api.reverseHoldInstallmentAllocation(tokens.accessToken, order.id, row.id, allocationId, reason.trim()); await onReload(); } catch (err) { window.alert(err instanceof Error ? err.message : '撤销认款失败'); } finally { setBusyId(null); }
  };
  const changeDueDate = async (row: HoldInstallment) => {
    if (!tokens || row.status === 'PAID') return;
    const dueDate = window.prompt('请输入新的截止日（YYYY-MM-DD）', row.dueDate.slice(0, 10));
    if (!dueDate) return;
    setBusyId(row.id);
    try { await api.updateHoldInstallmentDueDate(tokens.accessToken, order.id, row.id, dueDate); await onReload(); } catch (err) { window.alert(err instanceof Error ? err.message : '调整截止日失败'); } finally { setBusyId(null); }
  };
  return (
    <div>
      <div className="mb-2 text-xs font-semibold text-ink-soft">收款计划</div>
      <table className="w-full text-xs"><thead><tr className="text-ink-muted"><th className="text-left">期号</th><th className="text-left">期名</th><th className="text-right">应收</th><th className="text-right">已认</th><th className="text-left">截止</th><th className="text-left">状态</th><th></th></tr></thead><tbody>
        {rows.map((row) => <Fragment key={row.id}><tr className="border-t border-slate-200"><td>{row.seq}</td><td>{row.label}</td><td className="text-right">¥{row.amountCny.toLocaleString()}</td><td className="text-right">¥{activeAmount(row).toLocaleString()}</td><td>{row.dueDate.slice(0, 10)}</td><td><span className={row.status === 'PAID' ? 'badge-success' : 'badge-neutral'}>{row.status === 'PAID' ? '已认满' : '待认款'}</span></td><td className="text-right"><button className="mr-2 text-brand-700 disabled:text-ink-muted" disabled={row.status === 'PAID'} onClick={() => onAllocate(row)}>认款</button><button className="text-amber-700 disabled:text-ink-muted" disabled={row.status === 'PAID' || busyId === row.id} onClick={() => void changeDueDate(row)}>调期</button></td></tr>
          {row.allocations.filter((a) => !a.reversedAt).map((allocation) => <tr key={allocation.id} className="text-[11px] text-ink-muted"><td></td><td colSpan={4}>挂账认款 ¥{Number(allocation.amountCny).toLocaleString()}</td><td colSpan={2} className="text-right"><button className="text-rose-600" disabled={busyId === allocation.id} onClick={() => void reverse(row, allocation.id)}>撤销</button></td></tr>)}
        </Fragment>)}
      </tbody></table>
    </div>
  );
}

function AllocateModal({ order, installment, token, onCancel, onDone }: { order: HoldOrderListItem; installment: HoldInstallment; token: string; onCancel: () => void; onDone: (warning: string | null) => Promise<void> }) {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptId, setReceiptId] = useState('');
  const [amount, setAmount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const already = installment.allocations.filter((a) => !a.reversedAt).reduce((sum, a) => sum + Number(a.amountCny), 0);
  const due = Math.max(0, installment.amountCny - already);
  useEffect(() => {
    api.listReceipts(token, { unallocatedOnly: '1' }).then((res) => { setReceipts(res.receipts.filter((r) => Number(r.remainingCny) > 0)); setLoading(false); }).catch((err) => { setError(err instanceof Error ? err.message : '加载挂账池失败'); setLoading(false); });
  }, [token]);
  useEffect(() => {
    const selected = receipts.find((r) => r.id === receiptId);
    if (selected) setAmount(Math.min(due, Number(selected.remainingCny)));
  }, [receiptId, receipts, due]);
  const submit = async () => {
    if (!receiptId || amount < 1 || amount > due) { setError(`请输入不超过本期未认余额 ¥${due.toLocaleString()} 的金额`); return; }
    try { const result = await api.allocateHoldInstallment(token, order.id, installment.id, { receiptId, amountCny: amount }); await onDone(result.result.warning); } catch (err) { setError(err instanceof Error ? err.message : '认款失败'); }
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}><div className="w-full max-w-lg rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}><div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">认款 · {order.holdNo} · {installment.label}</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div><div className="space-y-4 px-5 py-4"><p className="text-sm text-ink-muted">本期应收 ¥{installment.amountCny.toLocaleString()}，未认 ¥{due.toLocaleString()}</p>{loading ? <p className="text-sm text-ink-muted">加载挂账池…</p> : <select className="input" value={receiptId} onChange={(e) => setReceiptId(e.target.value)}><option value="">选择 OPEN/部分认款流水</option>{receipts.map((r) => <option key={r.id} value={r.id}>{r.receiptNo} · 余额 ¥{Number(r.remainingCny).toLocaleString()} · {new Date(r.receivedAt).toLocaleString('zh-CN')}</option>)}</select>}<input className="input" type="number" min={1} max={due} value={amount || ''} onChange={(e) => setAmount(Number(e.target.value))} placeholder="认款金额（元）" />{error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}<div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" disabled={loading || !receiptId} onClick={() => void submit()}>确认认款</button></div></div></div></div>;
}

function ReduceModal({ order, token, onCancel, onDone }: { order: HoldOrderListItem; token: string; onCancel: () => void; onDone: () => Promise<void> }) {
  const available = order.seats - order.seatsConverted - order.seatsCancelled;
  const [seats, setSeats] = useState(1);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<HoldReductionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadPreview = async () => { setBusy(true); setError(null); try { setPreview((await api.previewHoldReduction(token, order.id, { seats, note: note.trim() || undefined })).preview); } catch (err) { setError(err instanceof Error ? err.message : '试算失败'); } finally { setBusy(false); } };
  const confirm = async () => { if (!preview) return; setBusy(true); try { await api.reduceHoldSeats(token, order.id, { seats, note: note.trim() || undefined }); await onDone(); } catch (err) { setError(err instanceof Error ? err.message : '减员失败'); } finally { setBusy(false); } };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}><div className="w-full max-w-md rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}><div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">减员清算 · {order.holdNo}</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div><div className="space-y-4 px-5 py-4"><p className="text-sm text-ink-muted">当前占位余座 {available}，尾款确认后免损额度作废。</p><input className="input" type="number" min={1} max={available} value={seats} onChange={(e) => { setSeats(Number(e.target.value)); setPreview(null); }} /><textarea className="input min-h-20" value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（选填）" />{preview && <div className="rounded bg-slate-50 p-3 text-sm"><div>免损 {preview.freeSeats} 座 · 扣损 {preview.forfeitSeats} 座</div><div>没收 ¥{preview.forfeitCny.toLocaleString()} · 转抵 ¥{preview.creditCny.toLocaleString()} · 挂账 ¥{preview.surplusCny.toLocaleString()}</div></div>}{error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}<div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button>{preview ? <button className="btn-primary" disabled={busy} onClick={() => void confirm()}>确认执行</button> : <button className="btn-primary" disabled={busy || seats < 1 || seats > available} onClick={() => void loadPreview()}>试算清算</button>}</div></div></div></div>;
}

function ConfigModal({ config, token, onCancel, onDone }: { config: HoldOrderConfig; token: string; onCancel: () => void; onDone: (config: HoldOrderConfig) => void }) {
  const [rows, setRows] = useState(config.installments);
  const [action, setAction] = useState(config.overdueAction);
  const [ratio, setRatio] = useState(config.defaultFreeCancelRatio * 100);
  const [error, setError] = useState<string | null>(null);
  const save = async () => { if (rows.length < 1 || rows.length > 6 || rows.filter((r) => r.amountRule === 'REMAINDER').length !== 1 || rows[rows.length - 1].amountRule !== 'REMAINDER' || ratio < 0 || ratio > 50) { setError('模板需 1-6 期，尾款恰好一期且在最后，免损比例 0-50%'); return; } try { const result = await api.updateHoldOrderConfig(token, { installments: rows, overdueAction: action, defaultFreeCancelRatio: ratio / 100 }); onDone(result.config); } catch (err) { setError(err instanceof Error ? err.message : '保存模板失败'); } };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}><div className="w-full max-w-2xl rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}><div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">收款模板设置</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div><div className="space-y-3 px-5 py-4"><div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr><th className="text-left">名称</th><th className="text-left">金额规则</th><th>每人金额</th><th>起飞前天数</th><th></th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><td><input className="input h-8" value={row.label} onChange={(e) => setRows((old) => old.map((r, i) => i === index ? { ...r, label: e.target.value } : r))} /></td><td><select className="input h-8" value={row.amountRule} onChange={(e) => setRows((old) => old.map((r, i) => i === index ? { ...r, amountRule: e.target.value as 'PER_PERSON_FIXED' | 'REMAINDER', perPersonCny: e.target.value === 'REMAINDER' ? undefined : r.perPersonCny ?? 0 } : r))}><option value="PER_PERSON_FIXED">每人固定</option><option value="REMAINDER">尾款余款</option></select></td><td><input className="input h-8 w-24" type="number" disabled={row.amountRule === 'REMAINDER'} value={row.perPersonCny ?? ''} onChange={(e) => setRows((old) => old.map((r, i) => i === index ? { ...r, perPersonCny: Number(e.target.value) } : r))} /></td><td><input className="input h-8 w-24" type="number" min={0} value={row.dueOffsetDays ?? ''} onChange={(e) => setRows((old) => old.map((r, i) => i === index ? { ...r, dueOffsetDays: e.target.value === '' ? null : Number(e.target.value) } : r))} /></td><td><button className="text-rose-600" disabled={rows.length <= 1} onClick={() => setRows((old) => old.filter((_, i) => i !== index))}>删除</button></td></tr>)}</tbody></table></div><button className="btn-secondary text-xs" disabled={rows.length >= 6} onClick={() => setRows((old) => [...old, { label: '新收款期', amountRule: 'REMAINDER', dueOffsetDays: 0 }])}>+ 添加一期</button><div className="grid gap-3 sm:grid-cols-2"><div><label className="label">逾期动作</label><select className="input" value={action} onChange={(e) => setAction(e.target.value as 'REMIND_ONLY' | 'AUTO_RELEASE')}><option value="REMIND_ONLY">标记逾期并提醒</option><option value="AUTO_RELEASE">自动释放</option></select></div><div><label className="label">默认免损比例（%）</label><input className="input" type="number" min={0} max={50} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} /></div></div>{error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}<div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" onClick={() => void save()}>保存</button></div></div></div></div>;
}

function PriceModal({ order, onCancel, onSubmit }: { order: HoldOrderListItem; onCancel: () => void; onSubmit: (price: number, reason: string) => Promise<void> }) {
  const [price, setPrice] = useState(order.perSeatPriceCny);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (price < 0 || !reason.trim()) { setError('新价和改价原因均为必填'); return; }
    try { await onSubmit(price, reason.trim()); } catch (err) { setError(err instanceof Error ? err.message : '改价失败'); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">调整锁定结算价</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div>
        <div className="space-y-4 px-5 py-4"><p className="text-sm text-ink-muted">占位单 {order.holdNo} · 原价 ¥{order.perSeatPriceCny}/人</p><div><label className="label">新价（元/人）</label><input className="input" type="number" min={0} value={price} onChange={(e) => setPrice(Number(e.target.value))} /></div><div><label className="label">改价原因（必填）</label><textarea className="input min-h-24" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></div>{error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}<div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" onClick={() => void submit()}>保存改价</button></div></div>
      </div>
    </div>
  );
}
