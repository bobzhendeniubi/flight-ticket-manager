/**
 * 小程序时间显示口径 —— 与 sales-web/src/lib/datetime.ts 同一套规则，三层别混用。
 *
 * ┌ 1. 系统时间戳（下单 / 支付 / 取消等**动作发生时刻**）
 * │    → 本文件的 formatDateTimeCn / formatDateCn，**固定北京时间**。
 * │      买家可能人在境外（越南 UTC+7 等），跟着设备走就会和客服后台对不上时间。
 * │
 * ├ 2. 航班时刻 / 出发到达时间
 * │    → 走 lib/airports.ts，按班次自己的 departureTz / arrivalTz。不要用本文件。
 * │
 * └ 3. 纯日期字段（出行日 / 入住日 / 生日 / 证件有效期）
 *      → 后端给的就是 'YYYY-MM-DD'，直接用，别做时区换算。
 *
 * ⚠️ 为什么不用 Intl：微信小程序的 JS 引擎（尤其 iOS）对
 *    `Intl.DateTimeFormat` 的 timeZone 选项支持不全，真机上可能直接忽略或抛错。
 *    所以这里全部走纯手工算术，不依赖 Intl，也不引第三方日期库。
 *
 * ⚠️ 为什么不用 `new Date(iso)` 直接解析：小程序 iOS 端对日期字符串解析历来挑格式。
 *    这里先用正则拆 ISO 串的年月日时分秒，再只做整数运算，任何机型上结果一致。
 */

/** 公司业务时区。与后端 lib/business-time.ts 的 BUSINESS_TZ 同口径。 */
export const BUSINESS_TZ = 'Asia/Shanghai';

/**
 * 业务时区相对 UTC 的固定偏移（小时）。
 * Asia/Shanghai 自 1991 年起无夏令时，恒为 +08:00，所以按固定偏移平移不会算错。
 */
const BUSINESS_UTC_OFFSET_HOURS = 8;

/** 值缺失 / 非法时的占位符。 */
const EMPTY = '—';

/** 后端时间戳形如 2026-08-26T06:30:00.000Z —— 只取到秒，末尾毫秒/时区后缀不参与解析。 */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/**
 * ISO 串（UTC）→ epoch 毫秒。串无法识别时返回 null。
 *
 * 用正则拆分量再走 `Date.UTC`，绕开 `new Date(iso)` 在小程序 iOS 端的解析挑剔。
 * lib/airports.ts 折算航班时刻时也用它——两条时间线（系统时间戳按北京、航班时刻
 * 按航段时区）共用同一套解析，避免两边各写一份正则以后跑偏。
 */
export function parseIsoUtcMs(iso: string): number | null {
  const m = ISO_RE.exec(iso.trim());
  if (!m) return null;
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    m[6] ? Number(m[6]) : 0,
  );
  return Number.isNaN(ms) ? null : ms;
}

/**
 * ISO 串（UTC）→ 北京墙钟分量。
 *
 * 平移 8 小时后取 getUTC* —— 全程不碰设备本地时区，所以越南手机、美国手机、
 * 模拟器上算出来的都是同一个北京时刻。
 */
function toBusinessWallClock(iso: string): WallClock | null {
  const base = parseIsoUtcMs(iso);
  if (base === null) return null;
  const d = new Date(base + BUSINESS_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

/**
 * 系统时间戳 → 北京时间「YYYY-MM-DD HH:mm:ss」。
 * 只用于**动作发生时刻**（下单时间、支付时间…）。航班时刻请走 lib/airports.ts。
 */
export function formatDateTimeCn(iso: string | null | undefined, fallback = EMPTY): string {
  if (!iso) return fallback;
  const t = toBusinessWallClock(iso);
  if (!t) return fallback;
  return `${t.y}-${pad(t.mo)}-${pad(t.d)} ${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}`;
}

/**
 * 系统时间戳 → 北京时间「YYYY-MM-DD」。
 * 同 {@link formatDateTimeCn}，只用于动作发生时刻。
 */
export function formatDateCn(iso: string | null | undefined, fallback = EMPTY): string {
  if (!iso) return fallback;
  const t = toBusinessWallClock(iso);
  if (!t) return fallback;
  return `${t.y}-${pad(t.mo)}-${pad(t.d)}`;
}
