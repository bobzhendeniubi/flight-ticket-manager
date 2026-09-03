/**
 * 批量 no-show 的纯计算/文案（无 React，便于页面与表格组件共用）。
 * 合格性判定全部来自服务端 preview —— 这里只做展示口径与勾选汇总，不自己判能不能标。
 */
import type {
  NoShowAmbiguousCandidate,
  NoShowAmbiguousLine,
  NoShowBatchEntry,
  NoShowBatchMatch,
  NoShowMatchedBy,
} from '../../lib/api';

/** 勾选键：同一乘客在同一单里唯一 */
export function matchKey(m: Pick<NoShowBatchMatch, 'orderId' | 'passengerId'>): string {
  return `${m.orderId}:${m.passengerId}`;
}

export const MATCHED_BY_LABEL: Record<NoShowMatchedBy, string> = {
  DOCUMENT: '护照号',
  NAME: '证件姓名',
  CHINESE_NAME: '中文名',
};

/**
 * 多人同名候选选定后，就地拼一条 matched 行 —— 不用再让运营把名单文字换成候选姓名、
 * 手工点一次「匹配」等服务端重新判一遍。
 *
 * eligible/blockers/scope/回程信息先尽量借同一张单里服务端已经判过的另一行（同单同口径）；
 * 这张单在名单里没有别的乘客、借不到口径时，就放行勾选但打上警示。
 *
 * 无论借没借到，这些行都带 pinned 标记：页面随后会对这张单再补一次逐单预检
 * （applyOrderAssessment），拿回真实的 eligible/blockers/scope —— 补上了警示才消。
 */
function pinnedCandidateToMatch(
  line: string,
  candidate: NoShowAmbiguousCandidate,
  matched: NoShowBatchMatch[],
): NoShowBatchMatch {
  const sibling = matched.find((m) => m.orderId === candidate.orderId);
  const base = {
    line,
    lines: [line],
    // 借来的口径终究不是这一行自己的判定：标记 pinned，页面会对这张单再补一次逐单预检。
    pinned: true,
    orderId: candidate.orderId,
    orderNumber: candidate.orderNumber,
    passengerId: candidate.passengerId,
    fullName: candidate.fullName,
    chineseName: candidate.chineseName,
    // 候选目前不带护照尾号；万一后端以后补上，这里顺手接住，没有就显示 —（由表格兜底）
    documentTail: candidate.documentTail ?? null,
    matchedBy: 'NAME' as NoShowMatchedBy,
  };
  if (sibling) {
    return {
      ...base,
      alreadyNoShow: sibling.alreadyNoShow,
      eligible: sibling.eligible,
      blockers: sibling.blockers,
      scope: sibling.scope,
      hasReturn: sibling.hasReturn,
      returnTicketed: sibling.returnTicketed,
      returnDeparted: sibling.returnDeparted,
    };
  }
  return {
    ...base,
    alreadyNoShow: false,
    eligible: true,
    blockers: [],
    scope: 'WHOLE',
    hasReturn: false,
    returnTicketed: false,
    returnDeparted: false,
    warning: '该单未预检，提交前请确认',
  };
}

export interface ResolvedPreviewMatches {
  matched: NoShowBatchMatch[];
  ambiguous: NoShowAmbiguousLine[];
}

/**
 * 用「运营已经钉住的候选」把预检结果里仍然多人同名的行解出来，合并进 matched。
 * pinnedPassengerIds 以「当前名单里这一行的文本」为键（选定候选后名单文字已经换成了
 * 候选的证件姓名——所以键是新文本，不是原始行）。不在 pins 里、或钉住的 passengerId
 * 在这次候选里已经找不到（服务端候选变了）的行，原样留在 ambiguous 里等运营重新选。
 */
export function resolvePinnedAmbiguous(
  matched: NoShowBatchMatch[],
  ambiguous: NoShowAmbiguousLine[],
  pinnedPassengerIds: Record<string, string>,
): ResolvedPreviewMatches {
  const stillAmbiguous: NoShowAmbiguousLine[] = [];
  const resolved: NoShowBatchMatch[] = [];
  for (const amb of ambiguous) {
    const pinnedId = pinnedPassengerIds[amb.line];
    const candidate = pinnedId ? amb.candidates.find((c) => c.passengerId === pinnedId) : undefined;
    if (!candidate) {
      stillAmbiguous.push(amb);
      continue;
    }
    resolved.push(pinnedCandidateToMatch(amb.line, candidate, matched));
  }
  return { matched: [...matched, ...resolved], ambiguous: stillAmbiguous };
}

/**
 * 默认勾选：服务端判定合格、这次还没标过、**且不需要拆单**的人。
 *
 * 需拆单的行默认不勾：拆单会真的拆出一张新单，拆完不可回滚（钱与座位都搬到新单上）。
 * 「全选」按下去就把整批人一起拆了，谁也没来得及看一眼是哪几张单 —— 这一档必须由
 * 运营逐行明确勾上，提交前的确认弹窗还会把会被拆的单号逐条列出来。
 */
export function defaultSelectedKeys(matched: NoShowBatchMatch[]): Set<string> {
  return new Set(
    matched
      .filter((m) => m.eligible && !m.alreadyNoShow && m.scope !== 'SPLIT_REQUIRED')
      .map(matchKey),
  );
}

/** 勾选里会触发自动拆单的订单号（去重、按单号排序），给确认弹窗逐条列出来。 */
export function splitOrderNumbers(selected: NoShowBatchMatch[]): string[] {
  const byOrder = new Map<string, string>();
  for (const m of selected) {
    if (m.scope === 'SPLIT_REQUIRED') byOrder.set(m.orderId, m.orderNumber);
  }
  return [...byOrder.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * 「本来整单、被取消勾选后变成只标部分人」的订单 id。
 *
 * 服务端的 scope 是按**贴进来的名单**算的：整单的人都在名单里 → WHOLE。运营在表格里
 * 取消勾了同单的某个人之后，实际提交的就只是这张单的一部分 —— 服务端到执行时会自动拆单，
 * 而表格上那一行还写着「整单」。这里把这种单挑出来，行上给一条琥珀提示。
 */
export function downgradedToSplitOrderIds(
  matched: NoShowBatchMatch[],
  selectedKeys: Set<string>,
): Set<string> {
  const stat = new Map<string, { picked: number; total: number }>();
  for (const m of matched) {
    if (m.scope !== 'WHOLE') continue;
    const hit = stat.get(m.orderId) ?? { picked: 0, total: 0 };
    hit.total += 1;
    if (selectedKeys.has(matchKey(m))) hit.picked += 1;
    stat.set(m.orderId, hit);
  }
  const out = new Set<string>();
  for (const [orderId, { picked, total }] of stat) {
    if (picked > 0 && picked < total) out.add(orderId);
  }
  return out;
}

/** 带 pinned 标记（多人同名点选并入）的行所在的订单 id —— 这些单要补一次逐单预检。 */
export function pinnedOrderIds(matched: NoShowBatchMatch[]): string[] {
  return [...new Set(matched.filter((m) => m.pinned).map((m) => m.orderId))];
}

/** 一张单补预检回来的真实口径（字段与服务端 previewNoShow 同源）。 */
export interface OrderAssessmentPatch {
  eligible: boolean;
  blockers: string[];
  scope: NoShowBatchMatch['scope'];
  alreadyNoShow: boolean;
  hasReturn: boolean;
  returnTicketed: boolean;
  returnDeparted: boolean;
}

/**
 * 把补回来的逐单口径盖到这张单的所有行上，并抹掉「未预检」警示。
 * 补不回来（接口失败）时页面不调本函数，警示原样留着。
 */
export function applyOrderAssessment(
  matched: NoShowBatchMatch[],
  orderId: string,
  patch: OrderAssessmentPatch,
): NoShowBatchMatch[] {
  return matched.map((m) =>
    m.orderId === orderId ? { ...m, ...patch, pinned: m.pinned, warning: undefined } : m,
  );
}

/**
 * 单次提交的分片大小 —— 与服务端 noShowBatchBodySchema 的 entries 上限一致。
 * 批量是串行执行的（每单一个事务，要拆单的还要再走一整套拆单），一片太大就会把
 * 一个 HTTP 请求拖到网关超时。超过一片时前端按片顺序连发，单片失败不影响后续片。
 */
export const NO_SHOW_BATCH_CHUNK_SIZE = 50;

/** 按 size 把提交载荷切片（保序）。 */
export function chunkEntries(
  entries: NoShowBatchEntry[],
  size: number = NO_SHOW_BATCH_CHUNK_SIZE,
): NoShowBatchEntry[][] {
  const out: NoShowBatchEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) out.push(entries.slice(i, i + size));
  return out;
}

/** 勾选 → 提交载荷（同一单的多个乘客合成一条 entry） */
export function buildEntries(selected: NoShowBatchMatch[]): NoShowBatchEntry[] {
  const byOrder = new Map<string, string[]>();
  for (const m of selected) {
    const list = byOrder.get(m.orderId);
    if (list) list.push(m.passengerId);
    else byOrder.set(m.orderId, [m.passengerId]);
  }
  return [...byOrder.entries()].map(([orderId, passengerIds]) => ({ orderId, passengerIds }));
}

export interface NoShowSelectionSummary {
  /** 勾了几个人 */
  pax: number;
  /** 涉及几张单 */
  orders: number;
  /** 其中几张需要服务端先自动拆单 */
  splitOrders: number;
  /**
   * 预计释放几座 —— 只是给运营一个量级参考（勾了释放回程 × 还有未起飞回程的人数）。
   * 真实释放数以提交后服务端返回的 summary.releasedSeats 为准，所以文案里写「预计」。
   */
  estimatedReleasedSeats: number;
}

export function summarizeSelection(
  selected: NoShowBatchMatch[],
  releaseReturn: boolean,
): NoShowSelectionSummary {
  const orders = new Set(selected.map((m) => m.orderId));
  const splitOrders = new Set(
    selected.filter((m) => m.scope === 'SPLIT_REQUIRED').map((m) => m.orderId),
  );
  const estimatedReleasedSeats = releaseReturn
    ? selected.filter((m) => m.hasReturn && !m.returnDeparted).length
    : 0;
  return {
    pax: selected.length,
    orders: orders.size,
    splitOrders: splitOrders.size,
    estimatedReleasedSeats,
  };
}

/**
 * 提交载荷指纹 —— requestToken 按它记忆化：
 * 同一批载荷（含「重试失败项」这种原样重发）复用同一个幂等键，
 * 改了勾选 / 释放开关 / 备注才换新的，避免已成功的单被再执行一遍。
 */
export function payloadFingerprint(input: {
  scheduleId: string;
  entries: NoShowBatchEntry[];
  releaseReturn: boolean;
  note: string;
}): string {
  // 用 JSON 序列化而不是自己拼分隔符：拼串要考虑 id 里出现分隔符导致两份不同载荷撞出同一指纹，
  // 用同一个幂等键就等于把两批不同的操作当成一批。归一化（各自排序）后交给 JSON.stringify 最省心。
  const normalized = input.entries
    .map((e) => [e.orderId, [...e.passengerIds].sort()] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify([
    input.scheduleId,
    normalized,
    input.releaseReturn,
    input.note.trim(),
  ]);
}

/** 名单文本 → 去空行去重（保序）的标识行数组 */
export function parseNameLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * 幂等键。服务端按 **uuid v4 格式**校验，格式不对直接 400 —— 所以退路也必须产出合法 v4，
 * 不能随手拼时间戳加随机数（randomUUID 只在安全上下文里有，内网 http 打开后台就会走到退路）。
 */
export function newRequestToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  // v4 版本位与 variant 位（第 6/8 字节）：不盖上去就不是合法 v4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
