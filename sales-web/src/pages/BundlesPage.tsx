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
 * 价格：含机票的全包价；机票按所选出发日实时计价（fareBuckets 阶梯），故同套餐不同日期总价不同。
 *   卡内逐行重算 = (机票 × 人数 + 酒店每晚价 × 晚数 × 房间数 + 签证每人价 × 人数 + 加项) × (1 − discountPct/100)，
 *   整单 percent off；与后端权威重算一致；列表"地板价"排序用含机票（基准价）的折后合计（见 bundleFloorPrice）。
 *
 * 库存档位口径：买家只看档位（充足/紧张/少量/极少量/售罄、房量充足/紧张/极少/售罄），
 * 绝不暴露原始余票/余房数字（与六档余位一致）。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Bundle as ApiBundle, type Hotel, type AvailabilityTier, type FlightSearchResult, type ProductRating } from '../lib/api';
import { formatLocalTime } from '../lib/airports';
import { BED_TYPE_NOTE } from '../lib/notices';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { useFlightSearchCache, type FlightSearchCache, type FlightLeg } from '../lib/useFlightSearchCache';
import { useHotelAvailability } from '../lib/useHotelAvailability';
import { useBundleSellableDates } from '../lib/useBundleSellableDates';
import {
  computeRoomsNeeded,
  resolveRoomCapacity,
  resolveBundleNights,
  resolveBundleRoomFactor,
  isSoloOccupancy,
} from '../lib/bundleRooms';
import {
  SellableReasonChip,
  isSellableBlocked,
  sellableBlockTitle,
} from '../components/SellableReasonChip';
import { BenefitsStrip } from '../components/BenefitsStrip';
import { BookingNotices } from '../components/BookingNotices';
import { HeroCarousel } from '../components/HeroCarousel';
import { Icon, type IconName } from '../components/Icon';
import { Img } from '../components/Img';
import { SortSelect, type SortOption } from '../components/SortSelect';
import { StarRating } from '../components/StarRating';
import { ScarcityBadge } from '../components/ScarcityBadge';
import { RefundBadge } from '../components/RefundBadge';
import { ListSkeleton } from '../components/LoadingSkeleton';
import { ErrorRetry } from '../components/ErrorRetry';
import { EmptyState } from '../components/EmptyState';
import { matchKeyword } from '../components/HomeSections';
import { useAuth } from '../stores/auth';
import { useCart } from '../stores/cart';

/** 主航线（澳门 ⇌ 岘港）。住宿晚数走 resolveBundleNights（hotelNights → HOTEL qty → 兜底）。 */
const ROUTE_ORIGIN = 'MFM';
const ROUTE_DEST = 'DAD';

/** 机票单航段兜底价（搜不到班次时用，避免价格显示为 0） */
const FALLBACK_PRICE = {
  ECONOMY: { go: 1480, ret: 1380 },
  BUSINESS: { go: 4380, ret: 4280 },
} as const;

export type BundleItemKind = 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA';

/** 套餐内的单个产品项。 */
export interface BundleItem {
  kind: BundleItemKind;
  /** 显示用名称；真接 API 后改为 productId 引用 */
  productName: string;
  /** 数量或晚数 */
  qty: number;
  /** 单价，¥ */
  unitPrice: number;
}

/** 套餐的展示结构。 */
export interface Bundle {
  id: string;
  name: string;
  tagline: string;
  emoji: string;
  photo: string;
  /** 含哪些产品 */
  items: BundleItem[];
  /** 单卖总价（计算自 items；机票为可选基准价，运营未填=0 则仅含地面项） */
  listPrice: number;
  /** 套餐价（机票基准价计入，未填=0 则仅地面，卡内按出发日实时重算含机票真实价） */
  bundlePrice: number;
  /** 整单折扣百分比（整数 0–100）：套餐总价 = 全包价 × (1 − discountPct/100） */
  discountPct: number;
  /** @deprecated 已弃用的固定让利金额；前台改用 discountPct（整单 percent off） */
  groundDiscount: number;
  /** 机票对应人数（用于调 /flights/price） */
  flightPax: number;
  /** 适合人数 */
  suitableFor: string;
  /** 当前状态 */
  active: boolean;
}

/** Bundle + 后端新增展示字段（升级价 / 关联房型 / 实时库存所需 id+晚数 / 评分销量） */
interface BundleView extends Bundle {
  singleSupplementPerNight: number | null;
  businessUpgradePerLeg: number | null;
  /** 占座儿童每人比成人便宜多少（机票折扣，CNY）；null = 不优惠 */
  childSeatDiscount: number | null;
  /** 不占座婴儿每人机票价（CNY）；null = 不收婴儿价 */
  infantPrice: number | null;
  /** 每人操作服务费（CNY，DB 默认 ¥20，按占座人数收）；缺省按 ¥20 兜底——后端一定会收 */
  operationFee: number;
  legs: number;
  // capacity/maxAdults/maxChildren 用于镜像后端 roomsNeeded（房间数按房型能住几大几小算）。
  hotelRoomType: {
    id: string;
    name: string;
    hotelName: string;
    capacity?: number | null;
    maxAdults?: number | null;
    maxChildren?: number | null;
  } | null;
  hotelRoomTypeId: string | null;
  hotelNights: number | null;
  /** 运营绑定的去/回航班号（选出发日后据此把航段解析到对应班次；null = 未绑定，回退首条）。 */
  outboundFlightNumber: string | null;
  returnFlightNumber: string | null;
  /** 套餐默认出发日（管理员设；null = 未设，前端回退 today+3） */
  defaultDepartDate: string | null;
  rating: ProductRating | null;
  reviewCount: number | null;
  soldCount: number | null;
}

function bundleApiToView(b: ApiBundle): BundleView {
  const items = (b.items as BundleItem[]) ?? [];
  // 列表排序/「地板价」估算：全部要素合计（FLIGHT 行 unitPrice 为可选机票基准价，运营未填=0 则只含地面）。
  // 卡内总价另按所选出发日实时机票价逐行重算（见 ConfigurableBundleCard），故排序稳定、不随日期抖动。
  const allInTotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  return {
    id: b.id, name: b.name, tagline: b.tagline ?? '', emoji: b.emoji ?? '🎁',
    photo: b.photo ?? '',
    items, listPrice: allInTotal, bundlePrice: allInTotal,
    discountPct: b.discountPct ?? 0,
    groundDiscount: Number(b.groundDiscount), flightPax: b.flightPax,
    suitableFor: b.suitableFor ?? '', active: b.isActive,
    singleSupplementPerNight:
      b.singleSupplementCnyPerNight != null ? Number(b.singleSupplementCnyPerNight) : null,
    businessUpgradePerLeg:
      b.businessUpgradeCnyPerLeg != null ? Number(b.businessUpgradeCnyPerLeg) : null,
    childSeatDiscount:
      b.childSeatDiscountCnyPerPerson != null ? Number(b.childSeatDiscountCnyPerPerson) : null,
    infantPrice: b.infantPriceCny != null ? Number(b.infantPriceCny) : null,
    // 操作服务费：老缓存缺字段时按 DB 默认 ¥20 兜底（后端一定按占座人数收，展示价须计入以对齐实收）。
    operationFee: b.operationFeeCny != null ? Number(b.operationFeeCny) : 20,
    legs: b.legs != null ? Number(b.legs) : 2,
    hotelRoomType: b.hotelRoomType ?? null,
    hotelRoomTypeId: b.hotelRoomTypeId ?? null,
    hotelNights: b.hotelNights ?? null,
    outboundFlightNumber: b.outboundFlight?.flightNumber ?? null,
    returnFlightNumber: b.returnFlight?.flightNumber ?? null,
    defaultDepartDate: b.defaultDepartDate ?? null,
    rating: b.rating ?? null,
    reviewCount: b.reviewCount ?? null,
    soldCount: b.soldCount ?? null,
  };
}

// ── 排序（对标 Klook/携程 列表排序，选中值持久化到 ?sort=）──────────────
type SortKey = 'recommended' | 'price_asc' | 'price_desc' | 'rating' | 'popular';

const SORT_OPTIONS: SortOption[] = [
  { value: 'recommended', label: '推荐' },
  { value: 'price_asc', label: '价格低→高' },
  { value: 'price_desc', label: '价格高→低' },
  { value: 'rating', label: '好评优先' },
  { value: 'popular', label: '热度' },
];

const SORT_KEYS = new Set<SortKey>(['recommended', 'price_asc', 'price_desc', 'rating', 'popular']);

function parseSort(raw: string | null): SortKey {
  return raw && SORT_KEYS.has(raw as SortKey) ? (raw as SortKey) : 'recommended';
}

/**
 * 套餐排序用「地板价」估算：全部要素合计 × (1 − discountPct/100)（整单折后价）。
 * 机票按可选基准价计入（运营未填=0 则仅地面）；用固定值排序，稳定不随日期抖动。
 * 卡内展示总价另按所选出发日实时机票价逐行重算（含机票真实价），两者口径分工不同。
 * （= bundlePrice × 折后系数。）
 */
function bundleFloorPrice(b: BundleView): number {
  return Math.max(0, Math.round(b.bundlePrice * (1 - (b.discountPct ?? 0) / 100)));
}

/** 销量阈值：达到才显示"近期热订"紧迫感徽章（避免给冷门套餐贴假热度）。 */
const SOLD_RECENTLY_THRESHOLD = 30;

/** 按排序键给可见套餐排序（recommended = 保留后端默认顺序，稳定排序）。 */
function sortBundles(list: BundleView[], sort: SortKey): BundleView[] {
  if (sort === 'recommended') return list;
  const withIndex = list.map((b, i) => ({ b, i }));
  withIndex.sort((x, y) => {
    switch (sort) {
      case 'price_asc':
        return bundleFloorPrice(x.b) - bundleFloorPrice(y.b) || x.i - y.i;
      case 'price_desc':
        return bundleFloorPrice(y.b) - bundleFloorPrice(x.b) || x.i - y.i;
      case 'rating':
        return (y.b.rating?.average ?? 0) - (x.b.rating?.average ?? 0) || x.i - y.i;
      case 'popular':
        return (y.b.soldCount ?? 0) - (x.b.soldCount ?? 0) || x.i - y.i;
      default:
        return x.i - y.i;
    }
  });
  return withIndex.map((w) => w.b);
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

/** 占座模型人数文案："X 成人 · Y 儿童 · Z 婴儿"（0 的不显示；全 0 兜底显示成人）。 */
function formatOccupancy(adultCount: number, childCount: number, infantCount: number): string {
  const parts = [
    `${adultCount} 成人`,
    childCount > 0 ? `${childCount} 儿童` : null,
    infantCount > 0 ? `${infantCount} 婴儿` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

const KIND_LABEL: Record<BundleItem['kind'], { label: string; color: string }> = {
  FLIGHT: { label: '机票', color: 'bg-sky-100 text-sky-700' },
  HOTEL: { label: '酒店', color: 'bg-purple-100 text-purple-700' },
  TRANSFER: { label: '地面服务', color: 'bg-pink-100 text-pink-700' },
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
  const navigate = useNavigate();
  const [bundles, setBundles] = useState<BundleView[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  // 套餐列表为主内容，决定页面加载/错误态；酒店明细为增强信息，失败仅降级（不阻塞页面）。
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    Promise.all([api.listBundles(), api.listHotels().catch(() => ({ hotels: [] as Hotel[] }))])
      .then(([bundleRes, hotelRes]) => {
        if (cancelled) return;
        setBundles(bundleRes.bundles.map(bundleApiToView));
        setHotels(hotelRes.hotels);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, [reloadKey]);

  // ── 简单选择器：出发日期（默认 +3 天）+ 占座模型三计数 ──────────────
  // 成人（占座，≥1）/ 占座儿童（占座，比成人便宜）/ 不占座婴儿（不占座、不占房、仍需护照）
  const [goDate, setGoDate] = useState(todayISO(3));
  const [adultCount, setAdultCount] = useState(2);
  const [childCount, setChildCount] = useState(0);
  const [infantCount, setInfantCount] = useState(0);
  // 顶部选择器为各卡默认出发日期；每张卡内部各自防抖查询库存/价格。

  // 套餐关键字搜索（名称 / 行项 / 酒店名，防抖 300ms）
  // 首页套餐卡深链 /bundles?kw=xxx → 挂载时预填搜索框，落地即过滤
  const [searchParams, setSearchParams] = useSearchParams();
  const [keyword, setKeyword] = useState(() => searchParams.get('kw') ?? '');
  const kw = useDebouncedValue(keyword);

  // 排序：从 ?sort= 读取，可分享；变更写回 URL（保留已有 query 如 kw）
  const sort = parseSort(searchParams.get('sort'));
  const onSortChange = (next: string) => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === 'recommended') p.delete('sort');
        else p.set('sort', next);
        return p;
      },
      { replace: true },
    );
  };

  // 航班搜索缓存：多张卡共享同一 (日期,航线) 的搜索，避免重复请求
  const flightCache = useFlightSearchCache();

  // 酒店明细 modal（笔记式：照片 + 房型 + 设施）
  const [hotelModal, setHotelModal] = useState<{ hotel: Hotel; roomTypeName: string | null } | null>(null);

  const filtered = bundles.filter(
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
  const visible = sortBundles(filtered, sort);

  return (
    <div className="space-y-5">
      {/* 精简 hero（hero 仅保留在落地页） */}
      <HeroCarousel greeting={user ? (user.displayName ?? user.email) : null} />

      <BenefitsStrip />

      {/* 简单选择器：出发日期 + 出行人（成人/儿童/婴儿）+ 搜索（钉在套餐列表上方） */}
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
          <div className="md:col-span-1">
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
          <div className="sm:col-span-2 md:col-span-1">
            <span className="label">出行人</span>
            <OccupancyPicker
              adultCount={adultCount}
              childCount={childCount}
              infantCount={infantCount}
              onAdult={setAdultCount}
              onChild={setChildCount}
              onInfant={setInfantCount}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          默认已为你选好最近可出发日（今天 +3 天起），可改；房间数按各套餐房型能住几大几小自动算，人多一间坐不下会自动加房、价格已含（婴儿不占座、不占床，仍需护照）；回程日期按各套餐住宿晚数自动推算，机位 / 房量随日期实时更新，每张套餐只让选可售日期。
        </p>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            {/* 英文 eyebrow（Fraunces 展示字）—— 编辑气质，中文标题靠字重出彩 */}
            <span className="text-display block text-[11px] font-semibold uppercase tracking-[0.2em] text-palm">
              All-Inclusive Packages
            </span>
            <h2 className="section-title mt-0.5 inline-flex items-center gap-2">
              <Icon name="gift" className="h-5 w-5 text-brand" />一价全含套餐
            </h2>
          </div>
          <div className="flex items-center gap-3">
            {status === 'ready' && (
              <SortSelect value={sort} options={SORT_OPTIONS} onChange={onSortChange} />
            )}
            <Link to="/hotels" className="shrink-0 text-sm font-semibold text-brand transition-colors hover:text-brand-dark">浏览更多 →</Link>
          </div>
        </div>

        {status === 'loading' && <ListSkeleton rows={3} />}

        {status === 'error' && (
          <ErrorRetry
            message="套餐列表没能加载出来，检查下网络再试一次"
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        )}

        {status === 'ready' && visible.length === 0 && (
          <EmptyState
            icon="package"
            title={kw ? `没有匹配"${kw}"的套餐` : '暂时没有可预订的套餐'}
            hint={kw ? '换个关键词，或清空搜索看全部套餐' : '新行程正在筹备，过两天再来看看'}
            action={
              kw ? (
                <button type="button" className="btn-secondary text-sm" onClick={() => setKeyword('')}>
                  清空搜索
                </button>
              ) : undefined
            }
          />
        )}

        {status === 'ready' &&
          visible.map((b) => (
          <ConfigurableBundleCard
            key={b.id}
            bundle={b}
            flightCache={flightCache}
            goDate={goDate}
            adultCount={adultCount}
            childCount={childCount}
            infantCount={infantCount}
            hotel={matchHotelForBundle(b, hotels)}
            onView={(cfg) =>
            navigate(`/bundles/${b.id}`, {
              state: {
                goDate: cfg.goDate,
                adultCount: cfg.adultCount,
                childCount: cfg.childCount,
                infantCount: cfg.infantCount,
                singleCount: cfg.singleCount,
                businessCount: cfg.businessCount,
                nights: cfg.nights,
              },
            })
          }
            onShowHotel={(hotel) => setHotelModal({ hotel, roomTypeName: b.hotelRoomType?.name ?? null })}
            onAdd={(cfg) => {
              const addOnSummary = [
                cfg.childCount > 0 ? `儿童×${cfg.childCount}` : null,
                cfg.infantCount > 0 ? `婴儿×${cfg.infantCount}` : null,
                cfg.singleCount > 0 ? `单人入住×${cfg.singleCount}` : null,
                cfg.businessCount > 0 ? `商务舱×${cfg.businessCount}` : null,
              ]
                .filter(Boolean)
                .join(' · ');
              add({
                kind: 'BUNDLE',
                productId: b.id,
                name: `${b.name}（${formatOccupancy(cfg.adultCount, cfg.childCount, cfg.infantCount)}·${cfg.rooms}房 · ${cfg.goDate}→${cfg.returnDate}${addOnSummary ? ` · ${addOnSummary}` : ''}）`,
                description: b.tagline,
                emoji: b.emoji,
                unitPrice: cfg.total,
                qty: 1,
                meta: {
                  goDate: cfg.goDate,
                  returnDate: cfg.returnDate,
                  adultCount: cfg.adultCount,
                  childCount: cfg.childCount,
                  infantCount: cfg.infantCount,
                  // 兼容旧字段：pax = headCount（出行人总数，含婴儿）
                  pax: cfg.headCount,
                  rooms: cfg.rooms,
                  flightTotal: cfg.flightTotal,
                  hotelTotal: cfg.hotelTotal,
                  otherTotal: cfg.otherTotal,
                  discountPct: b.discountPct ?? 0,
                  singleCount: cfg.singleCount,
                  businessCount: cfg.businessCount,
                  ...(cfg.goLegScheduleId ? { goLegScheduleId: cfg.goLegScheduleId } : {}),
                  ...(cfg.retLegScheduleId ? { retLegScheduleId: cfg.retLegScheduleId } : {}),
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
  adultCount: number; // 成人（占座）
  childCount: number; // 占座儿童（占座，比成人便宜）
  infantCount: number; // 不占座婴儿（不占座、不占房，仍需护照）
  headCount: number; // = adult + child + infant（出行人总数）
  rooms: number; // 住宿间数 = roomsNeeded（按房型容量自动算；一间坐不下自动加房，婴儿不占床）
  goDate: string;
  returnDate: string;
  total: number;
  flightTotal: number;
  hotelTotal: number;
  otherTotal: number;
  // ── 可选升级 add-on ──
  singleCount: number; // 「一个人住酒店（单人入住）」人数
  businessCount: number; // 「升级商务舱」人数（占真实商务舱库存）
  goLegScheduleId: string | null; // 已解析的去程经济舱班次 id（升舱需补 FLIGHT 行）
  retLegScheduleId: string | null; // 已解析的回程经济舱班次 id
}

function ConfigurableBundleCard({
  bundle: b,
  flightCache,
  goDate,
  adultCount,
  childCount,
  infantCount,
  hotel,
  onView,
  onShowHotel,
  onAdd,
}: {
  bundle: BundleView;
  flightCache: FlightSearchCache;
  goDate: string;
  adultCount: number;
  childCount: number;
  infantCount: number;
  hotel?: Hotel;
  /** 跳转到套餐详情（/bundles/:id）；卡片整体或"查看详情"触发。透传当前卡片配置供详情页初始化。 */
  onView: (cfg: { goDate: string; adultCount: number; childCount: number; infantCount: number; singleCount: number; businessCount: number; nights: number }) => void;
  onShowHotel: (hotel: Hotel) => void;
  onAdd: (cfg: BundleAddConfig) => void;
}) {
  // 占座模型（镜像后端 resolveBundleOccupancy）：
  //   seatPax  = 成人 + 占座儿童（占座、计入机票座位）
  //   headCount= 成人 + 占座儿童 + 不占座婴儿（出行人总数，都要护照）
  const seatPax = adultCount + childCount;
  const headCount = adultCount + childCount + infantCount;
  // 房间数按关联房型容量算（镜像后端 computeRoomsNeeded）：一间坐不下就自动加房，
  // 加的房按房价收钱。容量缺失/未绑房型 → 兜底 2 大 1 小。婴儿不占床、单人入住独立不计入。
  const roomCapacity = resolveRoomCapacity(b.hotelRoomType);
  const baseRooms = computeRoomsNeeded(adultCount, childCount, b.hotelRoomType);
  // 单人预订（1 成人、0 儿童）：默认拼房（与同行客共一间双人房，只占半间）。
  const isSolo = isSoloOccupancy(adultCount, childCount);
  // 可选升级 add-on（默认 0；范围 0..seatPax — 婴儿不占座、不能升舱/不算单人入住房）。
  // 单人预订时 singleCount 同时充当「拼房(0) / 独住(1)」开关（默认拼房）。
  const [singleCount, setSingleCount] = useState(0); // 一个人住酒店（单人入住 / 独住）
  const [businessCount, setBusinessCount] = useState(0); // 升级商务舱

  // 日期输入框 ref：售罄时"看看其它日期"聚焦并弹出原生日期选择器（不暴露原始库存）。
  const dateInputRef = useRef<HTMLInputElement>(null);

  // 每张卡可单独改出发日期：初值优先用套餐默认出发日（管理员设的最近可出发日），
  // 未设则回退顶部选择器（页级 goDate = today+3 默认）。用户可在卡内覆盖。
  const [cardGoDate, setCardGoDate] = useState(b.defaultDepartDate ?? goDate);
  // 页→卡同步：顶部出发日期变化时把各卡同步过去（sync 逻辑保持不变）。
  // mount 用 ref 跳过，避免初始把套餐默认日清成 today+3；之后每次页级变更都同步并提示。
  const didMountSyncRef = useRef(false);
  const [syncedHint, setSyncedHint] = useState(false);
  useEffect(() => {
    if (!didMountSyncRef.current) {
      didMountSyncRef.current = true;
      return;
    }
    setCardGoDate(goDate);
    // 短暂提示：本卡已跟随上方出发日期更新（纯展示，不改同步逻辑）。
    setSyncedHint(true);
    const t = setTimeout(() => setSyncedHint(false), 2600);
    return () => clearTimeout(t);
  }, [goDate]);
  // 库存/价格查询用防抖日期（边改边查后台，不每次 onChange 都打 API）
  const queryCardGo = useDebouncedValue(cardGoDate);

  const isBiz = b.items.some((i) => i.kind === 'FLIGHT' && i.productName.includes('商务'));
  const cabin: 'ECONOMY' | 'BUSINESS' = isBiz ? 'BUSINESS' : 'ECONOMY';

  // 住宿晚数 → 回程日期。展示用 cardGoDate（即时反馈），库存查询用防抖日期。
  // 口径：hotelNights ?? 第一条 HOTEL item 的 qty ?? 默认 4 晚（镜像后端）。
  const nights = resolveBundleNights(b);
  const displayReturnDate = addDaysISO(cardGoDate, nights);
  const queryReturnDate = addDaysISO(queryCardGo, nights);

  // 触发去/回航段搜索（缓存幂等去重）
  useEffect(() => {
    flightCache.ensure(ROUTE_ORIGIN, ROUTE_DEST, queryCardGo);
    flightCache.ensure(ROUTE_DEST, ROUTE_ORIGIN, queryReturnDate);
  }, [flightCache, queryCardGo, queryReturnDate]);

  // 按运营绑定的航班号解析航段：绑定命中该班，未绑定/未命中回退首条（与旧版一致）。
  const outLeg = flightCache.getByFlightNumber(ROUTE_ORIGIN, ROUTE_DEST, queryCardGo, b.outboundFlightNumber);
  const retLeg = flightCache.getByFlightNumber(ROUTE_DEST, ROUTE_ORIGIN, queryReturnDate, b.returnFlightNumber);
  const legs = { go: toLegInfo(outLeg), ret: toLegInfo(retLeg) };

  const goTier = legTier(outLeg, cabin);
  const retTier = legTier(retLeg, cabin);

  // 升级商务舱要占真实商务舱库存 → 取去/回航段 BUSINESS 档位；任一段无商务舱/已售罄则不可升舱。
  const goBizTier = legTier(outLeg, 'BUSINESS');
  const retBizTier = legTier(retLeg, 'BUSINESS');
  // 已加载航段但查不到 BUSINESS 舱位（null）→ 视为该段无商务舱可卖。
  const businessSoldOut =
    goBizTier === 'SOLD_OUT' ||
    retBizTier === 'SOLD_OUT' ||
    (outLeg != null && goBizTier === null) ||
    (retLeg != null && retBizTier === null);
  // 升级开关只在套餐配置了升舱报价（> 0，即真的收费才算「提供升舱」）、
  // 且本航线为经济舱套餐（升舱才有意义）时出现。用 > 0 而非 != null——
  // 新建套餐留空时后端显式落 0（= 不提供升舱，见 products.service createBundle），
  // 若仍按 != null 判断会把「不提供」误读成「¥0 免费升舱」显示出来。
  const canOfferBusiness = (b.businessUpgradePerLeg ?? 0) > 0 && cabin === 'ECONOMY';

  // 占座人数变化时把 add-on 份数夹回 [0, seatPax]（婴儿不占座 → 不计入升级上限）。
  useEffect(() => {
    setSingleCount((c) => Math.min(c, seatPax));
    setBusinessCount((c) => Math.min(c, seatPax));
  }, [seatPax]);
  // 商务舱售罄时强制清零升舱份数（避免提交后被后端拒）。
  useEffect(() => {
    if (businessSoldOut || !canOfferBusiness) setBusinessCount(0);
  }, [businessSoldOut, canOfferBusiness]);

  // 酒店实时房量（关联房型才查；无包房配置 → null 不展示）
  const hotelTier = useHotelAvailability(b.hotelRoomTypeId, queryCardGo, queryReturnDate);

  // 套餐可售日期窗口（按 航班+酒店库存 逐日 + blackout 封盘）。查失败 → PERMISSIVE（空集不硬拦截）。
  const sellable = useBundleSellableDates(b.id);
  // 所选出发日不在可售集合时的原因（封盘/机位满/满房）；可售或未知 → null（不拦截）。
  // 仅当窗口已就绪且确有可售日时才据集合判定，避免空窗（加载中/查失败）误拦。
  const dateReason =
    sellable.status === 'ready' && sellable.sellableSet.size > 0 && !sellable.sellableSet.has(cardGoDate)
      ? sellable.reasonOf(cardGoDate)
      : null;

  // 实时机票单人来回价（搜不到用兜底价）
  const fb = FALLBACK_PRICE[cabin];
  const pricePerPerson = legPrice(outLeg, cabin, fb.go) + legPrice(retLeg, cabin, fb.ret);

  // 计费晚数 = 套餐住宿晚数（镜像后端 computeBundleAddOn：无关联房型时回退 hotelNights）。
  const billNights = Math.max(1, nights);
  const supp = b.singleSupplementPerNight ?? 0;
  const upg = b.businessUpgradePerLeg ?? 0;
  // 占座模型报价（镜像后端 flight 公式）：占座儿童每人减 childDiscount；不占座婴儿每人收 infantPrice。
  const childDiscount = b.childSeatDiscount ?? 0;
  const infantPrice = b.infantPrice ?? 0;
  // 操作服务费（server-priced；镜像后端 computeBundleOperationFeeTotal：每人 × 占座人数 seatPax，婴儿不收）。
  // 修复前卡片漏计此项 → 展示价比实收低一份操作费；补上以对齐下单权威价（避免 expectedTotalCny 误伤）。
  const operationFee = b.operationFee;
  const operationFeeTotal = operationFee * seatPax;
  const childDiscountTotal = childCount * childDiscount;
  const infantPriceTotal = infantCount * infantPrice;
  // ── add-on 加价（镜像后端：单人入住/独住 = singleCount×supp×nights；升舱 = businessCount×upg×legs）──
  const singleAddOn = singleCount * supp * billNights;
  const businessAddOn = businessCount * upg * b.legs;

  // 计费房间比例（展示与提交口径一致）：单人拼房只占半间（0.5），其余按容量整数房间数 baseRooms。
  //   solo 拼房（singleCount=0）→ 0.5 间（拼房价 = 0.5×房价×晚，镜像后端 roomsBilled 缺省的半间口径）；
  //   solo 独住（singleCount=1）→ 整间 + 单房差（singleAddOn）；多人 → baseRooms。
  const roomFactor = resolveBundleRoomFactor(adultCount, childCount, singleCount, baseRooms);
  // 拼房（半间）文案标签：仅单人拼房时点出，避免与整间价混淆。
  const soloShared = isSolo && singleCount <= 0;

  // 计算每个行项展示金额，逐行镜像后端权威重算（card total 必须 == order total，否则后端拒单）：
  //   FLIGHT：经济舱全价×seatPax（占座；婴儿不占座 → 不发机票座位）。儿童折扣/婴儿价不在机票行，
  //           而是并进套餐 add-on（与后端 computeBundleAddOn 一致：折扣/婴儿价计入 BUNDLE 行净额）。
  //   HOTEL：每间每晚价 × 晚数 × 房间数（镜像后端 roomFactor=roomsNeeded；一间坐不下自动加房按房价收）。
  //   VISA/TRANSFER：固定份数，不随房间数缩放。
  const itemRows = b.items.map((item) => {
    if (item.kind === 'FLIGHT') {
      return {
        ...item,
        computedTotal: pricePerPerson * seatPax,
        label: `来回${isBiz ? '商务' : '经济'}舱 · ${formatOccupancy(adultCount, childCount, infantCount)}`,
      };
    }
    if (item.kind === 'HOTEL') {
      // 酒店地面价随计费房间比例缩放（item.qty = 晚数；× roomFactor = 房间数或半间），
      // 与后端 hotel = 单价×晚×房 一致；单人拼房 roomFactor=0.5（拼房价 = 0.5×房价×晚）。
      return {
        ...item,
        computedTotal: item.unitPrice * item.qty * roomFactor,
        label: soloShared
          ? `${item.productName}（拼房价·双人一间，单人拼房）`
          : `${item.productName}（${baseRooms} 间）`,
      };
    }
    if (item.kind === 'VISA') {
      // 签证按办签人数收（S2）：办签人数 = 出行总人数 headCount（成人+儿童+婴儿，都需签证）。
      // 前台无「自备签」选择 → 自备签 = 0，办签人数 = headCount。与后端 groundTotal VISA 分支恒等。
      return { ...item, computedTotal: item.unitPrice * headCount, label: item.productName };
    }
    // TRANSFER — 固定价（按趟不按人头，不随人数缩放）
    return { ...item, computedTotal: item.unitPrice * item.qty, label: item.productName };
  });

  // 机票块（S1）：套餐内嵌 FLIGHT 行 → 沿用其行价（已是 pricePerPerson×seatPax）；未内嵌但去/回航段已解析
  //   → 按 pricePerPerson×seatPax 派生（与 CheckoutPage 下单拆腿口径恒等：outLeg/retLeg 各拆一条经济舱腿）。
  //   不补 → flightTotal 恒 0，卡片机票显示 ¥0 但下单实扣真实机票价（展示 ~547 / 实扣 ~3200）。
  const hasEmbeddedFlight = itemRows.some((r) => r.kind === 'FLIGHT');
  const flightTotal = hasEmbeddedFlight
    ? itemRows.filter((r) => r.kind === 'FLIGHT').reduce((s, r) => s + r.computedTotal, 0)
    : outLeg && retLeg
      ? pricePerPerson * seatPax
      : 0;
  const hotelTotal = itemRows.filter((r) => r.kind === 'HOTEL').reduce((s, r) => s + r.computedTotal, 0);
  const otherTotal =
    itemRows.filter((r) => r.kind !== 'FLIGHT' && r.kind !== 'HOTEL').reduce((s, r) => s + r.computedTotal, 0);
  // 加项净额（不预夹 0；镜像后端 computeBundleAddOn.total：升级 + 婴儿价 − 儿童折扣，前台无自备签）。
  //   非负夹逼下沉到「地面 + 加项 + 操作费」整体层 → 儿童折扣可正常抵扣地面价（与后端 BUNDLE 行口径一致）。
  const addOnNet = singleAddOn + businessAddOn + infantPriceTotal - childDiscountTotal;
  // 「升级/差价」概览值（仅价格构成提示行用，非负）；儿童折扣等明细另按逐条行展示。
  const addOnTotal = Math.max(0, addOnNet);
  // 套餐行（镜像后端 createOrder BUNDLE 行金额）：max(0, round(地面) + 加项净额 + 操作费)。
  const bundleRow = Math.max(0, Math.round(hotelTotal + otherTotal) + addOnNet + operationFeeTotal);
  const pct = b.discountPct ?? 0;
  const factor = (100 - pct) / 100;
  // 划线原价（未打折全包价，展示用）。
  const listTotal = flightTotal + bundleRow;
  // 权威总价：逐块取整（机票块 + 套餐行各自 round 后相加），与后端「FLIGHT 腿 + BUNDLE 行逐行 round」
  //   总价偏差 ≤1 元（不触发下单 expectedTotalCny 兜底拒单）。
  const total = Math.round(flightTotal * factor) + Math.round(bundleRow * factor);
  const perPerson = headCount > 0 ? Math.round(total / headCount) : total;

  // 售罄拦截：去/回任一航段或酒店售罄 → 禁止加购
  const soldOut = goTier === 'SOLD_OUT' || retTier === 'SOLD_OUT' || hotelTier === 'SOLD_OUT';
  // 加购禁用（单一路径）：实时售罄 OR 所选日期不可售（封盘/机位满/满房）。
  // dateReason 层叠在既有 soldOut 之上，不另开并行禁用路径；售罄文案优先，否则用日期原因文案。
  const addBlocked = soldOut || isSellableBlocked(dateReason);
  const blockTitle = soldOut ? '该日期已售罄，换个日期试试' : sellableBlockTitle(dateReason);

  // 售罄时"看看其它日期"：聚焦日期框并尝试弹出原生选择器（不暴露任何库存数字）。
  const nudgeDatePicker = () => {
    const el = dateInputRef.current;
    if (!el) return;
    el.focus();
    // showPicker 仅部分浏览器支持，失败静默（聚焦已足够引导用户改日期）。
    try {
      (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      /* 不支持 showPicker 的浏览器：focus 已生效 */
    }
  };

  // 紧迫感徽章（对标 Klook/携程"近期热订"）：仅当销量达阈值才贴，绝不暴露原始库存数字。
  const showScarcity = !soldOut && (b.soldCount ?? 0) >= SOLD_RECENTLY_THRESHOLD;

  // 评分行（rating 缺省/count=0 则不展示，不造假分数）
  const rating = b.rating;
  const reviewCount = b.reviewCount ?? rating?.count ?? 0;
  const soldCount = b.soldCount ?? 0;

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

  // 多人「单人入住」升级（占座 seatPax≥2：多人里某几位想一人一间；婴儿不占房不算）。
  const canOfferSingle = b.singleSupplementPerNight != null && seatPax >= 2;
  // 单人「拼房 / 独住」开关（solo 才出现；配置了单房差才可选独住）。默认拼房（singleCount=0）。
  const canOfferSoloRoom = isSolo && b.singleSupplementPerNight != null;

  return (
    <article className="card-warm-interactive group overflow-hidden">
      {/* 图片整块可点 → 详情页（不影响下方加购按钮，按钮 stopPropagation 走自己的逻辑） */}
      <button
        type="button"
        onClick={() => onView({ goDate: cardGoDate, adultCount, childCount, infantCount, singleCount, businessCount, nights })}
        aria-label={`查看「${b.name}」套餐详情`}
        className="relative block w-full overflow-hidden bg-sand-light text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
      >
        <Img src={b.photo} alt={b.name} ratio="4/3" className="img-zoom max-h-48" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/40 to-transparent" />
        <span className="absolute left-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/85 text-brand shadow-sm backdrop-blur-sm">
          <Icon name="package" className="h-4 w-4" />
        </span>
        <div className="absolute right-3 top-3 flex flex-col items-end gap-1.5">
          {pct > 0 && (
            <span className="badge-deal">省 {pct}%</span>
          )}
          {showScarcity && <ScarcityBadge kind="soldRecently" text="近期热订" />}
        </div>
      </button>
      <div className="p-4 md:p-5">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-extrabold tracking-tight text-ink">
              <Link
                to={`/bundles/${b.id}`}
                className="transition-colors hover:text-brand focus:outline-none focus-visible:underline"
              >
                {b.name}
              </Link>
            </h3>
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">{b.tagline}</p>

          {/* 评分 + 销量（对标 Klook/携程；缺省不展示，不造假） */}
          {(rating || soldCount > 0) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
              {rating && (
                <StarRating value={rating.average} size="sm" showValue count={reviewCount} />
              )}
              {soldCount > 0 && (
                <span className="text-ink-muted">已售 {soldCount.toLocaleString()}</span>
              )}
            </div>
          )}

          {/* 含什么 一眼看清 —— 棕榈绿福利 chip（含早/接送/签证/中文客服） */}
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            {inclusions.map((inc) => (
              <span key={inc.label} className="chip-palm">
                <Icon name={inc.icon} className="h-3.5 w-3.5" />
                {inc.label}
              </span>
            ))}
            <RefundBadge />
          </div>
        </div>

        {/* 人数 + 房间数（按房型容量自动算；一间坐不下自动加房，婴儿不占床） */}
        <div className="flex flex-col gap-1 items-end">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700">
            <Icon name="user" className="h-3.5 w-3.5" />
            {formatOccupancy(adultCount, childCount, infantCount)}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-50 px-2.5 py-1 text-xs font-semibold text-purple-700">
            <Icon name="hotel" className="h-3.5 w-3.5" />
            {soloShared
              ? '住宿：拼房（与同行客共一间双人房）'
              : `房间数：${baseRooms} 间（每间最多 ${roomCapacity.maxAdults} 大 ${roomCapacity.maxChildren} 小）`}
          </span>
          {/* 人数一间坐不下 → 自动加房，明确告知价格已含多出的房间 */}
          {baseRooms > 1 && (
            <span className="text-right text-[11px] font-medium text-purple-600">
              需 {baseRooms} 间房（按 {roomCapacity.maxAdults} 大 {roomCapacity.maxChildren} 小自动安排，价格已含）
            </span>
          )}
        </div>
      </div>

      {/* 出行日期可改：每张卡独立选出发日期，机位/房量/价格随之实时更新；只让选可售日期。 */}
      <div className="mt-3 inline-flex flex-wrap items-center gap-2 rounded-lg bg-canvas px-2.5 py-1.5 text-xs font-semibold text-ink">
        <Icon name="calendar" className="h-4 w-4 text-brand" />
        <label className="flex items-center gap-1.5">
          <span className="text-ink-soft">出发</span>
          <input
            ref={dateInputRef}
            type="date"
            className="input h-7 w-24 sm:w-auto px-2 py-0.5 text-xs"
            // 约束到可售区间：min = max(今天, 首个可售日)，max = 末个可售日。
            // 窗口未知（加载中/查失败 PERMISSIVE）→ 回退 min=今天、无 max（不硬框）。
            min={sellable.minDate && sellable.minDate > todayISO(0) ? sellable.minDate : todayISO(0)}
            max={sellable.maxDate ?? undefined}
            value={cardGoDate}
            onChange={(e) => setCardGoDate(e.target.value)}
            aria-label="出发日期"
          />
        </label>
        <span className="text-ink-soft">回 {formatMonthDay(displayReturnDate)} · {nights} 晚</span>
        {/* 页级出发日期把本卡同步过来时的短暂提示（纯展示，不改同步逻辑） */}
        {syncedHint && (
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand">
            <Icon name="check" className="h-3 w-3" />
            已跟随上方出发日期更新
          </span>
        )}
        {/* 所选日期不可售：保留所选值，旁边标原因（封盘/机位满/满房），加购同时禁用 */}
        <SellableReasonChip reason={dateReason} />
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

      {/* 酒店 + 房型（含双早 · 每间最多 X 大 Y 小 · 床型尽量安排）+ 实时房量档位 */}
      {(b.hotelRoomType || hotel) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-purple-50/70 p-2 sm:p-2.5 text-[11px] sm:text-xs text-slate-700">
          <span className="inline-flex items-center gap-1.5">
            <Icon name="hotel" className="h-4 w-4 text-purple-600" />
            <span className="font-medium">{b.hotelRoomType?.hotelName ?? hotel?.name}</span>
            {b.hotelRoomType?.name ? ` · ${b.hotelRoomType.name}` : ''} · 含双早 · 每间最多 {roomCapacity.maxAdults} 大 {roomCapacity.maxChildren} 小
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
        {/* S1：套餐未内嵌 FLIGHT 行时，用实时解析的去/回航段派生一条机票明细（与下单拆腿口径恒等），
            避免机票展示 ¥0；内嵌 FLIGHT 行的套餐则由下方 itemRows 正常展示。 */}
        {!hasEmbeddedFlight && outLeg && retLeg && (
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`rounded px-1.5 py-0.5 font-medium ${KIND_LABEL.FLIGHT.color}`}>
                {KIND_LABEL.FLIGHT.label}
              </span>
              <span className="text-slate-700 truncate">
                来回{isBiz ? '商务' : '经济'}舱 · {formatOccupancy(adultCount, childCount, infantCount)}
              </span>
            </div>
            <span className="text-slate-600 tabular-nums whitespace-nowrap">
              ¥{(pricePerPerson * seatPax).toLocaleString()}
            </span>
          </div>
        )}
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
        {/* 占座儿童折扣 / 不占座婴儿价 明细行（>0 才显示，镜像后端 flight 公式） */}
        {childCount > 0 && childDiscount > 0 && (
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">儿童</span>
              <span className="text-slate-700 truncate">占座儿童 ×{childCount} · 每人 −¥{childDiscount.toLocaleString()}</span>
            </div>
            <span className="text-emerald-700 tabular-nums whitespace-nowrap">−¥{childDiscountTotal.toLocaleString()}</span>
          </div>
        )}
        {infantCount > 0 && (
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700">婴儿</span>
              <span className="text-slate-700 truncate">婴儿 ×{infantCount} · 每人 ¥{infantPrice.toLocaleString()}</span>
            </div>
            <span className="text-slate-600 tabular-nums whitespace-nowrap">+¥{infantPriceTotal.toLocaleString()}</span>
          </div>
        )}
        {/* 升级 add-on 明细行（选了才显示）；单人预订独住时显示为「独住·单房差」 */}
        {singleCount > 0 && (
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="rounded bg-indigo-100 px-1.5 py-0.5 font-medium text-indigo-700">升级</span>
              <span className="text-slate-700 truncate">
                {isSolo ? '独住 · 单房差' : `单人入住 ×${singleCount}`}
              </span>
            </div>
            <span className="text-slate-600 tabular-nums whitespace-nowrap">+¥{singleAddOn.toLocaleString()}</span>
          </div>
        )}
        {businessCount > 0 && (
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="rounded bg-indigo-100 px-1.5 py-0.5 font-medium text-indigo-700">升级</span>
              <span className="text-slate-700 truncate">升级商务舱 ×{businessCount}</span>
            </div>
            <span className="text-slate-600 tabular-nums whitespace-nowrap">+¥{businessAddOn.toLocaleString()}</span>
          </div>
        )}
        {/* 操作服务费明细行（按占座人数收，与后端一致；补上以让明细行加总 == 展示总价）。 */}
        {operationFeeTotal > 0 && (
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="rounded bg-slate-200 px-1.5 py-0.5 font-medium text-slate-700">服务</span>
              <span className="text-slate-700 truncate">操作服务费 ×{seatPax} · 每人 ¥{operationFee.toLocaleString()}</span>
            </div>
            <span className="text-slate-600 tabular-nums whitespace-nowrap">+¥{operationFeeTotal.toLocaleString()}</span>
          </div>
        )}
      </div>

      {/* 单人预订：拼房（默认，半间价）/ 独住（整间 + 单房差）二选一。诚实标价，与服务端实收一致。 */}
      {canOfferSoloRoom && (
        <div className="mt-3 rounded-xl border border-brand-200 bg-brand-50/40 p-3 text-xs">
          <div className="font-semibold text-ink">住宿方式（单人预订）</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setSingleCount(0)}
              aria-pressed={singleCount <= 0}
              className={`rounded-xl border-2 p-2.5 text-left transition-colors ${
                singleCount <= 0
                  ? 'border-brand bg-surface shadow-card'
                  : 'border-slate-200 bg-surface/60 hover:border-brand/50'
              }`}
            >
              <div className="font-semibold text-ink">拼房</div>
              <div className="mt-0.5 text-ink-muted">与同行客共一间 · 默认</div>
            </button>
            <button
              type="button"
              onClick={() => setSingleCount(1)}
              aria-pressed={singleCount >= 1}
              className={`rounded-xl border-2 p-2.5 text-left transition-colors ${
                singleCount >= 1
                  ? 'border-brand bg-surface shadow-card'
                  : 'border-slate-200 bg-surface/60 hover:border-brand/50'
              }`}
            >
              <div className="font-semibold text-ink">独住</div>
              <div className="mt-0.5 text-ink-muted">
                一人一间 · +¥{(b.singleSupplementPerNight ?? 0).toLocaleString()}/晚
              </div>
            </button>
          </div>
        </div>
      )}

      {/* 可选升级 add-on（直接在前台选购，下单即含；不走客服） */}
      {(canOfferSingle || canOfferBusiness) && (
        <div className="mt-3 space-y-2.5 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 text-xs">
          <div className="font-semibold text-indigo-900">可选升级（即选即享）</div>
          {canOfferSingle && (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-ink">一个人住酒店（单人入住）</div>
                <div className="text-ink-muted">
                  一人一间房 · +¥{(b.singleSupplementPerNight ?? 0).toLocaleString()}/晚/人
                </div>
              </div>
              <Stepper value={singleCount} min={0} max={seatPax} onChange={setSingleCount} />
            </div>
          )}
          {canOfferBusiness && (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-ink">升级商务舱</div>
                <div className="text-ink-muted">
                  {businessSoldOut
                    ? '商务舱已售罄'
                    : `+¥${(b.businessUpgradePerLeg ?? 0).toLocaleString()}/程/人`}
                </div>
              </div>
              <Stepper
                value={businessCount}
                min={0}
                max={businessSoldOut ? 0 : seatPax}
                onChange={setBusinessCount}
              />
            </div>
          )}
        </div>
      )}

      {/* 价格汇总 */}
      <div className="mt-4 rounded-2xl border border-slate-200/70 bg-canvas p-3.5">
        <div className="flex flex-col gap-1 text-[11px] text-ink-muted sm:flex-row sm:items-center sm:justify-between sm:text-xs">
          <span>
            机票 ¥{flightTotal.toLocaleString()} + 酒店 ¥{hotelTotal.toLocaleString()} + 其他 ¥{otherTotal.toLocaleString()}
            {addOnTotal > 0 && ` + 升级/差价 ¥${addOnTotal.toLocaleString()}`}
            {operationFeeTotal > 0 && ` + 服务费 ¥${operationFeeTotal.toLocaleString()}`}
            {pct > 0 && ` − 已省 ${pct}%`}
          </span>
        </div>
        <div className="mt-1.5 flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between">
          <div className="text-xs text-ink-muted">
            {formatOccupancy(adultCount, childCount, infantCount)} · {baseRooms} 间房 · {formatMonthDay(cardGoDate)} → {formatMonthDay(displayReturnDate)}
          </div>
          <div className="flex items-baseline justify-end gap-2 text-right">
            {pct > 0 && (
              <span className="price-old">¥{listTotal.toLocaleString()}</span>
            )}
            <div>
              <span className="price text-2xl">¥{total.toLocaleString()}</span>
              <div className="text-xs text-ink-muted">≈ ¥{perPerson.toLocaleString()} /人</div>
            </div>
          </div>
        </div>
      </div>

      {/* 不可加购提示 + "看看其它日期"引导（售罄 / 封盘 / 机位满 / 满房；不暴露原始库存数字） */}
      {addBlocked && (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs font-semibold text-deal">
          <span>{blockTitle ?? '该日期暂不可售，换个日期试试'}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full bg-deal-light px-2.5 py-1 text-deal-dark transition-colors hover:bg-deal/15"
            onClick={nudgeDatePicker}
          >
            <Icon name="calendar" className="h-3.5 w-3.5" />
            看看其它日期
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className="btn-ghost text-sm"
          onClick={() => onView({ goDate: cardGoDate, adultCount, childCount, infantCount, singleCount, businessCount, nights })}
        >
          查看详情
        </button>
        <Link to="/cart" className="btn-secondary text-sm">查看购物车</Link>
        <button
          className="btn-deal text-sm"
          disabled={addBlocked}
          title={blockTitle}
          onClick={() =>
            onAdd({
              adultCount,
              childCount,
              infantCount,
              headCount,
              rooms: baseRooms,
              goDate: cardGoDate,
              returnDate: displayReturnDate,
              total,
              flightTotal,
              hotelTotal,
              otherTotal,
              singleCount,
              businessCount,
              goLegScheduleId: outLeg?.scheduleId ?? null,
              retLegScheduleId: retLeg?.scheduleId ?? null,
            })
          }
        >
          {soldOut ? '该日期已售罄' : isSellableBlocked(dateReason) ? '该日期不可售' : '加入购物车'}
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
            {hotel.rating && hotel.rating.count > 0 && (
              <span className="rating">
                {hotel.rating.average.toFixed(1)} / 5（{hotel.rating.count} 条评价）
              </span>
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
              含双早
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

/**
 * 占座模型出行人选择器：成人（占座，≥1）/ 占座儿童（占座，≥0）/ 不占座婴儿（≥0）。
 * 三行紧凑 stepper，附一行说明；具体房间数按各套餐房型容量在卡片上算（一间坐不下自动加房）。
 */
function OccupancyPicker({
  adultCount,
  childCount,
  infantCount,
  onAdult,
  onChild,
  onInfant,
}: {
  adultCount: number;
  childCount: number;
  infantCount: number;
  onAdult: (v: number) => void;
  onChild: (v: number) => void;
  onInfant: (v: number) => void;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 p-2.5">
      <OccupancyRow label="成人" hint="占座" value={adultCount} min={1} max={9} onChange={onAdult} />
      <OccupancyRow label="儿童" hint="占座 · 比成人便宜" value={childCount} min={0} max={9} onChange={onChild} />
      <OccupancyRow label="婴儿" hint="不占座 · 不占床" value={infantCount} min={0} max={9} onChange={onInfant} />
      <p className="text-[11px] text-ink-muted">
        房间数按各套餐房型自动算（一间坐不下会自动加房）；以每张套餐卡上的"房间数"为准。
      </p>
    </div>
  );
}

function OccupancyRow({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{label}</div>
        <div className="text-[11px] text-ink-muted">{hint}</div>
      </div>
      <Stepper value={value} min={min} max={max} onChange={onChange} />
    </div>
  );
}

// RankBadge 已移除：dateRank A/B/C/D 是公司内部日期等级，不对客户展示
// 余房档位：关联房型 → 查后台房控；未关联或未配置包房 → 不展示（不造假数字）
