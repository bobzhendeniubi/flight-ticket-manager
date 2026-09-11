/**
 * POST /orders/:id/restore-cancelled · 路由级单测（鉴权 + 审计留痕）
 *
 * 服务层口径见 orders.restore-cancelled.test.ts；这里只管路由这一层：
 *   1. AGENT / CUSTOMER → 403（requireRole 硬闸），不触服务；
 *   2. STAFF / ADMIN 可达：透传 requestToken/allowOversell，普通恢复记 WARNING 审计 RESTORE_CANCELLED_ORDER；
 *   3. 超售放行那一档的 CRITICAL 审计已在 service 事务里写过，路由不再重复记；回放也不记；
 *   4. 请求体缺 requestToken → 400。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }),
  },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const serviceMocks = vi.hoisted(() => ({
  restoreCancelledOrder: vi.fn(),
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

const TOKEN = '00000000-0000-4000-8000-00000000c0de';

const baseAudit = {
  orderNumber: 'FTM-RESTORE-001',
  fromStatus: 'CANCELLED',
  toStatus: 'PENDING_PAYMENT',
  seats: [],
  seatTotal: 1,
  oversold: false,
  oversoldBy: 0,
  displacedReserved: 0,
  hotelOversold: [],
  randomTierOversold: [],
  paymentExpiresAt: null,
  invoiceCapWarnings: [],
  warnings: [],
  commissionsReaccrued: false,
  replayed: false,
};

describe('POST /orders/:id/restore-cancelled', () => {
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
  });

  const call = (role: UserRole, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/orders/o1/restore-cancelled',
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: `u-${role}`, role })}` },
      payload: payload as Record<string, unknown>,
    });

  it('AGENT → 403，不触服务', async () => {
    const res = await call(UserRole.AGENT, { requestToken: TOKEN });
    expect(res.statusCode).toBe(403);
    expect(serviceMocks.restoreCancelledOrder).not.toHaveBeenCalled();
  });

  it('CUSTOMER → 403，不触服务', async () => {
    const res = await call(UserRole.CUSTOMER, { requestToken: TOKEN });
    expect(res.statusCode).toBe(403);
    expect(serviceMocks.restoreCancelledOrder).not.toHaveBeenCalled();
  });

  it('STAFF → 200：透传入参，普通恢复记 WARNING 审计 RESTORE_CANCELLED_ORDER', async () => {
    serviceMocks.restoreCancelledOrder.mockResolvedValue({ order: { id: 'o1' }, audit: baseAudit });
    const res = await call(UserRole.STAFF, { requestToken: TOKEN, allowOversell: true, note: '客人又要走了' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ order: { id: 'o1' }, audit: baseAudit });
    expect(serviceMocks.restoreCancelledOrder).toHaveBeenCalledWith(
      'o1',
      { requestToken: TOKEN, allowOversell: true, note: '客人又要走了' },
      { userId: 'u-STAFF', role: UserRole.STAFF },
    );
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'RESTORE_CANCELLED_ORDER',
        targetType: 'ORDER',
        targetId: 'o1',
        severity: 'WARNING',
        before: { status: 'CANCELLED' },
        after: expect.objectContaining({ toStatus: 'PENDING_PAYMENT', seatTotal: 1, note: '客人又要走了' }),
      }),
    );
  });

  it('ADMIN 超售放行 → 路由不再重复记审计（CRITICAL 已在 service 事务内落）', async () => {
    serviceMocks.restoreCancelledOrder.mockResolvedValue({
      order: { id: 'o1' },
      audit: { ...baseAudit, oversold: true, oversoldBy: 1 },
    });
    const res = await call(UserRole.ADMIN, { requestToken: TOKEN, allowOversell: true });
    expect(res.statusCode).toBe(200);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('幂等回放 → 不记审计', async () => {
    serviceMocks.restoreCancelledOrder.mockResolvedValue({
      order: { id: 'o1' },
      audit: { ...baseAudit, replayed: true },
    });
    const res = await call(UserRole.STAFF, { requestToken: TOKEN });
    expect(res.statusCode).toBe(200);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('缺 requestToken → 400，不触服务', async () => {
    const res = await call(UserRole.STAFF, { allowOversell: true });
    expect(res.statusCode).toBe(400);
    expect(serviceMocks.restoreCancelledOrder).not.toHaveBeenCalled();
  });
});
