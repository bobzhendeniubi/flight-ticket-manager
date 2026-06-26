/**
 * SHARED with sales-web/src/lib/airports.ts — keep them in sync.
 */
export interface AirportInfo {
  code: string;
  name: string;
  tz: string;
  country: '越南' | '中国香港' | '中国澳门';
  active: boolean;
}

export const AIRPORTS: Record<string, AirportInfo> = {
  DAD: { code: 'DAD', name: '岘港', tz: 'Asia/Ho_Chi_Minh', country: '越南', active: true },
  MFM: { code: 'MFM', name: '澳门', tz: 'Asia/Macau', country: '中国澳门', active: true },
  HKG: { code: 'HKG', name: '香港', tz: 'Asia/Hong_Kong', country: '中国香港', active: false },
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

export const CABIN_LABEL: Record<string, string> = {
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '超级经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
};

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

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}
