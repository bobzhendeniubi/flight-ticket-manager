/**
 * 财务 API — ADMIN-only 业务财务模块
 *
 * 路由：
 *   GET /finances/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET /finances/flights?from=...&to=...&limit=100
 *   GET /finances/orders?from=...&to=...&limit=100
 *   GET /finances/monthly?months=6
 *
 * 所有访问都写审计日志（VIEW_FINANCES）— 财务数据敏感。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import {
  getFinancesSummary,
  getFlightPnl,
  getOrderPnl,
  getMonthlyTrend,
} from './finances.service.js';

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD');

const rangeSchema = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const monthlySchema = z.object({
  months: z.coerce.number().int().positive().max(36).optional(),
});

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  const fmt = (d: Date): string =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { from: fmt(from), to: fmt(to) };
}

function logView(
  req: FastifyRequest,
  detail: { route: string; range?: { from: string; to: string }; months?: number },
): void {
  void writeAudit({
    actor: actorFromRequest(req),
    action: 'VIEW_FINANCES',
    targetType: 'SYSTEM',
    targetId: detail.route,
    targetLabel: '财务模块',
    after: detail,
  });
}

export const financesRoutes: FastifyPluginAsync = async (app) => {
  const requireAdmin = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)],
  };

  app.get('/summary', requireAdmin, async (req) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'summary', range });
    return getFinancesSummary(range);
  });

  app.get('/flights', requireAdmin, async (req) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'flights', range });
    const rows = await getFlightPnl(range, q.limit ?? 100);
    return { range, rows };
  });

  app.get('/orders', requireAdmin, async (req) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'orders', range });
    const rows = await getOrderPnl(range, q.limit ?? 100);
    return { range, rows };
  });

  app.get('/monthly', requireAdmin, async (req) => {
    const q = monthlySchema.parse(req.query);
    const months = q.months ?? 6;
    logView(req, { route: 'monthly', months });
    const points = await getMonthlyTrend(months);
    return { months, points };
  });
};
