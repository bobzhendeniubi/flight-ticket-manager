/**
 * 取消订单 · 退款手续费引擎
 *
 * 输入：订单 + 取消时刻
 * 输出：每个 OrderItem 的费率 + 总手续费 + 应退金额 + 不可退原因
 *
 * 规则：
 *   1. 每个 OrderItem 按 kind 查 CancellationPolicy（先 scope 精确，否则 isDefault）
 *   2. 计算"距离起飞 / 入住 / 履约时间"的小时数
 *   3. 在 tiers 里找匹配档：取 hoursBeforeDeparture <= hoursLeft 中 hoursBeforeDeparture 最大的一档
 *      没匹配（i.e. hoursLeft < 0）→ 找 hoursBeforeDeparture = -1 那条（"已履约"档），收 100%
 *   4. 已 CONFIRMED 的 fulfillment task → 强制 100% 手续费（覆盖时间档）
 *   5. INSURANCE / 其他 kind 没策略 → 默认 100%（保守）
 *
 * 设计取舍：
 *   - 实时计算，不缓存。policy 改完立即生效。
 *   - 不做"已退款的部分二次退" — 同订单同 item 只能取消一次。
 */
import { type FulfillmentStatus, type FulfillmentTask, type Order, type OrderItem, type Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import {
  isReturnCurrentlyReleased,
  stripInternalLegPrefix,
} from '../modules/orders/orders.leg-status.js';

export interface CancellationTier {
  hoursBeforeDeparture: number; // -1 = 已履约
  feePercent: number;           // 0 - 100
}

export interface ItemQuote {
  itemId: string;
  kind: string;
  description: string;
  amount: number;          // 该 item 的**毛价**（明细行金额，未扣立减 / SETTLEMENT 差额）
  /**
   * 该 item 实际分摊到的已付金额 = amount × feeScale（见 CancellationQuote.feeScale）。
   * 手续费与应退都以它为基数——「按什么收费」必须与「按什么退钱」同源。
   */
  paidShare: number;
  hoursLeft: number | null; // 距出发 / 入住的小时；null = 不适用（如纯地面 / 签证）
  policyId: string | null;
  policyName: string;
  matchedTier: CancellationTier | null;
  feePercent: number;
  feeAmount: number;       // 手续费 ¥ = paidShare × feePercent%
  refundAmount: number;    // 应退 ¥ = paidShare - feeAmount
  reason: string;          // 人类可读的"为什么收这个比例"
  fulfilled: boolean;      // 该 item 是否已履约（CONFIRMED）
}

export interface CancellationQuote {
  orderId: string;
  orderNumber: string;
  /** 现金实收（Order.paidAmount） */
  paidAmount: number;
  /** 代理预存余额抵扣额（旧列 Order.prepaymentOffset）——无生产代码写入，恒为 0，仅为兼容保留 */
  prepaymentOffsetCny: number;
  /**
   * 本单预存余额抵扣毛额 = |Σ PrepaymentTransaction(OFFSET).amount|（唯一真源是流水）。
   * 抵扣当时已累加进 Order.paidAmount（见 applyAgentBalanceToOrder），故它是 paidAmount 的
   * **内含**部分，绝不再加进可退基数（那等于凭空放宽退款上限）；只用来把应退拆成
   * 「退现金 / 退回余额」两段 —— 口径与 orders.service 落 REFUNDED 的执行侧同源。
   */
  offsetGrossCny: number;
  /** 改期费 / 换人费（Order.adjustmentCny）——已发生的不可退成本，从可退基数里剔除 */
  adjustmentCny: number;
  /** 可退基数 = max(0, paidAmount + prepaymentOffset − adjustmentCny) */
  refundableBaseCny: number;
  /** 手续费折算系数 = min(1, 可退基数 ÷ 明细毛价合计)；毛价合计为 0 时为 0 */
  feeScale: number;
  totalFee: number;
  totalRefund: number;     // = refundableBaseCny − totalFee
  /** 应退里退回现金的部分（财务实际打款额） */
  refundToCashCny: number;
  /** 应退里退回代理预存余额的部分（由 REFUNDED 流转写 PrepaymentTransaction(REFUND) 回补） */
  refundToBalanceCny: number;
  items: ItemQuote[];
  /** 是否可取消（PAID / TICKETED 之类才能取消；DRAFT / 已 CANCELLED 不行） */
  cancellable: boolean;
  cancellableReason?: string;
}

/**
 * 把「应退总额」拆成 退现金 / 退回代理预存余额 两部分。
 *
 * 口径（现金优先）：客户付出的钱由现金与预存余额抵扣两段组成，其中 adjustmentCny
 *（改期费/换人费）视为**先从现金里消耗掉**的不可退成本。应退先退现金、退不下的部分回余额。
 * 现金优先而非余额优先：现金是客户真金白银出去的，优先原路退回；剩余额度回到余额可继续下单。
 *
 * 两条余额口径（**互斥**，正常只会有 offsetGrossCny 一条）：
 *   · offsetGrossCny —— 流水口径（唯一真源）：|Σ PrepaymentTransaction(OFFSET)|。这笔钱抵扣当时
 *     已累加进 paidAmount，所以现金侧上限要先把它扣掉：realCash = max(0, paidAmount − offsetGross)。
 *   · prepaymentOffsetCny —— 旧列 Order.prepaymentOffset（无生产代码写入，恒为 0）。它按「不含在
 *     paidAmount 里」的旧口径参与，故不从现金侧扣减。保留只为不破坏既有调用与用例。
 *
 * 导出供 orders.service 的 REFUNDED 流转对照——退款完成时必须按**同一口径**回补余额，
 * 否则报价说退 8000（其中 8000 回余额）、落库却按别的比例回补，账目立刻分叉。
 */
export function splitRefundBetweenCashAndBalance(input: {
  totalRefund: number;
  paidAmount: number;
  adjustmentCny: number;
  prepaymentOffsetCny: number;
  /** 预存余额抵扣毛额（已内含在 paidAmount 里）；缺省 0 = 无余额抵扣流水，行为与旧版逐位一致。 */
  offsetGrossCny?: number;
}): { refundToCashCny: number; refundToBalanceCny: number } {
  const totalRefund = Math.max(0, round2(input.totalRefund));
  const offsetGrossCny = Math.max(0, round2(input.offsetGrossCny ?? 0));
  // 真·现金 = 实收合计 − 余额抵扣毛额。按**毛额**而非净额（已回补不减 paidAmount，用净额会让
  // 已回补的部分在下一次分批批准时摇身变成「现金」，同一笔钱退两遍）。
  const realCash = Math.max(0, round2(input.paidAmount - offsetGrossCny));
  const cashCapacity = Math.max(0, round2(realCash - input.adjustmentCny));
  const refundToCashCny = round2(Math.min(totalRefund, cashCapacity));
  // 余额部分再夹一层抵扣毛额上限：绝不回补超过当初抵扣掉的余额（防凭空造币）。
  const balanceCap = Math.max(0, round2(input.prepaymentOffsetCny)) + offsetGrossCny;
  const refundToBalanceCny = round2(
    Math.min(balanceCap, Math.max(0, round2(totalRefund - refundToCashCny))),
  );
  return { refundToCashCny, refundToBalanceCny };
}

/**
 * 可走「取消 → 退款」流程的订单状态。
 *
 * FAILED（出票失败）在列：出票失败恰恰是最该退款的场景，此前漏放导致这类单只能靠 ADMIN
 * 手动 PATCH 状态硬推 REFUNDED（不生成 Refund、不算退改费，账目直接分叉）。座位账无副作用——
 * FAILED 属 SEAT_RELEASING_STATUSES，座位在落 FAILED 时就已释放，转 REFUND_REQUESTED 时
 * wasHolding=false → 释放分支短路，不会二次放座；佣金亦已在落 FAILED 时冲销，且冲销只挑
 * ACCRUED/SETTLED，重复推进天然幂等。
 *
 * PENDING_PAYMENT 的取消走另一条路（直接释放座位 + 0 费用），不走 refund。
 */
export const CANCELLABLE_STATUSES = new Set([
  'PAID',
  'PROCESSING',
  'TICKETED',
  // 改签中/已改签也允许走退款取消——状态机矩阵允许 CHANGED→REFUND_REQUESTED、
  // CHANGE_REQUESTED 亦从占座态发起，quote 层此前漏放导致这两态客户无法自助取消。
  'CHANGE_REQUESTED',
  'CHANGED',
  'FAILED',
]);

/** 报错文案里列可取消状态：中文名单一处维护，避免与集合漂移。 */
const CANCELLABLE_STATUS_LABELS_ZH: Record<string, string> = {
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '出票完成',
  CHANGE_REQUESTED: '改期申请中',
  CHANGED: '已改期',
  FAILED: '出票失败',
};

/**
 * 主入口：计算订单的 cancellation quote。只读，不改任何状态。
 */
export async function computeCancellationQuote(
  orderId: string,
  cancelAt: Date = new Date(),
): Promise<CancellationQuote> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: {
        include: {
          flightSchedule: { select: { departureTime: true } },
          fulfillmentTasks: { select: { status: true, type: true } },
        },
      },
    },
  });
  if (!order) throw new Error(`Order ${orderId} not found`);

  const cancellable = CANCELLABLE_STATUSES.has(order.status);
  const cancellableReason = !cancellable
    ? `订单状态 ${order.status} 不可取消（仅 ${[...CANCELLABLE_STATUSES]
        .map((s) => CANCELLABLE_STATUS_LABELS_ZH[s] ?? s)
        .join(' / ')} 可走退款流程）`
    : undefined;

  // 一次性把所有 active policy 拉出来（一般几条到几十条；不分页）
  const policies = await prisma.cancellationPolicy.findMany({
    where: { isActive: true },
  });

  const grossItems = await Promise.all(
    order.items.map((it) => quoteItem(it, policies, cancelAt)),
  );

  // ── 预存余额抵扣毛额：按流水现算，绝不读 Order.prepaymentOffset ────────────────
  // 那一列没有任何生产代码写入（恒为 0），照它算出来的「退回余额」恒为 0 —— 预存抵付过的单
  // 报价上永远显示「全额退现金」，而落 REFUNDED 的执行侧按流水回补余额，报价与落库当场分叉。
  // 唯一真源是 PrepaymentTransaction(OFFSET)（负数），口径与 orders.service 的 REFUNDED 分支同源。
  // 无归属代理的单必然没有 OFFSET 流水（applyAgentBalanceToOrder 硬要求 order.agentId），跳过查询。
  const offsetRows = order.agentId
    ? await prisma.prepaymentTransaction.findMany({
        where: { orderId: order.id, type: 'OFFSET' },
        select: { amount: true },
      })
    : [];
  const offsetGrossCny = round2(
    offsetRows.reduce((s, r) => s + Math.abs(Number(r.amount)), 0),
  );

  const breakdown = computeRefundBreakdown({
    paidAmount: Number(order.paidAmount),
    prepaymentOffsetCny: Number(order.prepaymentOffset ?? 0),
    offsetGrossCny,
    adjustmentCny: Number(order.adjustmentCny ?? 0),
    grossItems,
  });

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    ...breakdown,
    cancellable,
    cancellableReason,
  };
}

/** computeRefundBreakdown 的行级输入：只用到毛价与毛价口径手续费，其余字段原样带过。 */
export type GrossItemQuote = Omit<ItemQuote, 'paidShare'>;

/**
 * 退款金额引擎（纯函数，无 IO —— 便于直接单测各种金额组合）。
 *
 * ── 口径修正（旧版有两处系统性偏差）────────────────────────────────────
 * 旧口径：手续费按**明细毛价**逐行算，应退却按 paidAmount 扣 —— 两个基数不同源，于是
 *   · 立减 / SETTLEMENT 差额行把实收压低后，毛价算出的手续费在实收里占比被放大
 *     （毛价 12000、收敛后实收 6000、20% 档 → 扣 2400，实际费率 40%，应扣 1200）；
 *   · adjustmentCny（改期费/换人费）已含在 paidAmount 里却不参与手续费计算，
 *     取消时被原样退还给客户（公司净损）。
 *
 * 新口径：两个基数强制同源。
 *   可退基数 refundableBaseCny = max(0, paidAmount + prepaymentOffset − adjustmentCny)
 *     ＋ prepaymentOffset：旧列 Order.prepaymentOffset（恒 0，无生产代码写入），保留只为兼容。
 *        代理用预存余额抵付的钱同样是客户付出的钱，但那笔钱抵扣当时已被累加进 paidAmount
 *       （见 applyAgentBalanceToOrder），已含在基数里 —— 它只经 offsetGrossCny 参与
 *        「退现金 / 退回余额」的拆分，**绝不再加一次**（加了等于凭空放宽退款上限）。
 *     － adjustmentCny：改期费/换人费对应**已发生且不可退**的成本，不进可退基数。
 *   手续费折算系数 feeScale = min(1, 可退基数 ÷ 明细毛价合计)，逐行折算后再求和。
 *     · 夹到 ≤1：客户多付（实收 > 毛价）时不把手续费一起放大。
 *     · 毛价合计为 0（整单只剩优惠行等）→ feeScale=0：不收手续费，可退基数原样退。
 *   逐行折算而不是只折总额：Refund.gatewayPayload.quoteSnapshot 的行级 feeAmount/refundAmount
 *     是佣金按比例冲销的输入（ratio = 退款额 ÷ (退款额+退改费)）。同比例缩放后该比值不变，
 *     佣金冲销口径不受本次修正影响。
 *
 * ⚠️ 本函数的输出直接决定退给客户多少钱。改动前请同步复核 orders.service 的
 *    「批准退款资金守恒断言」（Σ退款 ≤ paidAmount + prepaymentOffset）与余额回补口径。
 */
export function computeRefundBreakdown(input: {
  paidAmount: number;
  prepaymentOffsetCny: number;
  adjustmentCny: number;
  grossItems: GrossItemQuote[];
  /**
   * 预存余额抵扣毛额（流水口径，**已内含在 paidAmount 里**）。缺省 0 = 无余额抵扣，
   * 输出与旧版逐位一致。只影响「退现金 / 退回余额」的拆分，不影响可退基数与手续费。
   */
  offsetGrossCny?: number;
}): Pick<
  CancellationQuote,
  | 'paidAmount'
  | 'prepaymentOffsetCny'
  | 'offsetGrossCny'
  | 'adjustmentCny'
  | 'refundableBaseCny'
  | 'feeScale'
  | 'totalFee'
  | 'totalRefund'
  | 'refundToCashCny'
  | 'refundToBalanceCny'
  | 'items'
> {
  const { paidAmount, prepaymentOffsetCny, adjustmentCny, grossItems } = input;
  const offsetGrossCny = Math.max(0, round2(input.offsetGrossCny ?? 0));
  const refundableBaseCny = round2(
    Math.max(0, paidAmount + prepaymentOffsetCny - adjustmentCny),
  );
  const grossPositiveCny = round2(grossItems.reduce((s, i) => s + Math.max(0, i.amount), 0));
  const feeScale = grossPositiveCny > 0 ? Math.min(1, refundableBaseCny / grossPositiveCny) : 0;

  const items: ItemQuote[] = grossItems.map((i) => {
    const paidShare = round2(Math.max(0, i.amount) * feeScale);
    const feeAmount = round2(i.feeAmount * feeScale);
    return { ...i, paidShare, feeAmount, refundAmount: round2(paidShare - feeAmount) };
  });

  const totalFee = round2(items.reduce((s, i) => s + i.feeAmount, 0));
  // 应退硬上限 = 可退基数：绝不退超过客户实际付进来（现金 + 余额抵扣）的钱。
  const totalRefund = round2(Math.max(0, Math.min(refundableBaseCny, refundableBaseCny - totalFee)));
  const { refundToCashCny, refundToBalanceCny } = splitRefundBetweenCashAndBalance({
    totalRefund,
    paidAmount,
    adjustmentCny,
    prepaymentOffsetCny,
    offsetGrossCny,
  });

  return {
    paidAmount,
    prepaymentOffsetCny,
    offsetGrossCny,
    adjustmentCny,
    refundableBaseCny,
    feeScale,
    totalFee,
    totalRefund,
    refundToCashCny,
    refundToBalanceCny,
    items,
  };
}

/** quoteItem 的入参形状（导出供按行报价的调用方组装查询）。 */
export type CancellationQuoteItem = OrderItem & {
  flightSchedule: { departureTime: Date } | null;
  fulfillmentTasks: Pick<FulfillmentTask, 'status' | 'type'>[];
};

/**
 * 单行取消报价（公开入口）——「只取消其中一段航段」这类**部分取消**的手续费口径。
 *
 * 与整单报价 computeCancellationQuote 共用同一个 quoteItem，绝不另写一份费率算法：
 * 政策匹配、已履约强制 100%、时间档命中全部同源，改政策两处同时生效。
 * 区别只在基数：整单报价会再乘 feeScale（把毛价折算到实收口径），部分取消没有「整单实收」
 * 这个概念，手续费就按**这一行自己的金额**算 —— 返回的正是折算前的毛价口径行报价。
 *
 * db 可传事务客户端，让报价与执行落在同一事务快照里（政策表在事务中途被改也不会分叉）。
 */
export async function quoteCancellationForItem(
  item: CancellationQuoteItem,
  cancelAt: Date = new Date(),
  db: Pick<Prisma.TransactionClient, 'cancellationPolicy'> = prisma,
): Promise<GrossItemQuote> {
  const policies = await db.cancellationPolicy.findMany({ where: { isActive: true } });
  return quoteItem(item, policies, cancelAt);
}

// ── 单个 item 的费率计算 ─────────────────────────────────────
//
// ⚠ 行 description 一律走 stripInternalLegPrefix：退款报价是**直接给代理/客户看的单据**
//（前台退款页与订单详情的退款卡片都渲染它），内部岗位的操作留痕前缀（【去程未登机】/
//【回程座位已释放】/【已取消去程】…）不该出现在上面 —— 口径同 serializeOrder 的对外脱敏分支。
async function quoteItem(
  item: OrderItem & {
    flightSchedule: { departureTime: Date } | null;
    fulfillmentTasks: Pick<FulfillmentTask, 'status' | 'type'>[];
  },
  policies: { id: string; productKind: string; scope: string | null; name: string; tiers: Prisma.JsonValue; isDefault: boolean }[],
  cancelAt: Date,
): Promise<GrossItemQuote> {
  const amount = Number(item.amount);

  // ── 已释放 / 已作废的航段行：一律 0 退款，**显式分支，绝不靠兜底** ────────────────
  // 座位已经放回库存重新卖掉了（回程 no-show 释放）或整段已作废（取消航段 / 起飞后作废，
  // 金额已归零），这份收入不能再退给客户第二次。
  // 不能指望 hoursLeft === null 落进「无出发时间取最严档」的兜底：那条路取的是
  // policy.tiers 里 feePercent 最大的一档，默认 FLIGHT 政策把最严档配成 50% 时，
  // 一个座位已被重卖的航段会退掉一半钱。
  //
  // ⚠ 判据必须是「有释放/作废留痕」，**不能只看 flightScheduleId 为空**：
  // 天生就没绑班次的 FLIGHT 行（手工补录、地面段占位、导入的历史单）也满足 flightScheduleId===null，
  // 把它们一并判成 0 退 = 客人交的钱一分不退，且报价上写着「已释放/已作废」这种查无实据的理由。
  // 那类行维持本分支加进来之前的行为：往下走费率引擎，按「无出发时间取最严档」处理。
  const legMeta =
    item.metadata != null && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, unknown>)
      : {};
  const legVoided = legMeta.returnLegCancelled != null || legMeta.returnVoidedFinal != null;
  if (item.kind === 'FLIGHT' && item.flightScheduleId === null &&
      (isReturnCurrentlyReleased(item) || legVoided)) {
    return {
      itemId: item.id,
      kind: item.kind,
      // 对外报价里不露内部留痕前缀（【回程座位已释放】/【已取消去程】…）——
      // 退款报价是直接给代理/客户看的单据，内部岗位怎么标不该出现在上面。
      description: stripInternalLegPrefix(item.description),
      amount,
      hoursLeft: null,
      policyId: null,
      policyName: '（该航段不在本单行程内）',
      matchedTier: null,
      feePercent: 100,
      feeAmount: round2(Math.max(0, amount)),
      refundAmount: 0,
      // 对外中性文案：客户看到的是「这段已经不在你的行程里了」，不是我方内部怎么处置的座位。
      reason: '该航段已不在本单行程内，不参与退款',
      fulfilled: item.fulfillmentTasks.some(
        (t) => t.status === ('CONFIRMED' as FulfillmentStatus),
      ),
    };
  }

  // 非正金额行（优惠/减免 DISCOUNT 等）：不进费率引擎。
  // 否则"保守按 100% 收费"会算出负手续费，抵减总手续费、把应退顶高（甚至超过实收）。
  // 优惠对应退的影响已经体现在订单实收 paidAmount 里，这里 fee=0 即可。
  if (amount <= 0) {
    return {
      itemId: item.id,
      kind: item.kind,
      description: stripInternalLegPrefix(item.description),
      amount,
      hoursLeft: null,
      policyId: null,
      policyName: '（优惠/减免行，不计手续费）',
      matchedTier: null,
      feePercent: 0,
      feeAmount: 0,
      refundAmount: 0,
      reason: '优惠/减免行不参与取消手续费计算',
      fulfilled: false,
    };
  }

  // 1. 找 policy（先精确 scope 匹配，否则 isDefault）
  const scopeId =
    item.kind === 'FLIGHT' ? item.flightScheduleId :
    item.kind === 'HOTEL'  ? item.hotelRoomTypeId :
    item.kind === 'BUNDLE' ? item.bundleId :
    item.kind === 'VISA'   ? item.visaId :
    item.kind === 'TRANSFER' ? item.transferId :
    null;

  const exact = scopeId
    ? policies.find((p) => p.productKind === item.kind && p.scope === scopeId)
    : null;
  const fallback = policies.find((p) => p.productKind === item.kind && p.isDefault);
  const policy = exact ?? fallback;

  // 2. 已履约？(对应 fulfillment task 是 CONFIRMED) → 100% fee
  const fulfilled = item.fulfillmentTasks.some(
    (t) => t.status === ('CONFIRMED' as FulfillmentStatus),
  );

  // 3. 算 hoursLeft（FLIGHT 用 schedule.departureTime；HOTEL 用 checkIn；其他 null）
  const refTime =
    item.kind === 'FLIGHT' ? item.flightSchedule?.departureTime :
    item.kind === 'HOTEL'  ? item.hotelCheckIn :
    null;
  const hoursLeft = refTime
    ? (refTime.getTime() - cancelAt.getTime()) / 3_600_000
    : null;

  if (!policy) {
    // 没策略 → 100% fee（保守）
    return {
      itemId: item.id,
      kind: item.kind,
      description: stripInternalLegPrefix(item.description),
      amount,
      hoursLeft,
      policyId: null,
      policyName: '（无策略，保守按 100% 收费）',
      matchedTier: null,
      feePercent: 100,
      feeAmount: amount,
      refundAmount: 0,
      reason: `${item.kind} 类型未配置取消策略，按 100% 手续费`,
      fulfilled,
    };
  }

  // 4. 找匹配 tier
  let tier: CancellationTier | null = null;
  let reason = '';
  const tiers = parseTiers(policy.tiers);

  if (fulfilled) {
    // 已履约 → 找 -1 档；找不到 → 100%
    tier = tiers.find((t) => t.hoursBeforeDeparture === -1) ?? { hoursBeforeDeparture: -1, feePercent: 100 };
    reason = `已履约（出票/确认/派单完成），收 ${tier.feePercent}% 手续费`;
  } else if (hoursLeft === null) {
    // 没参考时间（VISA / TRANSFER），用最严的一档（hoursBeforeDeparture 最小或 -1）
    tier = pickMostStrict(tiers);
    reason = `${item.kind} 无明确出发时间，按最严格档收 ${tier.feePercent}%`;
  } else {
    // 找 tier.hoursBeforeDeparture <= hoursLeft 中最大的（即"刚好踩进的最早档"）
    const sorted = tiers
      .filter((t) => t.hoursBeforeDeparture >= 0)
      .sort((a, b) => b.hoursBeforeDeparture - a.hoursBeforeDeparture);
    tier = sorted.find((t) => hoursLeft >= t.hoursBeforeDeparture) ?? null;
    if (!tier) {
      // hoursLeft < 0 (已起飞) → 取 -1 档
      tier = tiers.find((t) => t.hoursBeforeDeparture === -1) ?? { hoursBeforeDeparture: -1, feePercent: 100 };
      reason = `已过出发时间，收 ${tier.feePercent}% 手续费`;
    } else {
      reason = `距离出发 ${hoursLeft.toFixed(1)}h，匹配「>=${tier.hoursBeforeDeparture}h」档：${tier.feePercent}% 手续费`;
    }
  }

  const feeAmount = round2(amount * (tier.feePercent / 100));
  return {
    itemId: item.id,
    kind: item.kind,
    description: stripInternalLegPrefix(item.description),
    amount,
    hoursLeft,
    policyId: policy.id,
    policyName: policy.name,
    matchedTier: tier,
    feePercent: tier.feePercent,
    feeAmount,
    refundAmount: round2(amount - feeAmount),
    reason,
    fulfilled,
  };
}

function parseTiers(json: Prisma.JsonValue): CancellationTier[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((t) => {
      if (typeof t !== 'object' || t === null) return null;
      const obj = t as Record<string, unknown>;
      const h = Number(obj.hoursBeforeDeparture);
      const f = Number(obj.feePercent);
      if (Number.isNaN(h) || Number.isNaN(f)) return null;
      return { hoursBeforeDeparture: h, feePercent: Math.max(0, Math.min(100, f)) };
    })
    .filter((t): t is CancellationTier => t !== null);
}

function pickMostStrict(tiers: CancellationTier[]): CancellationTier {
  // 最严 = feePercent 最大
  if (tiers.length === 0) return { hoursBeforeDeparture: -1, feePercent: 100 };
  return tiers.reduce((max, t) => (t.feePercent > max.feePercent ? t : max));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── tier 校验（admin CRUD 时用）──
export interface TierValidationResult {
  ok: boolean;
  error?: string;
  /** 校验通过时返回排好序的 tiers（hoursBeforeDeparture 降序），可直接存库 */
  normalized?: CancellationTier[];
}
export function validateTiers(tiers: unknown): TierValidationResult {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { ok: false, error: 'tiers 必须是非空数组' };
  }
  const seen = new Set<number>();
  const parsed: CancellationTier[] = [];
  let hasNonNegative = false;
  for (const t of tiers) {
    if (typeof t !== 'object' || t === null) return { ok: false, error: 'tier 必须是对象' };
    const o = t as Record<string, unknown>;
    if (typeof o.hoursBeforeDeparture !== 'number' || !Number.isFinite(o.hoursBeforeDeparture)) {
      return { ok: false, error: 'hoursBeforeDeparture 必须是有限数字' };
    }
    if (typeof o.feePercent !== 'number' || !Number.isFinite(o.feePercent)) {
      return { ok: false, error: 'feePercent 必须是有限数字' };
    }
    if (o.feePercent < 0 || o.feePercent > 100) {
      return { ok: false, error: 'feePercent 必须在 0-100' };
    }
    if (o.hoursBeforeDeparture !== -1 && o.hoursBeforeDeparture < 0) {
      return { ok: false, error: `hoursBeforeDeparture 只允许 >= 0 或 = -1（"已履约"档），不接受其他负数（${o.hoursBeforeDeparture}）` };
    }
    if (seen.has(o.hoursBeforeDeparture)) {
      return { ok: false, error: `hoursBeforeDeparture 重复：${o.hoursBeforeDeparture}` };
    }
    seen.add(o.hoursBeforeDeparture);
    if (o.hoursBeforeDeparture >= 0) hasNonNegative = true;
    parsed.push({ hoursBeforeDeparture: o.hoursBeforeDeparture, feePercent: o.feePercent });
  }
  if (!hasNonNegative) {
    return { ok: false, error: '至少需要一个 hoursBeforeDeparture >= 0 的档（否则所有取消都按"已起飞"100% 收费）' };
  }
  // 规范化：hoursBeforeDeparture 降序（-1 排到末尾）；这样运行时找匹配只需顺序扫描
  const normalized = [...parsed].sort((a, b) => {
    if (a.hoursBeforeDeparture === -1) return 1;
    if (b.hoursBeforeDeparture === -1) return -1;
    return b.hoursBeforeDeparture - a.hoursBeforeDeparture;
  });
  return { ok: true, normalized };
}

// 把 Order 类型 export 出去给 routes 用
export type OrderForQuote = Order;
