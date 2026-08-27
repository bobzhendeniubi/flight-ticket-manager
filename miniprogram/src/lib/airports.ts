/**
 * 机场代码中英文 + 航班时刻的时区折算。
 *
 * 口径与 sales-web/src/lib/airports.ts、backend/src/lib/flight-time.ts 一致：
 * 班次的 departureTime / arrivalTime 存的是 **UTC**，当地时区另存在
 * departureTz / arrivalTz。展示给买家的起降时刻必须按对应 tz 折算——澳门/北京
 * 差 8 小时、越南差 7 小时，直接用设备本地分量（getHours 系）渲染，人在境外的
 * 买家看到的起飞时刻就是错的，和登机牌对不上。
 *
 * ⚠️ 为什么不用 Intl：微信小程序的 JS 引擎（尤其 iOS）对 `Intl.DateTimeFormat`
 *    的 timeZone 选项支持不全，真机上可能被忽略或直接抛错——那正好是「看起来在
 *    折算、其实没折」的最坏情况。所以这里内置固定偏移表，只做整数运算，不引依赖。
 */
import { parseIsoUtcMs } from './datetime';

const AIRPORTS: Record<string, string> = {
  MFM: '澳门',
  DAD: '岘港',
  HKG: '香港',
  PVG: '上海浦东',
  PEK: '北京',
  CAN: '广州',
  BKK: '曼谷',
  SIN: '新加坡',
};

export function airportLabel(code: string): string {
  return AIRPORTS[code] ? `${AIRPORTS[code]} (${code})` : code;
}

/**
 * IANA 时区 → 相对 UTC 的固定偏移（分钟）。
 *
 * 覆盖全库实际出现过的 tz 值域：Asia/Macau 与 Asia/Ho_Chi_Minh（主力航线
 * MFM↔DAD，见后端种子数据）、Asia/Shanghai（后端建班次时的默认 tz）、
 * Asia/Hong_Kong 与 Asia/Bangkok（机场表里的扩展目的地）。
 * Asia/Singapore 一并列上，对应上面机场表里的 SIN。
 *
 * 这几个时区都**没有夏令时**（Asia/Shanghai 自 1991 年起、其余长期无 DST），
 * 所以按固定偏移平移不会算错。将来若接入有 DST 的时区，这张表就不够用了，
 * 得改成按日期查偏移。
 */
const TZ_OFFSET_MINUTES: Record<string, number> = {
  'Asia/Shanghai': 8 * 60,
  'Asia/Macau': 8 * 60,
  'Asia/Hong_Kong': 8 * 60,
  'Asia/Singapore': 8 * 60,
  'Asia/Ho_Chi_Minh': 7 * 60,
  'Asia/Bangkok': 7 * 60,
};

/**
 * 表里没有的 tz 回退到业务基准时区 Asia/Shanghai（+8）。
 * 回退到 UTC 会让绝大多数班次（+8/+7 两条线）整体早 7~8 小时；回退到 +8 至多
 * 差 1 小时，是两害相权的选择。真出现新时区应当补进上面那张表，而不是靠回退。
 */
const FALLBACK_OFFSET_MINUTES = 8 * 60;

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** 值缺失 / ISO 串非法时的占位符，与 lib/datetime.ts 保持一致。 */
const EMPTY = '—';

interface AirportWallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/**
 * UTC ISO 串 + 机场时区 → 该机场的当地墙钟分量。
 * 平移偏移后一律取 getUTC*，全程不碰设备本地时区。
 */
function toAirportWallClock(iso: string, tz: string): AirportWallClock | null {
  const base = parseIsoUtcMs(iso);
  if (base === null) return null;
  const offset = TZ_OFFSET_MINUTES[tz] ?? FALLBACK_OFFSET_MINUTES;
  const d = new Date(base + offset * 60 * 1000);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
  };
}

/** 航班日期 → 机场当地「YYYY-MM-DD」。 */
export function formatLocalDate(iso: string, tz: string): string {
  const t = toAirportWallClock(iso, tz);
  if (!t) return EMPTY;
  return `${t.y}-${pad(t.mo)}-${pad(t.d)}`;
}

/** 航班时刻 → 机场当地「HH:mm」（24 小时制）。 */
export function formatLocalTime(iso: string, tz: string): string {
  const t = toAirportWallClock(iso, tz);
  if (!t) return EMPTY;
  return `${pad(t.h)}:${pad(t.mi)}`;
}

export const CABIN_LABEL: Record<string, string> = {
  ECONOMY: '经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
  PREMIUM_ECONOMY: '超级经济舱',
};
