/**
 * 经营报表聚合服务 — ADMIN-only（财务口径）
 *
 * 统计口径与 finances 模块一致：
 *   - 计入统计的订单状态 COUNTED_STATUSES：排除 DRAFT/CANCELLED/PAYMENT_TIMEOUT/REFUNDED/FAILED
 *   - 一律排除软删除（deletedAt != null）
 *   - 收入 = OrderItem.amount（行级）；成本 = OrderItem.totalCostCny（下单时锁定的快照）
 *   - 成本快照为 NULL 的行跳过成本累计，计入 missingCostItemCount 提醒补录
 *
 * 应收口径：
 *   - 应收余额 = total + adjustmentCny − paidAmount − prepaymentOffset
 *   - 应收状态集 RECEIVABLE_STATUSES：进行中的六态（不含 COMPLETED / REFUND_REQUESTED）
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';

export interface DateRange {
  /** ISO date 'YYYY-MM-DD'，包含 */
  from: string;
  /** ISO date 'YYYY-MM-DD'，包含 */
  to: string;
}

export type SalesDim = 'kind' | 'channel' | 'agent';

export interface SalesRow {
  key: string;
  label: string;
  /** 该维度涉及的订单数（去重） */
  orderCount: number;
  revenueCny: number;
  costCny: number;
  grossMarginCny: number;
  marginPct: number | null; // null = revenue 为 0
  missingCostItemCount: number;
}

export interface SalesTotals {
  /** 区间内订单总数（去重，不随维度重复计） */
  orderCount: number;
  revenueCny: number;
  costCny: number;
  grossMarginCny: number;
  marginPct: number | null;
  missingCostItemCount: number;
}

export interface SalesReport {
  rows: SalesRow[];
  totals: SalesTotals;
}

export type ReceivableBucket = '0-7' | '8-30' | '31-60' | '61+';

export interface ReceivableRow {
  orderId: string;
  orderNumber: string;
  contactName: string;
  /** 代理名或'直客' */
  agentLabel: string;
  status: string;
  /** 应收合计 = total + adjustmentCny */
  totalCny: number;
  /** 已收合计 = paidAmount + prepaymentOffset */
  paidCny: number;
  /** 应收余额 = totalCny − paidCny */
  balanceCny: number;
  /** 距下单（createdAt）的天数 */
  ageDays: number;
  bucket: ReceivableBucket;
}

export interface ReceivableBucketSummary {
  count: number;
  amountCny: number;
}

export interface ReceivablesSummary {
  totalBalanceCny: number;
  buckets: Record<ReceivableBucket, ReceivableBucketSummary>;
  /** rows 超过上限被截断时为 true（summary 仍统计全量） */
  truncated?: boolean;
}

export interface ReceivablesReport {
  rows: ReceivableRow[];
  summary: ReceivablesSummary;
}

export interface AgentDebtRow {
  agentId: string;
  agentLabel: string;
  orderCount: number;
  outstandingCny: number;
  prepaymentBalanceCny: number;
}

// 计入营收的订单状态（与 finances.service.ts 一致）：
// 排除 DRAFT/CANCELLED/PAYMENT_TIMEOUT/REFUNDED/FAILED
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

// 应收口径的状态集（进行中六态；不含 COMPLETED / REFUND_REQUESTED）
const RECEIVABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/** 应收明细最多返回的行数（summary 仍统计全量） */
const RECEIVABLE_ROW_LIMIT = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

// 渠道维度：代理分销 / 会员直订 / 游客下单
const CHANNEL_LABELS: Record<string, string> = {
  agent: '代理分销',
  member: '会员直订',
  guest: '游客下单',
};

/** 无代理订单在 dim=agent 下归为一行 */
const DIRECT_KEY = 'direct';
const DIRECT_LABEL = '直客';

function toDateOnlyUtc(s: string, endOfDay = false): Date {
  // 'YYYY-MM-DD' → UTC midnight (or 23:59:59.999) — 与 finances 一致
  const [y, m, d] = s.split('-').map((x) => parseInt(x, 10));
  if (!y || !m || !d) throw new Error(`invalid date: ${s}`);
  return new Date(
    Date.UTC(
      y,
      m - 1,
      d,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    ),
  );
}

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function marginPctOf(revenue: number, cost: number): number | null {
  if (revenue <= 0) return null;
  return Math.round(((revenue - cost) / revenue) * 10000) / 10000;
}

function agentLabelOf(agent: { companyName: string | null; contactName: string } | null): string {
  if (!agent) return DIRECT_LABEL;
  return agent.companyName ?? agent.contactName;
}

interface MutableSalesAcc {
  key: string;
  label: string;
  orderIds: Set<string>;
  revenueCny: number;
  costCny: number;
  missingCostItemCount: number;
}

function newAcc(key: string, label: string): MutableSalesAcc {
  return { key, label, orderIds: new Set(), revenueCny: 0, costCny: 0, missingCostItemCount: 0 };
}

/** 销售毛利：按 kind / channel / agent 三个维度聚合区间内订单（按 createdAt 落区间） */
export async function getSalesReport(
  range: DateRange,
  dim: SalesDim,
  client: PrismaClient = defaultPrisma,
): Promise<SalesReport> {
  const from = toDateOnlyUtc(range.from);
  const to = toDateOnlyUtc(range.to, true);

  const orders = await client.order.findMany({
    where: { deletedAt: null, createdAt: { gte: from, lte: to }, status: { in: COUNTED_STATUSES } },
    select: {
      id: true,
      agentId: true,
      userId: true,
      agent: { select: { companyName: true, contactName: true } },
      items: { select: { kind: true, amount: true, totalCostCny: true } },
    },
  });

  const accMap = new Map<string, MutableSalesAcc>();
  let totalRevenue = 0;
  let totalCost = 0;
  let totalMissing = 0;

  for (const o of orders) {
    // 订单级维度键（channel / agent）；kind 维度按行分桶
    let orderKey = '';
    let orderLabel = '';
    if (dim === 'channel') {
      orderKey = o.agentId != null ? 'agent' : o.userId != null ? 'member' : 'guest';
      orderLabel = CHANNEL_LABELS[orderKey] ?? orderKey;
    } else if (dim === 'agent') {
      orderKey = o.agentId ?? DIRECT_KEY;
      orderLabel = agentLabelOf(o.agent);
    }

    for (const it of o.items) {
      const amt = dec(it.amount);
      const cost = it.totalCostCny == null ? null : dec(it.totalCostCny);
      totalRevenue += amt;
      if (cost != null) totalCost += cost;
      else totalMissing += 1;

      const key = dim === 'kind' ? it.kind : orderKey;
      const label = dim === 'kind' ? it.kind : orderLabel;
      const acc = accMap.get(key) ?? newAcc(key, label);
      acc.orderIds.add(o.id);
      acc.revenueCny += amt;
      if (cost != null) acc.costCny += cost;
      else acc.missingCostItemCount += 1;
      accMap.set(key, acc);
    }
  }

  const rows: SalesRow[] = Array.from(accMap.values())
    .map((a) => {
      const revenue = round2(a.revenueCny);
      const cost = round2(a.costCny);
      return {
        key: a.key,
        label: a.label,
        orderCount: a.orderIds.size,
        revenueCny: revenue,
        costCny: cost,
        grossMarginCny: round2(revenue - cost),
        marginPct: marginPctOf(revenue, cost),
        missingCostItemCount: a.missingCostItemCount,
      };
    })
    .sort((a, b) => b.revenueCny - a.revenueCny);

  const revenue = round2(totalRevenue);
  const cost = round2(totalCost);
  const totals: SalesTotals = {
    orderCount: orders.length,
    revenueCny: revenue,
    costCny: cost,
    grossMarginCny: round2(revenue - cost),
    marginPct: marginPctOf(revenue, cost),
    missingCostItemCount: totalMissing,
  };

  return { rows, totals };
}

function bucketOf(ageDays: number): ReceivableBucket {
  if (ageDays <= 7) return '0-7';
  if (ageDays <= 30) return '8-30';
  if (ageDays <= 60) return '31-60';
  return '61+';
}

interface ReceivableOrderShape {
  total: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  prepaymentOffset: Prisma.Decimal;
  adjustmentCny: number;
}

/** 应收余额（单笔）= total + adjustmentCny − paidAmount − prepaymentOffset */
function balanceOf(o: ReceivableOrderShape): number {
  return round2(dec(o.total) + o.adjustmentCny - dec(o.paidAmount) - dec(o.prepaymentOffset));
}

/** 应收账龄：所有进行中订单里余额 > 0 的明细 + 账龄桶汇总 */
export async function getReceivablesReport(
  client: PrismaClient = defaultPrisma,
): Promise<ReceivablesReport> {
  const orders = await client.order.findMany({
    where: { deletedAt: null, status: { in: RECEIVABLE_STATUSES } },
    select: {
      id: true,
      orderNumber: true,
      contactName: true,
      status: true,
      total: true,
      paidAmount: true,
      prepaymentOffset: true,
      adjustmentCny: true,
      createdAt: true,
      agent: { select: { companyName: true, contactName: true } },
    },
  });

  const now = Date.now();
  const allRows: ReceivableRow[] = [];
  for (const o of orders) {
    const balance = balanceOf(o);
    if (balance <= 0) continue;
    const totalCny = round2(dec(o.total) + o.adjustmentCny);
    const ageDays = Math.max(0, Math.floor((now - o.createdAt.getTime()) / DAY_MS));
    allRows.push({
      orderId: o.id,
      orderNumber: o.orderNumber,
      contactName: o.contactName,
      agentLabel: agentLabelOf(o.agent),
      status: o.status,
      totalCny,
      paidCny: round2(totalCny - balance),
      balanceCny: balance,
      ageDays,
      bucket: bucketOf(ageDays),
    });
  }

  allRows.sort((a, b) => b.balanceCny - a.balanceCny);

  const buckets: Record<ReceivableBucket, ReceivableBucketSummary> = {
    '0-7': { count: 0, amountCny: 0 },
    '8-30': { count: 0, amountCny: 0 },
    '31-60': { count: 0, amountCny: 0 },
    '61+': { count: 0, amountCny: 0 },
  };
  let totalBalance = 0;
  for (const r of allRows) {
    totalBalance += r.balanceCny;
    buckets[r.bucket].count += 1;
    buckets[r.bucket].amountCny += r.balanceCny;
  }
  for (const b of Object.values(buckets)) b.amountCny = round2(b.amountCny);

  const truncated = allRows.length > RECEIVABLE_ROW_LIMIT;
  const summary: ReceivablesSummary = {
    totalBalanceCny: round2(totalBalance),
    buckets,
    ...(truncated ? { truncated: true } : {}),
  };

  return { rows: allRows.slice(0, RECEIVABLE_ROW_LIMIT), summary };
}

/** 代理欠款：按代理聚合其名下订单的应收余额（只累计余额 > 0 的订单，与账龄口径一致） */
export async function getAgentDebtsReport(
  client: PrismaClient = defaultPrisma,
): Promise<AgentDebtRow[]> {
  const [orders, agents] = await Promise.all([
    client.order.findMany({
      where: { deletedAt: null, agentId: { not: null }, status: { in: RECEIVABLE_STATUSES } },
      select: {
        agentId: true,
        total: true,
        paidAmount: true,
        prepaymentOffset: true,
        adjustmentCny: true,
      },
    }),
    client.agent.findMany({
      select: { id: true, companyName: true, contactName: true, prepaymentBalance: true },
    }),
  ]);

  const outstandingMap = new Map<string, { orderCount: number; outstandingCny: number }>();
  for (const o of orders) {
    const balance = balanceOf(o);
    if (balance <= 0) continue;
    const agentId = o.agentId as string;
    const cur = outstandingMap.get(agentId) ?? { orderCount: 0, outstandingCny: 0 };
    cur.orderCount += 1;
    cur.outstandingCny += balance;
    outstandingMap.set(agentId, cur);
  }

  return agents
    .map<AgentDebtRow>((a) => {
      const o = outstandingMap.get(a.id);
      return {
        agentId: a.id,
        agentLabel: agentLabelOf(a),
        orderCount: o?.orderCount ?? 0,
        outstandingCny: round2(o?.outstandingCny ?? 0),
        prepaymentBalanceCny: round2(dec(a.prepaymentBalance)),
      };
    })
    .filter((r) => r.outstandingCny > 0 || r.prepaymentBalanceCny > 0)
    .sort((a, b) => b.outstandingCny - a.outstandingCny);
}
