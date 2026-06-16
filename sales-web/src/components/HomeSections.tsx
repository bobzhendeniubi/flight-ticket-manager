/**
 * 首页产品速览 sections — 套餐 / 酒店 / 接送用车。
 *
 * 首页排序要求：套餐 first，然后 机票 / 酒店 / 用车。
 * 每个 section 自己拉一次数据（公开端点，失败静默隐藏），
 * 接收 keyword（已防抖）做客户端关键字过滤（名称 / 航线 / 酒店名）。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Bundle, type Hotel, type Transfer } from '../lib/api';
import { Icon, type IconName } from './Icon';

/** 关键字命中：任一字段包含（不区分大小写）即命中 */
export function matchKeyword(keyword: string, ...fields: Array<string | null | undefined>): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(kw));
}

function SectionHeader({ icon, title, sub, to, toLabel }: { icon: IconName; title: string; sub?: string; to: string; toLabel: string }) {
  return (
    <div className="flex items-end justify-between gap-2">
      <div>
        <h2 className="section-title inline-flex items-center gap-2">
          <Icon name={icon} className="h-5 w-5 text-brand" />
          {title}
        </h2>
        {sub && <p className="section-sub">{sub}</p>}
      </div>
      <Link
        to={to}
        className="group inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-semibold text-brand transition-colors hover:text-brand-dark"
      >
        {toLabel}
        <Icon name="arrowRight" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}

// ── 套餐速览（首页第一个产品 section）─────────────────────────────

/**
 * 套餐"¥X 起/人"展示价：地面部分（酒店/签证/接送）合计 − 套餐让利，按 flightPax 摊到每人。
 * FLIGHT 行项 unitPrice=0（机票按日期实时取价），所以实际总价只会更高 —— "起"是真实下限。
 * groundDiscount 是后端 Decimal 序列化的字符串，须 Number() 后再参与计算。
 */
function bundleFromPricePerPerson(b: Bundle): number {
  const groundTotal = b.items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  const pax = Math.max(1, b.flightPax);
  return Math.max(0, Math.round((groundTotal - Number(b.groundDiscount)) / pax));
}

export function BundlesPreviewSection({ keyword }: { keyword: string }) {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  // 套餐是主推位，任何情况下区块都不能整段消失（加载中给骨架、失败给提示）
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    api.listBundles()
      .then((r) => {
        if (cancelled) return;
        setBundles(r.bundles.filter((b) => b.isActive));
        setState('ok');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => { cancelled = true; };
  }, []);

  const visible = bundles.filter((b) =>
    matchKeyword(
      keyword,
      b.name,
      b.tagline,
      b.suitableFor,
      b.hotelRoomType?.hotelName,
      b.hotelRoomType?.name,
      ...b.items.map((i) => i.productName),
    ),
  );

  return (
    <section>
      <SectionHeader
        icon="package"
        title="一价全含套餐"
        sub="机票 + 酒店含早 + 签证 + 接送一次订齐 · 一眼看清、马上能买"
        to="/bundles"
        toLabel="全部套餐"
      />
      {state === 'loading' ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-52" aria-hidden />
          ))}
        </div>
      ) : state === 'error' ? (
        <div className="card mt-4 text-sm text-ink-soft">套餐加载失败，请刷新页面重试。</div>
      ) : bundles.length === 0 ? (
        <div className="card mt-4 text-sm text-ink-soft">套餐上架中，敬请期待。</div>
      ) : visible.length === 0 ? (
        <div className="card mt-4 text-sm text-ink-soft">没有匹配"{keyword}"的套餐，去看看全部套餐吧。</div>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visible.slice(0, 6).map((b) => (
            <Link
              key={b.id}
              to={`/bundles?kw=${encodeURIComponent(b.name)}`}
              className="card-interactive group block overflow-hidden"
            >
              {b.photo && (
                <div className="relative h-40 w-full overflow-hidden bg-slate-100">
                  <img
                    src={b.photo}
                    alt={b.name}
                    loading="lazy"
                    className="img-zoom h-full w-full object-cover"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/35 to-transparent" />
                  {Number(b.groundDiscount) > 0 && (
                    <span className="badge-deal absolute right-2.5 top-2.5">
                      立减 ¥{Number(b.groundDiscount).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              <div className="p-4">
                <h3 className="flex items-center gap-1.5 truncate font-bold text-ink">
                  {!b.photo && <Icon name="package" className="h-4 w-4 shrink-0 text-brand" />}
                  <span className="truncate">{b.name}</span>
                </h3>
                <p className="mt-0.5 line-clamp-2 text-xs text-ink-soft">{b.tagline}</p>
                {b.hotelRoomType && (
                  <p className="mt-1.5 flex items-center gap-1.5 truncate text-xs text-ink-muted">
                    <Icon name="hotel" className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{b.hotelRoomType.hotelName} · {b.hotelRoomType.name} · 含双早</span>
                  </p>
                )}
                {bundleFromPricePerPerson(b) > 0 && (
                  <p className="mt-2 flex items-baseline gap-1">
                    <span className="price text-lg">¥{bundleFromPricePerPerson(b).toLocaleString()}</span>
                    <span className="text-xs font-normal text-ink-muted">起/人</span>
                  </p>
                )}
                <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs">
                  <span className="text-ink-muted">{b.suitableFor}</span>
                  <span className="inline-flex items-center gap-1 font-semibold text-brand transition-colors group-hover:text-brand-dark">
                    看详情 / 订 <Icon name="arrowRight" className="h-3.5 w-3.5" />
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

// ── 酒店速览 ─────────────────────────────────────────────────────

export function HotelsPreviewSection({ keyword }: { keyword: string }) {
  const [hotels, setHotels] = useState<Hotel[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.listHotels().then((r) => { if (!cancelled) setHotels(r.hotels); }).catch(() => {/* 静默 */});
    return () => { cancelled = true; };
  }, []);

  const visible = hotels.filter((h) => matchKeyword(keyword, h.name, h.nameEn, h.area, h.cityCode, h.highlight));

  if (hotels.length === 0) return null;

  return (
    <section>
      <SectionHeader icon="hotel" title="精选酒店" sub="直签合作 · 含早可选 · 与机票打包更优惠" to="/hotels" toLabel="全部酒店" />
      {visible.length === 0 ? (
        <div className="card mt-4 text-sm text-ink-soft">没有匹配"{keyword}"的酒店。</div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {visible.slice(0, 4).map((h) => (
            <Link key={h.id} to="/hotels" className="card-interactive group block overflow-hidden">
              {h.photos[0] && (
                <div className="relative h-28 w-full overflow-hidden bg-slate-100">
                  <img
                    src={h.photos[0]}
                    alt={h.name}
                    loading="lazy"
                    className="img-zoom h-full w-full object-cover"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                  <span className="rating absolute left-2 top-2 inline-flex items-center gap-0.5 shadow-card">
                    <Icon name="star" className="h-3 w-3 text-amber-500" />
                    {h.starRating}.0
                  </span>
                </div>
              )}
              <div className="p-3">
                <h3 className="truncate text-sm font-bold text-ink">{h.name}</h3>
                <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-ink-muted">
                  <Icon name="mapPin" className="h-3 w-3 shrink-0" />
                  <span className="truncate">{h.area ?? h.cityCode}</span>
                </p>
                {h.basePrice && (
                  <p className="mt-1.5 flex items-baseline gap-1">
                    <span className="price text-base">¥{Number(h.basePrice).toLocaleString()}</span>
                    <span className="text-xs font-normal text-ink-muted">/晚起</span>
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

// ── 接送 / 用车速览 ───────────────────────────────────────────────

export function TransfersPreviewSection({ keyword }: { keyword: string }) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.listTransfers().then((r) => { if (!cancelled) setTransfers(r.transfers); }).catch(() => {/* 静默 */});
    return () => { cancelled = true; };
  }, []);

  const visible = transfers.filter((t) =>
    matchKeyword(keyword, t.name, t.vehicleType, t.originArea, t.destArea),
  );

  if (transfers.length === 0) return null;

  return (
    <section>
      <SectionHeader icon="car" title="地面服务" sub="中文司机点对点 · 航班延误自动顺延" to="/transfers" toLabel="全部用车" />
      {visible.length === 0 ? (
        <div className="card mt-4 text-sm text-ink-soft">没有匹配"{keyword}"的用车产品。</div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {visible.slice(0, 4).map((t) => (
            <Link key={t.id} to="/transfers" className="card-interactive group flex flex-col p-4">
              <div className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand">
                <Icon name="car" className="h-6 w-6" />
              </div>
              <h3 className="mt-2 line-clamp-2 text-sm font-bold text-ink">{t.name}</h3>
              <p className="mt-0.5 truncate text-xs text-ink-muted">{t.vehicleType}</p>
              <p className="mt-1.5 flex items-baseline gap-1">
                <span className="price text-base">¥{Number(t.basePrice).toLocaleString()}</span>
                <span className="text-xs font-normal text-ink-muted">起</span>
              </p>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
