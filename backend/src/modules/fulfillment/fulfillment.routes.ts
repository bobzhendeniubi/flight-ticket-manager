/**
 * 履约任务 API（ADMIN/STAFF）
 *
 * GET  /fulfillment-tasks            列表（按 order/status/type/notesQuery 过滤）
 * GET  /fulfillment-tasks/by-order/:orderId   某订单的全部任务
 * PATCH /fulfillment-tasks/:id       更新状态/PNR/确认号/司机等
 * POST /fulfillment-tasks/batch-status        批量改状态（签证批量"已送签"）
 * POST /fulfillment-tasks/batch-notes         批量改备注（独立于批量改状态）
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { FulfillmentService } from './fulfillment.service.js';
import {
  batchFulfillmentNotesBodySchema,
  batchFulfillmentStatusBodySchema,
  batchVisaPassengerStatusBodySchema,
  batchVisaTaskCostBodySchema,
  listFulfillmentQuerySchema,
  updateFulfillmentBodySchema,
  updateVisaPassengerStatusBodySchema,
} from './fulfillment.schemas.js';
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

  /**
   * GET /fulfillment-tasks/by-order/:orderId/passenger-photos
   *
   * 按需拉取某订单乘客的护照图（base64 data URL）。
   * 列表接口为提速不随行回传大图；签证台展开某单时才调这里取真图。
   */
  app.get('/by-order/:orderId/passenger-photos', pre, async (req) => {
    const { orderId } = req.params as { orderId: string };
    const photos = await service.listPassengerPhotos(orderId);
    return { photos };
  });

  app.patch('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateFulfillmentBodySchema.parse(req.body);
    const task = await service.update(id, body, actorFromRequest(req));

    // 签证金额/签证公司变更单列审计动作（与状态/备注变更区分，便于财务追溯成本来源）
    const isVisaCostChange =
      body.visaUnitCostUsd !== undefined ||
      body.visaFxRate !== undefined ||
      body.visaUnitCostCny !== undefined ||
      body.visaSupplier !== undefined;

    void writeAudit({
      actor: actorFromRequest(req),
      action: isVisaCostChange ? 'UPDATE_VISA_TASK_COST' : 'UPDATE_FULFILLMENT_TASK',
      targetType: 'ORDER',
      targetId: task.order.id,
      targetLabel: `${task.order.orderNumber} / ${task.type}`,
      after: isVisaCostChange
        ? {
            visaUnitCostUsd: task.visaUnitCostUsd,
            visaFxRate: task.visaFxRate,
            visaUnitCostCny: task.visaUnitCostCny,
            visaSupplier: task.visaSupplier,
          }
        : { status: task.status, data: task.data, notes: task.notes },
      severity: body.status === 'FAILED' ? 'WARNING' : 'INFO',
    });

    return { task };
  });

  /**
   * POST /fulfillment-tasks/batch-status
   *
   * 批量更新任务状态（如签证任务批量标"已送签"）。
   * 逐条复用单任务 update 的校验/副作用；partial failure 返回 failures 明细。
   */
  app.post('/batch-status', pre, async (req) => {
    const body = batchFulfillmentStatusBodySchema.parse(req.body);
    const result = await service.batchUpdateStatus(body.taskIds, body.toStatus);

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'BATCH_UPDATE_FULFILLMENT_STATUS',
      targetType: 'ORDER',
      targetId: 'batch',
      targetLabel: `${result.successCount}/${body.taskIds.length} tasks → ${body.toStatus}`,
      after: {
        toStatus: body.toStatus,
        requestedCount: body.taskIds.length,
        successCount: result.successCount,
        failureCount: result.failureCount,
      },
      severity: result.failureCount > 0 || body.toStatus === 'FAILED' ? 'WARNING' : 'INFO',
    });

    return result;
  });

  /**
   * POST /fulfillment-tasks/batch-notes
   *
   * 批量更新任务备注（独立于批量改状态，不动 status）。
   * 逐条复用单任务 update 的写入；partial failure 返回 failures 明细。
   */
  app.post('/batch-notes', pre, async (req) => {
    const body = batchFulfillmentNotesBodySchema.parse(req.body);
    const result = await service.batchUpdateNotes(body.taskIds, body.notes);

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'BATCH_UPDATE_FULFILLMENT_NOTES',
      targetType: 'ORDER',
      targetId: 'batch',
      targetLabel: `${result.successCount}/${body.taskIds.length} tasks notes updated`,
      after: {
        requestedCount: body.taskIds.length,
        successCount: result.successCount,
        failureCount: result.failureCount,
      },
      severity: result.failureCount > 0 ? 'WARNING' : 'INFO',
    });

    return result;
  });

  /**
   * POST /fulfillment-tasks/visa-cost/batch
   *
   * 批量给选中订单的签证任务设同一人均单价 / 同一签证公司（按航班统一单价是常态）。
   * 金额与签证公司互相独立：只带 visaSupplier 的调用不动金额，反之亦然。
   * 逐条复用单任务 update 的签证成本校验/折算；partial failure 返回 failures 明细。
   */
  app.post('/visa-cost/batch', pre, async (req) => {
    const { taskIds, ...cost } = batchVisaTaskCostBodySchema.parse(req.body);
    const result = await service.batchSetVisaCost(taskIds, cost);

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'BATCH_UPDATE_VISA_TASK_COST',
      targetType: 'ORDER',
      targetId: 'batch',
      targetLabel: `${result.successCount}/${taskIds.length} 签证任务批量设金额/签证公司`,
      after: {
        visaUnitCostUsd: cost.visaUnitCostUsd ?? null,
        visaFxRate: cost.visaFxRate ?? null,
        visaUnitCostCny: cost.visaUnitCostCny ?? null,
        visaSupplier: cost.visaSupplier ?? null,
        requestedCount: taskIds.length,
        successCount: result.successCount,
        failureCount: result.failureCount,
      },
      severity: result.failureCount > 0 ? 'WARNING' : 'INFO',
    });

    return result;
  });

  /**
   * PATCH /fulfillment-tasks/visa-passengers/:passengerId/status
   *
   * 按人更新送签进度（单个）。权限与其余签证台端点一致（ADMIN/STAFF）。
   * 内部改写乘客送签进度并重新派生该单签证任务状态。
   */
  app.patch('/visa-passengers/:passengerId/status', pre, async (req) => {
    const { passengerId } = req.params as { passengerId: string };
    const body = updateVisaPassengerStatusBodySchema.parse(req.body);
    const result = await service.updateVisaPassengerStatus(passengerId, body.status, actorFromRequest(req));

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_VISA_PASSENGER_STATUS',
      targetType: 'ORDER',
      targetId: result.orderId ?? passengerId,
      targetLabel: `乘客 ${passengerId.slice(0, 8)}… → ${body.status}`,
      after: { passengerId, status: body.status },
      severity: 'INFO',
    });

    return { result };
  });

  /**
   * POST /fulfillment-tasks/visa-passengers/batch-status
   *
   * 按人批量标记送签进度（部分送签核心入口）。逐乘客校验（存在/非自备签/父订单存活），
   * 通过者改写送签进度并按单重新派生任务状态；partial failure 返回 failures 明细。
   */
  app.post('/visa-passengers/batch-status', pre, async (req) => {
    const body = batchVisaPassengerStatusBodySchema.parse(req.body);
    const result = await service.batchUpdateVisaPassengerStatus(
      body.passengerIds,
      body.toStatus,
      actorFromRequest(req),
    );

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'BATCH_UPDATE_VISA_PASSENGER_STATUS',
      targetType: 'ORDER',
      targetId: 'batch',
      targetLabel: `${result.successCount}/${body.passengerIds.length} 乘客 → ${body.toStatus}`,
      after: {
        toStatus: body.toStatus,
        requestedCount: body.passengerIds.length,
        successCount: result.successCount,
        failureCount: result.failureCount,
        affectedOrderCount: result.affectedOrderIds.length,
      },
      severity: result.failureCount > 0 ? 'WARNING' : 'INFO',
    });

    return result;
  });

  /**
   * POST /fulfillment-tasks/:id/reissue
   *
   * 强制重新出票 — 清空 PNR、重置任务为 QUEUED、重新 enqueue。
   * 用于：供应商端故障 / PNR 作废 / 客户要求换座。
   */
  app.post('/:id/reissue', pre, async (req) => {
    const { id } = req.params as { id: string };
    const task = await service.reissue(id);

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'REISSUE_FULFILLMENT_TASK',
      targetType: 'ORDER',
      targetId: task.order.id,
      targetLabel: `${task.order.orderNumber} / ${task.type}`,
      severity: 'WARNING',
    });

    return { task };
  });

  /**
   * POST /fulfillment-tasks/by-order/:orderId/resend-itinerary
   *
   * 重新渲染 PDF 并重发邮件（不改任务状态）。
   * 返回 { orderNumber, result: { status, ... } } 让 UI 给出准确反馈。
   */
  app.post('/by-order/:orderId/resend-itinerary', pre, async (req) => {
    const { orderId } = req.params as { orderId: string };
    const { orderNumber, result } = await service.resendItinerary(orderId);

    // SMTP 未配置 / 部分未出票都是值得告警的异常情况
    const severity =
      result.status === 'sent' ? 'INFO'
        : result.status === 'not_all_ticketed' ? 'INFO'
          : 'WARNING'; // smtp_disabled / no_email / no_flights

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'RESEND_ITINERARY',
      targetType: 'ORDER',
      targetId: orderId,
      targetLabel: `${orderNumber} · ${result.status}`,
      after: result,
      severity,
    });

    return { orderNumber, result };
  });
};
