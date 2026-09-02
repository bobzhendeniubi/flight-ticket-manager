/**
 * 套餐改档申请路由。
 *
 * /orders 前缀：提交申请、查看本单申请；
 * /bundle-change-requests 前缀：运营待办队列、确认、驳回。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { BundleChangeRequestsService } from './bundle-change-requests.service.js';
import {
  createBundleChangeRequestBodySchema,
  decideBundleChangeRequestBodySchema,
  listBundleChangeRequestsQuerySchema,
} from './bundle-change-requests.schemas.js';

const service = new BundleChangeRequestsService();

export const orderBundleChangeRequestRoutes: FastifyPluginAsync = async (app) => {
  const requireAgentOrOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT);

  app.post(
    '/:id/bundle-change-requests',
    { preHandler: [app.authenticate, requireAgentOrOps] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = createBundleChangeRequestBodySchema.parse(req.body);
      const request = await service.create({ userId: req.user.sub, role: req.user.role }, id, body);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'BUNDLE_CHANGE_REQUEST_CREATED',
        targetType: 'ORDER',
        targetId: id,
        targetLabel: request.orderNumber ?? undefined,
        after: {
          requestId: request.id,
          agentId: request.agentId,
          fromBundleId: request.fromBundleId,
          fromBundleName: request.fromBundleName,
          fromNights: request.fromNights,
          toBundleId: request.toBundleId,
          toBundleName: request.toBundleName,
          toNights: request.toNights,
          requestedById: request.requestedById,
          note: request.note,
        },
      });
      return reply.status(201).send({ request });
    },
  );

  app.get(
    '/:id/bundle-change-requests',
    { preHandler: [app.authenticate, requireAgentOrOps] },
    async (req) => {
      const { id } = req.params as { id: string };
      return service.listForOrder({ userId: req.user.sub, role: req.user.role }, id);
    },
  );
};

export const bundleChangeRequestRoutes: FastifyPluginAsync = async (app) => {
  const requireOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF);
  const requireAgentOrOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT);

  app.get('/', { preHandler: [app.authenticate, requireAgentOrOps] }, async (req) => {
    const query = listBundleChangeRequestsQuerySchema.parse(req.query);
    return service.list({ userId: req.user.sub, role: req.user.role }, query);
  });

  app.post('/:id/approve', { preHandler: [app.authenticate, requireOps] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = decideBundleChangeRequestBodySchema.parse(req.body);
    const { request, order, diffCny, warnings, changeAudit, audit } = await service.approve(
      { userId: req.user.sub, role: req.user.role },
      id,
      body,
    );
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'BUNDLE_CHANGE_REQUEST_APPROVED',
      targetType: 'ORDER',
      targetId: audit.orderId,
      targetLabel: audit.orderNumber,
      before: { status: 'PENDING' },
      after: {
        requestId: request.id,
        status: request.status,
        fromBundleId: request.fromBundleId,
        toBundleId: request.toBundleId,
        diffCny,
        diffItemId: request.appliedDiffItemId,
        requestedById: audit.requestedById,
        decidedById: request.decidedById,
        decisionNote: request.decisionNote,
        appliedAt: request.appliedAt,
      },
      severity: 'WARNING',
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CHANGE_ORDER_BUNDLE',
      targetType: 'ORDER',
      targetId: audit.orderId,
      targetLabel: changeAudit.orderNumber,
      before: { orderItemId: changeAudit.orderItemId, ...changeAudit.before },
      after: {
        ...changeAudit.after,
        diffCny: changeAudit.diffCny,
        diffItemId: changeAudit.diffItemId,
        pricingSource: changeAudit.pricingSource,
        note: changeAudit.note,
        warnings,
      },
      severity: 'WARNING',
    });
    return { request, order, diffCny, warnings };
  });

  app.post('/:id/reject', { preHandler: [app.authenticate, requireOps] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = decideBundleChangeRequestBodySchema.parse(req.body);
    const { request, audit } = await service.reject(
      { userId: req.user.sub, role: req.user.role },
      id,
      body,
    );
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'BUNDLE_CHANGE_REQUEST_REJECTED',
      targetType: 'ORDER',
      targetId: audit.orderId,
      targetLabel: audit.orderNumber ?? undefined,
      before: { status: 'PENDING' },
      after: {
        requestId: request.id,
        status: request.status,
        fromBundleId: request.fromBundleId,
        toBundleId: request.toBundleId,
        requestedById: audit.requestedById,
        decidedById: request.decidedById,
        decisionNote: request.decisionNote,
      },
      severity: 'WARNING',
    });
    return { request };
  });
};
