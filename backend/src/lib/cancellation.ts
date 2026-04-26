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
  amount: number;          // 该 item 已支付金额
  hoursLeft: number | null; // 距出发 / 入住的小时；null = 不适用（如纯地面 / 签证）
  policyId: string | null;
  policyName: string;
  matchedTier: CancellationTier | null;
  feePercent: number;
  feeAmount: number;       // 手续费 ¥
  refundAmount: number;    // 应退 ¥ = amount - feeAmount
  reason: string;          // 人类可读的"为什么收这个比例"
  fulfilled: boolean;      // 该 item 是否已履约（CONFIRMED）
}

export interface CancellationQuote {
  orderId: string;
  orderNumber: string;
  paidAmount: number;
  totalFee: number;
  totalRefund: number;     // = paidAmount - totalFee
  items: ItemQuote[];
  /** 是否可取消（PAID / TICKETED 之类才能取消；DRAFT / 已 CANCELLED 不行） */
  cancellable: boolean;
  cancellableReason?: string;
}

const CANCELLABLE_STATUSES = new Set([
  'PAID',
  'PROCESSING',
  'TICKETED',
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

  const items = await Promise.all(
    order.items.map((it) => quoteItem(it, policies, cancelAt)),
  );

  const totalFee = round2(items.reduce((s, i) => s + i.feeAmount, 0));
  const paidAmount = Number(order.paidAmount);
  const totalRefund = round2(Math.max(0, paidAmount - totalFee));

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    paidAmount,
    totalFee,
    totalRefund,
    items,
    cancellable,
    cancellableReason,
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
): Promise<ItemQuote> {
  const amount = Number(item.amount);

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
