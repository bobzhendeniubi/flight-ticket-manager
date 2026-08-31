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
  VisaSubmissionStatus,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import type { AuditActor } from '../../lib/audit.js';
import { syncOrderVisaCompletion, type VisaCompletionOutcome } from './visa-completion.js';
import type { ListFulfillmentQuery, UpdateFulfillmentBody } from './fulfillment.schemas.js';

export const REFUND_REQUESTED_FULFILLMENT_ERROR =
  '订单退款申请中，库存已释放，不可继续履约；如退款被驳回可恢复操作';

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
 * 分类值的出处 —— 下发给前端决定「这个值有多确凿」：
 *   PRODUCT      = 签证产品的结构化字段（业务真的标注过）→ 前端实色展示
 *   ORDER_STATUS = 从订单级录单「签证状态」回退推出（录单员只表达了签发方式）→ 前端浅色 +「·录单」
 * null = 无值。
 */
export type VisaClassificationSource = 'PRODUCT' | 'ORDER_STATUS';

/**
 * 订单级录单「签证状态」→ 有效签发方式的回退映射。
 * **内存分类（effectiveVisaClassification）与查询层筛选（issuanceMethodWhere）共读这一张表**，
 * 两处口径由同一份数据保证逐字一致，不各写一遍。
 *
 *   E_VISA（录单选「电子签」）→ 签发方式 = 电子签
 *   NEEDED（录单选「需要签证」）→ 签发方式 = 落地签（业务口径：需办签 = 走落地签办理）
 *
 * NOT_NEEDED（不需要）/ HAS_VISA（已签证）不办签证，无回退来源。
 */
const ORDER_STATUS_ISSUANCE_FALLBACK: ReadonlyArray<{
  orderStatus: VisaRequirement;
  issuanceMethod: VisaIssuanceMethod;
}> = [
  { orderStatus: VisaRequirement.E_VISA, issuanceMethod: VisaIssuanceMethod.E_VISA },
  { orderStatus: VisaRequirement.NEEDED, issuanceMethod: VisaIssuanceMethod.ARRIVAL },
];

/** 有回退来源的订单级签证状态 —— 「未标注」桶要把它们排除掉，否则会被回退成有值 */
const FALLBACK_ORDER_STATUSES: VisaRequirement[] = ORDER_STATUS_ISSUANCE_FALLBACK.map(
  (r) => r.orderStatus,
);

/**
 * 任务的有效签证分类（签发方式 / 入境次数）+ 各自的出处。
 *
 * **签发方式**优先取签证产品的结构化字段；产品缺失（录单单子多为纯机票行，签证信息只落在
 * 订单级「签证状态」）时按 ORDER_STATUS_ISSUANCE_FALLBACK 回退录单口径：
 * visaStatus=E_VISA → 电子签（录单的下拉选项**本身就写着「电子签」**），
 * visaStatus=NEEDED → 落地签（录单的「需要签证」在业务上就是由我们代办落地签）。
 * 签证台「签证类型」筛选与录单侧由此打通（公测反馈：仅认产品字段时，录单单子全部落进
 * 「未标注」桶，按「电子签 / 落地签」一个都筛不出来）。
 *
 * **入境次数**只认签证产品的结构化字段，**没有录单回退**：录单的「签证状态」从未表达过
 * 入境次数，任何由它推出的「单次/多次」都是无据猜测，且是**静默的错**（不报错、只标错）。
 * 宁可留空让签证岗看到「未标注」，也不给一个看起来权威的假值。
 * 入境次数应由签证产品的 entryType 结构化标注。
 *
 * 回退有据的那一半留下（签发方式），没据的那一半不做（入境次数）。
 */
export function effectiveVisaClassification(
  visa:
    | { issuanceMethod: VisaIssuanceMethod | null; entryType: VisaEntryType | null }
    | null
    | undefined,
  orderVisaStatus: VisaRequirement | null | undefined,
): {
  issuanceMethod: VisaIssuanceMethod | null;
  entryType: VisaEntryType | null;
  issuanceSource: VisaClassificationSource | null;
  entrySource: VisaClassificationSource | null;
} {
  const issuanceFromOrder =
    ORDER_STATUS_ISSUANCE_FALLBACK.find((r) => r.orderStatus === orderVisaStatus)?.issuanceMethod ??
    null;
  const issuanceFromProduct = visa?.issuanceMethod ?? null;
  const issuanceMethod = issuanceFromProduct ?? issuanceFromOrder;
  const entryType = visa?.entryType ?? null;
  return {
    issuanceMethod,
    entryType,
    issuanceSource: issuanceFromProduct
      ? 'PRODUCT'
      : issuanceMethod
        ? 'ORDER_STATUS'
        : null,
    // 入境次数无回退来源 → 有值必来自产品
    entrySource: entryType ? 'PRODUCT' : null,
  };
}

/**
 * 「签发方式」筛选下沉到查询层 —— 与 effectiveVisaClassification 的内存口径逐字对齐
 * （两者共读同一张 ORDER_STATUS_ISSUANCE_FALLBACK，口径只有一份）：
 *
 *   有效签发方式 = 签证产品 issuanceMethod ?? 录单回退(订单级 visaStatus)
 *   录单回退：E_VISA → 电子签，NEEDED → 落地签，其余（含 NULL）→ 无
 *
 * 回退命中的条件是「产品侧未标注（无关联签证产品，或关联了但 issuanceMethod 为空）
 * 且订单级 visaStatus = 该签发方式对应的录单状态」——这个 `??` 回退在关系过滤里能完整
 * 表达，所以下沉后筛选结果与内存分类一致（回退出来的电子签 / 落地签单**照样筛得到**）。
 *
 * 注意：只有 E_VISA / ARRIVAL 有回退来源；STICKER / OTHER 没有，只认产品结构化字段。
 * 本函数只**镜像** effectiveVisaClassification 的口径，不重新定义它。
 */
export function issuanceMethodWhere(
  filter: VisaIssuanceMethod | 'NONE',
): Prisma.OrderItemWhereInput {
  // 产品侧未标注 = 没关联签证产品，或关联了但 issuanceMethod 为空
  const productUnset: Prisma.OrderItemWhereInput = {
    OR: [{ visa: { is: null } }, { visa: { is: { issuanceMethod: null } } }],
  };

  if (filter === 'NONE') {
    // 未标注 = 产品侧未标注 且 订单级也不在「有回退来源」的状态里
    // （否则会回退成电子签 / 落地签，就不算未标注了）。
    // 显式列出 NULL，不依赖 `notIn` 对可空列是否兜 NULL 的实现细节
    // （SQL 里 NULL NOT IN (...) 得 NULL 而非真）。
    const orderHasNoFallback: Prisma.OrderItemWhereInput = {
      order: { OR: [{ visaStatus: null }, { visaStatus: { notIn: FALLBACK_ORDER_STATUSES } }] },
    };
    return { AND: [productUnset, orderHasNoFallback] };
  }

  const fallbackOrderStatus = ORDER_STATUS_ISSUANCE_FALLBACK.find(
    (r) => r.issuanceMethod === filter,
  )?.orderStatus;
  if (fallbackOrderStatus) {
    return {
      OR: [
        { visa: { is: { issuanceMethod: filter } } },
        { AND: [productUnset, { order: { visaStatus: fallbackOrderStatus } }] },
      ],
    };
  }
  return { visa: { is: { issuanceMethod: filter } } };
}

/**
 * 「客人搜索」下沉到查询层 —— 按乘客姓名 / 中文名 / 护照号模糊命中，任一乘客命中即命中该任务。
 *
 * 口径要点：命中的是「**这一单里有这个人**」，不附加 visaExempt 条件。拿着一个名字来找单，
 * 问的是"这人在哪张单上"，不是"这人要不要我方代办"；若在这里再卡自备签，自备签客人的名字
 * 就永远搜不出他所在的那张单（而那张单可能正因为别的同行人要送签而挂在签证台上）。
 * 列表展示侧仍按 visaExempt=false 过滤乘客明细，两者互不干扰。
 *
 * 子句形状与订单搜索的乘客子句同构（orders.service 的 buildSearchTermClause）：
 * 姓名 / 中文名不区分大小写，护照号同样放开大小写（护照号里的字母录入时大小写不一）。
 */
export function passengerQueryWhere(term: string): Prisma.OrderItemWhereInput {
  return {
    order: {
      passengers: {
        some: {
          OR: [
            { fullName: { contains: term, mode: 'insensitive' } },
            { chineseName: { contains: term, mode: 'insensitive' } },
            { documentNumber: { contains: term, mode: 'insensitive' } },
          ],
        },
      },
    },
  };
}

/**
 * 「签证口径」筛选下沉到查询层 —— 直接比订单级 Order.visaStatus，不做任何推断或回退。
 *
 * 这与上面的 issuanceMethodWhere（签发方式，带「产品字段 ?? 录单回退」）是**两根不同的轴**：
 * 本函数问的是"录单当时把这单的签证口径记成了什么"，一个字段一个答案，没有二义。
 *
 * 'UNSET' = 未标注：录单从没填过签证状态（库里 visaStatus IS NULL）。这一档必须显式存在——
 * 四档是枚举的四个成员，NULL 不在其中，没有这一档时这批单在任何一档下都不出现，
 * 只有「全部」能看到，签证岗一筛就会以为单少了（**这不是小数**：清查时开发库 171 条签证
 * 任务里 107 条 visaStatus 为空）。「未标注」与「未签证(NOT_NEEDED)」是两回事：
 * 后者是录单明确表态「不需要办」，前者是录单压根没表态。
 */
export function visaRequirementWhere(
  filter: VisaRequirement | 'UNSET',
): Prisma.OrderItemWhereInput {
  // 未标注 = 订单级签证状态为 NULL；Prisma 的 `visaStatus: null` 生成 IS NULL（可空列上正确）
  if (filter === 'UNSET') return { order: { visaStatus: null } };
  return { order: { visaStatus: filter } };
}

/**
 * 送签进度的推进次序（低→高）——派生任务级状态时取「最早（最低）」那一档。
 */
const VISA_SUBMISSION_RANK: Record<VisaSubmissionStatus, number> = {
  [VisaSubmissionStatus.PENDING]: 0,
  [VisaSubmissionStatus.IN_PROGRESS]: 1,
  [VisaSubmissionStatus.CONFIRMED]: 2,
};

/**
 * 乘客送签进度 → 任务级 FulfillmentStatus 的恒等映射（成员同名，语义一致）。
 * 只覆盖三档送签进度；CANCELLED/FAILED 是任务级独有态，不由乘客派生（见 rederiveVisaTasksForOrder）。
 */
const SUBMISSION_TO_TASK: Record<VisaSubmissionStatus, FulfillmentStatus> = {
  [VisaSubmissionStatus.PENDING]: FulfillmentStatus.PENDING,
  [VisaSubmissionStatus.IN_PROGRESS]: FulfillmentStatus.IN_PROGRESS,
  [VisaSubmissionStatus.CONFIRMED]: FulfillmentStatus.CONFIRMED,
};

/**
 * 派生口径：全部需签乘客到达某档，任务才算该档；只要有人更早，任务保持较早那一档。
 *   实现 = 取所有非自备签乘客送签进度里**最低**的一档，再恒等映射到任务级状态。
 * 无非自备签乘客（空数组）→ PENDING（无人可送，保持待处理）。
 */
export function deriveVisaTaskStatus(statuses: VisaSubmissionStatus[]): FulfillmentStatus {
  if (statuses.length === 0) return FulfillmentStatus.PENDING;
  let lowest = statuses[0];
  for (const s of statuses) {
    if (VISA_SUBMISSION_RANK[s] < VISA_SUBMISSION_RANK[lowest]) lowest = s;
  }
  return SUBMISSION_TO_TASK[lowest];
}

/**
 * 任务级三档进度状态（可由乘客派生 / 被派生覆盖）——CANCELLED/FAILED 为终态，不在此列，
 * 派生只在这三档之间流转，永不复活终态。
 */
const DERIVABLE_TASK_STATUSES: FulfillmentStatus[] = [
  FulfillmentStatus.PENDING,
  FulfillmentStatus.IN_PROGRESS,
  FulfillmentStatus.CONFIRMED,
];

/**
 * 任务级状态是否属于「可映射到乘客送签进度」的三档（成员名与 VisaSubmissionStatus 逐字相同）。
 * 为真时可安全把该值当作 VisaSubmissionStatus 使用（见 asVisaSubmissionStatus）。
 */
function isVisaSubmissionStatus(s: FulfillmentStatus): boolean {
  return DERIVABLE_TASK_STATUSES.includes(s);
}

/**
 * 把已确认属于三档进度的任务级状态转成乘客级 VisaSubmissionStatus（同名枚举值，运行时等值）。
 * 调用前须 isVisaSubmissionStatus(s) 为真。
 */
function asVisaSubmissionStatus(s: FulfillmentStatus): VisaSubmissionStatus {
  return s as unknown as VisaSubmissionStatus;
}

/** Prisma.Decimal | number | null → number | null（签证金额序列化用） */
function decOrNull(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : Number(v.toString());
}

/**
 * 解析签证任务的人均成本三字段 —— CNY 为入账权威：
 *   · 美金单价 + 汇率齐备 → 自动折算 CNY 存底（覆盖任何直填 CNY，保证「$x ×汇率=¥y」自洽）
 *   · 否则 → 用直填 CNY（美金/汇率各自原样，通常为空）
 * 三者皆空即回退产品主数据成本（调用方据此清空）。
 */
export function resolveVisaUnitCost(input: {
  visaUnitCostUsd?: number | null;
  visaFxRate?: number | null;
  visaUnitCostCny?: number | null;
}): { usd: number | null; rate: number | null; cny: number | null } {
  const usd = input.visaUnitCostUsd ?? null;
  const rate = input.visaFxRate ?? null;
  const cny =
    usd != null && rate != null
      ? Math.round(usd * rate * 100) / 100
      : (input.visaUnitCostCny ?? null);
  return { usd, rate, cny };
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
        select: {
          id: true,
          fullName: true,
          documentNumber: true,
          passportPhotoUrl: true,
          passportExpiry: true,
          visaSubmissionStatus: true,
        },
      }),
    ]);
    const serializedPassengers = passengers.map(serializePassenger);
    return items.flatMap((it) => {
      // 分类回退：签发方式在产品字段缺失时回退订单级录单签证状态（E_VISA=电子签 / NEEDED=落地签）；
      // 入境次数只认产品字段。两者各自带 source 下发，前端据此区分实色/浅色
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
              // 出处标：PRODUCT=产品结构化标注（确证）/ ORDER_STATUS=录单回退（推断）
              visaIssuanceSource: visaClass.issuanceSource,
              visaEntrySource: visaClass.entrySource,
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

  /**
   * 「出发日期」筛选下沉到查询层，口径与列表回传的 departureTime 逐字一致：
   * **每订单最早一段 FLIGHT** 的 departureTime，按该班次 departureTz 折算成出发地本地日。
   *
   * 两个必须守住的点：
   * 1. 纯签证单/纯酒店单**无航班 → 保留可见**（不被日期筛选误隐藏）——与护照按姓名导出同口径
   *    （见 hotel-control.passports.ts collectPassportGroupsByNames），别让两边分叉。
   * 2. 取**最早**一段而非任意一段：否则回程恰好落在该日的订单会被误命中。
   *    「最早一段」是聚合语义，关系过滤表达不了，故先用一条原生 SQL 算出命中的 orderId 集合，
   *    再并回关系过滤 —— 这样 findMany 与 count 仍共用同一个 where。
   *
   * 时区换算方向：departureTime 是 TIMESTAMP(3) **without time zone** 且存的是 UTC，
   * 所以必须先 `AT TIME ZONE 'UTC'` 还原成 timestamptz，再 `AT TIME ZONE departureTz`
   * 落到出发地本地时刻。少了第一跳会把 UTC 时刻当成本地时刻，日期整体错位。
   */
  private async departureDateWhere(
    from: string | undefined,
    to: string | undefined,
  ): Promise<Prisma.OrderItemWhereInput> {
    // 最早一段机票出发地本地日，供区间上下界比对（'YYYY-MM-DD' 串按字典序比较即日期序）
    const localDay = Prisma.sql`to_char(
      fs."departureTime" AT TIME ZONE 'UTC' AT TIME ZONE fs."departureTz",
      'YYYY-MM-DD'
    )`;
    // 区间边界：from/to 各自可缺省（开区间）；至少有一侧（调用方已保证）
    const bounds: Prisma.Sql[] = [];
    if (from) bounds.push(Prisma.sql`${localDay} >= ${from}`);
    if (to) bounds.push(Prisma.sql`${localDay} <= ${to}`);
    const boundsSql = Prisma.join(bounds, ' AND ');

    const rows = await prisma.$queryRaw<Array<{ orderId: string }>>(Prisma.sql`
      SELECT DISTINCT oi."orderId" AS "orderId"
      FROM "OrderItem" oi
      JOIN "FlightSchedule" fs ON fs."id" = oi."flightScheduleId"
      WHERE oi."kind"::text = 'FLIGHT'
        AND fs."departureTime" = (
          SELECT MIN(fs2."departureTime")
          FROM "OrderItem" oi2
          JOIN "FlightSchedule" fs2 ON fs2."id" = oi2."flightScheduleId"
          WHERE oi2."orderId" = oi."orderId" AND oi2."kind"::text = 'FLIGHT'
        )
        AND ${boundsSql}
    `);
    const orderIds = rows.map((r) => r.orderId);

    return {
      order: {
        OR: [
          // 最早一段机票的出发地本地日落在所选区间内
          { id: { in: orderIds } },
          // 无航班订单（纯签证单等）→ 保留可见
          { items: { none: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } } } },
        ],
      },
    };
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

    // 签证台的筛选（状态 / 签发方式 / 签证口径 / 出发日期 / 客人）全部下沉到 where —— 必须与
    // count 共用同一个 where，分页和 total 才有意义。任何一个退回前端过滤，都会让「总数」和
    // 「实际能翻到的行数」对不上，并且跨页的匹配项永远凑不齐（按「待办」翻页会漏单）。
    const orderItemAnd: Prisma.OrderItemWhereInput[] = [];
    if (query.issuanceMethod) orderItemAnd.push(issuanceMethodWhere(query.issuanceMethod));
    // 签证口径（订单级 visaStatus 四档）；与签发方式是两根轴，同时给就是 AND
    if (query.visaRequirement) orderItemAnd.push(visaRequirementWhere(query.visaRequirement));
    // 客人搜索（乘客姓名 / 中文名 / 护照号）——与备注搜索各管一头，同时给就是 AND
    if (query.passengerQuery) orderItemAnd.push(passengerQueryWhere(query.passengerQuery));
    // 出发日期筛选：优先区间 from/to（任一侧可缺），向后兼容旧单日参数 departureDate（= from=to=该日）。
    const depFrom = query.departureDateFrom ?? query.departureDate;
    const depTo = query.departureDateTo ?? query.departureDate;
    if (depFrom || depTo) {
      orderItemAnd.push(await this.departureDateWhere(depFrom, depTo));
    }
    if (orderItemAnd.length) orderItemWhere.AND = orderItemAnd;

    const where: Prisma.FulfillmentTaskWhereInput = { orderItem: orderItemWhere };
    if (query.type) where.type = query.type;
    // 多状态：「待办」= PENDING + IN_PROGRESS 在后端表达；省略 = 「全部状态」不加条件
    if (query.status?.length) where.status = { in: query.status };
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
              // 本签证 item 关联的签证产品（用于 #7：单次/多次签名称 + 结构化签发方式/入境次数分类
              // + stayDays：非 15 天单次的特殊情况徽标）
              visa: { select: { visaName: true, issuanceMethod: true, entryType: true, stayDays: true } },
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
                  // 所属代理（公测反馈：签证台需直接看到归属，不必点进订单详情）；
                  // 走同一主查询的嵌套 select，不新增每行子查询
                  agent: { select: { companyName: true, contactName: true } },
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
      // 护照有效期（YYYY-MM-DD，@db.Date 用 to_char 直出，无时区问题）；null=未录入
      passportExpiry: string | null;
      // 按人送签进度
      visaSubmissionStatus: VisaSubmissionStatus;
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
                   ("passportPhotoUrl" IS NOT NULL AND length("passportPhotoUrl") > 0) AS "hasPhoto",
                   to_char("passportExpiry", 'YYYY-MM-DD') AS "passportExpiry",
                   "visaSubmissionStatus"::text AS "visaSubmissionStatus"
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

    // 送签人数统计（签证台对数条）：按**整个筛选范围**算（不是当前页），乘客级口径——
    // 只数非自备签乘客（签证岗的数=要办的人，自备签的人不显示也不计入）。
    // 「已送签人数」即签证岗线下送签总数，两边必须恒等（2026-08-30 拍板的对数恒等式）。
    let passengerStats: { pending: number; inProgress: number; confirmed: number } | null = null;
    if (query.type === FulfillmentType.VISA_APPLICATION) {
      const matchedTaskOrders = await prisma.fulfillmentTask.findMany({
        where,
        select: { orderItem: { select: { orderId: true } } },
      });
      const statOrderIds = [...new Set(matchedTaskOrders.map((t) => t.orderItem.orderId))];
      const grouped = statOrderIds.length
        ? await prisma.passenger.groupBy({
            by: ['visaSubmissionStatus'],
            where: { orderId: { in: statOrderIds }, visaExempt: false },
            _count: { _all: true },
          })
        : [];
      const countOf = (s: VisaSubmissionStatus) =>
        grouped.find((g) => g.visaSubmissionStatus === s)?._count._all ?? 0;
      passengerStats = {
        pending: countOf(VisaSubmissionStatus.PENDING),
        inProgress: countOf(VisaSubmissionStatus.IN_PROGRESS),
        confirmed: countOf(VisaSubmissionStatus.CONFIRMED),
      };
    }

    return {
      passengerStats,
      tasks: rows.map((t) => {
        const order = t.orderItem.order;
        // 最早一段机票的出发时间/时区（无机票则 null）— 供签证台显示出发日期
        const firstLeg = earliestLegByOrder.get(order.id) ?? null;
        // 分类回退：签发方式在产品字段缺失时回退订单级录单签证状态（E_VISA=电子签 / NEEDED=落地签），
        // 签证台「签证类型」筛选/徽章两边口径由此对齐（见 issuanceMethodWhere）；
        // 入境次数只认产品字段，无回退
        const visaClass = effectiveVisaClassification(t.orderItem.visa, order.visaStatus);
        // 所属代理名（口径与订单模块导出/看板一致：公司名优先，回退联系人名；无代理 = 直客）
        const { agent, ...orderRest } = order;
        const agentName = agent ? agent.companyName || agent.contactName : null;
        return {
          ...serializeTask(t, t.orderItem),
          // #7：本签证产品名称（单次/多次签等）置于任务顶层
          visaName: t.orderItem.visa?.visaName ?? null,
          // 签证结构化分类（签发方式/入境次数）；产品与订单级都未标注 = null
          visaIssuanceMethod: visaClass.issuanceMethod,
          visaEntryType: visaClass.entryType,
          // 单次最多停留天数（产品结构化字段；null=未标注）→ 「非15天单次」特殊情况徽标
          visaStayDays: t.orderItem.visa?.stayDays ?? null,
          // 出处标：PRODUCT=产品结构化标注（确证）/ ORDER_STATUS=录单回退（推断）
          visaIssuanceSource: visaClass.issuanceSource,
          visaEntrySource: visaClass.entrySource,
          order: {
            ...orderRest,
            // 所属代理名；null = 直客（无代理）
            agentName,
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
                  // 护照有效期（YYYY-MM-DD / null）→ 签证台按人平铺展示 + 临期标黄
                  passportExpiry: p.passportExpiry,
                  // 按人送签进度 → 勾选按人标记 + 订单行「已送 x/y」
                  visaSubmissionStatus: p.visaSubmissionStatus,
                })),
              }
            : {}),
        };
      }),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  async update(id: string, body: UpdateFulfillmentBody, actor?: AuditActor) {
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
      if (body.status === FulfillmentStatus.CONFIRMED && ord.status === OrderStatus.REFUND_REQUESTED) {
        throw new BadRequestError(REFUND_REQUESTED_FULFILLMENT_ERROR);
      }
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

    // 签证实际成本（人均口径）：任一字段出现即视为设置。只允许签证任务（其余任务无签证成本语义）。
    const hasVisaCost =
      body.visaUnitCostUsd !== undefined ||
      body.visaFxRate !== undefined ||
      body.visaUnitCostCny !== undefined;
    if (hasVisaCost) {
      if (existing.type !== FulfillmentType.VISA_APPLICATION) {
        throw new ConflictError('签证金额只能设置在签证任务上');
      }
      const resolved = resolveVisaUnitCost(body);
      data.visaUnitCostUsd = resolved.usd;
      data.visaFxRate = resolved.rate;
      data.visaUnitCostCny = resolved.cny;
    }

    // 签证公司：与金额三字段互相独立（只改公司不动金额）。同样只允许签证任务。
    // 空串等同清空——前端清空输入框保存即回到「未填」，不留空白字符串。
    if (body.visaSupplier !== undefined) {
      if (existing.type !== FulfillmentType.VISA_APPLICATION) {
        throw new ConflictError('签证公司只能设置在签证任务上');
      }
      const trimmed = body.visaSupplier?.trim() ?? '';
      data.visaSupplier = trimmed === '' ? null : trimmed;
    }

    const taskInclude = {
      orderItem: {
        include: {
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
    } as const;

    let updated;
    if (body.status === FulfillmentStatus.CONFIRMED) {
      // 与 worker 的最终 CAS 同口径：不能只信上面的旧快照，必须把父订单状态条件
      // 放进真正写入的 where，堵住「读到 PAID → 订单变 REFUND_REQUESTED → 再确认」窗口。
      const guarded = await prisma.fulfillmentTask.updateMany({
        where: {
          id,
          status: existing.status,
          orderItem: { order: { status: { not: OrderStatus.REFUND_REQUESTED } } },
        },
        data,
      });
      if (guarded.count !== 1) {
        const current = await prisma.fulfillmentTask.findUnique({
          where: { id },
          include: { orderItem: { include: { order: { select: { status: true } } } } },
        });
        if (current?.orderItem.order.status === OrderStatus.REFUND_REQUESTED) {
          throw new BadRequestError(REFUND_REQUESTED_FULFILLMENT_ERROR);
        }
        throw new ConflictError('履约任务状态已被并发修改，请重试');
      }
      updated = await prisma.fulfillmentTask.findUnique({ where: { id }, include: taskInclude });
      if (!updated) throw new NotFoundError('履约任务不存在');
    } else {
      updated = await prisma.fulfillmentTask.update({ where: { id }, data, include: taskInclude });
    }

    // 任务级 VISA 流转 = 「作用于该单全部乘客」：把订单所有非自备签乘客的送签进度改写成同一档，
    // 使派生与直写一致（旧的任务级批量入口由此保持语义：整单一起推进）。只对三档送签进度生效；
    // CANCELLED/FAILED 是任务级独有终态，不改乘客送签进度。
    if (
      updated.type === FulfillmentType.VISA_APPLICATION &&
      body.status !== undefined &&
      isVisaSubmissionStatus(body.status)
    ) {
      await prisma.passenger.updateMany({
        where: { orderId: updated.orderItem.orderId, visaExempt: false },
        data: { visaSubmissionStatus: asVisaSubmissionStatus(body.status) },
      });
      // 订单级办结派生：整单推到「已送签」→ 订单自动已签证；从已送签退回 → 对称撤销。
      await this.syncCompletionForOrders([updated.orderItem.orderId], actor);
    }

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
   * 批量设置签证任务的人均成本 / 签证公司（签证公司按航班开统一单价是常态）。
   * 逐条复用 update() 的单任务校验（仅签证任务 + 非负 + USD→CNY 折算），不另写规则；
   * 金额与签证公司互相独立——只带 visaSupplier 的调用不会动金额，反之亦然。
   * 单条失败不影响其余，返回 failures 明细（镜像 batchUpdateStatus 的返回形状）。
   */
  async batchSetVisaCost(
    taskIds: string[],
    cost: {
      visaUnitCostUsd?: number | null;
      visaFxRate?: number | null;
      visaUnitCostCny?: number | null;
      visaSupplier?: string | null;
    },
  ): Promise<{
    successCount: number;
    failureCount: number;
    failures: Array<{ id: string; error: string }>;
  }> {
    let successCount = 0;
    const failures: Array<{ id: string; error: string }> = [];
    for (const id of taskIds) {
      try {
        await this.update(id, cost);
        successCount += 1;
      } catch (err) {
        failures.push({ id, error: err instanceof Error ? err.message : '未知错误' });
      }
    }
    return { successCount, failureCount: failures.length, failures };
  }

  /**
   * 重新派生某订单签证任务的状态（按人送签用）：
   * 取该单全部非自备签乘客送签进度里**最早**一档，写回该单所有签证任务的状态。
   * 只覆盖三档进度中的任务（status in DERIVABLE_TASK_STATUSES）——CANCELLED/FAILED 终态不复活。
   *
   * completedAt：派生为「已送签」时置当前时间，否则清空（与任务级 update 的完成时间语义一致）。
   * startedAt 不在此管理（更新多行无法逐行保留旧值；签证台不展示该字段）。
   */
  /**
   * 送签进度落库后的订单级办结派生（拆出来供各写入口共用：任务级 update 的整单联动、
   * 按人批量标记；orders 侧改自备签走 visa-completion 模块直调）。actor 缺省记 SYSTEM。
   */
  private async syncCompletionForOrders(
    orderIds: Iterable<string>,
    actor: AuditActor | undefined,
  ): Promise<Array<Exclude<VisaCompletionOutcome, { changed: false }>>> {
    const outcomes: Array<Exclude<VisaCompletionOutcome, { changed: false }>> = [];
    for (const orderId of orderIds) {
      const o = await syncOrderVisaCompletion(orderId, actor ?? { role: 'SYSTEM' });
      if (o.changed) outcomes.push(o);
    }
    return outcomes;
  }

  private async rederiveVisaTasksForOrder(orderId: string): Promise<FulfillmentStatus> {
    const passengers = await prisma.passenger.findMany({
      where: { orderId, visaExempt: false },
      select: { visaSubmissionStatus: true },
    });
    const derived = deriveVisaTaskStatus(passengers.map((p) => p.visaSubmissionStatus));
    await prisma.fulfillmentTask.updateMany({
      where: {
        orderItem: { orderId },
        type: FulfillmentType.VISA_APPLICATION,
        status: { in: DERIVABLE_TASK_STATUSES },
      },
      data: {
        status: derived,
        completedAt: derived === FulfillmentStatus.CONFIRMED ? new Date() : null,
      },
    });
    return derived;
  }

  /**
   * 按人更新送签进度（批量）——部分送签的核心入口。
   *
   * 逐个乘客校验：存在 / 非自备签 / 父订单存活（与任务级 update 同一存活闸）；
   * 通过者一次性 updateMany 改写送签进度，再对受影响订单逐单重新派生任务级状态。
   * 单个失败不影响其余，返回 failures 明细（镜像 batchUpdateStatus 的返回形状）。
   */
  async batchUpdateVisaPassengerStatus(
    passengerIds: string[],
    toStatus: VisaSubmissionStatus,
    actor?: AuditActor,
  ): Promise<{
    successCount: number;
    failureCount: number;
    failures: Array<{ id: string; error: string }>;
    affectedOrderIds: string[];
    /** 本次触发的订单级办结变化（自动已签证 / 撤销办结），供前端回显。 */
    visaCompletion: Array<Exclude<VisaCompletionOutcome, { changed: false }>>;
  }> {
    const passengers = await prisma.passenger.findMany({
      where: { id: { in: passengerIds } },
      select: {
        id: true,
        orderId: true,
        visaExempt: true,
        order: { select: { status: true, deletedAt: true } },
      },
    });
    const byId = new Map(passengers.map((p) => [p.id, p]));

    const failures: Array<{ id: string; error: string }> = [];
    const okIds: string[] = [];
    const affectedOrders = new Set<string>();
    for (const id of passengerIds) {
      const p = byId.get(id);
      if (!p) {
        failures.push({ id, error: '乘客不存在' });
        continue;
      }
      if (p.visaExempt) {
        failures.push({ id, error: '该乘客自备签证，无需送签' });
        continue;
      }
      if (p.order.deletedAt || !COUNTED_STATUSES.includes(p.order.status)) {
        failures.push({
          id,
          error: `父订单状态为 ${p.order.status}${p.order.deletedAt ? '（已在回收站）' : ''}，不可标记送签进度`,
        });
        continue;
      }
      okIds.push(id);
      affectedOrders.add(p.orderId);
    }

    let visaCompletion: Array<Exclude<VisaCompletionOutcome, { changed: false }>> = [];
    if (okIds.length > 0) {
      await prisma.passenger.updateMany({
        where: { id: { in: okIds } },
        data: { visaSubmissionStatus: toStatus },
      });
      // 逐单重新派生任务级状态（受影响订单去重后处理）
      for (const orderId of affectedOrders) {
        await this.rederiveVisaTasksForOrder(orderId);
      }
      // 订单级办结派生：整单推满「已送签」→ 自动已签证；退回 → 对称撤销。
      visaCompletion = await this.syncCompletionForOrders(affectedOrders, actor);
    }

    return {
      successCount: okIds.length,
      failureCount: failures.length,
      failures,
      affectedOrderIds: [...affectedOrders],
      visaCompletion,
    };
  }

  /**
   * 按人更新送签进度（单个）——批量的薄封装，失败即抛（乘客不存在 → 404，其余 → 409）。
   */
  async updateVisaPassengerStatus(
    passengerId: string,
    toStatus: VisaSubmissionStatus,
    actor?: AuditActor,
  ): Promise<{ passengerId: string; status: VisaSubmissionStatus; orderId: string | null }> {
    const res = await this.batchUpdateVisaPassengerStatus([passengerId], toStatus, actor);
    if (res.failureCount > 0) {
      const msg = res.failures[0].error;
      if (msg === '乘客不存在') throw new NotFoundError(msg);
      throw new ConflictError(msg);
    }
    return { passengerId, status: toStatus, orderId: res.affectedOrderIds[0] ?? null };
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
  passportExpiry: Date | null;
  visaSubmissionStatus: VisaSubmissionStatus;
}) {
  return {
    id: p.id,
    fullName: p.fullName,
    documentNumber: p.documentNumber,
    passportPhotoUrl: p.passportPhotoUrl,
    hasPhoto: p.passportPhotoUrl !== null && p.passportPhotoUrl.length > 0,
    // 护照有效期 → YYYY-MM-DD（@db.Date 经 JSON 是完整 ISO 串，这里裁到日）；null=未录入
    passportExpiry: p.passportExpiry ? p.passportExpiry.toISOString().slice(0, 10) : null,
    // 按人送签进度（部分送签用）
    visaSubmissionStatus: p.visaSubmissionStatus,
  };
}

function serializeTask(
  t: {
    id: string; orderItemId: string; type: FulfillmentType; status: FulfillmentStatus;
    data: unknown; notes: string | null; attempts: number;
    scheduledAt: Date | null; startedAt: Date | null; completedAt: Date | null;
    failureReason: string | null; assigneeUserId: string | null;
    visaUnitCostUsd?: Prisma.Decimal | number | null;
    visaFxRate?: Prisma.Decimal | number | null;
    visaUnitCostCny?: Prisma.Decimal | number | null;
    visaSupplier?: string | null;
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
    // 签证实际成本（人均口径）；非签证任务/未设置 = null
    visaUnitCostUsd: decOrNull(t.visaUnitCostUsd),
    visaFxRate: decOrNull(t.visaFxRate),
    visaUnitCostCny: decOrNull(t.visaUnitCostCny),
    // 签证公司（本次送签的供应商；非签证任务/未填 = null）
    visaSupplier: t.visaSupplier ?? null,
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
