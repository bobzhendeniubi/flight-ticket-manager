import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Hotel } from '../lib/api';
import { useCart } from '../stores/cart';
import { Icon } from '../components/Icon';
import { Img } from '../components/Img';
import { SortSelect, type SortOption } from '../components/SortSelect';
import { StarRating } from '../components/StarRating';
import { RefundBadge } from '../components/RefundBadge';
import { ListSkeleton } from '../components/LoadingSkeleton';
import { ErrorRetry } from '../components/ErrorRetry';
import { EmptyState } from '../components/EmptyState';
import { Seo } from '../components/Seo';

/** 酒店星级 → 实心星图标行（与「点评评分」的金星刻意区分：这是建筑挂牌星级）。 */
function HotelClassStars({ count, className }: { count: number; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className ?? ''}`} aria-label={`${count} 星级酒店`}>
      {Array.from({ length: count }).map((_, i) => (
        <Icon key={i} name="star" className="h-3 w-3" />
      ))}
    </span>
  );
}

/** 列表排序口径（对标 Klook/携程）。值会写入 URL（?sort=）。 */
const SORT_OPTIONS: SortOption[] = [
  { value: 'recommended', label: '推荐排序' },
  { value: 'price_asc', label: '价格从低到高' },
  { value: 'price_desc', label: '价格从高到低' },
  { value: 'rating', label: '好评优先' },
  { value: 'sold', label: '热度优先' },
];
const SORT_VALUES = new Set(SORT_OPTIONS.map((o) => o.value));

type LoadState = 'loading' | 'error' | 'ready';

function basePriceNum(h: Hotel): number {
  return Number(h.basePrice ?? 0);
}

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function HotelsPage() {
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');
  const [city, setCity] = useState('');
  const [stars, setStars] = useState<'' | '3' | '4' | '5'>('');
  const [maxPrice, setMaxPrice] = useState(4000);
  const [checkIn, setCheckIn] = useState(todayISO(3));
  const [checkOut, setCheckOut] = useState(todayISO(5));
  const [amenityFilter, setAmenityFilter] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const add = useCart((s) => s.add);
  const navigate = useNavigate();

  // 排序持久化到 URL（?sort=），刷新/分享保留口径
  const [searchParams, setSearchParams] = useSearchParams();
  const sortParam = searchParams.get('sort') ?? '';
  const sort = SORT_VALUES.has(sortParam) ? sortParam : 'recommended';
  const setSort = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'recommended') next.delete('sort');
    else next.set('sort', value);
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    let cancelled = false;
    setLoad('loading');
    api
      .listHotels()
      .then((r) => {
        if (cancelled) return;
        setHotels(r.hotels);
        setLoad('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setLoad('error');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // 全量设施集合（用于多选筛选；不依赖新接口，从已加载酒店聚合）
  const allAmenities = useMemo(() => {
    const set = new Set<string>();
    for (const h of hotels) for (const a of h.amenities) set.add(a);
    return Array.from(set);
  }, [hotels]);

  const toggleAmenity = (a: string) =>
    setAmenityFilter((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]));

  const filtered = useMemo(() => {
    const list = hotels.filter((h) => {
      if (city && h.cityCode !== city) return false;
      if (stars && h.starRating !== Number(stars)) return false;
      if (basePriceNum(h) > maxPrice) return false;
      if (amenityFilter.length > 0 && !amenityFilter.every((a) => h.amenities.includes(a)))
        return false;
      return true;
    });
    const sorted = [...list];
    switch (sort) {
      case 'price_asc':
        sorted.sort((a, b) => basePriceNum(a) - basePriceNum(b));
        break;
      case 'price_desc':
        sorted.sort((a, b) => basePriceNum(b) - basePriceNum(a));
        break;
      case 'rating':
        sorted.sort((a, b) => (b.rating?.average ?? 0) - (a.rating?.average ?? 0));
        break;
      case 'sold':
        sorted.sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0));
        break;
      default:
        break; // recommended = 后端返回顺序
    }
    return sorted;
  }, [hotels, city, stars, maxPrice, amenityFilter, sort]);

  const nights = Math.max(
    1,
    Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000),
  );

  /** 卡片内直接加购：取最便宜房型 × 1 间 × nights 晚（不打断列表流，详情页可精选房型）。 */
  const quickAdd = (h: Hotel) => {
    const cheapest = [...h.roomTypes].sort(
      (a, b) =>
        Number(a.basePrice) * Number(a.priceMultiplier ?? 1) -
        Number(b.basePrice) * Number(b.priceMultiplier ?? 1),
    )[0];
    const perNight = cheapest
      ? Math.round(Number(cheapest.basePrice) * Number(cheapest.priceMultiplier ?? 1))
      : basePriceNum(h);
    const roomName = cheapest?.name ?? '标准房';
    add({
      kind: 'HOTEL',
      productId: cheapest ? cheapest.id : `${h.id}-${roomName}`,
      name: `${h.name} · ${roomName} × 1 房 · ${nights} 晚`,
      description: `${h.area ?? h.address} · ${'★'.repeat(h.starRating)} · ${cheapest?.bedType ?? ''}`,
      emoji: h.emoji ?? '🏨',
      unitPrice: perNight * nights,
      qty: 1,
      meta: {
        checkIn,
        checkOut,
        nights,
        roomType: roomName,
        rooms: 1,
        hotelRoomTypeId: cheapest ? cheapest.id : '',
      },
    });
  };

  return (
    <div className="space-y-6">
      <Seo
        title="酒店预订"
        description="覆盖岘港 / 会安等海岛目的地的精选酒店，房型、设施、真实点评一目了然，与航班打包更划算。"
        canonicalPath="/hotels"
      />

      <section className="card">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">酒店预订</h1>
        <p className="mt-1 text-sm text-ink-soft">
          覆盖东南亚 / 中国港澳 / 全球主要城市，与航班打包可享额外折扣。下方为本月精选房型。
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-5">
          <div>
            <label className="label">目的地</label>
            <select className="input" value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="">全部（岘港 + 会安）</option>
              <option value="DAD">岘港</option>
              <option value="HOA">会安</option>
            </select>
          </div>
          <div>
            <label className="label">入住</label>
            <input type="date" className="input" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
          </div>
          <div>
            <label className="label">退房</label>
            <input
              type="date"
              className="input"
              value={checkOut}
              min={checkIn}
              onChange={(e) => setCheckOut(e.target.value)}
            />
          </div>
          <div>
            <label className="label">星级</label>
            <select className="input" value={stars} onChange={(e) => setStars(e.target.value as '' | '3' | '4' | '5')}>
              <option value="">不限</option>
              <option value="3">三星</option>
              <option value="4">四星</option>
              <option value="5">五星</option>
            </select>
          </div>
          <div>
            <label className="label">价格上限 ¥{maxPrice}</label>
            <input
              type="range"
              min={500}
              max={4000}
              step={100}
              className="w-full"
              value={maxPrice}
              onChange={(e) => setMaxPrice(Number(e.target.value))}
            />
          </div>
        </div>

        {/* 设施多选筛选（从已加载酒店聚合，不依赖新接口） */}
        {allAmenities.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">设施筛选</span>
              {amenityFilter.length > 0 && (
                <button
                  type="button"
                  className="text-xs font-semibold text-brand hover:underline"
                  onClick={() => setAmenityFilter([])}
                >
                  清空（{amenityFilter.length}）
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allAmenities.map((a) => {
                const on = amenityFilter.includes(a);
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() => toggleAmenity(a)}
                    aria-pressed={on}
                    className={`chip cursor-pointer transition-colors ${
                      on
                        ? 'border-brand bg-brand-50 text-brand-700'
                        : 'hover:border-brand/40 hover:text-brand-700'
                    }`}
                  >
                    {on && <Icon name="check" className="h-3 w-3" />}
                    {a}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="section-title">精选酒店</p>
            {load === 'ready' && (
              <p className="text-sm text-ink-muted">找到 {filtered.length} 家 · {nights} 晚</p>
            )}
          </div>
          <SortSelect value={sort} options={SORT_OPTIONS} onChange={setSort} />
        </div>

        {load === 'loading' && <ListSkeleton rows={5} />}

        {load === 'error' && (
          <ErrorRetry
            message="酒店列表没能加载出来，请稍后重试。"
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        )}

        {load === 'ready' && filtered.length === 0 && (
          <EmptyState
            icon="hotel"
            title="没有符合条件的酒店"
            hint="试着放宽星级、价格或设施筛选，换个日期也许有惊喜。"
            action={
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setCity('');
                  setStars('');
                  setMaxPrice(4000);
                  setAmenityFilter([]);
                }}
              >
                重置筛选
              </button>
            }
          />
        )}

        {load === 'ready' && filtered.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map((h) => (
              <HotelCard
                key={h.id}
                hotel={h}
                onOpen={() => navigate(`/hotels/${h.id}`)}
                onQuickAdd={() => quickAdd(h)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface HotelCardProps {
  hotel: Hotel;
  onOpen: () => void;
  onQuickAdd: () => void;
}

const CARD_AMENITIES = 3;

function HotelCard({ hotel, onOpen, onQuickAdd }: HotelCardProps) {
  const rating = hotel.rating;
  const extraAmenities = hotel.amenities.length - CARD_AMENITIES;

  return (
    <article
      className="card-interactive group flex cursor-pointer flex-col overflow-hidden"
      onClick={onOpen}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="relative overflow-hidden bg-slate-100">
        <Img src={hotel.photos[0] ?? ''} alt={hotel.name} ratio="4/3" className="img-zoom" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/35 to-transparent" />
        {/* 挂牌星级（建筑级别，区别于点评评分） */}
        <span className="badge-sun absolute left-3 top-3 shadow-card">
          <HotelClassStars count={hotel.starRating} />
        </span>
        {/* 点评评分（金星 + 数值），仅在有真实评分时显示 */}
        {rating && rating.count > 0 && (
          <span className="absolute right-3 top-3 inline-flex items-center rounded-full bg-white/95 px-2 py-1 shadow-card backdrop-blur">
            <StarRating value={rating.average} size="sm" showValue />
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-4">
        <h3 className="font-bold text-ink">{hotel.name}</h3>
        {hotel.nameEn && <p className="text-xs text-ink-muted">{hotel.nameEn}</p>}
        <p className="mt-1 inline-flex items-center gap-1 text-xs text-ink-soft">
          <Icon name="mapPin" className="h-3 w-3 shrink-0" />
          {hotel.area ?? hotel.address}
          {typeof hotel.soldCount === 'number' && hotel.soldCount > 0 && (
            <span className="text-ink-muted">· 已售 {hotel.soldCount}</span>
          )}
        </p>
        {hotel.highlight && (
          <p className="mt-2 line-clamp-2 text-xs italic text-ink-soft">{hotel.highlight}</p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {hotel.amenities.slice(0, CARD_AMENITIES).map((a) => (
            <span key={a} className="chip">{a}</span>
          ))}
          {extraAmenities > 0 && (
            <button
              type="button"
              className="chip cursor-pointer text-brand-700 hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
            >
              查看全部 +{extraAmenities}
            </button>
          )}
        </div>

        <div className="mt-3">
          <RefundBadge />
        </div>

        <div className="mt-4 flex items-end justify-between border-t border-slate-100 pt-3">
          <div>
            <div className="text-xs text-ink-muted">每晚起</div>
            <div className="flex items-baseline gap-1">
              <span className="price text-xl">¥{basePriceNum(hotel)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn-secondary inline-flex items-center gap-1 py-1.5 text-sm"
              onClick={(e) => {
                e.stopPropagation();
                onQuickAdd();
              }}
            >
              <Icon name="cart" className="h-4 w-4" />
              加购
            </button>
            <button
              className="btn-deal py-1.5 text-sm"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
            >
              查看详情
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
