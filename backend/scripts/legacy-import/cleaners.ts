export interface CleanResult<T> {
  value: T;
  issues: string[];
}

// This list is data, not product copy. Keep additions isolated to this constant.
export const SCRUB_PATTERNS: RegExp[] = [
  /倩怡姐/gu,
  /嘉美姐/gu,
  /曾嘉美/gu,
  /霞姐/gu,
  /影姐/gu,
  /罗姐/gu,
  /嘉美/gu,
  /娥姐/gu,
  /欢姐/gu,
  /王总/gu,
  /乐盈/gu,
  /贺帅/gu,
  /赵姐/gu,
  /李萍/gu,
  /李孟/gu,
  /谢晓枝/gu,
  /童明青/gu,
  /寇露/gu,
  /倪嘉露/gu,
  /章琴/gu,
  /王在美/gu,
  /海哥/gu,
];

export const PROTECTED_NAMES = ['吴章琴', '李萍萍', '李孟昆', '李孟月'] as const;

let protectedTokenCounter = 0;

function protectedToken(source: string, index: number): string {
  let attempt = 0;
  while (true) {
    const token = `\u0000legacy-protected-${source.length}-${index}-${protectedTokenCounter++}-${attempt++}\u0000`;
    if (!source.includes(token)) return token;
  }
}

function rawText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return text === '' ? null : text;
}

function dateOnly(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return date;
}

/** Parse an archive date as UTC midnight so it remains a date-only value. */
export function cleanDate(raw: unknown, issueKey = 'date'): CleanResult<Date | null> {
  if (raw === null || raw === undefined) return { value: null, issues: [] };
  const original = String(raw);
  const value = original.trim();
  const issues: string[] = [];
  if (value !== original) issues.push(`${issueKey}:trimmed`);
  if (!value) return { value: null, issues };

  let parsed: Date | null = null;
  let match = /^(\d{2})-(\d{2})-(\d{4})$/u.exec(value);
  if (match) parsed = dateOnly(Number(match[3]), Number(match[2]), Number(match[1]));
  if (!parsed) {
    match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (match) parsed = dateOnly(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  if (!parsed && /^\d{5}$/u.test(value)) {
    const serial = Number(value);
    const timestamp = Date.UTC(1899, 11, 30) + serial * 86_400_000;
    const excelDate = new Date(timestamp);
    if (Number.isFinite(timestamp) && excelDate.getUTCFullYear() >= 1900 && excelDate.getUTCFullYear() <= 2200) {
      parsed = dateOnly(excelDate.getUTCFullYear(), excelDate.getUTCMonth() + 1, excelDate.getUTCDate());
      if (parsed) issues.push(`${issueKey}:excel-serial`);
    }
  }
  if (!parsed) issues.push(`${issueKey}:invalid`);
  return { value: parsed, issues };
}

/** Parse the two legacy datetime forms used by receipts and audit timestamps. */
export function cleanDateTime(raw: unknown, issueKey = 'datetime'): CleanResult<Date | null> {
  if (raw === null || raw === undefined) return { value: null, issues: [] };
  const original = String(raw);
  const value = original.trim();
  const issues: string[] = [];
  if (value !== original) issues.push(`${issueKey}:trimmed`);
  if (!value) return { value: null, issues };

  const standard = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (standard) {
    const year = Number(standard[1]);
    const month = Number(standard[2]);
    const day = Number(standard[3]);
    const hour = Number(standard[4]);
    const minute = Number(standard[5]);
    const second = Number(standard[6] ?? 0);
    const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
    const parsed = new Date(timestamp);
    if (
      Number.isFinite(timestamp) &&
      parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day && parsed.getUTCHours() === hour &&
      parsed.getUTCMinutes() === minute && parsed.getUTCSeconds() === second
    ) {
      return { value: parsed, issues };
    }
  }
  const iso = new Date(value);
  if (!Number.isNaN(iso.getTime())) return { value: iso, issues };
  return { value: null, issues: [...issues, `${issueKey}:invalid`] };
}

export function cleanMoney(raw: unknown, issueKey = 'money'): CleanResult<string | null> {
  if (raw === null || raw === undefined) return { value: null, issues: [] };
  const original = String(raw);
  const value = original.trim();
  const issues: string[] = [];
  if (value !== original) issues.push(`${issueKey}:trimmed`);
  if (!value) return { value: null, issues };
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) {
    return { value: null, issues: [...issues, `${issueKey}:invalid`] };
  }
  return { value, issues };
}

export function cleanInt(raw: unknown, issueKey = 'integer'): CleanResult<number | null> {
  if (raw === null || raw === undefined) return { value: null, issues: [] };
  const original = String(raw);
  const value = original.trim();
  const issues: string[] = [];
  if (value !== original) issues.push(`${issueKey}:trimmed`);
  if (!value) return { value: null, issues };
  if (!/^-?\d+$/u.test(value)) return { value: null, issues: [...issues, `${issueKey}:invalid`] };
  return { value: Number(value), issues };
}

export function cleanGender(raw: unknown, title: unknown): string | null {
  const gender = rawText(raw)?.toUpperCase();
  if (gender === 'M' || gender === 'F') return gender;
  const normalizedTitle = rawText(title)?.toUpperCase();
  if (normalizedTitle === 'MR' || normalizedTitle === 'MSTR') return 'M';
  if (normalizedTitle === 'MS' || normalizedTitle === 'MRS' || normalizedTitle === 'MISS') return 'F';
  return null;
}

export function cleanPassengerType(raw: unknown): string {
  const value = rawText(raw)?.toUpperCase();
  return value || 'ADULT';
}

export function normalizeUpper(raw: unknown): string | null {
  const value = rawText(raw);
  return value ? value.toUpperCase() : null;
}

export function normalizeDocumentNumber(raw: unknown): string | null {
  return normalizeUpper(raw);
}

export function cleanRemark(
  raw: unknown,
  patterns: readonly RegExp[] = SCRUB_PATTERNS,
  protectedNames: readonly string[] = PROTECTED_NAMES,
): string | null {
  const value = rawText(raw);
  if (!value) return null;
  const placeholders = protectedNames.map((name, index) => ({
    name,
    token: protectedToken(value, index),
  }));
  const protectedValue = placeholders.reduce(
    (current, { name, token }) => current.split(name).join(token),
    value,
  );
  const scrubbed = patterns.reduce((current, pattern) => current.replace(pattern, '[内部]'), protectedValue);
  return placeholders.reduce((current, { name, token }) => current.split(token).join(name), scrubbed);
}

export function cleanText(raw: unknown): string | null {
  return rawText(raw);
}

export function rawInteger(raw: unknown): number | null {
  const value = rawText(raw);
  return value && /^-?\d+$/u.test(value) ? Number(value) : null;
}

export function rawBoolean(raw: unknown): boolean {
  return rawInteger(raw) === 1;
}
