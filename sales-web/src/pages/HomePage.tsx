import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type CabinClass, type FlightSearchResult } from '../lib/api';
import {
  AIRPORT_OPTIONS,
  CABIN_LABEL,
  airportLabel,
  formatDuration,
  formatLocalDate,
  formatLocalTime,
} from '../lib/airports';
import { useAuth } from '../stores/auth';

function todayISO(offsetDays = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function HomePage() {
  const user = useAuth((s) => s.user);

  const [origin, setOrigin] = useState('PEK');
  const [destination, setDestination] = useState('PVG');
  const [date, setDate] = useState(todayISO(3));
  const [cabin, setCabin] = useState<'' | CabinClass>('');
  const [passengers, setPassengers] = useState(1);

  const [results, setResults] = useState<FlightSearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // 首次加载：用默认条件预热一下 UI（不阻塞）
  useEffect(() => {
    (async () => {
      try {
        const res = await api.searchFlights({ passengers: 1 });
        setResults(res.results);
      } catch {
        // 静默，进页面再重新搜
      }
    })();
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setHasSearched(true);
    try {
      const res = await api.searchFlights({
        origin: origin || undefined,
        destination: destination || undefined,
        date: date || undefined,
        cabin: cabin || undefined,
        passengers,
      });
      setResults(res.results);
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
      <section className="card">
        <h1 className="text-2xl font-bold text-slate-900">
          {user ? `${user.displayName ?? user.email}，您好` : '机票管家'}
        </h1>
        <p className="mt-2 text-slate-600">
          搜索我们自营的国内航线，支持多级代理下单、预付款抵扣和管理员实时调价。
        </p>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold text-slate-900">航班搜索</h2>
        <form className="mt-4 grid gap-4 md:grid-cols-12" onSubmit={onSubmit}>
          <div className="md:col-span-3">
            <label className="label" htmlFor="origin">出发</label>
            <select
              id="origin"
              className="input"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
            >
              <option value="">全部</option>
              {AIRPORT_OPTIONS.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.name} ({a.code})
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
              {AIRPORT_OPTIONS.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.name} ({a.code})
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="date">出发日期</label>
            <input
              id="date"
              type="date"
              className="input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="md:col-span-2">
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
            <p className="text-sm text-slate-500">共 {results.length} 个班次</p>
            <div className="space-y-3">
              {results.map((r) => (
                <FlightCard key={r.scheduleId} flight={r} passengers={passengers} isLoggedIn={!!user} />
              ))}
            </div>
          </>
        )}

        {results === null && (
          <div className="card text-slate-500">正在加载…</div>
        )}
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
    .reduce((m, c) => (m === null || Number(c.basePrice) < m ? Number(c.basePrice) : m), null as number | null);

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
          {minPrice !== null && (
            <div className="text-lg font-semibold text-red-600">
              ¥{minPrice.toFixed(0)} <span className="text-xs text-slate-500 font-normal">起</span>
            </div>
          )}
          {isLoggedIn ? (
            <button className="btn-primary mt-2 text-sm" disabled title="下单流程将在 M2 后续迭代中开放">
              选择舱位
            </button>
          ) : (
            <Link to="/login" className="btn-secondary mt-2 text-sm">
              登录后预订
            </Link>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {flight.seatClasses.map((c) => (
          <div
            key={c.cabin}
            className={`rounded-md border px-3 py-2 text-sm ${
              c.available >= passengers
                ? 'border-slate-200 bg-white'
                : 'border-slate-100 bg-slate-50 text-slate-400'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-700">{CABIN_LABEL[c.cabin] ?? c.cabin}</span>
              <span className="font-semibold text-slate-900">¥{Number(c.basePrice).toFixed(0)}</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">余票 {c.available} / {c.capacity}</div>
          </div>
        ))}
      </div>
    </article>
  );
}
