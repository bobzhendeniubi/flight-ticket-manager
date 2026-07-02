/**
 * 仪表盘路由 — 仅 ADMIN/STAFF
 *
 * GET /dashboard/kpi          今日/本月 KPI + 变化率
 * GET /dashboard/weekly       最近 7 天时间序列
 * GET /dashboard/top-agents   本月 Top 5 代理
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { DashboardService } from './dashboard.service.js';

// days 允许缺省（默认 7 天）；提供时必须是 1..90 的整数字符串，非法值（非数字/超范围）→ 400。
const weeklyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  const service = new DashboardService();
  const pre = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };

  app.get('/kpi', pre, async () => {
    return { kpi: await service.getKpi() };
  });

  app.get('/weekly', pre, async (req) => {
    const { days } = weeklyQuerySchema.parse(req.query);
    return { series: await service.getDailySeries(days) };
  });

  app.get('/top-agents', pre, async () => {
    return { agents: await service.topAgentsThisMonth() };
  });
};
