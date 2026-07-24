/**
 * PaymentsService.confirmManualPayment / batchConfirmManualPayment · 真 DB 集成测试
 *
 * 覆盖：
 *   - 超收硬闸：手工/批量到账使累计已付净额超过应收 → 400 拦下（多付改走对账台挂账池）
 *   - 同额防呆软闸：近 10 分钟等额手工收款 → 409 + code DUPLICATE_AMOUNT；confirmDuplicate 放行
 *   - 正常分次凑单到收满 → 自动 PAID（不产生多付）
 *   - 防手误上限：异常偏高金额被拒
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
describe('PaymentsService.confirmManualPayment · 超收硬闸与防手误', () => {
  const service = new PaymentsService();

  it('超收硬闸：一次性到账 > 应收 → 400 拦下，订单不被改动（多付改走挂账池）', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);

    // 应收 1000，一次录 1200（超出 200）→ 硬闸拦下
    await expect(
      service.confirmManualPayment(
        order.id,
        { amount: 1200, method: PaymentMethod.BANK_CARD },
        ADMIN,
      ),
    ).rejects.toThrow(/超出应收|已收满|挂账池/);

    // 订单未被改动：paidAmount 仍 0，状态仍 PENDING_PAYMENT，没有落 Payment
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(0);
    expect(dbOrder.status).toBe(OrderStatus.PENDING_PAYMENT);
    const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(payments).toHaveLength(0);
  });

  it('超收硬闸：收满后再录任意金额 → 400 拦下（同一笔到账误录两次场景）', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);

    // 第一笔收满 → PAID
    const first = await service.confirmManualPayment(
      order.id,
      { amount: 1000, method: PaymentMethod.BANK_CARD },
      ADMIN,
    );
    expect(first.status).toBe(OrderStatus.PAID);

    // 第二笔（不同收款方式，等额）→ 超收硬闸拦下（正是本次修复的误录两次事故）
    await expect(
      service.confirmManualPayment(
        order.id,
        { amount: 1000, method: PaymentMethod.WECHAT_PAY },
        ADMIN,
      ),
    ).rejects.toThrow(/超出应收|已收满|挂账池/);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1000); // 没有变成 2000
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

  it('正常分次凑单不拦：先付 300 再付 700 → 收满 PAID（不产生多付）', async () => {
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

    // 补齐尾款 700（恰好收满，不超收）→ 硬闸不拦，自动 PAID
    const second = await service.confirmManualPayment(
      order.id,
      { amount: 700, method: PaymentMethod.WECHAT_PAY },
      ADMIN,
    );
    expect(second.paidAmount).toBe(1000); // 300 + 700，恰好收满
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

  it('小额订单超收也拦：总额 10，到账 5000（未超防手误上限，但超应收）→ 400', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 10);
    // 5000 在防手误绝对上限内（不触发「异常偏高」），但远超应收 10 → 超收硬闸拦下
    await expect(
      service.confirmManualPayment(
        order.id,
        { amount: 5000, method: PaymentMethod.BANK_CARD },
        ADMIN,
      ),
    ).rejects.toThrow(/超出应收|已收满|挂账池/);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(0);
  });

  it('幂等：同 idempotencyKey 重试只入账一次', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    const key = `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const a = await service.confirmManualPayment(
      order.id,
      { amount: 1000, method: PaymentMethod.BANK_CARD, idempotencyKey: key },
      ADMIN,
    );
    // 同 key 重放：走幂等回放分支（在两闸之前短路），不会因「已收满」被超收硬闸误拦
    const b = await service.confirmManualPayment(
      order.id,
      { amount: 1000, method: PaymentMethod.BANK_CARD, idempotencyKey: key },
      ADMIN,
    );
    expect(a.paymentId).toBe(b.paymentId);
    expect(b.paidAmount).toBe(1000); // 没有变成 2000

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1000);
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
          { orderId: o2.id, amount: 500 }, // method 省略 → 默认 BANK_CARD；恰好收满
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
    expect(r2.paidAmount).toBe(500); // 恰好收满
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

  it('幂等：同 batchId 重复提交整批 → 逐单只入账一次，不双倍', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const o1 = await createPendingOrder(customer.id, 1000);
    const o2 = await createPendingOrder(customer.id, 500);
    const batchId = `batchtest-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const items = [
      { orderId: o1.id, amount: 1000, method: PaymentMethod.BANK_CARD },
      { orderId: o2.id, amount: 500, method: PaymentMethod.BANK_CARD },
    ];

    // 第一次提交：模拟表单正常提交
    const first = await service.batchConfirmManualPayment({ items, batchId }, ADMIN);
    const firstR1 = first.results.find((r) => r.orderId === o1.id)!;
    const firstR2 = first.results.find((r) => r.orderId === o2.id)!;
    expect(firstR1.ok).toBe(true);
    expect(firstR1.paidAmount).toBe(1000);
    expect(firstR2.ok).toBe(true);
    expect(firstR2.paidAmount).toBe(500);

    // 第二次提交：同一 batchId 重复提交（模拟双击/网络重试/表单重发）
    const second = await service.batchConfirmManualPayment({ items, batchId }, ADMIN);
    const secondR1 = second.results.find((r) => r.orderId === o1.id)!;
    const secondR2 = second.results.find((r) => r.orderId === o2.id)!;
    expect(secondR1.ok).toBe(true);
    expect(secondR1.paymentId).toBe(firstR1.paymentId); // 回放同一笔 Payment，不是新记录
    expect(secondR1.paidAmount).toBe(1000); // 没有变成 2000
    expect(secondR2.paymentId).toBe(firstR2.paymentId);
    expect(secondR2.paidAmount).toBe(500); // 没有变成 1000

    // DB 真值：两单各只有一笔 SUCCEEDED Payment，paidAmount 未被重复累加
    const dbOrder1 = await prisma.order.findUniqueOrThrow({ where: { id: o1.id } });
    const dbOrder2 = await prisma.order.findUniqueOrThrow({ where: { id: o2.id } });
    expect(Number(dbOrder1.paidAmount)).toBe(1000);
    expect(Number(dbOrder2.paidAmount)).toBe(500);
    const payments1 = await prisma.payment.findMany({ where: { orderId: o1.id } });
    const payments2 = await prisma.payment.findMany({ where: { orderId: o2.id } });
    expect(payments1).toHaveLength(1);
    expect(payments2).toHaveLength(1);
  });

  it('不同 batchId（未传 batchId）→ 不做批量去重，等价于旧行为', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    const items = [{ orderId: order.id, amount: 400, method: PaymentMethod.BANK_CARD }];

    // 不传 batchId：两次独立提交各自入账（旧行为，向后兼容）
    const first = await service.batchConfirmManualPayment({ items }, ADMIN);
    const second = await service.batchConfirmManualPayment({ items }, ADMIN);
    expect(first.results[0].ok).toBe(true);
    expect(second.results[0].ok).toBe(true);
    expect(second.results[0].paymentId).not.toBe(first.results[0].paymentId);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(800); // 400 + 400，两笔独立入账
  });
});

// ══════════════════════════════════════════════════════════════════════════
// R4/R5 · 双通道到账账目分叉收口：兄弟 Payment 作废 + 迟到回调计入可见多付 + 并发不丢账
// （回调走 sandbox adapter：PAYMENT_MODE 默认 sandbox，x-sandbox-secret 默认 sandbox-test-secret）
// ══════════════════════════════════════════════════════════════════════════
describe('PaymentsService.handleCallback · R4/R5 兄弟 Payment 作废 + 迟到回调多付', () => {
  const service = new PaymentsService();

  /** 直接建一笔 PENDING 网关 Payment（模拟客户发起支付后尚未回调）。 */
  async function createPendingPayment(orderId: string, amount: number, method = PaymentMethod.WECHAT_PAY) {
    return prisma.payment.create({
      data: { orderId, method, amount: new Prisma.Decimal(amount), status: PaymentStatus.PENDING },
    });
  }

  /** 触发 sandbox 网关回调（验签通过 → 标 SUCCEEDED / 走后续账目）。 */
  function fireCallback(method: PaymentMethod, paymentId: string, amountYuan: number) {
    return service.handleCallback(
      method,
      { 'x-sandbox-secret': process.env.SANDBOX_WEBHOOK_SECRET ?? 'sandbox-test-secret' },
      { paymentId, transactionId: `TX-${paymentId}`, amountYuan },
    );
  }

  it('point 2：订单转 PAID 时其它 PENDING 兄弟 Payment 作废（FAILED + supersededByPaid）', async () => {
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    const payA = await createPendingPayment(order.id, 1000);
    const payB = await createPendingPayment(order.id, 1000);

    const res = await fireCallback(PaymentMethod.WECHAT_PAY, payA.id, 1000);
    expect(res.ok).toBe(true);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe(OrderStatus.PAID);
    expect(Number(dbOrder.paidAmount)).toBe(1000);

    const dbA = await prisma.payment.findUniqueOrThrow({ where: { id: payA.id } });
    expect(dbA.status).toBe(PaymentStatus.SUCCEEDED);

    // 兄弟单 B 被作废：FAILED + gatewayPayload.supersededByPaid=true
    const dbB = await prisma.payment.findUniqueOrThrow({ where: { id: payB.id } });
    expect(dbB.status).toBe(PaymentStatus.FAILED);
    expect((dbB.gatewayPayload as { supersededByPaid?: boolean } | null)?.supersededByPaid).toBe(true);
  });

  it('point 3：被作废的兄弟单后来真收到回调 → 复活为可见多付（paidAmount 抬高、不消失）', async () => {
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    const payA = await createPendingPayment(order.id, 1000);
    const payB = await createPendingPayment(order.id, 1000);

    // A 回调 → PAID，B 被作废
    await fireCallback(PaymentMethod.WECHAT_PAY, payA.id, 1000);

    // B 的真实网关回调迟到（客户确实又付了一次）→ 计入 paidAmount 形成可见多付
    const resB = await fireCallback(PaymentMethod.WECHAT_PAY, payB.id, 1000);
    expect(resB.ok).toBe(true);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(2000); // 1000 + 1000，多付 1000 可见
    expect(Number(dbOrder.total)).toBe(1000);
    const dbB = await prisma.payment.findUniqueOrThrow({ where: { id: payB.id } });
    expect(dbB.status).toBe(PaymentStatus.SUCCEEDED);

    // 幂等：B 的回调重放 → 不二次累加（仍 2000）
    const replay = await fireCallback(PaymentMethod.WECHAT_PAY, payB.id, 1000);
    expect(replay.ok).toBe(true);
    const dbOrder2 = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder2.paidAmount)).toBe(2000);
  });

  it('point 3：双通道到账（人工确认先 PAID）→ 网关迟到回调计入可见多付，钱不消失', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    const payA = await createPendingPayment(order.id, 1000); // 客户已发起网关支付（PENDING）

    // 人工线下确认全额 → 订单 PAID（走另一通道），此时网关 PENDING 单被作废
    await service.confirmManualPayment(order.id, { amount: 1000, method: PaymentMethod.BANK_CARD }, ADMIN);
    const midOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(midOrder.status).toBe(OrderStatus.PAID);
    expect(Number(midOrder.paidAmount)).toBe(1000);

    // 网关回调迟到（客户实际也付了网关）→ 这笔真实到账要落到 paidAmount 可见，而不是消失
    const resA = await fireCallback(PaymentMethod.WECHAT_PAY, payA.id, 1000);
    expect(resA.ok).toBe(true);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(2000); // 多付 1000 可见（可走 creditOverpayToAgent/overpayToPool 处置）
    const dbA = await prisma.payment.findUniqueOrThrow({ where: { id: payA.id } });
    expect(dbA.status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('point 1（并发不丢账）：网关回调 PAID 与人工部分到账并发 → paidAmount 无 lost update', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    // 应收 2000：网关 1000 + 人工 200 = 1200 均在应收内，两笔都不触发超收硬闸，
    // 纯测并发 FOR UPDATE 串行下的 paidAmount 累加不丢账。
    const order = await createPendingOrder(customer.id, 2000);
    const payA = await createPendingPayment(order.id, 1000);

    // 并发：A 回调（PENDING_PAYMENT→PAID，按台账聚合抬 paidAmount）+ 人工确认 200（累加 paidAmount）。
    // 两者都持 Order 行 FOR UPDATE 串行 → 无论谁先，最终 paidAmount = 1000 + 200 = 1200（不丢那 200）。
    await Promise.all([
      fireCallback(PaymentMethod.WECHAT_PAY, payA.id, 1000),
      service.confirmManualPayment(order.id, { amount: 200, method: PaymentMethod.BANK_CARD }, ADMIN),
    ]);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe(OrderStatus.PAID);
    expect(Number(dbOrder.paidAmount)).toBe(1200); // 1000（网关）+ 200（人工），无 lost update

    // A 只入账一次（一笔 SUCCEEDED 网关单 + 一笔 SUCCEEDED 人工单）
    const succeeded = await prisma.payment.findMany({
      where: { orderId: order.id, status: PaymentStatus.SUCCEEDED },
    });
    expect(succeeded).toHaveLength(2);
    expect(succeeded.reduce((s, p) => s + Number(p.amount), 0)).toBe(1200);
  });

  // ── A3：迟到回调命中已取消/超时订单 → CAS 标 REFUNDED（押 payment 原始状态、幂等）──
  it('A3：迟到回调命中已取消订单 → payment CAS 标 REFUNDED（原路退回），重试幂等不二次处理', async () => {
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    const pay = await createPendingPayment(order.id, 1000);
    // 回调到达前订单已取消
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });

    // 迟到回调：CAS（where id + status=PENDING）标 REFUNDED，抛「资金原路退回」
    await expect(fireCallback(PaymentMethod.WECHAT_PAY, pay.id, 1000)).rejects.toThrow(/资金将原路退回/);
    const dbPay = await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } });
    expect(dbPay.status).toBe(PaymentStatus.REFUNDED);
    expect(dbPay.paidAt).not.toBeNull();

    // 网关重试同一回调 → payment 已 REFUNDED，短路返回 ok:false，不二次处理（仍 REFUNDED，未被覆盖）
    const retry = await fireCallback(PaymentMethod.WECHAT_PAY, pay.id, 1000);
    expect(retry.ok).toBe(false);
    const dbPay2 = await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } });
    expect(dbPay2.status).toBe(PaymentStatus.REFUNDED);
  });

  it('A3：迟到回调命中已超时（PAYMENT_TIMEOUT）订单 → 同样 CAS 标 REFUNDED', async () => {
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    const pay = await createPendingPayment(order.id, 1000);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PAYMENT_TIMEOUT } });

    await expect(fireCallback(PaymentMethod.WECHAT_PAY, pay.id, 1000)).rejects.toThrow(/资金将原路退回/);
    const dbPay = await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } });
    expect(dbPay.status).toBe(PaymentStatus.REFUNDED);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B3 · 人工确认收款默认金额/fullyPaid 用清账口径（含 adjustmentCny + prepaymentOffset）
//   清账公式：应付 = total + adjustmentCny；结清 ⇔ paidAmount + prepaymentOffset >= 应付
// ══════════════════════════════════════════════════════════════════════════
describe('PaymentsService.confirmManualPayment · 清账口径含改期费与预存抵扣', () => {
  const service = new PaymentsService();

  it('默认收款金额 = 清账尾款（total + adjustmentCny − paidAmount − prepaymentOffset），收齐自动 PAID', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    // 改期费 300 + 预存抵扣 200 → 清账尾款 = 1000 + 300 − 0 − 200 = 1100
    await prisma.order.update({
      where: { id: order.id },
      data: { adjustmentCny: 300, prepaymentOffset: new Prisma.Decimal(200) },
    });

    // 不传 amount → 默认收清账尾款 1100；收齐后自动 PAID（1100 + 200 >= 1300）
    const result = await service.confirmManualPayment(order.id, { method: PaymentMethod.BANK_CARD }, ADMIN);
    expect(result.paidAmount).toBe(1100);
    expect(result.fullyPaid).toBe(true);
    expect(result.status).toBe(OrderStatus.PAID);
  });

  it('只收 total（没连改期费一起收）→ 不自动 PAID；补齐改期费后才 PAID', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    // 改期费 300，无预存抵扣 → 应付 1300
    await prisma.order.update({
      where: { id: order.id },
      data: { adjustmentCny: 300, prepaymentOffset: new Prisma.Decimal(0) },
    });

    // 收 1000（=total，但少了 300 改期费）→ 1000 + 0 < 1300 → 未收齐，不自动 PAID（旧口径会误 PAID）
    const first = await service.confirmManualPayment(order.id, { amount: 1000, method: PaymentMethod.BANK_CARD }, ADMIN);
    expect(first.fullyPaid).toBe(false);
    expect(first.status).toBe(OrderStatus.PENDING_PAYMENT);

    // 再补 300（连改期费收齐）→ 自动 PAID
    const second = await service.confirmManualPayment(order.id, { amount: 300, method: PaymentMethod.BANK_CARD }, ADMIN);
    expect(second.fullyPaid).toBe(true);
    expect(second.status).toBe(OrderStatus.PAID);
  });

  it('预存抵扣视同已付：收 total − prepaymentOffset 即结清', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    // 预存抵扣 400，无改期费 → 清账尾款 = 1000 − 400 = 600
    await prisma.order.update({
      where: { id: order.id },
      data: { prepaymentOffset: new Prisma.Decimal(400) },
    });

    const result = await service.confirmManualPayment(order.id, { amount: 600, method: PaymentMethod.BANK_CARD }, ADMIN);
    expect(result.fullyPaid).toBe(true); // 600 + 400 >= 1000
    expect(result.status).toBe(OrderStatus.PAID);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 同额防呆软闸 · 近 10 分钟等额手工收款 → 409 DUPLICATE_AMOUNT；confirmDuplicate 放行
//   场景选应收充裕的订单（total 2000），使两笔 500 都不触发超收硬闸，单独测软闸。
// ══════════════════════════════════════════════════════════════════════════
describe('PaymentsService.confirmManualPayment · 同额防呆软闸', () => {
  const service = new PaymentsService();

  it('等额重复无标志 → 被拦（409 + code DUPLICATE_AMOUNT），第二笔不入账', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 2000);

    // 第一笔 500 正常入账
    const first = await service.confirmManualPayment(
      order.id,
      { amount: 500, method: PaymentMethod.BANK_CARD },
      ADMIN,
    );
    expect(first.paidAmount).toBe(500);

    // 第二笔等额 500（近 10 分钟内、未带 confirmDuplicate）→ 软闸拦下
    let caught: unknown;
    try {
      await service.confirmManualPayment(
        order.id,
        { amount: 500, method: PaymentMethod.WECHAT_PAY },
        ADMIN,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // 稳定 code=DUPLICATE_AMOUNT（前端据此弹二次确认，不靠中文文案匹配）
    expect((caught as { code?: string }).code).toBe('DUPLICATE_AMOUNT');
    expect((caught as { statusCode?: number }).statusCode).toBe(409);

    // 第二笔未入账：paidAmount 仍 500，只有一笔 Payment
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(500);
    const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(payments).toHaveLength(1);
  });

  it('等额重复带 confirmDuplicate:true → 放行（确系两笔真实到账）', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 2000);

    await service.confirmManualPayment(
      order.id,
      { amount: 500, method: PaymentMethod.BANK_CARD },
      ADMIN,
    );

    // 带 confirmDuplicate 放行软闸（超收硬闸仍在：500+500=1000 ≤ 2000，不触发）
    const second = await service.confirmManualPayment(
      order.id,
      { amount: 500, method: PaymentMethod.WECHAT_PAY, confirmDuplicate: true },
      ADMIN,
    );
    expect(second.paidAmount).toBe(1000);

    const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(payments).toHaveLength(2);
  });

  it('两闸叠加超收优先：等额重复且会超收 → 抛超收 400（非 409），不是软闸', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);

    // 第一笔 1000 收满
    await service.confirmManualPayment(
      order.id,
      { amount: 1000, method: PaymentMethod.BANK_CARD },
      ADMIN,
    );
    // 第二笔等额 1000：既是等额重复、又会超收 → 超收硬闸优先，抛 400（不是 409 软闸）
    let caught: unknown;
    try {
      await service.confirmManualPayment(
        order.id,
        { amount: 1000, method: PaymentMethod.WECHAT_PAY },
        ADMIN,
      );
    } catch (e) {
      caught = e;
    }
    expect((caught as { statusCode?: number }).statusCode).toBe(400);
    expect((caught as { code?: string }).code).not.toBe('DUPLICATE_AMOUNT');
  });

  it('批量到账跳过软闸：同订单同额两条 batch 项均入账（batchId 去重另管重复提交）', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 2000);

    // 批量里对同一订单放两条等额 500 → 软闸被 confirmDuplicate:true 跳过，两条都入账（合计 1000 ≤ 2000）
    const { results } = await service.batchConfirmManualPayment(
      {
        items: [
          { orderId: order.id, amount: 500, method: PaymentMethod.BANK_CARD },
          { orderId: order.id, amount: 500, method: PaymentMethod.WECHAT_PAY },
        ],
      },
      ADMIN,
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1000);
  });
});

describe('PaymentsService · 收款复核锁守卫（只拦人工录入）', () => {
  const service = new PaymentsService();

  it('paymentsLocked=true → 人工确认收款被拒（409），订单未被改动', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    await prisma.order.update({ where: { id: order.id }, data: { paymentsLocked: true } });

    await expect(
      service.confirmManualPayment(
        order.id,
        { amount: 500, method: PaymentMethod.BANK_CARD },
        ADMIN,
      ),
    ).rejects.toThrow(/收款已锁定/);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(0);
    const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(payments).toHaveLength(0);
  });

  it('paymentsLocked=true → 批量确认逐单返回 ok:false（复用同一守卫）', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    await prisma.order.update({ where: { id: order.id }, data: { paymentsLocked: true } });

    const { results } = await service.batchConfirmManualPayment(
      { items: [{ orderId: order.id, amount: 500, method: PaymentMethod.BANK_CARD }] },
      ADMIN,
    );
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/收款已锁定/);
  });

  it('解锁后人工确认恢复正常入账', async () => {
    const ADMIN = await createAdminActor();
    const customer = await createCustomer();
    const order = await createPendingOrder(customer.id, 1000);
    await prisma.order.update({ where: { id: order.id }, data: { paymentsLocked: true } });
    await prisma.order.update({ where: { id: order.id }, data: { paymentsLocked: false } });

    const res = await service.confirmManualPayment(
      order.id,
      { amount: 1000, method: PaymentMethod.BANK_CARD },
      ADMIN,
    );
    expect(res.status).toBe(OrderStatus.PAID);
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1000);
  });
});
