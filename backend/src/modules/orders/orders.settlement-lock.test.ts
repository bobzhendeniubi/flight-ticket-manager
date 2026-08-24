/**
 * 订单结算价锁定：路由鉴权、批量计数、审计，以及改价锁冲突。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';
import { ConflictError } from '../../lib/errors.js';
import { batchSettlementLockBodySchema } from './orders.schemas.js';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }) },
  agent: { findUnique: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const batchSetSettlementLockMock = vi.hoisted(() => vi.fn());
const updateItemSettlementPriceMock = vi.hoisted(() => vi.fn());
vi.mock('./orders.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orders.service.js')>();
  return {
    ...actual,
    OrderService: vi.fn().mockImplementation(() => ({
      batchSetSettlementLock: batchSetSettlementLockMock,
      updateItemSettlementPrice: updateItemSettlementPriceMock,
    })),
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

describe('batchSettlementLockBodySchema', () => {
  it('要求 1~500 个订单且 lock 必须是布尔值', () => {
    expect(() => batchSettlementLockBodySchema.parse({ orderIds: [], lock: true })).toThrow();
    expect(() => batchSettlementLockBodySchema.parse({ orderIds: ['o1'], lock: 'true' })).toThrow();
    expect(() =>
      batchSettlementLockBodySchema.parse({ orderIds: ['o1'], lock: false }),
    ).not.toThrow();
  });
});

describe('订单结算价锁定路由', () => {
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
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: true });
  });

  function tokenFor(sub: string, role: UserRole): string {
    return app.jwt.sign({ sub, role });
  }

  function postLock(token: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/orders/batch/settlement-lock',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  it.each<UserRole>([UserRole.CUSTOMER, UserRole.AGENT])(
    'role=%s 拒绝批量锁定/解锁',
    async (role) => {
      const res = await postLock(tokenFor(`user-${role}`, role), { orderIds: ['o1'], lock: true });
      expect(res.statusCode).toBe(403);
      expect(batchSetSettlementLockMock).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])('STAFF 批量 lock=%s 返回 updated/skipped 并逐单审计', async (lock) => {
    const at = new Date('2026-07-23T01:00:00.000Z');
    batchSetSettlementLockMock.mockResolvedValue({
      updated: 2,
      skipped: 1,
      results: [
        { id: 'o1', orderNumber: 'ORD-001', beforeLocked: !lock, settlementLockedAt: lock ? at : null },
        { id: 'o2', orderNumber: 'ORD-002', beforeLocked: false, settlementLockedAt: lock ? at : null },
      ],
    });

    const res = await postLock(tokenFor('staff-1', UserRole.STAFF), {
      orderIds: ['o1', 'o2', 'missing'],
      lock,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: 2, skipped: 1 });
    expect(batchSetSettlementLockMock).toHaveBeenCalledWith(['o1', 'o2', 'missing'], lock, 'staff-1');
    expect(writeAudit).toHaveBeenCalledTimes(2);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: lock ? 'LOCK_SETTLEMENT_PRICE' : 'UNLOCK_SETTLEMENT_PRICE',
        targetType: 'ORDER',
      }),
    );
  });

  it('锁后改结算价返回 409', async () => {
    updateItemSettlementPriceMock.mockRejectedValueOnce(
      new ConflictError('结算价已锁定，请先解锁再修改'),
    );
    const res = await app.inject({
      method: 'PATCH',
      url: '/orders/o1/items/item1/settlement-price',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
      payload: { unitPriceCny: 1200 },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { message: string } }).error.message).toBe(
      '结算价已锁定，请先解锁再修改',
    );
  });

  it('解锁后改结算价可以继续执行', async () => {
    updateItemSettlementPriceMock.mockResolvedValueOnce({
      order: { id: 'o1', settlementLocked: false },
      warning: null,
      audit: {
        orderNumber: 'ORD-001',
        orderItemId: 'item1',
        before: {},
        after: {},
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/orders/o1/items/item1/settlement-price',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
      payload: { unitPriceCny: 1200 },
    });
    expect(res.statusCode).toBe(200);
    expect(updateItemSettlementPriceMock).toHaveBeenCalledWith(
      'o1',
      'item1',
      { unitPriceCny: 1200 },
      { userId: 'staff-1', role: UserRole.STAFF },
    );
  });
});
