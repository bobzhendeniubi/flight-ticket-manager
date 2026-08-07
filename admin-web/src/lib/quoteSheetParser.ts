/**
 * 报价表粘贴解析（纯函数：无 DOM、无网络、无副作用）。
 *
 * 运营每天维护的报价表 Excel 格式固定，整块复制出来就是 TSV（行 = 换行，列 = 制表符）。
 * 这里把两张表解析成结算价日历可直接批量入库的条目：
 *
 *   parseGroundQuoteSheet —— 套票 sheet（近期/远期同构）→ 地面结算价（出发日 × 晚数 × 档次）
 *   parseOtaQuoteSheet    —— OTA sheet（左右两张并排表）→ 机票结算价（出发日 × 航班号）
 *
 * 两个函数都返回 { entries, skipped }：entries 可直接批量 upsert；skipped 是「看着像数据行
 * 但没能取到价」的行，带行号 + 原因交给页面展示，避免静默丢数据。
 * 表头行 / 空行 / 公告行 / 回程行这类明显噪声不进 skipped（否则清单全是噪声没法看）。
 */
import type { SettlementTier } from './api';

/** 地面套票一格：出发日 × 晚数 × 档次 → 每人结算价（CNY 整数）。 */
export interface GroundQuoteEntry {
  departDate: string;
  nights: number;
  tier: SettlementTier;
  pricePerPersonCny: number;
}

/** 机票一格：出发日 × 航班号 → 每人 OTA 结算价（CNY 整数）。 */
export interface OtaQuoteEntry {
  departDate: string;
  flightNumber: string;
  pricePerPersonCny: number;
}

/** 被跳过的数据行（行号从 1 起，对应粘贴文本的行序，便于回原表核对）。 */
export interface QuoteSheetSkippedRow {
  line: number;
  reason: string;
  /** 原始行回显（去空列后用 ` | ` 连接，超长截断），只作核对用 */
  raw: string;
}

export interface QuoteSheetResult<T> {
  entries: T[];
  skipped: QuoteSheetSkippedRow[];
}

/** 套票 sheet 四档价格列的固定顺序：市区三星 / 市区四星 / 市区五星 / 国际五星。 */
export const GROUND_TIER_COLUMNS: SettlementTier[] = [
  'CITY_3STAR',
  'CITY_4STAR',
  'CITY_5STAR',
  'INTL_5STAR',
];

/** 结算价日历只维护 1–5 晚（与后端 nights 校验一致）。 */
const MIN_NIGHTS = 1;
const MAX_NIGHTS = 5;

/** 「1晚」「10 晚」这类晚数单元格。 */
const NIGHTS_CELL = /^(\d{1,2})\s*晚$/u;
/** 航段单元格里的航班号（如「QH9589澳门-岘港」→ QH9589）。 */
const FLIGHT_IN_CELL = /[A-Z]{2}\d{2,4}/u;

/** Excel 1900 日期系统折算基准：序列号 1 = 1900-01-01，故基准取 1899-12-30。 */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;
/** 只有落在这个区间的纯数字才当 Excel 序列号（约 1954–2064），避免把「808」当日期。 */
const EXCEL_SERIAL_MIN = 20_000;
const EXCEL_SERIAL_MAX = 60_000;

const RAW_PREVIEW_MAX = 80;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 年月日 → YYYY-MM-DD；非法日期（如 2 月 30 日）返回 null。 */
function makeYmd(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * 报价表里的日期单元格 → YYYY-MM-DD，兼容三类写法：
 *   1. 完整日期 YYYY-MM-DD / YYYY/M/D / YYYY.M.D / YYYY年M月D日
 *   2. 只有月日 M/D（或 M-D、M月D日）：按所选月份（baseMonth）的年份补全；
 *      月份小于所选月份时视为跨年往后推一年（12 月的表里出现 1/5 → 次年 1 月 5 日）
 *   3. Excel 序列号（复制出来是数字，如 46243）：按 1900 日期系统折算
 * 认不出返回 null。
 */
export function parseQuoteDate(raw: string, baseMonth: string): string | null {
  const s = raw.trim();
  if (s === '') return null;

  // Excel 序列号（纯数字）
  if (/^\d+$/u.test(s)) {
    const serial = Number(s);
    if (serial < EXCEL_SERIAL_MIN || serial > EXCEL_SERIAL_MAX) return null;
    const dt = new Date(EXCEL_EPOCH_UTC + serial * DAY_MS);
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  }

  const full = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/u.exec(s);
  if (full) return makeYmd(Number(full[1]), Number(full[2]), Number(full[3]));

  const md = /^(\d{1,2})[-/.月](\d{1,2})日?$/u.exec(s);
  if (md) {
    const base = /^(\d{4})-(\d{2})$/u.exec(baseMonth.trim());
    if (!base) return null;
    const baseYear = Number(base[1]);
    const baseMonthNum = Number(base[2]);
    const month = Number(md[1]);
    const year = month < baseMonthNum ? baseYear + 1 : baseYear;
    return makeYmd(year, month, Number(md[2]));
  }

  return null;
}

/** 价格单元格 → 整数；「/」「售罄」「955余1」「空」等一律返回 null（该格跳过，不写不清空既有值）。 */
function parsePrice(raw: string): number | null {
  const s = raw.replace(/[¥￥,，\s]/gu, '');
  if (!/^\d+$/u.test(s)) return null;
  const v = Number(s);
  return Number.isSafeInteger(v) ? v : null;
}

/** 一行文本 → 单元格数组（制表符分列，不换行空格归一后去首尾空白）。 */
function toCells(line: string): string[] {
  return line.split('\t').map((c) => c.replace(/ /gu, ' ').trim());
}

/** 粘贴文本 → 带行号的行（行号从 1 起，与运营看到的粘贴内容对齐）。 */
function toLines(text: string): Array<{ line: number; cells: string[] }> {
  return text
    .replace(/\r/gu, '')
    .split('\n')
    .map((raw, i) => ({ line: i + 1, cells: toCells(raw) }));
}

/** 跳过原因里回显的原始行（去掉空列 + 截断）。 */
function rawPreview(cells: string[]): string {
  const joined = cells.filter((c) => c !== '').join(' | ');
  return joined.length > RAW_PREVIEW_MAX ? `${joined.slice(0, RAW_PREVIEW_MAX)}…` : joined;
}

/**
 * 套票 sheet（近期/远期同构）→ 地面结算价条目。
 *
 * 行模式：每天一块 = 表头行 + 5 组晚数 × 2 行（去程行带晚数与四档价，回程行只有航段）：
 *   日期  晚数  星期  时刻  航段  市区三星 市区四星 市区五星 国际五星 备注 升级
 *   2026-08-07  1晚  星期五  16:40-17:35  QH9589澳门-岘港  1368  1418  /  /  少量  加1400
 *   2026-08-08       星期六  12:30-15:10  QH9588岘港-澳门
 *
 * 只认「去程行」：同一行里同时有 晚数单元格 + 含航班号的航段单元格 + 可解析日期 + 至少一档数字价。
 * 四档价格列取航段列右侧连续 4 列，顺序固定；`/`、空、非数字的那一档直接跳过（不写、不清空既有值）。
 * 同一 (出发日, 晚数, 档次) 重复出现时取最后一次（报价表下方的修订覆盖上方）。
 */
export function parseGroundQuoteSheet(
  text: string,
  baseMonth: string,
): QuoteSheetResult<GroundQuoteEntry> {
  const skipped: QuoteSheetSkippedRow[] = [];
  const byKey = new Map<string, GroundQuoteEntry>();

  for (const { line, cells } of toLines(text)) {
    // 晚数单元格 = 「这是一条去程数据行」的标志；表头/回程/公告/空行都没有，静默跳过
    const nightsIdx = cells.findIndex((c) => NIGHTS_CELL.test(c));
    if (nightsIdx < 0) continue;

    const nights = Number(NIGHTS_CELL.exec(cells[nightsIdx])![1]);
    if (nights < MIN_NIGHTS || nights > MAX_NIGHTS) {
      skipped.push({
        line,
        reason: `晚数 ${nights} 晚超出可维护范围（${MIN_NIGHTS}–${MAX_NIGHTS} 晚）`,
        raw: rawPreview(cells),
      });
      continue;
    }

    const flightIdx = cells.findIndex((c) => FLIGHT_IN_CELL.test(c.toUpperCase()));
    if (flightIdx < 0) {
      skipped.push({ line, reason: '这行找不到航段列（缺航班号）', raw: rawPreview(cells) });
      continue;
    }

    // 日期在航段列左侧（避免把时刻/备注当日期）
    let departDate: string | null = null;
    for (const cell of cells.slice(0, flightIdx)) {
      departDate = parseQuoteDate(cell, baseMonth);
      if (departDate) break;
    }
    if (!departDate) {
      skipped.push({ line, reason: '这行的日期认不出来', raw: rawPreview(cells) });
      continue;
    }
    const date = departDate;

    // 四档价格 = 航段列右侧连续 4 列，顺序固定
    const priceCells = cells.slice(flightIdx + 1, flightIdx + 1 + GROUND_TIER_COLUMNS.length);
    let hit = 0;
    GROUND_TIER_COLUMNS.forEach((tier, i) => {
      const price = parsePrice(priceCells[i] ?? '');
      if (price === null) return;
      hit += 1;
      byKey.set(`${date}__${nights}__${tier}`, {
        departDate: date,
        nights,
        tier,
        pricePerPersonCny: price,
      });
    });
    if (hit === 0) {
      skipped.push({ line, reason: '四档价格都不是数字（如「/」或空）', raw: rawPreview(cells) });
    }
  }

  const entries = [...byKey.values()].sort(
    (a, b) =>
      a.departDate.localeCompare(b.departDate) ||
      a.nights - b.nights ||
      GROUND_TIER_COLUMNS.indexOf(a.tier) - GROUND_TIER_COLUMNS.indexOf(b.tier),
  );
  return { entries, skipped };
}

/** OTA sheet 半张表的列序：日期 星期 航段 航班号 OTA结算 易达OTA结算。 */
const OTA_HALF_WIDTH = 6;
const OTA_DATE_COL = 0;
const OTA_FLIGHT_COL = 3;
const OTA_PRICE_COL = 4;

/**
 * OTA sheet（左右两张并排表）→ 机票结算价条目。
 *
 * 一行 12 列 = 左表 6 列 + 右表 6 列：
 *   日期 星期 航段 航班号 OTA结算 易达OTA结算 | 日期 星期 航段 航班号 OTA结算 易达OTA结算
 *   2026-08-08 星期六 澳门-岘港 QH9589 900 900 | 2026-08-08 星期六 岘港澳门 QH9588 售罄 955余1
 *
 * 每行拆成左右两条候选各自解析：
 *   • 权威价取「OTA结算」列（各半第 5 列），不取「易达」列；
 *   • 「售罄」「765余7」「1200结算余1」等非纯数字 → 该条跳过并列入跳过明细；
 *   • 右表日期可能是 Excel 序列号（如 46243），也可能与左表同格式，都兼容；
 *   • 只复制半张表（≥6 列不足 12 列）时按单表解析。
 * 同一 (出发日, 航班号) 重复出现时取最后一次。
 */
export function parseOtaQuoteSheet(
  text: string,
  baseMonth: string,
): QuoteSheetResult<OtaQuoteEntry> {
  const skipped: QuoteSheetSkippedRow[] = [];
  const byKey = new Map<string, OtaQuoteEntry>();

  for (const { line, cells } of toLines(text)) {
    const halves: Array<{ label: string; cells: string[] }> = [
      { label: '左表', cells: cells.slice(0, OTA_HALF_WIDTH) },
    ];
    if (cells.length > OTA_HALF_WIDTH) {
      halves.push({ label: '右表', cells: cells.slice(OTA_HALF_WIDTH, OTA_HALF_WIDTH * 2) });
    }

    for (const half of halves) {
      // 航班号 = 「这是一条数据行」的标志；表头/公告/空白半边都没有，静默跳过
      const flightMatch = FLIGHT_IN_CELL.exec((half.cells[OTA_FLIGHT_COL] ?? '').toUpperCase());
      if (!flightMatch) continue;
      const flightNumber = flightMatch[0];

      const dateRaw = half.cells[OTA_DATE_COL] ?? '';
      const departDate = parseQuoteDate(dateRaw, baseMonth);
      if (!departDate) {
        skipped.push({
          line,
          reason: `${half.label} ${flightNumber} 的日期「${dateRaw || '空'}」认不出来`,
          raw: rawPreview(half.cells),
        });
        continue;
      }

      const priceRaw = half.cells[OTA_PRICE_COL] ?? '';
      const price = parsePrice(priceRaw);
      if (price === null) {
        skipped.push({
          line,
          reason: `${half.label} ${departDate} ${flightNumber} 的 OTA结算「${priceRaw || '空'}」不是纯数字`,
          raw: rawPreview(half.cells),
        });
        continue;
      }

      byKey.set(`${departDate}__${flightNumber}`, {
        departDate,
        flightNumber,
        pricePerPersonCny: price,
      });
    }
  }

  const entries = [...byKey.values()].sort(
    (a, b) =>
      a.departDate.localeCompare(b.departDate) || a.flightNumber.localeCompare(b.flightNumber),
  );
  return { entries, skipped };
}
