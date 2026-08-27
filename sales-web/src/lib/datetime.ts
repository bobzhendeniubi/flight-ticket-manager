/**
 * 前台时间显示口径 —— 三层，别混用。
 *
 * ┌ 1. 系统时间戳（下单 / 加入购物车 / 注册 / 上次登录 / 佣金生成到账等**动作发生时刻**）
 * │    → 本文件的 formatDateTimeCn / formatDateCn，**固定北京时间**。
 * │      买家和代理可能人在境外（越南 UTC+7、欧美负时区），跟着设备时区渲染就会出现
 * │      「客服说 14:00 下的单，我这儿显示 13:00」——同一笔单两个时间，对不上账。
 * │
 * ├ 2. 航班时刻 / 出发到达时间
 * │    → 走 lib/airports.ts 的 formatLocalTime / formatLocalDate，按班次自己的
 * │      departureTz / arrivalTz 折算。**不要**换成本文件：岘港 13:05 起飞，
 * │      登机牌上印的就是 13:05，折成北京时间反而是错的。
 * │
 * └ 3. 纯日期字段（出行日 / 入住退房日 / 生日 / 护照有效期）
 *      → 用 formatPlainDate。后端这些字段是 @db.Date，回来的是「UTC 午夜」，
 *        按任何时区折算都可能把整个日期推错一天（负时区设备上尤其明显）。
 *        这类值只能按 UTC 分量切，不参与时区换算。
 */

/** 公司业务时区。与后端 lib/business-time.ts 的 BUSINESS_TZ 同口径。 */
export const BUSINESS_TZ = 'Asia/Shanghai';

/**
 * 业务时区相对 UTC 的固定偏移。Asia/Shanghai 自 1991 年起无夏令时，恒为 +08:00，
 * 所以 Intl 不可用时可以直接按固定偏移平移，不会算错。
 */
const BUSINESS_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 值缺失 / 非法时的占位符，与页面上原有的空态写法保持一致。 */
const EMPTY = '—';

/** 宽松入参：ISO 字符串、Date、时间戳，或空值。 */
export type DateLike = string | number | Date | null | undefined;

function toDate(value: DateLike): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 把某个瞬间平移成「北京墙钟」，之后取 getUTC* 分量即得北京当地年月日时分秒。 */
function toBusinessWallClock(d: Date): Date {
  return new Date(d.getTime() + BUSINESS_UTC_OFFSET_MS);
}

/**
 * Intl 兜底：手工按 +8 折算，输出与 toLocaleString('zh-CN') 同形（YYYY/M/D HH:mm:ss）。
 * 正常浏览器走不到这里，留着是为了任何一台设备都不会把时间显示成 Invalid Date。
 */
function manualBusinessFormat(d: Date, withTime: boolean): string {
  const t = toBusinessWallClock(d);
  const date = `${t.getUTCFullYear()}/${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
  if (!withTime) return date;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

/**
 * 系统时间戳 → 北京时间「YYYY/M/D HH:mm:ss」。
 *
 * 只用于**动作发生时刻**（下单时间、加入购物车时间、注册时间、到账时间…）。
 * 航班时刻请走 lib/airports.ts；出行日/生日等纯日期请走 formatPlainDate。
 */
export function formatDateTimeCn(value: DateLike, fallback = EMPTY): string {
  const d = toDate(value);
  if (!d) return fallback;
  try {
    return d.toLocaleString('zh-CN', { timeZone: BUSINESS_TZ });
  } catch {
    return manualBusinessFormat(d, true);
  }
}

/**
 * 系统时间戳 → 北京时间「YYYY/M/D」（只要日期那一截）。
 * 同 {@link formatDateTimeCn}，只用于动作发生时刻。
 */
export function formatDateCn(value: DateLike, fallback = EMPTY): string {
  const d = toDate(value);
  if (!d) return fallback;
  try {
    return d.toLocaleDateString('zh-CN', { timeZone: BUSINESS_TZ });
  } catch {
    return manualBusinessFormat(d, false);
  }
}

/**
 * 系统时间戳 → 北京时间「YYYY-MM-DD」。
 * 定长、可直接字典序比较/排序，用于分组和 key，也用于「很久以前」的兜底展示。
 */
export function businessYmd(value: DateLike, fallback = ''): string {
  const d = toDate(value);
  if (!d) return fallback;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: BUSINESS_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return toBusinessWallClock(d).toISOString().slice(0, 10);
  }
}

/**
 * 「今天」（北京口径 YYYY-MM-DD），可带天数偏移。
 *
 * 日期选择器默认值、可售日窗口起点这类地方要的是**买家心里的今天**，而买家和
 * 客服都按北京时间说话。用 `new Date().toISOString().slice(0,10)` 取的是 UTC 日，
 * 北京时间早上 8 点前会整体早一天——可售日窗口会把已经飞掉的日期算成可订。
 * 同样，`d.setDate(d.getDate() + n)` 是按**设备本地日**加减，境外买家的设备上
 * 起算点就已经错了。所以这里先落到北京日，再按纯日期做整数天加减。
 */
export function businessToday(offsetDays = 0): string {
  return addDaysYmd(businessYmd(new Date()), offsetDays);
}

/**
 * 在「YYYY-MM-DD」上加减 n 天。按 UTC 零点算，纯日期进出，不碰时区。
 * 入参不是合法日期时原样返回（调用方拿到的仍是可渲染的字符串）。
 */
export function addDaysYmd(ymd: string, days: number): string {
  const ms = Date.parse(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return ymd;
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 纯日期字段 → 「YYYY-MM-DD」，**不做任何时区换算**。
 *
 * 用于出行日 / 入住退房日 / 生日 / 护照有效期这类后端 @db.Date 字段：库里存的是
 * 「那一天的 UTC 午夜」，交给 new Date(...).toLocaleDateString() 会按设备时区折，
 * 负时区设备（如美西 UTC−7）上整张单的出行日会集体早一天。
 *
 * 后端已经给出 'YYYY-MM-DD' 的，原样返回；给完整 ISO 的，按 UTC 分量切。
 */
export function formatPlainDate(value: DateLike, fallback = EMPTY): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  }
  const d = toDate(value);
  if (!d) return fallback;
  return d.toISOString().slice(0, 10);
}
