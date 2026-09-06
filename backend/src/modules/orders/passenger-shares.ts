/**
 * 按人份额 —— 纯函数层（审查根因 R1：业务按人算账、系统按订单建模）。
 *
 * 本文件**不含任何算法**：每人份额的口径仍然只有一份 ——
 *   · 每人结算价   lib/order-money.perPaxSettlementByPassenger（per-pax-share.computePerPaxShares + 按人调价分组）
 *   · 签证金额     lib/order-money.perPaxVisaAmountByPassenger
 *   · 单房差       lib/order-money.perPaxSingleRoomDiffByPassenger
 *   · 立减均摊     lib/order-money.evenShareCny(settlementDiscountTotalCny(items), 人数)
 * 这里只做三件事：
 *   1. computePassengerShareRows —— 把上面几个 Map 拼成「每人一行」的落库形状，并把每人结算价拆成
 *      基准（baseCny）+ 该乘客按人调价净额（adjustmentCny），拆法就是算法自己的定义（settlement = base + net），
 *      不是第二套算法；
 *   2. assertSharesReconcile —— 守恒：Σ 每人结算价 + 换人费等不摊条目 = 应收（lib/order-money.payableCny），逐分；
 *   3. resolvePassengerShares —— 读侧优先级：库里有完整的一套（每位在单乘客一行、算法版本一致）就用库里的，
 *      否则派生（老单 / 尚未回填），并把来源标出来（PERSISTED / DERIVED）给 DTO 与调用方。
 *
 * 落库值与派生值必须逐分相等（passenger-shares.test.ts 用黄金夹具钉死）。算法要改口径时改 lib/order-money，
 * 然后把 PASSENGER_SHARE_ALGO_VERSION 换个值：读侧会把旧版本行视为「没有」重新派生并顺手回填。
 */
import {
  evenShareCny,
  payableCny,
  perPaxSettlementByPassenger,
  perPaxSingleRoomDiffByPassenger,
  perPaxVisaAmountByPassenger,
  settlementDiscountTotalCny,
  toCents,
  toCny,
  type MoneyLike,
} from '../../lib/order-money.js';
import type { Prisma } from '@prisma/client';
import { spreadableAdjustmentCny } from './per-pax-share.js';
import { groupPassengerAdjustments } from './order-adjustment-lines.js';

/**
 * 算法版本戳。改任何一个 perPax* 的口径都要换值：老行会被读侧当作「没有」重新派生并回填，
 * 回填脚本 / 端点也据此挑出旧版本行重算。
 */
export const PASSENGER_SHARE_ALGO_VERSION = 'per-pax-share@2026-09-04';

/** 一行份额（CNY，两位小数）。settlementCny = baseCny + adjustmentCny。 */
export interface PassengerShareRow {
  passengerId: string;
  /** 每人结算价（应收份额）—— perPaxSettlementByPassenger */
  settlementCny: number;
  /** 均摊基准 = settlementCny − adjustmentCny */
  baseCny: number;
  /** 该乘客名下「按乘客调价」净额 */
  adjustmentCny: number;
  /** 签证金额 —— perPaxVisaAmountByPassenger */
  visaCny: number;
  /** 单房差 —— perPaxSingleRoomDiffByPassenger */
  singleRoomDiffCny: number;
  /** 立减均摊 —— evenShareCny(settlementDiscountTotalCny, 人数) */
  discountCny: number;
}

/** 算份额需要的订单形状（写点从库里按 SHARE_SOURCE_SELECT 读；读侧各自的 include 只要覆盖这些字段即可）。 */
export interface ShareSourceOrder {
  total: MoneyLike;
  adjustmentCny?: number | null;
  adjustments?: unknown;
  passengers: ReadonlyArray<{ id: string; visaExempt?: boolean | null; singleRoom?: boolean | null }>;
  items: ReadonlyArray<{
    id: string;
    kind: string;
    amount: MoneyLike;
    description: string;
    passengerId?: string | null;
    metadata?: unknown;
    /** 套餐定义（签证挂牌价老单回退用）；窄 select 没带 items 时按无组件处理 */
    bundle?: { items?: unknown; [key: string]: unknown } | null;
  }>;
}

/**
 * 读侧 include：与 pickPersistedShares 需要的字段一致。所有读订单的 include / select
 *（ORDER_FULL_INCLUDE / getOrder / listOrders / 三导出 / 分房表 / 代理对账单）都挂这一份。
 */
export const PASSENGER_SHARES_INCLUDE = {
  select: {
    passengerId: true,
    settlementCny: true,
    baseCny: true,
    adjustmentCny: true,
    visaCny: true,
    singleRoomDiffCny: true,
    discountCny: true,
    algoVersion: true,
    computedAt: true,
  },
} satisfies Prisma.Order$passengerSharesArgs;

export interface PassengerShareComputation {
  rows: PassengerShareRow[];
  /** 应收 = payableCny(order)（total + adjustmentCny） */
  payableCny: number;
  /** 换人费 / 换人差价等 excludeFromPerPax 条目合计：记在已不在单上的被换人头上，不进任何一行 */
  excludedCny: number;
  algoVersion: string;
}

const centsToCny = (cents: number): number => cents / 100;

/**
 * 把三个权威 Map 拼成每人一行。每人结算价拆成 base + net：net 直接取 groupPassengerAdjustments 的按人净额
 *（与 perPaxSettlementByPassenger 内部喂给 computePerPaxShares 的是同一个数），base 是差。
 */
export function computePassengerShareRows(order: ShareSourceOrder): PassengerShareComputation {
  const settlement = perPaxSettlementByPassenger(order);
  const visa = perPaxVisaAmountByPassenger({
    passengers: order.passengers,
    items: order.items.map((it) => ({
      kind: it.kind,
      amount: it.amount,
      metadata: it.metadata,
      bundle: it.bundle ? { items: it.bundle.items ?? null } : null,
    })),
  });
  const singleRoom = perPaxSingleRoomDiffByPassenger(order);
  const { byPassenger } = groupPassengerAdjustments(
    order.items.map((it) => ({
      id: it.id,
      amount: toCny(it.amount),
      description: it.description,
      passengerId: it.passengerId ?? null,
      metadata: it.metadata,
    })),
  );
  const paxCount = order.passengers.length;
  const discountPerPax =
    paxCount > 0
      ? evenShareCny(
          settlementDiscountTotalCny(order.items.map((it) => ({ amount: it.amount, metadata: it.metadata ?? null }))),
          paxCount,
        )
      : 0;

  const rows: PassengerShareRow[] = order.passengers.map((p) => {
    const settlementCents = toCents(settlement.get(p.id) ?? 0);
    const netCents = toCents(byPassenger[p.id]?.netCny ?? 0);
    return {
      passengerId: p.id,
      settlementCny: centsToCny(settlementCents),
      baseCny: centsToCny(settlementCents - netCents),
      adjustmentCny: centsToCny(netCents),
      visaCny: visa.get(p.id) ?? 0,
      singleRoomDiffCny: singleRoom.get(p.id) ?? 0,
      discountCny: discountPerPax,
    };
  });

  const adjustmentCents = toCents(order.adjustmentCny ?? 0);
  const spreadableCents = toCents(spreadableAdjustmentCny(order));
  return {
    rows,
    payableCny: payableCny(order),
    excludedCny: centsToCny(adjustmentCents - spreadableCents),
    algoVersion: PASSENGER_SHARE_ALGO_VERSION,
  };
}

/**
 * 守恒断言：有乘客时 Σ 每人结算价 + 不摊条目 = 应收，逐分。写点在事务内调用 —— 不平即抛，整事务回滚
 *（与 OrderMutation 内核的账本恒等式同一口吻）。
 */
export function assertSharesReconcile(comp: PassengerShareComputation, label = '按人份额'): void {
  if (comp.rows.length === 0) return;
  const sumCents = comp.rows.reduce((s, r) => s + toCents(r.settlementCny), 0);
  const expected = toCents(comp.payableCny);
  const actual = sumCents + toCents(comp.excludedCny);
  if (actual !== expected) {
    throw new Error(
      `${label}守恒断言失败：Σ 每人结算价 ¥${centsToCny(sumCents)} + 不摊条目 ¥${comp.excludedCny} ≠ 应收 ¥${comp.payableCny}（已回滚）`,
    );
  }
  for (const r of comp.rows) {
    if (toCents(r.baseCny) + toCents(r.adjustmentCny) !== toCents(r.settlementCny)) {
      throw new Error(
        `${label}守恒断言失败：乘客 ${r.passengerId} 基准 ¥${r.baseCny} + 净额 ¥${r.adjustmentCny} ≠ 结算价 ¥${r.settlementCny}（已回滚）`,
      );
    }
  }
}

// ── 读侧 ────────────────────────────────────────────────────────────────

/** 库里一行的最小形状（Prisma 返回 Decimal；DTO / 测试可传 number）。 */
export interface PersistedShareLike {
  passengerId: string;
  settlementCny: MoneyLike;
  baseCny: MoneyLike;
  adjustmentCny: MoneyLike;
  visaCny: MoneyLike;
  singleRoomDiffCny: MoneyLike;
  discountCny: MoneyLike;
  algoVersion?: string | null;
  computedAt?: Date | string | null;
}

export type SharesSource = 'PERSISTED' | 'DERIVED';

export interface ResolvedPassengerShares {
  rows: Map<string, PassengerShareRow>;
  source: SharesSource;
  payableCny: number;
  excludedCny: number;
  /** PERSISTED 时取库里最早的一次 computedAt（多行同批写入，取最小值即可）；DERIVED 为 null */
  computedAt: Date | null;
}

function toRow(p: PersistedShareLike): PassengerShareRow {
  return {
    passengerId: p.passengerId,
    settlementCny: toCny(p.settlementCny),
    baseCny: toCny(p.baseCny),
    adjustmentCny: toCny(p.adjustmentCny),
    visaCny: toCny(p.visaCny),
    singleRoomDiffCny: toCny(p.singleRoomDiffCny),
    discountCny: toCny(p.discountCny),
  };
}

/**
 * 库里的一套是否「完整可用」：每位**当前在单**的乘客恰有一行、且算法版本是当前版本。
 * 多出来的行（乘客已被拆走 / 换单，写点还没来得及清）忽略不算错；少一行或版本不对 → null（视为没有）。
 */
export function pickPersistedShares(order: {
  passengers: ReadonlyArray<{ id: string }>;
  passengerShares?: ReadonlyArray<PersistedShareLike> | null;
}): { rows: Map<string, PassengerShareRow>; computedAt: Date | null } | null {
  const persisted = order.passengerShares;
  if (!Array.isArray(persisted)) return null;
  const byPid = new Map<string, PersistedShareLike>();
  for (const s of persisted) {
    if (s && typeof s.passengerId === 'string' && s.algoVersion === PASSENGER_SHARE_ALGO_VERSION) {
      byPid.set(s.passengerId, s);
    }
  }
  const rows = new Map<string, PassengerShareRow>();
  let computedAt: Date | null = null;
  for (const p of order.passengers) {
    const s = byPid.get(p.id);
    if (!s) return null;
    rows.set(p.id, toRow(s));
    const at = s.computedAt == null ? null : new Date(s.computedAt);
    if (at && !Number.isNaN(at.getTime()) && (computedAt === null || at < computedAt)) computedAt = at;
  }
  return { rows, computedAt };
}

/**
 * 读侧唯一入口：先读库（pickPersistedShares），没有就派生（computePassengerShareRows）。
 * 派生这一支**不落库**——落库是 service/passenger-shares.ts 的事（lazy 回填在那边、失败不影响读）。
 */
export function resolvePassengerShares(
  order: ShareSourceOrder & { passengerShares?: ReadonlyArray<PersistedShareLike> | null },
): ResolvedPassengerShares {
  const adjustmentCents = toCents(order.adjustmentCny ?? 0);
  const excludedCny = centsToCny(adjustmentCents - toCents(spreadableAdjustmentCny(order)));
  const persisted = pickPersistedShares(order);
  if (persisted) {
    return {
      rows: persisted.rows,
      source: 'PERSISTED',
      payableCny: payableCny(order),
      excludedCny,
      computedAt: persisted.computedAt,
    };
  }
  const comp = computePassengerShareRows(order);
  return {
    rows: new Map(comp.rows.map((r) => [r.passengerId, r])),
    source: 'DERIVED',
    payableCny: comp.payableCny,
    excludedCny: comp.excludedCny,
    computedAt: null,
  };
}

/** 两套行是否逐分相等（一致性测试 / 回填校验用）。 */
export function shareRowsEqual(a: ReadonlyArray<PassengerShareRow>, b: ReadonlyArray<PassengerShareRow>): boolean {
  if (a.length !== b.length) return false;
  const byPid = new Map(b.map((r) => [r.passengerId, r]));
  const keys: Array<keyof Omit<PassengerShareRow, 'passengerId'>> = [
    'settlementCny',
    'baseCny',
    'adjustmentCny',
    'visaCny',
    'singleRoomDiffCny',
    'discountCny',
  ];
  return a.every((ra) => {
    const rb = byPid.get(ra.passengerId);
    return rb !== undefined && keys.every((k) => toCents(ra[k]) === toCents(rb[k]));
  });
}

/** 导出 / 对账单用的三张 Map（passengerId → 金额），与改前 perPax*ByPassenger 的返回形状一致。 */
export function sharesAsMaps(resolved: ResolvedPassengerShares): {
  settlement: Map<string, number>;
  visa: Map<string, number>;
  singleRoomDiff: Map<string, number>;
  source: SharesSource;
} {
  const settlement = new Map<string, number>();
  const visa = new Map<string, number>();
  const singleRoomDiff = new Map<string, number>();
  for (const [pid, r] of resolved.rows) {
    settlement.set(pid, r.settlementCny);
    visa.set(pid, r.visaCny);
    singleRoomDiff.set(pid, r.singleRoomDiffCny);
  }
  return { settlement, visa, singleRoomDiff, source: resolved.source };
}
