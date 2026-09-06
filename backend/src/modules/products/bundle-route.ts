/**
 * 套餐航线派生 —— 全站唯一入口。
 *
 * 背景：系统最初只有一条航线（澳门 MFM ⇌ 岘港 DAD），可售日期 / 录单 / 结算价 / 随机档
 * 各自把这条线写死。开第二条线起，凡是「按航线取数」的地方一律从套餐绑定的航班派生，
 * 不再各写一份常量，也**不回落到旧航线**：没绑航班的套餐 = 没有航线 = 不可售 / 不取日历价。
 *
 * routeKey 形如 `MFM-DAD`（去程 起点-终点，大写 IATA）。存量数据迁移回填用 LEGACY_ROUTE_KEY。
 */

/** 存量数据默认航线（仅迁移回填 / 兼容老数据用，业务代码不要拿它当兜底）。 */
export const LEGACY_ROUTE_KEY = 'MFM-DAD';

export interface BundleRoute {
  /** 去程出发机场 IATA */
  origin: string;
  /** 去程到达机场 IATA（= 目的地城市所在机场） */
  destination: string;
  /** `${origin}-${destination}` */
  routeKey: string;
}

/** 只需要航班上的两个字段，方便 select 最小集。 */
export interface RouteFlightLike {
  originCode: string | null;
  destinationCode: string | null;
}

export interface RouteBundleLike {
  outboundFlight?: RouteFlightLike | null;
  returnFlight?: RouteFlightLike | null;
}

export function routeKeyOf(origin: string, destination: string): string {
  return `${origin.trim().toUpperCase()}-${destination.trim().toUpperCase()}`;
}

/** `MFM-DAD` → { origin, destination }；格式不对返回 null。 */
export function parseRouteKey(key: string | null | undefined): Omit<BundleRoute, 'routeKey'> | null {
  if (!key) return null;
  const m = /^([A-Z0-9]{3})-([A-Z0-9]{3})$/.exec(key.trim().toUpperCase());
  if (!m) return null;
  return { origin: m[1], destination: m[2] };
}

/**
 * 从套餐绑定的航班派生航线。优先去程航班；只绑了回程时按回程反推；都没绑返回 null。
 * 调用方拿到 null 应视为「该套餐没有航线」，按各自口径拒售 / 不取价 / 不聚合，不要自行兜底。
 */
export function resolveBundleRoute(bundle: RouteBundleLike): BundleRoute | null {
  const ob = bundle.outboundFlight;
  if (ob?.originCode && ob?.destinationCode) {
    return {
      origin: ob.originCode.toUpperCase(),
      destination: ob.destinationCode.toUpperCase(),
      routeKey: routeKeyOf(ob.originCode, ob.destinationCode),
    };
  }
  const rt = bundle.returnFlight;
  if (rt?.originCode && rt?.destinationCode) {
    return {
      origin: rt.destinationCode.toUpperCase(),
      destination: rt.originCode.toUpperCase(),
      routeKey: routeKeyOf(rt.destinationCode, rt.originCode),
    };
  }
  return null;
}

export function bundleRouteKey(bundle: RouteBundleLike): string | null {
  return resolveBundleRoute(bundle)?.routeKey ?? null;
}

/** Prisma include/select 片段：派生航线所需的最小字段。 */
export const BUNDLE_ROUTE_SELECT = {
  outboundFlight: { select: { originCode: true, destinationCode: true } },
  returnFlight: { select: { originCode: true, destinationCode: true } },
} as const;
