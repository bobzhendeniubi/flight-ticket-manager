import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, type CabinClass, type FlightSearchResult } from '../lib/api';
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
            <h3 className="mt-1 font-semibold text-slate-900">签约精选酒店</h3>
            <p className="mt-1 text-slate-600">四季 / 洲际 / 凯悦 / 铂尔曼，8 家核心酒店直签价</p>
          </div>
          <div>
            <div className="text-3xl">🚘</div>
            <h3 className="mt-1 font-semibold text-slate-900">中文司机接送</h3>
            <p className="mt-1 text-slate-600">机场接送、会安 / 巴拿山 / 顺化包车，沟通无忧</p>
          </div>
          <div>
            <div className="text-3xl">🛂</div>
            <h3 className="mt-1 font-semibold text-slate-900">越南签证代办</h3>
            <p className="mt-1 text-slate-600">E-visa / 落地签 / 1 年多次商务签，3–5 天出签</p>
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
  const dateRank = flight.seatClasses[0]?.dateRank ?? 'C';

  return (
    <article className="card hover:shadow-md transition">
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center rounded bg-brand/10 px-2 py-0.5 text-sm font-semibold text-brand">
            {flight.flightNumber}
          </span>
          <span className="text-xs text-slate-500">{flight.aircraftType ?? ''}</span>
        </div>

        <div className="flex items-center gap-4">
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

        <div className="ml-auto text-right">
          <span className={`rounded px-1.5 py-0.5 text-xs font-bold mr-1 ${
            dateRank === 'A' ? 'bg-red-100 text-red-700' :
            dateRank === 'B' ? 'bg-amber-100 text-amber-700' :
            dateRank === 'C' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
          }`}>{dateRank}</span>
          {minPrice !== null && (
            <div className="mt-1 text-lg font-semibold text-red-600">
              ¥{minPrice.toFixed(0)} <span className="text-xs text-slate-500 font-normal">起</span>
            </div>
          )}
          <div className="mt-1 text-xs text-slate-500">↓ 选舱位加入购物车</div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
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

function FlightSeatCard({
  flight,
  cabin,
  passengers,
  isLoggedIn: _isLoggedIn,
}: {
  flight: FlightSearchResult;
  cabin: FlightSearchResult['seatClasses'][number];
  passengers: number;
  isLoggedIn: boolean;
}) {
  const add = useCart((s) => s.add);
  const enough = cabin.available >= passengers;
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
      <div className="mt-1 text-xs text-slate-500">余票 {cabin.available} / {cabin.capacity}</div>
      <button
        className="btn-primary mt-2 w-full text-xs py-1"
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
              dateRank: cabin.dateRank,
              basePrice: Number(cabin.basePrice),
              totalForQty: cabin.totalForQty,
            },
          });
        }}
      >
        {enough ? `+ 加购 ${passengers} 张` : '余票不足'}
      </button>
    </div>
  );
}
