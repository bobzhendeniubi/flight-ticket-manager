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
import {
  OrderService,
  releaseSeatFloored,
  computeBundleSeatSplit,
  createFulfillmentTasks,
} from './orders.service.js';

const service = new OrderService();

/**
 * 忠实复刻 queues/worker.ts 超时释放事务（FOR UPDATE 锁 Order 行 → 事务内读 items → 释放 → CAS
 * PAYMENT_TIMEOUT）。直接 import worker.ts 会在模块加载时 new Worker(...) 连 Redis，故此处内联复刻，
 * 用于验证「改期侧 FOR UPDATE」与超时侧共享同一把行锁、严格串行（R2）。
 */
async function simulateSeatHoldTimeout(orderId: string): Promise<'released' | 'skipped'> {
  let released = false;
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      Array<{ id: string; status: OrderStatus; paymentExpiresAt: Date | null }>
    >`SELECT id, status, "paymentExpiresAt" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const row = locked[0];
    if (!row) return;
    if (row.status !== OrderStatus.PENDING_PAYMENT) return;
    if (!row.paymentExpiresAt || row.paymentExpiresAt.getTime() > Date.now()) return;
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { kind: true, flightScheduleId: true, flightCabin: true, quantity: true, metadata: true },
    });
    for (const item of items) {
      if (item.kind !== OrderItemKind.FLIGHT || !item.flightScheduleId || !item.flightCabin) continue;
      const meta = (item.metadata ?? {}) as { businessUpgradeCount?: unknown };
      const rawUpgrade = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;
      const split = computeBundleSeatSplit(item.flightCabin, item.quantity, rawUpgrade);
      await releaseSeatFloored(tx, item.flightScheduleId, CabinClass.BUSINESS, split.business);
      await releaseSeatFloored(tx, item.flightScheduleId, item.flightCabin, split.sameCabin);
    }
    const upd = await tx.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.PAYMENT_TIMEOUT },
    });
    if (upd.count === 0) throw new Error('ORDER_STATUS_CHANGED_DURING_EXPIRY');
    released = true;
  });
  return released ? 'released' : 'skipped';
}

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

/** 建一个 PENDING_PAYMENT 散客单（paymentExpiresAt 可设为过去 → 超时 worker 会释放机位），含 1 个 FLIGHT 行。 */
async function createPendingFlightOrder(opts: {
  scheduleId: string;
  cabin: CabinClass;
  expired?: boolean;
  total?: number;
}) {
  const total = opts.total ?? 1000;
  return prisma.order.create({
    data: {
      orderNumber: uniq('ORD'),
      status: OrderStatus.PENDING_PAYMENT,
      // 前台散客单：过期时间；expired=true → 设为过去（超时释放条件成立）。
      paymentExpiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 30 * 60_000)),
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(0),
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

/**
 * 建一个含自备签减免的 BUNDLE 订单（BUNDLE 行 metadata.addOns 记 selfProvidedVisaCount/selfVisaDeductCny），
 * 出行人 visaExempt 可设。用于验证换人价回滚（true→false 撤销自备签减免）。
 * 不含 FLIGHT 行 → 换人时跳过基于班次的重复证件校验，聚焦价回滚逻辑。
 */
async function createBundleOrderWithSelfVisa(opts: {
  selfVisaDeductCny: number;
  visaExempt: boolean;
  total?: number;
}) {
  const total = opts.total ?? 5000;
  return prisma.order.create({
    data: {
      orderNumber: uniq('BND'),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(total),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.BUNDLE,
            description: '测试套餐',
            quantity: 1,
            unitPrice: new Prisma.Decimal(total),
            amount: new Prisma.Decimal(total),
            metadata: {
              addOns: {
                selfProvidedVisaCount: opts.visaExempt ? 1 : 0,
                selfVisaDeductCny: opts.selfVisaDeductCny,
              },
            },
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
            visaExempt: opts.visaExempt,
          },
        ],
      },
    },
    include: { items: true, passengers: true },
  });
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

  it('R2 改期 vs 超时释放并发 → Order 行 FOR UPDATE 串行：座位账一致（无旧舱双放 / 新舱幽灵持有）', async () => {
    const actor = await adminActor();
    const from = await createScheduleWithSeats({ cabin: CabinClass.ECONOMY, capacity: 50, sold: 1 });
    const to = await createScheduleWithSeats({ cabin: CabinClass.ECONOMY, capacity: 50, sold: 0 });
    // PENDING_PAYMENT 且已过期：超时 worker 会释放机位；同时该态占座、可改期。
    const order = await createPendingFlightOrder({
      scheduleId: from.schedule.id,
      cabin: CabinClass.ECONOMY,
      expired: true,
    });

    // 并发跑：改期（旧 from → 新 to）与超时释放。两者都对同一 Order 行 FOR UPDATE → 严格串行。
    // 用 allSettled：某一序（超时先提交）下改期会被占座守卫拒（PAYMENT_TIMEOUT 不可改期），属预期。
    const [reschedRes, timeoutRes] = await Promise.allSettled([
      service.rescheduleOrderItem(
        order.id,
        { orderItemId: order.items[0].id, newScheduleId: to.schedule.id },
        actor,
      ),
      simulateSeatHoldTimeout(order.id),
    ]);
    // 两个操作都已结束（各自 fulfilled/rejected，不 hang）
    expect(['fulfilled', 'rejected']).toContain(reschedRes.status);
    expect(['fulfilled', 'rejected']).toContain(timeoutRes.status);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const fromSold = await soldCount(from.schedule.id, CabinClass.ECONOMY);
    const toSold = await soldCount(to.schedule.id, CabinClass.ECONOMY);

    // 两种串行序都收敛到同一一致态（PENDING_PAYMENT→CHANGED 不在白名单，改期后仍 PENDING_PAYMENT，
    // 故不论谁先拿锁，最终订单都超时、其当前所持机位被恰好释放一次）：
    //   · 改期先提交：座搬到 to，随后超时读到最新 items 释放 to → from=0, to=0, PAYMENT_TIMEOUT。
    //   · 超时先提交：释放 from → PAYMENT_TIMEOUT，改期被守卫拒 → from=0, to=0, PAYMENT_TIMEOUT。
    expect(dbOrder.status).toBe(OrderStatus.PAYMENT_TIMEOUT);
    expect(fromSold).toBe(0); // 旧舱：恰好释放一次（无双放；floored 亦不为负）
    expect(toSold).toBe(0); // 新舱：无幽灵持有（超时单绝不留占座）
    // 不变量：无负库存、无净泄漏占座
    expect(fromSold + toSold).toBe(0);
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
        // P1-8：这些字段此前 swapPassengerBodySchema 未暴露（前端传不进来）；补齐后应透传落库。
        visaExempt: true,
        singleRoom: true,
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
    // P1-8：换人可显式带的乘客级属性（自备签 / 单住）落库
    expect(px.visaExempt).toBe(true);
    expect(px.singleRoom).toBe(true);

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

  // ── 换人价回滚（自备签 true→false 撤销自备签减免；null 审计发现）──────────────────
  it('换人 visaExempt true→false（证件变更强制随团办签）→ 撤销自备签减免、尾款回收', async () => {
    const actor = await adminActor();
    // 套餐单：出行人自备签（visaExempt=true），套餐每人自备签减免 500，订单已全额付清。
    const order = await createBundleOrderWithSelfVisa({ selfVisaDeductCny: 500, visaExempt: true, total: 5000 });

    const result = await service.swapPassenger(
      order.id,
      order.passengers[0].id,
      { fullName: 'LI MING', documentNumber: 'E77777777', nationality: 'CHN' },
      actor,
    );

    // 证件变更 → visaExempt 回落 false（新客进签证台随团办签）
    const px = await prisma.passenger.findUniqueOrThrow({ where: { id: order.passengers[0].id } });
    expect(px.visaExempt).toBe(false);

    // 撤销自备签减免：adjustmentCny += 500，adjustments 记一条 SWAP_VISA_DEDUCT_REVERSAL
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(500);
    const log = reloaded.adjustments as Array<{ type: string; amountCny: number }>;
    expect(log.some((e) => e.type === 'SWAP_VISA_DEDUCT_REVERSAL' && e.amountCny === 500)).toBe(true);

    // 钱回收：effectivePayable = 5000 + 500；balanceDue = 5500 − 5000 = 500（原本已付清，现应补 500）
    expect(result.order.effectivePayable).toBe('5500');
    expect(result.order.balanceDue).toBe('500');
  });

  it('换人 true→false 且带换人费 → 撤销减免 + 换人费合并进 adjustmentCny（两条流水、一次写）', async () => {
    const actor = await adminActor();
    const order = await createBundleOrderWithSelfVisa({ selfVisaDeductCny: 500, visaExempt: true, total: 5000 });

    await service.swapPassenger(
      order.id,
      order.passengers[0].id,
      { fullName: 'LI MING', documentNumber: 'E88888888', nationality: 'CHN', feeCny: 200, feeLabel: '换人费' },
      actor,
    );

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(700); // 500（撤销减免）+ 200（换人费）
    const log = reloaded.adjustments as Array<{ type: string; amountCny: number }>;
    expect(log.some((e) => e.type === 'SWAP_VISA_DEDUCT_REVERSAL' && e.amountCny === 500)).toBe(true);
    expect(log.some((e) => e.type === 'SWAP_FEE' && e.amountCny === 200)).toBe(true);
  });

  it('换人未改证件号（visaExempt 保持 true）→ 不撤销减免', async () => {
    const actor = await adminActor();
    const order = await createBundleOrderWithSelfVisa({ selfVisaDeductCny: 500, visaExempt: true, total: 5000 });

    // 仅改姓名（不改证件号）→ documentChanged=false，visaExempt 不动 → 不产生撤销减免。
    await service.swapPassenger(order.id, order.passengers[0].id, { fullName: 'WANG DA' }, actor);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(0);
    const px = await prisma.passenger.findUniqueOrThrow({ where: { id: order.passengers[0].id } });
    expect(px.visaExempt).toBe(true);
  });

  it('旧客本非自备签（visaExempt false）→ 换人不产生撤销减免', async () => {
    const actor = await adminActor();
    const order = await createBundleOrderWithSelfVisa({ selfVisaDeductCny: 500, visaExempt: false, total: 5000 });

    await service.swapPassenger(
      order.id,
      order.passengers[0].id,
      { fullName: 'LI MING', documentNumber: 'E99990000', nationality: 'CHN' },
      actor,
    );

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(0);
  });

  // ── A1：resetVisa 绝不复活 CANCELLED 履约任务（取消族终态化留下的记录）──────────────────
  it('resetVisa 只重置活动态（FAILED→PENDING），CANCELLED 任务保持终态不复活', async () => {
    const actor = await adminActor();
    const from = await createScheduleWithSeats({ sold: 1 });
    const order = await createPaidFlightOrder({ scheduleId: from.schedule.id, cabin: CabinClass.ECONOMY });

    // 预置两条 VISA 任务：一条 CANCELLED（取消族终态化留下），一条 FAILED（活动态、应被重置）。
    const cancelledTask = await prisma.fulfillmentTask.create({
      data: {
        orderItemId: order.items[0].id,
        type: FulfillmentType.VISA_APPLICATION,
        status: FulfillmentStatus.CANCELLED,
        completedAt: new Date(),
      },
    });
    const failedTask = await prisma.fulfillmentTask.create({
      data: {
        orderItemId: order.items[0].id,
        type: FulfillmentType.VISA_APPLICATION,
        status: FulfillmentStatus.FAILED,
        failureReason: '上次送签被拒',
      },
    });

    const result = await service.swapPassenger(
      order.id,
      order.passengers[0].id,
      { fullName: 'LI MING', documentNumber: 'E12312312', nationality: 'CHN', resetVisa: true },
      actor,
    );

    // FAILED → PENDING（重开送签），CANCELLED 保持不动（绝不复活）
    const failedAfter = await prisma.fulfillmentTask.findUniqueOrThrow({ where: { id: failedTask.id } });
    expect(failedAfter.status).toBe(FulfillmentStatus.PENDING);
    expect(failedAfter.failureReason).toBeNull();
    const cancelledAfter = await prisma.fulfillmentTask.findUniqueOrThrow({ where: { id: cancelledTask.id } });
    expect(cancelledAfter.status).toBe(FulfillmentStatus.CANCELLED); // 未被复活
    expect(result.audit.visaTasksReset).toBe(1); // 只重置了 FAILED 那一条
  });

  // ── SWAP：换人价回滚幂等（同一乘客的自备签减免只冲一次，多次换人不过冲）──────────────────
  it('多次换人 true→false：同一乘客的自备签减免只冲一次（幂等，不过冲多收）', async () => {
    const actor = await adminActor();
    const order = await createBundleOrderWithSelfVisa({ selfVisaDeductCny: 500, visaExempt: true, total: 5000 });
    const passengerId = order.passengers[0].id;

    // 换人 1：证件变更 → visaExempt true→false → 撤销减免 +500（记 passengerId）。
    await service.swapPassenger(
      order.id,
      passengerId,
      { fullName: 'LI MING', documentNumber: 'E55550001', nationality: 'CHN' },
      actor,
    );
    let reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(500);

    // 模拟该乘客又被改回自备签（false→true 不自动撤，业务上可能显式回填）。
    await prisma.passenger.update({ where: { id: passengerId }, data: { visaExempt: true } });

    // 换人 2：再次证件变更 → true→false 又命中撤销条件，但同一乘客已冲过 → 幂等跳过，不再 +500。
    await service.swapPassenger(
      order.id,
      passengerId,
      { fullName: 'ZHAO LEI', documentNumber: 'E55550002', nationality: 'CHN' },
      actor,
    );
    reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(500); // 仍是 500（未过冲成 1000）
    const log = reloaded.adjustments as Array<{ type: string; passengerId?: string }>;
    const reversals = log.filter((e) => e.type === 'SWAP_VISA_DEDUCT_REVERSAL');
    expect(reversals).toHaveLength(1); // 只冲一次
    expect(reversals[0].passengerId).toBe(passengerId); // 按乘客留痕
  });
});

// ══════════════════════════════════════════════════════════════════════════
// A2：createFulfillmentTasks 去重口径按「(type, 非终态)」—— force 复活重建任务
// ══════════════════════════════════════════════════════════════════════════
describe('createFulfillmentTasks · CANCELLED 视为不存在（force 复活重建 PENDING）', () => {
  it('取消族终态化后复活：CANCELLED 任务不挡路，缺失活动任务重建 PENDING', async () => {
    const from = await createScheduleWithSeats({ sold: 1 });
    const order = await createPaidFlightOrder({ scheduleId: from.schedule.id, cabin: CabinClass.ECONOMY });
    const itemId = order.items[0].id;

    // 首次生成：1 个 PENDING FLIGHT_TICKETING 任务
    const first = await prisma.$transaction((tx) => createFulfillmentTasks(tx, order.id));
    expect(first).toHaveLength(1);
    const t1 = await prisma.fulfillmentTask.findUniqueOrThrow({ where: { id: first[0] } });
    expect(t1.type).toBe(FulfillmentType.FLIGHT_TICKETING);
    expect(t1.status).toBe(FulfillmentStatus.PENDING);

    // 模拟取消族终态化：任务 → CANCELLED
    await prisma.fulfillmentTask.update({
      where: { id: t1.id },
      data: { status: FulfillmentStatus.CANCELLED, completedAt: new Date() },
    });

    // 复活（再跑 createFulfillmentTasks）：CANCELLED 视为不存在 → 重建一条新的 PENDING
    const second = await prisma.$transaction((tx) => createFulfillmentTasks(tx, order.id));
    expect(second).toHaveLength(1);
    const t2 = await prisma.fulfillmentTask.findUniqueOrThrow({ where: { id: second[0] } });
    expect(t2.id).not.toBe(t1.id);
    expect(t2.status).toBe(FulfillmentStatus.PENDING);
    // 旧的 CANCELLED 仍冻结为终态（历史记录，不被复活）
    const cancelled = await prisma.fulfillmentTask.findUniqueOrThrow({ where: { id: t1.id } });
    expect(cancelled.status).toBe(FulfillmentStatus.CANCELLED);
    // 该订单项现有 2 条任务：1 CANCELLED + 1 PENDING
    const all = await prisma.fulfillmentTask.findMany({ where: { orderItemId: itemId } });
    expect(all).toHaveLength(2);
  });

  it('活动任务（CONFIRMED）算已存在 → 不重复建（幂等，不误伤已完成的工单）', async () => {
    const from = await createScheduleWithSeats({ sold: 1 });
    const order = await createPaidFlightOrder({ scheduleId: from.schedule.id, cabin: CabinClass.ECONOMY });

    const first = await prisma.$transaction((tx) => createFulfillmentTasks(tx, order.id));
    await prisma.fulfillmentTask.update({
      where: { id: first[0] },
      data: { status: FulfillmentStatus.CONFIRMED, completedAt: new Date() },
    });
    // 再跑：CONFIRMED 是活动/已完成态，算已存在 → 不重复建
    const second = await prisma.$transaction((tx) => createFulfillmentTasks(tx, order.id));
    expect(second).toHaveLength(0);
  });
});
