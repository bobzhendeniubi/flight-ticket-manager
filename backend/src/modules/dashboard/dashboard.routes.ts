/**
 * 仪表盘路由 — 仅 ADMIN/STAFF
 *
 * GET /dashboard/kpi          今日/本月 KPI + 变化率
 * GET /dashboard/weekly       最近 7 天时间序列
 * GET /dashboard/top-agents   本月 Top 5 代理
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { DashboardService } from './dashboard.service.js';

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  const service = new DashboardService();
  const pre = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };

  app.get('/kpi', pre, async () => {
    return { kpi: await service.getKpi() };
  });

  app.get('/weekly', pre, async (req) => {
    const { days } = req.query as { days?: string };
    const n = days ? Math.min(30, Math.max(1, Number(days))) : 7;
    return { series: await service.getDailySeries(n) };
  });

  app.get('/top-agents', pre, async () => {
    return { agents: await service.topAgentsThisMonth() };
  });
};
