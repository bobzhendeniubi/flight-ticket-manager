/**
 * 占位单管理 — 占位单是无乘客名单的库存实体。
 *
 * 后端统一保证：可售余量 = capacity − sold − 未过期 ACTIVE 锁位 − 占位余座。
 * 本页覆盖占位单库存、收款计划、挂账认款与减员清算，不创建乘客名单。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type HoldOrderFilter,
  type CreateHoldGroupInput,
  type HoldInstallment,
  type HoldReductionPreview,
  type HoldOrderSummary,
  type BatchOrderPassenger,
  type Receipt,
} from '../lib/api';
import { CABIN_LABEL, formatLocalDate, formatLocalTime } from '../lib/airports';
import { formatDateTimeSecCn } from '../lib/datetime';
import { useAuth } from '../stores/auth';
import { HOLD_STATUS_META, holdStatusBadgeClass, holdStatusLabel } from '../lib/orderStatus';
import { useDialogA11y } from '../components/Modal';
import { useConfirm } from '../components/ConfirmDialog';

const CABINS: CabinClass[] = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'];
/** 建单可选班次与默认筛选窗口都是「今天起 60 天」，与班次拉取的 horizon 一致。 */
const HOLD_HORIZON_DAYS = 60;

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

function KpiCard({ label, value, tone }: { label: string; value: string; tone: 'success' | 'warning' | 'info' | 'neutral' }) {
  const toneClass = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    neutral: 'border-slate-200 bg-white text-slate-800',
  }[tone];
  return <div className={`card border ${toneClass}`}><div className="text-xs text-ink-muted">{label}</div><div className="mt-1 text-xl font-semibold nums">{value}</div></div>;
}

function newConversionRequestToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

export function HoldOrdersPage() {
  const tokens = useAuth((s) => s.tokens);
  const askConfirm = useConfirm();
  const actionConfirmRef = useRef(false);
  const user = useAuth((s) => s.user);
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [allSchedules, setAllSchedules] = useState<Record<string, AdminSchedule[]>>({});
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  // 筛选器是「看哪些占位单」，不再兼任「建到哪一班」——建单目标一律在弹窗里选。
  const [dateFrom, setDateFrom] = useState(todayStr());
  const [dateTo, setDateTo] = useState(daysFromTodayStr(HOLD_HORIZON_DAYS));
  const [filterFlightId, setFilterFlightId] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [orders, setOrders] = useState<HoldOrderListItem[]>([]);
  const [summary, setSummary] = useState<HoldOrderSummary>({ occupiedOrderCount: 0, occupiedSeats: 0, overdueOrderCount: 0, fullyPaidPendingConversionCount: 0, receivedCny: 0 });
  const [statusFilter, setStatusFilter] = useState<'' | HoldOrderStatus>('');
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [priceOrder, setPriceOrder] = useState<HoldOrderListItem | null>(null);
  const [infoOrder, setInfoOrder] = useState<HoldOrderListItem | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reduceOrder, setReduceOrder] = useState<HoldOrderListItem | null>(null);
  const [allocateTarget, setAllocateTarget] = useState<{ order: HoldOrderListItem; installment: HoldInstallment } | null>(null);
  const [manualReceiptTarget, setManualReceiptTarget] = useState<{ order: HoldOrderListItem; installment: HoldInstallment } | null>(null);
  const [convertOrder, setConvertOrder] = useState<HoldOrderListItem | null>(null);
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
        setAllSchedules(await fetchScheduleMap(tokens.accessToken, flightResult.flights));
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载航班/代理失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [tokens, user]);

  // 筛到「某一天 + 某个航班」时，顺带把该班次各舱余量摊开——运营常常筛完就想看这一班还剩多少。
  const focusedSchedules = useMemo(() => {
    if (!filterFlightId || dateFrom !== dateTo) return [];
    return (allSchedules[filterFlightId] ?? [])
      .filter((s) => localDateOf(s.departureTime, s.departureTz) === dateFrom)
      .sort((a, b) => a.departureTime.localeCompare(b.departureTime));
  }, [allSchedules, filterFlightId, dateFrom, dateTo]);

  const reloadSchedules = useCallback(async () => {
    if (!tokens || flights.length === 0) return;
    setAllSchedules(await fetchScheduleMap(tokens.accessToken, flights));
  }, [tokens, flights]);

  const reload = useCallback(async () => {
    if (!tokens) {
      setOrders([]);
      return;
    }
    setListLoading(true);
    try {
      // 团号筛选是「把这个团的所有航段一次看全」，日期区间会把回程挡在外面，故按团查时不带日期。
      const filter: HoldOrderFilter = groupFilter
        ? { groupRef: groupFilter }
        : {
            from: dateFrom,
            to: dateTo,
            ...(filterFlightId ? { flightId: filterFlightId } : {}),
            ...(agentFilter ? { agentId: agentFilter } : {}),
            ...(statusFilter ? { status: statusFilter } : {}),
          };
      const [result, kpis] = await Promise.all([
        api.listHoldOrders(tokens.accessToken, filter),
        api.getHoldOrderSummary(tokens.accessToken, filter),
      ]);
      setOrders(result.holdOrders);
      setSummary(kpis.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载占位单失败');
    } finally {
      setListLoading(false);
    }
  }, [tokens, dateFrom, dateTo, filterFlightId, agentFilter, statusFilter, groupFilter]);

  useEffect(() => { void reload(); }, [reload]);



  const runAction = async (order: HoldOrderListItem, action: 'release' | 'cancel') => {
    if (!tokens || actionConfirmRef.current) return;
    actionConfirmRef.current = true;
    const ok = await askConfirm({
      title: `确认${action === 'release' ? '释放' : '取消'}占位单 ${order.holdNo}？`,
      body: '座位将回到公共库存。',
      tone: 'danger',
    });
    if (!ok) {
      actionConfirmRef.current = false;
      return;
    }
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
      actionConfirmRef.current = false;
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

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="占座中" value={`${summary.occupiedOrderCount} 单 · ${summary.occupiedSeats} 座`} tone="success" />
        <KpiCard label="逾期占座" value={`${summary.overdueOrderCount} 单`} tone="warning" />
        <KpiCard label="全款待转正" value={`${summary.fullyPaidPendingConversionCount} 单`} tone="info" />
        <KpiCard label="本页合计已收" value={`¥${summary.receivedCny.toLocaleString()}`} tone="neutral" />
      </section>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          <div>
            <label className="label">出发日期 从</label>
            <input className="input" type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setGroupFilter(''); }} />
          </div>
          <div>
            <label className="label">出发日期 到</label>
            <input className="input" type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setGroupFilter(''); }} />
          </div>
          <div>
            <label className="label">航班号</label>
            <select className="input" value={filterFlightId} onChange={(e) => { setFilterFlightId(e.target.value); setGroupFilter(''); }}>
              <option value="">全部航班</option>
              {flights.map((flight) => <option key={flight.id} value={flight.id}>{flight.flightNumber} · {flight.originCode} → {flight.destinationCode}</option>)}
            </select>
          </div>
          <div>
            <label className="label">归属代理</label>
            <select className="input" value={agentFilter} onChange={(e) => { setAgentFilter(e.target.value); setGroupFilter(''); }}>
              <option value="">全部归属</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}
            </select>
          </div>
          <div>
            <label className="label">状态筛选</label>
            <select className="input" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as '' | HoldOrderStatus); setGroupFilter(''); }}>
              <option value="">全部状态</option>
              {(Object.keys(HOLD_STATUS_META) as HoldOrderStatus[]).map((status) => <option key={status} value={status}>{holdStatusLabel(status)}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button className="btn-primary w-full text-sm" onClick={() => setShowForm(true)}>+ 新建占位单</button>
          </div>
        </div>
        {groupFilter ? (
          <p className="mt-3 rounded bg-brand-50 px-3 py-2 text-sm text-brand-800">
            正在只看团号 <strong className="font-mono">{groupFilter}</strong> 的全部航段（不受日期区间限制）。
            <button className="ml-2 font-medium underline" onClick={() => setGroupFilter('')}>回到日期区间</button>
          </p>
        ) : (
          <p className="mt-3 text-xs text-ink-muted">按出发日期看，不是按建单日期。列表里的「出发日期」列就是这张单实际留的那一天。</p>
        )}
      </section>

      {focusedSchedules.length > 0 && (
        <section className="space-y-3">
          {focusedSchedules.map((schedule) => (
            <div key={schedule.id}>
              <h3 className="text-sm font-semibold text-ink-soft">
                {formatLocalDate(schedule.departureTime, schedule.departureTz)} {formatLocalTime(schedule.departureTime, schedule.departureTz)} 出发 · 各舱余量
              </h3>
              <div className="mt-2 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                {schedule.seatClasses.map((cabin) => (
                  <div key={cabin.id} className="card">
                    <h4 className="font-semibold">{CABIN_LABEL[cabin.cabin] ?? cabin.cabin}</h4>
                    <p className="mt-1 text-sm text-ink-soft">可售余量 <strong>{cabin.available}</strong> 座</p>
                    <p className="mt-1 text-xs text-ink-muted">已售 {cabin.sold} · 锁位 {cabin.locked} · 占位 {cabin.held}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="card p-0 overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-3">
          <h3 className="font-semibold">
            占位单
            <span className="ml-2 text-sm font-normal text-ink-muted">
              {groupFilter ? `团号 ${groupFilter}` : `${dateFrom} ~ ${dateTo} 出发`} · 共 {orders.length} 单
            </span>
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead><tr><th className="text-left">出发日期 · 航班</th><th className="text-left">团号 / 团名</th><th className="text-left">单号</th><th className="text-left">归属</th><th className="text-left">舱位</th><th className="text-right">占位数</th><th className="text-right">锁价</th><th className="text-left">状态</th><th className="text-left">建单时间</th><th></th></tr></thead>
            <tbody>
              {listLoading && <tr><td colSpan={10} className="py-5 text-center text-ink-muted">加载占位单中…</td></tr>}
              {!listLoading && orders.length === 0 && <tr><td colSpan={10} className="py-5 text-center text-ink-muted">该区间没有占位单</td></tr>}
              {orders.map((order) => {
                const holding = order.status === 'HOLDING' || order.status === 'OVERDUE' || order.status === 'FULLY_PAID';
                const remainingSeats = order.seats - order.seatsConverted - order.seatsCancelled;
                const canRelease = order.status === 'PENDING' || holding;
                const canCancel = order.status === 'PENDING' || holding;
                const canReduce = order.status === 'PENDING' || holding;
                const canConvert = holding && remainingSeats > 0;
                const waitingOccupy = order.status === 'PENDING' && order.occupyOn === 'FULL_PAYMENT' && order.installments.length > 0 && order.installments.every((item) => item.amountCny === 0 || item.allocations.filter((allocation) => !allocation.reversedAt).reduce((sum, allocation) => sum + Number(allocation.amountCny), 0) >= item.amountCny);
                return (
                  <Fragment key={order.id}>
                  <tr className={order.status === 'OVERDUE' ? 'bg-rose-50' : undefined}>
                    <td>
                      <div className="font-medium">{formatLocalDate(order.flightSchedule.departureTime, order.flightSchedule.departureTz)}</div>
                      <div className="text-xs text-ink-muted">
                        {order.flightSchedule.flight.flightNumber} · {order.flightSchedule.flight.originCode} → {order.flightSchedule.flight.destinationCode} · {formatLocalTime(order.flightSchedule.departureTime, order.flightSchedule.departureTz)}
                      </div>
                    </td>
                    <td>
                      {order.groupRef ? (
                        <button type="button" className="font-mono text-xs font-medium text-brand-700 underline" title="只看这个团的全部航段" onClick={() => setGroupFilter(order.groupRef!)}>
                          {order.groupRef}
                        </button>
                      ) : <span className="text-xs text-ink-muted">—</span>}
                      <div className="text-xs text-ink-muted">{order.groupName || ''}</div>
                    </td>
                    <td className="font-mono text-xs">{order.holdNo}</td>
                    <td><div className="font-medium">{ownerLabel(order)}</div><div className="text-xs text-ink-muted">{order.ownerType === 'AGENT' ? '代理' : '直客'}</div></td>
                    <td><span className="badge-neutral">{CABIN_LABEL[order.seatClass.cabin] ?? order.seatClass.cabin}</span></td>
                    <td className="text-right nums">{remainingSeats}/{order.seats}</td>
                    <td className="text-right nums">¥{order.perSeatPriceCny}/人</td>
                    <td><button type="button" className={holdStatusBadgeClass(order.status)} onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}>{holdStatusLabel(order.status)} · 期表</button>{waitingOccupy && <div className="mt-1 text-xs font-semibold text-amber-700">已收全款，待占座</div>}</td>
                    <td className="text-xs text-ink-muted">{formatDateTimeSecCn(order.createdAt)}</td>
                    <td className="whitespace-nowrap text-right">
                      <button className="mr-2 text-xs font-medium text-brand-700 disabled:text-ink-muted" disabled={!holding || busy} onClick={() => setPriceOrder(order)}>改价</button>
                      <button className="mr-2 text-xs font-medium text-brand-700 disabled:text-ink-muted" disabled={!holding || busy} onClick={() => setInfoOrder(order)}>编辑</button>
                      {canConvert && <button className={`mr-2 text-xs font-semibold disabled:text-ink-muted ${order.status === 'FULLY_PAID' ? 'btn-primary px-2 py-1' : 'text-brand-700'}`} disabled={busy} onClick={() => setConvertOrder(order)}>导入名单转正</button>}
                      <button className="mr-2 text-xs font-medium text-amber-700 disabled:text-ink-muted" disabled={!canRelease || busy} onClick={() => void runAction(order, 'release')}>释放</button>
                      <button className="mr-2 text-xs font-medium text-brand-700 disabled:text-ink-muted" disabled={!canReduce || busy} onClick={() => setReduceOrder(order)}>减员</button>
                      {waitingOccupy && <button className="mr-2 text-xs font-semibold text-amber-700 disabled:text-ink-muted" disabled={busy} onClick={() => void retryOccupy(order)}>重试占座</button>}
                      <button className="text-xs font-medium text-rose-600 disabled:text-ink-muted" disabled={!canCancel || busy} onClick={() => void runAction(order, 'cancel')}>取消</button>
                    </td>
                  </tr>
                  {expandedId === order.id && (
                    <tr className={order.status === 'OVERDUE' ? 'bg-rose-50/70' : 'bg-slate-50/70'}>
                      <td colSpan={10} className="px-5 py-3">
                        <InstallmentTable order={order} onAllocate={(installment) => setAllocateTarget({ order, installment })} onManualReceipt={(installment) => setManualReceiptTarget({ order, installment })} onReload={reload} />
                        <HoldLedgerDetails order={order} />
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

      {showForm && (
        <CreateHoldModal
          flights={flights}
          allSchedules={allSchedules}
          agents={agents}
          defaultDate={dateFrom}
          defaultFlightId={filterFlightId}
          onCancel={() => setShowForm(false)}
          onSubmit={async (body) => {
            if (!tokens) return;
            setBusy(true);
            try {
              const result = await api.createHoldOrderGroup(tokens.accessToken, body);
              setShowForm(false);
              await Promise.all([reload(), reloadSchedules()]);
              const legWord = body.legs.length > 1 ? `${body.legs.length} 个航段` : '1 个航段';
              notify(body.mode === 'ALLOTMENT'
                ? `切位占位单已创建（${legWord}，团号 ${result.groupRef}），付款前不占公共座位`
                : `占位单已创建（${legWord}，团号 ${result.groupRef}），座位已计入占用`);
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
      {infoOrder && (
        <InfoModal
          order={infoOrder}
          agents={agents}
          onCancel={() => setInfoOrder(null)}
          onSubmit={async (groupName, notes, agentId) => {
            if (!tokens) return;
            setBusy(true);
            try {
              // 先改团名/备注，再改归属：任一步失败弹窗留在原地展示后端原因。
              await api.updateHoldOrderInfo(tokens.accessToken, infoOrder.id, { groupName, notes });
              const agentChanged = infoOrder.ownerType === 'AGENT' && !!agentId && agentId !== infoOrder.agentId;
              if (agentChanged) await api.updateHoldOrderAgent(tokens.accessToken, infoOrder.id, { agentId });
              setInfoOrder(null);
              await reload();
              notify(agentChanged ? '归属代理与占位单信息已更新' : '团名 / 备注已更新');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {reduceOrder && tokens && (
        <ReduceModal order={reduceOrder} token={tokens.accessToken} onCancel={() => setReduceOrder(null)} onDone={async () => { setReduceOrder(null); await Promise.all([reload(), reloadSchedules()]); notify('减员清算已完成，座位已回池'); }} />
      )}
      {convertOrder && tokens && (
        <ConvertModal
          order={convertOrder}
          token={tokens.accessToken}
          onCancel={() => setConvertOrder(null)}
          onDone={async (result, pendingDocumentCount) => {
            setConvertOrder(null);
            await Promise.all([reload(), reloadSchedules()]);
            const base = `已转正 ${result.seats} 座，结转 ¥${result.carryCny.toLocaleString()}，订单 ${result.orderNumber}`;
            notify(pendingDocumentCount > 0
              ? `${base}；其中 ${pendingDocumentCount} 人证件待补，护照到了到订单详情的出行人卡片补录`
              : base);
          }}
        />
      )}
      {allocateTarget && tokens && (
        <AllocateModal order={allocateTarget.order} installment={allocateTarget.installment} token={tokens.accessToken} onCancel={() => setAllocateTarget(null)} onDone={async (warning) => { setAllocateTarget(null); await reload(); notify(warning ?? '认款已记录'); }} />
      )}
      {manualReceiptTarget && tokens && (
        <ManualReceiptModal order={manualReceiptTarget.order} installment={manualReceiptTarget.installment} token={tokens.accessToken} onCancel={() => setManualReceiptTarget(null)} onDone={async (warning) => { setManualReceiptTarget(null); await reload(); notify(warning ?? '到账已记录，待财务核实'); }} />
      )}
      {showConfig && holdConfig && tokens && (
        <ConfigModal config={holdConfig} token={tokens.accessToken} onCancel={() => setShowConfig(false)} onDone={(config) => { setHoldConfig(config); setShowConfig(false); notify('收款模板已保存'); }} />
      )}
    </div>
  );
}

/** 建单弹窗里的一段航段：日期 → 航班 → 班次 → 舱位 → 锁价，全部在弹窗内选定。 */
interface LegDraft {
  key: string;
  date: string;
  flightId: string;
  scheduleId: string;
  cabin: CabinClass;
  price: number;
}

/** 距起飞多少天以内要二次确认出发日期。团队留位极少留明后天的班。 */
const NEAR_DEPARTURE_DAYS = 3;

function daysUntil(iso: string): number {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86400000);
}

let legSeq = 0;
function newLegKey(): string {
  legSeq += 1;
  return `leg_${legSeq}`;
}

/**
 * 新建占位单 / 建团占位。
 *
 * 出发日期必须在弹窗里选：此前日期取自页面顶部的筛选器，弹窗里只有一行灰色小字，
 * 填完表单点确认就把座位留到了页面默认的那一班——留错日期而毫无察觉。
 * 现在每个航段的日期/航班/班次都在弹窗内显式选定，临近起飞的班次还要再确认一次。
 */
function CreateHoldModal({
  flights,
  allSchedules,
  agents,
  defaultDate,
  defaultFlightId,
  onCancel,
  onSubmit,
}: {
  flights: AdminFlight[];
  allSchedules: Record<string, AdminSchedule[]>;
  agents: AgentListItem[];
  defaultDate: string;
  defaultFlightId: string;
  onCancel: () => void;
  onSubmit: (body: CreateHoldGroupInput) => Promise<void>;
}) {
  const dialogRef = useDialogA11y(onCancel);
  const tokens = useAuth((s) => s.tokens);

  const dateOptions = useMemo(() => {
    const dates = new Set<string>();
    Object.values(allSchedules).forEach((schedules) => {
      schedules.forEach((s) => dates.add(localDateOf(s.departureTime, s.departureTz)));
    });
    return [...dates].sort();
  }, [allSchedules]);

  const schedulesOn = useCallback(
    (date: string, flightId: string) =>
      (allSchedules[flightId] ?? [])
        .filter((s) => localDateOf(s.departureTime, s.departureTz) === date)
        .sort((a, b) => a.departureTime.localeCompare(b.departureTime)),
    [allSchedules],
  );
  const flightsOn = useCallback(
    (date: string) => flights.filter((f) => (allSchedules[f.id] ?? []).some((s) => localDateOf(s.departureTime, s.departureTz) === date)),
    [flights, allSchedules],
  );

  const makeLeg = useCallback(
    (date: string, flightId: string, preferCabin?: CabinClass): LegDraft => {
      // 带进来的日期可能根本没有航班（筛选器默认「今天」，而最近一班在几天后）——
      // 那样三级选择器会全空、余量显示 0，看着像坏了。回落到第一个有班次的日期。
      const day = dateOptions.includes(date) ? date : (dateOptions[0] ?? '');
      const flightList = flightsOn(day);
      const flight = flightList.find((f) => f.id === flightId) ?? flightList[0];
      const schedule = flight ? schedulesOn(day, flight.id)[0] : undefined;
      return {
        key: newLegKey(),
        date: day,
        flightId: flight?.id ?? '',
        scheduleId: schedule?.id ?? '',
        // 回程通常与去程同舱；班次里排第一的舱位可能是只有几座的商务舱，拿它当默认很容易看岔。
        cabin: (preferCabin && schedule?.seatClasses.some((c) => c.cabin === preferCabin) ? preferCabin : schedule?.seatClasses[0]?.cabin) ?? 'ECONOMY',
        price: 0,
      };
    },
    [dateOptions, flightsOn, schedulesOn],
  );

  const [legs, setLegs] = useState<LegDraft[]>(() => [makeLeg(defaultDate, defaultFlightId)]);
  const [seats, setSeats] = useState(1);
  const [mode, setMode] = useState<'RESERVE' | 'ALLOTMENT'>('RESERVE');
  const [ownerType, setOwnerType] = useState<HoldOwnerType>('AGENT');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [groupName, setGroupName] = useState('');
  const [ratio, setRatio] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [dateConfirmed, setDateConfirmed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [planRows, setPlanRows] = useState<Array<{ seq: number; label: string; amountRule: 'PER_PERSON_FIXED' | 'REMAINDER'; perPersonCny: number | null; amountCny: number; dueDate: string }>>([]);
  const [planLoading, setPlanLoading] = useState(false);
  const [dueDates, setDueDates] = useState<Record<string, string>>({});

  // 表单脏检测：任一字段偏离初始值即视为「已编辑」，用于挂载 beforeunload 兜底——
  // 触控板横滑会被 Safari 等浏览器识别成「后退」手势，弹窗填到一半会被直接划走、
  // 内容全丢（公测反馈）。overscroll-behavior-x 在 Chrome/Edge/Firefox 已根治，
  // 这里给不吃该属性的浏览器再加一道原生「离开确认」。
  const initialFormSnapshotRef = useRef(
    JSON.stringify({ legs, seats, mode, ownerType, agentId, groupName, ratio, notes, dateConfirmed, dueDates }),
  );
  const isDirty =
    JSON.stringify({ legs, seats, mode, ownerType, agentId, groupName, ratio, notes, dateConfirmed, dueDates }) !==
    initialFormSnapshotRef.current;

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const scheduleOf = useCallback(
    (leg: LegDraft) => schedulesOn(leg.date, leg.flightId).find((s) => s.id === leg.scheduleId),
    [schedulesOn],
  );

  const patchLeg = (key: string, patch: Partial<LegDraft>) => {
    setLegs((old) =>
      old.map((leg) => {
        if (leg.key !== key) return leg;
        const next = { ...leg, ...patch };
        // 日期变了航班可能不飞，航班变了班次可能不存在——逐级回落到该级第一个可选项，
        // 避免选择器停在一个已经不存在的组合上（这正是留错日期的老路子）。
        if (patch.date !== undefined) {
          const flightList = flightsOn(next.date);
          if (!flightList.some((f) => f.id === next.flightId)) next.flightId = flightList[0]?.id ?? '';
        }
        if (patch.date !== undefined || patch.flightId !== undefined) {
          const list = schedulesOn(next.date, next.flightId);
          if (!list.some((s) => s.id === next.scheduleId)) next.scheduleId = list[0]?.id ?? '';
        }
        if (patch.cabin === undefined) {
          const schedule = schedulesOn(next.date, next.flightId).find((s) => s.id === next.scheduleId);
          if (schedule && !schedule.seatClasses.some((c) => c.cabin === next.cabin)) {
            next.cabin = schedule.seatClasses[0]?.cabin ?? next.cabin;
          }
        }
        return next;
      }),
    );
    setDateConfirmed(false);
  };

  const availabilityOf = (leg: LegDraft): number => {
    const schedule = scheduleOf(leg);
    return Math.max(0, schedule?.seatClasses.find((c) => c.cabin === leg.cabin)?.available ?? 0);
  };

  const firstLeg = legs[0];
  const singleLeg = legs.length === 1;
  // 收款计划按第一段（通常是去程）生成；多航段时各段在服务端各自按同一套期次结构算钱，
  // 金额用各段自己的锁价。截止日只在单航段时开放手调，多航段建单后可在期表里逐单调整。
  useEffect(() => {
    if (!tokens || !firstLeg?.scheduleId || seats < 1 || firstLeg.price < 0) return;
    let cancelled = false;
    setPlanLoading(true);
    setFormError(null);
    api.previewHoldPlan(tokens.accessToken, { flightScheduleId: firstLeg.scheduleId, cabin: firstLeg.cabin, seats, perSeatPriceCny: firstLeg.price, mode })
      .then((result) => { if (!cancelled) { setPlanRows(result.plan.installments); setDueDates({}); } })
      .catch((err) => { if (!cancelled) { setPlanRows([]); setFormError(err instanceof Error ? err.message : '收款计划预览失败'); } })
      .finally(() => { if (!cancelled) setPlanLoading(false); });
    return () => { cancelled = true; };
  }, [tokens, firstLeg?.scheduleId, firstLeg?.cabin, firstLeg?.price, seats, mode]);

  const visibleRows = planRows.map((row) => ({ ...row, key: String(row.seq), dueDate: dueDates[String(row.seq)] ?? row.dueDate }));
  const nearDepartureLegs = legs.filter((leg) => {
    const schedule = scheduleOf(leg);
    return schedule ? daysUntil(schedule.departureTime) <= NEAR_DEPARTURE_DAYS : false;
  });
  const overbookedLegs = mode === 'RESERVE' ? legs.filter((leg) => seats > availabilityOf(leg)) : [];
  const duplicatedLeg = legs.some((leg, index) => legs.findIndex((other) => other.scheduleId === leg.scheduleId && other.cabin === leg.cabin) !== index);
  const totalCny = legs.reduce((sum, leg) => sum + leg.price * seats, 0);

  const valid =
    legs.length > 0 &&
    legs.every((leg) => leg.scheduleId && leg.price >= 0) &&
    !duplicatedLeg &&
    seats >= 1 &&
    overbookedLegs.length === 0 &&
    !planLoading &&
    planRows.length > 0 &&
    (ownerType === 'AGENT' ? !!agentId : !!groupName.trim()) &&
    (ratio === '' || (ratio >= 0 && ratio <= 50)) &&
    (nearDepartureLegs.length === 0 || dateConfirmed);

  const submit = async () => {
    if (!valid) return;
    setFormError(null);
    try {
      await onSubmit({
        legs: legs.map((leg) => ({ flightScheduleId: leg.scheduleId, cabin: leg.cabin, perSeatPriceCny: leg.price })),
        seats,
        mode,
        ownerType,
        ...(singleLeg && Object.keys(dueDates).length > 0
          ? { installmentsOverride: visibleRows.map((row) => row.perPersonCny != null ? ({ label: row.label, perPersonCny: row.perPersonCny, dueDate: row.dueDate }) : ({ label: row.label, dueDate: row.dueDate })) }
          : {}),
        ...(ownerType === 'AGENT' ? { agentId } : {}),
        ...(groupName.trim() ? { groupName: groupName.trim() } : {}),
        ...(ratio !== '' ? { freeCancelRatio: ratio / 100 } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '创建失败');
    }
  };

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="新建占位单" tabIndex={-1} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4" onClick={onCancel}>
      <div className="my-6 w-full max-w-3xl rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-lg font-semibold">新建占位单{legs.length > 1 ? `（${legs.length} 个航段，同一个团）` : ''}</h2>
          <button onClick={onCancel} className="text-xl text-slate-400" aria-label="关闭">×</button>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div>
            <div className="flex items-center justify-between">
              <p className="label mb-0">留位航段</p>
              <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setLegs((old) => [...old, makeLeg(old[old.length - 1]?.date ?? defaultDate, '', old[old.length - 1]?.cabin)])}>
                + 添加航段（去程 / 回程）
              </button>
            </div>
            <p className="mt-1 text-xs text-ink-muted">出发日期在这里选，选几号就留几号；同一个团的多个航段会拿到同一个团号。</p>
            <div className="mt-2 space-y-2">
              {legs.map((leg, index) => {
                const schedule = scheduleOf(leg);
                const avail = availabilityOf(leg);
                const near = schedule ? daysUntil(schedule.departureTime) <= NEAR_DEPARTURE_DAYS : false;
                return (
                  <div key={leg.key} className={`rounded border px-3 py-2 ${near ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-ink-soft">{index === 0 ? '第 1 段（去程）' : `第 ${index + 1} 段`}</span>
                      {legs.length > 1 && (
                        <button type="button" className="text-xs font-medium text-rose-600" onClick={() => setLegs((old) => old.filter((item) => item.key !== leg.key))}>移除</button>
                      )}
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-5">
                      <div>
                        <label className="label text-xs">出发日期</label>
                        <select className="input" value={leg.date} onChange={(e) => patchLeg(leg.key, { date: e.target.value })}>
                          {dateOptions.map((date) => <option key={date} value={date}>{date}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="label text-xs">航班号</label>
                        <select className="input" value={leg.flightId} onChange={(e) => patchLeg(leg.key, { flightId: e.target.value })}>
                          {flightsOn(leg.date).map((flight) => <option key={flight.id} value={flight.id}>{flight.flightNumber} · {flight.originCode} → {flight.destinationCode}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="label text-xs">班次时刻</label>
                        <select className="input" value={leg.scheduleId} onChange={(e) => patchLeg(leg.key, { scheduleId: e.target.value })}>
                          {schedulesOn(leg.date, leg.flightId).map((item) => <option key={item.id} value={item.id}>{formatLocalTime(item.departureTime, item.departureTz)} 出发</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="label text-xs">舱位</label>
                        <select className="input" value={leg.cabin} onChange={(e) => patchLeg(leg.key, { cabin: e.target.value as CabinClass })}>
                          {CABINS.filter((c) => schedule?.seatClasses.some((s) => s.cabin === c)).map((c) => <option key={c} value={c}>{CABIN_LABEL[c] ?? c}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="label text-xs">锁价（元/人）</label>
                        <input className="input" type="number" min={0} value={leg.price} onChange={(e) => patchLeg(leg.key, { price: Number(e.target.value) })} />
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">
                      {schedule ? `${formatLocalDate(schedule.departureTime, schedule.departureTz)} ${formatLocalTime(schedule.departureTime, schedule.departureTz)} 出发 · ` : ''}
                      当前可售余量 <strong className={mode === 'RESERVE' && seats > avail ? 'text-rose-600' : ''}>{avail}</strong> 座
                      {near && <span className="ml-2 font-semibold text-amber-700">距起飞不足 {NEAR_DEPARTURE_DAYS + 1} 天，请确认是不是要留这一天</span>}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div><label className="label">占位座位数（全团）</label><input className="input" type="number" min={1} max={600} value={seats} onChange={(e) => setSeats(Number(e.target.value))} /></div>
            <div><label className="label">归属</label><select className="input" value={ownerType} onChange={(e) => setOwnerType(e.target.value as HoldOwnerType)}><option value="AGENT">代理</option><option value="CUSTOMER">直客</option></select></div>
            <div><label className="label">占位模式</label><select className="input" value={mode} onChange={(e) => setMode(e.target.value as 'RESERVE' | 'ALLOTMENT')}><option value="RESERVE">留位（建单即占座）</option><option value="ALLOTMENT">切位（全款才占座）</option></select></div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {ownerType === 'AGENT' && (
              <div><label className="label">代理</label><select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>{agents.length === 0 && <option value="">暂无可用代理</option>}{agents.map((a) => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}</select></div>
            )}
            {/* 团名对代理归属同样开放：代理团也要能按团名找回来，否则列表里只有一串单号 */}
            <div>
              <label className="label">团名 / 客户备注名{ownerType === 'CUSTOMER' ? '' : '（选填）'}</label>
              <input className="input" maxLength={120} value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="例如：九月国旅团" />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label">免损比例（%，选填）</label><input className="input" type="number" min={0} max={50} step={1} value={ratio} onChange={(e) => setRatio(e.target.value === '' ? '' : Number(e.target.value))} /></div>
            <div><label className="label">备注（选填）</label><input className="input" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          </div>

          <div>
            <p className="label">收款计划预览（服务端计算{singleLeg ? '，截止日可手调' : '，多航段各段按同一套期次结构各算各的金额'}）</p>
            {planLoading ? <p className="rounded bg-slate-50 px-3 py-2 text-sm text-ink-muted">计算收款计划…</p> : (
              <div className="overflow-x-auto rounded border border-slate-200">
                <table className="w-full text-xs">
                  <thead><tr className="bg-slate-50"><th className="px-2 py-1 text-left">期</th><th className="px-2 py-1 text-right">应收{singleLeg ? '' : '（第 1 段）'}</th><th className="px-2 py-1 text-left">截止</th></tr></thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <tr key={row.key}>
                        <td className="px-2 py-1">{row.label}</td>
                        <td className="px-2 py-1 text-right">¥{row.amountCny.toLocaleString()}</td>
                        <td className="px-2 py-1">
                          {singleLeg
                            ? <input className="input h-7 py-0 text-xs" type="date" value={row.dueDate} onChange={(e) => setDueDates((old) => ({ ...old, [row.key]: e.target.value }))} />
                            : row.dueDate}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {legs.length > 1 && <p className="mt-1 text-xs text-ink-muted">全团应收合计 ¥{totalCny.toLocaleString()}（{seats} 座 × {legs.map((leg) => `¥${leg.price}`).join(' + ')}）</p>}
          </div>

          {nearDepartureLegs.length > 0 && (
            <label className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <input type="checkbox" className="mt-1" checked={dateConfirmed} onChange={(e) => setDateConfirmed(e.target.checked)} />
              <span>
                有 {nearDepartureLegs.length} 个航段就在最近几天起飞
                （{nearDepartureLegs.map((leg) => { const s = scheduleOf(leg); return s ? formatLocalDate(s.departureTime, s.departureTz) : ''; }).filter(Boolean).join('、')}）。
                我已确认要留的就是这几天。
              </span>
            </label>
          )}
          {duplicatedLeg && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">同一班次同一舱位重复添加了，会把同一批人留两遍</p>}
          {overbookedLegs.length > 0 && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">有航段可售余量不足 {seats} 座，无法留位</p>}
          {formError && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{formError}</p>}
          <div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" disabled={!valid} onClick={() => void submit()}>确认建单</button></div>
        </div>
      </div>
    </div>
  );
}

function InstallmentTable({ order, onAllocate, onManualReceipt, onReload }: { order: HoldOrderListItem; onAllocate: (installment: HoldInstallment) => void; onManualReceipt: (installment: HoldInstallment) => void; onReload: () => Promise<void> }) {
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
        {rows.map((row) => <Fragment key={row.id}><tr className="border-t border-slate-200"><td>{row.seq}</td><td>{row.label}</td><td className="text-right">¥{row.amountCny.toLocaleString()}</td><td className="text-right">¥{activeAmount(row).toLocaleString()}</td><td>{row.dueDate.slice(0, 10)}</td><td><span className={row.status === 'PAID' ? 'badge-success' : 'badge-neutral'}>{row.status === 'PAID' ? '已认满' : '待认款'}</span></td><td className="text-right"><button className="mr-2 font-semibold text-emerald-700 disabled:text-ink-muted" disabled={row.status === 'PAID'} onClick={() => onManualReceipt(row)}>手工到账</button><button className="mr-2 text-brand-700 disabled:text-ink-muted" disabled={row.status === 'PAID'} onClick={() => onAllocate(row)}>认款</button><button className="text-amber-700 disabled:text-ink-muted" disabled={row.status === 'PAID' || busyId === row.id} onClick={() => void changeDueDate(row)}>调期</button></td></tr>
          {row.allocations.filter((a) => !a.reversedAt).map((allocation) => {
            const isClaim = allocation.receipt?.source === 'OPS_CLAIM';
            const claimVerified = isClaim && !!allocation.receipt?.verifiedAt;
            return <tr key={allocation.id} className="text-[11px] text-ink-muted"><td></td><td colSpan={4}>{isClaim ? '手工到账' : '挂账认款'} ¥{Number(allocation.amountCny).toLocaleString()}{isClaim && (claimVerified ? <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">财务已核实</span> : <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">待财务核实</span>)}</td><td colSpan={2} className="text-right"><button className="link-danger text-xs" disabled={busyId === allocation.id} onClick={() => void reverse(row, allocation.id)}>撤销</button></td></tr>;
          })}
        </Fragment>)}
      </tbody></table>
    </div>
  );
}

function HoldLedgerDetails({ order }: { order: HoldOrderListItem }) {
  const conversions = order.conversions ?? [];
  const reductions = order.reductions ?? [];
  return (
    <div className="mt-4 grid gap-4 border-t border-slate-200 pt-3 text-xs md:grid-cols-2">
      <div>
        <div className="mb-1 font-semibold text-ink-soft">转正记录</div>
        {conversions.length === 0 ? <div className="text-ink-muted">暂无</div> : <ul className="space-y-1 text-ink-muted">
          {conversions.map((row) => <li key={row.id}>订单 <span className="font-mono text-brand-700">{row.orderNumber}</span> · {row.seats} 座 · 结转 ¥{row.carryCny.toLocaleString()} · {formatDateTimeSecCn(row.createdAt)}</li>)}
        </ul>}
      </div>
      <div>
        <div className="mb-1 font-semibold text-ink-soft">清算记录</div>
        {reductions.length === 0 ? <div className="text-ink-muted">暂无</div> : <ul className="space-y-1 text-ink-muted">
          {reductions.map((row) => <li key={row.id}>{row.seatsReduced} 座 · 免损 {row.freeSeats} · 没收 ¥{row.forfeitCny.toLocaleString()} · 挂账 ¥{row.surplusCny.toLocaleString()} · {formatDateTimeSecCn(row.createdAt)}</li>)}
        </ul>}
      </div>
    </div>
  );
}

type ConversionResult = {
  orderNumber: string;
  seats: number;
  carryCny: number;
};

/** 转正名单里的日期列：留空 = 待补，填了就必须是 YYYY-MM-DD。 */
const isBlankOrYmd = (value: string | undefined): boolean =>
  !value?.trim() || /^\d{4}-\d{2}-\d{2}$/.test(value.trim());

function ConvertModal({
  order,
  token,
  onCancel,
  onDone,
}: {
  order: HoldOrderListItem;
  token: string;
  onCancel: () => void;
  onDone: (result: ConversionResult, pendingDocumentCount: number) => Promise<void>;
}) {
  const dialogRef = useDialogA11y(onCancel);
  const remaining = order.seats - order.seatsConverted - order.seatsCancelled;
  const [requestToken] = useState(newConversionRequestToken);
  const [rows, setRows] = useState<BatchOrderPassenger[]>([{ fullName: '', documentNumber: '', dateOfBirth: '', passportExpiry: '', nationality: 'CN' }]);
  const [contactName, setContactName] = useState(order.groupName ?? '');
  const [contactPhone, setContactPhone] = useState('');
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ perSeatCarry: number; carryCny: number; orderDueCny: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreviewBusy(true);
    api.previewHoldConversion(token, order.id, rows.length)
      .then((result) => { if (!cancelled) setPreview(result.preview); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : '加载转正试算失败'); })
      .finally(() => { if (!cancelled) setPreviewBusy(false); });
    return () => { cancelled = true; };
  }, [token, order.id, rows.length]);

  const carry = preview?.carryCny ?? 0;
  const orderDue = preview?.orderDueCny ?? 0;
  // 未核实的手工到账金额（运营水单登记、财务还没对上流水）：转正会把这笔钱结转进订单，
  // 出票是不可逆动作——这里先明示，让经办人自己决定要不要在核实前继续。
  const unverifiedClaimCny = (order.installments ?? []).reduce((sum, installment) =>
    sum + installment.allocations.filter((a) => !a.reversedAt && a.receipt?.source === 'OPS_CLAIM' && !a.receipt?.verifiedAt).reduce((s, a) => s + Number(a.amountCny), 0), 0);

  // 「证件资料待补」= 这行只有名字、还没有证件号。转正照常建单占位，护照到了再去订单详情补录。
  const pendingDocumentCount = rows.filter((row) => !row.documentNumber.trim()).length;

  const setRow = (index: number, patch: Partial<BatchOrderPassenger>) => setRows((old) => old.map((row, i) => i === index ? { ...row, ...patch } : row));
  const addRow = () => { if (rows.length < remaining) setRows((old) => [...old, { fullName: '', documentNumber: '', dateOfBirth: '', passportExpiry: '', nationality: 'CN' }]); };
  const removeRow = (index: number) => setRows((old) => old.length <= 1 ? old : old.filter((_, i) => i !== index));
  const parsePaste = () => {
    const parsed = pasteText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const cols = line.split(/[,，\t]+|\s{2,}|\s+/).map((col) => col.trim()).filter(Boolean);
      return { fullName: cols[0] ?? '', documentNumber: cols[1] ?? '', dateOfBirth: cols[2] ?? '', passportExpiry: cols[3] ?? '', nationality: 'CN' };
    }).filter((row) => row.fullName);
    if (parsed.length === 0) { setError('没有解析出乘客行'); return; }
    setRows(parsed.slice(0, remaining));
    if (parsed.length > remaining) setError(`名单超过余座，已保留前 ${remaining} 行`);
  };

  const submit = async () => {
    if (rows.length < 1 || rows.length > remaining) { setError(`本次人数必须在 1 至 ${remaining} 人之间`); return; }
    // 转正只强制姓名：护照可以等名单先占座、证件后到再补（后端 holdConversionPassengerInputSchema
    // 同款口径）。填了的日期仍要求 YYYY-MM-DD，避免半截日期被静默丢掉。
    const missingName = rows.findIndex((row) => !row.fullName.trim());
    if (missingName >= 0) { setError(`第 ${missingName + 1} 位请填写姓名`); return; }
    const badDate = rows.findIndex((row) => !isBlankOrYmd(row.dateOfBirth) || !isBlankOrYmd(row.passportExpiry));
    if (badDate >= 0) { setError(`第 ${badDate + 1} 位的出生日期 / 护照有效期格式应为 YYYY-MM-DD（不填请留空）`); return; }
    setBusy(true); setError(null);
    try {
      const result = await api.convertHoldOrder(token, order.id, {
        requestToken,
        passengers: rows,
        ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
        ...(contactPhone.trim() ? { contactPhone: contactPhone.trim() } : {}),
        ...(allowDuplicate ? { allowDuplicatePassengers: true } : {}),
      });
      await onDone(result.result, pendingDocumentCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : '转正失败');
    } finally { setBusy(false); }
  };

  return <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`导入名单转正 · ${order.holdNo}`} tabIndex={-1} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4" onClick={onCancel}>
    <div className="my-8 w-full max-w-5xl rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">导入名单转正 · {order.holdNo}</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div>
      <div className="space-y-4 px-5 py-4">
        <div className="grid gap-3 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-3"><div>本次转正 <b>{rows.length}</b> 座</div><div>结转 <b className="text-emerald-700">{previewBusy ? '试算中…' : `¥${carry.toLocaleString()}`}</b></div><div>订单待收 <b className="text-amber-700">{previewBusy ? '试算中…' : `¥${orderDue.toLocaleString()}`}</b></div></div>
        {unverifiedClaimCny > 0 && <p className="rounded bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">⚠ 本占位单已收里有 ¥{unverifiedClaimCny.toLocaleString()} 手工到账<b>未经财务核实</b>。转正后这笔钱会结转进订单并保留「待核实」标记——出票前请确认财务已对到流水，或自行评估风险再继续。</p>}
        <p className="rounded bg-sky-50 px-3 py-2 text-xs text-sky-800">只有<b>姓名必填</b>：护照还没到就先填名字把座位定下来，证件号 / 出生日期 / 护照有效期留空即可。转正后这几位会标成「证件待补」，护照到了到订单详情的出行人卡片补录。出票前请补齐。</p>
        {pendingDocumentCount > 0 && <p className="rounded bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">本次有 <b>{pendingDocumentCount}</b> 人只填了姓名，转正后按「证件待补」入单（订单备注会带这个标记）。</p>}
        <div className="flex flex-wrap gap-3"><input className="input max-w-xs" placeholder="联系人（选填）" value={contactName} onChange={(e) => setContactName(e.target.value)} /><input className="input max-w-xs" placeholder="联系电话（选填）" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} /><label className="flex items-center gap-2 text-sm text-ink-soft"><input type="checkbox" checked={allowDuplicate} onChange={(e) => setAllowDuplicate(e.target.checked)} />确认允许重复乘客</label></div>
        <div className="overflow-x-auto rounded border border-slate-200"><table className="min-w-[850px] w-full text-xs"><thead className="bg-slate-50 text-ink-muted"><tr><th className="px-2 py-2 text-left">姓名 *</th><th className="px-2 py-2 text-left">证件号<span className="ml-1 font-normal text-ink-muted">选填</span></th><th className="px-2 py-2 text-left">出生日期<span className="ml-1 font-normal text-ink-muted">选填</span></th><th className="px-2 py-2 text-left">护照有效期<span className="ml-1 font-normal text-ink-muted">选填</span></th><th className="px-2 py-2 text-left">国籍</th><th></th></tr></thead><tbody>{rows.map((row, index) => <tr key={index} className={`border-t border-slate-100 ${row.documentNumber.trim() ? '' : 'bg-amber-50/60'}`}><td className="px-2 py-1"><input className="input h-8" value={row.fullName} onChange={(e) => setRow(index, { fullName: e.target.value })} /></td><td className="px-2 py-1"><input className="input h-8" placeholder="待补" value={row.documentNumber} onChange={(e) => setRow(index, { documentNumber: e.target.value })} /></td><td className="px-2 py-1"><input className="input h-8" type="date" value={row.dateOfBirth} onChange={(e) => setRow(index, { dateOfBirth: e.target.value })} /></td><td className="px-2 py-1"><input className="input h-8" type="date" value={row.passportExpiry ?? ''} onChange={(e) => setRow(index, { passportExpiry: e.target.value })} /></td><td className="px-2 py-1"><input className="input h-8 w-20" value={row.nationality ?? 'CN'} onChange={(e) => setRow(index, { nationality: e.target.value.toUpperCase() })} /></td><td className="px-2 py-1"><button className="btn-ghost-danger text-xs" onClick={() => removeRow(index)}>删除</button></td></tr>)}</tbody></table></div>
        <div className="flex flex-wrap items-center gap-3"><button className="btn-secondary text-sm" disabled={rows.length >= remaining} onClick={addRow}>＋ 加一行</button><button className="btn-secondary text-sm" disabled={!pasteText.trim()} onClick={parsePaste}>解析粘贴名单</button><span className="text-xs text-ink-muted">快速粘贴格式：姓名,证件号,出生日期,护照有效期（只有姓名一列也能粘）</span></div>
        <textarea className="input min-h-20 font-mono text-xs" value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="张三,E12345678,1990-01-01,2030-01-01" />
        {error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        <div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" disabled={busy || rows.length < 1 || rows.length > remaining} onClick={() => void submit()}>{busy ? '转正中…' : '确认导入转正'}</button></div>
      </div>
    </div>
  </div>;
}

/** 手工到账：运营凭客户水单直接给某期录钱（不等财务导流水；财务事后在对账台核实）。 */
function ManualReceiptModal({ order, installment, token, onCancel, onDone }: { order: HoldOrderListItem; installment: HoldInstallment; token: string; onCancel: () => void; onDone: (warning: string | null) => Promise<void> }) {
  const dialogRef = useDialogA11y(onCancel);
  const already = installment.allocations.filter((a) => !a.reversedAt).reduce((sum, a) => sum + Number(a.amountCny), 0);
  const due = Math.max(0, installment.amountCny - already);
  const [amount, setAmount] = useState(due);
  const [method, setMethod] = useState<'WECHAT_PAY' | 'ALIPAY' | 'BANK_CARD'>('WECHAT_PAY');
  const [note, setNote] = useState('');
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onProofFile = (file: File | null) => {
    if (!file) { setProofUrl(null); return; }
    if (file.size > 5 * 1024 * 1024) { setError('水单截图不能超过 5MB'); return; }
    const reader = new FileReader();
    reader.onload = () => setProofUrl(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(file);
  };
  const submit = async () => {
    if (amount < 1 || amount > due) { setError(`请输入不超过本期未收余额 ¥${due.toLocaleString()} 的金额`); return; }
    setBusy(true);
    try {
      const result = await api.manualReceiptHoldInstallment(token, order.id, installment.id, { amountCny: amount, method, proofUrl: proofUrl ?? undefined, note: note.trim() || undefined });
      await onDone(result.result.warning);
    } catch (err) { setError(err instanceof Error ? err.message : '手工到账失败'); setBusy(false); }
  };
  return <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`手工到账 · ${order.holdNo} · ${installment.label}`} tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}><div className="w-full max-w-lg rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}><div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">手工到账 · {order.holdNo} · {installment.label}</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div><div className="space-y-4 px-5 py-4">
    <p className="text-sm text-ink-muted">本期应收 ¥{installment.amountCny.toLocaleString()}，未收 ¥{due.toLocaleString()}</p>
    <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">凭客户水单先入账推进流程；这笔钱会标为「待财务核实」，财务对到流水前请保留水单凭证。若客户实际未转账，撤销本笔并跟进客户。</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <div><label className="label">到账金额（元）</label><input className="input" type="number" min={1} max={due} value={amount || ''} onChange={(e) => setAmount(Number(e.target.value))} /></div>
      <div><label className="label">收款方式</label><select className="input" value={method} onChange={(e) => setMethod(e.target.value as 'WECHAT_PAY' | 'ALIPAY' | 'BANK_CARD')}><option value="WECHAT_PAY">微信</option><option value="ALIPAY">支付宝</option><option value="BANK_CARD">银行卡/对公</option></select></div>
    </div>
    <div><label className="label">水单截图（建议上传）</label><input className="input" type="file" accept="image/*" onChange={(e) => onProofFile(e.target.files?.[0] ?? null)} />{proofUrl && <img src={proofUrl} alt="水单截图预览" className="mt-2 max-h-32 rounded border border-slate-200" />}</div>
    <div><label className="label">备注（选填）</label><input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="客户名/转账尾号/约定说明等" /></div>
    {error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
    <div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" disabled={busy || amount < 1} onClick={() => void submit()}>{busy ? '提交中…' : '确认到账'}</button></div>
  </div></div></div>;
}

function AllocateModal({ order, installment, token, onCancel, onDone }: { order: HoldOrderListItem; installment: HoldInstallment; token: string; onCancel: () => void; onDone: (warning: string | null) => Promise<void> }) {
  const dialogRef = useDialogA11y(onCancel);
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
  return <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`认款 · ${order.holdNo} · ${installment.label}`} tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}><div className="w-full max-w-lg rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}><div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">认款 · {order.holdNo} · {installment.label}</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div><div className="space-y-4 px-5 py-4"><p className="text-sm text-ink-muted">本期应收 ¥{installment.amountCny.toLocaleString()}，未认 ¥{due.toLocaleString()}</p>{loading ? <p className="text-sm text-ink-muted">加载挂账池…</p> : receipts.length === 0 ? <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">挂账池暂无可认流水——请先在财务 · 流水页登记或导入这笔收款，再回来认款</p> : <select className="input" value={receiptId} onChange={(e) => setReceiptId(e.target.value)}><option value="">选择 OPEN/部分认款流水</option>{receipts.map((r) => <option key={r.id} value={r.id}>{r.receiptNo} · 余额 ¥{Number(r.remainingCny).toLocaleString()} · {formatDateTimeSecCn(r.receivedAt)}</option>)}</select>}<input className="input" type="number" min={1} max={due} value={amount || ''} disabled={!receiptId} onChange={(e) => setAmount(Number(e.target.value))} placeholder="认款金额（元）" />{error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}<div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" disabled={loading || !receiptId} title={!loading && !receiptId ? '请先选择流水' : undefined} onClick={() => void submit()}>确认认款</button></div></div></div></div>;
}

function ReduceModal({ order, token, onCancel, onDone }: { order: HoldOrderListItem; token: string; onCancel: () => void; onDone: () => Promise<void> }) {
  const dialogRef = useDialogA11y(onCancel);
  const available = order.seats - order.seatsConverted - order.seatsCancelled;
  const [seats, setSeats] = useState(1);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<HoldReductionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadPreview = async () => { setBusy(true); setError(null); try { setPreview((await api.previewHoldReduction(token, order.id, { seats, note: note.trim() || undefined })).preview); } catch (err) { setError(err instanceof Error ? err.message : '试算失败'); } finally { setBusy(false); } };
  const confirm = async () => { if (!preview) return; setBusy(true); try { await api.reduceHoldSeats(token, order.id, { seats, note: note.trim() || undefined }); await onDone(); } catch (err) { setError(err instanceof Error ? err.message : '减员失败'); } finally { setBusy(false); } };
  return <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`减员清算 · ${order.holdNo}`} tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}><div className="w-full max-w-md rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}><div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">减员清算 · {order.holdNo}</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div><div className="space-y-4 px-5 py-4"><p className="text-sm text-ink-muted">当前占位余座 {available}，尾款确认后免损额度作废。</p><input className="input" type="number" min={1} max={available} value={seats} onChange={(e) => { setSeats(Number(e.target.value)); setPreview(null); }} /><textarea className="input min-h-20" value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（选填）" />{preview && <div className="rounded bg-slate-50 p-3 text-sm"><div>免损 {preview.freeSeats} 座 · 扣损 {preview.forfeitSeats} 座</div><div>没收 ¥{preview.forfeitCny.toLocaleString()} · 转抵 ¥{preview.creditCny.toLocaleString()} · 挂账 ¥{preview.surplusCny.toLocaleString()}</div></div>}{error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}<div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button>{preview ? <button className="btn-primary" disabled={busy} onClick={() => void confirm()}>确认执行</button> : <button className="btn-primary" disabled={busy || seats < 1 || seats > available} onClick={() => void loadPreview()}>试算清算</button>}</div></div></div></div>;
}

function ConfigModal({ config, token, onCancel, onDone }: { config: HoldOrderConfig; token: string; onCancel: () => void; onDone: (config: HoldOrderConfig) => void }) {
  const dialogRef = useDialogA11y(onCancel);
  const [rows, setRows] = useState(config.installments);
  const [action, setAction] = useState(config.overdueAction);
  const [ratio, setRatio] = useState(config.defaultFreeCancelRatio * 100);
  const [error, setError] = useState<string | null>(null);
  const save = async () => { if (rows.length < 1 || rows.length > 6 || rows.filter((r) => r.amountRule === 'REMAINDER').length !== 1 || rows[rows.length - 1].amountRule !== 'REMAINDER' || ratio < 0 || ratio > 50) { setError('模板需 1-6 期，尾款恰好一期且在最后，免损比例 0-50%'); return; } try { const result = await api.updateHoldOrderConfig(token, { installments: rows, overdueAction: action, defaultFreeCancelRatio: ratio / 100 }); onDone(result.config); } catch (err) { setError(err instanceof Error ? err.message : '保存模板失败'); } };
  return <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="收款模板设置" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}><div className="w-full max-w-2xl rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}><div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">收款模板设置</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div><div className="space-y-3 px-5 py-4"><div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr><th className="text-left">名称</th><th className="text-left">金额规则</th><th>每人金额</th><th>起飞前天数</th><th></th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><td><input className="input h-8" value={row.label} onChange={(e) => setRows((old) => old.map((r, i) => i === index ? { ...r, label: e.target.value } : r))} /></td><td><select className="input h-8" value={row.amountRule} onChange={(e) => setRows((old) => old.map((r, i) => i === index ? { ...r, amountRule: e.target.value as 'PER_PERSON_FIXED' | 'REMAINDER', perPersonCny: e.target.value === 'REMAINDER' ? undefined : r.perPersonCny ?? 0 } : r))}><option value="PER_PERSON_FIXED">每人固定</option><option value="REMAINDER">尾款余款</option></select></td><td><input className="input h-8 w-24" type="number" disabled={row.amountRule === 'REMAINDER'} value={row.perPersonCny ?? ''} onChange={(e) => setRows((old) => old.map((r, i) => i === index ? { ...r, perPersonCny: Number(e.target.value) } : r))} /></td><td><input className="input h-8 w-24" type="number" min={0} value={row.dueOffsetDays ?? ''} onChange={(e) => setRows((old) => old.map((r, i) => i === index ? { ...r, dueOffsetDays: e.target.value === '' ? null : Number(e.target.value) } : r))} /></td><td><button className="btn-ghost-danger text-xs" disabled={rows.length <= 1} onClick={() => setRows((old) => old.filter((_, i) => i !== index))}>删除</button></td></tr>)}</tbody></table></div><button className="btn-secondary text-xs" disabled={rows.length >= 6} onClick={() => setRows((old) => [...old, { label: '新收款期', amountRule: 'REMAINDER', dueOffsetDays: 0 }])}>+ 添加一期</button><div className="grid gap-3 sm:grid-cols-2"><div><label className="label">逾期动作</label><select className="input" value={action} onChange={(e) => setAction(e.target.value as 'REMIND_ONLY' | 'AUTO_RELEASE')}><option value="REMIND_ONLY">标记逾期并提醒</option><option value="AUTO_RELEASE">自动释放</option></select></div><div><label className="label">默认免损比例（%）</label><input className="input" type="number" min={0} max={50} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} /></div></div>{error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}<div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" onClick={() => void save()}>保存</button></div></div></div></div>;
}

function PriceModal({ order, onCancel, onSubmit }: { order: HoldOrderListItem; onCancel: () => void; onSubmit: (price: number, reason: string) => Promise<void> }) {
  const dialogRef = useDialogA11y(onCancel);
  const [price, setPrice] = useState(order.perSeatPriceCny);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (price < 0 || !reason.trim()) { setError('新价和改价原因均为必填'); return; }
    try { await onSubmit(price, reason.trim()); } catch (err) { setError(err instanceof Error ? err.message : '改价失败'); }
  };
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="调整锁定结算价" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">调整锁定结算价</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div>
        <div className="space-y-4 px-5 py-4"><p className="text-sm text-ink-muted">占位单 {order.holdNo} · 原价 ¥{order.perSeatPriceCny}/人</p><div><label className="label">新价（元/人）</label><input className="input" type="number" min={0} value={price} onChange={(e) => setPrice(Number(e.target.value))} /></div><div><label className="label">改价原因（必填）</label><textarea className="input min-h-24" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></div>{error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}<div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" onClick={() => void submit()}>保存改价</button></div></div>
      </div>
    </div>
  );
}

function InfoModal({ order, agents, onCancel, onSubmit }: { order: HoldOrderListItem; agents: AgentListItem[]; onCancel: () => void; onSubmit: (groupName: string, notes: string, agentId: string) => Promise<void> }) {
  const dialogRef = useDialogA11y(onCancel);
  const [groupName, setGroupName] = useState(order.groupName ?? '');
  const [notes, setNotes] = useState(order.notes ?? '');
  const [agentId, setAgentId] = useState(order.agentId ?? '');
  const [error, setError] = useState<string | null>(null);
  // 当前归属的代理可能已停用而不在可选列表里：补一个占位选项，避免下拉显示成空白。
  const currentAgentMissing = order.ownerType === 'AGENT' && !!order.agentId && !agents.some((a) => a.id === order.agentId);
  const agentChanged = order.ownerType === 'AGENT' && agentId !== (order.agentId ?? '');
  const submit = async () => {
    if (order.ownerType === 'CUSTOMER' && !groupName.trim()) { setError('直客占位团名不能清空'); return; }
    if (order.ownerType === 'AGENT' && !agentId) { setError('代理占位必须选择归属代理'); return; }
    try { await onSubmit(groupName.trim(), notes.trim(), agentId); } catch (err) { setError(err instanceof Error ? err.message : '保存失败'); }
  };
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="编辑占位单" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3"><h2 className="text-lg font-semibold">编辑占位单</h2><button onClick={onCancel} className="text-xl text-slate-400">×</button></div>
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-ink-muted">占位单 {order.holdNo}</p>
          {order.ownerType === 'AGENT' && (
            <div>
              <label className="label">归属代理</label>
              <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {currentAgentMissing && <option value={order.agentId!}>{order.agent ? `${order.agent.companyName?.trim() || order.agent.contactName}（已停用）` : '当前代理（已停用）'}</option>}
                {agents.map((a) => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}
              </select>
              {agentChanged && order.seatsConverted > 0 && (
                <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">已转正的 {order.seatsConverted} 座不会跟着变更；如需调整，请到订单页用「批量改代理」处理对应正式订单。</p>
              )}
            </div>
          )}
          <div><label className="label">团名{order.ownerType === 'CUSTOMER' ? '（必填）' : ''}</label><input className="input" maxLength={120} value={groupName} onChange={(e) => setGroupName(e.target.value)} /></div>
          <div><label className="label">备注</label><textarea className="input min-h-24" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          {error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
          <div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onCancel}>取消</button><button className="btn-primary" onClick={() => void submit()}>保存</button></div>
        </div>
      </div>
    </div>
  );
}
