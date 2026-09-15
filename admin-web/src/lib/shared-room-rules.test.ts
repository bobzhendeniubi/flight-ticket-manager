import { describe, expect, it } from 'vitest';
import { groupsFromMembers, isLeftoverOnlyRoom, serializeGroups } from './shared-room-rules';

describe('isLeftoverOnlyRoom（P3：与后端 isLeftoverOnlyResubmit 对齐）', () => {
  it('既有房 Σ=0 且成员与落库现状完全一致 → true（H1④ 前端侧契约）', () => {
    // Arrange：工作台加载时读到的落库现状——A 已经被另一次请求隐式挪走，S 目前只剩 B
    // 一人、份额仍是 0（原计费方已迁出，B 留守）。运营原样把 S 重新提交（只列 B，份额
    // 不变）——这正是后端 H1④ 放行的场景，不是漏列（后端场景见
    // hotel-control.shared-rooms.integration.test.ts 的「H1④ 反例」）。
    const seedRoom = {
      sharedRoomId: 'sr-1',
      members: [{ orderId: 'orderB', orderItemId: 'itemB', passengerId: 'paxB', roomFraction: 0 }],
    };
    const draftRoom = {
      sharedRoomId: 'sr-1',
      groups: [{ orderId: 'orderB', orderItemId: 'itemB', passengerIds: ['paxB'], roomFraction: 0 }],
    };

    // Act
    const result = isLeftoverOnlyRoom(seedRoom, draftRoom);

    // Assert
    expect(result).toBe(true);
  });

  it('Σ=0 但漏列了落库现状的另一名计费方 → false（与后端 N2 覆盖校验对齐，不能悄悄摘人）', () => {
    const seedRoom = {
      sharedRoomId: 'sr-1',
      members: [
        { orderId: 'orderA', orderItemId: 'itemA', passengerId: 'paxA', roomFraction: 1 },
        { orderId: 'orderB', orderItemId: 'itemB', passengerId: 'paxB', roomFraction: 0 },
      ],
    };
    // 草稿只列出份额已改成 0 的 A，漏列了本该原样留守的 B。
    const draftRoom = {
      sharedRoomId: 'sr-1',
      groups: [{ orderId: 'orderA', orderItemId: 'itemA', passengerIds: ['paxA'], roomFraction: 0 }],
    };

    expect(isLeftoverOnlyRoom(seedRoom, draftRoom)).toBe(false);
  });

  it('Σ=0 但成员集合真有改动（多了新成员）→ false', () => {
    const seedRoom = {
      sharedRoomId: 'sr-1',
      members: [{ orderId: 'orderB', orderItemId: 'itemB', passengerId: 'paxB', roomFraction: 0 }],
    };
    const draftRoom = {
      sharedRoomId: 'sr-1',
      groups: [
        { orderId: 'orderB', orderItemId: 'itemB', passengerIds: ['paxB'], roomFraction: 0 },
        { orderId: 'orderC', orderItemId: 'itemC', passengerIds: ['paxC'], roomFraction: 0 },
      ],
    };

    expect(isLeftoverOnlyRoom(seedRoom, draftRoom)).toBe(false);
  });

  it('Σ≠0（正常在售房间）→ 恒 false，不管成员是否一致', () => {
    const seedRoom = {
      sharedRoomId: 'sr-1',
      members: [{ orderId: 'orderA', orderItemId: 'itemA', passengerId: 'paxA', roomFraction: 1 }],
    };
    const draftRoom = {
      sharedRoomId: 'sr-1',
      groups: [{ orderId: 'orderA', orderItemId: 'itemA', passengerIds: ['paxA'], roomFraction: 1 }],
    };

    expect(isLeftoverOnlyRoom(seedRoom, draftRoom)).toBe(false);
  });

  it('新建房间（sharedRoomId=null）→ 恒 false，新建房只能走 Σ=1 硬闸', () => {
    const draftRoom = {
      sharedRoomId: null,
      groups: [{ orderId: 'orderA', orderItemId: 'itemA', passengerIds: ['paxA'], roomFraction: 0 }],
    };

    expect(isLeftoverOnlyRoom(undefined, draftRoom)).toBe(false);
  });

  it('seedRoom 找不到（异常态：草稿带 sharedRoomId 但原始数据里没有）→ 保守返回 false，不代替后端拍板', () => {
    const draftRoom = {
      sharedRoomId: 'sr-missing',
      groups: [{ orderId: 'orderA', orderItemId: 'itemA', passengerIds: ['paxA'], roomFraction: 0 }],
    };

    expect(isLeftoverOnlyRoom(undefined, draftRoom)).toBe(false);
  });
});

describe('groupsFromMembers / serializeGroups（顺序无关的集合比较，isLeftoverOnlyRoom 的内部依赖）', () => {
  it('同一批成员按不同顺序传入 → 序列化结果相同', () => {
    const a = groupsFromMembers([
      { orderId: 'o1', orderItemId: 'i1', passengerId: 'p1', roomFraction: 1 },
      { orderId: 'o1', orderItemId: 'i1', passengerId: 'p2', roomFraction: 1 },
    ]);
    const b = groupsFromMembers([
      { orderId: 'o1', orderItemId: 'i1', passengerId: 'p2', roomFraction: 1 },
      { orderId: 'o1', orderItemId: 'i1', passengerId: 'p1', roomFraction: 1 },
    ]);
    expect(serializeGroups(a)).toBe(serializeGroups(b));
  });

  it('份额不同 → 序列化结果不同', () => {
    const a = groupsFromMembers([{ orderId: 'o1', orderItemId: 'i1', passengerId: 'p1', roomFraction: 1 }]);
    const b = groupsFromMembers([{ orderId: 'o1', orderItemId: 'i1', passengerId: 'p1', roomFraction: 0 }]);
    expect(serializeGroups(a)).not.toBe(serializeGroups(b));
  });
});
