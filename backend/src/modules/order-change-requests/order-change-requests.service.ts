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
import {
  computeCabinUpgradeDiffCny,
  computeSwapHotelCostSnapshot,
  isScheduleDeparted,
  ORDER_STATUS_LABEL_ZH,
  OrderService,
  SEAT_HOLDING_STATUSES,
} from '../orders/orders.service.js';
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
/**
 * 确认执行的处理中占位有效期：超过视为上次执行中途挂掉，允许再次确认。
 *
 * 定 5 分钟而不是 2 分钟：真正执行的那几条通道（换酒店要逐晚校验房量、改班次要搬座位并
 * 重算立减、升舱要放旧座拿新座）在大单上跑满一两分钟是正常的。占位过早失效，第二个运营
 * 点下去就会与仍在执行的那次撞车 —— 同一条申请被执行两遍。宁可让「真挂掉」的那条多等
 * 三分钟，也不能让并发执行溜进来。
 */
export const APPROVE_CLAIM_TTL_MS = 5 * 60 * 1000;
/** 按航段（去程/回程）定位时撞上已释放座位的航段：绝不退而求其次落到另一段上。 */
export const ORDER_CHANGE_RELEASED_LEG_MESSAGE = '该航段座位已释放，无法按航段申请';
/** 确认时目标班次已停售 / 已起飞（提交到确认之间班次变了）。 */
export const ORDER_CHANGE_STALE_SCHEDULE_MESSAGE = '目标班次已停售或已起飞，请驳回后重新申请';
/** 确认时发现订单早已是申请里的目标状态（上次执行成功但回写状态没落地）。 */
export const ORDER_CHANGE_ALREADY_APPLIED_NOTE = '已按申请内容生效（重试时发现已执行）';
/** 有人正在执行这条申请时点驳回。 */
export const ORDER_CHANGE_REJECT_IN_FLIGHT_MESSAGE = '该申请正在执行中，请稍后刷新';
/** 执行方式（纠错 / 按售后改期）只对改班次申请有意义，别的 kind 传了一律拒（不静默忽略）。 */
export const ORDER_CHANGE_EXECUTION_KIND_MESSAGE = '只有改班次申请可以选择执行方式';
/** 按售后改期执行时写进确认备注的留痕前缀（申请表没有单独的「执行方式」列）。 */
export const ORDER_CHANGE_AFTER_SALES_APPLIED_NOTE = '按售后改期执行';
/** 售后改期路径下缺省的费用名目（与改期表单缺省一致）。 */
export const ORDER_CHANGE_RESCHEDULE_FEE_LABEL = '改期费';
/** 收尾回写状态时发现申请已被别的操作改掉（驳回/另一次确认）。 */
export const ORDER_CHANGE_STATUS_RACED_MESSAGE = '申请状态已被其他操作改变';
/** 收尾回写状态的重试次数：连接抖动/瞬时超时不该让「订单已改完」的单卡在 PENDING。 */
const FINAL_STATUS_WRITE_MAX_ATTEMPTS = 3;
/** 成本字段只给运营看：代理拿到的 payload 里这几个键一律抹掉。 */
const OPS_ONLY_PAYLOAD_KEYS = ['costBeforeCny', 'costAfterCny'] as const;

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
  // 占座态闸要用（非占座态的单提了也执行不了，见 insertRequest）。
  status: true,
  visaStatus: true,
  items: {
    select: {
      id: true,
      kind: true,
      // 升舱差价 = 每人每航段 × 该行人数；换酒店成本 = 每间每晚 × 晚数(quantity) × 房数。
      quantity: true,
      roomsBilled: true,
      totalCostCny: true,
      flightScheduleId: true,
      flightCabin: true,
      hotelRoomTypeId: true,
      flightSchedule: {
        select: {
          id: true,
          departureTime: true,
          departureTz: true,
          flight: { select: { flightNumber: true, businessUpgradeCnyPerLeg: true } },
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
  /**
   * 本次改班次申请走的执行方式（非 FLIGHT 恒为 CORRECTION —— 那几类通道本来就不动钱）。
   * 审计里必须落这一笔：同一条申请按纠错执行还是按售后改期执行，差的是一笔真金白银。
   */
  executionMode?: OrderChangeExecutionMode;
  /** 按售后改期执行时实收的改期费（CNY）；纠错执行为 0。驳回不带（null）。 */
  executionFeeCny?: number | null;
}

/** 执行方式：纠错（不动钱，缺省）/ 按售后改期（收改期费、撤立减、推状态）。 */
type OrderChangeExecutionMode = 'CORRECTION' | 'AFTER_SALES';

/** payload 里读一个数字字段；缺失 / 不是有限数一律 null（老申请没有这些快照键）。 */
function readPayloadNumber(payload: Prisma.JsonValue, key: string): number | null {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 代理侧的 payload：抹掉成本快照键（我方进价，对外身份一个字都不给）。 */
function stripOpsOnlyPayload(payload: Prisma.JsonValue): Prisma.JsonValue {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const rest = { ...(payload as Record<string, unknown>) };
  for (const key of OPS_ONLY_PAYLOAD_KEYS) delete rest[key];
  return rest as Prisma.JsonValue;
}

/**
 * 序列化一条申请。
 *
 * 两个派生金额字段：
 *   · amountCny —— 升舱补差（CABIN），**所有角色都看得到**：这笔钱最终由代理的客人出，
 *     提交时就该白纸黑字写清楚，不能等运营点完确认才冒出来。
 *   · costDeltaCny —— 换酒店的成本变动（HOTEL），**只给运营**：那是我方进价，
 *     代理侧连 payload 里的成本快照键都一并抹掉（见 stripOpsOnlyPayload）。
 */
function serializeOrderChangeRequest(
  r: OrderChangeRequestRow,
  opts: { requestedByLabel?: string | null; canSeeCost: boolean },
) {
  const costBefore = readPayloadNumber(r.payload, 'costBeforeCny');
  const costAfter = readPayloadNumber(r.payload, 'costAfterCny');
  const costDeltaCny =
    opts.canSeeCost && r.kind === OrderChangeKind.HOTEL && costBefore != null && costAfter != null
      ? costAfter - costBefore
      : null;
  return {
    id: r.id,
    orderId: r.orderId,
    orderNumber: r.order?.orderNumber ?? null,
    agentId: r.agentId,
    agentName: r.agent ? r.agent.companyName || r.agent.contactName : null,
    requestedById: r.requestedById,
    requestedByLabel: opts.requestedByLabel ?? null,
    batchId: r.batchId,
    kind: r.kind,
    payload: opts.canSeeCost ? r.payload : stripOpsOnlyPayload(r.payload),
    summary: r.summary,
    note: r.note,
    status: r.status,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    appliedAt: r.appliedAt?.toISOString() ?? null,
    applyError: r.applyError,
    createdAt: r.createdAt.toISOString(),
    amountCny: r.kind === OrderChangeKind.CABIN ? readPayloadNumber(r.payload, 'diffCny') : null,
    costDeltaCny,
  };
}

/** 运营（含管理员）才看得到成本。 */
function canSeeCost(actor: OrderChangeRequestActor): boolean {
  return actor.role === UserRole.ADMIN || actor.role === UserRole.STAFF;
}

/** 金额千分位（¥4,800）：摘要是给人看的，别把裸数字甩上去。 */
function formatCny(amount: number): string {
  return amount.toLocaleString('en-US');
}

/** Prisma Decimal / number / null → number | null（两种形态都可能，统一走 toString）。 */
function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(String(value));
  return Number.isFinite(n) ? n : null;
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
    return serializeOrderChangeRequest(created, { canSeeCost: canSeeCost(actor) });
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
        // 占座态闸：改班次/换酒店/升舱在执行侧都要求订单当前真的持有座位与履约（各通道自带同一道闸）。
        // 非占座态（已取消/已退款/超时/草稿…）的单提上来，运营点确认时必然被底层拒掉 ——
        // 与其攒一队执行不了的申请，不如提交这一刻就说清楚。
        if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
          throw new BadRequestError(
            `订单当前状态（${ORDER_STATUS_LABEL_ZH[order.status] ?? order.status}）不可提交改单申请`,
          );
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
      // ── 已释放航段：绝不退而求其次落到另一段上 ────────────────────────────────
      // determineFlightLegItems 是「按出发时刻排序取前两条**有班次**的行」：no-show 释放 /
      // 取消航段会把那一行的 flightScheduleId 置空（座位已放回库存），该行随即退出判定 ——
      // 于是回程行会顶上来变成 legs.outbound。批量按航段提交时，这等于把「改去程」
      // 静默改到了回程头上。本单只要还有一条座位已释放的机票行，就一律拒，不猜。
      const hasReleasedLeg = order.items.some(
        (i) => i.kind === OrderItemKind.FLIGHT && i.flightScheduleId === null,
      );
      if (hasReleasedLeg) throw new BadRequestError(ORDER_CHANGE_RELEASED_LEG_MESSAGE);
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
      select: {
        id: true,
        name: true,
        costPriceCny: true,
        hotel: { select: { name: true, isActive: true } },
      },
    });
    if (!target) throw new NotFoundError('目标酒店房型不存在');
    if (!target.hotel.isActive) throw new BadRequestError('目标酒店已下架');

    const fromHotelName = hotelLabel(item.hotelRoomType?.hotel.name, item.hotelRoomType?.name);
    const toHotelName = hotelLabel(target.hotel.name, target.name) ?? target.name;

    // ── 成本快照（只给运营看）：换酒店「差价恒 0」说的是**卖价**，我方进价该换是要换的。
    // 口径与 swapItemHotel 的重打快照一字不差：HOTEL 行 = 新房型成本价 × 晚数(quantity) × 房数；
    // BUNDLE 行建单时没快照过酒店成本（totalCostCny 覆盖整包），换酒店也不重算 → 前后一致。
    const roomsBilled = toNumberOrNull(item.roomsBilled) ?? 1;
    const costBeforeCny = toNumberOrNull(item.totalCostCny);
    const costAfterCny =
      item.kind === OrderItemKind.HOTEL
        ? computeSwapHotelCostSnapshot({
            newCostPriceCny: toNumberOrNull(target.costPriceCny),
            nights: item.quantity,
            rooms: roomsBilled,
          }).totalCostCny
        : costBeforeCny;

    return {
      payload: {
        itemId: item.id,
        toHotelRoomTypeId: target.id,
        toHotelName,
        fromHotelName,
        costBeforeCny,
        costAfterCny,
      },
      // 摘要不带成本 —— 它是所有角色共用的一句话，成本走 costDeltaCny（运营专属）。
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
    if (!item.flightScheduleId) throw new BadRequestError(ORDER_CHANGE_RELEASED_LEG_MESSAGE);
    const fromCabin = item.flightCabin ?? CabinClass.ECONOMY;
    if (fromCabin === CabinClass.BUSINESS) throw new BadRequestError('该航段已经是商务舱');

    // ── 补差要在提交这一刻算清楚并写进摘要 ──────────────────────────────────────
    // 升舱是这四类改单里**唯一动钱**的一类：执行时 upgradeOrderItemCabin 会按
    // 「每人每航段差价 × 该行人数」抬 total，这笔钱最终由代理的客人出。
    // 不在申请上写明金额，等于让人闭眼签字。取价口径与执行侧同一个纯函数。
    const diffCny = computeCabinUpgradeDiffCny(
      item.flightSchedule?.flight.businessUpgradeCnyPerLeg ?? 0,
      item.quantity,
    );
    if (diffCny <= 0) {
      // 与升舱通道同一句话：没配差价就没法报价，先去航班管理补，别攒一条执行不了的申请。
      throw new BadRequestError('该航班未配置商务舱差价，请先在航班管理维护');
    }

    return {
      payload: { itemId: item.id, toCabin: CabinClass.BUSINESS, fromCabin, diffCny },
      summary:
        `${CABIN_LABEL[fromCabin]} → ${CABIN_LABEL[CabinClass.BUSINESS]}` +
        `（补差 ¥${formatCny(diffCny)}）`,
    };
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────

  async list(
    actor: OrderChangeRequestActor,
    query: ListOrderChangeRequestsQuery,
  ): Promise<{ requests: SerializedOrderChangeRequest[]; nextCursor: string | null }> {
    const where: Prisma.OrderChangeRequestWhereInput = {};
    // status 不按角色分档：代理提完申请要能回来看「运营到底确认了还是驳回了、备注写了什么」，
    // 只筛得到 PENDING 等于把处理结果藏起来。可见范围仍由下面的 agentId 收口。
    if (query.status) where.status = query.status;
    if (query.kind) where.kind = query.kind;
    if (query.orderId) where.orderId = query.orderId;
    // since：只要这个时间点之后新建的申请（代理侧轮询「我这批单有没有新结果」用）。
    if (query.since) where.createdAt = { gte: query.since };

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

    const cost = canSeeCost(actor);
    return {
      requests: page.map((row) =>
        serializeOrderChangeRequest(row, {
          requestedByLabel: labels.get(row.requestedById) ?? null,
          canSeeCost: cost,
        }),
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
      // 执行方式只有改班次申请认（签证/换酒店/升舱各有各的既有口径，没有「按售后改期收费」这回事）。
      // 传错了直接拒，不静默按纠错执行 —— 运营以为收了改期费、系统一分没收，是最坏的一种沉默。
      if (body.execution && row.kind !== OrderChangeKind.FLIGHT) {
        throw new BadRequestError(ORDER_CHANGE_EXECUTION_KIND_MESSAGE);
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

    const opsActor = { userId: actor.userId, role: actor.role, agentId: actor.agentId };
    // 执行方式：缺省纠错（历史行为）；只有 FLIGHT 能是 AFTER_SALES（上面的闸已保证）。
    const executionMode: OrderChangeExecutionMode = body.execution?.mode ?? 'CORRECTION';
    const executionFeeCny = executionMode === 'AFTER_SALES' ? (body.execution?.feeCny ?? 0) : 0;

    // ── 幂等：订单早已是申请里的目标状态 → 不再执行第二遍 ──────────────────────
    // 成因是「执行成功了，但收尾回写状态那一步没落地」（进程被杀、连接断在中间）：
    // 申请还挂在 PENDING，运营看队列里还有一条就会再点一次。真的再执行一遍就是
    // 第二次搬座位 / 第二次抬 total。先对一遍现状，对上了就只补状态。
    const alreadyApplied = await this.detectAlreadyApplied(claim.orderId, claim.kind, claim.payload);

    let order: unknown;
    if (alreadyApplied) {
      order = await this.orders.getOrder(claim.orderId, opsActor);
    } else {
      try {
        order = await this.execute(claim.orderId, claim.kind, claim.payload, actor, body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 没执行成 → 撤掉处理中标记、把原因记下来，申请原样留在队列里（状态一直是 PENDING）。
        await prisma.orderChangeRequest.updateMany({
          where: { id, status: OrderChangeRequestStatus.PENDING, appliedAt: null },
          data: { decidedById: null, decidedAt: null, decisionNote: null, applyError: message },
        });
        throw new BadRequestError(message);
      }
    }

    // ── 确认备注的留痕 ────────────────────────────────────────────────────────
    // 幂等分支要把「这次没真执行」写进备注（运营在队列里一眼看得出）；
    // 按售后改期执行的也要写一句（申请表没有「执行方式」列，队列回看只有这一处能看出
    // 这条申请到底收没收改期费）。正常纠错分支的备注在占位那一步已经写过，不重复覆盖。
    const afterSalesNote =
      !alreadyApplied && executionMode === 'AFTER_SALES'
        ? `${ORDER_CHANGE_AFTER_SALES_APPLIED_NOTE}（${ORDER_CHANGE_RESCHEDULE_FEE_LABEL} ¥${formatCny(executionFeeCny)}）`
        : null;
    const noteParts = [
      alreadyApplied ? ORDER_CHANGE_ALREADY_APPLIED_NOTE : null,
      afterSalesNote,
      body.decisionNote?.trim() || null,
    ].filter(Boolean);
    const decisionNoteOverride =
      alreadyApplied || afterSalesNote ? noteParts.join('；') : undefined;
    await this.finalizeApproved(id, decisionNoteOverride);

    const finalRow = (await prisma.orderChangeRequest.findUniqueOrThrow({
      where: { id },
      include: REQUEST_INCLUDE,
    })) as OrderChangeRequestRow;

    return {
      request: serializeOrderChangeRequest(finalRow, { canSeeCost: canSeeCost(actor) }),
      order,
      audit: {
        orderId: claim.orderId,
        orderNumber: claim.orderNumber,
        requestedById: claim.requestedById,
        kind: claim.kind,
        summary: claim.summary,
        executionMode,
        // 幂等分支这次并没有真执行，也就没收钱 —— 别在审计里记一笔并不存在的改期费。
        executionFeeCny: alreadyApplied ? 0 : executionFeeCny,
      },
    };
  }

  /**
   * 收尾回写状态：条件更新（status 仍是 PENDING 才写），并对瞬时失败重试。
   *
   * 用 updateMany 而不是 update：到这一步订单已经真的改完了，如果此刻申请行被并发的
   * 驳回 / 另一次确认翻走，无条件 update 会把别人的决定悄悄盖掉。条件不命中 → 409 留声，
   * 让运营回队列核对这张单（订单侧的改动是已生效的事实，不会因为这条 409 回滚）。
   */
  private async finalizeApproved(id: string, decisionNoteOverride?: string | null): Promise<void> {
    const data = {
      status: OrderChangeRequestStatus.APPROVED,
      appliedAt: new Date(),
      applyError: null,
      ...(decisionNoteOverride !== undefined ? { decisionNote: decisionNoteOverride } : {}),
    };
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= FINAL_STATUS_WRITE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const { count } = await prisma.orderChangeRequest.updateMany({
          where: { id, status: OrderChangeRequestStatus.PENDING },
          data,
        });
        if (count === 0) {
          console.error('[order-change-requests] 收尾回写状态未命中 PENDING（并发驳回/重复确认）', {
            requestId: id,
          });
          throw new ConflictError(ORDER_CHANGE_STATUS_RACED_MESSAGE);
        }
        return;
      } catch (err) {
        if (err instanceof ConflictError) throw err;
        // 瞬时错误（连接抖动 / 超时）：订单侧的改动**已经落库**，这一步放弃就会留下
        // 「订单改了、申请还在 PENDING」的脏队列 —— 多试两次比留脏账划算。
        lastError = err;
        console.error('[order-change-requests] 收尾回写状态失败，第', attempt, '次', err);
      }
    }
    throw lastError;
  }

  /**
   * 订单当前是不是**已经**是申请里的目标状态（幂等重试判定）。
   * 只对最终态取值，不看过程：目标班次/目标房型/目标签证状态/已是商务舱。
   */
  private async detectAlreadyApplied(
    orderId: string,
    kind: OrderChangeKind,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    if (kind === OrderChangeKind.VISA) {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { visaStatus: true },
      });
      return order?.visaStatus != null && order.visaStatus === payload.toVisaStatus;
    }
    const itemId = typeof payload.itemId === 'string' ? payload.itemId : null;
    if (!itemId) return false;
    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      select: { orderId: true, flightScheduleId: true, hotelRoomTypeId: true, flightCabin: true },
    });
    // 行已经不在这张单上（被拆走/删了）→ 不算「已生效」，交给通道自己报错。
    if (!item || item.orderId !== orderId) return false;
    switch (kind) {
      case OrderChangeKind.FLIGHT:
        return item.flightScheduleId != null && item.flightScheduleId === payload.newScheduleId;
      case OrderChangeKind.HOTEL:
        return item.hotelRoomTypeId != null && item.hotelRoomTypeId === payload.toHotelRoomTypeId;
      case OrderChangeKind.CABIN:
        return item.flightCabin === CabinClass.BUSINESS;
      default:
        return false;
    }
  }

  /**
   * 改班次执行前复检目标班次：提交到确认之间隔着几小时甚至几天，班次可能已经停售或已起飞。
   * 提交时那一刻的快照不作数，执行前一律重读现状（与 payload 只作展示留痕的口径一致）。
   *
   * 「已起飞」判定复用改期入口同一份 isScheduleDeparted；改单申请执行**永不放行**已起飞的
   * 目标班次（下游 correctFlightSchedule 也不会收到 allowDepartedTarget，两层都拒）。
   */
  private async assertTargetScheduleStillUsable(scheduleId: string): Promise<void> {
    const target = await prisma.flightSchedule.findUnique({
      where: { id: scheduleId },
      select: { id: true, isActive: true, departureTime: true },
    });
    if (!target || !target.isActive || isScheduleDeparted(target)) {
      throw new BadRequestError(ORDER_CHANGE_STALE_SCHEDULE_MESSAGE);
    }
  }

  /**
   * 升舱执行前复检补差：申请上写的金额是代理（和他的客人）看过并认下的那个数。
   * 航班改了 businessUpgradeCnyPerLeg、或这行人数变了，执行下去就是按新价扣钱 ——
   * 拒掉，让运营驳回后重新走一遍「代理看得见金额」的流程。
   * 老申请（payload 里没有 diffCny 快照）不判，没有可比对的基准。
   */
  private async assertCabinDiffUnchanged(payload: Record<string, unknown>): Promise<void> {
    const snapshot = readPayloadNumber(payload as Prisma.JsonValue, 'diffCny');
    if (snapshot == null) return;
    const itemId = typeof payload.itemId === 'string' ? payload.itemId : null;
    if (!itemId) return;
    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      select: {
        quantity: true,
        flightSchedule: { select: { flight: { select: { businessUpgradeCnyPerLeg: true } } } },
      },
    });
    if (!item) return; // 行不在了：交给升舱通道自己报「订单项不存在」
    const current = computeCabinUpgradeDiffCny(
      item.flightSchedule?.flight.businessUpgradeCnyPerLeg ?? 0,
      item.quantity,
    );
    if (current !== snapshot) {
      throw new BadRequestError(
        `升舱差价已变（申请时 ¥${formatCny(snapshot)}，现 ¥${formatCny(current)}），` +
          '请驳回后让代理重新提交',
      );
    }
  }

  /**
   * 真正改订单的一步：一律回调运营侧既有通道，actor = 点确认的那个运营
   * （所以自助窗口闸、自助差价归零那套代理规则统统不适用，走的就是运营路径）。
   *
   * 改班次一类有两条通道，由运营在确认这一刻二选一（body.execution，缺省纠错）：
   *   · 纠错 correctFlightSchedule —— 本来就该录成这班，差价恒 0、不撤立减、不推状态；
   *   · 售后改期 rescheduleOrderItem —— 行程真的变了，收改期费、撤立减、推状态。
   * 其余三类（签证/换酒店/升舱）只有各自那一条既有口径，没有执行方式可选。
   */
  private async execute(
    orderId: string,
    kind: OrderChangeKind,
    payload: Record<string, unknown>,
    actor: OrderChangeRequestActor,
    body: DecideOrderChangeRequestBody,
  ): Promise<unknown> {
    const opsActor = { userId: actor.userId, role: actor.role, agentId: actor.agentId };
    switch (kind) {
      case OrderChangeKind.FLIGHT: {
        // 目标班次的现势复检两种执行方式都要跑：已停售/已起飞的班次，收不收改期费都改不过去。
        await this.assertTargetScheduleStillUsable(String(payload.newScheduleId));
        if (body.execution?.mode === 'AFTER_SALES') {
          // ── 行程真的变了：走售后改期这条既有路径 ────────────────────────────────
          // 与运营手工点 PATCH /orders/:id/reschedule 完全同一个方法同一套语义：收改期费、
          // 撤套餐立减、推状态、作废旧票号。两个「已起飞放行」开关一律不传 ——
          // 那是运营在改期表单上逐单确认的例外，不该从确认一条代理申请里溜进来。
          const { order } = await this.orders.rescheduleOrderItem(
            orderId,
            {
              orderItemId: String(payload.itemId),
              newScheduleId: String(payload.newScheduleId),
              feeCny: body.execution.feeCny ?? 0,
              feeLabel: body.execution.feeLabel?.trim() || ORDER_CHANGE_RESCHEDULE_FEE_LABEL,
              note: body.execution.note?.trim() || ORDER_CHANGE_REQUEST_REASON_TEXT,
            },
            opsActor,
          );
          return order;
        }
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
            // 套餐档次与酒店星级不符时，换酒店通道要求运营写明放行原因才过。
            // 这是**运营在确认这一刻**做的定价决定（代理侧那条路是硬拒的），所以取自确认请求体。
            ...(body.designatedHotelStarMismatchReason
              ? { designatedHotelStarMismatchReason: body.designatedHotelStarMismatchReason }
              : {}),
          },
          opsActor,
        );
        return order;
      }
      case OrderChangeKind.CABIN: {
        await this.assertCabinDiffUnchanged(payload);
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
        Array<{ id: string; status: OrderChangeRequestStatus; decidedAt: Date | null }>
      >`SELECT id, status, "decidedAt" FROM "OrderChangeRequest" WHERE id = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new NotFoundError('改单申请不存在');
      if (row.status !== OrderChangeRequestStatus.PENDING) {
        throw new ConflictError(`该申请当前状态为 ${row.status}，不可重复处理`);
      }
      // ── 执行中不许驳回 ────────────────────────────────────────────────────
      // 确认执行期间申请一直是 PENDING（只有 decidedAt 占位），此刻驳回会翻成 REJECTED，
      // 而那边的订单正被真的改着：改完收尾时状态已经不是 PENDING —— 队列显示「已驳回」，
      // 订单却实实在在改了。占位有效期内一律拒，让运营刷新看执行结果。
      if (row.decidedAt && Date.now() - row.decidedAt.getTime() < APPROVE_CLAIM_TTL_MS) {
        throw new ConflictError(ORDER_CHANGE_REJECT_IN_FLIGHT_MESSAGE);
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
      request: serializeOrderChangeRequest(updated, { canSeeCost: canSeeCost(actor) }),
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
