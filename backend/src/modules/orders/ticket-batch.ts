/**
 * 按航班批量回填真实 PNR / 电子票号 —— 票务出完票照名单一次灌回来的正路。
 *
 * 现状（单人点）：出票代理回一份几十人的名单，票务得一张单一张单地搜、点开、逐人改。
 * 本模块把它变成「选班次 → 贴名单（或传表格）→ 看匹配结果 → 一键写入」，
 * 与「按航班批量 no-show」是同一套操作手感（preview 只读 / confirm 落库 / 逐条如实回结果）。
 *
 * 两个端点，两件事：
 *   · batch-preview —— **只读**。名单逐行解析成「谁 + PNR + 票号」，再按护照号优先、
 *     姓名兜底匹配到本班次的乘客，并把库里**现有**的号一并回给界面，让票务先看清楚
 *     「这一条是新填、是原样重填、还是要覆盖一个不一样的号」。
 *   · batch        —— 逐条写库。一条一事务，一条失败不影响其它条。
 *
 * ⚠ 本模块只动 Passenger 的 pnr / eticketNumber 两列：不碰订单状态、不碰履约任务、
 *   不碰开票三维布尔（开票是「出票进度」口径，与票号是两回事），也**不发行程单邮件**
 *   （票务边灌边发，客人会收到一串行程单；要发走订单详情的「重发行程单邮件」）。
 *
 * 不分去程/回程：Passenger 上只有**一对** pnr / eticketNumber 列，本来就是「按人」的口径，
 * 不是按航段的。所以候选池收「这一班上有 FLIGHT 行」的单，去程回程都算 —— 与 no-show
 * 只认去程正相反：那边放的是座位（必须分方向），这边填的是这个人的票号（不分方向）。
 *
 * 幂等：写值天然幂等 —— 同一批重发，库里已经是这个号了，本次 changedFields 为空、
 * 一个字段都不写。requestToken 不用来加锁，只作整批的关联号落进审计
 *（同一批重试在审计里认得出是同一批，而不是「怎么又灌了一遍」）。
 */

import { OrderStatus, UserRole, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { localDateISO, localHHMM } from '../../lib/flight-time.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { SEAT_HOLDING_STATUSES } from './orders.service.js';
import {
  documentTail,
  matchRosterLines,
  type RosterCandidate,
  type RosterMatchedBy,
} from './no-show-roster-match.js';
import { parseTicketRosterLines, type TicketRosterRow } from './ticket-roster.js';

// ── 响应契约 ────────────────────────────────────────────────────────────────

/** 班次抬头（贴名单前先让票务确认「这一班对不对」）。 */
export interface TicketBatchScheduleView {
  id: string;
  flightNumber: string;
  /** 出发地当地日 YYYY-MM-DD。 */
  departDate: string;
  /** 出发地当地时刻 HH:mm。 */
  departTimeLocal: string;
  /** 该班次逐舱 sold 之和（对名单规模用）。 */
  seatsSold: number;
}

/** 一位被名单点到的乘客 + 这次要写什么 + 库里现在是什么。 */
export interface TicketBatchMatchedRow {
  /** 名单原文那一行（多行命中同一人时是第一条）。 */
  line: string;
  /** 命中这位乘客的**全部**原文行（含 line 自己）。 */
  lines: string[];
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  passengerId: string;
  fullName: string;
  chineseName: string | null;
  /** 证件号**后 4 位**（对外只给这个）。 */
  documentTail: string;
  matchedBy: RosterMatchedBy;
  /** 本次要写的 PNR（名单没给就是 null = 不动这一列）。 */
  pnr: string | null;
  /** 本次要写的电子票号（名单没给就是 null = 不动这一列）。 */
  eticketNumber: string | null;
  /** 库里现有的 PNR。 */
  currentPnr: string | null;
  /** 库里现有的电子票号。 */
  currentEticketNumber: string | null;
  /** 库里已有一个**不一样**的号 —— 要覆盖必须在执行体里显式带 overwrite。 */
  conflict: boolean;
  conflictFields: Array<'pnr' | 'eticketNumber'>;
  /** 库里已经就是这个号 —— 写了也不会有任何变化。 */
  unchanged: boolean;
  /** 名单**自己前后矛盾**（同一个人被两行给了两个不同的号）→ 系统不猜，交人工。 */
  rosterConflict: boolean;
  /** 面向操作人的拦截原因（目前只有名单自相矛盾一条）。 */
  blockers: string[];
}

export interface TicketBatchAmbiguousRow {
  line: string;
  pnr: string | null;
  eticketNumber: string | null;
  candidates: Array<{
    /** 前端点选后直接拼进执行体的 entries，不必再回匹配一次。 */
    orderId: string;
    orderNumber: string;
    passengerId: string;
    fullName: string;
    chineseName: string | null;
    documentTail: string;
  }>;
}

/** 行本身就不可用（格式不对/缺列）—— 与「人匹配不上」是两回事，分开列。 */
export interface TicketBatchInvalidRow {
  line: string;
  error: string;
}

export interface TicketBatchPreview {
  schedule: TicketBatchScheduleView;
  matched: TicketBatchMatchedRow[];
  /** 行解析没问题、但这一班里找不到这个人。 */
  unmatched: Array<{ line: string; identity: string }>;
  /** 一行命中多位乘客 —— 系统**不猜**，交人工点选。 */
  ambiguous: TicketBatchAmbiguousRow[];
  /** 行格式不合规（PNR/票号长度不对、只有一列…）。 */
  invalid: TicketBatchInvalidRow[];
  /** 去重后的总行数（**不受上限影响**）。 */
  totalLines: number;
  /** 本次实际参与解析的行数（truncated 时 < totalLines）。 */
  processedLines: number;
  /** 行数超过单次上限 → 本次只处理了前若干行，其余需再贴一次。 */
  truncated: boolean;
}

export interface TicketBatchEntryResult {
  orderId: string;
  orderNumber: string;
  passengerId: string;
  fullName: string;
  ok: boolean;
  /** 本条真正变了值的字段（空数组 = 库里本来就是这个号，本次没动）。 */
  changedFields: Array<'pnr' | 'eticketNumber'>;
  error?: string;
  code?: string;
}

export interface TicketBatchResult {
  results: TicketBatchEntryResult[];
  summary: {
    ok: number;
    failed: number;
    /** 真正改了值的条数。 */
    changed: number;
    /** 处理成功但一个字段都没变的条数（重发同一批时它会等于成功数）。 */
    unchanged: number;
  };
}

// ── 入参 ────────────────────────────────────────────────────────────────────

export interface TicketBatchPreviewInput {
  scheduleId: string;
  /** 整块贴进来的名单文本（按行切）。xlsx 上传由路由层先转成同形文本再进来。 */
  lines: string;
}

export interface TicketBatchEntryInput {
  orderId: string;
  passengerId: string;
  /** 要写的 PNR；不传/null = 不动这一列。 */
  pnr?: string | null;
  /** 要写的电子票号；不传/null = 不动这一列。 */
  eticketNumber?: string | null;
  /** 库里已有不同的号时，必须显式带 true 才覆盖（缺省 false = 保守跳过）。 */
  overwrite?: boolean;
}

export interface TicketBatchInput {
  requestToken: string;
  scheduleId: string;
  entries: TicketBatchEntryInput[];
  note?: string;
}

export interface TicketBatchActor {
  userId: string;
  role: UserRole;
}

export interface TicketBatchDeps {
  prisma?: PrismaClient;
}

function assertInternalRole(actor: TicketBatchActor): void {
  if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
    throw new ForbiddenError('仅运营/管理员可回填票号');
  }
}

// ── 候选人装载 ──────────────────────────────────────────────────────────────

/** 匹配用候选人 + 该乘客库里现有的号（预览要把「现在是什么」一并摆出来）。 */
interface TicketCandidateContext {
  candidates: RosterCandidate[];
  currentByPassengerId: Map<string, { pnr: string | null; eticketNumber: string | null }>;
  orderStatusById: Map<string, OrderStatus>;
}

/**
 * 本班次可回填票号的乘客池。口径两条：
 *   1. 订单**占座态**且不在回收站（其余状态早已不持有这班的座位；已取消单要补票号请走
 *      订单详情的单人回填 —— 那是一单一议的动作，不该在整班批量里顺手做）；
 *   2. 该单有一条 FLIGHT 行挂在这个班次上（**不分去程回程**，见文件头）。
 */
async function loadCandidates(
  client: PrismaClient,
  scheduleId: string,
): Promise<TicketCandidateContext> {
  const orders = await client.order.findMany({
    where: {
      deletedAt: null,
      status: { in: SEAT_HOLDING_STATUSES },
      items: { some: { kind: 'FLIGHT', flightScheduleId: scheduleId } },
    },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      passengers: {
        select: {
          id: true,
          fullName: true,
          chineseName: true,
          documentNumber: true,
          lastName: true,
          firstName: true,
          pnr: true,
          eticketNumber: true,
        },
      },
    },
  });

  const candidates: RosterCandidate[] = [];
  const currentByPassengerId = new Map<
    string,
    { pnr: string | null; eticketNumber: string | null }
  >();
  const orderStatusById = new Map<string, OrderStatus>();
  for (const order of orders) {
    orderStatusById.set(order.id, order.status);
    for (const p of order.passengers) {
      candidates.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        passengerId: p.id,
        fullName: p.fullName,
        chineseName: p.chineseName,
        documentNumber: p.documentNumber,
        lastName: p.lastName,
        firstName: p.firstName,
      });
      currentByPassengerId.set(p.id, { pnr: p.pnr, eticketNumber: p.eticketNumber });
    }
  }
  return { candidates, currentByPassengerId, orderStatusById };
}

// ── 预检 ────────────────────────────────────────────────────────────────────

/** 同一位乘客被多行命中时的合并中间态。 */
interface MergedTicketTarget {
  first: TicketRosterRow;
  lines: string[];
  candidate: RosterCandidate;
  matchedBy: RosterMatchedBy;
  pnr: string | null;
  eticketNumber: string | null;
  rosterConflict: boolean;
  blockers: string[];
}

/**
 * 贴名单 → 解析 + 匹配 + 与库里现值比对（只读，一个字段都不写库）。
 *
 * 匹配沿用 no-show 名单那套内核（护照号 → 英文名 → 中文名，命中多人不猜）：
 * 两处若各写一套「这一行说的是谁」，同一份名单在两个页面会认出不同的人。
 */
export async function previewTicketBatch(
  deps: TicketBatchDeps,
  input: TicketBatchPreviewInput,
  actor: TicketBatchActor,
): Promise<TicketBatchPreview> {
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

  const scheduleView: TicketBatchScheduleView = {
    id: schedule.id,
    flightNumber: schedule.flight?.flightNumber ?? '',
    departDate: localDateISO(schedule.departureTime, schedule.departureTz),
    departTimeLocal: localHHMM(schedule.departureTime, schedule.departureTz),
    seatsSold: schedule.seatClasses.reduce((n, sc) => n + sc.sold, 0),
  };

  const parsed = parseTicketRosterLines(input.lines);
  const invalid: TicketBatchInvalidRow[] = parsed.rows
    .filter((r) => r.error !== null)
    .map((r) => ({ line: r.line, error: r.error as string }));
  const usable = parsed.rows.filter((r) => r.error === null);

  const { candidates, currentByPassengerId, orderStatusById } = await loadCandidates(
    client,
    input.scheduleId,
  );

  // 匹配按 identity 去重跑一次，再把结论分发回各行：同一个人被名单点了两次，
  // 匹配内核跑两遍只是白花时间，而且两次结论必然一样。
  const identities = [...new Set(usable.map((r) => r.identity))];
  const { matched, unmatched, ambiguous } = matchRosterLines(identities, candidates);
  const matchByIdentity = new Map(matched.map((m) => [m.line, m]));
  const ambiguousByIdentity = new Map(ambiguous.map((a) => [a.line, a.candidates]));
  const unmatchedIdentities = new Set(unmatched);

  const mergedByPassenger = new Map<string, MergedTicketTarget>();
  const unmatchedRows: Array<{ line: string; identity: string }> = [];
  const ambiguousRows: TicketBatchAmbiguousRow[] = [];

  for (const row of usable) {
    const ambiguousCandidates = ambiguousByIdentity.get(row.identity);
    if (ambiguousCandidates) {
      ambiguousRows.push({
        line: row.line,
        pnr: row.pnr,
        eticketNumber: row.eticketNumber,
        candidates: ambiguousCandidates.map((c) => ({
          orderId: c.orderId,
          orderNumber: c.orderNumber,
          passengerId: c.passengerId,
          fullName: c.fullName,
          chineseName: c.chineseName,
          documentTail: documentTail(c.documentNumber),
        })),
      });
      continue;
    }
    const hit = matchByIdentity.get(row.identity);
    // 三个集合互斥且穷尽；命不中就是没这个人（unmatchedIdentities 只作可读性校验）。
    if (!hit || unmatchedIdentities.has(row.identity)) {
      unmatchedRows.push({ line: row.line, identity: row.identity });
      continue;
    }

    const key = hit.candidate.passengerId;
    const existing = mergedByPassenger.get(key);
    if (!existing) {
      mergedByPassenger.set(key, {
        first: row,
        lines: [row.line],
        candidate: hit.candidate,
        matchedBy: hit.matchedBy,
        pnr: row.pnr,
        eticketNumber: row.eticketNumber,
        rosterConflict: false,
        blockers: [],
      });
      continue;
    }

    // 同一位乘客被多行命中：互补的（一行给 PNR、一行给票号）合并；
    // 给了两个**不同**的号则是名单自相矛盾 —— 不猜，整条挂红交人工。
    existing.lines.push(row.line);
    for (const field of ['pnr', 'eticketNumber'] as const) {
      const incoming = row[field];
      if (incoming === null) continue;
      const current = existing[field];
      if (current === null) {
        existing[field] = incoming;
      } else if (current !== incoming) {
        existing.rosterConflict = true;
        const label = field === 'pnr' ? 'PNR' : '电子票号';
        existing.blockers.push(`名单里这个人出现了两个不同的${label}（${current} / ${incoming}）`);
      }
    }
  }

  const matchedRows: TicketBatchMatchedRow[] = [...mergedByPassenger.values()].map((t) => {
    const current = currentByPassengerId.get(t.candidate.passengerId) ?? {
      pnr: null,
      eticketNumber: null,
    };
    const conflictFields: Array<'pnr' | 'eticketNumber'> = [];
    let changes = 0;
    for (const field of ['pnr', 'eticketNumber'] as const) {
      const next = t[field];
      if (next === null) continue; // 名单没给这一列 → 不动，也就无所谓冲突
      if (current[field] === next) continue; // 已经就是这个号
      changes += 1;
      if (current[field] !== null && current[field] !== '') conflictFields.push(field);
    }
    return {
      line: t.first.line,
      lines: t.lines,
      orderId: t.candidate.orderId,
      orderNumber: t.candidate.orderNumber,
      orderStatus: orderStatusById.get(t.candidate.orderId) ?? OrderStatus.PENDING_PAYMENT,
      passengerId: t.candidate.passengerId,
      fullName: t.candidate.fullName,
      chineseName: t.candidate.chineseName,
      documentTail: documentTail(t.candidate.documentNumber),
      matchedBy: t.matchedBy,
      pnr: t.pnr,
      eticketNumber: t.eticketNumber,
      currentPnr: current.pnr,
      currentEticketNumber: current.eticketNumber,
      conflict: conflictFields.length > 0,
      conflictFields,
      unchanged: changes === 0,
      rosterConflict: t.rosterConflict,
      blockers: t.blockers,
    };
  });

  return {
    schedule: scheduleView,
    matched: matchedRows,
    unmatched: unmatchedRows,
    ambiguous: ambiguousRows,
    invalid,
    totalLines: parsed.totalLines,
    processedLines: parsed.rows.length,
    truncated: parsed.truncated,
  };
}

// ── 执行 ────────────────────────────────────────────────────────────────────

/**
 * 整批写入：逐条一事务。
 *
 * 三条纪律（与按航班批量 no-show 同款）：
 *   1. **一条一事务**：一条失败绝不回滚已写好的条目 —— 票务今天灌到哪就是哪，
 *      剩下的改完再来一遍即可（写值天然幂等，重来不会写坏已经对的号）。
 *   2. 事务里**当场重读**库里现值再判冲突：拿预检时的快照去判，中间被人改过就成了盲写。
 *   3. 逐条结果如实回，失败带人话 error 与稳定 code，前端逐条列给票务处置。
 */
export async function executeTicketBatch(
  deps: TicketBatchDeps,
  input: TicketBatchInput,
  actor: TicketBatchActor,
): Promise<TicketBatchResult> {
  assertInternalRole(actor);
  const client = deps.prisma ?? defaultPrisma;

  const orderIds = [...new Set(input.entries.map((e) => e.orderId))];
  const heads = await client.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      deletedAt: true,
      items: { where: { kind: 'FLIGHT' }, select: { flightScheduleId: true } },
    },
  });
  const headById = new Map(heads.map((h) => [h.id, h]));

  const results: TicketBatchEntryResult[] = [];
  for (const entry of input.entries) {
    const head = headById.get(entry.orderId);
    const fail = (error: string, code: string): void => {
      results.push({
        orderId: entry.orderId,
        orderNumber: head?.orderNumber ?? '',
        passengerId: entry.passengerId,
        fullName: '',
        ok: false,
        changedFields: [],
        error,
        code,
      });
    };

    if (!head || head.deletedAt !== null) {
      fail('订单不存在或已在回收站，本条跳过。', 'ORDER_NOT_FOUND');
      continue;
    }
    // 班次一致性闸（fail-closed）：前端拿着一份过期的预检结果提交时，这里把
    //「这单根本不在这一班」挡下来 —— 没有这道闸，一次误提交就能把票号灌到别班客人身上。
    if (!head.items.some((it) => it.flightScheduleId === input.scheduleId)) {
      fail(
        '该订单没有本班次的航段（名单可能已过期），本条跳过；请重新贴名单预检。',
        'SCHEDULE_MISMATCH',
      );
      continue;
    }
    if (!SEAT_HOLDING_STATUSES.includes(head.status)) {
      fail(
        '该订单已不在占座状态，整班批量不处理；确需补录请到订单详情单人回填。',
        'ORDER_NOT_HOLDING',
      );
      continue;
    }

    try {
      const outcome = await client.$transaction(async (tx) => {
        const passenger = await tx.passenger.findUnique({
          where: { id: entry.passengerId },
          select: { id: true, orderId: true, fullName: true, pnr: true, eticketNumber: true },
        });
        if (!passenger || passenger.orderId !== entry.orderId) {
          return { kind: 'MISSING' as const };
        }

        const current = { pnr: passenger.pnr, eticketNumber: passenger.eticketNumber };
        const next = { ...current };
        const changedFields: Array<'pnr' | 'eticketNumber'> = [];
        const blockedFields: Array<'pnr' | 'eticketNumber'> = [];
        for (const field of ['pnr', 'eticketNumber'] as const) {
          const incoming = entry[field];
          if (incoming === undefined || incoming === null) continue; // 这一列不动
          if (current[field] === incoming) continue; // 已经就是这个号
          // 库里已有一个不一样的号：没显式说要覆盖就不覆盖。票号被悄悄改掉，
          // 事后对账没有任何线索能查出是哪一次批量灌的。
          if (current[field] !== null && current[field] !== '' && entry.overwrite !== true) {
            blockedFields.push(field);
            continue;
          }
          next[field] = incoming;
          changedFields.push(field);
        }

        if (blockedFields.length > 0) {
          return {
            kind: 'CONFLICT' as const,
            fullName: passenger.fullName,
            current,
            blockedFields,
          };
        }
        if (changedFields.length > 0) {
          await tx.passenger.update({
            where: { id: entry.passengerId },
            data: { pnr: next.pnr, eticketNumber: next.eticketNumber },
          });
        }
        return { kind: 'OK' as const, fullName: passenger.fullName, changedFields };
      });

      if (outcome.kind === 'MISSING') {
        fail('出行人不存在或不属于该订单（可能已被换人/拆走），本条跳过。', 'PASSENGER_NOT_FOUND');
        continue;
      }
      if (outcome.kind === 'CONFLICT') {
        const labels = outcome.blockedFields
          .map((f) =>
            f === 'pnr'
              ? `PNR（现为 ${outcome.current.pnr}）`
              : `电子票号（现为 ${outcome.current.eticketNumber}）`,
          )
          .join('、');
        results.push({
          orderId: entry.orderId,
          orderNumber: head.orderNumber,
          passengerId: entry.passengerId,
          fullName: outcome.fullName,
          ok: false,
          changedFields: [],
          error: `库里已有不同的${labels}；确认要换成名单里的号，请勾「覆盖已有票号」后重试。`,
          code: 'TICKET_CONFLICT',
        });
        continue;
      }
      results.push({
        orderId: entry.orderId,
        orderNumber: head.orderNumber,
        passengerId: entry.passengerId,
        fullName: outcome.fullName,
        ok: true,
        changedFields: outcome.changedFields,
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : '回填失败（原因未知）', 'WRITE_FAILED');
    }
  }

  const ok = results.filter((r) => r.ok);
  return {
    results,
    summary: {
      ok: ok.length,
      failed: results.length - ok.length,
      changed: ok.filter((r) => r.changedFields.length > 0).length,
      // 重发同一批时这个数会等于成功数 —— 界面照实说「N 条本来就是这个号，没有改动」，
      // 别把它算进「已回填 N 条」，票务拿这个数跟出票单对必然对不上。
      unchanged: ok.filter((r) => r.changedFields.length === 0).length,
    },
  };
}
