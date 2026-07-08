/**
 * OrderService.softDeleteOrder + buildOrderFilterWhere 软删除口径 · 服务级测试（vitest）
 *
 * 用 vi.mock 把 Prisma 替换成可控 fixture，不依赖真 DB。覆盖：
 *   1. 权限：非 ADMIN（STAFF/AGENT/CUSTOMER）删单 → ForbiddenError，不落任何写
 *   2. 前置守卫：仍占座状态（SEAT_HOLDING_STATUSES）拒删 → BadRequestError，且 update 从未被调用
 *      （证明删除绝不偷偷释放座位）
 *   3. 已释放型状态（CANCELLED 等）可删：写 deletedAt，返回 before/after 供路由写审计
 *   4. 不存在 / 已删过 → NotFoundError（findFirst 只匹配 deletedAt: null）
 *   5. 列表/导出口径：buildOrderFilterWhere 两条分支都挂 deletedAt: null（软删后列表/导出不含）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

// audit 是 fire-and-forget，softDeleteOrder 本身不调它（由路由层调）；mock 掉避免真写库
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn(),
  actorFromRequest: vi.fn(() => ({})),
}));

import { OrderService, buildOrderFilterWhere } from './orders.service.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN };

beforeEach(() => {
  mockPrisma.order.findFirst.mockReset();
  mockPrisma.order.update.mockReset();
});

describe('softDeleteOrder · 权限（仅 ADMIN）', () => {
  it.each([UserRole.STAFF, UserRole.AGENT, UserRole.CUSTOMER])(
    '%s 删单 → ForbiddenError，且不查库不写库',
    async (role) => {
      await expect(
        service.softDeleteOrder('o1', { userId: 'u', role }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockPrisma.order.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.order.update).not.toHaveBeenCalled();
    },
  );
});

describe('softDeleteOrder · 前置守卫（占座状态拒删）', () => {
  const SEAT_HOLDING: OrderStatus[] = [
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAID,
    OrderStatus.PROCESSING,
    OrderStatus.TICKETED,
    OrderStatus.COMPLETED,
    OrderStatus.CHANGE_REQUESTED,
    OrderStatus.CHANGED,
    OrderStatus.REFUND_REQUESTED,
  ];

  it.each(SEAT_HOLDING)('占座状态 %s 拒删 → BadRequestError，update 从不被调用', async (status) => {
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'o1', orderNumber: 'FTM1', status });
    await expect(service.softDeleteOrder('o1', ADMIN)).rejects.toBeInstanceOf(BadRequestError);
    // CRITICAL：删除绝不偷偷释放座位——拒删路径不得触碰任何写
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });
});

describe('softDeleteOrder · 已释放型状态可删', () => {
  const SEAT_RELEASING: OrderStatus[] = [
    OrderStatus.CANCELLED,
    OrderStatus.PAYMENT_TIMEOUT,
    OrderStatus.REFUNDED,
    OrderStatus.FAILED,
    OrderStatus.DRAFT,
  ];

  it.each(SEAT_RELEASING)('%s 可删：置 deletedAt，返回 before/after 供审计', async (status) => {
    const deletedAt = new Date('2026-07-08T12:00:00Z');
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'o1', orderNumber: 'FTM1', status });
    mockPrisma.order.update.mockResolvedValue({ id: 'o1', orderNumber: 'FTM1', status, deletedAt });

    const res = await service.softDeleteOrder('o1', ADMIN);

    // 只找未删订单
    expect(mockPrisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1', deletedAt: null } }),
    );
    // 写 deletedAt（软删，不改 status —— 不触碰座位账）
    const updateArg = mockPrisma.order.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'o1' });
    expect(updateArg.data.deletedAt).toBeInstanceOf(Date);
    expect(updateArg.data).not.toHaveProperty('status');
    // 返回审计快照
    expect(res.before).toEqual({ id: 'o1', orderNumber: 'FTM1', status });
    expect(res.after.deletedAt).toBe(deletedAt);
  });
});

describe('softDeleteOrder · 不存在 / 已删过', () => {
  it('findFirst 返回 null（不存在或已软删）→ NotFoundError', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null);
    await expect(service.softDeleteOrder('nope', ADMIN)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });
});

describe('buildOrderFilterWhere · 软删后列表/导出不含（deletedAt: null）', () => {
  it('普通筛选分支挂 deletedAt: null', () => {
    const where = buildOrderFilterWhere({ status: OrderStatus.CANCELLED });
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe(OrderStatus.CANCELLED);
  });

  it('勾选导出（orderIds）分支也挂 deletedAt: null —— 已删单即便被显式勾中也不导出', () => {
    const where = buildOrderFilterWhere({ orderIds: ['a', 'b'] });
    expect(where.deletedAt).toBeNull();
    expect(where.id).toEqual({ in: ['a', 'b'] });
  });

  it('无任何筛选也排除已删', () => {
    const where = buildOrderFilterWhere({});
    expect(where.deletedAt).toBeNull();
  });
});
