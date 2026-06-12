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

/** 关键字命中：任一字段包含（不区分大小写）即命中 */
export function matchKeyword(keyword: string, ...fields: Array<string | null | undefined>): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(kw));
}

function SectionHeader({ title, sub, to, toLabel }: { title: string; sub?: string; to: string; toLabel: string }) {
  return (
    <div className="flex items-end justify-between gap-2">
      <div>
        <h2 className="text-xl font-bold text-slate-900">{title}</h2>
        {sub && <p className="text-xs text-slate-500">{sub}</p>}
      </div>
      <Link to={to} className="text-sm text-brand hover:text-brand-dark whitespace-nowrap">
        {toLabel} →
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
        title="🎁 一价全含套餐"
        sub="机票 + 酒店含早 + 签证 + 接送一次订齐 · 一眼看清、马上能买"
        to="/bundles"
        toLabel="全部套餐"
      />
      {state === 'loading' ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-40 animate-pulse bg-slate-100" aria-hidden />
          ))}
        </div>
      ) : state === 'error' ? (
        <div className="card mt-4 text-sm text-slate-500">套餐加载失败，请刷新页面重试。</div>
      ) : bundles.length === 0 ? (
        <div className="card mt-4 text-sm text-slate-500">套餐上架中，敬请期待。</div>
      ) : visible.length === 0 ? (
        <div className="card mt-4 text-sm text-slate-500">没有匹配"{keyword}"的套餐，去看看全部套餐吧。</div>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visible.slice(0, 6).map((b) => (
            <Link
              key={b.id}
              to={`/bundles?kw=${encodeURIComponent(b.name)}`}
              className="card overflow-hidden p-0 hover:shadow-md transition block"
            >
              {b.photo && (
                <div className="relative h-32 w-full overflow-hidden bg-slate-100">
                  <img
                    src={b.photo}
                    alt={b.name}
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                  <span className="absolute left-2 top-2 text-2xl drop-shadow">{b.emoji}</span>
                  {Number(b.groundDiscount) > 0 && (
                    <span className="absolute right-2 top-2 rounded bg-red-500 px-1.5 py-0.5 text-xs font-semibold text-white">
                      立减 ¥{Number(b.groundDiscount).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              <div className="p-4">
                <h3 className="font-semibold text-slate-900 truncate">{!b.photo ? `${b.emoji ?? '🎁'} ` : ''}{b.name}</h3>
                <p className="mt-0.5 text-xs text-slate-600 line-clamp-2">{b.tagline}</p>
                {b.hotelRoomType && (
                  <p className="mt-1.5 text-xs text-slate-500 truncate">
                    🏨 {b.hotelRoomType.hotelName} · {b.hotelRoomType.name} · 含双早
                  </p>
                )}
                {bundleFromPricePerPerson(b) > 0 && (
                  <p className="mt-1.5 text-sm font-semibold text-red-600">
                    ¥{bundleFromPricePerPerson(b).toLocaleString()}
                    <span className="text-xs font-normal text-slate-500"> 起/人</span>
                  </p>
                )}
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-slate-500">{b.suitableFor}</span>
                  <span className="font-semibold text-brand">看详情 / 订 →</span>
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
      <SectionHeader title="🏨 精选酒店" sub="直签合作 · 含早可选 · 与机票打包更优惠" to="/hotels" toLabel="全部酒店" />
      {visible.length === 0 ? (
        <div className="card mt-4 text-sm text-slate-500">没有匹配"{keyword}"的酒店。</div>
      ) : (
        <div className="mt-4 grid gap-4 grid-cols-2 lg:grid-cols-4">
          {visible.slice(0, 4).map((h) => (
            <Link key={h.id} to="/hotels" className="card overflow-hidden p-0 hover:shadow-md transition block">
              {h.photos[0] && (
                <img
                  src={h.photos[0]}
                  alt={h.name}
                  loading="lazy"
                  className="h-24 w-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <div className="p-3">
                <h3 className="text-sm font-semibold text-slate-900 truncate">{h.name}</h3>
                <p className="mt-0.5 text-xs text-slate-500 truncate">
                  {'★'.repeat(h.starRating)} · {h.area ?? h.cityCode}
                </p>
                {h.basePrice && (
                  <p className="mt-1 text-sm font-semibold text-red-600">
                    ¥{Number(h.basePrice).toLocaleString()}
                    <span className="text-xs font-normal text-slate-500"> /晚起</span>
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
      <SectionHeader title="🚐 接送 / 包车" sub="中文司机点对点 · 航班延误自动顺延" to="/transfers" toLabel="全部用车" />
      {visible.length === 0 ? (
        <div className="card mt-4 text-sm text-slate-500">没有匹配"{keyword}"的用车产品。</div>
      ) : (
        <div className="mt-4 grid gap-4 grid-cols-2 lg:grid-cols-4">
          {visible.slice(0, 4).map((t) => (
            <Link key={t.id} to="/transfers" className="card hover:shadow-md transition block !p-4">
              <div className="text-2xl">{t.emoji ?? '🚐'}</div>
              <h3 className="mt-1 text-sm font-semibold text-slate-900 line-clamp-2">{t.name}</h3>
              <p className="mt-0.5 text-xs text-slate-500 truncate">{t.vehicleType}</p>
              <p className="mt-1 text-sm font-semibold text-red-600">
                ¥{Number(t.basePrice).toLocaleString()}
                <span className="text-xs font-normal text-slate-500"> 起</span>
              </p>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
