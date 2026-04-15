import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { AgentService } from './agents.service.js';
import { createChildAgentBodySchema } from './agents.schemas.js';

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
};
