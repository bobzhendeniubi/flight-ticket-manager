import { useCallback, useRef, useState } from 'react';
import { api, type FlightSearchResult } from './api';

/**
 * 航班搜索缓存 —— 按 (出发地, 目的地, 日期) 去重，多张套餐卡共享同一次搜索。
 *
 * 套餐落地页每张卡都要"去/回"两条航段的实时余位 + 价格。很多套餐共用同一条
 * 主航线（澳门 ⇌ 岘港）和同一出发日期，只是住宿晚数不同导致回程日期不同。
 * 用一个 (route,date) → 首条结果 的缓存，把 N 张卡的请求收敛成"每个唯一
 * (日期,航线) 一次"，避免重复打 /flights/search。
 *
 * - ensure()：幂等触发某条 (route,date) 的搜索（已请求过的 key 直接跳过）。
 * - get()：读已缓存的首条结果（undefined=未/加载中，null=该日期无班次）。
 *
 * 价格按单人取（passengers=1），人数变化只在前端乘算，不触发新搜索；余位档位
 * 由服务端给出，与查询人数无关。
 */
export type FlightLeg = FlightSearchResult | null;

export interface FlightSearchCache {
  /** 触发一次搜索（幂等）。已请求过的 (route,date) 不再重复打 API。 */
  ensure: (origin: string, destination: string, date: string) => void;
  /** 读首条结果：undefined=加载中/未请求，null=无班次，否则为航段数据。 */
  get: (origin: string, destination: string, date: string) => FlightLeg | undefined;
}

function cacheKey(origin: string, destination: string, date: string): string {
  return `${origin}|${destination}|${date}`;
}

export function useFlightSearchCache(): FlightSearchCache {
  const [cache, setCache] = useState<Record<string, FlightLeg>>({});
  // 已发起请求的 key（去重用）。用 ref 让 ensure 保持稳定引用，不随 cache 变化重建。
  const requested = useRef<Set<string>>(new Set());

  const ensure = useCallback((origin: string, destination: string, date: string) => {
    if (!origin || !destination || !date) return;
    const key = cacheKey(origin, destination, date);
    if (requested.current.has(key)) return;
    requested.current.add(key);
    api
      .searchFlights({ origin, destination, date, passengers: 1 })
      .then((r) => setCache((c) => ({ ...c, [key]: r.results[0] ?? null })))
      .catch(() => setCache((c) => ({ ...c, [key]: null })));
  }, []);

  const get = useCallback(
    (origin: string, destination: string, date: string): FlightLeg | undefined =>
      cache[cacheKey(origin, destination, date)],
    [cache],
  );

  return { ensure, get };
}
