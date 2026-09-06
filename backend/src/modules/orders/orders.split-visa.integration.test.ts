/**
 * 拆单 · 签证任务按两侧乘客各自重派生（拆单审计 #5）· **真 DB** 集成测试
 *
 * 为什么非得走真库：任务级状态 = 该单非自备签乘客送签进度的**最低档**，拆单把名单一分为二，
 * 两侧的最低档都可能变；mock 版里乘客名单是常量，「派生了」和「没派生」长得一模一样。
 * 这里乘客保 id 整行搬家（送签进度随人走），断言的是搬完之后两侧任务 / 订单头各自的派生结果。
 *
 * 覆盖：
 *   1. 需签单 [已送签, 已送签, 待处理]，任务待处理 → 拆出两位已送签：新单任务已送签 + 自动办结（已签证），
 *      源单任务仍待处理、订单头不动；签证成本三字段 + 签证公司随任务镜像到新单。
 *   2. 同一张单拆出那位待处理的 → 源单任务已送签 + 源单自动办结；新单任务待处理、订单头仍需签。
 *   3. 源单已自动办结（全员已送签 + 订单头已签证）→ 拆出一位：新单承接一条已送签任务、两侧都保持已签证，
 *      新单带承接来的办结审计（回退对称的前提）。
 *
 * 跑：
 *   TEST_DATABASE_URL=... npx vitest run -c vitest.integration.config.ts src/modules/orders/orders.split-visa.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  CabinClass,
  DocumentType,
  FulfillmentStatus,
  FulfillmentType,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  Prisma,
  UserRole,
  VisaRequirement,
  VisaSubmissionStatus,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from './orders.service.js';
import { VISA_AUTO_COMPLETE_ACTION } from '../fulfillment/visa-completion.js';

const service = new OrderService();
const { PENDING, CONFIRMED } = VisaSubmissionStatus;

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** requestToken 必须是 uuid：拼一个固定形状、按 tag 区分的 v4。 */
function token(tag: string): string {
  return `00000000-0000-4000-8000-0000000${tag.padStart(5, '0')}`;
}

async function adminActor(): Promise<{ userId: string; role: UserRole }> {
  const u = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: u.id, role: UserRole.ADMIN };
}

/** 建一个去程班次（经济舱 3 座已售，供拆座位账守恒）。 */
async function createSchedule(): Promise<{ id: string }> {
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `T${Math.floor(Math.random() * 1000000)}`,
      originCode: 'MFM',
      destinationCode: 'DAD',
      isActive: true,
    },
  });
  const departureTime = new Date(Date.now() + 10 * 24 * 3600_000);
  return prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: 'Asia/Macau',
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
      seatClasses: {
        create: [
          { cabin: CabinClass.ECONOMY, capacity: 50, sold: 3, basePrice: new Prisma.Decimal(1000) },
        ],
      },
    },
    select: { id: true },
  });
}

function passengerData(i: number, visaSubmissionStatus: VisaSubmissionStatus) {
  return {
    fullName: `WANG XIAO ${i}`,
    documentType: DocumentType.PASSPORT,
    documentNumber: uniq(`P${i}`),
    dateOfBirth: new Date('1990-01-01'),
    nationality: 'CN',
    passengerType: PassengerType.ADULT,
    passportExpiry: new Date('2031-01-01'),
    visaExempt: false,
    visaSubmissionStatus,
  };
}

/**
 * 3 人「机票 + 签证」需签单：去程 FLIGHT 3 座 ¥3000 + VISA 行 3 人 ¥1500，已全额收款；
 * 签证任务挂在 VISA 行上，状态按三人进度最低档给定；成本三字段 + 签证公司填好供镜像断言。
 */
async function createVisaOrder(opts: {
  progress: [VisaSubmissionStatus, VisaSubmissionStatus, VisaSubmissionStatus];
  visaStatus: VisaRequirement;
  taskStatus: FulfillmentStatus;
}) {
  const outbound = await createSchedule();
  const order = await prisma.order.create({
    data: {
      orderNumber: uniq('TEST-SPLITV'),
      status: OrderStatus.PAID,
      visaStatus: opts.visaStatus,
      subtotal: new Prisma.Decimal(4500),
      total: new Prisma.Decimal(4500),
      paidAmount: new Prisma.Decimal(4500),
      contactName: 'VISA SPLIT E2E',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.FLIGHT,
            description: '去程（经济舱）',
            quantity: 3,
            unitPrice: new Prisma.Decimal(1000),
            amount: new Prisma.Decimal(3000),
            totalCostCny: new Prisma.Decimal(1800),
            flightScheduleId: outbound.id,
            flightCabin: CabinClass.ECONOMY,
          },
          {
            kind: OrderItemKind.VISA,
            description: '落地签 × 3人',
            quantity: 3,
            unitPrice: new Prisma.Decimal(500),
            amount: new Prisma.Decimal(1500),
            totalCostCny: new Prisma.Decimal(324),
          },
        ],
      },
      passengers: {
        create: [
          passengerData(1, opts.progress[0]),
          passengerData(2, opts.progress[1]),
          passengerData(3, opts.progress[2]),
        ],
      },
    },
    include: { items: true, passengers: { orderBy: { fullName: 'asc' } } },
  });
  const visaItem = order.items.find((it) => it.kind === OrderItemKind.VISA)!;
  const task = await prisma.fulfillmentTask.create({
    data: {
      orderItemId: visaItem.id,
      type: FulfillmentType.VISA_APPLICATION,
      status: opts.taskStatus,
      completedAt: opts.taskStatus === FulfillmentStatus.CONFIRMED ? new Date() : null,
      visaUnitCostUsd: new Prisma.Decimal(15),
      visaFxRate: new Prisma.Decimal(7.2),
      visaUnitCostCny: new Prisma.Decimal(108),
      visaSupplier: '签证公司A',
    },
    select: { id: true },
  });
  const [p1, p2, p3] = order.passengers;
  return { order, visaItem, task, p1, p2, p3 };
}

async function visaTasksOf(orderId: string) {
  return prisma.fulfillmentTask.findMany({
    where: { orderItem: { orderId }, type: FulfillmentType.VISA_APPLICATION },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      completedAt: true,
      visaUnitCostUsd: true,
      visaFxRate: true,
      visaUnitCostCny: true,
      visaSupplier: true,
    },
  });
}

async function orderHead(orderId: string) {
  return prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      visaStatus: true,
      passengers: { select: { id: true, visaSubmissionStatus: true }, orderBy: { fullName: 'asc' } },
    },
  });
}

async function autoCompleteAudits(orderId: string) {
  return prisma.auditLog.findMany({
    where: { targetId: orderId, action: VISA_AUTO_COMPLETE_ACTION },
    select: { before: true, after: true },
  });
}

// ══════════════════════════════════════════════════════════════════════════
describe('拆单 · 签证任务按两侧乘客各自重派生（真 DB）', () => {
  it('拆出两位已送签的人：新单任务已送签并自动办结；源单任务仍待处理；成本字段随任务镜像', async () => {
    const actor = await adminActor();
    const { order, p1, p2, p3 } = await createVisaOrder({
      progress: [CONFIRMED, CONFIRMED, PENDING],
      visaStatus: VisaRequirement.NEEDED,
      taskStatus: FulfillmentStatus.PENDING,
    });

    const result = await service.splitOrder(
      order.id,
      { passengerIds: [p1.id, p2.id], requestToken: token('v1') },
      actor,
    );
    expect(result.replayed).toBe(false);

    // 送签进度随人走（乘客保 id 整行搬家）
    const target = await orderHead(result.targetOrderId);
    const source = await orderHead(order.id);
    expect(target.passengers.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
    expect(target.passengers.every((p) => p.visaSubmissionStatus === CONFIRMED)).toBe(true);
    expect(source.passengers).toEqual([{ id: p3.id, visaSubmissionStatus: PENDING }]);

    // 新单任务 = 两位已送签的最低档 → 已送签（completedAt 盖上），成本三字段 + 签证公司镜像过来
    const targetTasks = await visaTasksOf(result.targetOrderId);
    expect(targetTasks).toHaveLength(1);
    expect(targetTasks[0].status).toBe(FulfillmentStatus.CONFIRMED);
    expect(targetTasks[0].completedAt).not.toBeNull();
    expect(Number(targetTasks[0].visaUnitCostUsd)).toBe(15);
    expect(Number(targetTasks[0].visaFxRate)).toBe(7.2);
    expect(Number(targetTasks[0].visaUnitCostCny)).toBe(108);
    expect(targetTasks[0].visaSupplier).toBe('签证公司A');

    // 源单任务 = 剩下那位的进度 → 待处理（不被新单的已送签带偏）
    const sourceTasks = await visaTasksOf(order.id);
    expect(sourceTasks).toHaveLength(1);
    expect(sourceTasks[0].status).toBe(FulfillmentStatus.PENDING);
    expect(sourceTasks[0].completedAt).toBeNull();

    // 订单头：新单非自备签乘客全部已送签 + 确有我方任务 → 自动办结（留审计）；源单仍需签
    expect(target.visaStatus).toBe(VisaRequirement.HAS_VISA);
    expect(source.visaStatus).toBe(VisaRequirement.NEEDED);
    const audits = await autoCompleteAudits(result.targetOrderId);
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toEqual({ visaStatus: VisaRequirement.NEEDED });
    expect(await autoCompleteAudits(order.id)).toHaveLength(0);
  });

  it('拆出那位待处理的人：源单任务已送签并自动办结；新单任务待处理、订单头仍需签', async () => {
    const actor = await adminActor();
    const { order, p3 } = await createVisaOrder({
      progress: [CONFIRMED, CONFIRMED, PENDING],
      visaStatus: VisaRequirement.NEEDED,
      taskStatus: FulfillmentStatus.PENDING,
    });

    const result = await service.splitOrder(
      order.id,
      { passengerIds: [p3.id], requestToken: token('v2') },
      actor,
    );

    const sourceTasks = await visaTasksOf(order.id);
    expect(sourceTasks.map((t) => t.status)).toEqual([FulfillmentStatus.CONFIRMED]);
    expect(sourceTasks[0].completedAt).not.toBeNull();
    const targetTasks = await visaTasksOf(result.targetOrderId);
    expect(targetTasks.map((t) => t.status)).toEqual([FulfillmentStatus.PENDING]);

    expect((await orderHead(order.id)).visaStatus).toBe(VisaRequirement.HAS_VISA);
    expect((await orderHead(result.targetOrderId)).visaStatus).toBe(VisaRequirement.NEEDED);
    expect(await autoCompleteAudits(order.id)).toHaveLength(1);
    expect(await autoCompleteAudits(result.targetOrderId)).toHaveLength(0);
  });

  it('源单已自动办结 → 拆出一位：新单承接已送签任务，两侧保持已签证，新单带承接的办结审计', async () => {
    const actor = await adminActor();
    const { order, p1 } = await createVisaOrder({
      progress: [CONFIRMED, CONFIRMED, CONFIRMED],
      visaStatus: VisaRequirement.HAS_VISA,
      taskStatus: FulfillmentStatus.CONFIRMED,
    });
    // 源单的「已签证」是派生办结写的（审计里最近一条 AUTO_COMPLETE_VISA）
    await prisma.auditLog.create({
      data: {
        action: VISA_AUTO_COMPLETE_ACTION,
        targetType: 'ORDER',
        targetId: order.id,
        targetLabel: order.orderNumber,
        actorRole: 'SYSTEM',
        before: { visaStatus: VisaRequirement.NEEDED },
        after: { visaStatus: VisaRequirement.HAS_VISA },
      },
    });

    const result = await service.splitOrder(
      order.id,
      { passengerIds: [p1.id], requestToken: token('v3') },
      actor,
    );

    const targetTasks = await visaTasksOf(result.targetOrderId);
    expect(targetTasks.map((t) => t.status)).toEqual([FulfillmentStatus.CONFIRMED]);
    expect(targetTasks[0].visaSupplier).toBe('签证公司A');
    const sourceTasks = await visaTasksOf(order.id);
    expect(sourceTasks.map((t) => t.status)).toEqual([FulfillmentStatus.CONFIRMED]);

    expect((await orderHead(order.id)).visaStatus).toBe(VisaRequirement.HAS_VISA);
    expect((await orderHead(result.targetOrderId)).visaStatus).toBe(VisaRequirement.HAS_VISA);
    // 承接来的办结审计（before 沿用源单的办结前原档），日后新单退回时才认得这是派生值
    const carried = await autoCompleteAudits(result.targetOrderId);
    expect(carried).toHaveLength(1);
    expect(carried[0].before).toEqual({ visaStatus: VisaRequirement.NEEDED });
  });
});
