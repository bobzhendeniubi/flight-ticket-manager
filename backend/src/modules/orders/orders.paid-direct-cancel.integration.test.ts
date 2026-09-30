/**
 * 已付款族「钱已撤干净」直接取消 · 真 DB 集成测试
 *
 * 现场：运营录了到账（订单自动推到已支付）→ 发现录错/客人不走了 → 撤销到账（钱回 0，状态刻意不动）
 * → 想取消却被状态机拦下，只能找管理员强制。修复后：净收款 ≤ 0 且无进行中退款、余额抵扣已退回时，
 * 运营可不带强制直接取消；列表 / 详情的 allowedTransitions 同步出现「已取消」。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npx vitest run -c vitest.integration.config.ts src/modules/orders/orders.paid-direct-cancel.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  FulfillmentStatus,
  OrderStatus,
  PaymentMethod,
  PrepaymentTxType,
  Prisma,
  RefundStatus,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService, type OrderRequester } from './orders.service.js';
import { PaymentsService } from '../payments/payments.service.js';

const orders = new OrderService();
const payments = new PaymentsService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function staffActor(): Promise<OrderRequester> {
  const user = await prisma.user.create({
    data: { email: `${uniq('staff')}@test.com`, role: UserRole.STAFF, displayName: uniq('运营') },
  });
  return { userId: user.id, role: UserRole.STAFF, actorType: 'USER' as const };
}

async function createOrder(opts: { status?: OrderStatus; paidAmount?: number; agentId?: string | null } = {}) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-PDC'),
      status: opts.status ?? OrderStatus.PENDING_PAYMENT,
      agentId: opts.agentId ?? null,
      subtotal: new Prisma.Decimal(1000),
      total: new Prisma.Decimal(1000),
      paidAmount: new Prisma.Decimal(opts.paidAmount ?? 0),
      contactName: 'WANG MEI',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: 'VISA',
            description: '测试签证',
            quantity: 1,
            unitPrice: new Prisma.Decimal(1000),
            amount: new Prisma.Decimal(1000),
          },
        ],
      },
    },
  });
}

async function allowedOf(orderId: string, requester: OrderRequester): Promise<string[]> {
  const detail = (await orders.getOrder(orderId, requester)) as { allowedTransitions: string[] };
  return detail.allowedTransitions;
}

describe('已付款族钱撤干净直接取消 · 真 DB', () => {
  it('录到账 → 直接取消被拒 → 撤销到账 → 下拉出现「已取消」→ 不带强制取消成功', async () => {
    const staff = await staffActor();
    const order = await createOrder();

    // 1. 录全款到账：订单自动推到已支付（→PAID 钩子建签证履约任务）
    const confirmed = await payments.confirmManualPayment(
      order.id,
      { amount: 1000, method: PaymentMethod.WECHAT_PAY },
      staff,
    );
    const paymentId = confirmed.paymentId as string;
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paid.status).toBe(OrderStatus.PAID);

    // 2. 钱还在单上：详情不给「已取消」，直接取消被拒并点明还剩多少钱
    expect(await allowedOf(order.id, staff)).not.toContain(OrderStatus.CANCELLED);
    await expect(
      orders.updateStatus(order.id, OrderStatus.CANCELLED, staff, '想直接取消'),
    ).rejects.toThrow(/净收款 ¥1000\.00/u);

    // 3. 撤销到账（本人录入、财务未核实 → 运营可自撤）：钱回 0，状态刻意不动
    await payments.reverseManualPayment(paymentId, { reason: '录错单' }, staff);
    const reversed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(reversed.paidAmount)).toBe(0);
    expect(reversed.status).toBe(OrderStatus.PAID);

    // 4. 详情与列表都下发「已取消」
    expect(await allowedOf(order.id, staff)).toContain(OrderStatus.CANCELLED);
    const list = await orders.listOrders({ page: 1, pageSize: 50 } as Parameters<OrderService['listOrders']>[0], staff);
    const row = (list.orders as Array<{ id: string; allowedTransitions: string[] }>).find((o) => o.id === order.id);
    expect(row?.allowedTransitions).toContain(OrderStatus.CANCELLED);

    // 5. 不带强制取消成功，副作用走既有取消路径
    const cancelled = await orders.updateStatus(order.id, OrderStatus.CANCELLED, staff, '到账已撤销，客人不走了');
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    const event = await prisma.orderStatusEvent.findFirst({
      where: { orderId: order.id, toStatus: OrderStatus.CANCELLED },
    });
    expect(event?.fromStatus).toBe(OrderStatus.PAID);
    const openTasks = await prisma.fulfillmentTask.count({
      where: {
        orderItem: { orderId: order.id },
        status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS] },
      },
    });
    expect(openTasks).toBe(0);

    // 6. 恢复：钱已撤光 → 回待支付（不是已支付），重新收款后再走 →PAID 钩子
    const restored = await orders.restoreCancelledOrder(
      order.id,
      { requestToken: randomUUID(), allowOversell: false, allowFlownLegs: false },
      staff,
    );
    expect(restored.audit.toStatus).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('有进行中的退款申请 → 拒，且详情不给「已取消」', async () => {
    const staff = await staffActor();
    const order = await createOrder({ status: OrderStatus.PAID, paidAmount: 0 });
    await prisma.refund.create({
      data: { orderId: order.id, amount: new Prisma.Decimal(0), status: RefundStatus.REQUESTED },
    });

    expect(await allowedOf(order.id, staff)).not.toContain(OrderStatus.CANCELLED);
    await expect(
      orders.updateStatus(order.id, OrderStatus.CANCELLED, staff, '想直接取消'),
    ).rejects.toThrow(/进行中的退款申请/u);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe(OrderStatus.PAID);
  });

  it('代理余额抵扣未退回（paidAmount 已为 0）→ 拒', async () => {
    const staff = await staffActor();
    const agentUser = await prisma.user.create({
      data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT },
    });
    const agent = await prisma.agent.create({
      data: { userId: agentUser.id, contactName: '测试代理', contactPhone: '13800138000' },
    });
    const order = await createOrder({ status: OrderStatus.PAID, paidAmount: 0, agentId: agent.id });
    await prisma.prepaymentTransaction.create({
      data: {
        agentId: agent.id,
        amount: new Prisma.Decimal(-300),
        balanceAfter: new Prisma.Decimal(0),
        type: PrepaymentTxType.OFFSET,
        orderId: order.id,
        createdById: staff.userId,
      },
    });

    expect(await allowedOf(order.id, staff)).not.toContain(OrderStatus.CANCELLED);
    await expect(
      orders.updateStatus(order.id, OrderStatus.CANCELLED, staff, '想直接取消'),
    ).rejects.toThrow(/预存余额抵扣的 ¥300\.00 尚未退回/u);
  });
});
