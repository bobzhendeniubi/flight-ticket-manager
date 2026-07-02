/**
 * 收款渠道路由 —— 统一收款码 / 收款账户 CRUD（ADMIN/STAFF）。
 *
 * 注册前缀 /payment-channels：
 *   GET    /payment-channels        列表（ADMIN/STAFF）
 *   POST   /payment-channels        新建（ADMIN/STAFF）
 *   PATCH  /payment-channels/:id    编辑（ADMIN/STAFF）
 *   DELETE /payment-channels/:id    删除（ADMIN/STAFF）
 *
 * 前台公开「只读启用中渠道」走 /public/payment-channels（见 public.routes）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { PaymentChannelsService } from './payment-channels.service.js';
import {
  createPaymentChannelSchema,
  updatePaymentChannelSchema,
} from './payment-channels.schemas.js';

export const paymentChannelRoutes: FastifyPluginAsync = async (app) => {
  const service = new PaymentChannelsService();
  const requireAdminOrStaff = app.requireRole(UserRole.ADMIN, UserRole.STAFF);

  // ── 列表 ─────────────────────────────────────────────
  app.get('/', { preHandler: [app.authenticate, requireAdminOrStaff] }, async () => {
    const channels = await service.list();
    return { channels };
  });

  // ── 新建 ─────────────────────────────────────────────
  app.post('/', { preHandler: [app.authenticate, requireAdminOrStaff] }, async (req, reply) => {
    const body = createPaymentChannelSchema.parse(req.body);
    const channel = await service.create(body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_PAYMENT_CHANNEL',
      targetType: 'SYSTEM',
      targetId: channel.id,
      targetLabel: channel.label,
      after: { kind: channel.kind, label: channel.label, isActive: channel.isActive, agentId: channel.agentId },
    });
    return reply.status(201).send({ channel });
  });

  // ── 编辑 ─────────────────────────────────────────────
  app.patch('/:id', { preHandler: [app.authenticate, requireAdminOrStaff] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = updatePaymentChannelSchema.parse(req.body);
    const channel = await service.update(id, body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_PAYMENT_CHANNEL',
      targetType: 'SYSTEM',
      targetId: channel.id,
      targetLabel: channel.label,
      after: { kind: channel.kind, label: channel.label, isActive: channel.isActive, agentId: channel.agentId },
    });
    return { channel };
  });

  // ── 删除 ─────────────────────────────────────────────
  app.delete('/:id', { preHandler: [app.authenticate, requireAdminOrStaff] }, async (req) => {
    const { id } = req.params as { id: string };
    const result = await service.remove(id);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_PAYMENT_CHANNEL',
      targetType: 'SYSTEM',
      targetId: id,
      targetLabel: id,
    });
    return result;
  });
};
