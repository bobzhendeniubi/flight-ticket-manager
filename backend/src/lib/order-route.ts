/**
 * 订单的航线 —— 报表 / 概览 / 导出按航线分账的唯一派生口径。
 *
 * 第二条航线在即，而经营报表只有 产品线 / 渠道 / 代理 三个维度，财务概览与月度也没有航线筛选：
 * 两条线的收入成本混在一个数里，「哪条线赚钱」谁也答不上来。这里给出订单 → 航线的单一派生。
 *
 * ## 派生规则（去程方向，与套餐航线同一个约定）
 * 1. 本单最早起飞的那条机票航段 → 该航段航班的 `origin → destination`。
 *    往返单取最早的一条 = 去程，方向天然与套餐航线一致（回程那条是反的，不能拿来当航线）。
 * 2. 没有机票航段（纯地面套餐单）→ 退到套餐绑定的航班，走 `resolveBundleRoute`
 *    （products/bundle-route.ts 是航线派生的唯一入口，这里只是复用它，不另写一套）。
 * 3. 两条都推不出来 → `null`，报表里归「未知航线」这一桶。
 *
 * **不兜底到任何写死的航线**：口径与 bundle-route.ts 一致 —— 兜底就意味着新航线的单会静默
 * 算进老航线，错得毫无痕迹。宁可如实归「未知航线」，让运营看见有多少单还没绑航班。
 */
import {
  resolveBundleRoute,
  routeKeyOf,
  type RouteBundleLike,
} from '../modules/products/bundle-route.js';

/** 「未知航线」这一桶的键与展示名（推不出航线的单归这里）。 */
export const UNKNOWN_ROUTE_KEY = 'unknown';
export const UNKNOWN_ROUTE_LABEL = '未知航线';

/** 派生航线需要的订单行最小形状（Prisma select 出来的样子）。 */
export interface RouteOrderItemLike {
  flightSchedule?: {
    departureTime: Date;
    flight: { originCode: string | null; destinationCode: string | null } | null;
  } | null;
  bundle?: RouteBundleLike | null;
}

/**
 * Prisma select 片段：任何要按航线分桶的订单查询都带上它。
 * 机票航段取航班起降地 + 出发时刻（选最早那条 = 去程）；套餐取绑定航班的起降地。
 */
export const ORDER_ROUTE_ITEM_SELECT = {
  flightSchedule: {
    select: {
      departureTime: true,
      flight: { select: { originCode: true, destinationCode: true } },
    },
  },
  bundle: {
    select: {
      outboundFlight: { select: { originCode: true, destinationCode: true } },
      returnFlight: { select: { originCode: true, destinationCode: true } },
    },
  },
} as const;

function normalizeCode(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 一张订单的航线 routeKey（'MFM-DAD' 形状）；推不出来 → null。
 * 规则见文件头：最早起飞的机票航段优先，其次套餐绑定航班，两者都没有 → null。
 */
export function resolveOrderRouteKey(items: ReadonlyArray<RouteOrderItemLike>): string | null {
  let earliest: { at: number; origin: string; destination: string } | null = null;
  for (const it of items) {
    const sched = it.flightSchedule;
    if (!sched?.flight) continue;
    const origin = normalizeCode(sched.flight.originCode);
    const destination = normalizeCode(sched.flight.destinationCode);
    // 起降地缺失的脏航班按「没有航线」处理，绝不半途拼出一条假航线（口径同 bundle-route）。
    if (!origin || !destination) continue;
    const at = sched.departureTime.getTime();
    if (earliest == null || at < earliest.at) earliest = { at, origin, destination };
  }
  if (earliest) return routeKeyOf(earliest.origin, earliest.destination);

  for (const it of items) {
    if (!it.bundle) continue;
    const route = resolveBundleRoute(it.bundle);
    if (route) return route.routeKey;
  }
  return null;
}

/** 航线桶键：推不出航线的单归 `UNKNOWN_ROUTE_KEY`（报表要有这一桶，不能把这些单丢掉）。 */
export function orderRouteBucketKey(items: ReadonlyArray<RouteOrderItemLike>): string {
  return resolveOrderRouteKey(items) ?? UNKNOWN_ROUTE_KEY;
}

/** 航线展示名：'MFM-DAD' → 'MFM→DAD'；未知桶 → 「未知航线」。 */
export function routeKeyLabel(routeKey: string): string {
  if (routeKey === UNKNOWN_ROUTE_KEY) return UNKNOWN_ROUTE_LABEL;
  const parts = routeKey.split('-');
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[0]}→${parts[1]}` : routeKey;
}

/**
 * 该单是否落在筛选的航线上。
 * `routeKey` 传 `UNKNOWN_ROUTE_KEY` = 只看推不出航线的单（运营据此去补绑航班）。
 */
export function orderMatchesRoute(
  items: ReadonlyArray<RouteOrderItemLike>,
  routeKey: string,
): boolean {
  return orderRouteBucketKey(items) === routeKey;
}
