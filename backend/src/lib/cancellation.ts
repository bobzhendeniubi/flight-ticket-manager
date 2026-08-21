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
  /** 代理预存余额抵扣额（Order.prepaymentOffset）——同样是客户付出的钱，必须计入可退基数 */
  prepaymentOffsetCny: number;
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
 * 口径（现金优先）：客户付出的钱由现金（paidAmount）与预存余额抵扣（prepaymentOffset）两段组成，
 * 其中 adjustmentCny（改期费/换人费）视为**先从现金里消耗掉**的不可退成本。
 * 于是可退现金上限 = max(0, paidAmount − adjustmentCny)，应退先退现金、退不下的部分回余额。
 * 现金优先而非余额优先：现金是客户真金白银出去的，优先原路退回；剩余额度回到余额可继续下单。
 *
 * 导出供 orders.service 的 REFUNDED 流转复用——退款完成时必须按**同一口径**回补余额，
 * 否则报价说退 8000（其中 8000 回余额）、落库却按别的比例回补，账目立刻分叉。
 */
export function splitRefundBetweenCashAndBalance(input: {
  totalRefund: number;
  paidAmount: number;
  adjustmentCny: number;
  prepaymentOffsetCny: number;
}): { refundToCashCny: number; refundToBalanceCny: number } {
  const totalRefund = Math.max(0, round2(input.totalRefund));
  const cashCapacity = Math.max(0, round2(input.paidAmount - input.adjustmentCny));
  const refundToCashCny = round2(Math.min(totalRefund, cashCapacity));
  // 余额部分再夹一层 prepaymentOffset 上限：绝不回补超过当初抵扣掉的余额（防凭空造币）。
  const refundToBalanceCny = round2(
    Math.min(Math.max(0, input.prepaymentOffsetCny), round2(totalRefund - refundToCashCny)),
  );
  return { refundToCashCny, refundToBalanceCny };
}

const CANCELLABLE_STATUSES = new Set([
  'PAID',
  'PROCESSING',
  'TICKETED',
  // 改签中/已改签也允许走退款取消——状态机矩阵允许 CHANGED→REFUND_REQUESTED、
  // CHANGE_REQUESTED 亦从占座态发起，quote 层此前漏放导致这两态客户无法自助取消。
  'CHANGE_REQUESTED',
  'CHANGED',
  // PENDING_PAYMENT 的取消走另一条路（直接释放座位 + 0 费用），不走 refund
]);

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
    ? `订单状态 ${order.status} 不可取消（仅 PAID / PROCESSING / TICKETED 可走退款流程）`
    : undefined;

  // 一次性把所有 active policy 拉出来（一般几条到几十条；不分页）
  const policies = await prisma.cancellationPolicy.findMany({
    where: { isActive: true },
  });

  const grossItems = await Promise.all(
    order.items.map((it) => quoteItem(it, policies, cancelAt)),
  );

  const breakdown = computeRefundBreakdown({
    paidAmount: Number(order.paidAmount),
    prepaymentOffsetCny: Number(order.prepaymentOffset ?? 0),
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
 *     ＋ prepaymentOffset：代理用预存余额抵付的钱同样是客户付出的钱。不计入就会把
 *        「全额余额抵付单」（paidAmount=0）算成应退 ¥0，客户白丢一整单钱。
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
}): Pick<
  CancellationQuote,
  | 'paidAmount'
  | 'prepaymentOffsetCny'
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
  });

  return {
    paidAmount,
    prepaymentOffsetCny,
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

// ── 单个 item 的费率计算 ─────────────────────────────────────
async function quoteItem(
  item: OrderItem & {
    flightSchedule: { departureTime: Date } | null;
    fulfillmentTasks: Pick<FulfillmentTask, 'status' | 'type'>[];
  },
  policies: { id: string; productKind: string; scope: string | null; name: string; tiers: Prisma.JsonValue; isDefault: boolean }[],
  cancelAt: Date,
): Promise<GrossItemQuote> {
  const amount = Number(item.amount);

  // 非正金额行（优惠/减免 DISCOUNT 等）：不进费率引擎。
  // 否则"保守按 100% 收费"会算出负手续费，抵减总手续费、把应退顶高（甚至超过实收）。
  // 优惠对应退的影响已经体现在订单实收 paidAmount 里，这里 fee=0 即可。
  if (amount <= 0) {
    return {
      itemId: item.id,
      kind: item.kind,
      description: item.description,
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
      description: item.description,
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
    description: item.description,
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
