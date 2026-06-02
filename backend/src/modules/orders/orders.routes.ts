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
import { InvoiceStatus, UserRole } from '@prisma/client';
import { OrderService, type OrderRequester } from './orders.service.js';
import {
  batchCreateOrdersBodySchema,
  batchUpdateStatusBodySchema,
  createOrderBodySchema,
  listOrdersQuerySchema,
  updateStatusBodySchema,
} from './orders.schemas.js';
import { prisma } from '../../db/prisma.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { computeCancellationQuote } from '../../lib/cancellation.js';
import { buildPnrWorkbook, pnrExportFilename } from './pnr-export.js';
import { buildPassportPhotoZip, passportZipFilename } from './passport-zip.js';
import { buildOrdersBySchedule, ordersExportFilename } from './orders.export.js';

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

  // ── 批量散客建单（后台）─────────────────────────────────────────
  // POST /orders/batch — 选一个航班班次+舱位+共享联系人，名单每位乘客各成一单
  // CUSTOMER 不可用（前台无此入口）；ADMIN/STAFF/AGENT 可用
  app.post(
    '/batch',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      if (req.user.role === UserRole.CUSTOMER) {
        return reply.status(403).send({ error: '客户不可批量建单' });
      }
      const body = batchCreateOrdersBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const result = await service.batchCreateOrders(body, requester);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'BATCH_CREATE_ORDERS',
        targetType: 'ORDER',
        targetId: 'batch',
        targetLabel: `${result.successCount}/${body.passengers.length} 单 · ${body.description}`,
        after: {
          flightScheduleId: body.flightScheduleId,
          flightCabin: body.flightCabin,
          requestedCount: body.passengers.length,
          successCount: result.successCount,
          failureCount: result.failureCount,
        },
        severity: result.failureCount > 0 ? 'WARNING' : 'INFO',
      });
      return reply.status(201).send(result);
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
      const order = await service.updateStatus(id, body.toStatus, requester, body.reason, body.force);
      void writeAudit({
        actor: actorFromRequest(req),
        action: body.force ? 'FORCE_ORDER_STATUS' : 'ADVANCE_ORDER_STATUS',
        targetType: 'ORDER',
        targetId: order.id,
        targetLabel: order.orderNumber,
        after: { toStatus: body.toStatus, reason: body.reason, force: body.force ?? false },
        severity:
          body.force || body.toStatus === 'CANCELLED' || body.toStatus === 'REFUNDED' ? 'WARNING' : 'INFO',
      });
      return { order };
    },
  );

  // ── 批量状态流转 ────────────────────────────────────────────────
  // POST /orders/batch-status — ADMIN/STAFF 在订单管理页一次改多条
  app.post(
    '/batch-status',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const role = req.user.role;
      if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
        return reply.status(403).send({ error: '仅管理员可批量改状态' });
      }
      const body = batchUpdateStatusBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, role);
      const result = await service.batchUpdateStatus(
        body.ids,
        body.toStatus,
        requester,
        body.reason,
        body.force,
      );
      void writeAudit({
        actor: actorFromRequest(req),
        action: body.force ? 'BATCH_FORCE_ORDER_STATUS' : 'BATCH_ADVANCE_ORDER_STATUS',
        targetType: 'ORDER',
        targetId: 'batch',
        targetLabel: `${result.successCount}/${body.ids.length} orders → ${body.toStatus}`,
        after: {
          toStatus: body.toStatus,
          requestedCount: body.ids.length,
          successCount: result.successCount,
          failureCount: result.failureCount,
          force: body.force ?? false,
          reason: body.reason,
        },
        severity: result.failureCount > 0 || body.force ? 'WARNING' : 'INFO',
      });
      return result;
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

  // ── 一键导出 PNR Excel（航司提交格式）──
  // GET /orders/:id/pnr-export — ADMIN/STAFF/AGENT 可下载
  app.get('/:id/pnr-export', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const requester = await buildRequester(req.user.sub, req.user.role);
    // service.getOrder 已含 RBAC（CUSTOMER 只能看自己；AGENT 看自己 + 下级；ADMIN/STAFF 看全部）
    const order = await service.getOrder(id, requester);
    const passengers = await prisma.passenger.findMany({ where: { orderId: id } });
    const buf = await buildPnrWorkbook({ orderNumber: order.orderNumber, passengers });

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'EXPORT_PNR',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: order.orderNumber,
      after: { passengerCount: passengers.length },
    });

    reply
      .header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(pnrExportFilename(order.orderNumber))}"`,
      )
      .send(buf);
  });

  // ── 整班机订单导出（ops 用，不含成本）──
  // GET /orders/export-by-schedule?scheduleId=... — ADMIN/STAFF only
  // 代理不能跨代理看订单，所以 AGENT 不放行；客户更不行
  app.get(
    '/export-by-schedule',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const query = z
        .object({ scheduleId: z.string().min(1, 'scheduleId 必填') })
        .parse(req.query);

      // 取班次基本信息用于文件名 + 校验存在
      const schedule = await prisma.flightSchedule.findUnique({
        where: { id: query.scheduleId },
        include: { flight: { select: { flightNumber: true } } },
      });
      if (!schedule) {
        return reply.status(404).send({ error: '班次不存在' });
      }

      const departureDate = `${schedule.departureTime.getUTCFullYear()}-${String(
        schedule.departureTime.getUTCMonth() + 1,
      ).padStart(2, '0')}-${String(schedule.departureTime.getUTCDate()).padStart(2, '0')}`;
      const flightNumber = schedule.flight.flightNumber;

      const buf = await buildOrdersBySchedule(query.scheduleId);

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'EXPORT_ORDERS_BY_SCHEDULE',
        // schema.AuditTargetType 没有 FLIGHT_SCHEDULE；用 FLIGHT + scheduleId 已经足够定位
        targetType: 'FLIGHT',
        targetId: query.scheduleId,
        targetLabel: `${flightNumber} · ${departureDate}`,
        after: { scheduleId: query.scheduleId, flightNumber, departureDate },
      });

      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(
            ordersExportFilename(query.scheduleId, { flightNumber, departureDate }),
          )}"`,
        )
        .send(buf);
    },
  );

  // ── 一键打包护照图片 zip ──
  // GET /orders/:id/passport-photos.zip
  app.get('/:id/passport-photos.zip', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const requester = await buildRequester(req.user.sub, req.user.role);
    const order = await service.getOrder(id, requester);
    const passengers = await prisma.passenger.findMany({ where: { orderId: id } });
    const zipBuf = await buildPassportPhotoZip({ orderNumber: order.orderNumber, passengers });

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DOWNLOAD_PASSPORTS',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: order.orderNumber,
      after: { passengerCount: passengers.length, photoCount: passengers.filter((p) => p.passportPhotoUrl).length },
    });

    reply
      .header('Content-Type', 'application/zip')
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(passportZipFilename(order.orderNumber))}"`,
      )
      .send(zipBuf);
  });

  // ── 认领订单（防漏单）──
  // POST /orders/:id/claim — ADMIN/STAFF 点"接单"
  app.post('/:id/claim', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可认领订单' });
    }
    const { id } = req.params as { id: string };
    const before = await prisma.order.findUnique({
      where: { id },
      select: { claimedById: true, orderNumber: true },
    });
    if (!before) return reply.status(404).send({ error: '订单不存在' });
    const updated = await prisma.order.update({
      where: { id },
      data: { claimedById: req.user.sub, claimedAt: new Date() },
      include: {
        claimedBy: { select: { id: true, email: true, displayName: true } },
      },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CLAIM_ORDER',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: before.orderNumber,
      before: { claimedById: before.claimedById },
      after: { claimedById: req.user.sub },
    });
    return { ok: true, claimedBy: updated.claimedBy };
  });

  // ── 套票分房（管理员设置 / 修改）──
  // PUT /orders/:id/room-assignment
  app.put('/:id/room-assignment', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可分房' });
    }
    const { id } = req.params as { id: string };
    const body = z
      .object({
        roomGroups: z.array(
          z.object({
            id: z.string(),
            hotelName: z.string(),
            roomType: z.string(),
            passengerIds: z.array(z.string()),
            notes: z.string().optional(),
          }),
        ),
      })
      .parse(req.body);
    const before = await prisma.order.findUnique({
      where: { id },
      select: { orderNumber: true, roomAssignment: true },
    });
    if (!before) return reply.status(404).send({ error: '订单不存在' });
    await prisma.order.update({
      where: { id },
      data: { roomAssignment: body as unknown as object },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_ROOM_ASSIGNMENT',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: before.orderNumber,
      before: { roomAssignment: before.roomAssignment },
      after: { roomAssignment: body },
    });
    return { ok: true };
  });

  // ── 更新订单内部备注 / 客户备注 ──
  // PATCH /orders/:id/notes
  app.patch('/:id/notes', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ notes: z.string().max(2000).optional(), internalNotes: z.string().max(2000).optional() })
      .parse(req.body);
    const role = req.user.role;
    // internalNotes 只有 ADMIN/STAFF 可改
    if (body.internalNotes !== undefined && role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可修改内部备注' });
    }
    const before = await prisma.order.findUnique({
      where: { id },
      select: { orderNumber: true, notes: true, internalNotes: true },
    });
    if (!before) return reply.status(404).send({ error: '订单不存在' });
    await prisma.order.update({
      where: { id },
      data: {
        ...(body.notes !== undefined && { notes: body.notes }),
        ...(body.internalNotes !== undefined && { internalNotes: body.internalNotes }),
      },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_ORDER_NOTES',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: before.orderNumber,
      before: { notes: before.notes, internalNotes: before.internalNotes },
      after: body,
    });
    return { ok: true };
  });

  // ── 开票状态（ADMIN/STAFF）──
  // PATCH /orders/:id/invoice-status
  app.patch('/:id/invoice-status', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可修改开票状态' });
    }
    const { id } = req.params as { id: string };
    const body = z.object({ invoiceStatus: z.nativeEnum(InvoiceStatus) }).parse(req.body);
    const result = await service.setInvoiceStatus(id, body.invoiceStatus);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_INVOICE_STATUS',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: result.orderNumber,
      after: { invoiceStatus: body.invoiceStatus },
    });
    return result;
  });
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
