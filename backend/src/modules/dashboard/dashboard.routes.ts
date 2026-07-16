/**
 * 仪表盘路由 — 仅 ADMIN/STAFF
 *
 * GET /dashboard/kpi                    今日/本月 KPI + 变化率
 * GET /dashboard/weekly                 最近 7 天时间序列
 * GET /dashboard/top-agents             本月 Top 5 代理
 * GET /dashboard/pending-aging          待支付订单账龄分桶（含无支付时限单数）
 * GET /dashboard/pending-aging/orders   下钻：某一档的待支付单明细
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { DashboardService } from './dashboard.service.js';
import { PendingAgingService, PENDING_AGING_BUCKETS } from './pending-aging.service.js';

// days 允许缺省（默认 7 天）；提供时必须是 1..90 的整数字符串，非法值（非数字/超范围）→ 400。
const weeklyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

// 下钻筛选：bucket 缺省=不限账龄；noClockOnly 只认 'true'/'false'（query 全是字符串，
// z.coerce.boolean 会把 "false" 判成 true —— 与订单列表 invoiced 同款处理，别踩同一个坑）。
const pendingAgingOrdersQuerySchema = z.object({
  bucket: z.enum(PENDING_AGING_BUCKETS).optional(),
  noClockOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  const service = new DashboardService();
  const pendingAging = new PendingAgingService();
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

  // 待支付订单账龄：四档 + 各档「无支付时限」单数。
  // 这些单占着机位、无任何自动回收 —— 卡片就是唯一能第一天看见它们的地方。
  app.get('/pending-aging', pre, async () => {
    return { summary: await pendingAging.getSummary() };
  });

  // 下钻明细：卡片点进来的那一档（代理 / 出发日 / 账龄 / 占座人数）。
  app.get('/pending-aging/orders', pre, async (req) => {
    const query = pendingAgingOrdersQuerySchema.parse(req.query);
    return pendingAging.listOrders(query);
  });
};
