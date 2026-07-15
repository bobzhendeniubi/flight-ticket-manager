/**
 * 切位（包位）路由 — 从散客池划座给代理专卖，到期未售回散客池（ADMIN/STAFF）。
 *
 * POST /seat-allocations              创建切位（校验 seats ≤ 散客池余票，绝不超切）
 * GET  /seat-allocations?flightScheduleId=&agentId=  列表（两个筛选都选填）
 * POST /seat-allocations/:id/reclaim  回收切位（ACTIVE → RECLAIMED，座位回散客池）
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { SeatAllocationService } from './seat-allocation.service.js';
import {
  createSeatAllocationBodySchema,
  listSeatAllocationsQuerySchema,
} from './seat-allocation.schemas.js';
import { actorFromRequest } from '../../lib/audit.js';

export const seatAllocationRoutes: FastifyPluginAsync = async (app) => {
  const service = new SeatAllocationService();

  // ── 创建切位 ────────────────────────────────────────────────────
  app.post(
    '/',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const body = createSeatAllocationBodySchema.parse(req.body);
      const allocation = await service.createAllocation(body, actorFromRequest(req));
      return reply.status(201).send({ allocation });
    },
  );

  // ── 列表 ────────────────────────────────────────────────────────
  app.get(
    '/',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const query = listSeatAllocationsQuerySchema.parse(req.query);
      const allocations = await service.listAllocations(query);
      return { allocations };
    },
  );

  // ── 回收切位 ────────────────────────────────────────────────────
  app.post(
    '/:id/reclaim',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const result = await service.reclaimAllocation(id, actorFromRequest(req));
      return { result };
    },
  );
};
