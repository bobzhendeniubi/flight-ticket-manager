/**
 * 更改订单归属代理（T5）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. changeOrderAgentBodySchema：空串归一为 null（直客）；合法 id / null 通过。
 *   2. changeOrderAgent 权限：非 ADMIN/STAFF（CUSTOMER/AGENT）→ ForbiddenError（未触库）。
 *   3. changeOrderAgent 守卫：订单不存在 / 归属未变化 / 目标代理不存在 / 目标代理已停用。
 *
 * 「改归属成功 + warning（曾用余额抵扣）+ 审计 before/after」需真 DB 全链路 ——
 * 见 orders.agent-change.integration.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    agent: { findUnique: vi.fn() },
    prepaymentTransaction: { findFirst: vi.fn() },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { changeOrderAgentBodySchema } from './orders.schemas.js';

const service = new OrderService();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('changeOrderAgentBodySchema', () => {
  it('空串归一为 null（前端「直客」选项）', () => {
    const parsed = changeOrderAgentBodySchema.parse({ agentId: '' });
    expect(parsed.agentId).toBeNull();
  });

  it('null（转直客）通过', () => {
    expect(changeOrderAgentBodySchema.safeParse({ agentId: null }).success).toBe(true);
  });

  it('合法代理 id + reason 通过', () => {
    const parsed = changeOrderAgentBodySchema.parse({ agentId: 'agent-1', reason: '归属订正' });
    expect(parsed.agentId).toBe('agent-1');
    expect(parsed.reason).toBe('归属订正');
  });
});

describe('OrderService.changeOrderAgent · 权限（服务端按认证身份判）', () => {
  it.each(['CUSTOMER', 'AGENT'] as const)('%s 调用 → ForbiddenError，且未触库', async (role) => {
    await expect(
      service.changeOrderAgent('o1', { agentId: 'a1' }, { userId: 'u1', role }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });
});

describe('OrderService.changeOrderAgent · 守卫', () => {
  const actor = { userId: 'admin', role: 'ADMIN' as const };

  it('订单不存在 → NotFoundError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await expect(
      service.changeOrderAgent('missing', { agentId: 'a1' }, actor),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('归属未变化（同代理）→ BadRequestError，不更新', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1', agentId: 'a1' });
    await expect(
      service.changeOrderAgent('o1', { agentId: 'a1' }, actor),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('本为直客又转直客（null→null）→ BadRequestError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1', agentId: null });
    await expect(
      service.changeOrderAgent('o1', { agentId: null }, actor),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('目标代理不存在 → NotFoundError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1', agentId: null });
    mockPrisma.agent.findUnique.mockResolvedValue(null);
    await expect(
      service.changeOrderAgent('o1', { agentId: 'ghost' }, actor),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('目标代理已停用 → BadRequestError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1', agentId: null });
    mockPrisma.agent.findUnique.mockResolvedValue({
      id: 'a2',
      isActive: false,
      companyName: '某代理',
      contactName: '联系人',
    });
    await expect(
      service.changeOrderAgent('o1', { agentId: 'a2' }, actor),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });
});
