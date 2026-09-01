/**
 * 结算价议价申请路由。
 *
 * 挂在 /orders 前缀（在 app.ts 用 prefix:'/orders' 注册 orderSettlementRequestRoutes）：
 *   POST /orders/:id/settlement-requests   代理（限本单归属代理）或运营提交申请
 *   GET  /orders/:id/settlement-requests   本单全部申请
 *
 * 挂在 /settlement-requests 前缀：
 *   GET  /settlement-requests              待办队列（AGENT 调用只返回自家 + 下级）
 *   POST /settlement-requests/:id/approve  确认（ADMIN/STAFF）→ 走既有调价通道生成差额行
 *   POST /settlement-requests/:id/reject   驳回（ADMIN/STAFF）
 *
 * 提交申请**永远改不动订单金额**；钱只在运营确认那一步、由服务端按既有调价通道动。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { SettlementRequestsService } from './settlement-requests.service.js';
import {
  createSettlementRequestBodySchema,
  decideSettlementRequestBodySchema,
  listSettlementRequestsQuerySchema,
} from './settlement-requests.schemas.js';

const service = new SettlementRequestsService();

// ── 挂在 /orders 前缀 ────────────────────────────────────────────────
export const orderSettlementRequestRoutes: FastifyPluginAsync = async (app) => {
  const requireAgentOrOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT);

  // 提交议价申请
  app.post(
    '/:id/settlement-requests',
    { preHandler: [app.authenticate, requireAgentOrOps] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = createSettlementRequestBodySchema.parse(req.body);
      const request = await service.create({ userId: req.user.sub, role: req.user.role }, id, body);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'SETTLEMENT_REQUEST_CREATED',
        targetType: 'ORDER',
        targetId: id,
        targetLabel: request.orderNumber ?? undefined,
        after: {
          requestId: request.id,
          agentId: request.agentId,
          requestedTotalCny: request.requestedTotalCny,
          systemTotalCny: request.systemTotalCny,
          diffCny: request.diffCny,
          requestedById: request.requestedById,
          note: request.note,
        },
      });
      return reply.status(201).send({ request });
    },
  );

  // 本单全部申请
  app.get(
    '/:id/settlement-requests',
    { preHandler: [app.authenticate, requireAgentOrOps] },
    async (req) => {
      const { id } = req.params as { id: string };
      return service.listForOrder({ userId: req.user.sub, role: req.user.role }, id);
    },
  );
};

// ── 挂在 /settlement-requests 前缀 ───────────────────────────────────
export const settlementRequestRoutes: FastifyPluginAsync = async (app) => {
  const requireOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF);
  const requireAgentOrOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT);

  // 待办队列
  app.get('/', { preHandler: [app.authenticate, requireAgentOrOps] }, async (req) => {
    const query = listSettlementRequestsQuerySchema.parse(req.query);
    return service.list({ userId: req.user.sub, role: req.user.role }, query);
  });

  // 确认 —— 差额行由既有调价通道生成，订单金额只在这一步动
  app.post('/:id/approve', { preHandler: [app.authenticate, requireOps] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = decideSettlementRequestBodySchema.parse(req.body);
    const { request, order, audit } = await service.approve(
      { userId: req.user.sub, role: req.user.role },
      id,
      body,
    );
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'SETTLEMENT_REQUEST_APPROVED',
      targetType: 'ORDER',
      targetId: audit.orderId,
      targetLabel: audit.orderNumber,
      before: { status: 'PENDING', receivableCny: audit.currentTotalCny },
      after: {
        requestId: request.id,
        status: request.status,
        requestedTotalCny: audit.requestedTotalCny,
        currentTotalCny: audit.currentTotalCny,
        diffCny: audit.diffCny,
        requestedById: audit.requestedById,
        decidedById: request.decidedById,
        decisionNote: request.decisionNote,
        itemId: audit.itemId,
      },
      severity: 'WARNING',
    });
    return { request, order };
  });

  // 驳回
  app.post('/:id/reject', { preHandler: [app.authenticate, requireOps] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = decideSettlementRequestBodySchema.parse(req.body);
    const { request, audit } = await service.reject(
      { userId: req.user.sub, role: req.user.role },
      id,
      body,
    );
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'SETTLEMENT_REQUEST_REJECTED',
      targetType: 'ORDER',
      targetId: audit.orderId,
      targetLabel: request.orderNumber ?? undefined,
      before: { status: 'PENDING' },
      after: {
        requestId: request.id,
        status: request.status,
        requestedTotalCny: request.requestedTotalCny,
        currentTotalCny: request.currentTotalCny,
        diffCny: request.diffCny,
        requestedById: audit.requestedById,
        decidedById: request.decidedById,
        decisionNote: request.decisionNote,
      },
      severity: 'WARNING',
    });
    return { request };
  });
};
