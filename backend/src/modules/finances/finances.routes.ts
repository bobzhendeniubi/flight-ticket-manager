/**
 * 财务 API — 业务财务模块
 * 损益/报表/导出等查询放开到 ADMIN 或 STAFF+财务岗；成本维护（周期/班次/产品成本 + 成本锁定）仍按 ADMIN/STAFF。
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
import {
  FX_CURRENCIES,
  getFxRate,
  listEffectiveFxRates,
  listFxNameOptions,
  listFxRates,
  listFxSupplierOptions,
  upsertFxRate,
} from './finances.fx.service.js';
import { buildFinanceExportWorkbook, financeExportFilename } from './finances.export.js';
import {
  buildFinanceExportByFlightWorkbook,
  financeExportByFlightFilename,
} from './finances.export-by-flight.js';
import {
  buildFinanceExportByOrderWorkbook,
  financeExportByOrderFilename,
} from './finances.export-orders.js';
import {
  createHotelRoomTypeCostPeriod,
  deleteHotelRoomTypeCostPeriod,
  listHotelRoomTypeCostPeriods,
  updateHotelRoomTypeCostPeriod,
} from './hotel-cost.service.js';

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
// 酒店净房价：人民币或越南盾二选一（同一次提交不能两个都给数）；costFxName = 越南盾按哪条 VND 汇率行折算（空 = 通用行）
const fxNameStr = z.string().max(100);
const hotelCostSchema = z
  .object({
    costPriceCny: costNum,
    costPriceVnd: z.number().nonnegative().max(9_999_999_999).nullable().optional(),
    costFxName: fxNameStr.nullable().optional(),
  })
  .refine((b) => !(b.costPriceCny != null && b.costPriceVnd != null), {
    message: '净房价填人民币或越南盾其中一个',
  });
// 酒店房型净房价按日期区间：区间价必填（人民币或越南盾二选一，非负），起止日 YYYY-MM-DD（含 effectiveTo 当晚）
const hotelCostPeriodWriteSchema = z
  .object({
    effectiveFrom: dateStr,
    effectiveTo: dateStr,
    costPriceCny: z.number().nonnegative().max(99_999_999).nullable().optional(),
    costPriceVnd: z.number().nonnegative().max(9_999_999_999).nullable().optional(),
    costFxName: fxNameStr.nullable().optional(),
    note: z.string().max(200).nullable().optional(),
  })
  .refine((b) => (b.costPriceCny != null) !== (b.costPriceVnd != null), {
    message: '区间净房价填人民币或越南盾其中一个',
  });
const hotelCostPeriodPatchSchema = z
  .object({
    effectiveFrom: dateStr.optional(),
    effectiveTo: dateStr.optional(),
    costPriceCny: z.number().nonnegative().max(99_999_999).nullable().optional(),
    costPriceVnd: z.number().nonnegative().max(9_999_999_999).nullable().optional(),
    costFxName: fxNameStr.nullable().optional(),
    note: z.string().max(200).nullable().optional(),
  })
  .refine((b) => !(b.costPriceCny != null && b.costPriceVnd != null), {
    message: '区间净房价填人民币或越南盾其中一个',
  });
const visaCostSchema = z.object({ costPriceCny: costNum });
// 车队结算价：人民币或越南盾二选一（同一次提交不能两个都给数）；costFxName = 越南盾按哪条 VND 汇率行折算（空 = 通用行）
const transferCostSchema = z
  .object({
    costPriceCny: costNum,
    costPriceVnd: z.number().nonnegative().max(9_999_999_999).nullable().optional(),
    costFxName: fxNameStr.nullable().optional(),
  })
  .refine((b) => !(b.costPriceCny != null && b.costPriceVnd != null), {
    message: '结算价填人民币或越南盾其中一个',
  });

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
  detail: { route: string; range?: { from: string; to: string }; months?: number; orderId?: string },
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
    preHandler: [app.authenticate, app.requireFinanceAccess],
  };
  const requireAdminOrStaff = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)],
  };

  app.get('/summary', requireFinance, async (req) => {
    const q = rangeSchema.parse(req.query);
    const def = defaultRange();
    const range = { from: q.from ?? def.from, to: q.to ?? def.to };
    logView(req, { route: 'summary', range });
    return getFinancesSummary(range);
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

  app.get('/monthly', requireFinance, async (req) => {
    const q = monthlySchema.parse(req.query);
    const months = q.months ?? 6;
    logView(req, { route: 'monthly', months });
    const points = await getMonthlyTrend(months);
    return { months, points };
  });

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

  // ── 酒店房型净房价按日期区间（ADMIN/STAFF）：区间价优先于房型缺省净房价；同房型区间不得重叠（409）──
  app.get('/cost/hotel-room-type/:id/periods', requireAdminOrStaff, async (req) => {
    const { id } = req.params as { id: string };
    const periods = await listHotelRoomTypeCostPeriods(id);
    return { periods };
  });

  app.post('/cost/hotel-room-type/:id/periods', requireAdminOrStaff, async (req) => {
    const { id } = req.params as { id: string };
    const body = hotelCostPeriodWriteSchema.parse(req.body);
    const period = await createHotelRoomTypeCostPeriod(id, body);
    auditCost(req, `hotel-room-type:${id}:period:${period.id}`, { op: 'create', ...body });
    return { period };
  });

  app.patch('/cost/hotel-room-type-periods/:pid', requireAdminOrStaff, async (req) => {
    const { pid } = req.params as { pid: string };
    const body = hotelCostPeriodPatchSchema.parse(req.body);
    const period = await updateHotelRoomTypeCostPeriod(pid, body);
    auditCost(req, `hotel-room-type:${period.roomTypeId}:period:${pid}`, { op: 'update', ...body });
    return { period };
  });

  app.delete('/cost/hotel-room-type-periods/:pid', requireAdminOrStaff, async (req) => {
    const { pid } = req.params as { pid: string };
    const result = await deleteHotelRoomTypeCostPeriod(pid);
    auditCost(req, `hotel-room-type:${result.roomTypeId}:period:${pid}`, { op: 'delete' });
    return { id: result.id };
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

  // ── 汇率表（命名清单：汇率名称 × 币种 × 生效日）──────────────────────────────
  // 汇率跟供应商合同走：一个供应商一条名称（签证公司名 / 「酒店越南盾」…），汇率变了按生效日加新行，
  // 区间由同名称同币种下一条的生效日隐含；名称留空 = 该币种通用行，只在该名称没有汇率时兜底。
  // 记法按财务习惯：USD 行 = 1 美金折多少人民币；VND 行 = 多少越南盾折 1 人民币。
  // 签证台按签证公司名自动带 USD 汇率；酒店成本录越南盾时选用 VND 汇率行。折算值当场固化在业务单据上，
  // 之后改汇率表绝不追溯已入账的旧单据。读写都放开到 ADMIN/STAFF：签证岗要读当日汇率，财务岗要维护。
  // 路径：新前端走 /fx-rates*；/usd-fx-rates* 保留为 USD 别名（supplier = 汇率名称）。
  const fxCurrency = z.enum(FX_CURRENCIES);
  const fxRateUpsertSchema = z.object({
    name: fxNameStr.nullable().optional(),
    /** 旧字段名（USD 别名路径），等价 name */
    supplier: fxNameStr.nullable().optional(),
    currency: fxCurrency.default('USD'),
    effectiveFrom: dateStr,
    // VND 记法是「多少越南盾折 1 人民币」（3740 量级），上限放到百万
    rate: z.number().positive().max(1_000_000),
    note: z.string().max(200).nullable().optional(),
  });

  for (const prefix of ['/fx-rates', '/usd-fx-rates'] as const) {
    app.get(prefix, requireAdminOrStaff, async () => {
      const rates = await listFxRates();
      return { rates };
    });

    /** 汇率名称候选（按币种）：USD = 签证供应商候选；VND = 酒店/车队越南盾建议项；都并上表里已有名称。 */
    app.get(`${prefix}/name-options`, requireAdminOrStaff, async () => {
      const options = await listFxNameOptions();
      return { options };
    });

    /** 旧接口：汇率表「签证公司」输入候选（产品供应商 ∪ 任务签证公司，去重）。 */
    app.get(`${prefix}/supplier-options`, requireAdminOrStaff, async () => {
      const suppliers = await listFxSupplierOptions();
      return { suppliers };
    });

    /**
     * 取某名称某日生效的汇率：先该名称 ≤date 的最新一条，没有回落同币种通用行；都没有 → { rate: null }，
     * 前端据此让用户手填。name/supplier 省略/空 = 只看通用行；currency 缺省 USD。
     */
    app.get(`${prefix}/effective`, requireAdminOrStaff, async (req) => {
      const q = z
        .object({
          date: dateStr,
          currency: fxCurrency.default('USD'),
          name: fxNameStr.optional(),
          supplier: fxNameStr.optional(),
        })
        .parse(req.query);
      const rate = await getFxRate({ date: q.date, currency: q.currency, name: q.name ?? q.supplier ?? null });
      return { rate };
    });

    /** 某币种在目标日每个名称各一条生效汇率（含通用行），供「选用哪条汇率」下拉。 */
    app.get(`${prefix}/effective-list`, requireAdminOrStaff, async (req) => {
      const q = z.object({ date: dateStr, currency: fxCurrency.default('USD') }).parse(req.query);
      const rates = await listEffectiveFxRates(q);
      return { rates };
    });

    app.put(prefix, requireAdminOrStaff, async (req) => {
      const body = fxRateUpsertSchema.parse(req.body);
      const rate = await upsertFxRate(
        {
          name: body.name ?? body.supplier ?? null,
          currency: body.currency,
          effectiveFrom: body.effectiveFrom,
          rate: body.rate,
          note: body.note,
        },
        req.user.sub,
      );
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'UPSERT_FX_RATE',
        targetType: 'SYSTEM',
        targetId: rate.id,
        targetLabel: `汇率 ${rate.currency} ${rate.name ?? '通用'} ${rate.effectiveFrom} 起 ${rate.rate}`,
        after: rate,
      });
      return { rate };
    });
  }
};
