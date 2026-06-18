/**
 * PaymentsService.confirmManualPayment / batchConfirmManualPayment · 真 DB 集成测试
 *
 * 覆盖：
 *   - 多付：到账金额可超过应收余额 → paidAmount > total → 尾款（total − paidAmount）为负
 *   - 全额/超额到账自动 PAID
 *   - 防手误上限：异常偏高金额被拒
 *   - 部分到账累加
 *   - 幂等：同 idempotencyKey 不二次累计
 *   - 批量到账：N 单确认，单坏不连累其余
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { OrderStatus, PaymentMethod, Prisma, UserRole, PaymentStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { PaymentsService } from './payments.service.js';

// ── Fixtures ──────────────────────────────────────────────────────────────
async function createCustomer() {
  return prisma.user.create({
    data: {
      email: `pay${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      role: UserRole.CUSTOMER,
    },
  });
}

/**
 * 建一个真实的 ADMIN 用户做 actor。
 * 自动转 PAID 时会写 OrderStatusEvent.actorUserId（FK → User），所以 actor 必须是真用户。
 */
async function createAdminActor() {
  const admin = await prisma.user.create({
    data: {
      email: `admin${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      role: UserRole.ADMIN,
    },
  });
  return { userId: admin.id, role: UserRole.ADMIN };
}

/** 建一个 PENDING_PAYMENT 订单（默认总额 1000，paidAmount 0）。 */
async function createPendingOrder(userId: string, total = 1000) {
  return prisma.order.create({
    data: {
      orderNumber: `TEST-PAY-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      userId,
      status: OrderStatus.PENDING_PAYMENT,
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(0),
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
describe('PaymentsService.confirmManualPayment · 多付与防手误', () => {
  const service = new PaymentsService();

  it('多付：到账金额 > 应收余额 → 记录全额，paidAmount > total，尾款为负', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);

    // 应收余额 1000，但到账 1200（结算价≠到账金额，多付 200）
    const result = await service.confirmManualPayment(
      order.id,
      { amount: 1200, method: PaymentMethod.BANK_CARD },
      ADMIN,
    );

    expect(result.ok).toBe(true);
    expect(result.paidAmount).toBe(1200);
    expect(result.total).toBe(1000);
    expect(result.fullyPaid).toBe(true);
    // 尾款 = total − paidAmount = 1000 − 1200 = −200（多付）
    expect(result.total - result.paidAmount).toBe(-200);
    expect(result.status).toBe(OrderStatus.PAID);

    // DB 真值：Order.paidAmount 落了 1200，且 Payment.amount = 1200
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1200);
    expect(dbOrder.status).toBe(OrderStatus.PAID);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: result.paymentId } });
    expect(Number(payment.amount)).toBe(1200);
    expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('全额到账 → 自动 PAID（auto-flip 仍生效）', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 800);

    const result = await service.confirmManualPayment(
      order.id,
      { amount: 800, method: PaymentMethod.WECHAT_PAY },
      ADMIN,
    );
    expect(result.fullyPaid).toBe(true);
    expect(result.status).toBe(OrderStatus.PAID);
    expect(result.paidAmount).toBe(800);
  });

  it('部分到账累加：先付 300 再付 900 → paidAmount 1200（多付）且 PAID', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);

    const first = await service.confirmManualPayment(
      order.id,
      { amount: 300, method: PaymentMethod.BANK_CARD },
      ADMIN,
    );
    expect(first.paidAmount).toBe(300);
    expect(first.fullyPaid).toBe(false);
    expect(first.status).toBe(OrderStatus.PENDING_PAYMENT);

    const second = await service.confirmManualPayment(
      order.id,
      { amount: 900, method: PaymentMethod.BANK_CARD },
      ADMIN,
    );
    expect(second.paidAmount).toBe(1200); // 300 + 900，超额 200
    expect(second.fullyPaid).toBe(true);
    expect(second.status).toBe(OrderStatus.PAID);
  });

  it('防手误上限：金额 > 订单总额×10 且 > 绝对上限 → 拒绝', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000); // ×10 = 10000

    // 2,000,000 既超 ×10（10000）也超绝对上限（1,000,000）→ 拒
    await expect(
      service.confirmManualPayment(
        order.id,
        { amount: 2_000_000, method: PaymentMethod.BANK_CARD },
        ADMIN,
      ),
    ).rejects.toThrow(/异常偏高/);

    // 订单未被改动
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(0);
    expect(dbOrder.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('小额订单合理多付：总额 10，到账 5000（在绝对上限内）→ 成功', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 10);
    // 10 × 10 = 100，但绝对上限 1,000,000 兜底 → 5000 应被允许
    const result = await service.confirmManualPayment(
      order.id,
      { amount: 5000, method: PaymentMethod.BANK_CARD },
      ADMIN,
    );
    expect(result.ok).toBe(true);
    expect(result.paidAmount).toBe(5000);
  });

  it('幂等：同 idempotencyKey 重试只入账一次', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    const key = `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const a = await service.confirmManualPayment(
      order.id,
      { amount: 1200, method: PaymentMethod.BANK_CARD, idempotencyKey: key },
      ADMIN,
    );
    const b = await service.confirmManualPayment(
      order.id,
      { amount: 1200, method: PaymentMethod.BANK_CARD, idempotencyKey: key },
      ADMIN,
    );
    expect(a.paymentId).toBe(b.paymentId);
    expect(b.paidAmount).toBe(1200); // 没有变成 2400

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1200);
  });
});

describe('PaymentsService.batchConfirmManualPayment · 批量到账', () => {
  const service = new PaymentsService();

  it('批量确认 N 单：全部成功，逐单返回 paidAmount/status', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const o1 = await createPendingOrder(customer.id, 1000);
    const o2 = await createPendingOrder(customer.id, 500);

    const { results } = await service.batchConfirmManualPayment(
      {
        items: [
          { orderId: o1.id, amount: 1000, method: PaymentMethod.BANK_CARD },
          { orderId: o2.id, amount: 600 }, // method 省略 → 默认 BANK_CARD；多付 100
        ],
        sharedProofUrl: 'data:image/png;base64,SGVsbG8=',
      },
      ADMIN,
    );

    expect(results).toHaveLength(2);
    const r1 = results.find((r) => r.orderId === o1.id)!;
    const r2 = results.find((r) => r.orderId === o2.id)!;
    expect(r1.ok).toBe(true);
    expect(r1.paidAmount).toBe(1000);
    expect(r1.status).toBe(OrderStatus.PAID);
    expect(r2.ok).toBe(true);
    expect(r2.paidAmount).toBe(600); // 多付 100
    expect(r2.status).toBe(OrderStatus.PAID);

    // sharedProofUrl 应落到没有单独 proofUrl 的支付上
    const p2 = await prisma.payment.findUniqueOrThrow({ where: { id: r2.paymentId! } });
    expect(p2.proofUrl).toBe('data:image/png;base64,SGVsbG8=');
  });

  it('单坏不连累其余：一个坏 orderId 失败，其余仍成功', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const good = await createPendingOrder(customer.id, 1000);

    const { results } = await service.batchConfirmManualPayment(
      {
        items: [
          { orderId: 'nonexistent-order-id', amount: 100, method: PaymentMethod.BANK_CARD },
          { orderId: good.id, amount: 1000, method: PaymentMethod.BANK_CARD },
        ],
      },
      ADMIN,
    );

    expect(results).toHaveLength(2);
    const bad = results.find((r) => r.orderId === 'nonexistent-order-id')!;
    const ok = results.find((r) => r.orderId === good.id)!;
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe(OrderStatus.PAID);

    // 坏单不影响好单：好单已 PAID
    const dbGood = await prisma.order.findUniqueOrThrow({ where: { id: good.id } });
    expect(dbGood.status).toBe(OrderStatus.PAID);
  });

  it('空列表 → 抛错', async () => {
    const ADMIN = await createAdminActor();
    await expect(
      service.batchConfirmManualPayment({ items: [] }, ADMIN),
    ).rejects.toThrow(/不能为空/);
  });
});
