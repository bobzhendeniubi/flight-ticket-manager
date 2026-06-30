/**
 * 套餐「整个全包价 percent off」定价辅助。
 *
 * 套餐折扣 = 整个全包价 ×(1 − discountPct/100)，机票随出发日实时浮动（见 orders.service BUNDLE/FLIGHT 折扣后处理）。
 * 运营在后台「想卖的价格」录入需要一个「原价」锚点来反推 discountPct，原价 = 地面合计 + 当前最低来回机票×人数。
 * 这里只提供「当前最低来回经济舱机票/人」（按现有航班阶梯/底价的最便宜一档估算，带内存缓存），
 * 由 serializeBundle 组装成每个套餐的 originalAllInCny。估算值仅用于后台把目标价换算成折扣%与展示，
 * 不参与买家实际计价（买家价始终用存好的 discountPct × 实时全包）。
 */
import { prisma } from '../../db/prisma.js';
import { parseFareBuckets } from '../pricing/pricing.schemas.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { value: number | null; at: number } | null = null;

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

/**
 * 套餐「原价」(CNY，含当前最低来回机票)。= 地面合计 + 来回机票/人 × flightPax。
 * 地面合计 = 非 FLIGHT 行项 Σ(unitPrice×qty)（参考口径：1 间房，与 admin 录入参考一致）。
 * flightRefRoundTripCny 为 null（无可估机票）→ 仅返回地面合计。
 */
export function computeBundleOriginalAllInCny(
  items: ReadonlyArray<{ kind: string; qty: number; unitPrice: number }>,
  flightPax: number,
  flightRefRoundTripCny: number | null,
): number {
  const groundTotal = items
    .filter((i) => i.kind !== 'FLIGHT')
    .reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const flightTotal = flightRefRoundTripCny == null ? 0 : flightRefRoundTripCny * Math.max(1, flightPax);
  return Math.round(groundTotal + flightTotal);
}
