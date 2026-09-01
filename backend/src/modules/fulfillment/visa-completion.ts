/**
 * 订单级签证办结派生 —— 「材料送出去就算」（签证岗 2026-08-30 定的时点）。
 *
 * 口径：本单**非自备签**乘客全部标到「已送签」（visaSubmissionStatus=CONFIRMED），
 * 且本单确有我方签证任务（存在非 CANCELLED 的 VISA_APPLICATION）→ 订单 visaStatus
 * 自动写 HAS_VISA（已签证）。签证岗从此不用回头改订单状态，订单列表/导出徽标随之变绿。
 *
 * 回退对称：任一乘客从已送签退回 → 若订单的已签证是**本派生写的**（以审计里最近一条
 * AUTO_COMPLETE_VISA / AUTO_COMPLETE_VISA_REVERT 判定），恢复办结前的原档（写入时存在
 * 审计 before 里）。录单人手选的「已签证」（客人自带签证）没有办结审计，不受回退影响。
 *
 * 为什么用审计流水而不是加列：办结来源只在「回退」这一处需要，且审计本就要留
 * （谁把单标成已签证是要能查的）；fire-and-forget 的审计极小概率写失败时，仅损失
 * 自动回退（可人工改回），不影响任何钱与任务的正确性。
 *
 * 调用点约定：任何写 Passenger.visaSubmissionStatus 的路径完成后调用（不在事务内，
 * 与 writeAudit 同一「主操作成功才派生」的时序）。幂等：重复调用无副作用。
 */
import { FulfillmentStatus, FulfillmentType, VisaRequirement, VisaSubmissionStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { isVisaContradiction } from '../orders/visa-need.js';

/** 办结派生审计动作名（写/回退共用，回退时按最近一条判断来源）。 */
export const VISA_AUTO_COMPLETE_ACTION = 'AUTO_COMPLETE_VISA';
export const VISA_AUTO_COMPLETE_REVERT_ACTION = 'AUTO_COMPLETE_VISA_REVERT';

export type VisaCompletionOutcome =
  | { changed: false }
  | { changed: true; kind: 'COMPLETED'; orderNumber: string }
  | { changed: true; kind: 'REVERTED'; orderNumber: string; restoredTo: VisaRequirement };

/**
 * 重算并落写一个订单的「已签证」办结状态。返回本次是否改动（调用方可用于回显/汇总）。
 */
export async function syncOrderVisaCompletion(
  orderId: string,
  actor: AuditActor,
): Promise<VisaCompletionOutcome> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, visaStatus: true, deletedAt: true },
  });
  // 回收站单不派生：签证台本就看不见它，别在暗处翻状态。
  if (!order || order.deletedAt) return { changed: false };

  const [roster, ourVisaTaskCount] = await Promise.all([
    // 取全名单（不在 where 里滤 visaExempt）：办结判定只看非自备签那部分，但下面的
    // 回退矛盾闸要区分「全员自备签」与「一位乘客都没录」，得看得见整张名单。
    prisma.passenger.findMany({
      where: { orderId },
      select: { visaSubmissionStatus: true, visaExempt: true },
    }),
    // 「确有我方签证任务」：全员自备签/录单已签证的单不建任务，也就永远不会被这里翻状态。
    prisma.fulfillmentTask.count({
      where: {
        orderItem: { orderId },
        type: FulfillmentType.VISA_APPLICATION,
        status: { not: FulfillmentStatus.CANCELLED },
      },
    }),
  ]);

  const passengers = roster.filter((p) => !p.visaExempt);
  const allConfirmed =
    passengers.length > 0 &&
    passengers.every((p) => p.visaSubmissionStatus === VisaSubmissionStatus.CONFIRMED);

  if (allConfirmed && ourVisaTaskCount > 0) {
    if (order.visaStatus === VisaRequirement.HAS_VISA) return { changed: false };
    await prisma.order.update({
      where: { id: orderId },
      data: { visaStatus: VisaRequirement.HAS_VISA },
    });
    await writeAudit({
      actor,
      action: VISA_AUTO_COMPLETE_ACTION,
      targetType: 'ORDER',
      targetId: orderId,
      targetLabel: order.orderNumber,
      before: { visaStatus: order.visaStatus },
      after: { visaStatus: VisaRequirement.HAS_VISA, reason: '全员已送签，系统自动办结' },
    });
    return { changed: true, kind: 'COMPLETED', orderNumber: order.orderNumber };
  }

  // 未达办结条件：仅当现值 HAS_VISA 且是本派生写的才回退。
  if (order.visaStatus !== VisaRequirement.HAS_VISA) return { changed: false };
  const lastAuto = await prisma.auditLog.findFirst({
    where: {
      targetType: 'ORDER',
      targetId: orderId,
      action: { in: [VISA_AUTO_COMPLETE_ACTION, VISA_AUTO_COMPLETE_REVERT_ACTION] },
    },
    orderBy: { createdAt: 'desc' },
    select: { action: true, before: true },
  });
  if (!lastAuto || lastAuto.action !== VISA_AUTO_COMPLETE_ACTION) return { changed: false };

  const beforeStatus = (lastAuto.before as { visaStatus?: string } | null)?.visaStatus;
  const restoredTo =
    beforeStatus && (Object.values(VisaRequirement) as string[]).includes(beforeStatus)
      ? (beforeStatus as VisaRequirement)
      : VisaRequirement.NEEDED;
  // 回退前的矛盾闸：本单现在已全员自备签时，把订单级恢复成「需要签证 / 电子签」会造出
  // 「订单说要我方办、却没有一位出行人要办」的矛盾单 —— 不建任务、签证台看不见（判定见
  // visa-need.ts 的 isVisaContradiction），正是要根治的漏签形态。此时保留「已签证」不回退：
  // 全员自备签下客人签证已自持，签证岗本就无事可做。乘客级 visaExempt 一概不碰。
  // （常规回退——名单里还有人随团办签、只是进度退回——不受影响。）
  if (isVisaContradiction({ visaStatus: restoredTo, passengers: roster })) {
    return { changed: false };
  }
  await prisma.order.update({
    where: { id: orderId },
    data: { visaStatus: restoredTo },
  });
  await writeAudit({
    actor,
    action: VISA_AUTO_COMPLETE_REVERT_ACTION,
    targetType: 'ORDER',
    targetId: orderId,
    targetLabel: order.orderNumber,
    before: { visaStatus: VisaRequirement.HAS_VISA },
    after: { visaStatus: restoredTo, reason: '送签进度回退，自动撤销办结' },
  });
  return { changed: true, kind: 'REVERTED', orderNumber: order.orderNumber, restoredTo };
}
