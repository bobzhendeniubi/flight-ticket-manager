/**
 * 航段状态派生（no-show / 回程释放 / 恢复 / 作废）——**唯一口径**。
 *
 * 数据源全部是 OrderItem.metadata 上的快照（零迁移设计，见 orders.service 的 no-show 流程）：
 *   · metadata.noShow            —— 去程未登机（班次不动、钱不动）
 *   · metadata.returnReleased    —— 回程座位放回库存（flightScheduleId 置空、金额不动）
 *   · metadata.returnRestored    —— 回程恢复到原班次（可能超售）
 *   · metadata.returnVoidedFinal —— 回程起飞后自动作废（终态，不可恢复）
 *   · metadata.returnLegCancelled—— 取消航段（老快照，金额已归零）
 *
 * 「当前是否处于已释放态」的判定必须是 **flightScheduleId 为空 且 releasedAt > restoredAt**：
 * 释放→恢复→再释放可以反复发生，光看 returnReleased 存不存在会把已恢复的行也当成已释放。
 *
 * 导出侧（全岗可用/签证模板、全岗总表、整班导出）与退款报价共用本文件，
 * 避免同一个状态在四个地方各写一套判断然后慢慢漂移。
 */

/** 航段状态四态（导出列直接落这些中文值；无状态 = 空串）。 */
export type LegStatus = '去程未登机' | '回程座位已释放' | '回程已恢复' | '回程已作废';

/** 派生所需的最小行形状（导出侧的 select 只要带上这三样即可）。 */
export interface LegStatusItemLike {
  kind: string;
  flightScheduleId?: string | null;
  metadata?: unknown;
}

/** 防御式读 JSON 对象（形状不符按空对象处理）。 */
function readObject(raw: unknown): Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** 取快照里的 at 时间戳（毫秒）；缺失/不可解析 → null。 */
function snapshotAt(snapshot: unknown): number | null {
  const at = readObject(snapshot).at;
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 该行当前是否处于「回程座位已释放、尚未恢复」的状态。
 *
 * 三个条件缺一不可：
 *   1. flightScheduleId 为空（座位账已经不认这一行了）
 *   2. 有 returnReleased.at
 *   3. 释放时间晚于最近一次恢复时间（反复释放/恢复时只认最后一次动作）
 * 已被「起飞后自动作废」终结（returnVoidedFinal）的不算 —— 那是终态，不可再恢复。
 */
export function isReturnCurrentlyReleased(item: LegStatusItemLike): boolean {
  if (item.kind !== 'FLIGHT') return false;
  if (item.flightScheduleId != null) return false;
  const meta = readObject(item.metadata);
  if (meta.returnVoidedFinal != null) return false;
  const releasedAt = snapshotAt(meta.returnReleased);
  if (releasedAt == null) return false;
  const restoredAt = snapshotAt(meta.returnRestored) ?? 0;
  return releasedAt > restoredAt;
}

/**
 * 最近一次恢复**新增**了几座超售（无超售 / 恢复后又被释放 → 0）。
 * 取的是快照里的 oversoldBy（increment），不是 scheduleOversoldAfter（该班累计）——
 * 房控按订单逐条累加时，只有增量口径加起来才等于「这一班被放行了多少超售」。
 */
export function restoredOversoldSeats(item: LegStatusItemLike): number {
  if (item.kind !== 'FLIGHT') return 0;
  const meta = readObject(item.metadata);
  const restored = readObject(meta.returnRestored);
  if (restored.oversold !== true) return 0;
  // 恢复之后又被释放掉了 → 这条超售已经不成立。
  const restoredAt = snapshotAt(meta.returnRestored) ?? 0;
  const releasedAt = snapshotAt(meta.returnReleased) ?? 0;
  if (releasedAt > restoredAt) return 0;
  const by = Number(restored.oversoldBy);
  return Number.isFinite(by) && by > 0 ? Math.trunc(by) : 0;
}

/**
 * 单行航段状态（无任何痕迹 → null）。
 *
 * 优先级：作废 > 当前已释放 > 已恢复 > 去程未登机。
 * 「回程已作废」既包含起飞后自动作废（returnVoidedFinal），也包含取消航段
 * （returnLegCancelled，金额已归零）—— 对运营是同一件事：这段没了。
 */
export function deriveLegStatus(item: LegStatusItemLike): LegStatus | null {
  if (item.kind !== 'FLIGHT') return null;
  const meta = readObject(item.metadata);
  if (meta.returnVoidedFinal != null || meta.returnLegCancelled != null) return '回程已作废';
  if (isReturnCurrentlyReleased(item)) return '回程座位已释放';
  if (snapshotAt(meta.returnRestored) != null) return '回程已恢复';
  if (meta.noShow != null) return '去程未登机';
  return null;
}

/** 单行航段状态的展示文案（已恢复且超售时带上超售座数）；无状态 → 空串。 */
export function formatLegStatus(item: LegStatusItemLike): string {
  const status = deriveLegStatus(item);
  if (status == null) return '';
  if (status === '回程已恢复') {
    const oversold = restoredOversoldSeats(item);
    return oversold > 0 ? `回程已恢复（超售 ${oversold} 座）` : '回程已恢复';
  }
  return status;
}

/**
 * 整单的「航段状态」列取值：把各航段行的状态合并成一格。
 * 一单可能同时有「去程未登机」和「回程座位已释放」两行 —— 都要显示，用 ` / ` 连接，去重保序。
 */
export function formatOrderLegStatus(items: LegStatusItemLike[]): string {
  const parts: string[] = [];
  for (const it of items) {
    const text = formatLegStatus(it);
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join(' / ');
}
