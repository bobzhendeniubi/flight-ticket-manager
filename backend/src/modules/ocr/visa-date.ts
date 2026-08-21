/**
 * 签证页日期归一化：只接受已知格式，无法确认时返回 null，绝不猜测。
 * 斜杠/短横线分隔的三段日期统一按日在前（DD/MM/YYYY）解析。
 */

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

function toIsoIfValid(year: number, month: number, day: number): string | null {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeDateText(raw: string): string {
  return raw
    .trim()
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/／/g, '/')
    .replace(/[－﹣−]/g, '-')
    .replace(/\s+/g, ' ');
}

function parseYear(raw: string): number {
  // 签证页常见的两位年份按 20xx 解释，保证前端仍得到四位年份。
  return raw.length === 2 ? 2000 + Number(raw) : Number(raw);
}

/** 将签证页上的常见日期格式归一为 YYYY-MM-DD。 */
export function normalizeVisaDate(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = normalizeDateText(raw);
  if (!value) return null;

  // 斜杠/短横线格式默认日在前；年份在前时要求四位，避免把 15/08/26 误读成 YY/MM/DD。
  const yearFirst = value.match(/^(\d{4})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{1,2})$/);
  if (yearFirst) {
    return toIsoIfValid(parseYear(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
  }

  const dayFirst = value.match(/^(\d{1,2})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{4}|\d{2})$/);
  if (dayFirst) {
    return toIsoIfValid(parseYear(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
  }

  const monthName = value.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}|\d{2})$/);
  if (monthName) {
    const month = MONTHS[monthName[2].toUpperCase()];
    if (month === undefined) return null;
    return toIsoIfValid(parseYear(monthName[3]), month, Number(monthName[1]));
  }

  return null;
}
