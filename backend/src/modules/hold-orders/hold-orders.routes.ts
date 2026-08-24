/**
 * 占位单路由 — ADMIN/STAFF 管理无名单库存实体。
 * 建单与订单、锁位共享：capacity − sold − 未过期 ACTIVE 锁位 − 占位余座。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest } from '../../lib/audit.js';
import { HoldOrderService } from './hold-orders.service.js';
import {
  createHoldOrderBodySchema,
  listHoldOrdersQuerySchema,
  updateHoldOrderPriceBodySchema,
} from './hold-orders.schemas.js';

export const holdOrderRoutes: FastifyPluginAsync = async (app) => {
  const service = new HoldOrderService();
  const pre = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };

  app.post('/', pre, async (req, reply) => {
    const body = createHoldOrderBodySchema.parse(req.body);
    const holdOrder = await service.create(body, req.user.sub, actorFromRequest(req));
    return reply.status(201).send({ holdOrder });
  });

  app.get('/', pre, async (req) => {
    const query = listHoldOrdersQuerySchema.parse(req.query);
    return { holdOrders: await service.list(query) };
  });

  app.get('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    return { holdOrder: await service.getById(id) };
  });

  app.post('/:id/release', pre, async (req) => {
    const { id } = req.params as { id: string };
    return { result: await service.release(id, actorFromRequest(req)) };
  });

  app.post('/:id/cancel', pre, async (req) => {
    const { id } = req.params as { id: string };
    return { result: await service.cancel(id, actorFromRequest(req)) };
  });

  app.patch('/:id/price', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateHoldOrderPriceBodySchema.parse(req.body);
    return { result: await service.updatePrice(id, body, actorFromRequest(req)) };
  });
};
