/**
 * 跨单分房 · 代理自助拼房归属范围（2026-09-21 拍板）单元测试（vitest）。
 *
 * 覆盖：
 *   - schema：工作台作用域 hotelId | randomStarTier | hotelRoomTypeId 三选一；
 *   - isOrderWithinAgentScope / assertOrdersWithinAgentScope / assertRoomsEditableWithinAgentScope：
 *     ADMIN/STAFF（scope=null）空操作；代理越界 403 文案；查不到的订单同样 403（不暴露存在性）；
 *   - maskRoomForAgent：含范围外成员 → 整间 readOnly + 范围外成员单号/姓名脱敏、占位键不含真实 id、
 *     运营备注置空；纯别家房（一个自家成员都没有，含空房）→ 返回 null 整间不给代理看（F4）；
 *   - getSharedRoomWorkbench：agentScope 非空时候选订单 where 叠 agentId ∈ scope；共享房 readOnly 判定；
 *     ADMIN 路径（无 opts）where 不带 agentId、readOnly 恒 false（回归）；
 *   - saveSharedRooms：代理点名别家订单 → 403 且幂等占位行被清理；触及含范围外成员的房 → 403；
 *   - placeSharedRoom：房内含范围外成员 → 403；归属闸在 CAS 之前（旧版本 + 混合房仍 403 而非 409）。
 * 真库全链路（A/B 两代理 + 运营合住房 + 代理自己两单合住落位）见 *.agent-scope.integration.test.ts。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ForbiddenError } from '../../lib/errors.js';
import { sharedRoomWorkbenchQuerySchema } from './hotel-control.schemas.js';
import {
  AGENT_SCOPE_ORDER_FORBIDDEN,
  AGENT_SCOPE_PLACE_FORBIDDEN,
  AGENT_SCOPE_ROOM_FORBIDDEN,
  EXTERNAL_MEMBER_LABEL,
  assertOrdersWithinAgentScope,
  assertRoomsEditableWithinAgentScope,
  getSharedRoomWorkbench,
  isOrderWithinAgentScope,
  maskRoomForAgent,
  saveSharedRooms,
  type SharedRoomWorkbenchRoom,
} from './hotel-control.shared-rooms.js';
import { placeSharedRoom } from './shared-room-placement.js';

const CHECK_IN = '2026-10-01';
const CHECK_OUT = '2026-10-02';
const SCOPE_A = new Set(['agent-A', 'agent-A-child']);

function member(overrides: Partial<SharedRoomWorkbenchRoom['members'][number]>): SharedRoomWorkbenchRoom['members'][number] {
  return {
    orderId: 'oA',
    orderItemId: 'iA',
    passengerId: 'pA',
    roomFraction: 1,
    orderStatus: 'PAID',
    isActive: true,
    orderNumber: 'FTM-A',
    chineseName: '甲',
    name: 'A',
    ...overrides,
  };
}

function room(members: SharedRoomWorkbenchRoom['members'], notes: string | null = null): SharedRoomWorkbenchRoom {
  return {
    sharedRoomId: 'sr1',
    hotelId: 'h1',
    hotelRoomTypeId: 'rt1',
    randomStarTier: null,
    version: 1,
    notes,
    readOnly: false,
    externalMemberCount: 0,
    members,
  };
}

/** 运营在共享房备注里写别家客人的自由文本（真实场景：姓名 / 单号 / 电话都可能出现）。*/
const SENSITIVE_NOTES = '乙一 FTM-B 13800000000 要靠窗';

describe('schema：工作台作用域三选一（新增 hotelRoomTypeId）', () => {
  const dates = { checkIn: CHECK_IN, checkOut: CHECK_OUT };
  it('只给 hotelRoomTypeId → 通过；与 hotelId / randomStarTier 同给 → 拒绝', () => {
    expect(sharedRoomWorkbenchQuerySchema.safeParse({ hotelRoomTypeId: 'rt1', ...dates }).success).toBe(true);
    expect(sharedRoomWorkbenchQuerySchema.safeParse({ hotelRoomTypeId: 'rt1', hotelId: 'h1', ...dates }).success).toBe(false);
    expect(
      sharedRoomWorkbenchQuerySchema.safeParse({ hotelRoomTypeId: 'rt1', randomStarTier: '4', ...dates }).success,
    ).toBe(false);
    expect(sharedRoomWorkbenchQuerySchema.safeParse({ ...dates }).success).toBe(false);
  });
});

describe('isOrderWithinAgentScope', () => {
  it('ADMIN/STAFF（scope=null）恒 true，直客单也 true', () => {
    expect(isOrderWithinAgentScope({ agentId: null }, null)).toBe(true);
    expect(isOrderWithinAgentScope({ agentId: 'agent-B' }, null)).toBe(true);
  });
  it('代理：自己 / 下级 true；别家 false；直客（agentId=null）false', () => {
    expect(isOrderWithinAgentScope({ agentId: 'agent-A' }, SCOPE_A)).toBe(true);
    expect(isOrderWithinAgentScope({ agentId: 'agent-A-child' }, SCOPE_A)).toBe(true);
    expect(isOrderWithinAgentScope({ agentId: 'agent-B' }, SCOPE_A)).toBe(false);
    expect(isOrderWithinAgentScope({ agentId: null }, SCOPE_A)).toBe(false);
  });
  it('空集合 fail-closed：什么都不在范围内', () => {
    expect(isOrderWithinAgentScope({ agentId: 'agent-A' }, new Set())).toBe(false);
  });
});

describe('assertOrdersWithinAgentScope', () => {
  const orders = new Map([
    ['oA', { agentId: 'agent-A' }],
    ['oB', { agentId: 'agent-B' }],
    ['oDirect', { agentId: null }],
  ]);
  it('scope=null：不校验（连查不到的订单也放行，交给后面的 400）', () => {
    expect(() => assertOrdersWithinAgentScope(['oA', 'oB', 'missing'], orders, null)).not.toThrow();
  });
  it('全部自家单 → 通过', () => {
    expect(() => assertOrdersWithinAgentScope(['oA'], orders, SCOPE_A)).not.toThrow();
  });
  it('点名别家单 → 403「只能分配自己名下的订单」', () => {
    expect(() => assertOrdersWithinAgentScope(['oA', 'oB'], orders, SCOPE_A)).toThrow(ForbiddenError);
    expect(() => assertOrdersWithinAgentScope(['oB'], orders, SCOPE_A)).toThrow(AGENT_SCOPE_ORDER_FORBIDDEN);
  });
  it('点名直客单 → 403', () => {
    expect(() => assertOrdersWithinAgentScope(['oDirect'], orders, SCOPE_A)).toThrow(ForbiddenError);
  });
  it('查不到的订单同样 403（不向代理暴露别家订单是否存在）', () => {
    expect(() => assertOrdersWithinAgentScope(['missing'], orders, SCOPE_A)).toThrow(ForbiddenError);
  });
  it('自定义文案透传', () => {
    expect(() => assertOrdersWithinAgentScope(['oB'], orders, SCOPE_A, AGENT_SCOPE_PLACE_FORBIDDEN)).toThrow(
      AGENT_SCOPE_PLACE_FORBIDDEN,
    );
  });
});

describe('assertRoomsEditableWithinAgentScope', () => {
  it('scope=null：不校验', () => {
    const rooms = new Map([['sr1', ['agent-B', null]]]);
    expect(() => assertRoomsEditableWithinAgentScope(rooms, null)).not.toThrow();
  });
  it('每间房成员都在范围内 → 通过', () => {
    const rooms = new Map([
      ['sr1', ['agent-A', 'agent-A']],
      ['sr2', ['agent-A-child']],
    ]);
    expect(() => assertRoomsEditableWithinAgentScope(rooms, SCOPE_A)).not.toThrow();
  });
  it('任一间房含别家 / 直客成员 → 403「该房间由运营安排、含其他代理客人」', () => {
    expect(() => assertRoomsEditableWithinAgentScope(new Map([['sr1', ['agent-A', 'agent-B']]]), SCOPE_A)).toThrow(
      AGENT_SCOPE_ROOM_FORBIDDEN,
    );
    expect(() => assertRoomsEditableWithinAgentScope(new Map([['sr1', ['agent-A', null]]]), SCOPE_A)).toThrow(
      ForbiddenError,
    );
  });
});

describe('maskRoomForAgent（readOnly 判定 + 脱敏）', () => {
  it('scope=null → 原样返回（同一对象）', () => {
    const r = room([member({})]);
    expect(maskRoomForAgent(r, ['agent-B'], null)).toBe(r);
  });
  it('全员自家 → 不脱敏、readOnly=false', () => {
    const r = room([member({}), member({ orderId: 'oA2', orderItemId: 'iA2', passengerId: 'pA2', roomFraction: 0 })]);
    const out = maskRoomForAgent(r, ['agent-A', 'agent-A-child'], SCOPE_A)!;
    expect(out.readOnly).toBe(false);
    expect(out.externalMemberCount).toBe(0);
    expect(out.members).toEqual(r.members);
  });
  it('全员自家 → 运营备注原样保留（整间都是自家客人）', () => {
    const r = room([member({})], SENSITIVE_NOTES);
    expect(maskRoomForAgent(r, ['agent-A'], SCOPE_A)!.notes).toBe(SENSITIVE_NOTES);
  });
  it('含别家成员 → 整间 readOnly；范围外成员单号/姓名顶替成「其他代理客人」，占位键不含真实 id；自家成员原样', () => {
    const r = room([
      member({}),
      member({ orderId: 'oB', orderItemId: 'iB', passengerId: 'pB1', roomFraction: 0, orderNumber: 'FTM-B', name: 'B1', chineseName: '乙一' }),
      member({ orderId: 'oB', orderItemId: 'iB', passengerId: 'pB2', roomFraction: 0, orderNumber: 'FTM-B', name: 'B2', chineseName: '乙二' }),
      member({ orderId: 'oC', orderItemId: 'iC', passengerId: 'pC', roomFraction: 0, orderNumber: 'FTM-C', name: 'C', chineseName: null }),
    ], SENSITIVE_NOTES);
    const out = maskRoomForAgent(r, ['agent-A', 'agent-B', 'agent-B', null], SCOPE_A)!;
    expect(out.readOnly).toBe(true);
    expect(out.externalMemberCount).toBe(3);
    // F4：运营自由文本备注对代理一律不展示（里面常写别家客人姓名/单号/电话）
    expect(out.notes).toBeNull();
    // 自家成员原样
    expect(out.members[0]).toEqual(r.members[0]);
    // 范围外成员脱敏
    for (const m of out.members.slice(1)) {
      expect(m.orderNumber).toBe(EXTERNAL_MEMBER_LABEL);
      expect(m.name).toBe(EXTERNAL_MEMBER_LABEL);
      expect(m.chineseName).toBeNull();
      expect(m.orderId.startsWith('external-')).toBe(true);
      expect(m.orderItemId).toBe(m.orderId);
      expect(m.passengerId.startsWith(`${m.orderId}-p`)).toBe(true);
    }
    // 同一 (orderId, orderItemId) 共用同一个占位键（前端按键分组后份额结构不变），不同订单不同键
    expect(out.members[1]!.orderId).toBe(out.members[2]!.orderId);
    expect(out.members[3]!.orderId).not.toBe(out.members[1]!.orderId);
    // 乘客占位键互不相同
    expect(new Set(out.members.map((m) => m.passengerId)).size).toBe(4);
    // 份额保留
    expect(out.members.map((m) => m.roomFraction)).toEqual([1, 0, 0, 0]);
    // 真实 id / 单号 / 姓名一个都不漏出去
    const json = JSON.stringify(out);
    for (const secret of ['oB', 'iB', 'pB1', 'pB2', 'oC', 'iC', 'pC', 'FTM-B', 'FTM-C', 'B1', 'B2', '乙一', '乙二', SENSITIVE_NOTES]) {
      expect(json.includes(secret)).toBe(false);
    }
  });
  it('纯别家房（一个自家成员都没有）→ 返回 null，整间不给代理看（F4）', () => {
    const r = room(
      [
        member({ orderId: 'oB', orderItemId: 'iB', passengerId: 'pB', orderNumber: 'FTM-B', name: 'B', chineseName: '乙' }),
        member({ orderId: 'oC', orderItemId: 'iC', passengerId: 'pC', roomFraction: 0, orderNumber: 'FTM-C', name: 'C', chineseName: null }),
      ],
      SENSITIVE_NOTES,
    );
    expect(maskRoomForAgent(r, ['agent-B', null], SCOPE_A)).toBeNull();
    // ADMIN/STAFF 不受影响
    expect(maskRoomForAgent(r, ['agent-B', null], null)).toBe(r);
  });
  it('零成员的空房对代理同样不返回（没有自家成员）', () => {
    expect(maskRoomForAgent(room([], SENSITIVE_NOTES), [], SCOPE_A)).toBeNull();
  });
});

function workbenchClient() {
  const ownOrder = {
    id: 'oA',
    orderNumber: 'FTM-A',
    status: 'PAID',
    agentId: 'agent-A',
    sameHotelWith: null,
    roomAssignment: null,
    passengers: [{ id: 'pA', fullName: 'A', chineseName: null, gender: 'M' }],
  };
  const orderItemFindMany = vi.fn().mockResolvedValue([
    { id: 'iA', roomsBilled: 1, randomStarTier: null, hotelRoomType: { id: 'rt1', name: '双床', hotel: { randomTierPlaceholder: null } }, order: ownOrder },
  ]);
  const sharedRoomFindMany = vi.fn().mockResolvedValue([
    {
      id: 'sr-mixed',
      hotelId: 'h1',
      hotelRoomTypeId: 'rt1',
      randomStarTier: null,
      version: 3,
      notes: SENSITIVE_NOTES,
      members: [
        { orderId: 'oA', orderItemId: 'iA', passengerId: 'pA', roomFraction: 1, order: { status: 'PAID', deletedAt: null, orderNumber: 'FTM-A', agentId: 'agent-A' }, passenger: { fullName: 'A', chineseName: null } },
        { orderId: 'oB', orderItemId: 'iB', passengerId: 'pB', roomFraction: 0, order: { status: 'PAID', deletedAt: null, orderNumber: 'FTM-B', agentId: 'agent-B' }, passenger: { fullName: 'B', chineseName: '乙' } },
      ],
    },
    {
      id: 'sr-own',
      hotelId: 'h1',
      hotelRoomTypeId: 'rt1',
      randomStarTier: null,
      version: 1,
      notes: null,
      members: [
        { orderId: 'oA', orderItemId: 'iA', passengerId: 'pA3', roomFraction: 1, order: { status: 'PAID', deletedAt: null, orderNumber: 'FTM-A', agentId: 'agent-A' }, passenger: { fullName: 'A3', chineseName: null } },
        { orderId: 'oA2', orderItemId: 'iA2', passengerId: 'pA4', roomFraction: 0, order: { status: 'PAID', deletedAt: null, orderNumber: 'FTM-A2', agentId: 'agent-A-child' }, passenger: { fullName: 'A4', chineseName: null } },
      ],
    },
    {
      // 纯别家房：A 的范围里一个成员都没有 → 对 A 整间不返回（F4）
      id: 'sr-foreign',
      hotelId: 'h1',
      hotelRoomTypeId: 'rt1',
      randomStarTier: null,
      version: 7,
      notes: SENSITIVE_NOTES,
      members: [
        { orderId: 'oB2', orderItemId: 'iB2', passengerId: 'pB2', roomFraction: 1, order: { status: 'PAID', deletedAt: null, orderNumber: 'FTM-B2', agentId: 'agent-B' }, passenger: { fullName: 'B2', chineseName: '乙二' } },
      ],
    },
  ]);
  const client = { orderItem: { findMany: orderItemFindMany }, sharedRoom: { findMany: sharedRoomFindMany } } as unknown as PrismaClient;
  return { client, orderItemFindMany };
}

describe('getSharedRoomWorkbench · 代理归属范围', () => {
  it('agentScope 非空：候选订单 where 叠 order.agentId ∈ scope；混合房 readOnly+脱敏，自家房可编辑', async () => {
    const { client, orderItemFindMany } = workbenchClient();
    const wb = await getSharedRoomWorkbench({ hotelId: 'h1' }, CHECK_IN, CHECK_OUT, client, { agentScope: SCOPE_A });
    const where = orderItemFindMany.mock.calls[0]![0].where;
    expect(where.order.agentId).toEqual({ in: [...SCOPE_A] });
    expect(where.order.deletedAt).toBeNull(); // countedOrderWhere 仍在
    expect(wb.orders.map((o) => o.orderId)).toEqual(['oA']);

    const mixed = wb.sharedRooms.find((r) => r.sharedRoomId === 'sr-mixed')!;
    expect(mixed.readOnly).toBe(true);
    expect(mixed.externalMemberCount).toBe(1);
    expect(mixed.members[0]!.orderNumber).toBe('FTM-A');
    expect(mixed.members[1]!.orderNumber).toBe(EXTERNAL_MEMBER_LABEL);
    expect(mixed.members[1]!.name).toBe(EXTERNAL_MEMBER_LABEL);
    expect(JSON.stringify(mixed).includes('FTM-B')).toBe(false);

    const own = wb.sharedRooms.find((r) => r.sharedRoomId === 'sr-own')!;
    expect(own.readOnly).toBe(false);
    expect(own.externalMemberCount).toBe(0);
    expect(own.members.map((m) => m.orderNumber)).toEqual(['FTM-A', 'FTM-A2']);

    // F4：混合房的运营备注置空；纯别家房整间不返回；整份响应里不含别家备注/单号/姓名
    expect(mixed.notes).toBeNull();
    expect(wb.sharedRooms.map((r) => r.sharedRoomId)).toEqual(['sr-mixed', 'sr-own']);
    const json = JSON.stringify(wb);
    for (const secret of [SENSITIVE_NOTES, 'FTM-B2', 'oB2', 'iB2', '乙二', '乙']) {
      expect(json.includes(secret)).toBe(false);
    }
  });

  it('ADMIN 路径（无 opts）：where 不带 agentId，readOnly 恒 false，成员一个不脱敏（回归）', async () => {
    const { client, orderItemFindMany } = workbenchClient();
    const wb = await getSharedRoomWorkbench({ hotelId: 'h1' }, CHECK_IN, CHECK_OUT, client);
    const where = orderItemFindMany.mock.calls[0]![0].where;
    expect(where.order.agentId).toBeUndefined();
    for (const r of wb.sharedRooms) {
      expect(r.readOnly).toBe(false);
      expect(r.externalMemberCount).toBe(0);
    }
    expect(wb.sharedRooms.map((r) => r.sharedRoomId)).toEqual(['sr-mixed', 'sr-own', 'sr-foreign']);
    expect(wb.sharedRooms[0]!.notes).toBe(SENSITIVE_NOTES);
    expect(wb.sharedRooms[0]!.members[1]!.orderNumber).toBe('FTM-B');
    expect(wb.sharedRooms[0]!.members[1]!.chineseName).toBe('乙');
  });
});

/**
 * saveSharedRooms 的最小 mock：只需要走到锁后归属闸（在 CAS / 业务校验之前）——
 * 占位（sharedRoomRequest.create）→ $transaction → 隐式房查询 → 锁 → 锁后订单快照 → 归属闸 403。
 */
function saveClient(opts: {
  orders: Array<{ id: string; agentId: string | null }>;
  /** 触及房（按 sharedRoomId 查成员）返回的成员：orderId + 所属订单 agentId。*/
  roomMembers?: Array<{ sharedRoomId: string; orderId: string; agentId: string | null }>;
}) {
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const memberFindMany = vi.fn().mockImplementation(async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
    const members = opts.roomMembers ?? [];
    // 隐式房查询（按 passengerId）→ 没有隐式房
    if ('passengerId' in args.where) return [];
    // 归属闸查询（select 带 order.agentId）
    if (args.select && 'order' in args.select) {
      return members.map((m) => ({ sharedRoomId: m.sharedRoomId, order: { agentId: m.agentId } }));
    }
    // 锁前 / 锁后成员集合（只要 orderId）
    return members.map((m) => ({ orderId: m.orderId }));
  });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    sharedRoomMember: { findMany: memberFindMany },
    order: {
      findMany: vi.fn().mockResolvedValue(
        opts.orders.map((o) => ({
          id: o.id,
          orderNumber: `FTM-${o.id}`,
          status: 'PAID',
          deletedAt: null,
          agentId: o.agentId,
          roomAssignment: null,
          passengers: [{ id: `p-${o.id}` }],
          items: [],
        })),
      ),
    },
  };
  const client = {
    hotel: { findUnique: vi.fn().mockResolvedValue({ id: 'h1', randomTierPlaceholder: null }) },
    sharedRoomRequest: {
      create: vi.fn().mockResolvedValue({ id: 'resv-1' }),
      deleteMany,
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  return { client, deleteMany, tx };
}

const actor = { userId: 'u-agent', role: 'AGENT' as const };
const groupOf = (orderId: string, fraction: number) => ({
  orderId,
  orderItemId: `i-${orderId}`,
  passengerIds: [`p-${orderId}`],
  roomFraction: fraction,
});

describe('saveSharedRooms · 代理归属闸', () => {
  it('rooms 里点名别家订单 → 403「只能分配自己名下的订单」，幂等占位行被清理', async () => {
    const { client, deleteMany } = saveClient({ orders: [{ id: 'oA', agentId: 'agent-A' }, { id: 'oB', agentId: 'agent-B' }] });
    await expect(
      saveSharedRooms(
        {
          hotelId: 'h1',
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: 'tok-1',
          rooms: [{ hotelRoomTypeId: 'rt1', groups: [groupOf('oA', 1), groupOf('oB', 0)] }],
          dissolve: [],
        },
        actor,
        client,
        { agentScope: SCOPE_A },
      ),
    ).rejects.toThrow(AGENT_SCOPE_ORDER_FORBIDDEN);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'resv-1' } });
  });

  it('解散 / 更新含别家成员的房（readOnly）→ 403「该房间由运营安排、含其他代理客人」', async () => {
    const { client } = saveClient({
      orders: [{ id: 'oA', agentId: 'agent-A' }, { id: 'oB', agentId: 'agent-B' }],
      roomMembers: [
        { sharedRoomId: 'sr-mixed', orderId: 'oA', agentId: 'agent-A' },
        { sharedRoomId: 'sr-mixed', orderId: 'oB', agentId: 'agent-B' },
      ],
    });
    await expect(
      saveSharedRooms(
        {
          hotelId: 'h1',
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: 'tok-2',
          expectedVersions: { 'sr-mixed': 3 },
          rooms: [],
          dissolve: ['sr-mixed'],
        },
        actor,
        client,
        { agentScope: SCOPE_A },
      ),
    ).rejects.toThrow(AGENT_SCOPE_ROOM_FORBIDDEN);
  });

  it('ADMIN 路径（无 opts）：同样的请求不会在归属闸被拦（回归——走到后面的 CAS，这里 mock 里没有该房 → 404）', async () => {
    const { client, tx } = saveClient({
      orders: [{ id: 'oA', agentId: 'agent-A' }, { id: 'oB', agentId: 'agent-B' }],
      roomMembers: [
        { sharedRoomId: 'sr-mixed', orderId: 'oA', agentId: 'agent-A' },
        { sharedRoomId: 'sr-mixed', orderId: 'oB', agentId: 'agent-B' },
      ],
    });
    (tx as unknown as { sharedRoom: unknown }).sharedRoom = { findMany: vi.fn().mockResolvedValue([]) };
    await expect(
      saveSharedRooms(
        {
          hotelId: 'h1',
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: 'tok-3',
          expectedVersions: { 'sr-mixed': 3 },
          rooms: [],
          dissolve: ['sr-mixed'],
        },
        { userId: 'u-admin', role: 'ADMIN' },
        client,
      ),
    ).rejects.toThrow('共享房 sr-mixed 不存在');
  });
});

describe('placeSharedRoom · 代理归属闸', () => {
  function placeClient(memberAgentIds: Record<string, string | null>) {
    const memberOrderIds = Object.keys(memberAgentIds);
    const members = memberOrderIds.map((oid) => ({ orderId: oid, orderItemId: `i-${oid}`, passengerId: `p-${oid}`, roomFraction: 1 }));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      sharedRoom: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'sr-tier',
          status: 'ACTIVE',
          version: 2,
          hotelId: null,
          randomStarTier: 4,
          checkIn: new Date(`${CHECK_IN}T00:00:00.000Z`),
          checkOut: new Date(`${CHECK_OUT}T00:00:00.000Z`),
          members,
        }),
      },
      sharedRoomMember: { findMany: vi.fn().mockResolvedValue([]) },
      order: {
        findMany: vi.fn().mockResolvedValue(memberOrderIds.map((oid) => ({ id: oid, agentId: memberAgentIds[oid] }))),
      },
      hotelRoomType: { findUnique: vi.fn() },
    };
    const client = {
      sharedRoom: { findUnique: vi.fn().mockResolvedValue({ id: 'sr-tier', members }) },
      sharedRoomMember: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;
    return { client, tx };
  }

  it('房内含别家 / 直客成员 → 403「该房间含其他代理客人，整房落位只能由运营操作」，不碰目标房型', async () => {
    const { client, tx } = placeClient({ oA: 'agent-A', oB: 'agent-B' });
    await expect(
      placeSharedRoom('sr-tier', { hotelRoomTypeId: 'rt-real', expectedVersion: 2 }, actor, client, { agentScope: SCOPE_A }),
    ).rejects.toThrow(AGENT_SCOPE_PLACE_FORBIDDEN);
    expect(tx.hotelRoomType.findUnique).not.toHaveBeenCalled();
  });

  it('旧版本 + 混合房 → 403（归属闸在 CAS 之前，不先报 409 暴露别家房的版本）', async () => {
    const { client, tx } = placeClient({ oA: 'agent-A', oB: 'agent-B' });
    await expect(
      // expectedVersion 故意给过期值（落库现状是 2）：归属闸先判，仍然 403 而不是 409
      placeSharedRoom('sr-tier', { hotelRoomTypeId: 'rt-real', expectedVersion: 1 }, actor, client, { agentScope: SCOPE_A }),
    ).rejects.toThrow(AGENT_SCOPE_PLACE_FORBIDDEN);
    expect(tx.hotelRoomType.findUnique).not.toHaveBeenCalled();
  });

  it('零成员的房对代理 → 403（不用 400「没有成员，请先解散」暴露空房存在）', async () => {
    const { client } = placeClient({});
    await expect(
      placeSharedRoom('sr-tier', { hotelRoomTypeId: 'rt-real', expectedVersion: 2 }, actor, client, { agentScope: SCOPE_A }),
    ).rejects.toThrow(AGENT_SCOPE_PLACE_FORBIDDEN);
  });

  it('ADMIN 路径（无 opts）：旧版本仍然按 CAS 报 409（回归——归属闸前移不改运营口径）', async () => {
    const { client } = placeClient({ oA: 'agent-A', oB: 'agent-B' });
    await expect(
      placeSharedRoom(
        'sr-tier',
        { hotelRoomTypeId: 'rt-real', expectedVersion: 1 },
        { userId: 'u-admin', role: 'ADMIN' },
        client,
      ),
    ).rejects.toThrow('该房间已被他人修改，请刷新后重试');
  });

  it('房内全是自家（含下级）成员 → 通过归属闸，走到目标房型校验（mock 里没有该房型 → 400）', async () => {
    const { client, tx } = placeClient({ oA: 'agent-A', oA2: 'agent-A-child' });
    tx.hotelRoomType.findUnique.mockResolvedValue(null);
    await expect(
      placeSharedRoom('sr-tier', { hotelRoomTypeId: 'rt-real', expectedVersion: 2 }, actor, client, { agentScope: SCOPE_A }),
    ).rejects.not.toThrow(ForbiddenError);
    expect(tx.hotelRoomType.findUnique).toHaveBeenCalled();
  });

  it('ADMIN 路径（无 opts）：不查成员单归属（回归）', async () => {
    const { client, tx } = placeClient({ oA: 'agent-A', oB: 'agent-B' });
    tx.hotelRoomType.findUnique.mockResolvedValue(null);
    await expect(
      placeSharedRoom('sr-tier', { hotelRoomTypeId: 'rt-real', expectedVersion: 2 }, { userId: 'u-admin', role: 'ADMIN' }, client),
    ).rejects.not.toThrow(ForbiddenError);
    expect(tx.order.findMany).not.toHaveBeenCalled();
  });
});
