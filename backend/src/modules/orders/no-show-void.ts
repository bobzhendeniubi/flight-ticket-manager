/**
 * 回程「起飞后自动作废」的后台扫描（每小时一次，样板同占位单逾期扫描 hold-overdue）。
 *
 * 为什么要有它：去程 no-show 把回程座位放回库存后，这一行会停在「已释放」态等人处置。
 * 客人要飞就点「恢复回程」；不飞的话，原班次一飞走恢复窗口就关了，而这一行还挂在单上没有
 * 终态 —— 提醒规则会一直催（起飞后换成「请确认作废」那一条），没人来点就永远催不完。
 * 本 job 在原班次起飞满 2 小时后把它推到终态，运营手上那条待办也一并关掉。
 *
 * ⚠ 只打一个终态标：**座位不动**（释放那一步早就还回库存了）、**钱不动**
 *（no-show 全程钱不动；要退钱走既有退款流程）、开票位不动。
 *
 * 为什么留 2 小时缓冲：起飞时刻是计划时刻，延误/换班次都可能让「已经过了起飞点」的判断
 * 提前于事实。缓冲期内运营仍然点得动「恢复回程」（那条路只看班次时间，不看本 job），
 * 真要恢复的单不会被系统抢先作废掉。
 *
 * 幂等：已经有 returnVoidedFinal 的行直接跳过；每条单独事务、单独行锁，一条失败不影响其余。
 */
import {
  AuditSeverity,
  AuditTargetType,
  OrderItemKind,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { writeAudit } from '../../lib/audit.js';
import { isReturnCurrentlyReleased } from './orders.leg-status.js';
import { voidReleasedReturnLegWithinTx } from './orders.service.js';

/**
 * 起飞后到自动作废之间的缓冲（毫秒）。
 * 计划起飞时刻不等于实际起飞，留一段时间给运营在延误/换班次的场景里手工处置。
 */
export const RETURN_VOID_DEPARTED_GRACE_MS = 2 * 60 * 60 * 1000;

export interface VoidDepartedReleasedResult {
  /** 本轮扫到的候选行数。 */
  scanned: number;
  /** 实际推到终态的行数。 */
  voided: number;
  /** 本轮的批次标识（进快照与审计，便于把一批自动作废归到同一次扫描）。 */
  jobId: string;
}

/** 本轮真正作废掉的一行（供扫描主循环在事务外写审计）。 */
type VoidedRow = { orderId: string; orderNumber: string; itemId: string; scheduleId: string };

/** 防御式读 JSON 对象（形状不符按空对象处理）。 */
function readObject(raw: unknown): Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * 扫描并作废「原班次已起飞满 2 小时、仍停在已释放态」的回程行。
 *
 * 候选集只负责粗筛（FLIGHT 行 + 班次为空 + 有 returnReleased 快照）；
 * 「现在到底还是不是已释放态」「原班次到底飞了没有」都在逐条的事务里、拿到订单行锁之后
 * 重新判一遍 —— 扫描与人工恢复/再释放并发时，锁外读到的状态随时可能是旧的。
 */
export async function voidDepartedReleasedReturnLegs(
  client: PrismaClient = defaultPrisma,
  now = new Date(),
): Promise<VoidDepartedReleasedResult> {
  const jobId = `noshow-void-${now.toISOString()}`;
  const cutoff = new Date(now.getTime() - RETURN_VOID_DEPARTED_GRACE_MS);

  const candidates = await client.orderItem.findMany({
    where: {
      kind: OrderItemKind.FLIGHT,
      // 释放的口径就是「班次置空」，占着班次的行一律不是候选。
      flightScheduleId: null,
      metadata: { path: ['returnReleased'], not: Prisma.DbNull },
    },
    select: { id: true, orderId: true, metadata: true },
  });

  const voidedRows: VoidedRow[] = [];
  for (const candidate of candidates) {
    // 已经作废过的、或恢复后又被释放但快照顺序不成立的，在粗筛阶段就滤掉，省一次事务往返。
    const stillReleased = isReturnCurrentlyReleased({
      kind: 'FLIGHT',
      flightScheduleId: null,
      metadata: candidate.metadata,
    });
    if (!stillReleased) continue;
    const rawScheduleId = readObject(readObject(candidate.metadata).returnReleased)
      .originalScheduleId;
    if (typeof rawScheduleId !== 'string' || rawScheduleId === '') continue;
    const scheduleId = rawScheduleId;

    const done = await client.$transaction(async (tx): Promise<VoidedRow | null> => {
      // 与 no-show / 恢复 / 取消航段 / 人工作废同一把行锁：这几条路径都在改同一批 FLIGHT 行。
      const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${candidate.orderId} FOR UPDATE
      `;
      if (lockRows.length === 0) return null;

      const item = await tx.orderItem.findUnique({
        where: { id: candidate.id },
        select: { id: true, orderId: true, metadata: true, flightScheduleId: true, kind: true },
      });
      // 锁内重判：拿锁期间可能已经被人工恢复（占回班次）或人工作废了。
      if (!item || !isReturnCurrentlyReleased(item)) return null;

      const schedule = await tx.flightSchedule.findUnique({
        where: { id: scheduleId },
        select: { departureTime: true },
      });
      // 班次查不到 → 判不出飞没飞，交人工（订单详情的「作废回程」放行这一档）。
      if (!schedule || schedule.departureTime.getTime() > cutoff.getTime()) return null;

      const order = await tx.order.findUnique({
        where: { id: item.orderId },
        select: { orderNumber: true, adjustments: true },
      });
      if (!order) return null;

      await voidReleasedReturnLegWithinTx(tx, {
        orderId: item.orderId,
        item,
        adjustments: order.adjustments,
        at: now,
        byUserId: 'SYSTEM',
        jobId,
        note: null,
      });
      return {
        orderId: item.orderId,
        orderNumber: order.orderNumber,
        itemId: item.id,
        scheduleId,
      };
    });
    if (!done) continue;

    voidedRows.push(done);
    // 审计在事务外写（口径同 hold-overdue）：这一步不改钱不改座，审计落不落库不影响正确性，
    // 不值得为它把整条作废回滚。
    void writeAudit({
      actor: { label: 'system:no-show-void', role: 'SYSTEM' },
      action: 'VOID_RETURN_LEG',
      targetType: AuditTargetType.ORDER,
      targetId: done.orderId,
      targetLabel: `${done.orderNumber} · 回程过期作废（原班次已起飞）`,
      after: {
        returnItemId: done.itemId,
        scheduleId: done.scheduleId,
        jobId,
        graceMs: RETURN_VOID_DEPARTED_GRACE_MS,
        auto: true,
      },
      severity: AuditSeverity.WARNING,
    });
  }

  return { scanned: candidates.length, voided: voidedRows.length, jobId };
}
