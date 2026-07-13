/**
 * OrderService.changeOrderAgent（T5 更改订单归属代理）· 真 DB 集成测试
 *
 * 覆盖：
 *   - 直客 → 代理：order.agentId 更新，审计 before/after 名称正确，warning=null（未用余额抵扣）
 *   - 代理 → 直客（null）：order.agentId 置空
 *   - 曾用原代理预存余额抵扣（PrepaymentTransaction OFFSET 挂本单）→ 改归属成功但 warning 非空（不回溯）
 *   - 目标代理已停用 → BadRequestError（不更新）
 *   - 非 ADMIN/STAFF 调用被拒（ForbiddenError）
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { OrderStatus, PrepaymentTxType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from './orders.service.js';

const service = new OrderService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function adminActor(): Promise<{ userId: string; role: UserRole }> {
  const admin = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: admin.id, role: UserRole.ADMIN };
}

async function createAgent(opts: { isActive?: boolean; companyName?: string } = {}) {
  const user = await prisma.user.create({
    data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT },
  });
  return prisma.agent.create({
    data: {
      userId: user.id,
      contactName: '测试代理',
      contactPhone: '13800138000',
      companyName: opts.companyName ?? null,
      isActive: opts.isActive ?? true,
    },
  });
}

async function createOrder(opts: { agentId?: string | null } = {}) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-AC'),
      agentId: opts.agentId ?? null,
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(1000),
      total: new Prisma.Decimal(1000),
      paidAmount: new Prisma.Decimal(1000),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: 'VISA',
            description: '测试服务项',
            quantity: 1,
            unitPrice: new Prisma.Decimal(1000),
            amount: new Prisma.Decimal(1000),
          },
        ],
      },
    },
  });
}

describe('OrderService.changeOrderAgent · 真 DB E2E', () => {
  it('直客 → 代理：agentId 更新 + 审计名称 + warning=null', async () => {
    const actor = await adminActor();
    const agent = await createAgent({ companyName: '椰岛旅行社' });
    const order = await createOrder({ agentId: null });

    const result = await service.changeOrderAgent(
      order.id,
      { agentId: agent.id, reason: '归属订正' },
      actor,
    );

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.agentId).toBe(agent.id);

    expect(result.warning).toBeNull();
    expect(result.audit.before.agentId).toBeNull();
    expect(result.audit.after.agentId).toBe(agent.id);
    expect(result.audit.after.agentName).toBe('椰岛旅行社');
    expect(result.audit.reason).toBe('归属订正');
    expect(result.audit.usedAgentBalance).toBe(false);
  });

  it('代理 → 直客（null）：agentId 置空', async () => {
    const actor = await adminActor();
    const agent = await createAgent();
    const order = await createOrder({ agentId: agent.id });

    const result = await service.changeOrderAgent(order.id, { agentId: null }, actor);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.agentId).toBeNull();
    expect(result.audit.after.agentId).toBeNull();
  });

  it('曾用原代理预存余额抵扣 → 改归属成功但 warning 非空（不回溯）', async () => {
    const actor = await adminActor();
    const oldAgent = await createAgent({ companyName: '原代理' });
    const newAgent = await createAgent({ companyName: '新代理' });
    const order = await createOrder({ agentId: oldAgent.id });

    // 预置：一条挂本单的 OFFSET 流水（= 曾用原代理余额抵扣）
    await prisma.prepaymentTransaction.create({
      data: {
        agentId: oldAgent.id,
        amount: new Prisma.Decimal(-200),
        balanceAfter: new Prisma.Decimal(0),
        type: PrepaymentTxType.OFFSET,
        orderId: order.id,
        createdById: actor.userId,
      },
    });

    const result = await service.changeOrderAgent(order.id, { agentId: newAgent.id }, actor);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.agentId).toBe(newAgent.id); // 改归属成功（不阻断）
    expect(result.warning).not.toBeNull(); // 提醒核对财务归属
    expect(result.audit.usedAgentBalance).toBe(true);
  });

  it('目标代理已停用 → BadRequestError，不更新', async () => {
    const actor = await adminActor();
    const inactive = await createAgent({ isActive: false });
    const order = await createOrder({ agentId: null });

    await expect(
      service.changeOrderAgent(order.id, { agentId: inactive.id }, actor),
    ).rejects.toThrow(/已停用/);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.agentId).toBeNull();
  });

  it('非 ADMIN/STAFF 调用 → 拒绝', async () => {
    const agent = await createAgent();
    const order = await createOrder({ agentId: null });
    await expect(
      service.changeOrderAgent(
        order.id,
        { agentId: agent.id },
        { userId: 'someone', role: UserRole.AGENT },
      ),
    ).rejects.toThrow(/仅运营\/管理员/);
  });
});
