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

/**
 * 业务时区相对 UTC 的固定偏移。Asia/Shanghai 自 1991 年起无夏令时，恒为 +08:00，
 * 所以「动作发生时刻」类系统时间戳可以直接按固定偏移平移，不必每次走 Intl。
 */
const BUSINESS_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 把某个瞬间平移成「业务时区墙钟」，之后取 getUTC* 分量即得当地年月日时分秒。
 *
 * 为什么不用 `getHours()` 等本地分量：导出是服务器生成的，容器 TZ 是 UTC，
 * 依赖运行环境时区会让同一份导出在开发机和线上给出不同结果。
 */
function toBusinessWallClock(d: Date): Date {
  return new Date(d.getTime() + BUSINESS_UTC_OFFSET_MS);
}

/**
 * 系统时间戳（录入/下单/到账/核销等**动作发生时刻**）→ 'YYYY-MM-DD HH:mm'（北京时间）。
 *
 * ⚠️ 只用于动作时刻。**不要**用于：
 *   - 航班时刻 / 出发日期 —— 那套按班次自己的 departureTz 折算，见 lib/flight-time.ts；
 *   - 生日 / 护照签发日 / 有效期等 `@db.Date` 字段 —— 库里存 UTC 午夜，必须按 UTC 切，
 *     平移 +8 反而会把日期整体推错。
 */
export function businessDateTime(d: Date | null | undefined): string {
  if (!d) return '';
  const t = toBusinessWallClock(d);
  const date = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  return `${date} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * 同 {@link businessDateTime}，但含秒：'YYYY-MM-DD HH:mm:ss'（北京时间）。
 * 用于旧系统样例里录入时间/到账时间带秒的模版列。
 */
export function businessDateTimeSec(d: Date | null | undefined): string {
  if (!d) return '';
  const t = toBusinessWallClock(d);
  return `${businessDateTime(d)}:${String(t.getUTCSeconds()).padStart(2, '0')}`;
}
