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
 * 并发：补偿行走 createMany(skipDuplicates) —— reversalOfId 唯一索引撞上人工冲正时
 * ON CONFLICT DO NOTHING，**不会**把整个取消事务打成 aborted（Postgres 里一条失败语句
 * 会废掉整个事务，create + catch(P2002) 在事务内是不能用的）。
 *
 * 老单测的 prisma mock 没有本文件用到的 delegate：缺 delegate 时整段跳过（真 client 永远齐全，
 * 这个守卫只影响 mock；口径同 reminders.rules.upgrade-redeem.ts 的取数守卫）。
 */
import { AuditSeverity, AuditTargetType, ReminderPriority, type Prisma } from '@prisma/client';
import { writeAuditWithinTx } from '../../lib/audit.js';
import { businessDateISO } from '../../lib/business-time.js';

/** 自动冲正行的 createdById：不是真实账号，台账 / 前端据此识别「系统自动」。 */
export const BENEFIT_AUTO_REVERSAL_ACTOR_ID = 'system-benefit-auto-reversal';
/** 自动冲正行的操作人姓名快照（产品里可见的文案）。 */
export const BENEFIT_AUTO_REVERSAL_ACTOR_NAME = '系统自动';
export const BENEFIT_AUTO_REVERSED_AUDIT_ACTION = 'BENEFIT_REDEMPTION_AUTO_REVERSED';
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
    findMany?: (args: unknown) => Promise<Array<{ sourceOrderId: string }> | undefined>;
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
  auditLog?: { create?: unknown };
  operationalReminder?: {
    findUnique?: (args: unknown) => Promise<{ id: string } | null>;
    create?: (args: unknown) => Promise<{ id: string }>;
  };
}

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
  const sourceOrderIds = [...new Set(splitRows.map((r) => r.sourceOrderId))];

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

  const toReverse = await narrowSplitCandidates(delegates, input.orderId, candidates);
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

/**
 * 候选收窄：挂在本单上的一律冲；挂在源单（拆单前）上的，只冲「该档案的证件出现在本单乘客里」
 * 的那几条 —— 留在源单上的客人照常飞，他们的核销不该被拆出去的那张单连坐。
 * 档案证件 = 主档案本证 + 一跳指针行（merge() 只允许并入 canonical 行，链深恒为 1）。
 */
async function narrowSplitCandidates(
  delegates: AutoReverseDelegates,
  orderId: string,
  candidates: RedemptionCandidate[],
): Promise<RedemptionCandidate[]> {
  const direct = candidates.filter((c) => c.orderId === orderId);
  const viaSource = candidates.filter((c) => c.orderId !== orderId);
  if (viaSource.length === 0) return direct;
  if (
    typeof delegates.passenger?.findMany !== 'function' ||
    typeof delegates.travelerProfile?.findMany !== 'function'
  ) {
    return direct;
  }
  const passengers =
    (await delegates.passenger.findMany({
      where: { orderId },
      select: { documentType: true, documentNumber: true },
    })) ?? [];
  const orderDocs = new Set(passengers.map((p) => normDoc(p.documentType, p.documentNumber)));
  const profileIds = [...new Set(viaSource.map((c) => c.profileId))];
  const profileRows =
    (await delegates.travelerProfile.findMany({
      where: { OR: [{ id: { in: profileIds } }, { mergedIntoId: { in: profileIds } }] },
      select: { id: true, mergedIntoId: true, documentType: true, documentNumber: true },
    })) ?? [];
  const docsByMaster = new Map<string, Set<string>>();
  for (const row of profileRows) {
    const masterId = row.mergedIntoId ?? row.id;
    const set = docsByMaster.get(masterId) ?? new Set<string>();
    set.add(normDoc(row.documentType, row.documentNumber));
    docsByMaster.set(masterId, set);
  }
  const matched = viaSource.filter((c) => {
    const docs = docsByMaster.get(c.profileId);
    if (!docs) return false;
    for (const d of docs) if (orderDocs.has(d)) return true;
    return false;
  });
  return [...direct, ...matched];
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
