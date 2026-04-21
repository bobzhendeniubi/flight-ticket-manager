/**
 * 订单路由 — 所有端点都需要登录。
 *
 * POST   /orders               下单（任意登录用户；代理身份自动绑定 agentId）
 * GET    /orders               列表（RBAC 过滤：客户/代理/运营各看见不同范围）
 * GET    /orders/:id           详情
 * PATCH  /orders/:id/status    状态流转（ADMIN/STAFF；客户可取消待支付）
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { OrderService, type OrderRequester } from './orders.service.js';
import {
  createOrderBodySchema,
  listOrdersQuerySchema,
  updateStatusBodySchema,
} from './orders.schemas.js';
import { prisma } from '../../db/prisma.js';

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const service = new OrderService();

  // ── 下单 ────────────────────────────────────────────────────────
  app.post(
    '/',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const body = createOrderBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const order = await service.createOrder(body, requester);
      return reply.status(201).send({ order });
    },
  );

  // ── 列表 ────────────────────────────────────────────────────────
  app.get(
    '/',
    { preHandler: [app.authenticate] },
    async (req) => {
      const query = listOrdersQuerySchema.parse(req.query);
      const requester = await buildRequester(req.user.sub, req.user.role);
      return service.listOrders(query, requester);
    },
  );

  // ── 详情 ────────────────────────────────────────────────────────
  app.get(
    '/:id',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const requester = await buildRequester(req.user.sub, req.user.role);
      const order = await service.getOrder(id, requester);
      return { order };
    },
  );

  // ── 状态流转 ────────────────────────────────────────────────────
  app.patch(
    '/:id/status',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = updateStatusBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const order = await service.updateStatus(id, body.toStatus, requester, body.reason);
      return { order };
    },
  );
};

/**
 * 构建 OrderRequester：从 JWT payload 补齐 agentId（如果是 AGENT 角色）。
 */
async function buildRequester(userId: string, role: UserRole): Promise<OrderRequester> {
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
