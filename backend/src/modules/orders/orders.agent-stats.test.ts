/**
 * 代理分销统计 GET /orders/agent-stats · 服务级测试（vitest）
 *
 * 用 vi.mock 把 Prisma 换成可控 fixture（与 orders.service.test.ts 同款风格），不依赖真 DB。
 *
 * 要钉死的是「口径与列表卡片旧算法逐条一致」——卡片以前在前端按已加载的那一页现算，
 * 搬到后端聚合时任何一处口径漂移，运营看到的都是「数字变了但没人动过数据」：
 *   · 只计已付款族 PAID/TICKETED/COMPLETED（叠进 AND，不覆盖用户自己筛的 status）；
 *   · 成交额 = Σ Order.total，两位小数；
 *   · 代理名 = 公司名优先、否则联系人名；查不到的代理不丢金额，落「未知代理」；
 *   · 按成交额降序；
 *   · 走与列表**同一份** where（筛选 + RBAC + 精筛），代理只看得到自己 + 下级。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    agent: {
      findMany: vi.fn(),
    },
    // AGENT 角色的可见代理集合走递归 CTE（getDescendantAgentIds）。
    $queryRaw: vi.fn(async () => [{ id: 'agt-self' }, { id: 'agt-child' }]),
    $transaction: vi.fn(async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => Promise<unknown>)({}),
    ),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../lib/cancellation.js', () => ({ computeCancellationQuote: vi.fn() }));
vi.mock('../hotel-control/hotel-control.service.js', () => ({
  getHotelNightlyRemaining: vi.fn(),
  assertRandomTierFit: vi.fn(),
  getHotelOversellCapRooms: async () => 3,
}));
vi.mock('../../queues/queue.js', () => ({
  enqueueWaitlistCheck: vi.fn(),
  scheduleSeatHoldRelease: vi.fn(),
}));
vi.mock('../settlement-discounts/settlement-discounts.service.js', () => ({
  resolveAgentSettlementDiscount: vi.fn(),
  resolveRetailSettlementDiscount: vi.fn(),
}));
vi.mock('../settlement-rates/settlement-rates.service.js', () => ({
  getSettlementRate: vi.fn(),
}));

import type { Prisma } from '@prisma/client';
import { OrderService } from './orders.service.js';
import { listOrdersQuerySchema } from './orders.schemas.js';

type GroupRow = {
  agentId: string | null;
  _count: { _all: number };
  _sum: { total: number | null };
};

type Where = Prisma.OrderWhereInput & { AND?: Prisma.OrderWhereInput[] };

const service = new OrderService();
const q = (extra: Record<string, unknown> = {}) => listOrdersQuerySchema.parse(extra);

/** 取出本次 groupBy 实际用的 where（口径断言都靠它）。*/
const lastGroupByWhere = (): Where =>
  (mockPrisma.order.groupBy.mock.calls.at(-1)?.[0] as { where: Where }).where;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$queryRaw.mockResolvedValue([{ id: 'agt-self' }, { id: 'agt-child' }]);
  mockPrisma.order.groupBy.mockResolvedValue([] as GroupRow[]);
  mockPrisma.agent.findMany.mockResolvedValue([]);
});

describe('OrderService.getAgentStats · 聚合口径', () => {
  it('直客与各代理分开汇总；代理名取公司名优先、成交额降序', async () => {
    mockPrisma.order.groupBy.mockResolvedValue([
      { agentId: null, _count: { _all: 3 }, _sum: { total: 7500 } },
      { agentId: 'agt-a', _count: { _all: 2 }, _sum: { total: 5000 } },
      { agentId: 'agt-b', _count: { _all: 5 }, _sum: { total: 12000 } },
    ] as GroupRow[]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { id: 'agt-a', companyName: '甲旅行社', contactName: '联系人甲' },
      { id: 'agt-b', companyName: null, contactName: '联系人乙' },
    ]);

    const result = await service.getAgentStats(q(), { userId: 'admin1', role: 'ADMIN' });

    expect(result.direct).toEqual({ orders: 3, revenueCny: 7500 });
    // 降序：12000 在前、5000 在后（不是 groupBy 返回的顺序）。
    expect(result.agents).toEqual([
      { agentId: 'agt-b', agentName: '联系人乙', orders: 5, revenueCny: 12000 },
      { agentId: 'agt-a', agentName: '甲旅行社', orders: 2, revenueCny: 5000 },
    ]);
  });

  it('没有直客单时 direct 落 0/0，而不是缺字段', async () => {
    mockPrisma.order.groupBy.mockResolvedValue([
      { agentId: 'agt-a', _count: { _all: 1 }, _sum: { total: 100 } },
    ] as GroupRow[]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { id: 'agt-a', companyName: '甲旅行社', contactName: '联系人甲' },
    ]);

    const result = await service.getAgentStats(q(), { userId: 'admin1', role: 'ADMIN' });
    expect(result.direct).toEqual({ orders: 0, revenueCny: 0 });
  });

  it('一条都没有 → 空集合（direct 归零、agents 空数组，不查代理表）', async () => {
    const result = await service.getAgentStats(q(), { userId: 'admin1', role: 'ADMIN' });
    expect(result).toEqual({ direct: { orders: 0, revenueCny: 0 }, agents: [] });
    expect(mockPrisma.agent.findMany).not.toHaveBeenCalled();
  });

  it('公司名是空白串 → 回落联系人名（与列表「代理机构」列同款 trim 口径）', async () => {
    mockPrisma.order.groupBy.mockResolvedValue([
      { agentId: 'agt-a', _count: { _all: 1 }, _sum: { total: 100 } },
    ] as GroupRow[]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { id: 'agt-a', companyName: '   ', contactName: '联系人甲' },
    ]);

    const result = await service.getAgentStats(q(), { userId: 'admin1', role: 'ADMIN' });
    expect(result.agents[0]?.agentName).toBe('联系人甲');
  });

  it('代理行查不到（已删/脏数据）→ 记「未知代理」，金额照样计入，不静默丢', async () => {
    mockPrisma.order.groupBy.mockResolvedValue([
      { agentId: 'agt-gone', _count: { _all: 2 }, _sum: { total: 888 } },
    ] as GroupRow[]);
    mockPrisma.agent.findMany.mockResolvedValue([]);

    const result = await service.getAgentStats(q(), { userId: 'admin1', role: 'ADMIN' });
    expect(result.agents).toEqual([
      { agentId: 'agt-gone', agentName: '未知代理', orders: 2, revenueCny: 888 },
    ]);
  });

  it('金额保留两位小数（累加的浮点尾巴不透出到卡片上）', async () => {
    mockPrisma.order.groupBy.mockResolvedValue([
      { agentId: null, _count: { _all: 3 }, _sum: { total: 1234.5678 } },
    ] as GroupRow[]);

    const result = await service.getAgentStats(q(), { userId: 'admin1', role: 'ADMIN' });
    expect(result.direct.revenueCny).toBe(1234.57);
  });

  it('_sum.total 为 null（理论上不该有，防御）→ 成交额 0，不是 NaN', async () => {
    mockPrisma.order.groupBy.mockResolvedValue([
      { agentId: null, _count: { _all: 0 }, _sum: { total: null } },
    ] as GroupRow[]);

    const result = await service.getAgentStats(q(), { userId: 'admin1', role: 'ADMIN' });
    expect(result.direct.revenueCny).toBe(0);
  });

  it('只查一次代理名（按 id 批量），不做 N+1', async () => {
    mockPrisma.order.groupBy.mockResolvedValue([
      { agentId: 'agt-a', _count: { _all: 1 }, _sum: { total: 1 } },
      { agentId: 'agt-b', _count: { _all: 1 }, _sum: { total: 2 } },
      { agentId: null, _count: { _all: 1 }, _sum: { total: 3 } },
    ] as GroupRow[]);

    await service.getAgentStats(q(), { userId: 'admin1', role: 'ADMIN' });

    expect(mockPrisma.agent.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agent.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: { in: ['agt-a', 'agt-b'] } }, // null 不进 in
    });
  });
});

describe('OrderService.getAgentStats · 已付款闸', () => {
  it('AND 里叠 status ∈ {PAID, TICKETED, COMPLETED}', async () => {
    await service.getAgentStats(q(), { userId: 'admin1', role: 'ADMIN' });
    expect(lastGroupByWhere().AND).toContainEqual({
      status: { in: ['PAID', 'TICKETED', 'COMPLETED'] },
    });
  });

  it('用户自己筛了 status 时不覆盖它 —— 两个条件并存（筛「待支付」诚实是空集）', async () => {
    await service.getAgentStats(q({ status: 'PENDING_PAYMENT' }), {
      userId: 'admin1',
      role: 'ADMIN',
    });
    const where = lastGroupByWhere();
    expect(where.status).toBe('PENDING_PAYMENT');
    expect(where.AND).toContainEqual({ status: { in: ['PAID', 'TICKETED', 'COMPLETED'] } });
  });

  it('聚合走 groupBy(agentId) + 求和，不把订单拉进内存', async () => {
    await service.getAgentStats(q(), { userId: 'admin1', role: 'ADMIN' });
    expect(mockPrisma.order.groupBy.mock.calls[0]?.[0]).toMatchObject({
      by: ['agentId'],
      _count: { _all: true },
      _sum: { total: true },
    });
    expect(mockPrisma.order.findMany).not.toHaveBeenCalled();
  });
});

describe('OrderService.getAgentStats · 与列表同一份 where（筛选 + RBAC）', () => {
  it('列表筛选原样带进聚合（软删排除 / 渠道 / 产品类型）', async () => {
    await service.getAgentStats(q({ channel: 'agent', kind: 'BUNDLE' }), {
      userId: 'admin1',
      role: 'ADMIN',
    });
    const where = lastGroupByWhere();
    expect(where.deletedAt).toBeNull();
    expect(where.AND).toContainEqual({ agentId: { not: null } });
    expect(where.AND).toContainEqual({ items: { some: { kind: 'BUNDLE' } } });
  });

  it('AGENT 只统计自己 + 下级（RBAC 基准写在 where.agentId 上）', async () => {
    await service.getAgentStats(q(), {
      userId: 'u-agent',
      role: 'AGENT',
      agentId: 'agt-self',
    });
    expect(lastGroupByWhere().agentId).toEqual({ in: ['agt-self', 'agt-child'] });
  });

  it('AGENT + channel=direct → RBAC 与直客条件并存 = 空集，而不是看到全站直客单', async () => {
    await service.getAgentStats(q({ channel: 'direct' }), {
      userId: 'u-agent',
      role: 'AGENT',
      agentId: 'agt-self',
    });
    const where = lastGroupByWhere();
    expect(where.agentId).toEqual({ in: ['agt-self', 'agt-child'] });
    expect(where.AND).toContainEqual({ agentId: null });
  });

  it('AGENT 指名一个不在可见集合里的代理 → 403，不是静默返回别家数据', async () => {
    await expect(
      service.getAgentStats(q({ agentId: 'agt-other' }), {
        userId: 'u-agent',
        role: 'AGENT',
        agentId: 'agt-self',
      }),
    ).rejects.toThrow('无权查看该代理的订单');
    expect(mockPrisma.order.groupBy).not.toHaveBeenCalled();
  });

  it('CUSTOMER 只统计自己的单', async () => {
    await service.getAgentStats(q(), { userId: 'u-cust', role: 'CUSTOMER' });
    expect(lastGroupByWhere().userId).toBe('u-cust');
  });

  it('出行日期精筛照样生效（与列表同一条两段式路径：先粗召回、再按 id in 收口）', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      {
        id: 'o-hit',
        items: [
          {
            hotelCheckIn: null,
            visaIntendedDate: null,
            flightScheduleId: 'sch-1',
            flightSchedule: {
              departureTime: new Date('2026-09-03T01:00:00Z'),
              departureTz: 'Asia/Macau',
              flight: { flightNumber: 'QH9588' },
            },
          },
        ],
      },
      {
        id: 'o-miss',
        items: [
          {
            hotelCheckIn: null,
            visaIntendedDate: null,
            flightScheduleId: 'sch-2',
            flightSchedule: {
              departureTime: new Date('2026-09-05T01:00:00Z'),
              departureTz: 'Asia/Macau',
              flight: { flightNumber: 'QH9588' },
            },
          },
        ],
      },
    ]);

    await service.getAgentStats(q({ travelFrom: '2026-09-03', travelTo: '2026-09-03' }), {
      userId: 'admin1',
      role: 'ADMIN',
    });

    // 粗窗口召回两单，精筛只留 9/3 出发的那一单。
    expect(mockPrisma.order.findMany).toHaveBeenCalledTimes(1);
    expect(lastGroupByWhere().id).toEqual({ in: ['o-hit'] });
  });
});
