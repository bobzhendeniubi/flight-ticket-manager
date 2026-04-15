/**
 * 我们主营的目的地：岘港。核心航线 澳门 ↔ 岘港 (QH9588/9589)。
 * 其他机场为未来扩展（港澳/大湾区 ↔ 越南主要城市）。
 */
export interface AirportInfo {
  code: string;
  name: string; // 中文名
  tz: string; // IANA 时区
  country: '越南' | '中国' | '';
}

export const AIRPORTS: Record<string, AirportInfo> = {
  DAD: { code: 'DAD', name: '岘港', tz: 'Asia/Ho_Chi_Minh', country: '越南' },
  MFM: { code: 'MFM', name: '澳门', tz: 'Asia/Macau', country: '中国' },
  HKG: { code: 'HKG', name: '香港', tz: 'Asia/Hong_Kong', country: '中国' },
  SGN: { code: 'SGN', name: '胡志明', tz: 'Asia/Ho_Chi_Minh', country: '越南' },
  HAN: { code: 'HAN', name: '河内', tz: 'Asia/Ho_Chi_Minh', country: '越南' },
  CXR: { code: 'CXR', name: '芽庄', tz: 'Asia/Ho_Chi_Minh', country: '越南' },
  PQC: { code: 'PQC', name: '富国岛', tz: 'Asia/Ho_Chi_Minh', country: '越南' },
  PEK: { code: 'PEK', name: '北京首都', tz: 'Asia/Shanghai', country: '中国' },
  CAN: { code: 'CAN', name: '广州', tz: 'Asia/Shanghai', country: '中国' },
  SZX: { code: 'SZX', name: '深圳', tz: 'Asia/Shanghai', country: '中国' },
  PVG: { code: 'PVG', name: '上海浦东', tz: 'Asia/Shanghai', country: '中国' },
};

export const AIRPORT_OPTIONS = Object.values(AIRPORTS).map((a) => ({
  code: a.code,
  name: a.name,
  country: a.country,
}));

export function airportLabel(code: string): string {
  const a = AIRPORTS[code];
  return a ? `${a.name} (${code})` : code;
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

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}
