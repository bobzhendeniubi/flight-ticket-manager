/**
 * 到账双状态（业务已收 → 财务已核实）· 真 DB 集成测试
 *
 * 覆盖（资金关键路径）：
 *   - 人工确认收款 → verifiedAt 为空（待核实），进 listUnverifiedPayments 队列
 *   - 认款（register → allocate）生成的收款 → 创建即已核实，不进队列
 *   - verifyManualPayment：他人核实成功；录入人自核被拒（ADMIN 例外）；重复核实被拒
 *   - OPS_CLAIM 进账：进 listUnverifiedClaims 队列；verifyClaimReceipt 落 verifiedAt +
 *     可选写 externalTxnId；流水号撞已有进账被拒；录入人自核被拒
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { OrderStatus, PaymentMethod, ReceiptSource, UserRole, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { PaymentsService } from './payments.service.js';
import { ReceiptsService, createOpenReceiptWithinTx } from '../receipts/receipts.service.js';

const paymentsService = new PaymentsService();
const receiptsService = new ReceiptsService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createActor(role: UserRole) {
  const user = await prisma.user.create({
    data: { email: `${uniq('user')}@test.com`, role, displayName: uniq('操作员') },
  });
  return { userId: user.id, role };
}

async function createGuestOrder(total = 1000) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-VRF'),
      agentId: null,
      status: OrderStatus.PENDING_PAYMENT,
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(0),
      contactName: 'WANG MEI',
      contactPhone: '13800138000',
      items: {
        create: [
          { kind: 'VISA', description: '测试服务项', quantity: 1, unitPrice: new Prisma.Decimal(total), amount: new Prisma.Decimal(total) },
        ],
      },
    },
  });
}

// ══════════════════════════════════════════════════════════════════════════
describe('到账双状态 · 订单人工收款', () => {
  it('人工确认收款待核实进队列；他人核实后落 verifiedAt 并出队', async () => {
    const staffA = await createActor(UserRole.STAFF);
    const staffB = await createActor(UserRole.STAFF);
    const order = await createGuestOrder(1000);

    const confirmed = await paymentsService.confirmManualPayment(
      order.id,
      { amount: 1000, method: PaymentMethod.WECHAT_PAY },
      staffA,
    );
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: confirmed.paymentId } });
    expect(payment.verifiedAt).toBeNull();

    const queue = await paymentsService.listUnverifiedPayments();
    expect(queue.some((item) => item.id === confirmed.paymentId)).toBe(true);

    const verified = await paymentsService.verifyManualPayment(confirmed.paymentId, staffB);
    expect(verified.ok).toBe(true);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: confirmed.paymentId } });
    expect(after.verifiedAt).not.toBeNull();
    expect(after.verifiedById).toBe(staffB.userId);

    const queueAfter = await paymentsService.listUnverifiedPayments();
    expect(queueAfter.some((item) => item.id === confirmed.paymentId)).toBe(false);
  });

  it('录入人不能核实自己录的账（STAFF 拒；ADMIN 例外）；重复核实拒', async () => {
    const staff = await createActor(UserRole.STAFF);
    const admin = await createActor(UserRole.ADMIN);
    const order = await createGuestOrder(500);
    const confirmed = await paymentsService.confirmManualPayment(
      order.id,
      { amount: 500, method: PaymentMethod.ALIPAY },
      staff,
    );

    await expect(paymentsService.verifyManualPayment(confirmed.paymentId, staff)).rejects.toThrow(/不能核实自己录入/u);

    const verified = await paymentsService.verifyManualPayment(confirmed.paymentId, admin);
    expect(verified.ok).toBe(true);
    await expect(paymentsService.verifyManualPayment(confirmed.paymentId, admin)).rejects.toThrow(/已经核实过/u);
  });

  it('认款生成的收款创建即已核实，不进待核实队列', async () => {
    const admin = await createActor(UserRole.ADMIN);
    const order = await createGuestOrder(800);
    const receipt = await receiptsService.register({ amountCny: 800, method: PaymentMethod.WECHAT_PAY }, admin);
    const result = await receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 800 }, admin);
    expect(result.ok).toBe(true);

    const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.verifiedAt).not.toBeNull();

    const queue = await paymentsService.listUnverifiedPayments();
    expect(queue.some((item) => item.orderId === order.id)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('到账双状态 · 运营水单登记（OPS_CLAIM）', () => {
  async function createClaimReceipt(actor: { userId: string }, amountCny = 3000) {
    return prisma.$transaction((tx) =>
      createOpenReceiptWithinTx(tx, {
        amountCny,
        method: PaymentMethod.BANK_CARD,
        source: ReceiptSource.OPS_CLAIM,
        payerNote: '客户水单尾号 1234',
        createdById: actor.userId,
      }),
    );
  }

  it('OPS_CLAIM 进待核实队列；核实可带流水号（写 externalTxnId）', async () => {
    const staffA = await createActor(UserRole.STAFF);
    const staffB = await createActor(UserRole.STAFF);
    const receipt = await createClaimReceipt(staffA);

    const queue = await receiptsService.listUnverifiedClaims();
    expect(queue.some((item) => item.id === receipt.id)).toBe(true);

    const txnId = uniq('TXN');
    const verified = await receiptsService.verifyClaimReceipt(receipt.id, { externalTxnId: txnId }, staffB);
    expect(verified.ok).toBe(true);

    const after = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(after.verifiedAt).not.toBeNull();
    expect(after.verifiedById).toBe(staffB.userId);
    expect(after.externalTxnId).toBe(txnId);

    const queueAfter = await receiptsService.listUnverifiedClaims();
    expect(queueAfter.some((item) => item.id === receipt.id)).toBe(false);
  });

  it('流水号已挂在别的进账上 → 拒（同一笔钱不能记两次）', async () => {
    const staffA = await createActor(UserRole.STAFF);
    const staffB = await createActor(UserRole.STAFF);
    const txnId = uniq('TXN');
    await prisma.receipt.update({
      where: { id: (await createClaimReceipt(staffA, 100)).id },
      data: { externalTxnId: txnId },
    });
    const receipt = await createClaimReceipt(staffA, 200);
    await expect(receiptsService.verifyClaimReceipt(receipt.id, { externalTxnId: txnId }, staffB)).rejects.toThrow(/已登记在进账/u);
  });

  it('录入人自核被拒（STAFF）；非 OPS_CLAIM 进账不接受核实', async () => {
    const staff = await createActor(UserRole.STAFF);
    const claim = await createClaimReceipt(staff);
    await expect(receiptsService.verifyClaimReceipt(claim.id, {}, staff)).rejects.toThrow(/不能核实自己录入/u);

    const admin = await createActor(UserRole.ADMIN);
    const normal = await receiptsService.register({ amountCny: 50, method: PaymentMethod.WECHAT_PAY }, admin);
    await expect(receiptsService.verifyClaimReceipt(normal.id, {}, admin)).rejects.toThrow(/只有运营水单登记/u);
  });
});
