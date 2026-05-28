/**
 * 财务聚合服务 — ADMIN-only 业务财务核心计算
 *
 * 数据来源：
 *   - 收入：Order.total + OrderItem.amount（按 kind 分类）
 *   - 成本：OrderItem.totalCostCny（下单时锁定的成本快照）
 *   - 包机沉没成本：FlightSchedule.charterCostCny 与已售座位比对
 *
 * 关键概念：
 *   - 单座分摊成本 = charterCostCny / Σ(seatClasses[].capacity)
 *   - 已售座位成本 = soldSeats × 单座分摊成本
 *   - 空座沉没成本 = (totalSeats - soldSeats) × 单座分摊成本
 *   - 整航班毛利 = revenue - charterCostCny（整包机视角）
 *   - 仅已售部分毛利 = revenue - 已售座位成本（忽略空座）
 *
 * 老数据（cost 字段为 NULL）会被自动跳过统计，并在响应里标 missingCostItemCount。
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

export interface CategoryBreakdown {
  kind: string;
  revenueCny: number;
  costCny: number;
  grossMarginCny: number;
  marginPct: number | null; // null = revenue 为 0
  orderItemCount: number;
}

export interface FinancesSummary {
  range: DateRange;
  /** 已下单总收入（OrderItem.amount，未扣税费）— 含尚未支付的订单 */
  revenueCny: number;
  /** 已锁定成本总额（OrderItem.totalCostCny） */
  costCny: number;
  /** revenue - cost；不包含空座沉没成本 */
  grossMarginCny: number;
  /** grossMargin / revenue */
  marginPct: number | null;
  /** 含已售/未售座位推算的"应负担"包机沉没成本（仅 charterCostCny 已填的航班） */
  emptySeatSunkCostCny: number;
  /** 真实净利 = grossMargin - emptySeatSunkCost */
  netMarginCny: number;
  /** 该区间内的订单数（不含 DRAFT / CANCELLED） */
  orderCount: number;
  /** 该区间内 OrderItem 没填 cost 的条目数（用于提醒补录） */
  missingCostItemCount: number;
  categories: CategoryBreakdown[];
}

export interface FlightPnlRow {
  scheduleId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: string; // ISO
  charterCostCny: number | null;
  totalSeats: number;
  soldSeats: number;
  loadPct: number; // 0..1
  revenueCny: number;
  /** 已售部分应分摊成本 = soldSeats × perSeatCost */
  soldSeatAllocCostCny: number | null;
  /** 空座沉没成本 = (totalSeats - soldSeats) × perSeatCost */
  emptySeatSunkCostCny: number | null;
  /** 整包机净利 = revenue - charterCost */
  netMarginCny: number | null;
  /** 已售部分毛利 = revenue - 已售分摊成本 */
  grossOnSoldCny: number | null;
}

export interface OrderPnlRow {
  orderId: string;
  orderNumber: string;
  status: string;
  contactName: string;
  createdAt: string; // ISO
  totalCny: number; // Order.total
  costCny: number | null; // sum of OrderItem.totalCostCny；NULL = 有条目缺失
  grossMarginCny: number | null;
  marginPct: number | null;
  itemCount: number;
  /** 有几条 OrderItem 没填成本 */
  missingCostItemCount: number;
}

export interface MonthlyPoint {
  /** 'YYYY-MM' */
  month: string;
  revenueCny: number;
  costCny: number;
  grossMarginCny: number;
  orderCount: number;
}

// 计入营收的订单状态：排除 DRAFT/CANCELLED/PAYMENT_TIMEOUT/REFUNDED/FAILED
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

function toDateOnlyUtc(s: string, endOfDay = false): Date {
  // 'YYYY-MM-DD' → UTC midnight (or 23:59:59.999)
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

/** 计算财务概览（KPI + 分类拆分） */
export async function getFinancesSummary(
  range: DateRange,
  client: PrismaClient = defaultPrisma,
): Promise<FinancesSummary> {
  const from = toDateOnlyUtc(range.from);
  const to = toDateOnlyUtc(range.to, true);

  const orders = await client.order.findMany({
    where: {
      createdAt: { gte: from, lte: to },
      status: { in: COUNTED_STATUSES },
    },
    select: {
      id: true,
      total: true,
      items: { select: { kind: true, amount: true, totalCostCny: true } },
    },
  });

  const categoryMap = new Map<string, CategoryBreakdown>();
  let revenueCny = 0;
  let costCny = 0;
  let missingCostItemCount = 0;

  for (const o of orders) {
    for (const item of o.items) {
      const amt = dec(item.amount);
      const cost = item.totalCostCny == null ? null : dec(item.totalCostCny);
      revenueCny += amt;
      if (cost != null) costCny += cost;
      else missingCostItemCount += 1;

      const key = item.kind;
      const cur =
        categoryMap.get(key) ??
        ({
          kind: key,
          revenueCny: 0,
          costCny: 0,
          grossMarginCny: 0,
          marginPct: null,
          orderItemCount: 0,
        } satisfies CategoryBreakdown);
      cur.revenueCny += amt;
      if (cost != null) cur.costCny += cost;
      cur.orderItemCount += 1;
      categoryMap.set(key, cur);
    }
  }

  const schedules = await client.flightSchedule.findMany({
    where: {
      departureTime: { gte: from, lte: to },
      charterCostCny: { not: null },
    },
    select: {
      charterCostCny: true,
      seatClasses: { select: { capacity: true, sold: true } },
    },
  });

  let emptySeatSunkCostCny = 0;
  for (const s of schedules) {
    const totalSeats = s.seatClasses.reduce((a, c) => a + c.capacity, 0);
    const soldSeats = s.seatClasses.reduce((a, c) => a + c.sold, 0);
    if (totalSeats === 0) continue;
    const charter = dec(s.charterCostCny);
    const perSeat = charter / totalSeats;
    emptySeatSunkCostCny += (totalSeats - soldSeats) * perSeat;
  }

  const categories: CategoryBreakdown[] = Array.from(categoryMap.values())
    .map((c) => ({
      ...c,
      revenueCny: round2(c.revenueCny),
      costCny: round2(c.costCny),
      grossMarginCny: round2(c.revenueCny - c.costCny),
      marginPct: c.revenueCny > 0 ? round2((c.revenueCny - c.costCny) / c.revenueCny) : null,
    }))
    .sort((a, b) => b.revenueCny - a.revenueCny);

  const grossMarginCny = round2(revenueCny - costCny);

  return {
    range,
    revenueCny: round2(revenueCny),
    costCny: round2(costCny),
    grossMarginCny,
    marginPct: revenueCny > 0 ? round2(grossMarginCny / revenueCny) : null,
    emptySeatSunkCostCny: round2(emptySeatSunkCostCny),
    netMarginCny: round2(grossMarginCny - emptySeatSunkCostCny),
    orderCount: orders.length,
    missingCostItemCount,
    categories,
  };
}

/** 按航班分组的 P&L 列表 */
export async function getFlightPnl(
  range: DateRange,
  limit = 100,
  client: PrismaClient = defaultPrisma,
): Promise<FlightPnlRow[]> {
  const from = toDateOnlyUtc(range.from);
  const to = toDateOnlyUtc(range.to, true);

  const schedules = await client.flightSchedule.findMany({
    where: { departureTime: { gte: from, lte: to } },
    orderBy: { departureTime: 'desc' },
    take: limit,
    include: {
      flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
      seatClasses: { select: { capacity: true, sold: true } },
      orderItems: {
        where: {
          order: { status: { in: COUNTED_STATUSES } },
        },
        select: { amount: true },
      },
    },
  });

  return schedules.map<FlightPnlRow>((s) => {
    const totalSeats = s.seatClasses.reduce((a, c) => a + c.capacity, 0);
    const soldSeats = s.seatClasses.reduce((a, c) => a + c.sold, 0);
    const loadPct = totalSeats > 0 ? soldSeats / totalSeats : 0;
    const revenue = s.orderItems.reduce((a, i) => a + dec(i.amount), 0);
    const charter = s.charterCostCny == null ? null : dec(s.charterCostCny);
    const perSeat = charter != null && totalSeats > 0 ? charter / totalSeats : null;
    const soldAlloc = perSeat == null ? null : perSeat * soldSeats;
    const emptySunk = perSeat == null ? null : perSeat * (totalSeats - soldSeats);
    const netMargin = charter == null ? null : revenue - charter;
    const grossOnSold = soldAlloc == null ? null : revenue - soldAlloc;
    return {
      scheduleId: s.id,
      flightNumber: s.flight.flightNumber,
      origin: s.flight.originCode,
      destination: s.flight.destinationCode,
      departureTime: s.departureTime.toISOString(),
      charterCostCny: charter == null ? null : round2(charter),
      totalSeats,
      soldSeats,
      loadPct: Math.round(loadPct * 10000) / 10000,
      revenueCny: round2(revenue),
      soldSeatAllocCostCny: soldAlloc == null ? null : round2(soldAlloc),
      emptySeatSunkCostCny: emptySunk == null ? null : round2(emptySunk),
      netMarginCny: netMargin == null ? null : round2(netMargin),
      grossOnSoldCny: grossOnSold == null ? null : round2(grossOnSold),
    };
  });
}

/** 按订单分组的 P&L 列表 */
export async function getOrderPnl(
  range: DateRange,
  limit = 100,
  client: PrismaClient = defaultPrisma,
): Promise<OrderPnlRow[]> {
  const from = toDateOnlyUtc(range.from);
  const to = toDateOnlyUtc(range.to, true);

  const orders = await client.order.findMany({
    where: {
      createdAt: { gte: from, lte: to },
      status: { in: COUNTED_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      contactName: true,
      total: true,
      createdAt: true,
      items: { select: { totalCostCny: true } },
    },
  });

  return orders.map<OrderPnlRow>((o) => {
    let costSum = 0;
    let missing = 0;
    for (const it of o.items) {
      if (it.totalCostCny == null) missing += 1;
      else costSum += dec(it.totalCostCny);
    }
    const hasFullCost = missing === 0;
    const total = dec(o.total);
    const cost = hasFullCost ? costSum : null;
    const margin = cost == null ? null : total - cost;
    const marginPct = margin == null || total === 0 ? null : margin / total;
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      contactName: o.contactName,
      createdAt: o.createdAt.toISOString(),
      totalCny: round2(total),
      costCny: cost == null ? null : round2(cost),
      grossMarginCny: margin == null ? null : round2(margin),
      marginPct: marginPct == null ? null : Math.round(marginPct * 10000) / 10000,
      itemCount: o.items.length,
      missingCostItemCount: missing,
    };
  });
}

/** 月度趋势（最近 N 个月） */
export async function getMonthlyTrend(
  months: number,
  client: PrismaClient = defaultPrisma,
): Promise<MonthlyPoint[]> {
  const n = Math.max(1, Math.min(36, Math.floor(months)));
  const now = new Date();
  const points: MonthlyPoint[] = [];

  for (let i = n - 1; i >= 0; i--) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    const monthKey = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;

    const orders = await client.order.findMany({
      where: {
        createdAt: { gte: monthStart, lt: monthEnd },
        status: { in: COUNTED_STATUSES },
      },
      select: { items: { select: { amount: true, totalCostCny: true } } },
    });

    let revenue = 0;
    let cost = 0;
    for (const o of orders) {
      for (const it of o.items) {
        revenue += dec(it.amount);
        if (it.totalCostCny != null) cost += dec(it.totalCostCny);
      }
    }

    points.push({
      month: monthKey,
      revenueCny: round2(revenue),
      costCny: round2(cost),
      grossMarginCny: round2(revenue - cost),
      orderCount: orders.length,
    });
  }

  return points;
}
