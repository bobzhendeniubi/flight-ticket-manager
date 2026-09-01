/**
 * 结算价议价申请服务 —— 代理提申请、运营确认后才由既有调价通道生效。
 *
 * 为什么不给代理开手填结算价的口子：代理能自己改低应付价 = 自己给自己打折。
 * 所以这条通道只搬运「意向价」，不碰钱：
 *   代理提交 → 落一条 PENDING（订单金额一分不动）
 *   运营确认 → 服务端按**确认那一刻**重读的应收算差额，调既有 addPriceAdjustment 生成差额行
 *   运营驳回 → 只改申请状态
 * 服务端权威定价这条底线因此不破：申请本身永远改不动订单金额。
 *
 * 差额行的 reasonCode 选型见 approve() 注释。
 */
import { OrderStatus, Prisma, SettlementRequestStatus, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import { OrderService, SEAT_HOLDING_STATUSES } from '../orders/orders.service.js';
import { PRICE_ADJUSTMENT_CAP_CNY } from '../orders/orders.schemas.js';
import type {
  CreateSettlementRequestBody,
  DecideSettlementRequestBody,
  ListSettlementRequestsQuery,
} from './settlement-requests.schemas.js';

/** 2 位小数四舍五入（与 orders.service / agent-recharges.service 同口径）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 确认时生成的差额行说明文本。固定文案，让订单详情那一行自己说清楚它是怎么来的：
 * 「价格调整：优惠（−¥500）：代理议价申请（运营确认）」。
 */
export const SETTLEMENT_REQUEST_REASON_TEXT = '代理议价申请（运营确认）';

/** 应收口径：total + adjustmentCny（与订单详情「应收」/尾款 balanceDue 一字一致）。 */
export function receivableCny(order: { total: Prisma.Decimal; adjustmentCny: number }): number {
  return round2(Number(order.total.toString()) + order.adjustmentCny);
}

export interface SettlementRequestActor {
  userId: string;
  role: UserRole;
}

type OrderPricingSnapshot = {
  id: string;
  orderNumber: string;
  agentId: string | null;
  status: OrderStatus;
  deletedAt: Date | null;
  total: Prisma.Decimal;
  adjustmentCny: number;
};

type SettlementRequestRow = {
  id: string;
  orderId: string;
  agentId: string | null;
  requestedById: string;
  requestedTotalCny: Prisma.Decimal;
  systemTotalCny: Prisma.Decimal;
  note: string | null;
  status: SettlementRequestStatus;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  appliedAdjustmentItemId: string | null;
  createdAt: Date;
  agent?: { id: string; companyName: string | null; contactName: string } | null;
  order?: {
    orderNumber: string;
    total: Prisma.Decimal;
    adjustmentCny: number;
    _count: { passengers: number };
  } | null;
};

/** 序列化：Decimal → string、Date → ISO（与 agent-recharges / orders 现有约定一致）。 */
function serializeSettlementRequest(r: SettlementRequestRow) {
  const requested = Number(r.requestedTotalCny.toString());
  // 队列要的是「现在还差多少」：带上订单时用**当前**应收重算，不吃 systemTotalCny 那份旧快照
  // （申请挂着的这段时间里改期费/补房差都可能已经动过应收）。
  const currentTotalCny = r.order ? receivableCny(r.order) : null;
  return {
    id: r.id,
    orderId: r.orderId,
    orderNumber: r.order?.orderNumber ?? null,
    agentId: r.agentId,
    agentName: r.agent ? r.agent.companyName || r.agent.contactName : null,
    passengerCount: r.order?._count.passengers ?? null,
    requestedById: r.requestedById,
    requestedTotalCny: r.requestedTotalCny.toString(),
    systemTotalCny: r.systemTotalCny.toString(),
    currentTotalCny: currentTotalCny === null ? null : currentTotalCny.toFixed(2),
    diffCny: currentTotalCny === null ? null : round2(requested - currentTotalCny).toFixed(2),
    note: r.note,
    status: r.status,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    appliedAdjustmentItemId: r.appliedAdjustmentItemId,
    createdAt: r.createdAt.toISOString(),
  };
}
export type SerializedSettlementRequest = ReturnType<typeof serializeSettlementRequest>;

/** 队列/详情列表的 include：订单号、应收重算所需字段、人数、代理名。 */
const REQUEST_INCLUDE = {
  agent: { select: { id: true, companyName: true, contactName: true } },
  order: {
    select: {
      orderNumber: true,
      total: true,
      adjustmentCny: true,
      _count: { select: { passengers: true } },
    },
  },
} as const;

export class SettlementRequestsService {
  constructor(private readonly orders: OrderService = new OrderService()) {}

  /** 从 actor 解析所属 agentId（AGENT 专用；没有代理档案视为无权限）。 */
  private async resolveOwnAgentId(userId: string): Promise<string> {
    const agent = await prisma.agent.findUnique({ where: { userId }, select: { id: true } });
    if (!agent) throw new ForbiddenError('当前用户不是代理');
    return agent.id;
  }

  /**
   * 读取范围内可见的代理 id 集合（AGENT 专用）。
   * 读比写宽一档：读用「自己 + 所有下级」（与认款/结算/订单列表同口径），
   * 写（提交申请）严格限本单归属代理本人 —— 见 create()。
   */
  private async visibleAgentIds(userId: string): Promise<string[]> {
    return getDescendantAgentIds(await this.resolveOwnAgentId(userId));
  }

  /** 差额闸：与人工调价共用同一上限，避免两处口径漂移。 */
  private assertDiffWithinCap(diffCny: number): void {
    if (Math.abs(diffCny) > PRICE_ADJUSTMENT_CAP_CNY) {
      throw new BadRequestError(
        `申请价与当前应收相差 ¥${Math.abs(diffCny)}，超出单笔调整上限（±${PRICE_ADJUSTMENT_CAP_CNY}）`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 提交申请
  // ══════════════════════════════════════════════════════════════════
  /**
   * 代理（限本单归属代理）或运营提交议价申请。**不改订单一分钱**，只落一条 PENDING。
   *
   * 并发：先锁订单行再查重 —— 「同一订单只能有一条 PENDING」的判断要靠这把锁才成立，
   * 否则两个并发请求各自读到「没有 PENDING」、各插一条。迁移里的部分唯一索引是第二道兜底
   * （任何绕过本方法的路径也插不进第二条），P2002 在这里被翻译成同一句 409。
   */
  async create(
    actor: SettlementRequestActor,
    orderId: string,
    body: CreateSettlementRequestBody,
  ): Promise<SerializedSettlementRequest> {
    let ownAgentId: string | null = null;
    if (actor.role === UserRole.AGENT) {
      ownAgentId = await this.resolveOwnAgentId(actor.userId);
    } else if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('无权限提交议价申请');
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        // 订单行锁：与调价/补房差同一把锁，串行化「查重 → 插入」。
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        const order = (await tx.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            orderNumber: true,
            agentId: true,
            status: true,
            deletedAt: true,
            total: true,
            adjustmentCny: true,
          },
        })) as OrderPricingSnapshot | null;
        if (!order || order.deletedAt) throw new NotFoundError('订单不存在');

        if (ownAgentId && order.agentId !== ownAgentId) {
          throw new ForbiddenError('只能对自己名下的订单提交议价申请');
        }
        if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
          throw new BadRequestError(
            '该订单当前状态不可议价（已取消/已退款/超时/草稿单不再改动应收）',
          );
        }

        const systemTotalCny = receivableCny(order);
        const diffCny = round2(body.requestedTotalCny - systemTotalCny);
        if (diffCny === 0) {
          throw new BadRequestError('与当前应收一致，无需申请');
        }
        this.assertDiffWithinCap(diffCny);

        const pending = await tx.settlementRequest.findFirst({
          where: { orderId, status: SettlementRequestStatus.PENDING },
          select: { id: true },
        });
        if (pending) {
          throw new ConflictError('该订单已有一条待确认的议价申请，请等运营处理后再提交');
        }

        return tx.settlementRequest.create({
          data: {
            orderId,
            agentId: order.agentId,
            requestedById: actor.userId,
            requestedTotalCny: new Prisma.Decimal(body.requestedTotalCny),
            systemTotalCny: new Prisma.Decimal(systemTotalCny),
            note: body.note?.trim() || null,
            status: SettlementRequestStatus.PENDING,
          },
          include: REQUEST_INCLUDE,
        });
      });
      return serializeSettlementRequest(created);
    } catch (err) {
      // 部分唯一索引兜底命中（并发穿过应用层查重）→ 回同一句 409，别把裸约束名抛给前端。
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError('该订单已有一条待确认的议价申请，请等运营处理后再提交');
      }
      throw err;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 查询
  // ══════════════════════════════════════════════════════════════════
  /** 单张订单的全部申请（AGENT 只看得到自己 + 下级名下的单）。 */
  async listForOrder(
    actor: SettlementRequestActor,
    orderId: string,
  ): Promise<{ requests: SerializedSettlementRequest[] }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, agentId: true, deletedAt: true },
    });
    if (!order || order.deletedAt) throw new NotFoundError('订单不存在');

    if (actor.role === UserRole.AGENT) {
      const visible = await this.visibleAgentIds(actor.userId);
      if (!order.agentId || !visible.includes(order.agentId)) {
        throw new ForbiddenError('无权查看该订单的议价申请');
      }
    } else if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('无权限查看议价申请');
    }

    const rows = await prisma.settlementRequest.findMany({
      where: { orderId },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return { requests: rows.map(serializeSettlementRequest) };
  }

  /** 运营待办队列（AGENT 调用只返回自家 + 下级）。 */
  async list(actor: SettlementRequestActor, query: ListSettlementRequestsQuery) {
    const where: Prisma.SettlementRequestWhereInput = {};
    if (query.status) where.status = query.status;

    if (actor.role === UserRole.AGENT) {
      where.agentId = { in: await this.visibleAgentIds(actor.userId) };
    } else if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('无权限查看议价申请');
    }

    const [rows, total] = await prisma.$transaction([
      prisma.settlementRequest.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.settlementRequest.count({ where }),
    ]);

    return {
      requests: rows.map(serializeSettlementRequest),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 确认 / 驳回
  // ══════════════════════════════════════════════════════════════════
  /**
   * 确认（ADMIN/STAFF）：把订单应收收敛到申请价。
   *
   * 差额 = 申请价 − **确认那一刻**重读的应收（不吃申请时的快照：挂着的这段时间里
   * 改期费/补房差都可能动过应收，照旧快照算会把那部分金额一起抹掉）。
   * 差额为 0（应收已被别的操作调到申请价）→ 直接标 APPROVED，不生成空行。
   *
   * 差额行一律走既有 addPriceAdjustment，不另写一套改总价的逻辑 ——
   * 资金闸（assertOrderAcceptsFunds：死单不许再改应收）、订单行锁、审计流水全都复用它的。
   *
   * reasonCode 取 MISC_FEE（补收）/ DISCOUNT（优惠）而不是语义更贴的 SETTLEMENT：
   * SETTLEMENT 被 orders.schemas 明确划为「只能系统生成、不进人工枚举」，addPriceAdjustment
   * 的入参类型（OrderPriceAdjustmentBody）也只收人工四类，塞 SETTLEMENT 得靠类型断言硬闯；
   * 且录单生成的 SETTLEMENT 行还带 metadata.settlementPrice 标（改归属代理时按它点名提醒），
   * 这条路径生成不出那个标，冒充它反而让两种行看着一样、行为不一样。
   * 差额行的来龙去脉由固定 reasonText + 本表 + 审计三处交代，足够追溯。
   *
   * 并发/幂等：先在事务里锁申请行、校验 PENDING、原子改 APPROVED（占位），再调调价通道。
   * 调价失败 → 把申请改回 PENDING 并原样抛出错误（运营看得到真实原因，申请还在队列里）。
   * 先占位再执行的取舍：万一进程在两步之间挂掉，留下的是「APPROVED 但没有差额行」（少收，
   * 看得见、可补），而不是「差额行已落但申请还 PENDING」（会被再确认一次 → 双重调价）。
   */
  async approve(
    actor: SettlementRequestActor,
    id: string,
    body: DecideSettlementRequestBody,
  ): Promise<{
    request: SerializedSettlementRequest;
    order: unknown | null;
    audit: {
      orderId: string;
      orderNumber: string;
      requestedTotalCny: number;
      currentTotalCny: number;
      diffCny: number;
      itemId: string | null;
      requestedById: string;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可确认议价申请');
    }

    const claim = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          orderId: string;
          requestedTotalCny: Prisma.Decimal;
          status: SettlementRequestStatus;
          requestedById: string;
        }>
      >`SELECT id, "orderId", "requestedTotalCny", status, "requestedById" FROM "SettlementRequest" WHERE id = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new NotFoundError('议价申请不存在');
      if (row.status !== SettlementRequestStatus.PENDING) {
        throw new ConflictError(`该申请当前状态为 ${row.status}，不可重复处理`);
      }

      const order = (await tx.order.findUnique({
        where: { id: row.orderId },
        select: {
          id: true,
          orderNumber: true,
          agentId: true,
          status: true,
          deletedAt: true,
          total: true,
          adjustmentCny: true,
        },
      })) as OrderPricingSnapshot | null;
      if (!order || order.deletedAt) throw new NotFoundError('订单不存在');

      const requestedTotalCny = Number(row.requestedTotalCny.toString());
      const currentTotalCny = receivableCny(order);
      const diffCny = round2(requestedTotalCny - currentTotalCny);
      this.assertDiffWithinCap(diffCny);

      await tx.settlementRequest.update({
        where: { id },
        data: {
          status: SettlementRequestStatus.APPROVED,
          decidedById: actor.userId,
          decidedAt: new Date(),
          decisionNote: body.note?.trim() || null,
        },
      });

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        requestedById: row.requestedById,
        requestedTotalCny,
        currentTotalCny,
        diffCny,
      };
    });

    let itemId: string | null = null;
    let orderPayload: unknown | null = null;
    if (claim.diffCny !== 0) {
      try {
        const applied = await this.orders.addPriceAdjustment(
          claim.orderId,
          {
            amountCny: claim.diffCny,
            reasonCode: claim.diffCny > 0 ? 'MISC_FEE' : 'DISCOUNT',
            reasonText: SETTLEMENT_REQUEST_REASON_TEXT,
          },
          { userId: actor.userId, role: actor.role },
        );
        itemId = applied.audit.itemId;
        orderPayload = applied.order;
      } catch (err) {
        // 调价没落地 → 申请必须回到队列里，否则它显示「已确认」而钱没动，谁也看不出差在哪。
        // 条件写回（只回滚仍是自己刚占的那条 APPROVED），避免覆盖并发写入的其它状态。
        await prisma.settlementRequest.updateMany({
          where: { id, status: SettlementRequestStatus.APPROVED, appliedAdjustmentItemId: null },
          data: {
            status: SettlementRequestStatus.PENDING,
            decidedById: null,
            decidedAt: null,
            decisionNote: null,
          },
        });
        throw err;
      }
      await prisma.settlementRequest.update({
        where: { id },
        data: { appliedAdjustmentItemId: itemId },
      });
    }

    const finalRow = await prisma.settlementRequest.findUniqueOrThrow({
      where: { id },
      include: REQUEST_INCLUDE,
    });
    return {
      request: serializeSettlementRequest(finalRow),
      order: orderPayload,
      audit: {
        orderId: claim.orderId,
        orderNumber: claim.orderNumber,
        requestedTotalCny: claim.requestedTotalCny,
        currentTotalCny: claim.currentTotalCny,
        diffCny: claim.diffCny,
        itemId,
        requestedById: claim.requestedById,
      },
    };
  }

  /** 驳回（ADMIN/STAFF）：只改申请状态，订单一分钱不动。 */
  async reject(
    actor: SettlementRequestActor,
    id: string,
    body: DecideSettlementRequestBody,
  ): Promise<{
    request: SerializedSettlementRequest;
    audit: { orderId: string; requestedById: string };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可驳回议价申请');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; orderId: string; status: SettlementRequestStatus; requestedById: string }>
      >`SELECT id, "orderId", status, "requestedById" FROM "SettlementRequest" WHERE id = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new NotFoundError('议价申请不存在');
      if (row.status !== SettlementRequestStatus.PENDING) {
        throw new ConflictError(`该申请当前状态为 ${row.status}，不可重复处理`);
      }
      return tx.settlementRequest.update({
        where: { id },
        data: {
          status: SettlementRequestStatus.REJECTED,
          decidedById: actor.userId,
          decidedAt: new Date(),
          decisionNote: body.note?.trim() || null,
        },
        include: REQUEST_INCLUDE,
      });
    });

    return {
      request: serializeSettlementRequest(updated),
      audit: { orderId: updated.orderId, requestedById: updated.requestedById },
    };
  }
}
