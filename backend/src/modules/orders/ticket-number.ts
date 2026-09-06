/**
 * 真实 PNR / 电子票号的**校验内核**（纯函数、零 IO，单人回填与整班批量回填共用）。
 *
 * 为什么单独一个文件：票号既可以一个一个改（订单详情乘客卡），也可以整班贴名单批量灌
 *（票号批量回填页）。两条路要是各写一套「什么算合法票号」，早晚一边收得进、另一边收不进，
 * 而票号是拿去跟航司对账的东西，两套口径就是两本账。
 *
 * 口径（与票务岗手上的票面一致，不自作聪明）：
 *   · PNR（订座编码）  5–8 位大写字母数字。航司主流是 6 位，部分系统给 5 位或带后缀到 8 位，
 *                      全部放行；分隔符（空格 / 连字符）在归一化时去掉。
 *   · 电子票号         10–17 位纯数字。真实航司票号是 13 位（3 位航司代码 + 10 位流水，
 *                      票面常写成 784-1234567890），沙箱自动出票生成的是 17 位；两种都放行，
 *                      免得「先按 17 位存了一批号、现在换真号反而存不进去」。
 *
 * 归一化只去**空格与连字符**，不做别的清洗：把「784ABC1234567890」里的字母悄悄抹掉再存，
 * 存进去的就是一个谁也对不上的号 —— 宁可报错让人重贴。
 */

/** PNR：归一化后必须整串命中。 */
export const PNR_PATTERN = /^[A-Z0-9]{5,8}$/;
/** 电子票号：归一化后必须整串命中（10–17 位纯数字，覆盖真实 13 位与沙箱 17 位）。 */
export const ETICKET_PATTERN = /^\d{10,17}$/;

/** 面向操作人的错误文案（单人 / 批量两条路共用一份，措辞不分叉）。 */
export const PNR_FORMAT_MESSAGE = 'PNR（订座编码）应为 5–8 位字母或数字';
export const ETICKET_FORMAT_MESSAGE =
  '电子票号应为 10–17 位数字（真实票号 13 位；票面上的 784-… 连字符可省可留）';

/** 只去空格与连字符（含各种全角/长短横），别的字符原样留着，好让校验把问题暴露出来。 */
function stripSeparators(raw: string): string {
  return raw.replace(/[\s\-－‐‑‒–—]/gu, '');
}

/**
 * PNR 归一化：去分隔符 + 大写。
 * 输入空 / 全空白 → 空串（调用方按「这一格没填」处理，别当成「填了个空 PNR」）。
 */
export function normalizePnr(raw: string | null | undefined): string {
  return stripSeparators(String(raw ?? '')).toUpperCase();
}

/**
 * 电子票号归一化：去分隔符（票面的 784-1234567890 → 7841234567890）。
 * 不去别的字符 —— 混进字母的串必须校验失败，不能被悄悄修剪成一个合法长度的假号。
 */
export function normalizeEticketNumber(raw: string | null | undefined): string {
  return stripSeparators(String(raw ?? ''));
}

/** 入参是**归一化之后**的串（先 normalizePnr 再判，别拿原文来问）。 */
export function isValidPnr(normalized: string): boolean {
  return PNR_PATTERN.test(normalized);
}

/** 入参是**归一化之后**的串（先 normalizeEticketNumber 再判）。 */
export function isValidEticketNumber(normalized: string): boolean {
  return ETICKET_PATTERN.test(normalized);
}
