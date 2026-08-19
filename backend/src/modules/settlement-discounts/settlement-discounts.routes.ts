import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import {
  deleteDiscountRuleParamsSchema,
  listDiscountRulesQuerySchema,
  retailQuoteQuerySchema,
  upsertDiscountRulesBodySchema,
} from './settlement-discounts.schemas.js';
import {
  deleteDiscountRule,
  listDiscountRules,
  listDiscountRulesByIds,
  resolveRetailSettlementDiscount,
  upsertDiscountRules,
} from './settlement-discounts.service.js';

export const settlementDiscountRoutes: FastifyPluginAsync = async (app) => {
  const requireStaff = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)],
  };
  const requireAdmin = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)],
  };

  app.get('/', requireStaff, async (req) => {
    const query = listDiscountRulesQuerySchema.parse(req.query);
    return { rules: await listDiscountRules(query) };
  });

  app.put('/batch', requireAdmin, async (req) => {
    const body = upsertDiscountRulesBodySchema.parse(req.body);
    const before = await listDiscountRulesByIds(
      body.rules.flatMap((rule) => (rule.id ? [rule.id] : [])),
    );
    const rules = await upsertDiscountRules(body.rules, req.user.sub);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPSERT_SETTLEMENT_DISCOUNTS',
      targetType: 'PRICING',
      targetLabel: `结算价立减规则（${body.rules.length} 条）`,
      before,
      after: { count: rules.length, rules },
    });
    return { rules };
  });

  // 散客前台展示专用：只返回金额，不暴露规则 id、代理信息或内部备注。
  app.get('/retail-quote', async (req) => {
    const query = retailQuoteQuerySchema.parse(req.query);
    const hit = await resolveRetailSettlementDiscount(
      query.tier,
      query.nights,
      query.departDate,
    );
    return { discountPerPersonCny: hit?.discountPerPersonCny ?? 0 };
  });

  app.delete('/:id', requireAdmin, async (req) => {
    const { id } = deleteDiscountRuleParamsSchema.parse(req.params);
    const removed = await deleteDiscountRule(id);
    if (!removed) throw new NotFoundError('立减规则不存在');
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_SETTLEMENT_DISCOUNT',
      targetType: 'PRICING',
      targetId: id,
      targetLabel: `立减规则 ${removed.kind}/${removed.tier}/${removed.nights}晚/${removed.startDate}至${removed.endDate}`,
      before: removed,
      after: null,
    });
    return { ok: true };
  });
};
