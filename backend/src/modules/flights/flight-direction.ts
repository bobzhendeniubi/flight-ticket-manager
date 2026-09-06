/**
 * 航班去 / 回程判定 —— 唯一入口。
 *
 * 背景：航班表本身不分去回程（同一条线的去程 / 回程是两条 Flight 行），此前座位统计页
 * 拿「起飞地 = 澳门」当去程写死。第二条航线一开，写死的判定会把新线的去程当回程画。
 *
 * 口径：**方向由活跃航线表决定**。航线表里的 routeKey 一律是「去程方向」的 `起飞-到达`
 *（见 modules/products/bundle-route.ts）：
 *   · 结算价日历 SettlementRate.routeKey —— 运营维护，去程方向；
 *   · 立减规则 SettlementDiscountRule.routeKey —— 同上；
 *   · 活跃套餐绑定航班派生的航线（去程优先，只绑回程时反推）。
 *
 * 于是对某个航班 origin→destination：
 *   · `origin-destination` 命中航线表 → 去程 OUTBOUND；
 *   · `destination-origin` 命中航线表 → 回程 RETURN；
 *   · 都不命中（纯机票新线、还没建套餐也没备价） → UNKNOWN，**不猜**。
 *
 * 两边同时命中（有人把一条线两个方向都当去程备过价）按 OUTBOUND 处理：去程优先，与
 * bundle-route 的取向一致，也保证同一班次不会随查询顺序翻来覆去。
 */

import type { PrismaClient } from '@prisma/client';
import {
  BUNDLE_ROUTE_SELECT,
  parseRouteKey,
  resolveBundleRoute,
} from '../products/bundle-route.js';

export type FlightDirection = 'OUTBOUND' | 'RETURN' | 'UNKNOWN';

/** 机场码规范化：去空白 + 大写；空 → null。与 bundle-route 的口径一致。 */
function normalizeCode(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 按「去程方向航线键集合」判定某航班的方向。
 * outboundRouteKeys 由 loadOutboundRouteKeys 一次性载入（批量场景避免 N+1）。
 */
export function resolveFlightDirection(
  originCode: string | null | undefined,
  destinationCode: string | null | undefined,
  outboundRouteKeys: ReadonlySet<string>,
): FlightDirection {
  const origin = normalizeCode(originCode);
  const destination = normalizeCode(destinationCode);
  if (!origin || !destination) return 'UNKNOWN';
  if (outboundRouteKeys.has(`${origin}-${destination}`)) return 'OUTBOUND';
  if (outboundRouteKeys.has(`${destination}-${origin}`)) return 'RETURN';
  return 'UNKNOWN';
}

/**
 * 去程方向航线键集合：结算价日历 ∪ 立减规则 ∪ 活跃套餐派生。
 * 三个来源的 routeKey 都已经是去程方向，直接并集即可；脏键（缺段 / 空段）丢弃。
 */
export async function loadOutboundRouteKeys(client: PrismaClient): Promise<Set<string>> {
  const [rateRows, ruleRows, bundles] = await Promise.all([
    client.settlementRate.findMany({ distinct: ['routeKey'], select: { routeKey: true } }),
    client.settlementDiscountRule.findMany({ distinct: ['routeKey'], select: { routeKey: true } }),
    client.bundle.findMany({
      where: { isActive: true },
      select: BUNDLE_ROUTE_SELECT,
    }),
  ]);

  const keys = new Set<string>();
  const addKey = (origin: string | null, destination: string | null): void => {
    if (origin && destination) keys.add(`${origin}-${destination}`);
  };
  const addRaw = (routeKey: string): void => {
    const parsed = parseRouteKey(routeKey);
    if (parsed) addKey(parsed.origin, parsed.destination);
  };

  for (const r of rateRows) addRaw(r.routeKey);
  for (const r of ruleRows) addRaw(r.routeKey);
  for (const b of bundles) {
    // 去程绑定优先，只绑回程时反推——与 resolveBundleRoute 同一套口径，直接复用。
    const route = resolveBundleRoute(b);
    if (route) keys.add(route.routeKey);
  }

  return keys;
}
