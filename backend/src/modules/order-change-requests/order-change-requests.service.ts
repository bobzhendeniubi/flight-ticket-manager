/**
 * 改单申请服务 —— 代理过了下单当天就提申请，运营一键执行。
 *
 * 分工与套餐改档申请（bundle-change-requests）完全同形：提交 / 驳回只动申请表，
 * 真正会改订单的动作**只发生在 approve()**，且一律回调运营侧既有通道
 * （改班次纠错 / 写签证状态 / 换酒店 / 升舱），不在这里另起一套写订单的逻辑。
 *
 * 一条要点：确认时执行失败（立减拒绝、座位被抢光、星级不匹配…）**不翻状态** ——
 * 申请仍是 PENDING 留在队列里，只把错误原文写进 applyError 并 400 吐给运营看，
 * 运营处理完前置问题（补座、改立减）后原样再点一次即可。
 */
import {
  CabinClass,
  OrderChangeKind,
  OrderChangeRequestStatus,
  OrderItemKind,
  Prisma,
  UserRole,
  VisaRequirement,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import { localDateISO } from '../../lib/flight-time.js';
import { determineFlightLegItems } from '../orders/ticketing-cap.js';
import { OrderService } from '../orders/orders.service.js';
import {
  cabinChangeSubmitSchema,
  flightChangeSubmitSchema,
  hotelChangeSubmitSchema,
  visaChangeSubmitSchema,
  type BatchApproveOrderChangeRequestBody,
  type BatchOrderChangeRequestBody,
  type CreateOrderChangeRequestBody,
  type DecideOrderChangeRequestBody,
  type ListOrderChangeRequestsQuery,
} from './order-change-requests.schemas.js';

// ── 文案常量（路由与测试共用，避免两处各写一句慢慢分叉）──────────────────────
export const ORDER_CHANGE_DUPLICATE_PENDING_MESSAGE = '该订单已有待处理的同类改单申请';
export const ORDER_CHANGE_VISA_HAS_VISA_MESSAGE = '「已签证」由签证岗确认，改单申请里改不了';
export const ORDER_CHANGE_BATCH_UNSUPPORTED_KIND_MESSAGE =
  '换酒店 / 升舱要按行选，只能单张单提交，不支持批量';
export const ORDER_CHANGE_REQUEST_REASON_TEXT = '改单申请（运营确认）';
/** 确认执行的处理中占位有效期：超过视为上次执行中途挂掉，允许再次确认。 */
export const APPROVE_CLAIM_TTL_MS = 2 * 60 * 1000;

const VISA_LABEL: Record<VisaRequirement, string> = {
  [VisaRequirement.NOT_NEEDED]: '不需要',
  [VisaRequirement.NEEDED]: '需要',
  [VisaRequirement.E_VISA]: '电子签',
  [VisaRequirement.HAS_VISA]: '已签证',
};

const CABIN_LABEL: Record<CabinClass, string> = {
  [CabinClass.ECONOMY]: '经济舱',
  [CabinClass.PREMIUM_ECONOMY]: '超级经济舱',
  [CabinClass.BUSINESS]: '商务舱',
  [CabinClass.FIRST]: '头等舱',
};

export interface OrderChangeRequestActor {
  userId: string;
  role: UserRole;
  agentId?: string;
}

/** 提交时要读的订单形状：够拼快照与摘要，不多读一列。 */
const SUBMIT_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  agentId: true,
  deletedAt: true,
  visaStatus: true,
  items: {
    select: {
      id: true,
      kind: true,
      flightScheduleId: true,
      flightCabin: true,
      hotelRoomTypeId: true,
      flightSchedule: {
        select: {
          id: true,
          departureTime: true,
          departureTz: true,
          flight: { select: { flightNumber: true } },
        },
      },
      hotelRoomType: {
        select: { id: true, name: true, hotel: { select: { name: true } } },
      },
    },
  },
} as const;

const REQUEST_INCLUDE = {
  agent: { select: { id: true, companyName: true, contactName: true } },
  order: { select: { orderNumber: true } },
} as const;

type OrderChangeRequestRow = {
  id: string;
  orderId: string;
  agentId: string | null;
  requestedById: string;
  batchId: string | null;
  kind: OrderChangeKind;
  payload: Prisma.JsonValue;
  summary: string;
  note: string | null;
  status: OrderChangeRequestStatus;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  appliedAt: Date | null;
  applyError: string | null;
  createdAt: Date;
  agent?: { id: string; companyName: string | null; contactName: string } | null;
  order?: { orderNumber: string } | null;
};

/** 确认 / 驳回后回给路由写审计的那份留痕（路由不再自己回查订单）。 */
interface DecisionAudit {
  orderId: string;
  orderNumber: string | null;
  requestedById: string;
  kind: OrderChangeKind;
  summary: string;
}

function serializeOrderChangeRequest(
  r: OrderChangeRequestRow,
  requestedByLabel: string | null = null,
) {
  return {
    id: r.id,
    orderId: r.orderId,
    orderNumber: r.order?.orderNumber ?? null,
    agentId: r.agentId,
    agentName: r.agent ? r.agent.companyName || r.agent.contactName : null,
    requestedById: r.requestedById,
    requestedByLabel,
    batchId: r.batchId,
    kind: r.kind,
    payload: r.payload,
    summary: r.summary,
    note: r.note,
    status: r.status,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    appliedAt: r.appliedAt?.toISOString() ?? null,
    applyError: r.applyError,
    createdAt: r.createdAt.toISOString(),
  };
}
export type SerializedOrderChangeRequest = ReturnType<typeof serializeOrderChangeRequest>;

/** 提交时算好的一条申请的「实质内容」：入库的 payload + 给人看的摘要。 */
interface ResolvedChange {
  payload: Prisma.InputJsonObject;
  summary: string;
}

type SubmitOrder = Prisma.OrderGetPayload<{ select: typeof SUBMIT_ORDER_SELECT }>;
type SubmitOrderItem = SubmitOrder['items'][number];

/** 住宿行名字：酒店 · 房型（两级都可能缺，缺就退化成有的那一半）。 */
function hotelLabel(
  hotelName: string | null | undefined,
  roomTypeName: string | null | undefined,
): string | null {
  return [hotelName, roomTypeName].filter(Boolean).join(' · ') || null;
}

export class OrderChangeRequestsService {
  constructor(private readonly orders: OrderService = new OrderService()) {}

  private async resolveOwnAgentId(userId: string): Promise<string> {
    const agent = await prisma.agent.findUnique({ where: { userId }, select: { id: true } });
    if (!agent) throw new ForbiddenError('当前用户不是代理');
    return agent.id;
  }

  private async visibleAgentIds(userId: string): Promise<string[]> {
    return getDescendantAgentIds(await this.resolveOwnAgentId(userId));
  }

  private assertOps(actor: OrderChangeRequestActor, what: string): void {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError(`仅运营/管理员可${what}改单申请`);
    }
  }

  // ── 提交 ──────────────────────────────────────────────────────────────────

  /**
   * 单张单提交：AGENT 只能对自家单提，运营可代提。
   * 同一订单同一 kind 已有 PENDING → 409（DB 侧还有一条部分唯一索引兜底并发）。
   */
  async create(
    actor: OrderChangeRequestActor,
    orderId: string,
    body: CreateOrderChangeRequestBody,
  ): Promise<SerializedOrderChangeRequest> {
    const ownAgentId = await this.resolveSubmitterAgentId(actor);
    const created = await this.insertRequest(actor, ownAgentId, orderId, body.kind, body.payload, {
      note: body.note,
      batchId: null,
    });
    return serializeOrderChangeRequest(created);
  }

  /**
   * 批量提交：一批订单同一类改动，共用一个 batchId。
   * 单张失败不拖垮整批 —— 逐单 try/catch，失败记 reason 继续下一张。
   */
  async createBatch(
    actor: OrderChangeRequestActor,
    body: BatchOrderChangeRequestBody,
  ): Promise<{
    batchId: string;
    created: number;
    skipped: number;
    results: Array<{
      orderId: string;
      orderNumber: string | null;
      ok: boolean;
      requestId?: string;
      reason?: string;
    }>;
  }> {
    // 换酒店 / 升舱要按「哪一行」选，批量给不出这个信息，直接拒。
    if (body.kind === OrderChangeKind.HOTEL || body.kind === OrderChangeKind.CABIN) {
      throw new BadRequestError(ORDER_CHANGE_BATCH_UNSUPPORTED_KIND_MESSAGE);
    }
    const ownAgentId = await this.resolveSubmitterAgentId(actor);
    const batchId = randomUUID();
    // 同一张单在入参里出现多次时只处理一次（第二次必然撞「已有待处理」，白吃一次事务）。
    const orderIds = Array.from(new Set(body.orderIds));

    const results: Array<{
      orderId: string;
      orderNumber: string | null;
      ok: boolean;
      requestId?: string;
      reason?: string;
    }> = [];
    for (const orderId of orderIds) {
      try {
        const created = await this.insertRequest(
          actor,
          ownAgentId,
          orderId,
          body.kind,
          body.payload,
          { note: body.note, batchId },
        );
        results.push({
          orderId,
          orderNumber: created.order?.orderNumber ?? null,
          ok: true,
          requestId: created.id,
        });
      } catch (err) {
        results.push({
          orderId,
          orderNumber: null,
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      batchId,
      created: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /** 提交人身份：AGENT 拿到自己的 agentId（后面按它比归属）；运营返回 null（可代提）。 */
  private async resolveSubmitterAgentId(actor: OrderChangeRequestActor): Promise<string | null> {
    if (actor.role === UserRole.AGENT) return this.resolveOwnAgentId(actor.userId);
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('无权限提交改单申请');
    }
    return null;
  }

  private async insertRequest(
    actor: OrderChangeRequestActor,
    ownAgentId: string | null,
    orderId: string,
    kind: OrderChangeKind,
    rawPayload: Record<string, unknown>,
    opts: { note?: string; batchId: string | null },
  ): Promise<OrderChangeRequestRow> {
    try {
      const created = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: SUBMIT_ORDER_SELECT,
        });
        if (!order || order.deletedAt) throw new NotFoundError('订单不存在');
        if (ownAgentId && order.agentId !== ownAgentId) {
          throw new ForbiddenError('只能对自己名下的订单提交改单申请');
        }

        const resolved = await this.resolveChange(tx, order, kind, rawPayload);

        const pending = await tx.orderChangeRequest.findFirst({
          where: { orderId, kind, status: OrderChangeRequestStatus.PENDING },
          select: { id: true },
        });
        if (pending) throw new ConflictError(ORDER_CHANGE_DUPLICATE_PENDING_MESSAGE);

        return tx.orderChangeRequest.create({
          data: {
            orderId,
            agentId: order.agentId,
            requestedById: actor.userId,
            batchId: opts.batchId,
            kind,
            payload: resolved.payload,
            summary: resolved.summary,
            note: opts.note?.trim() || null,
            status: OrderChangeRequestStatus.PENDING,
          },
          include: REQUEST_INCLUDE,
        });
      });
      return created as OrderChangeRequestRow;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError(ORDER_CHANGE_DUPLICATE_PENDING_MESSAGE);
      }
      throw err;
    }
  }

  // ── 各 kind 的入参解析 + 原值快照 ─────────────────────────────────────────

  private async resolveChange(
    tx: Prisma.TransactionClient,
    order: SubmitOrder,
    kind: OrderChangeKind,
    rawPayload: Record<string, unknown>,
  ): Promise<ResolvedChange> {
    switch (kind) {
      case OrderChangeKind.FLIGHT:
        return this.resolveFlightChange(tx, order, rawPayload);
      case OrderChangeKind.VISA:
        return this.resolveVisaChange(order, rawPayload);
      case OrderChangeKind.HOTEL:
        return this.resolveHotelChange(tx, order, rawPayload);
      case OrderChangeKind.CABIN:
        return this.resolveCabinChange(order, rawPayload);
      default:
        throw new BadRequestError('未知的改单类型');
    }
  }

  /** 按 itemId 或按航段（去程/回程）定位到本单的一条机票行。 */
  private resolveFlightItem(
    order: SubmitOrder,
    input: { itemId?: string; leg?: 'OUTBOUND' | 'RETURN' },
  ): { item: SubmitOrderItem; legLabel: string } {
    const flightItems = order.items.filter(
      (i) => i.kind === OrderItemKind.FLIGHT && i.flightScheduleId !== null,
    );
    const legs = determineFlightLegItems(flightItems);
    if (input.leg) {
      const picked = input.leg === 'OUTBOUND' ? legs.outbound : legs.return;
      if (!picked) {
        throw new BadRequestError(
          input.leg === 'OUTBOUND' ? '本单没有去程机票行' : '本单没有回程机票行',
        );
      }
      return { item: picked, legLabel: input.leg === 'OUTBOUND' ? '去程' : '回程' };
    }
    const item = flightItems.find((i) => i.id === input.itemId);
    if (!item) throw new BadRequestError('所选航段不是本订单的机票行');
    const legLabel =
      legs.outbound?.id === item.id ? '去程' : legs.return?.id === item.id ? '回程' : '航段';
    return { item, legLabel };
  }

  private async resolveFlightChange(
    tx: Prisma.TransactionClient,
    order: SubmitOrder,
    rawPayload: Record<string, unknown>,
  ): Promise<ResolvedChange> {
    const input = flightChangeSubmitSchema.parse(rawPayload);
    const { item, legLabel } = this.resolveFlightItem(order, input);
    if (item.flightScheduleId === input.newScheduleId) {
      throw new BadRequestError('目标班次与当前班次相同，无需申请');
    }

    const target = await tx.flightSchedule.findUnique({
      where: { id: input.newScheduleId },
      select: {
        id: true,
        departureTime: true,
        departureTz: true,
        isActive: true,
        flight: { select: { flightNumber: true } },
      },
    });
    if (!target) throw new NotFoundError('目标班次不存在');
    if (!target.isActive) throw new BadRequestError('目标班次已停用');

    const fromDepartureLocal = item.flightSchedule
      ? localDateISO(item.flightSchedule.departureTime, item.flightSchedule.departureTz)
      : null;
    const toDepartureLocal = localDateISO(target.departureTime, target.departureTz);
    const fromFlightNo = item.flightSchedule?.flight.flightNumber ?? '';
    const flightNo = target.flight.flightNumber;

    return {
      payload: {
        itemId: item.id,
        newScheduleId: target.id,
        fromScheduleId: item.flightScheduleId,
        fromDepartureLocal,
        toDepartureLocal,
        flightNo,
      },
      summary:
        `${legLabel} ${[fromDepartureLocal, fromFlightNo].filter(Boolean).join(' ')} → ` +
        `${[toDepartureLocal, flightNo].filter(Boolean).join(' ')}`,
    };
  }

  private resolveVisaChange(
    order: SubmitOrder,
    rawPayload: Record<string, unknown>,
  ): ResolvedChange {
    const input = visaChangeSubmitSchema.parse(rawPayload);
    // 「已签证」是签证岗确认出来的结果，不是谁想改就能改的录单选项（与自助改单同一条闸）。
    if (input.toVisaStatus === VisaRequirement.HAS_VISA) {
      throw new BadRequestError(ORDER_CHANGE_VISA_HAS_VISA_MESSAGE);
    }
    if (order.visaStatus === input.toVisaStatus) {
      throw new BadRequestError(`订单签证状态已经是「${VISA_LABEL[input.toVisaStatus]}」`);
    }
    const fromLabel = order.visaStatus ? VISA_LABEL[order.visaStatus] : '未填';
    return {
      payload: { toVisaStatus: input.toVisaStatus, fromVisaStatus: order.visaStatus },
      summary: `签证状态 ${fromLabel} → ${VISA_LABEL[input.toVisaStatus]}`,
    };
  }

  private async resolveHotelChange(
    tx: Prisma.TransactionClient,
    order: SubmitOrder,
    rawPayload: Record<string, unknown>,
  ): Promise<ResolvedChange> {
    const input = hotelChangeSubmitSchema.parse(rawPayload);
    const item = order.items.find((i) => i.id === input.itemId);
    if (!item) throw new BadRequestError('所选订单行不属于本订单');
    // 与换酒店通道同一条口径：HOTEL 行，或已落位的 BUNDLE 行。
    const isHotelRow =
      item.kind === OrderItemKind.HOTEL ||
      (item.kind === OrderItemKind.BUNDLE && item.hotelRoomTypeId != null);
    if (!isHotelRow) throw new BadRequestError('该行不含酒店，无法换酒店');
    if (item.hotelRoomTypeId === input.toHotelRoomTypeId) {
      throw new BadRequestError('目标房型与当前房型相同，无需更换');
    }

    const target = await tx.hotelRoomType.findUnique({
      where: { id: input.toHotelRoomTypeId },
      select: { id: true, name: true, hotel: { select: { name: true, isActive: true } } },
    });
    if (!target) throw new NotFoundError('目标酒店房型不存在');
    if (!target.hotel.isActive) throw new BadRequestError('目标酒店已下架');

    const fromHotelName = hotelLabel(item.hotelRoomType?.hotel.name, item.hotelRoomType?.name);
    const toHotelName = hotelLabel(target.hotel.name, target.name) ?? target.name;

    return {
      payload: {
        itemId: item.id,
        toHotelRoomTypeId: target.id,
        toHotelName,
        fromHotelName,
      },
      summary: `酒店 ${fromHotelName ?? '待落位'} → ${toHotelName}`,
    };
  }

  private resolveCabinChange(
    order: SubmitOrder,
    rawPayload: Record<string, unknown>,
  ): ResolvedChange {
    const input = cabinChangeSubmitSchema.parse(rawPayload);
    const item = order.items.find((i) => i.id === input.itemId);
    if (!item) throw new BadRequestError('所选订单行不属于本订单');
    if (item.kind !== OrderItemKind.FLIGHT) throw new BadRequestError('只有机票行可以升舱');
    const fromCabin = item.flightCabin ?? CabinClass.ECONOMY;
    if (fromCabin === CabinClass.BUSINESS) throw new BadRequestError('该航段已经是商务舱');

    return {
      payload: { itemId: item.id, toCabin: CabinClass.BUSINESS, fromCabin },
      summary: `${CABIN_LABEL[fromCabin]} → ${CABIN_LABEL[CabinClass.BUSINESS]}`,
    };
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────

  async list(
    actor: OrderChangeRequestActor,
    query: ListOrderChangeRequestsQuery,
  ): Promise<{ requests: SerializedOrderChangeRequest[]; nextCursor: string | null }> {
    const where: Prisma.OrderChangeRequestWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.kind) where.kind = query.kind;
    if (query.orderId) where.orderId = query.orderId;

    if (actor.role === UserRole.AGENT) {
      // 代理只看自己（含下级）的申请；显式传 agentId 时与可见集合取交集，越权筛不出别人的单。
      const visible = await this.visibleAgentIds(actor.userId);
      where.agentId = { in: query.agentId ? visible.filter((id) => id === query.agentId) : visible };
    } else if (actor.role === UserRole.ADMIN || actor.role === UserRole.STAFF) {
      if (query.agentId) where.agentId = query.agentId;
    } else {
      throw new ForbiddenError('无权限查看改单申请');
    }

    // 游标翻页：createdAt 降序 + id 降序兜同刻，游标取上一页最后一条的 id。
    const rows = (await prisma.orderChangeRequest.findMany({
      where,
      include: REQUEST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })) as OrderChangeRequestRow[];

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const labels = await this.requestedByLabels(page.map((r) => r.requestedById));

    return {
      requests: page.map((row) =>
        serializeOrderChangeRequest(row, labels.get(row.requestedById) ?? null),
      ),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** 提交人展示名：显示名 → 邮箱 → 手机号，都没有就留空（不建 FK，单独批量查一次）。 */
  private async requestedByLabels(userIds: string[]): Promise<Map<string, string>> {
    const ids = Array.from(new Set(userIds));
    if (ids.length === 0) return new Map();
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, email: true, phone: true },
    });
    return new Map(users.map((u) => [u.id, u.displayName || u.email || u.phone || ''] as const));
  }

  async pendingCount(actor: OrderChangeRequestActor): Promise<{ count: number }> {
    this.assertOps(actor, '查看待处理');
    const count = await prisma.orderChangeRequest.count({
      where: { status: OrderChangeRequestStatus.PENDING },
    });
    return { count };
  }

  // ── 确认 / 驳回 ───────────────────────────────────────────────────────────

  /**
   * 运营一键执行：占位 → 调既有通道 → 回填结果。
   * 执行失败一律翻成 400（把底层那句话原样带出来），申请留在 PENDING 并记 applyError。
   */
  async approve(
    actor: OrderChangeRequestActor,
    id: string,
    body: DecideOrderChangeRequestBody,
  ): Promise<{
    request: SerializedOrderChangeRequest;
    order: unknown;
    audit: DecisionAudit;
  }> {
    this.assertOps(actor, '确认');

    const claim = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          orderId: string;
          kind: OrderChangeKind;
          payload: Prisma.JsonValue;
          summary: string;
          status: OrderChangeRequestStatus;
          requestedById: string;
          decidedAt: Date | null;
        }>
      >`SELECT id, "orderId", kind, payload, summary, status, "requestedById", "decidedAt" FROM "OrderChangeRequest" WHERE id = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new NotFoundError('改单申请不存在');
      if (row.status !== OrderChangeRequestStatus.PENDING) {
        throw new ConflictError(`该申请当前状态为 ${row.status}，不可重复处理`);
      }
      // 处理中标记：status 仍是 PENDING（「一单一类一条待处理」的部分唯一索引在执行期间照样生效），
      // 只用 decidedAt 占位；占位超过 APPROVE_CLAIM_TTL_MS 视为上次执行中途挂掉，允许重试。
      if (row.decidedAt && Date.now() - row.decidedAt.getTime() < APPROVE_CLAIM_TTL_MS) {
        throw new ConflictError('该申请正在处理中，请稍后刷新查看结果');
      }

      const order = await tx.order.findUnique({
        where: { id: row.orderId },
        select: { id: true, orderNumber: true, deletedAt: true },
      });
      if (!order || order.deletedAt) throw new NotFoundError('订单不存在');

      await tx.orderChangeRequest.update({
        where: { id },
        data: {
          decidedById: actor.userId,
          decidedAt: new Date(),
          decisionNote: body.decisionNote?.trim() || null,
          applyError: null,
        },
      });

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        requestedById: row.requestedById,
        kind: row.kind,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        summary: row.summary,
      };
    });

    let order: unknown;
    try {
      order = await this.execute(claim.orderId, claim.kind, claim.payload, actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 没执行成 → 撤掉处理中标记、把原因记下来，申请原样留在队列里（状态一直是 PENDING）。
      await prisma.orderChangeRequest.updateMany({
        where: { id, status: OrderChangeRequestStatus.PENDING, appliedAt: null },
        data: { decidedById: null, decidedAt: null, decisionNote: null, applyError: message },
      });
      throw new BadRequestError(message);
    }

    await prisma.orderChangeRequest.update({
      where: { id },
      data: {
        status: OrderChangeRequestStatus.APPROVED,
        appliedAt: new Date(),
        applyError: null,
      },
    });

    const finalRow = (await prisma.orderChangeRequest.findUniqueOrThrow({
      where: { id },
      include: REQUEST_INCLUDE,
    })) as OrderChangeRequestRow;

    return {
      request: serializeOrderChangeRequest(finalRow),
      order,
      audit: {
        orderId: claim.orderId,
        orderNumber: claim.orderNumber,
        requestedById: claim.requestedById,
        kind: claim.kind,
        summary: claim.summary,
      },
    };
  }

  /**
   * 真正改订单的一步：一律回调运营侧既有通道，actor = 点确认的那个运营
   * （所以自助窗口闸、自助差价归零那套代理规则统统不适用，走的就是运营路径）。
   */
  private async execute(
    orderId: string,
    kind: OrderChangeKind,
    payload: Record<string, unknown>,
    actor: OrderChangeRequestActor,
  ): Promise<unknown> {
    const opsActor = { userId: actor.userId, role: actor.role, agentId: actor.agentId };
    switch (kind) {
      case OrderChangeKind.FLIGHT: {
        const { order } = await this.orders.correctFlightSchedule(
          orderId,
          String(payload.itemId),
          String(payload.newScheduleId),
          opsActor,
        );
        return order;
      }
      case OrderChangeKind.VISA: {
        const { order } = await this.orders.setOrderVisaStatus(
          orderId,
          payload.toVisaStatus as VisaRequirement,
          opsActor,
        );
        return order;
      }
      case OrderChangeKind.HOTEL: {
        const { order } = await this.orders.swapItemHotel(
          orderId,
          String(payload.itemId),
          {
            newHotelRoomTypeId: String(payload.toHotelRoomTypeId),
            // 改单申请永远不动钱：换酒店差价恒 0。
            feeCny: 0,
            note: ORDER_CHANGE_REQUEST_REASON_TEXT,
          },
          opsActor,
        );
        return order;
      }
      case OrderChangeKind.CABIN: {
        const { order } = await this.orders.upgradeOrderItemCabin(
          orderId,
          String(payload.itemId),
          { note: ORDER_CHANGE_REQUEST_REASON_TEXT },
          opsActor,
        );
        return order;
      }
      default:
        throw new BadRequestError('未知的改单类型');
    }
  }

  /** 批量确认：逐条串行执行（每条都会真改订单，不能并发抢同一批座位）。 */
  async batchApprove(
    actor: OrderChangeRequestActor,
    body: BatchApproveOrderChangeRequestBody,
  ): Promise<{
    approved: number;
    failed: number;
    results: Array<{ id: string; ok: boolean; error?: string }>;
    approvedRequests: Array<{ request: SerializedOrderChangeRequest; audit: DecisionAudit }>;
  }> {
    this.assertOps(actor, '确认');
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    const approvedRequests: Array<{ request: SerializedOrderChangeRequest; audit: DecisionAudit }> =
      [];

    for (const id of Array.from(new Set(body.ids))) {
      try {
        const { request, audit } = await this.approve(actor, id, {});
        results.push({ id, ok: true });
        approvedRequests.push({ request, audit });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      approved: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
      approvedRequests,
    };
  }

  async reject(
    actor: OrderChangeRequestActor,
    id: string,
    body: DecideOrderChangeRequestBody,
  ): Promise<{ request: SerializedOrderChangeRequest; audit: DecisionAudit }> {
    this.assertOps(actor, '驳回');

    const updated = (await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; status: OrderChangeRequestStatus }>
      >`SELECT id, status FROM "OrderChangeRequest" WHERE id = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new NotFoundError('改单申请不存在');
      if (row.status !== OrderChangeRequestStatus.PENDING) {
        throw new ConflictError(`该申请当前状态为 ${row.status}，不可重复处理`);
      }
      return tx.orderChangeRequest.update({
        where: { id },
        data: {
          status: OrderChangeRequestStatus.REJECTED,
          decidedById: actor.userId,
          decidedAt: new Date(),
          decisionNote: body.decisionNote?.trim() || null,
        },
        include: REQUEST_INCLUDE,
      });
    })) as OrderChangeRequestRow;

    return {
      request: serializeOrderChangeRequest(updated),
      audit: {
        orderId: updated.orderId,
        orderNumber: updated.order?.orderNumber ?? null,
        requestedById: updated.requestedById,
        kind: updated.kind,
        summary: updated.summary,
      },
    };
  }
}
