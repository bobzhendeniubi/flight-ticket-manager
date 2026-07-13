import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
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
};
