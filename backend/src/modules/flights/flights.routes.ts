import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { FlightService, capPublicAvailable } from './flights.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { actorFromRequest } from '../../lib/audit.js';
import { priceQuerySchema } from '../pricing/pricing.schemas.js';
import {
  batchDeleteSchedulesBodySchema,
  batchUpdateCapacityBodySchema,
  createFlightBodySchema,
  createScheduleBodySchema,
  flightSearchQuerySchema,
  updateScheduleBodySchema,
  upsertBaggagePoliciesBodySchema,
} from './flights.schemas.js';

export const flightRoutes: FastifyPluginAsync = async (app) => {
  const service = new FlightService();
  const pricingService = new PricingService();

  // ── 公共搜索 ──
  app.get('/search', async (req) => {
    const q = flightSearchQuerySchema.parse(req.query);
    const results = await service.search(q);
    return { query: q, results };
  });

  // ── 动态定价查询（公共） ──
  app.get('/price', async (req) => {
    const q = priceQuerySchema.parse(req.query);
    const pricing = await pricingService.calculatePrice(q.scheduleId, q.cabin, q.qty);
    // 公开端点余位封顶：currentBucketRemaining 是精确档内剩余（内部计价要真值），
    // 对匿名端 ≤9 封顶输出，防止轮询重建实时销量；价格/档位字段不受影响。
    return {
      pricing: { ...pricing, currentBucketRemaining: capPublicAvailable(pricing.currentBucketRemaining) },
    };
  });

  // ── 管理员航班 CRUD ──
  // 列表：ADMIN/STAFF/AGENT 都可读（代理批量创单要选航班；AdminFlight 不含成本字段，安全）
  app.get(
    '/',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)] },
    async () => {
      const flights = await service.listFlights();
      return { flights };
    },
  );

  app.post(
    '/',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req, reply) => {
      const body = createFlightBodySchema.parse(req.body);
      const flight = await service.createFlight(body);
      return reply.status(201).send({ flight });
    },
  );

  app.post(
    '/:flightId/toggle',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { flightId } = req.params as { flightId: string };
      const flight = await service.deactivateFlight(flightId);
      return { flight };
    },
  );

  app.get(
    '/:flightId/schedules',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)] },
    async (req) => {
      const { flightId } = req.params as { flightId: string };
      const schedules = await service.listSchedules(flightId);
      // 代理可读班次（批量创单需要），但不可见成本字段 —— 剥离防泄露毛利
      if (req.user.role === UserRole.AGENT) {
        const sanitized = schedules.map((s) => {
          const { charterCostCny, airportTaxDepCny, airportTaxArrCny, ...rest } = s;
          void charterCostCny;
          void airportTaxDepCny;
          void airportTaxArrCny;
          return rest;
        });
        return { schedules: sanitized };
      }
      return { schedules };
    },
  );

  // ── 座位统计：按出发日区间列出所有航班的班次（含 available/locked，一次取数，免 N+1）──
  app.get(
    '/schedules',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const q = z
        .object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'from 格式应为 YYYY-MM-DD').optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'to 格式应为 YYYY-MM-DD').optional(),
        })
        .parse(req.query);
      const schedules = await service.listSchedulesInRange(q);
      return { schedules };
    },
  );

  // ── 行李规则（航班 × 舱等；ADMIN/STAFF 维护）──
  app.get(
    '/:flightId/baggage-policies',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { flightId } = req.params as { flightId: string };
      const policies = await service.listBaggagePolicies(flightId);
      return { policies };
    },
  );

  // PUT 整体替换：body 是 [{cabin, checkedKg, checkedPieces, carryOnKg, note}]；未出现的舱等删除
  app.put(
    '/:flightId/baggage-policies',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { flightId } = req.params as { flightId: string };
      const items = upsertBaggagePoliciesBodySchema.parse(req.body);
      const policies = await service.upsertBaggagePolicies(flightId, items);
      return { policies };
    },
  );

  app.post(
    '/schedules',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req, reply) => {
      const body = createScheduleBodySchema.parse(req.body);
      const schedule = await service.createSchedule(body);
      return reply.status(201).send({ schedule });
    },
  );

  // 班次开票上限（航司限制；默认 191，运营可按班次调整）
  app.patch(
    '/schedules/:scheduleId/ticketing-cap',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const body = z
        .object({ ticketingCap: z.number().int().min(1).max(600) })
        .parse(req.body);
      const schedule = await service.updateTicketingCap(scheduleId, body.ticketingCap);
      return { schedule };
    },
  );

  // 单班次编辑（月历库存视图：改价 / 改容量 / 停用启用 / 改时刻）。ADMIN/STAFF 都可改。
  app.patch(
    '/schedules/:scheduleId',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const body = updateScheduleBodySchema.parse(req.body);
      const schedule = await service.updateSchedule(scheduleId, body, actorFromRequest(req));
      return { schedule };
    },
  );

  // 批量删除班次（按出发日区间；已售班次自动跳过）。仅 ADMIN —— 与单删同权限，
  // 避免 STAFF 一次跨全航班/整月批量删的更大爆炸半径；操作写审计留痕。
  // body: { flightId?, from, to }（from/to 为出发地当地日 YYYY-MM-DD）。
  // 返回 { deleted, skipped: [{ scheduleId, reason }] }，已售/有订单的班次不会被删。
  app.post(
    '/schedules/batch-delete',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const body = batchDeleteSchedulesBodySchema.parse(req.body);
      const result = await service.batchDeleteSchedules(body, actorFromRequest(req));
      return { result };
    },
  );

  // 批量改容量（按 scheduleId 列表；已售超过目标容量的班次自动跳过，不影响其它班次）。
  // 仅 ADMIN —— 与批量删除同权限口径，批量改动爆炸半径大；操作写审计留痕。
  // body: { scheduleIds, seatClasses: [{cabin, capacity}] }
  // 返回 { applied, skipped: [{ scheduleId, reason }] }。
  app.post(
    '/schedules/batch-update-capacity',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const body = batchUpdateCapacityBodySchema.parse(req.body);
      const result = await service.batchUpdateCapacity(body, actorFromRequest(req));
      return { result };
    },
  );

  app.delete(
    '/schedules/:scheduleId',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const result = await service.deleteSchedule(scheduleId);
      return { result };
    },
  );
};
