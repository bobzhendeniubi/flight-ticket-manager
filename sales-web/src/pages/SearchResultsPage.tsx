import { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  type Bundle,
  type Hotel,
  type Transfer,
  type Visa,
  type FlightSearchResult,
} from '../lib/api';
import { airportLabel } from '../lib/airports';
import { Seo } from '../components/Seo';
import { EmptyState } from '../components/EmptyState';
import { ListSkeleton } from '../components/LoadingSkeleton';
import { Icon, type IconName } from '../components/Icon';

/**
 * 全站搜索结果页（C2）。
 * - 读 ?q=；并行拉 套餐/酒店/接送/签证 列表 + 航班搜索；客户端按关键字过滤。
 * - 结果按品类分组，标题带计数（"套餐 5 · 酒店 8 · 接送 2 · 签证 1 · 机票 3"）。
 * - 单品类拉取失败不影响其它品类（Promise.allSettled + 各自 errored 标记）。
 * - 搜索页 noindex（薄内容、动态结果，不进索引）。
 */

/** 关键字命中：任一字段包含（不区分大小写）即命中 */
function matchKeyword(keyword: string, ...fields: Array<string | null | undefined>): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return false;
  return fields.some((f) => (f ?? '').toLowerCase().includes(kw));
}

interface CategoryState<T> {
  items: T[];
  errored: boolean;
}

const EMPTY = <T,>(): CategoryState<T> => ({ items: [], errored: false });

function ResultRow({
  to,
  icon,
  title,
  subtitle,
  meta,
}: {
  to: string;
  icon: IconName;
  title: string;
  subtitle?: string;
  meta?: string;
}) {
  return (
    <Link to={to} className="card-interactive group flex items-center gap-3 p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-bold text-ink">{title}</h3>
        {subtitle && <p className="truncate text-xs text-ink-soft">{subtitle}</p>}
      </div>
      {meta && <span className="price shrink-0 text-sm">{meta}</span>}
      <Icon
        name="arrowRight"
        className="h-4 w-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5"
      />
    </Link>
  );
}

function CategoryBlock<T>({
  icon,
  title,
  state,
  q,
  render,
}: {
  icon: IconName;
  title: string;
  state: CategoryState<T>;
  q: string;
  render: (item: T) => React.ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="section-title inline-flex items-center gap-2 text-base">
        <Icon name={icon} className="h-5 w-5 text-brand" />
        {title}
        <span className="text-sm font-normal text-ink-muted">
          {state.errored ? '加载失败' : state.items.length}
        </span>
      </h2>
      {state.errored ? (
        <div className="card text-sm text-ink-soft">该品类暂时加载失败，可稍后重试。</div>
      ) : state.items.length === 0 ? (
        <div className="card text-sm text-ink-muted">没有匹配“{q}”的{title}。</div>
      ) : (
        <div className="space-y-2">{state.items.map(render)}</div>
      )}
    </section>
  );
}

export default function SearchResultsPage() {
  const [params] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';

  const [loading, setLoading] = useState(true);
  const [bundles, setBundles] = useState<CategoryState<Bundle>>(EMPTY);
  const [hotels, setHotels] = useState<CategoryState<Hotel>>(EMPTY);
  const [transfers, setTransfers] = useState<CategoryState<Transfer>>(EMPTY);
  const [visas, setVisas] = useState<CategoryState<Visa>>(EMPTY);
  const [flights, setFlights] = useState<CategoryState<FlightSearchResult>>(EMPTY);

  useEffect(() => {
    if (!q) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    // 各品类独立 settle：一个失败不影响其它（resilient）
    void Promise.allSettled([
      api.listBundles(),
      api.listHotels(),
      api.listTransfers(),
      api.listVisas(),
      api.searchFlights({ passengers: 1 }),
    ]).then(([b, h, t, v, f]) => {
      if (cancelled) return;

      setBundles(
        b.status === 'fulfilled'
          ? {
              errored: false,
              items: b.value.bundles
                .filter((x) => x.isActive)
                .filter((x) =>
                  matchKeyword(
                    q,
                    x.name,
                    x.tagline,
                    x.suitableFor,
                    x.hotelRoomType?.hotelName,
                    x.hotelRoomType?.name,
                    ...x.items.map((i) => i.productName),
                  ),
                ),
            }
          : { items: [], errored: true },
      );

      setHotels(
        h.status === 'fulfilled'
          ? {
              errored: false,
              items: h.value.hotels.filter((x) =>
                matchKeyword(q, x.name, x.nameEn, x.area, x.cityCode, x.highlight),
              ),
            }
          : { items: [], errored: true },
      );

      setTransfers(
        t.status === 'fulfilled'
          ? {
              errored: false,
              items: t.value.transfers.filter((x) =>
                matchKeyword(q, x.name, x.vehicleType, x.originArea, x.destArea),
              ),
            }
          : { items: [], errored: true },
      );

      setVisas(
        v.status === 'fulfilled'
          ? {
              errored: false,
              items: v.value.visas.filter((x) =>
                matchKeyword(q, x.destinationCountry, x.country, x.visaType, x.visaName, x.highlight),
              ),
            }
          : { items: [], errored: true },
      );

      setFlights(
        f.status === 'fulfilled'
          ? {
              errored: false,
              items: f.value.results.filter((x) =>
                matchKeyword(
                  q,
                  x.flightNumber,
                  x.originCode,
                  x.destinationCode,
                  airportLabel(x.originCode),
                  airportLabel(x.destinationCode),
                  x.aircraftType,
                ),
              ),
            }
          : { items: [], errored: true },
      );

      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [q]);

  const totalHits = useMemo(
    () =>
      bundles.items.length +
      hotels.items.length +
      transfers.items.length +
      visas.items.length +
      flights.items.length,
    [bundles, hotels, transfers, visas, flights],
  );

  const allErrored =
    bundles.errored && hotels.errored && transfers.errored && visas.errored && flights.errored;

  // 计数摘要："套餐 5 · 酒店 8 · 接送 2 · 签证 1 · 机票 3"（失败品类不计入）
  const countSummary = [
    !bundles.errored && bundles.items.length > 0 ? `套餐 ${bundles.items.length}` : null,
    !hotels.errored && hotels.items.length > 0 ? `酒店 ${hotels.items.length}` : null,
    !transfers.errored && transfers.items.length > 0 ? `地面服务 ${transfers.items.length}` : null,
    !visas.errored && visas.items.length > 0 ? `签证 ${visas.items.length}` : null,
    !flights.errored && flights.items.length > 0 ? `机票 ${flights.items.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Seo
        title={q ? `搜索 “${q}”` : '搜索'}
        description="搜索海岛专线套餐、酒店、接送、签证与航班。"
        canonicalPath="/search"
      />
      {/* 搜索页薄内容 + 动态结果 → noindex（Seo 组件不暴露该项，单独 Helmet 注入并合并） */}
      <Helmet>
        <meta name="robots" content="noindex, follow" />
      </Helmet>

      <header>
        <h1 className="text-2xl font-bold text-ink">
          {q ? <>“{q}” 的搜索结果</> : '搜索'}
        </h1>
        {q && !loading && totalHits > 0 && (
          <p className="mt-1 text-sm text-ink-soft">{countSummary}</p>
        )}
      </header>

      {/* 无关键字 */}
      {!q ? (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title="输入关键词开始搜索"
            hint="试试航线、城市、酒店名或“接送 / 签证 / 套餐”等关键词。"
          />
        </div>
      ) : loading ? (
        <div className="mt-6">
          <ListSkeleton rows={5} />
        </div>
      ) : allErrored ? (
        <div className="mt-6">
          <EmptyState
            icon="info"
            title="搜索暂时不可用"
            hint="网络好像开了个小差，请稍后刷新页面重试。"
          />
        </div>
      ) : totalHits === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title={`没有找到与 “${q}” 相关的结果`}
            hint="换个关键词试试，或直接浏览套餐 / 机票 / 酒店。"
            action={
              <Link to="/" className="btn-primary">
                浏览全部产品
              </Link>
            }
          />
        </div>
      ) : (
        <div className="mt-6 space-y-7">
          <CategoryBlock
            icon="package"
            title="套餐"
            state={bundles}
            q={q}
            render={(b) => (
              <ResultRow
                key={b.id}
                to={`/bundles?kw=${encodeURIComponent(b.name)}`}
                icon="package"
                title={b.name}
                subtitle={b.tagline ?? b.suitableFor ?? undefined}
              />
            )}
          />
          <CategoryBlock
            icon="plane"
            title="机票"
            state={flights}
            q={q}
            render={(f) => (
              <ResultRow
                key={f.scheduleId}
                to={`/flights/${f.scheduleId}`}
                icon="plane"
                title={`${f.flightNumber} · ${f.originCode} → ${f.destinationCode}`}
                subtitle={`${airportLabel(f.originCode)} → ${airportLabel(f.destinationCode)}${f.aircraftType ? ` · ${f.aircraftType}` : ''}`}
              />
            )}
          />
          <CategoryBlock
            icon="hotel"
            title="酒店"
            state={hotels}
            q={q}
            render={(h) => (
              <ResultRow
                key={h.id}
                to={`/hotels/${h.id}`}
                icon="hotel"
                title={h.name}
                subtitle={[h.area ?? h.cityCode, h.highlight].filter(Boolean).join(' · ') || undefined}
                meta={h.basePrice ? `¥${Number(h.basePrice).toLocaleString()}起` : undefined}
              />
            )}
          />
          <CategoryBlock
            icon="car"
            title="地面服务"
            state={transfers}
            q={q}
            render={(t) => (
              <ResultRow
                key={t.id}
                to={`/transfers/${t.id}`}
                icon="car"
                title={t.name}
                subtitle={[t.vehicleType, `${t.originArea} → ${t.destArea}`].filter(Boolean).join(' · ')}
                meta={`¥${Number(t.basePrice).toLocaleString()}起`}
              />
            )}
          />
          <CategoryBlock
            icon="visa"
            title="签证"
            state={visas}
            q={q}
            render={(v) => (
              <ResultRow
                key={v.id}
                to={`/visas/${v.id}`}
                icon="visa"
                title={v.visaName ?? `${v.destinationCountry}${v.visaType}`}
                subtitle={[v.destinationCountry, v.highlight].filter(Boolean).join(' · ') || undefined}
                meta={`¥${Number(v.basePrice).toLocaleString()}起`}
              />
            )}
          />
        </div>
      )}
    </main>
  );
}
