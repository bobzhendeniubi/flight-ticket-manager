/**
 * 占位单服务 — 为旅游团留位、代理切位、散客占位提供无名单库存实体。
 *
 * 座位口径：capacity − sold − 未过期 ACTIVE 锁位 − 占位余座。
 * 本期只做建单、释放、取消、锁定结算价与审计；占位单不承载乘客名单，不创建收款计划。
 */
import {
  AuditSeverity,
  AuditTargetType,
  HoldOrderStatus,
  HoldOwnerType,
  Prisma,
  SeatLockStatus,
} from '@prisma/client';
import { randomInt } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError, BadRequestError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { AuditActor } from '../../lib/audit.js';
import { heldSeatsForSeatClass } from './held-seats.js';
import type {
  CreateHoldOrderBody,
  ListHoldOrdersQuery,
  UpdateHoldOrderPriceBody,
} from './hold-orders.schemas.js';

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

function generateHoldNo(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += HOLD_NO_ALPHABET[randomInt(HOLD_NO_ALPHABET.length)];
  return `H${y}${m}${d}${suffix}`;
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

export class HoldOrderService {
  async create(body: CreateHoldOrderBody, createdById: string, actor?: AuditActor) {
    if (body.ownerType === HoldOwnerType.AGENT && !body.agentId) {
      throw new BadRequestError('代理占位必须选择代理');
    }
    if (body.ownerType === HoldOwnerType.CUSTOMER && !body.groupName?.trim()) {
      throw new BadRequestError('直客占位必须填写团名或客户备注名');
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const holdOrder = await prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<
            Array<{ id: string; scheduleId: string; capacity: number; sold: number }>
          >`
            SELECT id, "scheduleId", capacity, sold
            FROM "FlightSeatClass"
            WHERE "scheduleId" = ${body.flightScheduleId}
              AND cabin = ${body.cabin}::"CabinClass"
            FOR UPDATE
          `;
          const seatClass = rows[0];
          if (!seatClass) throw new NotFoundError('舱位不存在');

          if (body.ownerType === HoldOwnerType.AGENT) {
            const agent = await tx.agent.findUnique({
              where: { id: body.agentId! },
              select: { id: true },
            });
            if (!agent) throw new NotFoundError('代理不存在');
          }

          const locked = await tx.seatLock.aggregate({
            _sum: { qty: true },
            where: {
              seatClassId: seatClass.id,
              status: SeatLockStatus.ACTIVE,
              expiresAt: { gt: new Date() },
            },
          });
          const held = await heldSeatsForSeatClass(tx, seatClass.id);
          const lockedQty = locked._sum.qty ?? 0;
          const available = seatClass.capacity - seatClass.sold - lockedQty - held;
          if (body.seats > available) {
            throw new ConflictError(
              `余票不足：需要占位 ${body.seats} 张，仅剩 ${Math.max(0, available)} 张可占`,
            );
          }

          return tx.holdOrder.create({
            data: {
              holdNo: generateHoldNo(),
              flightScheduleId: body.flightScheduleId,
              seatClassId: seatClass.id,
              ownerType: body.ownerType,
              agentId: body.ownerType === HoldOwnerType.AGENT ? body.agentId! : null,
              groupName: body.groupName?.trim() ?? null,
              seats: body.seats,
              perSeatPriceCny: body.perSeatPriceCny,
              freeCancelRatio: body.freeCancelRatio ?? null,
              notes: body.notes?.trim() ?? null,
              createdById,
              status: HoldOrderStatus.HOLDING,
            },
          });
        });

        auditHold(actor, 'CREATE_HOLD_ORDER', holdOrder, {
          after: {
            holdNo: holdOrder.holdNo,
            flightScheduleId: holdOrder.flightScheduleId,
            seatClassId: holdOrder.seatClassId,
            ownerType: holdOrder.ownerType,
            agentId: holdOrder.agentId,
            seats: holdOrder.seats,
            perSeatPriceCny: holdOrder.perSeatPriceCny,
            status: holdOrder.status,
          },
        });
        return holdOrder;
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 2) throw error;
      }
    }
    throw new ConflictError('占位单号生成失败，请稍后重试');
  }

  async list(query: ListHoldOrdersQuery) {
    return prisma.holdOrder.findMany({
      where: {
        ...(query.flightScheduleId ? { flightScheduleId: query.flightScheduleId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.agentId ? { agentId: query.agentId } : {}),
      },
      include: {
        seatClass: { select: { cabin: true } },
        flightSchedule: {
          select: {
            id: true,
            departureTime: true,
            flight: { select: { flightNumber: true } },
          },
        },
        agent: { select: { id: true, companyName: true, contactName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string) {
    const holdOrder = await prisma.holdOrder.findUnique({
      where: { id },
      include: {
        seatClass: { select: { cabin: true } },
        flightSchedule: {
          select: {
            id: true,
            departureTime: true,
            flight: { select: { flightNumber: true } },
          },
        },
        agent: { select: { id: true, companyName: true, contactName: true } },
      },
    });
    if (!holdOrder) throw new NotFoundError('占位单不存在');
    return holdOrder;
  }

  async release(id: string, actor?: AuditActor) {
    return this.changeHoldingStatus(id, HoldOrderStatus.RELEASED, 'releasedAt', 'RELEASE_HOLD_ORDER', actor);
  }

  async cancel(id: string, actor?: AuditActor) {
    return this.changeHoldingStatus(id, HoldOrderStatus.CANCELLED, 'cancelledAt', 'CANCEL_HOLD_ORDER', actor);
  }

  private async changeHoldingStatus(
    id: string,
    nextStatus: HoldOrderStatus,
    timestampField: 'releasedAt' | 'cancelledAt',
    action: string,
    actor?: AuditActor,
  ) {
    const existing = await prisma.holdOrder.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('占位单不存在');

    const updated = await prisma.holdOrder.updateMany({
      where: { id, status: HoldOrderStatus.HOLDING },
      data: { status: nextStatus, [timestampField]: new Date() },
    });
    if (updated.count !== 1) {
      throw new ConflictError(`占位单当前状态不可操作（${HOLD_STATUS_LABEL[existing.status]}）`);
    }

    auditHold(actor, action, existing, {
      before: { status: existing.status },
      after: { status: nextStatus, [timestampField]: '已记录' },
    });

    // 占位释放后可能补出公共余量：尽快触发候补检查；排队失败不阻塞库存释放。
    try {
      const { enqueueWaitlistCheck } = await import('../../queues/queue.js');
      await enqueueWaitlistCheck(existing.seatClassId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[hold-orders] failed to enqueue waitlist-check for', id, err);
    }
    return { id, status: nextStatus };
  }

  async updatePrice(id: string, body: UpdateHoldOrderPriceBody, actor?: AuditActor) {
    const existing = await prisma.holdOrder.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('占位单不存在');
    if (existing.status !== HoldOrderStatus.HOLDING) {
      throw new ConflictError(`占位单当前状态不可改价（${HOLD_STATUS_LABEL[existing.status]}）`);
    }

    const updated = await prisma.holdOrder.updateMany({
      where: { id, status: HoldOrderStatus.HOLDING },
      data: { perSeatPriceCny: body.perSeatPriceCny },
    });
    if (updated.count !== 1) throw new ConflictError('占位单状态已变化，请刷新后重试');

    auditHold(actor, 'UPDATE_HOLD_ORDER_PRICE', existing, {
      before: { perSeatPriceCny: existing.perSeatPriceCny },
      after: { perSeatPriceCny: body.perSeatPriceCny, reason: body.reason },
    });
    return { id, perSeatPriceCny: body.perSeatPriceCny };
  }
}
