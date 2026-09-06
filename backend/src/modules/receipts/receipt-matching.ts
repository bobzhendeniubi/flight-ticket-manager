/**
 * 流水匹配引擎（认款建议）—— 纯函数，不碰数据库、不写任何东西。
 *
 * 业务：财务把收单平台流水导进池子后，要把每笔钱认到订单上。此前前端只认
 * 「一笔流水金额 == 一张订单尾款」这一种线索，其余全靠人工拖。这里把线索放宽到
 * 金额关系 + 身份线索（备注里的订单号 / 乘客姓名 / 代理名 / 手机尾号 / 客户自报的
 * 疑似订单）+ 时间邻近，给每笔流水算出候选订单列表，并按置信度分档。
 *
 * **只出建议，不入账。** 入账仍走 receipts.service.allocate / allocateBatch 内核与全部资金闸；
 * 这里给的 suggestedAmountCents 只是「默认填多少」，最终以人工确认为准。
 *
 * 金额一律用「分」的整数比较——0.1+0.2 那种浮点误差在钱上不能容忍。
 *
 * 置信度规则（单笔候选）：
 *   HIGH   = 金额精确 + 至少一个身份线索，且**双向唯一**（这笔流水只有这一张「精确+身份」候选，
 *            这张订单也只被这一笔流水「精确+身份」命中）。只有 HIGH 才允许前端勾选后一键认款。
 *   MEDIUM = 金额精确 + 身份线索但不唯一（同额多候选降级）；
 *            或 金额精确但无身份线索且双向唯一；
 *            或 身份线索强（订单号 / 疑似订单 / 两条弱线索叠加）但金额是部分付款（< 尾款）。
 *   LOW    = 其余（金额精确无身份且撞车 / 弱身份 + 部分付款 / 流水大于尾款 + 身份线索）。
 *   不成候选：只有金额部分/覆盖关系而无任何身份线索（噪音太大，等于把每笔小钱推荐给每张大单）。
 *
 * 组合建议（独立类型，永不 HIGH，永远要人看一眼）：
 *   MANY_RECEIPTS_ONE_ORDER  同付款人 / 同代理、同一北京日、≤3 笔之和 == 某单尾款。
 *   ONE_RECEIPT_MANY_ORDERS  同代理 / 同联系人手机的 ≤3 张订单尾款之和 == 流水余额。
 */
import { businessDateISO } from '../../lib/business-time.js';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type MatchReason =
  /** 流水未认余额 == 订单尾款 */
  | 'AMOUNT_EXACT'
  /** 流水未认余额 < 订单尾款（部分付款） */
  | 'AMOUNT_PARTIAL'
  /** 流水未认余额 > 订单尾款（认掉尾款后还有剩） */
  | 'AMOUNT_COVERS'
  /** 付款备注含订单号 */
  | 'REMARK_HAS_ORDER_NO'
  /** 进账上带的疑似归属订单（客户上传/财务登记时自报）指向该单 */
  | 'ORDER_HINT'
  /** 付款备注含联系人或乘客姓名 */
  | 'REMARK_HAS_PASSENGER_NAME'
  /** 付款人/备注含代理公司名或代理联系人 */
  | 'PAYER_MATCHES_AGENT'
  /** 付款备注含联系人/代理手机（全号或尾号 4 位） */
  | 'PHONE_TAIL'
  /** 到账时间在下单前 1 天 ~ 下单后 N 天内 */
  | 'DATE_NEAR';

export type ComboReason =
  | MatchReason
  /** 各部分金额之和精确相等 */
  | 'AMOUNT_SUM_EXACT'
  /** 多笔流水来自同一付款人（付款备注一致） */
  | 'SAME_PAYER'
  /** 多笔流水都指向同一代理 / 多张订单同属一个代理 */
  | 'SAME_AGENT'
  /** 多张订单同一联系人手机 */
  | 'SAME_CONTACT'
  /** 多笔流水同一北京日到账 */
  | 'SAME_DAY';

export type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** 引擎输入：一笔未认完的进账（金额为分）。 */
export interface MatchReceipt {
  id: string;
  /** 未认余额（分，> 0 才参与） */
  remainingCents: number;
  receivedAt: Date;
  payerNote: string | null;
  orderHintId: string | null;
}

/** 引擎输入：一张待收款订单（金额为分）。 */
export interface MatchOrder {
  orderId: string;
  orderNumber: string;
  contactName: string;
  contactPhone: string | null;
  /** 乘客姓名（fullName / chineseName 都给，引擎自己归一化去重） */
  passengerNames: readonly string[];
  agentId: string | null;
  /** 代理公司名 + 代理联系人（有几个给几个） */
  agentNames: readonly string[];
  agentPhone: string | null;
  createdAt: Date;
  /** 尾款（分，> 0 才参与） */
  balanceDueCents: number;
}

export interface MatchCandidate {
  orderId: string;
  score: number;
  reasons: MatchReason[];
  confidence: MatchConfidence;
  /** 建议认款金额 = min(流水余额, 订单尾款)（分） */
  suggestedAmountCents: number;
}

export interface ReceiptMatch {
  receiptId: string;
  /** 按置信度 → 分数排序，已截断到 maxCandidatesPerReceipt */
  candidates: MatchCandidate[];
}

export type ComboType = 'MANY_RECEIPTS_ONE_ORDER' | 'ONE_RECEIPT_MANY_ORDERS';

export interface ComboPart {
  receiptId: string;
  orderId: string;
  amountCents: number;
}

export interface ComboSuggestion {
  type: ComboType;
  receiptIds: string[];
  orderIds: string[];
  /** 逐条认款计划（前端照此调 allocate-batch；金额为分） */
  parts: ComboPart[];
  totalCents: number;
  reasons: ComboReason[];
  confidence: Extract<MatchConfidence, 'MEDIUM' | 'LOW'>;
  score: number;
}

export interface MatchResult {
  receipts: ReceiptMatch[];
  combos: ComboSuggestion[];
}

export interface MatchOptions {
  /** 每笔流水最多回几张候选（默认 5） */
  maxCandidatesPerReceipt?: number;
  /** 组合建议总数上限（默认 50） */
  maxCombos?: number;
  /** DATE_NEAR 的「下单后 N 天」（默认 30） */
  dateNearDays?: number;
  /** 组合最多几部分（默认 3；与产品口径一致，改大会指数级放大噪音） */
  comboMaxParts?: number;
  /** 参与组合枚举的每个分桶最多几条（默认 12；C(12,3)=220 次求和，上限可控） */
  comboBucketCap?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 权重表（分数只用于排序；置信度是规则判定，不是阈值）
// ─────────────────────────────────────────────────────────────────────────────

export const MATCH_REASON_WEIGHT: Readonly<Record<MatchReason, number>> = {
  AMOUNT_EXACT: 50,
  AMOUNT_PARTIAL: 15,
  AMOUNT_COVERS: 5,
  REMARK_HAS_ORDER_NO: 40,
  ORDER_HINT: 35,
  REMARK_HAS_PASSENGER_NAME: 25,
  PAYER_MATCHES_AGENT: 20,
  PHONE_TAIL: 20,
  DATE_NEAR: 5,
};

export const COMBO_REASON_WEIGHT: Readonly<Record<Exclude<ComboReason, MatchReason>, number>> = {
  AMOUNT_SUM_EXACT: 40,
  SAME_PAYER: 15,
  SAME_AGENT: 20,
  SAME_CONTACT: 15,
  SAME_DAY: 5,
};

const IDENTITY_REASONS: ReadonlySet<MatchReason> = new Set<MatchReason>([
  'REMARK_HAS_ORDER_NO',
  'ORDER_HINT',
  'REMARK_HAS_PASSENGER_NAME',
  'PAYER_MATCHES_AGENT',
  'PHONE_TAIL',
]);

/** 身份线索「强」的门槛：订单号 / 疑似订单单独就够；姓名 + 代理、姓名 + 尾号等两条弱线索叠加也够。 */
const STRONG_IDENTITY_MIN_WEIGHT = 40;

const DEFAULTS: Required<MatchOptions> = {
  maxCandidatesPerReceipt: 5,
  maxCombos: 50,
  dateNearDays: 30,
  comboMaxParts: 3,
  comboBucketCap: 12,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// 文本归一化
// ─────────────────────────────────────────────────────────────────────────────

/** 金额 → 分（整数）。四舍五入到分，防 1000.01 这类浮点尾巴。 */
export function toCents(amount: number | string | { toString(): string }): number {
  const n = typeof amount === 'number' ? amount : Number(String(amount));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** 全角→半角、小写、去空白与常见标点，供包含判定用。 */
export function normalizeText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_/\\.,，。、·:：;；()（）[\]【】"'“”‘’<>《》|]+/g, '');
}

const CJK_RE = /[㐀-鿿]/;

/**
 * 姓名/代理名归一化后是否够「独特」到可做包含判定：
 * 含中文 ≥ 2 字；纯字母数字 ≥ 3 位（"ab" 这种在付款人 ID 里随处可见，不算线索）。
 */
function isDistinctiveToken(norm: string): boolean {
  if (!norm) return false;
  return CJK_RE.test(norm) ? norm.length >= 2 : norm.length >= 3;
}

const AGENT_SUFFIX_RE = /(国际旅行社|旅行社|有限责任公司|股份有限公司|有限公司|公司|旅游|国旅)$/;

/** 代理名去掉「有限公司 / 旅行社」这类后缀取核心词（备注里通常只写核心词）。 */
function agentNameCores(name: string): string[] {
  const full = normalizeText(name);
  const out = new Set<string>();
  if (isDistinctiveToken(full)) out.add(full);
  let core = full;
  for (let i = 0; i < 3; i += 1) {
    const next = core.replace(AGENT_SUFFIX_RE, '');
    if (next === core) break;
    core = next;
    if (isDistinctiveToken(core)) out.add(core);
  }
  return [...out];
}

/** 手机号 → 纯数字（去 +86 / 空格 / 横线）。 */
function phoneDigits(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.normalize('NFKC').replace(/\D+/g, '');
  return digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits;
}

/** 备注里的所有数字串（用于订单号数字核 / 手机尾号的整串等值比对，避免子串误命中）。 */
function digitRuns(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.normalize('NFKC').match(/\d+/g) ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 预处理
// ─────────────────────────────────────────────────────────────────────────────

interface PreparedReceipt {
  src: MatchReceipt;
  note: string;
  runs: ReadonlySet<string>;
  /** 北京业务日（组合「同一天」用） */
  day: string;
}

interface PreparedOrder {
  src: MatchOrder;
  orderNo: string;
  /** 订单号纯数字核（≥ 8 位才用，短了撞车） */
  orderNoDigits: string | null;
  names: string[];
  agentCores: string[];
  phones: Array<{ full: string; tail: string }>;
}

function prepareReceipt(r: MatchReceipt): PreparedReceipt {
  return {
    src: r,
    note: normalizeText(r.payerNote),
    runs: new Set(digitRuns(r.payerNote)),
    day: businessDateISO(r.receivedAt),
  };
}

function prepareOrder(o: MatchOrder): PreparedOrder {
  const orderNo = normalizeText(o.orderNumber);
  const digitsOnly = orderNo.replace(/\D+/g, '');
  const names = new Set<string>();
  for (const raw of [o.contactName, ...o.passengerNames]) {
    const n = normalizeText(raw);
    if (isDistinctiveToken(n)) names.add(n);
  }
  const agentCores = new Set<string>();
  for (const raw of o.agentNames) {
    for (const core of agentNameCores(raw)) agentCores.add(core);
  }
  const phones: Array<{ full: string; tail: string }> = [];
  for (const raw of [o.contactPhone, o.agentPhone]) {
    const d = phoneDigits(raw);
    if (d.length >= 7) phones.push({ full: d, tail: d.slice(-4) });
  }
  return {
    src: o,
    orderNo,
    orderNoDigits: digitsOnly.length >= 8 ? digitsOnly : null,
    names: [...names],
    agentCores: [...agentCores],
    phones,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 单笔候选：理由判定
// ─────────────────────────────────────────────────────────────────────────────

function amountReason(remainingCents: number, balanceCents: number): MatchReason {
  if (remainingCents === balanceCents) return 'AMOUNT_EXACT';
  return remainingCents < balanceCents ? 'AMOUNT_PARTIAL' : 'AMOUNT_COVERS';
}

/** 一笔流水 × 一张订单的全部理由（顺序固定，便于测试断言与前端展示）。 */
export function collectReasons(
  receipt: MatchReceipt,
  order: MatchOrder,
  options: Pick<MatchOptions, 'dateNearDays'> = {},
): MatchReason[] {
  return collectReasonsPrepared(prepareReceipt(receipt), prepareOrder(order), {
    ...DEFAULTS,
    ...options,
  });
}

function collectReasonsPrepared(
  r: PreparedReceipt,
  o: PreparedOrder,
  options: Required<MatchOptions>,
): MatchReason[] {
  const reasons: MatchReason[] = [amountReason(r.src.remainingCents, o.src.balanceDueCents)];

  const hasOrderNo =
    (o.orderNo.length > 0 && r.note.includes(o.orderNo)) ||
    (o.orderNoDigits != null && r.runs.has(o.orderNoDigits));
  if (hasOrderNo) reasons.push('REMARK_HAS_ORDER_NO');

  if (r.src.orderHintId && r.src.orderHintId === o.src.orderId) reasons.push('ORDER_HINT');

  if (r.note && o.names.some((n) => r.note.includes(n))) reasons.push('REMARK_HAS_PASSENGER_NAME');

  if (r.note && o.agentCores.some((c) => r.note.includes(c))) reasons.push('PAYER_MATCHES_AGENT');

  if (
    r.runs.size > 0 &&
    o.phones.some((p) => r.runs.has(p.full) || (p.tail.length === 4 && r.runs.has(p.tail)))
  ) {
    reasons.push('PHONE_TAIL');
  }

  const delta = r.src.receivedAt.getTime() - o.src.createdAt.getTime();
  if (delta >= -DAY_MS && delta <= options.dateNearDays * DAY_MS) reasons.push('DATE_NEAR');

  return reasons;
}

function hasIdentity(reasons: readonly MatchReason[]): boolean {
  return reasons.some((x) => IDENTITY_REASONS.has(x));
}

function identityWeight(reasons: readonly MatchReason[]): number {
  return reasons.reduce((acc, x) => acc + (IDENTITY_REASONS.has(x) ? MATCH_REASON_WEIGHT[x] : 0), 0);
}

export function scoreReasons(reasons: readonly MatchReason[]): number {
  return reasons.reduce((acc, x) => acc + MATCH_REASON_WEIGHT[x], 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 单笔候选：打分 + 置信度
// ─────────────────────────────────────────────────────────────────────────────

interface RawCandidate {
  receiptId: string;
  orderId: string;
  reasons: MatchReason[];
  score: number;
  exact: boolean;
  identity: boolean;
  suggestedAmountCents: number;
  /** |到账 − 下单| 毫秒，同分时更贴近下单时间的排前 */
  timeGapMs: number;
  orderNumber: string;
}

const CONFIDENCE_RANK: Record<MatchConfidence, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** 键分隔符用控制字符 US（\u001f），id / 备注 / 日期里绝不会出现，杜绝拼接歧义。 */
const KEY_SEP = '\u001f';

function pairKey(receiptId: string, orderId: string): string {
  return `${receiptId}${KEY_SEP}${orderId}`;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * 置信度判定（需要全局计数：同额多候选 / 同单多流水 都要降级）。
 * exactIdentityByReceipt / exactIdentityByOrder：「精确 + 身份」候选在两个方向上的数量。
 * exactByReceipt / exactByOrder：「精确」候选（不论身份）在两个方向上的数量。
 */
function decideConfidence(
  c: RawCandidate,
  counts: {
    exactIdentityByReceipt: Map<string, number>;
    exactIdentityByOrder: Map<string, number>;
    exactByReceipt: Map<string, number>;
    exactByOrder: Map<string, number>;
  },
): MatchConfidence {
  if (c.exact && c.identity) {
    const uniqueBothWays =
      (counts.exactIdentityByReceipt.get(c.receiptId) ?? 0) === 1 &&
      (counts.exactIdentityByOrder.get(c.orderId) ?? 0) === 1;
    return uniqueBothWays ? 'HIGH' : 'MEDIUM';
  }
  if (c.exact) {
    const uniqueBothWays =
      (counts.exactByReceipt.get(c.receiptId) ?? 0) === 1 &&
      (counts.exactByOrder.get(c.orderId) ?? 0) === 1;
    return uniqueBothWays ? 'MEDIUM' : 'LOW';
  }
  // 非精确：只有部分付款 + 强身份才到 MEDIUM；覆盖（流水 > 尾款）一律 LOW
  const partial = c.reasons.includes('AMOUNT_PARTIAL');
  if (partial && identityWeight(c.reasons) >= STRONG_IDENTITY_MIN_WEIGHT) return 'MEDIUM';
  return 'LOW';
}

function compareCandidates(
  a: { confidence: MatchConfidence; score: number; timeGapMs: number; orderNumber: string },
  b: { confidence: MatchConfidence; score: number; timeGapMs: number; orderNumber: string },
): number {
  const byConf = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
  if (byConf !== 0) return byConf;
  if (a.score !== b.score) return b.score - a.score;
  if (a.timeGapMs !== b.timeGapMs) return a.timeGapMs - b.timeGapMs;
  return a.orderNumber < b.orderNumber ? -1 : a.orderNumber > b.orderNumber ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 组合枚举（≤ N 个元素的子集求和，桶内元素有上限，复杂度可控）
// ─────────────────────────────────────────────────────────────────────────────

interface SubsetHit<T> {
  items: T[];
  sumCents: number;
}

/** 枚举 2..maxParts 元素的子集（items 已按桶上限截断）。 */
function enumerateSubsets<T>(
  items: readonly T[],
  amountOf: (t: T) => number,
  maxParts: number,
): SubsetHit<T>[] {
  const out: SubsetHit<T>[] = [];
  const n = items.length;
  const pick = (start: number, chosen: T[], sum: number): void => {
    if (chosen.length >= 2) out.push({ items: [...chosen], sumCents: sum });
    if (chosen.length >= maxParts) return;
    for (let i = start; i < n; i += 1) {
      chosen.push(items[i]);
      pick(i + 1, chosen, sum + amountOf(items[i]));
      chosen.pop();
    }
  };
  pick(0, [], 0);
  return out;
}

/** 把子集按和分组：cents → 子集列表。 */
function indexBySum<T>(hits: SubsetHit<T>[]): Map<number, SubsetHit<T>[]> {
  const map = new Map<number, SubsetHit<T>[]>();
  for (const h of hits) {
    const list = map.get(h.sumCents);
    if (list) list.push(h);
    else map.set(h.sumCents, [h]);
  }
  return map;
}

function scoreCombo(reasons: readonly ComboReason[]): number {
  return reasons.reduce((acc, x) => {
    const w =
      x in MATCH_REASON_WEIGHT
        ? MATCH_REASON_WEIGHT[x as MatchReason]
        : COMBO_REASON_WEIGHT[x as Exclude<ComboReason, MatchReason>];
    return acc + w;
  }, 0);
}

function uniqueReasons(list: readonly ComboReason[]): ComboReason[] {
  return [...new Set(list)];
}

/**
 * 同一个（流水集合 → 订单集合）组合可能被不同分桶各找到一次（例如既是同付款人又是同代理）。
 * 撞键时合并理由、取更高的置信度、重算分数——而不是把后到的（往往线索更强的）那份丢掉。
 */
function mergeCombo(into: Map<string, ComboSuggestion>, key: string, combo: ComboSuggestion): void {
  const existing = into.get(key);
  if (!existing) {
    into.set(key, combo);
    return;
  }
  const reasons = uniqueReasons([...existing.reasons, ...combo.reasons]);
  into.set(key, {
    ...existing,
    reasons,
    confidence: existing.confidence === 'MEDIUM' || combo.confidence === 'MEDIUM' ? 'MEDIUM' : 'LOW',
    score: scoreCombo(reasons),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对一批未认完的流水 × 一批待收款订单产出认款建议。
 * 输入里 remainingCents ≤ 0 的流水、balanceDueCents ≤ 0 的订单会被直接忽略。
 */
export function matchReceipts(
  receipts: readonly MatchReceipt[],
  orders: readonly MatchOrder[],
  options: MatchOptions = {},
): MatchResult {
  const opts: Required<MatchOptions> = { ...DEFAULTS, ...options };
  const rs = receipts.filter((r) => r.remainingCents > 0).map(prepareReceipt);
  const os = orders.filter((o) => o.balanceDueCents > 0).map(prepareOrder);

  // ── 单笔候选 ──
  const raw: RawCandidate[] = [];
  const reasonsByPair = new Map<string, MatchReason[]>();
  for (const r of rs) {
    for (const o of os) {
      const reasons = collectReasonsPrepared(r, o, opts);
      const exact = reasons[0] === 'AMOUNT_EXACT';
      const identity = hasIdentity(reasons);
      // 只有金额部分/覆盖关系、没有任何身份线索 → 不成候选（噪音）
      if (!exact && !identity) continue;
      reasonsByPair.set(pairKey(r.src.id, o.src.orderId), reasons);
      raw.push({
        receiptId: r.src.id,
        orderId: o.src.orderId,
        reasons,
        score: scoreReasons(reasons),
        exact,
        identity,
        suggestedAmountCents: Math.min(r.src.remainingCents, o.src.balanceDueCents),
        timeGapMs: Math.abs(r.src.receivedAt.getTime() - o.src.createdAt.getTime()),
        orderNumber: o.src.orderNumber,
      });
    }
  }

  const counts = {
    exactIdentityByReceipt: new Map<string, number>(),
    exactIdentityByOrder: new Map<string, number>(),
    exactByReceipt: new Map<string, number>(),
    exactByOrder: new Map<string, number>(),
  };
  for (const c of raw) {
    if (!c.exact) continue;
    bump(counts.exactByReceipt, c.receiptId);
    bump(counts.exactByOrder, c.orderId);
    if (c.identity) {
      bump(counts.exactIdentityByReceipt, c.receiptId);
      bump(counts.exactIdentityByOrder, c.orderId);
    }
  }

  const byReceipt = new Map<string, Array<MatchCandidate & { timeGapMs: number; orderNumber: string }>>();
  const highReceiptIds = new Set<string>();
  const highOrderIds = new Set<string>();
  for (const c of raw) {
    const confidence = decideConfidence(c, counts);
    if (confidence === 'HIGH') {
      highReceiptIds.add(c.receiptId);
      highOrderIds.add(c.orderId);
    }
    const list = byReceipt.get(c.receiptId) ?? [];
    list.push({
      orderId: c.orderId,
      score: c.score,
      reasons: c.reasons,
      confidence,
      suggestedAmountCents: c.suggestedAmountCents,
      timeGapMs: c.timeGapMs,
      orderNumber: c.orderNumber,
    });
    byReceipt.set(c.receiptId, list);
  }

  const receiptMatches: ReceiptMatch[] = [];
  for (const r of rs) {
    const list = byReceipt.get(r.src.id);
    if (!list || list.length === 0) continue;
    list.sort(compareCandidates);
    receiptMatches.push({
      receiptId: r.src.id,
      candidates: list.slice(0, opts.maxCandidatesPerReceipt).map(
        ({ orderId, score, reasons, confidence, suggestedAmountCents }) => ({
          orderId,
          score,
          reasons,
          confidence,
          suggestedAmountCents,
        }),
      ),
    });
  }

  // ── 组合建议 ──
  const combos: ComboSuggestion[] = [
    ...manyReceiptsOneOrder(rs, os, reasonsByPair, highReceiptIds, highOrderIds, opts),
    ...oneReceiptManyOrders(rs, os, reasonsByPair, highReceiptIds, highOrderIds, opts),
  ];
  combos.sort((a, b) => {
    const byConf = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (byConf !== 0) return byConf;
    if (a.score !== b.score) return b.score - a.score;
    return b.totalCents - a.totalCents;
  });

  return { receipts: receiptMatches, combos: combos.slice(0, opts.maxCombos) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 组合：多笔凑一单
// ─────────────────────────────────────────────────────────────────────────────

/** 该流水在备注里命中的代理 id 集合（从已算好的 pair 理由里反推，不重复解析）。 */
function agentIdsHitByReceipt(
  receiptId: string,
  os: readonly PreparedOrder[],
  reasonsByPair: ReadonlyMap<string, MatchReason[]>,
): Set<string> {
  const out = new Set<string>();
  for (const o of os) {
    if (!o.src.agentId) continue;
    const reasons = reasonsByPair.get(pairKey(receiptId, o.src.orderId));
    if (reasons?.includes('PAYER_MATCHES_AGENT')) out.add(o.src.agentId);
  }
  return out;
}

function manyReceiptsOneOrder(
  rs: readonly PreparedReceipt[],
  os: readonly PreparedOrder[],
  reasonsByPair: ReadonlyMap<string, MatchReason[]>,
  highReceiptIds: ReadonlySet<string>,
  highOrderIds: ReadonlySet<string>,
  opts: Required<MatchOptions>,
): ComboSuggestion[] {
  // 分桶：同付款人（备注一致）× 同一天；同代理 × 同一天。已 HIGH 的流水不再参与组合。
  const buckets = new Map<string, { kind: 'SAME_PAYER' | 'SAME_AGENT'; agentId?: string; items: PreparedReceipt[] }>();
  const push = (key: string, kind: 'SAME_PAYER' | 'SAME_AGENT', r: PreparedReceipt, agentId?: string): void => {
    const b = buckets.get(key);
    if (b) b.items.push(r);
    else buckets.set(key, { kind, agentId, items: [r] });
  };
  for (const r of rs) {
    if (highReceiptIds.has(r.src.id)) continue;
    if (isDistinctiveToken(r.note)) push(`payer${KEY_SEP}${r.note}${KEY_SEP}${r.day}`, 'SAME_PAYER', r);
    for (const agentId of agentIdsHitByReceipt(r.src.id, os, reasonsByPair)) {
      push(`agent${KEY_SEP}${agentId}${KEY_SEP}${r.day}`, 'SAME_AGENT', r, agentId);
    }
  }

  const ordersByBalance = new Map<number, PreparedOrder[]>();
  for (const o of os) {
    if (highOrderIds.has(o.src.orderId)) continue;
    const list = ordersByBalance.get(o.src.balanceDueCents);
    if (list) list.push(o);
    else ordersByBalance.set(o.src.balanceDueCents, [o]);
  }

  const out = new Map<string, ComboSuggestion>();
  for (const bucket of buckets.values()) {
    if (bucket.items.length < 2) continue;
    const items = [...bucket.items]
      .sort((a, b) => a.src.receivedAt.getTime() - b.src.receivedAt.getTime())
      .slice(0, opts.comboBucketCap);
    const subsets = enumerateSubsets(items, (r) => r.src.remainingCents, opts.comboMaxParts);
    for (const subset of subsets) {
      const targets = ordersByBalance.get(subset.sumCents);
      if (!targets) continue;
      for (const o of targets) {
        // 同代理桶只推荐该代理的订单
        if (bucket.kind === 'SAME_AGENT' && o.src.agentId !== bucket.agentId) continue;
        const receiptIds = subset.items.map((r) => r.src.id).sort();
        const key = `${receiptIds.join(',')}→${o.src.orderId}`;

        const identityReasons: MatchReason[] = [];
        for (const r of subset.items) {
          const reasons = reasonsByPair.get(pairKey(r.src.id, o.src.orderId)) ?? [];
          for (const x of reasons) if (IDENTITY_REASONS.has(x)) identityReasons.push(x);
        }
        const reasons = uniqueReasons([
          'AMOUNT_SUM_EXACT',
          bucket.kind,
          'SAME_DAY',
          ...identityReasons,
        ]);
        const linked = bucket.kind === 'SAME_AGENT' || identityReasons.length > 0;
        mergeCombo(out, key, {
          type: 'MANY_RECEIPTS_ONE_ORDER',
          receiptIds,
          orderIds: [o.src.orderId],
          parts: subset.items.map((r) => ({
            receiptId: r.src.id,
            orderId: o.src.orderId,
            amountCents: r.src.remainingCents,
          })),
          totalCents: subset.sumCents,
          reasons,
          confidence: linked ? 'MEDIUM' : 'LOW',
          score: scoreCombo(reasons),
        });
      }
    }
  }
  return [...out.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// 组合：一笔付多单
// ─────────────────────────────────────────────────────────────────────────────

function oneReceiptManyOrders(
  rs: readonly PreparedReceipt[],
  os: readonly PreparedOrder[],
  reasonsByPair: ReadonlyMap<string, MatchReason[]>,
  highReceiptIds: ReadonlySet<string>,
  highOrderIds: ReadonlySet<string>,
  opts: Required<MatchOptions>,
): ComboSuggestion[] {
  // 分桶：同代理；同联系人手机（散客一人多单）。已 HIGH 的订单不再参与。
  const buckets = new Map<string, { kind: 'SAME_AGENT' | 'SAME_CONTACT'; items: PreparedOrder[] }>();
  const push = (key: string, kind: 'SAME_AGENT' | 'SAME_CONTACT', o: PreparedOrder): void => {
    const b = buckets.get(key);
    if (b) b.items.push(o);
    else buckets.set(key, { kind, items: [o] });
  };
  for (const o of os) {
    if (highOrderIds.has(o.src.orderId)) continue;
    if (o.src.agentId) push(`agent${KEY_SEP}${o.src.agentId}`, 'SAME_AGENT', o);
    const phone = phoneDigits(o.src.contactPhone);
    if (phone.length >= 7) push(`phone${KEY_SEP}${phone}`, 'SAME_CONTACT', o);
  }

  // 每个桶的子集和只算一次；流水按余额 O(1) 查
  const indexed: Array<{ kind: 'SAME_AGENT' | 'SAME_CONTACT'; bySum: Map<number, SubsetHit<PreparedOrder>[]> }> = [];
  for (const bucket of buckets.values()) {
    if (bucket.items.length < 2) continue;
    const items = [...bucket.items]
      .sort((a, b) => b.src.createdAt.getTime() - a.src.createdAt.getTime())
      .slice(0, opts.comboBucketCap);
    indexed.push({
      kind: bucket.kind,
      bySum: indexBySum(enumerateSubsets(items, (o) => o.src.balanceDueCents, opts.comboMaxParts)),
    });
  }
  if (indexed.length === 0) return [];

  const out = new Map<string, ComboSuggestion>();
  for (const r of rs) {
    if (highReceiptIds.has(r.src.id)) continue;
    for (const bucket of indexed) {
      const hits = bucket.bySum.get(r.src.remainingCents);
      if (!hits) continue;
      for (const hit of hits) {
        const orderIds = hit.items.map((o) => o.src.orderId).sort();
        const key = `${r.src.id}→${orderIds.join(',')}`;

        const identityReasons: MatchReason[] = [];
        for (const o of hit.items) {
          const reasons = reasonsByPair.get(pairKey(r.src.id, o.src.orderId)) ?? [];
          for (const x of reasons) if (IDENTITY_REASONS.has(x)) identityReasons.push(x);
        }
        const reasons = uniqueReasons(['AMOUNT_SUM_EXACT', bucket.kind, ...identityReasons]);
        mergeCombo(out, key, {
          type: 'ONE_RECEIPT_MANY_ORDERS',
          receiptIds: [r.src.id],
          orderIds,
          parts: hit.items.map((o) => ({
            receiptId: r.src.id,
            orderId: o.src.orderId,
            amountCents: o.src.balanceDueCents,
          })),
          totalCents: hit.sumCents,
          reasons,
          confidence: identityReasons.length > 0 ? 'MEDIUM' : 'LOW',
          score: scoreCombo(reasons),
        });
      }
    }
  }
  return [...out.values()];
}
