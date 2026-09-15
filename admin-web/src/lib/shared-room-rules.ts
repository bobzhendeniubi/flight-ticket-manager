/**
 * 跨单分房工作台 · 纯函数判定层（P3 修复，批 10）。
 *
 * 与后端 backend/src/modules/hotel-control/hotel-control.shared-rooms.ts 的
 * `isLeftoverOnlyResubmit` 严格对齐（N3）：既有共享房（sharedRoomId 非空）本次提交的
 * 计费份额合计 = 0，且成员集合（orderId + orderItemId + roomFraction + passengerIds
 * 四元组的集合）与落库现状完全一致——不是新增/改动，只是把「原计费方已迁出、剩下的都是
 * 留守成员」这个既成事实原样交回来——服务端会放行成 200（带 warning），前端不该抢先拦成
 * Σ≠1 的硬闸错误。
 *
 * 这条判定此前直接写死在 SharedRoomWorkbench.tsx 的 handleSave 里（membersChanged /
 * membersUnchanged 局部变量），没有独立测试。抽成不依赖 React/组件状态的纯函数，双端
 * 各自能对同一份契约分别加最小单测，避免同一条业务规则在两处代码里各写一遍、后续改动
 * 只改了一边就裂开（sol 终审复核 2 · P3）。
 */

export interface SharedRoomRuleMember {
  orderId: string;
  orderItemId: string;
  passengerId: string;
  roomFraction: number;
}

export interface SharedRoomRuleSeedRoom {
  sharedRoomId: string;
  members: readonly SharedRoomRuleMember[];
}

export interface SharedRoomRuleGroup {
  orderId: string;
  orderItemId: string;
  passengerIds: readonly string[];
  roomFraction: number;
}

export interface SharedRoomRuleDraftRoom {
  sharedRoomId: string | null;
  groups: readonly SharedRoomRuleGroup[];
}

/** 共享房成员列表 → 按「来源订单 + 订单行」重新分组（顺序不重要，只用于集合比较）。 */
export function groupsFromMembers(members: readonly SharedRoomRuleMember[]): SharedRoomRuleGroup[] {
  const byKey = new Map<
    string,
    { orderId: string; orderItemId: string; passengerIds: string[]; roomFraction: number }
  >();
  for (const m of members) {
    const key = `${m.orderId}:${m.orderItemId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.passengerIds.push(m.passengerId);
    } else {
      byKey.set(key, {
        orderId: m.orderId,
        orderItemId: m.orderItemId,
        passengerIds: [m.passengerId],
        roomFraction: m.roomFraction,
      });
    }
  }
  return [...byKey.values()];
}

/** 规范化序列化一组 group，用于「本次改动前后是否相同」的字符串比较（顺序无关）。 */
export function serializeGroups(groups: readonly SharedRoomRuleGroup[]): string {
  return JSON.stringify(
    groups
      .map((g) => ({
        orderId: g.orderId,
        orderItemId: g.orderItemId,
        roomFraction: g.roomFraction,
        passengerIds: [...g.passengerIds].sort(),
      }))
      .sort((a, b) => `${a.orderId}:${a.orderItemId}`.localeCompare(`${b.orderId}:${b.orderItemId}`)),
  );
}

const FRACTION_ROUND_STEP = 100;
/** 份额浮点误差按百分位量化后再比较（与组件内 roundHalf 同一口径，避免 0.1+0.2 尾差）。 */
function roundFraction(n: number): number {
  return Math.round(n * FRACTION_ROUND_STEP) / FRACTION_ROUND_STEP;
}

/**
 * 既有房 Σ=0 且成员与落库现状完全一致的「原样重提」判定——与后端
 * `isLeftoverOnlyResubmit` 对齐，见文件头注释。
 *
 * `seedRoom` 为 `undefined`（理论上不该发生：草稿带着 sharedRoomId 却在工作台原始数据
 * 里找不到对应房间）时保守返回 `false`——不代替后端做决定，改动会被当作「有变化」交由
 * 后端的硬闸判断，不会因为前端这里瞎猜而放行一个本不该放行的请求。
 */
export function isLeftoverOnlyRoom(
  seedRoom: SharedRoomRuleSeedRoom | undefined,
  draftRoom: SharedRoomRuleDraftRoom,
): boolean {
  if (!draftRoom.sharedRoomId || !seedRoom) return false;
  const totalFraction = roundFraction(draftRoom.groups.reduce((sum, g) => sum + g.roomFraction, 0));
  if (totalFraction !== 0) return false;
  const originalGroups = groupsFromMembers(seedRoom.members);
  return serializeGroups(originalGroups) === serializeGroups(draftRoom.groups);
}
