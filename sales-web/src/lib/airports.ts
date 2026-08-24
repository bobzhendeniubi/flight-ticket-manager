/**
 * SHARED with admin-web/src/lib/airports.ts — keep them in sync.
 *
 * 公司主营：澳门客户 → 岘港。仅显示这条业务航线相关的机场。
 * 不要加中国大陆机场（PEK/PVG/CAN/SZX 等），避免 demo 时误导业务范围。
 */
export interface AirportInfo {
  code: string;
  name: string; // 中文名
  tz: string; // IANA 时区
  country: '越南' | '中国香港' | '中国澳门';
  /** 是否是当前在售航线的机场（true = 现在就在卖，false = 规划中） */
  active: boolean;
}

export const AIRPORTS: Record<string, AirportInfo> = {
  // 主力航线 — QH9588/9589
  DAD: { code: 'DAD', name: '岘港', tz: 'Asia/Ho_Chi_Minh', country: '越南', active: true },
  MFM: { code: 'MFM', name: '澳门', tz: 'Asia/Macau', country: '中国澳门', active: true },
  // 澳门出发地扩展
  HKG: { code: 'HKG', name: '香港', tz: 'Asia/Hong_Kong', country: '中国香港', active: false },
  // 越南目的地扩展
  HAN: { code: 'HAN', name: '河内', tz: 'Asia/Ho_Chi_Minh', country: '越南', active: false },
  SGN: { code: 'SGN', name: '胡志明', tz: 'Asia/Ho_Chi_Minh', country: '越南', active: false },
  CXR: { code: 'CXR', name: '芽庄', tz: 'Asia/Ho_Chi_Minh', country: '越南', active: false },
  PQC: { code: 'PQC', name: '富国岛', tz: 'Asia/Ho_Chi_Minh', country: '越南', active: false },
};

export const AIRPORT_OPTIONS = Object.values(AIRPORTS).map((a) => ({
  code: a.code,
  name: a.name,
  country: a.country,
  active: a.active,
}));

export function airportLabel(code: string): string {
  const a = AIRPORTS[code];
  return a ? `${a.name} (${code})` : code;
}

/** IANA 时区 → 中文时区名。未知时区回退原始 IANA 串。 */
const TZ_LABEL: Record<string, string> = {
  'Asia/Ho_Chi_Minh': '越南时间',
  'Asia/Macau': '澳门时间',
  'Asia/Shanghai': '北京时间',
  'Asia/Hong_Kong': '香港时间',
  'Asia/Bangkok': '泰国时间',
};

export function tzLabel(tz: string): string {
  return TZ_LABEL[tz] ?? tz;
}

/** 舱等中文名 */
export const CABIN_LABEL: Record<string, string> = {
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '超级经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
};

/** 格式化时间（按机场本地时区） */
export function formatLocalTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleTimeString('zh-CN');
  }
}

export function formatLocalDate(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleDateString('zh-CN');
  }
}

/** 本地时区 YYYY-MM-DD（含年份）——用于跨月/跨年仍可正确字典序排序。 */
export function localYmd(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(0, 10);
  }
}

/** 某个瞬间在指定 IANA 时区的 UTC 偏移（毫秒）。tz 不识别时回退 0（=按 UTC 处理）。 */
function tzOffsetMs(at: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    // hour12:false 在部分引擎会把午夜给成 "24"，取模归一到 0。
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return asUtc - at.getTime();
  } catch {
    return 0;
  }
}

/**
 * 当地钟点 → UTC ISO 串。表单里填的永远是**当地时刻**（"当地 16:40 起飞"），
 * 落库前要按该班次自己的时区折回 UTC——用 `new Date('2026-09-01T16:40')` 走的是
 * 浏览器时区，运营在国内改一个岘港（+7）起飞的班次就会差 1 小时。
 * @param dateISO 当地日 'YYYY-MM-DD'
 * @param hhmm    当地钟点 'HH:mm'
 */
export function localToUtcIso(dateISO: string, hhmm: string, tz: string): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  if (![y, m, d, hh, mi].every(Number.isFinite)) {
    throw new Error(`无法解析当地时刻：${dateISO} ${hhmm}`);
  }
  const wall = Date.UTC(y, m - 1, d, hh, mi);
  let ts = wall;
  // 迭代两轮以覆盖 DST 切换日（现役时区均无 DST，为将来扩时区留的余量）
  for (let i = 0; i < 2; i += 1) ts = wall - tzOffsetMs(new Date(ts), tz);
  return new Date(ts).toISOString();
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}
