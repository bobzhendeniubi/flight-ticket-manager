import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Transfer as ApiTransfer, type ProductRating } from '../lib/api';
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

/** 接送车型的展示结构（由接口原始数据归一化而来：价格转数字、可空字段填默认值）。 */
export interface Transfer {
  id: string;
  name: string;
  vehicleType: string;
  capacity: number;
  basePrice: number;
  originArea: string;
  destArea: string;
  emoji: string;
  photo: string;
  features: string[];
  duration: string;
}

/** 列表用车型：Transfer + 评分/销量（用于 StarRating、热度排序）。 */
type ListTransfer = Transfer & {
  rating?: ProductRating;
  soldCount?: number;
};

function transferApiToView(t: ApiTransfer): ListTransfer {
  return {
    id: t.id, name: t.name, vehicleType: t.vehicleType, capacity: t.capacity,
    basePrice: Number(t.basePrice), originArea: t.originArea, destArea: t.destArea,
    emoji: t.emoji ?? '🚗', photo: t.photo ?? '',
    features: t.features, duration: t.duration ?? '',
    rating: t.rating,
    soldCount: t.soldCount,
  };
}

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

type Status = 'loading' | 'error' | 'ready';

type SortKey = 'recommended' | 'price' | 'rating' | 'popular';

const SORT_OPTIONS: SortOption[] = [
  { value: 'recommended', label: '推荐' },
  { value: 'price', label: '价格优先' },
  { value: 'rating', label: '好评优先' },
  { value: 'popular', label: '热度优先' },
];

const SORT_KEYS: readonly SortKey[] = ['recommended', 'price', 'rating', 'popular'];

function isSortKey(v: string | null): v is SortKey {
  return v !== null && (SORT_KEYS as readonly string[]).includes(v);
}

function sortTransfers(list: ListTransfer[], sort: SortKey): ListTransfer[] {
  const copy = [...list];
  switch (sort) {
    case 'price':
      return copy.sort((a, b) => a.basePrice - b.basePrice);
    case 'rating':
      return copy.sort((a, b) => (b.rating?.average ?? 0) - (a.rating?.average ?? 0));
    case 'popular':
      return copy.sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0));
    default:
      return copy; // recommended：保持后端返回顺序
  }
}

export function TransfersPage() {
  const [transfers, setTransfers] = useState<ListTransfer[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [pickupAddress, setPickupAddress] = useState('');
  const [pickupDate, setPickupDate] = useState(todayISO(3));
  const [pickupTime, setPickupTime] = useState('07:00');
  const [passengers, setPassengers] = useState(1);
  const [vehicleType, setVehicleType] = useState('');
  const [selected, setSelected] = useState<ListTransfer | null>(null);

  // 排序持久化到 URL（?sort=），刷新/分享保留
  const [searchParams, setSearchParams] = useSearchParams();
  const sort: SortKey = isSortKey(searchParams.get('sort')) ? (searchParams.get('sort') as SortKey) : 'recommended';
  const setSort = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'recommended') params.delete('sort');
    else params.set('sort', next);
    setSearchParams(params, { replace: true });
  };

  const load = () => {
    setStatus('loading');
    let cancelled = false;
    api
      .listTransfers()
      .then((r) => {
        if (cancelled) return;
        setTransfers(r.transfers.map(transferApiToView));
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  };

  useEffect(load, []);

  // 车型筛选项（去重，来自实际数据）
  const vehicleTypes = useMemo(
    () => Array.from(new Set(transfers.map((t) => t.vehicleType))).sort(),
    [transfers],
  );

  const filtered = useMemo(() => {
    const base = transfers.filter((t) => {
      if (t.capacity < passengers) return false;
      if (vehicleType && t.vehicleType !== vehicleType) return false;
      return true;
    });
    return sortTransfers(base, sort);
  }, [transfers, passengers, vehicleType, sort]);

  return (
    <div className="space-y-6">
      <Seo
        title="地面服务"
        description="机场点对点 + 当地包车 + 一日游接驳，配中文司机，航班延误自动顺延。"
        canonicalPath="/transfers"
      />
      <section className="card">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">地面服务</h1>
        <p className="mt-1 text-sm text-ink-soft">
          机场点对点 + 当地包车 + 一日游接驳，配中文司机，航班延误自动顺延。
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <div className="md:col-span-2">
            <label className="label">上车地址</label>
            <input
              className="input"
              placeholder="如：酒店名称 / 机场航站楼"
              value={pickupAddress}
              onChange={(e) => setPickupAddress(e.target.value)}
            />
          </div>
          <div>
            <label className="label">用车日期</label>
            <input type="date" className="input" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} />
          </div>
          <div>
            <label className="label">用车时间</label>
            <input type="time" className="input" value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} />
          </div>
          <div>
            <label className="label">乘车人数</label>
            <input
              type="number"
              min={1}
              max={9}
              className="input"
              value={passengers}
              onChange={(e) => setPassengers(Number(e.target.value) || 1)}
            />
          </div>
          {vehicleTypes.length > 1 && (
            <div>
              <label className="label">车型</label>
              <select className="input" value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                <option value="">全部车型</option>
                {vehicleTypes.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <p className="section-title">推荐车型</p>
          <div className="flex items-center gap-4">
            {status === 'ready' && (
              <p className="text-sm text-ink-muted">{filtered.length} 种可选</p>
            )}
            <SortSelect value={sort} options={SORT_OPTIONS} onChange={setSort} />
          </div>
        </div>

        {status === 'loading' && <ListSkeleton rows={4} />}

        {status === 'error' && <ErrorRetry message="车型加载失败，请稍后再试一次" onRetry={load} />}

        {status === 'ready' && filtered.length > 0 && (
          <div className="space-y-3">
            {filtered.map((t) => {
              const rating = t.rating;
              return (
                <article key={t.id} className="card-interactive group flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-6">
                  <Link
                    to={`/transfers/${t.id}`}
                    aria-label={`查看 ${t.name} 详情`}
                    className="block h-24 w-full flex-shrink-0 overflow-hidden rounded-2xl bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 sm:h-20 sm:w-32"
                  >
                    <Img src={t.photo} alt={t.name} ratio="3/2" className="img-zoom" widths={[160, 320]} />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/transfers/${t.id}`}
                      className="font-bold text-ink transition-colors hover:text-brand-700 focus:outline-none focus-visible:underline"
                    >
                      {t.name}
                    </Link>
                    <p className="mt-0.5 text-sm text-ink-soft">{t.vehicleType}</p>
                    {(rating || typeof t.soldCount === 'number') && (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {rating && rating.count > 0 && (
                          <StarRating value={rating.average} size="sm" showValue count={rating.count} />
                        )}
                        {typeof t.soldCount === 'number' && t.soldCount > 0 && (
                          <span className="nums text-xs text-ink-muted">已售 {t.soldCount}</span>
                        )}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <RefundBadge text="航班延误免费顺延" />
                      {t.features.map((f) => (
                        <span key={f} className="chip">{f}</span>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-ink-muted">
                      {t.originArea} → {t.destArea} · 最多 {t.capacity} 人 · {t.duration}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-4 border-t border-slate-100 pt-3 sm:block sm:border-0 sm:pt-0 sm:text-right">
                    <div>
                      <div className="text-xs text-ink-muted">起步价</div>
                      <div className="price text-2xl">¥{t.basePrice}</div>
                    </div>
                    <div className="flex items-center gap-2 sm:mt-2 sm:justify-end">
                      <Link to={`/transfers/${t.id}`} className="btn-ghost text-sm">详情</Link>
                      <button className="btn-deal text-sm" onClick={() => setSelected(t)}>
                        立即预订
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {status === 'ready' && filtered.length === 0 && (
          <EmptyState
            icon="car"
            title="没有匹配的车型"
            hint="试试减少乘车人数或切换车型筛选。"
          />
        )}
      </section>

      {selected && (
        <BookModal
          transfer={selected}
          pickupAddress={pickupAddress || '（未填写）'}
          pickupDate={pickupDate}
          pickupTime={pickupTime}
          passengers={passengers}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function BookModal(props: {
  transfer: Transfer;
  pickupAddress: string;
  pickupDate: string;
  pickupTime: string;
  passengers: number;
  onClose: () => void;
}) {
  const { transfer, pickupAddress, pickupDate, pickupTime, passengers, onClose } = props;
  const add = useCart((s) => s.add);
  const navigate = useNavigate();

  const addToCart = (goCart: boolean) => {
    add({
      kind: 'TRANSFER',
      productId: transfer.id,
      name: transfer.name,
      description: `${pickupDate} ${pickupTime} · ${pickupAddress} → ${transfer.destArea} · ${passengers} 人`,
      emoji: transfer.emoji,
      unitPrice: transfer.basePrice,
      qty: 1,
      meta: { pickupDate, pickupTime, passengers, destArea: transfer.destArea },
    });
    onClose();
    if (goCart) navigate('/cart');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg overflow-hidden rounded-3xl bg-surface shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200/80 px-6 py-4">
          <h2 className="text-lg font-extrabold tracking-tight text-ink">确认用车信息</h2>
          <button className="text-xl text-ink-muted transition-colors hover:text-ink" onClick={onClose}>×</button>
        </div>
        <div className="px-6 py-5">
          <dl className="space-y-2.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-soft">车型</dt>
              <dd className="inline-flex items-center gap-1.5 font-medium text-ink">
                <Icon name="car" className="h-4 w-4 text-brand" />{transfer.name}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-soft">上车地址</dt>
              <dd className="font-medium text-ink">{pickupAddress}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-soft">目的地</dt>
              <dd className="font-medium text-ink">{transfer.destArea}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-soft">用车时间</dt>
              <dd className="font-medium text-ink">{pickupDate} {pickupTime}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-soft">乘车人数</dt>
              <dd className="font-medium text-ink">{passengers} 人</dd>
            </div>
            <div className="flex items-end justify-between border-t border-slate-200 pt-3">
              <dt className="text-ink-soft">应付</dt>
              <dd className="price text-xl">¥{transfer.basePrice}</dd>
            </div>
          </dl>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-slate-200/80 bg-canvas px-6 py-4">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <div className="flex gap-2">
            <button className="btn-secondary inline-flex items-center gap-1.5" onClick={() => addToCart(false)}>
              <Icon name="cart" className="h-4 w-4" />加入购物车
            </button>
            <button className="btn-deal inline-flex items-center gap-1.5" onClick={() => addToCart(true)}>
              立即购买 <Icon name="arrowRight" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
