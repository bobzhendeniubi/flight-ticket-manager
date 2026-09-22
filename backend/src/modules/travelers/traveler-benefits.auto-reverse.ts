/**
 * 权益核销的**自动冲正**（2026-09-21 拍板）：挂了订单号的核销，在该单
 *   · 落取消族终态（订单状态机 _updateStatusWithinTx：取消 / 退款 / 支付超时 / 失败），或
 *   · 去程被标 no-show（_executeNoShow 首次打标）
 * 时，由系统在**同一事务内**给每条「正数且尚未被冲正」的核销行追加一条负数补偿行，
 * 并写审计 BENEFIT_REDEMPTION_AUTO_REVERSED + 一条给运营的待办（知会客人 / 恢复后重核销）。
 *
 * 为什么放在 travelers/ 而不是 orders.service：台账的写法（append-only、reversalOfId 唯一、
 * 补偿行照抄 benefit / orderId）只有这一份口径，人工冲正（TravelerBenefitsService.reverse）
 * 与自动冲正必须长得一样；orders.service 只负责在状态机出口喊一声。
 *
 * 拆单：no-show / 取消常常先把几位客人拆到新单再操作，核销却挂在**源单**上。这里顺带认
 * 「源单上的核销 + 该档案的证件出现在本单乘客里」这一层（OrderSplitRecord 一跳），
 * 拆了两次以上的链不追（见遗留风险）。
 *
 * 冲正与否跟着**旅客当前承载的行程**走，不是只看核销挂的单号（评审 F1）：
 *   核销挂 A 的客人 P 被拆到 B，B 照常出行，之后运营取消 A 里留下的其他人 —— A 的核销
 *   全部冲正的话，P 行程没少却白拿回 N 次。所以每条候选先问一句「这个人（档案全部证件，
 *   合并链任意深度）此刻是否还在别的有效已付款单上有行程」：有 → 不冲正，只写一条 INFO 审计
 *   BENEFIT_REDEMPTION_AUTO_REVERSE_SKIPPED；没有 → 冲正。判定口径见 findCarriedOrderIdsByDoc。
 *
 * 并发：补偿行走 createMany(skipDuplicates) —— reversalOfId 唯一索引撞上人工冲正时
 * ON CONFLICT DO NOTHING，**不会**把整个取消事务打成 aborted（Postgres 里一条失败语句
 * 会废掉整个事务，create + catch(P2002) 在事务内是不能用的）。
 *
 * 老单测的 prisma mock 没有本文件用到的 delegate：缺 delegate 时整段跳过（真 client 永远齐全，
 * 这个守卫只影响 mock；口径同 reminders.rules.upgrade-redeem.ts 的取数守卫）。
 */
import {
  AuditSeverity,
  AuditTargetType,
  ReminderPriority,
  type DocumentType,
  type Prisma,
} from '@prisma/client';
import { writeAuditWithinTx } from '../../lib/audit.js';
import { businessDateISO } from '../../lib/business-time.js';
import { hasNoShowMark } from '../orders/orders.leg-status.js';
import { countsAsPaidUpcoming } from './traveler-profiles.aggregate.js';
import { EXCLUDED_ORDER_STATUSES } from './traveler-trip-count.js';
import {
  buildAliasIndex,
  docPairsForProfile,
  type ProfileRef,
} from './traveler-profile-alias.js';

/** 自动冲正行的 createdById：不是真实账号，台账 / 前端据此识别「系统自动」。 */
export const BENEFIT_AUTO_REVERSAL_ACTOR_ID = 'system-benefit-auto-reversal';
/** 自动冲正行的操作人姓名快照（产品里可见的文案）。 */
export const BENEFIT_AUTO_REVERSAL_ACTOR_NAME = '系统自动';
export const BENEFIT_AUTO_REVERSED_AUDIT_ACTION = 'BENEFIT_REDEMPTION_AUTO_REVERSED';
/** 「核销挂的单已取消 / no-show，但旅客仍有有效行程，未补回」的 INFO 审计。 */
export const BENEFIT_AUTO_REVERSE_SKIPPED_AUDIT_ACTION = 'BENEFIT_REDEMPTION_AUTO_REVERSE_SKIPPED';
/** 自动冲正待办的 ruleKey 前缀：`BENEFITREV:{补偿行 id}`（一条补偿行一条待办，幂等）。 */
export const BENEFIT_AUTO_REVERSAL_REMINDER_PREFIX = 'BENEFITREV:';

export interface AutoReverseRedemptionsInput {
  /** 触发事件的那张单（取消 / 退款 / no-show 的目标单）。 */
  orderId: string;
  orderNumber: string;
  /** 触发原因（进补偿行 note、审计与待办正文），如「订单已取消」「去程 no-show」。 */
  reason: string;
  /**
   * 待办提单人：必须是真实 User id（外键）。系统调用者（支付超时 worker 等）传 null →
   * 只冲正 + 审计，不建待办。
   */
  reminderCreatedById: string | null;
  at?: Date;
}

export interface AutoReversedRedemption {
  profileId: string;
  profileName: string;
  originalId: string;
  reversalId: string;
  /** 补回的次数（正数）。 */
  tripsUsed: number;
  benefit: string;
  /** 原核销挂的单（拆单场景下可能是源单，不一定等于触发单）。 */
  orderId: string;
}

type RedemptionCandidate = {
  id: string;
  profileId: string;
  tripsUsed: number;
  benefit: string;
  orderId: string | null;
  profile: { id: string; fullName: string; documentType: string; documentNumber: string };
};

/** 本文件用到的 delegate 子集（防御式取：老 mock 没有时整段跳过）。 */
interface AutoReverseDelegates {
  travelerBenefitRedemption?: {
    findMany?: (args: unknown) => Promise<unknown[] | undefined>;
    createMany?: (args: unknown) => Promise<{ count: number }>;
  };
  orderSplitRecord?: {
    findMany?: (
      args: unknown,
    ) => Promise<Array<{ sourceOrderId?: string; targetOrderId?: string }> | undefined>;
  };
  passenger?: {
    findMany?: (
      args: unknown,
    ) => Promise<Array<{ documentType: string; documentNumber: string }> | undefined>;
  };
  travelerProfile?: {
    findMany?: (args: unknown) => Promise<
      | Array<{ id: string; mergedIntoId: string | null; documentType: string; documentNumber: string }>
      | undefined
    >;
  };
  order?: {
    findMany?: (args: unknown) => Promise<CarriedOrderRow[] | undefined>;
  };
  auditLog?: { create?: unknown };
  operationalReminder?: {
    findUnique?: (args: unknown) => Promise<{ id: string } | null>;
    create?: (args: unknown) => Promise<{ id: string }>;
  };
}

/** 「仍有有效行程」判定要读的订单形状（状态 + 乘客证件 + 航段班次时刻 / no-show 标）。 */
type CarriedOrderRow = {
  id: string;
  status: string;
  passengers: Array<{ documentType: string; documentNumber: string }>;
  items: Array<{
    metadata: unknown;
    flightSchedule: { departureTime: Date } | null;
  }>;
};

/** 与 traveler-profiles.aggregate 的 docKey 同一口径（类型 + 号码，trim + 大写）；入参放宽为 string。 */
function normDoc(documentType: string, documentNumber: string): string {
  return `${documentType}|${(documentNumber ?? '').trim().toUpperCase()}`;
}

/**
 * 对一张单执行自动冲正；返回本次追加的补偿行（空数组 = 这单没有可冲的核销）。
 * 幂等：已冲正过的行（reversedBy 非空）不在候选集；重复取消 / 再次打标不会二次冲正。
 */
export async function autoReverseRedemptionsForOrderWithinTx(
  tx: Prisma.TransactionClient,
  input: AutoReverseRedemptionsInput,
): Promise<AutoReversedRedemption[]> {
  const delegates = tx as unknown as AutoReverseDelegates;
  const redemptionDelegate = delegates.travelerBenefitRedemption;
  if (
    typeof redemptionDelegate?.findMany !== 'function' ||
    typeof redemptionDelegate?.createMany !== 'function'
  ) {
    return [];
  }
  const at = input.at ?? new Date();

  // 拆单一跳：本单若是从某张源单拆出来的，源单上挂的核销也在候选里（下面再按证件收窄）。
  const splitDelegate = delegates.orderSplitRecord;
  const splitRows =
    typeof splitDelegate?.findMany === 'function'
      ? ((await splitDelegate.findMany({
          where: { targetOrderId: input.orderId },
          select: { sourceOrderId: true },
        })) ?? [])
      : [];
  const sourceOrderIds = [
    ...new Set(splitRows.map((r) => r.sourceOrderId).filter((id): id is string => !!id)),
  ];

  const candidates = ((await redemptionDelegate.findMany({
    where: {
      orderId: { in: [input.orderId, ...sourceOrderIds] },
      tripsUsed: { gt: 0 },
      reversedBy: null,
    },
    select: {
      id: true,
      profileId: true,
      tripsUsed: true,
      benefit: true,
      orderId: true,
      profile: {
        select: { id: true, fullName: true, documentType: true, documentNumber: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  })) ?? []) as RedemptionCandidate[];
  if (candidates.length === 0) return [];

  const { toReverse, skipped } = await decideCandidates(
    delegates,
    input.orderId,
    candidates,
    sourceOrderIds,
    at,
  );
  // 仍有有效行程的：不冲正，只留一条 INFO 审计（运营核对时能看到系统为什么没补回）
  if (skipped.length > 0 && typeof delegates.auditLog?.create === 'function') {
    for (const { candidate: row, carriedByOrderIds } of skipped) {
      await writeAuditWithinTx(tx, {
        actor: { label: BENEFIT_AUTO_REVERSAL_ACTOR_NAME, role: 'SYSTEM' },
        action: BENEFIT_AUTO_REVERSE_SKIPPED_AUDIT_ACTION,
        targetType: AuditTargetType.TRAVELER,
        targetId: row.profileId,
        targetLabel: row.profile.fullName,
        severity: AuditSeverity.INFO,
        before: {
          redemptionId: row.id,
          tripsUsed: row.tripsUsed,
          benefit: row.benefit,
          orderId: row.orderId,
        },
        after: {
          reason: input.reason,
          triggerOrderId: input.orderId,
          triggerOrderNumber: input.orderNumber,
          carriedByOrderIds,
          note: '核销挂单已取消 / no-show，但旅客仍有有效行程，未补回',
        },
      });
    }
  }
  if (toReverse.length === 0) return [];

  const note = `${input.reason}（订单 ${input.orderNumber}），系统自动冲正`;
  await redemptionDelegate.createMany({
    data: toReverse.map((row) => ({
      profileId: row.profileId,
      tripsUsed: -row.tripsUsed,
      benefit: row.benefit,
      note,
      reversalOfId: row.id,
      orderId: row.orderId,
      // 触发单：拆单场景下 ≠ orderId（核销挂源单、触发的是拆出去的目标单），恢复目标单时靠它找提示
      triggeredByOrderId: input.orderId,
      createdById: BENEFIT_AUTO_REVERSAL_ACTOR_ID,
      createdByName: BENEFIT_AUTO_REVERSAL_ACTOR_NAME,
      createdAt: at,
    })),
    // reversalOfId 唯一：与人工冲正撞上时 ON CONFLICT DO NOTHING，事务不废
    skipDuplicates: true,
  });
  // createMany 不回 id：按 reversalOfId 读回真正落库的那几条（被人工抢先冲正的不在其中）
  const written = ((await redemptionDelegate.findMany({
    where: {
      reversalOfId: { in: toReverse.map((r) => r.id) },
      createdById: BENEFIT_AUTO_REVERSAL_ACTOR_ID,
    },
    select: { id: true, reversalOfId: true },
  })) ?? []) as Array<{ id: string; reversalOfId: string | null }>;
  const reversalIdByOriginal = new Map<string, string>();
  for (const w of written) {
    if (w.reversalOfId) reversalIdByOriginal.set(w.reversalOfId, w.id);
  }

  const results: AutoReversedRedemption[] = [];
  for (const row of toReverse) {
    const reversalId = reversalIdByOriginal.get(row.id);
    if (!reversalId) continue; // 人工冲正抢先了：那条已经补回，不重复记
    const result: AutoReversedRedemption = {
      profileId: row.profileId,
      profileName: row.profile.fullName,
      originalId: row.id,
      reversalId,
      tripsUsed: row.tripsUsed,
      benefit: row.benefit,
      orderId: row.orderId ?? input.orderId,
    };
    results.push(result);

    if (typeof delegates.auditLog?.create === 'function') {
      await writeAuditWithinTx(tx, {
        actor: { label: BENEFIT_AUTO_REVERSAL_ACTOR_NAME, role: 'SYSTEM' },
        action: BENEFIT_AUTO_REVERSED_AUDIT_ACTION,
        targetType: AuditTargetType.TRAVELER,
        targetId: row.profileId,
        targetLabel: row.profile.fullName,
        severity: AuditSeverity.WARNING,
        before: {
          redemptionId: row.id,
          tripsUsed: row.tripsUsed,
          benefit: row.benefit,
          orderId: row.orderId,
        },
        after: {
          reversalId,
          tripsUsed: -row.tripsUsed,
          reason: input.reason,
          triggerOrderId: input.orderId,
          triggerOrderNumber: input.orderNumber,
        },
      });
    }

    if (input.reminderCreatedById) {
      await createAutoReversalReminder(delegates, {
        createdById: input.reminderCreatedById,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        reason: input.reason,
        at,
        reversal: result,
      });
    }
  }
  return results;
}

/** 候选 → 冲正 / 跳过（仍有有效行程，附承载行程的单号）。 */
interface CandidateDecision {
  toReverse: RedemptionCandidate[];
  skipped: Array<{ candidate: RedemptionCandidate; carriedByOrderIds: string[] }>;
}

/**
 * 两道收窄：
 *   1. 拆单一跳：挂在源单（拆单前）上的核销，只认「该档案的证件出现在本单乘客里」的那几条 ——
 *      留在源单上的客人照常飞，他们的核销不该被拆出去的那张单连坐；挂在本单上的直接进第二道。
 *   2. 仍有有效行程（评审 F1）：不论挂本单还是源单，该档案（全部证件）此刻若还在**别的**有效
 *      已付款单上承载着行程，就不冲正 —— 拆到 B 照常出行的客人，A 取消时不能给他补回次数。
 * 档案证件 = 主档案本证 + 合并链上全部旧证（任意深度，防环），与 getDetail / resolveDocPairs 同一套解析。
 */
async function decideCandidates(
  delegates: AutoReverseDelegates,
  orderId: string,
  candidates: RedemptionCandidate[],
  sourceOrderIds: string[],
  at: Date,
): Promise<CandidateDecision> {
  const docsByProfile = await loadCandidateDocs(delegates, candidates);

  const direct = candidates.filter((c) => c.orderId === orderId);
  const viaSource = candidates.filter((c) => c.orderId !== orderId);
  let narrowed = direct;
  if (viaSource.length > 0 && typeof delegates.passenger?.findMany === 'function') {
    const passengers =
      (await delegates.passenger.findMany({
        where: { orderId },
        select: { documentType: true, documentNumber: true },
      })) ?? [];
    const orderDocs = new Set(passengers.map((p) => normDoc(p.documentType, p.documentNumber)));
    const matched = viaSource.filter((c) => {
      for (const d of docsByProfile.get(c.profileId) ?? []) if (orderDocs.has(d)) return true;
      return false;
    });
    narrowed = [...direct, ...matched];
  }
  if (narrowed.length === 0) return { toReverse: [], skipped: [] };

  const carriedByDoc = await findCarriedOrderIdsByDoc(
    delegates,
    orderId,
    narrowed,
    docsByProfile,
    sourceOrderIds,
    at,
  );
  const toReverse: RedemptionCandidate[] = [];
  const skipped: CandidateDecision['skipped'] = [];
  for (const c of narrowed) {
    const carried = new Set<string>();
    for (const d of docsByProfile.get(c.profileId) ?? []) {
      for (const id of carriedByDoc.get(d) ?? []) carried.add(id);
    }
    if (carried.size > 0) skipped.push({ candidate: c, carriedByOrderIds: [...carried].sort() });
    else toReverse.push(c);
  }
  return { toReverse, skipped };
}

/**
 * 候选档案 → 全部证件（归一化 key）。沿 mergedIntoId 链解析到主档案再取链上全部旧证
 * （traveler-profile-alias.ts，与档案详情同源）；档案表拉不到（老 mock）时退回候选自带的本证。
 */
async function loadCandidateDocs(
  delegates: AutoReverseDelegates,
  candidates: RedemptionCandidate[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (!out.has(c.profileId)) {
      out.set(c.profileId, new Set([normDoc(c.profile.documentType, c.profile.documentNumber)]));
    }
  }
  if (typeof delegates.travelerProfile?.findMany !== 'function') return out;
  const rows =
    (await delegates.travelerProfile.findMany({
      select: { id: true, mergedIntoId: true, documentType: true, documentNumber: true },
    })) ?? [];
  const refs = new Map<string, ProfileRef>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        mergedIntoId: r.mergedIntoId,
        documentType: r.documentType as DocumentType,
        documentNumber: r.documentNumber,
      },
    ]),
  );
  const { docPairsByMasterId } = buildAliasIndex(refs);
  for (const profileId of out.keys()) {
    const pairs = docPairsForProfile(profileId, refs, docPairsByMasterId);
    if (!pairs) continue;
    const set = out.get(profileId)!;
    for (const pair of pairs) set.add(normDoc(pair.documentType, pair.documentNumber));
  }
  return out;
}

/**
 * 「仍有有效行程」的判定（评审 F1）：证件 key → 承载着行程的订单 id。
 *
 * 有效 = 未软删、状态在已付款在订集（countsAsPaidUpcoming：PAID/PROCESSING/TICKETED/COMPLETED/
 * CHANGE_REQUESTED/CHANGED，与可用次数口径同一份）、**不是触发单本身**（触发单正在落终态 /
 * 刚打了 no-show 标，事务内可能还没写回状态）。
 * 承载行程 = 满足其一：
 *   a. 去程尚未起飞（班次时刻 > 现在）且没打 no-show 标 —— 这次核销的额度会被那趟行程用掉；
 *   b. 该单与核销挂的单同属一条拆单链（源单 / 一跳目标单）且没打 no-show 标 —— 拆出去的那张单
 *      就是核销时的同一趟行程，哪怕已经飞了也是「行程没少」（评审的原始反例正是 B 已正常出行）。
 * 老 mock 没有 order delegate 时视为没有有效行程（行为同改造前，只影响 mock）。
 */
async function findCarriedOrderIdsByDoc(
  delegates: AutoReverseDelegates,
  orderId: string,
  candidates: RedemptionCandidate[],
  docsByProfile: Map<string, Set<string>>,
  sourceOrderIds: string[],
  at: Date,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (typeof delegates.order?.findMany !== 'function') return out;

  const docFilters: Array<{ documentType: string; documentNumber: string }> = [];
  const seenDoc = new Set<string>();
  for (const c of candidates) {
    for (const key of docsByProfile.get(c.profileId) ?? []) {
      if (seenDoc.has(key)) continue;
      seenDoc.add(key);
      const sep = key.indexOf('|');
      docFilters.push({ documentType: key.slice(0, sep), documentNumber: key.slice(sep + 1) });
    }
  }
  if (docFilters.length === 0) return out;

  // 拆单谱系一跳：本单的源单 + 候选挂的单 + 这些单拆出去的目标单。候选挂的单**包含本单**：
  // 触发单 = A 本身时，从 A 拆出去的 B 正是「客人现在所在的同一趟行程」（评审的原始反例）。
  const candidateOrderIds = [
    ...new Set(candidates.map((c) => c.orderId).filter((id): id is string => !!id)),
  ];
  const lineage = new Set<string>([...sourceOrderIds, ...candidateOrderIds]);
  if (candidateOrderIds.length > 0 && typeof delegates.orderSplitRecord?.findMany === 'function') {
    const targets =
      (await delegates.orderSplitRecord.findMany({
        where: { sourceOrderId: { in: candidateOrderIds } },
        select: { targetOrderId: true },
      })) ?? [];
    for (const t of targets) if (t.targetOrderId) lineage.add(t.targetOrderId);
  }
  lineage.delete(orderId);

  const rows =
    (await delegates.order.findMany({
      where: {
        id: { not: orderId },
        deletedAt: null,
        status: { notIn: EXCLUDED_ORDER_STATUSES },
        passengers: {
          some: {
            OR: docFilters.map((d) => ({
              documentType: d.documentType,
              documentNumber: { equals: d.documentNumber, mode: 'insensitive' },
            })),
          },
        },
      },
      select: {
        id: true,
        status: true,
        passengers: { select: { documentType: true, documentNumber: true } },
        items: { select: { metadata: true, flightSchedule: { select: { departureTime: true } } } },
      },
    })) ?? [];

  for (const order of rows) {
    if (!countsAsPaidUpcoming(order.status as Parameters<typeof countsAsPaidUpcoming>[0])) continue;
    const legs = order.items
      .filter((i): i is typeof i & { flightSchedule: { departureTime: Date } } =>
        i.flightSchedule?.departureTime != null,
      )
      .sort((a, b) => a.flightSchedule.departureTime.getTime() - b.flightSchedule.departureTime.getTime());
    const outbound = legs[0] ?? null;
    if (!outbound || hasNoShowMark(outbound.metadata)) continue;
    const unflown = outbound.flightSchedule.departureTime.getTime() > at.getTime();
    if (!unflown && !lineage.has(order.id)) continue;
    for (const p of order.passengers) {
      const key = normDoc(p.documentType, p.documentNumber);
      if (!seenDoc.has(key)) continue;
      const list = out.get(key) ?? [];
      list.push(order.id);
      out.set(key, list);
    }
  }
  return out;
}

/** 给运营的待办：一条补偿行一条，ruleKey 幂等（先查后建，事务内不能 create+catch）。 */
async function createAutoReversalReminder(
  delegates: AutoReverseDelegates,
  input: {
    createdById: string;
    orderId: string;
    orderNumber: string;
    reason: string;
    at: Date;
    reversal: AutoReversedRedemption;
  },
): Promise<void> {
  const reminderDelegate = delegates.operationalReminder;
  if (
    typeof reminderDelegate?.findUnique !== 'function' ||
    typeof reminderDelegate?.create !== 'function'
  ) {
    return;
  }
  const ruleKey = `${BENEFIT_AUTO_REVERSAL_REMINDER_PREFIX}${input.reversal.reversalId}`;
  const existing = await reminderDelegate.findUnique({ where: { ruleKey }, select: { id: true } });
  if (existing) return;
  await reminderDelegate.create({
    data: {
      orderId: input.orderId,
      createdById: input.createdById,
      title: `【核销已自动冲正】${input.orderNumber} ${input.reversal.profileName} 补回 ${input.reversal.tripsUsed} 次`,
      body:
        `${input.reason}，该单挂的权益核销「${input.reversal.benefit}」（${input.reversal.tripsUsed} 次）` +
        `已由系统自动冲正，可用次数已补回。请知会客人；若这张单之后恢复占位，系统不会自动再核销，` +
        `需要时请到常旅客档案重新核销。`,
      dueAt: new Date(`${businessDateISO(input.at)}T00:00:00Z`),
      priority: ReminderPriority.HIGH,
      ruleKey,
    },
    select: { id: true },
  });
}
