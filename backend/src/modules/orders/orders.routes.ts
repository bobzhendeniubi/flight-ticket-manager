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
import { InvoiceStatus, Prisma, UserRole } from '@prisma/client';
import { OrderService, type OrderRequester } from './orders.service.js';
import {
  batchCreateOrdersBodySchema,
  batchUpdateStatusBodySchema,
  createOrderBodySchema,
  exportRoomAllocationQuerySchema,
  exportTemplatesQuerySchema,
  listOrdersQuerySchema,
  orderIdsQuerySchema,
  orderStructuredNotesShape,
  publicOrderLookupQuerySchema,
  quoteOrderBodySchema,
  rescheduleOrderBodySchema,
  swapItemHotelBodySchema,
  swapPassengerBodySchema,
  updateItemSettlementPriceBodySchema,
  updateStatusBodySchema,
  visaBundleQuerySchema,
} from './orders.schemas.js';
import { prisma } from '../../db/prisma.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { computeCancellationQuote } from '../../lib/cancellation.js';
import { BadRequestError } from '../../lib/errors.js';
import { buildPnrWorkbook, pnrExportFilename } from './pnr-export.js';
import { buildPassportPhotoZip, passportZipFilename } from './passport-zip.js';
import { buildOrdersBySchedule, ordersExportFilename } from './orders.export.js';
import {
  buildOrderTemplateExportWorkbook,
  ORDER_TEMPLATE_LABEL,
  orderTemplateExportFilename,
} from './orders.export-templates.js';
import {
  buildRoomAllocationWorkbook,
  roomAllocationExportFilename,
  roomAllocationExportFilenameByDepart,
} from './orders.export-room-allocation.js';
import {
  buildVisaBundleZip,
  visaBundleZipFilename,
} from './orders.export-visa-bundle.js';
import {
  buildMasterExportWorkbook,
  masterExportFilename,
} from './orders.export-master.js';
import {
  buildRosterTemplateWorkbook,
  parseRosterXlsx,
  rosterTemplateFilename,
} from './roster.js';

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const service = new OrderService();

  // ── 下单（登录可选：登录用户绑 userId/代理；游客需 guestContact）────────
  app.post(
    '/',
    {
      preHandler: [app.optionalAuthenticate],
      // 多人团每位乘客可带一张护照图（data-URL），全局 8MB 上限对 9 人团不够 → 单路由放宽到 25MB
      bodyLimit: 25 * 1024 * 1024,
    },
    async (req, reply) => {
      const body = createOrderBodySchema.parse(req.body);
      // req.user 由 optionalAuthenticate 在带有效 token 时设置；否则为 undefined（游客）
      const isLoggedIn = Boolean(req.user);
      let order;
      if (isLoggedIn) {
        const requester = await buildRequester(req.user.sub, req.user.role);
        order = await service.createOrder(body, requester);
      } else {
        if (!body.guestContact) {
          return reply.status(400).send({ error: '游客下单需填写联系人姓名与手机号（guestContact）' });
        }
        order = await service.createOrder(body, { guest: body.guestContact });
      }
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'CREATE_ORDER',
        targetType: 'ORDER',
        targetId: order.id,
        targetLabel: order.orderNumber,
        after: {
          total: order.total.toString(),
          itemCount: order.items.length,
          passengerCount: order.passengers.length,
          guest: !isLoggedIn,
        },
      });
      return reply.status(201).send({ order });
    },
  );

  // ── 录单前试算（quote，只算不落库）— ADMIN/STAFF ──────────────────────
  // POST /orders/quote：body 为 createOrder items 子集，走同一权威定价 priceAndValidateItems，
  // 只算价格、绝不写库/扣座。录单页填完产品/人数即可拿到「系统价」在提交前展示。
  app.post(
    '/quote',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const body = quoteOrderBodySchema.parse(req.body);
      const quote = await service.quoteOrder(body);
      return reply.send(quote);
    },
  );

  // ── 公开订单查询（A4，免登录 + 限流 + 脱敏）────────────────────────
  // GET /orders/lookup?orderNumber=...&phone=...（也接受 &email=）
  // 命中返回脱敏视图；不命中一律 404（不泄露哪个字段错）
  app.get(
    '/lookup',
    {
      config: {
        // 覆盖全局限流：本路由更严（~10 req/min/IP）防枚举订单号
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const query = publicOrderLookupQuerySchema.parse(req.query);
      const masked = await service.lookupOrderPublic(query);
      if (!masked) {
        return reply.status(404).send({ error: '未找到匹配的订单，请核对订单号与联系方式' });
      }
      return { order: masked };
    },
  );

  // ── 批量散客建单（后台）─────────────────────────────────────────
  // POST /orders/batch — 选一个航班班次+舱位+共享联系人，名单每位乘客各成一单
  // CUSTOMER 不可用（前台无此入口）；ADMIN/STAFF/AGENT 可用
  app.post(
    '/batch',
    {
      preHandler: [app.authenticate],
      // 批量散客建单：名单每位乘客各带一张护照图（data-URL），单路由放宽到 25MB 防 413
      bodyLimit: 25 * 1024 * 1024,
    },
    async (req, reply) => {
      if (req.user.role === UserRole.CUSTOMER) {
        return reply.status(403).send({ error: '客户不可批量建单' });
      }
      const body = batchCreateOrdersBodySchema.parse(req.body);
      // 团队议价结算价覆盖机票价：仅 ADMIN/STAFF 可用（AGENT 自助批量建单不得改价）。
      const isOps = req.user.role === UserRole.ADMIN || req.user.role === UserRole.STAFF;
      if (body.settlementPriceCny !== undefined && !isOps) {
        return reply.status(403).send({ error: '仅运营/管理员可指定团队议价结算价' });
      }
      // OTA 手动结算单价：仅 ADMIN/STAFF 可用（AGENT 自助批量建单不得手动定价）。
      if (body.manualUnitPriceCny !== undefined && !isOps) {
        return reply.status(403).send({ error: '仅运营/管理员可手动录入结算单价' });
      }
      // 手动结算单价与团队议价结算价语义冲突（前者保留系统权威价 + 调差，后者直接覆盖机票价）→ 二选一。
      if (body.manualUnitPriceCny !== undefined && body.settlementPriceCny !== undefined) {
        return reply.status(400).send({ error: '结算单价与团队议价结算价二选一，请勿同时填写' });
      }
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
          // 团队议价结算价覆盖（如有）— 审计谁、改成多少、团期备注
          settlementPriceCny: body.settlementPriceCny ?? null,
          // OTA 手动结算单价（如有）— 保留系统权威价 + 差额调整行，此处记录录入的每人结算单价
          manualUnitPriceCny: body.manualUnitPriceCny ?? null,
          priceOverride:
            body.settlementPriceCny !== undefined
              ? 'TEAM_SETTLEMENT'
              : body.manualUnitPriceCny !== undefined
                ? 'OTA_MANUAL'
                : null,
          groupNote: body.groupNote ?? null,
        },
        // 改价是敏感操作 → 提级到 WARNING（便于审计检索）
        severity:
          result.failureCount > 0 ||
          body.settlementPriceCny !== undefined ||
          body.manualUnitPriceCny !== undefined
            ? 'WARNING'
            : 'INFO',
      });
      return reply.status(201).send(result);
    },
  );

  // ── 旅游团名单模版下载 ───────────────────────────────────────────
  // GET /orders/roster/template — ADMIN/STAFF only
  // 导出空白名单模版（姓名 | 护照号 | 出生日期 | 性别），运营把收单群名单转此格式后上传解析。
  app.get(
    '/roster/template',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const buf = await buildRosterTemplateWorkbook();
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'DOWNLOAD_ROSTER_TEMPLATE',
        targetType: 'ORDER',
        targetId: 'roster-template',
        targetLabel: '名单模版',
      });
      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(rosterTemplateFilename())}"`,
        )
        .send(buf);
    },
  );

  // ── 旅游团名单解析 ───────────────────────────────────────────────
  // POST /orders/roster/parse — ADMIN/STAFF only
  // body { fileBase64 }（上传的 .xlsx 名单，base64）→ { rows, warnings }
  // 容错：跳空行 / 容错日期格式 / 单格不可解析只收 warning，不整文件抛错。
  app.post(
    '/roster/parse',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const body = z
        .object({ fileBase64: z.string().min(1, 'fileBase64 必填') })
        .parse(req.body);
      let result;
      try {
        result = await parseRosterXlsx(body.fileBase64);
      } catch {
        // 文件损坏 / 非 xlsx → 400（解析内部的单格错误已被吞成 warning，不会走到这里）
        // 走全局错误处理器，返回和其他接口一致的 {error:{code,message}} 结构，
        // 之前这里直接 reply.send({error:string}) 会被后台前端的 error.message 取值方式吞掉。
        throw new BadRequestError('名单文件无法解析，请确认为有效的 .xlsx 文件');
      }
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'PARSE_ROSTER',
        targetType: 'ORDER',
        targetId: 'roster-parse',
        targetLabel: `名单解析 ${result.rows.length} 行`,
        after: { rowCount: result.rows.length, warningCount: result.warnings.length },
      });
      return result;
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

  // ── 回收站：列出已软删订单（仅 ADMIN）──────────────────────────────
  // GET /orders/deleted?page&pageSize —— 分页列出 deletedAt 非空的订单（订单号/客户/金额/
  //   原状态/删除时间/删除人）。静态路由，Fastify 优先于 /:id 匹配，故不会被参数路由吞掉。
  app.get(
    '/deleted',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const q = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      const requester = await buildRequester(req.user.sub, req.user.role);
      return service.listDeletedOrders(q, requester);
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

  // ── 三模板筛选导出（全岗可用 / 票务专用 / 签证专用）──
  // GET /orders/export-templates?template=full|ticketing|visa + listOrders 同款筛选
  // ADMIN/STAFF only（与 export-by-schedule 一致：代理/客户不放行）
  app.get(
    '/export-templates',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const query = exportTemplatesQuerySchema.parse(req.query);
      const buf = await buildOrderTemplateExportWorkbook(query);

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'EXPORT_ORDER_TEMPLATES',
        targetType: 'ORDER',
        targetId: query.template,
        targetLabel: ORDER_TEMPLATE_LABEL[query.template],
        after: { ...query },
      });

      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(orderTemplateExportFilename(query.template))}"`,
        )
        .send(buf);
    },
  );

  // ── 全岗总表导出（PRIMARY 综合导出：一行/乘客，字段全）──
  // GET /orders/export/master?from=YYYY-MM-DD&to=YYYY-MM-DD&role=all|ticketing|visa
  // 按出发日期区间选单（同整班/全岗口径）；role 缺省=完整全岗表，仅裁与岗位无关的列。
  // ADMIN/STAFF only（与其它导出一致：代理/客户不放行）。
  app.get(
    '/export/master',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const query = z
        .object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD').optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD').optional(),
          role: z.enum(['all', 'ticketing', 'visa']).optional(),
          // 勾选导出：给了就只导这批订单（以 id 集合为准，忽略 from/to）。
          orderIds: orderIdsQuerySchema,
        })
        .parse(req.query);
      const buf = await buildMasterExportWorkbook(query);

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'EXPORT_ORDER_MASTER',
        targetType: 'ORDER',
        targetId: 'master',
        targetLabel: query.orderIds
          ? `全岗总表 · 勾选 ${query.orderIds.length} 条`
          : `全岗总表 ${query.from ?? '全部'} ~ ${query.to ?? query.from ?? '全部'}`,
        after: {
          from: query.from ?? null,
          to: query.to ?? null,
          role: query.role ?? 'all',
          selectedCount: query.orderIds?.length ?? null,
        },
      });

      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(masterExportFilename(query.from, query.to))}"`,
        )
        .send(buf);
    },
  );

  // ── 分房表导出（成都格式：每入住日期一个 sheet，按酒店分组）──
  // GET /orders/export-room-allocation?from&to — 或 ?departDate（ADMIN/STAFF only）
  //   · from/to：按入住日区间选（默认 from=to=今天；跨度上限 14 天，超出 service 抛 400）
  //   · departDate：按出发日选订单，导出其全部入住晚（给了它就优先，忽略 from/to）
  app.get(
    '/export-room-allocation',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const query = exportRoomAllocationQuerySchema.parse(req.query);

      let buf: Buffer;
      let filename: string;
      let auditLabel: string;
      let auditAfter: Record<string, string>;
      if (query.departDate) {
        // 按出发日：选该日出发的订单，导出整段入住晚
        buf = await buildRoomAllocationWorkbook({ departDate: query.departDate });
        filename = roomAllocationExportFilenameByDepart(query.departDate);
        auditLabel = `分房表 出发日 ${query.departDate}`;
        auditAfter = { departDate: query.departDate };
      } else {
        const today = new Date().toISOString().slice(0, 10);
        const from = query.from ?? today;
        const to = query.to ?? from; // 只给 from 时按单日导出
        buf = await buildRoomAllocationWorkbook({ from, to });
        filename = roomAllocationExportFilename(from, to);
        auditLabel = `分房表 ${from} ~ ${to}`;
        auditAfter = { from, to };
      }

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'EXPORT_ROOM_ALLOCATION',
        targetType: 'ORDER',
        targetId: 'room-allocation',
        targetLabel: auditLabel,
        after: auditAfter,
      });

      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(filename)}"`,
        )
        .send(buf);
    },
  );

  // ── 签证资料整日打包 zip（合并签证名单 xlsx + 全部护照图）──
  // GET /orders/visa-bundle.zip?departDate=YYYY-MM-DD（ADMIN/STAFF only）
  // 按出发日选订单（与分房表 departDate 同口径）；一次导出该日全部订单的签证资料。
  app.get(
    '/visa-bundle.zip',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const query = visaBundleQuerySchema.parse(req.query);
      const zipBuf = await buildVisaBundleZip({ departDate: query.departDate });

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'DOWNLOAD_VISA_BUNDLE',
        targetType: 'ORDER',
        targetId: 'visa-bundle',
        targetLabel: `签证资料 出发日 ${query.departDate}`,
        after: { departDate: query.departDate },
      });

      return reply
        .header('Content-Type', 'application/zip')
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(visaBundleZipFilename(query.departDate))}"`,
        )
        .send(zipBuf);
    },
  );

  // ── 一键打包护照图片 zip ──
  // GET /orders/:id/passport-photos.zip
  app.get('/:id/passport-photos.zip', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const requester = await buildRequester(req.user.sub, req.user.role);
    const order = await service.getOrder(id, requester);
    const passengers = await prisma.passenger.findMany({ where: { orderId: id } });
    // 空订单（无出行人）→ 友好 400，避免下载到只有空表的 zip
    if (passengers.length === 0) {
      return reply
        .status(400)
        .send({ error: '该订单暂无出行人信息，无法生成出行人资料表' });
    }
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

  // ── 软删除订单（仅 ADMIN）──
  // DELETE /orders/:id — 软删：从所有列表/导出/统计里消失，数据保留可追溯（审计记录谁删的）。
  //   前置守卫（service.softDeleteOrder）：仍占座的订单拒删（需先取消释放座位），只允许删已释放型
  //   状态（CANCELLED/PAYMENT_TIMEOUT/REFUNDED/FAILED/DRAFT）。删除本身绝不触碰库存/座位账。
  app.delete(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const requester = await buildRequester(req.user.sub, req.user.role);
      const { before, after } = await service.softDeleteOrder(id, requester);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'SOFT_DELETE_ORDER',
        targetType: 'ORDER',
        targetId: before.id,
        targetLabel: before.orderNumber,
        before: { status: before.status, deletedAt: null },
        after: { status: after.status, deletedAt: after.deletedAt },
        severity: 'WARNING',
      });
      return { ok: true, id: after.id, deletedAt: after.deletedAt };
    },
  );

  // POST /orders/:id/restore — 从回收站恢复：deletedAt 置回 null，订单重新可见。
  //   仅 ADMIN；只对已软删的订单生效（未删/不存在 → 404）。软删从不改 status，且回收站里
  //   全是释放型状态，恢复绝不凭空占座（依据见 service.restoreOrder 注释）。审计 RESTORE_ORDER。
  app.post(
    '/:id/restore',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const requester = await buildRequester(req.user.sub, req.user.role);
      const { before, after } = await service.restoreOrder(id, requester);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'RESTORE_ORDER',
        targetType: 'ORDER',
        targetId: before.id,
        targetLabel: before.orderNumber,
        before: { status: before.status, deletedAt: before.deletedAt },
        after: { status: after.status, deletedAt: after.deletedAt },
        severity: 'WARNING',
      });
      return { ok: true, id: after.id, deletedAt: after.deletedAt };
    },
  );

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
            // 半间/拼房：0.5 = 占半间（与他人拼），默认 1 间。Σ roomFraction = 该单实际占房间数。
            // 只允许 0.5 步进（Decimal(4,1)），拒绝脏小数被静默四舍五入；0 间组不入此校验。
            roomFraction: z.number().multipleOf(0.5).min(0.5).max(20).optional(),
          }),
        ),
      })
      .parse(req.body);
    const before = await prisma.order.findUnique({
      where: { id },
      select: { orderNumber: true, roomAssignment: true },
    });
    if (!before) return reply.status(404).send({ error: '订单不存在' });
    // 分房总间数（含 0.5 拼房）→ 写回酒店订单行的 roomsBilled，房控据此按真实间数计（如 7 人 3.5 间）。
    const totalRooms = body.roomGroups.reduce((s, g) => s + (g.roomFraction ?? 1), 0);
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: { roomAssignment: body as unknown as object },
      });
      // 先清空本单所有酒店行的 roomsBilled，避免多酒店行残留旧值导致房控按行 Σ 重复计数。
      await tx.orderItem.updateMany({
        where: { orderId: id, hotelRoomTypeId: { not: null } },
        data: { roomsBilled: null },
      });
      if (totalRooms > 0) {
        // 落到首个带房型的订单行（套餐/酒店行）；多酒店行的复杂分摊本期不处理。
        const hotelItem = await tx.orderItem.findFirst({
          where: { orderId: id, hotelRoomTypeId: { not: null } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (hotelItem) {
          await tx.orderItem.update({
            where: { id: hotelItem.id },
            data: { roomsBilled: totalRooms },
          });
        }
      }
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
      .object({
        notes: z.string().max(2000).optional(),
        internalNotes: z.string().max(2000).optional(),
        // 订单级签证状态 + 结构化备注四栏（运营在已存在的订单上编辑）
        ...orderStructuredNotesShape,
      })
      .parse(req.body);
    const role = req.user.role;
    const isOps = role === UserRole.ADMIN || role === UserRole.STAFF;
    // internalNotes / 签证状态 / 结构化备注四栏 只有 ADMIN/STAFF 可改
    const opsOnlyTouched =
      body.internalNotes !== undefined ||
      body.visaStatus !== undefined ||
      body.noteHotel !== undefined ||
      body.noteVisa !== undefined ||
      body.notePayment !== undefined ||
      body.noteSpecial !== undefined;
    if (opsOnlyTouched && !isOps) {
      return reply.status(403).send({ error: '仅运营/管理员可修改内部备注 / 签证状态 / 结构化备注' });
    }
    const before = await prisma.order.findUnique({
      where: { id },
      select: {
        orderNumber: true,
        notes: true,
        internalNotes: true,
        visaStatus: true,
        noteHotel: true,
        noteVisa: true,
        notePayment: true,
        noteSpecial: true,
      },
    });
    if (!before) return reply.status(404).send({ error: '订单不存在' });
    await prisma.order.update({
      where: { id },
      data: {
        ...(body.notes !== undefined && { notes: body.notes }),
        ...(body.internalNotes !== undefined && { internalNotes: body.internalNotes }),
        ...(body.visaStatus !== undefined && { visaStatus: body.visaStatus }),
        ...(body.noteHotel !== undefined && { noteHotel: body.noteHotel }),
        ...(body.noteVisa !== undefined && { noteVisa: body.noteVisa }),
        ...(body.notePayment !== undefined && { notePayment: body.notePayment }),
        ...(body.noteSpecial !== undefined && { noteSpecial: body.noteSpecial }),
      },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_ORDER_NOTES',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: before.orderNumber,
      before: {
        notes: before.notes,
        internalNotes: before.internalNotes,
        visaStatus: before.visaStatus,
        noteHotel: before.noteHotel,
        noteVisa: before.noteVisa,
        notePayment: before.notePayment,
        noteSpecial: before.noteSpecial,
      },
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

  // ── 六态开票：去程/回程/系统 三个布尔位（ADMIN/STAFF）──
  // PATCH /orders/:id/invoice-flags  body: { outboundInvoiced?, returnInvoiced?, systemInvoiced? }
  // 翻某航段为已开时校验对应班次开票上限（超限 422）；systemInvoiced 不占额度。
  app.patch('/:id/invoice-flags', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可修改开票状态' });
    }
    const { id } = req.params as { id: string };
    const body = z
      .object({
        outboundInvoiced: z.boolean().optional(),
        returnInvoiced: z.boolean().optional(),
        systemInvoiced: z.boolean().optional(),
      })
      .parse(req.body);
    const result = await service.setInvoiceFlags(id, body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_INVOICE_STATUS',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: result.orderNumber,
      after: {
        outboundInvoiced: result.outboundInvoiced,
        returnInvoiced: result.returnInvoiced,
        systemInvoiced: result.systemInvoiced,
      },
    });
    return result;
  });

  // ── 预期到账金额（ADMIN/STAFF；锁定后仅 ADMIN）──
  // PATCH /orders/:id/expected-amount  body: { amountCny: number | null }
  app.patch('/:id/expected-amount', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可修改预期到账金额' });
    }
    const { id } = req.params as { id: string };
    const body = z.object({ amountCny: z.number().nullable() }).parse(req.body);
    const order = await prisma.order.findUnique({
      where: { id },
      select: { id: true, orderNumber: true, expectedAmountLocked: true, expectedAmountCny: true },
    });
    if (!order) return reply.status(404).send({ error: '订单不存在' });
    if (order.expectedAmountLocked && role !== UserRole.ADMIN) {
      return reply.status(403).send({ error: '已锁定，请联系管理员' });
    }
    const updated = await prisma.order.update({
      where: { id },
      data: {
        expectedAmountCny: body.amountCny === null ? null : new Prisma.Decimal(body.amountCny),
      },
      select: { id: true, expectedAmountCny: true, expectedAmountLocked: true },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'SET_EXPECTED_AMOUNT',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: order.orderNumber,
      before: {
        expectedAmountCny: order.expectedAmountCny ? Number(order.expectedAmountCny.toString()) : null,
      },
      after: { expectedAmountCny: body.amountCny },
    });
    return {
      id: updated.id,
      expectedAmountCny:
        updated.expectedAmountCny === null ? null : Number(updated.expectedAmountCny.toString()),
      expectedAmountLocked: updated.expectedAmountLocked,
    };
  });

  // ── 预期到账锁定/解锁（仅 ADMIN）──
  // POST /orders/:id/expected-amount/lock  body: { locked: boolean }
  app.post('/:id/expected-amount/lock', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN) {
      return reply.status(403).send({ error: '仅管理员可锁定/解锁预期到账' });
    }
    const { id } = req.params as { id: string };
    const body = z.object({ locked: z.boolean() }).parse(req.body);
    const order = await prisma.order.findUnique({
      where: { id },
      select: { id: true, orderNumber: true, expectedAmountLocked: true },
    });
    if (!order) return reply.status(404).send({ error: '订单不存在' });
    const updated = await prisma.order.update({
      where: { id },
      data: { expectedAmountLocked: body.locked },
      select: { id: true, expectedAmountCny: true, expectedAmountLocked: true },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: body.locked ? 'LOCK_EXPECTED_AMOUNT' : 'UNLOCK_EXPECTED_AMOUNT',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: order.orderNumber,
      before: { expectedAmountLocked: order.expectedAmountLocked },
      after: { expectedAmountLocked: body.locked },
      severity: 'WARNING',
    });
    return {
      id: updated.id,
      expectedAmountCny:
        updated.expectedAmountCny === null ? null : Number(updated.expectedAmountCny.toString()),
      expectedAmountLocked: updated.expectedAmountLocked,
    };
  });

  // ── 多付存入代理余额（ADMIN/STAFF）──
  // POST /orders/:id/credit-overpay-to-agent
  // 订单多付（paidAmount > total）→ 把多付额转入归属代理的预存余额，订单回压到恰好结清。
  app.post('/:id/credit-overpay-to-agent', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可将多付存入代理余额' });
    }
    const { id } = req.params as { id: string };
    const result = await service.creditOverpayToAgent(id, { userId: req.user.sub, role });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREDIT_OVERPAY_TO_AGENT',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: result.orderNumber,
      after: {
        agentId: result.agentId,
        creditedAmount: result.creditedAmount,
        agentBalanceAfter: result.agentBalanceAfter,
      },
      severity: 'WARNING',
    });
    return result;
  });

  // ── 订单超额转入挂账池（ADMIN/STAFF）──
  // POST /orders/:id/overpay-to-pool
  // 任意订单（游客 OR 代理）多付（paidAmount > total）→ 多付额转入挂账池建一笔 OPEN 进账，
  // 订单回压到恰好结清；财务后续在收款对账台认领/退款。（游客版「存代理余额」。）
  app.post('/:id/overpay-to-pool', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可将订单超额转入挂账池' });
    }
    const { id } = req.params as { id: string };
    const result = await service.overpayToPool(id, { userId: req.user.sub, role });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'ORDER_OVERPAY_TO_POOL',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: result.orderNumber,
      after: {
        movedAmount: result.movedAmount,
        newPaidAmount: result.newPaidAmount,
        receiptId: result.receiptId,
        receiptNo: result.receiptNo,
      },
      severity: 'WARNING',
    });
    return result;
  });

  // ── 用代理余额抵尾款（ADMIN/STAFF）──
  // POST /orders/:id/apply-agent-balance  body: { amount }
  // 从归属代理预存余额扣 amount，记入订单 paidAmount；抵满则订单转 PAID（含佣金/履约）。
  app.post('/:id/apply-agent-balance', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可用代理余额抵尾款' });
    }
    const { id } = req.params as { id: string };
    const body = z.object({ amount: z.number().positive() }).parse(req.body);
    const result = await service.applyAgentBalanceToOrder(id, body.amount, {
      userId: req.user.sub,
      role,
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'APPLY_AGENT_BALANCE',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: result.orderNumber,
      after: {
        agentId: result.agentId,
        appliedAmount: result.appliedAmount,
        fullyPaid: result.fullyPaid,
        status: result.status,
        agentBalanceAfter: result.agentBalanceAfter,
      },
      severity: 'WARNING',
    });
    return result;
  });

  // ── 售后改单：改期（ADMIN/STAFF）──
  // PATCH /orders/:id/reschedule  body: { orderItemId, newScheduleId, newCabin?, feeCny?, feeLabel?, note? }
  // 把某条 FLIGHT 行就地改到新班次/新舱位（座位先放旧再原子拿新，售罄回滚不泄漏），可选加改期费。
  app.patch('/:id/reschedule', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可改期' });
    }
    const { id } = req.params as { id: string };
    const body = rescheduleOrderBodySchema.parse(req.body);
    const { order, audit } = await service.rescheduleOrderItem(id, body, {
      userId: req.user.sub,
      role,
    });
    const fmt = (d: Date | null) => (d ? d.toISOString() : null);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'RESCHEDULE_ORDER_ITEM',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: audit.orderNumber,
      before: {
        orderItemId: audit.orderItemId,
        scheduleId: audit.fromScheduleId,
        cabin: audit.fromCabin,
        departure: fmt(audit.fromDeparture),
      },
      after: {
        scheduleId: audit.toScheduleId,
        cabin: audit.toCabin,
        departure: fmt(audit.toDeparture),
        feeCny: audit.feeCny,
        statusChanged: audit.statusChanged,
        note: body.note,
      },
      severity: 'WARNING',
    });
    return { order };
  });

  // ── B4 改结算价（ADMIN/STAFF）──
  // PATCH /orders/:id/items/:itemId/settlement-price  body: { unitPriceCny, reason? }
  // 建单后订正某条 FLIGHT 行的每张结算价；事务内重算 order.subtotal/total（不走 adjustmentCny）。
  app.patch('/:id/items/:itemId/settlement-price', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可改结算价' });
    }
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = updateItemSettlementPriceBodySchema.parse(req.body);
    const { order, audit } = await service.updateItemSettlementPrice(id, itemId, body, {
      userId: req.user.sub,
      role,
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_ITEM_SETTLEMENT_PRICE',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: audit.orderNumber,
      before: { orderItemId: audit.orderItemId, ...audit.before },
      after: { ...audit.after, reason: audit.reason },
      severity: 'WARNING',
    });
    return { order };
  });

  // ── 售后改单：换人（ADMIN/STAFF）──
  // PATCH /orders/:id/passengers/:passengerId
  //   body: { lastName?, firstName?, fullName?, documentNumber?, dateOfBirth?, gender?,
  //           nationality?, resetInvoice?, resetVisa?, feeCny?, feeLabel?, note? }
  // 就地把出行人换成新人；resetInvoice→开票 NONE、resetVisa→签证任务 PENDING；可选加换人费。
  app.patch('/:id/passengers/:passengerId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可换人' });
    }
    const { id, passengerId } = req.params as { id: string; passengerId: string };
    const body = swapPassengerBodySchema.parse(req.body);
    const { order, audit } = await service.swapPassenger(id, passengerId, body, {
      userId: req.user.sub,
      role,
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'SWAP_ORDER_PASSENGER',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: audit.orderNumber,
      before: { passengerId: audit.passengerId, ...audit.before },
      after: {
        ...audit.after,
        resetInvoice: audit.resetInvoice,
        resetVisa: audit.resetVisa,
        visaTasksReset: audit.visaTasksReset,
        feeCny: audit.feeCny,
        note: body.note,
        // 换人（证件号变化）时清除了旧出行人的护照/签证/出生地信息
        clearedProfile: audit.clearedProfile,
        clearedProfileNote: audit.clearedProfile
          ? `换人：${audit.before.documentNumber || '—'}→${audit.after.documentNumber || '—'}，已清除旧护照/签证信息`
          : undefined,
      },
      severity: 'WARNING',
    });
    return { order };
  });

  // ── 售后改单：换酒店（ADMIN/STAFF）──
  // PATCH /orders/:id/items/:itemId/hotel  body: { newHotelRoomTypeId, feeCny?, feeLabel?, note? }
  // 价格默认冻结（绝不按新房型 basePrice 重算 unitPrice/amount）；只换住哪，可选加/减差价。
  app.patch('/:id/items/:itemId/hotel', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可换酒店' });
    }
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = swapItemHotelBodySchema.parse(req.body);
    const { order, audit } = await service.swapItemHotel(id, itemId, body, {
      userId: req.user.sub,
      role,
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'SWAP_ORDER_ITEM_HOTEL',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: audit.orderNumber,
      before: { orderItemId: audit.orderItemId, ...audit.before },
      after: {
        ...audit.after,
        feeCny: audit.feeCny,
        untrackedNights: audit.untrackedNights,
        note: body.note,
      },
      severity: 'WARNING',
    });
    return { order };
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
