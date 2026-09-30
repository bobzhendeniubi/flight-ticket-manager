/**
 * 订单详情「售后费用」区：换人费 / 换人差价那一行的标题文案。
 *
 * 调价流水（Order.adjustments 的 SWAP_FEE / SWAP_PRICE_DIFF）只记了**被换下去的人**
 *（passengerName / passengerDocument 快照）和时间，没记换上来的是谁；换上来的人在换人审计
 *（SWAP_ORDER_PASSENGER，乘客卡下方「换人 / 改信息记录」同一份）里。这里把两边对上：
 * 同一位旧人（姓名、证件号都有时两者都要对上）+ 时间最接近的那次换人 = 这笔钱对应的换人。
 * 不新增存储。对不上（审计读不到 / 旧数据）就只写旧人与日期，不臆造新人。
 *
 * 输出形如「换人费（原 QIN/XUE → 新 YANG/LIN，09-30）」；金额仍由调用方在右侧单独显示。
 */
import { businessTzParts } from './datetime';

/** 换人历史里本函数用得到的几项（与 OrdersPage 的 PassengerHistoryEntry 结构兼容）。*/
export interface SwapHistoryLite {
  kind?: 'SWAP' | 'CORRECTION';
  at: string;
  beforeName?: string;
  beforeDoc?: string;
  afterName?: string;
}

/** 调价流水里本函数用得到的几项（lib/api.ts 的 OrderAdjustment 子集）。*/
export interface SwapAdjustmentLite {
  type: string;
  label: string;
  at: string;
  passengerName?: string;
  passengerDocument?: string;
}

/** 挂在被换人头上、需要补「原 → 新」的调价流水类型。*/
export const SWAP_LINKED_ADJUSTMENT_TYPES: ReadonlySet<string> = new Set(['SWAP_FEE', 'SWAP_PRICE_DIFF']);

/**
 * 调价流水与换人审计的最大时间差：流水时间在换人事务里取、审计在事务提交后写，
 * 正常只差几秒；放宽到 30 分钟兜住慢事务，又不至于把同一位旧人隔天的另一次换人配上。
 */
const MATCH_WINDOW_MS = 30 * 60 * 1000;

function norm(v: string | undefined): string {
  return (v ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function mmdd(iso: string): string {
  const p = businessTzParts(iso);
  return p ? `${p.month}-${p.day}` : '';
}

/** 找这笔换人费对应的那次换人（同一位旧人、时间最近、在窗口内）；找不到 → null。*/
export function matchSwapForAdjustment(
  adj: SwapAdjustmentLite,
  history: readonly SwapHistoryLite[],
): SwapHistoryLite | null {
  const oldName = norm(adj.passengerName);
  if (!oldName) return null;
  const adjAt = Date.parse(adj.at);
  if (!Number.isFinite(adjAt)) return null;
  const adjDoc = norm(adj.passengerDocument);
  let best: SwapHistoryLite | null = null;
  let bestGap = Infinity;
  for (const h of history) {
    if (h.kind && h.kind !== 'SWAP') continue;
    if (norm(h.beforeName) !== oldName) continue;
    const hDoc = norm(h.beforeDoc);
    if (adjDoc && hDoc && adjDoc !== hDoc) continue;
    const gap = Math.abs(Date.parse(h.at) - adjAt);
    if (!Number.isFinite(gap) || gap > MATCH_WINDOW_MS) continue;
    if (gap < bestGap) {
      best = h;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * 换人费 / 换人差价行的标题；其余类型返回 null（调用方沿用原展示）。
 *   对上了：「换人费（原 QIN/XUE → 新 YANG/LIN，09-30）」
 *   对不上：「换人费（原 QIN/XUE，09-30）」
 *   连旧人都没记（很早的流水）：「换人费（09-30）」
 */
export function swapAdjustmentTitle(
  adj: SwapAdjustmentLite,
  history: readonly SwapHistoryLite[],
): string | null {
  if (!SWAP_LINKED_ADJUSTMENT_TYPES.has(adj.type)) return null;
  const date = mmdd(adj.at);
  const oldName = (adj.passengerName ?? '').trim();
  const matched = matchSwapForAdjustment(adj, history);
  const newName = (matched?.afterName ?? '').trim();
  const who = oldName ? (newName ? `原 ${oldName} → 新 ${newName}` : `原 ${oldName}`) : '';
  const detail = [who, date].filter((s) => s !== '').join('，');
  return detail ? `${adj.label}（${detail}）` : adj.label;
}
