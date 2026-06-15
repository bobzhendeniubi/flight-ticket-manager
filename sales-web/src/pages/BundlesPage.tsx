/**
 * 套餐落地页（首页）— 套餐主推、默认首屏。
 *
 * 顶部：精简 hero 轮播 + 福利条 + 一个简单选择器（出发日期 + 人数）。
 * 每张套餐卡：
 *   - 回程日期 = 出发 + 套餐住宿晚数（hotelNights ?? 默认 4 晚），卡上展示"去/回/N晚"。
 *   - 实时库存（选择器驱动，防抖 300ms）：
 *       机票 → 去/回航段余位档位徽章（复用六档余位口径）。
 *       酒店 → 关联房型时查后台房控，展示房量档位徽章；无包房配置则不展示。
 *   - 去/回任一航段或酒店售罄 → 禁用"加入购物车"，给出换日期提示。
 * 价格：机票按日期实时取价 × 人数；酒店每晚价 × 晚数 × 房间数；签证每人价 × 人数。
 *
 * 库存档位口径：买家只看档位（充足/紧张/少量/极少量/售罄、房量充足/紧张/极少/售罄），
 * 绝不暴露原始余票/余房数字（与六档余位一致）。
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { type MockBundle, type BundleItem } from '../lib/mockData';
import { api, type Bundle as ApiBundle, type Hotel, type AvailabilityTier, type FlightSearchResult } from '../lib/api';
import { formatLocalTime } from '../lib/airports';
import { BED_TYPE_NOTE } from '../lib/notices';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { useFlightSearchCache, type FlightSearchCache, type FlightLeg } from '../lib/useFlightSearchCache';
import { useHotelAvailability } from '../lib/useHotelAvailability';
import { BenefitsStrip } from '../components/BenefitsStrip';
import { BookingNotices } from '../components/BookingNotices';
import { HeroCarousel } from '../components/HeroCarousel';
import { Icon, type IconName } from '../components/Icon';
import { matchKeyword } from '../components/HomeSections';
import { useAuth } from '../stores/auth';
import { useCart } from '../stores/cart';

/** 主航线（澳门 ⇌ 岘港）+ 默认住宿晚数（套餐未配置 hotelNights 时） */
const ROUTE_ORIGIN = 'MFM';
const ROUTE_DEST = 'DAD';
const DEFAULT_NIGHTS = 4;

/** 机票单航段兜底价（搜不到班次时用，避免价格显示为 0） */
const FALLBACK_PRICE = {
  ECONOMY: { go: 1480, ret: 1380 },
  BUSINESS: { go: 4380, ret: 4280 },
} as const;

/** MockBundle + 后端新增展示字段（升级价 / 关联房型 / 实时库存所需 id+晚数） */
interface BundleView extends MockBundle {
  singleSupplementPerNight: number | null;
  cabinUpgradePerLeg: number | null;
  hotelRoomType: { id: string; name: string; hotelName: string } | null;
  hotelRoomTypeId: string | null;
  hotelNights: number | null;
}

function bundleApiToView(b: ApiBundle): BundleView {
  const items = (b.items as BundleItem[]) ?? [];
  const groundTotal = items.filter((i) => i.kind !== 'FLIGHT').reduce((s, i) => s + i.unitPrice * i.qty, 0);
  return {
    id: b.id, name: b.name, tagline: b.tagline ?? '', emoji: b.emoji ?? '🎁',
    photo: b.photo ?? '',
    items, listPrice: groundTotal, bundlePrice: groundTotal,
    groundDiscount: Number(b.groundDiscount), flightPax: b.flightPax,
    suitableFor: b.suitableFor ?? '', active: b.isActive,
    singleSupplementPerNight:
      b.singleSupplementCnyPerNight != null ? Number(b.singleSupplementCnyPerNight) : null,
    cabinUpgradePerLeg: b.cabinUpgradeCnyPerLeg != null ? Number(b.cabinUpgradeCnyPerLeg) : null,
    hotelRoomType: b.hotelRoomType ?? null,
    hotelRoomTypeId: b.hotelRoomTypeId ?? null,
    hotelNights: b.hotelNights ?? null,
  };
}

function todayISO(offset = 3) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** 在 YYYY-MM-DD 上加 n 天（按 UTC 零点，避开时区漂移）。*/
function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD → "X月X日"（卡片紧凑展示用）。*/
function formatMonthDay(iso: string): string {
  const ms = Date.parse(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

const KIND_LABEL: Record<BundleItem['kind'], { label: string; color: string }> = {
  FLIGHT: { label: '机票', color: 'bg-sky-100 text-sky-700' },
  HOTEL: { label: '酒店', color: 'bg-purple-100 text-purple-700' },
  TRANSFER: { label: '接送', color: 'bg-pink-100 text-pink-700' },
  VISA: { label: '签证', color: 'bg-amber-100 text-amber-700' },
};

// ── 库存档位徽章配置（买家只看档位，不看精确数字）────────────────────
const FLIGHT_TIER_LABEL: Record<AvailabilityTier, string> = {
  AMPLE: '余位充足', TIGHT: '余位紧张', LOW: '余位少量', VERY_LOW: '余位极少量', SOLD_OUT: '已售罄',
};
const FLIGHT_TIER_CLASS: Record<AvailabilityTier, string> = {
  AMPLE: 'bg-emerald-100 text-emerald-700',
  TIGHT: 'bg-sky-100 text-sky-700',
  LOW: 'bg-amber-100 text-amber-800',
  VERY_LOW: 'bg-orange-100 text-orange-700',
  SOLD_OUT: 'bg-slate-100 text-rose-600',
};

/** 去/回航段展示信息（从 /flights/search 第一条结果取） */
interface LegInfo {
  flightNumber: string;
  departureTime: string;
  arrivalTime: string;
  departureTz: string;
  arrivalTz: string;
}

function toLegInfo(r: FlightSearchResult | null | undefined): LegInfo | null {
  return r
    ? {
        flightNumber: r.flightNumber,
        departureTime: r.departureTime,
        arrivalTime: r.arrivalTime,
        departureTz: r.departureTz,
        arrivalTz: r.arrivalTz,
      }
    : null;
}

/** 取某航段某舱位的余位档位（无班次/未加载 → null） */
function legTier(leg: FlightLeg | undefined, cabin: 'ECONOMY' | 'BUSINESS'): AvailabilityTier | null {
  if (!leg) return null;
  return leg.seatClasses.find((c) => c.cabin === cabin)?.availabilityTier ?? null;
}

/** 取某航段某舱位的实时单价（无则兜底价） */
function legPrice(leg: FlightLeg | undefined, cabin: 'ECONOMY' | 'BUSINESS', fallback: number): number {
  const sc = leg?.seatClasses.find((c) => c.cabin === cabin);
  return sc ? Number(sc.dynamicPrice) : fallback;
}

/** 套餐 → 酒店匹配：优先关联房型的酒店名，退化到 HOTEL 行项名称包含酒店名 */
function matchHotelForBundle(b: BundleView, hotels: Hotel[]): Hotel | undefined {
  if (b.hotelRoomType) {
    const byRoom = hotels.find((h) => h.name === b.hotelRoomType?.hotelName);
    if (byRoom) return byRoom;
  }
  const hotelItem = b.items.find((i) => i.kind === 'HOTEL');
  if (!hotelItem) return undefined;
  return hotels.find((h) => h.name && hotelItem.productName.includes(h.name));
}

export function BundlesPage() {
  const add = useCart((s) => s.add);
  const user = useAuth((s) => s.user);
  const [bundles, setBundles] = useState<BundleView[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.listBundles().then((r) => { if (!cancelled) setBundles(r.bundles.map(bundleApiToView)); }).catch(() => {/* 静默 */});
    api.listHotels().then((r) => { if (!cancelled) setHotels(r.hotels); }).catch(() => {/* 静默 */});
    return () => { cancelled = true; };
  }, []);

  // ── 简单选择器：出发日期（默认 +3 天）+ 人数（默认 2 人）──────────────
  const [goDate, setGoDate] = useState(todayISO(3));
  const [pax, setPax] = useState(2);
  // 顶部选择器为各卡默认出发日期；每张卡内部各自防抖查询库存/价格。

  // 套餐关键字搜索（名称 / 行项 / 酒店名，防抖 300ms）
  // 首页套餐卡深链 /bundles?kw=xxx → 挂载时预填搜索框，落地即过滤
  const [searchParams] = useSearchParams();
  const [keyword, setKeyword] = useState(() => searchParams.get('kw') ?? '');
  const kw = useDebouncedValue(keyword);

  // 航班搜索缓存：多张卡共享同一 (日期,航线) 的搜索，避免重复请求
  const flightCache = useFlightSearchCache();

  // 酒店明细 modal（笔记式：照片 + 房型 + 设施）
  const [hotelModal, setHotelModal] = useState<{ hotel: Hotel; roomTypeName: string | null } | null>(null);

  const visible = bundles.filter(
    (b) =>
      b.active &&
      matchKeyword(
        kw,
        b.name,
        b.tagline,
        b.suitableFor,
        b.hotelRoomType?.hotelName,
        b.hotelRoomType?.name,
        ...b.items.map((i) => i.productName),
      ),
  );

  return (
    <div className="space-y-5">
      {/* 精简 hero（hero 仅保留在落地页） */}
      <HeroCarousel greeting={user ? (user.displayName ?? user.email) : null} />

      <BenefitsStrip />

      {/* 简单选择器：出发日期 + 人数 + 搜索（钉在套餐列表上方） */}
      <section className="card">
        <div className="grid grid-cols-1 gap-3 sm:gap-4 sm:grid-cols-2 md:grid-cols-3">
          <div>
            <label className="label" htmlFor="bundle-godate">出发日期</label>
            <input
              id="bundle-godate"
              type="date"
              className="input"
              value={goDate}
              min={todayISO(0)}
              onChange={(e) => setGoDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label">出行人数</label>
            <Stepper value={pax} min={1} max={9} onChange={setPax} />
          </div>
          <div>
            <label className="label" htmlFor="bundle-keyword">搜索套餐</label>
            <input
              id="bundle-keyword"
              type="search"
              className="input"
              placeholder="如：凯悦 / 蜜月 / 商务"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          回程日期按各套餐住宿晚数自动推算；机位 / 房量随日期实时更新。
        </p>
      </section>

      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <h2 className="section-title inline-flex items-center gap-2">
            <Icon name="gift" className="h-5 w-5 text-brand" />一价全含套餐
          </h2>
          <Link to="/hotels" className="text-sm font-semibold text-brand transition-colors hover:text-brand-dark">浏览更多 →</Link>
        </div>
        {visible.length === 0 && bundles.length > 0 && (
          <div className="card text-sm text-ink-soft">没有匹配"{kw}"的套餐，清空搜索框看全部。</div>
        )}
        {visible.map((b) => (
          <ConfigurableBundleCard
            key={b.id}
            bundle={b}
            flightCache={flightCache}
            goDate={goDate}
            pax={pax}
            hotel={matchHotelForBundle(b, hotels)}
            onShowHotel={(hotel) => setHotelModal({ hotel, roomTypeName: b.hotelRoomType?.name ?? null })}
            onAdd={(cfg) => {
              add({
                kind: 'BUNDLE',
                productId: b.id,
                name: `${b.name}（${cfg.pax}人${cfg.rooms}房 · ${cfg.goDate}→${cfg.returnDate}）`,
                description: b.tagline,
                emoji: b.emoji,
                unitPrice: cfg.total,
                qty: 1,
                meta: {
                  goDate: cfg.goDate,
                  returnDate: cfg.returnDate,
                  pax: cfg.pax,
                  rooms: cfg.rooms,
                  flightTotal: cfg.flightTotal,
                  hotelTotal: cfg.hotelTotal,
                  otherTotal: cfg.otherTotal,
                  discount: b.groundDiscount,
                },
              });
            }}
          />
        ))}
      </section>

      {/* 预订须知 / 扣损规则 / 值机提示 */}
      <BookingNotices />

      {hotelModal && (
        <HotelInfoModal
          hotel={hotelModal.hotel}
          roomTypeName={hotelModal.roomTypeName}
          onClose={() => setHotelModal(null)}
        />
      )}
    </div>
  );
}

// ── 可配置套餐卡 ─────────────────────────────────────────────────

interface BundleAddConfig {
  pax: number;
  rooms: number;
  goDate: string;
  returnDate: string;
  total: number;
  flightTotal: number;
  hotelTotal: number;
  otherTotal: number;
}

function ConfigurableBundleCard({
  bundle: b,
  flightCache,
  goDate,
  pax,
  hotel,
  onShowHotel,
  onAdd,
}: {
  bundle: BundleView;
  flightCache: FlightSearchCache;
  goDate: string;
  pax: number;
  hotel?: Hotel;
  onShowHotel: (hotel: Hotel) => void;
  onAdd: (cfg: BundleAddConfig) => void;
}) {
  const [rooms, setRooms] = useState(1); // 房间数

  // 每张卡可单独改出发日期：默认跟随顶部选择器（goDate 变化时同步），用户可在卡内覆盖。
  const [cardGoDate, setCardGoDate] = useState(goDate);
  useEffect(() => setCardGoDate(goDate), [goDate]);
  // 库存/价格查询用防抖日期（边改边查后台，不每次 onChange 都打 API）
  const queryCardGo = useDebouncedValue(cardGoDate);

  const isBiz = b.items.some((i) => i.kind === 'FLIGHT' && i.productName.includes('商务'));
  const cabin: 'ECONOMY' | 'BUSINESS' = isBiz ? 'BUSINESS' : 'ECONOMY';

  // 住宿晚数 → 回程日期。展示用 cardGoDate（即时反馈），库存查询用防抖日期。
  const nights = b.hotelNights ?? DEFAULT_NIGHTS;
  const displayReturnDate = addDaysISO(cardGoDate, nights);
  const queryReturnDate = addDaysISO(queryCardGo, nights);

  // 触发去/回航段搜索（缓存幂等去重）
  useEffect(() => {
    flightCache.ensure(ROUTE_ORIGIN, ROUTE_DEST, queryCardGo);
    flightCache.ensure(ROUTE_DEST, ROUTE_ORIGIN, queryReturnDate);
  }, [flightCache, queryCardGo, queryReturnDate]);

  const outLeg = flightCache.get(ROUTE_ORIGIN, ROUTE_DEST, queryCardGo);
  const retLeg = flightCache.get(ROUTE_DEST, ROUTE_ORIGIN, queryReturnDate);
  const legs = { go: toLegInfo(outLeg), ret: toLegInfo(retLeg) };

  const goTier = legTier(outLeg, cabin);
  const retTier = legTier(retLeg, cabin);

  // 酒店实时房量（关联房型才查；无包房配置 → null 不展示）
  const hotelTier = useHotelAvailability(b.hotelRoomTypeId, queryCardGo, queryReturnDate);

  // 实时机票单人来回价（搜不到用兜底价）
  const fb = FALLBACK_PRICE[cabin];
  const pricePerPerson = legPrice(outLeg, cabin, fb.go) + legPrice(retLeg, cabin, fb.ret);

  // 计算每个行项的金额
  const itemRows = b.items.map((item) => {
    if (item.kind === 'FLIGHT') {
      return { ...item, computedTotal: pricePerPerson * pax, label: `来回${isBiz ? '商务' : '经济'}舱 × ${pax} 人` };
    }
    if (item.kind === 'HOTEL') {
      return { ...item, computedTotal: item.unitPrice * item.qty * rooms, label: `${item.productName}${rooms > 1 ? ` × ${rooms} 房` : ''}` };
    }
    if (item.kind === 'VISA') {
      return { ...item, computedTotal: item.unitPrice * pax, label: `${item.productName.replace(/× \d+/, `× ${pax}`)}` };
    }
    // TRANSFER — 固定价（按趟不按人头）
    return { ...item, computedTotal: item.unitPrice * item.qty, label: item.productName };
  });

  const flightTotal = itemRows.filter((r) => r.kind === 'FLIGHT').reduce((s, r) => s + r.computedTotal, 0);
  const hotelTotal = itemRows.filter((r) => r.kind === 'HOTEL').reduce((s, r) => s + r.computedTotal, 0);
  const otherTotal = itemRows.filter((r) => r.kind !== 'FLIGHT' && r.kind !== 'HOTEL').reduce((s, r) => s + r.computedTotal, 0);
  const listTotal = flightTotal + hotelTotal + otherTotal;
  const total = listTotal - b.groundDiscount;
  const perPerson = pax > 0 ? Math.round(total / pax) : total;

  // 售罄拦截：去/回任一航段或酒店售罄 → 禁止加购
  const soldOut = goTier === 'SOLD_OUT' || retTier === 'SOLD_OUT' || hotelTier === 'SOLD_OUT';

  // 含什么 — 接送/签证按行项判断，中文客服全套餐标配
  type Inclusion = { icon: IconName; label: string };
  const inclusions = (
    [
      b.items.some((i) => i.kind === 'HOTEL') ? { icon: 'hotel', label: '酒店含双早' } : null,
      b.items.some((i) => i.kind === 'TRANSFER') ? { icon: 'car', label: '当地接送' } : null,
      b.items.some((i) => i.kind === 'VISA') ? { icon: 'visa', label: '签证代办' } : null,
      { icon: 'support', label: '中文客服' },
    ] as (Inclusion | null)[]
  ).filter((x): x is Inclusion => x !== null);

  const hasUpgrades = b.singleSupplementPerNight != null || b.cabinUpgradePerLeg != null;

  return (
    <article className="card-interactive group overflow-hidden">
      {b.photo ? (
        <div className="relative h-48 w-full overflow-hidden bg-slate-100">
          <img
            src={b.photo}
            alt={b.name}
            className="img-zoom h-full w-full object-cover"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/40 to-transparent" />
          <span className="absolute left-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/85 text-brand shadow-sm backdrop-blur-sm">
            <Icon name="package" className="h-4 w-4" />
          </span>
          {b.groundDiscount > 0 && (
            <span className="badge-deal absolute right-3 top-3">立减 ¥{b.groundDiscount.toLocaleString()}</span>
          )}
        </div>
      ) : null}
      <div className="p-4 md:p-5">
      <div className="flex flex-wrap items-start gap-4">
        {!b.photo && (
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand">
            <Icon name="package" className="h-5 w-5" />
          </span>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-extrabold tracking-tight text-ink">{b.name}</h3>
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">{b.tagline}</p>
          {/* 含什么 一眼看清 */}
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            {inclusions.map((inc) => (
              <span key={inc.label} className="badge-soft inline-flex items-center gap-1">
                <Icon name={inc.icon} className="h-3.5 w-3.5 text-brand" />
                {inc.label}
              </span>
            ))}
          </div>
        </div>

        {/* 房间数调整器（人数由顶部选择器统一控制） */}
        <div className="flex flex-col gap-2 items-end">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-soft">房间数</span>
            <Stepper value={rooms} min={1} max={5} onChange={setRooms} />
          </div>
        </div>
      </div>

      {/* 出行日期可改：每张卡独立选出发日期，机位/房量/价格随之实时更新 */}
      <div className="mt-3 inline-flex flex-wrap items-center gap-2 rounded-lg bg-canvas px-2.5 py-1.5 text-xs font-semibold text-ink">
        <Icon name="calendar" className="h-4 w-4 text-brand" />
        <label className="flex items-center gap-1.5">
          <span className="text-ink-soft">出发</span>
          <input
            type="date"
            className="input h-7 w-24 sm:w-auto px-2 py-0.5 text-xs"
            min={todayISO(0)}
            value={cardGoDate}
            onChange={(e) => setCardGoDate(e.target.value)}
            aria-label="出发日期"
          />
        </label>
        <span className="text-ink-soft">回 {formatMonthDay(displayReturnDate)} · {nights} 晚</span>
      </div>

      {/* 去/回航班号 + 时刻 + 实时余位档位 */}
      {(legs.go || legs.ret || goTier || retTier) && (
        <div className="mt-2 grid grid-cols-1 gap-1.5 rounded-md bg-sky-50/70 p-2 sm:p-2.5 text-[11px] sm:text-xs text-slate-700 sm:grid-cols-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-sky-100 px-1.5 py-0.5 font-semibold text-sky-700">去程</span>
            {legs.go && (
              <>
                <span className="font-medium">{legs.go.flightNumber}</span>
                <span>
                  {formatMonthDay(cardGoDate)} {formatLocalTime(legs.go.departureTime, legs.go.departureTz)} →{' '}
                  {formatLocalTime(legs.go.arrivalTime, legs.go.arrivalTz)}
                </span>
              </>
            )}
            {goTier && (
              <span className={`rounded px-1.5 py-0.5 font-medium ${FLIGHT_TIER_CLASS[goTier]}`}>
                {FLIGHT_TIER_LABEL[goTier]}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-sky-100 px-1.5 py-0.5 font-semibold text-sky-700">回程</span>
            {legs.ret && (
              <>
                <span className="font-medium">{legs.ret.flightNumber}</span>
                <span>
                  {formatMonthDay(displayReturnDate)} {formatLocalTime(legs.ret.departureTime, legs.ret.departureTz)} →{' '}
                  {formatLocalTime(legs.ret.arrivalTime, legs.ret.arrivalTz)}
                </span>
              </>
            )}
            {retTier && (
              <span className={`rounded px-1.5 py-0.5 font-medium ${FLIGHT_TIER_CLASS[retTier]}`}>
                {FLIGHT_TIER_LABEL[retTier]}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 酒店 + 房型（含双早 · 2人1间 · 床型尽量安排）+ 实时房量档位 */}
      {(b.hotelRoomType || hotel) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-purple-50/70 p-2 sm:p-2.5 text-[11px] sm:text-xs text-slate-700">
          <span className="inline-flex items-center gap-1.5">
            <Icon name="hotel" className="h-4 w-4 text-purple-600" />
            <span className="font-medium">{b.hotelRoomType?.hotelName ?? hotel?.name}</span>
            {b.hotelRoomType?.name ? ` · ${b.hotelRoomType.name}` : ''} · 含双早 · 2 人 1 间
          </span>
          <HotelTierBadge tier={hotelTier} />
          <span className="text-slate-500">（{BED_TYPE_NOTE}）</span>
          {hotel && (
            <button
              type="button"
              className="text-brand hover:text-brand-dark font-medium"
              onClick={() => onShowHotel(hotel)}
            >
              查看酒店明细 →
            </button>
          )}
        </div>
      )}

      {/* 明细 */}
      <div className="mt-4 space-y-1.5">
        {itemRows.map((r, idx) => (
          <div key={idx} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`rounded px-1.5 py-0.5 font-medium ${KIND_LABEL[r.kind].color}`}>
                {KIND_LABEL[r.kind].label}
              </span>
              <span className="text-slate-700 truncate">{r.label}</span>
            </div>
            <span className="text-slate-600 tabular-nums whitespace-nowrap">
              ¥{r.computedTotal.toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {/* 可自愿付费升级（仅展示，收费走线下人工） */}
      {hasUpgrades && (
        <div className="mt-3 rounded-md border border-dashed border-indigo-300 bg-indigo-50/60 p-2.5 text-xs text-indigo-800">
          <span className="font-semibold">可选升级（自愿付费，下单后联系客服办理）：</span>{' '}
          {[
            b.singleSupplementPerNight != null
              ? `单住补房差 ¥${b.singleSupplementPerNight.toLocaleString()}/晚`
              : null,
            b.cabinUpgradePerLeg != null
              ? `升舱商务 ¥${b.cabinUpgradePerLeg.toLocaleString()}/程`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}

      {/* 价格汇总 */}
      <div className="mt-4 rounded-2xl border border-slate-200/70 bg-canvas p-3.5">
        <div className="flex flex-col gap-1 text-[11px] text-ink-muted sm:flex-row sm:items-center sm:justify-between sm:text-xs">
          <span>
            机票 ¥{flightTotal.toLocaleString()} + 酒店 ¥{hotelTotal.toLocaleString()} + 其他 ¥{otherTotal.toLocaleString()}
            {b.groundDiscount > 0 && ` − 已省 ¥${b.groundDiscount.toLocaleString()}`}
          </span>
        </div>
        <div className="mt-1.5 flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between">
          <div className="text-xs text-ink-muted">
            {pax} 人 · {rooms} 房 · {formatMonthDay(cardGoDate)} → {formatMonthDay(displayReturnDate)}
          </div>
          <div className="flex items-baseline justify-end gap-2 text-right">
            {b.groundDiscount > 0 && (
              <span className="price-old">¥{listTotal.toLocaleString()}</span>
            )}
            <div>
              <span className="price text-2xl">¥{total.toLocaleString()}</span>
              <div className="text-xs text-ink-muted">≈ ¥{perPerson.toLocaleString()} /人</div>
            </div>
          </div>
        </div>
      </div>

      {/* 售罄提示 */}
      {soldOut && (
        <p className="mt-2 text-right text-xs font-semibold text-deal">该日期已售罄，换个日期试试</p>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Link to="/cart" className="btn-secondary text-sm">查看购物车</Link>
        <button
          className="btn-deal text-sm"
          disabled={soldOut}
          title={soldOut ? '该日期已售罄，换个日期试试' : undefined}
          onClick={() =>
            onAdd({ pax, rooms, goDate: cardGoDate, returnDate: displayReturnDate, total, flightTotal, hotelTotal, otherTotal })
          }
        >
          {soldOut ? '该日期已售罄' : '加入购物车'}
        </button>
      </div>
      </div>
    </article>
  );
}

/** 酒店房量档位徽章（与机票余位同纪律，只回档位不回数字；null/loading 不展示） */
function HotelTierBadge({ tier }: { tier: ReturnType<typeof useHotelAvailability> }) {
  if (tier === null || tier === 'loading') return null;
  const map: Record<'SOLD_OUT' | 'LOW' | 'TIGHT' | 'AMPLE', { label: string; cls: string }> = {
    SOLD_OUT: { label: '房量售罄', cls: 'bg-rose-100 text-rose-700' },
    LOW: { label: '房量极少', cls: 'bg-orange-100 text-orange-700' },
    TIGHT: { label: '房量紧张', cls: 'bg-amber-100 text-amber-800' },
    AMPLE: { label: '房量充足', cls: 'bg-emerald-100 text-emerald-700' },
  };
  const { label, cls } = map[tier];
  return <span className={`rounded px-1.5 py-0.5 font-medium ${cls}`}>{label}</span>;
}

// ── 酒店明细 modal（笔记式：照片 + 房型 + 设施，只看不订）──────────

function HotelInfoModal({
  hotel,
  roomTypeName,
  onClose,
}: {
  hotel: Hotel;
  roomTypeName: string | null;
  onClose: () => void;
}) {
  const matchedRoom = roomTypeName
    ? hotel.roomTypes.find((rt) => rt.name === roomTypeName)
    : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-3xl bg-surface shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200/80 bg-surface/90 px-6 py-4 backdrop-blur-xl">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold tracking-tight text-ink">
            <Icon name="hotel" className="h-5 w-5 text-purple-600" />
            {hotel.name}
          </h2>
          <button onClick={onClose} className="text-xl text-ink-muted transition-colors hover:text-ink" aria-label="关闭">×</button>
        </div>

        <div className="space-y-4 px-6 py-5">
          {hotel.photos[0] && (
            <div className="overflow-hidden rounded-2xl bg-slate-100">
              <img
                src={hotel.photos[0]}
                alt={hotel.name}
                className="h-48 w-full object-cover"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            </div>
          )}
          {hotel.photos.length > 1 && (
            <div className="grid grid-cols-3 gap-2">
              {hotel.photos.slice(1, 4).map((p) => (
                <img
                  key={p}
                  src={p}
                  alt=""
                  loading="lazy"
                  className="h-20 w-full rounded-xl object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="badge-sun inline-flex items-center gap-0.5">
              {Array.from({ length: hotel.starRating }).map((_, i) => (
                <Icon key={i} name="star" className="h-3.5 w-3.5 text-amber-500" />
              ))}
            </span>
            {hotel.rating && (
              <span className="rating">{hotel.rating} / 5</span>
            )}
            <span className="inline-flex items-center gap-1 text-ink-muted">
              <Icon name="mapPin" className="h-3.5 w-3.5" />
              {hotel.area ?? hotel.address}
            </span>
          </div>

          {hotel.highlight && <p className="text-sm italic text-ink-soft">{hotel.highlight}</p>}

          {/* 套餐安排的房型 */}
          <div className="rounded-2xl border border-brand/20 bg-brand-50/50 p-3.5 text-sm">
            <div className="font-bold text-ink">
              本套餐房型：{roomTypeName ?? matchedRoom?.name ?? '以确认单为准'}
            </div>
            <div className="mt-1 text-xs text-ink-soft">
              {matchedRoom?.bedType ? `${matchedRoom.bedType} · ` : ''}
              {matchedRoom ? `可住 ${matchedRoom.capacity} 人 · ` : ''}
              含双早 · 2 人 1 间
            </div>
            <div className="mt-1 text-xs text-ink-muted">{BED_TYPE_NOTE}</div>
          </div>

          {/* 设施 */}
          {hotel.amenities.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-ink">酒店设施</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {hotel.amenities.map((a) => (
                  <span key={a} className="chip">{a}</span>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button className="btn-secondary" onClick={onClose}>知道了</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 小组件 ───────────────────────────────────────────────────────

function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center overflow-hidden rounded-xl border border-slate-200">
      <button
        type="button"
        className="px-2.5 py-2 sm:py-1.5 text-ink-soft transition-colors hover:bg-brand-50 disabled:text-slate-300"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <span className="nums min-w-[2.5rem] bg-white px-3 py-2 sm:py-1.5 text-center font-semibold text-ink">
        {value}
      </span>
      <button
        type="button"
        className="px-2.5 py-2 sm:py-1.5 text-ink-soft transition-colors hover:bg-brand-50 disabled:text-slate-300"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}

// RankBadge 已移除：dateRank A/B/C/D 是公司内部日期等级，不对客户展示
// 余房档位：关联房型 → 查后台房控；未关联或未配置包房 → 不展示（不造假数字）
