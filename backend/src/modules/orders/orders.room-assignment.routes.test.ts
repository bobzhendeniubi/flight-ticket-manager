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
    order: { update: vi.fn().mockResolvedValue({}) },
    orderItem: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
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
