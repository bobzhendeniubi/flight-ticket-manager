/**
 * OrderCostItem 路由 — 财务录入的订单杂项成本明细 CRUD
 *
 * 所有端点要求登录 + ADMIN/STAFF。
 * 写操作记审计：targetType=ORDER，targetId/targetLabel 用所属订单。
 *
 * 路径（注册时挂在 /orders 前缀下）：
 *   GET    /orders/:orderId/cost-items
 *   POST   /orders/:orderId/cost-items
 *   PATCH  /orders/cost-items/:id
 *   DELETE /orders/cost-items/:id
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { OrderCostCategory, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import {
  create as createCostItem,
  listByOrder,
  remove as removeCostItem,
  update as updateCostItem,
} from './order-cost-items.service.js';

const categoryEnum = z.nativeEnum(OrderCostCategory);

const createBodySchema = z.object({
  category: categoryEnum,
  amountCny: z.number().finite(),
  note: z.string().max(500).optional().nullable(),
});

const updateBodySchema = z
  .object({
    category: categoryEnum.optional(),
    amountCny: z.number().finite().optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

export const orderCostItemRoutes: FastifyPluginAsync = async (app) => {
  const requireAdminOrStaff = app.requireRole(UserRole.ADMIN, UserRole.STAFF);

  // ── 列表（按订单） ──────────────────────────────────────────────
  app.get(
    '/:orderId/cost-items',
    { preHandler: [app.authenticate, requireAdminOrStaff] },
    async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true },
      });
      if (!order) return reply.status(404).send({ error: '订单不存在' });
      const items = await listByOrder(orderId);
      return { items };
    },
  );

  // ── 新增 ────────────────────────────────────────────────────────
  app.post(
    '/:orderId/cost-items',
    { preHandler: [app.authenticate, requireAdminOrStaff] },
    async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      const body = createBodySchema.parse(req.body);
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, orderNumber: true },
      });
      if (!order) return reply.status(404).send({ error: '订单不存在' });
      const item = await createCostItem(orderId, {
        category: body.category,
        amountCny: body.amountCny,
        note: body.note ?? null,
      });
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'UPDATE_ORDER_COST_ITEM',
        targetType: 'ORDER',
        targetId: orderId,
        targetLabel: order.orderNumber,
        after: {
          op: 'create',
          costItemId: item.id,
          category: item.category,
          amountCny: item.amountCny,
          note: item.note,
        },
      });
      return reply.status(201).send({ item });
    },
  );

  // ── 修改 ────────────────────────────────────────────────────────
  app.patch(
    '/cost-items/:id',
    { preHandler: [app.authenticate, requireAdminOrStaff] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = updateBodySchema.parse(req.body);
      const existing = await prisma.orderCostItem.findUnique({
        where: { id },
        select: { id: true, orderId: true },
      });
      if (!existing) return reply.status(404).send({ error: '成本明细不存在' });
      const order = await prisma.order.findUnique({
        where: { id: existing.orderId },
        select: { orderNumber: true },
      });
      const item = await updateCostItem(id, body);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'UPDATE_ORDER_COST_ITEM',
        targetType: 'ORDER',
        targetId: existing.orderId,
        targetLabel: order?.orderNumber,
        after: {
          op: 'update',
          costItemId: item.id,
          patch: body,
        },
      });
      return { item };
    },
  );

  // ── 删除 ────────────────────────────────────────────────────────
  app.delete(
    '/cost-items/:id',
    { preHandler: [app.authenticate, requireAdminOrStaff] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = await prisma.orderCostItem.findUnique({
        where: { id },
        select: { id: true, orderId: true, category: true, amountCny: true, note: true },
      });
      if (!existing) return reply.status(404).send({ error: '成本明细不存在' });
      const order = await prisma.order.findUnique({
        where: { id: existing.orderId },
        select: { orderNumber: true },
      });
      const result = await removeCostItem(id);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'UPDATE_ORDER_COST_ITEM',
        targetType: 'ORDER',
        targetId: existing.orderId,
        targetLabel: order?.orderNumber,
        after: {
          op: 'delete',
          costItemId: id,
          category: existing.category,
          amountCny: Number(existing.amountCny.toString()),
          note: existing.note,
        },
      });
      return result;
    },
  );
};
