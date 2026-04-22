/**
 * 履约任务 API（ADMIN/STAFF）
 *
 * GET  /fulfillment-tasks            列表（按 order/status/type 过滤）
 * GET  /fulfillment-tasks/by-order/:orderId   某订单的全部任务
 * PATCH /fulfillment-tasks/:id       更新状态/PNR/确认号/司机等
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { FulfillmentService } from './fulfillment.service.js';
import { listFulfillmentQuerySchema, updateFulfillmentBodySchema } from './fulfillment.schemas.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';

export const fulfillmentRoutes: FastifyPluginAsync = async (app) => {
  const service = new FulfillmentService();
  const pre = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };

  app.get('/', pre, async (req) => {
    const q = listFulfillmentQuerySchema.parse(req.query);
    return service.list(q);
  });

  app.get('/by-order/:orderId', pre, async (req) => {
    const { orderId } = req.params as { orderId: string };
    const tasks = await service.listByOrder(orderId);
    return { tasks };
  });

  app.patch('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateFulfillmentBodySchema.parse(req.body);
    const task = await service.update(id, body);

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_FULFILLMENT_TASK',
      targetType: 'ORDER',
      targetId: task.order.id,
      targetLabel: `${task.order.orderNumber} / ${task.type}`,
      after: { status: task.status, data: task.data, notes: task.notes },
      severity: body.status === 'FAILED' ? 'WARNING' : 'INFO',
    });

    return { task };
  });
};
