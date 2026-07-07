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
 *   GET    /hotel-control/alerts?days=14           提醒线（超卖加房/富余退房/班次超员）
 *   GET    /hotel-control/occupants?hotelId&date   占房下钻（某酒店某晚，谁占的）
 *   GET    /hotel-control/nightly-remaining?hotelRoomTypeId&checkIn&checkOut  当日余量（分房弹窗徽标）
 *   GET    /hotel-control/export?from&to           房态导出（xlsx，销控矩阵原样导出）
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { buildHotelControlBoardWorkbook, hotelControlExportFilename } from './hotel-control.export.js';
import {
  alertsQuerySchema,
  boardQuerySchema,
  createBlockPeriodBodySchema,
  listBlockPeriodsQuerySchema,
  nightlyRemainingQuerySchema,
  occupantsQuerySchema,
  updateBlockPeriodBodySchema,
} from './hotel-control.schemas.js';
import {
  createBlockPeriod,
  deleteBlockPeriod,
  getAlerts,
  getBoard,
  getForward,
  getNightlyRemainingForRoomType,
  getOccupyingOrders,
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

  // ── 提醒线（按需计算，无 cron）────────────────────────────────────────
  app.get('/alerts', requireStaff, async (req) => {
    const q = alertsQuerySchema.parse(req.query);
    return getAlerts(q.days);
  });

  // ── 占房下钻（某酒店某晚，谁占的；销控矩阵余量格点击用）──────────────────
  app.get('/occupants', requireStaff, async (req) => {
    const q = occupantsQuerySchema.parse(req.query);
    const occupants = await getOccupyingOrders(q.hotelId, q.date);
    return { occupants };
  });

  // ── 当日余量（给定房型 + 入住区间；分房弹窗徽标用）───────────────────────
  app.get('/nightly-remaining', requireStaff, async (req) => {
    const q = nightlyRemainingQuerySchema.parse(req.query);
    return getNightlyRemainingForRoomType(q.hotelRoomTypeId, q.checkIn, q.checkOut);
  });

  // ── 房态导出（xlsx；销控矩阵原样导出，含「未配包房」标记）────────────────
  app.get('/export', requireStaff, async (req, reply) => {
    const q = boardQuerySchema.parse(req.query);
    const buf = await buildHotelControlBoardWorkbook(q);

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'EXPORT_HOTEL_CONTROL_BOARD',
      targetType: 'PRODUCT',
      targetId: 'hotel-control-board',
      targetLabel: `房控导出 ${q.from}~${q.to}`,
      after: { from: q.from, to: q.to },
    });

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(hotelControlExportFilename(q.from, q.to))}"`,
      )
      .send(buf);
  });
};
