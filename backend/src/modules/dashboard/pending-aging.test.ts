/**
 * 待支付订单账龄分桶单测。
 *
 * 重点盯两件事：
 *   1. 分桶边界（24h / 3d / 7d 整点归老档），且「卡片计数用的 where」与「分桶判定」互为镜像 ——
 *      两者一旦漂移，卡片数字和点进去的列表就对不上，这功能等于没做。
 *   2. 无支付时限（paymentExpiresAt IS NULL）单独计数，且下钻能只筛这一类。
 *
 * mock 风格对齐既有模块：vi.hoisted + vi.mock Prisma。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

const {
  PendingAgingService,
  PENDING_AGING_BUCKETS,
  agingBoundaries,
  bucketForAgeMs,
  bucketForCreatedAt,
  bucketCreatedAtWhere,
  departureDateOf,
  seatsOf,
} = await import('./pending-aging.service.js');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-07-15T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bucketForAgeMs — 账龄分桶边界', () => {
  it('刚下单（0 小时）落在 24 小时内一档', () => {
    expect(bucketForAgeMs(0)).toBe('LT_24H');
  });

  it('23h59m 仍算 24 小时内', () => {
    expect(bucketForAgeMs(DAY - 60_000)).toBe('LT_24H');
  });

  it('整 24 小时归入更老的 1-3 天档（边界不粉饰）', () => {
    expect(bucketForAgeMs(DAY)).toBe('D1_3');
  });

  it('整 3 天归入更老的 3-7 天档', () => {
    expect(bucketForAgeMs(3 * DAY)).toBe('D3_7');
  });

  it('2 天 23 小时仍算 1-3 天档', () => {
    expect(bucketForAgeMs(3 * DAY - HOUR)).toBe('D1_3');
  });

  it('整 7 天归入超过 7 天档', () => {
    expect(bucketForAgeMs(7 * DAY)).toBe('GT_7D');
  });

  it('6 天 23 小时仍算 3-7 天档', () => {
    expect(bucketForAgeMs(7 * DAY - HOUR)).toBe('D3_7');
  });

  it('躺了 60 天的老单落在超过 7 天档', () => {
    expect(bucketForAgeMs(60 * DAY)).toBe('GT_7D');
  });

  it('负账龄（下单时刻在未来／时钟漂移）按最新一档处理，不会误落老档', () => {
    expect(bucketForAgeMs(-HOUR)).toBe('LT_24H');
  });
});

describe('bucketForCreatedAt', () => {
  it('按 now − createdAt 判档', () => {
    expect(bucketForCreatedAt(new Date(NOW.getTime() - 5 * DAY), NOW)).toBe('D3_7');
  });
});

describe('agingBoundaries', () => {
  it('给出 now−24h / now−3d / now−7d 三个切点', () => {
    const { h24, d3, d7 } = agingBoundaries(NOW);
    expect(h24.toISOString()).toBe('2026-07-14T12:00:00.000Z');
    expect(d3.toISOString()).toBe('2026-07-12T12:00:00.000Z');
    expect(d7.toISOString()).toBe('2026-07-08T12:00:00.000Z');
  });
});

describe('bucketCreatedAtWhere — 与分桶判定互为镜像', () => {
  // 这是本功能的命门：卡片数字（count 用 where）与列表判档（bucketForCreatedAt）必须同边界。
  // 用一批跨越所有边界的 createdAt 交叉验证：where 命中的，判档结论必须一致。
  const samples = [
    0,
    HOUR,
    DAY - 1,
    DAY,
    DAY + 1,
    2 * DAY,
    3 * DAY - 1,
    3 * DAY,
    3 * DAY + 1,
    5 * DAY,
    7 * DAY - 1,
    7 * DAY,
    7 * DAY + 1,
    60 * DAY,
  ];

  function matchesWhere(createdAt: Date, where: { gt?: Date; lte?: Date }): boolean {
    if (where.gt && !(createdAt.getTime() > where.gt.getTime())) return false;
    if (where.lte && !(createdAt.getTime() <= where.lte.getTime())) return false;
    return true;
  }

  it('每个账龄样本恰好落进一个桶的 where，且与 bucketForCreatedAt 结论一致', () => {
    for (const ageMs of samples) {
      const createdAt = new Date(NOW.getTime() - ageMs);
      const expected = bucketForCreatedAt(createdAt, NOW);
      const hit = PENDING_AGING_BUCKETS.filter((b) =>
        matchesWhere(createdAt, bucketCreatedAtWhere(b, NOW) as { gt?: Date; lte?: Date }),
      );
      expect(hit, `账龄 ${ageMs}ms 应恰好命中一个桶，实际命中 ${hit.join(',')}`).toEqual([expected]);
    }
  });
});

describe('departureDateOf — 最早出发日', () => {
  it('取机票行最早的 departureTime', () => {
    const items = [
      { kind: 'FLIGHT', hotelCheckIn: null, flightSchedule: { departureTime: new Date('2026-09-20T02:00:00Z') } },
      { kind: 'FLIGHT', hotelCheckIn: null, flightSchedule: { departureTime: new Date('2026-09-13T02:00:00Z') } },
    ];
    expect(departureDateOf(items)).toBe('2026-09-13');
  });

  it('无机票行时退到酒店入住日', () => {
    const items = [
      { kind: 'HOTEL', hotelCheckIn: new Date('2026-08-01T00:00:00Z'), flightSchedule: null },
    ];
    expect(departureDateOf(items)).toBe('2026-08-01');
  });

  it('有机票行时不被酒店日期干扰（机票优先）', () => {
    const items = [
      { kind: 'HOTEL', hotelCheckIn: new Date('2026-08-01T00:00:00Z'), flightSchedule: null },
      { kind: 'FLIGHT', hotelCheckIn: null, flightSchedule: { departureTime: new Date('2026-09-13T02:00:00Z') } },
    ];
    expect(departureDateOf(items)).toBe('2026-09-13');
  });

  it('纯签证单无行程日期 → null', () => {
    expect(departureDateOf([{ kind: 'VISA', hotelCheckIn: null, flightSchedule: null }])).toBeNull();
  });

  it('空行 → null', () => {
    expect(departureDateOf([])).toBeNull();
  });
});

describe('seatsOf — 占座人数', () => {
  it('含机票行 → 乘客数即占座人数（往返同一批人不重复计）', () => {
    const items = [
      { kind: 'FLIGHT', hotelCheckIn: null, flightSchedule: { departureTime: new Date('2026-09-13T02:00:00Z') } },
      { kind: 'FLIGHT', hotelCheckIn: null, flightSchedule: { departureTime: new Date('2026-09-20T02:00:00Z') } },
    ];
    expect(seatsOf(items, 2)).toBe(2);
  });

  it('纯酒店单不占机位 → 0', () => {
    expect(seatsOf([{ kind: 'HOTEL', hotelCheckIn: new Date('2026-08-01T00:00:00Z'), flightSchedule: null }], 3)).toBe(0);
  });
});

describe('PendingAgingService.getSummary', () => {
  it('四档各出一个总数与一个无支付时限数，并汇总', async () => {
    // count 调用顺序：每档先 orders 再 noClockOrders（见实现里的 Promise.all 配对）
    const service = new PendingAgingService();
    mockPrisma.order.count
      .mockResolvedValueOnce(10).mockResolvedValueOnce(4)   // LT_24H
      .mockResolvedValueOnce(6).mockResolvedValueOnce(5)    // D1_3
      .mockResolvedValueOnce(3).mockResolvedValueOnce(3)    // D3_7
      .mockResolvedValueOnce(2).mockResolvedValueOnce(2);   // GT_7D

    const summary = await service.getSummary(NOW);

    expect(summary.buckets).toEqual([
      { bucket: 'LT_24H', orders: 10, noClockOrders: 4 },
      { bucket: 'D1_3', orders: 6, noClockOrders: 5 },
      { bucket: 'D3_7', orders: 3, noClockOrders: 3 },
      { bucket: 'GT_7D', orders: 2, noClockOrders: 2 },
    ]);
    expect(summary.totalOrders).toBe(21);
    expect(summary.totalNoClockOrders).toBe(14);
    expect(summary.asOf).toBe(NOW.toISOString());
  });

  it('只统计未软删的 PENDING_PAYMENT，且无支付时限那次 count 带 paymentExpiresAt: null', async () => {
    const service = new PendingAgingService();
    mockPrisma.order.count.mockResolvedValue(0);
    await service.getSummary(NOW);

    const calls = mockPrisma.order.count.mock.calls.map((c) => c[0].where);
    // 每一次 count 都必须挂 deletedAt: null + status: PENDING_PAYMENT（否则把已删单/别的状态算进来）
    for (const where of calls) {
      expect(where.deletedAt).toBeNull();
      expect(where.status).toBe('PENDING_PAYMENT');
    }
    // 8 次调用里恰好 4 次（每档一次）筛 paymentExpiresAt: null
    const noClockCalls = calls.filter((w) => w.paymentExpiresAt === null);
    expect(calls).toHaveLength(8);
    expect(noClockCalls).toHaveLength(4);
  });
});

describe('PendingAgingService.listOrders — 下钻', () => {
  const baseRow = {
    id: 'o1',
    orderNumber: 'FTM2026070100001',
    createdAt: new Date(NOW.getTime() - 10 * DAY),
    paymentExpiresAt: null,
    contactName: '张三',
    agentId: 'a1',
    agent: { companyName: '示例商旅', contactName: '联系人' },
    _count: { passengers: 2 },
    items: [
      { kind: 'FLIGHT', hotelCheckIn: null, flightSchedule: { departureTime: new Date('2026-09-13T02:00:00Z') } },
    ],
  };

  it('返回代理 / 出发日 / 账龄 / 占座人数 / 无时限标记', async () => {
    const service = new PendingAgingService();
    mockPrisma.order.count.mockResolvedValue(1);
    mockPrisma.order.findMany.mockResolvedValue([baseRow]);

    const res = await service.listOrders({ page: 1, pageSize: 50 }, NOW);

    expect(res.total).toBe(1);
    expect(res.orders[0]).toMatchObject({
      orderNumber: 'FTM2026070100001',
      agentName: '示例商旅',
      departureDate: '2026-09-13',
      ageHours: 240,
      bucket: 'GT_7D',
      noClock: true,
      seats: 2,
    });
  });

  it('代理无公司名时回落到联系人；直客单代理名为 null', async () => {
    const service = new PendingAgingService();
    mockPrisma.order.count.mockResolvedValue(2);
    mockPrisma.order.findMany.mockResolvedValue([
      { ...baseRow, agent: { companyName: null, contactName: '个体代理' } },
      { ...baseRow, id: 'o2', agentId: null, agent: null },
    ]);

    const res = await service.listOrders({ page: 1, pageSize: 50 }, NOW);
    expect(res.orders[0].agentName).toBe('个体代理');
    expect(res.orders[1].agentName).toBeNull();
  });

  it('有支付时限的单 noClock=false', async () => {
    const service = new PendingAgingService();
    mockPrisma.order.count.mockResolvedValue(1);
    mockPrisma.order.findMany.mockResolvedValue([
      { ...baseRow, paymentExpiresAt: new Date(NOW.getTime() + 30 * 60_000) },
    ]);

    const res = await service.listOrders({ page: 1, pageSize: 50 }, NOW);
    expect(res.orders[0].noClock).toBe(false);
  });

  it('noClockOnly 筛出无支付时限单；bucket 转成对应的 createdAt 窗口', async () => {
    const service = new PendingAgingService();
    mockPrisma.order.count.mockResolvedValue(0);
    mockPrisma.order.findMany.mockResolvedValue([]);

    await service.listOrders({ bucket: 'GT_7D', noClockOnly: true, page: 1, pageSize: 50 }, NOW);

    const where = mockPrisma.order.findMany.mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe('PENDING_PAYMENT');
    expect(where.paymentExpiresAt).toBeNull();
    expect(where.createdAt).toEqual(bucketCreatedAtWhere('GT_7D', NOW));
  });

  it('不给 bucket = 不限账龄（where 不含 createdAt）；不给 noClockOnly 则不筛时限', async () => {
    const service = new PendingAgingService();
    mockPrisma.order.count.mockResolvedValue(0);
    mockPrisma.order.findMany.mockResolvedValue([]);

    await service.listOrders({ page: 1, pageSize: 50 }, NOW);

    const where = mockPrisma.order.findMany.mock.calls[0][0].where;
    expect(where.createdAt).toBeUndefined();
    expect(where.paymentExpiresAt).toBeUndefined();
  });

  it('最老的排最前，并按 page/pageSize 分页', async () => {
    const service = new PendingAgingService();
    mockPrisma.order.count.mockResolvedValue(0);
    mockPrisma.order.findMany.mockResolvedValue([]);

    await service.listOrders({ page: 3, pageSize: 20 }, NOW);

    const args = mockPrisma.order.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
    expect(args.skip).toBe(40);
    expect(args.take).toBe(20);
  });
});
