/**
 * 财务账本 — ADMIN-only（财务数据敏感，STAFF 不开放）
 *
 * GET /finances/costs  → 返回当前 COSTS_DATA（来自 docs/finances/COSTS.xlsx）
 *
 * 数据更新流程：
 *   1. 编辑 docs/finances/COSTS.xlsx
 *   2. 跑 `python3 scripts/build-presentation/build_costs_json.py` 重新生成 costs-data.ts
 *   3. commit + redeploy backend
 *   4. admin 后台「财务」页自动看到新数据
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { COSTS_DATA } from './costs-data.js';

export const financesRoutes: FastifyPluginAsync = async (app) => {
  const requireAdmin = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)],
  };

  app.get('/costs', requireAdmin, async (req) => {
    // 财务数据查阅记录到审计日志
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'VIEW_FINANCES',
      targetType: 'SYSTEM',
      targetId: 'costs',
      targetLabel: '财务账本',
      after: { asOf: COSTS_DATA.asOf, totalUsd: COSTS_DATA.totalUsd },
    });
    return COSTS_DATA;
  });
};
