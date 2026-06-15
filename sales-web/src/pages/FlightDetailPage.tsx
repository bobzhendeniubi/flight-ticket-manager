import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  type FlightSearchResult,
  type Review,
  type ReviewSummary,
} from '../lib/api';
import {
  airportLabel,
  formatDuration,
  formatLocalDate,
  formatLocalTime,
} from '../lib/airports';
import { Seo } from '../components/Seo';
import { Breadcrumb } from '../components/Breadcrumb';
import { DetailSkeleton } from '../components/LoadingSkeleton';
import { ErrorRetry } from '../components/ErrorRetry';
import { EmptyState } from '../components/EmptyState';
import { RatingSummary } from '../components/RatingSummary';
import { ReviewList, type ReviewItem } from '../components/ReviewList';
import { TrustBadges } from '../components/TrustBadges';
import { RefundBadge } from '../components/RefundBadge';
import { Icon } from '../components/Icon';
import { FlightSeatCard } from '../components/FlightSeatCard';
import { useAuth } from '../stores/auth';

/**
 * 航班详情页（真实实现）。
 * - 复用现有 api.searchFlights 拉全部可售班次，再按路由 :id（= scheduleId）find。
 * - 时刻线（出发→到达、时长、机型、舱位价/余位/加购/锁位复用 FlightSeatCard）。
 * - 行李规则、改退说明、信任标识、移动端 sticky 预订条。
 * - 评价：route 维度（productId = "ORIGIN-DESTINATION"），listReviews('FLIGHT', ...) + 加载更多。
 *
 * 评价 productId 口径假设：航班无单班次评价，按"航线"聚合（去/回程共用），
 * 故 productId 用 `${originCode}-${destinationCode}`。评价内容为 make-up（后端 seed）。
 */

const REVIEW_PAGE_SIZE = 5;

/** Review（后端）→ ReviewItem（展示组件）。reply: null → undefined。 */
function toReviewItem(r: Review): ReviewItem {
  return {
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    authorName: r.authorName,
    verified: r.verified,
    tripType: r.tripType,
    reply: r.reply ?? undefined,
    createdAt: r.createdAt,
  };
}

export default function FlightDetailPage() {
  const { id } = useParams<{ id: string }>();
  const user = useAuth((s) => s.user);

  const [flight, setFlight] = useState<FlightSearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadFlight = useCallback(async () => {
    if (!id) {
      setError('缺少航班标识');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // 无 by-id 端点：拉全部班次再 find（与 HomePage 同一公开端点）
      const res = await api.searchFlights({ passengers: 1 });
      const found = res.results.find((r) => r.scheduleId === id) ?? null;
      setFlight(found);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '航班加载失败');
      setFlight(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadFlight();
  }, [loadFlight]);

  // ── 评价（route 维度）────────────────────────────────────────────
  const routeKey = flight ? `${flight.originCode}-${flight.destinationCode}` : null;
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary | null>(null);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const loadReviews = useCallback(
    async (page: number, productId: string) => {
      setReviewLoading(true);
      setReviewError(null);
      try {
        const res = await api.listReviews({
          productType: 'FLIGHT',
          productId,
          page,
          limit: REVIEW_PAGE_SIZE,
        });
        setReviews((prev) => (page === 1 ? res.items : [...prev, ...res.items]));
        setReviewSummary(res.summary);
        setReviewTotal(res.total);
        setReviewPage(page);
      } catch (err) {
        setReviewError(err instanceof ApiError ? err.message : '评价加载失败');
      } finally {
        setReviewLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!routeKey) return;
    setReviews([]);
    setReviewSummary(null);
    setReviewTotal(0);
    void loadReviews(1, routeKey);
  }, [routeKey, loadReviews]);

  const minPrice = flight
    ? flight.seatClasses
        .filter((c) => c.available > 0)
        .reduce(
          (m, c) => (m === null || Number(c.dynamicPrice) < m ? Number(c.dynamicPrice) : m),
          null as number | null,
        )
    : null;

  // ── 渲染：loading / error / not-found / ok ─────────────────────────
  if (loading) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Seo title="航班详情" canonicalPath={id ? `/flights/${id}` : '/flights'} />
        <DetailSkeleton />
      </main>
    );
  }

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Seo title="航班详情" canonicalPath={id ? `/flights/${id}` : '/flights'} />
        <ErrorRetry message={error} onRetry={() => void loadFlight()} />
      </main>
    );
  }

  if (!flight) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Seo
          title="航班详情"
          description="该航班可能已下架或日期已过。"
          canonicalPath={id ? `/flights/${id}` : '/flights'}
        />
        <EmptyState
          icon="plane"
          title="找不到这个航班"
          hint="它可能已售罄、下架或日期已过，去机票列表看看其它班次吧。"
          action={
            <Link to="/flights" className="btn-primary">
              查看全部航班
            </Link>
          }
        />
      </main>
    );
  }

  const routeName = `${airportLabel(flight.originCode)} → ${airportLabel(flight.destinationCode)}`;

  // Flight + Product JSON-LD（SEO 结构化数据）
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Flight',
    flightNumber: flight.flightNumber,
    departureAirport: { '@type': 'Airport', iataCode: flight.originCode },
    arrivalAirport: { '@type': 'Airport', iataCode: flight.destinationCode },
    departureTime: flight.departureTime,
    arrivalTime: flight.arrivalTime,
    ...(flight.aircraftType ? { aircraft: flight.aircraftType } : {}),
    ...(minPrice !== null
      ? {
          offers: {
            '@type': 'Offer',
            price: minPrice,
            priceCurrency: 'CNY',
            availability: flight.hasSpace
              ? 'https://schema.org/InStock'
              : 'https://schema.org/SoldOut',
          },
        }
      : {}),
    ...(reviewSummary && reviewSummary.count > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: reviewSummary.average,
            reviewCount: reviewSummary.count,
          },
        }
      : {}),
  };

  const hasMoreReviews = reviews.length < reviewTotal;

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 pb-28 md:pb-10">
      <Seo
        title={`${flight.flightNumber} ${flight.originCode}→${flight.destinationCode} 航班详情`}
        description={`${routeName} 直飞 · ${flight.aircraftType ?? '客机'} · 飞行约${formatDuration(flight.durationMinutes)}。在线选舱位、查行李规则与改退说明。`}
        canonicalPath={`/flights/${flight.scheduleId}`}
        jsonLd={jsonLd}
      />

      <Breadcrumb
        items={[
          { label: '首页', to: '/' },
          { label: '机票', to: '/flights' },
          { label: `${flight.originCode} → ${flight.destinationCode}` },
        ]}
      />

      {/* 标题区 */}
      <header className="mt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded bg-brand/10 px-2 py-0.5 text-sm font-semibold text-brand">
            {flight.flightNumber}
          </span>
          <span className="badge-outline">
            <Icon name="plane" className="h-3 w-3" />
            直飞
          </span>
          <RefundBadge />
        </div>
        <h1 className="mt-2 text-2xl font-bold text-ink">{routeName}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
          {flight.aircraftType && (
            <span className="inline-flex items-center gap-1">
              <Icon name="plane" className="h-3.5 w-3.5 text-ink-muted" />
              {flight.aircraftType}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Icon name="clock" className="h-3.5 w-3.5 text-ink-muted" />
            飞行约 {formatDuration(flight.durationMinutes)}
          </span>
        </p>
      </header>

      {/* 时刻线（出发 → 到达） */}
      <section aria-labelledby="itinerary-heading" className="card mt-5">
        <h2 id="itinerary-heading" className="section-title text-base">
          行程时刻
        </h2>
        <div className="mt-4 flex items-stretch gap-4">
          {/* 出发 */}
          <div className="flex-1 text-center sm:text-left">
            <div className="nums text-3xl font-bold text-ink">
              {formatLocalTime(flight.departureTime, flight.departureTz)}
            </div>
            <div className="mt-1 text-sm font-semibold text-ink-soft">
              {airportLabel(flight.originCode)}
            </div>
            <div className="text-xs text-ink-muted">
              {formatLocalDate(flight.departureTime, flight.departureTz)}
            </div>
          </div>

          {/* 中段：时长 + 直飞 */}
          <div className="flex shrink-0 flex-col items-center justify-center px-2 text-xs text-ink-muted">
            <span>{formatDuration(flight.durationMinutes)}</span>
            <div className="my-1.5 flex items-center gap-1">
              <span className="h-px w-8 bg-slate-300 sm:w-16" />
              <Icon name="planeDepart" className="h-4 w-4 text-brand" />
              <span className="h-px w-8 bg-slate-300 sm:w-16" />
            </div>
            <span>直飞</span>
          </div>

          {/* 到达 */}
          <div className="flex-1 text-center sm:text-right">
            <div className="nums text-3xl font-bold text-ink">
              {formatLocalTime(flight.arrivalTime, flight.arrivalTz)}
            </div>
            <div className="mt-1 text-sm font-semibold text-ink-soft">
              {airportLabel(flight.destinationCode)}
            </div>
            <div className="text-xs text-ink-muted">
              {formatLocalDate(flight.arrivalTime, flight.arrivalTz)}
            </div>
          </div>
        </div>
      </section>

      {/* 舱位选择（价格 / 余位档位 / 行李 / 加购 / 锁位 复用 FlightSeatCard） */}
      <section aria-labelledby="cabin-heading" className="mt-5">
        <h2 id="cabin-heading" className="section-title text-base">
          选择舱位
        </h2>
        <p className="section-sub">价格为实时动态价；余位只显示档位，下单前可锁位 10 分钟。</p>
        <div className="mt-3 grid gap-2 grid-cols-2 lg:grid-cols-4">
          {flight.seatClasses.map((c) => (
            <FlightSeatCard
              key={c.cabin}
              flight={flight}
              cabin={c}
              passengers={1}
              isLoggedIn={!!user}
            />
          ))}
        </div>
      </section>

      {/* 行李规则 */}
      <section aria-labelledby="baggage-heading" className="card mt-5">
        <h2 id="baggage-heading" className="section-title text-base">
          行李规则
        </h2>
        <ul className="mt-2 space-y-1.5 text-sm text-ink-soft">
          <li className="flex items-start gap-2">
            <Icon name="ticket" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            各舱位托运 / 手提行李额以上方舱位卡内标注为准，未标注的以航司柜台规定为准。
          </li>
          <li className="flex items-start gap-2">
            <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            超额行李、特殊物品（乐器 / 运动器材等）请提前联系客服确认收费与限重。
          </li>
        </ul>
      </section>

      {/* 改退说明 */}
      <section aria-labelledby="refund-heading" className="card mt-5">
        <h2 id="refund-heading" className="section-title text-base">
          改退说明
        </h2>
        <ul className="mt-2 space-y-1.5 text-sm text-ink-soft">
          <li className="flex items-start gap-2">
            <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            出发前 7 天可免费取消；7 天内退改按航司规则收取手续费。
          </li>
          <li className="flex items-start gap-2">
            <Icon name="support" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            姓名 / 证件填写有误，请第一时间联系 7×24 中文客服协助更正。
          </li>
        </ul>
      </section>

      {/* 评价（route 维度，内容为 make-up） */}
      <section aria-labelledby="reviews-heading" className="mt-6">
        <h2 id="reviews-heading" className="section-title text-base">
          航线真实评价
        </h2>
        {reviewError ? (
          <div className="mt-3">
            <ErrorRetry
              message={reviewError}
              onRetry={() => routeKey && void loadReviews(1, routeKey)}
            />
          </div>
        ) : (
          <>
            {reviewSummary && reviewSummary.count > 0 && (
              <div className="mt-3">
                <RatingSummary
                  average={reviewSummary.average}
                  count={reviewSummary.count}
                  distribution={reviewSummary.distribution}
                />
              </div>
            )}
            <div className="mt-3">
              <ReviewList
                reviews={reviews.map(toReviewItem)}
                loading={reviewLoading && reviews.length === 0}
                emptyHint="这条航线还没有评价，欢迎成为第一个分享体验的人。"
              />
            </div>
            {hasMoreReviews && (
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={reviewLoading}
                  onClick={() => routeKey && void loadReviews(reviewPage + 1, routeKey)}
                >
                  {reviewLoading ? '加载中…' : `加载更多评价（剩 ${reviewTotal - reviews.length} 条）`}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {/* 信任标识 */}
      <section className="mt-6">
        <TrustBadges variant="checkout" />
      </section>

      {/* 移动端 sticky 预订条 */}
      <div className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+3.5rem)] z-20 border-t border-slate-200/80 bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur-xl md:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-xs text-ink-muted">
              {flight.flightNumber} · {flight.originCode}→{flight.destinationCode}
            </div>
            {minPrice !== null ? (
              <div className="flex items-baseline gap-1">
                <span className="price text-lg">¥{minPrice.toFixed(0)}</span>
                <span className="text-xs text-ink-muted">起</span>
              </div>
            ) : (
              <div className="text-sm font-semibold text-rose-600">暂无可售舱位</div>
            )}
          </div>
          <a href="#cabin-heading" className="btn-primary shrink-0">
            选舱位下单
          </a>
        </div>
      </div>
    </main>
  );
}
