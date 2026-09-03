/**
 * 航司 no-show 名单 → 本班次乘客的**匹配内核**（纯函数，零 IO，可单测）。
 *
 * 业务原样：票务每天收到航司发来的 no-show 名单，整块贴进后台。名单的形状完全不受我们控制 ——
 * 一行可能是「张三」「ZHANG/SAN」「SAN ZHANG」「张三 E12345678」「ZHANG SAN, E12345678」，
 * 分隔符空格 / 逗号（中英）/ 顿号 / 斜杠 / 制表符混着来。所以这里不做「按固定列切」，
 * 而是**逐行抽取线索、按优先级各试一遍**：
 *
 *   1. 护照号精确（最强证据，同名同姓也不会认错人）；
 *   2. 英文名归一化（去空格/斜杠/标点、大写，支持「姓/名」与「名 姓」两种顺序）；
 *   3. 中文名精确（去掉一切非汉字后逐字相等）。
 *
 * 一行命中多位不同乘客 → **不猜**，落 ambiguous 交人工点选：同团重名一旦猜错，
 * 就是给没 no-show 的客人打标、把他的回程座位放回库存重卖，事后极难查。
 *
 * ⚠ 对外只给证件号**后 4 位**（documentTail）：这张表会摊在票务的屏幕上，
 * 完整证件号没有任何理由出现在勾选列表里。
 */

import { createHash } from 'node:crypto';

// ── 分词 ────────────────────────────────────────────────────────────────────

/** 行分隔：\n / \r\n（整块粘贴的名单一行一人）。 */
const LINE_SEPARATORS = /\r\n|\r|\n/;

/**
 * 行内分隔符：空格（含制表）、英文逗号、中文逗号、顿号、斜杠（含全角）、反斜杠、点、连字符、竖线。
 * 斜杠既是 PNR 姓名的「姓/名」分隔符、也是名单里常见的字段分隔符 —— 两种用法都按分隔符切开，
 * 姓名的顺序问题交给下面的 key 生成（正序 + 两种轮转）兜住。
 */
const INLINE_SEPARATORS = /[\s,，、/／\\.\-_|]+/u;

/** 汉字区间（含扩展 A 与兼容区）。 */
const CJK_CHAR = /[㐀-䶿一-鿿豈-﫿]/u;
const NON_CJK_GLOBAL = /[^㐀-䶿一-鿿豈-﫿]/gu;

/** 单次最多解析多少行（防误传整本表格把接口拖死）。 */
export const NO_SHOW_ROSTER_MAX_LINES = 500;

/**
 * 整块名单文本 → 逐行（trim、去空行、按原文去重、截断到上限）。
 * 去重按 trim 后的原文：航司名单里同一个人贴两遍很常见，重复行会让勾选列表出现两条一模一样的记录。
 */
export function parseRosterLines(
  names: string,
  limit: number = NO_SHOW_ROSTER_MAX_LINES,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(names ?? '').split(LINE_SEPARATORS)) {
    const line = raw.trim();
    if (line === '') continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

/** 一行拆成词（大写、去空词）：汉字与其它非 ASCII 一律当分隔符，只留拉丁字母与数字。 */
function latinTokens(raw: string): string[] {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^\x20-\x7e]/g, ' ')
    .split(INLINE_SEPARATORS)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

/** 只留纯字母的词（带数字的词是证件号，不是名字）。 */
function nameTokens(raw: string): string[] {
  return latinTokens(raw).filter((t) => /^[A-Z]+$/.test(t));
}

/** 证件号归一化：去掉一切非字母数字后大写。 */
export function normalizeDocumentNumber(raw: string | null | undefined): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** 证件号后 4 位（不足 4 位原样给；空值给空串）。对外只出现这个。 */
export function documentTail(raw: string | null | undefined): string {
  const doc = normalizeDocumentNumber(raw);
  return doc.length <= 4 ? doc : doc.slice(-4);
}

/** 中文名归一化：去掉一切非汉字（空格、间隔号、括注一律不参与比对）。 */
export function normalizeChineseName(raw: string | null | undefined): string {
  return String(raw ?? '').replace(NON_CJK_GLOBAL, '');
}

/**
 * 姓名 → 归一化比对键集合（大写、无分隔符）。
 *
 * 生成三到四把键，覆盖名单里的常见写法：
 *   · 「姓/名」写法（PNR 标准）→ 姓+名 与 名+姓 两把；
 *   · 无斜杠的多词写法 → 正序、末词提到最前、首词挪到最后 三把
 *     （拼音姓恒为单词，这三把足以覆盖「姓 名」↔「名 姓」互换）。
 * 已经粘在一起的单词姓名（ZHANGSAN）只有一把，正好等于上面的正序键。
 */
export function buildNameKeys(raw: string | null | undefined): string[] {
  const source = String(raw ?? '');
  const keys = new Set<string>();

  const slash = source.search(/[/／\\]/u);
  if (slash >= 0) {
    const surname = nameTokens(source.slice(0, slash)).join('');
    const given = nameTokens(source.slice(slash + 1)).join('');
    if (surname !== '' && given !== '') {
      keys.add(surname + given);
      keys.add(given + surname);
    }
  }

  const tokens = nameTokens(source);
  if (tokens.length === 1) {
    keys.add(tokens[0]);
  } else if (tokens.length > 1) {
    keys.add(tokens.join(''));
    keys.add([tokens[tokens.length - 1], ...tokens.slice(0, -1)].join(''));
    keys.add([...tokens.slice(1), tokens[0]].join(''));
  }
  return [...keys];
}

// ── 匹配 ────────────────────────────────────────────────────────────────────

/** 参与匹配的一位乘客（调用方从本班次去程占座单里捞出来）。 */
export interface RosterCandidate {
  orderId: string;
  orderNumber: string;
  passengerId: string;
  fullName: string;
  chineseName: string | null;
  /** 完整证件号**只在服务端内部用于精确匹配**，绝不出现在响应里（响应给 documentTail）。 */
  documentNumber: string;
  lastName?: string | null;
  firstName?: string | null;
}

export type RosterMatchedBy = 'DOCUMENT' | 'NAME' | 'CHINESE_NAME';

export interface RosterMatchedLine {
  line: string;
  matchedBy: RosterMatchedBy;
  candidate: RosterCandidate;
}

export interface RosterAmbiguousLine {
  line: string;
  candidates: RosterCandidate[];
}

export interface RosterMatchResult {
  matched: RosterMatchedLine[];
  unmatched: string[];
  ambiguous: RosterAmbiguousLine[];
}

/** 多值索引：key → 候选人列表（按 passengerId 去重）。 */
function pushIndex(
  index: Map<string, RosterCandidate[]>,
  key: string,
  candidate: RosterCandidate,
): void {
  if (key === '') return;
  const bucket = index.get(key);
  if (!bucket) {
    index.set(key, [candidate]);
    return;
  }
  if (!bucket.some((c) => c.passengerId === candidate.passengerId)) bucket.push(candidate);
}

function dedupe(candidates: readonly RosterCandidate[]): RosterCandidate[] {
  const seen = new Set<string>();
  const out: RosterCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.passengerId)) continue;
    seen.add(c.passengerId);
    out.push(c);
  }
  return out;
}

/**
 * 逐行匹配名单。
 *
 * 优先级 护照号 → 英文名 → 中文名：证件号是最强证据，能命中就不再看名字
 *（同名同姓的两个人靠名字永远分不开，靠证件号一次到位）。
 * 命中多位不同乘客 → ambiguous（不猜）；一位都没命中 → unmatched。
 */
export function matchRosterLines(
  lines: readonly string[],
  candidates: readonly RosterCandidate[],
): RosterMatchResult {
  const byDoc = new Map<string, RosterCandidate[]>();
  const byNameKey = new Map<string, RosterCandidate[]>();
  const byChinese = new Map<string, RosterCandidate[]>();

  for (const c of candidates) {
    pushIndex(byDoc, normalizeDocumentNumber(c.documentNumber), c);
    for (const key of buildNameKeys(c.fullName)) pushIndex(byNameKey, key, c);
    if (c.lastName && c.firstName) {
      for (const key of buildNameKeys(`${c.lastName}/${c.firstName}`)) pushIndex(byNameKey, key, c);
    }
    // 中文名可能存在 chineseName 列，也可能被直接录进 fullName（老单常见）。
    pushIndex(byChinese, normalizeChineseName(c.chineseName), c);
    if (CJK_CHAR.test(c.fullName)) pushIndex(byChinese, normalizeChineseName(c.fullName), c);
  }

  const matched: RosterMatchedLine[] = [];
  const unmatched: string[] = [];
  const ambiguous: RosterAmbiguousLine[] = [];

  for (const line of lines) {
    const hit = resolveLine(line, byDoc, byNameKey, byChinese);
    if (hit == null) {
      unmatched.push(line);
    } else if (hit.candidates.length === 1) {
      matched.push({ line, matchedBy: hit.matchedBy, candidate: hit.candidates[0] });
    } else {
      ambiguous.push({ line, candidates: hit.candidates });
    }
  }

  return { matched, unmatched, ambiguous };
}

/** 单行 → 命中的候选人（按优先级各试一遍；一个都没命中返回 null）。 */
function resolveLine(
  line: string,
  byDoc: Map<string, RosterCandidate[]>,
  byNameKey: Map<string, RosterCandidate[]>,
  byChinese: Map<string, RosterCandidate[]>,
): { matchedBy: RosterMatchedBy; candidates: RosterCandidate[] } | null {
  // ① 护照号：行内每个「含数字的词」都试一遍，另外整行去分隔符也试一次
  //    （名单里偶见「E1234 5678」这种被空格劈开的证件号）。
  const docCandidates: RosterCandidate[] = [];
  const tried = new Set<string>();
  const docTokens = [
    ...latinTokens(line).filter((t) => /\d/.test(t)),
    normalizeDocumentNumber(line),
  ];
  for (const token of docTokens) {
    const norm = normalizeDocumentNumber(token);
    if (norm.length < 5 || tried.has(norm)) continue;
    tried.add(norm);
    const hits = byDoc.get(norm);
    if (hits) docCandidates.push(...hits);
  }
  if (docCandidates.length > 0) return { matchedBy: 'DOCUMENT', candidates: dedupe(docCandidates) };

  // ② 英文名归一化（姓/名 与 名 姓 两种顺序都能命中）。
  const nameCandidates: RosterCandidate[] = [];
  for (const key of buildNameKeys(line)) {
    const hits = byNameKey.get(key);
    if (hits) nameCandidates.push(...hits);
  }
  if (nameCandidates.length > 0) return { matchedBy: 'NAME', candidates: dedupe(nameCandidates) };

  // ③ 中文名精确。
  const cn = normalizeChineseName(line);
  if (cn !== '') {
    const hits = byChinese.get(cn);
    if (hits && hits.length > 0) return { matchedBy: 'CHINESE_NAME', candidates: dedupe(hits) };
  }
  return null;
}

// ── 批次内的逐单幂等键 ───────────────────────────────────────────────────────

/**
 * 批次令牌命名空间（生成一次后**永久固定**）。
 * 改动它会让同一批名单在重试时算出另一组 token，幂等回放全部失效、座位被二次释放。
 */
const NO_SHOW_BATCH_NAMESPACE = '3f2b7c14-9d6e-4a58-8b1f-27c5e0a49d63';

/**
 * RFC 4122 UUID v5（SHA-1 命名空间派生）。
 * 自己实现而不是引依赖：只有十来行，而且这里要的是「稳定、可复算」，不是一个新的三方包。
 */
export function uuidV5(name: string, namespace: string = NO_SHOW_BATCH_NAMESPACE): string {
  const nsHex = namespace.replace(/-/g, '');
  const hash = createHash('sha1')
    .update(Buffer.from(nsHex, 'hex'))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * 批次里某一单的幂等键：由「整批 requestToken + 订单 id」稳定派生。
 *
 * 为什么不能让前端给每单各发一个随机 token：整批重试时前端会重新生成，
 * 上一轮已经标好的单会被当成新请求再跑一遍 —— 回程座位放两次。
 * v5 派生保证「同一批 + 同一单」永远算出同一个 uuid，既满足 markNoShow 的 uuid 校验，
 * 又让整批重试天然落进既有的逐单幂等回放。
 */
export function deriveBatchOrderToken(requestToken: string, orderId: string): string {
  return uuidV5(`${requestToken}:${orderId}`);
}
