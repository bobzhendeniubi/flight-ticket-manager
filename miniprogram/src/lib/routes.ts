/**
 * 活跃航线拉取 + 买家可读摘要文案。
 *
 * 公司马上开第二条直飞航线（目的地未定），首页标题栏、登录页、"我的"页里原来写死的
 * 「澳门 ↔ 岘港」不能再是编译时常量。这里统一从后端 `GET /public/routes` 拉，带一份
 * 内存缓存（一次小程序会话只拉一次，三个页面共用），并顺带把机场中文名合并进
 * lib/airports.ts 的展示表。拉取失败/暂无数据时不缓存失败结果，调用方按
 * `routeSummaryText()` 的兜底文案（品牌名）展示，下次调用会重新尝试。
 */
import { api } from './api';
import { applyPublicAirports } from './airports';
import type { PublicRoute } from './types';

let cachedRoutes: PublicRoute[] | null = null;
let inFlight: Promise<PublicRoute[]> | null = null;

/** 拉活跃航线 + 机场并合并进本地机场名展示表；内存缓存，不重复请求。 */
export async function loadPublicRoutes(): Promise<PublicRoute[]> {
  if (cachedRoutes) return cachedRoutes;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const [routesRes, airportsRes] = await Promise.all([
        api.getPublicRoutes(),
        api.getPublicAirports(),
      ]);
      applyPublicAirports(airportsRes.airports);
      cachedRoutes = routesRes.routes;
      return routesRes.routes;
    } catch {
      // 拉取失败：不缓存失败结果，下次调用（如切换页面）重新尝试
      return [];
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * 买家可读的航线摘要文案：
 *   - 恰好一条 → "起 ⇌ 达"（如"澳门 ⇌ 岘港"）
 *   - 多于一条 → "N 条直飞航线"（不偏向其中任何一条）
 *   - 拉取失败 / 尚无数据 → 品牌名兜底，不展示任何具体航线
 */
export function routeSummaryText(routes: PublicRoute[], brandFallback = '椰岛假期'): string {
  if (!routes || routes.length === 0) return brandFallback;
  if (routes.length === 1) return `${routes[0].origin.name} ⇌ ${routes[0].destination.name}`;
  return `${routes.length} 条直飞航线`;
}
