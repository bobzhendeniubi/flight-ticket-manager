import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { FlightService } from './flights.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { priceQuerySchema } from '../pricing/pricing.schemas.js';
import {
  createFlightBodySchema,
  createScheduleBodySchema,
  flightSearchQuerySchema,
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
    return { pricing };
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
