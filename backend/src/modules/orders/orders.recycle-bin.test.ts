/**
 * OrderService.listDeletedOrders + restoreOrder 回收站口径 · 服务级测试（vitest）
 *
 * 用 vi.mock 把 Prisma 替换成可控 fixture，不依赖真 DB。覆盖：
 *   1. 权限：非 ADMIN（STAFF/AGENT/CUSTOMER）看回收站 / 恢复 → ForbiddenError，且不查库不写库
 *   2. listDeletedOrders：只列 deletedAt 非空、按删除时间倒序；映射订单号/客户/金额/原状态/
 *      删除时间/删除人；删除人从 SOFT_DELETE_ORDER 审计取（actorLabel 优先，回退 actor
 *      displayName/email），取不到置 null（不硬凑）
 *   3. restoreOrder：置 deletedAt=null（不改 status —— 不触碰座位账），返回 before/after 供审计
 *   4. 恢复后重新可见：restore 清空 deletedAt，即从「已删」集合移出，回到正常列表口径
 *   5. 未删 / 不存在的订单 restore → NotFoundError（findFirst 只匹配 deletedAt 非空）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findFirst: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
    },
    // 服务用 $transaction([...]) 批量并发；等价 Promise.all
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

// audit 是 fire-and-forget，由路由层调；service 不直接调它。mock 掉避免真写库
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn(),
  actorFromRequest: vi.fn(() => ({})),
}));

import { OrderService } from './orders.service.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN };

beforeEach(() => {
  mockPrisma.order.findFirst.mockReset();
  mockPrisma.order.update.mockReset();
  mockPrisma.order.findMany.mockReset();
  mockPrisma.order.count.mockReset();
  mockPrisma.auditLog.findMany.mockReset();
  mockPrisma.$transaction.mockClear();
});

describe('listDeletedOrders · 权限（仅 ADMIN）', () => {
  it.each([UserRole.STAFF, UserRole.AGENT, UserRole.CUSTOMER])(
    '%s 看回收站 → ForbiddenError，且不查库',
    async (role) => {
      await expect(
        service.listDeletedOrders({ page: 1, pageSize: 50 }, { userId: 'u', role }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockPrisma.order.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
    },
  );
});

describe('listDeletedOrders · 口径与映射', () => {
  it('只列 deletedAt 非空、按删除时间倒序，映射删除人（审计 actorLabel 优先）', async () => {
    const deletedAt = new Date('2026-07-08T12:00:00Z');
    mockPrisma.order.findMany.mockResolvedValue([
      {
        id: 'o1',
        orderNumber: 'FTM1',
        contactName: '张三',
        total: { toString: () => '1200.00' },
        currency: 'CNY',
        status: OrderStatus.CANCELLED,
        deletedAt,
      },
      {
        id: 'o2',
        orderNumber: 'FTM2',
        contactName: '李四',
        total: { toString: () => '800.00' },
        currency: 'CNY',
        status: OrderStatus.REFUNDED,
        deletedAt,
      },
    ]);
    mockPrisma.order.count.mockResolvedValue(2);
    mockPrisma.auditLog.findMany.mockResolvedValue([
      // o1 有缓存 actorLabel → 直接用
      { targetId: 'o1', actorLabel: 'ops@coco', actor: null },
      // o2 无 actorLabel，回退到关联 actor 的 displayName
      { targetId: 'o2', actorLabel: null, actor: { displayName: '运营小组', email: 'x@coco' } },
    ]);

    const res = await service.listDeletedOrders({ page: 1, pageSize: 50 }, ADMIN);

    // findMany 只取 deletedAt 非空、倒序
    const findArg = mockPrisma.order.findMany.mock.calls[0][0];
    expect(findArg.where).toEqual({ deletedAt: { not: null } });
    expect(findArg.orderBy).toEqual({ deletedAt: 'desc' });
    // 审计按目标订单 + 动作查
    const auditArg = mockPrisma.auditLog.findMany.mock.calls[0][0];
    expect(auditArg.where.action).toBe('SOFT_DELETE_ORDER');
    expect(auditArg.where.targetId).toEqual({ in: ['o1', 'o2'] });

    expect(res.pagination).toEqual({ page: 1, pageSize: 50, total: 2 });
    expect(res.orders[0]).toEqual({
      id: 'o1',
      orderNumber: 'FTM1',
      customerName: '张三',
      total: '1200.00',
      currency: 'CNY',
      status: OrderStatus.CANCELLED,
      deletedAt,
      deletedBy: 'ops@coco',
    });
    expect(res.orders[1].deletedBy).toBe('运营小组');
  });

  it('审计缺失时 deletedBy 置 null（不硬凑）', async () => {
    const deletedAt = new Date('2026-07-08T12:00:00Z');
    mockPrisma.order.findMany.mockResolvedValue([
      {
        id: 'o9',
        orderNumber: 'FTM9',
        contactName: '王五',
        total: { toString: () => '500.00' },
        currency: 'CNY',
        status: OrderStatus.PAYMENT_TIMEOUT,
        deletedAt,
      },
    ]);
    mockPrisma.order.count.mockResolvedValue(1);
    mockPrisma.auditLog.findMany.mockResolvedValue([]); // 无审计

    const res = await service.listDeletedOrders({ page: 1, pageSize: 50 }, ADMIN);
    expect(res.orders[0].deletedBy).toBeNull();
  });

  it('无已删订单时不查审计（省一次查询）', async () => {
    mockPrisma.order.findMany.mockResolvedValue([]);
    mockPrisma.order.count.mockResolvedValue(0);

    const res = await service.listDeletedOrders({ page: 1, pageSize: 50 }, ADMIN);
    expect(res.orders).toEqual([]);
    expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});

describe('restoreOrder · 权限（仅 ADMIN）', () => {
  it.each([UserRole.STAFF, UserRole.AGENT, UserRole.CUSTOMER])(
    '%s 恢复 → ForbiddenError，且不查库不写库',
    async (role) => {
      await expect(
        service.restoreOrder('o1', { userId: 'u', role }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockPrisma.order.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.order.update).not.toHaveBeenCalled();
    },
  );
});

describe('restoreOrder · 恢复已软删订单', () => {
  it('置 deletedAt=null（不改 status），返回 before/after 供审计', async () => {
    const deletedAt = new Date('2026-07-08T12:00:00Z');
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.CANCELLED,
      deletedAt,
    });
    mockPrisma.order.update.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.CANCELLED,
      deletedAt: null,
    });

    const res = await service.restoreOrder('o1', ADMIN);

    // 只找已软删订单（deletedAt 非空）
    expect(mockPrisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1', deletedAt: { not: null } } }),
    );
    // 清 deletedAt；绝不改 status（软删/恢复都不触碰座位账）
    const updateArg = mockPrisma.order.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'o1' });
    expect(updateArg.data).toEqual({ deletedAt: null });
    expect(updateArg.data).not.toHaveProperty('status');
    // 审计快照：before 记删除时间、原状态；after 记 deletedAt=null（恢复动作可追溯）
    expect(res.before).toEqual({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.CANCELLED,
      deletedAt,
    });
    expect(res.after.deletedAt).toBeNull();
    expect(res.after.status).toBe(OrderStatus.CANCELLED);
  });

  it('恢复后 deletedAt=null —— 从「已删」集合移出，回到正常列表口径', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.REFUNDED,
      deletedAt: new Date('2026-07-08T12:00:00Z'),
    });
    mockPrisma.order.update.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.REFUNDED,
      deletedAt: null,
    });

    const res = await service.restoreOrder('o1', ADMIN);
    // deletedAt 为 null → 之后 listDeletedOrders 的 where(deletedAt not null) 不再命中它，
    // 同时 buildOrderFilterWhere(deletedAt: null) 会重新纳入它（软删口径见 soft-delete 测试）
    expect(res.after.deletedAt).toBeNull();
  });
});

describe('restoreOrder · 未删 / 不存在', () => {
  it('findFirst 返回 null（未软删或不存在）→ NotFoundError，且不写库', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null);
    await expect(service.restoreOrder('nope', ADMIN)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });
});
