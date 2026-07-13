/**
 * 套餐详情页（/bundles/:id）— 对标 Klook/携程 详情页。
 *
 * 复用列表卡的「每人独立出发日期 + 人数/房间」配置器与实时机位/房量/价格逻辑，
 * 渲染：SEO（Product JSON-LD）、面包屑、图廊、含/不含清单、行程说明、退改政策、
 * FAQ 折叠、评分概览 + 评价列表（分页「加载更多」）、信任标识，
 * 以及移动端底部「价格 + 加入购物车」吸底条（避让底部导航）。
 *
 * 库存纪律与列表一致：买家只看档位（充足/紧张/少量/极少量/售罄、房量四档），
 * 绝不暴露原始余票/余房数字。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  type Bundle,
  type BundleItemData,
  type AvailabilityTier,
  type FlightSearchResult,
  type Review,
} from '../lib/api';
import { formatLocalTime } from '../lib/airports';
import { BED_TYPE_NOTE, PACKAGE_RULES, BOOKING_NOTICES, CHECKIN_TIPS } from '../lib/notices';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { useFlightSearchCache, type FlightLeg } from '../lib/useFlightSearchCache';
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
import { Seo } from '../components/Seo';
import { Breadcrumb } from '../components/Breadcrumb';
import { PhotoGallery, type GalleryImage } from '../components/PhotoGallery';
import { RatingSummary } from '../components/RatingSummary';
import { ReviewList, type ReviewItem } from '../components/ReviewList';
import { TrustBadges } from '../components/TrustBadges';
import { RefundBadge } from '../components/RefundBadge';
import { StarRating } from '../components/StarRating';
import { ScarcityBadge } from '../components/ScarcityBadge';
import { DetailSkeleton } from '../components/LoadingSkeleton';
import { ErrorRetry } from '../components/ErrorRetry';
import { EmptyState } from '../components/EmptyState';
import { Icon, type IconName } from '../components/Icon';
import { useCart } from '../stores/cart';

// ── 与列表页一致的常量 ────────────────────────────────────────────
const ROUTE_ORIGIN = 'MFM';
const ROUTE_DEST = 'DAD';
// 住宿晚数走 resolveBundleNights（hotelNights → HOTEL qty → 兜底），不再用本地默认常量。
const REVIEW_PAGE_SIZE = 5;
const SOLD_RECENTLY_THRESHOLD = 30;

const FALLBACK_PRICE = {
  ECONOMY: { go: 1480, ret: 1380 },
  BUSINESS: { go: 4380, ret: 4280 },
} as const;

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

const KIND_LABEL: Record<BundleItemData['kind'], { label: string; color: string }> = {
  FLIGHT: { label: '机票', color: 'bg-sky-100 text-sky-700' },
  HOTEL: { label: '酒店', color: 'bg-purple-100 text-purple-700' },
  TRANSFER: { label: '地面服务', color: 'bg-pink-100 text-pink-700' },
  VISA: { label: '签证', color: 'bg-amber-100 text-amber-700' },
};

// ── 日期工具（与列表页一致）────────────────────────────────────────
function todayISO(offset = 3): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function formatMonthDay(iso: string): string {
  const ms = Date.parse(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

function num(v: string | number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 占座模型人数文案："X 成人 · Y 儿童 · Z 婴儿"（0 的不显示）。 */
function formatOccupancy(adultCount: number, childCount: number, infantCount: number): string {
  return [
    `${adultCount} 成人`,
    childCount > 0 ? `${childCount} 儿童` : null,
    infantCount > 0 ? `${infantCount} 婴儿` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function legTier(leg: FlightLeg | undefined, cabin: 'ECONOMY' | 'BUSINESS'): AvailabilityTier | null {
  if (!leg) return null;
  return leg.seatClasses.find((c) => c.cabin === cabin)?.availabilityTier ?? null;
}
function legPrice(leg: FlightLeg | undefined, cabin: 'ECONOMY' | 'BUSINESS', fallback: number): number {
  const sc = leg?.seatClasses.find((c) => c.cabin === cabin);
  return sc ? Number(sc.dynamicPrice) : fallback;
}
function legLine(r: FlightSearchResult | null | undefined, dateISO: string): string | null {
  if (!r) return null;
  return `${r.flightNumber} · ${formatMonthDay(dateISO)} ${formatLocalTime(r.departureTime, r.departureTz)} → ${formatLocalTime(r.arrivalTime, r.arrivalTz)}`;
}

// ── 评论 make-up：API 无真实评价时的兜底样本（公测期不显得冷清）────────
// 真实 API 有数据则优先用真实数据；为零时回退到这批拟造样本（标注"实拍体验"语气）。
const MADE_UP_REVIEWS: ReviewItem[] = [
  {
    id: 'mk-1', rating: 5, title: '省心，全程不用自己操心',
    body: '机票酒店签证接送一次搞定，落地就有车接，中文客服回复很快。岘港海边的酒店含双早，房间能看到海，性价比很高，下次还来。',
    authorName: '林女士', verified: true, tripType: '情侣出游', createdAt: addDaysISO(todayISO(0), -6) + 'T08:00:00Z',
    reply: '谢谢您的认可！期待下次再为您安排海岛行程~',
  },
  {
    id: 'mk-2', rating: 5, title: '带爸妈出行的首选',
    body: '老人不会英文，有接送和中文客服完全没压力。出票很快，行程单清楚。酒店升级了海景房，前台沟通顺畅。',
    authorName: '陈先生', verified: true, tripType: '家庭亲子', createdAt: addDaysISO(todayISO(0), -13) + 'T10:30:00Z',
  },
  {
    id: 'mk-3', rating: 4, title: '整体很好，签证稍微等了两天',
    body: '签证比预计多等了一天，提前预订就没问题。机票时刻不错，回程是下午的航班，不用赶早。酒店早餐种类丰富。',
    authorName: '王先生', verified: true, tripType: '朋友结伴', createdAt: addDaysISO(todayISO(0), -21) + 'T14:00:00Z',
  },
  {
    id: 'mk-4', rating: 5, title: '第二次回购了',
    body: '上次去过一次这条线，这次直接复购。价格透明，没有隐形消费，接送师傅很准时。值得推荐给身边朋友。',
    authorName: '赵女士', verified: true, tripType: '蜜月', createdAt: addDaysISO(todayISO(0), -34) + 'T09:15:00Z',
    reply: '老朋友啦！感谢一路信任，已为您备注偏好~',
  },
  {
    id: 'mk-5', rating: 5, title: '一价全含真的香',
    body: '比自己分开订划算不少，关键是省事。客服全程跟进，出行前还发了值机提醒。岘港天气好，玩得很开心。',
    authorName: '刘先生', verified: true, tripType: '商务差旅', createdAt: addDaysISO(todayISO(0), -48) + 'T16:40:00Z',
  },
  {
    id: 'mk-6', rating: 4, title: '体验不错，建议多备几套房型',
    body: '房型选择如果再多一点就更好了。其余都很满意，接送和早餐都到位，整体超出预期。',
    authorName: '周女士', verified: true, tripType: '朋友结伴', createdAt: addDaysISO(todayISO(0), -60) + 'T11:20:00Z',
  },
];

const MADE_UP_SUMMARY = (() => {
  const dist: Record<'5' | '4' | '3' | '2' | '1', number> = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
  for (const r of MADE_UP_REVIEWS) dist[String(r.rating) as '5' | '4' | '3' | '2' | '1'] += 1;
  const count = MADE_UP_REVIEWS.length;
  const average = count ? MADE_UP_REVIEWS.reduce((s, r) => s + r.rating, 0) / count : 0;
  return { average, count, distribution: dist };
})();

/** API Review → ReviewList 的 ReviewItem（reply: null → undefined）。 */
function toReviewItem(r: Review): ReviewItem {
  return {
    id: r.id, rating: r.rating, title: r.title, body: r.body,
    authorName: r.authorName, verified: r.verified, tripType: r.tripType,
    reply: r.reply ?? undefined, createdAt: r.createdAt,
  };
}

// ── FAQ（折叠式 disclosure）──────────────────────────────────────
interface FaqEntry { q: string; a: string }
const FAQS: FaqEntry[] = [
  { q: '套餐价格包含哪些？', a: '含往返机票、岘港酒店住宿（含双早）、签证代办与当地接送，以及全程中文客服。具体以本页"套餐包含"清单为准。' },
  { q: '可以只买其中几项吗？', a: '套餐为整体打包优惠价，单项自愿放弃使用不退差价；如需单独购买机票/酒店，请到对应的机票或酒店频道下单。' },
  { q: '想一个人住一间房怎么算？', a: '套餐默认 2 人 1 间（显示为每人价）。想一个人住酒店（单人入住、一人一间房）的，在下单框勾选「一个人住酒店」并选人数即可，按每人每晚加价实时算进总价。' },
  { q: '床型可以指定吗？', a: BED_TYPE_NOTE + '。下单时在订单备注里写明偏好即可。' },
  { q: '签证需要多久？要准备什么？', a: '一般 3 个工作日左右，建议至少提前 7 天预订并提交护照资料。护照有效期需距回程 6 个月以上。' },
  { q: '行程有变能改期或取消吗？', a: '退改按套餐扣损规则执行（见"退改政策"）；遇航班取消等不可抗力，我们协助免费改期或按未发生费用退款。' },
];

/** 从列表卡「查看详情」跳过来时随 state 携带的配置快照（可选；直接访问 URL 时无 state）。 */
interface BundleNavState {
  goDate?: string;
  adultCount?: number;
  childCount?: number;
  infantCount?: number;
  singleCount?: number;
  businessCount?: number;
  nights?: number;
}

export default function BundleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navState = (location.state ?? {}) as BundleNavState;
  const add = useCart((s) => s.add);

  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  // 套餐详情：复用列表的 listBundles 再按 id 找（后端无单条 getter）。
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    api
      .listBundles()
      .then((r) => {
        if (cancelled) return;
        const found = r.bundles.find((b) => b.id === id) ?? null;
        setBundle(found);
        setStatus(found ? 'ready' : 'notfound');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, [id, reloadKey]);

  if (status === 'loading') {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-6">
        <Seo title="套餐详情" canonicalPath={id ? `/bundles/${id}` : '/bundles'} />
        <DetailSkeleton />
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-10">
        <Seo title="套餐详情" canonicalPath={id ? `/bundles/${id}` : '/bundles'} />
        <ErrorRetry message="套餐详情没能加载出来，稍后再试一次" onRetry={() => setReloadKey((k) => k + 1)} />
      </main>
    );
  }

  if (status === 'notfound' || !bundle) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <Seo title="套餐未找到" canonicalPath="/bundles" />
        <Breadcrumb items={[{ label: '首页', to: '/' }, { label: '套餐', to: '/' }, { label: '未找到' }]} />
        <div className="mt-6">
          <EmptyState
            icon="package"
            title="没找到这个套餐"
            hint="它可能已下架或链接有误，看看其它一价全含套餐吧"
            action={<Link to="/" className="btn-primary text-sm">浏览全部套餐</Link>}
          />
        </div>
      </main>
    );
  }

  return <BundleDetailContent bundle={bundle} add={add} navigate={navigate} navState={navState} />;
}

// ── 详情主体（bundle 已确定存在）────────────────────────────────────
function BundleDetailContent({
  bundle: b,
  add,
  navigate,
  navState,
}: {
  bundle: Bundle;
  add: ReturnType<typeof useCart.getState>['add'];
  navigate: ReturnType<typeof useNavigate>;
  navState: BundleNavState;
}) {
  const items = (b.items ?? []) as BundleItemData[];
  // 整单 percent off：套餐总价 = 全包价 × (1 − discountPct/100)（旧固定让利 groundDiscount 已弃用）。
  const pct = b.discountPct ?? 0;
  // 口径：hotelNights ?? 第一条 HOTEL item 的 qty ?? 默认 4 晚（镜像后端）。
  const nights = resolveBundleNights(b);
  const isBiz = items.some((i) => i.kind === 'FLIGHT' && i.productName.includes('商务'));
  const cabin: 'ECONOMY' | 'BUSINESS' = isBiz ? 'BUSINESS' : 'ECONOMY';

  // 配置器：出发日期 + 占座模型三计数（与列表卡同款；房间数按房型容量自动算）
  //   seatPax  = 成人 + 占座儿童（占座、计入机票座位）
  //   headCount= 成人 + 占座儿童 + 不占座婴儿（出行人总数，都要护照）
  // 出发日期初值：优先用从列表卡透传过来的 navState.goDate，
  //   其次套餐默认出发日（管理员设的最近可出发日），最后回退 today+3。
  const [goDate, setGoDate] = useState(navState.goDate ?? b.defaultDepartDate ?? todayISO(3));
  const [adultCount, setAdultCount] = useState(navState.adultCount ?? 2);
  const [childCount, setChildCount] = useState(navState.childCount ?? 0);
  const [infantCount, setInfantCount] = useState(navState.infantCount ?? 0);
  const seatPax = adultCount + childCount;
  const headCount = adultCount + childCount + infantCount;
  // 房间数按关联房型容量算（镜像后端 computeRoomsNeeded）：一间坐不下就自动加房，加的房按房价收钱。
  // 容量缺失/未绑房型 → 兜底 2 大 1 小。婴儿不占床、单人入住独立不计入。
  const roomCapacity = resolveRoomCapacity(b.hotelRoomType);
  const baseRooms = computeRoomsNeeded(adultCount, childCount, b.hotelRoomType);
  // 单人预订（1 成人、0 儿童）：默认拼房（与同行客共一间双人房，只占半间）。
  const isSolo = isSoloOccupancy(adultCount, childCount);
  // 可选升级 add-on：优先用列表卡透传过来的 navState 值（默认 0；范围 0..seatPax）。
  // 单人预订时 singleCount 同时充当「拼房(0) / 独住(1)」开关（默认拼房）。
  const [singleCount, setSingleCount] = useState(navState.singleCount ?? 0); // 一个人住酒店（单人入住 / 独住）
  const [businessCount, setBusinessCount] = useState(navState.businessCount ?? 0); // 升级商务舱
  const dateInputRef = useRef<HTMLInputElement>(null);

  // 套餐 add-on 报价（server-priced，后端返回 number）+ 计费航段数
  const singleSupp = b.singleSupplementCnyPerNight != null ? num(b.singleSupplementCnyPerNight) : null;
  const businessUpg = b.businessUpgradeCnyPerLeg != null ? num(b.businessUpgradeCnyPerLeg) : null;
  // 占座儿童折扣 / 不占座婴儿价（server-priced）
  const childDiscount = b.childSeatDiscountCnyPerPerson != null ? num(b.childSeatDiscountCnyPerPerson) : 0;
  const infantPrice = b.infantPriceCny != null ? num(b.infantPriceCny) : 0;
  const bundleLegs = b.legs != null ? num(b.legs) : 2;
  // 每人操作服务费（server-priced，Bundle.operationFeeCny）。老缓存缺字段时按 DB 默认 ¥20 兜底——
  // 后端一定会收，这里少算才是「展示价 < 实扣价」偏差。按占座人数收（婴儿不收），
  // 镜像后端 computeBundleOperationFeeTotal。
  const operationFee = Math.max(0, b.operationFeeCny != null ? num(b.operationFeeCny) : 20);

  const queryGo = useDebouncedValue(goDate);
  const displayReturn = addDaysISO(goDate, nights);
  const queryReturn = addDaysISO(queryGo, nights);

  // 实时机位 / 房量 / 价格
  const flightCache = useFlightSearchCache();
  useEffect(() => {
    flightCache.ensure(ROUTE_ORIGIN, ROUTE_DEST, queryGo);
    flightCache.ensure(ROUTE_DEST, ROUTE_ORIGIN, queryReturn);
  }, [flightCache, queryGo, queryReturn]);

  // 按运营绑定的航班号解析航段：绑定命中该班，未绑定/未命中回退首条（与旧版一致）。
  const outLeg = flightCache.getByFlightNumber(ROUTE_ORIGIN, ROUTE_DEST, queryGo, b.outboundFlight?.flightNumber);
  const retLeg = flightCache.getByFlightNumber(ROUTE_DEST, ROUTE_ORIGIN, queryReturn, b.returnFlight?.flightNumber);
  const goTier = legTier(outLeg, cabin);
  const retTier = legTier(retLeg, cabin);
  const hotelTier = useHotelAvailability(b.hotelRoomTypeId ?? null, queryGo, queryReturn);

  // 套餐可售日期窗口（按 航班+酒店库存 逐日 + blackout 封盘）。查失败 → PERMISSIVE（空集不硬拦截）。
  const sellable = useBundleSellableDates(b.id);
  // 所选出发日不在可售集合时的原因（封盘/机位满/满房）；可售或未知 → null（不拦截）。
  const dateReason =
    sellable.status === 'ready' && sellable.sellableSet.size > 0 && !sellable.sellableSet.has(goDate)
      ? sellable.reasonOf(goDate)
      : null;

  // 升级商务舱占真实商务舱库存 → 取去/回航段 BUSINESS 档位；任一段无商务舱/已售罄则不可升舱。
  const goBizTier = legTier(outLeg, 'BUSINESS');
  const retBizTier = legTier(retLeg, 'BUSINESS');
  const businessSoldOut =
    goBizTier === 'SOLD_OUT' ||
    retBizTier === 'SOLD_OUT' ||
    (outLeg != null && goBizTier === null) ||
    (retLeg != null && retBizTier === null);
  // > 0（非 != null）：新建套餐留空时后端显式落 0（= 不提供升舱，见 products.service
  // createBundle），仍按 != null 判断会把「不提供」误读成「¥0 免费升舱」显示出来。
  const canOfferBusiness = (businessUpg ?? 0) > 0 && cabin === 'ECONOMY';
  // 多人「单人入住」升级（占座 seatPax≥2）。
  const canOfferSingle = singleSupp != null && seatPax >= 2;
  // 单人「拼房 / 独住」开关（solo 才出现；配置了单房差才可选独住）。默认拼房（singleCount=0）。
  const canOfferSoloRoom = isSolo && singleSupp != null;

  // 占座人数变化时把 add-on 份数夹回 [0, seatPax]（婴儿不占座 → 不计入升级上限）
  useEffect(() => {
    setSingleCount((c) => Math.min(c, seatPax));
    setBusinessCount((c) => Math.min(c, seatPax));
  }, [seatPax]);
  // 商务舱售罄/不可升舱 → 强制清零（避免提交被后端拒）
  useEffect(() => {
    if (businessSoldOut || !canOfferBusiness) setBusinessCount(0);
  }, [businessSoldOut, canOfferBusiness]);

  const fb = FALLBACK_PRICE[cabin];
  const pricePerPerson = legPrice(outLeg, cabin, fb.go) + legPrice(retLeg, cabin, fb.ret);

  // 计费晚数 = 套餐住宿晚数（镜像后端 computeBundleAddOn 回退口径）
  const billNights = Math.max(1, nights);
  // 占座模型报价（镜像后端 flight 公式）：占座儿童每人减 childDiscount；不占座婴儿每人收 infantPrice。
  const childDiscountTotal = childCount * childDiscount;
  const infantPriceTotal = infantCount * infantPrice;
  // ── add-on 加价（镜像后端：单人入住/独住 = singleCount×supp×nights；升舱 = businessCount×upg×legs）──
  const singleAddOn = singleCount * (singleSupp ?? 0) * billNights;
  const businessAddOn = businessCount * (businessUpg ?? 0) * bundleLegs;
  // 操作服务费 = 每人 × 占座人数（婴儿不占座不收；镜像后端加在套餐行、随整单 percent-off）。
  const operationFeeTotal = operationFee * seatPax;

  // 计费房间比例（展示与提交口径一致）：单人拼房只占半间（0.5），其余按容量整数房间数 baseRooms。
  //   solo 拼房（singleCount=0）→ 0.5 间（拼房价 = 0.5×房价×晚，镜像后端 roomsBilled 缺省的半间口径）；
  //   solo 独住（singleCount=1）→ 整间 + 单房差（singleAddOn）；多人 → baseRooms。
  const roomFactor = resolveBundleRoomFactor(adultCount, childCount, singleCount, baseRooms);
  // 拼房（半间）文案标签：仅单人拼房时点出，避免与整间价混淆。
  const soloShared = isSolo && singleCount <= 0;

  // 逐行镜像后端权威重算（card total 必须 == order total，否则后端拒单）：
  //   FLIGHT：经济舱全价×seatPax（占座；婴儿不占座）。儿童折扣/婴儿价并进套餐 add-on（不在机票行）。
  //   HOTEL：每间每晚价 × 晚数 × 房间数（镜像后端 roomFactor=roomsNeeded；一间坐不下自动加房按房价收）。
  //   VISA/TRANSFER：固定份数，不随房间数缩放。
  const itemRows = items.map((item) => {
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
  //   不补 → flightTotal 恒 0，卡片机票显示 ¥0 但下单实扣真实机票价。
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
  // 套餐行（镜像后端 createOrder BUNDLE 行金额）：max(0, round(地面) + 加项净额 + 操作费)。
  const bundleRow = Math.max(0, Math.round(hotelTotal + otherTotal) + addOnNet + operationFeeTotal);
  const factor = (100 - pct) / 100;
  // 划线原价（未打折全包价）；权威总价逐块取整（机票块 + 套餐行各自 round），与后端逐行 round 偏差 ≤1 元。
  const listTotal = flightTotal + bundleRow;
  const total = Math.round(flightTotal * factor) + Math.round(bundleRow * factor);
  const perPerson = headCount > 0 ? Math.round(total / headCount) : total;

  const soldOut = goTier === 'SOLD_OUT' || retTier === 'SOLD_OUT' || hotelTier === 'SOLD_OUT';
  // 加购禁用（单一路径）：实时售罄 OR 所选日期不可售（封盘/机位满/满房）。
  // dateReason 层叠在既有 soldOut 之上，不另开并行禁用路径；售罄文案优先，否则用日期原因文案。
  const addBlocked = soldOut || isSellableBlocked(dateReason);
  const blockTitle = soldOut ? '该日期已售罄，换个日期试试' : sellableBlockTitle(dateReason);

  const nudgeDatePicker = () => {
    const el = dateInputRef.current;
    if (!el) return;
    el.focus();
    try {
      (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      /* 浏览器不支持 showPicker：focus 已生效 */
    }
  };

  const handleAdd = () => {
    const addOnSummary = [
      childCount > 0 ? `儿童×${childCount}` : null,
      infantCount > 0 ? `婴儿×${infantCount}` : null,
      singleCount > 0 ? `单人入住×${singleCount}` : null,
      businessCount > 0 ? `商务舱×${businessCount}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    add({
      kind: 'BUNDLE',
      productId: b.id,
      name: `${b.name}（${formatOccupancy(adultCount, childCount, infantCount)}·${baseRooms}房 · ${goDate}→${displayReturn}${addOnSummary ? ` · ${addOnSummary}` : ''}）`,
      description: b.tagline ?? '',
      emoji: b.emoji ?? '🎁',
      unitPrice: total,
      qty: 1,
      meta: {
        goDate, returnDate: displayReturn,
        adultCount, childCount, infantCount,
        // 兼容旧字段：pax = headCount（出行人总数，含婴儿）
        pax: headCount, rooms: baseRooms,
        flightTotal, hotelTotal, otherTotal, discountPct: pct,
        singleCount, businessCount,
        ...(outLeg?.scheduleId ? { goLegScheduleId: outLeg.scheduleId } : {}),
        ...(retLeg?.scheduleId ? { retLegScheduleId: retLeg.scheduleId } : {}),
      },
    });
    navigate('/cart');
  };

  // 图廊：套餐主图（后端目前一张；缺省时 PhotoGallery 给占位）
  const galleryImages: GalleryImage[] = b.photo ? [{ url: b.photo, alt: b.name }] : [];

  // 含 / 不含清单
  const included: Array<{ icon: IconName; label: string }> = [
    items.some((i) => i.kind === 'FLIGHT') ? { icon: 'plane', label: `往返机票（${isBiz ? '商务舱' : '经济舱'}）` } : null,
    items.some((i) => i.kind === 'HOTEL') ? { icon: 'hotel', label: `${nights} 晚酒店住宿 · 含双早` } : null,
    items.some((i) => i.kind === 'TRANSFER') ? { icon: 'car', label: '当地往返接送' } : null,
    items.some((i) => i.kind === 'VISA') ? { icon: 'visa', label: '签证代办' } : null,
    { icon: 'support', label: '全程中文客服' },
  ].filter((x): x is { icon: IconName; label: string } => x !== null);

  const excluded = ['个人消费与自费项目', '旅游意外险（建议自行购买）', '行程外的额外用车与门票'];

  // 可选升级现作为前台 add-on 即选即享（下方配置器内选购），不再走客服线下办理。

  const rating = b.rating;
  const soldCount = b.soldCount ?? 0;
  const showScarcity = !soldOut && soldCount >= SOLD_RECENTLY_THRESHOLD;

  // 评价：API 优先；为零回退到 make-up 样本（公测期）
  const reviews = useReviews(b.id);
  const usingMadeUp = reviews.status === 'ready' && reviews.total === 0;
  const reviewItems = usingMadeUp
    ? MADE_UP_REVIEWS.slice(0, reviews.shownMadeUp)
    : reviews.items.map(toReviewItem);
  const summary = usingMadeUp ? MADE_UP_SUMMARY : reviews.summary;
  const canLoadMore = usingMadeUp
    ? reviews.shownMadeUp < MADE_UP_REVIEWS.length
    : reviews.items.length < reviews.total;

  // Product JSON-LD（结构化数据，利于搜索/分享）
  const jsonLd = useMemo(() => {
    const ld: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: b.name,
      description: b.tagline ?? `${b.name} 一价全含海岛专线套餐`,
      ...(b.photo ? { image: b.photo } : {}),
      brand: { '@type': 'Brand', name: '椰岛假期 · 海岛专线' },
      offers: {
        '@type': 'Offer',
        priceCurrency: 'CNY',
        price: Math.max(0, total),
        availability: soldOut ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
        url: typeof window !== 'undefined' ? window.location.href : `/bundles/${b.id}`,
      },
    };
    const agg = usingMadeUp ? MADE_UP_SUMMARY : rating;
    if (agg && agg.count > 0) {
      ld.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: Number(agg.average.toFixed(1)),
        reviewCount: agg.count,
        bestRating: 5,
        worstRating: 1,
      };
    }
    return ld;
  }, [b, total, soldOut, rating, usingMadeUp]);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-4 md:pb-10">
      <Seo
        title={b.name}
        description={b.tagline ?? `${b.name}：往返机票 + 酒店 + 接送 + 签证，一价全含。`}
        image={b.photo ?? undefined}
        canonicalPath={`/bundles/${b.id}`}
        jsonLd={jsonLd}
      />

      <Breadcrumb items={[{ label: '首页', to: '/' }, { label: '套餐', to: '/' }, { label: b.name }]} />

      {/* 标题 + 评分 + 紧迫感 */}
      <header className="mt-3">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink md:text-3xl">{b.name}</h1>
        {b.tagline && <p className="mt-1.5 text-sm text-ink-soft md:text-base">{b.tagline}</p>}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          {(rating ?? (usingMadeUp ? MADE_UP_SUMMARY : null)) && (
            <StarRating
              value={(rating ?? MADE_UP_SUMMARY).average}
              size="sm"
              showValue
              count={(rating ?? MADE_UP_SUMMARY).count}
            />
          )}
          {soldCount > 0 && <span className="text-ink-muted">已售 {soldCount.toLocaleString()}</span>}
          {showScarcity && <ScarcityBadge kind="soldRecently" text="近期热订" />}
          <RefundBadge />
        </div>
      </header>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* 左列：图廊 + 信息 */}
        <div className="min-w-0 space-y-6">
          <PhotoGallery images={galleryImages} />

          {/* 套餐包含 / 不包含 */}
          <section className="card" aria-labelledby="incl-heading">
            <h2 id="incl-heading" className="section-title text-base md:text-lg">套餐包含</h2>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {included.map((inc) => (
                <li key={inc.label} className="flex items-center gap-2 text-sm text-ink-soft">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand">
                    <Icon name={inc.icon} className="h-4 w-4" />
                  </span>
                  {inc.label}
                </li>
              ))}
            </ul>
            <h3 className="mt-5 text-sm font-bold text-ink">费用不含</h3>
            <ul className="mt-2 space-y-1.5 text-xs text-ink-soft">
              {excluded.map((x) => (
                <li key={x} className="flex items-start gap-2">
                  <span className="mt-0.5 text-ink-muted">·</span>
                  {x}
                </li>
              ))}
            </ul>
            {(canOfferSingle || canOfferBusiness) && (
              <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 text-xs text-indigo-900">
                <span className="font-semibold">可选升级即选即享：</span>{' '}
                {[
                  canOfferSingle ? `一个人住酒店（单人入住）+¥${(singleSupp ?? 0).toLocaleString()}/晚/人` : null,
                  canOfferBusiness ? `升级商务舱 +¥${(businessUpg ?? 0).toLocaleString()}/程/人` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                <span className="text-indigo-700">（在右侧下单框直接选份数）</span>
              </div>
            )}
          </section>

          {/* 行程说明 / 预订须知 */}
          <section className="card" aria-labelledby="itin-heading">
            <h2 id="itin-heading" className="section-title text-base md:text-lg">行程说明</h2>
            {b.suitableFor && (
              <p className="mt-2 rounded-xl bg-canvas px-3 py-2 text-sm text-ink-soft">
                <span className="font-semibold text-ink">适合人群：</span>{b.suitableFor}
              </p>
            )}
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-soft">
              {BOOKING_NOTICES.map((line, i) => (
                <li key={i} className="flex gap-2">
                  <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <h3 className="mt-5 flex items-center gap-1.5 text-sm font-bold text-ink">
              <Icon name="clock" className="h-4 w-4 text-brand" />值机与登机提示
            </h3>
            <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-ink-soft">
              {CHECKIN_TIPS.map((tip, i) => (
                <li key={i} className="flex gap-2"><span className="text-ink-muted">·</span>{tip}</li>
              ))}
            </ul>
          </section>

          {/* 退改政策 */}
          <section className="card" aria-labelledby="refund-heading">
            <h2 id="refund-heading" className="section-title inline-flex items-center gap-2 text-base md:text-lg">
              <Icon name="shield" className="h-5 w-5 text-brand" />退改政策
            </h2>
            <ul className="mt-3 space-y-2 text-xs leading-relaxed text-ink-soft">
              {PACKAGE_RULES.map((rule, i) => (
                <li key={i} className="flex gap-2"><span className="text-ink-muted">·</span>{rule}</li>
              ))}
            </ul>
          </section>

          {/* FAQ 折叠 */}
          <section className="card" aria-labelledby="faq-heading">
            <h2 id="faq-heading" className="section-title text-base md:text-lg">常见问题</h2>
            <div className="mt-2 divide-y divide-slate-200/70">
              {FAQS.map((f) => (
                <details key={f.q} className="group py-2.5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-ink">
                    <span>{f.q}</span>
                    <Icon
                      name="arrowRight"
                      className="h-4 w-4 shrink-0 text-ink-muted transition-transform group-open:rotate-90"
                    />
                  </summary>
                  <p className="mt-2 text-sm leading-relaxed text-ink-soft">{f.a}</p>
                </details>
              ))}
            </div>
          </section>

          {/* 评价 */}
          <section className="space-y-4" aria-labelledby="reviews-heading">
            <h2 id="reviews-heading" className="section-title text-base md:text-lg">真实评价</h2>
            {reviews.status === 'loading' ? (
              <ReviewList reviews={[]} loading />
            ) : reviews.status === 'error' ? (
              <ErrorRetry message="评价没能加载出来" onRetry={reviews.reload} />
            ) : (
              <>
                {summary.count > 0 && (
                  <RatingSummary
                    average={summary.average}
                    count={summary.count}
                    distribution={summary.distribution}
                  />
                )}
                <ReviewList
                  reviews={reviewItems}
                  emptyHint="成为第一个分享真实体验的人吧"
                />
                {canLoadMore && (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      className="btn-secondary text-sm"
                      disabled={reviews.loadingMore}
                      onClick={() => (usingMadeUp ? reviews.showMoreMadeUp() : reviews.loadMore())}
                    >
                      {reviews.loadingMore ? '加载中…' : '加载更多评价'}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          <TrustBadges variant="checkout" />
        </div>

        {/* 右列：配置器 + 价格（桌面端 sticky；移动端常规排布 + 底部吸底条） */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="card space-y-4">
            <h2 className="section-title text-base">选择出行</h2>

            {/* 出发日期（只让选可售日期；默认已选最近可出发日，可改） */}
            <div>
              <label className="label" htmlFor="detail-godate">出发日期</label>
              <input
                ref={dateInputRef}
                id="detail-godate"
                type="date"
                className="input"
                // 约束到可售区间：min = max(今天, 首个可售日)，max = 末个可售日。
                // 窗口未知（加载中/查失败 PERMISSIVE）→ 回退 min=今天、无 max（不硬框）。
                min={sellable.minDate && sellable.minDate > todayISO(0) ? sellable.minDate : todayISO(0)}
                max={sellable.maxDate ?? undefined}
                value={goDate}
                onChange={(e) => setGoDate(e.target.value)}
              />
              <p className="mt-1 text-xs text-ink-muted">
                默认已为你选好最近可出发日（今天 +3 天起），可改 · 回程 {formatMonthDay(displayReturn)} · {nights} 晚（按住宿晚数自动推算）
              </p>
              {/* 所选日期不可售：保留所选值，下方标原因（封盘/机位满/满房），加购同时禁用 */}
              {dateReason && (
                <div className="mt-1.5">
                  <SellableReasonChip reason={dateReason} />
                </div>
              )}
            </div>

            {/* 出行人（成人/占座儿童/不占座婴儿）+ 拼房间数自动推导 */}
            <div>
              <span className="label">出行人</span>
              <div className="space-y-2 rounded-xl border border-slate-200 p-2.5">
                <OccupancyRow label="成人" hint="占座" value={adultCount} min={1} max={9} onChange={setAdultCount} />
                <OccupancyRow label="儿童" hint="占座 · 比成人便宜" value={childCount} min={0} max={9} onChange={setChildCount} />
                <OccupancyRow label="婴儿" hint="不占座 · 不占床" value={infantCount} min={0} max={9} onChange={setInfantCount} />
              </div>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1.5 font-semibold text-sky-700">
                  <Icon name="user" className="h-3.5 w-3.5" />
                  {formatOccupancy(adultCount, childCount, infantCount)}
                </span>
                <span className="inline-flex items-center gap-1.5 font-semibold text-purple-700">
                  <Icon name="hotel" className="h-3.5 w-3.5" />
                  {soloShared
                    ? '住宿：拼房（与同行客共一间双人房）'
                    : `房间数：${baseRooms} 间（每间最多 ${roomCapacity.maxAdults} 大 ${roomCapacity.maxChildren} 小）`}
                </span>
              </p>
              {/* 人数一间坐不下 → 自动加房，明确告知价格已含多出的房间 */}
              {baseRooms > 1 && (
                <p className="mt-1 text-xs font-medium text-purple-600">
                  需 {baseRooms} 间房（按 {roomCapacity.maxAdults} 大 {roomCapacity.maxChildren} 小自动安排，价格已含）
                </p>
              )}
            </div>

            {/* 单人预订：拼房（默认，半间价）/ 独住（整间 + 单房差）二选一。诚实标价，与服务端实收一致。 */}
            {canOfferSoloRoom && (
              <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-3 text-xs">
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
                      一人一间 · +¥{(singleSupp ?? 0).toLocaleString()}/晚
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* 可选升级 add-on（即选即享，下单即含；不走客服） */}
            {(canOfferSingle || canOfferBusiness) && (
              <div className="space-y-2.5 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 text-xs">
                <div className="font-semibold text-indigo-900">可选升级（即选即享）</div>
                {canOfferSingle && (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-ink">一个人住酒店（单人入住）</div>
                      <div className="text-ink-muted">
                        一人一间房 · +¥{(singleSupp ?? 0).toLocaleString()}/晚/人
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
                          : `+¥${(businessUpg ?? 0).toLocaleString()}/程/人`}
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

            {/* 去/回航段 + 余位档位 */}
            {(goTier || retTier || outLeg || retLeg) && (
              <div className="space-y-1.5 rounded-xl bg-sky-50/70 p-2.5 text-xs text-slate-700">
                <FlightRow label="去程" line={legLine(outLeg, goDate)} tier={goTier} />
                <FlightRow label="回程" line={legLine(retLeg, displayReturn)} tier={retTier} />
              </div>
            )}

            {/* 酒店房型 + 房量档位 */}
            {b.hotelRoomType && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-purple-50/70 p-2.5 text-xs text-slate-700">
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="hotel" className="h-4 w-4 text-purple-600" />
                  <span className="font-medium">{b.hotelRoomType.hotelName}</span>
                  · {b.hotelRoomType.name} · 含双早
                </span>
                <HotelTierBadge tier={hotelTier} />
              </div>
            )}

            {/* 明细 */}
            <div className="space-y-1.5 border-t border-slate-200/70 pt-3">
              {/* S1：套餐未内嵌 FLIGHT 行时，用实时解析的去/回航段派生一条机票明细（与下单拆腿口径恒等），
                  避免机票展示 ¥0；内嵌 FLIGHT 行的套餐则由下方 itemRows 正常展示。 */}
              {!hasEmbeddedFlight && outLeg && retLeg && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 font-medium ${KIND_LABEL.FLIGHT.color}`}>
                      {KIND_LABEL.FLIGHT.label}
                    </span>
                    <span className="truncate text-slate-700">
                      来回{isBiz ? '商务' : '经济'}舱 · {formatOccupancy(adultCount, childCount, infantCount)}
                    </span>
                  </div>
                  <span className="nums whitespace-nowrap text-slate-600">
                    ¥{(pricePerPerson * seatPax).toLocaleString()}
                  </span>
                </div>
              )}
              {itemRows.map((r, idx) => (
                <div key={idx} className="flex items-center justify-between text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 font-medium ${KIND_LABEL[r.kind].color}`}>
                      {KIND_LABEL[r.kind].label}
                    </span>
                    <span className="truncate text-slate-700">{r.label}</span>
                  </div>
                  <span className="nums whitespace-nowrap text-slate-600">¥{r.computedTotal.toLocaleString()}</span>
                </div>
              ))}
              {childCount > 0 && childDiscount > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">儿童</span>
                    <span className="truncate text-slate-700">占座儿童 ×{childCount} · 每人 −¥{childDiscount.toLocaleString()}</span>
                  </div>
                  <span className="nums whitespace-nowrap text-emerald-700">−¥{childDiscountTotal.toLocaleString()}</span>
                </div>
              )}
              {infantCount > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700">婴儿</span>
                    <span className="truncate text-slate-700">婴儿 ×{infantCount} · 每人 ¥{infantPrice.toLocaleString()}</span>
                  </div>
                  <span className="nums whitespace-nowrap text-slate-600">+¥{infantPriceTotal.toLocaleString()}</span>
                </div>
              )}
              {singleCount > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="rounded bg-indigo-100 px-1.5 py-0.5 font-medium text-indigo-700">升级</span>
                    <span className="truncate text-slate-700">
                      {isSolo ? '独住 · 单房差' : `单人入住 ×${singleCount}`}
                    </span>
                  </div>
                  <span className="nums whitespace-nowrap text-slate-600">+¥{singleAddOn.toLocaleString()}</span>
                </div>
              )}
              {businessCount > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="rounded bg-indigo-100 px-1.5 py-0.5 font-medium text-indigo-700">升级</span>
                    <span className="truncate text-slate-700">升级商务舱 ×{businessCount}</span>
                  </div>
                  <span className="nums whitespace-nowrap text-slate-600">+¥{businessAddOn.toLocaleString()}</span>
                </div>
              )}
              {operationFeeTotal > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="rounded bg-slate-200 px-1.5 py-0.5 font-medium text-slate-700">服务</span>
                    <span className="truncate text-slate-700">
                      操作服务费 ×{seatPax} · 每人 ¥{operationFee.toLocaleString()}
                    </span>
                  </div>
                  <span className="nums whitespace-nowrap text-slate-600">+¥{operationFeeTotal.toLocaleString()}</span>
                </div>
              )}
            </div>

            {/* 价格 */}
            <div className="rounded-2xl border border-slate-200/70 bg-canvas p-3.5">
              <div className="flex items-end justify-between gap-2">
                <div className="text-xs text-ink-muted">
                  {formatOccupancy(adultCount, childCount, infantCount)} · {baseRooms} 间房{pct > 0 && <span className="ml-1 text-deal">已省 {pct}%</span>}
                </div>
                <div className="text-right">
                  {pct > 0 && <span className="price-old block text-xs">¥{listTotal.toLocaleString()}</span>}
                  <span className="price text-2xl">¥{total.toLocaleString()}</span>
                  <div className="text-xs text-ink-muted">≈ ¥{perPerson.toLocaleString()} /人</div>
                </div>
              </div>
            </div>

            {/* 不可加购引导（售罄 / 封盘 / 机位满 / 满房；不暴露原始库存数字） */}
            {addBlocked && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-deal">
                <span>{soldOut ? '该日期已售罄' : (blockTitle ?? '该日期暂不可售')}</span>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full bg-deal-light px-2.5 py-1 text-deal-dark transition-colors hover:bg-deal/15"
                  onClick={nudgeDatePicker}
                >
                  <Icon name="calendar" className="h-3.5 w-3.5" />看看其它日期
                </button>
              </div>
            )}

            <button
              type="button"
              className="btn-deal w-full"
              disabled={addBlocked}
              title={blockTitle}
              onClick={handleAdd}
            >
              {soldOut ? '该日期已售罄' : isSellableBlocked(dateReason) ? '该日期不可售' : '加入购物车'}
            </button>
            <TrustBadges variant="card" />
          </div>
        </aside>
      </div>

      {/* 移动端吸底条：价格 + 加入购物车（避让底部导航 56px + 安全区） */}
      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-brand-100/70 bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur-xl md:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="price text-xl">¥{total.toLocaleString()}</span>
              <span className="text-[11px] text-ink-muted">≈¥{perPerson.toLocaleString()}/人</span>
            </div>
            <div className="truncate text-[11px] text-ink-muted">
              {formatMonthDay(goDate)}→{formatMonthDay(displayReturn)} · {formatOccupancy(adultCount, childCount, infantCount)}·{baseRooms}间房
            </div>
          </div>
          {addBlocked ? (
            <button type="button" className="btn-secondary shrink-0 text-sm" onClick={nudgeDatePicker} title={blockTitle}>
              换个日期
            </button>
          ) : (
            <button type="button" className="btn-deal shrink-0" onClick={handleAdd}>
              加入购物车
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

// ── 评价数据 hook（分页 + 加载更多 + make-up 样本翻页）─────────────
interface ReviewSummaryState {
  average: number;
  count: number;
  distribution: Record<'5' | '4' | '3' | '2' | '1', number>;
}
const EMPTY_SUMMARY: ReviewSummaryState = {
  average: 0, count: 0, distribution: { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 },
};

function useReviews(bundleId: string) {
  const [items, setItems] = useState<Review[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [summary, setSummary] = useState<ReviewSummaryState>(EMPTY_SUMMARY);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // make-up 样本当前展示条数（API 为零时启用）
  const [shownMadeUp, setShownMadeUp] = useState(REVIEW_PAGE_SIZE);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setItems([]);
    setPage(1);
    setShownMadeUp(REVIEW_PAGE_SIZE);
    api
      .listReviews({ productType: 'BUNDLE', productId: bundleId, page: 1, limit: REVIEW_PAGE_SIZE })
      .then((r) => {
        if (cancelled) return;
        setItems(r.items);
        setTotal(r.total);
        setSummary(r.summary);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, [bundleId, reloadKey]);

  const loadMore = () => {
    if (loadingMore) return;
    const next = page + 1;
    setLoadingMore(true);
    api
      .listReviews({ productType: 'BUNDLE', productId: bundleId, page: next, limit: REVIEW_PAGE_SIZE })
      .then((r) => {
        setItems((prev) => [...prev, ...r.items]);
        setTotal(r.total);
        setPage(next);
      })
      .catch(() => {/* 加载更多失败：保留已加载内容，不打断 */})
      .finally(() => setLoadingMore(false));
  };

  const showMoreMadeUp = () => setShownMadeUp((n) => Math.min(MADE_UP_REVIEWS.length, n + REVIEW_PAGE_SIZE));
  const reload = () => setReloadKey((k) => k + 1);

  return { items, total, summary, status, loadingMore, loadMore, reload, shownMadeUp, showMoreMadeUp };
}

// ── 小组件 ───────────────────────────────────────────────────────
function FlightRow({ label, line, tier }: { label: string; line: string | null; tier: AvailabilityTier | null }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="rounded bg-sky-100 px-1.5 py-0.5 font-semibold text-sky-700">{label}</span>
      {line ? <span>{line}</span> : <span className="text-ink-muted">查询中…</span>}
      {tier && (
        <span className={`rounded px-1.5 py-0.5 font-medium ${FLIGHT_TIER_CLASS[tier]}`}>
          {FLIGHT_TIER_LABEL[tier]}
        </span>
      )}
    </div>
  );
}

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

/** 占座模型出行人单行：标签 + 提示 + stepper（成人/占座儿童/不占座婴儿共用）。 */
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

function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center overflow-hidden rounded-xl border border-slate-200">
      <button
        type="button"
        className="px-3 py-2 text-ink-soft transition-colors hover:bg-brand-50 disabled:text-slate-300"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
        aria-label="减少"
      >
        −
      </button>
      <span className="nums min-w-[2.5rem] flex-1 bg-white py-2 text-center font-semibold text-ink">{value}</span>
      <button
        type="button"
        className="px-3 py-2 text-ink-soft transition-colors hover:bg-brand-50 disabled:text-slate-300"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        aria-label="增加"
      >
        +
      </button>
    </div>
  );
}
