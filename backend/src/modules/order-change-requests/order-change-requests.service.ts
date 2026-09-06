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
  StaffRole,
  UserRole,
  VisaRequirement,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import { hasCapability, type Capability } from '../../lib/capabilities.js';
import { isFeatureEnabled } from '../../lib/feature-flags.js';
import { localDateISO } from '../../lib/flight-time.js';
import { determineFlightLegItems } from '../orders/ticketing-cap.js';
import {
  computeCabinUpgradeDiffCny,
  computeSwapHotelCostSnapshot,
  ORDER_STATUS_LABEL_ZH,
  OrderService,
  SEAT_HOLDING_STATUSES,
} from '../orders/orders.service.js';
import {
  cabinChangeSubmitSchema,
  cancelLegChangeSubmitSchema,
  flightChangeSubmitSchema,
  hotelChangeSubmitSchema,
  isFlaggedOrderChangeKind,
  splitChangeSubmitSchema,
  visaChangeSubmitSchema,
  visaExemptChangeSubmitSchema,
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
/**
 * flag 关着时三类扩展一律拒 —— **含运营代提**。
 *
 * 只拦代理不拦运营等于「关着的时候还是有一条路能走通」：一旦运营从队列里确认执行，
 * 订单照样被拆 / 被取消航段 / 被改自备签，口径还没拍板就先有了既成事实。
 * 关 = 零行为变化，这是这个 flag 唯一的意义。
 */
export const ORDER_CHANGE_EXTRA_KIND_DISABLED_MESSAGE =
  '拆单 / 取消单程 / 改自备签的改单申请尚未开放，请联系我们的操作人员处理';
/** 稳定 code，前端据此判「功能没开」而不是靠中文文案匹配。 */
export const ORDER_CHANGE_FEATURE_DISABLED_CODE = 'FEATURE_DISABLED';
/** 改自备签的确认只放行管理员与签证岗（驳回不限岗位——驳回不动订单）。 */
export const ORDER_CHANGE_VISA_EXEMPT_DESK_ONLY_MESSAGE =
  '改自备签的申请要由签证岗确认（其他岗位可以驳回）';
/** 三类扩展都要按单选人 / 选航段，批量给不出这些信息。 */
export const ORDER_CHANGE_BATCH_EXTRA_KIND_MESSAGE =
  '拆单 / 取消单程 / 改自备签要逐单选人、选航段，只能单张单提交，不支持批量';
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

const LEG_LABEL: Record<'OUTBOUND' | 'RETURN', string> = {
  OUTBOUND: '去程',
  RETURN: '回程',
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
  /**
   * 内部岗位（仅 role=STAFF 有意义）。逐请求从 User 表取回（authenticate 写进 req.staffRole），
   * 改岗后下一个请求即生效。目前只有「确认改自备签申请」这一处判它。
   */
  staffRole?: StaffRole | null;
}

/** 本文件内联闸的唯一入口，与路由层的 requireCapability 同一张表（lib/capabilities.ts）。 */
function actorCan(actor: OrderChangeRequestActor, cap: Capability): boolean {
  return hasCapability({ role: actor.role, staffRole: actor.staffRole }, cap);
}

/**
 * 借运营身份跑三个动作各自的只读预检。
 *
 * previewOrderSplit / previewCancelLeg 对 actor 只做一件事：role 必须是 ADMIN/STAFF，
 * 既不按 actor 收窄可见范围，也不写任何东西。而调用点都在归属闸之后
 * （assertOwnOrderForExtraKind 判过「是不是自家单」），所以按运营身份读同一套准入闸，
 * 比在这里另抄一份规则安全得多。
 */
function assessAsOps(actor: OrderChangeRequestActor): { userId: string; role: UserRole } {
  return { userId: actor.userId, role: UserRole.STAFF };
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
}

/** payload 里读一个数字字段；缺失 / 不是有限数一律 null（老申请没有这些快照键）。 */
function readPayloadNumber(payload: Prisma.JsonValue, key: string): number | null {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** payload 里读一个字符串数组；不是数组 / 混了非字符串一律滤掉（余下交给通道自己报错）。 */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** payload 里的备注：空 / 缺省回落到统一的「改单申请（运营确认）」，让审计里认得出来路。 */
function readNote(value: unknown): string {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : ORDER_CHANGE_REQUEST_REASON_TEXT;
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
  return actorCan(actor, 'change_requests.view_cost');
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

/**
 * 三类扩展的预检结果（提交闸与预检端点同一份）。
 *
 * 字段一律是**卖价侧 / 提示侧**的东西，一个进价字段都没有 —— 代理看得到它。
 * 取消航段的预估退款是「按当下取消政策算出来的数」，不是承诺：真金额在确认那一刻重算。
 */
export interface ExtraKindAssessment {
  kind: OrderChangeKind;
  eligible: boolean;
  blockers: string[];
  warnings: string[];
  cancelLeg: {
    leg: 'OUTBOUND' | 'RETURN';
    legLabel: string;
    flightNumber: string | null;
    departDate: string | null;
    /** 预估退款（元）= 该段金额 − 取消政策手续费。 */
    refundCny: number;
    policyName: string | null;
    /** true = 有需要回执的提示（如该段已出票），确认时运营要勾「我已知悉」才放行。 */
    requiresAcknowledgement: boolean;
  } | null;
  split: {
    movedShareCny: number;
    shares: Array<{ passengerId: string; fullName: string; shareCny: number }>;
  } | null;
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
    if (!actorCan(actor, 'change_requests.decide')) {
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
    await this.assertKindEnabled(body.kind);
    const ownAgentId = await this.resolveSubmitterAgentId(actor);
    // 三类扩展的准入闸：跑各自动作的只读预检，有 blocker 当场说清楚，不攒执行不了的申请。
    // （放在事务外：预检要读佣金/退款/改档申请等一串表，塞进行锁里只会把锁按得更久。
    //   权威的归属与状态判定仍在 insertRequest 的行锁内重跑。）
    if (isFlaggedOrderChangeKind(body.kind)) {
      await this.assertExtraKindEligible(actor, ownAgentId, orderId, body.kind, body.payload);
    }
    const created = await this.insertRequest(actor, ownAgentId, orderId, body.kind, body.payload, {
      note: body.note,
      batchId: null,
    });
    return serializeOrderChangeRequest(created, { canSeeCost: canSeeCost(actor) });
  }

  /** flag 关着 → 三类扩展一律 403 FEATURE_DISABLED（代理与运营同拒）。 */
  private async assertKindEnabled(kind: OrderChangeKind): Promise<void> {
    if (!isFlaggedOrderChangeKind(kind)) return;
    const enabled = await isFeatureEnabled(prisma, 'AGENT_CHANGE_REQUEST_EXTRA_KINDS');
    if (!enabled) {
      throw new AppError(ORDER_CHANGE_EXTRA_KIND_DISABLED_MESSAGE, {
        statusCode: 403,
        code: ORDER_CHANGE_FEATURE_DISABLED_CODE,
      });
    }
  }

  /** flag 开着时，当前身份能提哪几类（前端据此决定下拉里出不出这三项）。 */
  async availableKinds(actor: OrderChangeRequestActor): Promise<{ kinds: OrderChangeKind[] }> {
    if (!actorCan(actor, 'change_requests.submit')) {
      throw new ForbiddenError('无权限查看改单申请');
    }
    const base: OrderChangeKind[] = [
      OrderChangeKind.FLIGHT,
      OrderChangeKind.VISA,
      OrderChangeKind.HOTEL,
      OrderChangeKind.CABIN,
    ];
    const extraEnabled = await isFeatureEnabled(prisma, 'AGENT_CHANGE_REQUEST_EXTRA_KINDS');
    return {
      kinds: extraEnabled
        ? [
            ...base,
            OrderChangeKind.SPLIT,
            OrderChangeKind.CANCEL_LEG,
            OrderChangeKind.VISA_EXEMPT,
          ]
        : base,
    };
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
    // flag 先判：关着的时候错误话术要是「尚未开放」，而不是「不支持批量」。
    await this.assertKindEnabled(body.kind);
    // 换酒店 / 升舱要按「哪一行」选，批量给不出这个信息，直接拒。
    if (body.kind === OrderChangeKind.HOTEL || body.kind === OrderChangeKind.CABIN) {
      throw new BadRequestError(ORDER_CHANGE_BATCH_UNSUPPORTED_KIND_MESSAGE);
    }
    // 三类扩展同理，而且更硬：拆单要选人、取消航段要选段、改自备签要选人，
    // 一批单套同一份 payload 必然张冠李戴（乘客 id 根本不属于其它单）。
    if (isFlaggedOrderChangeKind(body.kind)) {
      throw new BadRequestError(ORDER_CHANGE_BATCH_EXTRA_KIND_MESSAGE);
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
    if (!actorCan(actor, 'change_requests.submit')) {
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

  // ── 三类扩展的准入预检（提交闸与预检端点共用同一份，不各写一套）──────────────

  /**
   * 归属前置闸：代理拿别家单号来跑预检时直接拒，不让 blockers 文案变成
   * 「别人订单现在什么状态」的探针。权威判定仍在 insertRequest 的行锁里。
   */
  private async assertOwnOrderForExtraKind(
    ownAgentId: string | null,
    orderId: string,
  ): Promise<void> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { agentId: true, deletedAt: true },
    });
    if (!order || order.deletedAt) throw new NotFoundError('订单不存在');
    // ownAgentId 为 null = 运营代提，不收窄（与 insertRequest 同一条口径）。
    if (ownAgentId && order.agentId !== ownAgentId) {
      throw new ForbiddenError('只能对自己名下的订单提交改单申请');
    }
  }

  /**
   * 跑三类扩展各自的准入闸，一次性返回全部不满足项（不命中第一条就停）。
   *
   * SPLIT / CANCEL_LEG 直接调拆单、取消航段自己的只读预检 —— 那两套闸各有十来条
   * （回收站 / 占座态 / 资金处置 / 佣金进结算 / 退款中 / 多套餐行 / 各类待处理申请 /
   * 预存抵扣 / 回程已释放…），在这里抄一份必然抄漏，且随时会与本体漂移。
   * VISA_EXEMPT 没有对应的只读预检，只做「人在不在本单、值是不是已经一样」这类
   * 解析级判定；送签进度、结算锁、开票闸那些深层闸留给确认那一刻由通道自己报
   * （与 FLIGHT / HOTEL 的深层闸同一口径：提交只快照，执行才见真章）。
   */
  private async collectExtraKindAssessment(
    actor: OrderChangeRequestActor,
    orderId: string,
    kind: OrderChangeKind,
    rawPayload: Record<string, unknown>,
  ): Promise<ExtraKindAssessment> {
    switch (kind) {
      case OrderChangeKind.SPLIT: {
        const input = splitChangeSubmitSchema.parse(rawPayload);
        const preview = await this.orders.previewOrderSplit(
          orderId,
          { passengerIds: input.passengerIds },
          assessAsOps(actor),
        );
        return {
          kind,
          eligible: preview.eligible,
          blockers: preview.blockers,
          warnings: preview.warnings,
          cancelLeg: null,
          split: { movedShareCny: preview.movedShareCny, shares: preview.shares },
        };
      }
      case OrderChangeKind.CANCEL_LEG: {
        const input = cancelLegChangeSubmitSchema.parse(rawPayload);
        const preview = await this.orders.previewCancelLeg(orderId, input.leg, assessAsOps(actor));
        return {
          kind,
          eligible: preview.eligible,
          blockers: preview.blockers,
          warnings: preview.warnings,
          cancelLeg: {
            leg: input.leg,
            legLabel: LEG_LABEL[input.leg],
            flightNumber: preview.returnItem?.flightNumber ?? null,
            departDate: preview.returnItem?.departDate ?? null,
            // 预估退款 = 该段金额 − 取消政策手续费（与运营弹窗看到的是同一个数）。
            refundCny: preview.netReductionCny,
            policyName: preview.policyFee?.policyName ?? null,
            requiresAcknowledgement: preview.requiresAcknowledgement,
          },
          split: null,
        };
      }
      case OrderChangeKind.VISA_EXEMPT: {
        const input = visaExemptChangeSubmitSchema.parse(rawPayload);
        const blockers: string[] = [];
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          select: { status: true, deletedAt: true },
        });
        if (!order || order.deletedAt) throw new NotFoundError('订单不存在');
        if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
          blockers.push(
            `订单当前状态（${ORDER_STATUS_LABEL_ZH[order.status] ?? order.status}）不可改自备签。`,
          );
        }
        const passenger = await prisma.passenger.findUnique({
          where: { id: input.passengerId },
          select: { orderId: true, visaExempt: true },
        });
        if (!passenger || passenger.orderId !== orderId) {
          blockers.push('所选出行人不属于本订单，请刷新后重试。');
        } else if (passenger.visaExempt === input.visaExempt) {
          blockers.push(`该出行人已经是「${input.visaExempt ? '自备签' : '随团办签'}」，无需申请。`);
        }
        return {
          kind,
          eligible: blockers.length === 0,
          blockers,
          warnings: [],
          cancelLeg: null,
          split: null,
        };
      }
      default:
        throw new BadRequestError('该改单类型不需要预检');
    }
  }

  /** 提交前的硬闸：预检不过 → 400，把全部 blocker 原样带给提交方。 */
  private async assertExtraKindEligible(
    actor: OrderChangeRequestActor,
    ownAgentId: string | null,
    orderId: string,
    kind: OrderChangeKind,
    rawPayload: Record<string, unknown>,
  ): Promise<void> {
    await this.assertOwnOrderForExtraKind(ownAgentId, orderId);
    const assessment = await this.collectExtraKindAssessment(actor, orderId, kind, rawPayload);
    if (!assessment.eligible) throw new BadRequestError(assessment.blockers.join(' '));
  }

  /**
   * 预检端点：三类扩展提交前，把 blockers 与预估退款 / 份额摆给提交方看。
   * 代理侧「取消单程要显示预估退款」靠的就是这个 —— 取消航段本体的预检端点只对运营开放，
   * 不能把那条路直接放给代理（它连同成本口径的字段一并返回）。
   */
  async previewExtraKind(
    actor: OrderChangeRequestActor,
    orderId: string,
    kind: OrderChangeKind,
    rawPayload: Record<string, unknown>,
  ): Promise<ExtraKindAssessment> {
    await this.assertKindEnabled(kind);
    if (!isFlaggedOrderChangeKind(kind)) throw new BadRequestError('该改单类型不需要预检');
    const ownAgentId = await this.resolveSubmitterAgentId(actor);
    await this.assertOwnOrderForExtraKind(ownAgentId, orderId);
    return this.collectExtraKindAssessment(actor, orderId, kind, rawPayload);
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
      case OrderChangeKind.SPLIT:
        return this.resolveSplitChange(tx, order, rawPayload);
      case OrderChangeKind.CANCEL_LEG:
        return this.resolveCancelLegChange(order, rawPayload);
      case OrderChangeKind.VISA_EXEMPT:
        return this.resolveVisaExemptChange(tx, order, rawPayload);
      default:
        throw new BadRequestError('未知的改单类型');
    }
  }

  /**
   * 拆单：把要拆出去的人记下来，并**在提交这一刻生成 requestToken**。
   *
   * token 落在 payload 里而不是确认时现生成：拆单本体按 (源单, token) 幂等，
   * 同一条申请被点两次确认时第二次只回放既有结果，绝不会拆出第二张新单。
   * 确认时现生成等于每次重试都是一个新 token —— 幂等键形同虚设。
   */
  private async resolveSplitChange(
    tx: Prisma.TransactionClient,
    order: SubmitOrder,
    rawPayload: Record<string, unknown>,
  ): Promise<ResolvedChange> {
    const input = splitChangeSubmitSchema.parse(rawPayload);
    const passengerIds = Array.from(new Set(input.passengerIds));
    if (passengerIds.length !== input.passengerIds.length) {
      throw new BadRequestError('拆出乘客列表中有重复项，请刷新后重试');
    }
    const roster = await tx.passenger.findMany({
      where: { orderId: order.id },
      select: { id: true, fullName: true, chineseName: true },
    });
    const picked = passengerIds.map((id) => {
      const row = roster.find((p) => p.id === id);
      if (!row) {
        throw new BadRequestError('所选乘客不属于本订单（可能已被换人/拆走），请刷新后重试');
      }
      return row;
    });
    if (picked.length >= roster.length) {
      throw new BadRequestError('至少要留 1 位乘客在原订单；整单转移请走改归属');
    }
    const names = picked.map((p) => p.chineseName || p.fullName);
    return {
      payload: {
        passengerIds,
        requestToken: randomUUID(),
        note: input.note?.trim() || null,
      },
      summary: `拆出 ${picked.length} 人：${names.join('、')}`,
    };
  }

  /**
   * 取消单程航段：只记哪一段。**不快照金额** —— 退多少一律由取消政策在确认那一刻算，
   * 提交时写一个数进去只会变成「申请上写 ¥3000、实际退了 ¥2800」的纠纷源。
   * 预估退款走预检端点（同一套报价），看的是当下的数，不冒充承诺。
   */
  private resolveCancelLegChange(
    order: SubmitOrder,
    rawPayload: Record<string, unknown>,
  ): ResolvedChange {
    const input = cancelLegChangeSubmitSchema.parse(rawPayload);
    // 复用改班次那套按航段定位（含「本单有已释放航段就一律拒，绝不猜」的闸）。
    const { item, legLabel } = this.resolveFlightItem(order, { leg: input.leg });
    const departureLocal = item.flightSchedule
      ? localDateISO(item.flightSchedule.departureTime, item.flightSchedule.departureTz)
      : null;
    const flightNo = item.flightSchedule?.flight.flightNumber ?? null;
    const what = [flightNo, departureLocal].filter(Boolean).join(' ');
    return {
      payload: {
        leg: input.leg,
        itemId: item.id,
        flightNo,
        departureLocal,
        requestToken: randomUUID(),
        note: input.note?.trim() || null,
      },
      summary: `取消${legLabel}${what ? ` ${what}` : ''}（退款按取消政策计算）`,
    };
  }

  /** 按人改自备签：记人 + 目标值 + 原值快照。 */
  private async resolveVisaExemptChange(
    tx: Prisma.TransactionClient,
    order: SubmitOrder,
    rawPayload: Record<string, unknown>,
  ): Promise<ResolvedChange> {
    const input = visaExemptChangeSubmitSchema.parse(rawPayload);
    const passenger = await tx.passenger.findUnique({
      where: { id: input.passengerId },
      select: { id: true, orderId: true, fullName: true, chineseName: true, visaExempt: true },
    });
    if (!passenger || passenger.orderId !== order.id) {
      throw new BadRequestError('所选出行人不属于本订单');
    }
    if (passenger.visaExempt === input.visaExempt) {
      throw new BadRequestError(
        `该出行人已经是「${input.visaExempt ? '自备签' : '随团办签'}」，无需申请`,
      );
    }
    const name = passenger.chineseName || passenger.fullName;
    return {
      payload: {
        passengerId: passenger.id,
        visaExempt: input.visaExempt,
        fromVisaExempt: passenger.visaExempt,
        note: input.note?.trim() || null,
      },
      summary: `${name} 改为${input.visaExempt ? '自备签' : '随团办签'}`,
    };
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
      // 判岗要在**占位之前**：抛在这里整个事务回滚，不会留下一条「处理中」的死占位
      // 让别人干等 5 分钟 TTL。
      if (row.kind === OrderChangeKind.VISA_EXEMPT) this.assertVisaDeskForVisaExempt(actor);
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

    // ── 幂等：订单早已是申请里的目标状态 → 不再执行第二遍 ──────────────────────
    // 成因是「执行成功了，但收尾回写状态那一步没落地」（进程被杀、连接断在中间）：
    // 申请还挂在 PENDING，运营看队列里还有一条就会再点一次。真的再执行一遍就是
    // 第二次搬座位 / 第二次抬 total。先对一遍现状，对上了就只补状态。
    const alreadyApplied = await this.detectAlreadyApplied(claim.orderId, claim.kind, claim.payload);

    let order: unknown;
    // 执行侧回带的一句话（目前只有拆单用：拆出来的新单号必须让提交方看得见，
    // 否则代理只知道「批了」，不知道人被拆到哪张单上）。
    let resultNote: string | undefined;
    if (alreadyApplied) {
      order = await this.orders.getOrder(claim.orderId, opsActor);
    } else {
      try {
        const executed = await this.execute(claim.orderId, claim.kind, claim.payload, actor, body);
        order = executed.order;
        resultNote = executed.resultNote;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 没执行成 → 撤掉处理中标记、把原因记下来，申请原样留在队列里（状态一直是 PENDING）。
        await prisma.orderChangeRequest.updateMany({
          where: { id, status: OrderChangeRequestStatus.PENDING, appliedAt: null },
          data: { decidedById: null, decidedAt: null, decisionNote: null, applyError: message },
        });
        // 状态码统一收成 400（既有契约：确认失败一律 400，申请留在 PENDING），
        // 但底层通道的**稳定 code 原样带出** —— 取消航段的 ACKNOWLEDGEMENT_REQUIRED
        // 就靠它让前端弹「我已知悉」二次确认。裹成通用 BAD_REQUEST 的话，前端只能回去
        // 匹配中文文案，文案一改就失灵。
        throw new AppError(message, {
          statusCode: 400,
          code: err instanceof AppError ? err.code : 'BAD_REQUEST',
          details: err instanceof AppError ? err.details : undefined,
        });
      }
    }

    // 幂等分支要把「这次没真执行」写进备注（运营在队列里一眼看得出）；
    // 有结果备注的分支（拆单）把新单号并进去。两者都没有时不覆盖 —— 占位那一步已写过运营的备注。
    const decisionNoteOverride = alreadyApplied
      ? [ORDER_CHANGE_ALREADY_APPLIED_NOTE, body.decisionNote?.trim()].filter(Boolean).join('；')
      : resultNote
        ? [resultNote, body.decisionNote?.trim()].filter(Boolean).join('；')
        : undefined;
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
    // 三类扩展各自带幂等，重试由底层通道自己收口，这里不另做「已生效」判定：
    //   · 拆单 / 取消航段 —— 按 (订单, requestToken) 回放，token 在提交那一刻就定死了；
    //   · 改自备签 —— 目标值与现值相同即短路（不写审计不动钱）。
    if (
      kind === OrderChangeKind.SPLIT ||
      kind === OrderChangeKind.CANCEL_LEG ||
      kind === OrderChangeKind.VISA_EXEMPT
    ) {
      return false;
    }
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
   */
  private async assertTargetScheduleStillUsable(scheduleId: string): Promise<void> {
    const target = await prisma.flightSchedule.findUnique({
      where: { id: scheduleId },
      select: { id: true, isActive: true, departureTime: true },
    });
    if (!target || !target.isActive || target.departureTime.getTime() <= Date.now()) {
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
   */
  private async execute(
    orderId: string,
    kind: OrderChangeKind,
    payload: Record<string, unknown>,
    actor: OrderChangeRequestActor,
    body: DecideOrderChangeRequestBody,
  ): Promise<{ order: unknown; resultNote?: string }> {
    const opsActor = { userId: actor.userId, role: actor.role, agentId: actor.agentId };
    switch (kind) {
      case OrderChangeKind.FLIGHT: {
        await this.assertTargetScheduleStillUsable(String(payload.newScheduleId));
        const { order } = await this.orders.correctFlightSchedule(
          orderId,
          String(payload.itemId),
          String(payload.newScheduleId),
          opsActor,
        );
        return { order };
      }
      case OrderChangeKind.VISA: {
        const { order } = await this.orders.setOrderVisaStatus(
          orderId,
          payload.toVisaStatus as VisaRequirement,
          opsActor,
        );
        return { order };
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
        return { order };
      }
      case OrderChangeKind.CABIN: {
        await this.assertCabinDiffUnchanged(payload);
        const { order } = await this.orders.upgradeOrderItemCabin(
          orderId,
          String(payload.itemId),
          { note: ORDER_CHANGE_REQUEST_REASON_TEXT },
          opsActor,
        );
        return { order };
      }
      // ── 三类扩展：一律回调既有通道，守恒断言 / 审计 / 幂等全在通道本体里 ──────────
      case OrderChangeKind.SPLIT: {
        const result = await this.orders.splitOrder(
          orderId,
          {
            passengerIds: readStringArray(payload.passengerIds),
            requestToken: String(payload.requestToken),
            note: readNote(payload.note),
            // 混合房组**不自动劈半**：那是 no-show / 按人改期编排的专用口径。
            // 走申请这条路等同手工拆单 —— 同房组闸照旧拒拆，让运营先在分房里把人分开。
            autoSplitRoomGroups: false,
          },
          opsActor,
        );
        return {
          // splitOrder 回的是两侧单号与份额，不是序列化订单；这里补读一次源单给前端刷新。
          order: await this.orders.getOrder(orderId, opsActor),
          resultNote: result.replayed
            ? `已拆出新单 ${result.targetOrderNumber}（重试时发现已拆过，本次未再拆）`
            : `已拆出新单 ${result.targetOrderNumber}（${result.passengerCount} 人）`,
        };
      }
      case OrderChangeKind.CANCEL_LEG: {
        const { order } = await this.orders.cancelLeg(
          orderId,
          {
            requestToken: String(payload.requestToken),
            leg: payload.leg === 'OUTBOUND' ? 'OUTBOUND' : 'RETURN',
            // 一律按取消政策报价。手工档（feeMode=MANUAL）是运营在订单页当面拍的决定，
            // 要填金额和原因；申请这条路上没有这两样东西，也不该在确认弹窗里补出来。
            feeMode: 'POLICY',
            note: readNote(payload.note),
            // 「该段已出票」这类需要回执的提示，由点确认的运营勾（提申请的人看不到出票进度）。
            acknowledgeWarnings: body.acknowledgeWarnings === true,
          },
          opsActor,
        );
        return { order };
      }
      case OrderChangeKind.VISA_EXEMPT: {
        // 岗位闸已在 approve 的 claim 事务里判过（抛在那里不留死占位）。
        const { order } = await this.orders.setPassengerVisaExempt(
          orderId,
          String(payload.passengerId),
          { visaExempt: payload.visaExempt === true, note: readNote(payload.note) },
          opsActor,
        );
        return { order };
      }
      default:
        throw new BadRequestError('未知的改单类型');
    }
  }

  /**
   * 改自备签的确认只放行管理员与签证岗。
   *
   * 自备签既是「这个人要不要我方送签」的口径，也是**定价输入**（套餐按人扣减自备签减免）：
   * 翻它等于同时改签证台的活儿和这张单的应收，而「客人到底自己有没有签、送签走到哪一步了」
   * 只有签证岗清楚。所以确认这一步收在签证岗手里；驳回不动订单，仍对所有运营开放。
   */
  private assertVisaDeskForVisaExempt(actor: OrderChangeRequestActor): void {
    if (actorCan(actor, 'change_requests.approve_visa_exempt')) return;
    throw new ForbiddenError(ORDER_CHANGE_VISA_EXEMPT_DESK_ONLY_MESSAGE);
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
