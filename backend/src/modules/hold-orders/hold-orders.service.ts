/** 占位单二期：收款计划、挂账池认款、逾期与减员清算。 */
import {
  AuditSeverity,
  AuditTargetType,
  CabinClass,
  HoldAmountRule,
  HoldInstallmentStatus,
  HoldOccupyOn,
  HoldOrderStatus,
  HoldOwnerType,
  HoldOverdueAction,
  OrderStatus,
  PaymentMethod,
  Prisma,
  ReminderStatus,
  ReceiptStatus,
  SeatLockStatus,
  UserRole,
} from '@prisma/client';
import { randomInt } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { AuditActor } from '../../lib/audit.js';
import { heldSeatsForSeatClass } from './held-seats.js';
import { OrderService } from '../orders/orders.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import {
  attributableReceivedCny,
  holdLedgerTotals,
  perSeatAttributableCny,
  rebaseInstallmentsForRemainingSeats,
  type HoldLedger,
} from './hold-settlement.js';
import {
  buildInstallmentsFromOverride,
  FALLBACK_HOLD_CONFIG,
  foldInstallments,
  installmentCreateData,
  dateInTimezone,
  type HoldInstallmentOverride,
  type HoldInstallmentTemplate,
} from './hold-installments.js';
import { computeReduction, type ReductionResult } from './hold-reduction.js';
import type {
  AllocateHoldInstallmentBody,
  CreateHoldGroupBody,
  CreateHoldOrderBody,
  ListHoldOrdersQuery,
  ReduceHoldSeatsBody,
  UpdateHoldInstallmentBody,
  UpdateHoldOrderConfigBody,
  UpdateHoldOrderPriceBody,
  PreviewHoldPlanBody,
  ConvertHoldOrderBody,
  PreviewConvertHoldOrderBody,
} from './hold-orders.schemas.js';
import { convertHoldOrderBodySchema } from './hold-orders.schemas.js';
import { deriveHoldStatus, HOLD_STATUS_LABEL } from './hold-status.js';

const HOLD_NO_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

type Tx = Prisma.TransactionClient;

function generateHoldNo(now = new Date()): string {
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += HOLD_NO_ALPHABET[randomInt(HOLD_NO_ALPHABET.length)];
  return `H${date}${suffix}`;
}

/** 团号 `G{YYYYMMDD}{4位}`：同一次建团的所有航段共用，用于「按团查/按团核对」。 */
function generateGroupRef(now = new Date()): string {
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += HOLD_NO_ALPHABET[randomInt(HOLD_NO_ALPHABET.length)];
  return `G${date}${suffix}`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function auditHold(
  actor: AuditActor | undefined,
  action: string,
  hold: { id: string; holdNo: string; flightScheduleId: string },
  entry: { before?: unknown; after?: unknown },
): void {
  void writeAudit({
    actor: actor ?? {},
    action,
    targetType: AuditTargetType.FLIGHT,
    targetId: hold.id,
    targetLabel: `占位单 ${hold.holdNo}`,
    before: entry.before,
    after: entry.after,
    severity: AuditSeverity.WARNING,
  });
}

function money(value: Prisma.Decimal | number | null | undefined): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

function configTemplates(value: Prisma.JsonValue | undefined): HoldInstallmentTemplate[] {
  if (!Array.isArray(value) || value.length === 0) return FALLBACK_HOLD_CONFIG.installments;
  const candidates = value as unknown[];
  const rows = candidates.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  if (rows.length !== candidates.length) return FALLBACK_HOLD_CONFIG.installments;
  const templates = rows.map((row) => ({
    label: typeof row.label === 'string' ? row.label : '',
    amountRule: row.amountRule === HoldAmountRule.PER_PERSON_FIXED
      ? HoldAmountRule.PER_PERSON_FIXED
      : row.amountRule === HoldAmountRule.REMAINDER ? HoldAmountRule.REMAINDER : null,
    perPersonCny: typeof row.perPersonCny === 'number' ? row.perPersonCny : undefined,
    dueOffsetDays: row.dueOffsetDays == null ? null : Number(row.dueOffsetDays),
  }));
  if (
    templates.some((row) => !row.label || !row.amountRule || row.dueOffsetDays !== null && (!Number.isInteger(row.dueOffsetDays) || row.dueOffsetDays < 0)) ||
    templates.filter((row) => row.amountRule === HoldAmountRule.REMAINDER).length !== 1
  ) return FALLBACK_HOLD_CONFIG.installments;
  return templates as HoldInstallmentTemplate[];
}

async function readConfig(tx: Tx | typeof prisma) {
  const delegate = (tx as unknown as { holdOrderConfig?: { findFirst: (args?: unknown) => Promise<unknown> } }).holdOrderConfig;
  const row = delegate ? await delegate.findFirst() as {
    id: string;
    installments: Prisma.JsonValue;
    overdueAction: HoldOverdueAction;
    defaultFreeCancelRatio: Prisma.Decimal;
  } | null : null;
  return row ?? {
    id: null,
    installments: FALLBACK_HOLD_CONFIG.installments as unknown as Prisma.JsonValue,
    overdueAction: HoldOverdueAction.REMIND_ONLY,
    defaultFreeCancelRatio: new Prisma.Decimal(FALLBACK_HOLD_CONFIG.defaultFreeCancelRatio),
  };
}

async function findHold(tx: Tx | typeof prisma, id: string) {
  return tx.holdOrder.findUnique({
    where: { id },
    include: {
      installments: { orderBy: { seq: 'asc' }, include: { allocations: true } },
      reductions: { select: { id: true, forfeitCny: true, surplusCny: true, createdAt: true } },
      conversions: {
        select: {
          id: true,
          orderId: true,
          seats: true,
          carryCny: true,
          paymentId: true,
          requestToken: true,
          createdAt: true,
          order: { select: { orderNumber: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
      seatClass: { select: { cabin: true } },
      flightSchedule: {
        select: {
          id: true,
          departureTime: true,
          departureTz: true,
          flight: { select: { flightNumber: true } },
        },
      },
      agent: { select: { id: true, companyName: true, contactName: true } },
    },
  });
}

async function lockHold(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "HoldOrder" WHERE id = ${id} FOR UPDATE`;
}

async function lockSeatClass(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "FlightSeatClass" WHERE id = ${id} FOR UPDATE`;
  if (!rows[0]) throw new NotFoundError('舱位不存在');
}

async function seatsAvailableForNewHold(tx: Tx, seatClassId: string, seats: number): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ capacity: number; sold: number }>>`
    SELECT capacity, sold FROM "FlightSeatClass" WHERE id = ${seatClassId} FOR UPDATE
  `;
  const seatClass = rows[0];
  if (!seatClass) throw new NotFoundError('舱位不存在');
  const locked = await tx.seatLock.aggregate({
    _sum: { qty: true },
    where: { seatClassId, status: SeatLockStatus.ACTIVE, expiresAt: { gt: new Date() } },
  });
  const held = await heldSeatsForSeatClass(tx, seatClassId);
  return seatClass.capacity - seatClass.sold - (locked._sum.qty ?? 0) - held - seats;
}

async function availableSeatsForHold(tx: Tx, hold: { seatClassId: string }, seatsToOccupy: number): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ capacity: number; sold: number }>>`
    SELECT capacity, sold FROM "FlightSeatClass" WHERE id = ${hold.seatClassId} FOR UPDATE
  `;
  const seatClass = rows[0];
  if (!seatClass) throw new NotFoundError('舱位不存在');
  const locked = await tx.seatLock.aggregate({
    _sum: { qty: true },
    where: { seatClassId: hold.seatClassId, status: SeatLockStatus.ACTIVE, expiresAt: { gt: new Date() } },
  });
  const held = await heldSeatsForSeatClass(tx, hold.seatClassId);
  return seatClass.capacity - seatClass.sold - (locked._sum.qty ?? 0) - held - seatsToOccupy;
}

function activeAllocationTotal(installment: { allocations: Array<{ amountCny: Prisma.Decimal; reversedAt: Date | null }> }): number {
  return installment.allocations
    .filter((allocation) => !allocation.reversedAt)
    .reduce((sum, allocation) => sum + money(allocation.amountCny), 0);
}

/** 金额重算后的统一状态收口：状态只由未撤销认款合计与新应收决定。 */
export async function syncInstallmentPaidStates(tx: Tx, holdOrderId: string) {
  const rows = await tx.holdInstallment.findMany({
    where: { holdOrderId },
    orderBy: { seq: 'asc' },
    include: { allocations: true },
  });
  const now = new Date();
  const synced = [];
  for (const item of rows) {
    const allocatedCny = activeAllocationTotal(item);
    const paid = item.amountCny === 0 || allocatedCny >= item.amountCny;
    const status = paid ? HoldInstallmentStatus.PAID : HoldInstallmentStatus.PENDING;
    const paidAt = paid ? item.paidAt ?? now : null;
    if (item.status !== status || (paid && !item.paidAt) || (!paid && item.paidAt)) {
      await tx.holdInstallment.update({ where: { id: item.id }, data: { status, paidAt } });
    }
    synced.push({ ...item, status, paidAt, allocatedCny });
  }
  return synced;
}

async function closeOpenHoldDueReminders(tx: Tx, installmentId: string, note: string): Promise<void> {
  const delegate = (tx as unknown as { operationalReminder?: { updateMany: (args: unknown) => Promise<unknown> } }).operationalReminder;
  if (!delegate) return;
  await delegate.updateMany({
    where: { ruleKey: { startsWith: `HOLD_DUE:${installmentId}:` }, status: ReminderStatus.OPEN },
    data: { status: ReminderStatus.SKIPPED, resolvedAt: new Date(), resolvedNote: note, claimedById: null },
  });
}

async function enqueueWaitlist(seatClassId: string): Promise<void> {
  try {
    const { enqueueWaitlistCheck } = await import('../../queues/queue.js');
    await enqueueWaitlistCheck(seatClassId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[hold-orders] failed to enqueue waitlist-check', err);
  }
}

async function enqueueFulfillmentTasks(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0 || process.env.ENABLE_AUTO_FULFILLMENT !== 'true') return;
  try {
    const { fulfillmentQueue } = await import('../../queues/queue.js');
    for (const taskId of taskIds) {
      void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[hold-orders] failed to enqueue fulfillment task', error);
      });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[hold-orders] failed to load fulfillment queue', error);
  }
}

/**
 * 占位单列表筛选条件。出发日期区间按起飞地当地日折算——先用权威 SQL（双段 AT TIME ZONE）
 * 解析出区间内的班次 id，再交给 Prisma 过滤；不用「UTC 窗口 ± 1 天」猜，避免跨时区边界漏单。
 */
async function holdListWhere(query: ListHoldOrdersQuery): Promise<Prisma.HoldOrderWhereInput> {
  const where: Prisma.HoldOrderWhereInput = {
    ...(query.flightScheduleId ? { flightScheduleId: query.flightScheduleId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.agentId ? { agentId: query.agentId } : {}),
    ...(query.groupRef ? { groupRef: query.groupRef } : {}),
    ...(query.flightId ? { flightSchedule: { flightId: query.flightId } } : {}),
  };
  if (!query.from && !query.to) return where;

  const from = query.from ?? null;
  const to = query.to ?? null;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s.id FROM "FlightSchedule" s
    WHERE (${from}::text IS NULL OR (s."departureTime" AT TIME ZONE 'UTC' AT TIME ZONE s."departureTz")::date >= ${from}::date)
      AND (${to}::text IS NULL OR (s."departureTime" AT TIME ZONE 'UTC' AT TIME ZONE s."departureTz")::date <= ${to}::date)
  `;
  const ids = rows.map((row) => row.id);
  // 命中的班次与显式指定的班次取交集；区间内没有任何班次时用空集合，宁可返回空也不放行全量。
  const scoped = query.flightScheduleId ? ids.filter((id) => id === query.flightScheduleId) : ids;
  return { ...where, flightScheduleId: { in: scoped } };
}

export class HoldOrderService {
  private readonly orderService = new OrderService();
  private readonly paymentsService = new PaymentsService();
  /**
   * 单航段建单的事务体。抽出来是为了让「建团」能把多个航段放进同一个事务：
   * 要么整团都占上，要么一个都不占——避免去程占住、回程失败留下半个团。
   */
  private async createHoldInTx(
    tx: Tx,
    leg: { flightScheduleId: string; cabin: CabinClass; perSeatPriceCny: number },
    shared: {
      seats: number;
      mode: 'RESERVE' | 'ALLOTMENT';
      ownerType: HoldOwnerType;
      agentId?: string;
      groupName?: string;
      freeCancelRatio?: number;
      notes?: string;
      installmentsOverride?: CreateHoldOrderBody['installmentsOverride'];
      groupRef: string | null;
    },
    createdById: string,
    now: Date,
  ) {
    const rows = await tx.$queryRaw<Array<{ id: string; scheduleId: string; capacity: number; sold: number }>>`
      SELECT id, "scheduleId", capacity, sold FROM "FlightSeatClass"
      WHERE "scheduleId" = ${leg.flightScheduleId} AND cabin = ${leg.cabin}::"CabinClass" FOR UPDATE
    `;
    const seatClass = rows[0];
    if (!seatClass) throw new NotFoundError('舱位不存在');
    if (shared.ownerType === HoldOwnerType.AGENT) {
      const agent = await tx.agent.findUnique({ where: { id: shared.agentId! }, select: { id: true } });
      if (!agent) throw new NotFoundError('代理不存在');
    }

    const mode = shared.mode ?? 'RESERVE';
    if (mode === 'RESERVE') {
      const remaining = await seatsAvailableForNewHold(tx, seatClass.id, shared.seats);
      if (remaining < 0) throw new ConflictError(`余票不足：需要占位 ${shared.seats} 张，仅剩 ${Math.max(0, remaining + shared.seats)} 张可占`);
    }

    const scheduleDelegate = (tx as unknown as { flightSchedule?: { findUnique: (args: unknown) => Promise<{ departureTime: Date; departureTz: string } | null> } }).flightSchedule;
    const schedule = scheduleDelegate
      ? await scheduleDelegate.findUnique({ where: { id: leg.flightScheduleId }, select: { departureTime: true, departureTz: true } })
      : { departureTime: now, departureTz: 'UTC' };
    if (!schedule) throw new NotFoundError('航班班次不存在');

    const config = await readConfig(tx);
    let installments;
    let occupyOn: HoldOccupyOn;
    let status: HoldOrderStatus;
    if (mode === 'ALLOTMENT') {
      occupyOn = HoldOccupyOn.FULL_PAYMENT;
      status = HoldOrderStatus.PENDING;
      installments = [{ seq: 1, label: '全款', amountRule: HoldAmountRule.REMAINDER, perPersonCny: null, amountCny: shared.seats * leg.perSeatPriceCny, seatsBasis: shared.seats, dueDate: new Date(`${dateInTimezone(now, schedule.departureTz)}T00:00:00Z`) }];
    } else {
      occupyOn = HoldOccupyOn.CREATE;
      status = HoldOrderStatus.HOLDING;
      installments = shared.installmentsOverride
        ? buildInstallmentsFromOverride({ seats: shared.seats, perSeatPriceCny: leg.perSeatPriceCny, createdAt: now, departureTz: schedule.departureTz, overrides: shared.installmentsOverride as HoldInstallmentOverride[] })
        : foldInstallments({ seats: shared.seats, perSeatPriceCny: leg.perSeatPriceCny, createdAt: now, departureTime: schedule.departureTime, departureTz: schedule.departureTz, templates: configTemplates(config.installments) });
      status = deriveHoldStatus(
        { status: HoldOrderStatus.HOLDING },
        installments.map((item) => ({
          amountCny: item.amountCny,
          status: item.amountCny === 0 ? HoldInstallmentStatus.PAID : HoldInstallmentStatus.PENDING,
          dueDate: item.dueDate,
        })),
        dateInTimezone(now, schedule.departureTz),
      );
    }

    return tx.holdOrder.create({
      data: {
        holdNo: generateHoldNo(now),
        flightScheduleId: leg.flightScheduleId,
        seatClassId: seatClass.id,
        ownerType: shared.ownerType,
        agentId: shared.ownerType === HoldOwnerType.AGENT ? shared.agentId! : null,
        groupName: shared.groupName?.trim() ?? null,
        groupRef: shared.groupRef,
        seats: shared.seats,
        perSeatPriceCny: leg.perSeatPriceCny,
        freeCancelRatio: new Prisma.Decimal(shared.freeCancelRatio ?? Number(config.defaultFreeCancelRatio)),
        occupyOn,
        notes: shared.notes?.trim() ?? null,
        createdById,
        status,
        installments: {
          create: installmentCreateData(installments).map((item) => ({
            ...item,
            status: item.amountCny === 0 ? HoldInstallmentStatus.PAID : HoldInstallmentStatus.PENDING,
            paidAt: item.amountCny === 0 ? now : null,
          })),
        },
      },
      include: { installments: { orderBy: { seq: 'asc' } } },
    });
  }

  async create(body: CreateHoldOrderBody, createdById: string, actor?: AuditActor) {
    if (body.ownerType === HoldOwnerType.AGENT && !body.agentId) throw new BadRequestError('代理占位必须选择代理');
    if (body.ownerType === HoldOwnerType.CUSTOMER && !body.groupName?.trim()) throw new BadRequestError('直客占位必须填写团名或客户备注名');

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const now = new Date();
        const holdOrder = await prisma.$transaction(async (tx) =>
          this.createHoldInTx(
            tx,
            { flightScheduleId: body.flightScheduleId, cabin: body.cabin, perSeatPriceCny: body.perSeatPriceCny },
            {
              seats: body.seats,
              mode: body.mode ?? 'RESERVE',
              ownerType: body.ownerType,
              agentId: body.agentId,
              groupName: body.groupName,
              freeCancelRatio: body.freeCancelRatio,
              notes: body.notes,
              installmentsOverride: body.installmentsOverride,
              groupRef: null,
            },
            createdById,
            now,
          ),
        );
        auditHold(actor, 'CREATE_HOLD_ORDER', holdOrder, { after: { holdNo: holdOrder.holdNo, seats: holdOrder.seats, perSeatPriceCny: holdOrder.perSeatPriceCny, occupyOn: holdOrder.occupyOn, status: holdOrder.status } });
        return holdOrder;
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 2) throw error;
      }
    }
    throw new ConflictError('占位单号生成失败，请稍后重试');
  }

  /**
   * 建团占位：一次为同一个团的多个航段建单，落同一个团号，整团同一事务。
   * 去程占上、回程余票不足这种半成品是运营最难收拾的状态，所以宁可整团失败。
   */
  async createGroup(body: CreateHoldGroupBody, createdById: string, actor?: AuditActor) {
    if (body.ownerType === HoldOwnerType.AGENT && !body.agentId) throw new BadRequestError('代理占位必须选择代理');
    if (body.ownerType === HoldOwnerType.CUSTOMER && !body.groupName?.trim()) throw new BadRequestError('直客占位必须填写团名或客户备注名');

    for (let attempt = 0; attempt < 3; attempt++) {
      const now = new Date();
      const groupRef = generateGroupRef(now);
      try {
        const holdOrders = await prisma.$transaction(async (tx) => {
          const created = [];
          // 顺序建单：多段共用一个事务，FlightSeatClass 的 FOR UPDATE 行锁按 leg 顺序累积获取。
          for (const leg of body.legs) {
            created.push(
              await this.createHoldInTx(
                tx,
                leg,
                {
                  seats: body.seats,
                  mode: body.mode ?? 'RESERVE',
                  ownerType: body.ownerType,
                  agentId: body.agentId,
                  groupName: body.groupName,
                  freeCancelRatio: body.freeCancelRatio,
                  notes: body.notes,
                  installmentsOverride: body.installmentsOverride,
                  groupRef,
                },
                createdById,
                now,
              ),
            );
          }
          return created;
        });
        for (const holdOrder of holdOrders) {
          auditHold(actor, 'CREATE_HOLD_ORDER', holdOrder, { after: { holdNo: holdOrder.holdNo, groupRef, seats: holdOrder.seats, perSeatPriceCny: holdOrder.perSeatPriceCny, occupyOn: holdOrder.occupyOn, status: holdOrder.status } });
        }
        return { groupRef, holdOrders };
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 2) throw error;
      }
    }
    throw new ConflictError('占位单号生成失败，请稍后重试');
  }

  async previewPlan(body: PreviewHoldPlanBody) {
    const schedule = await prisma.flightSchedule.findUnique({
      where: { id: body.flightScheduleId },
      select: { departureTime: true, departureTz: true },
    });
    if (!schedule) throw new NotFoundError('航班班次不存在');
    const now = new Date();
    const config = await readConfig(prisma);
    const mode = body.mode ?? 'RESERVE';
    const installments = mode === 'ALLOTMENT'
      ? [{ seq: 1, label: '全款', amountRule: HoldAmountRule.REMAINDER, perPersonCny: null, amountCny: body.seats * body.perSeatPriceCny, seatsBasis: body.seats, dueDate: new Date(`${dateInTimezone(now, schedule.departureTz)}T00:00:00Z`) }]
      : body.installmentsOverride
        ? buildInstallmentsFromOverride({ seats: body.seats, perSeatPriceCny: body.perSeatPriceCny, createdAt: now, departureTz: schedule.departureTz, overrides: body.installmentsOverride as HoldInstallmentOverride[] })
        : foldInstallments({ seats: body.seats, perSeatPriceCny: body.perSeatPriceCny, createdAt: now, departureTime: schedule.departureTime, departureTz: schedule.departureTz, templates: configTemplates(config.installments) });
    return {
      mode,
      occupyOn: mode === 'ALLOTMENT' ? HoldOccupyOn.FULL_PAYMENT : HoldOccupyOn.CREATE,
      installments: installments.map((item) => ({
        seq: item.seq,
        label: item.label,
        amountRule: item.amountRule,
        perPersonCny: item.perPersonCny,
        amountCny: item.amountCny,
        seatsBasis: item.seatsBasis,
        dueDate: item.dueDate.toISOString().slice(0, 10),
      })),
    };
  }

  async list(query: ListHoldOrdersQuery) {
    const rows = await prisma.holdOrder.findMany({
      where: await holdListWhere(query),
      include: {
        installments: { orderBy: { seq: 'asc' }, include: { allocations: true } },
        reductions: { orderBy: { createdAt: 'asc' } },
        conversions: {
          orderBy: { createdAt: 'asc' },
          include: { order: { select: { orderNumber: true } } },
        },
        seatClass: { select: { cabin: true } },
        flightSchedule: {
          select: {
            id: true,
            departureTime: true,
            departureTz: true,
            flight: { select: { id: true, flightNumber: true, originCode: true, destinationCode: true } },
          },
        },
        agent: { select: { id: true, companyName: true, contactName: true } },
      },
      // 跨日期视图的主序是出发日期（先飞的排前面），同一天内按建单时间倒序。
      orderBy: [{ flightSchedule: { departureTime: 'asc' } }, { createdAt: 'desc' }],
    });
    const normalized = rows.map((row) => ({
      ...row,
      conversions: row.conversions.map(({ order, ...conversion }) => ({
        ...conversion,
        orderNumber: order.orderNumber,
      })),
    }));
    return normalized.sort((a, b) => (a.status === HoldOrderStatus.OVERDUE ? -1 : 0) - (b.status === HoldOrderStatus.OVERDUE ? -1 : 0));
  }

  /** 工作台 KPI：一次 SQL 聚合完成，前端不逐单重算收款与余座。 */
  async summary(query: ListHoldOrdersQuery) {
    const scheduleId = query.flightScheduleId ?? null;
    const status = query.status ?? null;
    const agentId = query.agentId ?? null;
    const flightId = query.flightId ?? null;
    const groupRef = query.groupRef ?? null;
    const from = query.from ?? null;
    const to = query.to ?? null;
    const rows = await prisma.$queryRaw<Array<{
      occupiedOrderCount: bigint | number;
      occupiedSeats: bigint | number;
      overdueOrderCount: bigint | number;
      fullyPaidPendingConversionCount: bigint | number;
      receivedCny: Prisma.Decimal | number | null;
    }>>`
      SELECT
        COUNT(*) FILTER (WHERE h.status::text IN ('HOLDING', 'OVERDUE', 'FULLY_PAID')) AS "occupiedOrderCount",
        COALESCE(SUM(h.seats - h."seatsConverted" - h."seatsCancelled")
          FILTER (WHERE h.status::text IN ('HOLDING', 'OVERDUE', 'FULLY_PAID')), 0) AS "occupiedSeats",
        COUNT(*) FILTER (WHERE h.status::text = 'OVERDUE') AS "overdueOrderCount",
        COUNT(*) FILTER (WHERE h.status::text = 'FULLY_PAID') AS "fullyPaidPendingConversionCount",
        COALESCE(SUM((
          SELECT COALESCE(SUM(a."amountCny"), 0)
          FROM "HoldInstallment" i
          JOIN "HoldReceiptAllocation" a ON a."holdInstallmentId" = i.id
          WHERE i."holdOrderId" = h.id AND a."reversedAt" IS NULL
        )), 0) AS "receivedCny"
      FROM "HoldOrder" h
      JOIN "FlightSchedule" s ON s.id = h."flightScheduleId"
      WHERE (${scheduleId}::text IS NULL OR h."flightScheduleId" = ${scheduleId})
        AND (${agentId}::text IS NULL OR h."agentId" = ${agentId})
        AND (${status}::text IS NULL OR h.status::text = ${status})
        AND (${flightId}::text IS NULL OR s."flightId" = ${flightId})
        AND (${groupRef}::text IS NULL OR h."groupRef" = ${groupRef})
        -- 出发日按起飞地时区折算成当地日，与列表/座位统计同口径（naive timestamp 必须双段折算）
        AND (${from}::text IS NULL OR (s."departureTime" AT TIME ZONE 'UTC' AT TIME ZONE s."departureTz")::date >= ${from}::date)
        AND (${to}::text IS NULL OR (s."departureTime" AT TIME ZONE 'UTC' AT TIME ZONE s."departureTz")::date <= ${to}::date)
    `;
    const row = rows[0] ?? {
      occupiedOrderCount: 0,
      occupiedSeats: 0,
      overdueOrderCount: 0,
      fullyPaidPendingConversionCount: 0,
      receivedCny: 0,
    };
    return {
      occupiedOrderCount: Number(row.occupiedOrderCount),
      occupiedSeats: Number(row.occupiedSeats),
      overdueOrderCount: Number(row.overdueOrderCount),
      fullyPaidPendingConversionCount: Number(row.fullyPaidPendingConversionCount),
      receivedCny: money(row.receivedCny),
    };
  }

  /**
   * 名单导入转正：消费占位单自身余座，订单在同一事务内独立建账并结转人均可归属实收。
   */
  async previewConversion(id: string, body: PreviewConvertHoldOrderBody) {
    const hold = await findHold(prisma, id);
    if (!hold) throw new NotFoundError('占位单不存在');
    const convertibleStatuses: HoldOrderStatus[] = [
      HoldOrderStatus.HOLDING,
      HoldOrderStatus.OVERDUE,
      HoldOrderStatus.FULLY_PAID,
    ];
    if (!convertibleStatuses.includes(hold.status)) {
      throw new ConflictError(`占位单当前状态不可转正（${HOLD_STATUS_LABEL[hold.status]}）`);
    }
    const availableSeats = hold.seats - hold.seatsConverted - hold.seatsCancelled;
    if (body.seats > availableSeats) {
      throw new ConflictError(`转正人数超过占位余座：当前余 ${Math.max(0, availableSeats)} 座，本次 ${body.seats} 人`);
    }
    const totalReceived = hold.installments.reduce((sum, item) => sum + activeAllocationTotal(item), 0);
    const ledger: HoldLedger = { reductions: hold.reductions, conversions: hold.conversions };
    const perSeatCarry = perSeatAttributableCny(totalReceived, availableSeats, ledger);
    const carryCny = body.seats * perSeatCarry;
    const orderDueCny = Math.max(0, body.seats * hold.perSeatPriceCny - carryCny);
    return { perSeatCarry, carryCny, orderDueCny };
  }

  async convert(id: string, body: ConvertHoldOrderBody, actor?: AuditActor) {
    // 路由层已 parse；服务层再守一道边界，保证任何直接调用也在事务开始前完成
    // 与批量创单完全相同的姓名/证件/出生日期/护照有效期校验，失败不会先消费占位余座。
    const validatedBody = convertHoldOrderBodySchema.parse(body);
    const pendingFulfillmentTaskIds: string[] = [];
    const actorUserId = actor?.userId ?? null;
    const actorRole = actor?.role === 'STAFF' ? UserRole.STAFF : UserRole.ADMIN;
    const result = await prisma.$transaction(async (tx) => {
      await lockHold(tx, id);
      const existing = await findHold(tx, id);
      if (!existing) throw new NotFoundError('占位单不存在');

      // 同一占位单上的请求令牌在锁内先查，重试直接回放原订单，绝不再次消费座位或收款。
      const prior = await tx.holdConversionRecord.findUnique({
        where: { holdOrderId_requestToken: { holdOrderId: id, requestToken: validatedBody.requestToken } },
        select: { id: true, orderId: true, seats: true, carryCny: true, requestToken: true },
      });
      if (prior) {
        const priorOrder = await tx.order.findUnique({
          where: { id: prior.orderId },
          select: { id: true, orderNumber: true, total: true, paidAmount: true, status: true },
        });
        if (!priorOrder) throw new ConflictError('转正记录对应订单不存在，无法安全幂等返回');
        return {
          id,
          holdNo: existing.holdNo,
          flightScheduleId: existing.flightScheduleId,
          seatClassId: existing.seatClassId,
          orderId: priorOrder.id,
          orderNumber: priorOrder.orderNumber,
          seats: prior.seats,
          carryCny: prior.carryCny,
          remainingSeats: existing.seats - existing.seatsConverted - existing.seatsCancelled,
          holdStatus: existing.status,
          orderStatus: priorOrder.status,
          paidAmount: money(priorOrder.paidAmount),
          total: money(priorOrder.total),
          requestToken: prior.requestToken,
        };
      }
      const convertibleStatuses: HoldOrderStatus[] = [
        HoldOrderStatus.HOLDING,
        HoldOrderStatus.OVERDUE,
        HoldOrderStatus.FULLY_PAID,
      ];
      if (!convertibleStatuses.includes(existing.status)) {
        throw new ConflictError(`占位单当前状态不可转正（${HOLD_STATUS_LABEL[existing.status]}）`);
      }

      const availableSeats = existing.seats - existing.seatsConverted - existing.seatsCancelled;
      const seatsToConvert = validatedBody.passengers.length;
      if (seatsToConvert > availableSeats) {
        throw new ConflictError(`转正人数超过占位余座：当前余 ${Math.max(0, availableSeats)} 座，本次 ${seatsToConvert} 人`);
      }
      if (existing.installments.length === 0) throw new BadRequestError('占位单没有收款期，无法结转已收款');

      // 先锁舱位行；随后消费自身占位，CAS 只看到扣除本次占位后的公共净余量。
      await lockSeatClass(tx, existing.seatClassId);
      const totalReceived = existing.installments.reduce((sum, item) => sum + activeAllocationTotal(item), 0);
      const ledger: HoldLedger = { reductions: existing.reductions, conversions: existing.conversions };
      const perSeatCarry = perSeatAttributableCny(totalReceived, availableSeats, ledger);
      const carryCny = seatsToConvert * perSeatCarry;
      const remainingSeats = availableSeats - seatsToConvert;

      await tx.holdOrder.update({
        where: { id },
        data: { seatsConverted: { increment: seatsToConvert } },
      });

      const created = await this.orderService.createHoldConversionOrderWithinTx(tx, {
        holdOrderId: existing.id,
        holdNo: existing.holdNo,
        flightScheduleId: existing.flightScheduleId,
        cabin: existing.seatClass.cabin as CabinClass,
        quantity: seatsToConvert,
        unitPriceCny: existing.perSeatPriceCny,
        passengers: validatedBody.passengers,
        contactName: validatedBody.contactName,
        contactPhone: validatedBody.contactPhone,
        agentId: existing.agentId,
        actorUserId,
        allowDuplicatePassengers: validatedBody.allowDuplicatePassengers === true && (actorRole === UserRole.ADMIN || actorRole === UserRole.STAFF),
      });

      let paymentId: string | null = null;
      if (carryCny > 0) {
        const credited = await this.paymentsService._creditOrderPaymentWithinTx(
          tx,
          created.order.id,
          {
            amount: carryCny,
            method: PaymentMethod.BANK_CARD,
            note: `占位单 ${existing.holdNo} 结转`,
          },
          { userId: actorUserId ?? 'system-hold-conversion', role: actorRole },
          pendingFulfillmentTaskIds,
        );
        paymentId = credited.paymentId;
      }

      // 即使 carryCny=0 也必须走同一套 effectivePayable<=paid 状态机；零价订单按正常订单
      // 口径推进 PAID，并在同一事务内生成佣金/履约任务。结转款本身不经过 paymentsLocked 闸，
      // 因为它是占位单已有实收的内部搬账，不是新进账。
      await this.orderService.advanceOrderToPaidIfClearedWithinTx(
        tx,
        created.order.id,
        { userId: actorUserId ?? 'system-hold-conversion', role: actorRole, actorType: 'USER' },
        pendingFulfillmentTaskIds,
      );

      await tx.holdConversionRecord.create({
        data: {
          holdOrderId: existing.id,
          orderId: created.order.id,
          seats: seatsToConvert,
          carryCny,
          paymentId,
          requestToken: validatedBody.requestToken,
          createdById: actorUserId ?? 'system',
        },
      });

      const attributableAfterCarry = attributableReceivedCny(totalReceived, ledger) - carryCny;
      const rebased = rebaseInstallmentsForRemainingSeats(
        existing.installments,
        remainingSeats,
        remainingSeats * existing.perSeatPriceCny,
        attributableAfterCarry,
        false,
      );
      for (const update of rebased.updates) {
        await tx.holdInstallment.update({
          where: { holdOrderId_seq: { holdOrderId: id, seq: update.seq } },
          data: { amountCny: update.amountCny, seatsBasis: update.seatsBasis },
        });
      }
      const syncedInstallments = await syncInstallmentPaidStates(tx, id);
      for (const installment of syncedInstallments) {
        if (installment.status === HoldInstallmentStatus.PAID) {
          await closeOpenHoldDueReminders(tx, installment.id, '转正后本期已结清');
        }
      }
      const derivedStatus = deriveHoldStatus(
        existing,
        syncedInstallments,
        dateInTimezone(new Date(), existing.flightSchedule.departureTz),
      );
      const nextStatus = remainingSeats === 0 ? HoldOrderStatus.CONVERTED : derivedStatus;
      if (nextStatus !== existing.status) {
        await tx.holdOrder.update({
          where: { id },
          data: { status: nextStatus },
        });
        if (nextStatus === HoldOrderStatus.CONVERTED) {
          for (const installment of syncedInstallments) {
            await closeOpenHoldDueReminders(tx, installment.id, '占位单已全部转正');
          }
        }
      }

      const orderAfter = await tx.order.findUnique({
        where: { id: created.order.id },
        select: { id: true, orderNumber: true, total: true, paidAmount: true, status: true },
      });
      return {
        id,
        holdNo: existing.holdNo,
        flightScheduleId: existing.flightScheduleId,
        seatClassId: existing.seatClassId,
        orderId: created.order.id,
        orderNumber: orderAfter?.orderNumber ?? created.order.orderNumber,
        seats: seatsToConvert,
        carryCny,
        remainingSeats,
        holdStatus: nextStatus,
        orderStatus: orderAfter?.status ?? OrderStatus.PENDING_PAYMENT,
        paidAmount: money(orderAfter?.paidAmount),
        total: money(orderAfter?.total),
        requestToken: validatedBody.requestToken,
      };
    });

    await enqueueFulfillmentTasks(pendingFulfillmentTaskIds);
    auditHold(actor, 'CONVERT_HOLD_ORDER', result, {
      after: {
        orderNumber: result.orderNumber,
        seats: result.seats,
        carryCny: result.carryCny,
        remainingSeats: result.remainingSeats,
        status: result.holdStatus,
      },
    });
    return result;
  }

  async getById(id: string) {
    const holdOrder = await findHold(prisma, id);
    if (!holdOrder) throw new NotFoundError('占位单不存在');
    return {
      ...holdOrder,
      conversions: holdOrder.conversions.map(({ order, ...conversion }) => ({
        ...conversion,
        orderNumber: order.orderNumber,
      })),
    };
  }

  async getConfig() {
    const config = await readConfig(prisma);
    return {
      id: config.id,
      installments: configTemplates(config.installments),
      overdueAction: config.overdueAction,
      defaultFreeCancelRatio: Number(config.defaultFreeCancelRatio),
    };
  }

  async updateConfig(body: UpdateHoldOrderConfigBody, actor?: AuditActor) {
    const before = await this.getConfig();
    const data = { installments: body.installments, overdueAction: body.overdueAction, defaultFreeCancelRatio: new Prisma.Decimal(body.defaultFreeCancelRatio) };
    const existing = await prisma.holdOrderConfig.findFirst();
    const updated = existing
      ? await prisma.holdOrderConfig.update({ where: { id: existing.id }, data })
      : await prisma.holdOrderConfig.create({ data: { id: 'default', ...data } });
    void writeAudit({ actor: actor ?? {}, action: 'UPDATE_HOLD_ORDER_CONFIG', targetType: AuditTargetType.SYSTEM, targetId: updated.id, targetLabel: '占位单收款模板', before, after: data, severity: AuditSeverity.WARNING });
    return { id: updated.id, installments: body.installments, overdueAction: updated.overdueAction, defaultFreeCancelRatio: Number(updated.defaultFreeCancelRatio) };
  }

  async release(id: string, actor?: AuditActor) {
    return this.changeHoldingStatus(id, HoldOrderStatus.RELEASED, 'releasedAt', 'RELEASE_HOLD_ORDER', actor, true);
  }

  async cancel(id: string, actor?: AuditActor) {
    const result = await prisma.$transaction(async (tx) => {
      await lockHold(tx, id);
      const existing = await findHold(tx, id);
      if (!existing) throw new NotFoundError('占位单不存在');
      const remaining = existing.seats - existing.seatsConverted - existing.seatsCancelled;
      // 必须在持有 HoldOrder 行锁的事务内读取，避免认款与取消之间出现窗口。
      const hasReceipt = existing.installments.some((item) => activeAllocationTotal(item) > 0);
      if (hasReceipt && remaining > 0) {
        return { kind: 'reduction' as const, result: await this.reduceSeatsInTransaction(tx, id, { seats: remaining, note: '取消占位单' }, actor, 'CANCEL_HOLD_ORDER') };
      }
      const allowed: HoldOrderStatus[] = [HoldOrderStatus.PENDING, HoldOrderStatus.HOLDING, HoldOrderStatus.OVERDUE, HoldOrderStatus.FULLY_PAID];
      if (!allowed.includes(existing.status)) throw new ConflictError(`占位单当前状态不可操作（${HOLD_STATUS_LABEL[existing.status]}）`);
      const now = new Date();
      await tx.holdOrder.update({ where: { id }, data: { status: HoldOrderStatus.CANCELLED, cancelledAt: now } });
      for (const installment of existing.installments) await closeOpenHoldDueReminders(tx, installment.id, '占位单已取消');
      return { kind: 'status' as const, result: { id, status: HoldOrderStatus.CANCELLED, hold: existing } };
    });
    if (result.kind === 'reduction') {
      await enqueueWaitlist(result.result.seatClassId);
      auditHold(actor, 'CANCEL_HOLD_ORDER', { id, holdNo: result.result.holdNo, flightScheduleId: result.result.flightScheduleId }, { after: { ...result.result.computation, status: result.result.status, note: '取消占位单' } });
      return { id, status: result.result.status, ...result.result.computation };
    }
    auditHold(actor, 'CANCEL_HOLD_ORDER', result.result.hold, { before: { status: result.result.hold.status }, after: { status: HoldOrderStatus.CANCELLED, cancelledAt: '已记录' } });
    await enqueueWaitlist(result.result.hold.seatClassId);
    return { id, status: HoldOrderStatus.CANCELLED };
  }

  private async changeHoldingStatus(
    id: string,
    nextStatus: HoldOrderStatus,
    timestampField: 'releasedAt' | 'cancelledAt',
    action: string,
    actor?: AuditActor,
    allowPending = false,
  ) {
    const result = await prisma.$transaction(async (tx) => {
      await lockHold(tx, id);
      const existing = await findHold(tx, id);
      if (!existing) throw new NotFoundError('占位单不存在');
      const allowed: HoldOrderStatus[] = allowPending
        ? [HoldOrderStatus.PENDING, HoldOrderStatus.HOLDING, HoldOrderStatus.OVERDUE, HoldOrderStatus.FULLY_PAID]
        : [HoldOrderStatus.HOLDING, HoldOrderStatus.OVERDUE, HoldOrderStatus.FULLY_PAID];
      if (!allowed.includes(existing.status)) throw new ConflictError(`占位单当前状态不可操作（${HOLD_STATUS_LABEL[existing.status]}）`);
      const now = new Date();
      await tx.holdOrder.update({ where: { id }, data: { status: nextStatus, [timestampField]: now } });
      // 释放与取消一样让座位回池，未结的期款提醒必须一起关掉；
      // 否则占位单已经不占座了，催款提醒还挂在提醒中心永远关不掉。
      if (nextStatus === HoldOrderStatus.CANCELLED || nextStatus === HoldOrderStatus.RELEASED) {
        const note = nextStatus === HoldOrderStatus.CANCELLED ? '占位单已取消' : '占位单已释放';
        for (const installment of existing.installments) await closeOpenHoldDueReminders(tx, installment.id, note);
      }
      return { id, status: nextStatus, hold: existing };
    });
    auditHold(actor, action, result.hold, { before: { status: result.hold.status }, after: { status: nextStatus, [timestampField]: '已记录' } });
    await enqueueWaitlist(result.hold.seatClassId);
    return { id, status: result.status };
  }

  async updatePrice(id: string, body: UpdateHoldOrderPriceBody, actor?: AuditActor) {
    const result = await prisma.$transaction(async (tx) => {
      await lockHold(tx, id);
      const existing = await findHold(tx, id);
      if (!existing) throw new NotFoundError('占位单不存在');
      const editableStatuses: HoldOrderStatus[] = [HoldOrderStatus.PENDING, HoldOrderStatus.HOLDING, HoldOrderStatus.OVERDUE];
      if (!editableStatuses.includes(existing.status)) {
        throw new ConflictError(`占位单当前状态不可改价（${HOLD_STATUS_LABEL[existing.status]}）`);
      }
      const tail = [...existing.installments].sort((a, b) => b.seq - a.seq)[0];
      if (!tail || tail.amountRule !== HoldAmountRule.REMAINDER || activeAllocationTotal(tail) >= tail.amountCny) {
        throw new ConflictError('仅存在未认满的尾款期时允许改价；尾款已付请先撤销认款');
      }
      const remainingSeats = existing.seats - existing.seatsConverted - existing.seatsCancelled;
      const ledgerTotals = holdLedgerTotals({ reductions: existing.reductions, conversions: existing.conversions });
      const historicalForfeitCny = ledgerTotals.forfeitCny;
      const historicalSurplusCny = ledgerTotals.surplusCny;
      const historicalCarryCny = ledgerTotals.carryCny;
      // 计划总额守恒：Σ期应收 = 剩余合同额 + 历史没收 + 历史挂账 + 历史结转（这些已实收
      // 但不再归属剩余人的钱，其所在期金额不随改价缩水，故全部加回而非扣减）。
      const adjustedContractCny = remainingSeats * body.perSeatPriceCny + historicalForfeitCny + historicalSurplusCny + historicalCarryCny;
      const simulated = existing.installments.map((item) => {
        if (activeAllocationTotal(item) >= item.amountCny) return { ...item };
        if (item.amountRule === HoldAmountRule.PER_PERSON_FIXED) {
          const next = remainingSeats * (item.perPersonCny ?? 0);
          if (next < activeAllocationTotal(item)) throw new ConflictError(`第${item.seq}期新应收低于已认金额，请先撤销认款`);
          return { ...item, amountCny: next, seatsBasis: remainingSeats };
        }
        return { ...item };
      });
      const fixedTotal = simulated.filter((item) => item.seq !== tail.seq).reduce((sum, item) => sum + item.amountCny, 0);
      if (fixedTotal > adjustedContractCny) {
        throw new ConflictError(`固定收款期合计 ¥${fixedTotal} 超过改价后的可结算合同额 ¥${Math.max(0, adjustedContractCny)}，请先调整收款计划`);
      }
      const nextTailAmount = adjustedContractCny - fixedTotal;
      if (nextTailAmount < activeAllocationTotal(tail)) {
        throw new ConflictError(`新尾款 ¥${nextTailAmount} 小于本期已认 ¥${activeAllocationTotal(tail).toFixed(2)}，请先撤销认款`);
      }
      for (const item of simulated) {
        const nextAmount = item.seq === tail.seq ? nextTailAmount : item.amountCny;
        const old = existing.installments.find((candidate) => candidate.seq === item.seq);
        const nextBasis = activeAllocationTotal(item) < item.amountCny ? remainingSeats : (old?.seatsBasis ?? remainingSeats);
        if (nextAmount !== old?.amountCny || nextBasis !== old?.seatsBasis) {
          await tx.holdInstallment.update({ where: { id: item.id }, data: { amountCny: nextAmount, seatsBasis: nextBasis } });
        }
      }
      const nextInstallments = await syncInstallmentPaidStates(tx, id);
      for (const item of nextInstallments) {
        if (item.status === HoldInstallmentStatus.PAID) await closeOpenHoldDueReminders(tx, item.id, '改价后本期已结清');
      }
      const nextStatus = deriveHoldStatus(existing, nextInstallments, dateInTimezone(new Date(), existing.flightSchedule.departureTz));
      await tx.holdOrder.update({ where: { id }, data: { perSeatPriceCny: body.perSeatPriceCny, status: nextStatus } });
      return { id, perSeatPriceCny: body.perSeatPriceCny, hold: existing, status: nextStatus };
    });
    auditHold(actor, 'UPDATE_HOLD_ORDER_PRICE', result.hold, { before: { perSeatPriceCny: result.hold.perSeatPriceCny }, after: { perSeatPriceCny: body.perSeatPriceCny, reason: body.reason, status: result.status } });
    return { id, perSeatPriceCny: body.perSeatPriceCny, status: result.status };
  }

  async allocateInstallment(id: string, installmentId: string, body: AllocateHoldInstallmentBody, actor: AuditActor) {
    const result = await prisma.$transaction(async (tx) => {
      const receiptRows = await tx.$queryRaw<Array<{ id: string; receiptNo: string; amountCny: Prisma.Decimal; allocatedCny: Prisma.Decimal; status: ReceiptStatus }>>`
        SELECT id, "receiptNo", "amountCny", "allocatedCny", status FROM "Receipt" WHERE id = ${body.receiptId} FOR UPDATE
      `;
      const receipt = receiptRows[0];
      if (!receipt) throw new NotFoundError('进账不存在');
      if (receipt.status === ReceiptStatus.REFUNDED) throw new ConflictError(`进账 ${receipt.receiptNo} 已退款，无法认款`);
      const remaining = money(receipt.amountCny) - money(receipt.allocatedCny);
      if (remaining < body.amountCny) throw new ConflictError(`认款金额 ¥${body.amountCny} 超过进账 ${receipt.receiptNo} 剩余 ¥${remaining.toFixed(2)}`);
      await lockHold(tx, id);
      const hold = await findHold(tx, id);
      if (!hold) throw new NotFoundError('占位单不存在');
      if (hold.status === HoldOrderStatus.CONVERTED) throw new ConflictError('占位单已转正，不能再认款');
      if (([HoldOrderStatus.RELEASED, HoldOrderStatus.CANCELLED] as HoldOrderStatus[]).includes(hold.status)) {
        throw new ConflictError(`占位单当前状态不可认款（${HOLD_STATUS_LABEL[hold.status]}）`);
      }
      const installment = hold.installments.find((item) => item.id === installmentId);
      if (!installment) throw new NotFoundError('收款期不存在');
      const allocated = activeAllocationTotal(installment);
      const installmentRemaining = installment.amountCny - allocated;
      if (body.amountCny > installmentRemaining) throw new ConflictError(`本期应收 ¥${installment.amountCny}，已认 ¥${allocated.toFixed(2)}，本次最多认 ¥${installmentRemaining.toFixed(2)}`);
      const allocation = await tx.holdReceiptAllocation.create({ data: { receiptId: body.receiptId, holdOrderId: id, holdInstallmentId: installmentId, amountCny: new Prisma.Decimal(body.amountCny), createdById: actor.userId } });
      const newReceiptAllocated = money(receipt.allocatedCny) + body.amountCny;
      await tx.receipt.update({ where: { id: body.receiptId }, data: { allocatedCny: new Prisma.Decimal(newReceiptAllocated), status: newReceiptAllocated >= money(receipt.amountCny) ? ReceiptStatus.ALLOCATED : ReceiptStatus.PARTIALLY_ALLOCATED } });
      const newlyPaid = allocated + body.amountCny >= installment.amountCny;
      if (newlyPaid) await tx.holdInstallment.update({ where: { id: installmentId }, data: { status: HoldInstallmentStatus.PAID, paidAt: new Date() } });
      const postInstallments = await syncInstallmentPaidStates(tx, id);
      if (newlyPaid) await closeOpenHoldDueReminders(tx, installmentId, '本期已认满');
      const derived = deriveHoldStatus(hold, postInstallments, dateInTimezone(new Date(), hold.flightSchedule.departureTz));
      let nextStatus: HoldOrderStatus = hold.status;
      let warning: string | null = null;
      const first = [...hold.installments].sort((a, b) => a.seq - b.seq)[0];
      const firstPaid = postInstallments.find((item) => item.id === first.id)!.status === HoldInstallmentStatus.PAID;
      const shouldEnter = hold.status === HoldOrderStatus.PENDING && hold.occupyOn === HoldOccupyOn.FULL_PAYMENT && firstPaid;
      if (shouldEnter) {
        const seatsToOccupy = hold.seats - hold.seatsConverted - hold.seatsCancelled;
        const enough = await availableSeatsForHold(tx, hold, seatsToOccupy) >= 0;
        if (enough) nextStatus = derived;
        else {
          nextStatus = HoldOrderStatus.PENDING;
          warning = `认款已记录，但当前舱位余量不足以占 ${seatsToOccupy} 张座，请人工协调；占位单仍为待生效。`;
        }
      } else if (hold.status !== HoldOrderStatus.PENDING) {
        nextStatus = derived;
      }
      if (nextStatus !== hold.status) await tx.holdOrder.update({ where: { id }, data: { status: nextStatus } });
      return { id, allocation, holdNo: hold.holdNo, flightScheduleId: hold.flightScheduleId, receiptNo: receipt.receiptNo, installmentSeq: installment.seq, allocated: body.amountCny, installmentPaid: newlyPaid, holdStatus: nextStatus, warning };
    });
    auditHold(actor, 'ALLOCATE_HOLD_INSTALLMENT', result, { after: { receiptNo: result.receiptNo, installmentId, installmentSeq: result.installmentSeq, amountCny: result.allocated, installmentPaid: result.installmentPaid, holdStatus: result.holdStatus, warning: result.warning } });
    return result;
  }

  async reverseInstallmentAllocation(id: string, installmentId: string, allocationId: string, reason: string, actor: AuditActor) {
    const result = await prisma.$transaction(async (tx) => {
      const allocation = await tx.holdReceiptAllocation.findUnique({ where: { id: allocationId } });
      if (!allocation || allocation.holdOrderId !== id || allocation.holdInstallmentId !== installmentId || allocation.reversedAt) throw new NotFoundError('占位单认款记录不存在或已撤销');
      const receiptRows = await tx.$queryRaw<Array<{ id: string; receiptNo: string; amountCny: Prisma.Decimal; allocatedCny: Prisma.Decimal; status: ReceiptStatus }>>`
        SELECT id, "receiptNo", "amountCny", "allocatedCny", status FROM "Receipt" WHERE id = ${allocation.receiptId} FOR UPDATE
      `;
      const receipt = receiptRows[0];
      if (!receipt) throw new NotFoundError('进账不存在');
      if (receipt.status === ReceiptStatus.REFUNDED) throw new ConflictError(`进账 ${receipt.receiptNo} 已退款，无法撤销认款`);
      // 与 allocateInstallment 保持同一锁顺序：Receipt → HoldOrder，避免两个资金入口互相等待。
      const currentAllocation = await tx.holdReceiptAllocation.findUnique({ where: { id: allocationId } });
      if (!currentAllocation || currentAllocation.holdOrderId !== id || currentAllocation.holdInstallmentId !== installmentId || currentAllocation.reversedAt) throw new ConflictError('该笔占位单认款已被撤销，请刷新后重试');
      await lockHold(tx, id);
      const hold = await findHold(tx, id);
      if (!hold) throw new NotFoundError('占位单不存在');
      if (hold.conversions.length > 0) {
        throw new ConflictError('已有结转到订单的记录，撤销会造成资金重复使用，请先处理订单侧');
      }
      if (hold.status === HoldOrderStatus.CONVERTED) throw new ConflictError('占位单已转正，不能撤销认款');
      if (hold.reductions.length > 0) throw new ConflictError('占位单已有减员清算记录，不能撤销认款');
      const amount = money(currentAllocation.amountCny);
      const newAllocated = Math.max(0, money(receipt.allocatedCny) - amount);
      await tx.holdReceiptAllocation.update({ where: { id: allocationId }, data: { reversedAt: new Date() } });
      const receiptStatus = newAllocated <= 0
        ? ReceiptStatus.OPEN
        : newAllocated >= money(receipt.amountCny) ? ReceiptStatus.ALLOCATED : ReceiptStatus.PARTIALLY_ALLOCATED;
      await tx.receipt.update({ where: { id: receipt.id }, data: { allocatedCny: new Prisma.Decimal(newAllocated), status: receiptStatus } });
      const installment = hold.installments.find((item) => item.id === installmentId)!;
      const postInstallments = await syncInstallmentPaidStates(tx, id);
      const nowPaid = postInstallments.find((item) => item.id === installmentId)?.status === HoldInstallmentStatus.PAID;
      const first = [...postInstallments].sort((a, b) => a.seq - b.seq)[0];
      const firstPaid = first?.status === HoldInstallmentStatus.PAID;
      let nextStatus: HoldOrderStatus = hold.status;
      const occupiedStatuses: HoldOrderStatus[] = [HoldOrderStatus.HOLDING, HoldOrderStatus.OVERDUE, HoldOrderStatus.FULLY_PAID];
      const derived = deriveHoldStatus(hold, postInstallments, dateInTimezone(new Date(), hold.flightSchedule.departureTz));
      if (hold.occupyOn === HoldOccupyOn.FULL_PAYMENT && !firstPaid && occupiedStatuses.includes(hold.status)) nextStatus = HoldOrderStatus.PENDING;
      else if (hold.status !== HoldOrderStatus.PENDING || hold.occupyOn !== HoldOccupyOn.FULL_PAYMENT) nextStatus = derived;
      if (nextStatus !== hold.status) await tx.holdOrder.update({ where: { id }, data: { status: nextStatus } });
      return { holdNo: hold.holdNo, flightScheduleId: hold.flightScheduleId, receiptNo: receipt.receiptNo, installmentSeq: installment.seq, amount, newAllocated, holdStatus: nextStatus, reason };
    });
    auditHold(actor, 'REVERSE_HOLD_INSTALLMENT_ALLOCATION', { id, holdNo: result.holdNo, flightScheduleId: result.flightScheduleId }, { after: { installmentSeq: result.installmentSeq, allocationId, receiptNo: result.receiptNo, amountCny: result.amount, reason, holdStatus: result.holdStatus } });
    return result;
  }

  async updateInstallmentDueDate(id: string, installmentId: string, body: UpdateHoldInstallmentBody, actor: AuditActor) {
    const result = await prisma.$transaction(async (tx) => {
      await lockHold(tx, id);
      const hold = await findHold(tx, id);
      if (!hold) throw new NotFoundError('占位单不存在');
      const before = hold.installments.find((item) => item.id === installmentId);
      if (!before) throw new NotFoundError('收款期不存在');
      if (activeAllocationTotal(before) >= before.amountCny) throw new ConflictError('已认满的收款期不能调整截止日');
      const nextDueDate = new Date(`${body.dueDate}T00:00:00Z`);
      await tx.holdInstallment.update({ where: { id: installmentId }, data: { dueDate: nextDueDate } });
      await closeOpenHoldDueReminders(tx, installmentId, '收款期截止日已调整');
      const postInstallments = (await syncInstallmentPaidStates(tx, id)).map((item) => item.id === installmentId ? { ...item, dueDate: nextDueDate } : item);
      const derived = deriveHoldStatus(hold, postInstallments, dateInTimezone(new Date(), hold.flightSchedule.departureTz));
      const nextStatus = hold.status === HoldOrderStatus.PENDING && hold.occupyOn === HoldOccupyOn.FULL_PAYMENT
        ? HoldOrderStatus.PENDING
        : derived;
      if (nextStatus !== hold.status) await tx.holdOrder.update({ where: { id }, data: { status: nextStatus } });
      return { id: installmentId, dueDate: body.dueDate, hold, before, nextStatus };
    });
    auditHold(actor, 'UPDATE_HOLD_INSTALLMENT_DUE_DATE', result.hold, { before: { dueDate: result.before.dueDate }, after: { dueDate: body.dueDate, status: result.nextStatus } });
    return { id: installmentId, dueDate: body.dueDate, status: result.nextStatus };
  }

  async previewReduction(id: string, body: ReduceHoldSeatsBody) {
    const hold = await findHold(prisma, id);
    if (!hold) throw new NotFoundError('占位单不存在');
    return computeReduction(hold, hold.installments, body.seats);
  }

  async retryOccupy(id: string, actor?: AuditActor) {
    const result = await prisma.$transaction(async (tx) => {
      await lockHold(tx, id);
      const hold = await findHold(tx, id);
      if (!hold) throw new NotFoundError('占位单不存在');
      if (hold.status !== HoldOrderStatus.PENDING || hold.occupyOn !== HoldOccupyOn.FULL_PAYMENT) {
        throw new ConflictError('当前占位单不是待重试占座的切位单');
      }
      const allPaid = hold.installments.every((item) => item.amountCny === 0 || activeAllocationTotal(item) >= item.amountCny);
      if (!allPaid) throw new ConflictError('收款计划尚未全部认满，不能重试占座');
      const remaining = hold.seats - hold.seatsConverted - hold.seatsCancelled;
      const available = await availableSeatsForHold(tx, hold, remaining);
      if (available < 0) throw new ConflictError(`当前舱位仅剩 ${Math.max(0, available + remaining)} 张，仍不足以占 ${remaining} 张座`);
      const nextStatus = deriveHoldStatus(hold, hold.installments.map((item) => ({ ...item, allocatedCny: activeAllocationTotal(item) })), dateInTimezone(new Date(), hold.flightSchedule.departureTz));
      await tx.holdOrder.update({ where: { id }, data: { status: nextStatus } });
      return { id, hold, status: nextStatus, remaining };
    });
    auditHold(actor, 'RETRY_HOLD_OCCUPY', result.hold, { before: { status: HoldOrderStatus.PENDING }, after: { status: result.status, seats: result.remaining } });
    return { id, status: result.status };
  }

  private async reduceSeatsInTransaction(tx: Tx, id: string, body: ReduceHoldSeatsBody, actor?: AuditActor, action = 'REDUCE_HOLD_SEATS') {
    const hold = await findHold(tx, id);
    if (!hold) throw new NotFoundError('占位单不存在');
    const reducibleStatuses: HoldOrderStatus[] = [HoldOrderStatus.PENDING, HoldOrderStatus.HOLDING, HoldOrderStatus.OVERDUE, HoldOrderStatus.FULLY_PAID];
    if (!reducibleStatuses.includes(hold.status)) throw new ConflictError(`占位单当前状态不可减员（${HOLD_STATUS_LABEL[hold.status]}）`);
    const computation = computeReduction(hold, hold.installments, body.seats);
    const now = new Date();
    for (const update of computation.installmentUpdates) {
      await tx.holdInstallment.update({ where: { holdOrderId_seq: { holdOrderId: id, seq: update.seq } }, data: { amountCny: update.amountCny, seatsBasis: update.seatsBasis } });
    }
    const syncedInstallments = await syncInstallmentPaidStates(tx, id);
    for (const installment of syncedInstallments) {
      if (installment.status === HoldInstallmentStatus.PAID) await closeOpenHoldDueReminders(tx, installment.id, '清算后本期已结清');
    }
    await tx.holdReductionRecord.create({ data: { holdOrderId: id, seatsReduced: computation.seatsReduced, freeSeats: computation.freeSeats, forfeitSeats: computation.forfeitSeats, perSeatPaidCny: computation.perSeatPaidCny, forfeitCny: computation.forfeitCny, creditCny: computation.creditCny, surplusCny: computation.surplusCny, note: body.note ?? null, createdById: actor?.userId ?? 'system' } });
    const remaining = hold.seats - hold.seatsConverted - hold.seatsCancelled - body.seats;
    let nextStatus: HoldOrderStatus;
    if (remaining === 0) {
      nextStatus = HoldOrderStatus.CANCELLED;
      for (const installment of syncedInstallments) await closeOpenHoldDueReminders(tx, installment.id, '占位单已取消');
    } else if (hold.status === HoldOrderStatus.PENDING && hold.occupyOn === HoldOccupyOn.FULL_PAYMENT) {
      const first = syncedInstallments[0];
      const firstPaid = !!first && first.status === HoldInstallmentStatus.PAID;
      if (firstPaid && await availableSeatsForHold(tx, hold, remaining) >= 0) {
        nextStatus = deriveHoldStatus(hold, syncedInstallments, dateInTimezone(new Date(), hold.flightSchedule.departureTz));
      } else {
        nextStatus = HoldOrderStatus.PENDING;
      }
    } else {
      nextStatus = deriveHoldStatus(hold, syncedInstallments, dateInTimezone(new Date(), hold.flightSchedule.departureTz));
    }
    await tx.holdOrder.update({ where: { id }, data: { seatsCancelled: { increment: body.seats }, freeCancelUsed: { increment: computation.freeSeats }, status: nextStatus, ...(nextStatus === HoldOrderStatus.CANCELLED ? { cancelledAt: now } : {}) } });
    return { id, status: nextStatus, computation, holdNo: hold.holdNo, seatClassId: hold.seatClassId, flightScheduleId: hold.flightScheduleId, action };
  }

  async reduceSeats(id: string, body: ReduceHoldSeatsBody, actor?: AuditActor, action = 'REDUCE_HOLD_SEATS') {
    const result = await prisma.$transaction(async (tx) => {
      await lockHold(tx, id);
      return this.reduceSeatsInTransaction(tx, id, body, actor, action);
    });
    await enqueueWaitlist(result.seatClassId);
    auditHold(actor, action, { id, holdNo: result.holdNo, flightScheduleId: result.flightScheduleId }, { after: { ...result.computation, status: result.status, note: body.note } });
    return { id, status: result.status, ...result.computation };
  }
}

export type HoldReductionPreview = ReductionResult;
