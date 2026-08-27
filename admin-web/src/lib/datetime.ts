/**
 * 后台「系统时间戳」统一展示口径 —— 一律折成北京时间，不跟浏览器时区走。
 *
 * 背景：同事在境外（越南 UTC+7 等）打开后台时，`toLocaleString('zh-CN')` 会按浏览器时区渲染，
 * 于是页面上的下单/收款/审计时间比导出的 Excel（早已固定北京时间）差好几个小时，
 * 对账时对不上。这里把展示口径钉死在 Asia/Shanghai，页面与导出永远一致。
 *
 * 适用范围 = **动作发生的时刻**：下单、录入、收款、核销、退款、审计、登录、提醒 ……
 *
 * 不适用（各有各的正确口径，勿改）：
 *  1. 航班时刻 / 出发日期 —— 走班次自己的 departureTz 折算（见 lib/airports.ts 的
 *     formatLocalTime / formatLocalDate、localYmd）。越南航班就该显示越南当地时刻。
 *  2. Prisma `@db.Date` 纯日期字段（生日、护照签发/有效期、入住/退房日）—— 后端给的是
 *     UTC 午夜 ISO 串，现有 `slice(0, 10)` 之类的处理保持原样。
 *     真要经过本模块时用 formatDateCn：UTC 午夜 +8 之后仍在同一天，不会跳日。
 */

const BUSINESS_TZ = 'Asia/Shanghai';

/** 展示层能接受的输入：ISO 串、时间戳、Date，以及各页面常见的空值。 */
export type DateTimeInput = string | number | Date | null | undefined;

const BASE_DATE_PARTS = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
} as const;

const BASE_TIME_PARTS = {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
} as const;

/**
 * 建 formatter；环境万一不认 Asia/Shanghai（老 ICU / 裁剪过的时区库）就退回不带时区的同格式，
 * 保证页面不会因为一个时间格式化崩掉整块 UI。
 */
function createFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: BUSINESS_TZ });
  } catch {
    return new Intl.DateTimeFormat('zh-CN', options);
  }
}

// formatter 构造是这几个函数里最贵的一步，模块级建一次复用。
const DATE_TIME_SEC_FORMATTER = createFormatter({
  ...BASE_DATE_PARTS,
  ...BASE_TIME_PARTS,
  second: '2-digit',
});

const DATE_TIME_FORMATTER = createFormatter({
  ...BASE_DATE_PARTS,
  ...BASE_TIME_PARTS,
});

const DATE_FORMATTER = createFormatter(BASE_DATE_PARTS);

/** 少数页面有自己的排版（省年份、只要时刻、月日补零……），按 options 缓存 formatter。 */
const CUSTOM_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function customFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = JSON.stringify(options);
  const cached = CUSTOM_FORMATTERS.get(cacheKey);
  if (cached) return cached;
  const formatter = createFormatter(options);
  CUSTOM_FORMATTERS.set(cacheKey, formatter);
  return formatter;
}

/** 归一化输入；空值与非法日期一律返回 null，由各 format 函数统一吐空串。 */
function toDate(value: DateTimeInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function format(formatter: Intl.DateTimeFormat, value: DateTimeInput): string {
  const date = toDate(value);
  return date ? formatter.format(date) : '';
}

/** 北京时间「YYYY/M/D HH:MM」。空值 / 非法值 → 空串。 */
export function formatDateTimeCn(value: DateTimeInput): string {
  return format(DATE_TIME_FORMATTER, value);
}

/** 北京时间「YYYY/M/D HH:MM:SS」——原先裸 `toLocaleString('zh-CN')` 的等价输出。 */
export function formatDateTimeSecCn(value: DateTimeInput): string {
  return format(DATE_TIME_SEC_FORMATTER, value);
}

/** 北京时间「YYYY/M/D」，只要日期。 */
export function formatDateCn(value: DateTimeInput): string {
  return format(DATE_FORMATTER, value);
}

/**
 * 北京时间 + 自定义排版 —— 给少数有自己格式的位置用（审计表省年份、仪表盘只要时刻等）。
 *
 * 唯一作用是**替调用方钉死 timeZone**：别再直接写 `toLocaleString('zh-CN', {...})`，
 * 那会跟浏览器时区走。上面三个具名函数覆盖不到的排版才用它。
 */
export function formatInBusinessTz(
  value: DateTimeInput,
  options: Intl.DateTimeFormatOptions,
): string {
  return format(customFormatter(options), value);
}

/** businessTzParts 的返回：全部补零，可直接拼串。 */
export type BusinessTzParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

const PARTS_FORMATTER = createFormatter({
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * 北京时间的年月日时分秒零件（补零字符串），给「YYYY-MM-DD」这类 Intl 排不出来的自定义拼法用。
 *
 * 别再用 `d.getFullYear()` / `d.getMonth()` / `d.getHours()` 手拼时间 —— 那些取的是**浏览器时区**，
 * 境外同事看到的就会跟导出对不上；这个 grep 不到 `toLocale`，是最容易漏的一类。
 *
 * 空值 / 非法值 → null。
 */
export function businessTzParts(value: DateTimeInput): BusinessTzParts | null {
  const date = toDate(value);
  if (!date) return null;
  const parts = PARTS_FORMATTER.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  };
}
