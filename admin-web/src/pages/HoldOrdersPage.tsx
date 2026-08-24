/**
 * 占位单管理 — 占位单是无乘客名单的库存实体。
 *
 * 后端统一保证：可售余量 = capacity − sold − 未过期 ACTIVE 锁位 − 占位余座。
 * 本页只操作库存占用、释放/取消和锁定结算价，不创建收款计划或乘客名单。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type AdminFlight,
  type AdminSchedule,
  type AgentListItem,
  type CabinClass,
  type HoldOrderListItem,
  type HoldOrderStatus,
  type HoldOwnerType,
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
  }, [tokens]);

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

  if (loading) return <div className="card text-ink-muted">加载中…</div>;
  if (error) return <div className="card border-rose-200 bg-rose-50 text-rose-700">{error}</div>;
  if (flights.length === 0) return <div className="card text-ink-muted">没有可用的班次</div>;

  return (
    <div className="space-y-5">
      <section>
        <h1 className="page-title">占位单管理</h1>
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
                const holding = order.status === 'HOLDING';
                return (
                  <tr key={order.id}>
                    <td className="font-mono text-xs">{order.holdNo}</td>
                    <td><div className="font-medium">{ownerLabel(order)}</div><div className="text-xs text-ink-muted">{order.ownerType === 'AGENT' ? '代理' : '直客'}</div></td>
                    <td><span className="badge-neutral">{CABIN_LABEL[order.seatClass.cabin] ?? order.seatClass.cabin}</span></td>
                    <td className="text-right nums">{order.seats}</td>
                    <td className="text-right nums">¥{order.perSeatPriceCny}/人</td>
                    <td><span className={STATUS_BADGE[order.status]}>{STATUS_LABEL[order.status]}</span></td>
                    <td className="text-xs text-ink-muted">{new Date(order.createdAt).toLocaleString('zh-CN')}</td>
                    <td className="whitespace-nowrap text-right">
                      <button className="mr-2 text-xs font-medium text-brand-700 disabled:text-ink-muted" disabled={!holding || busy} onClick={() => setPriceOrder(order)}>改价</button>
                      <button className="mr-2 text-xs font-medium text-amber-700 disabled:text-ink-muted" disabled={!holding || busy} onClick={() => void runAction(order, 'release')}>释放</button>
                      <button className="text-xs font-medium text-rose-600 disabled:text-ink-muted" disabled={!holding || busy} onClick={() => void runAction(order, 'cancel')}>取消</button>
                    </td>
                  </tr>
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
              notify('占位单已创建，座位已计入占用');
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
  onSubmit: (body: { cabin: CabinClass; seats: number; perSeatPriceCny: number; ownerType: HoldOwnerType; agentId?: string; groupName?: string; freeCancelRatio?: number; notes?: string }) => Promise<void>;
}) {
  const [cabin, setCabin] = useState<CabinClass>(schedule.seatClasses[0]?.cabin ?? 'ECONOMY');
  const [seats, setSeats] = useState(1);
  const [price, setPrice] = useState(0);
  const [ownerType, setOwnerType] = useState<HoldOwnerType>('AGENT');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [groupName, setGroupName] = useState('');
  const [ratio, setRatio] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const seat = schedule.seatClasses.find((c) => c.cabin === cabin);
  const max = Math.max(0, seat?.available ?? 0);
  const valid = seats >= 1 && seats <= max && price >= 0 && (ownerType === 'AGENT' ? !!agentId : !!groupName.trim()) && (ratio === '' || (ratio >= 0 && ratio <= 50));

  const submit = async () => {
    if (!valid) return;
    setFormError(null);
    try {
      await onSubmit({
        cabin,
        seats,
        perSeatPriceCny: price,
        ownerType,
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
          </div>
          {ownerType === 'AGENT' ? <div><label className="label">代理</label><select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>{agents.length === 0 && <option value="">暂无可用代理</option>}{agents.map((a) => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}</select></div> : <div><label className="label">团名 / 客户备注名</label><input className="input" maxLength={120} value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="例如：春季团队" /></div>}
          <div className="grid gap-3 sm:grid-cols-2"><div><label className="label">免损比例（%，选填）</label><input className="input" type="number" min={0} max={50} step={1} value={ratio} onChange={(e) => setRatio(e.target.value === '' ? '' : Number(e.target.value))} /></div><div><label className="label">备注（选填）</label><input className="input" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></div></div>
          {seats > max && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">占位数不能超过当前可售余量 {max} 座</p>}
          {formError && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{formError}</p>}
          <div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" disabled={!valid} onClick={() => void submit()}>确认建单</button></div>
        </div>
      </div>
    </div>
  );
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
