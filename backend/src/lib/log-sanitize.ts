/**
 * 写日志前的截断 / 脱敏小工具（只影响日志内容，不改任何接口返回）。
 *
 * 三处可观测性日志共用：请求失败日志（plugins/error-handler）、前端报错上报（/client-errors）、
 * 护照 OCR 指标（modules/ocr）。原则是日志里只留「够定位问题」的最小信息：
 * 长文本截断、URL 去掉 query / hash、令牌形态抹掉、证件号 / 身份证号 / 手机号只留尾 4 位。
 */

/** 截断到 max 个字符（含末尾省略号）；不超长原样返回。 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - 1)}…`;
}

/** 去掉 query 与 hash：`/orders?search=x#top` → `/orders`。 */
export function stripQueryAndHash(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** 多行文本取第一段非空行（Prisma 校验错误等会把整段调用参数塞进多行消息里）。 */
export function firstNonEmptyLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return (line ?? '').trim();
}

// Bearer 令牌、JWT 形态、带 `=` 的 query / hash 参数（`?token=…&page=2`、`#access_token=…`）。
// query 段后面若紧跟调用栈的「:行:列」（`a.js?v=1:10:20`）则保留行列号，只去掉参数。
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const QUERY_WITH_PARAMS = /\?[^\s"'<>#()]*?=[^\s"'<>#()]*?((?::\d+){1,2})?(?=[\s"'<>#()]|$)/g;
const HASH_WITH_PARAMS = /#[^\s"'<>()]*=[^\s"'<>()]*/g;

/** 抹掉自由文本里的令牌与 URL 参数（URL 本身与调用栈行列号保留，只去掉参数段）。 */
export function scrubSecrets(text: string): string {
  return text
    .replace(BEARER_TOKEN, 'Bearer [redacted]')
    .replace(JWT_LIKE, '[jwt]')
    .replace(QUERY_WITH_PARAMS, '$1')
    .replace(HASH_WITH_PARAMS, '');
}

// 证件号：1–2 位大写字母 + 6–10 位数字（护照 E12345678 / EA1234567、港澳通行证 H12345678 等）；
// 身份证号：17 位数字 + 数字或 X；大陆手机号：1[3-9] 开头 11 位。
// 前后都要求词边界：订单号（FTM + 13 位数字）、航班号（3–4 位数字）、日期、Prisma 错误码都不会被误伤。
const DOCUMENT_NUMBER = /\b[A-Z]{1,2}\d{6,10}\b/g;
const CN_ID_NUMBER = /\b\d{17}[\dXx]\b/g;
const CN_MOBILE = /\b1[3-9]\d{9}\b/g;

function keepFirstAndLast4(token: string): string {
  if (token.length <= 5) return token;
  return `${token.slice(0, 1)}${'*'.repeat(token.length - 5)}${token.slice(-4)}`;
}

/** 证件号 / 身份证号 / 手机号只留首位与尾 4 位（`E12345678` → `E****5678`），够对单、不外泄全号。 */
export function maskPersonalIdentifiers(text: string): string {
  return text
    .replace(CN_ID_NUMBER, keepFirstAndLast4)
    .replace(DOCUMENT_NUMBER, keepFirstAndLast4)
    .replace(CN_MOBILE, keepFirstAndLast4);
}

/** 一站式：抹令牌 → 遮证件号 → 截断。先遮再截，避免截断把半个证件号漏在外面。 */
export function sanitizeLogText(text: string, max: number): string {
  return truncateText(maskPersonalIdentifiers(scrubSecrets(text)), max);
}
