/** 自营航线常用机场 — 三字码 → 中文名 */
export const AIRPORTS: Record<string, string> = {
  PEK: '北京首都',
  PKX: '北京大兴',
  PVG: '上海浦东',
  SHA: '上海虹桥',
  CAN: '广州白云',
  SZX: '深圳宝安',
  CTU: '成都天府',
  XMN: '厦门高崎',
  HGH: '杭州萧山',
  KMG: '昆明长水',
  XIY: '西安咸阳',
  HRB: '哈尔滨太平',
};

export const AIRPORT_OPTIONS: Array<{ code: string; name: string }> = Object.entries(AIRPORTS).map(
  ([code, name]) => ({ code, name }),
);

export function airportLabel(code: string): string {
  return AIRPORTS[code] ? `${AIRPORTS[code]} (${code})` : code;
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
