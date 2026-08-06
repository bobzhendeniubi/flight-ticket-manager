/**
 * 机票结算价日历 API — ADMIN/STAFF only（运营维护机票同业结算价；代理/客户不可见，
 * 取价只在下单时服务端查表，绝不接受客户端传入的日历价）。
 *
 * 路由：
 *   GET    /flight-settlement-rates?from&to&flightNumbers   月度网格查询（日期区间 + 可选航班号列表）
 *   PUT    /flight-settlement-rates/batch                   批量 upsert（网格整批保存 / 粘贴块）
 *   DELETE /flight-settlement-rates/:id                     删除一格
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import {
  deleteFlightRateParamsSchema,
  listFlightRatesQuerySchema,
  upsertFlightRatesBodySchema,
} from './flight-settlement-rates.schemas.js';
import {
  deleteFlightRate,
  listFlightRates,
  upsertFlightRates,
} from './flight-settlement-rates.service.js';

export const flightSettlementRateRoutes: FastifyPluginAsync = async (app) => {
  const requireStaff = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)],
  };

  // ── 月度网格查询 ────────────────────────────────────────────────────────
  app.get('/', requireStaff, async (req) => {
    const q = listFlightRatesQuerySchema.parse(req.query);
    const rates = await listFlightRates(q);
    return { rates };
  });

  // ── 批量 upsert（网格整批保存）────────────────────────────────────────────
  app.put('/batch', requireStaff, async (req) => {
    const body = upsertFlightRatesBodySchema.parse(req.body);
    const rates = await upsertFlightRates(body.rates, req.user.sub);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPSERT_FLIGHT_SETTLEMENT_RATES',
      targetType: 'PRICING',
      targetLabel: `机票结算价日历（${body.rates.length} 格）`,
      // 只留摘要 + 前几格样本，避免整批 2000 格塞爆审计 after
      after: {
        count: body.rates.length,
        sample: body.rates.slice(0, 20),
      },
    });
    return { rates };
  });

  // ── 删除一格 ────────────────────────────────────────────────────────────
  app.delete('/:id', requireStaff, async (req) => {
    const { id } = deleteFlightRateParamsSchema.parse(req.params);
    const removed = await deleteFlightRate(id);
    if (!removed) throw new NotFoundError('机票结算价不存在');
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_FLIGHT_SETTLEMENT_RATE',
      targetType: 'PRICING',
      targetId: id,
      targetLabel: `机票结算价 ${removed.flightNumber}/${removed.departDate}`,
      before: removed,
      after: null,
    });
    return { ok: true };
  });
};
