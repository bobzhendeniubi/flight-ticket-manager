/**
 * 预存余额抵付单的退款回补 · 真 DB 集成测试
 *
 * 走完整链路：充值认款 → 余额抵尾款 → 申请取消 → 批准退款，断言**代理余额真的回来了**。
 *
 * 为什么必须用集成测试兜底：这条缺陷的病灶正是"输入取错了字段"——
 * 退款回补此前读 Order.prepaymentOffset，而全仓没有任何生产代码写那一列（恒为 0），
 * 于是余额部分恒算成 0、永不回补。单测里只要手工把 prepaymentOffset 塞成非 0 就"绿"了，
 * 假绿正是这么来的。真库跑一遍，那一列该是几就是几，谁也塞不了。
 *
 * 跑：
 *   1. docker compose -f ../docker-compose.test.yml up -d
 *   2. npx vitest run -c vitest.integration.config.ts src/modules/orders/orders.prepayment-refund.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { OrderStatus, PrepaymentTxType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from './orders.service.js';
import { AgentRechargesService } from '../agent-recharges/agent-recharges.service.js';

const orderService = new OrderService();
const rechargeService = new AgentRechargesService();

// 1×1 透明 PNG —— 认款凭证图必须是 data:image/...;base64 的 data-URL
const PROOF_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// ── Fixtures ──────────────────────────────────────────────────────────────
function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createAdmin() {
  const admin = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: admin.id, role: UserRole.ADMIN as const };
}

async function createAgent() {
  const user = await prisma.user.create({
    data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT },
  });
  return prisma.agent.create({
    data: {
      userId: user.id,
      contactName: '测试代理',
      contactPhone: '13800138000',
      prepaymentBalance: new Prisma.Decimal(0),
    },
  });
}

/** 走真实认款链路给代理充值：提交申请 → 另一个人确认到账（双人复核）。 */
async function topUp(agentId: string, amountCny: number) {
  const submitter = await createAdmin();
  const confirmer = await createAdmin();
  const req = await rechargeService.create(submitter, {
    agentId,
    amountCny,
    proofImages: [PROOF_IMAGE],
  });
  await rechargeService.confirm(confirmer, req.id, {});
}

/** 建一张挂代理的 PENDING_PAYMENT 单（纯地面 VISA 行，不牵扯座位库存）。 */
async function createOrder(opts: { agentId: string; total: number; paidAmount?: number }) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-PR'),
      agentId: opts.agentId,
      status: OrderStatus.PENDING_PAYMENT,
      subtotal: new Prisma.Decimal(opts.total),
      total: new Prisma.Decimal(opts.total),
      paidAmount: new Prisma.Decimal(opts.paidAmount ?? 0),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: 'VISA',
            description: '测试服务项',
            quantity: 1,
            unitPrice: new Prisma.Decimal(opts.total),
            amount: new Prisma.Decimal(opts.total),
          },
        ],
      },
    },
  });
}

/** VISA 兜底退订策略：20% 手续费（VISA 无出发时间 → 取最严档，这里只有这一档）。 */
async function seedVisaPolicy() {
  await prisma.cancellationPolicy.create({
    data: {
      productKind: 'VISA',
      name: '测试签证退订',
      tiers: [{ hoursBeforeDeparture: 0, feePercent: 20 }],
      isDefault: true,
      isActive: true,
    },
  });
}

async function balanceOf(agentId: string): Promise<number> {
  const a = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  return Number(a.prepaymentBalance);
}

// ══════════════════════════════════════════════════════════════════════════
describe('预存余额抵付单退款 · 余额必须原路回补', () => {
  it('充值 10000 → 全额抵付 → 退款 8000：余额回到 8000，REFUND 流水落库', async () => {
    const ADMIN = await createAdmin();
    await seedVisaPolicy();
    const agent = await createAgent();
    await topUp(agent.id, 10_000);
    expect(await balanceOf(agent.id)).toBe(10_000);

    const order = await createOrder({ agentId: agent.id, total: 10_000 });

    // ① 余额抵尾款：余额清零、订单收齐翻 PAID
    const applied = await orderService.applyAgentBalanceToOrder(order.id, 10_000, ADMIN);
    expect(applied.status).toBe(OrderStatus.PAID);
    expect(await balanceOf(agent.id)).toBe(0);

    // 病灶留痕：抵扣走的是 paidAmount + OFFSET 流水，Order.prepaymentOffset **纹丝不动**。
    // 退款回补一旦拿它当输入，算出来的余额部分就恒为 0 —— 这正是本次修复的根因。
    const afterOffset = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(afterOffset.paidAmount)).toBe(10_000);
    expect(Number(afterOffset.prepaymentOffset)).toBe(0);

    // ② 申请取消：20% 手续费 → 应退 8000
    const { refund } = await orderService.requestCancellation(order.id, '客户改行程', ADMIN);
    expect(Number(refund.amount)).toBe(8_000);

    // ③ 批准退款
    await orderService.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN, '财务已退款');

    // ④ 余额真的回来了（8000 = 应退额全部走余额，因为这单一分现金都没收过）
    expect(await balanceOf(agent.id)).toBe(8_000);

    const refundTx = await prisma.prepaymentTransaction.findFirst({
      where: { orderId: order.id, type: PrepaymentTxType.REFUND },
    });
    expect(refundTx).not.toBeNull();
    expect(Number(refundTx?.amount)).toBe(8_000); // 正数 = 退回余额
    expect(Number(refundTx?.balanceAfter)).toBe(8_000);
    expect(refundTx?.agentId).toBe(agent.id);

    // 订单落终态、退款记录推进到 COMPLETED
    const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe(OrderStatus.REFUNDED);
    const finalRefund = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(finalRefund.status).toBe('COMPLETED');
  });

  it('现金优先：现金 4000 + 余额抵 6000、应退 8000 → 只回补 4000 到余额', async () => {
    const ADMIN = await createAdmin();
    await seedVisaPolicy();
    const agent = await createAgent();
    await topUp(agent.id, 6_000);

    // 已收现金 4000，余款 6000 用余额抵
    const order = await createOrder({ agentId: agent.id, total: 10_000, paidAmount: 4_000 });
    await orderService.applyAgentBalanceToOrder(order.id, 6_000, ADMIN);
    expect(await balanceOf(agent.id)).toBe(0);

    const { refund } = await orderService.requestCancellation(order.id, '客户改行程', ADMIN);
    expect(Number(refund.amount)).toBe(8_000);

    await orderService.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN, '财务已退款');

    // 现金侧可退 4000（真·现金 = paidAmount 10000 − 余额抵扣 6000），剩下 4000 回余额
    expect(await balanceOf(agent.id)).toBe(4_000);
    const refundTx = await prisma.prepaymentTransaction.findFirstOrThrow({
      where: { orderId: order.id, type: PrepaymentTxType.REFUND },
    });
    expect(Number(refundTx.amount)).toBe(4_000);
  });

  it('纯现金单退款：不写 REFUND 流水、代理余额分文不动', async () => {
    const ADMIN = await createAdmin();
    await seedVisaPolicy();
    const agent = await createAgent();
    await topUp(agent.id, 5_000);

    // 全额现金收讫，从未动过余额
    const order = await createOrder({ agentId: agent.id, total: 10_000, paidAmount: 10_000 });
    await orderService.updateStatus(order.id, OrderStatus.PAID, ADMIN, '现金收讫');
    await orderService.requestCancellation(order.id, '客户改行程', ADMIN);
    await orderService.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN, '财务已退款');

    expect(await balanceOf(agent.id)).toBe(5_000); // 充值的钱原样不动
    const refundTx = await prisma.prepaymentTransaction.findFirst({
      where: { orderId: order.id, type: PrepaymentTxType.REFUND },
    });
    expect(refundTx).toBeNull();
  });

  it('幂等：重复批准退款不重复回补（REFUNDED 是终态，余额只涨一次）', async () => {
    const ADMIN = await createAdmin();
    await seedVisaPolicy();
    const agent = await createAgent();
    await topUp(agent.id, 10_000);

    const order = await createOrder({ agentId: agent.id, total: 10_000 });
    await orderService.applyAgentBalanceToOrder(order.id, 10_000, ADMIN);
    await orderService.requestCancellation(order.id, '客户改行程', ADMIN);
    await orderService.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN, '财务已退款');
    expect(await balanceOf(agent.id)).toBe(8_000);

    // 再批一次：REFUNDED 是终态，转不动 —— 关键断言是余额与流水都没被再动一次
    await expect(
      orderService.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN, '手滑再点一次'),
    ).rejects.toThrow();

    expect(await balanceOf(agent.id)).toBe(8_000);
    const refundTxCount = await prisma.prepaymentTransaction.count({
      where: { orderId: order.id, type: PrepaymentTxType.REFUND },
    });
    expect(refundTxCount).toBe(1);
  });
});
