/**
 * 结算价日历 API — ADMIN/STAFF only（运营维护同业结算价；代理/客户不可见，取价只在下单时服务端查取）。
 *
 * 路由：
 *   GET    /settlement-rates/routes                         可维护的航线（日历页航线下拉）
 *   GET    /settlement-rates?routeKey&from&to&nights&tier   网格查询（按航线 + 出发日期区间 + 可选晚数/档次）
 *   PUT    /settlement-rates/batch                          批量 upsert（一次提交多格，网格整批保存/粘贴块）
 *   DELETE /settlement-rates/:id                            删除一格
 *
 * routeKey 读写必填（zod 400）：老客户端不传一律拒绝，不默认某条航线。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import {
  deleteRateParamsSchema,
  listRatesQuerySchema,
  upsertRatesBodySchema,
} from './settlement-rates.schemas.js';
import {
  deleteRate,
  listRates,
  listSettlementRoutes,
  upsertRates,
} from './settlement-rates.service.js';

export const settlementRateRoutes: FastifyPluginAsync = async (app) => {
  const requireStaff = {
    preHandler: [app.authenticate, app.requireCapability('settlement_rates.write')],
  };

  // ── 可维护航线 ──────────────────────────────────────────────────────────
  // 日历表 distinct routeKey ∪ 立减规则表 ∪ 活跃套餐派生 ∪ 活跃航班（去程方向）；有价的线排前面。
  app.get('/routes', requireStaff, async () => {
    const routes = await listSettlementRoutes();
    return { routes };
  });

  // ── 网格查询 ────────────────────────────────────────────────────────────
  app.get('/', requireStaff, async (req) => {
    const q = listRatesQuerySchema.parse(req.query);
    const rates = await listRates(q);
    return { rates };
  });

  // ── 批量 upsert（网格整批保存）────────────────────────────────────────────
  app.put('/batch', requireStaff, async (req) => {
    const body = upsertRatesBodySchema.parse(req.body);
    const rates = await upsertRates(body.rates, req.user.sub);
    const routeKeys = [...new Set(body.rates.map((r) => r.routeKey))].sort();
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPSERT_SETTLEMENT_RATES',
      targetType: 'PRICING',
      targetLabel: `结算价日历（${routeKeys.join('、')}，${body.rates.length} 格）`,
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
    const { id } = deleteRateParamsSchema.parse(req.params);
    const removed = await deleteRate(id);
    if (!removed) throw new NotFoundError('结算价不存在');
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_SETTLEMENT_RATE',
      targetType: 'PRICING',
      targetId: id,
      targetLabel: `结算价 ${removed.routeKey}/${removed.tier}/${removed.nights}晚/${removed.departDate}`,
      before: removed,
      after: null,
    });
    return { ok: true };
  });
};
