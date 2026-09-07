/**
 * 改单申请路由。
 *
 * /orders 前缀：单张单提交申请；
 * /order-change-requests 前缀：批量提交、运营待办队列、确认、驳回、批量确认。
 *
 * 权限分工与套餐改档申请一致：提交 = 运营 + 代理；确认 / 驳回 = 只有运营。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { OrderChangeRequestsService } from './order-change-requests.service.js';
import {
  batchApproveOrderChangeRequestBodySchema,
  batchOrderChangeRequestBodySchema,
  createOrderChangeRequestBodySchema,
  decideOrderChangeRequestBodySchema,
  listOrderChangeRequestsQuerySchema,
} from './order-change-requests.schemas.js';

const service = new OrderChangeRequestsService();

export const ORDER_CHANGE_REQUEST_CREATED_ACTION = 'ORDER_CHANGE_REQUEST_CREATED';
export const ORDER_CHANGE_REQUEST_APPROVED_ACTION = 'ORDER_CHANGE_REQUEST_APPROVED';
export const ORDER_CHANGE_REQUEST_REJECTED_ACTION = 'ORDER_CHANGE_REQUEST_REJECTED';

/** 挂在 /orders 前缀下：单张单提交。 */
export const orderChangeRequestOrderRoutes: FastifyPluginAsync = async (app) => {
  const requireAgentOrOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT);

  app.post(
    '/:id/change-requests',
    { preHandler: [app.authenticate, requireAgentOrOps] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = createOrderChangeRequestBodySchema.parse(req.body);
      const request = await service.create({ userId: req.user.sub, role: req.user.role }, id, body);
      void writeAudit({
        actor: actorFromRequest(req),
        action: ORDER_CHANGE_REQUEST_CREATED_ACTION,
        targetType: 'ORDER',
        targetId: id,
        targetLabel: request.orderNumber ?? undefined,
        after: {
          requestId: request.id,
          agentId: request.agentId,
          kind: request.kind,
          summary: request.summary,
          payload: request.payload,
          requestedById: request.requestedById,
          note: request.note,
        },
      });
      return reply.status(201).send({ request });
    },
  );
};

/** 挂在 /order-change-requests 前缀下：批量提交 + 运营队列 + 处理。 */
export const orderChangeRequestRoutes: FastifyPluginAsync = async (app) => {
  const requireOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF);
  const requireAgentOrOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT);

  // 批量提交：一批订单同一类改动（只支持改班次 / 签证状态）。
  app.post('/batch', { preHandler: [app.authenticate, requireAgentOrOps] }, async (req) => {
    const body = batchOrderChangeRequestBodySchema.parse(req.body);
    const result = await service.createBatch({ userId: req.user.sub, role: req.user.role }, body);
    for (const row of result.results) {
      if (!row.ok) continue;
      void writeAudit({
        actor: actorFromRequest(req),
        action: ORDER_CHANGE_REQUEST_CREATED_ACTION,
        targetType: 'ORDER',
        targetId: row.orderId,
        targetLabel: row.orderNumber ?? undefined,
        after: {
          requestId: row.requestId,
          batchId: result.batchId,
          kind: body.kind,
          payload: body.payload,
          note: body.note ?? null,
        },
      });
    }
    return result;
  });

  app.get('/', { preHandler: [app.authenticate, requireAgentOrOps] }, async (req) => {
    const query = listOrderChangeRequestsQuerySchema.parse(req.query);
    return service.list({ userId: req.user.sub, role: req.user.role }, query);
  });

  // 待办角标：运营订单页顶栏那颗红点读的就是这个数。
  app.get('/pending-count', { preHandler: [app.authenticate, requireOps] }, async (req) => {
    return service.pendingCount({ userId: req.user.sub, role: req.user.role });
  });

  app.post('/:id/approve', { preHandler: [app.authenticate, requireOps] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = decideOrderChangeRequestBodySchema.parse(req.body ?? {});
    const { request, order, audit } = await service.approve(
      { userId: req.user.sub, role: req.user.role },
      id,
      body,
    );
    void writeAudit({
      actor: actorFromRequest(req),
      action: ORDER_CHANGE_REQUEST_APPROVED_ACTION,
      targetType: 'ORDER',
      targetId: audit.orderId,
      targetLabel: audit.orderNumber ?? undefined,
      before: { status: 'PENDING' },
      after: {
        requestId: request.id,
        status: request.status,
        kind: audit.kind,
        summary: audit.summary,
        payload: request.payload,
        requestedById: audit.requestedById,
        decidedById: request.decidedById,
        decisionNote: request.decisionNote,
        appliedAt: request.appliedAt,
        // 改班次申请的执行方式：纠错（不动钱）还是按售后改期（收改期费、撤立减、推状态）。
        // 同一条申请两种走法差着一笔真金白银，审计里必须看得出来。
        execution: { mode: audit.executionMode ?? 'CORRECTION', feeCny: audit.executionFeeCny ?? 0 },
      },
      severity: 'WARNING',
    });
    return { request, order };
  });

  app.post('/:id/reject', { preHandler: [app.authenticate, requireOps] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = decideOrderChangeRequestBodySchema.parse(req.body ?? {});
    const { request, audit } = await service.reject(
      { userId: req.user.sub, role: req.user.role },
      id,
      body,
    );
    void writeAudit({
      actor: actorFromRequest(req),
      action: ORDER_CHANGE_REQUEST_REJECTED_ACTION,
      targetType: 'ORDER',
      targetId: audit.orderId,
      targetLabel: audit.orderNumber ?? undefined,
      before: { status: 'PENDING' },
      after: {
        requestId: request.id,
        status: request.status,
        kind: audit.kind,
        summary: audit.summary,
        requestedById: audit.requestedById,
        decidedById: request.decidedById,
        decisionNote: request.decisionNote,
      },
      severity: 'WARNING',
    });
    return { request };
  });

  // 批量确认：逐条串行执行，成功的各写一条审计，失败的把原因回给前端逐条显示。
  app.post('/batch-approve', { preHandler: [app.authenticate, requireOps] }, async (req) => {
    const body = batchApproveOrderChangeRequestBodySchema.parse(req.body);
    const { approved, failed, results, approvedRequests } = await service.batchApprove(
      { userId: req.user.sub, role: req.user.role },
      body,
    );
    for (const { request, audit } of approvedRequests) {
      void writeAudit({
        actor: actorFromRequest(req),
        action: ORDER_CHANGE_REQUEST_APPROVED_ACTION,
        targetType: 'ORDER',
        targetId: audit.orderId,
        targetLabel: audit.orderNumber ?? undefined,
        before: { status: 'PENDING' },
        after: {
          requestId: request.id,
          status: request.status,
          kind: audit.kind,
          summary: audit.summary,
          payload: request.payload,
          requestedById: audit.requestedById,
          decidedById: request.decidedById,
          appliedAt: request.appliedAt,
          // 批量确认没有执行方式入口，一律纠错执行（不动钱）。
          execution: { mode: audit.executionMode ?? 'CORRECTION', feeCny: audit.executionFeeCny ?? 0 },
          batchApprove: true,
        },
        severity: 'WARNING',
      });
    }
    return { approved, failed, results };
  });
};
