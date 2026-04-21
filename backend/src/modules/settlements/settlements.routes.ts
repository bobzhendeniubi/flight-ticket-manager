/**
 * 结算单路由
 * POST   /settlements/generate   批量生成/重算某期结算单（ADMIN）
 * GET    /settlements            列表（RBAC：管理员全部 / 代理自己+下级）
 * GET    /settlements/:id        详情（含 commission 明细）
 * PATCH  /settlements/:id/status 状态流转（ADMIN）
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { SettlementService, type SettlementRequester } from './settlements.service.js';
import {
  generateSettlementsBodySchema,
  listSettlementsQuerySchema,
  updateSettlementStatusBodySchema,
} from './settlements.schemas.js';
import { prisma } from '../../db/prisma.js';

export const settlementRoutes: FastifyPluginAsync = async (app) => {
  const service = new SettlementService();

  app.post(
    '/generate',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const body = generateSettlementsBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const result = await service.generate(body, requester);
      return reply.status(201).send(result);
    },
  );

  app.get(
    '/',
    { preHandler: [app.authenticate] },
    async (req) => {
      const query = listSettlementsQuerySchema.parse(req.query);
      const requester = await buildRequester(req.user.sub, req.user.role);
      return service.list(query, requester);
    },
  );

  app.get(
    '/:id',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const requester = await buildRequester(req.user.sub, req.user.role);
      const settlement = await service.getById(id, requester);
      return { settlement };
    },
  );

  app.patch(
    '/:id/status',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = updateSettlementStatusBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const settlement = await service.updateStatus(id, body.toStatus, requester, body.notes);
      return { settlement };
    },
  );
};

async function buildRequester(userId: string, role: UserRole): Promise<SettlementRequester> {
  let agentId: string | undefined;
  if (role === 'AGENT') {
    const agent = await prisma.agent.findUnique({
      where: { userId },
      select: { id: true },
    });
    agentId = agent?.id;
  }
  return { userId, role, agentId };
}
