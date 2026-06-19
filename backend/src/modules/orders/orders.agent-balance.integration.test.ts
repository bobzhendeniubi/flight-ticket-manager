/**
 * OrderService 代理余额账户 · 真 DB 集成测试
 *
 * 覆盖（取代「跨人抵扣」的代理余额账户口径）：
 *   - creditOverpayToAgent：多付（paidAmount > total）转入代理余额，订单回压到恰好结清（尾款=0）
 *   - applyAgentBalanceToOrder：用代理余额抵尾款，抵满 → 订单翻 PAID + 余额扣减
 *   - 拒绝：无代理 / 无多付 / 余额不足 / 超抵
 *   - settlementMode 持久化（PER_ORDER ↔ MONTHLY）+ 暴露在订单序列化的 agent 上
 *   - PrepaymentTransaction 流水复用（TOP_UP 入账 / OFFSET 抵扣，balanceAfter 正确）
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import {
  OrderStatus,
  PrepaymentTxType,
  Prisma,
  SettlementMode,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from './orders.service.js';
import { AgentService } from '../agents/agents.service.js';

const orderService = new OrderService();
const agentService = new AgentService();

// ── Fixtures ──────────────────────────────────────────────────────────────
function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createAdminActor() {
  const admin = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: admin.id, role: UserRole.ADMIN };
}

/** 建一个代理（带 User），可指定初始余额与结算模式。 */
async function createAgent(opts: { balance?: number; mode?: SettlementMode } = {}) {
  const user = await prisma.user.create({
    data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT },
  });
  return prisma.agent.create({
    data: {
      userId: user.id,
      contactName: '测试代理',
      contactPhone: '13800138000',
      prepaymentBalance: new Prisma.Decimal(opts.balance ?? 0),
      settlementMode: opts.mode ?? SettlementMode.PER_ORDER,
    },
  });
}

/** 建一个 PENDING_PAYMENT 订单，可挂代理、设 paidAmount。 */
async function createOrder(opts: {
  agentId?: string | null;
  total?: number;
  paidAmount?: number;
}) {
  const total = opts.total ?? 1000;
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-AB'),
      agentId: opts.agentId ?? null,
      status: OrderStatus.PENDING_PAYMENT,
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(opts.paidAmount ?? 0),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: 'VISA',
            description: '测试服务项',
            quantity: 1,
            unitPrice: new Prisma.Decimal(total),
            amount: new Prisma.Decimal(total),
          },
        ],
      },
    },
  });
}

// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.creditOverpayToAgent · 多付存入代理余额', () => {
  it('多付转存：paidAmount 1200 / total 1000 → 余额 +200，订单尾款=0', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgent({ balance: 500 });
    const order = await createOrder({ agentId: agent.id, total: 1000, paidAmount: 1200 });

    const result = await orderService.creditOverpayToAgent(order.id, ADMIN);

    expect(result.ok).toBe(true);
    expect(result.creditedAmount).toBe(200);
    expect(result.newPaidAmount).toBe(1000);
    expect(result.agentBalanceAfter).toBe(700); // 500 + 200

    // 订单真值：paidAmount 回压到 total（恰好结清，尾款=0）
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1000);
    expect(Number(dbOrder.total) - Number(dbOrder.paidAmount)).toBe(0);

    // 代理余额真值
    const dbAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(Number(dbAgent.prepaymentBalance)).toBe(700);

    // 流水：一条 TOP_UP（正数入账），balanceAfter 正确，关联 orderId
    const tx = await prisma.prepaymentTransaction.findFirst({
      where: { agentId: agent.id, orderId: order.id },
    });
    expect(tx).not.toBeNull();
    expect(tx?.type).toBe(PrepaymentTxType.TOP_UP);
    expect(Number(tx?.amount)).toBe(200);
    expect(Number(tx?.balanceAfter)).toBe(700);
  });

  it('拒绝：订单无代理', async () => {
    const ADMIN = await createAdminActor();
    const order = await createOrder({ agentId: null, total: 1000, paidAmount: 1200 });
    await expect(orderService.creditOverpayToAgent(order.id, ADMIN)).rejects.toThrow(/无归属代理/);
  });

  it('拒绝：没有多付（paidAmount ≤ total）', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgent();
    const order = await createOrder({ agentId: agent.id, total: 1000, paidAmount: 1000 });
    await expect(orderService.creditOverpayToAgent(order.id, ADMIN)).rejects.toThrow(/没有多付/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.applyAgentBalanceToOrder · 用代理余额抵尾款', () => {
  it('抵满尾款 → 订单翻 PAID，余额扣减，流水 OFFSET', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgent({ balance: 1000 });
    // total 1000，已付 600 → 尾款 400
    const order = await createOrder({ agentId: agent.id, total: 1000, paidAmount: 600 });

    const result = await orderService.applyAgentBalanceToOrder(order.id, 400, ADMIN);

    expect(result.ok).toBe(true);
    expect(result.appliedAmount).toBe(400);
    expect(result.newPaidAmount).toBe(1000);
    expect(result.fullyPaid).toBe(true);
    expect(result.status).toBe(OrderStatus.PAID);
    expect(result.agentBalanceAfter).toBe(600); // 1000 − 400

    // 订单真值：PAID + paidAmount=1000
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe(OrderStatus.PAID);
    expect(Number(dbOrder.paidAmount)).toBe(1000);

    // 余额真值
    const dbAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(Number(dbAgent.prepaymentBalance)).toBe(600);

    // 流水：一条 OFFSET（负数扣减）
    const tx = await prisma.prepaymentTransaction.findFirst({
      where: { agentId: agent.id, orderId: order.id },
    });
    expect(tx?.type).toBe(PrepaymentTxType.OFFSET);
    expect(Number(tx?.amount)).toBe(-400);
    expect(Number(tx?.balanceAfter)).toBe(600);

    // PAID 流转生效：状态事件落库
    const event = await prisma.orderStatusEvent.findFirst({
      where: { orderId: order.id, toStatus: OrderStatus.PAID },
    });
    expect(event).not.toBeNull();
  });

  it('部分抵扣：尾款未抵满 → 订单仍 PENDING_PAYMENT，余额按额扣减', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgent({ balance: 1000 });
    const order = await createOrder({ agentId: agent.id, total: 1000, paidAmount: 0 });

    const result = await orderService.applyAgentBalanceToOrder(order.id, 300, ADMIN);
    expect(result.fullyPaid).toBe(false);
    expect(result.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(result.newPaidAmount).toBe(300);
    expect(result.agentBalanceAfter).toBe(700);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(Number(dbOrder.paidAmount)).toBe(300);
  });

  it('拒绝：余额不足', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgent({ balance: 100 });
    const order = await createOrder({ agentId: agent.id, total: 1000, paidAmount: 0 });
    await expect(orderService.applyAgentBalanceToOrder(order.id, 400, ADMIN)).rejects.toThrow(
      /余额.*不足/,
    );

    // 余额未被动过（不透支为负）
    const dbAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(Number(dbAgent.prepaymentBalance)).toBe(100);
  });

  it('拒绝：超抵（amount > 尾款）', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgent({ balance: 5000 });
    // 尾款只有 200
    const order = await createOrder({ agentId: agent.id, total: 1000, paidAmount: 800 });
    await expect(orderService.applyAgentBalanceToOrder(order.id, 400, ADMIN)).rejects.toThrow(
      /超过尾款/,
    );
  });

  it('拒绝：订单无代理', async () => {
    const ADMIN = await createAdminActor();
    const order = await createOrder({ agentId: null, total: 1000, paidAmount: 0 });
    await expect(orderService.applyAgentBalanceToOrder(order.id, 100, ADMIN)).rejects.toThrow(
      /无归属代理/,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('AgentService.setSettlementMode · 结算模式持久化 + 序列化暴露', () => {
  it('默认 PER_ORDER → 改 MONTHLY 持久化，返回前后值', async () => {
    const agent = await createAgent(); // 默认 PER_ORDER
    expect(agent.settlementMode).toBe(SettlementMode.PER_ORDER);

    const result = await agentService.setSettlementMode(
      agent.id,
      SettlementMode.MONTHLY,
      UserRole.ADMIN,
    );
    expect(result.previousMode).toBe(SettlementMode.PER_ORDER);
    expect(result.settlementMode).toBe(SettlementMode.MONTHLY);

    const dbAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(dbAgent.settlementMode).toBe(SettlementMode.MONTHLY);
  });

  it('非 ADMIN 拒绝', async () => {
    const agent = await createAgent();
    await expect(
      agentService.setSettlementMode(agent.id, SettlementMode.MONTHLY, UserRole.STAFF),
    ).rejects.toThrow(/仅管理员/);
  });

  it('settlementMode + prepaymentBalance 暴露在订单序列化的 agent 上', async () => {
    const admin = await createAdminActor();
    const agent = await createAgent({ mode: SettlementMode.MONTHLY, balance: 250 });
    const order = await createOrder({ agentId: agent.id, total: 1000, paidAmount: 0 });

    const serialized = (await orderService.getOrder(order.id, {
      userId: admin.userId,
      role: UserRole.ADMIN,
    })) as {
      agent: { settlementMode: SettlementMode; prepaymentBalance: string } | null;
    };
    expect(serialized.agent?.settlementMode).toBe(SettlementMode.MONTHLY);
    // 余额序列化成字符串
    expect(serialized.agent?.prepaymentBalance).toBe('250');
  });
});
