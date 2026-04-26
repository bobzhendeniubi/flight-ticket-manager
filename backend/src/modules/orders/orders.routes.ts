/**
 * 订单路由 — 所有端点都需要登录。
 *
 * POST   /orders               下单（任意登录用户；代理身份自动绑定 agentId）
 * GET    /orders               列表（RBAC 过滤：客户/代理/运营各看见不同范围）
 * GET    /orders/:id           详情
 * PATCH  /orders/:id/status    状态流转（ADMIN/STAFF；客户可取消待支付）
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { OrderService, type OrderRequester } from './orders.service.js';
import {
  createOrderBodySchema,
  listOrdersQuerySchema,
  updateStatusBodySchema,
} from './orders.schemas.js';
import { prisma } from '../../db/prisma.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { computeCancellationQuote } from '../../lib/cancellation.js';

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const service = new OrderService();

  // ── 下单 ────────────────────────────────────────────────────────
  app.post(
    '/',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const body = createOrderBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const order = await service.createOrder(body, requester);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'CREATE_ORDER',
        targetType: 'ORDER',
        targetId: order.id,
        targetLabel: order.orderNumber,
        after: { total: order.total.toString(), itemCount: order.items.length, passengerCount: order.passengers.length },
      });
      return reply.status(201).send({ order });
    },
  );

  // ── 列表 ────────────────────────────────────────────────────────
  app.get(
    '/',
    { preHandler: [app.authenticate] },
    async (req) => {
      const query = listOrdersQuerySchema.parse(req.query);
      const requester = await buildRequester(req.user.sub, req.user.role);
      return service.listOrders(query, requester);
    },
  );

  // ── 详情 ────────────────────────────────────────────────────────
  app.get(
    '/:id',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const requester = await buildRequester(req.user.sub, req.user.role);
      const order = await service.getOrder(id, requester);
      return { order };
    },
  );

  // ── 状态流转 ────────────────────────────────────────────────────
  app.patch(
    '/:id/status',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = updateStatusBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const order = await service.updateStatus(id, body.toStatus, requester, body.reason);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'ADVANCE_ORDER_STATUS',
        targetType: 'ORDER',
        targetId: order.id,
        targetLabel: order.orderNumber,
        after: { toStatus: body.toStatus, reason: body.reason },
        severity: body.toStatus === 'CANCELLED' || body.toStatus === 'REFUNDED' ? 'WARNING' : 'INFO',
      });
      return { order };
    },
  );

  /**
   * GET /orders/:id/refund-quote
   * 预览取消订单的退款明细（只读，不改任何状态）
   * 客户/代理/管理员都能调（service.assertCanView 兜底权限）
   */
  app.get(
    '/:id/refund-quote',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const requester = await buildRequester(req.user.sub, req.user.role);
      // 复用 service 的权限校验：能 getOrder 就能看 quote
      await service.getOrder(id, requester);
      const quote = await computeCancellationQuote(id);
      return { quote };
    },
  );

  /**
   * POST /orders/:id/cancel
   * 客户/代理 主动申请取消 → 创建 Refund(amount=应退) + Order 转 REFUND_REQUESTED
   * ADMIN/STAFF 后续审批（POST /refunds/:id/approve）
   */
  app.post(
    '/:id/cancel',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
      const requester = await buildRequester(req.user.sub, req.user.role);
      const result = await service.requestCancellation(id, body.reason, requester);

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'REQUEST_CANCELLATION',
        targetType: 'ORDER',
        targetId: result.order.id,
        targetLabel: result.order.orderNumber,
        after: {
          totalFee: result.quote.totalFee,
          totalRefund: result.quote.totalRefund,
          reason: body.reason,
          isNew: result.isNew,
        },
        severity: 'WARNING',
      });

      return result;
    },
  );
};

/**
 * 构建 OrderRequester：从 JWT payload 补齐 agentId（如果是 AGENT 角色）。
 */
async function buildRequester(userId: string, role: UserRole): Promise<OrderRequester> {
  let agentId: string | undefined;
  if (role === 'AGENT') {
    const agent = await prisma.agent.findUnique({
      where: { userId },
      select: { id: true },
    });
    agentId = agent?.id;
  }
  return { userId, role, agentId };
}
