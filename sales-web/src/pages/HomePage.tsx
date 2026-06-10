import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, type AvailabilityTier, type CabinClass, type FlightSearchResult } from '../lib/api';
import {
  AIRPORT_OPTIONS,
  CABIN_LABEL,
  airportLabel,
  formatDuration,
  formatLocalDate,
  formatLocalTime,
} from '../lib/airports';
import { DANANG_HIGHLIGHTS } from '../lib/mockData';
import { useAuth } from '../stores/auth';
import { useCart } from '../stores/cart';

function todayISO(offsetDays = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function HomePage() {
  const user = useAuth((s) => s.user);

  // 默认主航线：澳门 → 岘港
  const [tripType, setTripType] = useState<'oneway' | 'roundtrip'>('roundtrip');
  const [origin, setOrigin] = useState('MFM');
  const [destination, setDestination] = useState('DAD');
  const [date, setDate] = useState(todayISO(3));
  const [returnDate, setReturnDate] = useState(todayISO(7));
  const [cabin, setCabin] = useState<'' | CabinClass>('');
  const [passengers, setPassengers] = useState(1);

  type SearchResultWithLeg = FlightSearchResult & { _leg?: '去程' | '回程' };
  const [results, setResults] = useState<SearchResultWithLeg[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.searchFlights({ passengers: 1 });
        setResults(res.results);
      } catch {
        // 静默
      }
    })();
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setHasSearched(true);
    try {
      // 去程
      const outbound = await api.searchFlights({
        origin: origin || undefined,
        destination: destination || undefined,
        date: date || undefined,
        cabin: cabin || undefined,
        passengers,
      });
      const combined: SearchResultWithLeg[] = outbound.results.map((r) => ({ ...r, _leg: '去程' }));

      // 往返 → 也搜回程
      if (tripType === 'roundtrip' && returnDate) {
        const inbound = await api.searchFlights({
          origin: destination || undefined,
          destination: origin || undefined,
          date: returnDate,
          cabin: cabin || undefined,
          passengers,
        });
        combined.push(...inbound.results.map((r) => ({ ...r, _leg: '回程' as const })));
      }
      setResults(combined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '搜索失败');
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const swap = () => {
    setOrigin(destination);
    setDestination(origin);
  };

  return (
    <div className="space-y-6">
      {/* Hero */}
      <section className="rounded-xl bg-gradient-to-br from-sky-500 to-emerald-500 p-8 text-white shadow-sm">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 text-sm text-sky-50">
            <span>✈️ 澳门出发</span>
            <span>·</span>
            <span>🇻🇳 岘港专线</span>
          </div>
          <h1 className="mt-2 text-3xl font-bold md:text-4xl">
            {user ? `${user.displayName ?? user.email}，您好` : '世途旅行 Citur Travel · 澳门直飞岘港'}
          </h1>
          <p className="mt-2 text-sky-50">
            自营 QH9588 / QH9589 澳门 ↔ 岘港直飞航班，每天 1 班，机票 + 酒店 + 接送 + 签证一站搞定。
          </p>
          <p className="mt-1 text-xs text-sky-100/80">
            * 内地及香港旅客可经珠海/深圳口岸 30 分钟巴士抵达澳门机场出发
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-sm">
            <span className="rounded-full bg-white/20 px-3 py-1 backdrop-blur">🏝️ 美溪海滩</span>
            <span className="rounded-full bg-white/20 px-3 py-1 backdrop-blur">🌉 巴拿山</span>
            <span className="rounded-full bg-white/20 px-3 py-1 backdrop-blur">🏮 会安古城</span>
            <span className="rounded-full bg-white/20 px-3 py-1 backdrop-blur">💆 全别墅度假</span>
          </div>
        </div>
      </section>

      {/* 搜索表单 */}
      <section className="card">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-slate-900">航班搜索</h2>
          <div className="flex rounded-md border border-slate-300 overflow-hidden text-sm">
            <button
              type="button"
              className={`px-3 py-1.5 ${tripType === 'roundtrip' ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
              onClick={() => setTripType('roundtrip')}
            >
              往返
            </button>
            <button
              type="button"
              className={`px-3 py-1.5 ${tripType === 'oneway' ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
              onClick={() => setTripType('oneway')}
            >
              单程
            </button>
          </div>
        </div>
        <form className="mt-4 grid gap-4 md:grid-cols-12" onSubmit={onSubmit}>
          <div className="md:col-span-3">
            <label className="label" htmlFor="origin">出发</label>
            <select id="origin" className="input" value={origin} onChange={(e) => setOrigin(e.target.value)}>
              <option value="">全部</option>
              {AIRPORT_OPTIONS.filter((a) => a.active).map((a) => (
                <option key={a.code} value={a.code}>
                  {a.name} ({a.code}){a.country ? ` · ${a.country}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-1 flex items-end justify-center">
            <button
              type="button"
              aria-label="互换城市"
              className="btn-secondary text-xl leading-none h-10 px-3"
              onClick={swap}
              title="互换"
            >
              ⇌
            </button>
          </div>
          <div className="md:col-span-3">
            <label className="label" htmlFor="destination">到达</label>
            <select
              id="destination"
              className="input"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="">全部</option>
              {AIRPORT_OPTIONS.filter((a) => a.active).map((a) => (
                <option key={a.code} value={a.code}>
                  {a.name} ({a.code}){a.country ? ` · ${a.country}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className={tripType === 'roundtrip' ? 'md:col-span-2' : 'md:col-span-2'}>
            <label className="label" htmlFor="date">
              {tripType === 'roundtrip' ? '去程日期' : '出发日期'}
            </label>
            <input id="date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {tripType === 'roundtrip' && (
            <div className="md:col-span-2">
              <label className="label" htmlFor="returnDate">回程日期</label>
              <input
                id="returnDate"
                type="date"
                className="input"
                value={returnDate}
                min={date}
                onChange={(e) => setReturnDate(e.target.value)}
              />
            </div>
          )}
          <div className={tripType === 'roundtrip' ? 'md:col-span-1' : 'md:col-span-2'}>
            <label className="label" htmlFor="cabin">舱等</label>
            <select
              id="cabin"
              className="input"
              value={cabin}
              onChange={(e) => setCabin(e.target.value as '' | CabinClass)}
            >
              <option value="">不限</option>
              {Object.entries(CABIN_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-1">
            <label className="label" htmlFor="passengers">人数</label>
            <input
              id="passengers"
              type="number"
              min={1}
              max={9}
              className="input"
              value={passengers}
              onChange={(e) => setPassengers(Number(e.target.value) || 1)}
            />
          </div>
          <div className="md:col-span-12 flex justify-end">
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? '搜索中…' : '搜索航班'}
            </button>
          </div>
        </form>
      </section>

      {/* 航班结果 */}
      <section className="space-y-3">
        {error && (
          <div className="card border-red-200 bg-red-50 text-sm text-red-700">{error}</div>
        )}

        {results && results.length === 0 && (
          <div className="card text-slate-600">
            {hasSearched ? '没有符合条件的航班，换个日期或航线试试。' : '暂无可售航班，请先由管理员添加班次。'}
          </div>
        )}

        {results && results.length > 0 && (
          <>
            <p className="text-sm text-slate-500">
              {tripType === 'roundtrip' ? '往返' : '单程'} · 共 {results.length} 个班次
            </p>
            <div className="space-y-3">
              {/* 按去程/回程分组显示 */}
              {tripType === 'roundtrip' && results.some((r) => r._leg === '去程') && (
                <div className="flex items-center gap-2 text-sm font-semibold text-brand mt-2">
                  <span className="rounded bg-brand/10 px-2 py-0.5">✈ 去程</span>
                  <span className="text-slate-500 font-normal">{origin} → {destination} · {date}</span>
                </div>
              )}
              {results.filter((r) => r._leg !== '回程').map((r) => (
                <FlightCard key={r.scheduleId} flight={r} passengers={passengers} isLoggedIn={!!user} />
              ))}
              {tripType === 'roundtrip' && results.some((r) => r._leg === '回程') && (
                <>
                  <div className="flex items-center gap-2 text-sm font-semibold text-brand mt-4">
                    <span className="rounded bg-brand/10 px-2 py-0.5">✈ 回程</span>
                    <span className="text-slate-500 font-normal">{destination} → {origin} · {returnDate}</span>
                  </div>
                  {results.filter((r) => r._leg === '回程').map((r) => (
                    <FlightCard key={r.scheduleId} flight={r} passengers={passengers} isLoggedIn={!!user} />
                  ))}
                </>
              )}
            </div>
          </>
        )}

        {results === null && <div className="card text-slate-500">正在加载…</div>}
      </section>

      {/* 岘港亮点 */}
      <section>
        <div className="flex items-end justify-between">
          <h2 className="text-xl font-bold text-slate-900">岘港必玩</h2>
          <p className="text-xs text-slate-500">一个行程一次打卡</p>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {DANANG_HIGHLIGHTS.map((h) => (
            <div key={h.title} className="card hover:shadow-md transition">
              <div className="text-4xl">{h.emoji}</div>
              <h3 className="mt-2 font-semibold text-slate-900">{h.title}</h3>
              <p className="mt-1 text-sm text-slate-600">{h.description}</p>
              <span className="mt-3 inline-block rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                {h.tag}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* 打包优势 */}
      <section className="card bg-slate-50">
        <h2 className="text-lg font-bold text-slate-900">为什么选我们</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-4 text-sm">
          <div>
            <div className="text-3xl">✈️</div>
            <h3 className="mt-1 font-semibold text-slate-900">自营直飞航班</h3>
            <p className="mt-1 text-slate-600">QH9588/9589 澳门 ↔ 岘港直飞 1h45m，每天 1 班</p>
          </div>
          <div>
            <div className="text-3xl">🏨</div>
            <h3 className="mt-1 font-semibold text-slate-900">酒店预订</h3>
            <p className="mt-1 text-slate-600">直签合作酒店覆盖东南亚 / 中国港澳 / 全球主要城市</p>
          </div>
          <div>
            <div className="text-3xl">🚘</div>
            <h3 className="mt-1 font-semibold text-slate-900">机场接送 / 包车</h3>
            <p className="mt-1 text-slate-600">中文司机点对点、一日游包车，航班延误自动顺延</p>
          </div>
          <div>
            <div className="text-3xl">🛂</div>
            <h3 className="mt-1 font-semibold text-slate-900">签证代办</h3>
            <p className="mt-1 text-slate-600">东南亚 / 东北亚 / 申根，全程线上提交，最快 2 天出签</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function FlightCard({
  flight,
  passengers,
  isLoggedIn,
}: {
  flight: FlightSearchResult;
  passengers: number;
  isLoggedIn: boolean;
}) {
  const minPrice = flight.seatClasses
    .filter((c) => c.available >= passengers)
    .reduce((m, c) => (m === null || Number(c.dynamicPrice) < m ? Number(c.dynamicPrice) : m), null as number | null);
  // dateRank A/B/C/D 是公司内部日期等级，绝不展示给客户。仅用 basePrice 与 dynamicPrice 的差额
  // 反映"相对优惠"。
  const baseMin = flight.seatClasses
    .filter((c) => c.available >= passengers)
    .reduce((m, c) => (m === null || Number(c.basePrice) < m ? Number(c.basePrice) : m), null as number | null);
  const isDeal = baseMin !== null && minPrice !== null && minPrice < baseMin * 0.95;

  return (
    <article className="card hover:shadow-md transition">
      {/* 顶部行：航班号 + 价格（手机端两端对齐，桌面端航班号靠左、其它信息后面跟） */}
      <div className="flex items-start justify-between gap-3 sm:flex-wrap sm:items-center sm:gap-6">
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <span className="inline-flex items-center rounded bg-brand/10 px-2 py-0.5 text-sm font-semibold text-brand">
            {flight.flightNumber}
          </span>
          <span className="hidden sm:inline text-xs text-slate-500">{flight.aircraftType ?? ''}</span>
        </div>

        {/* 时间块：手机端单独占一行（在下面），桌面端在中间 */}
        <div className="hidden sm:flex items-center gap-4">
          <div>
            <div className="text-2xl font-semibold text-slate-900">
              {formatLocalTime(flight.departureTime, flight.departureTz)}
            </div>
            <div className="text-xs text-slate-500">
              {airportLabel(flight.originCode)} · {formatLocalDate(flight.departureTime, flight.departureTz)}
            </div>
          </div>

          <div className="text-center text-xs text-slate-500">
            <div>{formatDuration(flight.durationMinutes)}</div>
            <div className="my-1 h-px w-24 bg-slate-300" />
            <div>直飞</div>
          </div>

          <div>
            <div className="text-2xl font-semibold text-slate-900">
              {formatLocalTime(flight.arrivalTime, flight.arrivalTz)}
            </div>
            <div className="text-xs text-slate-500">
              {airportLabel(flight.destinationCode)} · {formatLocalDate(flight.arrivalTime, flight.arrivalTz)}
            </div>
          </div>
        </div>

        <div className="sm:ml-auto text-right flex-shrink-0">
          {isDeal && (
            <span className="inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-700">
              限时优惠
            </span>
          )}
          {minPrice !== null && (
            <div className="mt-1 text-lg font-semibold text-red-600">
              ¥{minPrice.toFixed(0)} <span className="text-xs text-slate-500 font-normal">起</span>
            </div>
          )}
          <div className="mt-1 text-xs text-slate-500 hidden sm:block">↓ 选舱位加入购物车</div>
        </div>
      </div>

      {/* 手机端时间行：DEP — DUR — ARR 紧凑布局 */}
      <div className="sm:hidden mt-3 flex items-center justify-between gap-2">
        <div className="text-left">
          <div className="text-xl font-semibold text-slate-900">
            {formatLocalTime(flight.departureTime, flight.departureTz)}
          </div>
          <div className="text-[10px] text-slate-500">
            {airportLabel(flight.originCode)}
          </div>
        </div>
        <div className="flex-1 text-center text-[10px] text-slate-400">
          <div>{formatDuration(flight.durationMinutes)}</div>
          <div className="my-1 h-px bg-slate-200" />
          <div>直飞</div>
        </div>
        <div className="text-right">
          <div className="text-xl font-semibold text-slate-900">
            {formatLocalTime(flight.arrivalTime, flight.arrivalTz)}
          </div>
          <div className="text-[10px] text-slate-500">
            {airportLabel(flight.destinationCode)}
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 grid-cols-2 lg:grid-cols-4">
        {flight.seatClasses.map((c) => (
          <FlightSeatCard
            key={c.cabin}
            flight={flight}
            cabin={c}
            passengers={passengers}
            isLoggedIn={isLoggedIn}
          />
        ))}
      </div>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────
// 余位档位徽章 — 买家只看档位不看精确余票数（档位口径由服务端
// computeAvailabilityTier 统一；available/capacity 仍在 payload 里，
// 但仅用于禁用/上限等内部逻辑，绝不渲染给买家）。
// ─────────────────────────────────────────────────────────────────
const TIER_LABEL: Record<AvailabilityTier, string> = {
  AMPLE: '余位充足',
  TIGHT: '余位紧张',
  LOW: '余位少量',
  VERY_LOW: '余位极少量',
  SOLD_OUT: '已售罄',
};
const TIER_CLASS: Record<AvailabilityTier, string> = {
  AMPLE: 'bg-emerald-100 text-emerald-700',
  TIGHT: 'bg-sky-100 text-sky-700',
  LOW: 'bg-amber-100 text-amber-800',
  VERY_LOW: 'bg-orange-100 text-orange-700',
  SOLD_OUT: 'bg-slate-100 text-rose-600',
};

function FlightSeatCard({
  flight,
  cabin,
  passengers,
  isLoggedIn,
}: {
  flight: FlightSearchResult;
  cabin: FlightSearchResult['seatClasses'][number];
  passengers: number;
  isLoggedIn: boolean;
}) {
  const add = useCart((s) => s.add);
  const token = useAuth((s) => s.tokens?.accessToken ?? '');
  const enough = cabin.available >= passengers;
  const soldOut = cabin.availabilityTier === 'SOLD_OUT' || cabin.available <= 0;

  // ── 锁位（下单前临时占座：单次 ≤9 张 / 固定 10 分钟 / 到期自动回收） ──
  const maxLockQty = Math.min(9, cabin.available);
  const [lockOpen, setLockOpen] = useState(false);
  const [lockQty, setLockQty] = useState(1);
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [activeLock, setActiveLock] = useState<{ qty: number; expiresAt: string } | null>(null);

  const confirmLock = async () => {
    // seatClassId 是新加字段 —— 老缓存/异常数据可能缺失，缺了直接提示而不是打 API
    if (!cabin.seatClassId) {
      setLockError('该舱位暂不支持锁位');
      return;
    }
    setLocking(true);
    setLockError(null);
    try {
      const r = await api.createSeatLock(token, {
        flightScheduleId: flight.scheduleId,
        seatClassId: cabin.seatClassId,
        qty: lockQty,
      });
      // 同卡片多次锁 → 累计张数，倒计时以最新一次锁位为基准
      setActiveLock((prev) => ({ qty: (prev?.qty ?? 0) + r.lock.qty, expiresAt: r.lock.expiresAt }));
      setLockOpen(false);
    } catch (err) {
      // 409（同舱超 9 张 / 余票不足）等 → 原样展示服务端 message
      setLockError(err instanceof ApiError ? err.message : '锁位失败，请稍后再试');
    } finally {
      setLocking(false);
    }
  };

  // ── 候补登记（售罄时替代锁位：1-9 张 + 手机号，有位运营按先来先到通知） ──
  const [wlOpen, setWlOpen] = useState(false);
  const [wlQty, setWlQty] = useState(1);
  const [wlPhone, setWlPhone] = useState('');
  const [wlSubmitting, setWlSubmitting] = useState(false);
  const [wlError, setWlError] = useState<string | null>(null);
  const [wlDone, setWlDone] = useState(false);

  const submitWaitlist = async () => {
    // seatClassId 老缓存/异常数据可能缺失 —— 缺了直接提示而不是打 API（同锁位）
    if (!cabin.seatClassId) {
      setWlError('该舱位暂不支持候补');
      return;
    }
    if (!wlPhone.trim()) {
      setWlError('请填写联系手机号');
      return;
    }
    setWlSubmitting(true);
    setWlError(null);
    try {
      await api.createWaitlist(token, {
        flightScheduleId: flight.scheduleId,
        seatClassId: cabin.seatClassId,
        qty: wlQty,
        contactPhone: wlPhone.trim(),
      });
      setWlDone(true);
      setWlOpen(false);
    } catch (err) {
      // 409（重复登记）/ 400（余票充足）等 → 原样展示服务端 message
      setWlError(err instanceof ApiError ? err.message : '候补登记失败，请稍后再试');
    } finally {
      setWlSubmitting(false);
    }
  };

  return (
    <div
      className={`rounded-md border px-3 py-2 text-sm ${
        enough ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50 text-slate-400'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-slate-700">{CABIN_LABEL[cabin.cabin] ?? cabin.cabin}</span>
        <div className="text-right">
          {Number(cabin.dynamicPrice) !== Number(cabin.basePrice) && (
            <span className="text-xs text-slate-400 line-through mr-1">¥{Number(cabin.basePrice).toFixed(0)}</span>
          )}
          <span className="font-semibold text-red-600">¥{Number(cabin.dynamicPrice).toFixed(0)}</span>
        </div>
      </div>
      {/* 买家只看档位徽章 —— 精确余票数（available/capacity）仅内部用于禁用逻辑 */}
      <div className="mt-1">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${TIER_CLASS[cabin.availabilityTier]}`}
        >
          {TIER_LABEL[cabin.availabilityTier]}
        </span>
      </div>
      <div className="mt-2 flex gap-1.5">
      <button
        className="btn-primary flex-1 text-xs py-1"
        disabled={!enough}
        onClick={() => {
          // 使用 totalForQty 精确总价（服务端 per-seat 累加），避免 round(avg)*qty 造成 1-2 元舍入差
          add({
            kind: 'FLIGHT',
            productId: flight.scheduleId,
            name: `${flight.flightNumber} ${flight.originCode}→${flight.destinationCode} · ${CABIN_LABEL[cabin.cabin]} × ${passengers}`,
            description: `${formatLocalDate(flight.departureTime, flight.departureTz)} ${formatLocalTime(flight.departureTime, flight.departureTz)}`,
            emoji: '✈️',
            unitPrice: cabin.totalForQty,
            qty: 1, // 用 qty=1 + unitPrice=totalForQty 保证精确金额
            meta: {
              departureTime: flight.departureTime,
              cabin: cabin.cabin,
              passengers,
              // dateRank 是内部字段，不放进 cart meta（之前 CartPage 曾把它显示给客户）
              basePrice: Number(cabin.basePrice),
              totalForQty: cabin.totalForQty,
            },
          });
        }}
      >
        {soldOut ? '已售罄' : enough ? `+ 加购 ${passengers} 张` : '余票不足'}
      </button>
      {isLoggedIn && !soldOut && (
        <button
          type="button"
          className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={maxLockQty < 1}
          title="先占座 10 分钟，收齐乘客姓名再下单"
          onClick={() => {
            setLockError(null);
            setLockQty(Math.min(Math.max(1, passengers), maxLockQty));
            setLockOpen((v) => !v);
          }}
        >
          🔒 锁位
        </button>
      )}
      {isLoggedIn && soldOut && !wlDone && (
        <button
          type="button"
          className="rounded-md border border-sky-300 bg-sky-50 px-2 py-1 text-xs text-sky-700 hover:bg-sky-100"
          title="留下手机号，座位释放后按先来先到通知"
          onClick={() => {
            setWlError(null);
            setWlQty(Math.min(Math.max(1, passengers), 9));
            setWlOpen((v) => !v);
          }}
        >
          🕐 候补登记
        </button>
      )}
      </div>
      {isLoggedIn && lockOpen && (
        <div className="mt-1.5 space-y-1.5 rounded-md border border-amber-200 bg-amber-50/60 p-2">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>锁定张数 · 10 分钟 · 最多可锁 {maxLockQty} 张</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="减少锁定张数"
                className="h-5 w-5 rounded border border-slate-300 bg-white leading-none text-slate-600 disabled:opacity-40"
                disabled={lockQty <= 1}
                onClick={() => setLockQty((q) => Math.max(1, q - 1))}
              >
                −
              </button>
              <span className="w-5 text-center font-semibold tabular-nums text-slate-800">{lockQty}</span>
              <button
                type="button"
                aria-label="增加锁定张数"
                className="h-5 w-5 rounded border border-slate-300 bg-white leading-none text-slate-600 disabled:opacity-40"
                disabled={lockQty >= maxLockQty}
                onClick={() => setLockQty((q) => Math.min(maxLockQty, q + 1))}
              >
                +
              </button>
            </div>
          </div>
          {lockError && <div className="text-xs text-red-600">{lockError}</div>}
          <div className="flex gap-1.5">
            <button
              type="button"
              className="flex-1 rounded-md bg-amber-500 px-2 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
              disabled={locking}
              onClick={confirmLock}
            >
              {locking ? '锁定中…' : `确认锁 ${lockQty} 张`}
            </button>
            <button
              type="button"
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
              disabled={locking}
              onClick={() => setLockOpen(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {isLoggedIn && soldOut && wlOpen && !wlDone && (
        <div className="mt-1.5 space-y-1.5 rounded-md border border-sky-200 bg-sky-50/60 p-2">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>候补张数 · 1-9 张</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="减少候补张数"
                className="h-5 w-5 rounded border border-slate-300 bg-white leading-none text-slate-600 disabled:opacity-40"
                disabled={wlQty <= 1}
                onClick={() => setWlQty((q) => Math.max(1, q - 1))}
              >
                −
              </button>
              <span className="w-5 text-center font-semibold tabular-nums text-slate-800">{wlQty}</span>
              <button
                type="button"
                aria-label="增加候补张数"
                className="h-5 w-5 rounded border border-slate-300 bg-white leading-none text-slate-600 disabled:opacity-40"
                disabled={wlQty >= 9}
                onClick={() => setWlQty((q) => Math.min(9, q + 1))}
              >
                +
              </button>
            </div>
          </div>
          <input
            type="tel"
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 placeholder:text-slate-400"
            placeholder="联系手机号（有位通知你）"
            value={wlPhone}
            maxLength={32}
            onChange={(e) => setWlPhone(e.target.value)}
          />
          {wlError && <div className="text-xs text-red-600">{wlError}</div>}
          <div className="flex gap-1.5">
            <button
              type="button"
              className="flex-1 rounded-md bg-sky-500 px-2 py-1 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50"
              disabled={wlSubmitting}
              onClick={submitWaitlist}
            >
              {wlSubmitting ? '提交中…' : `登记候补 ${wlQty} 张`}
            </button>
            <button
              type="button"
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
              disabled={wlSubmitting}
              onClick={() => setWlOpen(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {wlDone && (
        <div className="mt-1.5 rounded-md bg-sky-100 px-2 py-1 text-center text-xs font-medium text-sky-800">
          ✓ 已登记候补，有位会通知你
        </div>
      )}
      {activeLock && (
        <SeatLockChip
          qty={activeLock.qty}
          expiresAt={activeLock.expiresAt}
          onExpire={() => setActiveLock(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SeatLockChip — 卡片上的锁位倒计时（mm:ss）。
// 计时方式同 CheckoutPage 的 HoldCountdown：1s setInterval + useEffect 清理。
// 倒计时归零 → onExpire 让父组件收起 chip（座位已由服务端自动回收）。
// ─────────────────────────────────────────────────────────────────
function SeatLockChip({
  qty,
  expiresAt,
  onExpire,
}: {
  qty: number;
  expiresAt: string;
  onExpire: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const leftMs = Math.max(0, new Date(expiresAt).getTime() - now);
  useEffect(() => {
    if (leftMs === 0) onExpire();
  }, [leftMs, onExpire]);
  if (leftMs === 0) return null;
  const mm = Math.floor(leftMs / 60000);
  const ss = Math.floor((leftMs % 60000) / 1000);
  return (
    <div className="mt-1.5 flex items-center justify-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800">
      🔒 已锁{qty}张{' '}
      <strong className="font-mono tabular-nums">
        {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
      </strong>
    </div>
  );
}
