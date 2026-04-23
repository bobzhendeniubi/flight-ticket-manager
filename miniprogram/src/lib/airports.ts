/**
 * 机场代码中英文 — 精简版（仅 MFM/DAD 用于 MVP）。
 * 和 sales-web/src/lib/airports.ts 保持同步。
 */
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

export function formatLocalDate(iso: string, _tz: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function formatLocalTime(iso: string, _tz: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export const CABIN_LABEL: Record<string, string> = {
  ECONOMY: '经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
  PREMIUM_ECONOMY: '超级经济舱',
};
