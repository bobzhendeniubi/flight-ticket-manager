/**
 * 财务 API — 业务财务模块
 * 损益/报表/导出等查询放开到 ADMIN 或 STAFF+财务岗；成本维护（周期/班次/产品成本 + 成本锁定）仍按 ADMIN/STAFF。
 *
 * 路由：
 *   GET /finances/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&routeKey=MFM-DAD
 *   GET /finances/flights?from=...&to=...&limit=100
 *   GET /finances/orders?from=...&to=...&limit=100
 *   GET /finances/monthly?months=6&routeKey=MFM-DAD
 *   POST /finances/cost-snapshots/backfill?limit=&apply=  存量机票/套餐行成本快照回填
 *
 * 所有访问都写审计日志（VIEW_FINANCES）— 财务数据敏感。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
// 成本快照回填的查询参数：定义在契约包（前后端同一份）
import { costBackfillQuerySchema } from '@ftm/contracts/finances';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { businessDateISO } from '../../lib/business-time.js';
import {
  getFinancesSummary,
  getFlightPnl,
  getOrderPnl,
  getOrderPnlDetail,
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
  setFlightScheduleCostLock,
  updateCostPeriod,
} from './finances.cost.service.js';
import { getUsdFxRate, listUsdFxRates, upsertUsdFxRate } from './finances.fx.service.js';
import { buildFinanceExportWorkbook, financeExportFilename } from './finances.export.js';
import {
  buildFinanceExportByFlightWorkbook,
  financeExportByFlightFilename,
} from './finances.export-by-flight.js';
import {
  buildFinanceExportByOrderWorkbook,
  financeExportByOrderFilename,
} from './finances.export-orders.js';
import { listPendingRefundPayouts } from './finances.refund-payout.js';
import { backfillItemCostSnapshots } from './finances.cost-backfill.js';

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD');

/**
 * 航线筛选参数（'MFM-DAD' 形状，或 'unknown' = 推不出航线的单）。
 * 缺省 / 空串 = 不筛（全部航线）——前端下拉的「全部」项传空串。
 */
const routeKeyParam = z
  .string()
  .max(32)
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null));

const rangeSchema = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  routeKey: routeKeyParam,
});

const monthlySchema = z.object({
  months: z.coerce.number().int().positive().max(36).optional(),
  routeKey: routeKeyParam,
});

// 成本字段：number 或 null（清空）；缺省 = 不改（统一 CNY，无汇率）
const costNum = z.number().nonnegative().nullable().optional();
// 机型调整/起降折扣允许负数（少收或补贴的减项）
const signedCostNum = z.number().nullable().optional();
const flightCostSchema = z.object({
  charterCostCny: costNum,
  airportTaxDepCny: costNum,
  airportTaxArrCny: costNum,
  fuelCostCny: costNum,
  peakSurchargeCny: costNum,
  aircraftAdjustCny: signedCostNum,
  takeoffDiscountCny: signedCostNum,
});
const hotelCostSchema = z.object({ costPriceCny: costNum });
const visaCostSchema = z.object({ costPriceCny: costNum });
const transferCostSchema = z.object({ costPriceCny: costNum });

/**
 * 缺省区间 = 最近 30 天，末端锚在**北京业务日**的今天（口径同 reports.routes.ts）。
 * 原先按 UTC 日取「今天」，北京 00:00–08:00 打开损益会拿到只到昨天的区间。
 */
function defaultRange(): { from: string; to: string } {
  const to = businessDateISO(new Date());
  const fromDate = new Date(`${to}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 29);
  return { from: fromDate.toISOString().slice(0, 10), to };
}

function logView(
  req: FastifyRequest,
  detail: {
    route: string;
    range?: { from: string; to: string };
    months?: number;
    orderId?: string;
    /** 圈定的航线（未圈 = 省略）——审计里看得出这次查的是哪条线的数。 */
    routeKey?: string;
  },
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
  const requireFinance = {
    preHandler: [app.authenticate, app.requireCapability('finances.view')],
  };
  const requireAdminOrStaff = {
    preHandler: [app.authenticate, app.requireCapability('finances.cost.manage')],
  };

  app.get('/summary', requireFinance, async (req) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'summary', range, routeKey: q.routeKey ?? undefined });
    return getFinancesSummary(range, q.routeKey);
  });

  app.get('/flights', requireFinance, async (req) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'flights', range });
    const rows = await getFlightPnl(range, q.limit ?? 100);
    return { range, rows };
  });

  app.get('/orders', requireFinance, async (req) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'orders', range });
    const rows = await getOrderPnl(range, q.limit ?? 100);
    return { range, rows };
  });

  // ── 单订单收支明细（下钻）：收入逐项 + 成本逐项 + 杂项成本逐条 ──
  app.get('/orders/:id/pnl-detail', requireFinance, async (req, reply) => {
    const { id } = req.params as { id: string };
    logView(req, { route: 'order-pnl-detail', orderId: id });
    const detail = await getOrderPnlDetail(id);
    if (!detail) return reply.status(404).send({ error: '订单不存在或已删除' });
    return detail;
  });

  // ── 待打款队列 ────────────────────────────────────────────────────────────
  // 已核准（Refund=COMPLETED）但还没登记打款（paidAt 为空）的退款。
  // 核准只是「账上认了这笔退款」，钱是财务在银行/微信里手工打的——这条队列就是那一步的待办。
  // 登记入口在订单侧（POST /orders/:id/refunds/:refundId/mark-paid），两处同一份财务岗闸。
  app.get('/refunds/pending-payout', requireFinance, async (req) => {
    logView(req, { route: 'refunds-pending-payout' });
    return listPendingRefundPayouts();
  });

  app.get('/monthly', requireFinance, async (req) => {
    const q = monthlySchema.parse(req.query);
    const months = q.months ?? 6;
    logView(req, { route: 'monthly', months, routeKey: q.routeKey ?? undefined });
    const points = await getMonthlyTrend(months, q.routeKey);
    return { months, points, routeKey: q.routeKey };
  });

  // ── 存量成本快照回填（机票行 / 套餐行）────────────────────────────────────
  // 这两类行的成本快照 2026-09-06 才开始落库，之前的单一律 NULL，于是存量区间的毛利
  // 全报「未知」。这条端点把现在算得出来的成本补进去；口径与幂等见 finances.cost-backfill.ts。
  // 缺省 apply=false（只算不写）——先看清楚要补多少行、有多少行补不上，再决定要不要写。
  // 只给 ADMIN（finances.cost.backfill）：改一条成本周期只影响那条线那段日期，这一按却会
  // 一次性重写整本订单簿上机票/套餐行的成本，报表与概览的毛利跟着全变——比成本维护重一档。
  app.post(
    '/cost-snapshots/backfill',
    { preHandler: [app.authenticate, app.requireCapability('finances.cost.backfill')] },
    async (req) => {
      const q = costBackfillQuerySchema.parse(req.query);
      const result = await backfillItemCostSnapshots({ limit: q.limit, apply: q.apply });
      // 真写库才留审计（dry-run 只是看一眼，写审计反而是噪音）。
      if (q.apply && result.filled > 0) {
        await writeAudit({
          actor: actorFromRequest(req),
          action: 'BACKFILL_ITEM_COST_SNAPSHOTS',
          targetType: 'SYSTEM',
          targetId: 'cost-snapshots',
          targetLabel: `订单行成本快照回填 · 补上 ${result.filled} 行`,
          after: {
            ...result,
            limit: q.limit ?? null,
            note: '成本周期无版本历史，回填按当前周期定义 + 航段出发日计算；套餐办签人数取当前乘客名单。',
          },
          severity: 'CRITICAL',
        });
      }
      return result;
    },
  );

  // ── xlsx 导出（一行/乘客）──
  app.get('/export', requireFinance, async (req, reply) => {
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
  app.get('/export-by-flight', requireFinance, async (req, reply) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'export-by-flight', range, routeKey: q.routeKey ?? undefined });
    const buf = await buildFinanceExportByFlightWorkbook(range, q.routeKey);
    return reply
      .header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(financeExportByFlightFilename(range, q.routeKey))}"`,
      )
      .send(buf);
  });

  // ── xlsx 导出（一行/订单，订单毛利）──
  app.get('/export-orders', requireFinance, async (req, reply) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'export-orders', range });
    const buf = await buildFinanceExportByOrderWorkbook(range);
    return reply
      .header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(financeExportByOrderFilename(range))}"`,
      )
      .send(buf);
  });

  // ── 航班成本列表（财务页用，ADMIN/STAFF）──
  // GET /finances/cost/schedules?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get('/cost/schedules', requireAdminOrStaff, async (req) => {
    const q = z.object({ from: dateStr.optional(), to: dateStr.optional() }).parse(req.query);
    const schedules = await listSchedulesWithCost(q);
    return { schedules };
  });

  // ── 班次成本手动锁定（ADMIN/STAFF）────────────────────────────────────────
  app.post('/schedules/:id/cost-lock', requireAdminOrStaff, async (req) => {
    const { id } = req.params as { id: string };
    const { lock } = z.object({ lock: z.boolean() }).parse(req.body);
    const actor = actorFromRequest(req);
    const result = await setFlightScheduleCostLock(id, lock, actor.userId);
    if (result.changed) {
      void writeAudit({
        actor,
        action: lock ? 'LOCK_FLIGHT_SCHEDULE_COST' : 'UNLOCK_FLIGHT_SCHEDULE_COST',
        targetType: 'FLIGHT',
        targetId: id,
        targetLabel: result.targetLabel,
        before: result.before,
        after: result.after,
      });
    }
    return {
      id: result.id,
      costLocked: result.costLocked,
      costLockedAt: result.costLockedAt?.toISOString() ?? null,
      costLockedBy: result.costLockedBy,
    };
  });

  // ── 航班成本周期 CRUD（ADMIN/STAFF）按 (航班, 日期段) 定包机/机场税/4 个新成本字段
  const periodWriteSchema = z.object({
    flightId: z.string().min(1),
    effectiveFrom: dateStr,
    effectiveTo: dateStr,
    charterCostCny: costNum,
    airportTaxDepCny: costNum,
    airportTaxArrCny: costNum,
    fuelCostCny: costNum,
    peakSurchargeCny: costNum,
    aircraftAdjustCny: signedCostNum,
    takeoffDiscountCny: signedCostNum,
    // A2 汇率四元组（可空）：包机原币种(ISO 4217)/原币金额/汇率/折算日——审计留痕，CNY 仍是入账口径
    charterSourceCurrency: z.string().regex(/^[A-Z]{3}$/, '币种须为 3 位大写代码，如 USD').nullable().optional(),
    charterSourceAmount: z.number().min(0).max(99_999_999).nullable().optional(),
    charterFxRate: z.number().gt(0).max(100_000).nullable().optional(),
    charterFxDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').nullable().optional(),
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
    aircraftAdjustCny: signedCostNum,
    takeoffDiscountCny: signedCostNum,
    // A2 汇率四元组（可空）：包机原币种(ISO 4217)/原币金额/汇率/折算日——审计留痕，CNY 仍是入账口径
    charterSourceCurrency: z.string().regex(/^[A-Z]{3}$/, '币种须为 3 位大写代码，如 USD').nullable().optional(),
    charterSourceAmount: z.number().min(0).max(99_999_999).nullable().optional(),
    charterFxRate: z.number().gt(0).max(100_000).nullable().optional(),
    charterFxDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').nullable().optional(),
    note: z.string().max(200).nullable().optional(),
  });

  app.get('/cost/periods', requireAdminOrStaff, async (req) => {
    const q = z.object({ flightId: z.string().optional() }).parse(req.query);
    const periods = await listCostPeriods({ flightId: q.flightId });
    return { periods };
  });

  app.post('/cost/periods', requireAdminOrStaff, async (req, reply) => {
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

  app.patch('/cost/periods/:id', requireAdminOrStaff, async (req, reply) => {
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

  app.delete('/cost/periods/:id', requireAdminOrStaff, async (req) => {
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

  app.patch('/cost/flight-schedule/:id', requireAdminOrStaff, async (req) => {
    const { id } = req.params as { id: string };
    const data = flightCostSchema.parse(req.body);
    const result = await patchFlightScheduleCost(id, data);
    auditCost(req, `flight-schedule:${id}`, data);
    return result;
  });

  app.patch('/cost/hotel-room-type/:id', requireAdminOrStaff, async (req) => {
    const { id } = req.params as { id: string };
    const data = hotelCostSchema.parse(req.body);
    const result = await patchHotelRoomTypeCost(id, data);
    auditCost(req, `hotel-room-type:${id}`, data);
    return result;
  });

  app.patch('/cost/visa/:id', requireAdminOrStaff, async (req) => {
    const { id } = req.params as { id: string };
    const data = visaCostSchema.parse(req.body);
    const result = await patchVisaCost(id, data);
    auditCost(req, `visa:${id}`, data);
    return result;
  });

  app.patch('/cost/transfer/:id', requireAdminOrStaff, async (req) => {
    const { id } = req.params as { id: string };
    const data = transferCostSchema.parse(req.body);
    const result = await patchTransferCost(id, data);
    auditCost(req, `transfer:${id}`, data);
    return result;
  });

  // ── 美金汇率表（按生效日）────────────────────────────────────────────────────
  // 财务加一条「某日起 x.xx」，区间由下一条的生效日隐含。签证台设金额时自动带出当日汇率，
  // 折算值当场固化在任务上 —— 之后改汇率表绝不追溯已入账的旧任务。
  // 读写都放开到 ADMIN/STAFF：签证岗要读当日汇率，财务岗要维护。
  const usdFxRateUpsertSchema = z.object({
    effectiveFrom: dateStr,
    rate: z.number().positive().max(1000),
    note: z.string().max(200).nullable().optional(),
  });

  app.get('/usd-fx-rates', requireAdminOrStaff, async () => {
    const rates = await listUsdFxRates();
    return { rates };
  });

  /** 取某日生效的汇率（≤date 的最新一条）；未维护 → { rate: null }，前端据此让用户手填。 */
  app.get('/usd-fx-rates/effective', requireAdminOrStaff, async (req) => {
    const q = z.object({ date: dateStr }).parse(req.query);
    const rate = await getUsdFxRate(q.date);
    return { rate };
  });

  app.put('/usd-fx-rates', requireAdminOrStaff, async (req) => {
    const body = usdFxRateUpsertSchema.parse(req.body);
    const rate = await upsertUsdFxRate(body, req.user.sub);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPSERT_USD_FX_RATE',
      targetType: 'SYSTEM',
      targetId: rate.id,
      targetLabel: `美金汇率 ${rate.effectiveFrom} 起 ${rate.rate}`,
      after: rate,
    });
    return { rate };
  });
};
