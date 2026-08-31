/**
 * 仪表盘数据聚合 — 基于真实订单表。
 *
 * 语义：
 * - 今日/本月：按订单 createdAt 算；只算 PAID/PROCESSING/TICKETED/COMPLETED 的算营收
 * - 变化率：本期 vs 上期（昨天 / 上月）
 * - 活跃代理：最近 30 天有订单的代理数
 */
import { OrderStatus, Prisma, ReminderStatus, ReminderPriority } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { businessDateISO, startOfBusinessDayUtc } from '../../lib/business-time.js';
import { getAlerts } from '../hotel-control/hotel-control.service.js';

const PAID_LIKE_STATUSES: OrderStatus[] = [
  'PAID', 'PROCESSING', 'TICKETED', 'COMPLETED', 'CHANGE_REQUESTED', 'CHANGED',
];

export class DashboardService {
  /**
   * 统一预警入口（仪表盘「今日预警」条）：把散在各页的预警数聚成一眼可见的汇总。
   * 只做计数不重复口径——提醒数直接数 OperationalReminder（PENDING），房控四类
   * 复用 getAlerts（14 天窗，与房控页横幅同参数），点进各页看明细。
   * 注意：提醒是「生成今日提醒」按钮/规则扫描落库后的数字，没人生成时不为负也不报假 0 ——
   * pendingReminders=0 且当天没跑过生成 ≠ 没有风险，前端在条上带「生成」入口。
   */
  async getAlertsSummary() {
    // 「待办」= 未完成（新建待处理 + 已认领处理中）；DONE/SKIPPED 不算。
    const openStatuses = [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS];
    const [pending, critical, hotelAlerts] = await Promise.all([
      prisma.operationalReminder.count({ where: { status: { in: openStatuses } } }),
      prisma.operationalReminder.count({
        where: { status: { in: openStatuses }, priority: ReminderPriority.CRITICAL },
      }),
      getAlerts(14),
    ]);
    return {
      reminders: { pending, critical },
      hotel: {
        oversold: hotelAlerts.oversold.length,
        surplusSoon: hotelAlerts.surplusSoon.length,
        overCapacitySchedules: hotelAlerts.overCapacitySchedules.length,
        sharedOddNear: hotelAlerts.sharedOddNear.length,
      },
    };
  }

  async getKpi() {
    const now = new Date();
    const todayStart = startOfBusinessDayUtc(now);
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);

    const [businessYear, businessMonth] = businessDateISO(now).split('-').map(Number);
    const thisMonthStart = localMonthStartUtc(businessYear, businessMonth);
    const lastMonthStart = localMonthStartUtc(
      businessMonth === 1 ? businessYear - 1 : businessYear,
      businessMonth === 1 ? 12 : businessMonth - 1,
    );

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
      prisma.order.count({ where: { deletedAt: null, status: 'PENDING_PAYMENT' } }),
      prisma.order.findMany({
        where: {
          deletedAt: null, // 排除已软删订单（本查询无状态过滤）
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

  /** 最近 N 天时间序列（N 默认 7）— 一次 SQL groupBy 完成，无 N+1 */
  async getDailySeries(days = 7) {
    const now = new Date();
    const todayStart = startOfBusinessDayUtc(now);
    const windowStart = new Date(todayStart.getTime() - (days - 1) * 86400000);
    const windowEnd = new Date(todayStart.getTime() + 86400000);

    // createdAt 是按 UTC 存储的 naive timestamp：先按 UTC 解释成 timestamptz，
    // 再折成上海墙钟 timestamp，最后按上海日聚合。
    const rows = await prisma.$queryRaw<Array<{ day: Date; revenue: string; orders: bigint }>>`
      SELECT
        date_trunc('day', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai')::date AS day,
        COALESCE(SUM(total), 0)::text AS revenue,
        COUNT(*)::bigint AS orders
      FROM "Order"
      WHERE "createdAt" >= ${windowStart}
        AND "createdAt" < ${windowEnd}
        AND "deletedAt" IS NULL
        AND status IN ('PAID','PROCESSING','TICKETED','COMPLETED','CHANGE_REQUESTED','CHANGED')
      GROUP BY day
      ORDER BY day ASC
    `;

    // 把 SQL 结果索引化
    const byDate = new Map<string, { revenue: number; orders: number }>();
    rows.forEach((r) => {
      const key = r.day.toISOString().slice(0, 10); // YYYY-MM-DD
      byDate.set(key, { revenue: Number(r.revenue), orders: Number(r.orders) });
    });

    // 填充所有 N 天（包括无订单的零值日）
    const series: Array<{ date: string; revenue: number; orders: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(todayStart.getTime() - i * 86400000);
      const iso = businessDateISO(dayStart);
      const [, month, day] = iso.split('-');
      const agg = byDate.get(iso) ?? { revenue: 0, orders: 0 };
      series.push({ date: `${month}-${day}`, revenue: agg.revenue, orders: agg.orders });
    }
    return series;
  }

  /** Top 5 代理按本月 GMV 排名 */
  async topAgentsThisMonth() {
    const now = new Date();
    const [businessYear, businessMonth] = businessDateISO(now).split('-').map(Number);
    const monthStart = localMonthStartUtc(businessYear, businessMonth);

    const rows = await prisma.order.groupBy({
      by: ['agentId'],
      where: {
        deletedAt: null,
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
function localMonthStartUtc(year: number, month: number): Date {
  return new Date(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01T00:00:00.000+08:00`);
}

function pctChange(cur: number, prev: number): number {
  if (prev === 0) return cur === 0 ? 0 : 100;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

async function revenueAndCount(gte: Date, lt: Date): Promise<{ revenue: number; orders: number }> {
  const agg = await prisma.order.aggregate({
    where: {
      deletedAt: null,
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
