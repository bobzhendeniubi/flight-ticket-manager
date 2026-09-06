/**
 * 套餐航线派生 —— 唯一入口。
 *
 * 背景：公司第二条航线在即（直飞，目的地未定）。此前全站把「澳门 ⇌ 岘港」当常量写死
 * （后端可售日期 / 起价兜底、前台套餐页、后台录单弹窗），新航线一开这些地方全会算错——
 * 会拿另一条航线的余位判断可售、拿另一条航线的票价当起价。
 *
 * 新口径：**套餐的航线 = 套餐绑定航班的航线**（模板绑法：Bundle.outboundFlightId /
 * returnFlightId 绑的是航班号 Flight，Flight 自带 originCode/destinationCode）。
 *   · 绑了去程 → 航线 = 去程航班的 origin→destination（去程优先，唯一权威）；
 *   · 只绑了回程 → 按回程反推（回程 destination→origin 即去程方向）；
 *   · 两段都没绑 → **null**。
 *
 * **null 绝不兜底到老航线**：没绑航班 = 没航线 = 不可售。可售日期一律 sellable=false
 * （reason='NO_FLIGHT_BOUND'），起价里机票项按「无可估班次」处理。之所以硬性不兜底：
 * 兜底就意味着新航线的套餐会静默按老航线算库存和价钱，错得毫无痕迹；宁可显式不可售，
 * 让运营去把航班绑上。
 *
 * routeKey（'MFM-DAD' 形状）只做**分桶 / 缓存键**用途（例如按航线去重批量查余位、
 * 机票参考价缓存分键），不参与业务判断——业务一律读 origin/destination。
 */

/** 老航线（澳门 ⇌ 岘港）的 routeKey。仅供迁移期比对 / 日志识别，**不作为任何兜底值**。 */
export const LEGACY_ROUTE_KEY = 'MFM-DAD';

/** 一条套餐航线：去程方向的 origin→destination（回程即反向）。 */
export interface BundleRoute {
  origin: string;
  destination: string;
  /** `${origin}-${destination}`，仅做分桶 / 缓存键。 */
  routeKey: string;
}

/** 航线派生只需要航班的起降地（Prisma select 出来的最小形状）。 */
export interface RouteFlightLike {
  originCode: string | null;
  destinationCode: string | null;
}

/** 航线派生只需要套餐绑定的去 / 回程航班（未绑 = null / 省略）。 */
export interface RouteBundleLike {
  outboundFlight?: RouteFlightLike | null;
  returnFlight?: RouteFlightLike | null;
}

/** 机场码规范化：去空白 + 大写；非字符串 / 空串 → null。 */
function normalizeCode(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** `${origin}-${destination}`（分桶 / 缓存键）。 */
export function routeKeyOf(origin: string, destination: string): string {
  return `${origin}-${destination}`;
}

/** routeKey → { origin, destination }；形状不对（缺段 / 空段）→ null。 */
export function parseRouteKey(
  key: string | null | undefined,
): { origin: string; destination: string } | null {
  if (typeof key !== 'string') return null;
  const parts = key.split('-');
  if (parts.length !== 2) return null;
  const origin = normalizeCode(parts[0]);
  const destination = normalizeCode(parts[1]);
  if (!origin || !destination) return null;
  return { origin, destination };
}

function makeRoute(origin: string, destination: string): BundleRoute {
  return { origin, destination, routeKey: routeKeyOf(origin, destination) };
}

/**
 * 套餐航线（去程方向）。去程绑定优先；只绑回程时按回程反推；都没绑 → null（= 不可售，不兜底）。
 * 绑了航班但起降地缺失（脏数据）同样按未绑处理，绝不半途拼出一条假航线。
 */
export function resolveBundleRoute(bundle: RouteBundleLike): BundleRoute | null {
  const outOrigin = normalizeCode(bundle.outboundFlight?.originCode);
  const outDest = normalizeCode(bundle.outboundFlight?.destinationCode);
  if (outOrigin && outDest) return makeRoute(outOrigin, outDest);

  // 只绑回程：回程是 destination→origin，反推去程方向。
  const retOrigin = normalizeCode(bundle.returnFlight?.originCode);
  const retDest = normalizeCode(bundle.returnFlight?.destinationCode);
  if (retOrigin && retDest) return makeRoute(retDest, retOrigin);

  return null;
}

/** 套餐航线的 routeKey（分桶 / 缓存键）；没绑航班 → null。 */
export function bundleRouteKey(bundle: RouteBundleLike): string | null {
  return resolveBundleRoute(bundle)?.routeKey ?? null;
}

/**
 * Prisma select 片段：任何需要派生航线的套餐查询都带上它（去 / 回程各只取起降地）。
 * 与 products.service 的 BUNDLE_ROOM_INCLUDE 兼容——那边 select 更宽（含航班号），
 * 结构上仍满足 RouteBundleLike。
 */
export const BUNDLE_ROUTE_SELECT = {
  outboundFlight: { select: { originCode: true, destinationCode: true } },
  returnFlight: { select: { originCode: true, destinationCode: true } },
} as const;
