/**
 * 结算价日历网格共用工具（地面档次日历 + 机票航班日历共用）。
 *
 * 两张日历的行都是「起始日期起连续 31 天」，列不同（地面=晚数，机票=航班号），
 * 但日期展开 / 星期展示 / Excel 粘贴取数的口径必须一致，故抽到这里单一实现。
 * 一律走 UTC 历法：date-only 语义只认年月日，绝不让本地时区把日期挪前一天。
 */

/** 星期中文（0=日），与 weekdayOf 返回值下标对应。 */
export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
/** 日历滚动窗口长度；两个结算价页签共用。 */
export const WINDOW_DAYS = 31;

/** 当前本地日期（YYYY-MM-DD），日历默认起始日期。 */
export function todayYmd(): string {
  const d = new Date();
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseYmd(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(ymd);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function formatYmd(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** 按 UTC 历法移动 YMD；非法日期或步长返回空串。 */
export function addDays(ymd: string, amount: number): string {
  const date = parseYmd(ymd);
  if (!date || !Number.isSafeInteger(amount)) return '';
  date.setUTCDate(date.getUTCDate() + amount);
  return Number.isNaN(date.getTime()) ? '' : formatYmd(date);
}

/** 从起始日（含）起展开连续 count 天的 YMD 列表（UTC 历法，避免时区跨日）。非法输入返回空数组。 */
export function windowDays(startYmd: string, count: number): string[] {
  const start = parseYmd(startYmd);
  if (!start || !Number.isSafeInteger(count) || count <= 0) return [];
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return formatYmd(date);
  });
}

/** YMD → 周几（0=日）；纯 UTC，展示星期列用。 */
export function weekdayOf(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(ymd);
  if (!m) return 0;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/** 粘贴单元格里的数字：去掉 ¥ / 逗号 / 空格，保留纯数字串（空串 = 清空该格）。 */
export function normalizePasteCell(raw: string): string {
  return raw.replace(/[¥,\s]/gu, '').trim();
}

/**
 * Excel 块状粘贴解析：剪贴板文本 → 二维单元格数组（行按换行、列按 tab）。
 * 已去掉末尾空行并对每格做 normalizePasteCell；单值（无 tab/换行）返回 null，
 * 由调用方交还浏览器默认粘贴行为。
 */
export function parsePasteBlock(text: string): string[][] | null {
  if (!text || (!text.includes('\t') && !text.includes('\n'))) return null;
  return text
    .replace(/\r/gu, '')
    .split('\n')
    .filter((row, i, arr) => !(i === arr.length - 1 && row === ''))
    .map((row) => row.split('\t').map(normalizePasteCell));
}
