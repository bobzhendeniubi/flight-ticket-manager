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
import { isCheckinClosed } from '../../lib/checkin-close.js';
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
  /**
   * 已关柜（no-show 的前提；没关柜的班次匹配得出来但一条都标不了）。
   *
   * 锚点是**关柜时刻**（起飞时刻 − 该班次的关柜提前分钟数，没配走系统默认，见 lib/checkin-close.ts），
   * 与单单口径 `_assessNoShow` 闸 4 同源 —— 两处若一个看起飞、一个看关柜，就会出现
   * 「整批抬头说不能提交、逐行却全绿」的对不上。字段名沿用 departed 不改（前端只拿它当
   * 「现在能不能提交」的开关），语义以本注释为准。
   */
  departed: boolean;
  /** 该班次逐舱 sold 之和（对名单规模用）。 */
  seatsSold: number;
}

/** 一位被名单点到的乘客 + 该单的 no-show 准入结论（同一人被多行命中时合并成一条）。 */
export interface NoShowBatchMatchedRow {
  /** 名单原文那一行（票务要按原文核对，不能只回我们解析后的名字）；多行命中同一人时是第一条。 */
  line: string;
  /**
   * 命中这位乘客的**全部**原文行（含 line 自己）。
   * 名单里「张三」与「ZHANG/SAN E12345678」指的是同一个人时，这里会有两条 ——
   * 合成一行返回，勾选列表就不会出现两条同人记录、执行时也不会为同一人排两次。
   */
  lines: string[];
  orderId: string;
  orderNumber: string;
  /**
   * 订单备注原文（`Order.notes`），给票务在单号旁边多一个可读的识别标。
   *
   * 为什么不是「团期」：这张表本来就是针对**单一已选定班次**的，所有行的出发日期天然相同，
   * 再造一个团期字段既无区分度也无真源。运营录单时习惯往备注里写团组/客人识别信息
   *（「两位成人（双床）三星」这类），拿它当标识是现成的、不必新增字段。
   */
  notes: string | null;
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
  /** 贴进来的名单去重后共多少行（**不受单次上限影响**）。 */
  totalLines: number;
  /** 行数超过单次上限 → 本次只处理了前 NO_SHOW_ROSTER_MAX_LINES 行，其余需再贴一次。 */
  truncated: boolean;
  /** 本次实际参与匹配的行数（truncated 时 < totalLines）。 */
  processedLines: number;
  /**
   * 名单点到的订单数超过单次预检上限 → 本次只逐单预检了前 NO_SHOW_PREVIEW_MAX_ORDERS 张单，
   * 其余单的 eligible/blockers **没有算过**（如实回一条「本次未预检」的 blocker，不装绿）。
   * 前端见到 true 要提示票务分批贴名单。
   */
  truncatedOrders: boolean;
  /** 名单点到的订单总数（**不受上限影响**）。 */
  totalOrders: number;
  /** 本次实际逐单预检的订单数（truncatedOrders 时 < totalOrders）。 */
  processedOrders: number;
}

export interface NoShowBatchEntryResult {
  orderId: string;
  orderNumber: string;
  ok: boolean;
  /** 实际被标记的那张单的单号（部分乘客时是拆出来的新单）。 */
  targetOrderNumber?: string;
  /** 实际被标记的那张单的 id（部分乘客时是拆出来的新单 id）；供审计与前端跳转用。 */
  targetOrderId?: string;
  /**
   * true = 这一单是**同 token 重试的回放**：库里一个字段都没动，座位没有二次释放。
   * 整批重试时前几单必然是回放 —— 不把它标出来，前端会把「一座没放」的单显示成
   * 「本次释放了 N 座」，票务照着这个数去跟航司对座位就会对不上。
   */
  replayed?: boolean;
  /** 本单释放回库存的回程座数（回放的单这里是上一次的数，不计进 summary）。 */
  releasedSeats?: number;
  /** 回程已出票时派给票务的「撤名单/退票」工单 id。 */
  workOrderReminderId?: string | null;
  error?: string;
  code?: string;
}

export interface NoShowBatchResult {
  results: NoShowBatchEntryResult[];
  summary: {
    ok: number;
    failed: number;
    /** **本次真正放回库存**的座数：回放的单不计（它们上一次就已经放过了）。 */
    releasedSeats: number;
    /** 本批里属于「同 token 回放、库里没动」的单数。 */
    replayedCount: number;
  };
}

// ── 入参 ────────────────────────────────────────────────────────────────────

export interface NoShowBatchPreviewInput {
  scheduleId: string;
  /** 整块贴进来的名单文本（按行切）。 */
  names: string;
  /**
   * 「同时释放回程」勾选框的当前状态（缺省 true，与执行体同缺省）。
   * 必须原样带进逐单预检：「回程已起飞不能释放」「这是再次释放」这两条闸只有拿到它才算得准，
   * 否则贴名单时一片绿、点了执行才逐单蹦红。
   */
  releaseReturn?: boolean;
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

/**
 * 单次预检最多逐单跑几张单。
 *
 * 比执行体的 50 张宽（预检是**只读**的，没有事务、不拆单），但仍必须有上限：
 * 500 行名单可能点到几百张单，每张单一次 previewNoShow 都要连行带乘客读一遍，
 * 不设限就是一个请求打穿网关超时。超出的单如实回 truncatedOrders，不装绿。
 */
export const NO_SHOW_PREVIEW_MAX_ORDERS = 200;

/** 逐单预检的并发分片大小：同一批里 10 张单一组并发跑，组间串行（连接池不会被打满）。 */
const PREVIEW_CONCURRENCY = 10;

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
): Promise<{ candidates: RosterCandidate[]; notesByOrderId: Map<string, string | null> }> {
  const orders = await client.order.findMany({
    where: {
      deletedAt: null,
      status: { in: SEAT_HOLDING_STATUSES },
      items: { some: { kind: 'FLIGHT', flightScheduleId: scheduleId } },
    },
    select: {
      id: true,
      orderNumber: true,
      // 备注：匹配用不到，只是随行下发给前端当可读识别标（见 NoShowBatchMatchedRow.notes）。
      // 因此不塞进 RosterCandidate —— 那是纯匹配用的形状，别让展示字段渗进去。
      notes: true,
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
  const notesByOrderId = new Map<string, string | null>();
  for (const order of orders) {
    const { outbound } = determineFlightLegItems(order.items);
    if (outbound?.flightScheduleId !== scheduleId) continue;
    notesByOrderId.set(order.id, order.notes);
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
  return { candidates: out, notesByOrderId };
}

// ── 预检 ────────────────────────────────────────────────────────────────────

/**
 * 贴名单 → 匹配 + 逐单准入结论（只读，一个字段都不写库）。
 *
 * eligible/blockers 逐**单**算一次（不是逐行）：同一张单被名单点到 2 个人时，
 * 这 2 行的准入结论必然一样 —— 一单一次 previewNoShow，结果分发给它的每一行。
 *
 * 名单超过单次上限（NO_SHOW_ROSTER_MAX_LINES）时仍处理前若干行，但响应里的
 * totalLines / processedLines / truncated 会把「贴了多少、这次看了多少」明说出来。
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
      // 关柜提前分钟数（null = 系统默认）：抬头的「能不能提交」按关柜算，与单单闸 4 同源。
      checkinCloseMinutes: true,
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
    departed: isCheckinClosed(schedule.departureTime, schedule.checkinCloseMinutes),
    seatsSold: schedule.seatClasses.reduce((n, sc) => n + sc.sold, 0),
  };

  const { lines, totalLines, truncated } = parseRosterLines(input.names);
  const { candidates, notesByOrderId } = await loadScheduleCandidates(client, input.scheduleId);
  const { matched, unmatched, ambiguous } = matchRosterLines(lines, candidates);

  // 同一位乘客被多行命中（「张三」+「ZHANG/SAN E12345678」）→ 合并成一条，原文行都留着。
  // 不合并的话勾选列表会出现两条同人记录，票务勾两次、执行时这一单也会被排两遍。
  const mergedByPassenger = new Map<string, { first: (typeof matched)[number]; lines: string[] }>();
  for (const m of matched) {
    const key = `${m.candidate.orderId}:${m.candidate.passengerId}`;
    const hit = mergedByPassenger.get(key);
    if (hit) {
      if (!hit.lines.includes(m.line)) hit.lines.push(m.line);
      continue;
    }
    mergedByPassenger.set(key, { first: m, lines: [m.line] });
  }

  // 一单一次预检：先把本次名单点到的乘客按单归拢。
  const pickedByOrder = new Map<string, string[]>();
  for (const { first } of mergedByPassenger.values()) {
    const list = pickedByOrder.get(first.candidate.orderId) ?? [];
    if (!list.includes(first.candidate.passengerId)) list.push(first.candidate.passengerId);
    pickedByOrder.set(first.candidate.orderId, list);
  }

  // 与执行体同缺省：不传 = true。带进逐单预检，「回程已起飞不能释放」「这是再次释放」
  // 这类闸才会在贴名单这一步就如实亮出来，而不是点了执行才逐单蹦红。
  const releaseReturn = input.releaseReturn ?? true;
  const assessments = new Map<string, NoShowPreview | { failure: string }>();
  // 订单数上限：超出的单本次不预检，如实回 truncatedOrders（下面给它们一条明说的 blocker）。
  const allOrderEntries = [...pickedByOrder.entries()];
  const totalOrders = allOrderEntries.length;
  const orderEntries = allOrderEntries.slice(0, NO_SHOW_PREVIEW_MAX_ORDERS);
  const truncatedOrders = totalOrders > orderEntries.length;
  // 分片并发：一张单的预检是几次只读查询，串行跑几百张会把响应时间线性堆起来。
  // 10 张一组、组间串行 —— 既压掉大部分等待，又不会把连接池打满拖垮别的请求。
  for (let i = 0; i < orderEntries.length; i += PREVIEW_CONCURRENCY) {
    const chunk = orderEntries.slice(i, i + PREVIEW_CONCURRENCY);
    const settled = await Promise.all(
      chunk.map(async ([orderId, passengerIds]) => {
        try {
          return {
            orderId,
            value: await deps.service.previewNoShow(
              orderId,
              { passengerIds, releaseReturn },
              actor,
            ),
          };
        } catch (err) {
          // 单张单预检抛错（订单被并发删掉 / 勾选的人已被拆走…）只影响这一张单，
          // 整批不能因此 500 —— 如实把原因落到这张单的 blockers 上。
          return {
            orderId,
            value: { failure: err instanceof Error ? err.message : '预检失败（原因未知）' },
          };
        }
      }),
    );
    for (const { orderId, value } of settled) assessments.set(orderId, value);
  }

  const matchedRows: NoShowBatchMatchedRow[] = [...mergedByPassenger.values()].map((entry) => {
    const m = entry.first;
    const c = m.candidate;
    const assessed = assessments.get(c.orderId);
    // 超出单次预检上限、本次根本没跑过的单：明说「未预检」，绝不按 eligible=true 放绿。
    const failure =
      assessed == null
        ? '本次名单点到的订单数超过单次预检上限，这一单没有预检；请分批贴名单。'
        : 'failure' in assessed
          ? assessed.failure
          : null;
    const preview = assessed != null && !('failure' in assessed) ? assessed : null;
    return {
      line: m.line,
      lines: entry.lines,
      orderId: c.orderId,
      orderNumber: c.orderNumber,
      notes: notesByOrderId.get(c.orderId) ?? null,
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
    totalLines,
    truncated,
    processedLines: lines.length,
    truncatedOrders,
    totalOrders,
    processedOrders: orderEntries.length,
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
      const { audit, targetOrderId } = await deps.service.markNoShow(
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
        targetOrderId,
        replayed: audit.replayed,
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
      // 回放的单**不计**释放座数：那几座上一次就已经放回库存了，这一次库里一个字段都没动。
      // 累加进去会让整批重试的汇总数随重试次数翻倍，票务拿着这个数跟航司对座位必然对不上。
      releasedSeats: results.reduce(
        (n, r) => n + (r.replayed === true ? 0 : (r.releasedSeats ?? 0)),
        0,
      ),
      replayedCount: results.filter((r) => r.replayed === true).length,
    },
  };
}
