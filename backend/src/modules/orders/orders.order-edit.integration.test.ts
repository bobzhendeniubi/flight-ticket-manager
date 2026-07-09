/**
 * OrderService 售后改单（改期 / 换人 / 售后费用）· 真 DB 集成测试
 *
 * 覆盖：
 *   - 改期：座位从旧班次搬到新班次（旧 sold−1、新 sold+1）+ 改期费进 adjustmentCny + 尾款反映
 *   - 改期到「售罄」新班次 → 抛错 AND 旧座保持原样（无泄漏、无超售）
 *   - 换人：身份字段更新 + resetInvoice→NONE + resetVisa→VISA 任务 PENDING + 换人费
 *   - 非 ADMIN/STAFF 调用被拒（ForbiddenError）
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import {
  CabinClass,
  FulfillmentStatus,
  FulfillmentType,
  InvoiceStatus,
  OrderItemKind,
  OrderStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from './orders.service.js';

const service = new OrderService();

// ── Fixtures ───────────────────────────────────────────────────────────────
function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createUser(role: UserRole = UserRole.CUSTOMER) {
  return prisma.user.create({
    data: { email: `${uniq('u')}@test.com`, role },
  });
}

/** 建一个班次（含一个舱位的 FlightSeatClass，capacity/sold 可指定）。 */
async function createScheduleWithSeats(opts: {
  cabin?: CabinClass;
  capacity?: number;
  sold?: number;
  departureHoursFromNow?: number;
}) {
  const cabin = opts.cabin ?? CabinClass.ECONOMY;
  const capacity = opts.capacity ?? 50;
  const sold = opts.sold ?? 0;
  const departureTime = new Date(Date.now() + (opts.departureHoursFromNow ?? 200) * 3600 * 1000);

  const flight = await prisma.flight.create({
    data: {
      flightNumber: `T${Math.floor(Math.random() * 100000)}`,
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
        create: [{ cabin, capacity, sold, basePrice: new Prisma.Decimal(1000) }],
      },
    },
    include: { seatClasses: true },
  });
  return { flight, schedule, seatClass: schedule.seatClasses[0] };
}

/** 建一个 PAID 订单，含 1 个 FLIGHT 行（quantity=1）落在给定班次/舱位。 */
async function createPaidFlightOrder(opts: {
  scheduleId: string;
  cabin: CabinClass;
  userId?: string;
  total?: number;
  paidAmount?: number;
}) {
  const total = opts.total ?? 1000;
  const paidAmount = opts.paidAmount ?? 1000;
  return prisma.order.create({
    data: {
      orderNumber: uniq('ORD'),
      userId: opts.userId ?? null,
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(paidAmount),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.FLIGHT,
            description: 'TEST MFM→DAD',
            quantity: 1,
            unitPrice: new Prisma.Decimal(total),
            amount: new Prisma.Decimal(total),
            flightScheduleId: opts.scheduleId,
            flightCabin: opts.cabin,
          },
        ],
      },
      passengers: {
        create: [
          {
            fullName: 'WANG XIAO',
            lastName: 'WANG',
            firstName: 'XIAO',
            documentType: 'PASSPORT',
            documentNumber: uniq('P'),
            dateOfBirth: new Date('1990-01-01'),
            nationality: 'CHN',
          },
        ],
      },
    },
    include: { items: true, passengers: true },
  });
}

async function adminActor() {
  const admin = await createUser(UserRole.ADMIN);
  return { userId: admin.id, role: UserRole.ADMIN as const };
}

async function soldCount(scheduleId: string, cabin: CabinClass): Promise<number> {
  const sc = await prisma.flightSeatClass.findFirstOrThrow({ where: { scheduleId, cabin } });
  return sc.sold;
}

// ══════════════════════════════════════════════════════════════════════════
// 改期
// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.rescheduleOrderItem · 真 DB E2E', () => {
  it('改期搬座位：旧 sold−1、新 sold+1 + 改期费进 adjustmentCny + 尾款反映', async () => {
    const actor = await adminActor();
    const from = await createScheduleWithSeats({ cabin: CabinClass.ECONOMY, capacity: 50, sold: 1 });
    const to = await createScheduleWithSeats({ cabin: CabinClass.ECONOMY, capacity: 50, sold: 0 });
    const order = await createPaidFlightOrder({
      scheduleId: from.schedule.id,
      cabin: CabinClass.ECONOMY,
      total: 1000,
      paidAmount: 1000,
    });

    const result = await service.rescheduleOrderItem(
      order.id,
      {
        orderItemId: order.items[0].id,
        newScheduleId: to.schedule.id,
        feeCny: 300,
        feeLabel: '改期费',
        note: '客户改期到次日',
      },
      actor,
    );

    // 座位搬移
    expect(await soldCount(from.schedule.id, CabinClass.ECONOMY)).toBe(0); // 旧 1 → 0
    expect(await soldCount(to.schedule.id, CabinClass.ECONOMY)).toBe(1); // 新 0 → 1

    // 订单行已指向新班次
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
    expect(item.flightScheduleId).toBe(to.schedule.id);
    // 机票基础价不重算
    expect(Number(item.amount)).toBe(1000);

    // 航变标记：换班次后该行 metadata 落 flightChanged（后台代理 + 前台直客据此标红）
    const changedMeta = (item.metadata as { flightChanged?: Record<string, unknown> } | null)
      ?.flightChanged;
    expect(changedMeta).toBeTruthy();
    expect(changedMeta?.fromScheduleId).toBe(from.schedule.id);
    expect(changedMeta?.toScheduleId).toBe(to.schedule.id);
    expect(typeof changedMeta?.at).toBe('string');
    // 序列化后的订单行也应随行下发该标记（前端从这里读）
    const serializedItem = result.order.items.find((it) => it.id === order.items[0].id);
    expect(
      (serializedItem?.metadata as { flightChanged?: unknown } | null)?.flightChanged,
    ).toBeTruthy();

    // 改期费 → adjustmentCny + adjustments 流水
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(300);
    const log = reloaded.adjustments as Array<{ type: string; amountCny: number }>;
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe('RESCHEDULE_FEE');
    expect(log[0].amountCny).toBe(300);

    // 尾款口径：effectivePayable = 1000 + 300；balanceDue = 1300 − 1000 = 300
    expect(result.order.effectivePayable).toBe('1300');
    expect(result.order.balanceDue).toBe('300');
    expect(result.order.adjustmentCny).toBe(300);
  });

  it('改期到「售罄」新班次 → 抛错 AND 旧座保持原样（无泄漏、无超售）', async () => {
    const actor = await adminActor();
    const from = await createScheduleWithSeats({ cabin: CabinClass.ECONOMY, capacity: 50, sold: 1 });
    // 新班次满舱（capacity=sold）→ 拿座必失败
    const to = await createScheduleWithSeats({ cabin: CabinClass.ECONOMY, capacity: 5, sold: 5 });
    const order = await createPaidFlightOrder({
      scheduleId: from.schedule.id,
      cabin: CabinClass.ECONOMY,
    });

    await expect(
      service.rescheduleOrderItem(
        order.id,
        { orderItemId: order.items[0].id, newScheduleId: to.schedule.id, feeCny: 300 },
        actor,
      ),
    ).rejects.toThrow();

    // 关键：旧座没被放掉（事务回滚），新座没被占（无超售）
    expect(await soldCount(from.schedule.id, CabinClass.ECONOMY)).toBe(1); // 旧仍 1
    expect(await soldCount(to.schedule.id, CabinClass.ECONOMY)).toBe(5); // 新仍 5（满）

    // 订单行仍指向旧班次；adjustmentCny 未动（费用也回滚）
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
    expect(item.flightScheduleId).toBe(from.schedule.id);
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(0);
  });

  it('非 ADMIN/STAFF 调用改期 → 拒绝', async () => {
    const agent = await createUser(UserRole.AGENT);
    const from = await createScheduleWithSeats({ sold: 1 });
    const to = await createScheduleWithSeats({ sold: 0 });
    const order = await createPaidFlightOrder({
      scheduleId: from.schedule.id,
      cabin: CabinClass.ECONOMY,
    });
    await expect(
      service.rescheduleOrderItem(
        order.id,
        { orderItemId: order.items[0].id, newScheduleId: to.schedule.id },
        { userId: agent.id, role: UserRole.AGENT },
      ),
    ).rejects.toThrow(/仅运营\/管理员/);
  });

  it('非 FLIGHT 行改期 → 拒绝（400）', async () => {
    const actor = await adminActor();
    const to = await createScheduleWithSeats({ sold: 0 });
    const order = await prisma.order.create({
      data: {
        orderNumber: uniq('ORD'),
        status: OrderStatus.PAID,
        subtotal: new Prisma.Decimal(500),
        total: new Prisma.Decimal(500),
        paidAmount: new Prisma.Decimal(500),
        contactName: 'X',
        contactPhone: '1',
        items: {
          create: [
            {
              kind: OrderItemKind.VISA,
              description: '签证',
              quantity: 1,
              unitPrice: new Prisma.Decimal(500),
              amount: new Prisma.Decimal(500),
            },
          ],
        },
      },
      include: { items: true },
    });
    await expect(
      service.rescheduleOrderItem(
        order.id,
        { orderItemId: order.items[0].id, newScheduleId: to.schedule.id },
        actor,
      ),
    ).rejects.toThrow(/只能对机票行/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 换人
// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.swapPassenger · 真 DB E2E', () => {
  it('换人：身份更新 + resetInvoice→NONE + resetVisa→任务 PENDING + 换人费', async () => {
    const actor = await adminActor();
    const from = await createScheduleWithSeats({ sold: 1 });
    const order = await createPaidFlightOrder({
      scheduleId: from.schedule.id,
      cabin: CabinClass.ECONOMY,
      total: 1000,
      paidAmount: 1000,
    });
    // 预置：开票=ISSUED + 一个 CONFIRMED 的 VISA 履约任务（挂在订单项上）
    await prisma.order.update({
      where: { id: order.id },
      data: { invoiceStatus: InvoiceStatus.ISSUED },
    });
    const visaTask = await prisma.fulfillmentTask.create({
      data: {
        orderItemId: order.items[0].id,
        type: FulfillmentType.VISA_APPLICATION,
        status: FulfillmentStatus.CONFIRMED,
        completedAt: new Date(),
      },
    });

    const result = await service.swapPassenger(
      order.id,
      order.passengers[0].id,
      {
        fullName: 'LI MING',
        documentNumber: 'E99999999',
        nationality: 'CHN',
        resetInvoice: true,
        resetVisa: true,
        feeCny: 200,
        feeLabel: '换人费',
      },
      actor,
    );

    // 身份更新（含自动拆姓/名）
    const px = await prisma.passenger.findUniqueOrThrow({ where: { id: order.passengers[0].id } });
    expect(px.fullName).toBe('LI MING');
    expect(px.lastName).toBe('LI');
    expect(px.firstName).toBe('MING');
    expect(px.documentNumber).toBe('E99999999');

    // resetInvoice → NONE
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.invoiceStatus).toBe(InvoiceStatus.NONE);

    // resetVisa → VISA 任务回 PENDING（completedAt 清空）
    const task = await prisma.fulfillmentTask.findUniqueOrThrow({ where: { id: visaTask.id } });
    expect(task.status).toBe(FulfillmentStatus.PENDING);
    expect(task.completedAt).toBeNull();

    // 换人费 → adjustmentCny + 流水 SWAP_FEE
    expect(reloaded.adjustmentCny).toBe(200);
    const log = reloaded.adjustments as Array<{ type: string; amountCny: number }>;
    expect(log[0].type).toBe('SWAP_FEE');
    expect(log[0].amountCny).toBe(200);

    // 审计明细 + 尾款口径
    expect(result.audit.before.fullName).toBe('WANG XIAO');
    expect(result.audit.after.fullName).toBe('LI MING');
    expect(result.audit.visaTasksReset).toBe(1);
    expect(result.order.balanceDue).toBe('200'); // 1000+200−1000
  });

  it('换人无 resetInvoice/resetVisa → 开票/签证状态不变', async () => {
    const actor = await adminActor();
    const from = await createScheduleWithSeats({ sold: 1 });
    const order = await createPaidFlightOrder({
      scheduleId: from.schedule.id,
      cabin: CabinClass.ECONOMY,
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { invoiceStatus: InvoiceStatus.ISSUED },
    });

    await service.swapPassenger(order.id, order.passengers[0].id, { fullName: 'ZHAO LEI' }, actor);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.invoiceStatus).toBe(InvoiceStatus.ISSUED); // 未重置
    expect(reloaded.adjustmentCny).toBe(0); // 无费用
  });

  it('非 ADMIN/STAFF 调用换人 → 拒绝', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const from = await createScheduleWithSeats({ sold: 1 });
    const order = await createPaidFlightOrder({
      scheduleId: from.schedule.id,
      cabin: CabinClass.ECONOMY,
      userId: customer.id,
    });
    await expect(
      service.swapPassenger(
        order.id,
        order.passengers[0].id,
        { fullName: 'HACK ATTEMPT' },
        { userId: customer.id, role: UserRole.CUSTOMER },
      ),
    ).rejects.toThrow(/仅运营\/管理员/);
  });
});
