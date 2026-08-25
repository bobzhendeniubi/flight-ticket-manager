/**
 * OrderService.softDeleteOrder + buildOrderFilterWhere 软删除口径 · 服务级测试（vitest）
 *
 * 用 vi.mock 把 Prisma 替换成可控 fixture，不依赖真 DB。覆盖：
 *   1. 权限：非内部员工（AGENT/CUSTOMER）删单 → ForbiddenError，不落任何写；STAFF 放行
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

describe('softDeleteOrder · 权限（ADMIN + STAFF）', () => {
  it.each([UserRole.AGENT, UserRole.CUSTOMER])(
    '%s 删单 → ForbiddenError，且不查库不写库',
    async (role) => {
      await expect(
        service.softDeleteOrder('o1', { userId: 'u', role }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockPrisma.order.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.order.update).not.toHaveBeenCalled();
    },
  );

  // STAFF 与 ADMIN 同权：过权限闸后走同一套前置守卫（占座/净收款），不因角色分叉。
  it('STAFF 删单 → 过权限闸，进入前置守卫（此处订单不存在 → NotFoundError）', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null);
    await expect(
      service.softDeleteOrder('o1', { userId: 'u', role: UserRole.STAFF }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.order.findFirst).toHaveBeenCalled();
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });
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
  ];

  it.each(SEAT_HOLDING)('占座状态 %s 拒删 → BadRequestError，update 从不被调用', async (status) => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status,
      paidAmount: 0,
      refunds: [],
    });
    await expect(service.softDeleteOrder('o1', ADMIN)).rejects.toBeInstanceOf(BadRequestError);
    // CRITICAL：删除绝不偷偷释放座位——拒删路径不得触碰任何写
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });
});

describe('softDeleteOrder · 已释放型状态可删（零收款）', () => {
  const SEAT_RELEASING: OrderStatus[] = [
    OrderStatus.CANCELLED,
    OrderStatus.PAYMENT_TIMEOUT,
    OrderStatus.REFUNDED,
    OrderStatus.FAILED,
    OrderStatus.DRAFT,
    OrderStatus.REFUND_REQUESTED,
  ];

  it.each(SEAT_RELEASING)('%s 可删：置 deletedAt，返回 before/after 供审计', async (status) => {
    const deletedAt = new Date('2026-07-08T12:00:00Z');
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status,
      paidAmount: 0,
      refunds: [],
    });
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

describe('softDeleteOrder · 净收款守卫', () => {
  it('已确认收款未退（paidAmount>0，无退款记录）→ BadRequestError，金额带进提示，update 从不被调用', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.CANCELLED,
      paidAmount: 3000,
      refunds: [],
    });

    await expect(service.softDeleteOrder('o1', ADMIN)).rejects.toThrow(
      /该订单尚有已收款 ¥3000\.00 未退，请先完成退款再删除/,
    );
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('已收款但部分退款未退完（paidAmount=3000，已完成退款=1000）→ 按差额拒删', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.REFUNDED,
      paidAmount: 3000,
      refunds: [{ amount: 1000 }],
    });

    await expect(service.softDeleteOrder('o1', ADMIN)).rejects.toThrow(
      /该订单尚有已收款 ¥2000\.00 未退，请先完成退款再删除/,
    );
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('收退已平（paidAmount=3000，已完成退款合计=3000）→ 可删', async () => {
    const deletedAt = new Date('2026-07-08T12:00:00Z');
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.REFUNDED,
      paidAmount: 3000,
      refunds: [{ amount: 1800 }, { amount: 1200 }],
    });
    mockPrisma.order.update.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.REFUNDED,
      deletedAt,
    });

    const res = await service.softDeleteOrder('o1', ADMIN);
    expect(res.after.deletedAt).toBe(deletedAt);
  });

  it('待处理退款（REQUESTED/PROCESSING）不算已退——查询只挑 COMPLETED，净收款仍未退，拒删', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.CANCELLED,
      paidAmount: 3000,
      // findFirst 的 where: { status: 'COMPLETED' } 已在查询层过滤，这里模拟「查出来是空」
      // 因为 REQUESTED/PROCESSING 状态的退款不会被这个 include 选中
      refunds: [],
    });

    await expect(service.softDeleteOrder('o1', ADMIN)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();

    // 断言 findFirst 的 select 只挑 COMPLETED 的退款（口径核实：不把待处理退款当已退）
    const call = mockPrisma.order.findFirst.mock.calls[0][0];
    expect(call.select.refunds.where).toEqual({ status: 'COMPLETED' });
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
