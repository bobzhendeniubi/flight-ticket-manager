/**
 * OrderService.requestCancellation · 真 DB 集成测试
 *
 * 这是真正的端到端：
 *   - 真 postgres（docker-compose.test.yml）
 *   - 真 prisma migrate
 *   - 真 transaction
 *   - 真 Order/Refund/StatusEvent 表写入
 *
 * 配套：
 *   - 启动测试库：docker compose -f docker-compose.test.yml up -d
 *   - 跑这套：npm run test:integration
 *   - schema 同步：tests/integration/setup.ts 自动 prisma migrate deploy
 */
import { describe, it, expect } from 'vitest';
import { OrderItemKind, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from './orders.service.js';

// ── Fixture helpers ──────────────────────────────────────────────────────
async function createUser(role: 'CUSTOMER' | 'ADMIN' | 'AGENT' = 'CUSTOMER') {
  return prisma.user.create({
    data: {
      email: `u${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      role,
    },
  });
}

/** 创建一个已支付的 Order + 1 个 FLIGHT item，用 future-flight schedule。 */
async function createPaidOrder(userId: string, opts?: { departureHoursFromNow?: number }) {
  const departureHoursFromNow = opts?.departureHoursFromNow ?? 100; // 默认起飞前 100h
  const departureTime = new Date(Date.now() + departureHoursFromNow * 3600 * 1000);

  // FlightSchedule 关联 Flight（一对多）— 先建 Flight 再建 Schedule
  const flightNumber = `TEST${Math.floor(Math.random() * 10000)}`;
  const flight = await prisma.flight.create({
    data: {
      flightNumber,
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

  const order = await prisma.order.create({
    data: {
      orderNumber: `TEST-ORD-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      userId,
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(1000),
      total: new Prisma.Decimal(1000),
      paidAmount: new Prisma.Decimal(1000),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.FLIGHT,
            description: `${flightNumber} ${flight.originCode}→${flight.destinationCode}`,
            quantity: 1,
            unitPrice: new Prisma.Decimal(1000),
            amount: new Prisma.Decimal(1000),
            flightScheduleId: schedule.id,
            flightCabin: 'ECONOMY',
          },
        ],
      },
    },
    include: { items: true, refunds: true },
  });

  return { order, schedule, flight };
}

/** 标准航班取消策略（默认）：72h 前 0%、48h 30%、24h 50%、已起飞 100% */
async function createFlightCancellationPolicy() {
  return prisma.cancellationPolicy.create({
    data: {
      productKind: OrderItemKind.FLIGHT,
      name: '默认机票退订（测试）',
      isDefault: true,
      tiers: [
        { hoursBeforeDeparture: 72, feePercent: 0 },
        { hoursBeforeDeparture: 48, feePercent: 30 },
        { hoursBeforeDeparture: 24, feePercent: 50 },
        { hoursBeforeDeparture: -1, feePercent: 100 },
      ],
    },
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.requestCancellation · 真 DB E2E', () => {
  const service = new OrderService();

  it('happy path: 起飞前 100h 取消 → 创建 Refund + Order 转 REFUND_REQUESTED', async () => {
    const customer = await createUser('CUSTOMER');
    await createFlightCancellationPolicy();
    const { order } = await createPaidOrder(customer.id, { departureHoursFromNow: 100 });

    const result = await service.requestCancellation(order.id, '改主意了', {
      userId: customer.id,
      role: 'CUSTOMER',
      agentId: undefined,
    });

    expect(result.isNew).toBe(true);
    expect(result.refund).toBeDefined();
    expect(result.refund.status).toBe('REQUESTED');
    // 100h > 72h 档 → 0% 手续费 → 全额退
    expect(Number(result.refund.amount)).toBe(1000);
    expect(result.quote.totalFee).toBe(0);
    expect(result.quote.totalRefund).toBe(1000);

    // 验证 DB：Order 状态已转
    const reloaded = await prisma.order.findUnique({
      where: { id: order.id },
      include: { refunds: true, statusEvents: true },
    });
    expect(reloaded!.status).toBe('REFUND_REQUESTED');
    expect(reloaded!.refunds).toHaveLength(1);
    expect(reloaded!.statusEvents.some((e) => e.toStatus === 'REFUND_REQUESTED')).toBe(true);
  });

  it('30h 起飞前取消 → 50% 手续费 → 退一半', async () => {
    const customer = await createUser('CUSTOMER');
    await createFlightCancellationPolicy();
    const { order } = await createPaidOrder(customer.id, { departureHoursFromNow: 30 });

    const result = await service.requestCancellation(order.id, undefined, {
      userId: customer.id,
      role: 'CUSTOMER',
      agentId: undefined,
    });

    expect(result.isNew).toBe(true);
    expect(result.quote.totalFee).toBe(500); // 50%
    expect(result.quote.totalRefund).toBe(500);
    expect(Number(result.refund.amount)).toBe(500);
  });

  it('幂等：重复申请同一订单 → 第二次返回 isNew=false（不创建第二条 Refund）', async () => {
    const customer = await createUser('CUSTOMER');
    await createFlightCancellationPolicy();
    const { order } = await createPaidOrder(customer.id, { departureHoursFromNow: 100 });

    const r1 = await service.requestCancellation(order.id, '第一次', {
      userId: customer.id,
      role: 'CUSTOMER',
      agentId: undefined,
    });
    expect(r1.isNew).toBe(true);

    const r2 = await service.requestCancellation(order.id, '第二次', {
      userId: customer.id,
      role: 'CUSTOMER',
      agentId: undefined,
    });
    expect(r2.isNew).toBe(false);
    expect(r2.refund.id).toBe(r1.refund.id);

    // DB 里应该只有 1 条 Refund
    const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds).toHaveLength(1);
  });

  it('权限：customer A 取消 customer B 的订单 → ForbiddenError，不动数据', async () => {
    const customerA = await createUser('CUSTOMER');
    const customerB = await createUser('CUSTOMER');
    await createFlightCancellationPolicy();
    const { order } = await createPaidOrder(customerB.id, { departureHoursFromNow: 100 });

    await expect(
      service.requestCancellation(order.id, undefined, {
        userId: customerA.id,
        role: 'CUSTOMER',
        agentId: undefined,
      }),
    ).rejects.toThrow(/无权/);

    // 验证：B 的订单状态不变，没建 Refund
    const reloaded = await prisma.order.findUnique({
      where: { id: order.id },
      include: { refunds: true },
    });
    expect(reloaded!.status).toBe('PAID');
    expect(reloaded!.refunds).toHaveLength(0);
  });

  it('订单不存在 → NotFoundError', async () => {
    const customer = await createUser('CUSTOMER');
    await expect(
      service.requestCancellation('nonexistent-id', undefined, {
        userId: customer.id,
        role: 'CUSTOMER',
        agentId: undefined,
      }),
    ).rejects.toThrow(/不存在/);
  });

  it('已起飞（hoursLeft < 0）→ 100% 手续费 + 0 退款', async () => {
    const customer = await createUser('CUSTOMER');
    await createFlightCancellationPolicy();
    const { order } = await createPaidOrder(customer.id, { departureHoursFromNow: -5 });

    const result = await service.requestCancellation(order.id, undefined, {
      userId: customer.id,
      role: 'CUSTOMER',
      agentId: undefined,
    });

    expect(result.quote.totalFee).toBe(1000);
    expect(result.quote.totalRefund).toBe(0);
    expect(Number(result.refund.amount)).toBe(0);
  });
});
