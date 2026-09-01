/**
 * OrderService.swapRefund · 真 DB 集成测试
 *
 * 这是真正的端到端：
 *   - 真 postgres（docker-compose.test.yml）
 *   - 真 prisma migrate
 *   - 真 transaction
 *   - 真 Order/Refund/StatusEvent/FlightSeatClass 表写入
 *
 * 配套：
 *   - 启动测试库：docker compose -f docker-compose.test.yml up -d
 *   - 跑这套：npm run test:integration
 *   - schema 同步：tests/integration/setup.ts 自动 prisma migrate deploy
 */
import { describe, expect, it } from 'vitest';
import {
  CommissionStatus,
  OrderItemKind,
  OrderStatus,
  Prisma,
  ProductKind,
  RefundStatus,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { netReceivedCny, sumCompletedRefundCny } from '../../lib/net-received.js';
import { OrderService } from './orders.service.js';

// ── Fixture helpers ──────────────────────────────────────────────────────
async function createUser(role: UserRole) {
  return prisma.user.create({
    data: {
      email: `swap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`,
      role,
    },
  });
}

async function createReplacementOrder(userId: string) {
  return prisma.order.create({
    data: {
      orderNumber: `TEST-REPLACEMENT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      userId,
      status: OrderStatus.PENDING_PAYMENT,
      subtotal: new Prisma.Decimal(800),
      total: new Prisma.Decimal(800),
      paidAmount: new Prisma.Decimal(0),
      contactName: '接手订单客户',
      contactPhone: '13800138001',
    },
  });
}

/** 创建一个已支付、确实占用 1 个经济舱座位的源订单。 */
async function createPaidOrder(userId: string, agentId?: string) {
  const departureTime = new Date(Date.now() + 100 * 3600 * 1000);
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `SWAP${Math.floor(Math.random() * 100000)}`,
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
    },
  });
  const seatClass = await prisma.flightSeatClass.create({
    data: {
      scheduleId: schedule.id,
      cabin: 'ECONOMY',
      capacity: 10,
      sold: 1,
      basePrice: new Prisma.Decimal(1000),
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `TEST-SWAP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      userId,
      agentId,
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(1000),
      total: new Prisma.Decimal(1000),
      paidAmount: new Prisma.Decimal(1000),
      contactName: '原订单客户',
      contactPhone: '13800138000',
      items: {
        create: {
          kind: OrderItemKind.FLIGHT,
          description: `${flight.flightNumber} MFM→DAD 经济舱`,
          quantity: 1,
          unitPrice: new Prisma.Decimal(1000),
          amount: new Prisma.Decimal(1000),
          flightScheduleId: schedule.id,
          flightCabin: 'ECONOMY',
        },
      },
    },
  });
  return { order, seatClass };
}

// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.swapRefund · 真 DB E2E', () => {
  const service = new OrderService();

  it('正常换人退款：净收 1000、换人费 450 → 源单申请退款、标记落库并释放座位', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const admin = await createUser(UserRole.ADMIN);
    const replacement = await createReplacementOrder(customer.id);
    const { order, seatClass } = await createPaidOrder(customer.id);
    const originalPaidAmount = Number(order.paidAmount);

    const result = await service.swapRefund(
      order.id,
      {
        swapFeeCny: 450,
        replacementOrderNumber: replacement.orderNumber,
        reason: '客人临时无法出行',
      },
      { userId: admin.id, role: UserRole.ADMIN },
    );

    expect(result.netPaidCny).toBe(1000);
    expect(result.swapFeeCny).toBe(450);
    expect(result.refundAmountCny).toBe(550);

    const reloaded = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { refunds: true, statusEvents: true },
    });
    expect(reloaded.status).toBe(OrderStatus.REFUND_REQUESTED);
    expect(reloaded.swapRefundedAt).toEqual(expect.any(Date));
    expect(reloaded.swapFeeCny).toBe(450);
    expect(reloaded.swapReplacementOrderNumber).toBe(replacement.orderNumber);
    expect(reloaded.internalNotes).toContain('【换人退款】');
    expect(reloaded.internalNotes).toContain('换人费 ¥450，应退 ¥550');
    expect(reloaded.internalNotes).toContain('接手订单');
    expect(reloaded.statusEvents.some((event) => event.toStatus === OrderStatus.REFUND_REQUESTED)).toBe(true);

    expect(reloaded.refunds).toHaveLength(1);
    expect(reloaded.refunds[0].status).toBe(RefundStatus.REQUESTED);
    expect(Number(reloaded.refunds[0].amount)).toBe(550);
    expect(reloaded.refunds[0].reason).toBe(
      '换人退款（换人费 ¥450，接手订单 ' + replacement.orderNumber + '）：客人临时无法出行',
    );
    expect(reloaded.refunds[0].gatewayPayload).toMatchObject({
      swapRefund: true,
      swapFeeCny: 450,
      netPaidCny: 1000,
      refundAmountCny: 550,
      replacementOrderNumber: replacement.orderNumber,
    });
    expect(reloaded.refunds[0].gatewayPayload).not.toHaveProperty('quoteSnapshot');

    const seatAfter = await prisma.flightSeatClass.findUniqueOrThrow({ where: { id: seatClass.id } });
    expect(seatAfter.sold).toBe(0);
    expect(Number(reloaded.paidAmount)).toBe(originalPaidAmount);

    // 接手订单只作为记录存在；源单的资金没有复制或转移到新单。
    const replacementAfter = await prisma.order.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(Number(replacementAfter.paidAmount)).toBe(0);
    expect(await prisma.payment.count({ where: { orderId: replacement.id } })).toBe(0);
  });

  it('换人费为 0 → 全额退款申请；换人费等于净收款 → 零额退款申请也通过', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const admin = await createUser(UserRole.ADMIN);

    const zeroFee = await createPaidOrder(customer.id);
    const zeroResult = await service.swapRefund(
      zeroFee.order.id,
      { swapFeeCny: 0, reason: '不收换人费' },
      { userId: admin.id, role: UserRole.ADMIN },
    );
    expect(zeroResult.refundAmountCny).toBe(1000);

    const fullFee = await createPaidOrder(customer.id);
    const fullResult = await service.swapRefund(
      fullFee.order.id,
      { swapFeeCny: 1000, reason: '换人费抵扣全款' },
      { userId: admin.id, role: UserRole.ADMIN },
    );
    expect(fullResult.refundAmountCny).toBe(0);
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: fullFee.order.id } });
    expect(Number(refund.amount)).toBe(0);
  });

  it('零额换人退款完整生命周期：批准后落已退款并全额冲销佣金，报表净收仍为换人费', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const agentUser = await createUser(UserRole.AGENT);
    const agent = await prisma.agent.create({
      data: {
        userId: agentUser.id,
        contactName: '测试代理',
        contactPhone: '13800138001',
      },
    });
    const admin = await createUser(UserRole.ADMIN);
    const { order } = await createPaidOrder(customer.id, agent.id);
    const commission = await prisma.commissionRecord.create({
      data: {
        agentId: agent.id,
        orderId: order.id,
        productKind: ProductKind.FLIGHT,
        baseAmount: new Prisma.Decimal(1000),
        rate: new Prisma.Decimal('0.0500'),
        amount: new Prisma.Decimal(50),
        status: CommissionStatus.ACCRUED,
        chainDepth: 0,
      },
    });

    await service.swapRefund(
      order.id,
      { swapFeeCny: 1000, reason: '换人费抵扣全款' },
      { userId: admin.id, role: UserRole.ADMIN },
    );
    await service.updateStatus(
      order.id,
      OrderStatus.REFUNDED,
      { userId: admin.id, role: UserRole.ADMIN },
      '财务批准零额退款',
    );

    const reloaded = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { refunds: true },
    });
    expect(reloaded.status).toBe(OrderStatus.REFUNDED);
    expect(reloaded.swapRefundedAt).toEqual(expect.any(Date));
    expect(reloaded.swapFeeCny).toBe(1000);
    expect(reloaded.swapReplacementOrderNumber).toBeNull();
    expect(reloaded.refunds).toHaveLength(1);
    expect(reloaded.refunds[0].status).toBe(RefundStatus.COMPLETED);
    expect(Number(reloaded.refunds[0].amount)).toBe(0);
    expect(reloaded.refunds[0].gatewayPayload).toMatchObject({
      swapRefund: true,
      swapFeeCny: 1000,
      netPaidCny: 1000,
      refundAmountCny: 0,
    });

    const commissionAfter = await prisma.commissionRecord.findUniqueOrThrow({ where: { id: commission.id } });
    expect(commissionAfter.status).toBe(CommissionStatus.REVERSED);

    const netReceived = netReceivedCny(reloaded, sumCompletedRefundCny(reloaded.refunds));
    expect(netReceived).toBe(1000);
    expect(netReceived).toBe(reloaded.swapFeeCny);
  });
});
