/**
 * 仪表盘数据聚合 — 基于真实订单表。
 *
 * 语义：
 * - 今日/本月：按订单 createdAt 算；只算 PAID/PROCESSING/TICKETED/COMPLETED 的算营收
 * - 变化率：本期 vs 上期（昨天 / 上月）
 * - 活跃代理：最近 30 天有订单的代理数
 */
import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

const PAID_LIKE_STATUSES: OrderStatus[] = [
  'PAID', 'PROCESSING', 'TICKETED', 'COMPLETED', 'CHANGE_REQUESTED', 'CHANGED',
];

export class DashboardService {
  async getKpi() {
    const now = new Date();
    const todayStart = startOfDayUtc(now);
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);

    const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

    const activeWindow = new Date(now.getTime() - 30 * 86400000);

    const [
      todayAgg,
      yesterdayAgg,
      monthAgg,
      lastMonthAgg,
      pendingCount,
      activeAgentsRaw,
    ] = await Promise.all([
      revenueAndCount(todayStart, tomorrowStart),
      revenueAndCount(yesterdayStart, todayStart),
      revenueAndCount(thisMonthStart, tomorrowStart),
      revenueAndCount(lastMonthStart, thisMonthStart),
      prisma.order.count({ where: { status: 'PENDING_PAYMENT' } }),
      prisma.order.findMany({
        where: {
          agentId: { not: null },
          createdAt: { gte: activeWindow },
        },
        select: { agentId: true },
        distinct: ['agentId'],
      }),
    ]);

    const revenueChangePct = pctChange(todayAgg.revenue, yesterdayAgg.revenue);
    const ordersChangePct = pctChange(todayAgg.orders, yesterdayAgg.orders);
    const monthRevenueChangePct = pctChange(monthAgg.revenue, lastMonthAgg.revenue);

    return {
      todayRevenue: todayAgg.revenue,
      todayOrders: todayAgg.orders,
      pendingOrders: pendingCount,
      activeAgents: activeAgentsRaw.length,
      monthRevenue: monthAgg.revenue,
      monthOrders: monthAgg.orders,
      revenueChangePct,
      ordersChangePct,
      monthRevenueChangePct,
      asOf: now.toISOString(),
    };
  }

  /** 最近 N 天时间序列（N 默认 7） */
  async getDailySeries(days = 7) {
    const now = new Date();
    const todayStart = startOfDayUtc(now);
    const series: Array<{ date: string; revenue: number; orders: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(todayStart.getTime() - i * 86400000);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const agg = await revenueAndCount(dayStart, dayEnd);
      const mm = String(dayStart.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(dayStart.getUTCDate()).padStart(2, '0');
      series.push({ date: `${mm}-${dd}`, revenue: agg.revenue, orders: agg.orders });
    }
    return series;
  }

  /** Top 5 代理按本月 GMV 排名 */
  async topAgentsThisMonth() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const rows = await prisma.order.groupBy({
      by: ['agentId'],
      where: {
        agentId: { not: null },
        status: { in: PAID_LIKE_STATUSES },
        createdAt: { gte: monthStart },
      },
      _sum: { total: true },
      _count: { _all: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 5,
    });

    const agents = await prisma.agent.findMany({
      where: { id: { in: rows.map((r) => r.agentId!).filter(Boolean) } },
      select: { id: true, companyName: true, contactName: true, tier: true },
    });
    const byId = new Map(agents.map((a) => [a.id, a]));

    return rows.map((r) => {
      const a = byId.get(r.agentId!);
      return {
        agentId: r.agentId,
        companyName: a?.companyName ?? null,
        contactName: a?.contactName ?? '',
        tier: a?.tier ?? 0,
        orderCount: r._count._all,
        revenue: Number(r._sum.total ?? 0),
      };
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────
function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function pctChange(cur: number, prev: number): number {
  if (prev === 0) return cur === 0 ? 0 : 100;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

async function revenueAndCount(gte: Date, lt: Date): Promise<{ revenue: number; orders: number }> {
  const agg = await prisma.order.aggregate({
    where: {
      status: { in: PAID_LIKE_STATUSES },
      createdAt: { gte, lt },
    },
    _sum: { total: true },
    _count: { _all: true },
  });
  // 用 Decimal 求和再转数字（Prisma 已为我们算了 sum）
  const revenueDecimal: Prisma.Decimal | null = agg._sum.total;
  return {
    revenue: revenueDecimal ? Number(revenueDecimal) : 0,
    orders: agg._count._all,
  };
}
