/**
 * 房控 API — ADMIN/STAFF only（酒店切房台账，代理/客户不可见）
 *
 * 路由：
 *   GET    /hotel-control/block-periods?hotelId=   包房周期列表（含酒店名）
 *   POST   /hotel-control/block-periods            新建周期
 *   PATCH  /hotel-control/block-periods/:id        改周期
 *   DELETE /hotel-control/block-periods/:id        删周期
 *   GET    /hotel-control/board?from&to            销控板（按酒店×日期：切/占/余）
 *   GET    /hotel-control/forward?from&to          远期视图（按日期跨酒店合计）
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import {
  boardQuerySchema,
  createBlockPeriodBodySchema,
  listBlockPeriodsQuerySchema,
  updateBlockPeriodBodySchema,
} from './hotel-control.schemas.js';
import {
  createBlockPeriod,
  deleteBlockPeriod,
  getBoard,
  getForward,
  listBlockPeriods,
  updateBlockPeriod,
} from './hotel-control.service.js';

export const hotelControlRoutes: FastifyPluginAsync = async (app) => {
  const requireStaff = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)],
  };

  // ── 包房周期 CRUD ──────────────────────────────────────────────────────
  app.get('/block-periods', requireStaff, async (req) => {
    const q = listBlockPeriodsQuerySchema.parse(req.query);
    const periods = await listBlockPeriods({ hotelId: q.hotelId });
    return { periods };
  });

  app.post('/block-periods', requireStaff, async (req, reply) => {
    const body = createBlockPeriodBodySchema.parse(req.body);
    const period = await createBlockPeriod(body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_HOTEL_BLOCK_PERIOD',
      targetType: 'PRODUCT',
      targetId: body.hotelId,
      targetLabel: `${period.hotelName} ${body.dateFrom}→${body.dateTo}`,
      after: body,
    });
    return reply.status(201).send({ period });
  });

  app.patch('/block-periods/:id', requireStaff, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateBlockPeriodBodySchema.parse(req.body);
    const period = await updateBlockPeriod(id, body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_HOTEL_BLOCK_PERIOD',
      targetType: 'PRODUCT',
      targetId: period.hotelId,
      targetLabel: `${period.hotelName} ${period.dateFrom}→${period.dateTo}`,
      after: body,
    });
    return { period };
  });

  app.delete('/block-periods/:id', requireStaff, async (req) => {
    const { id } = req.params as { id: string };
    const result = await deleteBlockPeriod(id);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_HOTEL_BLOCK_PERIOD',
      targetType: 'PRODUCT',
      targetId: id,
      targetLabel: 'block-period',
      after: null,
    });
    return result;
  });

  // ── 销控板 / 远期视图 ──────────────────────────────────────────────────
  app.get('/board', requireStaff, async (req) => {
    const q = boardQuerySchema.parse(req.query);
    return getBoard(q);
  });

  app.get('/forward', requireStaff, async (req) => {
    const q = boardQuerySchema.parse(req.query);
    return getForward(q);
  });
};
