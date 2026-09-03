/**
 * 按航班批量 no-show —— 票务每天照航司名单处理的正路。
 *
 * 现状（单单点）：航司发来一班几十人的 no-show 名单，票务得一张单一张单地搜、点开、勾人、
 * 确认，一班处理下来半小时起，还容易漏。本模块把它变成「贴名单 → 看匹配结果 → 一键执行」。
 *
 * 两个端点，两件事：
 *   · batch-preview —— **只读**。贴进来的名单逐行匹配到本班次去程占座单的乘客，
 *     并按**既有单单口径**（service.previewNoShow → _assessNoShow）逐单算 eligible/blockers。
 *     预检口径与执行口径同源，杜绝「预检放行、执行另算」。
 *   · batch        —— 逐单调既有 markNoShow，**一单一事务**，一单失败不影响其它单。
 *
 * ⚠ 本模块自己**不碰座位、不碰钱、不写任何订单字段**：所有落库都发生在 markNoShow 里。
 * 这里只做「名单 → 乘客」的匹配、逐单编排与结果汇总。
 *
 * 幂等：整批一个 requestToken，逐单的 token 由 `${requestToken}:${orderId}` 做 uuid v5 派生
 *（见 deriveBatchOrderToken）。整批重试时前几单会命中 markNoShow 既有的回放，座位绝不二次释放。
 */

import { UserRole, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { localDateISO, localHHMM } from '../../lib/flight-time.js';
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { determineFlightLegItems } from './ticketing-cap.js';
import { SEAT_HOLDING_STATUSES } from './orders.service.js';
import type { NoShowAudit, NoShowPreview, NoShowScope } from './orders.service.js';
import {
  deriveBatchOrderToken,
  documentTail,
  matchRosterLines,
  parseRosterLines,
  type RosterCandidate,
  type RosterMatchedBy,
} from './no-show-roster-match.js';

// ── 响应契约 ────────────────────────────────────────────────────────────────

/** 班次抬头（贴名单前先让票务确认「这一班对不对」）。 */
export interface NoShowBatchScheduleView {
  id: string;
  flightNumber: string;
  /** 出发地当地日 YYYY-MM-DD。 */
  departDate: string;
  /** 出发地当地时刻 HH:mm。 */
  departTimeLocal: string;
  /** 已起飞（no-show 的前提；没飞的班次匹配得出来但一条都标不了）。 */
  departed: boolean;
  /** 该班次逐舱 sold 之和（对名单规模用）。 */
  seatsSold: number;
}

/** 一行名单 → 一位乘客的匹配结果 + 该单的 no-show 准入结论。 */
export interface NoShowBatchMatchedRow {
  /** 名单原文那一行（票务要按原文核对，不能只回我们解析后的名字）。 */
  line: string;
  orderId: string;
  orderNumber: string;
  passengerId: string;
  fullName: string;
  chineseName: string | null;
  /** 证件号**后 4 位**（对外只给这个）。 */
  documentTail: string;
  matchedBy: RosterMatchedBy;
  /** 该单去程已标过 no-show。 */
  alreadyNoShow: boolean;
  /** 该单本次能不能标（口径 = 单单端点的 _assessNoShow）。 */
  eligible: boolean;
  blockers: string[];
  /** WHOLE = 勾的就是本单全员；SPLIT_REQUIRED = 只勾了一部分，执行时会先自动拆单。 */
  scope: NoShowScope;
  hasReturn: boolean;
  returnTicketed: boolean;
  returnDeparted: boolean;
}

export interface NoShowBatchAmbiguousRow {
  line: string;
  candidates: Array<{
    /** 前端点选后直接拼进执行体的 entries，不必再回匹配一次。 */
    orderId: string;
    orderNumber: string;
    passengerId: string;
    fullName: string;
    chineseName: string | null;
  }>;
}

export interface NoShowBatchPreview {
  schedule: NoShowBatchScheduleView;
  matched: NoShowBatchMatchedRow[];
  /** 一位都没匹配上的原文行（人工核对：可能是别班的人，也可能名字录得不一样）。 */
  unmatched: string[];
  /** 匹配到多位乘客的原文行 —— 系统**不猜**，交人工点选。 */
  ambiguous: NoShowBatchAmbiguousRow[];
}

export interface NoShowBatchEntryResult {
  orderId: string;
  orderNumber: string;
  ok: boolean;
  /** 实际被标记的那张单的单号（部分乘客时是拆出来的新单）。 */
  targetOrderNumber?: string;
  /** 本单释放回库存的回程座数。 */
  releasedSeats?: number;
  /** 回程已出票时派给票务的「撤名单/退票」工单 id。 */
  workOrderReminderId?: string | null;
  error?: string;
  code?: string;
}

export interface NoShowBatchResult {
  results: NoShowBatchEntryResult[];
  summary: { ok: number; failed: number; releasedSeats: number };
}

// ── 入参 ────────────────────────────────────────────────────────────────────

export interface NoShowBatchPreviewInput {
  scheduleId: string;
  /** 整块贴进来的名单文本（按行切）。 */
  names: string;
}

export interface NoShowBatchInput {
  requestToken: string;
  scheduleId: string;
  entries: Array<{ orderId: string; passengerIds: string[] }>;
  releaseReturn: boolean;
  note?: string;
}

export interface NoShowBatchActor {
  userId: string;
  role: UserRole;
}

/**
 * 本模块只用到 OrderService 的这两个方法。声明成结构化接口（而不是 import 整个类）
 * 让单测能塞一个假 service，也避免 service ↔ batch 互相 import。
 */
export interface NoShowBatchService {
  previewNoShow(
    orderId: string,
    body: { passengerIds?: string[]; releaseReturn?: boolean },
    actor: NoShowBatchActor,
  ): Promise<NoShowPreview>;
  markNoShow(
    orderId: string,
    input: { requestToken: string; passengerIds?: string[]; releaseReturn: boolean; note?: string },
    actor: NoShowBatchActor,
  ): Promise<{ targetOrderId: string; audit: NoShowAudit }>;
}

export interface NoShowBatchDeps {
  service: NoShowBatchService;
  prisma?: PrismaClient;
}

function assertInternalRole(actor: NoShowBatchActor): void {
  if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
    throw new ForbiddenError('仅运营/管理员可标记 no-show');
  }
}

// ── 候选人装载 ──────────────────────────────────────────────────────────────

/**
 * 本班次可被标 no-show 的乘客池。
 *
 * 口径三条，缺一不可：
 *   1. 订单**占座态**且不在回收站（其余状态早已不持有座位，标了没有任何意义）；
 *   2. 该单有一条 FLIGHT 行挂在这个班次上；
 *   3. 这条行必须是**去程**（determineFlightLegItems 的第 1 段）—— 全站唯一的航段方向口径。
 *      第 3 条是关键：同一个班次既可能是 A 单的去程、也可能是 B 单的回程（往返对飞的团），
 *      漏掉它就会把「回程正等着飞」的客人当成「去程没登机」，直接放掉他的座位。
 */
async function loadScheduleCandidates(
  client: PrismaClient,
  scheduleId: string,
): Promise<RosterCandidate[]> {
  const orders = await client.order.findMany({
    where: {
      deletedAt: null,
      status: { in: SEAT_HOLDING_STATUSES },
      items: { some: { kind: 'FLIGHT', flightScheduleId: scheduleId } },
    },
    select: {
      id: true,
      orderNumber: true,
      passengers: {
        select: {
          id: true,
          fullName: true,
          chineseName: true,
          documentNumber: true,
          lastName: true,
          firstName: true,
        },
      },
      items: {
        where: { kind: 'FLIGHT' },
        select: {
          id: true,
          flightScheduleId: true,
          flightSchedule: { select: { departureTime: true } },
        },
      },
    },
  });

  const out: RosterCandidate[] = [];
  for (const order of orders) {
    const { outbound } = determineFlightLegItems(order.items);
    if (outbound?.flightScheduleId !== scheduleId) continue;
    for (const p of order.passengers) {
      out.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        passengerId: p.id,
        fullName: p.fullName,
        chineseName: p.chineseName,
        documentNumber: p.documentNumber,
        lastName: p.lastName,
        firstName: p.firstName,
      });
    }
  }
  return out;
}

// ── 预检 ────────────────────────────────────────────────────────────────────

/**
 * 贴名单 → 匹配 + 逐单准入结论（只读，一个字段都不写库）。
 *
 * eligible/blockers 逐**单**算一次（不是逐行）：同一张单被名单点到 2 个人时，
 * 这 2 行的准入结论必然一样 —— 一单一次 previewNoShow，结果分发给它的每一行。
 */
export async function previewNoShowBatch(
  deps: NoShowBatchDeps,
  input: NoShowBatchPreviewInput,
  actor: NoShowBatchActor,
): Promise<NoShowBatchPreview> {
  assertInternalRole(actor);
  const client = deps.prisma ?? defaultPrisma;

  const schedule = await client.flightSchedule.findUnique({
    where: { id: input.scheduleId },
    select: {
      id: true,
      departureTime: true,
      departureTz: true,
      flight: { select: { flightNumber: true } },
      seatClasses: { select: { sold: true } },
    },
  });
  if (!schedule) throw new NotFoundError('航班班次不存在');

  const scheduleView: NoShowBatchScheduleView = {
    id: schedule.id,
    flightNumber: schedule.flight?.flightNumber ?? '',
    departDate: localDateISO(schedule.departureTime, schedule.departureTz),
    departTimeLocal: localHHMM(schedule.departureTime, schedule.departureTz),
    departed: schedule.departureTime.getTime() <= Date.now(),
    seatsSold: schedule.seatClasses.reduce((n, sc) => n + sc.sold, 0),
  };

  const lines = parseRosterLines(input.names);
  const candidates = await loadScheduleCandidates(client, input.scheduleId);
  const { matched, unmatched, ambiguous } = matchRosterLines(lines, candidates);

  // 一单一次预检：先把本次名单点到的乘客按单归拢。
  const pickedByOrder = new Map<string, string[]>();
  for (const m of matched) {
    const list = pickedByOrder.get(m.candidate.orderId) ?? [];
    if (!list.includes(m.candidate.passengerId)) list.push(m.candidate.passengerId);
    pickedByOrder.set(m.candidate.orderId, list);
  }

  const assessments = new Map<string, NoShowPreview | { failure: string }>();
  for (const [orderId, passengerIds] of pickedByOrder) {
    try {
      // releaseReturn 不传 → 走 previewNoShow 的缺省 true，与批量执行体的缺省一致：
      //「回程已起飞不能释放」这类闸要在贴名单这一步就看得到，而不是点了执行才蹦出来。
      assessments.set(orderId, await deps.service.previewNoShow(orderId, { passengerIds }, actor));
    } catch (err) {
      // 单张单预检抛错（订单被并发删掉 / 勾选的人已被拆走…）只影响这一张单，
      // 整批不能因此 500 —— 如实把原因落到这张单的 blockers 上。
      assessments.set(orderId, {
        failure: err instanceof Error ? err.message : '预检失败（原因未知）',
      });
    }
  }

  const matchedRows: NoShowBatchMatchedRow[] = matched.map((m) => {
    const c = m.candidate;
    const assessed = assessments.get(c.orderId);
    const failure = assessed != null && 'failure' in assessed ? assessed.failure : null;
    const preview = assessed != null && !('failure' in assessed) ? assessed : null;
    return {
      line: m.line,
      orderId: c.orderId,
      orderNumber: c.orderNumber,
      passengerId: c.passengerId,
      fullName: c.fullName,
      chineseName: c.chineseName,
      documentTail: documentTail(c.documentNumber),
      matchedBy: m.matchedBy,
      alreadyNoShow: preview?.alreadyNoShow ?? false,
      eligible: preview?.eligible ?? false,
      blockers: preview?.blockers ?? [failure ?? '预检失败（原因未知）'],
      scope: preview?.scope ?? 'WHOLE',
      hasReturn: preview?.returnItem != null,
      returnTicketed: preview?.returnItem?.ticketed ?? false,
      returnDeparted: preview?.returnDeparted ?? false,
    };
  });

  return {
    schedule: scheduleView,
    matched: matchedRows,
    unmatched,
    ambiguous: ambiguous.map((a) => ({
      line: a.line,
      candidates: a.candidates.map((c) => ({
        orderId: c.orderId,
        orderNumber: c.orderNumber,
        passengerId: c.passengerId,
        fullName: c.fullName,
        chineseName: c.chineseName,
      })),
    })),
  };
}

// ── 执行 ────────────────────────────────────────────────────────────────────

/** 从异常里取稳定 code（AppError 才有；其余不给 code）。 */
function errorCodeOf(err: unknown): string | undefined {
  if (err instanceof AppError && typeof err.code === 'string' && err.code !== '') return err.code;
  return undefined;
}

/**
 * 整批执行：逐单调既有 markNoShow。
 *
 * 三条纪律：
 *   1. **串行**跑。一班的座位账是同一批 FlightSeatClass 行，并发只会把行锁排队，
 *      还会让「一单失败」的归因变模糊；名单规模（几十单）串行完全跑得动。
 *   2. **一单一事务**（markNoShow 自己开）。一单失败绝不回滚已成功的单 —— 票务今天处理到哪
 *      就是哪，剩下的改完再来一遍即可（幂等派生 token 让重来不会二次放座）。
 *   3. 逐单结果如实回。失败的单带上人话 error 与稳定 code，前端逐条列出来给票务处置。
 */
export async function executeNoShowBatch(
  deps: NoShowBatchDeps,
  input: NoShowBatchInput,
  actor: NoShowBatchActor,
): Promise<NoShowBatchResult> {
  assertInternalRole(actor);
  const client = deps.prisma ?? defaultPrisma;

  const orderIds = [...new Set(input.entries.map((e) => e.orderId))];
  const heads = await client.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      orderNumber: true,
      items: {
        where: { kind: 'FLIGHT' },
        select: {
          id: true,
          flightScheduleId: true,
          flightSchedule: { select: { departureTime: true } },
        },
      },
    },
  });
  const headById = new Map(heads.map((h) => [h.id, h]));

  const results: NoShowBatchEntryResult[] = [];
  for (const entry of input.entries) {
    const head = headById.get(entry.orderId);
    if (!head) {
      results.push({
        orderId: entry.orderId,
        orderNumber: '',
        ok: false,
        error: '订单不存在（可能已被删除），本单跳过。',
        code: 'ORDER_NOT_FOUND',
      });
      continue;
    }
    // 班次一致性闸（fail-closed）：前端拿着一份过期的预检结果提交时，这里会把「这单的去程
    // 根本不在这一班」挡下来。没有这道闸，一次误提交就能把另一班的客人座位放掉。
    const { outbound } = determineFlightLegItems(head.items);
    if (outbound?.flightScheduleId !== input.scheduleId) {
      results.push({
        orderId: entry.orderId,
        orderNumber: head.orderNumber,
        ok: false,
        error: '该订单的去程航段不在本班次上（名单可能已过期），本单跳过；请重新贴名单预检。',
        code: 'SCHEDULE_MISMATCH',
      });
      continue;
    }

    try {
      const { audit } = await deps.service.markNoShow(
        entry.orderId,
        {
          requestToken: deriveBatchOrderToken(input.requestToken, entry.orderId),
          passengerIds: entry.passengerIds,
          releaseReturn: input.releaseReturn,
          note: input.note,
        },
        actor,
      );
      results.push({
        orderId: entry.orderId,
        orderNumber: head.orderNumber,
        ok: true,
        targetOrderNumber: audit.split?.targetOrderNumber ?? audit.orderNumber,
        releasedSeats: audit.releasedSeats.reduce((n, r) => n + r.quantity, 0),
        workOrderReminderId: audit.workOrderReminderId,
      });
    } catch (err) {
      results.push({
        orderId: entry.orderId,
        orderNumber: head.orderNumber,
        ok: false,
        error: err instanceof Error ? err.message : '标记失败（原因未知）',
        code: errorCodeOf(err),
      });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  return {
    results,
    summary: {
      ok,
      failed: results.length - ok,
      releasedSeats: results.reduce((n, r) => n + (r.releasedSeats ?? 0), 0),
    },
  };
}
