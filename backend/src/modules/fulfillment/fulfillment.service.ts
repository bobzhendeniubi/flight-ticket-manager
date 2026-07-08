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
    // 乘客明细一次性取出（按 orderId），避免后续 VISA 任务 N+1 查乘客
    const [items, passengers] = await prisma.$transaction([
      prisma.orderItem.findMany({
        where: { orderId },
        include: { fulfillmentTasks: { orderBy: { createdAt: 'asc' } } },
      }),
      prisma.passenger.findMany({
        where: { orderId },
        select: { id: true, fullName: true, documentNumber: true, passportPhotoUrl: true },
      }),
    ]);
    const serializedPassengers = passengers.map(serializePassenger);
    return items.flatMap((it) =>
      it.fulfillmentTasks.map((t) => ({
        ...serializeTask(t, it),
        // 签证任务附带乘客护照明细；其他类型任务不返回（undefined 被 JSON 序列化忽略）
        ...(t.type === FulfillmentType.VISA_APPLICATION
          ? { passengers: serializedPassengers }
          : {}),
      })),
    );
  }

  /**
   * 按订单拉取乘客护照图（base64 data URL）—— 签证台展开某单时按需调用。
   * 列表接口为提速已不随行回传大图（仅 hasPhoto）；点开某单才用这里取真图，
   * 把「一次性数百 MB」摊薄成「按需一单几 MB」。
   */
  async listPassengerPhotos(orderId: string): Promise<Array<{ id: string; passportPhotoUrl: string | null }>> {
    const rows = await prisma.passenger.findMany({
      where: { orderId },
      select: { id: true, passportPhotoUrl: true },
    });
    return rows.map((p) => ({ id: p.id, passportPhotoUrl: p.passportPhotoUrl }));
  }

  async list(query: ListFulfillmentQuery) {
    const where: Prisma.FulfillmentTaskWhereInput = {};
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.assigneeUserId) where.assigneeUserId = query.assigneeUserId;
    if (query.orderItemId) where.orderItemId = query.orderItemId;
    if (query.orderId) where.orderItem = { orderId: query.orderId };

    // 性能（签证台加载慢根因修复）：
    // 旧实现在每行 task 的 order include 里嵌套 passengers[] + 关系排序的最早机票子查询，
    // 一页 200 条会放大成 200× 相关子查询（Prisma 对「嵌套关系排序 + take」逐父发查询 = N+1），
    // 且非签证任务也会白拉整单乘客。现改为：主查询只取轻量标量，出发日 / 乘客各用 1 条批量查询按 orderId 合并。
    const [rows, total] = await prisma.$transaction([
      prisma.fulfillmentTask.findMany({
        where,
        include: {
          orderItem: {
            include: {
              // 本签证 item 关联的签证产品（用于 #7：单次/多次签名称）
              visa: { select: { visaName: true } },
              order: {
                select: {
                  id: true,
                  orderNumber: true,
                  contactName: true,
                  contactPhone: true,
                  status: true,
                  notes: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.fulfillmentTask.count({ where }),
    ]);

    // 本页涉及的订单集合（去重）——用于批量取乘客 + 最早出发日
    const orderIds = [...new Set(rows.map((t) => t.orderItem.order.id))];
    // 仅签证任务需要乘客明细（UI 只在 VISA_APPLICATION 时读取 passengers）
    const visaOrderIds = [
      ...new Set(
        rows
          .filter((t) => t.type === FulfillmentType.VISA_APPLICATION)
          .map((t) => t.orderItem.order.id),
      ),
    ];

    type PassengerRow = {
      orderId: string;
      id: string;
      fullName: string;
      documentNumber: string;
      hasPhoto: boolean;
    };
    type FlightLegRow = {
      orderId: string;
      flightSchedule: { departureTime: Date; departureTz: string } | null;
    };
    const [passengerRows, flightLegRows] = await Promise.all([
      // 性能关键：护照图以 base64 data URL 落库（单人可达数 MB），列表页 200 行会放大成
      // 数百 MB 的响应体（读库 + 序列化 + 传输都被拖垮，签证台加载卡到分钟级）。
      // 这里改用原生 SQL 只在库内算出 hasPhoto（布尔），不把大字段拉到应用层；
      // 真图在用户展开某单时按 orderId 单独按需拉取（见 listPassengerPhotos）。
      visaOrderIds.length
        ? prisma.$queryRaw<PassengerRow[]>(Prisma.sql`
            SELECT "orderId", "id", "fullName", "documentNumber",
                   ("passportPhotoUrl" IS NOT NULL AND length("passportPhotoUrl") > 0) AS "hasPhoto"
            FROM "Passenger"
            WHERE "orderId" IN (${Prisma.join(visaOrderIds)})
          `)
        : Promise.resolve([] as PassengerRow[]),
      orderIds.length
        ? prisma.orderItem.findMany({
            where: {
              orderId: { in: orderIds },
              kind: OrderItemKind.FLIGHT,
              flightScheduleId: { not: null },
            },
            select: {
              orderId: true,
              flightSchedule: { select: { departureTime: true, departureTz: true } },
            },
            // 每个订单可能多段机票；下方按 orderId 归并时取最早出发
            orderBy: { flightSchedule: { departureTime: 'asc' } },
          })
        : Promise.resolve([] as FlightLegRow[]),
    ]);

    // orderId → 乘客列表
    const passengersByOrder = new Map<string, PassengerRow[]>();
    for (const p of passengerRows) {
      const list = passengersByOrder.get(p.orderId);
      if (list) list.push(p);
      else passengersByOrder.set(p.orderId, [p]);
    }
    // orderId → 最早一段机票行程（flightLegRows 已按出发升序，首个即最早）
    const earliestLegByOrder = new Map<string, { departureTime: Date; departureTz: string }>();
    for (const leg of flightLegRows) {
      const sched = leg.flightSchedule;
      if (sched && !earliestLegByOrder.has(leg.orderId)) {
        earliestLegByOrder.set(leg.orderId, {
          departureTime: sched.departureTime,
          departureTz: sched.departureTz,
        });
      }
    }

    return {
      tasks: rows.map((t) => {
        const order = t.orderItem.order;
        // 最早一段机票的出发时间/时区（无机票则 null）— 供签证台显示出发日期
        const firstLeg = earliestLegByOrder.get(order.id) ?? null;
        return {
          ...serializeTask(t, t.orderItem),
          // #7：本签证产品名称（单次/多次签等）置于任务顶层
          visaName: t.orderItem.visa?.visaName ?? null,
          order: {
            ...order,
            // #6：出发日期 + 时区（ISO 字符串 / null）
            departureTime: firstLeg ? firstLeg.departureTime.toISOString() : null,
            departureTz: firstLeg?.departureTz ?? null,
          },
          // 签证任务附带乘客明细（轻量）：仅名称/证件号/hasPhoto，不含护照大图。
          // 缺照标红只依赖 hasPhoto（库内算出，准确）；护照真图展开某单时按需拉取。
          ...(t.type === FulfillmentType.VISA_APPLICATION
            ? {
                passengers: (passengersByOrder.get(order.id) ?? []).map((p) => ({
                  id: p.id,
                  fullName: p.fullName,
                  documentNumber: p.documentNumber,
                  passportPhotoUrl: null as string | null,
                  hasPhoto: p.hasPhoto,
                })),
              }
            : {}),
        };
      }),
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

// ── Serializers ─────────────────────────────────────────────────
/**
 * 乘客护照摘要（签证台专用）。
 * hasPhoto: 是否已上传护照图 → 前端缺照标红。
 */
function serializePassenger(p: {
  id: string;
  fullName: string;
  documentNumber: string;
  passportPhotoUrl: string | null;
}) {
  return {
    id: p.id,
    fullName: p.fullName,
    documentNumber: p.documentNumber,
    passportPhotoUrl: p.passportPhotoUrl,
    hasPhoto: p.passportPhotoUrl !== null && p.passportPhotoUrl.length > 0,
  };
}

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
