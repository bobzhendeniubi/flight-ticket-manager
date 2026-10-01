/**
 * OrderService.markSwapped（标记已换人）· 真 DB 集成测试
 *
 * 真 postgres + 真 prisma migrate + 真 transaction，覆盖换人主路径的钱与座位：
 *   - 代理单：净收 5154、换人费 1650 → 调价行 −3504 把应收收敛到 1650，多出 3504 存入代理余额，
 *     订单回压到恰好结清（已收 1650），未飞航段释放、已飞航段不退座，佣金整单冲销；
 *   - 直客单：多出的钱转挂账池（OPEN 进账，来源 ORDER_OVERPAY）；
 *   - 欠款：净收 < 换人费 → 不动钱，欠款留在单上；
 *   - 有进行中退款 → 409；代理 → 403；直接改状态到 SWAPPED（admin force）→ 400。
 *
 * 跑：export TEST_DATABASE_URL=… && npx vitest run -c vitest.integration.config.ts src/modules/orders/orders.mark-swapped.integration.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  CommissionStatus,
  FulfillmentStatus,
  FulfillmentType,
  OrderItemKind,
  OrderStatus,
  PaymentStatus,
  PrepaymentTxType,
  Prisma,
  ProductKind,
  ReceiptSource,
  ReceiptStatus,
  RefundStatus,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, ForbiddenError } from '../../lib/errors.js';
import { OrderService } from './orders.service.js';

// ── Fixture helpers ──────────────────────────────────────────────────────
async function createUser(role: UserRole) {
  return prisma.user.create({
    data: {
      email: `mark-swapped-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`,
      role,
    },
  });
}

async function createAgent() {
  const agentUser = await createUser(UserRole.AGENT);
  const agent = await prisma.agent.create({
    data: { userId: agentUser.id, contactName: '测试代理', contactPhone: '13800138001' },
  });
  return { agentUser, agent };
}

/** 一条航段：班次 + 经济舱座位账（sold=1 表示本单占着 1 座）。 */
async function createLeg(departureOffsetHours: number) {
  const departureTime = new Date(Date.now() + departureOffsetHours * 3600 * 1000);
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `SW${Math.floor(Math.random() * 100000)}`,
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
  return { flight, schedule, seatClass };
}

/**
 * 已支付订单：去程已飞（−48h）、回程未飞（+100h），各占 1 座；total/paidAmount 由调用方给。
 */
async function createPaidOrder(input: {
  userId: string;
  agentId?: string;
  totalCny: number;
  paidCny: number;
  status?: OrderStatus;
  /** 落库的 Order.total（默认 = 明细行合计 totalCny）；传一个不同的值模拟 total 与明细行脱节的脏单。 */
  storedTotalCny?: number;
}) {
  const flown = await createLeg(-48);
  const upcoming = await createLeg(100);
  const half = input.totalCny / 2;
  const storedTotal = input.storedTotalCny ?? input.totalCny;
  const order = await prisma.order.create({
    data: {
      orderNumber: `TEST-MS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      userId: input.userId,
      agentId: input.agentId,
      status: input.status ?? OrderStatus.PAID,
      subtotal: new Prisma.Decimal(storedTotal),
      total: new Prisma.Decimal(storedTotal),
      paidAmount: new Prisma.Decimal(input.paidCny),
      contactName: '原订单客户',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.FLIGHT,
            description: `${flown.flight.flightNumber} 去程（已飞）`,
            quantity: 1,
            unitPrice: new Prisma.Decimal(half),
            amount: new Prisma.Decimal(half),
            flightScheduleId: flown.schedule.id,
            flightCabin: 'ECONOMY',
          },
          {
            kind: OrderItemKind.FLIGHT,
            description: `${upcoming.flight.flightNumber} 回程（未飞）`,
            quantity: 1,
            unitPrice: new Prisma.Decimal(half),
            amount: new Prisma.Decimal(half),
            flightScheduleId: upcoming.schedule.id,
            flightCabin: 'ECONOMY',
          },
        ],
      },
    },
    include: { items: true },
  });
  if (input.paidCny > 0) {
    await prisma.payment.create({
      data: {
        orderId: order.id,
        method: 'BANK_CARD',
        amount: new Prisma.Decimal(input.paidCny),
        status: PaymentStatus.SUCCEEDED,
        paidAt: new Date(),
      },
    });
  }
  return { order, flown, upcoming };
}

// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.markSwapped · 真 DB E2E', () => {
  const service = new OrderService();

  it('代理单：已收 5154、换人费 1650 → 代理余额 +3504、应收/已收都是 1650、已换人、未飞放座已飞不放、佣金冲销', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const admin = await createUser(UserRole.ADMIN);
    const { agent } = await createAgent();
    const { order, flown, upcoming } = await createPaidOrder({
      userId: customer.id,
      agentId: agent.id,
      totalCny: 5154,
      paidCny: 5154,
    });
    const commission = await prisma.commissionRecord.create({
      data: {
        agentId: agent.id,
        orderId: order.id,
        productKind: ProductKind.FLIGHT,
        baseAmount: new Prisma.Decimal(5154),
        rate: new Prisma.Decimal('0.0500'),
        amount: new Prisma.Decimal(257.7),
        status: CommissionStatus.ACCRUED,
        chainDepth: 0,
      },
    });
    // 一条挂在未飞航段上的履约任务：换人后应同取消口径终态化。
    const task = await prisma.fulfillmentTask.create({
      data: {
        orderItemId: order.items[1].id,
        type: FulfillmentType.FLIGHT_TICKETING,
        status: FulfillmentStatus.PENDING,
      },
    });
    const replacement = await prisma.order.create({
      data: {
        orderNumber: `TEST-MS-NEW-${Date.now()}`,
        userId: customer.id,
        status: OrderStatus.PENDING_PAYMENT,
        subtotal: new Prisma.Decimal(5154),
        total: new Prisma.Decimal(5154),
        contactName: '接手客户',
        contactPhone: '13800138002',
      },
    });

    const result = await service.markSwapped(
      order.id,
      { swapFeeCny: 1650, replacementOrderNumber: replacement.orderNumber, note: '位子让给同行' },
      { userId: admin.id, role: UserRole.ADMIN },
    );

    // 响应审计：钱的三个数 + 去向 + 航段去向。
    expect(result.audit).toMatchObject({
      fromStatus: OrderStatus.PAID,
      swapFeeCny: 1650,
      beforePayableCny: 5154,
      netPaidCny: 5154,
      adjustmentDeltaCny: -3504,
      outstandingCny: 0,
      replacementOrderNumber: replacement.orderNumber,
    });
    expect(result.audit.disposal).toMatchObject({ kind: 'AGENT_BALANCE', amountCny: 3504, agentId: agent.id, agentBalanceAfter: 3504 });
    expect(result.audit.flownLegs.map((l) => l.itemId)).toEqual([order.items[0].id]);
    expect(result.audit.releasedLegs.map((l) => l.itemId)).toEqual([order.items[1].id]);
    expect(result.order.status).toBe(OrderStatus.SWAPPED);

    const reloaded = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, statusEvents: true, payments: true },
    });
    expect(reloaded.status).toBe(OrderStatus.SWAPPED);
    // 应收收敛到换人费：调价行 −3504 进了 total；已收回压到恰好结清。
    expect(Number(reloaded.total)).toBe(1650);
    expect(Number(reloaded.paidAmount)).toBe(1650);
    const feeRow = reloaded.items.find(
      (it) => (it.metadata as { reasonCode?: string } | null)?.reasonCode === 'SWAP_FEE',
    );
    expect(feeRow).toBeDefined();
    expect(Number(feeRow!.amount)).toBe(-3504);
    // 换人标记：复用两列；swapRefundedAt（退过现金）不写。
    expect(reloaded.swapFeeCny).toBe(1650);
    expect(reloaded.swapReplacementOrderNumber).toBe(replacement.orderNumber);
    expect(reloaded.swapRefundedAt).toBeNull();
    expect(reloaded.internalNotes).toContain('【已换人】');
    expect(reloaded.internalNotes).toContain('多出 ¥3504 已存入代理余额');
    expect(reloaded.statusEvents.some((e) => e.fromStatus === OrderStatus.PAID && e.toStatus === OrderStatus.SWAPPED)).toBe(true);
    // 多付转存的对冲行（负额 Payment）：台账与 paidAmount 同口径，订单再进 PAID 不会把 3504 灌回。
    expect(reloaded.payments.some((p) => Number(p.amount) === -3504)).toBe(true);

    // 代理余额 +3504，流水 TOP_UP。
    const agentAfter = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(Number(agentAfter.prepaymentBalance)).toBe(3504);
    const topUp = await prisma.prepaymentTransaction.findFirst({ where: { orderId: order.id, type: PrepaymentTxType.TOP_UP } });
    expect(topUp).not.toBeNull();
    expect(Number(topUp!.amount)).toBe(3504);

    // 座位：未飞航段释放（1→0）、已飞航段不退（仍 1）。
    const upcomingSeat = await prisma.flightSeatClass.findUniqueOrThrow({ where: { id: upcoming.seatClass.id } });
    const flownSeat = await prisma.flightSeatClass.findUniqueOrThrow({ where: { id: flown.seatClass.id } });
    expect(upcomingSeat.sold).toBe(0);
    expect(flownSeat.sold).toBe(1);

    // 佣金整单冲销（换人费不计佣）；履约任务终态化。
    const commissionAfter = await prisma.commissionRecord.findUniqueOrThrow({ where: { id: commission.id } });
    expect(commissionAfter.status).toBe(CommissionStatus.REVERSED);
    const taskAfter = await prisma.fulfillmentTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(taskAfter.status).toBe(FulfillmentStatus.CANCELLED);

    // 接手单一分钱都没动。
    const replacementAfter = await prisma.order.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(Number(replacementAfter.paidAmount)).toBe(0);
  });

  it('total 与明细行脱节（total 5000、明细 5154）：差额按明细行算，落库应收恰好 = 换人费，多付只转 3504', async () => {
    // 旧实现按 total 算差额（1650 − 5000 = −3350），内核却按 Σ 明细行重算 total → 1804 ≠ 1650，
    // 多出的 154 会被当成「应收」留在单上、代理余额只进 3350。现在以 Σ 明细行为基准，钱一分不错位。
    const customer = await createUser(UserRole.CUSTOMER);
    const staff = await createUser(UserRole.STAFF);
    const { agent } = await createAgent();
    const { order } = await createPaidOrder({
      userId: customer.id,
      agentId: agent.id,
      totalCny: 5154,
      storedTotalCny: 5000,
      paidCny: 5154,
    });

    const result = await service.markSwapped(order.id, { swapFeeCny: 1650 }, { userId: staff.id, role: UserRole.STAFF });

    expect(result.audit).toMatchObject({ beforePayableCny: 5154, adjustmentDeltaCny: -3504, outstandingCny: 0 });
    expect(result.audit.disposal).toMatchObject({ kind: 'AGENT_BALANCE', amountCny: 3504 });
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(Number(reloaded.total)).toBe(1650);
    expect(Number(reloaded.paidAmount)).toBe(1650);
    const feeRow = reloaded.items.find(
      (it) => (it.metadata as { reasonCode?: string } | null)?.reasonCode === 'SWAP_FEE',
    );
    expect(Number(feeRow!.amount)).toBe(-3504);
    const agentAfter = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(Number(agentAfter.prepaymentBalance)).toBe(3504);
  });

  it('差额为 0 但 total 与明细行脱节：没有差额行去重算 total → 409 整单回滚，订单原样不动', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const staff = await createUser(UserRole.STAFF);
    const { order, upcoming } = await createPaidOrder({ userId: customer.id, totalCny: 1650, storedTotalCny: 1500, paidCny: 1650 });

    await expect(
      service.markSwapped(order.id, { swapFeeCny: 1650 }, { userId: staff.id, role: UserRole.STAFF }),
    ).rejects.toBeInstanceOf(ConflictError);
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe(OrderStatus.PAID);
    expect(Number(reloaded.total)).toBe(1500);
    expect(Number(reloaded.paidAmount)).toBe(1650);
    const seat = await prisma.flightSeatClass.findUniqueOrThrow({ where: { id: upcoming.seatClass.id } });
    expect(seat.sold).toBe(1);
  });

  it('直客单（没填接手单号）：已收 1000、换人费 450 → 多出 550 转挂账池；进账不指回原单，备注说明认领去向', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const staff = await createUser(UserRole.STAFF);
    const { order } = await createPaidOrder({ userId: customer.id, totalCny: 1000, paidCny: 1000 });

    const result = await service.markSwapped(order.id, { swapFeeCny: 450 }, { userId: staff.id, role: UserRole.STAFF });

    expect(result.audit.disposal?.kind).toBe('RECEIPT_POOL');
    expect(result.audit.disposal?.amountCny).toBe(550);
    const receiptId = (result.audit.disposal as { receiptId: string }).receiptId;
    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(receipt.status).toBe(ReceiptStatus.OPEN);
    expect(receipt.source).toBe(ReceiptSource.ORDER_OVERPAY);
    expect(Number(receipt.amountCny)).toBe(550);
    // 不设 orderHintId 指回原单：订单详情 / 对账台的「认领到本单」提示按它找，指回会把钱认回已换人单。
    expect(receipt.orderHintId).toBeNull();
    expect(receipt.payerNote).toContain(order.orderNumber);
    expect(receipt.payerNote).toMatch(/已换人多付，请认领到接手的新单/);
    expect(await prisma.receipt.count({ where: { orderHintId: order.id } })).toBe(0);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe(OrderStatus.SWAPPED);
    expect(Number(reloaded.total)).toBe(450);
    expect(Number(reloaded.paidAmount)).toBe(450);
    expect(reloaded.swapFeeCny).toBe(450);
  });

  it('直客单（填了接手单号）：挂账进账的疑似归属指向接手新单，新单详情据此提示认领', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const staff = await createUser(UserRole.STAFF);
    const { order } = await createPaidOrder({ userId: customer.id, totalCny: 1000, paidCny: 1000 });
    const replacement = await prisma.order.create({
      data: {
        orderNumber: `TEST-MS-NEW-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        userId: customer.id,
        status: OrderStatus.PENDING_PAYMENT,
        subtotal: new Prisma.Decimal(1000),
        total: new Prisma.Decimal(1000),
        contactName: '接手客户',
        contactPhone: '13800138002',
      },
    });

    const result = await service.markSwapped(
      order.id,
      { swapFeeCny: 450, replacementOrderNumber: replacement.orderNumber },
      { userId: staff.id, role: UserRole.STAFF },
    );

    const receiptId = (result.audit.disposal as { receiptId: string }).receiptId;
    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(receipt.orderHintId).toBe(replacement.id);
    expect(receipt.payerNote).toContain(`请认领到接手订单 ${replacement.orderNumber}`);
    expect(await prisma.receipt.count({ where: { orderHintId: order.id } })).toBe(0);
    // 钱只是挂在池里等认领：接手单一分没动。
    const replacementAfter = await prisma.order.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(Number(replacementAfter.paidAmount)).toBe(0);
  });

  it('欠款：已收 1000、换人费 1650 → 不动钱，应收 1650 已收 1000，欠 650 留在单上', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const { agent } = await createAgent();
    const staff = await createUser(UserRole.STAFF);
    const { order } = await createPaidOrder({ userId: customer.id, agentId: agent.id, totalCny: 1000, paidCny: 1000 });

    const result = await service.markSwapped(order.id, { swapFeeCny: 1650 }, { userId: staff.id, role: UserRole.STAFF });

    expect(result.audit.disposal).toBeNull();
    expect(result.audit.outstandingCny).toBe(650);
    expect(result.audit.adjustmentDeltaCny).toBe(650);
    expect(result.order.balanceDue).toBe('650');
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe(OrderStatus.SWAPPED);
    expect(Number(reloaded.total)).toBe(1650);
    expect(Number(reloaded.paidAmount)).toBe(1000);
    const agentAfter = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(Number(agentAfter.prepaymentBalance)).toBe(0);
    expect(await prisma.prepaymentTransaction.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('换人费 0（一分不收）：全部已收转存，应收 0', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const { agent } = await createAgent();
    const staff = await createUser(UserRole.STAFF);
    const { order } = await createPaidOrder({ userId: customer.id, agentId: agent.id, totalCny: 800, paidCny: 800 });

    const result = await service.markSwapped(order.id, { swapFeeCny: 0 }, { userId: staff.id, role: UserRole.STAFF });
    expect(result.audit.disposal).toMatchObject({ kind: 'AGENT_BALANCE', amountCny: 800 });
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(reloaded.total)).toBe(0);
    expect(Number(reloaded.paidAmount)).toBe(0);
    expect(reloaded.swapFeeCny).toBe(0);
  });

  it('有进行中的退款申请 → 409，订单原样不动', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const staff = await createUser(UserRole.STAFF);
    const { order, upcoming } = await createPaidOrder({ userId: customer.id, totalCny: 1000, paidCny: 1000 });
    await prisma.refund.create({
      data: { orderId: order.id, amount: new Prisma.Decimal(300), reason: '客人申请', status: RefundStatus.REQUESTED },
    });

    await expect(
      service.markSwapped(order.id, { swapFeeCny: 450 }, { userId: staff.id, role: UserRole.STAFF }),
    ).rejects.toBeInstanceOf(ConflictError);
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe(OrderStatus.PAID);
    expect(Number(reloaded.total)).toBe(1000);
    const seat = await prisma.flightSeatClass.findUniqueOrThrow({ where: { id: upcoming.seatClass.id } });
    expect(seat.sold).toBe(1);
  });

  it('代理 → 403；直接改状态到已换人（admin force）→ 400 账目闸', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const admin = await createUser(UserRole.ADMIN);
    const { agentUser, agent } = await createAgent();
    const { order } = await createPaidOrder({ userId: customer.id, agentId: agent.id, totalCny: 1000, paidCny: 1000 });

    await expect(
      service.markSwapped(order.id, { swapFeeCny: 450 }, { userId: agentUser.id, role: UserRole.AGENT, agentId: agent.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      service.updateStatus(order.id, OrderStatus.SWAPPED, { userId: admin.id, role: UserRole.ADMIN }, '硬翻', true),
    ).rejects.toBeInstanceOf(BadRequestError);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe(OrderStatus.PAID);
  });
});
