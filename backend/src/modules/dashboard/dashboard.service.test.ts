import { afterEach, describe, expect, it, vi } from 'vitest';

const orderAggregate = vi.fn();
const orderCount = vi.fn();
const orderFindMany = vi.fn();
const orderGroupBy = vi.fn();
const agentFindMany = vi.fn();
const queryRaw = vi.fn();

vi.mock('../../db/prisma.js', () => ({
  prisma: {
    order: {
      aggregate: (...args: unknown[]) => orderAggregate(...args),
      count: (...args: unknown[]) => orderCount(...args),
      findMany: (...args: unknown[]) => orderFindMany(...args),
      groupBy: (...args: unknown[]) => orderGroupBy(...args),
    },
    agent: { findMany: (...args: unknown[]) => agentFindMany(...args) },
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
  },
}));

import { DashboardService } from './dashboard.service.js';

const service = new DashboardService();

afterEach(() => {
  vi.useRealTimers();
  orderAggregate.mockReset();
  orderCount.mockReset();
  orderFindMany.mockReset();
  orderGroupBy.mockReset();
  agentFindMany.mockReset();
  queryRaw.mockReset();
});

describe('DashboardService · 上海业务日边界', () => {
  it('KPI 今日、昨日、本月和上月使用上海日/月边界', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T17:00:00.000Z'));
    orderAggregate.mockResolvedValue({ _sum: { total: null }, _count: { _all: 0 } });
    orderCount.mockResolvedValue(0);
    orderFindMany.mockResolvedValue([]);

    await service.getKpi();

    expect(orderAggregate).toHaveBeenCalledTimes(4);
    expect(orderAggregate.mock.calls.map(([arg]) => arg.where.createdAt)).toEqual([
      { gte: new Date('2026-08-24T16:00:00.000Z'), lt: new Date('2026-08-25T16:00:00.000Z') },
      { gte: new Date('2026-08-23T16:00:00.000Z'), lt: new Date('2026-08-24T16:00:00.000Z') },
      { gte: new Date('2026-07-31T16:00:00.000Z'), lt: new Date('2026-08-25T16:00:00.000Z') },
      { gte: new Date('2026-06-30T16:00:00.000Z'), lt: new Date('2026-07-31T16:00:00.000Z') },
    ]);
  });

  it('日序列按上海日聚合并填充到上海“今天”，不产生未来日期', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T17:00:00.000Z'));
    queryRaw.mockResolvedValue([
      { day: new Date('2026-08-25T00:00:00.000Z'), revenue: '123.45', orders: BigInt(2) },
    ]);

    const series = await service.getDailySeries(7);

    expect(queryRaw.mock.calls[0][0].join(' ')).toContain(
      `date_trunc('day', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai')::date`,
    );
    expect(series).toHaveLength(7);
    expect(series.map((item) => item.date)).toEqual([
      '08-19', '08-20', '08-21', '08-22', '08-23', '08-24', '08-25',
    ]);
    expect(series.at(-1)).toEqual({ date: '08-25', revenue: 123.45, orders: 2 });
  });

  it('Top 代理本月从上海月初开始统计', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T17:00:00.000Z'));
    orderGroupBy.mockResolvedValue([]);
    agentFindMany.mockResolvedValue([]);

    await service.topAgentsThisMonth();

    expect(orderGroupBy.mock.calls[0][0].where.createdAt).toEqual({
      gte: new Date('2026-07-31T16:00:00.000Z'),
    });
  });
});
