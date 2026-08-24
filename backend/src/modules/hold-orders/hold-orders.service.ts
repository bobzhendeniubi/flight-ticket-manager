/** 占位单二期：收款计划、挂账池认款、逾期与减员清算。 */
import {
  AuditSeverity,
  AuditTargetType,
  HoldAmountRule,
  HoldInstallmentStatus,
  HoldOccupyOn,
  HoldOrderStatus,
  HoldOwnerType,
  HoldOverdueAction,
  Prisma,
  ReminderStatus,
  ReceiptStatus,
  SeatLockStatus,
} from '@prisma/client';
import { randomInt } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { AuditActor } from '../../lib/audit.js';
import { heldSeatsForSeatClass } from './held-seats.js';
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
  CreateHoldOrderBody,
  ListHoldOrdersQuery,
  ReduceHoldSeatsBody,
  UpdateHoldInstallmentBody,
  UpdateHoldOrderConfigBody,
  UpdateHoldOrderPriceBody,
  PreviewHoldPlanBody,
} from './hold-orders.schemas.js';
import { deriveHoldStatus } from './hold-status.js';

const HOLD_NO_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HOLD_STATUS_LABEL: Record<HoldOrderStatus, string> = {
  [HoldOrderStatus.PENDING]: '待生效',
  [HoldOrderStatus.HOLDING]: '占座中',
  [HoldOrderStatus.OVERDUE]: '逾期占座',
  [HoldOrderStatus.FULLY_PAID]: '已全款',
  [HoldOrderStatus.CONVERTED]: '已转正',
  [HoldOrderStatus.RELEASED]: '已释放',
  [HoldOrderStatus.CANCELLED]: '已取消',
};

type Tx = Prisma.TransactionClient;

function generateHoldNo(now = new Date()): string {
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += HOLD_NO_ALPHABET[randomInt(HOLD_NO_ALPHABET.length)];
  return `H${date}${suffix}`;
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

export class HoldOrderService {
  async create(body: CreateHoldOrderBody, createdById: string, actor?: AuditActor) {
    if (body.ownerType === HoldOwnerType.AGENT && !body.agentId) throw new BadRequestError('代理占位必须选择代理');
    if (body.ownerType === HoldOwnerType.CUSTOMER && !body.groupName?.trim()) throw new BadRequestError('直客占位必须填写团名或客户备注名');

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const holdOrder = await prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<Array<{ id: string; scheduleId: string; capacity: number; sold: number }>>`
            SELECT id, "scheduleId", capacity, sold FROM "FlightSeatClass"
            WHERE "scheduleId" = ${body.flightScheduleId} AND cabin = ${body.cabin}::"CabinClass" FOR UPDATE
          `;
          const seatClass = rows[0];
          if (!seatClass) throw new NotFoundError('舱位不存在');
          if (body.ownerType === HoldOwnerType.AGENT) {
            const agent = await tx.agent.findUnique({ where: { id: body.agentId! }, select: { id: true } });
            if (!agent) throw new NotFoundError('代理不存在');
          }

          const now = new Date();
          const mode = body.mode ?? 'RESERVE';
          if (mode === 'RESERVE') {
            const remaining = await seatsAvailableForNewHold(tx, seatClass.id, body.seats);
            if (remaining < 0) throw new ConflictError(`余票不足：需要占位 ${body.seats} 张，仅剩 ${Math.max(0, remaining + body.seats)} 张可占`);
          }

          const scheduleDelegate = (tx as unknown as { flightSchedule?: { findUnique: (args: unknown) => Promise<{ departureTime: Date; departureTz: string } | null> } }).flightSchedule;
          const schedule = scheduleDelegate
            ? await scheduleDelegate.findUnique({ where: { id: body.flightScheduleId }, select: { departureTime: true, departureTz: true } })
            : { departureTime: now, departureTz: 'UTC' };
          if (!schedule) throw new NotFoundError('航班班次不存在');

          const config = await readConfig(tx);
          let installments;
          let occupyOn: HoldOccupyOn;
          let status: HoldOrderStatus;
          if (mode === 'ALLOTMENT') {
            occupyOn = HoldOccupyOn.FULL_PAYMENT;
            status = HoldOrderStatus.PENDING;
            installments = [{ seq: 1, label: '全款', amountRule: HoldAmountRule.REMAINDER, perPersonCny: null, amountCny: body.seats * body.perSeatPriceCny, seatsBasis: body.seats, dueDate: new Date(`${dateInTimezone(now, schedule.departureTz)}T00:00:00Z`) }];
          } else {
            occupyOn = HoldOccupyOn.CREATE;
            status = HoldOrderStatus.HOLDING;
            installments = body.installmentsOverride
              ? buildInstallmentsFromOverride({ seats: body.seats, perSeatPriceCny: body.perSeatPriceCny, createdAt: now, departureTz: schedule.departureTz, overrides: body.installmentsOverride as HoldInstallmentOverride[] })
              : foldInstallments({ seats: body.seats, perSeatPriceCny: body.perSeatPriceCny, createdAt: now, departureTime: schedule.departureTime, departureTz: schedule.departureTz, templates: configTemplates(config.installments) });
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

          const created = await tx.holdOrder.create({
            data: {
              holdNo: generateHoldNo(now),
              flightScheduleId: body.flightScheduleId,
              seatClassId: seatClass.id,
              ownerType: body.ownerType,
              agentId: body.ownerType === HoldOwnerType.AGENT ? body.agentId! : null,
              groupName: body.groupName?.trim() ?? null,
              seats: body.seats,
              perSeatPriceCny: body.perSeatPriceCny,
              freeCancelRatio: new Prisma.Decimal(body.freeCancelRatio ?? Number(config.defaultFreeCancelRatio)),
              occupyOn,
              notes: body.notes?.trim() ?? null,
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
          return created;
        });
        auditHold(actor, 'CREATE_HOLD_ORDER', holdOrder, { after: { holdNo: holdOrder.holdNo, seats: holdOrder.seats, perSeatPriceCny: holdOrder.perSeatPriceCny, occupyOn: holdOrder.occupyOn, status: holdOrder.status } });
        return holdOrder;
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
      where: {
        ...(query.flightScheduleId ? { flightScheduleId: query.flightScheduleId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.agentId ? { agentId: query.agentId } : {}),
      },
      include: {
        installments: { orderBy: { seq: 'asc' }, include: { allocations: true } },
        seatClass: { select: { cabin: true } },
        flightSchedule: { select: { id: true, departureTime: true, departureTz: true, flight: { select: { flightNumber: true } } } },
        agent: { select: { id: true, companyName: true, contactName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.sort((a, b) => (a.status === HoldOrderStatus.OVERDUE ? -1 : 0) - (b.status === HoldOrderStatus.OVERDUE ? -1 : 0));
  }

  async getById(id: string) {
    const holdOrder = await findHold(prisma, id);
    if (!holdOrder) throw new NotFoundError('占位单不存在');
    return holdOrder;
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
      if (nextStatus === HoldOrderStatus.CANCELLED) {
        for (const installment of existing.installments) await closeOpenHoldDueReminders(tx, installment.id, '占位单已取消');
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
      const historicalForfeitCny = existing.reductions.reduce((sum, row) => sum + row.forfeitCny, 0);
      const historicalSurplusCny = existing.reductions.reduce((sum, row) => sum + row.surplusCny, 0);
      // 计划总额守恒：Σ期应收 = 剩余合同额 + 历史没收 + 历史挂账（历史损益是已实收但
      // 不再归属剩余人的钱，其所在期金额不随改价缩水，故加回而非扣减——扣减会少收 2L）。
      const adjustedContractCny = remainingSeats * body.perSeatPriceCny + historicalForfeitCny + historicalSurplusCny;
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
