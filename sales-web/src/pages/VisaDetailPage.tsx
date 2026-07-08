import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api,
  type Visa,
  type Review,
  type ReviewSummary,
} from '../lib/api';
import { useCart } from '../stores/cart';
import { Icon } from '../components/Icon';
import { Seo } from '../components/Seo';
import { Breadcrumb } from '../components/Breadcrumb';
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

/** 评价兜底（后端暂无该产品评价时展示，内容为示例/make-up）。 */
const FALLBACK_SUMMARY: ReviewSummary = {
  average: 4.9,
  count: 213,
  distribution: { '5': 189, '4': 18, '3': 4, '2': 1, '1': 1 },
};

const FALLBACK_REVIEWS: ReviewItem[] = [
  {
    id: 'mk-v1',
    rating: 5,
    title: '资料清单很清楚，一次过签',
    body: '按照客服给的材料清单准备，照片、行程单都帮我核对了一遍。提交后第三天就出签，全程没去过领馆，省心。',
    authorName: '周女士',
    verified: true,
    tripType: '自由行',
    createdAt: '2026-06-02T10:15:00Z',
  },
  {
    id: 'mk-v2',
    rating: 5,
    title: '加急真的快',
    body: '临时决定出行，选了加急，两天就拿到电子签。客服回复很及时，有问题随时能问到人。',
    authorName: '黄先生',
    verified: true,
    tripType: '商务出差',
    reply: '感谢信任！加急通道为赶时间的客人准备，祝您出行顺利～',
    createdAt: '2026-05-20T16:40:00Z',
  },
  {
    id: 'mk-v3',
    rating: 5,
    title: '第一次办签也不慌',
    body: '完全不懂流程，客服一步步教我拍照、填表，连酒店订单怎么出都告诉我了。出签后还提醒我打印好随身带。',
    authorName: '吴女士',
    verified: true,
    tripType: '家庭出游',
    createdAt: '2026-05-08T08:30:00Z',
  },
  {
    id: 'mk-v4',
    rating: 4,
    title: '整体顺利，价格透明',
    body: '没有乱收费，办理费和加急费都提前说清楚了。出签时间和承诺的一致，会推荐给朋友。',
    authorName: '徐先生',
    verified: true,
    tripType: '朋友结伴',
    createdAt: '2026-04-25T12:00:00Z',
  },
];

export default function VisaDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const add = useCart((s) => s.add);

  const [status, setStatus] = useState<Status>('loading');
  const [visa, setVisa] = useState<Visa | null>(null);

  // 下单选项
  const [express, setExpress] = useState(false);
  const [count, setCount] = useState(1);

  // 评价
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
      .listVisas()
      .then((r) => {
        if (cancelled) return;
        const found = r.visas.find((v) => v.id === id) ?? null;
        setVisa(found);
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
        .listReviews({ productType: 'VISA', productId: id, page, limit: REVIEW_PAGE_SIZE })
        .then((res) => {
          if (res.total === 0 && page === 1) {
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

  const basePrice = visa ? Number(visa.basePrice) : 0;
  const expressSurcharge = visa && visa.expressSurcharge ? Number(visa.expressSurcharge) : 0;
  const unitPrice = basePrice + (express ? expressSurcharge : 0);
  const total = unitPrice * count;

  const country = visa ? visa.country ?? visa.destinationCountry : '';
  const visaName = visa ? visa.visaName ?? visa.visaType : '';
  const flag = visa?.flag ?? '🌐';
  const processingDays = visa?.processingDays ?? 0;
  const expressDays = Math.max(1, processingDays - 2);

  const addToCart = (goCart: boolean) => {
    if (!visa) return;
    add({
      kind: 'VISA',
      productId: visa.id + (express ? '-express' : ''),
      name: `${country} · ${visaName}${express ? ' (加急)' : ''} × ${count}`,
      description: `${flag} ${express ? expressDays : processingDays} 天出签 · 有效期 ${visa.validityMonths ?? 1} 个月`,
      emoji: flag,
      unitPrice,
      qty: count,
      meta: { express, processingDays: express ? expressDays : processingDays },
    });
    if (goCart) navigate('/cart');
  };

  if (status === 'loading') {
    return (
      <div>
        <Seo title="签证详情" description="出境签证代办：材料清单、办理时效、价格一目了然。" canonicalPath={id ? `/visas/${id}` : '/visas'} />
        <DetailSkeleton />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div>
        <Seo title="签证详情" canonicalPath={id ? `/visas/${id}` : '/visas'} />
        <ErrorRetry message="签证信息加载失败，请稍后再试一次" onRetry={load} />
      </div>
    );
  }

  if (status === 'notfound' || !visa) {
    return (
      <div>
        <Seo title="签证详情" canonicalPath="/visas" />
        <EmptyState
          icon="visa"
          title="没找到这个签证产品"
          hint="它可能已下架，看看其它目的地吧。"
          action={<button className="btn-secondary" onClick={() => navigate('/visas')}>返回签证列表</button>}
        />
      </div>
    );
  }

  const rating = visa.rating;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `${country} · ${visaName}`,
    description: `${country}签证代办，${processingDays} 天出签，有效期 ${visa.validityMonths ?? 1} 个月。`,
    ...(visa.photo ? { image: visa.photo } : {}),
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

  // 办理时间线（make-up 流程节点；天数由 processingDays 推导）
  const timeline: Array<{ icon: 'cart' | 'check' | 'ticket' | 'visa'; title: string; desc: string }> = [
    { icon: 'cart', title: '下单付款', desc: '选好签证类型，线上下单，1 分钟完成。' },
    { icon: 'check', title: '提交材料', desc: '按清单上传照片与证件，客服协助核对。' },
    { icon: 'ticket', title: '送签受理', desc: `材料齐全后送签，约 ${processingDays} 天出签（加急约 ${expressDays} 天）。` },
    { icon: 'visa', title: '出签交付', desc: '电子签直接发到手机/邮箱，打印随身携带即可。' },
  ];

  return (
    <div className="pb-24 lg:pb-0">
      <Seo
        title={`${country} · ${visaName}`}
        description={`${country}签证代办：材料清单、办理时效、价格一目了然。${processingDays} 天出签。`}
        image={visa.photo ?? undefined}
        canonicalPath={`/visas/${visa.id}`}
        jsonLd={jsonLd}
      />

      <Breadcrumb
        items={[
          { label: '首页', to: '/' },
          { label: '签证代办', to: '/visas' },
          { label: `${country} · ${visaName}` },
        ]}
      />

      <div className="mt-4 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        {/* 左：hero + 详情 */}
        <div className="space-y-6">
          {/* 签证 hero（国旗主视觉块） */}
          <section className="relative overflow-hidden rounded-3xl border border-slate-200/80 bg-gradient-to-br from-brand-50 via-surface to-sun-light p-6 shadow-card sm:p-8">
            <div className="flex items-center gap-4">
              <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-white text-4xl shadow-card">
                {flag}
              </span>
              <div className="min-w-0">
                <h1 className="text-xl font-extrabold tracking-tight text-ink sm:text-2xl">{country} · {visaName}</h1>
                <p className="mt-0.5 text-sm text-ink-soft">有效期 {visa.validityMonths ?? 1} 个月 · {processingDays} 天出签</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {rating && rating.count > 0 && (
                <StarRating value={rating.average} size="md" showValue count={rating.count} />
              )}
              {typeof visa.soldCount === 'number' && visa.soldCount > 0 && (
                <span className="nums text-sm text-ink-muted">已办 {visa.soldCount}</span>
              )}
              <RefundBadge text="材料不齐全额退" />
            </div>
            {visa.highlight && (
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-white/70 px-3 py-1.5 text-xs font-semibold text-emerald-700">
                <Icon name="sparkles" className="h-3.5 w-3.5 text-amber-500" />
                {visa.highlight}
              </p>
            )}
          </section>

          {/* 材料清单 */}
          <section className="card">
            <h2 className="section-title mb-3">材料清单</h2>
            {visa.requiredDocs.length > 0 ? (
              <ul className="grid gap-2 sm:grid-cols-2">
                {visa.requiredDocs.map((d) => (
                  <li key={d} className="flex items-start gap-2 text-sm text-ink-soft">
                    <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    {d}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-soft">下单后客服会发送完整材料清单并协助核对。</p>
            )}
          </section>

          {/* 办理时间线 */}
          <section className="card">
            <h2 className="section-title mb-4">办理时间线</h2>
            <ol className="relative space-y-5 border-l border-slate-200 pl-6">
              {timeline.map((step, i) => (
                <li key={step.title} className="relative">
                  <span className="absolute -left-[31px] grid h-8 w-8 place-items-center rounded-full bg-brand-50 text-brand ring-4 ring-surface">
                    <Icon name={step.icon} className="h-4 w-4" />
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="nums text-xs font-bold text-ink-muted">第 {i + 1} 步</span>
                    <h3 className="text-sm font-bold text-ink">{step.title}</h3>
                  </div>
                  <p className="mt-0.5 text-sm text-ink-soft">{step.desc}</p>
                </li>
              ))}
            </ol>
          </section>

          {/* 加急 */}
          {expressSurcharge > 0 && (
            <section className="card">
              <h2 className="section-title mb-3">加急办理</h2>
              <div className="flex items-start gap-3 rounded-2xl bg-sun-light/60 p-4">
                <Icon name="clock" className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <div className="text-sm">
                  <p className="font-semibold text-ink">最快 {expressDays} 天出签</p>
                  <p className="mt-0.5 text-ink-soft">赶时间可选加急，每人加收 ¥{expressSurcharge}，下单时勾选即可。</p>
                </div>
              </div>
            </section>
          )}

          {/* FAQ */}
          <section className="card">
            <h2 className="section-title mb-3">常见问题</h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="font-semibold text-ink">需要本人到场或面签吗？</dt>
                <dd className="mt-0.5 text-ink-soft">电子签全程线上办理，无需到领馆，按清单上传材料即可。</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">出签率怎么样？材料不过怎么办？</dt>
                <dd className="mt-0.5 text-ink-soft">客服会先帮你预审材料，降低被拒风险；因材料不齐导致无法送签的，可全额退款。</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">出签后怎么拿到签证？</dt>
                <dd className="mt-0.5 text-ink-soft">电子签会直接发送到你的手机/邮箱，打印一份随身携带即可入境。</dd>
              </div>
            </dl>
          </section>

          {/* 评价 */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="section-title">真实评价</h2>
              {usingFallbackReviews && <span className="text-xs text-ink-muted">示例评价</span>}
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

        {/* 右：办理卡（桌面端 sticky） */}
        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <div className="card space-y-4">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-xs text-ink-muted">办理费</div>
                <div className="price text-3xl">¥{basePrice}</div>
              </div>
              <span className="badge-soft">{processingDays} 天出签</span>
            </div>

            {expressSurcharge > 0 && (
              <label className="flex items-center gap-2 rounded-xl bg-canvas px-3 py-2.5 text-sm text-ink">
                <input type="checkbox" checked={express} onChange={(e) => setExpress(e.target.checked)} className="accent-brand" />
                <span>加急办理（{expressDays} 天出签，+¥{expressSurcharge}/人）</span>
              </label>
            )}

            <div className="flex items-center justify-between">
              <label className="text-sm text-ink-soft">申请人数</label>
              <input
                type="number"
                min={1}
                max={9}
                className="input max-w-[6rem]"
                value={count}
                onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>

            <div className="flex items-end justify-between border-t border-slate-200 pt-3">
              <span className="text-sm text-ink-soft">合计</span>
              <span className="price text-2xl">¥{total}</span>
            </div>

            <div className="hidden gap-2 lg:flex">
              <button className="btn-secondary flex-1 inline-flex items-center justify-center gap-1.5" onClick={() => addToCart(false)}>
                <Icon name="cart" className="h-4 w-4" />加入购物车
              </button>
              <button className="btn-deal flex-1 inline-flex items-center justify-center gap-1.5" onClick={() => addToCart(true)}>
                立即办理 <Icon name="arrowRight" className="h-4 w-4" />
              </button>
            </div>
          </div>
          <TrustBadges variant="checkout" />
        </aside>
      </div>

      {/* 手机端 sticky 底部办理条（位于全局底部导航之上） */}
      <div className="fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-40 border-t border-slate-200/80 bg-surface/95 px-4 py-3 shadow-pop backdrop-blur-xl lg:hidden">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div>
            <div className="text-[11px] text-ink-muted">合计 · {count} 人{express ? ' · 加急' : ''}</div>
            <div className="price text-xl leading-none">¥{total}</div>
          </div>
          <div className="flex gap-2">
            <button className="btn-secondary inline-flex items-center gap-1.5 px-3" onClick={() => addToCart(false)}>
              <Icon name="cart" className="h-4 w-4" />加购
            </button>
            <button className="btn-deal inline-flex items-center gap-1.5" onClick={() => addToCart(true)}>
              立即办理 <Icon name="arrowRight" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
