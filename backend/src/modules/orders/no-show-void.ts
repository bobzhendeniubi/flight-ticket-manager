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
 * 幂等：已经有 returnVoidedFinal 的行在**候选集里就被排除**；每条单独事务、单独行锁。
 * 容错：主循环逐条 try/catch —— 一条失败只计进 failed 并打一条带 orderId 的日志，整轮照常
 * 跑完并正常返回。一条异常把整轮打断，等于「排在它后面的单今天全不处理」，而本 job 每小时
 * 才跑一次，下一轮之前那些单一直挂着。
 */
import {
  AuditSeverity,
  AuditTargetType,
  OrderItemKind,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { writeAuditWithinTx } from '../../lib/audit.js';
import { isReturnCurrentlyReleased } from './orders.leg-status.js';
import { voidReleasedReturnLegWithinTx } from './orders.service.js';

/**
 * 起飞后到自动作废之间的缓冲（毫秒）。
 * 计划起飞时刻不等于实际起飞，留一段时间给运营在延误/换班次的场景里手工处置。
 */
export const RETURN_VOID_DEPARTED_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * 单页候选行数（按 id 游标翻页）。
 * 一次 findMany 把全库的候选行连 metadata 一起捞进内存，随着存量增长迟早把这台 job 撑爆。
 */
export const VOID_SCAN_PAGE_SIZE = 500;

export interface VoidDepartedReleasedResult {
  /** 本轮扫到的候选行数。 */
  scanned: number;
  /** 实际推到终态的行数。 */
  voided: number;
  /** 本轮处理失败的行数（原因已打到 console.error，整轮不中断）。 */
  failed: number;
  /** 本轮的批次标识（进快照与审计，便于把一批自动作废归到同一次扫描）。 */
  jobId: string;
}

/** 防御式读 JSON 对象（形状不符按空对象处理）。 */
function readObject(raw: unknown): Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** 候选行的最小形状（粗筛只读这三列）。 */
type VoidScanCandidate = { id: string; orderId: string; metadata: Prisma.JsonValue };

/**
 * 扫描并作废「原班次已起飞满 2 小时、仍停在已释放态」的回程行。
 *
 * 候选集只负责粗筛（FLIGHT 行 + 班次为空 + 有 returnReleased 快照 + 尚无 returnVoidedFinal
 * + 订单不在回收站）；「现在到底还是不是已释放态」「原班次到底飞了没有」都在逐条的事务里、
 * 拿到订单行锁之后重新判一遍 —— 扫描与人工恢复/再释放并发时，锁外读到的状态随时可能是旧的。
 */
export async function voidDepartedReleasedReturnLegs(
  client: PrismaClient = defaultPrisma,
  now = new Date(),
): Promise<VoidDepartedReleasedResult> {
  const jobId = `noshow-void-${now.toISOString()}`;
  const cutoff = new Date(now.getTime() - RETURN_VOID_DEPARTED_GRACE_MS);

  // 粗筛条件，两条是这次补上的：
  //   · 已经作废过的行（returnVoidedFinal 非空）让**数据库**筛掉，不是捞回内存逐条 continue——
  //     存量作废行只会越来越多，全捞回来纯属白花内存与带宽；
  //   · 回收站里的单（order.deletedAt 非空）不处理：全站导出/报表都不认它们，
  //     job 去给一张已软删的单打终态标，只会在审计里留下一条谁也看不懂的记录。
  const where: Prisma.OrderItemWhereInput = {
    kind: OrderItemKind.FLIGHT,
    // 释放的口径就是「班次置空」，占着班次的行一律不是候选。
    flightScheduleId: null,
    order: { deletedAt: null },
    AND: [
      { metadata: { path: ['returnReleased'], not: Prisma.DbNull } },
      { metadata: { path: ['returnVoidedFinal'], equals: Prisma.DbNull } },
    ],
  };

  let scanned = 0;
  let voided = 0;
  let failed = 0;
  let cursor: string | null = null;

  for (;;) {
    const page: VoidScanCandidate[] = await client.orderItem.findMany({
      where,
      // 游标翻页按 id 单调前进：本轮处理过的行会退出候选集（落了 returnVoidedFinal），
      // 用 skip/offset 会因此漏行，用 id 游标不会。
      orderBy: { id: 'asc' },
      take: VOID_SCAN_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, orderId: true, metadata: true },
    });
    if (page.length === 0) break;
    scanned += page.length;
    cursor = page[page.length - 1]?.id ?? null;

    for (const candidate of page) {
      // 一条失败绝不带倒整轮：计进 failed、打一条带 orderId 的错误日志，接着跑下一条。
      try {
        const done = await voidOneCandidate(client, candidate, { cutoff, now, jobId });
        if (done) voided += 1;
      } catch (err) {
        failed += 1;
        console.error(
          `[no-show-void] 回程自动作废失败：orderId=${candidate.orderId} itemId=${candidate.id}`,
          err,
        );
      }
    }

    if (page.length < VOID_SCAN_PAGE_SIZE || cursor == null) break;
  }

  return { scanned, voided, failed, jobId };
}

/**
 * 处理一条候选行：锁 → 锁内重判 → 落终态 → 事务内写审计。
 * 返回 true = 真的推到了终态；false = 这一条不该处理（并发被人改过 / 班次没飞 / 快照不成立）。
 */
async function voidOneCandidate(
  client: PrismaClient,
  candidate: VoidScanCandidate,
  ctx: { cutoff: Date; now: Date; jobId: string },
): Promise<boolean> {
  // 恢复后又被释放、但快照顺序不成立的，在进事务之前就滤掉，省一次往返。
  const stillReleased = isReturnCurrentlyReleased({
    kind: 'FLIGHT',
    flightScheduleId: null,
    metadata: candidate.metadata,
  });
  if (!stillReleased) return false;
  const rawScheduleId = readObject(readObject(candidate.metadata).returnReleased).originalScheduleId;
  if (typeof rawScheduleId !== 'string' || rawScheduleId === '') return false;
  const scheduleId = rawScheduleId;

  return client.$transaction(async (tx): Promise<boolean> => {
    // 与 no-show / 恢复 / 取消航段 / 人工作废同一把行锁：这几条路径都在改同一批 FLIGHT 行。
    const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${candidate.orderId} FOR UPDATE
    `;
    if (lockRows.length === 0) return false;

    const item = await tx.orderItem.findUnique({
      where: { id: candidate.id },
      select: { id: true, orderId: true, metadata: true, flightScheduleId: true, kind: true },
    });
    // 锁内重判：拿锁期间可能已经被人工恢复（占回班次）或人工作废了。
    if (!item || !isReturnCurrentlyReleased(item)) return false;

    const schedule = await tx.flightSchedule.findUnique({
      where: { id: scheduleId },
      select: { departureTime: true },
    });
    // 班次查不到 → 判不出飞没飞，交人工（订单详情的「作废回程」放行这一档）。
    if (!schedule || schedule.departureTime.getTime() > ctx.cutoff.getTime()) return false;

    const order = await tx.order.findUnique({
      where: { id: item.orderId },
      select: { orderNumber: true, adjustments: true },
    });
    if (!order) return false;

    await voidReleasedReturnLegWithinTx(tx, {
      orderId: item.orderId,
      item,
      adjustments: order.adjustments,
      at: ctx.now,
      byUserId: 'SYSTEM',
      jobId: ctx.jobId,
      note: null,
    });

    // 审计**在事务内**写：这是一条无人值守的自动动作，审计是事后唯一的现场。
    // 放到事务外 fire-and-forget，一旦事务因冲突回滚重试，作废可能落了库而审计补不回来 ——
    // 运营看到回程凭空变成「已作废」，却查不到任何一条记录说明是谁、什么时候改的。
    await writeAuditWithinTx(tx, {
      actor: { label: 'system:no-show-void', role: 'SYSTEM' },
      action: 'VOID_RETURN_LEG',
      targetType: AuditTargetType.ORDER,
      targetId: item.orderId,
      targetLabel: `${order.orderNumber} · 回程过期作废（原班次已起飞）`,
      after: {
        returnItemId: item.id,
        scheduleId,
        jobId: ctx.jobId,
        graceMs: RETURN_VOID_DEPARTED_GRACE_MS,
        auto: true,
      },
      severity: AuditSeverity.WARNING,
    });
    return true;
  });
}
