import { Prisma, SettlementMode, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { hashPassword } from '../../lib/password.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import type { CreateChildAgentBody, UpdateAgentBody } from './agents.schemas.js';

// 详情查询共用的 include：列表 / 编辑后回显 / 停用启用后回显都要同一份投影，
// 避免三处字段拼写各自维护、逐渐漂移。
const AGENT_DETAIL_INCLUDE = {
  user: {
    select: { id: true, email: true, displayName: true, lastLoginAt: true, createdAt: true },
  },
  parentAgent: {
    select: { id: true, companyName: true, contactName: true, tier: true },
  },
  _count: { select: { childAgents: true, orders: true } },
} satisfies Prisma.AgentInclude;

type AgentWithDetail = Prisma.AgentGetPayload<{ include: typeof AGENT_DETAIL_INCLUDE }>;

export class AgentService {
  /** 与 listVisibleAgents 单条记录同形状的投影，供更新类接口直接把最新状态回传给前端。 */
  private mapAgentRow(a: AgentWithDetail) {
    return {
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
      rosterFormat: a.rosterFormat,
      rosterKeywords: a.rosterKeywords,
      email: a.user.email,
      displayName: a.user.displayName,
      lastLoginAt: a.user.lastLoginAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      childCount: a._count.childAgents,
      orderCount: a._count.orders,
    };
  }

  private async getAgentDetail(agentId: string) {
    const a = await prisma.agent.findUnique({ where: { id: agentId }, include: AGENT_DETAIL_INCLUDE });
    if (!a) throw new NotFoundError('代理不存在');
    return this.mapAgentRow(a);
  }

  /**
   * 服务层操作日志（app.log 级别）：只记录操作者 id / 目标代理 id / 变更字段名，
   * 不记录变更后的具体值（联系方式等不进日志）。需要留痕具体前后值的走 route 层 writeAudit()。
   */
  private logOperation(
    action: string,
    meta: { actorUserId: string; targetAgentId: string; changedFields: string[] },
  ): void {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: 'info',
        type: 'agent_operation',
        action,
        actorUserId: meta.actorUserId,
        targetAgentId: meta.targetAgentId,
        changedFields: meta.changedFields,
        at: new Date().toISOString(),
      }),
    );
  }

  /**
   * 识别词条全局查重：一条词条只能归属一家代理。命中其它代理已注册的词条 → 400，
   * 报错指明词条与占用方。excludeAgentId = 本次保存的代理自身（改自己的词条不算冲突）。
   * 说明：应用层校验（无 DB 级数组元素唯一约束），并发同词条保存存在极小竞窗，可接受。
   */
  private async assertRosterKeywordsAvailable(keywords: string[], excludeAgentId?: string): Promise<void> {
    if (keywords.length === 0) return;
    const holder = await prisma.agent.findFirst({
      where: {
        ...(excludeAgentId ? { id: { not: excludeAgentId } } : {}),
        rosterKeywords: { hasSome: keywords },
      },
      select: { id: true, companyName: true, contactName: true, rosterKeywords: true },
    });
    if (holder) {
      const taken = keywords.filter((k) => holder.rosterKeywords.includes(k));
      const holderName = holder.companyName ?? holder.contactName;
      throw new BadRequestError(
        `识别词条「${taken.join('、')}」已被代理「${holderName}」注册，请更换词条或先在对方处移除`,
      );
    }
  }

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
      include: AGENT_DETAIL_INCLUDE,
    });

    return agents.map((a) => this.mapAgentRow(a));
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

    // 识别词条全局查重（一词只归一家）
    await this.assertRosterKeywordsAvailable(body.rosterKeywords ?? []);

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

      // 余额恒为 0：不在建代理时裸设初始余额（会绕过流水与审计）。
      // Agent.prepaymentBalance 有 @default(0)，此处不写该字段即落 0。
      // 若确有「开户预存」需求，建完代理后走已有认款通道 —— agent-recharges 的
      // manualAdjust（人工调整）或 confirm（认款到账），两者都在同一事务内
      // 原子生成 PrepaymentTransaction 并加余额，留有流水+审计。铁律：余额只能这样产生。
      const agent = await tx.agent.create({
        data: {
          userId: user.id,
          companyName: body.companyName,
          contactName: body.contactName,
          contactPhone: body.contactPhone,
          parentAgentId: resolvedParentId,
          tier: parentTier + 1,
          notes: body.notes,
          rosterFormat: body.rosterFormat ?? null,
          rosterKeywords: body.rosterKeywords ?? [],
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

  /**
   * 编辑代理基础联系信息（公司名/联系人/电话/邮箱/备注）。
   * - ADMIN/STAFF：可改任意代理。
   * - AGENT：只能改自己（userId 必须匹配当前登录用户）。
   * email 落在 User 表（唯一），其余字段落在 Agent 表 —— 一次事务内一起改，避免半写。
   */
  async updateAgent(input: {
    currentUserId: string;
    currentRole: UserRole;
    targetAgentId: string;
    body: UpdateAgentBody;
  }) {
    const { currentUserId, currentRole, targetAgentId, body } = input;

    const target = await prisma.agent.findUnique({
      where: { id: targetAgentId },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!target) throw new NotFoundError('代理不存在');

    if (currentRole === UserRole.AGENT) {
      if (target.userId !== currentUserId) {
        throw new ForbiddenError('只能修改自己的代理信息');
      }
    } else if (currentRole !== UserRole.ADMIN && currentRole !== UserRole.STAFF) {
      throw new ForbiddenError('无权限修改代理信息');
    }

    if (body.email !== undefined && body.email !== target.user.email) {
      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing && existing.id !== target.userId) {
        throw new ConflictError('邮箱已被其他账号使用');
      }
    }

    // 只对比实际传入且发生变化的字段：before/after 只含改动过的字段，供 route 层写审计。
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const changedFields: string[] = [];
    const trackChange = (field: string, prevVal: unknown, nextVal: unknown) => {
      if (nextVal === undefined || nextVal === prevVal) return;
      before[field] = prevVal;
      after[field] = nextVal;
      changedFields.push(field);
    };
    trackChange('companyName', target.companyName, body.companyName);
    trackChange('contactName', target.contactName, body.contactName);
    trackChange('contactPhone', target.contactPhone, body.contactPhone);
    trackChange('notes', target.notes, body.notes);
    trackChange('email', target.user.email, body.email);
    trackChange('rosterFormat', target.rosterFormat, body.rosterFormat);
    // 数组字段：按内容比较（引用比较永远不等）
    const keywordsChanged =
      body.rosterKeywords !== undefined &&
      JSON.stringify(body.rosterKeywords) !== JSON.stringify(target.rosterKeywords);
    if (keywordsChanged && body.rosterKeywords !== undefined) {
      before.rosterKeywords = target.rosterKeywords;
      after.rosterKeywords = body.rosterKeywords;
      changedFields.push('rosterKeywords');
      // 识别词条全局查重（排除自己）
      await this.assertRosterKeywordsAvailable(body.rosterKeywords, targetAgentId);
    }

    if (changedFields.length > 0) {
      await prisma.$transaction(async (tx) => {
        const agentData: Prisma.AgentUpdateInput = {};
        if (body.companyName !== undefined) agentData.companyName = body.companyName;
        if (body.contactName !== undefined) agentData.contactName = body.contactName;
        if (body.contactPhone !== undefined) agentData.contactPhone = body.contactPhone;
        if (body.notes !== undefined) agentData.notes = body.notes;
        if (body.rosterFormat !== undefined) agentData.rosterFormat = body.rosterFormat;
        if (keywordsChanged && body.rosterKeywords !== undefined) {
          agentData.rosterKeywords = body.rosterKeywords;
        }
        if (Object.keys(agentData).length > 0) {
          await tx.agent.update({ where: { id: targetAgentId }, data: agentData });
        }
        if (body.email !== undefined && body.email !== target.user.email) {
          await tx.user.update({ where: { id: target.userId }, data: { email: body.email } });
        }
      });

      this.logOperation('UPDATE_AGENT', { actorUserId: currentUserId, targetAgentId, changedFields });
    }

    return { agent: await this.getAgentDetail(targetAgentId), changedFields, before, after };
  }

  /**
   * 停用/启用代理登录。仅 ADMIN。
   *
   * 行为说明：
   * - 只影响该代理本身能否登录（Agent.isActive=false → 登录时被拒绝，见 AuthService.login）。
   * - 不级联停用下级代理 —— 上级停用不代表下级立即失联，下级是否继续可登录由其自身
   *   isActive 独立决定，需要另行逐个处理（避免一次误操作停掉一整条线的下级）。
   * - 不允许停用当前操作者自己账号所属的代理（自锁保护）。
   */
  async setActive(input: {
    currentUserId: string;
    currentRole: UserRole;
    targetAgentId: string;
    isActive: boolean;
  }) {
    const { currentUserId, currentRole, targetAgentId, isActive } = input;
    if (currentRole !== UserRole.ADMIN) {
      throw new ForbiddenError('仅管理员可停用/启用代理');
    }

    const target = await prisma.agent.findUnique({
      where: { id: targetAgentId },
      select: { id: true, userId: true, isActive: true },
    });
    if (!target) throw new NotFoundError('代理不存在');

    if (target.userId === currentUserId) {
      throw new ForbiddenError('不能停用自己账号所属的代理');
    }

    if (target.isActive === isActive) {
      // 幂等：状态未变化，直接回显当前详情，不写操作日志/审计（没有实际变更）。
      return { agent: await this.getAgentDetail(targetAgentId), changed: false };
    }

    await prisma.agent.update({ where: { id: targetAgentId }, data: { isActive } });

    this.logOperation(isActive ? 'ACTIVATE_AGENT' : 'DEACTIVATE_AGENT', {
      actorUserId: currentUserId,
      targetAgentId,
      changedFields: ['isActive'],
    });

    return { agent: await this.getAgentDetail(targetAgentId), changed: true };
  }
}
