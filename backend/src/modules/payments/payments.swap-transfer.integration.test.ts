/**
 * PaymentsService.swapTransfer · 订单间转款与换人费 · 真 DB 集成测试
 *
 * 覆盖：
 *   - 正常换人转出：源单退款完成但 paidAmount 不变，净收款留存换人费，余额入目标单
 *   - 源单原有 Payment 行保持 SUCCEEDED 且不被拆分或搬动
 *   - 源单状态机真实释放座位并落 REFUNDED
 *   - 转入目标单的换人收款不能从通用人工收款入口单独撤销
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration -- src/modules/payments/payments.swap-transfer.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  CabinClass,
  OrderItemKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  RefundStatus,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { PaymentsService } from './payments.service.js';

// ── Fixtures ──────────────────────────────────────────────────────────────
function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createUser(role: UserRole = UserRole.CUSTOMER) {
  return prisma.user.create({
    data: { email: `${uniq('u')}@test.com`, role },
  });
}

/** 建一个真实班次和经济舱库存；sold=1 用来验证源单退款状态机确实释放座位。 */
async function createScheduleWithSeats() {
  const departureTime = new Date(Date.now() + 200 * 3600 * 1000);
  const flight = await prisma.flight.create({
    data: {
      flightNumber: uniq('FL'),
      originCode: 'MFM',
      destinationCode: 'DAD',
      isActive: true,
    },
  });
  const schedule = await prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: 'Asia/Macau',
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
      seatClasses: {
        create: [{
          cabin: CabinClass.ECONOMY,
          capacity: 50,
          sold: 1,
          basePrice: new Prisma.Decimal(1000),
        }],
      },
    },
    include: { seatClasses: true },
  });
  return { schedule, seatClass: schedule.seatClasses[0] };
}

/** 建一个 PAID 航班订单；库存由夹具显式设为 sold=1，和真实下单后的账面一致。 */
async function createPaidFlightOrder(opts: {
  scheduleId: string;
  userId: string;
  total: number;
  paidAmount: number;
}) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('ORD'),
      userId: opts.userId,
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(opts.total),
      total: new Prisma.Decimal(opts.total),
      paidAmount: new Prisma.Decimal(opts.paidAmount),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [{
          kind: OrderItemKind.FLIGHT,
          description: 'TEST MFM→DAD',
          quantity: 1,
          unitPrice: new Prisma.Decimal(opts.total),
          amount: new Prisma.Decimal(opts.total),
          flightScheduleId: opts.scheduleId,
          flightCabin: CabinClass.ECONOMY,
        }],
      },
      passengers: {
        create: [{
          fullName: 'WANG XIAO',
          lastName: 'WANG',
          firstName: 'XIAO',
          documentType: 'PASSPORT',
          documentNumber: uniq('P'),
          dateOfBirth: new Date('1990-01-01'),
          nationality: 'CHN',
        }],
      },
    },
    include: { items: true },
  });
}

/** 建一张价格不同的新目标单，保持待支付以验证转入款真实累加到 paidAmount。 */
async function createTargetOrder(userId: string) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('ORD'),
      userId,
      status: OrderStatus.PENDING_PAYMENT,
      subtotal: new Prisma.Decimal(10000),
      total: new Prisma.Decimal(10000),
      paidAmount: new Prisma.Decimal(0),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [{
          kind: OrderItemKind.VISA,
          description: 'TEST VISA',
          quantity: 1,
          unitPrice: new Prisma.Decimal(10000),
          amount: new Prisma.Decimal(10000),
        }],
      },
    },
  });
}

describe('PaymentsService.swapTransfer · 真 DB 资金与座位账', () => {
  const service = new PaymentsService();

  it('真实完成换人转出：退款、净收、目标入账、原收款和座位均落库正确', async () => {
    const admin = await createUser(UserRole.ADMIN);
    const sourceCustomer = await createUser();
    const targetCustomer = await createUser();
    const { schedule, seatClass } = await createScheduleWithSeats();
    const source = await createPaidFlightOrder({
      scheduleId: schedule.id,
      userId: sourceCustomer.id,
      total: 5000,
      paidAmount: 5000,
    });
    const target = await createTargetOrder(targetCustomer.id);
    const sourcePayment = await prisma.payment.create({
      data: {
        orderId: source.id,
        method: PaymentMethod.BANK_CARD,
        amount: new Prisma.Decimal(5000),
        status: PaymentStatus.SUCCEEDED,
        paidAt: new Date(),
        verifiedAt: new Date(),
        verifiedById: admin.id,
        gatewayPayload: { manual: true, note: '线下转账' },
      },
    });

    const result = await service.swapTransfer(
      source.id,
      {
        targetOrderNumber: target.orderNumber,
        transferFeeCny: 450,
        reason: '原旅客临时无法出行',
      },
      { userId: admin.id, role: UserRole.ADMIN },
    );

    const [sourceAfter, targetAfter, sourceRefunds, sourcePayments, targetPayments, seatAfter] =
      await Promise.all([
        prisma.order.findUniqueOrThrow({ where: { id: source.id } }),
        prisma.order.findUniqueOrThrow({ where: { id: target.id } }),
        prisma.refund.findMany({ where: { orderId: source.id } }),
        prisma.payment.findMany({ where: { orderId: source.id }, orderBy: { createdAt: 'asc' } }),
        prisma.payment.findMany({ where: { orderId: target.id } }),
        prisma.flightSeatClass.findUniqueOrThrow({ where: { id: seatClass.id } }),
      ]);

    expect(result.transferredAmount).toBe(4550);
    expect(sourceAfter.status).toBe(OrderStatus.REFUNDED);
    expect(Number(sourceAfter.paidAmount)).toBe(5000);
    expect(sourceRefunds).toHaveLength(1);
    expect(sourceRefunds[0].status).toBe(RefundStatus.COMPLETED);
    expect(Number(sourceRefunds[0].amount)).toBe(4550);
    expect(sourceRefunds
      .filter((refund) => refund.status === RefundStatus.COMPLETED)
      .reduce((sum, refund) => sum + Number(refund.amount), 0)).toBe(4550);
    expect(Number(sourceAfter.paidAmount) - Number(sourceRefunds[0].amount)).toBe(450);
    expect(Number(targetAfter.paidAmount)).toBe(4550);

    expect(sourcePayments).toHaveLength(1);
    expect(sourcePayments[0].id).toBe(sourcePayment.id);
    expect(sourcePayments[0].status).toBe(PaymentStatus.SUCCEEDED);
    expect(Number(sourcePayments[0].amount)).toBe(5000);
    expect(targetPayments).toHaveLength(1);
    expect(targetPayments[0].status).toBe(PaymentStatus.SUCCEEDED);
    expect(targetPayments[0].gatewayPayload).toMatchObject({
      swapTransfer: true,
      transferredIn: true,
      transferredFromOrderId: source.id,
      refundId: result.refundId,
    });
    expect(seatAfter.sold).toBe(0);

    await expect(
      service.reverseManualPayment(
        targetPayments[0].id,
        { reason: '尝试单独回退转入款' },
        { userId: admin.id, role: UserRole.ADMIN },
      ),
    ).rejects.toThrow('这笔收款是换人转出的转入款，不能单独撤销');

    const targetPaymentAfter = await prisma.payment.findUniqueOrThrow({
      where: { id: targetPayments[0].id },
    });
    const targetOrderAfterReverseAttempt = await prisma.order.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(targetPaymentAfter.status).toBe(PaymentStatus.SUCCEEDED);
    expect(Number(targetOrderAfterReverseAttempt.paidAmount)).toBe(4550);
  });
});
