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

  // ── 创建切位（已暂停）────────────────────────────────────────────
  // ⚠ 切位「专卖」当前未接入公共库存：散客搜索(search/listSchedules)与下单 CAS
  //   （sold+qty+locked ≤ capacity）都不扣 ACTIVE 切位（见 seat-allocation.service 头注释），
  //   所以切给代理的座散客照样能买光——「专卖不专」。在补齐「公共池扣切位 + 代理单消费切位余额
  //   + 回收只回未售量」这条完整库存链之前，禁止新建切位，避免运营依赖一个不成立的库存承诺。
  //   列表 / 回收保持开放，供清理存量切位。
  app.post(
    '/',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      createSeatAllocationBodySchema.parse(req.body); // 仍校验请求形状，但下方一律拒绝
      return reply.status(409).send({
        error:
          '切位功能暂停开放：当前切出的座位散客仍可购买（未接入公共库存扣减），为避免超卖已禁止新建。已存在的切位可继续查看与回收，库存联动补齐后再启用。',
      });
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
