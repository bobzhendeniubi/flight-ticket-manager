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
import {
  createCostPeriod,
  deleteCostPeriod,
  listCostPeriods,
  listSchedulesWithCost,
  patchFlightScheduleCost,
  patchHotelRoomTypeCost,
  patchVisaCost,
  patchTransferCost,
  updateCostPeriod,
} from './finances.cost.service.js';
import { buildFinanceExportWorkbook, financeExportFilename } from './finances.export.js';
import {
  buildFinanceExportByFlightWorkbook,
  financeExportByFlightFilename,
} from './finances.export-by-flight.js';

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

// 成本字段：number 或 null（清空）；缺省 = 不改（统一 CNY，无汇率）
const costNum = z.number().nonnegative().nullable().optional();
// 起降折扣允许负数（航司给我们的减项）
const signedCostNum = z.number().nullable().optional();
const flightCostSchema = z.object({
  charterCostCny: costNum,
  airportTaxDepCny: costNum,
  airportTaxArrCny: costNum,
  fuelCostCny: costNum,
  peakSurchargeCny: costNum,
  aircraftAdjustCny: costNum,
  takeoffDiscountCny: signedCostNum,
});
const hotelCostSchema = z.object({ costPriceCny: costNum });
const visaCostSchema = z.object({ costPriceCny: costNum });
const transferCostSchema = z.object({ costPriceCny: costNum });

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

  // ── xlsx 导出（一行/乘客）──
  app.get('/export', requireAdmin, async (req, reply) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'export', range });
    const buf = await buildFinanceExportWorkbook(range);
    return reply
      .header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(financeExportFilename(range))}"`,
      )
      .send(buf);
  });

  // ── xlsx 导出（一行/班次，整班 P&L）──
  app.get('/export-by-flight', requireAdmin, async (req, reply) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'export-by-flight', range });
    const buf = await buildFinanceExportByFlightWorkbook(range);
    return reply
      .header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(financeExportByFlightFilename(range))}"`,
      )
      .send(buf);
  });

  // ── 航班成本列表（财务页用，admin-only）──
  // GET /finances/cost/schedules?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get('/cost/schedules', requireAdmin, async (req) => {
    const q = z.object({ from: dateStr.optional(), to: dateStr.optional() }).parse(req.query);
    const schedules = await listSchedulesWithCost(q);
    return { schedules };
  });

  // ── 航班成本周期 CRUD（admin-only）按 (航班, 日期段) 定包机/机场税/4 个新成本字段
  const periodWriteSchema = z.object({
    flightId: z.string().min(1),
    effectiveFrom: dateStr,
    effectiveTo: dateStr,
    charterCostCny: costNum,
    airportTaxDepCny: costNum,
    airportTaxArrCny: costNum,
    fuelCostCny: costNum,
    peakSurchargeCny: costNum,
    aircraftAdjustCny: costNum,
    takeoffDiscountCny: signedCostNum,
    note: z.string().max(200).nullable().optional(),
  });
  const periodPatchSchema = z.object({
    effectiveFrom: dateStr.optional(),
    effectiveTo: dateStr.optional(),
    charterCostCny: costNum,
    airportTaxDepCny: costNum,
    airportTaxArrCny: costNum,
    fuelCostCny: costNum,
    peakSurchargeCny: costNum,
    aircraftAdjustCny: costNum,
    takeoffDiscountCny: signedCostNum,
    note: z.string().max(200).nullable().optional(),
  });

  app.get('/cost/periods', requireAdmin, async (req) => {
    const q = z.object({ flightId: z.string().optional() }).parse(req.query);
    const periods = await listCostPeriods({ flightId: q.flightId });
    return { periods };
  });

  app.post('/cost/periods', requireAdmin, async (req, reply) => {
    try {
      const body = periodWriteSchema.parse(req.body);
      const period = await createCostPeriod(body);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'CREATE_COST_PERIOD',
        targetType: 'FLIGHT',
        targetId: body.flightId,
        targetLabel: `${body.effectiveFrom}→${body.effectiveTo}`,
        after: body,
      });
      return { period };
    } catch (e) {
      if (e instanceof Error) return reply.status(400).send({ error: e.message });
      throw e;
    }
  });

  app.patch('/cost/periods/:id', requireAdmin, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const body = periodPatchSchema.parse(req.body);
      const period = await updateCostPeriod(id, body);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'UPDATE_COST_PERIOD',
        targetType: 'FLIGHT',
        targetId: period.flightId,
        targetLabel: `${period.effectiveFrom}→${period.effectiveTo}`,
        after: body,
      });
      return { period };
    } catch (e) {
      if (e instanceof Error) return reply.status(400).send({ error: e.message });
      throw e;
    }
  });

  app.delete('/cost/periods/:id', requireAdmin, async (req) => {
    const { id } = req.params as { id: string };
    const result = await deleteCostPeriod(id);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_COST_PERIOD',
      targetType: 'FLIGHT',
      targetId: id,
      targetLabel: 'period',
      after: null,
    });
    return result;
  });

  // ── 产品成本编辑 ──────────────────────────────────────────────────────────
  function auditCost(req: FastifyRequest, target: string, after: unknown): void {
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_FINANCE_COST',
      targetType: 'PRODUCT',
      targetId: target,
      targetLabel: '产品成本',
      after,
    });
  }

  app.patch('/cost/flight-schedule/:id', requireAdmin, async (req) => {
    const { id } = req.params as { id: string };
    const data = flightCostSchema.parse(req.body);
    const result = await patchFlightScheduleCost(id, data);
    auditCost(req, `flight-schedule:${id}`, data);
    return result;
  });

  app.patch('/cost/hotel-room-type/:id', requireAdmin, async (req) => {
    const { id } = req.params as { id: string };
    const data = hotelCostSchema.parse(req.body);
    const result = await patchHotelRoomTypeCost(id, data);
    auditCost(req, `hotel-room-type:${id}`, data);
    return result;
  });

  app.patch('/cost/visa/:id', requireAdmin, async (req) => {
    const { id } = req.params as { id: string };
    const data = visaCostSchema.parse(req.body);
    const result = await patchVisaCost(id, data);
    auditCost(req, `visa:${id}`, data);
    return result;
  });

  app.patch('/cost/transfer/:id', requireAdmin, async (req) => {
    const { id } = req.params as { id: string };
    const data = transferCostSchema.parse(req.body);
    const result = await patchTransferCost(id, data);
    auditCost(req, `transfer:${id}`, data);
    return result;
  });
};
