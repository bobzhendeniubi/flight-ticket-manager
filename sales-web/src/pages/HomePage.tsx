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
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { BenefitsStrip } from '../components/BenefitsStrip';
import { FlightSeatCard } from '../components/FlightSeatCard';
import {
  HotelsPreviewSection,
  TransfersPreviewSection,
  matchKeyword,
} from '../components/HomeSections';
import { useAuth } from '../stores/auth';

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

  // 产品关键字搜索（防抖 300ms）— 客户端过滤套餐 / 航班 / 酒店 / 用车
  const [keyword, setKeyword] = useState('');
  const kw = useDebouncedValue(keyword);

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

  // 关键字过滤航班结果（航班号 / 三字码 / 机场中文名）
  const filterFlights = (list: SearchResultWithLeg[]) =>
    list.filter((r) =>
      matchKeyword(
        kw,
        r.flightNumber,
        r.originCode,
        r.destinationCode,
        airportLabel(r.originCode),
        airportLabel(r.destinationCode),
      ),
    );

  return (
    <div className="space-y-6">
      {/* 福利条（hero 仅保留在套餐落地页 '/'，机票页直接进搜索） */}
      <BenefitsStrip />

      {/* 产品关键字搜索（防抖过滤 航班/酒店/用车） */}
      <section>
        <label className="sr-only" htmlFor="product-keyword">搜索产品</label>
        <input
          id="product-keyword"
          type="search"
          className="input py-2.5"
          placeholder="🔍 搜索航班 / 酒店 / 用车，如：QH9588、岘港、接送"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
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

      {/* 航班结果（受关键字过滤） */}
      <section className="space-y-3">
        {error && (
          <div className="card border-red-200 bg-red-50 text-sm text-red-700">{error}</div>
        )}

        {results && results.length === 0 && (
          <div className="card text-slate-600">
            {hasSearched ? '没有符合条件的航班，换个日期或航线试试。' : '暂无可售航班，请先由管理员添加班次。'}
          </div>
        )}

        {results && results.length > 0 && (() => {
          const visibleResults = filterFlights(results);
          if (visibleResults.length === 0) {
            return (
              <div className="card text-sm text-slate-500">没有匹配"{kw}"的航班，清空搜索框看全部班次。</div>
            );
          }
          return (
            <>
              <p className="text-sm text-slate-500">
                {tripType === 'roundtrip' ? '往返' : '单程'} · 共 {visibleResults.length} 个班次
              </p>
              <div className="space-y-3">
                {/* 按去程/回程分组显示 */}
                {tripType === 'roundtrip' && visibleResults.some((r) => r._leg === '去程') && (
                  <div className="flex items-center gap-2 text-sm font-semibold text-brand mt-2">
                    <span className="rounded bg-brand/10 px-2 py-0.5">✈ 去程</span>
                    <span className="text-slate-500 font-normal">{origin} → {destination} · {date}</span>
                  </div>
                )}
                {visibleResults.filter((r) => r._leg !== '回程').map((r) => (
                  <FlightCard
                    key={r.scheduleId}
                    flight={r}
                    passengers={passengers}
                    isLoggedIn={!!user}
                    mobileRouteCollapsed={r._leg !== undefined}
                  />
                ))}
                {tripType === 'roundtrip' && visibleResults.some((r) => r._leg === '回程') && (
                  <>
                    <div className="flex items-center gap-2 text-sm font-semibold text-brand mt-4">
                      <span className="rounded bg-brand/10 px-2 py-0.5">✈ 回程</span>
                      <span className="text-slate-500 font-normal">{destination} → {origin} · {returnDate}</span>
                    </div>
                    {visibleResults.filter((r) => r._leg === '回程').map((r) => (
                      <FlightCard
                        key={r.scheduleId}
                        flight={r}
                        passengers={passengers}
                        isLoggedIn={!!user}
                        mobileRouteCollapsed
                      />
                    ))}
                  </>
                )}
              </div>
            </>
          );
        })()}

        {results === null && <div className="card text-slate-500">正在加载…</div>}
      </section>

      {/* 酒店 / 用车速览（排在机票后面） */}
      <HotelsPreviewSection keyword={kw} />
      <TransfersPreviewSection keyword={kw} />

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
  mobileRouteCollapsed = false,
}: {
  flight: FlightSearchResult;
  passengers: number;
  isLoggedIn: boolean;
  /** 手机端折叠重复信息：去/回程分组头已写明 航线+日期 时，卡片内不再重复机场名 */
  mobileRouteCollapsed?: boolean;
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

      {/* 手机端时间行：DEP — DUR — ARR 紧凑布局；
          分组头已写明航线+日期时（mobileRouteCollapsed）不再重复机场名 */}
      <div className="sm:hidden mt-3 flex items-center justify-between gap-2">
        <div className="text-left">
          <div className="text-xl font-semibold text-slate-900">
            {formatLocalTime(flight.departureTime, flight.departureTz)}
          </div>
          {!mobileRouteCollapsed && (
            <div className="text-[10px] text-slate-500">
              {airportLabel(flight.originCode)}
            </div>
          )}
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
          {!mobileRouteCollapsed && (
            <div className="text-[10px] text-slate-500">
              {airportLabel(flight.destinationCode)}
            </div>
          )}
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

