import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import {
  getLegacyPassengerHistory,
  getLegacyDashboard,
  getLegacyStats,
  getLegacyTicket,
  listLegacyTickets,
} from './legacy.service.js';

const dateQuery = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day!));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
  }, '日期不是有效的日历日期');
const booleanQuery = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
);
const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  dateFrom: dateQuery.optional(),
  dateTo: dateQuery.optional(),
  orgId: z.string().trim().max(100).optional(),
  paymentConfirmed: booleanQuery.optional(),
  dataIssue: z.string().trim().min(1).max(100).optional(),
  includeDeleted: booleanQuery.optional().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const passengerHistorySchema = z.object({
  doc: z.string().trim().min(1).max(100),
});

export const legacyRoutes: FastifyPluginAsync = async (app) => {
  const staffOnly = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };

  app.get('/tickets', staffOnly, async (req) => {
    const query = listQuerySchema.parse(req.query);
    return listLegacyTickets(query);
  });

  app.get('/tickets/:id', staffOnly, async (req, reply) => {
    const params = z.object({ id: z.string().min(1).max(200) }).parse(req.params);
    const ticket = await getLegacyTicket(params.id);
    if (!ticket) return reply.notFound('历史档案不存在');
    return { item: ticket };
  });

  app.get('/passenger-history', staffOnly, async (req) => {
    const query = passengerHistorySchema.parse(req.query);
    return getLegacyPassengerHistory(query.doc);
  });

  app.get('/stats', staffOnly, async () => getLegacyStats());
  app.get('/dashboard', staffOnly, async () => getLegacyDashboard());
};
