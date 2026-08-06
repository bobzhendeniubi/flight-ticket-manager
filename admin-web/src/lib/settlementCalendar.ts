/**
 * 结算价日历网格共用工具（地面档次日历 + 机票航班日历共用）。
 *
 * 两张日历的行都是「当月每天」，列不同（地面=晚数，机票=航班号），
 * 但月份展开 / 星期展示 / Excel 粘贴取数的口径必须一致，故抽到这里单一实现。
 * 一律走 UTC 历法：date-only 语义只认年月日，绝不让本地时区把日期挪前一天。
 */

/** 星期中文（0=日），与 weekdayOf 返回值下标对应。 */
export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 当前月份（YYYY-MM），日历默认值。 */
export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 某月（YYYY-MM）→ 该月每天的 YMD 列表（UTC 历法，避免时区跨日）。非法输入返回空数组。 */
export function daysInMonth(ym: string): string[] {
  const m = /^(\d{4})-(\d{2})$/u.exec(ym);
  if (!m) return [];
  const year = Number(m[1]);
  const month = Number(m[2]);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
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
