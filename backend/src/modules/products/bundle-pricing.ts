/**
 * 套餐「整个全包价 percent off」定价辅助。
 *
 * 套餐折扣 = 整个全包价 ×(1 − discountPct/100)，机票随出发日实时浮动（见 orders.service BUNDLE/FLIGHT 折扣后处理）。
 * 运营在后台「想卖的价格」录入需要一个「原价」锚点来反推 discountPct，原价 = 地面合计 + 当前最低来回机票×人数。
 * 这里只提供「当前最低来回经济舱机票/人」（按现有航班阶梯/底价的最便宜一档估算，带内存缓存），
 * 由 serializeBundle 组装成每个套餐的 originalAllInCny。估算值仅用于后台把目标价换算成折扣%与展示，
 * 不参与买家实际计价（买家价始终用存好的 discountPct × 实时全包）。
 *
 * 「起价 / 人」(originalPerPaxCny) 是另一条独立口径（与 originalAllInCny 的整包/flightPax 均分不同）：
 * 起价 = 1 人 · 半间房（拼房 twin-share），与下单时「1 成人独自报套餐 → 只收半间床位价」的
 * server-authoritative 口径（见 orders.service computeBundleRoomsCharged）完全对应——起价就是把
 * 那个下单场景的价格摆到套餐卡片上。单独入住是加购项（singleSupplementCnyPerNight/晚），不计入起价。
 */
import { prisma } from '../../db/prisma.js';
import { parseFareBuckets } from '../pricing/pricing.schemas.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { value: number | null; at: number } | null = null;

/** 套餐组件行的最小形状（items JSON 单元素）；unitPrice 落库前已由服务端按产品定价覆盖。 */
export interface BundleItemPriceInput {
  kind: string;
  qty: number;
  unitPrice: number;
}

/**
 * 当前「最低来回经济舱机票 / 人」(CNY)。
 * 取所有未来经济舱仓位里最便宜的一档（有阶梯用 fareBuckets[0].price，否则 basePrice），×2 估来回。
 * 查不到任何未来经济舱班次 → null（套餐原价退化为仅地面）。带 5 分钟内存缓存（单航线、低频变化）。
 */
export async function getCheapestRoundTripEconomyCny(now: Date): Promise<number | null> {
  if (cache && now.getTime() - cache.at < CACHE_TTL_MS) return cache.value;
  const seatClasses = await prisma.flightSeatClass.findMany({
    where: { cabin: 'ECONOMY', schedule: { departureTime: { gte: now } } },
    select: { basePrice: true, fareBuckets: true },
  });
  let minOneWay: number | null = null;
  for (const sc of seatClasses) {
    const buckets = parseFareBuckets(sc.fareBuckets);
    const cheapest = buckets && buckets.length > 0 ? Number(buckets[0].price) : Number(sc.basePrice);
    if (Number.isFinite(cheapest) && (minOneWay == null || cheapest < minOneWay)) minOneWay = cheapest;
  }
  const value = minOneWay == null ? null : Math.round(minOneWay * 2);
  cache = { value, at: now.getTime() };
  return value;
}

/** items 非数组等畸形形状时安全兜底为 []（防御 DB 里少数历史脏行，不让整页列表因一条坏数据 500）。 */
function safeItems(items: unknown): ReadonlyArray<BundleItemPriceInput> {
  return Array.isArray(items) ? (items as BundleItemPriceInput[]) : [];
}

/**
 * 套餐「原价」(CNY，含当前最低来回机票)。= 地面合计（按 1 间房参考口径） + 来回机票/人 × flightPax。
 * 地面合计 = 非 FLIGHT 行项 Σ(unitPrice×qty)（参考口径：1 间房，与 admin 录入参考一致）。
 * flightRefRoundTripCny 为 null（无可估机票）→ 仅返回地面合计。
 *
 * 注意：这是「整包原价」锚点，供 admin-web 反推「机票/人」等展示用途（现状不变，未随本次
 * 起价改版调整——改的是下面新增的 originalPerPaxCny，两者是两条独立口径，互不派生）。
 */
export function computeBundleOriginalAllInCny(
  items: ReadonlyArray<BundleItemPriceInput>,
  flightPax: number,
  flightRefRoundTripCny: number | null,
): number {
  const groundTotal = safeItems(items)
    .filter((i) => i.kind !== 'FLIGHT')
    .reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const flightTotal = flightRefRoundTripCny == null ? 0 : flightRefRoundTripCny * Math.max(1, flightPax);
  return Math.round(groundTotal + flightTotal);
}

/**
 * 套餐「起价 / 人」(CNY) —— 唯一权威口径，1 人 · 半间房（拼房 twin-share）：
 *
 *   originalPerPaxCny = flightRoundTripPerPax + 0.5 × hotelNightly × nights + transferTotal + visaPerPax
 *
 *   flightRoundTripPerPax = 当前最低来回经济舱机票/人（getCheapestRoundTripEconomyCny，无可估机票 → 0）
 *   hotelNightly          = 关联酒店房型的整间夜价（HotelRoomType.basePrice，服务端权威取价，非半价）
 *   nights                = resolveBundleNights(items, hotelNights) 解析的住宿晚数
 *   transferTotal         = items 里所有 TRANSFER 组件 Σ(qty×unitPrice)（接送通常整车计价，不按人头拆分）
 *   visaPerPax             = items 里所有 VISA 组件 Σ(unitPrice)（每个签证组件按「1 人」的单价相加，
 *                             忽略 qty —— qty 在 VISA 行里历史上表达的是人数，起价只为 1 人定价）
 *
 * 与下单时「1 成人独自报套餐、绑了套餐房型、不独住 → 只收半间床位价」完全对应
 * （orders.service computeBundleRoomsCharged 的 isSoloSharing 分支），起价就是把该下单结果摆上卡片。
 * 无关联房型（hotelRoomTypeNightlyCny=null）→ 该项按 0 计（起价退化为无住宿口径，不影响其余各项）。
 */
export function computeBundleOriginalPerPaxCny(params: {
  items: ReadonlyArray<BundleItemPriceInput>;
  nights: number;
  hotelRoomTypeNightlyCny: number | null;
  flightRoundTripPerPaxCny: number | null;
}): number {
  const { items, nights, hotelRoomTypeNightlyCny, flightRoundTripPerPaxCny } = params;
  const safe = safeItems(items);
  const transferTotal = safe
    .filter((i) => i.kind === 'TRANSFER')
    .reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const visaPerPax = safe.filter((i) => i.kind === 'VISA').reduce((s, i) => s + i.unitPrice, 0);
  const hotelHalfShareTotal = hotelRoomTypeNightlyCny == null ? 0 : 0.5 * hotelRoomTypeNightlyCny * nights;
  const flightPerPax = flightRoundTripPerPaxCny ?? 0;
  return Math.round(flightPerPax + hotelHalfShareTotal + transferTotal + visaPerPax);
}
