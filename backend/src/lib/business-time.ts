import { localDateISO, localToUtc } from './flight-time.js';

/** 公司业务日统一按上海时间计算。 */
export const BUSINESS_TZ = 'Asia/Shanghai';

/** 返回某个瞬间在上海对应的业务日（YYYY-MM-DD）。 */
export function businessDateISO(d: Date): string {
  return localDateISO(d, BUSINESS_TZ);
}

/** 返回上海当天 00:00:00 对应的 UTC 时刻。 */
export function startOfBusinessDayUtc(now: Date): Date {
  return localToUtc(businessDateISO(now), '00:00', BUSINESS_TZ);
}
