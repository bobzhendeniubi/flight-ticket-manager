import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { FlightService } from './flights.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { priceQuerySchema } from '../pricing/pricing.schemas.js';
import {
  createFlightBodySchema,
  createScheduleBodySchema,
  flightSearchQuerySchema,
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
  app.get(
    '/',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
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
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { flightId } = req.params as { flightId: string };
      const schedules = await service.listSchedules(flightId);
      return { schedules };
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
