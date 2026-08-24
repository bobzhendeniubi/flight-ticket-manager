import {
  AuditSeverity,
  AuditTargetType,
  HoldInstallmentStatus,
  HoldOrderStatus,
  HoldOverdueAction,
  type PrismaClient,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { writeAudit } from '../../lib/audit.js';
import { enqueueWaitlistCheck } from '../../queues/queue.js';
import { FALLBACK_HOLD_CONFIG, dateInTimezone } from './hold-installments.js';

/**
 * 每小时扫描一次。候选集只负责找出可能逾期的占座单；每条记录在事务中锁行、按该班次
 * departureTz 重算当地今日并再次确认，随后才写状态，避免扫描与认款并发时的无锁读窗口。
 */
export async function markOverdueHolds(client: PrismaClient = prisma, now = new Date()) {
  const config = await client.holdOrderConfig.findFirst({ select: { overdueAction: true } });
  const action = config?.overdueAction ?? HoldOverdueAction.REMIND_ONLY;
  const candidates = await client.holdOrder.findMany({
    where: { status: HoldOrderStatus.HOLDING },
    select: { id: true },
  });
  let marked = 0;
  let released = 0;
  for (const candidate of candidates) {
    const transition = await client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "HoldOrder" WHERE id = ${candidate.id} AND status = 'HOLDING'::"HoldOrderStatus" FOR UPDATE`;
      const hold = await tx.holdOrder.findUnique({
        where: { id: candidate.id },
        include: {
          installments: { where: { status: HoldInstallmentStatus.PENDING }, select: { dueDate: true } },
          flightSchedule: { select: { departureTz: true } },
        },
      });
      if (!hold || hold.status !== HoldOrderStatus.HOLDING) return null;
      const today = dateInTimezone(now, hold.flightSchedule.departureTz);
      if (!hold.installments.some((item) => item.dueDate.toISOString().slice(0, 10) < today)) return null;
      const nextStatus = action === HoldOverdueAction.AUTO_RELEASE ? HoldOrderStatus.RELEASED : HoldOrderStatus.OVERDUE;
      const updated = await tx.holdOrder.updateMany({
        where: { id: hold.id, status: HoldOrderStatus.HOLDING },
        data: action === HoldOverdueAction.AUTO_RELEASE ? { status: nextStatus, releasedAt: now } : { status: nextStatus },
      });
      return updated.count === 1 ? { id: hold.id, holdNo: hold.holdNo, seatClassId: hold.seatClassId, nextStatus, today } : null;
    });
    if (!transition) continue;
    if (transition.nextStatus === HoldOrderStatus.RELEASED) released++;
    else marked++;
    void writeAudit({
      actor: { label: 'system:hold-overdue', role: 'SYSTEM' },
      action: transition.nextStatus === HoldOrderStatus.RELEASED ? 'AUTO_RELEASE_OVERDUE_HOLD' : 'MARK_HOLD_OVERDUE',
      targetType: AuditTargetType.FLIGHT,
      targetId: transition.id,
      targetLabel: `占位单 ${transition.holdNo}`,
      after: { fromStatus: HoldOrderStatus.HOLDING, toStatus: transition.nextStatus, action, today: transition.today },
      severity: AuditSeverity.WARNING,
    });
    if (transition.nextStatus === HoldOrderStatus.RELEASED) {
      try {
        await enqueueWaitlistCheck(transition.seatClassId);
      } catch (err) {
        // 释放已在事务内完成；候补入队失败沿用库存 worker 的容错级别，仅记录日志。
        // eslint-disable-next-line no-console
        console.error('[hold-overdue] failed to enqueue waitlist-check', err);
      }
    }
  }
  return { marked, released, action, today: now.toISOString().slice(0, 10) };
}

export const DEFAULT_HOLD_OVERDUE_ACTION = FALLBACK_HOLD_CONFIG.overdueAction;
