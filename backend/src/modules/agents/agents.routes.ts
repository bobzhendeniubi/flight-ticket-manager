import type { FastifyPluginAsync } from 'fastify';
import { Prisma, ProductKind, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { AgentService } from './agents.service.js';
import {
  createChildAgentBodySchema,
  setAgentStatusBodySchema,
  setSettlementModeBodySchema,
  updateAgentBodySchema,
} from './agents.schemas.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';

export const agentRoutes: FastifyPluginAsync = async (app) => {
  const service = new AgentService();

  // 列表：AGENT 看自己 + 所有后代；ADMIN/STAFF 看全部
  app.get(
    '/',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)] },
    async (req) => {
      const agents = await service.listVisibleAgents(req.user.sub, req.user.role);
      return { agents };
    },
  );

  // 当前登录用户自己的 agent profile（AGENT 专用）
  app.get(
    '/me',
    { preHandler: [app.authenticate, app.requireRole(UserRole.AGENT, UserRole.ADMIN)] },
    async (req) => {
      const agent = await service.getByUserId(req.user.sub);
      return { agent };
    },
  );

  // 创建下级代理。
  //  - AGENT: POST /agents/children  (父=自己)
  //  - ADMIN: POST /agents/children?parentId=xxx  可指定；省略 = 建 1 级代理
  app.post(
    '/children',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.AGENT)] },
    async (req, reply) => {
      const body = createChildAgentBodySchema.parse(req.body);
      const { parentId } = (req.query as { parentId?: string }) ?? {};
      const result = await service.createChildAgent({
        currentUserId: req.user.sub,
        currentRole: req.user.role,
        parentAgentId: parentId ?? null,
        body,
      });
      // 建代理留审计：记操作人 + 新代理 id + 层级/上级（不记余额——建代理余额恒为 0，
      // 余额变动一律走认款通道并在那里各自留审计）。
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'CREATE_CHILD_AGENT',
        targetType: 'AGENT',
        targetId: result.agent.id,
        targetLabel: result.agent.contactName,
        after: { tier: result.agent.tier, parentAgentId: result.agent.parentAgentId },
        severity: 'WARNING',
      });
      return reply.status(201).send(result);
    },
  );

  // 设置代理结算模式（PER_ORDER 逐单到账 / MONTHLY 月结挂账）。仅 ADMIN。
  // PATCH /agents/:id/settlement-mode  body: { settlementMode }
  app.patch(
    '/:id/settlement-mode',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = setSettlementModeBodySchema.parse(req.body);
      const result = await service.setSettlementMode(id, body.settlementMode, req.user.role);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'SET_AGENT_SETTLEMENT_MODE',
        targetType: 'AGENT',
        targetId: id,
        targetLabel: result.contactName,
        before: { settlementMode: result.previousMode },
        after: { settlementMode: result.settlementMode },
        severity: 'WARNING',
      });
      return result;
    },
  );

  // 编辑代理基础联系信息（公司名/联系人/电话/邮箱/备注）。
  // ADMIN/STAFF 可改任意代理；AGENT 只能改自己。
  // PATCH /agents/:id
  app.patch(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = updateAgentBodySchema.parse(req.body);
      const result = await service.updateAgent({
        currentUserId: req.user.sub,
        currentRole: req.user.role,
        targetAgentId: id,
        body,
      });
      if (result.changedFields.length > 0) {
        void writeAudit({
          actor: actorFromRequest(req),
          action: 'UPDATE_AGENT',
          targetType: 'AGENT',
          targetId: id,
          targetLabel: result.agent.contactName,
          before: result.before,
          after: result.after,
          severity: 'INFO',
        });
      }
      return { agent: result.agent };
    },
  );

  // 停用/启用代理登录。仅 ADMIN。停用后该代理对应账号无法再登录（见 AuthService.login）；
  // 不级联停用下级代理。
  // PATCH /agents/:id/status  body: { isActive }
  app.patch(
    '/:id/status',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = setAgentStatusBodySchema.parse(req.body);
      const result = await service.setActive({
        currentUserId: req.user.sub,
        currentRole: req.user.role,
        targetAgentId: id,
        isActive: body.isActive,
      });
      if (result.changed) {
        void writeAudit({
          actor: actorFromRequest(req),
          action: body.isActive ? 'ACTIVATE_AGENT' : 'DEACTIVATE_AGENT',
          targetType: 'AGENT',
          targetId: id,
          targetLabel: result.agent.contactName,
          before: { isActive: !body.isActive },
          after: { isActive: body.isActive },
          severity: 'WARNING',
        });
      }
      return { agent: result.agent };
    },
  );

  // ── 佣金规则（A1，2026-07-17）：CommissionRule 此前全仓只读（写入口仅 seed），
  // 缺规则时计提静默按 0 佣金——代理拿不到钱还查无此账。这里补上管理端读写：
  //   GET  /:id/commission-rules   当前生效费率（每 productKind 一条，取最新生效）
  //   PUT  /:id/commission-rules   仅 ADMIN；每个传入的 kind 追加一条 effectiveFrom=now 的新规则
  //                                （历史保留；计提读「最新生效」自然切换，不改旧账）
  const COMMISSION_KINDS = [
    ProductKind.FLIGHT,
    ProductKind.HOTEL,
    ProductKind.TRANSFER,
    ProductKind.VISA,
  ] as const;
  const putCommissionRulesBodySchema = z.object({
    rates: z
      .record(
        z.enum(['FLIGHT', 'HOTEL', 'TRANSFER', 'VISA']),
        z
          .number()
          .min(0, '费率不能为负')
          .max(0.5, '费率超出上限（50%）——按小数填，如 0.05 = 5%'),
      )
      .refine((r) => Object.keys(r).length > 0, '至少提供一个产品类型的费率'),
  });

  app.get(
    '/:id/commission-rules',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const agent = await prisma.agent.findUnique({ where: { id }, select: { id: true } });
      if (!agent) throw new NotFoundError('代理不存在');
      const now = new Date();
      // 与计提口径（createCommissionsForOrder）完全一致：生效中，按 effectiveFrom DESC 每 kind 取第一条
      const rows = await prisma.commissionRule.findMany({
        where: {
          agentId: id,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
        },
        orderBy: { effectiveFrom: 'desc' },
      });
      const current: Record<string, { rate: number; effectiveFrom: string } | null> = {};
      for (const kind of COMMISSION_KINDS) {
        const hit = rows.find((r) => r.productKind === kind);
        current[kind] = hit
          ? { rate: Number(hit.rate), effectiveFrom: hit.effectiveFrom.toISOString() }
          : null; // null = 无规则 → 计提按 0（缺规则不再是隐形的）
      }
      return { rules: current };
    },
  );

  app.put(
    '/:id/commission-rules',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = putCommissionRulesBodySchema.parse(req.body);
      const agent = await prisma.agent.findUnique({
        where: { id },
        select: { id: true, companyName: true, contactName: true },
      });
      if (!agent) throw new NotFoundError('代理不存在');

      const now = new Date();
      const entries = Object.entries(body.rates) as Array<[keyof typeof body.rates, number]>;
      const written: Record<string, number> = {};
      for (const [kind, rate] of entries) {
        // 追加新规则（同 agent+kind+effectiveFrom 唯一；同毫秒重复提交由唯一约束兜底 upsert）
        await prisma.commissionRule.upsert({
          where: {
            agentId_productKind_effectiveFrom: {
              agentId: id,
              productKind: kind as ProductKind,
              effectiveFrom: now,
            },
          },
          update: { rate: new Prisma.Decimal(rate) },
          create: {
            agentId: id,
            productKind: kind as ProductKind,
            rate: new Prisma.Decimal(rate),
            effectiveFrom: now,
          },
        });
        written[kind] = rate;
      }
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'SET_COMMISSION_RULES',
        targetType: 'AGENT',
        targetId: id,
        targetLabel: agent.companyName ?? agent.contactName,
        after: { rates: written, effectiveFrom: now.toISOString() },
        severity: 'WARNING', // 动费率=动钱，留痕等级同停用
      });
      return { ok: true, rates: written, effectiveFrom: now.toISOString() };
    },
  );
};
