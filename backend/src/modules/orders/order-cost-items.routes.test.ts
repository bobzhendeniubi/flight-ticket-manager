/**
 * order-cost-items 路由 · 单元测试（vitest）
 *
 * 覆盖：
 *   C-16  POST/PATCH amountCny 超出上限 → 400（而不是留到写库时炸 500）
 *   C-17  PATCH/DELETE 命中并发窗口（service 抛 NotFoundError）→ 404，
 *         而不是未捕获异常冒到全局错误处理器变成裸 500
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';
import { NotFoundError } from '../../lib/errors.js';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }) },
  order: { findUnique: vi.fn() },
  orderCostItem: { findUnique: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const serviceMocks = vi.hoisted(() => ({
  create: vi.fn(),
  listByOrder: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));
vi.mock('./order-cost-items.service.js', () => serviceMocks);

vi.mock('../../lib/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/audit.js')>();
  return { ...actual, writeAudit: vi.fn().mockResolvedValue(undefined) };
});

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { orderCostItemRoutes } from './order-cost-items.routes.js';

describe('order-cost-items 路由', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(orderCostItemRoutes, { prefix: '/orders' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } });
  });

  function tokenFor(sub: string, role: UserRole): string {
    return app.jwt.sign({ sub, role });
  }

  const staffToken = () => tokenFor('staff-1', UserRole.STAFF);

  describe('POST /orders/:orderId/cost-items · amountCny 上限（C-16）', () => {
    it('金额超出上限 → 400，不落库', async () => {
      prismaMock.order.findUnique.mockResolvedValue({ id: 'order1', orderNumber: 'FTM001' });
      const res = await app.inject({
        method: 'POST',
        url: '/orders/order1/cost-items',
        headers: { authorization: `Bearer ${staffToken()}` },
        payload: { category: 'OTHER', amountCny: 99_999_999_999 },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMocks.create).not.toHaveBeenCalled();
    });

    it('合法金额 → 201', async () => {
      prismaMock.order.findUnique.mockResolvedValue({ id: 'order1', orderNumber: 'FTM001' });
      serviceMocks.create.mockResolvedValue({
        id: 'ci1',
        orderId: 'order1',
        category: 'OTHER',
        amountCny: 500,
        note: null,
        createdAt: '2026-09-05T00:00:00.000Z',
        updatedAt: '2026-09-05T00:00:00.000Z',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/orders/order1/cost-items',
        headers: { authorization: `Bearer ${staffToken()}` },
        payload: { category: 'OTHER', amountCny: 500 },
      });
      expect(res.statusCode).toBe(201);
      expect(serviceMocks.create).toHaveBeenCalled();
    });
  });

  describe('PATCH /orders/cost-items/:id · 并发删除（C-17）', () => {
    it('先查存在，但 service.update 因记录已被并发删除抛 NotFoundError → 404（不是裸 500）', async () => {
      prismaMock.orderCostItem.findUnique.mockResolvedValue({ id: 'ci1', orderId: 'order1' });
      prismaMock.order.findUnique.mockResolvedValue({ orderNumber: 'FTM001' });
      serviceMocks.update.mockRejectedValue(new NotFoundError('成本明细不存在或已被删除'));

      const res = await app.inject({
        method: 'PATCH',
        url: '/orders/cost-items/ci1',
        headers: { authorization: `Bearer ${staffToken()}` },
        payload: { amountCny: 100 },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe('成本明细不存在或已被删除');
    });

    it('amountCny 超出上限 → 400', async () => {
      prismaMock.orderCostItem.findUnique.mockResolvedValue({ id: 'ci1', orderId: 'order1' });
      const res = await app.inject({
        method: 'PATCH',
        url: '/orders/cost-items/ci1',
        headers: { authorization: `Bearer ${staffToken()}` },
        payload: { amountCny: -99_999_999_999 },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMocks.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /orders/cost-items/:id · 并发删除（C-17）', () => {
    it('先查存在，但 service.remove 因记录已被并发删除抛 NotFoundError → 404', async () => {
      prismaMock.orderCostItem.findUnique.mockResolvedValue({
        id: 'ci1',
        orderId: 'order1',
        category: 'OTHER',
        amountCny: { toString: () => '100' },
        note: null,
      });
      prismaMock.order.findUnique.mockResolvedValue({ orderNumber: 'FTM001' });
      serviceMocks.remove.mockRejectedValue(new NotFoundError('成本明细不存在或已被删除'));

      const res = await app.inject({
        method: 'DELETE',
        url: '/orders/cost-items/ci1',
        headers: { authorization: `Bearer ${staffToken()}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe('成本明细不存在或已被删除');
    });
  });
});
