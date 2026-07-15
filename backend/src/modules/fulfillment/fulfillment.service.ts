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
import {
  FulfillmentStatus,
  FulfillmentType,
  OrderItemKind,
  OrderStatus,
  Prisma,
  VisaEntryType,
  VisaIssuanceMethod,
  VisaRequirement,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import type { ListFulfillmentQuery, UpdateFulfillmentBody } from './fulfillment.schemas.js';

/**
 * 计入履约任务列表 / 签证台的父订单状态——与订单/财务导出的 COUNTED_STATUSES 同一补集口径：
 * 排除 DRAFT（草稿未提交）/ PAYMENT_TIMEOUT（支付超时）/ CANCELLED（已取消）/
 * REFUNDED（已退款）/ FAILED（失败）这些"取消族"状态。
 * 订单一旦落入取消族，其履约任务（尤其签证送签）不应再残留在运营看板上。
 */
const COUNTED_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.REFUND_REQUESTED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

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

/**
 * 任务的有效签证分类（签发方式 / 入境次数）。
 *
 * 优先取签证产品的结构化字段；产品缺失（录单单子多为纯机票行，签证信息只落在
 * 订单级「签证状态」）时回退录单口径：visaStatus=E_VISA（电子签·三个月多次）
 * 视为 签发方式=电子签、入境次数=多次。签证台「签证类型」筛选与录单侧由此打通
 * （公测反馈：仅认产品字段时录单单子全部落入"未标注"，筛不出来）。
 */
export function effectiveVisaClassification(
  visa:
    | { issuanceMethod: VisaIssuanceMethod | null; entryType: VisaEntryType | null }
    | null
    | undefined,
  orderVisaStatus: VisaRequirement | null | undefined,
): { issuanceMethod: VisaIssuanceMethod | null; entryType: VisaEntryType | null } {
  const isOrderLevelEVisa = orderVisaStatus === VisaRequirement.E_VISA;
  return {
    issuanceMethod:
      visa?.issuanceMethod ?? (isOrderLevelEVisa ? VisaIssuanceMethod.E_VISA : null),
    entryType: visa?.entryType ?? (isOrderLevelEVisa ? VisaEntryType.MULTIPLE : null),
  };
}

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
        // 父订单已软删 / 落入取消族（见 COUNTED_STATUSES）时不返回其任务——
        // 避免已取消/已删订单的签证等任务残留在运营视图里。
        where: { orderId, order: { deletedAt: null, status: { in: COUNTED_STATUSES } } },
        include: {
          fulfillmentTasks: { orderBy: { createdAt: 'asc' } },
          // 本签证 item 关联的签证产品结构化分类（签发方式/入境次数），与 visaName 平级下发
          visa: { select: { visaName: true, issuanceMethod: true, entryType: true } },
          // 订单级录单签证状态 —— 产品结构化字段缺失时的分类回退来源
          order: { select: { visaStatus: true } },
        },
      }),
      prisma.passenger.findMany({
        // 自备签证乘客（visaExempt=true）不进签证台：客人自行办妥签证，无需送签。
        where: { orderId, visaExempt: false },
        select: { id: true, fullName: true, documentNumber: true, passportPhotoUrl: true },
      }),
    ]);
    const serializedPassengers = passengers.map(serializePassenger);
    return items.flatMap((it) => {
      // 分类回退：产品结构化字段缺失 → 订单级录单签证状态（E_VISA=电子签·多次）
      const visaClass = effectiveVisaClassification(it.visa, it.order.visaStatus);
      return it.fulfillmentTasks.map((t) => ({
        ...serializeTask(t, it),
        // 签证任务附带乘客护照明细 + 签证产品结构化分类；其他类型任务不返回
        // （undefined 被 JSON 序列化忽略）
        ...(t.type === FulfillmentType.VISA_APPLICATION
          ? {
              passengers: serializedPassengers,
              visaName: it.visa?.visaName ?? null,
              visaIssuanceMethod: visaClass.issuanceMethod,
              visaEntryType: visaClass.entryType,
            }
          : {}),
      }));
    });
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
    // 父订单已软删 / 落入取消族（见 COUNTED_STATUSES）时不进列表——
    // 签证台等运营看板不应残留已取消/已删订单的任务。
    // 注：orderItem 关系过滤单独成型再赋值（Prisma 的关系 where 是 XOR 联合类型，
    // 先赋后展开再并 orderId 会触发 TS2322，无法安全收窄）。
    const orderItemWhere: Prisma.OrderItemWhereInput = {
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    };
    if (query.orderId) orderItemWhere.orderId = query.orderId;

    const where: Prisma.FulfillmentTaskWhereInput = { orderItem: orderItemWhere };
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.assigneeUserId) where.assigneeUserId = query.assigneeUserId;
    if (query.orderItemId) where.orderItemId = query.orderItemId;
    if (query.notesQuery) where.notes = { contains: query.notesQuery, mode: 'insensitive' };

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
              // 本签证 item 关联的签证产品（用于 #7：单次/多次签名称 + 结构化签发方式/入境次数分类）
              visa: { select: { visaName: true, issuanceMethod: true, entryType: true } },
              order: {
                select: {
                  id: true,
                  orderNumber: true,
                  contactName: true,
                  contactPhone: true,
                  status: true,
                  notes: true,
                  // 订单级录单签证状态 —— 产品结构化字段缺失时的分类回退来源
                  visaStatus: true,
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
      lastName: string | null;
      firstName: string | null;
      chineseName: string | null;
      gender: string | null;
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
            SELECT "orderId", "id", "fullName", "lastName", "firstName",
                   "chineseName", "gender"::text AS "gender", "documentNumber",
                   ("passportPhotoUrl" IS NOT NULL AND length("passportPhotoUrl") > 0) AS "hasPhoto"
            FROM "Passenger"
            WHERE "orderId" IN (${Prisma.join(visaOrderIds)})
              AND "visaExempt" = false
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
        // 分类回退：产品结构化字段缺失 → 订单级录单签证状态（E_VISA=电子签·多次），
        // 签证台「签证类型」筛选/徽章两边口径由此对齐
        const visaClass = effectiveVisaClassification(t.orderItem.visa, order.visaStatus);
        return {
          ...serializeTask(t, t.orderItem),
          // #7：本签证产品名称（单次/多次签等）置于任务顶层
          visaName: t.orderItem.visa?.visaName ?? null,
          // 签证结构化分类（签发方式/入境次数）；产品与订单级都未标注 = null
          visaIssuanceMethod: visaClass.issuanceMethod,
          visaEntryType: visaClass.entryType,
          order: {
            ...order,
            // #6：出发日期 + 时区（ISO 字符串 / null）
            departureTime: firstLeg ? firstLeg.departureTime.toISOString() : null,
            departureTz: firstLeg?.departureTz ?? null,
          },
          // 签证任务附带乘客明细（轻量）：名称/姓名拆分/性别/证件号/hasPhoto，不含护照大图。
          // 缺照标红只依赖 hasPhoto（库内算出，准确）；护照真图展开某单时按需拉取。
          ...(t.type === FulfillmentType.VISA_APPLICATION
            ? {
                passengers: (passengersByOrder.get(order.id) ?? []).map((p) => ({
                  id: p.id,
                  fullName: p.fullName,
                  lastName: p.lastName,
                  firstName: p.firstName,
                  chineseName: p.chineseName,
                  gender: p.gender,
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
      include: { orderItem: { include: { order: { select: { status: true, deletedAt: true } } } } },
    });
    if (!existing) throw new NotFoundError('履约任务不存在');

    if (body.status !== undefined && body.status !== existing.status) {
      // CANCELLED 是终态，不许复活（终态化不变式的主写入口守卫，与 resetVisa / worker CAS 同口径）。
      if (existing.status === FulfillmentStatus.CANCELLED) {
        throw new ConflictError('任务已取消（终态），不可再改状态');
      }
      // 死单/软删单不许把任务写成活动态——否则 worker 可能给死单出票、或签证台复活隐藏任务。
      const ord = existing.orderItem.order;
      const toActive =
        body.status === FulfillmentStatus.PENDING ||
        body.status === FulfillmentStatus.IN_PROGRESS ||
        body.status === FulfillmentStatus.CONFIRMED;
      if (toActive && (ord.deletedAt || !COUNTED_STATUSES.includes(ord.status))) {
        throw new ConflictError(
          `父订单状态为 ${ord.status}${ord.deletedAt ? '（已在回收站）' : ''}，不可将任务改为活动态`,
        );
      }
    }

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
   * 批量改备注（独立于批量改状态，不动 status）。
   * 逐条复用 update() 的单任务写入；单条失败不影响其余，返回 failures 明细。
   * notes 允许空串（= 批量清空），与单条 PATCH notes 语义一致。
   */
  async batchUpdateNotes(
    taskIds: string[],
    notes: string,
  ): Promise<{
    successCount: number;
    failureCount: number;
    failures: Array<{ id: string; error: string }>;
  }> {
    let successCount = 0;
    const failures: Array<{ id: string; error: string }> = [];
    for (const id of taskIds) {
      try {
        await this.update(id, { notes });
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
      include: { orderItem: { include: { order: { select: { status: true, deletedAt: true } } } } },
    });
    if (!existing) throw new NotFoundError('履约任务不存在');
    if (existing.type !== FulfillmentType.FLIGHT_TICKETING) {
      throw new NotFoundError('reissue 仅支持 FLIGHT_TICKETING 任务');
    }
    // 父订单存活闸：已退款/取消/软删的订单不许重新出票——否则会给死单生成新 PNR、
    // 清空乘客票号、并给已退款客人发行程单邮件（接真实供应商即真金白银出票）。
    const parentOrder = existing.orderItem.order;
    if (parentOrder.deletedAt || !COUNTED_STATUSES.includes(parentOrder.status)) {
      throw new ConflictError(
        `订单当前状态为 ${parentOrder.status}${parentOrder.deletedAt ? '（已在回收站）' : ''}，不可重新出票`,
      );
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
      select: { id: true, orderNumber: true, contactEmail: true, status: true, deletedAt: true },
    });
    if (!order) throw new NotFoundError('订单不存在');
    // 死单/软删单不许重发行程单——不给已取消/退款客人发出行凭证。
    if (order.deletedAt || !COUNTED_STATUSES.includes(order.status)) {
      throw new ConflictError(
        `订单当前状态为 ${order.status}${order.deletedAt ? '（已在回收站）' : ''}，不可重发行程单`,
      );
    }
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
