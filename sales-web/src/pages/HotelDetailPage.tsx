import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api,
  type Hotel,
  type HotelAvailabilityTier,
  type HotelRoomType,
  type Review,
} from '../lib/api';
import { businessToday } from '../lib/datetime';
import { useCart } from '../stores/cart';
import { Icon } from '../components/Icon';
import { Seo } from '../components/Seo';
import { Breadcrumb } from '../components/Breadcrumb';
import { PhotoGallery, type GalleryImage } from '../components/PhotoGallery';
import { StarRating } from '../components/StarRating';
import { RatingSummary } from '../components/RatingSummary';
import { ReviewList, type ReviewItem } from '../components/ReviewList';
import { RefundBadge } from '../components/RefundBadge';
import { ScarcityBadge, type ScarcityKind } from '../components/ScarcityBadge';
import { TrustBadges } from '../components/TrustBadges';
import { DetailSkeleton } from '../components/LoadingSkeleton';
import { ErrorRetry } from '../components/ErrorRetry';
import { EmptyState } from '../components/EmptyState';

// ── 房量档位文案（买家只看档位，不看精确房量；与六档余位同纪律） ──────────────
const TIER_LABEL: Record<HotelAvailabilityTier, string> = {
  AMPLE: '房量充足',
  TIGHT: '房量紧张',
  LOW: '仅剩少量',
  SOLD_OUT: '已订满',
};
const TIER_SCARCITY: Record<HotelAvailabilityTier, ScarcityKind> = {
  AMPLE: 'soldRecently',
  TIGHT: 'low',
  LOW: 'hot',
  SOLD_OUT: 'low',
};

const REVIEWS_PER_PAGE = 5;

/** 入住/退房日默认值。按北京口径取「今天」再加天数，见 lib/datetime.ts。 */
function todayISO(offsetDays = 0): string {
  return businessToday(offsetDays);
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.max(
    1,
    Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000),
  );
}

// basePrice 已是该房型最终单价（含倍率），priceMultiplier 为遗留字段，不再参与计价，
// 否则会与后端收款口径（只认 basePrice）不一致，导致下单被拒。
function roomPerNight(rt: HotelRoomType): number {
  return Math.round(Number(rt.basePrice));
}

// ── 评论：make up（按需求写的样例评价）；与后端真实评价合并展示 ──────────────
const MOCK_AUTHORS = ['张女士', '李先生', 'Emily W.', '王同学', '陈太太', '刘工', 'Sophie L.', '黄先生'];
const MOCK_TRIPS = ['亲子出游', '情侣度假', '朋友结伴', '商务出行', '独自旅行'];
const MOCK_BODIES = [
  '位置很棒，步行就能到海边，前台中文服务很贴心，办理入住很快。房间干净，海景阳台拍照超出片。',
  '性价比很高，早餐种类丰富，泳池干净人也不多。带娃来住非常合适，会再回购。',
  '房间比照片还要大，隔音不错，晚上睡得很安稳。距离机场不远，接送也方便。',
  '整体体验超出预期，工作人员热情，帮我们升级了房型。周边吃饭购物都方便，强烈推荐。',
  '设施有点年代感但打扫得很干净，胜在地段和价格。客服回复消息很及时，办事靠谱。',
  '第二次来住了，依旧满意。床很舒服，热水很足，空调制冷快。打包机票一起订更划算。',
];
const MOCK_REPLIES = [
  '感谢您的入住与认可！期待下次为您和家人服务～',
  '谢谢您的好评！已将您的建议同步房务团队，欢迎再来。',
];

/** 用酒店 id 做种子，稳定生成一组样例评价（刷新不跳变）。 */
function makeMockReviews(hotel: Hotel): ReviewItem[] {
  const seedBase = hotel.id.split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const count = 6;
  return Array.from({ length: count }, (_, i): ReviewItem => {
    const seed = seedBase + i * 7;
    const rating = 5 - (seed % 3 === 0 ? 1 : 0); // 多数 5 星，少量 4 星
    const daysAgo = (seed % 60) + i * 3 + 1;
    const created = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    return {
      id: `mock-${hotel.id}-${i}`,
      rating,
      body: MOCK_BODIES[seed % MOCK_BODIES.length],
      authorName: MOCK_AUTHORS[seed % MOCK_AUTHORS.length],
      verified: true,
      tripType: MOCK_TRIPS[seed % MOCK_TRIPS.length],
      reply: i % 3 === 0 ? MOCK_REPLIES[seed % MOCK_REPLIES.length] : undefined,
      createdAt: created,
    };
  });
}

function reviewToItem(r: Review): ReviewItem {
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

type LoadState = 'loading' | 'error' | 'ready' | 'notfound';

export default function HotelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const add = useCart((s) => s.add);

  const [hotel, setHotel] = useState<Hotel | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  // 选房与日期
  const [selectedRoomIdx, setSelectedRoomIdx] = useState(0);
  const [rooms, setRooms] = useState(1);
  const [checkIn, setCheckIn] = useState(todayISO(3));
  const [checkOut, setCheckOut] = useState(todayISO(5));

  // 房量档位（按 选中房型 × 日期 查询；只回档位不回数字）
  const [tier, setTier] = useState<HotelAvailabilityTier | null>(null);

  // 评价
  const [realReviews, setRealReviews] = useState<ReviewItem[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [visibleReviews, setVisibleReviews] = useState(REVIEWS_PER_PAGE);

  // ── 拉酒店（复用列表接口 + 按 id 命中） ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoad('loading');
    api
      .listHotels()
      .then((r) => {
        if (cancelled) return;
        const found = r.hotels.find((h) => h.id === id);
        if (!found) {
          setLoad('notfound');
          return;
        }
        setHotel(found);
        setSelectedRoomIdx(0);
        setLoad('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setLoad('error');
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  const room = hotel?.roomTypes[selectedRoomIdx];
  const nights = nightsBetween(checkIn, checkOut);
  const perNight = room ? roomPerNight(room) : 0;
  const total = perNight * nights * rooms;

  // ── 房量档位（选中房型 × 日期变化时查询；未配置 → null，不拦截销售） ────────
  useEffect(() => {
    if (!room) return;
    let cancelled = false;
    setTier(null);
    api
      .getHotelAvailability({ hotelRoomTypeId: room.id, checkIn, checkOut })
      .then((r) => {
        if (!cancelled) setTier(r.tier);
      })
      .catch(() => {
        if (!cancelled) setTier(null); // 查询失败按"不展示档位"处理，不拦截
      });
    return () => {
      cancelled = true;
    };
  }, [room, checkIn, checkOut]);

  // ── 真实评价（按选中房型聚合；HOTEL 的 productId = hotelRoomTypeId） ────────
  useEffect(() => {
    if (!hotel || hotel.roomTypes.length === 0) return;
    let cancelled = false;
    setReviewsLoading(true);
    // 聚合该酒店所有房型的评价（买家视角看的是"这家酒店"的口碑）
    Promise.all(
      hotel.roomTypes.map((rt) =>
        api
          .listReviews({ productType: 'HOTEL', productId: rt.id, limit: 50 })
          .then((res) => res.items)
          .catch(() => [] as Review[]),
      ),
    )
      .then((batches) => {
        if (cancelled) return;
        const merged = new Map<string, Review>();
        for (const items of batches) for (const it of items) merged.set(it.id, it);
        setRealReviews(Array.from(merged.values()).map(reviewToItem));
      })
      .finally(() => {
        if (!cancelled) setReviewsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hotel]);

  // 真实评价在前，样例评价补足（按需求 make up），按时间倒序
  const allReviews = useMemo(() => {
    if (!hotel) return [];
    const mock = makeMockReviews(hotel);
    const combined = [...realReviews, ...mock];
    return combined.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [hotel, realReviews]);

  // 评分聚合：优先后端 rating（{average,count} 真实聚合）；否则用合并后的评价口径
  const ratingSummary = useMemo(() => {
    const dist: Record<'5' | '4' | '3' | '2' | '1', number> = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
    for (const r of allReviews) {
      const k = String(Math.max(1, Math.min(5, Math.round(r.rating)))) as '5' | '4' | '3' | '2' | '1';
      dist[k] += 1;
    }
    const count = allReviews.length;
    const sum = allReviews.reduce((s, r) => s + r.rating, 0);
    const computedAvg = count > 0 ? sum / count : 0;
    const pr = hotel?.rating;
    return {
      average: pr && pr.count > 0 ? pr.average : computedAvg,
      count: pr && pr.count > 0 ? Math.max(pr.count, count) : count,
      distribution: dist,
    };
  }, [allReviews, hotel]);

  const handleAdd = useCallback(
    (goCart: boolean) => {
      if (!hotel || !room) return;
      add({
        kind: 'HOTEL',
        productId: room.id,
        name: `${hotel.name} · ${room.name} × ${rooms} 房 · ${nights} 晚`,
        description: `${hotel.area ?? hotel.address} · ${'★'.repeat(hotel.starRating)} · ${room.bedType ?? ''}`,
        emoji: hotel.emoji ?? '🏨',
        unitPrice: total,
        qty: 1,
        meta: {
          checkIn,
          checkOut,
          nights,
          roomType: room.name,
          rooms,
          hotelRoomTypeId: room.id,
        },
      });
      if (goCart) navigate('/cart');
    },
    [hotel, room, rooms, nights, total, checkIn, checkOut, add, navigate],
  );

  // ── 加载 / 错误 / 不存在 ─────────────────────────────────────────────────
  if (load === 'loading') {
    return (
      <main className="mx-auto max-w-4xl px-4 py-6">
        <Seo title="酒店详情" canonicalPath={id ? `/hotels/${id}` : '/hotels'} />
        <DetailSkeleton />
      </main>
    );
  }
  if (load === 'error') {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10">
        <Seo title="酒店详情" canonicalPath={id ? `/hotels/${id}` : '/hotels'} />
        <ErrorRetry
          message="酒店详情没能加载出来，请稍后重试。"
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      </main>
    );
  }
  if (load === 'notfound' || !hotel || !room) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10">
        <Seo title="酒店详情" canonicalPath="/hotels" />
        <EmptyState
          icon="hotel"
          title="没找到这家酒店"
          hint="它可能已下架或链接有误，去看看其他海岛精选吧。"
          action={
            <button type="button" className="btn-deal" onClick={() => navigate('/hotels')}>
              返回酒店列表
            </button>
          }
        />
      </main>
    );
  }

  // ── 结构化数据（Hotel + aggregateRating，利于搜索结果富摘要） ───────────────
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Hotel',
    name: hotel.name,
    description: hotel.highlight ?? undefined,
    image: hotel.photos.length > 0 ? hotel.photos : undefined,
    starRating: { '@type': 'Rating', ratingValue: hotel.starRating, bestRating: 5 },
    address: { '@type': 'PostalAddress', streetAddress: hotel.address, addressLocality: hotel.area ?? undefined },
    priceRange: `¥${Number(hotel.basePrice ?? 0)} 起/晚`,
    ...(ratingSummary.count > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: Number(ratingSummary.average.toFixed(1)),
            reviewCount: ratingSummary.count,
            bestRating: 5,
          },
        }
      : {}),
  };

  const galleryImages: GalleryImage[] = hotel.photos.map((url, i) => ({
    url,
    alt: `${hotel.name} 实拍 ${i + 1}`,
  }));

  const mapQuery = encodeURIComponent(`${hotel.name} ${hotel.address}`);
  const mapEmbed = `https://www.openstreetmap.org/export/embed.html?bbox=&layer=mapnik&marker=&query=${mapQuery}`;
  const mapLink = `https://www.openstreetmap.org/search?query=${mapQuery}`;

  return (
    <main className="mx-auto max-w-4xl px-4 py-5 pb-28 lg:pb-10">
      <Seo
        title={`${hotel.name} · 酒店预订`}
        description={hotel.highlight ?? `${hotel.name}：${hotel.starRating} 星海岛酒店，房型、设施与真实点评一目了然。`}
        image={hotel.photos[0]}
        canonicalPath={`/hotels/${hotel.id}`}
        jsonLd={jsonLd}
      />

      <div className="mb-3">
        <Breadcrumb
          items={[
            { label: '首页', to: '/' },
            { label: '酒店', to: '/hotels' },
            { label: hotel.name },
          ]}
        />
      </div>

      {/* 标题区 */}
      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge-sun inline-flex items-center" aria-label={`${hotel.starRating} 星级酒店`}>
            {Array.from({ length: hotel.starRating }).map((_, i) => (
              <Icon key={i} name="star" className="h-3 w-3" />
            ))}
          </span>
          {ratingSummary.count > 0 && (
            <StarRating value={ratingSummary.average} size="sm" showValue count={ratingSummary.count} />
          )}
          {typeof hotel.soldCount === 'number' && hotel.soldCount > 0 && (
            <span className="text-xs text-ink-muted">· 已售 {hotel.soldCount}</span>
          )}
        </div>
        <h1 className="mt-1.5 text-2xl font-extrabold tracking-tight text-ink">{hotel.name}</h1>
        {hotel.nameEn && <p className="text-sm text-ink-muted">{hotel.nameEn}</p>}
        <p className="mt-1 inline-flex items-center gap-1 text-sm text-ink-soft">
          <Icon name="mapPin" className="h-3.5 w-3.5 shrink-0" />
          {hotel.address}
        </p>
      </header>

      {/* 图廊 */}
      <PhotoGallery images={galleryImages} className="mb-5" />

      {hotel.highlight && (
        <p className="mb-5 rounded-2xl border border-brand-100 bg-brand-50/50 p-4 text-sm italic text-ink-soft">
          {hotel.highlight}
        </p>
      )}

      <div className="space-y-6">
        {/* ── 房型选择 + 下单 ────────────────────────────────────────────── */}
        <section aria-labelledby="rooms-heading" className="space-y-3">
          <h2 id="rooms-heading" className="section-title">
            选择房型（{hotel.roomTypes.length} 种）
          </h2>

          {/* 日期 + 房间数 */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label text-xs">入住</label>
              <input type="date" className="input" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
            </div>
            <div>
              <label className="label text-xs">退房</label>
              <input
                type="date"
                className="input"
                value={checkOut}
                min={checkIn}
                onChange={(e) => setCheckOut(e.target.value)}
              />
            </div>
            <div>
              <label className="label text-xs">房间数</label>
              <div className="flex h-10 items-center overflow-hidden rounded-xl border border-slate-200">
                <button
                  type="button"
                  className="h-full px-3 text-ink-soft transition-colors hover:bg-brand-50 disabled:text-slate-300"
                  disabled={rooms <= 1}
                  onClick={() => setRooms((n) => Math.max(1, n - 1))}
                  aria-label="减少房间数"
                >
                  −
                </button>
                <span className="nums flex-1 text-center font-semibold text-ink">{rooms}</span>
                <button
                  type="button"
                  className="h-full px-3 text-ink-soft transition-colors hover:bg-brand-50 disabled:text-slate-300"
                  disabled={rooms >= 9}
                  onClick={() => setRooms((n) => Math.min(9, n + 1))}
                  aria-label="增加房间数"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          {/* 房型列表 */}
          <ul className="space-y-2">
            {hotel.roomTypes.map((rt, idx) => {
              const selected = idx === selectedRoomIdx;
              const price = roomPerNight(rt);
              return (
                <li key={rt.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedRoomIdx(idx)}
                    aria-pressed={selected}
                    className={`w-full rounded-2xl border-2 p-3.5 text-left transition-all ${
                      selected ? 'border-brand bg-brand-50/60 shadow-card' : 'border-slate-200 hover:border-brand/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-ink">{rt.name}</span>
                          {selected && <span className="badge-soft">已选</span>}
                        </div>
                        <div className="mt-0.5 inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                          {rt.bedType && (
                            <span className="inline-flex items-center gap-1">
                              <Icon name="bed" className="h-3.5 w-3.5" />
                              {rt.bedType}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <Icon name="user" className="h-3.5 w-3.5" />
                            可住 {rt.capacity} 人
                          </span>
                          {/* 房量档位徽章 —— 仅在选中且后端有配置时展示，买家不看精确房量 */}
                          {selected && tier && (
                            <ScarcityBadge kind={TIER_SCARCITY[tier]} text={TIER_LABEL[tier]} />
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="price text-lg">¥{price}</div>
                        <div className="text-xs text-ink-muted">每晚</div>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* 价格汇总（桌面端常驻；移动端另有底栏） */}
          <div className="rounded-2xl border border-slate-200/80 bg-canvas p-4">
            <div className="flex justify-between text-sm">
              <span className="text-ink-soft">{room.name} · ¥{perNight}/晚</span>
              <span className="nums font-semibold text-ink">¥{perNight}</span>
            </div>
            <div className="mt-1 flex justify-between text-sm">
              <span className="text-ink-soft">{nights} 晚 × {rooms} 房</span>
              <span className="nums font-semibold text-ink">¥{(perNight * nights * rooms).toLocaleString()}</span>
            </div>
            <div className="mt-3 flex items-end justify-between border-t border-slate-200 pt-3">
              <span className="text-sm text-ink-soft">合计</span>
              <span className="price text-2xl">¥{total.toLocaleString()}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <RefundBadge />
              {tier && <ScarcityBadge kind={TIER_SCARCITY[tier]} text={TIER_LABEL[tier]} />}
            </div>
            <div className="mt-4 hidden gap-2 lg:flex">
              <button type="button" className="btn-secondary inline-flex flex-1 items-center justify-center gap-1.5" onClick={() => handleAdd(false)}>
                <Icon name="cart" className="h-4 w-4" />
                加入购物车
              </button>
              <button type="button" className="btn-deal inline-flex flex-1 items-center justify-center gap-1.5" onClick={() => handleAdd(true)}>
                立即预订 <Icon name="arrowRight" className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>

        {/* ── 酒店设施（全量） ────────────────────────────────────────────── */}
        {hotel.amenities.length > 0 && (
          <section aria-labelledby="amenities-heading">
            <h2 id="amenities-heading" className="section-title mb-3">酒店设施</h2>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {hotel.amenities.map((a) => (
                <li key={a} className="inline-flex items-center gap-2 rounded-xl bg-canvas px-3 py-2 text-sm text-ink-soft">
                  <Icon name="check" className="h-4 w-4 shrink-0 text-brand" />
                  {a}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── 位置（OpenStreetMap 内嵌，无新依赖） ──────────────────────────── */}
        <section aria-labelledby="location-heading">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="location-heading" className="section-title">位置 · 周边</h2>
            <a href={mapLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline">
              在地图中打开 <Icon name="arrowRight" className="h-3.5 w-3.5" />
            </a>
          </div>
          <p className="mb-2 inline-flex items-center gap-1 text-sm text-ink-soft">
            <Icon name="mapPin" className="h-4 w-4 shrink-0 text-brand" />
            {hotel.address}
          </p>
          <div className="overflow-hidden rounded-2xl border border-slate-200/80 shadow-card">
            <iframe
              title={`${hotel.name} 位置地图`}
              src={mapEmbed}
              loading="lazy"
              className="h-64 w-full border-0"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </section>

        {/* ── 预订须知 + 常见问题 ────────────────────────────────────────── */}
        <section aria-labelledby="policy-heading" className="space-y-2">
          <h2 id="policy-heading" className="section-title mb-1">预订须知 · 常见问题</h2>
          <Disclosure title="入住与退房" defaultOpen>
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
              <li>入住时间：14:00 后；退房时间：次日 12:00 前。</li>
              <li>请携带与预订人一致的有效证件办理入住。</li>
              <li>部分房型可能收取押金，离店无损退还。</li>
            </ul>
          </Disclosure>
          <Disclosure title="取消与退改">
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
              <li>出发前 7 天可免费取消，逾期按酒店政策收取费用。</li>
              <li>如需修改日期或房型，请尽早联系客服协助处理。</li>
            </ul>
          </Disclosure>
          <Disclosure title="儿童与加床">
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
              <li>多数房型可免费携带 1 名 12 岁以下儿童同住（不加床）。</li>
              <li>加床需视房型与库存，可能产生额外费用，以确认为准。</li>
            </ul>
          </Disclosure>
          <Disclosure title="发票与支付">
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
              <li>支持微信 / 支付宝 / 银行卡支付，信息全程加密。</li>
              <li>如需开具发票，请在下单备注或联系客服。</li>
            </ul>
          </Disclosure>
        </section>

        {/* ── 评分 + 评价 ────────────────────────────────────────────────── */}
        <section aria-labelledby="reviews-heading" className="space-y-4">
          <h2 id="reviews-heading" className="section-title">真实点评</h2>
          {ratingSummary.count > 0 && (
            <RatingSummary
              average={ratingSummary.average}
              count={ratingSummary.count}
              distribution={ratingSummary.distribution}
            />
          )}
          <ReviewList
            reviews={allReviews.slice(0, visibleReviews)}
            loading={reviewsLoading && allReviews.length === 0}
            emptyHint="成为第一个分享真实入住体验的人吧"
          />
          {visibleReviews < allReviews.length && (
            <div className="text-center">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setVisibleReviews((n) => n + REVIEWS_PER_PAGE)}
              >
                加载更多评价（{allReviews.length - visibleReviews}）
              </button>
            </div>
          )}
        </section>

        {/* ── 安心保障 ───────────────────────────────────────────────────── */}
        <section aria-label="安心保障">
          <TrustBadges variant="checkout" />
        </section>
      </div>

      {/* ── 移动端底部预订条（桌面端隐藏） ──────────────────────────────────── */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t border-slate-200/80 bg-surface/95 px-4 py-3 shadow-pop backdrop-blur-xl lg:hidden">
        <div className="min-w-0">
          <div className="truncate text-xs text-ink-muted">{nights} 晚 × {rooms} 房 · 合计</div>
          <div className="price text-xl leading-tight">¥{total.toLocaleString()}</div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" className="btn-secondary px-3 py-2" onClick={() => handleAdd(false)} aria-label="加入购物车">
            <Icon name="cart" className="h-5 w-5" />
          </button>
          <button type="button" className="btn-deal inline-flex items-center gap-1.5 px-5 py-2" onClick={() => handleAdd(true)}>
            立即预订
          </button>
        </div>
      </div>
    </main>
  );
}

// ── 折叠展开块（须知 / FAQ，用原生 <details> 保留无障碍与无 JS 兜底） ──────────
interface DisclosureProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function Disclosure({ title, defaultOpen, children }: DisclosureProps) {
  return (
    <details
      open={defaultOpen}
      className="group overflow-hidden rounded-2xl border border-slate-200/80 bg-surface"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-bold text-ink transition-colors hover:bg-canvas">
        {title}
        <Icon name="arrowRight" className="h-4 w-4 shrink-0 text-ink-muted transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-slate-100 px-4 py-3">{children}</div>
    </details>
  );
}
