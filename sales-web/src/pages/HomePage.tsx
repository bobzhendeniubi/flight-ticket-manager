import { FormEvent, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, type CabinClass, type FlightSearchResult } from '../lib/api';
import {
  AIRPORT_OPTIONS,
  CABIN_LABEL,
  airportLabel,
  formatDuration,
  formatLocalDate,
  formatLocalTime,
} from '../lib/airports';
import { DANANG_HIGHLIGHTS } from '../lib/content';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { BenefitsStrip } from '../components/BenefitsStrip';
import { FlightSeatCard } from '../components/FlightSeatCard';
import {
  HotelsPreviewSection,
  TransfersPreviewSection,
  matchKeyword,
} from '../components/HomeSections';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';
import { SortSelect, type SortOption } from '../components/SortSelect';
import { ListSkeleton } from '../components/LoadingSkeleton';
import { ErrorRetry } from '../components/ErrorRetry';
import { EmptyState } from '../components/EmptyState';

// ── 列表排序（对标 Klook/携程）：URL 持久化（?sort=） ──────────────────
type FlightSort = 'recommended' | 'priceAsc' | 'departAsc' | 'durationAsc';

const SORT_OPTIONS: SortOption[] = [
  { value: 'recommended', label: '推荐' },
  { value: 'priceAsc', label: '价格低→高' },
  { value: 'departAsc', label: '出发时间早→晚' },
  { value: 'durationAsc', label: '飞行时长短→长' },
];

const VALID_SORTS = new Set<FlightSort>(['recommended', 'priceAsc', 'departAsc', 'durationAsc']);

function parseSort(raw: string | null): FlightSort {
  return raw && VALID_SORTS.has(raw as FlightSort) ? (raw as FlightSort) : 'recommended';
}

/** 该班次满足人数的最低动态价（无可售舱位 → null，排序时沉底）。 */
function minSellablePrice(flight: FlightSearchResult, passengers: number): number | null {
  return flight.seatClasses
    .filter((c) => c.available >= passengers)
    .reduce(
      (m, c) => (m === null || Number(c.dynamicPrice) < m ? Number(c.dynamicPrice) : m),
      null as number | null,
    );
}

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
  // error 与"空结果"是两种不同状态：error = 请求失败（给 ErrorRetry）；
  // results=[] 且 hasSearched = 请求成功但 0 班次（给 EmptyState）。两者绝不同屏。
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // 排序（URL 持久化 ?sort=）。读：解析校验；写：setSearchParams。
  const [searchParams, setSearchParams] = useSearchParams();
  const sort = parseSort(searchParams.get('sort'));
  const setSort = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'recommended') params.delete('sort');
    else params.set('sort', next);
    setSearchParams(params, { replace: true });
  };

  // 产品关键字搜索（防抖 300ms）— 客户端过滤套餐 / 航班 / 酒店 / 用车
  const [keyword, setKeyword] = useState('');
  const kw = useDebouncedValue(keyword);

  // 首屏拉取全部可售班次（公开端点）；失败要进 error 态而不是静默，
  // 否则用户分不清"加载失败"和"暂无班次"。
  const loadInitial = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.searchFlights({ passengers: 1 });
      setResults(res.results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '航班加载失败');
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadInitial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSearch = async () => {
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
      // 失败：进 error 态，results 置 null（绝不与 EmptyState 同屏）
      setError(err instanceof ApiError ? err.message : '搜索失败，请稍后再试');
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runSearch();
  };

  /** 按当前 sort 排序（不改去/回程分组，分组内排序）。 */
  const sortFlights = (list: SearchResultWithLeg[]): SearchResultWithLeg[] => {
    if (sort === 'recommended') return list;
    const copy = [...list];
    copy.sort((a, b) => {
      if (sort === 'departAsc') {
        return new Date(a.departureTime).getTime() - new Date(b.departureTime).getTime();
      }
      if (sort === 'durationAsc') return a.durationMinutes - b.durationMinutes;
      // priceAsc：无可售价（null）沉底
      const pa = minSellablePrice(a, passengers);
      const pb = minSellablePrice(b, passengers);
      if (pa === null && pb === null) return 0;
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pa - pb;
    });
    return copy;
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
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            id="product-keyword"
            type="search"
            className="input py-2.5 pl-9"
            placeholder="搜索航班 / 酒店 / 用车，如：QH9588、岘港、接送"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
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

      {/* 航班结果 —— 四种状态互斥，绝不同屏：
          1) loading → H1 + ListSkeleton（搜索/加载中）
          2) error   → ErrorRetry 卡片（请求失败，可重试，与"零结果"区分）
          3) 成功但 0 班次 → EmptyState（换日期/航线）
          4) 有班次 → 排序工具条 + 去/回程分组列表（关键字过滤再叠加） */}
      <section className="space-y-3" aria-labelledby="flight-results-heading">
        <h1 id="flight-results-heading" className="sr-only">航班搜索结果</h1>

        {loading ? (
          <>
            <h3 className="text-sm font-semibold text-ink-soft">正在为你查找航班…</h3>
            <ListSkeleton rows={4} />
          </>
        ) : error ? (
          // 请求失败：独立 ErrorRetry（明确区别于"无符合条件航班"）
          <ErrorRetry message={error} onRetry={() => (hasSearched ? void runSearch() : void loadInitial())} />
        ) : results && results.length === 0 ? (
          // 请求成功但 0 班次
          hasSearched ? (
            <EmptyState
              icon="plane"
              title="没有符合条件的航班"
              hint="换个日期或航线试试，或清空筛选看看全部班次。"
            />
          ) : (
            <EmptyState
              icon="plane"
              title="暂无可售航班"
              hint="班次正在上架中，请稍后再来看看。"
            />
          )
        ) : results && results.length > 0 ? (
          (() => {
            const visibleResults = sortFlights(filterFlights(results));
            // 关键字过滤后无命中（区别于服务端 0 结果）
            if (visibleResults.length === 0) {
              return (
                <EmptyState
                  icon="search"
                  title={`没有匹配"${kw}"的航班`}
                  hint="清空搜索框即可查看全部班次。"
                  action={
                    <button type="button" className="btn-secondary" onClick={() => setKeyword('')}>
                      清空关键字
                    </button>
                  }
                />
              );
            }
            return (
              <>
                {/* 排序工具条（对标 Klook/携程）：左计数、右排序 */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-ink-soft">
                    {tripType === 'roundtrip' ? '往返' : '单程'} · 共 {visibleResults.length} 个班次
                  </h3>
                  <SortSelect value={sort} options={SORT_OPTIONS} onChange={setSort} />
                </div>
                <div className="space-y-3">
                  {/* 按去程/回程分组显示 */}
                  {tripType === 'roundtrip' && visibleResults.some((r) => r._leg === '去程') && (
                    <div className="flex items-center gap-2 text-sm font-semibold text-brand mt-2">
                      <span className="inline-flex items-center gap-1 rounded bg-brand/10 px-2 py-0.5">
                        <Icon name="planeDepart" className="h-3.5 w-3.5" />去程
                      </span>
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
                        <span className="inline-flex items-center gap-1 rounded bg-brand/10 px-2 py-0.5">
                          <Icon name="planeReturn" className="h-3.5 w-3.5" />回程
                        </span>
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
          })()
        ) : null}
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
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand">
                <Icon name="mapPin" className="h-6 w-6" />
              </div>
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
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand">
              <Icon name="plane" className="h-6 w-6" />
            </div>
            <h3 className="mt-2 font-semibold text-slate-900">澳门 ⇌ 岘港海岛专线</h3>
            <p className="mt-1 text-slate-600">QH9588/9589 澳门 ↔ 岘港每日直飞 1h45m，每天 1 班</p>
          </div>
          <div>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand">
              <Icon name="hotel" className="h-6 w-6" />
            </div>
            <h3 className="mt-2 font-semibold text-slate-900">酒店预订</h3>
            <p className="mt-1 text-slate-600">直签合作酒店覆盖东南亚 / 中国港澳 / 全球主要城市</p>
          </div>
          <div>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand">
              <Icon name="car" className="h-6 w-6" />
            </div>
            <h3 className="mt-2 font-semibold text-slate-900">地面服务</h3>
            <p className="mt-1 text-slate-600">中文司机点对点、一日游包车，航班延误自动顺延</p>
          </div>
          <div>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand">
              <Icon name="visa" className="h-6 w-6" />
            </div>
            <h3 className="mt-2 font-semibold text-slate-900">签证代办</h3>
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
        <div className="flex min-w-0 flex-col gap-0.5 flex-shrink-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="inline-flex items-center rounded bg-brand/10 px-2 py-0.5 text-sm font-semibold text-brand">
              {flight.flightNumber}
            </span>
            {/* 机型 · 飞行时长 · 直飞 —— 桌面端跟在航班号后；机型为空则只显示时长 */}
            <span className="hidden truncate text-xs text-slate-500 sm:inline">
              {[flight.aircraftType, `飞行约${formatDuration(flight.durationMinutes)}`, '直飞']
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          {/* 手机端：只补机型（时长/直飞已在下方时间行，避免重复）；无机型则不渲染 */}
          {flight.aircraftType && (
            <span className="truncate text-[11px] text-slate-500 sm:hidden">
              {flight.aircraftType}
            </span>
          )}
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

      {/* 详情入口（B2）：去航班详情页看时刻线 / 行李 / 改退 / 评价。
          独立 Link，不影响卡内 加购/锁位 逻辑。 */}
      <div className="mt-3 flex justify-end border-t border-slate-100 pt-2.5">
        <Link
          to={`/flights/${flight.scheduleId}`}
          className="group inline-flex items-center gap-1 text-xs font-semibold text-brand transition-colors hover:text-brand-dark"
        >
          查看航班详情
          <Icon name="arrowRight" className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </article>
  );
}

