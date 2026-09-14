/**
 * 跨单分房房组对外角色化 DTO · 单元测试（§十，验收反例 9 的地基）。
 */
import { describe, it, expect } from 'vitest';
import { UserRole } from '@prisma/client';
import { serializeRoomGroupsFor } from './room-group-dto.js';

const roomAssignment = {
  roomGroups: [
    {
      id: 'g1',
      hotelName: '合住酒店',
      roomType: '大床房',
      passengerIds: ['p1'],
      roomFraction: 1,
      orderItemId: 'item-1',
      sharedRoomId: 'sr1',
      notes: '靠窗',
      splitPairKey: 'item-1:token-abc',
    },
    {
      id: 'g2',
      hotelName: '普通酒店',
      roomType: '双床房',
      passengerIds: ['p2', 'p3'],
      notes: null,
    },
  ],
};

describe('serializeRoomGroupsFor — ADMIN/STAFF 原样透传', () => {
  it('ADMIN：原值不变（含 sharedRoomId / splitPairKey / hotelName）', () => {
    expect(serializeRoomGroupsFor(UserRole.ADMIN, roomAssignment)).toBe(roomAssignment);
  });

  it('STAFF：原值不变', () => {
    expect(serializeRoomGroupsFor(UserRole.STAFF, roomAssignment)).toBe(roomAssignment);
  });
});

describe('serializeRoomGroupsFor — AGENT/CUSTOMER 剥离', () => {
  it('AGENT：只保留 id/roomType/passengerIds/roomFraction/isShared/notes，不含 sharedRoomId/splitPairKey/hotelName/orderItemId', () => {
    const result = serializeRoomGroupsFor(UserRole.AGENT, roomAssignment) as {
      roomGroups: Array<Record<string, unknown>>;
    };
    expect(result.roomGroups).toHaveLength(2);
    const [g1, g2] = result.roomGroups;
    expect(g1).toEqual({
      id: 'g1',
      roomType: '大床房',
      passengerIds: ['p1'],
      roomFraction: 1,
      isShared: true,
      notes: '靠窗',
    });
    expect(g1).not.toHaveProperty('sharedRoomId');
    expect(g1).not.toHaveProperty('splitPairKey');
    expect(g1).not.toHaveProperty('hotelName');
    expect(g1).not.toHaveProperty('orderItemId');
    // g2 未共享、缺省份额 1、notes 非字符串（null）回落空串
    expect(g2).toEqual({
      id: 'g2',
      roomType: '双床房',
      passengerIds: ['p2', 'p3'],
      roomFraction: 1,
      isShared: false,
      notes: '',
    });
  });

  it('CUSTOMER：同 AGENT 一样剥离', () => {
    const result = serializeRoomGroupsFor(UserRole.CUSTOMER, roomAssignment) as {
      roomGroups: Array<Record<string, unknown>>;
    };
    expect(result.roomGroups[0]!.isShared).toBe(true);
    expect(result.roomGroups[0]).not.toHaveProperty('sharedRoomId');
  });

  it('角色缺失（undefined）→ fail-closed 按外部角色剥离，不是原样透传', () => {
    const result = serializeRoomGroupsFor(undefined, roomAssignment) as {
      roomGroups: Array<Record<string, unknown>>;
    };
    expect(result.roomGroups[0]).not.toHaveProperty('sharedRoomId');
    expect(result.roomGroups).toHaveLength(2);
  });

  it('roomAssignment 为空/形状不符：外部角色回落 { roomGroups: [] }，不是 null', () => {
    expect(serializeRoomGroupsFor(UserRole.AGENT, null)).toEqual({ roomGroups: [] });
    expect(serializeRoomGroupsFor(UserRole.AGENT, undefined)).toEqual({ roomGroups: [] });
    expect(serializeRoomGroupsFor(UserRole.AGENT, { roomGroups: 'not-an-array' })).toEqual({
      roomGroups: [],
    });
  });

  it('ADMIN 视角对空/形状不符 roomAssignment 原样返回原值（不强行造对象）', () => {
    expect(serializeRoomGroupsFor(UserRole.ADMIN, null)).toBeNull();
    expect(serializeRoomGroupsFor(UserRole.ADMIN, undefined)).toBeUndefined();
  });
});
