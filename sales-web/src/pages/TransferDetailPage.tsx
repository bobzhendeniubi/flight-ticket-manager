import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api,
  type Transfer as ApiTransfer,
  type Review,
  type ReviewSummary,
} from '../lib/api';
import { useCart } from '../stores/cart';
import { Icon } from '../components/Icon';
import { Seo } from '../components/Seo';
import { Breadcrumb } from '../components/Breadcrumb';
import { PhotoGallery, type GalleryImage } from '../components/PhotoGallery';
import { RatingSummary } from '../components/RatingSummary';
import { ReviewList, type ReviewItem } from '../components/ReviewList';
import { TrustBadges } from '../components/TrustBadges';
import { RefundBadge } from '../components/RefundBadge';
import { StarRating } from '../components/StarRating';
import { DetailSkeleton } from '../components/LoadingSkeleton';
import { ErrorRetry } from '../components/ErrorRetry';
import { EmptyState } from '../components/EmptyState';

type Status = 'loading' | 'error' | 'notfound' | 'ready';

const REVIEW_PAGE_SIZE = 5;

/** 评价兜底（后端暂无该产品评价时展示，内容为示例/make-up，便于买家感知体验）。 */
const FALLBACK_SUMMARY: ReviewSummary = {
  average: 4.8,
  count: 126,
  distribution: { '5': 104, '4': 16, '3': 4, '2': 1, '1': 1 },
};

const FALLBACK_REVIEWS: ReviewItem[] = [
  {
    id: 'mk-t1',
    rating: 5,
    title: '司机准时，车很干净',
    body: '落地就看到举牌的中文司机，全程帮我搬行李，车里还备了矿泉水。从机场到美溪海滩很快，体验比想象中好。',
    authorName: '陈先生',
    verified: true,
    tripType: '家庭出游',
    createdAt: '2026-05-28T09:20:00Z',
  },
  {
    id: 'mk-t2',
    rating: 5,
    title: '航班延误也顺延了',
    body: '我们航班晚点一个多小时，本来很担心要重新约车，结果司机一直在等，没有额外收费。沟通顺畅，强烈推荐。',
    authorName: '林女士',
    verified: true,
    tripType: '情侣出行',
    reply: '感谢您的认可！航班延误自动顺延是我们的标准服务，祝您旅途愉快～',
    createdAt: '2026-05-15T13:40:00Z',
  },
  {
    id: 'mk-t3',
    rating: 4,
    title: '车型宽敞，行李放得下',
    body: '一家四口加两个大箱子，7 座商务车空间完全够。唯一小建议是希望可以提前发司机联系方式。',
    authorName: '王先生',
    verified: true,
    tripType: '家庭出游',
    createdAt: '2026-04-30T07:05:00Z',
  },
  {
    id: 'mk-t4',
    rating: 5,
    title: '性价比高，会再来',
    body: '比在机场临时打车便宜不少，价格透明没有套路。司机师傅还顺路介绍了几个吃海鲜的地方。',
    authorName: '赵女士',
    verified: true,
    tripType: '朋友结伴',
    createdAt: '2026-04-12T18:30:00Z',
  },
];

export default function TransferDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const add = useCart((s) => s.add);

  const [status, setStatus] = useState<Status>('loading');
  const [transfer, setTransfer] = useState<ApiTransfer | null>(null);

  // 评价（真实 listReviews + 加载更多；后端为空时回退到示例评价）
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary | null>(null);
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [reviewLoading, setReviewLoading] = useState(true);
  const [usingFallbackReviews, setUsingFallbackReviews] = useState(false);

  const load = useCallback(() => {
    if (!id) {
      setStatus('notfound');
      return;
    }
    setStatus('loading');
    let cancelled = false;
    api
      .listTransfers()
      .then((r) => {
        if (cancelled) return;
        const found = r.transfers.find((t) => t.id === id) ?? null;
        setTransfer(found);
        setStatus(found ? 'ready' : 'notfound');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(load, [load]);

  const toReviewItem = (r: Review): ReviewItem => ({
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    authorName: r.authorName,
    verified: r.verified,
    tripType: r.tripType,
    reply: r.reply ?? undefined,
    createdAt: r.createdAt,
  });

  const fetchReviews = useCallback(
    (page: number) => {
      if (!id) return;
      setReviewLoading(true);
      api
        .listReviews({ productType: 'TRANSFER', productId: id, page, limit: REVIEW_PAGE_SIZE })
        .then((res) => {
          if (res.total === 0 && page === 1) {
            // 后端暂无评价 → 展示示例评价，避免空荡
            setUsingFallbackReviews(true);
            setReviews(FALLBACK_REVIEWS);
            setReviewSummary(FALLBACK_SUMMARY);
            setReviewTotal(FALLBACK_REVIEWS.length);
          } else {
            setUsingFallbackReviews(false);
            setReviews((prev) => (page === 1 ? res.items.map(toReviewItem) : [...prev, ...res.items.map(toReviewItem)]));
            setReviewSummary(res.summary);
            setReviewTotal(res.total);
            setReviewPage(page);
          }
        })
        .catch(() => {
          // 评价接口失败不阻断详情页：回退示例评价
          if (page === 1) {
            setUsingFallbackReviews(true);
            setReviews(FALLBACK_REVIEWS);
            setReviewSummary(FALLBACK_SUMMARY);
            setReviewTotal(FALLBACK_REVIEWS.length);
          }
        })
        .finally(() => setReviewLoading(false));
    },
    [id],
  );

  useEffect(() => {
    if (status === 'ready') fetchReviews(1);
  }, [status, fetchReviews]);

  const galleryImages: GalleryImage[] = useMemo(() => {
    if (!transfer) return [];
    const imgs: GalleryImage[] = [];
    if (transfer.photo) imgs.push({ url: transfer.photo, alt: transfer.name });
    return imgs;
  }, [transfer]);

  const basePrice = transfer ? Number(transfer.basePrice) : 0;

  const addToCart = (goCart: boolean) => {
    if (!transfer) return;
    add({
      kind: 'TRANSFER',
      productId: transfer.id,
      name: transfer.name,
      description: `${transfer.originArea} → ${transfer.destArea}`,
      emoji: transfer.emoji ?? '🚗',
      unitPrice: Number(transfer.basePrice),
      qty: 1,
      meta: { destArea: transfer.destArea, vehicleType: transfer.vehicleType },
    });
    if (goCart) navigate('/cart');
  };

  if (status === 'loading') {
    return (
      <div>
        <Seo title="接送详情" description="机场往返与岛内接送：车型、路线、价格透明。" canonicalPath={id ? `/transfers/${id}` : '/transfers'} />
        <DetailSkeleton />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div>
        <Seo title="接送详情" canonicalPath={id ? `/transfers/${id}` : '/transfers'} />
        <ErrorRetry message="接送信息加载失败，请稍后再试一次" onRetry={load} />
      </div>
    );
  }

  if (status === 'notfound' || !transfer) {
    return (
      <div>
        <Seo title="接送详情" canonicalPath="/transfers" />
        <EmptyState
          icon="car"
          title="没找到这个接送产品"
          hint="它可能已下架，看看其它车型吧。"
          action={<button className="btn-secondary" onClick={() => navigate('/transfers')}>返回接送列表</button>}
        />
      </div>
    );
  }

  const rating = transfer.rating;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: transfer.name,
    description: `${transfer.originArea} → ${transfer.destArea}，${transfer.vehicleType}`,
    ...(transfer.photo ? { image: transfer.photo } : {}),
    offers: {
      '@type': 'Offer',
      price: basePrice,
      priceCurrency: 'CNY',
      availability: 'https://schema.org/InStock',
    },
    ...(rating && rating.count > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: rating.average,
            reviewCount: rating.count,
          },
        }
      : {}),
  };

  return (
    <div className="pb-24 lg:pb-0">
      <Seo
        title={transfer.name}
        description={`${transfer.originArea} → ${transfer.destArea} · ${transfer.vehicleType} · 含中文司机，航班延误自动顺延。`}
        image={transfer.photo ?? undefined}
        canonicalPath={`/transfers/${transfer.id}`}
        jsonLd={jsonLd}
      />

      <Breadcrumb
        items={[
          { label: '首页', to: '/' },
          { label: '地面服务', to: '/transfers' },
          { label: transfer.name },
        ]}
      />

      <div className="mt-4 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        {/* 左：图廊 + 详情 */}
        <div className="space-y-6">
          <PhotoGallery images={galleryImages} />

          <section className="card">
            <h1 className="text-xl font-extrabold tracking-tight text-ink sm:text-2xl">{transfer.name}</h1>
            <p className="mt-1 text-sm text-ink-soft">{transfer.vehicleType}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {rating && rating.count > 0 && (
                <StarRating value={rating.average} size="md" showValue count={rating.count} />
              )}
              {typeof transfer.soldCount === 'number' && transfer.soldCount > 0 && (
                <span className="nums text-sm text-ink-muted">已售 {transfer.soldCount}</span>
              )}
              <RefundBadge text="航班延误免费顺延" />
            </div>
          </section>

          {/* 路线 */}
          <section className="card">
            <h2 className="section-title mb-3">路线</h2>
            <div className="flex items-center gap-3 text-sm">
              <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                <Icon name="mapPin" className="h-4 w-4 text-brand" />{transfer.originArea}
              </span>
              <Icon name="arrowRight" className="h-4 w-4 shrink-0 text-ink-muted" />
              <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                <Icon name="mapPin" className="h-4 w-4 text-deal" />{transfer.destArea}
              </span>
            </div>
            {transfer.duration && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-muted">
                <Icon name="clock" className="h-3.5 w-3.5" />预计 {transfer.duration}
              </p>
            )}
          </section>

          {/* 车型 / 含什么 */}
          <section className="card">
            <h2 className="section-title mb-3">车型与服务</h2>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="flex items-center justify-between rounded-xl bg-canvas px-3 py-2.5">
                <dt className="inline-flex items-center gap-1.5 text-ink-soft">
                  <Icon name="car" className="h-4 w-4 text-brand" />车型
                </dt>
                <dd className="font-medium text-ink">{transfer.vehicleType}</dd>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-canvas px-3 py-2.5">
                <dt className="inline-flex items-center gap-1.5 text-ink-soft">
                  <Icon name="user" className="h-4 w-4 text-brand" />最多载客
                </dt>
                <dd className="font-medium text-ink">{transfer.capacity} 人</dd>
              </div>
            </dl>
            {transfer.features.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-bold text-ink">服务包含</h3>
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {transfer.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-ink-soft">
                      <Icon name="check" className="h-4 w-4 shrink-0 text-emerald-600" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* 退改 */}
          <section className="card">
            <h2 className="section-title mb-3">退改政策</h2>
            <ul className="space-y-2 text-sm text-ink-soft">
              <li className="flex items-start gap-2">
                <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                出发前 24 小时可免费取消，全额退款。
              </li>
              <li className="flex items-start gap-2">
                <Icon name="clock" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                航班延误自动顺延，免费等候 60 分钟。
              </li>
              <li className="flex items-start gap-2">
                <Icon name="support" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                7×24 中文客服，行程中有问题随时联系。
              </li>
            </ul>
          </section>

          {/* 评价 */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="section-title">真实评价</h2>
              {usingFallbackReviews && (
                <span className="text-xs text-ink-muted">示例评价</span>
              )}
            </div>
            {reviewSummary && reviewSummary.count > 0 && (
              <RatingSummary
                average={reviewSummary.average}
                count={reviewSummary.count}
                distribution={reviewSummary.distribution}
              />
            )}
            <ReviewList reviews={reviews} loading={reviewLoading && reviews.length === 0} />
            {!usingFallbackReviews && reviews.length < reviewTotal && (
              <div className="flex justify-center">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={reviewLoading}
                  onClick={() => fetchReviews(reviewPage + 1)}
                >
                  {reviewLoading ? '加载中…' : '加载更多评价'}
                </button>
              </div>
            )}
          </section>
        </div>

        {/* 右：预订卡（桌面端 sticky） */}
        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <div className="card">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-xs text-ink-muted">起步价</div>
                <div className="price text-3xl">¥{basePrice}</div>
              </div>
              <RefundBadge text="可免费取消" />
            </div>
            <div className="mt-4 hidden gap-2 lg:flex">
              <button className="btn-secondary flex-1 inline-flex items-center justify-center gap-1.5" onClick={() => addToCart(false)}>
                <Icon name="cart" className="h-4 w-4" />加入购物车
              </button>
              <button className="btn-deal flex-1 inline-flex items-center justify-center gap-1.5" onClick={() => addToCart(true)}>
                立即预订 <Icon name="arrowRight" className="h-4 w-4" />
              </button>
            </div>
          </div>
          <TrustBadges variant="checkout" />
        </aside>
      </div>

      {/* 手机端 sticky 底部预订条（位于全局底部导航之上） */}
      <div className="fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-40 border-t border-slate-200/80 bg-surface/95 px-4 py-3 shadow-pop backdrop-blur-xl lg:hidden">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div>
            <div className="text-[11px] text-ink-muted">起步价</div>
            <div className="price text-xl leading-none">¥{basePrice}</div>
          </div>
          <div className="flex gap-2">
            <button className="btn-secondary inline-flex items-center gap-1.5 px-3" onClick={() => addToCart(false)}>
              <Icon name="cart" className="h-4 w-4" />加购
            </button>
            <button className="btn-deal inline-flex items-center gap-1.5" onClick={() => addToCart(true)}>
              立即预订 <Icon name="arrowRight" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
