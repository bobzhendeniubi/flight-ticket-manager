/**
 * 批量 no-show 的纯计算/文案（无 React，便于页面与表格组件共用）。
 * 合格性判定全部来自服务端 preview —— 这里只做展示口径与勾选汇总，不自己判能不能标。
 */
import type { NoShowBatchEntry, NoShowBatchMatch, NoShowMatchedBy } from '../../lib/api';

/** 勾选键：同一乘客在同一单里唯一 */
export function matchKey(m: Pick<NoShowBatchMatch, 'orderId' | 'passengerId'>): string {
  return `${m.orderId}:${m.passengerId}`;
}

export const MATCHED_BY_LABEL: Record<NoShowMatchedBy, string> = {
  DOCUMENT: '护照号',
  NAME: '证件姓名',
  CHINESE_NAME: '中文名',
};

/** 默认勾选：服务端判定合格、且这次还没标过的人 */
export function defaultSelectedKeys(matched: NoShowBatchMatch[]): Set<string> {
  return new Set(matched.filter((m) => m.eligible && !m.alreadyNoShow).map(matchKey));
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

/** 浏览器不支持 crypto.randomUUID 时的退路（幂等键只要够唯一即可） */
export function newRequestToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random()
    .toString(16)
    .slice(2)}`;
}
