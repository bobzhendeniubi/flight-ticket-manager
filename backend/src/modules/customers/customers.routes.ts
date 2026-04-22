/**
 * 客户管理（ADMIN/STAFF）
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { CustomersService } from './customers.service.js';
import { listCustomersQuerySchema, updateCustomerBodySchema } from './customers.schemas.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';

export const customerRoutes: FastifyPluginAsync = async (app) => {
  const service = new CustomersService();
  const pre = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };

  app.get('/', pre, async (req) => {
    const q = listCustomersQuerySchema.parse(req.query);
    return service.list(q);
  });

  app.get('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const customer = await service.getById(id);
    return { customer };
  });

  app.patch('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateCustomerBodySchema.parse(req.body);

    const before = await service.getById(id);
    const customer = await service.update(id, body);

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_CUSTOMER',
      targetType: 'CUSTOMER',
      targetId: id,
      targetLabel: customer.displayName ?? customer.email ?? customer.phone ?? id,
      before: { displayName: before.displayName, email: before.email, phone: before.phone, tags: before.profile.tags, notes: before.profile.notes, idNumber: before.profile.idNumber },
      after: { displayName: customer.displayName, email: customer.email, phone: customer.phone, tags: customer.profile.tags, notes: customer.profile.notes, idNumber: customer.profile.idNumber },
    });

    return { customer };
  });
};
