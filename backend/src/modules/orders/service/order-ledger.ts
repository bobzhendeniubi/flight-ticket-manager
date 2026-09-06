/**
 * 订单账本快照与守恒断言 —— OrderMutation 内核的「守恒」这一条腿。
 *
 * 口径全部复用既有函数、不新造：
 *   · 座位 / 升舱位 / 房数 / 成本四维的求和（sumFlightQuantities / sumFlightUpgradeCounts /
 *     sumRoomsBilledHalves / sumTotalCostCents）原本住在 split.ts 的拆单守恒断言（§11），
 *     搬到这里让内核与拆单共用同一份实现；
 *   · 「Σ 每人份额 = 应收」复用 per-pax-share.computePerPaxShares（余数兜给最后一位，合计恒等于应收）
 *     与 order-adjustment-lines.groupPassengerAdjustments（按人调价行归到人头）；
 *   · 「subtotal = Σ items.amount、total = subtotal」是建单与改结算价的既有口径
 *     （create.ts「目前没有 taxes / discount，直接等于 subtotal」；pricing-adjust.ts「锁内重新聚合 items 算 subtotal/total」）；
 *   · 「应收不为负」是取消航段「不许把应收退成负数」与拆单审计（负 total）的既定闸。
 *
 * 两种断言：
 *   1. assertLedgerUnchanged(before, after, dims)：前后快照在点名的维度上 Σ 恒等（钱不动 / 座不动 / 房不动 / 成本不动）；
 *   2. assertNoNewLedgerViolations(before, after)：单张订单的账本恒等式，**只拦本次新引入的**不平——
 *      存量脏单本来就不平的，动作不碰钱时照旧放行（否则一张历史坏单会把所有售后动作全卡死）。
 */
import { OrderItemKind, type CabinClass, type Prisma } from '@prisma/client';
import { readUpgradeCount } from '../split-move-strategies.js';
import { computePerPaxShares, spreadableAdjustmentCny } from '../per-pax-share.js';
import { groupPassengerAdjustments } from '../order-adjustment-lines.js';
import { readJsonObject } from './leg-action-log.js';

/** 守恒断言用的行形状（拆前读 loadOrderForSplit、拆后读两单 findMany，字段一致）。 */
export interface SplitConservationRow {
  kind: OrderItemKind;
  flightScheduleId?: string | null;
  flightCabin?: CabinClass | null;
  quantity?: number;
  metadata?: unknown;
  roomsBilled?: Prisma.Decimal | number | null;
  totalCostCny?: Prisma.Decimal | number | null;
}

/** 逐班次舱位数量账（拆单座位守恒断言用）：key = `${scheduleId}|${cabin}` → Σquantity。 */
export function sumFlightQuantities(
  items: ReadonlyArray<{
    kind: OrderItemKind;
    flightScheduleId: string | null;
    flightCabin: CabinClass | null;
    quantity: number;
  }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const it of items) {
    if (it.kind !== OrderItemKind.FLIGHT || !it.flightScheduleId) continue;
    const key = `${it.flightScheduleId}|${it.flightCabin ?? 'NONE'}`;
    map.set(key, (map.get(key) ?? 0) + it.quantity);
  }
  return map;
}

/**
 * 逐班次舱位的**升舱位**账：key = `${scheduleId}|${cabin}` → Σ min(升舱人数, 该行座位数)。
 * 升舱位对应的是真实商务舱库存，拆单一旦把它放大就等于凭空占了商务舱座。
 */
export function sumFlightUpgradeCounts(items: ReadonlyArray<SplitConservationRow>): Map<string, number> {
  const map = new Map<string, number>();
  for (const it of items) {
    if (it.kind !== OrderItemKind.FLIGHT || !it.flightScheduleId) continue;
    const count = readUpgradeCount(readJsonObject(it.metadata));
    if (count <= 0) continue;
    const key = `${it.flightScheduleId}|${it.flightCabin ?? 'NONE'}`;
    map.set(key, (map.get(key) ?? 0) + Math.min(count, it.quantity ?? 0));
  }
  return map;
}

/** Σ roomsBilled（以「半间」为整数单位，避免 0.5 的浮点尾数）。 */
export function sumRoomsBilledHalves(items: ReadonlyArray<SplitConservationRow>): number {
  return items.reduce(
    (sum, it) => sum + (it.roomsBilled == null ? 0 : Math.round(Number(it.roomsBilled) * 2)),
    0,
  );
}

/** Σ totalCostCny（以「分」为整数单位）。 */
export function sumTotalCostCents(items: ReadonlyArray<SplitConservationRow>): number {
  return items.reduce(
    (sum, it) => sum + (it.totalCostCny == null ? 0 : Math.round(Number(it.totalCostCny) * 100)),
    0,
  );
}

// ── 快照 ────────────────────────────────────────────────────────────────

/**
 * 守恒维度：
 *   receivable = Σ(total + adjustmentCny)（应收）；paid = Σ(paidAmount + prepaymentOffset)（已收 + 预存抵扣）；
 *   seats = 逐班次舱位 Σquantity + 逐班次舱位升舱位；rooms = Σ 计费房数；cost = Σ 成本。
 */
export type LedgerDimension = 'receivable' | 'paid' | 'seats' | 'rooms' | 'cost';

export const LEDGER_DIMENSION_LABEL: Record<LedgerDimension, string> = {
  receivable: '应收（total + 售后费）',
  paid: '已收（paidAmount + 预存抵扣）',
  seats: '座位（逐班次舱位 Σquantity / 升舱位）',
  rooms: '计费房数',
  cost: '成本',
};

/** 快照读的 select：与拆单守恒断言的 conservationSelect + 行形状同源，外加账本恒等式要的 subtotal / adjustments / 乘客。 */
export const LEDGER_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  subtotal: true,
  total: true,
  adjustmentCny: true,
  adjustments: true,
  paidAmount: true,
  prepaymentOffset: true,
  passengers: { select: { id: true } },
  items: {
    select: {
      id: true,
      kind: true,
      description: true,
      amount: true,
      quantity: true,
      passengerId: true,
      flightScheduleId: true,
      flightCabin: true,
      metadata: true,
      roomsBilled: true,
      totalCostCny: true,
    },
  },
} as const;

export interface LedgerItemRow extends SplitConservationRow {
  id: string;
  description?: string | null;
  amount?: Prisma.Decimal | number | null;
  passengerId?: string | null;
}

/**
 * 一张订单的账本行。关系数组按可选处理：真库在 LEDGER_ORDER_SELECT 下必有，
 * 但快照读侧要对「部分 select 的行」宽容（读到什么算什么，缺的维度按 0 计）。
 */
export interface LedgerOrderRow {
  id: string;
  orderNumber?: string | null;
  subtotal?: Prisma.Decimal | number | null;
  total?: Prisma.Decimal | number | null;
  adjustmentCny?: number | null;
  adjustments?: unknown;
  paidAmount?: Prisma.Decimal | number | null;
  prepaymentOffset?: Prisma.Decimal | number | null;
  passengers?: ReadonlyArray<{ id: string }> | null;
  items?: ReadonlyArray<LedgerItemRow> | null;
}

export interface OrderLedgerSnapshot {
  /** 点名要看的订单 id（含尚不存在的：拆单前的新单读不到就不计入 rows）。 */
  orderIds: string[];
  rows: LedgerOrderRow[];
  receivableCents: number;
  paidCents: number;
  seats: Map<string, number>;
  upgrades: Map<string, number>;
  roomsHalves: number;
  costCents: number;
}

type LedgerDb = Pick<Prisma.TransactionClient, 'order'>;

const cents = (v: Prisma.Decimal | number | null | undefined): number => Math.round(Number(v ?? 0) * 100);

/** 读一组订单的账本快照（订单不存在 → 不计入，拆单前的新单就是这种情况）。 */
export async function snapshotOrderLedger(db: LedgerDb, orderIds: readonly string[]): Promise<OrderLedgerSnapshot> {
  const ids = [...new Set(orderIds)];
  const rows: LedgerOrderRow[] = [];
  for (const id of ids) {
    const row = (await db.order.findUnique({ where: { id }, select: LEDGER_ORDER_SELECT })) as
      | LedgerOrderRow
      | null
      | undefined;
    if (row) rows.push(row);
  }
  return buildLedgerSnapshot(ids, rows);
}

/** 纯函数：从已读到的行拼快照（单测 / 拆单侧已有行时直接用，不再读库）。 */
export function buildLedgerSnapshot(orderIds: readonly string[], rows: readonly LedgerOrderRow[]): OrderLedgerSnapshot {
  const items = rows.flatMap((r) => r.items ?? []);
  let receivableCents = 0;
  let paidCents = 0;
  for (const r of rows) {
    receivableCents += cents(r.total) + cents(r.adjustmentCny);
    paidCents += cents(r.paidAmount) + cents(r.prepaymentOffset);
  }
  const seatRows = items.map((it) => ({
    kind: it.kind,
    flightScheduleId: it.flightScheduleId ?? null,
    flightCabin: it.flightCabin ?? null,
    quantity: it.quantity ?? 0,
  }));
  return {
    orderIds: [...orderIds],
    rows: [...rows],
    receivableCents,
    paidCents,
    seats: sumFlightQuantities(seatRows),
    upgrades: sumFlightUpgradeCounts(items),
    roomsHalves: sumRoomsBilledHalves(items),
    costCents: sumTotalCostCents(items),
  };
}

// ── 断言 1：前后 Σ 恒等 ─────────────────────────────────────────────────

function mapDiff(before: Map<string, number>, after: Map<string, number>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const diffs: string[] = [];
  for (const k of keys) {
    const b = before.get(k) ?? 0;
    const a = after.get(k) ?? 0;
    if (a !== b) diffs.push(`${k} ${b}→${a}`);
  }
  return diffs;
}

/**
 * 前后快照在点名维度上必须 Σ 恒等；不平即抛（调用方在事务内 → 整事务回滚）。
 * 错误文案沿用拆单守恒断言的口吻（「…守恒断言失败：…（已回滚）」）。
 */
export function assertLedgerUnchanged(
  before: OrderLedgerSnapshot,
  after: OrderLedgerSnapshot,
  dims: readonly LedgerDimension[],
  label: string,
): void {
  const problems: string[] = [];
  for (const dim of dims) {
    switch (dim) {
      case 'receivable':
        if (before.receivableCents !== after.receivableCents) {
          problems.push(`${LEDGER_DIMENSION_LABEL.receivable} ¥${before.receivableCents / 100}→¥${after.receivableCents / 100}`);
        }
        break;
      case 'paid':
        if (before.paidCents !== after.paidCents) {
          problems.push(`${LEDGER_DIMENSION_LABEL.paid} ¥${before.paidCents / 100}→¥${after.paidCents / 100}`);
        }
        break;
      case 'seats': {
        const d = [...mapDiff(before.seats, after.seats), ...mapDiff(before.upgrades, after.upgrades).map((s) => `升舱位 ${s}`)];
        if (d.length) problems.push(`${LEDGER_DIMENSION_LABEL.seats} ${d.join('，')}`);
        break;
      }
      case 'rooms':
        if (before.roomsHalves !== after.roomsHalves) {
          problems.push(`${LEDGER_DIMENSION_LABEL.rooms} ${before.roomsHalves / 2}→${after.roomsHalves / 2} 间`);
        }
        break;
      case 'cost':
        if (before.costCents !== after.costCents) {
          problems.push(`${LEDGER_DIMENSION_LABEL.cost} ¥${before.costCents / 100}→¥${after.costCents / 100}`);
        }
        break;
    }
  }
  if (problems.length) {
    throw new Error(`${label}守恒断言失败：${problems.join('；')}（已回滚）`);
  }
}

// ── 断言 2：单张订单的账本恒等式 ──────────────────────────────────────

export type LedgerViolationKind =
  | 'SUBTOTAL_NE_ITEMS' // subtotal ≠ Σ items.amount
  | 'TOTAL_NE_SUBTOTAL' // total ≠ subtotal（当前无 taxes / discount）
  | 'NEGATIVE_TOTAL' // total < 0
  | 'PER_PAX_SUM' // Σ 每人份额 ≠ 应收
  | 'ORPHAN_PER_PAX_ADJUSTMENT'; // 挂人的调价行找不到人

export interface LedgerViolation {
  orderId: string;
  orderNumber: string | null;
  kind: LedgerViolationKind;
  detail: string;
}

/** 一张订单的账本恒等式检查（纯函数；返回违反项，空数组 = 全平）。 */
export function ledgerIdentityViolations(row: LedgerOrderRow): LedgerViolation[] {
  const out: LedgerViolation[] = [];
  const push = (kind: LedgerViolationKind, detail: string) =>
    out.push({ orderId: row.id, orderNumber: row.orderNumber ?? null, kind, detail });
  const items = row.items ?? [];
  const subtotalCents = cents(row.subtotal);
  const totalCents = cents(row.total);
  const itemsCents = items.reduce((s, it) => s + cents(it.amount), 0);
  if (itemsCents !== subtotalCents) {
    push('SUBTOTAL_NE_ITEMS', `subtotal ¥${subtotalCents / 100} ≠ Σ items.amount ¥${itemsCents / 100}`);
  }
  if (totalCents !== subtotalCents) {
    push('TOTAL_NE_SUBTOTAL', `total ¥${totalCents / 100} ≠ subtotal ¥${subtotalCents / 100}`);
  }
  if (totalCents < 0) push('NEGATIVE_TOTAL', `total ¥${totalCents / 100} < 0`);

  const passengerIds = (row.passengers ?? []).map((p) => p.id);
  const paxSet = new Set(passengerIds);
  const grouped = groupPassengerAdjustments(
    items.map((it) => ({
      id: it.id,
      amount: Number(it.amount ?? 0),
      description: it.description ?? '',
      passengerId: it.passengerId ?? null,
      metadata: it.metadata,
    })),
  );
  for (const [pid, g] of Object.entries(grouped.byPassenger)) {
    if (!paxSet.has(pid)) {
      push('ORPHAN_PER_PAX_ADJUSTMENT', `按人调价 ¥${g.netCny} 挂在不在本单的乘客 ${pid} 头上`);
    }
  }
  const netByPassenger = new Map<string, number>(
    Object.entries(grouped.byPassenger).map(([pid, g]) => [pid, g.netCny]),
  );
  const shares = computePerPaxShares({
    totalCny: totalCents / 100,
    adjustmentCny: spreadableAdjustmentCny({ adjustmentCny: row.adjustmentCny ?? 0, adjustments: row.adjustments }),
    passengerIds,
    netByPassenger,
  });
  const sumShareCents = shares.rows.reduce((s, r) => s + Math.round(r.shareCny * 100), 0);
  if (passengerIds.length > 0 && sumShareCents !== Math.round(shares.payableCny * 100)) {
    push('PER_PAX_SUM', `Σ 每人份额 ¥${sumShareCents / 100} ≠ 应收 ¥${shares.payableCny}`);
  }
  return out;
}

const violationKey = (v: LedgerViolation) => `${v.orderId}:${v.kind}`;

/**
 * 只拦**本次新引入**的账本不平：after 里有、before 里没有的 (订单, 违反类型) 才算失败。
 * 存量脏单（before 就不平）的同类不平原样放行 —— 内核不替历史数据背锅，也不让它卡住无关动作。
 */
export function assertNoNewLedgerViolations(
  before: OrderLedgerSnapshot,
  after: OrderLedgerSnapshot,
  label: string,
): void {
  const seen = new Set(before.rows.flatMap((r) => ledgerIdentityViolations(r).map(violationKey)));
  const fresh = after.rows.flatMap((r) => ledgerIdentityViolations(r)).filter((v) => !seen.has(violationKey(v)));
  if (fresh.length) {
    const lines = fresh.map((v) => `${v.orderNumber ?? v.orderId} ${v.kind}：${v.detail}`);
    throw new Error(`${label}账本恒等式失败：${lines.join('；')}（已回滚）`);
  }
}
