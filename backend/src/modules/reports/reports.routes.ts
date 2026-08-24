/**
 * 经营报表 API — ADMIN 或 STAFF+财务岗（财务口径，风格对齐 finances 模块）
 *
 * 路由：
 *   GET /reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD&dim=kind|channel|agent
 *   GET /reports/receivables
 *   GET /reports/agent-debts
 *   GET /reports/export?from=YYYY-MM-DD&to=YYYY-MM-DD   （xlsx，4 sheet）
 *
 * 所有访问都写审计日志（VIEW_REPORTS）— 报表数据敏感。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import {
  getAgentDebtsReport,
  getReceivablesReport,
  getSalesReport,
} from './reports.service.js';
import { buildReportsExportWorkbook, reportsExportFilename } from './reports.export.js';

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD');

const salesSchema = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  dim: z.enum(['kind', 'channel', 'agent']).optional(),
});

const rangeSchema = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
});

/** 缺省区间 = 最近 30 天（与 finances 一致） */
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
  detail: { route: string; range?: { from: string; to: string }; dim?: string },
): void {
  void writeAudit({
    actor: actorFromRequest(req),
    action: 'VIEW_REPORTS',
    targetType: 'SYSTEM',
    targetId: detail.route,
    targetLabel: '经营报表',
    after: detail,
  });
}

export const reportRoutes: FastifyPluginAsync = async (app) => {
  const requireFinance = {
    preHandler: [app.authenticate, app.requireFinanceAccess],
  };

  // ── 销售毛利（按产品线 / 渠道 / 代理）──
  app.get('/sales', requireFinance, async (req) => {
    const q = salesSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    const dim = q.dim ?? 'kind';
    logView(req, { route: 'sales', range, dim });
    return getSalesReport(range, dim);
  });

  // ── 应收账龄（余额 > 0 的进行中订单）──
  app.get('/receivables', requireFinance, async (req) => {
    logView(req, { route: 'receivables' });
    return getReceivablesReport();
  });

  // ── 代理欠款（按代理聚合应收余额 + 预存余额）──
  app.get('/agent-debts', requireFinance, async (req) => {
    logView(req, { route: 'agent-debts' });
    const rows = await getAgentDebtsReport();
    return { rows };
  });

  // ── xlsx 导出（4 sheet：三维度销售毛利 + 应收与代理欠款）──
  app.get('/export', requireFinance, async (req, reply) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'export', range });
    const buf = await buildReportsExportWorkbook(range);
    return reply
      .header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .header(
        'Content-Disposition',
        `attachment; filename="${reportsExportFilename(range)}"`,
      )
      .send(buf);
  });
};
