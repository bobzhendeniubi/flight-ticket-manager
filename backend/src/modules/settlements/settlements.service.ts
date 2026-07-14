/**
 * 结算服务 — 月度结算单 generate / list / detail / updateStatus。
 *
 * 核心概念：
 * - 结算期 (period) = YYYY-MM，按订单 PAID 时间归属（PAID 发生在 2026-04 就归 2026-04）
 * - 每代理每月 1 张结算单（unique period+agentId）
 * - 字段含义：
 *   grossRevenue            = Σ order.total for orders this agent is the direct seller of, paid in period
 *   commissionEarned        = Σ CommissionRecord.amount where agent=this, status=ACCRUED, in period
 *   commissionPaidToChildren = Σ CommissionRecord.amount for descendant agents, on orders this agent is in chain of
 *                             （信息展示字段；不影响 netCommission 的计算，因 records 已是净额）
 *   netCommission           = commissionEarned（records 本身已经是链路扣除后的净额）
 *   prepaymentOffset        = min(netCommission, agent.prepaymentBalance) —— 抵扣预付余额
 *   payableToAgent          = netCommission - prepaymentOffset
 *
 * 状态机：DRAFT → PENDING_APPROVAL → APPROVED → PAID
 *   PAID 时：  CommissionRecord.status ACCRUED → SETTLED；PrepaymentTransaction 写一条 OFFSET
 *   VOIDED 时：关联 records 回 ACCRUED（可重算）
 */
import {
  CommissionStatus,
  Prisma,
  PrepaymentTxType,
  SettlementStatus,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import type {
  GenerateSettlementsBody,
  ListSettlementsQuery,
} from './settlements.schemas.js';

const ALLOWED_TRANSITIONS: Record<SettlementStatus, SettlementStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'VOIDED'],
  PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'VOIDED'],
  APPROVED: ['PAID', 'PENDING_APPROVAL', 'VOIDED'],
  PAID: [], // 终态
  VOIDED: [],
};

export interface SettlementRequester {
  userId: string;
  role: UserRole;
  agentId?: string;
}

export class SettlementService {
  // ════════════════════════════════════════════════════════════════════
  // 生成
  // ════════════════════════════════════════════════════════════════════
  async generate(body: GenerateSettlementsBody, requester: SettlementRequester) {
    if (requester.role !== 'ADMIN' && requester.role !== 'STAFF') {
      throw new ForbiddenError('仅管理员可生成结算单');
    }

    const { period, agentId, overwrite } = body;
    const { start, end } = periodToDateRange(period);

    // 候选代理 = 期内有 ACCRUED records 的 ∪ 已有当期结算单的（包括 SETTLED/PAID）
    const agentCandidates = agentId
      ? [agentId]
      : await this.findAgentsWithActivity(period);

    const generated: Array<{ agentId: string; settlementId: string; status: SettlementStatus; action: string }> = [];

    for (const aId of agentCandidates) {
      // 幂等：查当期是否已有结算单
      const existing = await prisma.settlement.findUnique({
        where: { period_agentId: { period, agentId: aId } },
      });
      if (existing) {
        if (existing.status === 'PAID' || existing.status === 'APPROVED') {
          generated.push({ agentId: aId, settlementId: existing.id, status: existing.status, action: 'skipped' });
          continue;
        }
        if (!overwrite) {
          generated.push({ agentId: aId, settlementId: existing.id, status: existing.status, action: 'exists' });
          continue;
        }
      }

      const computed = await this.computeSettlement(aId, period, start, end);

      const settlement = await prisma.$transaction(async (tx) => {
        let s;
        if (existing) {
          // ── 原子 CAS：只允许「非已审核/已支付」的当期结算单被重算 ──
          // existing.status 是事务外读的快照；此后可能被并发 updateStatus 推到 APPROVED/PAID。
          // 无 CAS 时 overwrite 分支会无条件把它打回 DRAFT 并解绑 records —— 若已 PAID：offset 已扣、
          // records 已 SETTLED 却被解绑回 unlinked → 账面孤儿 + 下期 generate 重复计入双付。
          // 用 updateMany 附加 status notIn[APPROVED,PAID] 一步完成「检查+重置」：拿到行锁的同时确认
          // 状态可重算，命中 count=1；被并发推进到 APPROVED/PAID 则 count=0 → 拒绝重算（整体回滚）。
          const casReset = await tx.settlement.updateMany({
            where: {
              id: existing.id,
              status: { notIn: [SettlementStatus.APPROVED, SettlementStatus.PAID] },
            },
            data: {
              orderCount: computed.orderCount,
              grossRevenue: new Prisma.Decimal(computed.grossRevenue),
              commissionEarned: new Prisma.Decimal(computed.commissionEarned),
              commissionPaidToChildren: new Prisma.Decimal(computed.commissionPaidToChildren),
              netCommission: new Prisma.Decimal(computed.netCommission),
              prepaymentOffset: new Prisma.Decimal(computed.prepaymentOffset),
              payableToAgent: new Prisma.Decimal(computed.payableToAgent),
              status: SettlementStatus.DRAFT,
              generatedAt: new Date(),
              approvedAt: null,
              paidAt: null,
            },
          });
          if (casReset.count !== 1) {
            throw new ConflictError(
              `结算单 ${period} 已被并发推进到已审核/已支付，拒绝重算；如需重算请先作废该单`,
            );
          }
          // 状态已确认可重算且行锁在手：解绑旧 records（回 unlinked），下方再按新计算重新绑定。
          await tx.commissionRecord.updateMany({
            where: { settlementId: existing.id },
            data: { settlementId: null },
          });
          s = await tx.settlement.findUniqueOrThrow({ where: { id: existing.id } });
        } else {
          s = await tx.settlement.create({
            data: {
              period,
              agentId: aId,
              orderCount: computed.orderCount,
              grossRevenue: new Prisma.Decimal(computed.grossRevenue),
              commissionEarned: new Prisma.Decimal(computed.commissionEarned),
              commissionPaidToChildren: new Prisma.Decimal(computed.commissionPaidToChildren),
              netCommission: new Prisma.Decimal(computed.netCommission),
              prepaymentOffset: new Prisma.Decimal(computed.prepaymentOffset),
              payableToAgent: new Prisma.Decimal(computed.payableToAgent),
            },
          });
        }

        // 绑定 records 到该 settlement
        if (computed.recordIds.length > 0) {
          await tx.commissionRecord.updateMany({
            where: { id: { in: computed.recordIds } },
            data: { settlementId: s.id },
          });
        }
        return s;
      });

      generated.push({
        agentId: aId,
        settlementId: settlement.id,
        status: settlement.status,
        action: existing ? 'regenerated' : 'created',
      });
    }

    return { period, generated };
  }

  // 找出当期有 ACCRUED 佣金的所有代理 ∪ 已有结算单的代理（保证重算能打到 SETTLED 后的单子）
  private async findAgentsWithActivity(period: string): Promise<string[]> {
    const { start, end } = periodToDateRange(period);
    const ids = new Set<string>();
    const accruedRows = await prisma.commissionRecord.findMany({
      where: {
        status: CommissionStatus.ACCRUED,
        createdAt: { gte: start, lt: end },
      },
      select: { agentId: true },
      distinct: ['agentId'],
    });
    accruedRows.forEach((r) => ids.add(r.agentId));
    // 也纳入「本期只有退款冲销、没有新佣金」的代理：跨期反冲的负数补偿记录必须
    // 进入某张结算单去追回，否则永远漏算（净额对不上 = 平台多付）。
    const reversedRows = await prisma.commissionRecord.findMany({
      where: {
        status: CommissionStatus.REVERSED,
        settlementId: null,
        createdAt: { gte: start, lt: end },
      },
      select: { agentId: true },
      distinct: ['agentId'],
    });
    reversedRows.forEach((r) => ids.add(r.agentId));
    const existing = await prisma.settlement.findMany({
      where: { period },
      select: { agentId: true },
    });
    existing.forEach((s) => ids.add(s.agentId));
    return Array.from(ids);
  }

  // 核心计算：对给定代理 + 期，汇总 GMV / earned / paidToChildren / offset / payable
  private async computeSettlement(
    agentId: string,
    _period: string,
    start: Date,
    end: Date,
  ) {
    // 1. 本人当期 ACCRUED 佣金 records
    const earnedRecords = await prisma.commissionRecord.findMany({
      where: {
        agentId,
        status: CommissionStatus.ACCRUED,
        createdAt: { gte: start, lt: end },
      },
      select: { id: true, amount: true, orderId: true },
    });

    const commissionEarned = earnedRecords.reduce((s, r) => s + Number(r.amount), 0);

    // 1b. 本人当期「退款冲销」records —— 尚未并入任何结算单的 REVERSED 记录
    // （settlementId=null）。两类来源：
    //   - 同期退款：整单冲销时被翻状态的 ACCRUED→REVERSED 记录（amount 仍为正）。
    //   - 跨期反冲：已结算订单退款时新建的「负数补偿记录」（amount<0）。
    // 这些必须并入本期 netCommission（追回多付的佣金），不能静默丢弃。
    const reversalRecords = await prisma.commissionRecord.findMany({
      where: {
        agentId,
        status: CommissionStatus.REVERSED,
        settlementId: null,
        createdAt: { gte: start, lt: end },
      },
      select: { id: true, amount: true, orderId: true },
    });
    // reversalAmount = 本期应从净佣金里冲回的总额，恒为非正数（≤0）。
    // 只累加「负数补偿记录」（amount<0）—— 它们代表对【已计入/已结算】佣金的真实追回
    // （部分退款的按比例冲销，或跨「已结算」边界的整额反冲）。
    // 同期被翻状态的 ACCRUED→REVERSED 记录（amount>0）【绝不在此扣减】：它们已因状态≠ACCRUED
    // 被排除在 commissionEarned 之外；若再取相反数减一次会【重复冲销】、误伤同期其他订单的佣金。
    const negativeReversals = reversalRecords.filter((r) => Number(r.amount) < 0);
    const reversalAmount = negativeReversals.reduce((s, r) => s + Number(r.amount), 0);
    const reversalCount = negativeReversals.length;

    const recordIds = [
      ...earnedRecords.map((r) => r.id),
      ...reversalRecords.map((r) => r.id),
    ];
    const relatedOrderIds = Array.from(
      new Set([
        ...earnedRecords.map((r) => r.orderId),
        ...reversalRecords.map((r) => r.orderId),
      ]),
    );

    // 2. 作为 seller 的订单数 + GMV（只算本人直销，上级代理的 grossRevenue 由他们自己算）
    const sellerOrders = await prisma.order.findMany({
      where: {
        agentId,
        status: { in: ['PAID', 'PROCESSING', 'TICKETED', 'COMPLETED'] },
        // 按 updatedAt 走 PAID 切入本期；简化：用 createdAt
        createdAt: { gte: start, lt: end },
      },
      select: { id: true, total: true },
    });
    const grossRevenue = sellerOrders.reduce((s, o) => s + Number(o.total), 0);
    const orderCount = sellerOrders.length;

    // 3. commissionPaidToChildren: 在上述 relatedOrderIds 里，查 chainDepth < 自己 chainDepth 的 records
    // 简化：查所有 records（本订单集合）且 agentId 是本代理的后代
    const descendantIds = await getDescendantAgentIds(agentId);
    const descendantSet = new Set(descendantIds.filter((id) => id !== agentId));
    let commissionPaidToChildren = 0;
    if (relatedOrderIds.length > 0 && descendantSet.size > 0) {
      const childRecords = await prisma.commissionRecord.findMany({
        where: {
          orderId: { in: relatedOrderIds },
          agentId: { in: Array.from(descendantSet) },
          status: CommissionStatus.ACCRUED,
        },
        select: { amount: true },
      });
      commissionPaidToChildren = childRecords.reduce((s, r) => s + Number(r.amount), 0);
    }

    // netCommission = 本期应计净佣金 + 本期退款冲销（reversalAmount ≤ 0）
    //   records 本身已是链路净额；reversalAmount 把退款追回的部分扣回（可使 net 变小甚至为负）。
    const netCommission = commissionEarned + reversalAmount;

    // 4. 预付抵扣：取 min(netCommission, 当前 prepaymentBalance)
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { prepaymentBalance: true },
    });
    const balance = Number(agent?.prepaymentBalance ?? 0);
    const prepaymentOffset = Math.max(0, Math.min(netCommission, balance));
    const payableToAgent = Math.max(0, netCommission - prepaymentOffset);

    return {
      orderCount,
      grossRevenue: round2(grossRevenue),
      commissionEarned: round2(commissionEarned),
      commissionPaidToChildren: round2(commissionPaidToChildren),
      netCommission: round2(netCommission),
      prepaymentOffset: round2(prepaymentOffset),
      payableToAgent: round2(payableToAgent),
      // 本期退款冲销摘要（reversalAmount ≤ 0）；recordIds 已含 REVERSED 记录，
      // generate 会把它们一并绑到本结算单（settlementId），下期不再重复计入。
      reversalCount,
      reversalAmount: round2(reversalAmount),
      recordIds,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 列表
  // ════════════════════════════════════════════════════════════════════
  async list(query: ListSettlementsQuery, requester: SettlementRequester) {
    const where: Prisma.SettlementWhereInput = {};

    let visibleAgentIds: string[] | null = null;
    if (requester.role === 'AGENT') {
      visibleAgentIds = await getDescendantAgentIds(requester.agentId);
      where.agentId = { in: visibleAgentIds };
    } else if (requester.role === 'CUSTOMER') {
      throw new ForbiddenError('客户无权查看结算单');
    }

    if (query.period) where.period = query.period;
    if (query.agentId) {
      // 防横向越权：query.agentId 必须在可见集合内
      if (visibleAgentIds !== null && !visibleAgentIds.includes(query.agentId)) {
        throw new ForbiddenError('无权查看该代理的结算单');
      }
      where.agentId = query.agentId;
    }
    if (query.status) where.status = query.status;

    const [rows, total] = await prisma.$transaction([
      prisma.settlement.findMany({
        where,
        include: {
          agent: {
            select: {
              id: true, companyName: true, contactName: true, tier: true,
              user: { select: { displayName: true } },
            },
          },
          // 只取汇总退款冲销所需的最小字段（status + amount），不展开订单
          commissions: { select: { status: true, amount: true } },
        },
        orderBy: [{ period: 'desc' }, { agent: { tier: 'asc' } }],
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.settlement.count({ where }),
    ]);

    return {
      settlements: rows.map((r) => serializeSettlement(r)),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 详情
  // ════════════════════════════════════════════════════════════════════
  async getById(id: string, requester: SettlementRequester) {
    const s = await prisma.settlement.findUnique({
      where: { id },
      include: {
        agent: {
          select: {
            id: true, companyName: true, contactName: true, tier: true, prepaymentBalance: true,
            user: { select: { displayName: true, email: true } },
          },
        },
        commissions: {
          include: {
            order: { select: { id: true, orderNumber: true, total: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!s) throw new NotFoundError('结算单不存在');

    await this.assertCanView(s.agentId, requester);
    return serializeSettlement(s, true);
  }

  // ════════════════════════════════════════════════════════════════════
  // 状态流转
  // ════════════════════════════════════════════════════════════════════
  async updateStatus(
    id: string,
    toStatus: SettlementStatus,
    requester: SettlementRequester,
    notes?: string,
  ) {
    if (requester.role !== 'ADMIN' && requester.role !== 'STAFF') {
      throw new ForbiddenError('仅管理员可改结算单状态');
    }

    const s = await prisma.settlement.findUnique({ where: { id } });
    if (!s) throw new NotFoundError('结算单不存在');

    const allowed = ALLOWED_TRANSITIONS[s.status];
    if (!allowed.includes(toStatus)) {
      throw new BadRequestError(
        `不允许从 ${s.status} 转移到 ${toStatus}（允许：${allowed.join(', ') || '无'}）`,
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      // ── 原子 CAS：where 附加事务外读到的当前状态，一步完成「校验+推进」──
      // 铁律：一笔钱最多入账/扣账一次。两个并发的 APPROVED→PAID（或 APPROVED→PAID 与
      // APPROVED→VOIDED 抢跑）都能基于同一份事务外快照进事务；仅靠 Agent FOR UPDATE 只串行化
      // 余额扣减本身，挡不住第二个事务再按同一 prepaymentOffset 写一条 OFFSET、再扣一次余额、
      // 把结算单二次标 PAID / records 二次 SETTLED。这里先对 Settlement 行做 CAS 抢锁：
      // 第一个事务把 status 从快照值改成 toStatus（拿到行锁，count=1）；第二个事务的 UPDATE
      // 在 READ COMMITTED 下阻塞到第一个提交后，重判 where（status 已非快照值）→ count=0 →
      // 抛 Conflict 整体回滚，绝不进入后面的扣余额 / 写 OFFSET / 翻 records。CAS 先于所有副作用，
      // 因此第二个事务连 Agent FOR UPDATE 都到不了（天然无锁序死锁）。
      const casResult = await tx.settlement.updateMany({
        where: { id, status: s.status },
        data: {
          status: toStatus,
          notes: notes ?? s.notes,
          approvedAt: toStatus === 'APPROVED' ? new Date() : s.approvedAt,
          paidAt: toStatus === 'PAID' ? new Date() : s.paidAt,
        },
      });
      if (casResult.count !== 1) {
        throw new ConflictError(
          `结算单状态已被并发修改（期望 ${s.status}，请重试）`,
        );
      }

      // 标记 PAID：records SETTLED + 写 PrepaymentTransaction（若 offset>0）
      if (toStatus === 'PAID') {
        await tx.commissionRecord.updateMany({
          where: { settlementId: s.id, status: CommissionStatus.ACCRUED },
          data: { status: CommissionStatus.SETTLED, settledAt: new Date() },
        });

        const offset = Number(s.prepaymentOffset);
        if (offset > 0) {
          // FOR UPDATE 行锁：两张结算单并发批准时防止用同一余额快照双扣（透支）
          const agentRows = await tx.$queryRaw<Array<{ prepaymentBalance: Prisma.Decimal }>>`
            SELECT "prepaymentBalance" FROM "Agent" WHERE id = ${s.agentId} FOR UPDATE
          `;
          if (!agentRows[0]) throw new NotFoundError('代理不存在');
          const freshBalance = Number(agentRows[0].prepaymentBalance);
          // prepaymentOffset 是「生成结算单当时」的余额快照；生成后余额可能已被订单抵扣消耗。
          // 余额不允许为负（不许赊账），且已审核的结算数字不悄悄改 ——
          // 余额不足以覆盖快照抵扣时拒绝转 PAID，让财务作废本单后按当前余额重新生成。
          if (offset > freshBalance + 0.001) {
            throw new BadRequestError(
              `代理当前预存余额 ¥${freshBalance.toFixed(2)} 已不足以覆盖本单抵扣 ¥${offset.toFixed(2)}` +
                '（生成结算单后余额有新消耗）；请作废本单后重新生成',
            );
          }
          const newBalance = round2(freshBalance - offset);
          await tx.agent.update({
            where: { id: s.agentId },
            data: { prepaymentBalance: new Prisma.Decimal(newBalance) },
          });
          await tx.prepaymentTransaction.create({
            data: {
              agentId: s.agentId,
              amount: new Prisma.Decimal(-offset),
              balanceAfter: new Prisma.Decimal(newBalance),
              type: PrepaymentTxType.OFFSET,
              description: `结算单 ${s.period} 抵扣`,
              createdById: requester.userId,
            },
          });
        }
      }

      // VOIDED：records 回 ACCRUED（可重算）。CAS 已抢到本次流转，故这里的 records 回滚
      // 每单只会执行一次；并发的第二个 VOID（或 PAID 抢跑）已在 CAS 处被挡下回滚。
      // 解绑 where 额外押 status=ACCRUED：绝不碰已 SETTLED 的记录 —— 那属于已扣 offset 的
      // 已支付结算单，若被解绑回 unlinked 会被下期 generate 重复计入 → 佣金双付。此过滤与
      // PAID 分支的 ACCRUED→SETTLED 天然互斥：同一条记录不会同时被两个方向命中。
      if (toStatus === 'VOIDED') {
        await tx.commissionRecord.updateMany({
          where: { settlementId: s.id, status: CommissionStatus.ACCRUED },
          data: { settlementId: null, settledAt: null },
        });
      }

      // 状态/notes/时间戳已由上面的 CAS 原子写入；这里只读回带 include 的完整结算单返回。
      return tx.settlement.findUniqueOrThrow({
        where: { id },
        include: {
          agent: {
            select: {
              id: true, companyName: true, contactName: true, tier: true,
              user: { select: { displayName: true, email: true } },
            },
          },
          commissions: {
            include: { order: { select: { id: true, orderNumber: true, total: true } } },
          },
        },
      });
    });

    return serializeSettlement(updated, true);
  }

  private async assertCanView(agentId: string, requester: SettlementRequester) {
    if (requester.role === 'ADMIN' || requester.role === 'STAFF') return;
    if (requester.role === 'AGENT') {
      const ids = await getDescendantAgentIds(requester.agentId);
      if (!ids.includes(agentId)) throw new ForbiddenError('无权查看该结算单');
      return;
    }
    throw new ForbiddenError('无权查看结算单');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────
function periodToDateRange(period: string): { start: Date; end: Date } {
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start, end };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// getDescendantAgentIds — 已抽到 lib/agent-tree.ts

// ── Serializer ───────────────────────────────────────────────────────
type SettlementWithAgent = Prisma.SettlementGetPayload<{
  include: {
    agent: {
      select: {
        id: true; companyName: true; contactName: true; tier: true;
        user: { select: { displayName: true; email: true } };
      };
    };
  };
}>;

// 从结算单已绑定的佣金记录里汇总「本期退款冲销」摘要：
//   count = REVERSED 记录条数；amount = 这些记录金额之和（恒 ≤ 0）。
// 便于财务在结算单上直观看到「本期退款冲销 N 笔 / ¥X」。
type ReversalSummary = { reversalCount: number; reversalAmount: string };
function summarizeReversals(
  commissions: Array<{ status: string; amount: Prisma.Decimal }> | undefined,
): ReversalSummary {
  if (!commissions) return { reversalCount: 0, reversalAmount: '0' };
  // 只统计「负数补偿记录」（真实追回）；同期翻状态的正数 REVERSED 不计入（与 computeSettlement 口径一致）。
  const reversed = commissions.filter((c) => c.status === 'REVERSED' && Number(c.amount) < 0);
  const total = reversed.reduce((sum, c) => sum + Number(c.amount), 0);
  return { reversalCount: reversed.length, reversalAmount: round2(total).toString() };
}

function serializeSettlement<T extends SettlementWithAgent | (SettlementWithAgent & { commissions?: unknown })>(
  s: T,
  includeCommissions = false,
): unknown {
  const boundCommissions = 'commissions' in s
    ? (s.commissions as Array<{ status: string; amount: Prisma.Decimal }> | undefined)
    : undefined;
  const reversalSummary = summarizeReversals(boundCommissions);

  const base = {
    id: s.id,
    period: s.period,
    agentId: s.agentId,
    orderCount: s.orderCount,
    grossRevenue: s.grossRevenue.toString(),
    commissionEarned: s.commissionEarned.toString(),
    commissionPaidToChildren: s.commissionPaidToChildren.toString(),
    netCommission: s.netCommission.toString(),
    prepaymentOffset: s.prepaymentOffset.toString(),
    payableToAgent: s.payableToAgent.toString(),
    // 本期退款冲销摘要（amount ≤ 0）。从绑定的 REVERSED 佣金记录汇总；list 与详情均带。
    reversalCount: reversalSummary.reversalCount,
    reversalAmount: reversalSummary.reversalAmount,
    status: s.status,
    generatedAt: s.generatedAt,
    approvedAt: s.approvedAt,
    paidAt: s.paidAt,
    notes: s.notes,
    agent: {
      id: s.agent.id,
      companyName: s.agent.companyName,
      contactName: s.agent.contactName,
      tier: s.agent.tier,
      displayName: s.agent.user?.displayName ?? null,
      email: (s.agent.user as { email?: string | null } | undefined)?.email ?? null,
    },
  };

  if (includeCommissions && 'commissions' in s) {
    const commissions = (s.commissions as Array<{
      id: string; productKind: string; baseAmount: Prisma.Decimal; rate: Prisma.Decimal;
      amount: Prisma.Decimal; chainDepth: number; status: string; createdAt: Date;
      order: { id: string; orderNumber: string; total: Prisma.Decimal };
    }>) ?? [];
    return {
      ...base,
      commissions: commissions.map((c) => ({
        id: c.id,
        productKind: c.productKind,
        baseAmount: c.baseAmount.toString(),
        rate: c.rate.toString(),
        amount: c.amount.toString(),
        chainDepth: c.chainDepth,
        status: c.status,
        createdAt: c.createdAt,
        order: {
          id: c.order.id,
          orderNumber: c.order.orderNumber,
          total: c.order.total.toString(),
        },
      })),
    };
  }

  return base;
}
