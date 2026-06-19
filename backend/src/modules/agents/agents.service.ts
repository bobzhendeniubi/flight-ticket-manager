import { Prisma, SettlementMode, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { hashPassword } from '../../lib/password.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import type { CreateChildAgentBody } from './agents.schemas.js';

export class AgentService {
  /** 读取当前登录用户的 agent profile。CUSTOMER/STAFF 返回 null */
  async getByUserId(userId: string) {
    return prisma.agent.findUnique({ where: { userId } });
  }

  /** 广度优先递归：返回给定 agent 下所有后代 agent id，含自身 */
  async descendantIds(rootAgentId: string): Promise<string[]> {
    const result = [rootAgentId];
    let frontier = [rootAgentId];
    // 限制深度 10 防止误数据循环
    for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
      const children = await prisma.agent.findMany({
        where: { parentAgentId: { in: frontier } },
        select: { id: true },
      });
      if (children.length === 0) break;
      frontier = children.map((c) => c.id);
      result.push(...frontier);
    }
    return result;
  }

  /** ADMIN: 全量列表；AGENT: 仅自己 + 所有后代 */
  async listVisibleAgents(currentUserId: string, currentRole: UserRole) {
    let where: Prisma.AgentWhereInput = {};

    if (currentRole === UserRole.AGENT) {
      const me = await prisma.agent.findUnique({ where: { userId: currentUserId } });
      if (!me) throw new ForbiddenError('当前用户不是代理');
      const ids = await this.descendantIds(me.id);
      where = { id: { in: ids } };
    } else if (currentRole !== UserRole.ADMIN && currentRole !== UserRole.STAFF) {
      throw new ForbiddenError('无权限查看代理列表');
    }

    const agents = await prisma.agent.findMany({
      where,
      orderBy: [{ tier: 'asc' }, { createdAt: 'asc' }],
      include: {
        user: {
          select: { id: true, email: true, displayName: true, lastLoginAt: true, createdAt: true },
        },
        parentAgent: {
          select: { id: true, companyName: true, contactName: true, tier: true },
        },
        _count: { select: { childAgents: true, orders: true } },
      },
    });

    return agents.map((a) => ({
      id: a.id,
      userId: a.userId,
      tier: a.tier,
      parentAgentId: a.parentAgentId,
      parent: a.parentAgent,
      companyName: a.companyName,
      contactName: a.contactName,
      contactPhone: a.contactPhone,
      prepaymentBalance: a.prepaymentBalance.toString(),
      settlementMode: a.settlementMode,
      isActive: a.isActive,
      notes: a.notes,
      email: a.user.email,
      displayName: a.user.displayName,
      lastLoginAt: a.user.lastLoginAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      childCount: a._count.childAgents,
      orderCount: a._count.orders,
    }));
  }

  /**
   * 创建下级代理。
   * - ADMIN: 可以创建任意 tier=1 代理 (parentAgentId=null)，或指定 parent 创建下级
   * - AGENT: parent 必须是自己；新代理 tier = 自己 tier + 1
   */
  async createChildAgent(input: {
    currentUserId: string;
    currentRole: UserRole;
    parentAgentId?: string | null;
    body: CreateChildAgentBody;
  }) {
    const { currentUserId, currentRole, parentAgentId, body } = input;

    let parentTier = 0;
    let resolvedParentId: string | null = null;

    if (currentRole === UserRole.AGENT) {
      const me = await prisma.agent.findUnique({ where: { userId: currentUserId } });
      if (!me) throw new ForbiddenError('当前用户不是代理');
      if (parentAgentId && parentAgentId !== me.id) {
        throw new ForbiddenError('只能为自己创建下级代理');
      }
      resolvedParentId = me.id;
      parentTier = me.tier;
      if (parentTier >= 5) {
        throw new ForbiddenError('代理层级最多 5 级');
      }
    } else if (currentRole === UserRole.ADMIN) {
      if (parentAgentId) {
        const parent = await prisma.agent.findUnique({ where: { id: parentAgentId } });
        if (!parent) throw new NotFoundError('上级代理不存在');
        resolvedParentId = parent.id;
        parentTier = parent.tier;
      } else {
        // 建一个 1 级代理
        resolvedParentId = null;
        parentTier = 0;
      }
    } else {
      throw new ForbiddenError('无权限创建代理');
    }

    // 邮箱唯一
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw new ConflictError('邮箱已注册');

    const passwordHash = await hashPassword(body.password);

    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: body.email,
          passwordHash,
          displayName: body.displayName,
          role: UserRole.AGENT,
          emailVerified: true,
        },
      });

      const agent = await tx.agent.create({
        data: {
          userId: user.id,
          companyName: body.companyName,
          contactName: body.contactName,
          contactPhone: body.contactPhone,
          prepaymentBalance: body.prepaymentBalance,
          parentAgentId: resolvedParentId,
          tier: parentTier + 1,
          notes: body.notes,
        },
      });

      return { user: { id: user.id, email: user.email, displayName: user.displayName }, agent };
    });
  }

  /**
   * 设置代理结算模式（PER_ORDER 逐单到账 / MONTHLY 月结挂账）。仅 ADMIN。
   * 返回前后值供审计；只改模式标记，不动余额/订单（前端据此把月结代理的订单显示成「月结」）。
   */
  async setSettlementMode(
    agentId: string,
    mode: SettlementMode,
    currentRole: UserRole,
  ): Promise<{
    id: string;
    settlementMode: SettlementMode;
    previousMode: SettlementMode;
    contactName: string;
  }> {
    if (currentRole !== UserRole.ADMIN) {
      throw new ForbiddenError('仅管理员可设置代理结算模式');
    }
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, settlementMode: true, contactName: true },
    });
    if (!agent) throw new NotFoundError('代理不存在');

    const updated = await prisma.agent.update({
      where: { id: agentId },
      data: { settlementMode: mode },
      select: { id: true, settlementMode: true, contactName: true },
    });

    return {
      id: updated.id,
      settlementMode: updated.settlementMode,
      previousMode: agent.settlementMode,
      contactName: updated.contactName,
    };
  }
}
