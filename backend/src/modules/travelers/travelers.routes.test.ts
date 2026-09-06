/**
 * 旅客档案详情的代理作用域单测（B-4）。
 *
 * 走真实路由 + 真实 TravelersService（只 mock prisma），一并盖住
 * 「路由把 agentTreeIds 传下去」与「service 按 order.agentId 圈定」两段。
 *
 * 覆盖：
 *   - AGENT 看详情：历史行程只出自己代理树里的订单，tripCount / lastTripAt 同口径
 *   - ADMIN/STAFF 看详情：不加圈定，全量历史行程
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  agent: { findUnique: vi.fn() },
  savedPassenger: { findUnique: vi.fn() },
  passenger: { findMany: vi.fn() },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

vi.mock('../../lib/agent-tree.js', () => ({
  getDescendantAgentIds: vi.fn().mockResolvedValue(['agent-self', 'agent-child']),
}));

vi.mock('../../lib/audit.js', () => ({
  actorFromRequest: vi.fn(() => ({})),
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { travelerRoutes } from './travelers.routes.js';

const DOB = new Date('1990-01-01T00:00:00.000Z');

const savedPassengerRow = {
  id: 't1',
  userId: 'cust-1',
  fullName: 'ZHANG SAN',
  documentType: 'PASSPORT',
  documentNumber: 'E12345678',
  dateOfBirth: DOB,
  nationality: 'CN',
  passengerType: 'ADULT',
  phone: null,
  notes: null,
  user: {
    id: 'cust-1',
    displayName: '张三',
    email: null,
    phone: null,
    customerProfile: { primaryAgentId: 'agent-child' },
  },
};

/** 自己树内的订单行 */
const inScopePassenger = {
  id: 'p-in',
  pnr: 'AAAAAA',
  eticketNumber: '999-111',
  order: {
    id: 'o-in',
    orderNumber: 'FTM-IN',
    status: 'TICKETED',
    total: { toString: () => '5000.00' },
    createdAt: new Date('2026-08-01T02:00:00.000Z'),
  },
};

/** 别家代理的订单行 —— 同名同生日撞出来的，不该给 AGENT 看见 */
const outOfScopePassenger = {
  id: 'p-out',
  pnr: 'BBBBBB',
  eticketNumber: '999-222',
  order: {
    id: 'o-out',
    orderNumber: 'FTM-OUT',
    status: 'COMPLETED',
    total: { toString: () => '8000.00' },
    createdAt: new Date('2026-09-01T02:00:00.000Z'),
  },
};

describe('GET /travelers/:id 历史行程代理圈定', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(travelerRoutes, { prefix: '/travelers' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.agent.findUnique.mockResolvedValue({ id: 'agent-self' });
    prismaMock.savedPassenger.findUnique.mockResolvedValue(savedPassengerRow);
  });

  function tokenFor(sub: string, role: UserRole): string {
    return app.jwt.sign({ sub, role });
  }

  function asAgent(): void {
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: null,
      agentProfile: { isActive: true },
    });
  }

  function asStaff(): void {
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: null,
      agentProfile: null,
    });
  }

  it('AGENT 只看得到自己代理树里的历史行程，次数与最近一次同口径', async () => {
    asAgent();
    // 查询被圈定后，库里只会回自己树内那条
    prismaMock.passenger.findMany.mockResolvedValue([inScopePassenger]);

    const res = await app.inject({
      method: 'GET',
      url: '/travelers/t1',
      headers: { authorization: `Bearer ${tokenFor('agent-user', UserRole.AGENT)}` },
    });

    expect(res.statusCode).toBe(200);
    expect(prismaMock.passenger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fullName: 'ZHANG SAN',
          dateOfBirth: DOB,
          order: { agentId: { in: ['agent-self', 'agent-child'] } },
        }),
      }),
    );

    const { traveler } = res.json();
    expect(traveler.trips).toHaveLength(1);
    expect(traveler.trips[0].order.orderNumber).toBe('FTM-IN');
    expect(traveler.tripCount).toBe(1);
    expect(traveler.lastTripAt).toBe(inScopePassenger.order.createdAt.toISOString());
  });

  it('ADMIN/STAFF 不受圈定，历史行程照旧全量', async () => {
    asStaff();
    prismaMock.passenger.findMany.mockResolvedValue([outOfScopePassenger, inScopePassenger]);

    const res = await app.inject({
      method: 'GET',
      url: '/travelers/t1',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });

    expect(res.statusCode).toBe(200);
    const call = prismaMock.passenger.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where.order).toBeUndefined();

    const { traveler } = res.json();
    expect(traveler.trips).toHaveLength(2);
    expect(traveler.tripCount).toBe(2);
  });
});
