/**
 * 分房保存 · 路由级单测（鉴权 + 代理归属）
 *
 * 口径（2026-09）：代理可以给自家（含下级）订单分房，与运营用同一个编辑器、同一条保存接口；
 * 归属靠 service.getOrder（assertCanView）判，客户仍旧 403。
 * 分房本身的房量闸 / roomsBilled 分行落 / 警示文案不在这里测（见 hotel-control 与集成测试）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => {
  const tx = {
    // 分房保存现在锁序「先 Order 后酒店」：处理器自己在 tx 里 $queryRaw FOR UPDATE 锁本单，
    // 再 tx.order.findUnique 重读锁后现状（reconcile 共享组用）——两者都要 mock 掉。
    $queryRaw: vi.fn().mockResolvedValue([]),
    order: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ roomAssignment: null }),
    },
    orderItem: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({ _sum: { roomsBilled: null } }),
    },
  };
  return {
    tx,
    user: {
      findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }),
    },
    agent: { findUnique: vi.fn() },
    order: { findUnique: vi.fn(), update: vi.fn() },
    orderItem: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: { roomsBilled: null } }),
    },
    passenger: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
});
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const serviceMocks = vi.hoisted(() => ({
  getOrder: vi.fn(),
}));
vi.mock('./orders.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orders.service.js')>();
  return {
    ...actual,
    OrderService: vi.fn().mockImplementation(() => serviceMocks),
  };
});

vi.mock('../../lib/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/audit.js')>();
  return { ...actual, writeAudit: vi.fn().mockResolvedValue(undefined) };
});

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { orderRoutes } from './orders.routes.js';
import { writeAudit } from '../../lib/audit.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

describe('PUT /orders/:id/room-assignment · 角色与归属', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(orderRoutes, { prefix: '/orders' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      agentProfile: { isActive: true },
    });
    prismaMock.agent.findUnique.mockResolvedValue({ id: 'ag-1', isActive: true });
    prismaMock.order.findUnique.mockResolvedValue({ orderNumber: 'FTM-1', roomAssignment: null });
    prismaMock.orderItem.count.mockResolvedValue(0);
    prismaMock.orderItem.aggregate.mockResolvedValue({ _sum: { roomsBilled: null } });
    prismaMock.passenger.findMany.mockResolvedValue([]);
    prismaMock.tx.orderItem.findMany.mockResolvedValue([]);
    prismaMock.tx.orderItem.findFirst.mockResolvedValue(null);
    serviceMocks.getOrder.mockResolvedValue({ id: 'o1' });
  });

  const tokenFor = (sub: string, role: UserRole) => app.jwt.sign({ sub, role });

  const body = {
    roomGroups: [
      { id: 'g1', hotelName: '椰岛大酒店', roomType: '双床', passengerIds: ['p1', 'p2'] },
    ],
  };

  const put = (role: UserRole) =>
    app.inject({
      method: 'PUT',
      url: '/orders/o1/room-assignment',
      headers: { authorization: `Bearer ${tokenFor(`u-${role}`, role)}` },
      payload: body,
    });

  it('客户 → 403，不查归属也不落库', async () => {
    const res = await put(UserRole.CUSTOMER);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: '仅运营 / 代理可分房' });
    expect(serviceMocks.getOrder).not.toHaveBeenCalled();
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });

  it('代理给自家单分房 → 先过归属（带 agentId），再照运营路径落库 + 审计', async () => {
    const res = await put(UserRole.AGENT);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, warnings: [] });
    expect(serviceMocks.getOrder).toHaveBeenCalledWith('o1', {
      userId: 'u-AGENT',
      role: UserRole.AGENT,
      agentId: 'ag-1',
    });
    expect(prismaMock.tx.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { roomAssignment: body },
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UPDATE_ROOM_ASSIGNMENT', targetId: 'o1' }),
    );
  });

  it('代理碰别家的单（归属校验 403）→ 原样回 403，不落库', async () => {
    serviceMocks.getOrder.mockRejectedValue(new ForbiddenError('无权查看该订单'));
    const res = await put(UserRole.AGENT);
    expect(res.statusCode).toBe(403);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('代理分不存在的单 → 404', async () => {
    serviceMocks.getOrder.mockRejectedValue(new NotFoundError('订单不存在'));
    const res = await put(UserRole.AGENT);
    expect(res.statusCode).toBe(404);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });

  it('运营路径不受影响：不走归属校验，直接落库', async () => {
    const res = await put(UserRole.STAFF);
    expect(res.statusCode).toBe(200);
    expect(serviceMocks.getOrder).not.toHaveBeenCalled();
    expect(prismaMock.tx.order.update).toHaveBeenCalled();
  });
});

/**
 * PUT /orders/:id/room-assignment · 跨单分房 reconcile（§五「改」+ astra 评审 finding 9）
 *
 *   - 服务端以「锁后现状」（tx.order.findUnique 重读，而不是请求前的旧值）为准，把客户端
 *     发不出来的 sharedRoomId / splitPairKey 搬回最终写库的 roomGroups；
 *   - 带 sharedRoomId 的旧房组：改乘客/酒店名/房型/份额/归属或整组删除 → 400；只改 notes → 放行；
 *   - 没有 sharedRoomId 的旧房组若带 splitPairKey（拆单配对键），resave 后原样保留（finding 9）。
 */
describe('PUT /orders/:id/room-assignment · 跨单分房 reconcile', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(orderRoutes, { prefix: '/orders' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      agentProfile: { isActive: true },
    });
    prismaMock.order.findUnique.mockResolvedValue({ orderNumber: 'FTM-1', roomAssignment: null });
    prismaMock.orderItem.count.mockResolvedValue(0);
    prismaMock.orderItem.aggregate.mockResolvedValue({ _sum: { roomsBilled: null } });
    prismaMock.passenger.findMany.mockResolvedValue([]);
    prismaMock.tx.orderItem.findMany.mockResolvedValue([]);
    prismaMock.tx.orderItem.findFirst.mockResolvedValue(null);
    prismaMock.tx.orderItem.aggregate.mockResolvedValue({ _sum: { roomsBilled: null } });
    prismaMock.tx.$queryRaw.mockResolvedValue([]);
  });

  const tokenFor = (sub: string, role: UserRole) => app.jwt.sign({ sub, role });

  const putStaff = (payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: '/orders/o1/room-assignment',
      headers: { authorization: `Bearer ${tokenFor('u-STAFF', UserRole.STAFF)}` },
      payload,
    });

  it('拆单配对键（splitPairKey）resave 后原样保留——不因编辑器重构对象而丢失', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({
      roomAssignment: {
        roomGroups: [
          {
            id: 'g1',
            hotelName: '椰岛大酒店',
            roomType: '双床',
            passengerIds: ['p1'],
            roomFraction: 0.5,
            splitPairKey: 'pair-abc',
          },
        ],
      },
    });
    // 编辑器重存：整个对象重新构造，不带 splitPairKey（这正是 finding 9 描述的存量 bug 触发点）
    const res = await putStaff({
      roomGroups: [
        { id: 'g1', hotelName: '椰岛大酒店', roomType: '双床', passengerIds: ['p1'], roomFraction: 0.5 },
      ],
    });
    expect(res.statusCode).toBe(200);
    const written = prismaMock.tx.order.update.mock.calls[0][0].data.roomAssignment;
    expect(written.roomGroups[0].splitPairKey).toBe('pair-abc');
  });

  it('带 sharedRoomId 的房组只改 notes → 放行，sharedRoomId 原样保留', async () => {
    // orderItemId 归属校验（本单的酒店/套餐行）与 reconcile 是两道独立闸——这里过归属闸。
    prismaMock.orderItem.count.mockResolvedValue(1);
    prismaMock.tx.order.findUnique.mockResolvedValue({
      roomAssignment: {
        roomGroups: [
          {
            id: 'g1',
            hotelName: '椰岛大酒店',
            roomType: '双床',
            passengerIds: ['p1'],
            roomFraction: 0,
            orderItemId: 'item1',
            sharedRoomId: 'sr1',
            notes: '旧备注',
          },
        ],
      },
    });
    const res = await putStaff({
      roomGroups: [
        {
          id: 'g1',
          hotelName: '椰岛大酒店',
          roomType: '双床',
          passengerIds: ['p1'],
          roomFraction: 0,
          orderItemId: 'item1',
          notes: '新备注',
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const written = prismaMock.tx.order.update.mock.calls[0][0].data.roomAssignment;
    expect(written.roomGroups[0]).toMatchObject({ sharedRoomId: 'sr1', notes: '新备注', roomFraction: 0 });
  });

  it('带 sharedRoomId 的房组改乘客 → 400，不落库', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({
      roomAssignment: {
        roomGroups: [
          {
            id: 'g1',
            hotelName: '椰岛大酒店',
            roomType: '双床',
            passengerIds: ['p1'],
            roomFraction: 1,
            orderItemId: 'item1',
            sharedRoomId: 'sr1',
          },
        ],
      },
    });
    const res = await putStaff({
      roomGroups: [
        {
          id: 'g1',
          hotelName: '椰岛大酒店',
          roomType: '双床',
          passengerIds: ['p1', 'p2'],
          roomFraction: 1,
          orderItemId: 'item1',
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });

  it('直接删除带 sharedRoomId 的房组（新 payload 里整组消失）→ 400，不落库', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({
      roomAssignment: {
        roomGroups: [
          {
            id: 'g1',
            hotelName: '椰岛大酒店',
            roomType: '双床',
            passengerIds: ['p1'],
            roomFraction: 1,
            orderItemId: 'item1',
            sharedRoomId: 'sr1',
          },
        ],
      },
    });
    const res = await putStaff({ roomGroups: [] });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });

  it('普通（非共享）房组 roomFraction=0 → 400', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({ roomAssignment: null });
    const res = await putStaff({
      roomGroups: [
        { id: 'g1', hotelName: '椰岛大酒店', roomType: '双床', passengerIds: ['p1'], roomFraction: 0 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });
});
