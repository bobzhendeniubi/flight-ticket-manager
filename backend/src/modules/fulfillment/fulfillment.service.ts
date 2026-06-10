/**
 * 履约任务服务
 *
 * 任务由 orders.service 在订单 PAID 时自动创建（每个 OrderItem 一条）：
 *   FLIGHT  → FLIGHT_TICKETING
 *   HOTEL   → HOTEL_BOOKING
 *   VISA    → VISA_APPLICATION
 *   TRANSFER → TRANSFER_DISPATCH
 *   BUNDLE  → BUNDLE_COMPOSITE（简化：整条任务，未来拆子任务）
 *
 * MVP 同步实现：运营手动在 admin 里更新状态 + 数据。
 * V2 引入 BullMQ 后会变成自动触发供应商 API。
 */
import { FulfillmentStatus, FulfillmentType, OrderItemKind, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import type { ListFulfillmentQuery, UpdateFulfillmentBody } from './fulfillment.schemas.js';

const KIND_TO_TYPE: Record<OrderItemKind, FulfillmentType | null> = {
  FLIGHT: FulfillmentType.FLIGHT_TICKETING,
  HOTEL: FulfillmentType.HOTEL_BOOKING,
  VISA: FulfillmentType.VISA_APPLICATION,
  TRANSFER: FulfillmentType.TRANSFER_DISPATCH,
  BUNDLE: FulfillmentType.BUNDLE_COMPOSITE,
  INSURANCE: null,
  FEE: null,
  DISCOUNT: null,
  GUIDE: null, // 导游服务费收入：财务记账类，不触发履约
  UPGRADE_CHANGE: null, // 升舱/改期收入：财务记账类
  OVERSALE: null, // 超售收入：财务记账类
};

export class FulfillmentService {
  /**
   * 为订单的每个 item 创建任务（幂等 — 已有则跳过）。
   * 由 orders.service 在转 PAID 时调用。
   */
  async createTasksForOrder(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { id: true, kind: true, fulfillmentTasks: { select: { id: true } } },
    });
    let created = 0;
    for (const item of items) {
      const type = KIND_TO_TYPE[item.kind];
      if (!type) continue;
      if (item.fulfillmentTasks.length > 0) continue; // 已有
      await tx.fulfillmentTask.create({
        data: {
          orderItemId: item.id,
          type,
          status: FulfillmentStatus.PENDING,
        },
      });
      created++;
    }
    return created;
  }

  async listByOrder(orderId: string) {
    const items = await prisma.orderItem.findMany({
      where: { orderId },
      include: { fulfillmentTasks: { orderBy: { createdAt: 'asc' } } },
    });
    return items.flatMap((it) =>
      it.fulfillmentTasks.map((t) => serializeTask(t, it)),
    );
  }

  async list(query: ListFulfillmentQuery) {
    const where: Prisma.FulfillmentTaskWhereInput = {};
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.assigneeUserId) where.assigneeUserId = query.assigneeUserId;
    if (query.orderItemId) where.orderItemId = query.orderItemId;
    if (query.orderId) where.orderItem = { orderId: query.orderId };

    const [rows, total] = await prisma.$transaction([
      prisma.fulfillmentTask.findMany({
        where,
        include: { orderItem: { include: { order: { select: { id: true, orderNumber: true, contactName: true, contactPhone: true, status: true, notes: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.fulfillmentTask.count({ where }),
    ]);

    return {
      tasks: rows.map((t) => ({
        ...serializeTask(t, t.orderItem),
        order: t.orderItem.order,
      })),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  async update(id: string, body: UpdateFulfillmentBody) {
    const existing = await prisma.fulfillmentTask.findUnique({
      where: { id },
      include: { orderItem: true },
    });
    if (!existing) throw new NotFoundError('履约任务不存在');

    const data: Prisma.FulfillmentTaskUpdateInput = {};
    if (body.status !== undefined) {
      data.status = body.status;
      if (body.status === FulfillmentStatus.IN_PROGRESS && !existing.startedAt) {
        data.startedAt = new Date();
      }
      if (body.status === FulfillmentStatus.CONFIRMED || body.status === FulfillmentStatus.FAILED || body.status === FulfillmentStatus.CANCELLED) {
        data.completedAt = new Date();
      }
      if (body.status === FulfillmentStatus.IN_PROGRESS) {
        data.attempts = { increment: 1 };
      }
    }
    if (body.data !== undefined) {
      data.data = body.data as Prisma.InputJsonValue;
    }
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.assigneeUserId !== undefined) data.assigneeUserId = body.assigneeUserId;
    if (body.failureReason !== undefined) data.failureReason = body.failureReason;

    const updated = await prisma.fulfillmentTask.update({
      where: { id },
      data,
      include: { orderItem: { include: { order: { select: { id: true, orderNumber: true, contactName: true, contactPhone: true, status: true, notes: true } } } } },
    });

    // FLIGHT 完成时，把 PNR / e-ticket 同步到 Passenger（全订单的乘客都标）
    if (updated.type === FulfillmentType.FLIGHT_TICKETING && updated.status === FulfillmentStatus.CONFIRMED && updated.data) {
      const d = updated.data as { pnr?: string; eTicketNumber?: string };
      if (d.pnr || d.eTicketNumber) {
        await prisma.passenger.updateMany({
          where: { orderId: updated.orderItem.orderId },
          data: {
            pnr: d.pnr ?? undefined,
            eticketNumber: d.eTicketNumber ?? undefined,
          },
        });
      }
    }

    return {
      ...serializeTask(updated, updated.orderItem),
      order: updated.orderItem.order,
    };
  }

  /**
   * 批量更新任务状态（签证批量标"已送签"等场景）。
   * 逐条复用 update() 的单任务校验与副作用（startedAt/completedAt/attempts/PNR 同步），
   * 不另写一套规则；单条失败不影响其余，返回 failures 明细。
   */
  async batchUpdateStatus(
    taskIds: string[],
    toStatus: FulfillmentStatus,
  ): Promise<{
    successCount: number;
    failureCount: number;
    failures: Array<{ id: string; error: string }>;
  }> {
    let successCount = 0;
    const failures: Array<{ id: string; error: string }> = [];
    for (const id of taskIds) {
      try {
        await this.update(id, { status: toStatus });
        successCount += 1;
      } catch (err) {
        failures.push({ id, error: err instanceof Error ? err.message : '未知错误' });
      }
    }
    return { successCount, failureCount: failures.length, failures };
  }

  /**
   * 强制重新出票 — 清空结果数据、重置为 PENDING、重新 enqueue BullMQ。
   *
   * 只允许从 CONFIRMED / FAILED 发起（对应出了票想改座，或失败想重试）。
   * PENDING / IN_PROGRESS / CANCELLED 拒绝：前者说明还没到终态不需要 reissue；
   * IN_PROGRESS 若允许，会和当前正在跑的 worker job 并发出 2 个不同 PNR（重复出票风险）。
   */
  async reissue(id: string) {
    const existing = await prisma.fulfillmentTask.findUnique({
      where: { id },
      include: { orderItem: true },
    });
    if (!existing) throw new NotFoundError('履约任务不存在');
    if (existing.type !== FulfillmentType.FLIGHT_TICKETING) {
      throw new NotFoundError('reissue 仅支持 FLIGHT_TICKETING 任务');
    }
    if (
      existing.status !== FulfillmentStatus.CONFIRMED &&
      existing.status !== FulfillmentStatus.FAILED
    ) {
      throw new ConflictError(
        `任务当前状态 ${existing.status} 不可 reissue（仅 CONFIRMED / FAILED 允许重出票）`,
      );
    }

    // CAS — 只在状态仍是 CONFIRMED/FAILED 时清空并重排（防并发 reissue 造双 PNR）
    const upd = await prisma.fulfillmentTask.updateMany({
      where: {
        id,
        status: { in: [FulfillmentStatus.CONFIRMED, FulfillmentStatus.FAILED] },
      },
      data: {
        status: FulfillmentStatus.PENDING,
        startedAt: null,
        completedAt: null,
        failureReason: null,
        data: Prisma.JsonNull,
      },
    });
    if (upd.count === 0) {
      throw new ConflictError('并发 reissue 冲突，请刷新后重试');
    }

    const updated = await prisma.fulfillmentTask.findUniqueOrThrow({
      where: { id },
      include: { orderItem: { include: { order: { select: { id: true, orderNumber: true, contactName: true, contactPhone: true, status: true, notes: true } } } } },
    });

    // 同步清空本订单乘客的 PNR（出票成功后会重新写回）
    await prisma.passenger.updateMany({
      where: { orderId: updated.orderItem.orderId },
      data: { pnr: null, eticketNumber: null },
    });

    // 重新排队 — 用 jobId=taskId+时间戳 防和旧 job 碰撞
    const { fulfillmentQueue } = await import('../../queues/queue.js');
    await fulfillmentQueue.add(
      'auto-fulfill',
      { taskId: id },
      { jobId: `${id}:${Date.now()}`, delay: 500 },
    );

    return {
      ...serializeTask(updated, updated.orderItem),
      order: updated.orderItem.order,
    };
  }

  /**
   * 重发电子行程单。
   *
   * 返回结构化结果 —— UI 能准确告诉用户实际发生了什么：
   *   sent              : 邮件已真发送
   *   not_all_ticketed  : 多段订单部分未出票（运营需等全部出完再重发）
   *   smtp_disabled     : SMTP 未配置（demo/本地）—— 生产应告警
   *   no_email / no_flights : 订单状态不合法 —— 抛 400
   */
  async resendItinerary(orderId: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, contactEmail: true },
    });
    if (!order) throw new NotFoundError('订单不存在');
    if (!order.contactEmail) {
      throw new NotFoundError('订单没有联系邮箱，无法发送行程单');
    }

    const { sendItineraryEmail } = await import('../../lib/itinerary-email.js');
    const result = await sendItineraryEmail(orderId);
    return {
      orderNumber: order.orderNumber,
      result,
    };
  }
}

// ── Serializer ──────────────────────────────────────────────────
function serializeTask(
  t: {
    id: string; orderItemId: string; type: FulfillmentType; status: FulfillmentStatus;
    data: unknown; notes: string | null; attempts: number;
    scheduledAt: Date | null; startedAt: Date | null; completedAt: Date | null;
    failureReason: string | null; assigneeUserId: string | null;
    createdAt: Date; updatedAt: Date;
  },
  item: { id: string; kind: OrderItemKind; description: string; quantity: number; orderId: string },
) {
  return {
    id: t.id,
    orderItemId: t.orderItemId,
    type: t.type,
    status: t.status,
    data: t.data,
    notes: t.notes,
    attempts: t.attempts,
    scheduledAt: t.scheduledAt,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    failureReason: t.failureReason,
    assigneeUserId: t.assigneeUserId,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    item: {
      id: item.id,
      kind: item.kind,
      description: item.description,
      quantity: item.quantity,
      orderId: item.orderId,
    },
  };
}
