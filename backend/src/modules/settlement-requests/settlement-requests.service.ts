/**
 * 结算价议价申请服务 —— 代理改自家单的结算价：锁价前自助直通、锁价后走运营确认。
 *
 * 两条分支（业务拍板：代理对自己名下的订单，结算价锁定前可以自己填、自己改，不经运营审批）：
 *   · 未锁价 → **自助直通**：当场落一条 APPROVED（决定人=代理本人）并立即调既有 addPriceAdjustment
 *     生成差额行。钱动了，但只可能动自家这一单，且仍旧只走那一条服务端权威调价通道。
 *   · 已锁价 → 照旧只落一条 PENDING（订单金额一分不动），运营确认时才按**确认那一刻**重读的应收
 *     算差额、调同一条通道生成差额行；运营驳回只改申请状态。
 *
 * 自助直通的四道闸（只管自助这一支，运营提交/确认不受影响）—— 挡的是「改了会对不上账」的单：
 *   1. 已进结算单（本单佣金行已被某期结算单收走）：账单已出，改应收会与已出账目脱钩；
 *   2. 已开票（去程/回程/系统任一）：发票是已交付下游的凭证，改价必须先冲开票状态；
 *   3. 已收款且改后应收低于已收：凭空造出一笔应退款，退款口径必须有人经手；
 *   4. 结算价已锁定：财务已按这个应收对过账 → 落回 PENDING 交运营。
 *
 * 服务端权威定价的底线仍在：代理传的是「目标应收」，不是可自由写入的明细行价格；金额由服务端
 * 按「申请价 − 此刻应收」算差额，并同样受单笔调价上限约束。
 *
 * 作用范围两种（0903 运营反馈「代理只能改总价，需要能分别调整」）：
 *   · 整单（passengerId 空）：代理填「这一单想收多少」，差额 = 申请价 − 此刻应收（老行为不变）；
 *   · 指定乘客（passengerId 非空）：代理填「只给这个人加/减多少」的**调整净额**，与事后调价
 *     addPriceAdjustment 的 amountCny 同口径。之所以不是「这个人的新结算价」——每人结算价是
 *     「应收均摊 + 该乘客调整净额」派生出来的展示值、本就不可手填，收新总价得倒推均摊，两处口径
 *     必然漂移。这笔净额是**固定的**：确认时不按当下应收反推，否则会把期间别人头上的改期费/
 *     补房差一并抹到这一位乘客身上。
 * 「一单同一时刻只能挂一条 PENDING」的口径两种范围共用（不按乘客放宽），免得运营审批时对不上账。
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

/**
 * 自助直通生成的差额行说明文本。与上面那条固定文案分开，是为了在订单详情/导出里一眼分得清
 * 「运营确认过的议价」和「代理自己改的价」——两者钱一样动，追责路径不一样。
 */
export const AGENT_SELF_SETTLEMENT_REASON_TEXT = '代理自助改结算价';

/** 自助直通落库时给申请说明加的前缀（队列里一眼看出这条不是等运营处理的）。 */
const AGENT_SELF_SETTLEMENT_NOTE_PREFIX = '代理自助';

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

/** 提交申请时多读的几列：只有自助直通那一支要看它们（锁价/开票/已收款）。 */
type OrderSelfServiceSnapshot = OrderPricingSnapshot & {
  settlementLocked: boolean;
  paidAmount: Prisma.Decimal;
  outboundInvoiced: boolean;
  returnInvoiced: boolean;
  systemInvoiced: boolean;
};

type SettlementRequestRow = {
  id: string;
  orderId: string;
  agentId: string | null;
  requestedById: string;
  requestedTotalCny: Prisma.Decimal;
  systemTotalCny: Prisma.Decimal;
  /** 非空 = 只调这一位乘客的份额；空 = 整单（老行为） */
  passengerId: string | null;
  passengerName: string | null;
  /** 指定乘客时申请的调整净额（正=补收 / 负=优惠）；整单申请为空 */
  requestedAdjustmentCny: Prisma.Decimal | null;
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
  // 指定乘客的申请：申请的是一笔**固定的调整净额**，差额就是它本身，不随期间别的调价重算
  // （重算等于把别人头上的调价抹到这个人身上）。整单申请照旧「申请价 − 当前应收」。
  const requestedAdjustmentCny =
    r.requestedAdjustmentCny === null || r.requestedAdjustmentCny === undefined
      ? null
      : round2(Number(r.requestedAdjustmentCny.toString()));
  const diffCny = r.passengerId
    ? requestedAdjustmentCny
    : currentTotalCny === null
      ? null
      : round2(requested - currentTotalCny);
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
    diffCny: diffCny === null ? null : diffCny.toFixed(2),
    // 作用范围：非空 = 只调这一位乘客；空 = 整单。姓名是提交时的快照（乘客可能已被换人/拆单挪走）。
    passengerId: r.passengerId ?? null,
    passengerName: r.passengerName ?? null,
    requestedAdjustmentCny: requestedAdjustmentCny === null ? null : requestedAdjustmentCny.toFixed(2),
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
  // 提交申请（未锁价的自家单 = 自助直通；其余 = 落 PENDING 等运营）
  // ══════════════════════════════════════════════════════════════════
  /**
   * 代理（限本单归属代理）或运营提交结算价申请。
   *
   * 代理 + 自家单 + 未锁价 + 四道闸全过 → 自助直通：落 APPROVED 并立即生效（selfApplied=true）。
   * 其余情况（运营提交、已锁价）→ 只落一条 PENDING，**不改订单一分钱**（selfApplied=false）。
   *
   * 并发：先锁订单行再查重 —— 「同一订单只能有一条 PENDING」的判断要靠这把锁才成立，
   * 否则两个并发请求各自读到「没有 PENDING」、各插一条。迁移里的部分唯一索引是第二道兜底
   * （任何绕过本方法的路径也插不进第二条），P2002 在这里被翻译成同一句 409。
   * 同一把锁也串行化了「读 settlementLocked → 决定走哪一支」与批量锁价
   * （batchSetSettlementLock 同样 FOR UPDATE 后再改），不会出现「读到未锁 → 期间被锁 → 照样改价」。
   *
   * 差额行的落地放在事务外（addPriceAdjustment 自己要拿同一把行锁，嵌在本事务里必然自锁），
   * 取舍与 approve() 同款：先占位、后执行，失败则把刚落的那条 APPROVED 撤掉再原样抛错。
   */
  async create(
    actor: SettlementRequestActor,
    orderId: string,
    body: CreateSettlementRequestBody,
  ): Promise<SerializedSettlementRequest & { selfApplied: boolean; appliedDiffCny: string | null }> {
    let ownAgentId: string | null = null;
    if (actor.role === UserRole.AGENT) {
      ownAgentId = await this.resolveOwnAgentId(actor.userId);
    } else if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('无权限提交议价申请');
    }

    let claim: {
      requestId: string;
      selfApplied: boolean;
      diffCny: number;
      passengerId: string | null;
    };
    try {
      claim = await prisma.$transaction(async (tx) => {
        // 订单行锁：与调价/补房差/批量锁价同一把锁，串行化「查重 → 判锁 → 插入」。
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
            // 自助直通那一支要看的四列（运营提交时读到也不用）。
            settlementLocked: true,
            paidAmount: true,
            outboundInvoiced: true,
            returnInvoiced: true,
            systemInvoiced: true,
          },
        })) as OrderSelfServiceSnapshot | null;
        if (!order || order.deletedAt) throw new NotFoundError('订单不存在');

        if (ownAgentId && order.agentId !== ownAgentId) {
          throw new ForbiddenError('只能对自己名下的订单提交议价申请');
        }
        if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
          throw new BadRequestError(
            '该订单当前状态不可议价（已取消/已退款/超时/草稿单不再改动应收）',
          );
        }

        // 作用范围 = 指定乘客时，先确认这位乘客真属于本单（口径与 addPriceAdjustment 的
        // passengerId 归属校验一字一致：不接受跨单/不存在的乘客）。姓名当场存一份快照。
        let passengerName: string | null = null;
        if (body.passengerId) {
          const pax = await tx.passenger.findUnique({
            where: { id: body.passengerId },
            select: { id: true, orderId: true, fullName: true, chineseName: true },
          });
          if (!pax || pax.orderId !== orderId) {
            throw new BadRequestError('指定的乘客不存在或不属于本订单');
          }
          passengerName = pax.chineseName?.trim() || pax.fullName;
        }

        const systemTotalCny = receivableCny(order);
        // 两种口径分流：
        //   · 指定乘客 → 申请的就是一笔调整净额（与 addPriceAdjustment 的 amountCny 同口径，
        //     schema 已保证整数非 0）；整单应收顺带派生一份留痕，只作展示。
        //   · 整单 → 照旧「申请价 − 此刻应收」反推差额。
        const diffCny = body.passengerId
          ? body.adjustmentCny!
          : round2(body.requestedTotalCny! - systemTotalCny);
        const requestedTotalCny = body.passengerId
          ? round2(systemTotalCny + diffCny)
          : body.requestedTotalCny!;
        if (diffCny === 0) {
          throw new BadRequestError('与当前应收一致，无需申请');
        }
        this.assertDiffWithinCap(diffCny);

        // 一单一议照旧：已有待确认申请时两条支路都拒，免得自助改完还挂着一条没人处理的 PENDING。
        const pending = await tx.settlementRequest.findFirst({
          where: { orderId, status: SettlementRequestStatus.PENDING },
          select: { id: true },
        });
        if (pending) {
          throw new ConflictError('该订单已有一条待确认的议价申请，请等运营处理后再提交');
        }

        // ── 自助直通判定：代理本人 + 未锁价。锁着 → 落 PENDING 交运营（不是错误）。 ──
        const selfApplied = ownAgentId !== null && !order.settlementLocked;
        if (selfApplied) {
          // 「改后应收低于已收款」那道闸看的是改完之后的整单应收 —— 指定乘客的申请同样会抬/降
          // 整单 total，所以喂进去的是上面派生的 requestedTotalCny，两种口径同一把尺子。
          await this.assertSelfServiceAllowed(tx, order, requestedTotalCny);
        }

        const created = await tx.settlementRequest.create({
          data: {
            orderId,
            agentId: order.agentId,
            requestedById: actor.userId,
            requestedTotalCny: new Prisma.Decimal(requestedTotalCny),
            systemTotalCny: new Prisma.Decimal(systemTotalCny),
            passengerId: body.passengerId ?? null,
            passengerName,
            requestedAdjustmentCny: body.passengerId ? new Prisma.Decimal(diffCny) : null,
            note: selfApplied
              ? [AGENT_SELF_SETTLEMENT_NOTE_PREFIX, body.note?.trim()].filter(Boolean).join('：')
              : body.note?.trim() || null,
            status: selfApplied
              ? SettlementRequestStatus.APPROVED
              : SettlementRequestStatus.PENDING,
            // 自助直通没有第二个人经手：决定人就是提交人本人，留痕如实写。
            decidedById: selfApplied ? actor.userId : null,
            decidedAt: selfApplied ? new Date() : null,
          },
          select: { id: true },
        });

        return { requestId: created.id, selfApplied, diffCny, passengerId: body.passengerId ?? null };
      });
    } catch (err) {
      // 部分唯一索引兜底命中（并发穿过应用层查重）→ 回同一句 409，别把裸约束名抛给前端。
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError('该订单已有一条待确认的议价申请，请等运营处理后再提交');
      }
      throw err;
    }

    if (claim.selfApplied) {
      try {
        const applied = await this.orders.addPriceAdjustment(
          orderId,
          {
            amountCny: claim.diffCny,
            reasonCode: claim.diffCny > 0 ? 'MISC_FEE' : 'DISCOUNT',
            reasonText: AGENT_SELF_SETTLEMENT_REASON_TEXT,
            // 作用范围原样透传：非空 → 差额行挂在这位乘客名下（订单详情按人分组看得到）。
            ...(claim.passengerId ? { passengerId: claim.passengerId } : {}),
          },
          { userId: actor.userId, role: actor.role },
          // 公开的 POST /orders/:id/price-adjustment 对 AGENT 照旧 403；只有这条内部路径放行。
          { viaAgentSelfSettlement: true },
        );
        await prisma.settlementRequest.update({
          where: { id: claim.requestId },
          data: { appliedAdjustmentItemId: applied.audit.itemId },
        });
      } catch (err) {
        // 差额行没落地 → 刚占位的那条 APPROVED 必须消失，否则它显示「已生效」而钱没动。
        // 这里删而不是回落 PENDING：代理拿到的是真实错误、可以改完再提；留一条 PENDING 反而会让
        // 他下一次提交撞上「已有待确认申请」的 409，而运营队列里那条也没人知道是怎么来的。
        // 条件删除（只删仍是自己刚落的那条、且没回写差额行 id 的）避免误删并发写入。
        await prisma.settlementRequest.deleteMany({
          where: {
            id: claim.requestId,
            status: SettlementRequestStatus.APPROVED,
            appliedAdjustmentItemId: null,
          },
        });
        throw err;
      }
    }

    // 统一回读：自助直通后应收已变，序列化里的 currentTotalCny/diffCny 要按改完之后的数说话。
    const finalRow = await prisma.settlementRequest.findUniqueOrThrow({
      where: { id: claim.requestId },
      include: REQUEST_INCLUDE,
    });
    return {
      ...serializeSettlementRequest(finalRow),
      selfApplied: claim.selfApplied,
      // 自助直通实际落地的差额（正=补收/负=优惠）；落 PENDING 时没有差额行 → null。
      appliedDiffCny: claim.selfApplied ? claim.diffCny.toFixed(2) : null,
    };
  }

  /**
   * 自助直通的三道「对不上账」闸（锁价那一道在调用处判：锁着就落 PENDING，不是错误）。
   * 全部只在代理自助支路生效——运营提交/确认照旧不受这三条约束。
   */
  private async assertSelfServiceAllowed(
    tx: Prisma.TransactionClient,
    order: OrderSelfServiceSnapshot,
    requestedTotalCny: number,
  ): Promise<void> {
    // 1. 已进结算单：本单的佣金行已被某期结算单收走（CommissionRecord.settlementId 非空 —— 订单
    //    与结算单的连接就在这张表上，OrderItem 侧没有结算标记）。账单已出，再改应收会让那期结算单的
    //    营收/佣金与订单对不上，只能由运营连着结算单一起处理。
    const settledCommission = await tx.commissionRecord.findFirst({
      where: { orderId: order.id, settlementId: { not: null } },
      select: { id: true },
    });
    if (settledCommission) {
      throw new ConflictError('该订单已进入结算单，改价请联系运营处理');
    }
    // 2. 已开票：发票是已交付下游的凭证，改价必须先冲开票状态（与改结算价/改自备签同口径）。
    if (order.outboundInvoiced || order.returnInvoiced || order.systemInvoiced) {
      throw new ConflictError('已开票的订单请联系运营改价');
    }
    // 3. 改后应收低于已收款：等于凭空造出一笔应退款，退款口径必须有人经手。
    const paidAmount = Number(order.paidAmount.toString());
    if (paidAmount > 0 && requestedTotalCny < paidAmount) {
      throw new ConflictError('订单已收款，改后金额低于已收款，请联系运营处理');
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
      /** 作用范围：非空 = 只调了这一位乘客的份额；空 = 整单 */
      passengerId: string | null;
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
          passengerId: string | null;
          requestedAdjustmentCny: Prisma.Decimal | null;
        }>
      >`SELECT id, "orderId", "requestedTotalCny", status, "requestedById", "passengerId", "requestedAdjustmentCny" FROM "SettlementRequest" WHERE id = ${id} FOR UPDATE`;
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
      // 指定乘客的申请：确认的是那笔**固定的调整净额**，不按当下应收反推 ——
      // 反推会把申请挂着这段时间里别人头上的改期费/补房差一并抹到这一位乘客身上。
      // 整单申请照旧按「确认那一刻」重读的应收算差额。
      if (row.passengerId && row.requestedAdjustmentCny === null) {
        throw new ConflictError('该申请缺少调整净额，请让代理重新提交');
      }
      const diffCny = row.passengerId
        ? round2(Number(row.requestedAdjustmentCny!.toString()))
        : round2(requestedTotalCny - currentTotalCny);
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
        passengerId: row.passengerId,
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
            // 作用范围原样透传：非空 → 差额行挂在这位乘客名下（订单详情按人分组看得到）。
            ...(claim.passengerId ? { passengerId: claim.passengerId } : {}),
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
        passengerId: claim.passengerId,
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
