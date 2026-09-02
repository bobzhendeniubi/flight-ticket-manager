/**
 * 订单路由 — 所有端点都需要登录。
 *
 * POST   /orders               下单（任意登录用户；代理身份自动绑定 agentId）
 * GET    /orders               列表（RBAC 过滤：客户/代理/运营各看见不同范围）
 * GET    /orders/:id           详情
 * PATCH  /orders/:id/status    状态流转（ADMIN/STAFF；客户可取消待支付）
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { localDateISO } from '../../lib/flight-time.js';
import { env } from '../../config/env.js';
import { z } from 'zod';
import { OrderItemKind, Prisma, UserRole, type Passenger } from '@prisma/client';
import {
  buildStayNightDates,
  FULFILLMENT_TERMINATING_STATUSES,
  OrderService,
  resolveOrderAgentId,
  syncVisaTasksForOrder,
  type OrderRequester,
} from './orders.service.js';
import { isVisaContradiction, VISA_CONTRADICTION_MESSAGE } from './visa-need.js';
import { assertHotelPhysicalFitWithinTx } from '../hotel-control/hotel-control.service.js';
import {
  batchCreateOrdersBodySchema,
  batchRescheduleBodySchema,
  batchSettlementLockBodySchema,
  batchSetInvoiceFlagsBodySchema,
  batchUpdateStatusBodySchema,
  addGroundItemBodySchema,
  changeOrderAgentBodySchema,
  changeOrderBundleBodySchema,
  changeRequestBodySchema,
  createOrderBodySchema,
  orderPriceAdjustmentBodySchema,
  PRICE_ADJUSTMENT_REASON_LABEL,
  roomSupplementBodySchema,
  exportMasterQuerySchema,
  exportRoomAllocationQuerySchema,
  exportTemplatesQuerySchema,
  listOrdersQuerySchema,
  orderIdsQuerySchema,
  orderStructuredNotesShape,
  publicOrderLookupQuerySchema,
  quoteOrderBodySchema,
  rescheduleOrderBodySchema,
  reschedulePassengersBodySchema,
  upgradeItemCabinBodySchema,
  resolvePassengerPatchChannel,
  selfUpdatePassengerBodySchema,
  rescheduleItemHotelBodySchema,
  splitOrderBodySchema,
  splitOrderPreviewBodySchema,
  cancelLegBodySchema,
  cancelLegPreviewBodySchema,
  noShowBodySchema,
  noShowPreviewBodySchema,
  restoreReturnLegBodySchema,
  splitRoomGroupBodySchema,
  swapRefundBodySchema,
  updateSwapReplacementOrderBodySchema,
  swapItemHotelBodySchema,
  swapPassengerBodySchema,
  setPassengerVisaExemptBodySchema,
  updateItemSettlementPriceBodySchema,
  updatePassengerVisaDatesBodySchema,
  updateStatusBodySchema,
  visaBundleBodySchema,
} from './orders.schemas.js';
import { renderItineraryPdf } from '../../lib/itinerary-pdf.js';
import { prisma } from '../../db/prisma.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { businessDateISO } from '../../lib/business-time.js';
import { computeCancellationQuote } from '../../lib/cancellation.js';
import { BadRequestError } from '../../lib/errors.js';
import { buildPnrWorkbook, pnrExportFilename, earliestFlightDeparture } from './pnr-export.js';
import {
  buildPassportPhotoZip,
  passportZipFilename,
  type PassportZipScope,
} from './passport-zip.js';
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
  buildVisaRosterXlsx,
  visaRosterXlsxFilename,
  buildVisaPassportsZip,
  visaPassportsZipFilename,
} from './orders.export-visa-bundle.js';
import {
  buildMasterExportWorkbook,
  masterExportFilename,
} from './orders.export-master.js';
import {
  describeOrderFilters,
  serializableOrderFilters,
} from './orders.export-selection.js';
import {
  buildIntakeExportWorkbook,
  intakeExportFilename,
} from './orders.export-intake.js';
import {
  buildRosterTemplateWorkbook,
  parseRosterXlsx,
  rosterTemplateFilename,
} from './roster.js';
import {
  buildOrderImportMatchDeps,
  OrderImportError,
  parseOrderImportXlsx,
  resolveOrderImport,
} from './orders.import.js';

// ── 出纳「预期到账金额」上限（CNY，整单总额）──────────────────────────────
// 取 40_000_000 的依据（非拍脑袋）：
//   1. 物理上限靠不住 —— expectedAmountCny 落 Decimal(12, 2)，DB 侧能存到
//      9,999,999,999.99，超界/三位小数只会在写库那一刻炸成 500，不是校验。
//   2. 不能直接套 SETTLEMENT_PRICE_CAP_CNY（100_000）—— 那是「每人单价」上限，
//      而本字段是「整单总额」，一单可能几十人，套 10 万会误拒正常大团。
//   3. 取订单结构上限：createOrder 的 items ≤ 20 行，每行 quantity ≤ 20 人，
//      每人结算价 ≤ SETTLEMENT_PRICE_CAP_CNY(100_000) → 20 × 20 × 100_000
//      = 40_000_000。即「本系统自己能产生的最大整单总额」都不会被误拒，
//      同时把多打几个 0 / 误按「分」填这类手滑挡在 DB 之外。
export const EXPECTED_AMOUNT_CAP_CNY = 40_000_000;

// 预期到账金额入参：finite（挡 NaN/Infinity）+ 非负 + 最多两位小数（对齐 Decimal(12,2)）+ 上限。
// null = 清空，是合法操作（出纳撤回已填值），放行。
// 权宜：金额 schema 本应在 orders.schemas.ts 统一收编（当前该文件有并行改动，先就近具名导出避免冲突）。
export const expectedAmountBodySchema = z.object({
  amountCny: z
    .number()
    .finite('预期到账金额必须为有效数字')
    .nonnegative('预期到账金额不能为负数')
    .max(EXPECTED_AMOUNT_CAP_CNY, `预期到账金额超出上限（¥${EXPECTED_AMOUNT_CAP_CNY}）`)
    // 两位小数校验用 toFixed 回比，避开 multipleOf(0.01) 的浮点余数误判（如 1234.56 % 0.01 ≠ 0）。
    .refine((v) => Number(v.toFixed(2)) === v, { message: '预期到账金额最多两位小数（元）' })
    .nullable(),
});

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

  // ── 录单前试算（quote，只算不落库）— ADMIN/STAFF/AGENT ────────────────
  // POST /orders/quote：body 为 createOrder items 子集，走同一权威定价 priceAndValidateItems，
  // 只算价格、绝不写库/扣座。录单页填完产品/人数即可拿到「系统价」在提交前展示。
  // AGENT 只能试算自己家的结算价：归属经 resolveOrderAgentId 收口（AGENT 无视 body.agentId
  // 强制取本人），与 createOrder 完全同口径，杜绝传别家 agentId 窥探他人结算价。
  // 指定酒店星级闸同样在此生效（对 AGENT 硬拒 / 对运营不拦）——见 service.quoteOrder。
  app.post(
    '/quote',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)] },
    async (req, reply) => {
      const body = quoteOrderBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const scopedAgentId = await resolveOrderAgentId(requester, body.agentId);
      // 传身份：指定酒店星级闸对 AGENT 当场拒（与 createOrder 同一句文案），
      // 免得代理选了不匹配档次的酒店照样报价成功、提交才 400。ADMIN/STAFF 试算不拦。
      const quote = await service.quoteOrder(
        { ...body, agentId: scopedAgentId ?? undefined },
        { role: req.user.role },
      );
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
      const hasDiscount = body.discountPerPersonCny !== undefined && body.discountPerPersonCny > 0;
      if (body.manualUnitPriceCny !== undefined && hasDiscount) {
        return reply.status(400).send({ error: '优惠与手动结算单价二选一' });
      }
      if (body.settlementPriceCny !== undefined && hasDiscount) {
        return reply.status(400).send({ error: '优惠与团队议价结算价二选一' });
      }
      // 团队议价结算价覆盖机票价：仅 ADMIN/STAFF 可用（AGENT 自助批量建单不得改价）。
      const isOps = req.user.role === UserRole.ADMIN || req.user.role === UserRole.STAFF;
      if (body.settlementPriceCny !== undefined && !isOps) {
        return reply.status(403).send({ error: '仅运营/管理员可指定团队议价结算价' });
      }
      // OTA 手动结算单价：仅 ADMIN/STAFF 可用（AGENT 自助批量建单不得手动定价）。
      if (body.manualUnitPriceCny !== undefined && !isOps) {
        return reply.status(403).send({ error: '仅运营/管理员可手动录入结算单价' });
      }
      if (hasDiscount && !isOps) {
        return reply.status(403).send({ error: '仅运营/管理员可录入优惠' });
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
          discountPerPersonCny: hasDiscount ? body.discountPerPersonCny : null,
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
          body.manualUnitPriceCny !== undefined ||
          hasDiscount
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

  // ── 旧系统表格导入解析（批量录单预览）────────────────────────────
  // POST /orders/batch-import/parse — ADMIN/STAFF/AGENT
  // body { fileBase64 }（旧系统单程 16 列 / 往返 18 列模版 .xlsx）
  //   → { template, rows（行级解析+班次/代理匹配+错误）, warnings, batch（首行汇总） }
  // 纯解析预览，不落库；创建仍走 POST /orders/batch。
  // 代理身份上传：结算价格 / 选择代理两列忽略并提示（结算价由系统按代理价计算，归属自动为本代理）。
  app.post(
    '/batch-import/parse',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)] },
    async (req) => {
      const body = z
        .object({ fileBase64: z.string().min(1, 'fileBase64 必填') })
        .parse(req.body);
      const isOpsUpload = req.user.role === UserRole.ADMIN || req.user.role === UserRole.STAFF;
      let parsed;
      try {
        parsed = await parseOrderImportXlsx(body.fileBase64);
      } catch (e) {
        // 坏文件/超大/.xls/表头对不上 → 400 带中文原因（绝不 500）
        throw new BadRequestError(
          e instanceof OrderImportError
            ? e.message
            : '表格文件无法解析，请确认为有效的 .xlsx 文件（旧 .xls 请先另存为 .xlsx）',
        );
      }
      const result = await resolveOrderImport(parsed, buildOrderImportMatchDeps(), {
        includeSettlement: isOpsUpload,
        includeAgent: isOpsUpload,
      });
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'PARSE_ORDER_IMPORT',
        targetType: 'ORDER',
        targetId: 'batch-import-parse',
        targetLabel: `表格导入解析 ${result.rows.length} 行（${result.template === 'ROUNDTRIP' ? '往返' : '单程'}模版）`,
        after: {
          rowCount: result.rows.length,
          errorRowCount: result.rows.filter((r) => r.errors.length > 0).length,
          warningCount: result.warnings.length,
        },
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

  // ── 代理分销统计（列表卡片）──────────────────────────────────────
  // GET /orders/agent-stats + listOrders 同款筛选（page/pageSize 忽略）
  //   → { direct: {orders, revenueCny}, agents: [{agentId, agentName, orders, revenueCny}] }
  // 卡片此前在前端按「已加载的那一页」现算：列表一次只拉最新 200 单，于是排行榜其实只是
  // 最近 200 单里的排名，稍早成交的代理直接消失。真分页后改由后端在**全量**上聚合。
  // 权限与列表同（authenticate + 同一 requester 构建），AGENT 只看得到自己 + 下级的聚合。
  // 静态路由，Fastify 优先于 /:id 匹配，不会被参数路由吞掉。
  app.get(
    '/agent-stats',
    { preHandler: [app.authenticate] },
    async (req) => {
      const query = listOrdersQuerySchema.parse(req.query);
      const requester = await buildRequester(req.user.sub, req.user.role);
      return service.getAgentStats(query, requester);
    },
  );

  // ── 回收站：列出已软删订单（ADMIN + STAFF）────────────────────────
  // GET /orders/deleted?page&pageSize&search —— 分页列出 deletedAt 非空的订单（订单号/客户/金额/
  //   原状态/删除时间/删除人）。search 模糊匹配订单号/联系人名/乘客姓名（含中文名）。
  //   静态路由，Fastify 优先于 /:id 匹配，故不会被参数路由吞掉。
  app.get(
    '/deleted',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const q = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
          search: z.string().trim().min(1).optional(),
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

  /**
   * POST /orders/:id/swap-refund
   * 运营手填换人费发起退款申请；接手订单号只作记录，资金不在订单间转移。
   */
  app.post(
    '/:id/swap-refund',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = swapRefundBodySchema.parse(req.body);
      // 审计的 before.status 取业务方法执行前的快照；实际校验、金额计算和写入仍全部在 service 的事务内完成。
      const before = await prisma.order.findUnique({ where: { id }, select: { status: true } });
      const requester = await buildRequester(req.user.sub, req.user.role);
      const result = await service.swapRefund(id, body, requester);

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'SWAP_REFUND_ORDER',
        targetType: 'ORDER',
        targetId: result.order.id,
        targetLabel: result.order.orderNumber,
        before: { status: before?.status ?? null, netPaidCny: result.netPaidCny },
        after: {
          swapFeeCny: result.swapFeeCny,
          refundAmountCny: result.refundAmountCny,
          replacementOrderNumber: result.order.swapReplacementOrderNumber ?? null,
          reason: body.reason,
        },
        severity: 'WARNING',
      });

      return result;
    },
  );

  /**
   * PATCH /orders/:id/swap-replacement-order
   * 补填/修改换人退款的接手订单号；只改源单记录，不发生资金动作。
   */
  app.patch(
    '/:id/swap-replacement-order',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = updateSwapReplacementOrderBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const result = await service.updateSwapReplacementOrderNumber(
        id,
        body.replacementOrderNumber,
        requester,
      );

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'UPDATE_SWAP_REPLACEMENT_ORDER',
        targetType: 'ORDER',
        targetId: result.order.id,
        targetLabel: result.order.orderNumber,
        before: { replacementOrderNumber: result.beforeReplacementOrderNumber },
        after: { replacementOrderNumber: result.replacementOrderNumber },
        severity: 'WARNING',
      });

      return { order: result.order };
    },
  );

  /**
   * POST /orders/:id/change-request
   * 前台自助改签申请：订单转 CHANGE_REQUESTED（记 OrderStatusEvent）+ 建 HIGH 优先级
   * 运营待办提醒。仅 PAID/PROCESSING/TICKETED 可申请（否则 409 ORDER_NOT_CHANGEABLE）；
   * 已是 CHANGE_REQUESTED 幂等返回当前订单。归属校验同 getOrder。
   */
  app.post(
    '/:id/change-request',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = changeRequestBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const result = await service.requestChange(id, body.reason, requester);

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'REQUEST_CHANGE',
        targetType: 'ORDER',
        targetId: result.order.id,
        targetLabel: result.order.orderNumber,
        after: { reason: body.reason, idempotent: result.idempotent },
        severity: 'WARNING',
      });

      return { order: result.order };
    },
  );

  /**
   * GET /orders/:id/itinerary.pdf
   * 前台客户下载电子行程单（PDF 附件）。归属校验同 getOrder；订单确认（付款）后可下载
   * （否则 409 ITINERARY_NOT_READY）；无航班行的纯地面单 409 NO_FLIGHT_ITEMS。
   */
  app.get(
    '/:id/itinerary.pdf',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const requester = await buildRequester(req.user.sub, req.user.role);
      const { orderNumber, itinerary } = await service.getOrderItineraryData(id, requester);
      const pdf = await renderItineraryPdf(itinerary);

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'DOWNLOAD_ITINERARY',
        targetType: 'ORDER',
        targetId: id,
        targetLabel: orderNumber,
        after: { flightCount: itinerary.flights.length, passengerCount: itinerary.passengers.length },
      });

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="itinerary-${orderNumber}.pdf"`)
        .send(pdf);
    },
  );

  // ── 一键导出 PNR Excel（航司提交格式）──
  // GET /orders/:id/pnr-export — ADMIN/STAFF/AGENT 可下载
  app.get('/:id/pnr-export', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const requester = await buildRequester(req.user.sub, req.user.role);
    // service.getOrder 已含 RBAC（CUSTOMER 只能看自己；AGENT 看自己 + 下级；ADMIN/STAFF 看全部），
    // 且已按角色脱敏（AGENT/CUSTOMER 侧剥离 passportPhotoUrl 护照大图）。
    const order = await service.getOrder(id, requester);
    // 出行人一律取 getOrder 已脱敏的 order.passengers —— 绝不另起 prisma.passenger.findMany 裸查。
    // 本路由是 authenticate-only（AGENT 可达），裸查会绕开脱敏、把护照大图塞进导出给代理。
    // PNR 25 列（见 pnr-export.ts passengerToRow / PNR_COLUMNS）只读姓名/性别/生日/证件/签证/地址
    // 等文本字段，不含护照大图 → 脱敏结果的字段已够用，无需向 getOrder 额外索要任何字段。
    const passengers = order.passengers as unknown as Passenger[];
    // items 传入用于按「出发日 − 出生日期」自动推 PTC（见 pnr-export.ts derivePtcByAge）
    const buf = await buildPnrWorkbook({ orderNumber: order.orderNumber, passengers, items: order.items });

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
        `attachment; filename="${encodeURIComponent(pnrExportFilename(order.orderNumber, earliestFlightDeparture(order.items)))}"`,
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

      // 出发日按出发地当地时区折算——文件名和审计标签要跟运营在班次日历上看到的日期一致
      const departureDate = localDateISO(schedule.departureTime, schedule.departureTz);
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
  // ADMIN/STAFF + AGENT（0831 代理反馈：导出与列表同权）。AGENT 由服务端强制圈到
  // 自己+下级代理的订单（与 listOrders RBAC 同源），勾选导出同受此闸；客户不放行。
  // 列内容对代理无泄漏：三模板不含订单成本（《全岗可用》成本三列是留空占位）、不含 internalNotes。
  app.get(
    '/export-templates',
    {
      preHandler: [
        app.authenticate,
        app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT),
      ],
    },
    async (req, reply) => {
      const query = exportTemplatesQuerySchema.parse(req.query);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const agentScope = await service.resolveExportAgentScope(requester);
      const buf = await buildOrderTemplateExportWorkbook(query, undefined, { agentScope });

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
  // GET /orders/export/master + listOrders 同款筛选（与三模板导出同名同义）&role=all|ticketing|visa
  // ⚠️ from/to 的语义是**下单时间**（与列表/三模板一致），出行日期用 travelFrom/travelTo。
  //   此前本端点只认 from/to 且语义是出行日期，运营在列表里按下单时间/代理/渠道筛好一批单
  //   再点导出，导出的根本不是那一批。选单走共享 helper（orders.export-selection.ts）。
  // role 缺省=完整全岗表，仅裁与岗位无关的列。
  // ADMIN/STAFF + AGENT（0831 代理反馈：导出与列表同权；客户不放行）。
  // A20 岗位细分（2026-07-20 拍板「全改」）：role 不再单信 query 参数——专岗账号
  //（User.staffRole）被强制裁到本岗模板，改参数也拿不到订单成本/结算价等全岗列：
  //   ADMIN / 通用 STAFF（staffRole=null）→ 尊重 query（现状，可信运营）
  //   VISA_DESK → 强制 'visa'；TICKETING → 强制 'ticketing'
  //   ROOM_CONTROL → 强制 'visa'（总表内金额暴露面最小的模板；房控本职导出在房控模块）
  //   AGENT → 强制 'agent'（全岗列裁掉「订单成本」真实进价）+ 服务端圈到自己+下级代理的订单
  app.get(
    '/export/master',
    {
      preHandler: [
        app.authenticate,
        app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT),
      ],
    },
    async (req, reply) => {
      const query = exportMasterQuerySchema.parse(req.query);
      if (req.user.role === UserRole.STAFF) {
        const me = await prisma.user.findUnique({
          where: { id: req.user.sub },
          select: { staffRole: true },
        });
        const forced =
          me?.staffRole === 'VISA_DESK' || me?.staffRole === 'ROOM_CONTROL'
            ? ('visa' as const)
            : me?.staffRole === 'TICKETING'
              ? ('ticketing' as const)
              : null;
        if (forced) query.role = forced;
      }
      // AGENT：视图强制 'agent'（改 query 参数也无效），数据圈到自己+下级代理（服务端解析）。
      const requester = await buildRequester(req.user.sub, req.user.role);
      const agentScope = await service.resolveExportAgentScope(requester);
      const effectiveRole =
        req.user.role === UserRole.AGENT ? ('agent' as const) : query.role;
      const buf = await buildMasterExportWorkbook({ ...query, role: effectiveRole }, undefined, {
        agentScope,
      });

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'EXPORT_ORDER_MASTER',
        targetType: 'ORDER',
        targetId: 'master',
        targetLabel: query.orderIds
          ? `全岗总表 · 勾选 ${query.orderIds.length} 条`
          : `全岗总表 · ${describeOrderFilters(query)}`,
        // 全部筛选照实留痕：只记 from/to 的话，「这份表到底是按什么条件导的」事后查不出来
        //（尤其 from/to 语义已改为下单时间，出行日期另有 travelFrom/travelTo）。
        after: {
          ...serializableOrderFilters(query),
          role: effectiveRole ?? 'all',
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
          `attachment; filename="${encodeURIComponent(masterExportFilename(query))}"`,
        )
        .send(buf);
    },
  );

  // ── 进单统计导出（公测反馈·票务）──
  // GET /orders/export/intake + listOrders 同款筛选（尤其 from/to 下单时间窗口，可带时间到分钟）
  // 按「出发日期 × 产品/团期」聚合，列：出发日期 / 产品/团期 / 订单数 / 人数，末行总计。
  // ADMIN/STAFF + AGENT（0831 代理反馈：导出与列表同权；纯聚合无敏感列）。
  // AGENT 由服务端圈到自己+下级代理的订单，统计口径=代理自己列表所见；客户不放行。
  app.get(
    '/export/intake',
    {
      preHandler: [
        app.authenticate,
        app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT),
      ],
    },
    async (req, reply) => {
      // 复用 listOrders 的筛选字段（含放宽后的 from/to），保证「导出=列表所见」。
      const query = listOrdersQuerySchema
        .pick({
          status: true,
          agentId: true,
          kind: true,
          search: true,
          from: true,
          to: true,
          travelFrom: true,
          travelTo: true,
          flightNumber: true,
          passengerName: true,
          recordedBy: true,
          invoiceLeg: true,
          invoiced: true,
          visaFulfillmentStatus: true,
          visaRequirement: true,
          tripType: true,
        })
        .extend({ orderIds: orderIdsQuerySchema })
        .parse(req.query);
      const requester = await buildRequester(req.user.sub, req.user.role);
      const agentScope = await service.resolveExportAgentScope(requester);
      const buf = await buildIntakeExportWorkbook(query, undefined, { agentScope });

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'EXPORT_ORDER_INTAKE',
        targetType: 'ORDER',
        targetId: 'intake',
        targetLabel: `进单统计 ${query.from ?? '全部'} ~ ${query.to ?? query.from ?? '全部'}`,
        after: { from: query.from ?? null, to: query.to ?? null },
      });

      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(intakeExportFilename(query.from, query.to))}"`,
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
        // 「今天」按北京业务日取：容器 TZ 是 UTC，北京 0–8 点导出会默认成前一天的分房表
        const today = businessDateISO(new Date());
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

  // ── 签证资料导出：名单表 / 护照包 分开下载（0713 签证岗反馈：合并 zip 多一步解压不方便）──
  // POST /orders/visa-roster.xlsx  body { orderIds: string[] }（ADMIN/STAFF only）
  // 按勾选的订单导出合并签证名单 xlsx（状态不合格/查不到的单静默不计入，仅出合格单）。
  app.post(
    '/visa-roster.xlsx',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const body = visaBundleBodySchema.parse(req.body);
      const xlsxBuf = await buildVisaRosterXlsx(body.orderIds);

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'DOWNLOAD_VISA_ROSTER',
        targetType: 'ORDER',
        targetId: 'visa-roster',
        targetLabel: `签证名单 勾选 ${body.orderIds.length} 单`,
        after: { orderCount: body.orderIds.length },
      });

      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(visaRosterXlsxFilename(body.orderIds.length))}"`,
        )
        .send(xlsxBuf);
    },
  );

  // POST /orders/visa-passports.zip  body { orderIds: string[] }（ADMIN/STAFF only）
  // 按勾选的订单导出全部乘客护照图 zip（不含名单 xlsx）；状态不合格/查不到的单及缺图明细见 zip 内 README。
  app.post(
    '/visa-passports.zip',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const body = visaBundleBodySchema.parse(req.body);
      const zipBuf = await buildVisaPassportsZip(body.orderIds);

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'DOWNLOAD_VISA_PASSPORTS',
        targetType: 'ORDER',
        targetId: 'visa-passports',
        targetLabel: `签证护照 勾选 ${body.orderIds.length} 单`,
        after: { orderCount: body.orderIds.length },
      });

      return reply
        .header('Content-Type', 'application/zip')
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(visaPassportsZipFilename(body.orderIds.length))}"`,
        )
        .send(zipBuf);
    },
  );

  // ── 一键打包护照图片 zip ──
  // GET /orders/:id/passport-photos.zip — ADMIN/STAFF only
  // 这个包的正身就是**护照原图**（passport-zip.ts 逐乘客写入 fetchPhoto(p.passportPhotoUrl)），
  // 与上面勾选批量导出的 /visa-passports.zip 同一性质 → 同一道角色闸：签证岗/操作岗内部资料，
  // 代理与客户一律不放行（代理拿到全套护照原图 = 客资无门槛外流）。
  app.get(
    '/:id/passport-photos.zip',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      // 包类型按**入口**声明，不按角色（签证岗/操作岗同为 STAFF，服务端分不出谁是谁）：
      // 签证台传 scope=visa 拿送签包（自备签的人图和表都不含）；订单详情不传 → 'all' 全员资料包。
      // 非法/缺省一律落 'all'，绝不因为参数写错就悄悄少打包人。
      const scope: PassportZipScope =
        (req.query as { scope?: string } | undefined)?.scope === 'visa' ? 'visa' : 'all';
      const requester = await buildRequester(req.user.sub, req.user.role);
      const order = await service.getOrder(id, requester);
      // 出行人一律取 getOrder 已按角色脱敏的 order.passengers —— 绝不另起 prisma.passenger.findMany
      // 裸查（与 pnr-export 同一纪律）。裸查会绕开 orderSerializeRoleCtx 的
      // includePassportPhotos = (ADMIN || STAFF) 口径：上面那道角色闸哪天被放宽，裸查会立刻
      // 把护照大图塞进 zip 交给代理/客户。闸 + 数据源双保险，两处都不给绕。
      const passengers = order.passengers as unknown as Passenger[];
      // 空订单（无出行人）→ 友好 400，避免下载到只有空表的 zip
      if (passengers.length === 0) {
        return reply
          .status(400)
          .send({ error: '该订单暂无出行人信息，无法生成出行人资料表' });
      }
      const zipBuf = await buildPassportPhotoZip({
        orderNumber: order.orderNumber,
        passengers,
        scope,
      });

      void writeAudit({
        actor: actorFromRequest(req),
        action: 'DOWNLOAD_PASSPORTS',
        targetType: 'ORDER',
        targetId: id,
        targetLabel: order.orderNumber,
        after: {
          scope,
          passengerCount: passengers.length,
          photoCount: passengers.filter((p) => p.passportPhotoUrl).length,
        },
      });

      reply
        .header('Content-Type', 'application/zip')
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(passportZipFilename(order.orderNumber))}"`,
        )
        .send(zipBuf);
    },
  );

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

  // ── 软删除订单（ADMIN + STAFF）──
  // DELETE /orders/:id — 软删：从所有列表/导出/统计里消失，数据保留可追溯（审计记录谁删的）。
  //   前置守卫（service.softDeleteOrder）：仍占座的订单拒删（需先取消释放座位），只允许删已释放型
  //   状态（CANCELLED/PAYMENT_TIMEOUT/REFUNDED/FAILED/DRAFT）。删除本身绝不触碰库存/座位账。
  app.delete(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
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
  //   ADMIN + STAFF；只对已软删的订单生效（未删/不存在 → 404）。软删从不改 status，且回收站里
  //   全是释放型状态，恢复绝不凭空占座（依据见 service.restoreOrder 注释）。审计 RESTORE_ORDER。
  app.post(
    '/:id/restore',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
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
            // 房组归属的订单行（可选，split-room-group / 新版前端写入）：房控按它把房组
            // 计到该行所在酒店，roomsBilled 也按它分行落。缺省 = 旧口径（整单计数 + 塌缩首行）。
            orderItemId: z.string().min(1).optional(),
          }),
        ),
      })
      .parse(req.body);
    const before = await prisma.order.findUnique({
      where: { id },
      select: { orderNumber: true, roomAssignment: true },
    });
    if (!before) return reply.status(404).send({ error: '订单不存在' });

    // orderItemId 归属校验：必须是本单的 HOTEL/BUNDLE 行 id，否则 400（防串单/脏引用）。
    const attributedIds = [
      ...new Set(
        body.roomGroups
          .map((g) => g.orderItemId)
          .filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    ];
    if (attributedIds.length > 0) {
      const ownedCount = await prisma.orderItem.count({
        where: {
          id: { in: attributedIds },
          orderId: id,
          kind: { in: [OrderItemKind.HOTEL, OrderItemKind.BUNDLE] },
        },
      });
      if (ownedCount !== attributedIds.length) {
        return reply
          .status(400)
          .send({ error: '房组归属的订单行不存在或不属于本单（仅可归属本单的酒店/套餐行）' });
      }
    }
    const hasAttribution = attributedIds.length > 0;

    // 本次分房的物理间数 = 有乘客的房间盒子数。真正的房量判定在下方写 roomAssignment 的
    // 那个事务里做（带包房周期行锁），见那里的注释。
    const assignedRooms = body.roomGroups.filter((g) => g.passengerIds.length > 0).length;

    // ── B10 提示收集（不阻断，回给前端弹给运营看）───────────────────────────
    const warnings: string[] = [];

    // 混性别房间提示：异性不拼间是缺省口径，但运营故意混拼（夫妻/家庭）合法——只提示不拦。
    const paxRows = await prisma.passenger.findMany({
      where: { orderId: id },
      select: { id: true, gender: true },
    });
    const genderById = new Map(paxRows.map((p) => [p.id, p.gender]));
    for (const g of body.roomGroups) {
      if (g.passengerIds.length < 2) continue;
      const genders = new Set(
        g.passengerIds.map((pid) => genderById.get(pid)).filter((x) => x === 'M' || x === 'F'),
      );
      if (genders.size > 1) {
        warnings.push(
          `房间「${g.hotelName}·${g.roomType}」混拼了异性乘客——家庭/夫妻属正常，其他情况请确认（销控板按异性不拼口径计物理间数）。`,
        );
      }
    }

    // 分房总间数（含 0.5 拼房）→ 写回酒店订单行的 roomsBilled，房控据此按真实间数计（如 7 人 3.5 间）。
    const totalRooms = body.roomGroups.reduce((s, g) => s + (g.roomFraction ?? 1), 0);
    // Σ roomFraction 按房组归属分行落（解除「全部塌缩进首行」）：带 orderItemId 的组记到
    // 各自订单行；无归属的组维持旧口径 —— 合并进首个带房型的行。
    const roomsByItem = new Map<string, number>();
    let unattachedRooms = 0;
    for (const g of body.roomGroups) {
      const fraction = g.roomFraction ?? 1;
      if (g.orderItemId) {
        roomsByItem.set(g.orderItemId, (roomsByItem.get(g.orderItemId) ?? 0) + fraction);
      } else {
        unattachedRooms += fraction;
      }
    }
    // 金额分叉提示（B10）：roomsBilled 是房控口径也是计价参照——拖拽改它不会重算订单金额。
    // 把「计费房数变了但钱没变」明示给运营，需要调价走补房差 / 改结算价通道，别让两本账静默漂移。
    const prevAgg = await prisma.orderItem.aggregate({
      where: { orderId: id, hotelRoomTypeId: { not: null } },
      _sum: { roomsBilled: true },
    });
    const prevRooms = prevAgg._sum.roomsBilled == null ? null : Number(prevAgg._sum.roomsBilled.toString());
    const hotelItemCount = await prisma.orderItem.count({
      where: { orderId: id, hotelRoomTypeId: { not: null } },
    });
    await prisma.$transaction(async (tx) => {
      // ── 物理房间口径前瞻闸（口径同下单闸 / 销控板看板）────────────────────────
      // 分房表一旦落库，销控板就按「有乘客的房间盒子数」直计本单物理间数（assignedPhysicalRooms）——
      // 也就是说分房本身会改变物理占房。多开一个房间盒子 = 多占一间，必须过闸。
      // 逐酒店判定：本单在该酒店的所有行取住宿区间并集（对齐 expandAssignedPhysicalByDate 的订单级去重）。
      // allowNonWorsening：存量单可能在切闸前就已物理超卖，房控重排分房去补救时不该被自己造成的
      // 存量超卖挡住 —— 只拦「改完比改前更差」的操作。
      // **事务内互斥版**：判定与落库同一事务、先锁包房周期行，中间没有窗口 ——
      // 只读判定 + 事务外执行 = 两个并发分房各自读到旧快照双双通过，闸再准也拦不住。
      if (assignedRooms > 0) {
        const hotelItems = await tx.orderItem.findMany({
          where: { orderId: id, hotelRoomTypeId: { not: null } },
          select: {
            id: true,
            hotelCheckIn: true,
            hotelCheckOut: true,
            hotelRoomType: { select: { hotelId: true, hotel: { select: { name: true } } } },
          },
        });
        const byHotel = new Map<string, { nights: Set<string>; itemIds: Set<string>; name: string }>();
        for (const it of hotelItems) {
          const hotelId = it.hotelRoomType?.hotelId;
          if (!hotelId || !it.hotelCheckIn || !it.hotelCheckOut) continue;
          const agg =
            byHotel.get(hotelId) ??
            {
              nights: new Set<string>(),
              itemIds: new Set<string>(),
              name: it.hotelRoomType?.hotel?.name ?? '',
            };
          if (!byHotel.has(hotelId)) byHotel.set(hotelId, agg);
          agg.itemIds.add(it.id);
          for (const d of buildStayNightDates(it.hotelCheckIn, it.hotelCheckOut)) agg.nights.add(d);
        }
        // 逐酒店的本单新物理间数：带归属的分房按房组归属分酒店计（orderItemId ∈ 该酒店行 ∪
        // 无归属组按酒店名匹配）；整单无归属（旧数据/旧前端）回退整单口径 —— 每家都按总数判。
        const groupsWithPax = body.roomGroups.filter((g) => g.passengerIds.length > 0);
        // 按酒店 id 排序加锁，避免并发分房以不同顺序锁同一批酒店造成死锁。
        for (const hotelId of [...byHotel.keys()].sort()) {
          const agg = byHotel.get(hotelId)!;
          const roomsForHotel = hasAttribution
            ? groupsWithPax.filter((g) =>
                g.orderItemId ? agg.itemIds.has(g.orderItemId) : g.hotelName === agg.name,
              ).length
            : assignedRooms;
          await assertHotelPhysicalFitWithinTx(
            tx,
            hotelId,
            [...agg.nights].sort(),
            { wholeRooms: roomsForHotel, solos: [] },
            {
              excludeOrderId: id,
              allowNonWorsening: true,
              buildMessage: (violations) =>
                `分房间数超出该酒店包房量：${violations
                  .map((v) => `${v.date}（包房 ${v.block} 间，分完后需 ${v.physicalUsed} 间）`)
                  .join('；')}。请减少房间数，或联系房控加房 / 换酒店。`,
            },
          );
        }
      }

      await tx.order.update({
        where: { id },
        data: { roomAssignment: body as unknown as object },
      });
      // 先清空本单所有酒店行的 roomsBilled，避免多酒店行残留旧值导致房控按行 Σ 重复计数。
      await tx.orderItem.updateMany({
        where: { orderId: id, hotelRoomTypeId: { not: null } },
        data: { roomsBilled: null },
      });
      // 带归属的间数落到各自行；无归属的间数落首个带房型的行（旧口径兜底）。
      // 任何行合计为 0 → 保持 null（上面已清空），不留 0。Σ 各行 = totalRooms（间数守恒）。
      const writes = new Map(roomsByItem);
      if (unattachedRooms > 0) {
        const hotelItem = await tx.orderItem.findFirst({
          where: { orderId: id, hotelRoomTypeId: { not: null } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (hotelItem) {
          writes.set(hotelItem.id, (writes.get(hotelItem.id) ?? 0) + unattachedRooms);
        }
      }
      for (const [rowId, rooms] of writes) {
        if (rooms <= 0) continue;
        await tx.orderItem.update({
          where: { id: rowId },
          data: { roomsBilled: rooms },
        });
      }
    });
    if (prevRooms !== null && totalRooms > 0 && Math.abs(totalRooms - prevRooms) >= 0.5) {
      warnings.push(
        `计费房数由 ${prevRooms} 变为 ${totalRooms}，订单金额不会自动重算——如需按新房数调价，请走「补收单房差」或改结算价通道。`,
      );
    }
    // 多酒店行 + 存在无归属房组 → 无归属那部分仍按旧口径塌缩进首行，明示给运营。
    // 全部房组都带归属时间数已按行分落，不再提示。
    if (hotelItemCount > 1 && unattachedRooms > 0) {
      warnings.push(
        hasAttribution
          ? `本单有 ${hotelItemCount} 条酒店行，其中无归属房组的 ${unattachedRooms} 间已合并记在首条酒店行（房控合计口径不受影响，按行看会有偏差）。`
          : `本单有 ${hotelItemCount} 条酒店行，分房间数已合并记在首条酒店行（房控合计口径不受影响，按行看会有偏差）。`,
      );
    }
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_ROOM_ASSIGNMENT',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: before.orderNumber,
      before: { roomAssignment: before.roomAssignment, roomsBilled: prevRooms },
      after: { roomAssignment: body, roomsBilled: totalRooms, warnings },
    });
    return { ok: true, warnings };
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
    // 归属校验（IDOR 修复）：与同文件 cancel/change-request 等 :id 路由一致，先过 service.getOrder
    // （内含 assertCanView：CUSTOMER 仅本人单、AGENT 仅自己+下级、ADMIN/STAFF 全部），
    // 否则任意登录用户都能改他人订单的 plain notes（不存在 → 404，无权 → 403）。
    const requester = await buildRequester(req.user.sub, req.user.role);
    await service.getOrder(id, requester);
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
        // 签证矛盾硬闸要读：订单是否还参与履约 + 本单出行人的自备签现势
        status: true,
        deletedAt: true,
        passengers: { select: { visaExempt: true } },
      },
    });
    if (!before) return reply.status(404).send({ error: '订单不存在' });

    // ── 签证矛盾组合硬闸：改成「需要签证 / 电子签」但本单出行人全是自备签 → 拒绝 ──
    // 这种组合不会生成签证任务（判定见 visa-need.ts 的 orderNeedsVisaTask），签证台看不见
    // 这单，到期漏送签。只拒绝、不替客人翻 visaExempt（它同时是定价输入，改它 = 静默改价）。
    // 豁免：未录乘客（先建单后补人是正常流程）、部分自备签、取消族终态 / 回收站单
    //   —— 后者不参与履约，对它们做状态收尾不该被这条闸挡住（口径同 evaluateOrderVisaTaskState）。
    const orderInactive =
      Boolean(before.deletedAt) || FULFILLMENT_TERMINATING_STATUSES.includes(before.status);
    if (
      body.visaStatus !== undefined &&
      !orderInactive &&
      isVisaContradiction({ visaStatus: body.visaStatus, passengers: before.passengers })
    ) {
      return reply.status(400).send({ error: VISA_CONTRADICTION_MESSAGE });
    }

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
    // 订单级签证状态变更 → 签证任务事件驱动同步（条10）。
    // 改成「不需要签证 / 客人已有签证」之后，早先建的那条 PENDING 签证任务不会自己消失，
    // 签证台上会永远挂着一条办不掉的「待处理」；改回需签则要把任务补回来。
    // 只在 visaStatus 真的变了时才跑（幂等，且不给纯改备注的请求平白加几次查询）；
    // 批量改备注走的是同一个端点逐单调用，因此一并受益。
    // 放进事务：同步内部是「读现状 → 撤/建」，裸用全局 prisma 时两个并发请求会各建一条任务。
    // 事务 + 建任务前的同事务 re-check（见 syncVisaTasksForOrder）把并发窗口收到最小。
    if (body.visaStatus !== undefined && body.visaStatus !== before.visaStatus) {
      await prisma.$transaction((tx) =>
        syncVisaTasksForOrder(tx, id, { userId: req.user.sub, role }),
      );
    }
    return { ok: true };
  });

  // 旧端点 PATCH /orders/:id/invoice-status 已删除（0716 H11b）：订单级开票状态是六态开票改造
  // 前的遗留，与现口径是两本账——它不走 assertOrderAllowsInvoicing（取消族/回收站单照样能标），
  // 写进的 Order.invoiceStatus 也已无人读（开票额度、导出、财务口径全看下面的三个布尔位）。
  // 开票的唯一写入口就是 PATCH /orders/:id/invoice-flags。

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

  // ── 批量开票：票务岗一次给多单勾同一批航段/系统开票标记（ADMIN/STAFF）──
  // POST /orders/batch-invoice-flags  body: { orderIds: string[], flags: { outboundInvoiced?, returnInvoiced?, systemInvoiced? } }
  // 逐单复用 setInvoiceFlags（保持班次开票上限校验语义不变），单单失败（如超限）不影响其余单；
  // 每个成功单各写一条 UPDATE_INVOICE_STATUS 审计（after 字段对齐单条 PATCH 端点）。
  app.post(
    '/batch-invoice-flags',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const role = req.user.role;
      if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
        return reply.status(403).send({ error: '仅运营/管理员可批量修改开票状态' });
      }
      const body = batchSetInvoiceFlagsBodySchema.parse(req.body);
      const result = await service.batchSetInvoiceFlags(body.orderIds, body.flags);
      for (const r of result.results) {
        if (!r.ok) continue;
        void writeAudit({
          actor: actorFromRequest(req),
          action: 'UPDATE_INVOICE_STATUS',
          targetType: 'ORDER',
          targetId: r.id,
          targetLabel: r.orderNumber,
          after: {
            outboundInvoiced: r.outboundInvoiced,
            returnInvoiced: r.returnInvoiced,
            systemInvoiced: r.systemInvoiced,
          },
        });
      }
      return result;
    },
  );

  // ── 批量改航班：录入纠错（ADMIN/STAFF）───────────────────────────────
  // 按订单既有航段排序逐单改期；不收改期费，已出票/已完成单默认拦截。
  app.post('/batch-reschedule', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可批量改航班' });
    }
    const body = batchRescheduleBodySchema.parse(req.body);
    const result = await service.batchReschedule(body, {
      userId: req.user.sub,
      role,
    });
    const fmt = (d: Date | null) => (d ? d.toISOString() : null);
    for (const r of result.results) {
      if (r.ok && r.audit) {
        void writeAudit({
          actor: actorFromRequest(req),
          action: 'RESCHEDULE_ORDER_ITEM',
          targetType: 'ORDER',
          targetId: r.id,
          targetLabel: r.audit.orderNumber,
          before: {
            orderItemId: r.audit.orderItemId,
            scheduleId: r.audit.fromScheduleId,
            cabin: r.audit.fromCabin,
            departure: fmt(r.audit.fromDeparture),
          },
          after: {
            scheduleId: r.audit.toScheduleId,
            cabin: r.audit.toCabin,
            departure: fmt(r.audit.toDeparture),
            feeCny: r.audit.feeCny,
            statusChanged: r.audit.statusChanged,
            note: body.note,
            ...(r.notice ? { notice: r.notice } : {}),
          },
          severity: 'WARNING',
        });
        continue;
      }
      if (!r.ok) {
        void writeAudit({
          actor: actorFromRequest(req),
          action: 'RESCHEDULE_ORDER_ITEM_FAILED',
          targetType: 'ORDER',
          targetId: r.id,
          targetLabel: r.orderNumber ?? r.id,
          after: {
            leg: body.leg,
            newScheduleId: body.newScheduleId,
            error: r.error ?? '未知错误',
          },
          severity: 'WARNING',
        });
      }
    }
    const failureDetails = result.results
      .filter((r) => !r.ok)
      .map((r) => ({ orderId: r.id, error: r.error ?? '未知错误' }));
    const failureAuditLimit = 100;
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'BATCH_RESCHEDULE',
      targetType: 'ORDER',
      targetId: 'batch',
      targetLabel: `${result.succeeded}/${body.orderIds.length} orders → ${body.newScheduleId}`,
      after: {
        leg: body.leg,
        newScheduleId: body.newScheduleId,
        requestedCount: body.orderIds.length,
        successCount: result.succeeded,
        failureCount: result.failed,
        failureDetails: failureDetails.slice(0, failureAuditLimit),
        failureDetailsTotal: failureDetails.length,
        failureDetailsTruncated: failureDetails.length > failureAuditLimit,
        allowTicketed: body.allowTicketed,
        note: body.note,
      },
      severity: result.failed > 0 ? 'WARNING' : 'INFO',
    });
    return {
      succeeded: result.succeeded,
      failed: result.failed,
      results: result.results.map(({ audit: _audit, ...publicResult }) => publicResult),
    };
  });

  // ── 批量锁定/解锁结算价（ADMIN/STAFF）────────────────────────────────────
  // POST /orders/batch/settlement-lock  body: { orderIds: string[], lock: boolean }
  // 不存在或已软删订单跳过；每个成功订单各写一条审计。
  app.post(
    '/batch/settlement-lock',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const body = batchSettlementLockBodySchema.parse(req.body);
      const result = await service.batchSetSettlementLock(body.orderIds, body.lock, req.user.sub);
      for (const r of result.results) {
        void writeAudit({
          actor: actorFromRequest(req),
          action: body.lock ? 'LOCK_SETTLEMENT_PRICE' : 'UNLOCK_SETTLEMENT_PRICE',
          targetType: 'ORDER',
          targetId: r.id,
          targetLabel: r.orderNumber,
          before: { settlementLocked: r.beforeLocked },
          after: {
            settlementLocked: body.lock,
            settlementLockedAt: r.settlementLockedAt?.toISOString() ?? null,
            settlementLockedBy: body.lock ? req.user.sub : null,
          },
          severity: 'WARNING',
        });
      }
      return { updated: result.updated, skipped: result.skipped };
    },
  );

  // ── 预期到账金额（ADMIN/STAFF；锁定后仅 ADMIN）──
  // PATCH /orders/:id/expected-amount  body: { amountCny: number | null }
  app.patch('/:id/expected-amount', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可修改预期到账金额' });
    }
    const { id } = req.params as { id: string };
    const body = expectedAmountBodySchema.parse(req.body);
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

  // ── 预期到账锁定/解锁（ADMIN + STAFF/财务）──
  // POST /orders/:id/expected-amount/lock  body: { locked: boolean }
  // 锁定/解锁开放给财务：财务负责对账，需要能锁住核对无误的预期到账、也能在填错时解锁重来。
  // 注意：锁定状态下「修改预期到账金额」仍仅 ADMIN 可改（见上方 PATCH 端点）——
  // 财务能锁/解锁，但不能在锁定态下自行改数，改数仍需管理员，审计照写。
  app.post('/:id/expected-amount/lock', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅管理员或财务可锁定/解锁预期到账' });
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

  // ── 收款复核锁定/解锁（ADMIN + STAFF/财务）──
  // POST /orders/:id/payments-lock  body: { locked: boolean }
  // 口径：业务录收款 → 财务/出纳对账复核无误 → 锁定本单收款。锁定后禁止人工录新收款
  // （人工确认 / 批量确认在 paymentsLocked 时返回 409）；要再收钱需先解锁（审计留痕）。
  // 网关到账 / 对账认款是真钱已落库，不受此锁影响（见 payments.service 注释）。
  app.post('/:id/payments-lock', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅管理员或财务可锁定/解锁收款' });
    }
    const { id } = req.params as { id: string };
    const body = z.object({ locked: z.boolean() }).parse(req.body);
    const order = await prisma.order.findUnique({
      where: { id },
      select: { id: true, orderNumber: true, paymentsLocked: true },
    });
    if (!order) return reply.status(404).send({ error: '订单不存在' });
    const updated = await prisma.order.update({
      where: { id },
      data: {
        paymentsLocked: body.locked,
        paymentsLockedAt: body.locked ? new Date() : null,
        paymentsLockedBy: body.locked ? req.user.sub : null,
      },
      select: { id: true, paymentsLocked: true, paymentsLockedAt: true, paymentsLockedBy: true },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: body.locked ? 'LOCK_PAYMENTS' : 'UNLOCK_PAYMENTS',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: order.orderNumber,
      before: { paymentsLocked: order.paymentsLocked },
      after: {
        paymentsLocked: updated.paymentsLocked,
        paymentsLockedAt: updated.paymentsLockedAt?.toISOString() ?? null,
        paymentsLockedBy: updated.paymentsLockedBy,
      },
      severity: 'WARNING',
    });
    return {
      id: updated.id,
      paymentsLocked: updated.paymentsLocked,
      paymentsLockedAt: updated.paymentsLockedAt,
      paymentsLockedBy: updated.paymentsLockedBy,
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
        // 酒店入住随出发日平移的同步明细（空数组 = 本次未平移/无酒店行）
        hotelDateSync: audit.hotelDateSync,
      },
      severity: 'WARNING',
    });
    return { order };
  });

  // ── 售后改单：升舱（ADMIN/STAFF）──
  // POST /orders/:id/items/:itemId/upgrade-cabin  body: { note? }
  // 把某条**经济舱**机票行就地升到商务舱：座位先放经济舱再原子拿商务舱（余位不足回滚），
  // 差价由服务端按该航班的升舱差价源 × 人数权威计算（请求体不接受金额），单独记一条
  // UPGRADE_CHANGE 收入行并抬订单总额；**订单状态不动**（升舱不是改签）。
  app.post('/:id/items/:itemId/upgrade-cabin', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可升舱' });
    }
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = upgradeItemCabinBodySchema.parse(req.body ?? {});
    const { order, audit } = await service.upgradeOrderItemCabin(id, itemId, body, {
      userId: req.user.sub,
      role,
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPGRADE_CABIN_ITEM',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: audit.orderNumber,
      before: {
        orderItemId: audit.orderItemId,
        cabin: audit.fromCabin,
        scheduleId: audit.scheduleId,
        subtotalCny: audit.subtotalBefore,
      },
      after: {
        cabin: audit.toCabin,
        quantity: audit.quantity,
        upgradeCnyPerLeg: audit.upgradeCnyPerLeg,
        diffCny: audit.diffCny,
        upgradeItemId: audit.upgradeItemId,
        subtotalCny: audit.subtotalAfter,
        note: body.note,
      },
      severity: 'WARNING',
    });
    return { order };
  });

  // ── B4 改结算价（ADMIN/STAFF）──
  // PATCH /orders/:id/items/:itemId/settlement-price  body: { unitPriceCny, reason? }
  // 建单后订正某条 FLIGHT 行（每张票价）或 HOTEL 行（每间每晚价）的结算价；
  // 事务内按该 kind 的计价口径重算行金额与 order.subtotal/total（不走 adjustmentCny）。
  app.patch('/:id/items/:itemId/settlement-price', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可改结算价' });
    }
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = updateItemSettlementPriceBodySchema.parse(req.body);
    const { order, warning, audit } = await service.updateItemSettlementPrice(id, itemId, body, {
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
    return { order, warning };
  });

  // ── 出行人资料（同一路径，双通道）──
  // PATCH /orders/:id/passengers/:passengerId
  //
  // ① 补录护照/证件资料（selfUpdatePassengerBodySchema）：
  //   body: { chineseName?, gender?, documentNumber?, dateOfBirth?, nationality?,
  //           passportExpiry?, passportIssueDate?, passportIssueCountry?,
  //           passportIssuePlace?, passportPhotoUrl? }（至少一个；不允许改 fullName——换人请联系客服）
  //   走此路的角色：CUSTOMER/AGENT 一律走；ADMIN/STAFF 在「请求体不含任何换人语义字段」时也走此路
  //   ——运营只想补 passportIssueDate/passportExpiry/护照图 等证件资料时，不该被换人 schema 400（换人
  //   schema 无护照字段）。归属/状态校验在 service 内（assertCanView 对 ADMIN/STAFF 直接放行；
  //   仅 PENDING_PAYMENT/PAID/PROCESSING 可改，否则 409 ORDER_LOCKED）。返回 { passenger }。
  //
  // ② 售后改单：换人（仅 ADMIN/STAFF；请求体带 lastName/firstName/fullName/title/passengerType/
  //   visaExempt/singleRoom/resetInvoice/resetVisa/feeCny/feeLabel/note 任一「换人语义字段」
  //   即判为换人，见 resolvePassengerPatchChannel）：
  //   body: { lastName?, firstName?, fullName?, documentNumber?, dateOfBirth?, gender?,
  //           nationality?, title?, passengerType?, visaExempt?, singleRoom?,
  //           resetInvoice?, resetVisa?, feeCny?, feeLabel?, note? }
  //   就地把出行人换成新人；resetInvoice→开票 NONE、resetVisa→签证任务 PENDING；可选加换人费。
  app.patch('/:id/passengers/:passengerId', { preHandler: [app.authenticate] }, async (req) => {
    const role = req.user.role;
    const { id, passengerId } = req.params as { id: string; passengerId: string };
    if (resolvePassengerPatchChannel(role, req.body) === 'SELF_UPDATE') {
      // ① 补录护照/证件资料通道（CUSTOMER/AGENT 全部走此路；ADMIN/STAFF 无换人语义字段时也走此路）。
      //   归属/状态校验在 service 内；越权 403、锁定 409 由错误处理器统一格式化。
      const selfBody = selfUpdatePassengerBodySchema.parse(req.body);
      const requester = await buildRequester(req.user.sub, role);
      const result = await service.selfUpdatePassenger(id, passengerId, selfBody, requester);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'SELF_UPDATE_PASSENGER',
        targetType: 'TRAVELER',
        targetId: passengerId,
        targetLabel: result.orderNumber,
        // PII 红线：只记改了哪些字段名，绝不落护照号/照片/身份字段值
        after: { fields: result.changedFields },
      });
      return { passenger: result.passenger };
    }
    // ② 换人通道（仅 ADMIN/STAFF——resolvePassengerPatchChannel 已保证前台角色永不到此）。
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

  // ── 签证台：出签后补录 出签日/生效日/有效期（ADMIN/STAFF）──
  // PATCH /orders/:id/passengers/:passengerId/visa-dates
  // body: { visaIssueDate?: string|null, visaEffectiveDate?: string|null, visaExpiry?: string|null }
  //   （YYYY-MM-DD 或 null=清空该字段；至少提供一个）
  // 这三项是签证岗出签后才拿得到的信息，录单时无法预先知道（票务岗反馈：录单时不需要，
  // 已从录单表单移除）——改由签证台在出签后走本端点补录。
  app.patch(
    '/:id/passengers/:passengerId/visa-dates',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const role = req.user.role;
      if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
        return reply.status(403).send({ error: '仅运营/管理员可录入签证日期' });
      }
      const { id, passengerId } = req.params as { id: string; passengerId: string };
      const body = updatePassengerVisaDatesBodySchema.parse(req.body);
      const result = await service.updatePassengerVisaDates(id, passengerId, body, {
        userId: req.user.sub,
        role,
      });
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'UPDATE_PASSENGER_VISA_DATES',
        targetType: 'TRAVELER',
        targetId: passengerId,
        targetLabel: result.orderNumber,
        before: result.before,
        after: result.after,
      });
      return { passenger: result.passenger };
    },
  );

  // ── 建单后按人改自备签（ADMIN/STAFF）──
  // PATCH /orders/:id/passengers/:passengerId/visa-exempt  body: { visaExempt, note? }
  // 与换人通道分离的专用动作：同一个人改办签方式。套餐单由服务端按建单快照费率对称重算应收
  // （行重算，不走调整行）；送签进度重置为待处理；签证任务同步对齐 + 按人重派生状态。
  app.patch(
    '/:id/passengers/:passengerId/visa-exempt',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const role = req.user.role;
      if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
        return reply.status(403).send({ error: '仅运营/管理员可改乘客自备签' });
      }
      const { id, passengerId } = req.params as { id: string; passengerId: string };
      const body = setPassengerVisaExemptBodySchema.parse(req.body);
      const { order, warning, audit } = await service.setPassengerVisaExempt(id, passengerId, body, {
        userId: req.user.sub,
        role,
      });
      // 幂等短路（目标值与现值相同）不写审计——什么都没发生。
      if (audit) {
        void writeAudit({
          actor: actorFromRequest(req),
          action: 'SET_PASSENGER_VISA_EXEMPT',
          targetType: 'ORDER',
          targetId: id,
          targetLabel: audit.orderNumber,
          before: {
            passengerId: audit.passengerId,
            visaExempt: audit.before.visaExempt,
            visaSubmissionStatus: audit.before.visaSubmissionStatus,
          },
          after: {
            visaExempt: audit.after.visaExempt,
            visaSubmissionStatus: audit.after.visaSubmissionStatus,
            totalDelta: audit.totalDeltaCny,
            note: body.note,
            // 已送签人为确认路径（其余为 null/0）：实退客人 / 批文成本留存 / 操作人填的原因
            refundCny: audit.refundCny,
            retainCny: audit.retainCny,
            overrideReason: body.submittedOverride?.reason ?? null,
          },
          severity: 'WARNING',
        });
      }
      return { order, warning };
    },
  );

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
    // 越过「套餐档次 ↔ 酒店星级」闸时另记一条：换酒店审计只说换到哪，说不清「档次对不上还放行了」。
    if (audit.starMismatchOverride) {
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'DESIGNATED_HOTEL_STAR_MISMATCH_OVERRIDE',
        targetType: 'ORDER',
        targetId: id,
        targetLabel: audit.orderNumber,
        after: { ...audit.starMismatchOverride, orderItemId: audit.orderItemId, source: 'HOTEL_SWAP' },
        severity: 'WARNING',
      });
    }
    return { order };
  });

  // ── 售后改单：酒店改期（ADMIN/STAFF）──
  // PATCH /orders/:id/items/:itemId/hotel-reschedule  body: { newCheckIn, newCheckOut, feeCny?, feeLabel?, note? }
  // 把某条 HOTEL 行的入住/退房日期整体挪到新区间（占房同一条 UPDATE 里从旧区间转到新区间，
  // 新区间余量不足则整事务回滚）。行价冻结：晚数变化不重算 unitPrice/amount/quantity，
  // 差额由可选的 feeCny 走售后费行（缺省名「酒店改期差价」）。
  app.patch('/:id/items/:itemId/hotel-reschedule', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可改酒店入住日期' });
    }
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = rescheduleItemHotelBodySchema.parse(req.body);
    const { order, audit } = await service.rescheduleItemHotel(id, itemId, body, {
      userId: req.user.sub,
      role,
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'RESCHEDULE_ORDER_ITEM_HOTEL',
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

  // ── 售后改单：按房组拆分酒店行（ADMIN/STAFF）──
  // POST /orders/:id/items/:itemId/split-room-group  body: { roomGroupId, note? }
  // 把分房表里的一个房组从某条 HOTEL 行拆成独立酒店行（「按房组换酒店」的前置步骤）。
  // 钱不动：新行 0 元、源行 amount 冻结 → order.total 恒等；库存对称：Σ roomsBilled 恒等。
  app.post(
    '/:id/items/:itemId/split-room-group',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { id, itemId } = req.params as { id: string; itemId: string };
      const body = splitRoomGroupBodySchema.parse(req.body);
      const { order, audit } = await service.splitHotelItemByRoomGroup(id, itemId, body, {
        userId: req.user.sub,
        role: req.user.role,
      });
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'SPLIT_ROOM_GROUP',
        targetType: 'ORDER',
        targetId: id,
        targetLabel: audit.orderNumber,
        before: { orderItemId: audit.fromItemId, ...audit.before },
        after: {
          ...audit.after,
          newItemId: audit.newItemId,
          roomGroupId: audit.roomGroupId,
          note: body.note,
        },
        severity: 'WARNING',
      });
      return { order, newItemId: audit.newItemId };
    },
  );

  // ── 售后改单：套餐改档（ADMIN/STAFF）──
  // POST /orders/:id/change-bundle  body: { bundleId, note? }
  // 行业口径 amendment：改档 → 按新档重新计价 → 差价落一条 bundleChange 差额行 → 审计。
  // 机票行/班次/座位一律不动；酒店已落位到真实酒店的单先走换酒店。AGENT 不可用。
  app.post(
    '/:id/change-bundle',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = changeOrderBundleBodySchema.parse(req.body);
      const { order, audit } = await service.changeOrderBundle(id, body, {
        userId: req.user.sub,
        role: req.user.role,
      });
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'CHANGE_ORDER_BUNDLE',
        targetType: 'ORDER',
        targetId: id,
        targetLabel: audit.orderNumber,
        before: { orderItemId: audit.orderItemId, ...audit.before },
        after: {
          ...audit.after,
          diffCny: audit.diffCny,
          diffItemId: audit.diffItemId,
          pricingSource: audit.pricingSource,
          note: audit.note,
          warnings: audit.warnings,
        },
        severity: 'WARNING',
      });
      return { order, diffCny: audit.diffCny, warnings: audit.warnings };
    },
  );

  // ── T5 更改订单归属代理（ADMIN/STAFF）──
  // PATCH /orders/:id/agent  body: { agentId: string | null, reason? }
  // 硬守卫：回收站单、已退款单、曾用原代理预存余额抵扣的订单均拒绝；目标代理必须存在且未停用。
  // 财务不回溯：已发生的收款/余额抵扣/佣金按原归属保留，变更后新产生的按新归属。warning 保留为空以稳定 API 形状。
  app.patch('/:id/agent', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可更改订单归属代理' });
    }
    const { id } = req.params as { id: string };
    const body = changeOrderAgentBodySchema.parse(req.body);
    const { order, warning, audit } = await service.changeOrderAgent(id, body, {
      userId: req.user.sub,
      role,
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CHANGE_ORDER_AGENT',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: audit.orderNumber,
      before: { agentId: audit.before.agentId, agentName: audit.before.agentName },
      after: {
        agentId: audit.after.agentId,
        agentName: audit.after.agentName,
        reason: audit.reason,
        usedAgentBalance: audit.usedAgentBalance,
      },
      severity: 'WARNING',
    });
    return { order, warning };
  });

  // ── 拆单 v1（split PNR 售后逃生门；ADMIN/STAFF）──────────────────────────
  // POST /orders/:id/split-preview  body: { passengerIds }
  //   只读预检：跑全部准入闸 + 每人份额计算，返回 blockers（人话逐条）/ shares /
  //   movedShareCny / movedPaidCny / hotelItems（供 UI 让运营填 roomSplit）。
  app.post('/:id/split-preview', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可拆单' });
    }
    const { id } = req.params as { id: string };
    const body = splitOrderPreviewBodySchema.parse(req.body);
    return service.previewOrderSplit(id, body, { userId: req.user.sub, role });
  });

  // POST /orders/:id/split  body: { passengerIds, roomSplit?, note?, requestToken }
  //   执行拆单（服务端权威算钱：前端不传金额，roomSplit 只传间数）。
  //   幂等：同 (源单, requestToken) 重试只回放既有结果。审计（SPLIT_ORDER×2，CRITICAL）
  //   与守恒断言在 service 内完成。
  app.post('/:id/split', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可拆单' });
    }
    const { id } = req.params as { id: string };
    const body = splitOrderBodySchema.parse(req.body);
    return service.splitOrder(id, body, { userId: req.user.sub, role });
  });

  // ── 取消航段（partial cancellation；ADMIN/STAFF）────────────────────────────
  // 往返单的客人只飞其中一段，另一段放回给系统继续销售：
  //   leg=RETURN   取消回程 → 单去程单；leg=OUTBOUND 取消去程 → 单回程单。
  // 老路径 /cancel-return-leg[/preview] 保留为 leg=RETURN 的别名（老前端与集成方不受影响）。
  //
  // POST /orders/:id/cancel-leg/preview   body: { leg? }
  //   只读预检：跑全部准入闸 + 按取消政策给该航段行报价，返回 leg / blockers（人话逐条）/
  //   returnItem / policyFee / netReductionCny / overpayAfterCny，供运营在弹窗里逐条看。
  const previewCancelLegHandler =
    (fixedLeg?: 'OUTBOUND' | 'RETURN') =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const role = req.user.role;
      if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
        return reply.status(403).send({ error: '仅运营/管理员可取消航段' });
      }
      const { id } = req.params as { id: string };
      const leg = fixedLeg ?? cancelLegPreviewBodySchema.parse(req.body ?? {}).leg;
      return service.previewCancelLeg(id, leg, { userId: req.user.sub, role });
    };

  app.post('/:id/cancel-leg/preview', { preHandler: [app.authenticate] }, previewCancelLegHandler());
  app.post(
    '/:id/cancel-return-leg/preview',
    { preHandler: [app.authenticate] },
    previewCancelLegHandler('RETURN'),
  );

  // POST /orders/:id/cancel-leg  body: { requestToken, leg?, feeMode, manualFeeCny?, overrideReason?, note? }
  //   执行取消航段：该段座位放回库存、订单变单程、手续费按取消政策（或带原因的手工覆盖）
  //   落一条调价行。服务端权威定价：请求体不接受「应退多少」，本端点也不打款——
  //   降完应收后的多收走既有多付/退款流程。幂等：同 (订单, requestToken) 重试只回放。
  const cancelLegHandler =
    (fixedLeg?: 'OUTBOUND' | 'RETURN') =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const role = req.user.role;
      if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
        return reply.status(403).send({ error: '仅运营/管理员可取消航段' });
      }
      const { id } = req.params as { id: string };
      const parsed = cancelLegBodySchema.parse(req.body);
      const body = fixedLeg ? { ...parsed, leg: fixedLeg } : parsed;
      const { order, audit } = await service.cancelLeg(id, body, {
        userId: req.user.sub,
        role,
      });

      void writeAudit({
        actor: actorFromRequest(req),
        action: audit.leg === 'OUTBOUND' ? 'CANCEL_OUTBOUND_LEG' : 'CANCEL_RETURN_LEG',
        targetType: 'ORDER',
        targetId: id,
        targetLabel: audit.orderNumber,
        before: {
          returnItemId: audit.returnItemId,
          originalAmountCny: audit.originalAmountCny,
          totalCny: audit.totalBefore,
        },
        after: {
          leg: audit.leg,
          feeCny: audit.feeCny,
          feeMode: audit.feeMode,
          policyName: audit.policyName,
          // 手工覆盖取消政策是最需要事后复核的一步：原因原文进审计。
          overrideReason: body.overrideReason ?? null,
          note: body.note ?? null,
          releasedSeats: audit.releasedSeats,
          // 已出票的段被取消 → 同事务给票务派了撤名单/退票工单，id 进审计便于追踪跟进。
          workOrderReminderId: audit.workOrderReminderId,
          acknowledgedWarnings: body.acknowledgeWarnings === true,
          netReductionCny: audit.netReductionCny,
          totalCny: audit.totalAfter,
          overpayAfterCny: audit.overpayAfterCny,
          replayed: audit.replayed,
        },
        // 手工覆盖服务端政策报价 = 人为改动金额，按最高等级留痕；按政策走记 WARNING。
        severity: audit.feeMode === 'MANUAL' ? 'CRITICAL' : 'WARNING',
      });

      return { order, audit };
    };

  app.post('/:id/cancel-leg', { preHandler: [app.authenticate] }, cancelLegHandler());
  app.post('/:id/cancel-return-leg', { preHandler: [app.authenticate] }, cancelLegHandler('RETURN'));

  // ── 去程 no-show + 回程释放 / 恢复（ADMIN/STAFF）────────────────────────────
  // 航司每天发 no-show 名单：客人没登机 → 去程标 no-show（钱不动不退、成本不动）、
  // 回程座位释放回库存继续卖（钱同样不动）。之后代理来说要保留 → 恢复回程到原班次，
  // 有座直接占、没座允许超售（前端二次确认 + CRITICAL 审计）。
  //
  // ⚠ 与「取消航段」是两件事：取消回程 = 客人主动退、按政策退钱；
  //    no-show 释放 = 公司放座重卖、一分钱不动。前端两个入口别合并。
  //
  // POST /orders/:id/no-show/preview  body: { passengerIds? }
  app.post('/:id/no-show/preview', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可标记 no-show' });
    }
    const { id } = req.params as { id: string };
    const body = noShowPreviewBodySchema.parse(req.body ?? {});
    return service.previewNoShow(id, body, { userId: req.user.sub, role });
  });

  // POST /orders/:id/no-show  body: { requestToken, passengerIds?, releaseReturn?, note? }
  //   幂等：同 (订单, token) 重试只回放，座位绝不二次释放。
  //   部分乘客 → 服务端先拆单再对新单标记；拆单被闸挡回 409 SPLIT_BLOCKED，
  //   拆成了但标记失败回 409 SPLIT_DONE_NOSHOW_FAILED（details.newOrderId）。
  app.post('/:id/no-show', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可标记 no-show' });
    }
    const { id } = req.params as { id: string };
    const body = noShowBodySchema.parse(req.body);
    const result = await service.markNoShow(id, body, { userId: req.user.sub, role });

    // 幂等回放不再落审计：首刷已记过一条，重试再记一条会让审计里出现两次「释放回程」，
    // 事后核对会以为放了两次座。
    const seats = result.audit.releasedSeats.reduce((n, r) => n + r.quantity, 0);
    if (!result.audit.replayed) void writeAudit({
      actor: actorFromRequest(req),
      action: 'MARK_NO_SHOW',
      targetType: 'ORDER',
      targetId: result.targetOrderId,
      targetLabel:
        `${result.audit.orderNumber} · 去程 no-show · ` +
        `${result.audit.returnItemId ? `释放回程 ${seats} 座` : '未释放回程'}` +
        `${result.audit.split ? `（自 ${result.audit.split.sourceOrderNumber} 拆出）` : ''}`,
      before: { sourceOrderNumber: result.audit.split?.sourceOrderNumber ?? null },
      after: {
        outboundItemId: result.audit.outboundItemId,
        returnItemId: result.audit.returnItemId,
        releasedSeats: result.audit.releasedSeats,
        releaseReturn: body.releaseReturn,
        passengerIds: body.passengerIds ?? null,
        workOrderReminderId: result.audit.workOrderReminderId,
        split: result.audit.split,
        note: body.note ?? null,
        replayed: result.audit.replayed,
      },
      severity: 'WARNING',
    });

    return { order: result.order, targetOrderId: result.targetOrderId, audit: result.audit };
  });

  // POST /orders/:id/restore-return-leg/preview
  //   只读预检：能不能恢复、原班次还剩几座、要不要超售、超售上限多少。
  app.post(
    '/:id/restore-return-leg/preview',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const role = req.user.role;
      if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
        return reply.status(403).send({ error: '仅运营/管理员可恢复回程' });
      }
      const { id } = req.params as { id: string };
      return service.previewRestoreReturnLeg(id, { userId: req.user.sub, role });
    },
  );

  // POST /orders/:id/restore-return-leg  body: { requestToken, allowOversell?, note? }
  //   余位不足且未确认 → 409 OVERSELL_CONFIRMATION_REQUIRED（details 带 available/oversellBy），
  //   前端弹二次确认后带 allowOversell=true 重提。超售放行按最高等级留痕。
  app.post('/:id/restore-return-leg', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可恢复回程' });
    }
    const { id } = req.params as { id: string };
    const body = restoreReturnLegBodySchema.parse(req.body);
    const { order, audit } = await service.restoreReturnLeg(id, body, {
      userId: req.user.sub,
      role,
    });

    if (!audit.replayed) void writeAudit({
      actor: actorFromRequest(req),
      action: audit.oversold ? 'RESTORE_RETURN_LEG_OVERSOLD' : 'RESTORE_RETURN_LEG',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: audit.oversold
        ? `${audit.orderNumber} · 超售放行（班次 ${audit.scheduleId} 舱位 ${audit.cabin ?? '未知'} ` +
          `超出 ${audit.oversoldBy} 座，上限 ${env.FLIGHT_NOSHOW_MAX_OVERSELL_SEATS}）`
        : `${audit.orderNumber} · 恢复回程（${audit.quantity} 座）`,
      after: {
        returnItemId: audit.returnItemId,
        scheduleId: audit.scheduleId,
        cabin: audit.cabin,
        quantity: audit.quantity,
        oversold: audit.oversold,
        oversoldBy: audit.oversoldBy,
        maxOversell: env.FLIGHT_NOSHOW_MAX_OVERSELL_SEATS,
        note: body.note ?? null,
        replayed: audit.replayed,
      },
      // 超售 = 把班次卖到负余位，最需要事后复核 → CRITICAL；有座恢复记 WARNING。
      severity: audit.oversold ? 'CRITICAL' : 'WARNING',
    });

    return { order, audit };
  });

  // ── 按人改期（ADMIN/STAFF）────────────────────────────────────────────────
  // POST /orders/:id/reschedule-passengers
  //   body: { passengerIds, orderItemId, newScheduleId, newCabin?, feeCny?, feeLabel?,
  //           note?, roomSplit?, requestToken }
  //
  // 多人单只给其中一位客人改航班。一单一行程是全站硬约束（同单塞不下两个班次的同一航段），
  // 所以走 Split PNR：**先按所选乘客拆单、再对新单改期**；勾选全员则不拆单，等价整单改期。
  // 拆单与改期各自是独立事务：拆成了但改期失败 → 新单保留（它本身合法），接口回 409 且
  // code=SPLIT_DONE_RESCHEDULE_FAILED、details 带 newOrderId/newOrderNumber，
  // 前端提示运营到新单上重试；同 requestToken 重试幂等（拆单回放 + 已改则不重复收差价）。
  app.post('/:id/reschedule-passengers', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可按人改期' });
    }
    const { id } = req.params as { id: string };
    const body = reschedulePassengersBodySchema.parse(req.body);
    const result = await service.reschedulePassengers(id, body, {
      userId: req.user.sub,
      role,
    });

    // 改期审计与单条改期口径一致（挂在**实际被改期的那张单**上：拆过则是新单）；
    // 拆单的 SPLIT_ORDER×2 与本次的 RESCHEDULE_PASSENGERS 汇总由 service 内部照记。
    const fmt = (d: Date | null) => (d ? d.toISOString() : null);
    const detail = result.audit.reschedule;
    if (detail) {
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'RESCHEDULE_ORDER_ITEM',
        targetType: 'ORDER',
        targetId: result.audit.newOrderId ?? id,
        targetLabel: detail.orderNumber,
        before: {
          orderItemId: detail.orderItemId,
          scheduleId: detail.fromScheduleId,
          cabin: detail.fromCabin,
          departure: fmt(detail.fromDeparture),
        },
        after: {
          scheduleId: detail.toScheduleId,
          cabin: detail.toCabin,
          departure: fmt(detail.toDeparture),
          feeCny: detail.feeCny,
          statusChanged: detail.statusChanged,
          note: body.note,
          hotelDateSync: detail.hotelDateSync,
          // 按人改期专属：这次改的是从源单拆出来的新单
          splitFromOrderNumber: result.splitPerformed ? result.audit.orderNumber : null,
          passengerCount: result.audit.passengerCount,
        },
        severity: 'WARNING',
      });
    }

    return {
      order: result.order,
      newOrder: result.newOrder,
      splitPerformed: result.splitPerformed,
      audit: result.audit,
    };
  });

  // ── 事后补收单房差（ADMIN/STAFF）──
  // POST /orders/:id/room-supplement  body: { perNightCny, nights, note? }
  // 金额 = perNightCny × nights；新增 FEE 行 + 重算 order.subtotal/total + 追加审计流水。
  // 仅含 BUNDLE/HOTEL 行的订单可用（纯机票单无住宿 → 400）。
  app.post('/:id/room-supplement', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可补收单房差' });
    }
    const { id } = req.params as { id: string };
    const body = roomSupplementBodySchema.parse(req.body);
    const { order, audit } = await service.addRoomSupplement(id, body, {
      userId: req.user.sub,
      role,
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'ADD_ROOM_SUPPLEMENT',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: audit.orderNumber,
      before: { subtotal: audit.before.subtotal, total: audit.before.total },
      after: {
        subtotal: audit.after.subtotal,
        total: audit.after.total,
        perNightCny: audit.perNightCny,
        nights: audit.nights,
        amountCny: audit.amountCny,
        itemId: audit.itemId,
        note: audit.note,
        roomControl: audit.roomControl,
      },
      severity: 'WARNING',
    });
    return { order, roomControl: audit.roomControl };
  });

  // ── 订单详情补录结构化地面项（ADMIN/STAFF）──
  // 售价缺省时由后端按产品 costPriceCny 带出；收入与成本快照分开落库。
  app.post('/:id/items/ground', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可补录签证或房费' });
    }
    const { id } = req.params as { id: string };
    const body = addGroundItemBodySchema.parse(req.body);
    const { order, audit } = await service.addGroundItem(id, body, {
      userId: req.user.sub,
      role,
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'ADD_ORDER_GROUND_ITEM',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: audit.orderNumber,
      after: {
        kind: audit.kind,
        productId: audit.productId,
        itemId: audit.itemId,
        amountCny: audit.amountCny,
        unitPriceCny: audit.unitPriceCny,
        unitCostCny: audit.unitCostCny,
        totalCostCny: audit.totalCostCny,
        visaTaskCreated: audit.visaTaskCreated,
      },
      severity: 'WARNING',
    });
    return { order };
  });

  // ── 事后调价（0722 公测反馈「按乘客调价」；ADMIN/STAFF）──
  // POST /orders/:id/price-adjustment
  //   body: { amountCny: int≠0（正=补收/负=优惠）, reasonCode: DISCOUNT|MISC_FEE|CHANGE|OTHER,
  //           reasonText?: string, passengerId?: string }
  //   passengerId 非空 = 只作用于该乘客的应收份额（金额明细逐人可解释）；空 = 整单调价（现行为不变）。
  //   走与录单调价同一路径：追加一条 priceAdjustment 差额行，金额进 subtotal/total（订单总额 = 系统价 + Σ调整）。
  app.post('/:id/price-adjustment', { preHandler: [app.authenticate] }, async (req, reply) => {
    const role = req.user.role;
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可调整订单价格' });
    }
    const { id } = req.params as { id: string };
    const body = orderPriceAdjustmentBodySchema.parse(req.body);
    const { order, audit } = await service.addPriceAdjustment(id, body, {
      userId: req.user.sub,
      role,
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'ADD_ORDER_PRICE_ADJUSTMENT',
      targetType: 'ORDER',
      targetId: id,
      targetLabel: audit.orderNumber,
      before: { subtotal: audit.before.subtotal, total: audit.before.total },
      after: {
        subtotal: audit.after.subtotal,
        total: audit.after.total,
        amountCny: audit.amountCny,
        reasonCode: audit.reasonCode,
        reasonLabel: PRICE_ADJUSTMENT_REASON_LABEL[audit.reasonCode as keyof typeof PRICE_ADJUSTMENT_REASON_LABEL],
        // 对齐录单路径（ADJUST_ORDER_PRICE）审计键名：补齐说明文本，非 OTHER 原因常为 null。
        reasonText: body.reasonText?.trim() || null,
        // 归属乘客（整单调价为 null）；只记 id/姓名用于审计可读，不落证件级敏感数据。
        passengerId: audit.passengerId,
        passengerName: audit.passengerName,
        itemId: audit.itemId,
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
