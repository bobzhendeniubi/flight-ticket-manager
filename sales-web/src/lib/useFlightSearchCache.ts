import { useCallback, useRef, useState } from 'react';
import { api, type FlightSearchResult } from './api';

/**
 * 航班搜索缓存 —— 按 (出发地, 目的地, 日期) 去重，多张套餐卡共享同一次搜索。
 *
 * 套餐落地页每张卡都要"去/回"两条航段的实时余位 + 价格。很多套餐共用同一条
 * 主航线（澳门 ⇌ 岘港）和同一出发日期，只是住宿晚数不同导致回程日期不同。
 * 用一个 (route,date) → 全部结果 的缓存，把 N 张卡的请求收敛成"每个唯一
 * (日期,航线) 一次"，避免重复打 /flights/search。
 *
 * 缓存整条结果数组（而非只留首条）：套餐可绑定具体航班号，选出发日后要按
 * flightNumber 把航段解析到对应班次；只留首条会丢掉运营绑定的那班。
 *
 * - ensure()：幂等触发某条 (route,date) 的搜索（已请求过的 key 直接跳过）。
 * - get()：读首条结果（undefined=未/加载中，null=该日期无班次）。行为与旧版一致。
 * - getByFlightNumber()：给了航班号（已绑定）时只认对应班次——命中返回该班，未命中
 *   返回 null（= 绑定班次当天不飞，该航段不可售），绝不回退到别的班次；未绑定
 *   （航班号省略/为空）时回退首条结果（= get() 的语义），与旧版逐字节一致。
 *
 * 价格按单人取（passengers=1），人数变化只在前端乘算，不触发新搜索；余位档位
 * 由服务端给出，与查询人数无关。
 */
export type FlightLeg = FlightSearchResult | null;

/** 某 (route,date) 的搜索结果：undefined=加载中/未请求，null=无班次，否则为全部班次数组。 */
type CacheEntry = FlightSearchResult[] | null;

export interface FlightSearchCache {
  /** 触发一次搜索（幂等）。已请求过的 (route,date) 不再重复打 API。 */
  ensure: (origin: string, destination: string, date: string) => void;
  /** 读首条结果：undefined=加载中/未请求，null=无班次，否则为航段数据。 */
  get: (origin: string, destination: string, date: string) => FlightLeg | undefined;
  /**
   * 按航班号取航段：给了 flightNumber（已绑定）时只认对应班次——命中返回该班，
   * 未命中返回 null（绑定班次当天不飞，该航段不可售），绝不回退到别的班次。
   * undefined=加载中/未请求，null=无班次。未绑定（flightNumber 省略/为空）时与 get() 等价。
   */
  getByFlightNumber: (
    origin: string,
    destination: string,
    date: string,
    flightNumber?: string | null,
  ) => FlightLeg | undefined;
}

function cacheKey(origin: string, destination: string, date: string): string {
  return `${origin}|${destination}|${date}`;
}

/**
 * 从缓存条目里解析出航段。
 * - undefined（加载中/未请求）→ undefined。
 * - 无班次（null 或空数组）→ null。
 * - 已绑定航班号：命中该班返回它；未命中返回 null（= 绑定班次当天不飞，该航段不可售，
 *   买家可另选日期）。不回退到别的班次，避免把绑定套餐悄悄换成另一班机票。
 * - 未绑定（flightNumber 省略/为空）→ 首条结果（与旧版 results[0] 一致）。
 */
function resolveLeg(entry: CacheEntry | undefined, flightNumber?: string | null): FlightLeg | undefined {
  if (entry === undefined) return undefined; // 加载中/未请求
  if (entry === null || entry.length === 0) return null; // 无班次
  if (flightNumber) {
    // 已绑定：只认对应班次；不飞即当天不可售，绝不回退到别的班次。
    return entry.find((r) => r.flightNumber === flightNumber) ?? null;
  }
  // 未绑定 → 回退首条（与旧版 results[0] 一致）。
  return entry[0];
}

export function useFlightSearchCache(): FlightSearchCache {
  const [cache, setCache] = useState<Record<string, CacheEntry>>({});
  // 已发起请求的 key（去重用）。用 ref 让 ensure 保持稳定引用，不随 cache 变化重建。
  const requested = useRef<Set<string>>(new Set());

  const ensure = useCallback((origin: string, destination: string, date: string) => {
    if (!origin || !destination || !date) return;
    const key = cacheKey(origin, destination, date);
    if (requested.current.has(key)) return;
    requested.current.add(key);
    api
      .searchFlights({ origin, destination, date, passengers: 1 })
      .then((r) => setCache((c) => ({ ...c, [key]: r.results.length > 0 ? r.results : null })))
      .catch(() => setCache((c) => ({ ...c, [key]: null })));
  }, []);

  const get = useCallback(
    (origin: string, destination: string, date: string): FlightLeg | undefined =>
      resolveLeg(cache[cacheKey(origin, destination, date)]),
    [cache],
  );

  const getByFlightNumber = useCallback(
    (
      origin: string,
      destination: string,
      date: string,
      flightNumber?: string | null,
    ): FlightLeg | undefined =>
      resolveLeg(cache[cacheKey(origin, destination, date)], flightNumber),
    [cache],
  );

  return { ensure, get, getByFlightNumber };
}
