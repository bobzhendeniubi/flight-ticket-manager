/**
 * 订单金额单一口径 —— 只读侧唯一入口（审查根因 R2）。
 *
 * 背景：Order 有 8 个金额字段、OrderItem 4 个；「应收 / 已付 / 尾款 / 已收 / 立减 / 每人份额 /
 * 计佣基数」在列表 DTO、三模板、全岗总表、分房表、财务导出、经营报表、财务概览、对账台、
 * 认款建议、结算单、代理对账单、提醒、行程单、发票里各算各的。本文件把每一个数收成一个函数，
 * 调用方只准 import 这里，不准再在各自文件里写 `total + adjustmentCny`。
 *
 * ── 三条纪律 ─────────────────────────────────────────────────────────────────────
 * 1. **行为保持不变**：每个函数逐字镜像它接管的那处算法（含四舍五入的位置、有没有钳零、
 *    用不用 Decimal）。黄金测试 order-money.golden*.test.ts 钉住了合并前的数，一个都不许变。
 * 2. **不同就不同名**：两处原本算出不同数的，不在这里统一——各给一个显式命名的变体
 *    （如 isSettledByPaidAmount vs isSettledByNetReceived），让冲突可见；冲突清单登记在
 *    docs/口径决议.md「待拍板 · 金额口径冲突」，拍板前谁也不许「顺手修好」。
 * 3. **只读**：本文件不写任何资金字段；资金写入内核（收款 / 认款 / 退款 / 调价 / 计佣落库）
 *    另有实现（payments.service / receipts.service / orders.service），它们各自内联的清账公式
 *    与这里同式；等 R5 的 OrderMutation 内核落地再改调，本批不碰写路径。
 *
 * ── 口径速查（拍板依据见 docs/口径决议.md「资金 / 返佣」）────────────────────────
 *   应收 payable        = total + adjustmentCny            （0831 列表金额列改应收）
 *   已付 paid           = paidAmount                        （「已付≠水单」待拍板，本处不动）
 *   尾款 balanceDue     = 应收 − paidAmount − prepaymentOffset（负数 = 多付；抵扣视同已付）
 *   已收净额 netReceived= paidAmount + prepaymentOffset − Σ COMPLETED Refund（lib/net-received）
 *   应收余额 receivable = 应收 − 已收净额                   （账龄 / 代理欠款 / 代理对账单）
 *   每人份额 perPax*    = per-pax-share.ts 既有算法（0904：补房差挂单住乘客、签证按人、
 *                        换人费不摊）；到账 / 尾款 / 退款 / 立减是整单发生的钱，只均摊
 *   计佣基数            = 可计提行毛额 × (净额 / 毛额)，DISCOUNT 行按比例摊、FEE 不进分母，
 *                        立减是否入基数**待拍板**（现状不含，保持）
 *   订单总额 total      = 仪表盘营收 / 代理成交额 / 结算单 GMV 的 DB 聚合口径（不含售后费）
 */
import type { Prisma } from '@prisma/client';
import { OrderItemKind, ProductKind } from '@prisma/client';
import {
  netReceivedCny as netReceivedFromLib,
  sumCompletedRefundCny,
  type CompletedRefundShape,
} from './net-received.js';
import { computePerPaxShares, spreadableAdjustmentCny } from '../modules/orders/per-pax-share.js';
import { groupPassengerAdjustments } from '../modules/orders/order-adjustment-lines.js';
import type { BundleItemJson } from './json-types.js';

// ═══════════════════════════════════════════════════════════════════════════
// 基元
// ═══════════════════════════════════════════════════════════════════════════

/** Decimal / number / 空值 统一转 number（空 = 0）—— 各导出文件里那份 `dec()` 的同一实现。 */
export type MoneyLike = Prisma.Decimal | number | null | undefined;

export function toCny(v: MoneyLike): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

/** 金额保留 2 位小数（CNY，ROUND_HALF_UP 语义的 Math.round）。 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 金额 → 分（整数）。四舍五入到分，防 1000.01 这类浮点尾巴；非有限数按 0。
 * 与 receipts/receipt-matching.ts 的 toCents 逐字同式（那边接 number | string | Decimal）。
 */
export function toCents(amount: MoneyLike | string): number {
  if (amount == null) return 0;
  const n = typeof amount === 'number' ? amount : Number(String(amount));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** 均摊：整单发生的钱 ÷ 人数，两位小数。调用方按各自约定传 paxCount（通常 max(1, 人数)）。 */
export function evenShareCny(amountCny: number, paxCount: number): number {
  return round2(amountCny / paxCount);
}

// ═══════════════════════════════════════════════════════════════════════════
// 应收 / 已付 / 尾款
// ═══════════════════════════════════════════════════════════════════════════

export interface PayableOrderShape {
  total: MoneyLike;
  /** 售后费用（改期费 / 换人费 / 补房差等）；缺省按 0 */
  adjustmentCny?: number | null;
}

export interface PaidOrderShape {
  paidAmount: MoneyLike;
  /** 代理预存余额抵扣；缺省按 0（现状全库恒 0，见 lib/net-received 头注释） */
  prepaymentOffset?: MoneyLike;
}

export type BalanceOrderShape = PayableOrderShape & PaidOrderShape;

/** 订单总额（权威价 + 调整行，不含售后费）。仪表盘营收 / 代理成交额 / 结算单 GMV 在 DB 侧聚合的就是它。 */
export function grossTotalCny(order: PayableOrderShape): number {
  return toCny(order.total);
}

/**
 * 应收 = round2(total + adjustmentCny)。
 * 列表 DTO effectivePayable / 对账台 totalPayable / 议价申请 receivableCny / 发票开票金额 /
 * 财务导出 payableCny / 代理对账单 payableCny / 行程单应付 同款。
 */
export function payableCny(order: PayableOrderShape): number {
  return round2(toCny(order.total) + (order.adjustmentCny ?? 0));
}

/** 应收按人均分（代理对账单「每人结算价」列）：round2(应收 ÷ paxCount)，调用方保证 paxCount > 0。
 * ⚠️ 与 settlePerPaxFallbackCny（导出兜底：可摊应收 ÷ 人数）是两个数——换人费在这边摊、那边不摊。
 * 冲突已登记待拍板，本处只命名不统一。 */
export function payablePerPaxCny(order: PayableOrderShape, paxCount: number): number {
  return round2(payableCny(order) / paxCount);
}

/** 已付（现状口径 = paidAmount 原样；导出「到账金额」列、对账台 paidAmount 列用）。 */
export function paidCny(order: PaidOrderShape): number {
  return toCny(order.paidAmount);
}

/** 已付 + 预存抵扣（清账比较用的「客户已付出的钱」，不扣退款）。 */
export function paidWithOffsetCny(order: PaidOrderShape): number {
  return toCny(order.paidAmount) + toCny(order.prepaymentOffset);
}

/**
 * 尾款（有符号）= round2(应收 − paidAmount − prepaymentOffset)；负数 = 多付。
 * 列表 DTO balanceDue / 对账台候选 balanceDue 同款（先 round2 应收再减，与 serializeOrder 一字一致）。
 */
export function balanceDueCny(order: BalanceOrderShape): number {
  return round2(payableCny(order) - toCny(order.paidAmount) - toCny(order.prepaymentOffset));
}

/**
 * 尾款按「分」算（认款匹配引擎入参）：toCents(total) + adjustmentCny×100 − toCents(paid) − toCents(offset)。
 * 镜像 receipts.service suggestMatches 的原式：adjustmentCny 直接 ×100（整数元的售后费）而不是过 toCents。
 */
export function balanceDueCents(order: BalanceOrderShape): number {
  return (
    toCents(order.total) +
    (order.adjustmentCny ?? 0) * 100 -
    toCents(order.paidAmount) -
    toCents(order.prepaymentOffset)
  );
}

/** 提醒引擎用的 Decimal 精确尾款（total + adjustmentCny − paidAmount − prepaymentOffset，不四舍五入）。 */
export function balanceDueDecimal(order: {
  total: Prisma.Decimal;
  adjustmentCny: number;
  paidAmount: Prisma.Decimal;
  prepaymentOffset: Prisma.Decimal;
}): Prisma.Decimal {
  return order.total.plus(order.adjustmentCny).minus(order.paidAmount).minus(order.prepaymentOffset);
}

/**
 * 未收尾款（钳零、**不**四舍五入）= max(0, total + adjustmentCny − paidAmount − prepaymentOffset)。
 * 三模板 / 全岗总表「尾款金额（人均）」的分子：调用方再 evenShareCny(…, paxCount)。
 * 故意不先 round2：镜像导出现有算式，避免在 ÷ 人数之前多一次舍入把那一分钱挪走。
 */
export function outstandingRawCny(order: BalanceOrderShape): number {
  return Math.max(
    0,
    toCny(order.total) + (order.adjustmentCny ?? 0) - toCny(order.paidAmount) - toCny(order.prepaymentOffset),
  );
}

/**
 * 是否清账 · **按已付**口径：paidAmount + prepaymentOffset ≥ total + adjustmentCny（不扣退款，不四舍五入）。
 * 三模板《全岗可用》与全岗总表的「是否清账」列用。
 * ⚠️ 与 isSettledByNetReceived（财务导出）是两个算法：先收后退的单这里会显示「是」。冲突已登记待拍板。
 */
export function isSettledByPaidAmount(order: BalanceOrderShape): boolean {
  return paidWithOffsetCny(order) >= toCny(order.total) + (order.adjustmentCny ?? 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// 已收 / 退款
// ═══════════════════════════════════════════════════════════════════════════

/** 已完成退款行（查询侧已按 status='COMPLETED' 过滤）。 */
export type CompletedRefundLike = CompletedRefundShape;

/**
 * 已完成退款合计 —— 从**未过滤**的 refunds 里按 status 挑 COMPLETED 再求和（不四舍五入）。
 * 全岗总表 / 三模板 include 了全部退款行（含在途），它们在内存里过滤；查询侧已过滤的调用方请直接用
 * sumCompletedRefundCny（lib/net-received）。
 */
export function completedRefundTotalCny(
  refunds: ReadonlyArray<{ amount: MoneyLike; status: string }> | null | undefined,
): number {
  if (refunds == null) return 0;
  return refunds.filter((r) => r.status === 'COMPLETED').reduce((s, r) => s + toCny(r.amount), 0);
}

/** 已收净额 = paidAmount + prepaymentOffset − Σ COMPLETED Refund（转调 lib/net-received，唯一实现）。 */
export function netReceivedCny(
  order: PaidOrderShape,
  completedRefunds: readonly CompletedRefundLike[] | null | undefined,
): number {
  return netReceivedFromLib(order, sumCompletedRefundCny(completedRefunds));
}

/**
 * 应收余额 = round2(total + adjustmentCny − 已收净额)，可为负 = 多付（调用方自行决定钳不钳）。
 * 应收账龄 / 代理欠款（reports.service balanceOf）同款：应收**不先** round2，与原式一字一致。
 */
export function receivableBalanceCny(
  order: BalanceOrderShape,
  completedRefunds: readonly CompletedRefundLike[] | null | undefined,
): number {
  return round2(toCny(order.total) + (order.adjustmentCny ?? 0) - netReceivedCny(order, completedRefunds));
}

/**
 * 是否清账 · **按已收净额**口径：已收净额 ≥ 应收（扣已完成退款）。财务导出「是否清账」列用。
 * ⚠️ 与 isSettledByPaidAmount（三模板 / 全岗总表）是两个算法，冲突已登记待拍板。
 */
export function isSettledByNetReceived(
  order: BalanceOrderShape,
  completedRefunds: readonly CompletedRefundLike[] | null | undefined,
): boolean {
  return netReceivedCny(order, completedRefunds) >= payableCny(order);
}

/**
 * 已收减已退（**不含**预存抵扣、不四舍五入）= paidAmount − Σ COMPLETED Refund。
 * 财务概览对 REFUNDED 订单补的那笔负项用的是这条，而不是 netReceivedCny——差一个 prepaymentOffset。
 * 现状全库 prepaymentOffset 恒 0 所以数字相同，但公式不同，故单独命名；冲突已登记待拍板。
 */
export function paidMinusCompletedRefundsCny(
  order: { paidAmount: MoneyLike },
  completedRefunds: readonly CompletedRefundLike[] | null | undefined,
): number {
  const refunded = (completedRefunds ?? []).reduce((s, r) => s + toCny(r.amount), 0);
  return toCny(order.paidAmount) - refunded;
}

// ═══════════════════════════════════════════════════════════════════════════
// 立减
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 结算价立减合计（未撤销的立减快照行 |amount| 之和，**不**四舍五入）。
 * 全岗总表「抵扣金额」= evenShareCny(本值, paxCount)；代理对账单 = round2(本值)。
 */
export function settlementDiscountTotalCny(
  items: ReadonlyArray<{ amount: MoneyLike; metadata: unknown }>,
): number {
  let sum = 0;
  for (const item of items) {
    const metadata = item.metadata;
    if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
    const m = metadata as { settlementDiscount?: unknown; settlementDiscountRevoked?: unknown };
    if (m.settlementDiscount !== true || m.settlementDiscountRevoked === true) continue;
    sum += Math.abs(toCny(item.amount));
  }
  return sum;
}

// ═══════════════════════════════════════════════════════════════════════════
// 每人份额（转调 per-pax-share.ts 的既有算法，不重写）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 可摊应收（**不**四舍五入）= total + spreadableAdjustmentCny：换人费 / 换人差价（excludeFromPerPax）
 * 挂在已不在单上的被换人头上，不进分子。三模板 / 全岗总表 / 分房表「结算价格」的均摊兜底分子。
 */
export function spreadablePayableRawCny(order: {
  total: MoneyLike;
  adjustmentCny?: number | null;
  adjustments?: unknown;
}): number {
  return toCny(order.total) + spreadableAdjustmentCny(order);
}

/**
 * 结算价格的均摊兜底 = round2(可摊应收 ÷ paxCount)；只在乘客不在按人表里时用到。
 * ⚠️ 与 payablePerPaxCny（代理对账单：应收 ÷ 人数，换人费也摊）是两个数，冲突已登记待拍板。
 */
export function settlePerPaxFallbackCny(
  order: { total: MoneyLike; adjustmentCny?: number | null; adjustments?: unknown },
  paxCount: number,
): number {
  return round2(spreadablePayableRawCny(order) / paxCount);
}

/**
 * 「结算价格」列的**按乘客**取值 —— 全岗总表与《全岗可用》《签证专用》《分房表》《代理对账单》共用的唯一口径。
 *
 * 改前：整单 total ÷ 人数，四个人一律同一个数。同单不同价的单（某人补签证多收 800、
 * 某人自备签少收 360）导出来看不出差别，与订单详情页「每人结算价」表也对不上。
 *
 * 改后：直接复用权威口径 —— `computePerPaxShares`（backend/src/modules/orders/per-pax-share.ts，
 * 与前端 admin-web/src/lib/perPaxSettlement.ts 逐分对拍、拆单搬钱也走它）：
 *   应收总额 = total + adjustmentCny；基准每人 = (应收 − Σ按乘客调价净额) ÷ 人数；
 *   每人结算价 = 基准每人 + 该乘客调价净额。全员合计恒等于应收总额。
 * 按乘客调价净额取自 `groupPassengerAdjustments`（只认 metadata.priceAdjustment=true 且挂了
 * passengerId 的行；整单调价行留在基准里，不重复计）。
 *
 * 口径变化（需知会运营）：应收含 adjustmentCny（改期费/换人费等售后费，原先不在本列里），
 * 与详情页每人结算价、尾款列（本就含 adjustmentCny）从此同源。
 */
export function perPaxSettlementByPassenger(order: {
  total: MoneyLike;
  adjustmentCny?: number | null;
  /** 售后费流水（换人费/换人差价带 excludeFromPerPax，不参与均摊，见 spreadableAdjustmentCny）。 */
  adjustments?: unknown;
  passengers: ReadonlyArray<{ id: string }>;
  items: ReadonlyArray<{
    id: string;
    amount: MoneyLike;
    description: string;
    passengerId?: string | null;
    metadata?: unknown;
  }>;
}): Map<string, number> {
  const { byPassenger } = groupPassengerAdjustments(
    order.items.map((it) => ({
      id: it.id,
      amount: toCny(it.amount),
      description: it.description,
      passengerId: it.passengerId ?? null,
      metadata: it.metadata,
    })),
  );
  const { rows } = computePerPaxShares({
    totalCny: toCny(order.total),
    // 可摊售后费：换人费/换人差价（excludeFromPerPax）记在被换下去的人头上，不摊给同行人与新客。
    adjustmentCny: spreadableAdjustmentCny(order),
    // 按 id 升序传入：computePerPaxShares 把分级余数（那一分钱）兜给**数组最后一位**，
    // 而 order.passengers 的查询没有 orderBy —— 行序会随任何一次 UPDATE 漂移，
    // 同一张单两次导出那一分钱可能换人头，财务对数时看着像有人改过价。
    // 只排序、不动算法（口径仍在 per-pax-share.ts，与前端逐分对拍）；
    // 返回的是 Map，输出顺序与本处排序无关。
    passengerIds: [...order.passengers.map((p) => p.id)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    netByPassenger: new Map(
      Object.entries(byPassenger).map(([pid, bucket]) => [pid, bucket.netCny]),
    ),
  });
  return new Map(rows.map((r) => [r.passengerId, r.shareCny]));
}

/**
 * 「签证金额」列的**按乘客**取值 —— 全岗总表与《全岗可用》共用的唯一口径。
 *
 * 改前：整单合计 ÷ 人数，四个人一律同一个数。两处失真（运营反馈那张四人单：两人自备签、
 * 套餐签证挂牌价 240/人，导出来四人各 60）：
 *   · 自备签（visaExempt）的客人没走我方签证，套餐价里也按 selfVisaDeductCny 给他减掉了，
 *     这列却照样分到一份；
 *   · 套餐签证挂牌价快照 metadata.visaListSnapshotCny 是**每人**口径（套餐定义 items 的
 *     qty×unitPrice，与 products/bundle-pricing.ts 的 visaPerPax 同源），改前当成整单合计
 *     再 ÷ 人数，多人单被压低 N 倍（单人单恰好看不出来）。
 *
 * 改后：
 *   · 独立 VISA 行的实收金额是整单口径（qty = 买签证的人数）→ 在**非自备签**乘客间均摊；
 *     全员 exempt 却仍有 VISA 行（矛盾数据）时在全员间均摊，钱不凭空消失。
 *   · 套餐签证挂牌价（快照优先；老单无快照回退现行定义 qty×unitPrice，与旧版一致）是每人
 *     口径 → 非自备签乘客各记一份，自备签乘客记 0。
 *   · 自备签乘客 = 0 + 0 = 0。
 * 本列仍是「挂牌价 / 实收」的核对口径：客人付的是折后套餐总价，这里不是实收拆分额。
 */
export function perPaxVisaAmountByPassenger(order: {
  passengers: ReadonlyArray<{ id: string; visaExempt?: boolean | null }>;
  items: ReadonlyArray<{
    kind: string;
    amount: MoneyLike;
    metadata?: unknown;
    bundle?: { items: unknown } | null;
  }>;
}): Map<string, number> {
  const standaloneTotal = order.items
    .filter((it) => it.kind === 'VISA')
    .reduce((s, it) => s + toCny(it.amount), 0);
  const bundleListPerPax = order.items.reduce((s, it) => {
    if (it.kind !== 'BUNDLE') return s;
    // B14 快照优先（2026-07-20）：下单时把签证挂牌价快照进 metadata.visaListSnapshotCny
    //（含 0 = 当时不含签证组件），历史导出钉死在下单时点，不再随套餐改价漂移。
    const meta = (it.metadata ?? null) as { visaListSnapshotCny?: unknown } | null;
    if (meta && typeof meta.visaListSnapshotCny === 'number') {
      return s + meta.visaListSnapshotCny;
    }
    const components = Array.isArray(it.bundle?.items)
      ? (it.bundle!.items as unknown as BundleItemJson[])
      : [];
    return (
      s +
      components
        .filter((c) => c && c.kind === 'VISA')
        .reduce((acc, c) => acc + (Number(c.qty) || 0) * (Number(c.unitPrice) || 0), 0)
    );
  }, 0);
  const payers = order.passengers.filter((p) => p.visaExempt !== true);
  const sharers = payers.length > 0 ? payers : order.passengers;
  const standalonePerPax = sharers.length > 0 ? standaloneTotal / sharers.length : 0;
  const sharerIds = new Set(sharers.map((p) => p.id));
  return new Map(
    order.passengers.map((p) => {
      const standalone = sharerIds.has(p.id) ? standalonePerPax : 0;
      const bundle = p.visaExempt === true ? 0 : bundleListPerPax;
      return [p.id, round2(standalone + bundle)];
    }),
  );
}

/**
 * 「单房差」列的**按乘客**取值 —— 全岗总表与《全岗可用》共用的唯一口径。
 *
 * 改前（全岗总表）读的是订单行 metadata.singleRoomDiff —— 系统从没写过这个字段，整列恒 0；
 *《全岗可用》则干脆留空。单房差的真实来源有两处：
 *   · 下单时的单住：套餐行 metadata.addOns.singleSupplementTotal（= singleCount × 每晚差 × 晚数）；
 *   · 事后补收：kind=FEE、metadata.reasonCode='ROOM_DIFF' 的补收单房差行（addRoomSupplement），
 *     新行带 passengerId 指向转单住的那位乘客；老行没挂人。
 * 这两笔钱都只属于「单住」的乘客（Passenger.singleRoom=true），不该摊给拼房的人。
 *
 * 取值：挂了人的补收行直接记到该乘客；其余（套餐单住小计 + 未挂人的补收行）在**还没有专属补收行的
 * 单住乘客**间均摊。没有任何单住乘客却有钱（脏数据）→ 全员均摊，钱不凭空消失。
 */
export function perPaxSingleRoomDiffByPassenger(order: {
  passengers: ReadonlyArray<{ id: string; singleRoom?: boolean | null }>;
  items: ReadonlyArray<{
    kind: string;
    amount: MoneyLike;
    passengerId?: string | null;
    metadata?: unknown;
  }>;
}): Map<string, number> {
  const linked = new Map<string, number>();
  let pool = 0;
  for (const it of order.items) {
    const meta = (it.metadata ?? null) as
      | { reasonCode?: unknown; addOns?: { singleSupplementTotal?: unknown } | null }
      | null;
    if (it.kind === 'FEE' && meta?.reasonCode === 'ROOM_DIFF') {
      if (it.passengerId) {
        linked.set(it.passengerId, round2((linked.get(it.passengerId) ?? 0) + toCny(it.amount)));
      } else {
        pool += toCny(it.amount);
      }
    } else if (it.kind === 'BUNDLE') {
      const v = meta?.addOns?.singleSupplementTotal;
      if (typeof v === 'number') pool += v;
    }
  }
  const singles = order.passengers.filter((p) => p.singleRoom === true);
  const unlinkedSingles = singles.filter((p) => !linked.has(p.id));
  const sharers =
    pool === 0
      ? []
      : unlinkedSingles.length > 0
        ? unlinkedSingles
        : singles.length > 0
          ? singles
          : order.passengers;
  const sharerIds = new Set(sharers.map((p) => p.id));
  const share = sharers.length > 0 ? pool / sharers.length : 0;
  return new Map(
    order.passengers.map((p) => [
      p.id,
      round2((linked.get(p.id) ?? 0) + (sharerIds.has(p.id) ? share : 0)),
    ]),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 计佣基数（现状口径；立减是否入基数待拍板）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 订单行 kind → 计佣产品档。映射表里没有的 kind 不参与计提，当前为：
 *   INSURANCE / FEE（机建燃油）/ DISCOUNT / GUIDE / UPGRADE_CHANGE / OVERSALE。
 * 改 OrderItemKind 时记得回来核一遍这份名单，别让新 kind 静默漏计（BUNDLE 就是这么漏的）。
 * BUNDLE 是独立一档费率，不复用 FLIGHT 档：套餐单会拆成 FLIGHT 腿 + BUNDLE 行，两行金额相加即全包价、
 * 互不重叠，故两者同时计提不构成重复计佣。计佣基数就是 BUNDLE 行自身的 amount，不去拆套餐的组件。
 *
 * ⚠️ orders.service createCommissionsForOrder（计佣落库，写路径）里还有一份同名同内容的私有副本与
 * 同式的内联算法——本批不碰写路径，那份等 R5 内核落地时改调这里；下面的单测钉住两边同式。
 */
export const ORDER_ITEM_KIND_TO_PRODUCT_KIND: Partial<Record<OrderItemKind, ProductKind>> = {
  FLIGHT: ProductKind.FLIGHT,
  HOTEL: ProductKind.HOTEL,
  TRANSFER: ProductKind.TRANSFER,
  VISA: ProductKind.VISA,
  BUNDLE: ProductKind.BUNDLE,
};

export interface CommissionBaseResult {
  /** 可计提毛额 G = Σ(映射表里有 productKind 的行 amount)，两位小数 */
  grossCommissionableCny: number;
  /** 折扣总额 D = Σ(DISCOUNT 行 amount)，本身为负，两位小数 */
  discountTotalCny: number;
  /** 可计提净额 N = max(0, round2(G + D)) */
  netCommissionableCny: number;
  /** 折扣分摊比例 = N / G；G ≤ 0 时为 0（不用负基数或 1 兜底） */
  discountRatio: number;
}

/**
 * 计佣基数（财务已拍板：返佣按实收算，折扣从基数里扣掉）。
 *
 * 算法（折扣按可计提行的毛额比例分摊）：
 *   可计提毛额 G = Σ(映射表里有 productKind 的行 amount)
 *   折扣总额   D = Σ(DISCOUNT 行 amount)     // 本身为负
 *   可计提净额 N = max(0, G + D)
 *   每行计佣基数 = 行 amount × (N / G)        // 见 commissionBaseForItemCny
 * 例：BUNDLE 450 + FLIGHT 800 + FLIGHT 1000 + DISCOUNT −1032
 *     → G=2250、D=−1032、N=1218、ratio=0.541333…
 *     → 243.60 / 433.07 / 541.33，合计 1218.00 = 订单实收。
 *
 * 只摊到「可计提行」上，不摊给 FEE/INSURANCE/GUIDE/UPGRADE_CHANGE/OVERSALE：
 *   · FEE 是机建燃油等代收代付（转手交航司，本就不打折），把它算进分母会稀释比例、
 *     让计佣基数虚高，等于折扣没扣干净；
 *   · 其余几类另有口径且本来就不计佣，进分母同样只会把基数抬高。
 *   把它们排除在分母外 = 折扣全额由可计提行承担，这是对代理最保守（绝不多付）的口径。
 *
 * ⚠️ 下面这处不对称是**财务明确拍板保留的，不是遗漏，复审时不要"顺手修好"**：
 *   结算价与系统标价的差额按正负走两个不同的行类型（见 orders.service buildSettlementTotalItem）——
 *     谈定价 **低于** 标价 → 落 DISCOUNT（负）→ **扣减**计佣基数；
 *     谈定价 **高于** 标价 → 落 FEE（正）  → **不加**计佣基数。
 *   即「少收的要减佣、多收的不加佣」，两头都对我方有利、永远少付不多付。
 *
 * 立减（settlementDiscount 快照行）也是 DISCOUNT 行 → 现状**已从基数里扣掉**（口径决议 2026-08-25
 * 「立减与佣金」写的「不含立减」指的就是这个：基数按折后实收）；是否应改为含立减，待拍板，本处保持。
 *
 * G ≤ 0（整单只有折扣行 / 没有任何可计提行）→ ratio=0 → 所有基数为 0 → 不建任何记录。
 */
export function computeCommissionBase(
  items: ReadonlyArray<{ kind: OrderItemKind; amount: MoneyLike }>,
): CommissionBaseResult {
  let grossCommissionable = 0;
  let discountTotal = 0;
  for (const item of items) {
    if (ORDER_ITEM_KIND_TO_PRODUCT_KIND[item.kind]) {
      grossCommissionable += toCny(item.amount);
    } else if (item.kind === OrderItemKind.DISCOUNT) {
      discountTotal += toCny(item.amount);
    }
  }
  grossCommissionable = round2(grossCommissionable);
  discountTotal = round2(discountTotal);
  // N 先 round2 再相除：G/D 都是 2 位小数金额，先规整能消掉浮点累加的尾巴（如 …0000001）。
  const netCommissionable = Math.max(0, round2(grossCommissionable + discountTotal));
  const discountRatio = grossCommissionable > 0 ? netCommissionable / grossCommissionable : 0;
  return {
    grossCommissionableCny: grossCommissionable,
    discountTotalCny: discountTotal,
    netCommissionableCny: netCommissionable,
    discountRatio,
  };
}

/**
 * 单行计佣基数 = 行毛额 × 折扣分摊比例（无折扣时 ratio=1，等于毛额，存量语义不变）。
 * 逐行 round2：每行误差 ≤ 0.005 元，Σ基数 与 N 的偏差上界 = 0.005 × 可计提行数，
 * 且佣金金额还要再乘费率，落到钱上远小于 1 分，无可见漂移。
 */
export function commissionBaseForItemCny(amount: MoneyLike, discountRatio: number): number {
  return round2(toCny(amount) * discountRatio);
}
