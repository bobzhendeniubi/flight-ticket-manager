import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { type MockVisa } from '../lib/mockData';
import { api, type Visa, type ProductRating } from '../lib/api';
import { useCart } from '../stores/cart';
import { Icon } from '../components/Icon';
import { Img } from '../components/Img';
import { SortSelect, type SortOption } from '../components/SortSelect';
import { StarRating } from '../components/StarRating';
import { RefundBadge } from '../components/RefundBadge';
import { CardSkeleton } from '../components/LoadingSkeleton';
import { ErrorRetry } from '../components/ErrorRetry';
import { EmptyState } from '../components/EmptyState';
import { Seo } from '../components/Seo';

/** 列表用签证：MockVisa + 评分/销量（用于 StarRating、热度排序）。 */
type ListVisa = MockVisa & {
  rating?: ProductRating;
  soldCount?: number;
};

function visaApiToMock(v: Visa): ListVisa {
  return {
    id: v.id, country: v.country ?? v.destinationCountry, countryCode: v.destinationCountry,
    flag: v.flag ?? '🌐', photo: v.photo ?? '', type: v.visaName ?? v.visaType,
    processingDays: v.processingDays, basePrice: Number(v.basePrice),
    expressSurcharge: v.expressSurcharge ? Number(v.expressSurcharge) : 0,
    requiredDocs: v.requiredDocs, validityMonths: v.validityMonths ?? 1,
    highlight: v.highlight ?? undefined,
    rating: v.rating,
    soldCount: v.soldCount,
  };
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

function sortVisas(list: ListVisa[], sort: SortKey): ListVisa[] {
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

export function VisasPage() {
  const [visas, setVisas] = useState<ListVisa[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [search, setSearch] = useState('');
  const [maxDays, setMaxDays] = useState<'' | '7' | '15' | '30'>('');
  const [selected, setSelected] = useState<ListVisa | null>(null);

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
      .listVisas()
      .then((r) => {
        if (cancelled) return;
        setVisas(r.visas.map(visaApiToMock));
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

  const filtered = useMemo(() => {
    const base = visas.filter((v) => {
      if (search && !v.country.includes(search)) return false;
      if (maxDays && v.processingDays > Number(maxDays)) return false;
      return true;
    });
    return sortVisas(base, sort);
  }, [visas, search, maxDays, sort]);

  return (
    <div className="space-y-6">
      <Seo
        title="签证代办"
        description="覆盖东南亚 / 东北亚 / 申根等主要目的地，全程线上提交，最快 2 天出签。"
        canonicalPath="/visas"
      />
      <section className="card">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">签证代办</h1>
        <p className="mt-1 text-sm text-ink-soft">
          覆盖东南亚 / 东北亚 / 申根等主要目的地，全程线上提交，最快 2 天出签。
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div>
            <label className="label">搜索目的国</label>
            <input
              className="input"
              placeholder="日本 / 韩国 / 申根…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label className="label">出签时效</label>
            <select
              className="input"
              value={maxDays}
              onChange={(e) => setMaxDays(e.target.value as '' | '7' | '15' | '30')}
            >
              <option value="">不限</option>
              <option value="7">7 天内</option>
              <option value="15">15 天内</option>
              <option value="30">30 天内</option>
            </select>
          </div>
          <div className="flex items-end">
            {status === 'ready' && (
              <p className="text-sm text-slate-500">共 {filtered.length} 个签证产品</p>
            )}
          </div>
        </div>
      </section>

      <div className="flex items-center justify-between">
        <p className="section-title">签证产品</p>
        <SortSelect value={sort} options={SORT_OPTIONS} onChange={setSort} />
      </div>

      {status === 'loading' && (
        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </section>
      )}

      {status === 'error' && <ErrorRetry message="签证产品加载失败，请稍后再试一次" onRetry={load} />}

      {status === 'ready' && filtered.length > 0 && (
        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((v) => {
            const rating = v.rating;
            return (
              <article key={v.id} className="card-interactive group flex flex-col overflow-hidden p-0">
                <Link
                  to={`/visas/${v.id}`}
                  aria-label={`查看 ${v.country} 签证详情`}
                  className="relative block h-40 w-full overflow-hidden bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                >
                  <Img src={v.photo} alt={v.country} ratio="3/2" className="img-zoom" widths={[400, 800]} />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/35 to-transparent" />
                  {/* 国旗承载目的地语义，保留 */}
                  <span className="absolute left-3 top-3 text-3xl drop-shadow-md">{v.flag}</span>
                  <span className="badge-soft absolute right-3 top-3 shadow-card">
                    {v.processingDays} 天出签
                  </span>
                </Link>
                <div className="flex flex-1 flex-col p-4">
                  <Link
                    to={`/visas/${v.id}`}
                    className="font-bold text-ink transition-colors hover:text-brand-700 focus:outline-none focus-visible:underline"
                  >
                    {v.country}
                  </Link>
                  <p className="mt-0.5 text-sm text-ink-soft">{v.type}</p>
                  {(rating || typeof v.soldCount === 'number') && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {rating && rating.count > 0 && (
                        <StarRating value={rating.average} size="sm" showValue count={rating.count} />
                      )}
                      {typeof v.soldCount === 'number' && v.soldCount > 0 && (
                        <span className="nums text-xs text-ink-muted">已办 {v.soldCount}</span>
                      )}
                    </div>
                  )}
                  {v.highlight && (
                    <p className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                      <Icon name="star" className="h-3 w-3 text-amber-500" />
                      {v.highlight}
                    </p>
                  )}
                  <div className="mt-2">
                    <RefundBadge text="材料不齐全额退" />
                  </div>
                  <p className="mt-2 text-xs text-ink-muted">有效期 {v.validityMonths} 个月 · 需材料 {v.requiredDocs.length} 项</p>
                  <div className="mt-4 flex items-end justify-between border-t border-slate-100 pt-3">
                    <div>
                      <div className="text-xs text-ink-muted">办理费</div>
                      <div className="price text-xl">¥{v.basePrice}</div>
                      {v.expressSurcharge > 0 && (
                        <div className="text-xs font-medium text-sun">加急 +¥{v.expressSurcharge}</div>
                      )}
                    </div>
                    <button className="btn-deal py-1.5 text-sm" onClick={() => setSelected(v)}>立即办理</button>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {status === 'ready' && filtered.length === 0 && (
        <EmptyState
          icon="visa"
          title="没有匹配的签证产品"
          hint="换个目的国关键词，或放宽出签时效试试。"
        />
      )}

      {selected && <VisaDetailModal visa={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function VisaDetailModal({ visa, onClose }: { visa: MockVisa; onClose: () => void }) {
  const [express, setExpress] = useState(false);
  const [count, setCount] = useState(1);
  const add = useCart((s) => s.add);
  const navigate = useNavigate();

  const unitPrice = visa.basePrice + (express ? visa.expressSurcharge : 0);
  const total = unitPrice * count;

  const addToCart = (goCart: boolean) => {
    add({
      kind: 'VISA',
      productId: visa.id + (express ? '-express' : ''),
      name: `${visa.country} · ${visa.type}${express ? ' (加急)' : ''} × ${count}`,
      description: `${visa.flag} ${express ? visa.processingDays - 2 : visa.processingDays} 天出签 · 有效期 ${visa.validityMonths} 个月`,
      emoji: visa.flag,
      unitPrice,
      qty: count,
      meta: { express, processingDays: express ? visa.processingDays - 2 : visa.processingDays },
    });
    onClose();
    if (goCart) navigate('/cart');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-3xl bg-surface shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200/80 bg-surface/90 px-6 py-4 backdrop-blur-xl">
          <h2 className="text-lg font-extrabold tracking-tight text-ink">
            {visa.flag} {visa.country} · {visa.type}
          </h2>
          <button className="text-xl text-ink-muted transition-colors hover:text-ink" onClick={onClose}>×</button>
        </div>
        <div className="space-y-4 px-6 py-5">
          <div>
            <h3 className="font-bold text-ink">所需材料</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
              {visa.requiredDocs.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
          <div className="space-y-3 rounded-2xl border border-slate-200/80 bg-canvas p-4">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={express} onChange={(e) => setExpress(e.target.checked)} className="accent-brand" />
                <span>加急办理（{visa.processingDays - 2} 天出签，+¥{visa.expressSurcharge}/人）</span>
              </label>
            </div>
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
          </div>
        </div>
        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-slate-200/80 bg-surface/90 px-6 py-4 backdrop-blur-xl">
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
