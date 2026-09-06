/**
 * 套餐航线派生（前台）—— 镜像后端 backend/src/modules/products/bundle-route.ts 的口径。
 *
 * 套餐的航线 = 套餐绑定航班的航线：公开套餐 API 已把去/回程航班的 originCode/destinationCode
 * 一起返回（见 lib/api.ts 的 ApiBundle.outboundFlight / returnFlight）。
 *   · 绑了去程 → 航线 = 去程航班的 origin→destination；
 *   · 只绑了回程 → 按回程反推（回程 destination→origin 即去程方向）；
 *   · 两段都没绑 → null。
 *
 * null **绝不兜底到某条写死航线**：没航线的套餐查不了航段余位，服务端也会把整段可售日期判成
 * 不可售（reason='NO_FLIGHT_BOUND'）。公司第二条航线在即，兜底就意味着新航线的套餐会静默
 * 按老航线查余位、显示老航线的票价。
 */

export interface BundleRouteFlightLike {
  originCode?: string | null;
  destinationCode?: string | null;
}

export interface BundleRouteBundleLike {
  outboundFlight?: BundleRouteFlightLike | null;
  returnFlight?: BundleRouteFlightLike | null;
}

export interface BundleRoute {
  origin: string;
  destination: string;
}

function normalizeCode(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** 套餐航线（去程方向）；去程绑定优先，只绑回程按回程反推，都没绑 → null。 */
export function resolveBundleRoute(bundle: BundleRouteBundleLike): BundleRoute | null {
  const outOrigin = normalizeCode(bundle.outboundFlight?.originCode);
  const outDest = normalizeCode(bundle.outboundFlight?.destinationCode);
  if (outOrigin && outDest) return { origin: outOrigin, destination: outDest };

  const retOrigin = normalizeCode(bundle.returnFlight?.originCode);
  const retDest = normalizeCode(bundle.returnFlight?.destinationCode);
  if (retOrigin && retDest) return { origin: retDest, destination: retOrigin };

  return null;
}
