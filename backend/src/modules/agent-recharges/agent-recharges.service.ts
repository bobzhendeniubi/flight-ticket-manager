/**
 * 代理认款服务 —— 代理上传付款凭证 + 申报金额 → 财务核实到账后确认 →
 * 原子生成 PrepaymentTransaction(TOP_UP) 并加 Agent.prepaymentBalance。
 *
 * 口径（见 backend/prisma/schema.prisma AgentRechargeRequest 注释）：
 *   余额只能这样充进来，不许赊账（prepaymentBalance 永不为负）；
 *   订单尾款用「代理余额抵」从余额扣（orders.service.applyAgentBalanceToOrder，已有守卫），
 *   凭证与订单不再逐张配对（多单混付由余额池消化，不做 N:M 配对）。
 */
import { AgentRechargeStatus, Prisma, PrepaymentTxType, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import type {
  ConfirmRechargeRequestInput,
  CreateRechargeRequestInput,
  ListRechargeRequestsQuery,
  ManualBalanceAdjustmentInput,
  RejectRechargeRequestInput,
} from './agent-recharges.schemas.js';

/** 2 位小数四舍五入（与 orders.service / settlements.service 同口径）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface RechargeActor {
  userId: string;
  role: UserRole;
}

/** 序列化：Decimal → string（与 agents.service / orders.service 现有约定一致）。 */
function serializeRechargeRequest(r: {
  id: string;
  agentId: string;
  amountCny: Prisma.Decimal;
  confirmedAmountCny: Prisma.Decimal | null;
  proofImages: string[];
  note: string | null;
  status: AgentRechargeStatus;
  reviewNote: string | null;
  submittedByUserId: string;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  prepaymentTxId: string | null;
  createdAt: Date;
  updatedAt: Date;
  agent?: { id: string; companyName: string | null; contactName: string } | null;
}) {
  return {
    id: r.id,
    agentId: r.agentId,
    agentName: r.agent ? (r.agent.companyName || r.agent.contactName) : undefined,
    amountCny: r.amountCny.toString(),
    confirmedAmountCny: r.confirmedAmountCny?.toString() ?? null,
    proofImages: r.proofImages,
    note: r.note,
    status: r.status,
    reviewNote: r.reviewNote,
    submittedByUserId: r.submittedByUserId,
    reviewedByUserId: r.reviewedByUserId,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    prepaymentTxId: r.prepaymentTxId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export class AgentRechargesService {
  /** 从 actor 解析出所属 agentId（AGENT 角色专用；找不到 profile 视为无权限）。 */
  private async resolveOwnAgentId(userId: string): Promise<string> {
    const agent = await prisma.agent.findUnique({ where: { userId }, select: { id: true } });
    if (!agent) throw new ForbiddenError('当前用户不是代理');
    return agent.id;
  }

  /**
   * 提交认款申请。
   * - AGENT：只能为自己提交；body.agentId 若带了且与自己不符 → 拒绝（防冒领到别的代理账上）。
   * - ADMIN/STAFF：可代提交，body.agentId 必填。
   */
  async create(actor: RechargeActor, body: CreateRechargeRequestInput) {
    let agentId: string;
    if (actor.role === UserRole.AGENT) {
      const own = await this.resolveOwnAgentId(actor.userId);
      if (body.agentId && body.agentId !== own) {
        throw new ForbiddenError('只能为自己提交认款申请');
      }
      agentId = own;
    } else if (actor.role === UserRole.ADMIN || actor.role === UserRole.STAFF) {
      if (!body.agentId) throw new BadRequestError('请指定代提交的代理（agentId）');
      const exists = await prisma.agent.findUnique({ where: { id: body.agentId }, select: { id: true } });
      if (!exists) throw new NotFoundError('代理不存在');
      agentId = body.agentId;
    } else {
      throw new ForbiddenError('无权限提交认款申请');
    }

    const created = await prisma.agentRechargeRequest.create({
      data: {
        agentId,
        amountCny: new Prisma.Decimal(body.amountCny),
        proofImages: body.proofImages,
        note: body.note ?? null,
        status: AgentRechargeStatus.PENDING,
        submittedByUserId: actor.userId,
      },
    });
    return serializeRechargeRequest(created);
  }

  /**
   * 列表。
   * - ADMIN/STAFF：全部可见，可按 status / agentId 过滤。
   * - AGENT：只能看自己 + 所有后代代理提交的申请（与 settlements/orders 的可见范围口径一致）；
   *   请求里带的 agentId 会被忽略/校验（不允许越权查询范围外的代理）。
   */
  async list(actor: RechargeActor, query: ListRechargeRequestsQuery) {
    const where: Prisma.AgentRechargeRequestWhereInput = {};
    if (query.status) where.status = query.status;

    if (actor.role === UserRole.AGENT) {
      const own = await this.resolveOwnAgentId(actor.userId);
      const visibleIds = await getDescendantAgentIds(own);
      if (query.agentId) {
        if (!visibleIds.includes(query.agentId)) {
          throw new ForbiddenError('无权查看该代理的认款记录');
        }
        where.agentId = query.agentId;
      } else {
        where.agentId = { in: visibleIds };
      }
    } else if (actor.role === UserRole.ADMIN || actor.role === UserRole.STAFF) {
      if (query.agentId) where.agentId = query.agentId;
    } else {
      throw new ForbiddenError('无权限查看认款记录');
    }

    const [rows, total] = await prisma.$transaction([
      prisma.agentRechargeRequest.findMany({
        where,
        include: { agent: { select: { id: true, companyName: true, contactName: true } } },
        orderBy: { createdAt: 'desc' },
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.agentRechargeRequest.count({ where }),
    ]);

    return {
      requests: rows.map(serializeRechargeRequest),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  /**
   * 确认到账（ADMIN/STAFF）。一个事务内：
   *   1. 行锁重读申请，必须仍是 PENDING（非 PENDING → 409，防重复确认/双花）
   *   2. 行锁重读代理余额，累加 confirmedAmountCny（缺省 = amountCny）
   *   3. 写 PrepaymentTransaction(TOP_UP)，balanceAfter = 锁定读到的余额 + 到账额
   *   4. 更新申请 CONFIRMED + reviewedBy/At + confirmedAmountCny + prepaymentTxId（幂等锚点）
   * prepaymentTxId @unique 是 DB 层兜底：即使并发穿过应用层校验，二次写入也会因唯一约束回滚。
   */
  async confirm(actor: RechargeActor, id: string, body: ConfirmRechargeRequestInput) {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可确认认款');
    }

    return prisma.$transaction(async (tx) => {
      // 行锁申请本身，防并发双确认（两次 PATCH 同时到达）
      const reqRows = await tx.$queryRaw<
        Array<{
          id: string;
          agentId: string;
          amountCny: Prisma.Decimal;
          status: AgentRechargeStatus;
        }>
      >`SELECT id, "agentId", "amountCny", status FROM "AgentRechargeRequest" WHERE id = ${id} FOR UPDATE`;
      const reqRow = reqRows[0];
      if (!reqRow) throw new NotFoundError('认款申请不存在');
      if (reqRow.status !== AgentRechargeStatus.PENDING) {
        throw new ConflictError(`该申请当前状态为 ${reqRow.status}，不可重复确认`);
      }

      const confirmedAmount = round2(body.confirmedAmountCny ?? Number(reqRow.amountCny));
      if (confirmedAmount <= 0) throw new BadRequestError('到账金额必须大于 0');

      // 行锁代理余额（与 orders.service 的余额写入同一并发安全口径）
      const agentRows = await tx.$queryRaw<Array<{ prepaymentBalance: Prisma.Decimal }>>`
        SELECT "prepaymentBalance" FROM "Agent" WHERE id = ${reqRow.agentId} FOR UPDATE
      `;
      if (!agentRows[0]) throw new NotFoundError('代理不存在');
      const balanceAfter = round2(Number(agentRows[0].prepaymentBalance) + confirmedAmount);

      await tx.agent.update({
        where: { id: reqRow.agentId },
        data: { prepaymentBalance: new Prisma.Decimal(balanceAfter) },
      });

      const createdTx = await tx.prepaymentTransaction.create({
        data: {
          agentId: reqRow.agentId,
          amount: new Prisma.Decimal(confirmedAmount), // 正数 = 入账
          balanceAfter: new Prisma.Decimal(balanceAfter),
          type: PrepaymentTxType.TOP_UP,
          description: `认款单 ${reqRow.id} 确认到账`,
          createdById: actor.userId,
        },
      });

      const updated = await tx.agentRechargeRequest.update({
        where: { id },
        data: {
          status: AgentRechargeStatus.CONFIRMED,
          confirmedAmountCny: new Prisma.Decimal(confirmedAmount),
          reviewNote: body.reviewNote ?? null,
          reviewedByUserId: actor.userId,
          reviewedAt: new Date(),
          prepaymentTxId: createdTx.id,
        },
        include: { agent: { select: { id: true, companyName: true, contactName: true } } },
      });

      return { request: serializeRechargeRequest(updated), agentBalanceAfter: balanceAfter };
    });
  }

  /** 驳回（ADMIN/STAFF）。PENDING → REJECTED，不动余额；非 PENDING → 409。 */
  async reject(actor: RechargeActor, id: string, body: RejectRechargeRequestInput) {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可驳回认款');
    }

    return prisma.$transaction(async (tx) => {
      const reqRows = await tx.$queryRaw<
        Array<{ id: string; status: AgentRechargeStatus }>
      >`SELECT id, status FROM "AgentRechargeRequest" WHERE id = ${id} FOR UPDATE`;
      const reqRow = reqRows[0];
      if (!reqRow) throw new NotFoundError('认款申请不存在');
      if (reqRow.status !== AgentRechargeStatus.PENDING) {
        throw new ConflictError(`该申请当前状态为 ${reqRow.status}，不可重复驳回`);
      }

      const updated = await tx.agentRechargeRequest.update({
        where: { id },
        data: {
          status: AgentRechargeStatus.REJECTED,
          reviewNote: body.reviewNote,
          reviewedByUserId: actor.userId,
          reviewedAt: new Date(),
        },
        include: { agent: { select: { id: true, companyName: true, contactName: true } } },
      });
      return serializeRechargeRequest(updated);
    });
  }

  /**
   * AGENT 专用：返回应向哪个收款渠道付款——
   *   有专属渠道（PaymentChannel.agentId = 自己）→ 只返回专属渠道；
   *   没有 → 退回公司统一码（agentId = null 且 isActive）。
   * 不会把「其他代理」的专属码泄露出去。
   */
  async myChannels(actor: RechargeActor) {
    if (actor.role !== UserRole.AGENT) {
      throw new ForbiddenError('仅代理可查询专属收款渠道');
    }
    const agentId = await this.resolveOwnAgentId(actor.userId);

    const dedicated = await prisma.paymentChannel.findMany({
      where: { agentId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    if (dedicated.length > 0) {
      return { channels: dedicated, source: 'DEDICATED' as const };
    }

    const company = await prisma.paymentChannel.findMany({
      where: { agentId: null, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { channels: company, source: 'COMPANY' as const };
  }

  /**
   * 手动余额调整（人工修正，如线下对账差异）。ADMIN/STAFF 专用。
   * 一个事务内行锁读余额 → 校验负向调整不会击穿 0 → 写 Agent + PrepaymentTransaction(ADJUSTMENT)。
   * 复用与 confirm() 完全相同的行锁 + 校验模式，保证「不许赊账」这条线在这个入口也成立。
   */
  async manualAdjust(actor: RechargeActor, body: ManualBalanceAdjustmentInput) {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可手动调整代理余额');
    }
    const delta = round2(body.amount);

    return prisma.$transaction(async (tx) => {
      const agentRows = await tx.$queryRaw<Array<{ prepaymentBalance: Prisma.Decimal }>>`
        SELECT "prepaymentBalance" FROM "Agent" WHERE id = ${body.agentId} FOR UPDATE
      `;
      if (!agentRows[0]) throw new NotFoundError('代理不存在');
      const balance = Number(agentRows[0].prepaymentBalance);
      const balanceAfter = round2(balance + delta);
      if (balanceAfter < -0.001) {
        throw new BadRequestError(
          `代理余额 ¥${balance.toFixed(2)} 不足以扣减 ¥${Math.abs(delta).toFixed(2)}，已拒绝（余额不许为负）`,
        );
      }

      await tx.agent.update({
        where: { id: body.agentId },
        data: { prepaymentBalance: new Prisma.Decimal(balanceAfter) },
      });
      const created = await tx.prepaymentTransaction.create({
        data: {
          agentId: body.agentId,
          amount: new Prisma.Decimal(delta),
          balanceAfter: new Prisma.Decimal(balanceAfter),
          type: PrepaymentTxType.ADJUSTMENT,
          description: `手动调整：${body.reason}`,
          createdById: actor.userId,
        },
      });

      return {
        ok: true as const,
        agentId: body.agentId,
        amount: delta,
        balanceAfter,
        transactionId: created.id,
      };
    });
  }
}
