/**
 * 旅客管理（ADMIN/STAFF）
 *
 * 基于 SavedPassenger 表，tripCount / lastTripAt 实时从 Passenger 聚合。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { TravelersService } from './travelers.service.js';
import {
  createTravelerBodySchema,
  listTravelersQuerySchema,
  updateTravelerBodySchema,
} from './travelers.schemas.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';

export const travelerRoutes: FastifyPluginAsync = async (app) => {
  const service = new TravelersService();
  const pre = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };

  app.get('/', pre, async (req) => {
    const q = listTravelersQuerySchema.parse(req.query);
    return service.list(q);
  });

  app.get('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const traveler = await service.getById(id);
    return { traveler };
  });

  app.post('/', pre, async (req, reply) => {
    const body = createTravelerBodySchema.parse(req.body);
    const t = await service.create(body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_TRAVELER',
      targetType: 'TRAVELER',
      targetId: t.id,
      targetLabel: t.fullName,
      after: { fullName: t.fullName, documentNumber: t.documentNumber },
    });
    return reply.status(201).send({ traveler: t });
  });

  app.patch('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateTravelerBodySchema.parse(req.body);
    const before = await service.getById(id);
    const t = await service.update(id, body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_TRAVELER',
      targetType: 'TRAVELER',
      targetId: t.id,
      targetLabel: t.fullName,
      before: { fullName: before.fullName, documentNumber: before.documentNumber, phone: before.phone, notes: before.notes },
      after: { fullName: t.fullName, documentNumber: t.documentNumber, phone: t.phone, notes: t.notes },
    });
    return { traveler: t };
  });

  app.delete('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const before = await service.getById(id);
    await service.delete(id);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_TRAVELER',
      targetType: 'TRAVELER',
      targetId: id,
      targetLabel: before.fullName,
      severity: 'WARNING',
      before: { fullName: before.fullName, documentNumber: before.documentNumber },
    });
    return { result: { id } };
  });
};
