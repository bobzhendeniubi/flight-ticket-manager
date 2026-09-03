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

/** 航段状态五态（导出列直接落这些中文值；无状态 = 空串）。 */
export type LegStatus =
  | '去程未登机'
  | '回程座位已释放'
  | '回程已恢复'
  | '回程已作废'
  | '去程已作废';

// ── 内部留痕前缀（唯一定义处）────────────────────────────────────────────────
//
// 这些前缀是**内部岗位的操作留痕**，写在 OrderItem.description 上给内部一眼看清这段的状态。
// 代理与客户不该看到我们内部怎么标，对外一律剥掉（见 stripInternalLegPrefix）。
//
// 常量与剥前缀函数放在本文件（而不是 orders.service）：退款报价引擎 lib/cancellation.ts 也要剥，
// 而 lib 层 import service 会形成 lib → service 的反向依赖。本文件零依赖，两边都能安全 import。

/** 被标 no-show 的去程行前缀。 */
export const NO_SHOW_PREFIX = '【去程未登机】';
/** 被 no-show 释放座位的回程行前缀。 */
export const RETURN_RELEASED_PREFIX = '【回程座位已释放】';
/** 取消航段（去程）的行前缀。 */
export const LEG_CANCELLED_OUTBOUND_PREFIX = '【已取消去程】';
/** 取消航段（回程）的行前缀。 */
export const LEG_CANCELLED_RETURN_PREFIX = '【已取消回程】';
/** 半角旧写法（只用于剥前缀，让存量行也剥得干净；新数据一律用全角写法）。 */
export const LEGACY_NO_SHOW_PREFIX = '[去程 no-show] ';
/** 半角旧写法（同上）。 */
export const LEGACY_RETURN_RELEASED_PREFIX = '[回程已释放] ';

/** 内部留痕前缀全集（no-show / 释放 / 取消航段，含两种半角旧写法）。 */
export const INTERNAL_LEG_PREFIXES: readonly string[] = [
  NO_SHOW_PREFIX,
  RETURN_RELEASED_PREFIX,
  LEG_CANCELLED_OUTBOUND_PREFIX,
  LEG_CANCELLED_RETURN_PREFIX,
  LEGACY_NO_SHOW_PREFIX,
  LEGACY_RETURN_RELEASED_PREFIX,
];

/**
 * 剥掉行描述上的内部留痕前缀（可能叠加过多次，循环剥到干净）。
 * ADMIN/STAFF 视角保留前缀（内部要一眼看出这段的状态）；AGENT/CUSTOMER 视角与退款报价一律剥。
 */
export function stripInternalLegPrefix(description: string): string {
  if (typeof description !== 'string' || description === '') return description;
  let out = description;
  let matched = true;
  while (matched) {
    matched = false;
    for (const prefix of INTERNAL_LEG_PREFIXES) {
      if (out.startsWith(prefix)) {
        out = out.slice(prefix.length);
        matched = true;
        break;
      }
    }
  }
  return out;
}

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
 * 该行是否被打了「去程未登机」标（metadata.noShow 存在即为真）。
 *
 * 形状不符（null / 非对象 / 数组）一律按未打标处理 —— 快照是历史数据，读侧不许因脏 JSON 抛错。
 * 打标不动 flightScheduleId（那趟航班真飞了），所以光看班次判断不出客人到底上没上飞机。
 * 旅客档案的飞行次数（travelers/traveler-trip-count.ts）与本文件的状态派生共用这一份判据。
 */
export function hasNoShowMark(metadata: unknown): boolean {
  return readObject(metadata).noShow != null;
}

/**
 * 单行航段状态（无任何痕迹 → null）。
 *
 * 优先级：作废 > 当前已释放 > 已恢复 > 去程未登机。
 * 「作废」既包含起飞后自动作废（returnVoidedFinal，只发生在回程），也包含取消航段
 * （returnLegCancelled，金额已归零）—— 对运营是同一件事：这段没了。
 * 取消航段**去程/回程都能取消**，故按快照里的 leg 分成「去程已作废」「回程已作废」两态：
 * 一律写成「回程已作废」会让取消了去程的单在列表/导出里显示成回程没了，方向正好反。
 */
export function deriveLegStatus(item: LegStatusItemLike): LegStatus | null {
  if (item.kind !== 'FLIGHT') return null;
  const meta = readObject(item.metadata);
  if (meta.returnVoidedFinal != null) return '回程已作废';
  if (meta.returnLegCancelled != null) {
    // 快照缺 leg（早期数据）时按回程处理：取消航段功能上线初期只做过回程。
    return readObject(meta.returnLegCancelled).leg === 'OUTBOUND' ? '去程已作废' : '回程已作废';
  }
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

// ── 对外（代理 / 客户）视角的中性航段状态 ────────────────────────────────────
//
// 内部五态（LegStatus）连同行描述前缀一起对外剥离后，回程那一行在前台/小程序上只剩一个
// 光杆名字：没班次、没日期、没说明，客人会以为系统坏了。这里给对外视角一个**中性枚举**，
// 让前端能落一句买家口吻的说明，同时不暴露「座位放回库存 / 被转卖」这类我方内部动作。
// 只下发枚举值，文案由各前端自己写（后端不落中文，避免同一句话在四端各存一份）。

/** 对外可见的航段状态（没有可说的 → null，前端保持原样）。 */
export type PublicLegStatus =
  | 'RETURN_PENDING_REARRANGE' // 回程当前无班次，待重新安排
  | 'RETURN_CANCELLED' // 回程已取消（作废 / 取消航段）
  | 'OUTBOUND_CANCELLED' // 去程已取消
  | 'OUTBOUND_NOT_BOARDED'; // 去程未登机（客人自己知道，前端不必额外解释）

/**
 * 内部五态 → 对外中性状态。
 * 「回程已恢复」= 已经重新安排妥当，对外没有额外要说的 → null（回到普通航段行的展示）。
 */
export function derivePublicLegStatus(item: LegStatusItemLike): PublicLegStatus | null {
  switch (deriveLegStatus(item)) {
    case '回程座位已释放':
      return 'RETURN_PENDING_REARRANGE';
    case '回程已作废':
      return 'RETURN_CANCELLED';
    case '去程已作废':
      return 'OUTBOUND_CANCELLED';
    case '去程未登机':
      return 'OUTBOUND_NOT_BOARDED';
    default:
      return null;
  }
}
