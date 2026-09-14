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

  /**
   * astra B1：房组 id 曾经真实落库成 `shared:<sharedRoomId>:<orderItemId>` 的形状——这个
   * 函数按字段选择性透传，不解析/改写 id 的内容，所以「id 本身不能带敏感信息」是**写入方**
   * （hotel-control.shared-rooms.ts 的 saveSharedRooms）的职责，不是这层 DTO 的职责：DTO
   * 猜不出一个字符串 id 里有没有夹带 sharedRoomId，硬要在这里扫描/改写反而会把 AGENT 单单
   * 分房编辑器回传的 id 和服务端锁后现状的 id 对不上（reconcile 靠 id 相等匹配旧组）。
   * 写入方已经改成生成不含任何关系信息的随机 id（并有存量迁移脚本
   * rewrite-shared-room-group-ids.ts），端到端验证见
   * hotel-control.shared-rooms.integration.test.ts 的 astra B1 用例：真正调用
   * saveSharedRooms 产出的 id 过一遍这个函数，断言整份响应不含 sharedRoomId 原文。
   */
  it('原样透传 id 字段——不解析/改写其内容（id 是否携带敏感信息由写入方负责）', () => {
    const result = serializeRoomGroupsFor(UserRole.AGENT, roomAssignment) as {
      roomGroups: Array<{ id: string }>;
    };
    expect(result.roomGroups[0]!.id).toBe('g1');
  });
});
