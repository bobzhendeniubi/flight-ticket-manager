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
 *   prepaymentOffset        = 恒为 0（已停用，见下方说明）；历史结算单上的非零值仅保留展示/对账用途
 *   payableToAgent          = max(0, netCommission)
 *
 * ⚠️ 预付余额抵扣已停用（资金双吃修复）：
 *   代理的预存款是代理自己预先充值进来的钱（Agent.prepaymentBalance 语义 = 代理的资产余额，
 *   不是平台欠代理的债务，也不许赊账）。旧实现会在结算单转 PAID 时，把「平台应付给代理的佣金」
 *   去抵扣代理自己的预存款余额——但预存款本来就是代理的钱，根本不存在"欠款"可抵，实质是让
 *   代理自掏腰包抵自己该收的佣金：该收的佣金没收到，预存款还被扣掉，两头受损。
 *   若未来要做"佣金转存款"，应做成代理预存款余额的显式增加（入账流水），而不是从应付佣金里
 *   反向扣减——那不在本次修复范围内。
 *
 * 状态机：DRAFT → PENDING_APPROVAL → APPROVED → PAID
 *   PAID 时：  CommissionRecord.status ACCRUED → SETTLED（不再扣预存款余额、不再写 OFFSET 流水）。
 *              转 PAID 前会复检：本单绑定的「仍为 ACCRUED」的记录总额若小于生成时存的
 *              commissionEarned，说明有绑定记录在生成之后被外部翻成了 REVERSED（例如结算单
 *              审核通过后订单又被退款/取消——orders.service 把 ACCRUED 原地翻 REVERSED，但不清
 *              settlementId），继续付款会照着过期数字多付 → 400 拒绝，提示先作废重新生成。
 *              （不是"只要绑了 REVERSED 记录就拒绝"：负数补偿记录、结算前就已取消的正数
 *              REVERSED 记录，本就是生成时正确算入/正确排除的合法状态，不属于过期，否则会把
 *              「本期只是净掉一笔退款」的正常结算单也堵死，永远无法转 PAID。）
 *   VOIDED 时：关联的 ACCRUED / REVERSED 记录一并解绑（settlementId=null，可被下次 generate
 *              重新扫入）；已 SETTLED 的记录（钱已经付过）绝不解绑。
 *
 * 负佣金追回（M3）：若某期 netCommission = commissionEarned + reversalAmount < 0
 *   （本期退款冲销比本期新赚的佣金还多），payableToAgent 钳 0（本期不倒找代理要钱），
 *   但造成负差额的那部分负数补偿记录本次不绑定 settlementId——留在"待处理"池子里，
 *   由下一次 generate（不论哪个自然月，只要还是 settlementId=null 就会被扫到）用未来
 *   的新佣金去抵消，直到抵完为止。见 serializeSettlement 的 carryForwardAmount 字段。
 */
import {
  CommissionStatus,
  Prisma,
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
    // 不按 createdAt 限定期次：settlementId=null 才是"待处理"的唯一判据——负差额
    // 结转（M3）产生的记录可能是很久以前创建的，只要还没被绑定，任何一次 generate
    // 都该把它纳入候选，否则会因为 createdAt 落在已关闭的旧自然月而永远漏扫。
    const reversedRows = await prisma.commissionRecord.findMany({
      where: {
        status: CommissionStatus.REVERSED,
        settlementId: null,
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

    // 1b. 本人「退款冲销」records —— 尚未并入任何结算单的 REVERSED 记录
    // （settlementId=null）。三类来源：
    //   - 同期退款：整单冲销时被翻状态的 ACCRUED→REVERSED 记录（amount 仍为正）。
    //   - 跨期反冲：已结算订单退款时新建的「负数补偿记录」（amount<0）。
    //   - 负佣金结转（M3）：上一次 generate 因本期净额为负而未绑定的负数补偿记录，
    //     留到这一次用新的 commissionEarned 抵消。
    // 不按 createdAt 限定期次：settlementId=null 才是唯一的"待处理"判据，跟本次
    // 结算期无关——负差额结转的记录可能创建于更早的自然月（见 findAgentsWithActivity
    // 同款注释）。这些必须并入本期 netCommission（追回多付的佣金），不能静默丢弃。
    const reversalRecords = await prisma.commissionRecord.findMany({
      where: {
        agentId,
        status: CommissionStatus.REVERSED,
        settlementId: null,
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
    // order.total 已含套餐折扣、规则立减等折后净额，因此月结 GMV/佣金基数天然按折后价计算；立减不另改佣金链路。
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

    // 4. 预付抵扣已停用：预存款是代理自己的资产，不存在可抵的欠款场景（见文件头说明）。
    // prepaymentOffset 恒为 0；payableToAgent 直接等于净佣金，负数钳 0（本期不倒找代理要钱）。
    const prepaymentOffset = 0;
    const payableToAgent = Math.max(0, netCommission - prepaymentOffset);

    // M3（负佣金追回不再蒸发）：netCommission < 0 时，造成负差额的那部分负数补偿记录
    // 本次不绑定 settlementId——继续留在"待处理"池子里（settlementId 仍为 null），
    // 交给下一次 generate（不论本期还是下期）用新的 commissionEarned 去抵消，直到抵完
    // 为止；见 findAgentsWithActivity / 上方 reversalRecords 查询已去掉 createdAt 限制。
    // 正常记录（本人当期新赚的 earnedRecords、以及同期翻状态等"正数"REVERSED 记录）
    // 照常绑定——它们不影响净额，留在池子里对账无益、只会让"待处理"名单永远清不空。
    const boundReversalRecords =
      netCommission < 0 ? reversalRecords.filter((r) => Number(r.amount) >= 0) : reversalRecords;
    const recordIds = [
      ...earnedRecords.map((r) => r.id),
      ...boundReversalRecords.map((r) => r.id),
    ];

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
          // 汇总退款冲销所需的最小字段：status/amount 算金额，id/orderId/订单号让审批页
          // 能逐条看清"是哪张订单被冲销"（P0：此前列表页完全看不到 REVERSED 记录）。
          commissions: {
            select: {
              id: true, status: true, amount: true, orderId: true,
              order: { select: { orderNumber: true } },
            },
          },
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
      // APPROVED→VOIDED 抢跑）都能基于同一份事务外快照进事务；无 CAS 会导致结算单二次
      // 标 PAID / records 二次 SETTLED。这里先对 Settlement 行做 CAS 抢锁：
      // 第一个事务把 status 从快照值改成 toStatus（拿到行锁，count=1）；第二个事务的 UPDATE
      // 在 READ COMMITTED 下阻塞到第一个提交后，重判 where（status 已非快照值）→ count=0 →
      // 抛 Conflict 整体回滚，绝不进入后面翻 records。CAS 先于所有副作用。
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

      // 标记 PAID：records SETTLED。
      // 预付余额抵扣已停用（见文件头说明）：不再读/扣 Agent.prepaymentBalance，
      // 不再写 PrepaymentTransaction(OFFSET)——即便本单 prepaymentOffset 是历史遗留的非零值
      // （旧版本生成、尚未走到 PAID 的结算单），转 PAID 时也不再触发任何余额扣减。
      if (toStatus === 'PAID') {
        // ── P0 复检：转 PAID 前确认绑定记录没有在生成之后被外部翻成 REVERSED ──
        // orders.service 的退款/取消流程会把 ACCRUED 记录原地翻成 REVERSED（不清
        // settlementId，见文件头说明）；若本单审核通过后订单才被退款，stored 的
        // commissionEarned 就是过期数字，照付会多付。用「本单仍为 ACCRUED 的总额」
        // 与生成时存的 commissionEarned 比较：一旦有绑定记录从 ACCRUED 变走，总额必然
        // 变小（绑定是 generate 时一次性完成，之后不会再有记录加入），从而检测出过期。
        // 注意：不是"只要绑了 REVERSED 就拒绝"——负数补偿记录、结算前就已取消的正数
        // REVERSED 记录，从生成那一刻起就没算进 commissionEarned，总额不会因它们而变小，
        // 属于合法状态，不应被这条闸拦住（否则任何吸收过退款冲销的正常结算单都会被永久
        // 堵在 APPROVED，作废重生成也无法解开——见文件头说明）。
        const stillAccrued = await tx.commissionRecord.aggregate({
          where: { settlementId: s.id, status: CommissionStatus.ACCRUED },
          _sum: { amount: true },
        });
        const stillAccruedAmount = round2(Number(stillAccrued._sum.amount ?? 0));
        const storedEarned = round2(Number(s.commissionEarned));
        if (stillAccruedAmount < storedEarned) {
          throw new BadRequestError('本结算单包含已冲销佣金，请作废后重新生成');
        }

        await tx.commissionRecord.updateMany({
          where: { settlementId: s.id, status: CommissionStatus.ACCRUED },
          data: { status: CommissionStatus.SETTLED, settledAt: new Date() },
        });
      }

      // VOIDED：解绑本单关联的记录，使其回到"待处理"池子（settlementId=null），可被
      // 下次 generate 重新扫入重算。CAS 已抢到本次流转，故这里的解绑每单只会执行一次；
      // 并发的第二个 VOID（或 PAID 抢跑）已在 CAS 处被挡下回滚。
      // 解绑范围 = ACCRUED ∪ REVERSED：REVERSED 记录（同期翻状态 / 负数补偿）此前只解绑
      // ACCRUED，REVERSED 被永久绑死在废单上——作废后既回不到"待处理"池子被下次 generate
      // 追回，也不再对任何人可见，等于这笔冲销/追回凭空消失。SETTLED 记录（钱已经付过的）
      // 绝不在此范围：那是已完成支付的历史快照，解绑会被下期 generate 重复计入 → 佣金双付；
      // 此过滤与 PAID 分支的 ACCRUED→SETTLED 天然互斥：同一条记录不会同时被两个方向命中。
      if (toStatus === 'VOIDED') {
        await tx.commissionRecord.updateMany({
          where: {
            settlementId: s.id,
            status: { in: [CommissionStatus.ACCRUED, CommissionStatus.REVERSED] },
          },
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

// 从结算单已绑定的佣金记录里汇总「本期退款冲销」摘要，两个层次：
//   1. reversalCount / reversalAmount —— 只统计「负数补偿记录」（真实追回，恒 ≤ 0）；
//      同期翻状态的正数 REVERSED 不计入，口径与 computeSettlement 的 netCommission 一致。
//   2. reversedRecords —— 把本单绑定的 REVERSED 记录（不论正负）逐条透出（订单号 + 金额），
//      让审批页能看见"这张结算单里有没有被冲销的佣金"。P0 修复点：此前只看 reversalAmount
//      时，同期翻状态的正数 REVERSED（:5477-5480 那种 ACCRUED 原地翻转、不清 settlementId
//      的记录）完全不可见——金额是正的、被过滤掉了，审批人看不出这单里有一笔已经作废的佣金。
type ReversedRecordBrief = { id: string; orderId: string; orderNumber: string | null; amount: string };
type ReversalSummary = {
  reversalCount: number;
  reversalAmount: string;
  reversedRecords: ReversedRecordBrief[];
};
function summarizeReversals(
  commissions:
    | Array<{
        id?: string;
        status: string;
        amount: Prisma.Decimal;
        orderId?: string;
        order?: { orderNumber: string } | null;
      }>
    | undefined,
): ReversalSummary {
  if (!commissions) return { reversalCount: 0, reversalAmount: '0', reversedRecords: [] };
  const allReversed = commissions.filter((c) => c.status === 'REVERSED');
  // 只统计「负数补偿记录」（真实追回）；同期翻状态的正数 REVERSED 不计入（与 computeSettlement 口径一致）。
  const negative = allReversed.filter((c) => Number(c.amount) < 0);
  const total = negative.reduce((sum, c) => sum + Number(c.amount), 0);
  return {
    reversalCount: negative.length,
    reversalAmount: round2(total).toString(),
    reversedRecords: allReversed.map((c) => ({
      id: c.id ?? '',
      orderId: c.orderId ?? '',
      orderNumber: c.order?.orderNumber ?? null,
      amount: c.amount.toString(),
    })),
  };
}

function serializeSettlement<T extends SettlementWithAgent | (SettlementWithAgent & { commissions?: unknown })>(
  s: T,
  includeCommissions = false,
): unknown {
  const boundCommissions = 'commissions' in s
    ? (s.commissions as
        | Array<{
            id?: string;
            status: string;
            amount: Prisma.Decimal;
            orderId?: string;
            order?: { orderNumber: string } | null;
          }>
        | undefined)
    : undefined;
  const reversalSummary = summarizeReversals(boundCommissions);
  // 只读展示字段：本期净额若为负（M3 结转），造成负差额的补偿记录本次没有绑定 settlementId
  // （见 computeSettlement），不会体现在 reversalSummary（那只统计"实际绑定"的记录）里；
  // 这里直接从已存的 netCommission 派生，让审批页看得见"这单已结转、下期会继续追回"。
  const netCommissionNum = Number(s.netCommission);
  const carryForwardAmount =
    netCommissionNum < 0 ? round2(Math.abs(netCommissionNum)).toString() : '0';

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
    // 本单绑定的 REVERSED 记录逐条明细（不论正负），供审批页查看；list 与详情均带。
    reversedRecords: reversalSummary.reversedRecords,
    // 本期净额为负时的结转金额（正数，"已结转下期"的绝对值）；无结转时为 '0'。
    carryForwardAmount,
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
