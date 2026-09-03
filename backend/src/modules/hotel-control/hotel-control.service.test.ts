/**
 * getAlerts（提醒线）· 单元测试（vitest）
 *
 * 注入 fake PrismaClient（getBoard/getAlerts 都支持 client 参数），覆盖三类提醒：
 *   1. oversold        余量 < 0 → 提醒加房（deficit = used - block）
 *   2. surplusSoon     距今 3 天内 block > 0 且 remaining > 0 → 提示退房
 *   3. overCapacity    出发 30 天内班次计入口径乘客数 > 座位库存（Σ 各舱位 capacity）
 *
 * 日期 fixture 全部相对"今天"动态生成，避免用例随日历过期。
 */
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest';

// 默认 prisma 不参与（全部走注入 client）—— 仍需 mock 掉避免真实连接配置
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

// updateBlockPeriod 的超占 WARNING 审计走 writeAudit——mock 掉以断言调用，同时避免
// 真去碰被 mock 成 {} 的 prisma.auditLog。
const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
vi.mock('../../lib/audit.js', () => ({ writeAudit: auditMock }));

vi.useFakeTimers();
vi.setSystemTime(new Date('2026-08-24T17:00:00.000Z'));
afterAll(() => vi.useRealTimers());

import type { Gender, PrismaClient } from '@prisma/client';
import { businessDateISO } from '../../lib/business-time.js';

/** 拼房单出行人性别 fixture：单出行人套餐单的 order.passengers 形状（gender 明确类型，避免 string 收窄丢失）。*/
const solo = (gender: Gender | null): { order: { passengers: { gender: Gender | null }[] } } => ({
  order: { passengers: [{ gender }] },
});
import {
  getAlerts,
  getBoard,
  getForward,
  getOccupyingOrders,
  getNightlyRemainingForRoomType,
  getHotelNightlyRemaining,
  expandSharedHalfByDate,
  computePhysicalUsed,
  assignedPhysicalRooms,
  expandAssignedPhysicalByDate,
  expandSplitPairedByDate,
  checkHotelPhysicalFit,
  assertHotelPhysicalFit,
  assertHotelPhysicalFitWithinTx,
  lockHotelBlockPeriodsWithinTx,
  getHotelOversellCapRooms,
  getRandomTierAggregate,
  assertRandomTierFit,
  assertRandomTierFitWithinTx,
  lockRandomTierBlockPeriodsWithinTx,
  createBlockPeriod,
  updateBlockPeriod,
  deleteBlockPeriod,
  listBlockPeriods,
  getRecentRoomChanges,
} from './hotel-control.service.js';

/** 权威分房表 fixture：groupSizes[i] = 第 i 个房间盒子的乘客数（形状同 orders 模块分房保存）。*/
const roomAssignmentOf = (groupSizes: number[]) => ({
  roomGroups: groupSizes.map((size, i) => ({
    id: `g${i + 1}`,
    hotelName: '美溪海滩酒店',
    roomType: '',
    passengerIds: Array.from({ length: size }, (_, j) => `p${i + 1}-${j + 1}`),
  })),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const todayStr = businessDateISO(new Date());
const todayMs = new Date(`${todayStr}T00:00:00.000Z`).getTime();

/** 距今 n 天的 UTC 零点 Date / YYYY-MM-DD。*/
const day = (n: number): Date => new Date(todayMs + n * DAY_MS);
const dayStr = (n: number): string => day(n).toISOString().slice(0, 10);

/**
 * @param opts.restoredItems no-show 恢复超售的回程行（走 metadata path 过滤的那次查询）；
 *   缺省空数组 = 没有任何恢复超售，行为与旧版逐位一致。
 */
function fakeClient(opts: { paxCounts: number[]; restoredItems?: unknown[] }): PrismaClient {
  return {
    // 包房：1 间，覆盖 today..today+13
    hotelBlockPeriod: {
      findMany: vi.fn().mockResolvedValue([
        {
          hotelId: 'h1',
          dateFrom: day(0),
          dateTo: day(13),
          rooms: 1,
          unitPrice: null,
          hotel: { name: '美溪海滩酒店' },
        },
      ]),
    },
    // 占房：今晚 2 行 → used(today)=2 > block=1 → 超卖
    // 带 metadata 过滤的那次查询是「no-show 恢复超售」取数，走另一条返回。
    orderItem: {
      findMany: vi.fn(async (args: unknown) => {
        const where = (args as { where?: Record<string, unknown> }).where ?? {};
        if (where.metadata) return opts.restoredItems ?? [];
        return [
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } },
        },
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } },
        },
        ];
      }),
    },
    flightSchedule: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 's1',
          departureTime: day(1),
          // 座位库存 = Σ 各舱位 capacity（12 商务 + 179 经济 = 191），与开票上限同源。
          seatClasses: [{ capacity: 12 }, { capacity: 179 }],
          flight: { flightNumber: 'QH9589' },
        },
        {
          id: 's2',
          departureTime: day(2),
          // 座位库存 = Σ 各舱位 capacity（12 商务 + 179 经济 = 191），与开票上限同源。
          seatClasses: [{ capacity: 12 }, { capacity: 179 }],
          flight: { flightNumber: 'QH9590' },
        },
      ]),
    },
    passenger: {
      count: opts.paxCounts.reduce(
        (fn, n) => fn.mockResolvedValueOnce(n),
        vi.fn(),
      ),
    },
  } as unknown as PrismaClient;
}

describe('getAlerts', () => {
  it('超卖 / 富余 / 班次超员三线齐报', async () => {
    const client = fakeClient({ paxCounts: [195, 100] });
    const alerts = await getAlerts(14, client);

    const flightScheduleFindMany = client.flightSchedule.findMany as unknown as ReturnType<typeof vi.fn>;
    expect(flightScheduleFindMany.mock.calls[0][0].where.departureTime).toEqual({
      gte: new Date('2026-08-24T16:00:00.000Z'),
      lt: new Date('2026-09-23T16:00:00.000Z'),
    });

    // 今晚 block=1 used=2 → 超卖 1 间
    expect(alerts.oversold).toEqual([
      {
        hotelId: 'h1',
        hotelName: '美溪海滩酒店',
        date: todayStr,
        block: 1,
        used: 2,
        deficit: 1,
      },
    ]);

    // 距今 3 天内（D+1、D+2）仍剩 1 间 → 提示退房；今天余量为负不算富余
    expect(alerts.surplusSoon).toEqual([
      { hotelName: '美溪海滩酒店', date: dayStr(1), surplus: 1 },
      { hotelName: '美溪海滩酒店', date: dayStr(2), surplus: 1 },
    ]);

    // s1 乘客 195 > 191 → 报；s2 乘客 100 → 不报
    expect(alerts.overCapacitySchedules).toEqual([
      {
        flightNumber: 'QH9589',
        departureDate: dayStr(1),
        paxCount: 195,
        noShowOversoldSeats: 0,
        note: '',
      },
    ]);
  });

  it('乘客数恰好等于上限不报（> 才报）', async () => {
    const client = fakeClient({ paxCounts: [191, 191] });
    const alerts = await getAlerts(14, client);
    expect(alerts.overCapacitySchedules).toEqual([]);
  });

  // ── no-show 恢复超售：已人为确认 + 已落 CRITICAL 审计，不该当成异常刷屏 ──────
  const restoredItem = (scheduleId: string, oversoldBy: number) => ({
    flightScheduleId: scheduleId,
    metadata: {
      returnRestored: {
        at: '2026-09-02T05:00:00.000Z',
        oversold: oversoldBy > 0,
        oversoldBy,
      },
    },
  });

  it('超员完全由 no-show 恢复超售解释（超出量 ≤ N）→ 不报', async () => {
    const client = fakeClient({
      paxCounts: [193, 100],
      restoredItems: [restoredItem('s1', 1), restoredItem('s1', 1)],
    });
    const alerts = await getAlerts(14, client);
    expect(alerts.overCapacitySchedules).toEqual([]);
  });

  it('超出量大于 no-show 恢复超售座数 → 照报，文案标注已放行的部分', async () => {
    const client = fakeClient({
      paxCounts: [195, 100],
      restoredItems: [restoredItem('s1', 2)],
    });
    const alerts = await getAlerts(14, client);
    expect(alerts.overCapacitySchedules).toEqual([
      {
        flightNumber: 'QH9589',
        departureDate: dayStr(1),
        paxCount: 195,
        noShowOversoldSeats: 2,
        note: '（其中 2 座为 no-show 恢复超售，已审计放行）',
      },
    ]);
  });

  it('恢复时没超售（oversold=false）不算数：超员照旧全额报警', async () => {
    const client = fakeClient({
      paxCounts: [193, 100],
      restoredItems: [restoredItem('s1', 0)],
    });
    const alerts = await getAlerts(14, client);
    expect(alerts.overCapacitySchedules).toEqual([
      {
        flightNumber: 'QH9589',
        departureDate: dayStr(1),
        paxCount: 193,
        noShowOversoldSeats: 0,
        note: '',
      },
    ]);
  });

  it('别的班次的恢复超售不串台', async () => {
    const client = fakeClient({
      paxCounts: [193, 100],
      restoredItems: [restoredItem('s2', 5)],
    });
    const alerts = await getAlerts(14, client);
    expect(alerts.overCapacitySchedules).toMatchObject([
      { flightNumber: 'QH9589', paxCount: 193, noShowOversoldSeats: 0, note: '' },
    ]);
  });
});

describe('getAlerts sharedOddNear（拼房落单临近推送）', () => {
  const rt = { hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } } };

  /**
   * 拼房落单场景专用 fake client：包房 5 间覆盖 today..today+29，
   * 无班次/乘客（overCapacity 不参与），占房行由用例注入。
   */
  function sharedClient(orderItems: unknown[]): PrismaClient {
    return {
      hotelBlockPeriod: {
        findMany: vi.fn().mockResolvedValue([
          {
            hotelId: 'h1',
            dateFrom: day(0),
            dateTo: day(29),
            rooms: 5,
            unitPrice: null,
            hotel: { name: '美溪海滩酒店' },
          },
        ]),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue(orderItems) },
      flightSchedule: { findMany: vi.fn().mockResolvedValue([]) },
      passenger: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient;
  }

  const male = { order: { passengers: [{ gender: 'M' }] } };
  const female = { order: { passengers: [{ gender: 'F' }] } };

  it('临近日（窗口内）有拼房客落单（异性不能拼）→ 报，且带酒店/日期/总人数', async () => {
    // D+3 一男一女拼房客（异性不能拼，2 位落单）——入住临近（< 7 天）
    const client = sharedClient([
      { hotelCheckIn: day(3), hotelCheckOut: day(4), roomsBilled: 0.5, ...male, ...rt },
      { hotelCheckIn: day(3), hotelCheckOut: day(4), roomsBilled: 0.5, ...female, ...rt },
    ]);
    const alerts = await getAlerts(30, client);
    // sharedHalfCount = 当晚拼房客总人数（2）；触发条件是落单数 > 0
    expect(alerts.sharedOddNear).toEqual([
      { hotelId: 'h1', hotelName: '美溪海滩酒店', date: dayStr(3), sharedHalfCount: 2 },
    ]);
  });

  it('远期日（窗口外）有落单 → 不报', async () => {
    // D+10 一位拼房客（落单）——超出 7 天窗口
    const client = sharedClient([
      { hotelCheckIn: day(10), hotelCheckOut: day(11), roomsBilled: 0.5, ...male, ...rt },
    ]);
    const alerts = await getAlerts(30, client);
    expect(alerts.sharedOddNear).toEqual([]);
  });

  it('临近日两位同性拼房客 → 不报（同性两两成对，无人落单）', async () => {
    // D+2 两位男性拼房客（同性可拼一间，无落单）
    const client = sharedClient([
      { hotelCheckIn: day(2), hotelCheckOut: day(3), roomsBilled: 0.5, ...male, ...rt },
      { hotelCheckIn: day(2), hotelCheckOut: day(3), roomsBilled: 0.5, ...male, ...rt },
    ]);
    const alerts = await getAlerts(30, client);
    expect(alerts.sharedOddNear).toEqual([]);
  });
});

describe('expandSharedHalfByDate（按性别分桶）', () => {
  const dates = [dayStr(0), dayStr(1), dayStr(2)];
  const male = solo('M');
  const female = solo('F');

  it('只数 roomsBilled==0.5 的行，按出行人性别分入 m/f/u；整间/其它房量不计', () => {
    const items = [
      // 男拼房客 A：D0..D1 覆盖 D0
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...male },
      // 整间：不计
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 1, ...male },
      // 女拼房客 B：D0..D2 覆盖 D0、D1
      { hotelCheckIn: day(0), hotelCheckOut: day(2), roomsBilled: 0.5, ...female },
    ];
    // m: A → D0；f: B → D0、D1
    expect(expandSharedHalfByDate(items, dates)).toEqual({
      m: [1, 0, 0],
      f: [1, 1, 0],
      u: [0, 0, 0],
    });
  });

  it('性别为 X / null / 缺出行人 → 归入未知桶 u', () => {
    const items = [
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...solo('X') },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...solo(null) },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, order: { passengers: [] as { gender: Gender | null }[] } },
    ];
    // 三位都归入 u（D0）
    expect(expandSharedHalfByDate(items, dates)).toEqual({
      m: [0, 0, 0],
      f: [0, 0, 0],
      u: [3, 0, 0],
    });
  });

  it('缺 check-in/out 或非 0.5 的行跳过', () => {
    const items = [
      { hotelCheckIn: null, hotelCheckOut: day(1), roomsBilled: 0.5, ...male },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: null, ...male },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.25, ...male },
    ];
    expect(expandSharedHalfByDate(items, dates)).toEqual({
      m: [0, 0, 0],
      f: [0, 0, 0],
      u: [0, 0, 0],
    });
  });
});

describe('getBoard sharedHalfCount / sharedUnpaired / sharedOdd', () => {
  const rtName = { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } };
  const male = { order: { passengers: [{ gender: 'M' }] } };
  const female = { order: { passengers: [{ gender: 'F' }] } };

  function boardClient(orderItems: unknown[]): PrismaClient {
    return {
      hotelBlockPeriod: {
        findMany: vi.fn().mockResolvedValue([
          {
            hotelId: 'h1',
            dateFrom: day(0),
            dateTo: day(2),
            rooms: 5,
            unitPrice: null,
            hotel: { name: '美溪海滩酒店' },
          },
        ]),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue(orderItems) },
    } as unknown as PrismaClient;
  }

  it('同性两位不落单（sharedOdd=false）；异性两位全落单（sharedOdd=true）；整间不影响', async () => {
    const client = boardClient([
      // D0 两位男拼房（同性可配对，落单 0）+ 一整间
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...male, hotelRoomType: rtName },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...male, hotelRoomType: rtName },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 1, ...male, hotelRoomType: rtName },
      // D1 一男一女拼房（异性不能拼，落单 2）
      { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 0.5, ...male, hotelRoomType: rtName },
      { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 0.5, ...female, hotelRoomType: rtName },
    ]);
    const board = await getBoard({ from: dayStr(0), to: dayStr(2) }, client);
    const rows = board.hotels[0]!.rows;
    // 总人数 D0=2, D1=2, D2=0
    expect(rows.sharedHalfCount).toEqual([2, 2, 0]);
    // 落单数：D0 两男 → 0；D1 一男一女 → 2；D2 → 0
    expect(rows.sharedUnpaired).toEqual([0, 2, 0]);
    expect(rows.sharedOdd).toEqual([false, true, false]);
    // 既有口径不受影响
    expect(rows.remaining.length).toBe(3);
  });
});

describe('computePhysicalUsed（按性别分组，异性不能拼）', () => {
  const b = (m: number, f: number, u: number) => ({ m: [m], f: [f], u: [u] });

  it('一男一女 → 床位 1.0，物理 ceil(1/2)+ceil(1/2)+0 = 2 间', () => {
    expect(computePhysicalUsed([1.0], b(1, 1, 0))).toEqual([2]);
  });

  it('两男 → 床位 1.0，物理 ceil(2/2)+0+0 = 1 间', () => {
    expect(computePhysicalUsed([1.0], b(2, 0, 0))).toEqual([1]);
  });

  it('两男一女 → 床位 1.5，物理 ceil(2/2)+ceil(1/2)+0 = 2 间', () => {
    expect(computePhysicalUsed([1.5], b(2, 1, 0))).toEqual([2]);
  });

  it('一男一未知 → 床位 1.0，物理 ceil(1/2)+0+1 = 2 间（未知每人独占）', () => {
    expect(computePhysicalUsed([1.0], b(1, 0, 1))).toEqual([2]);
  });

  it('两位拼房客 + 1 整间（同性）→ 床位 2.0，物理 ceil(2/2)+1 = 2 间', () => {
    // used = 2*0.5 + 1 = 2.0
    expect(computePhysicalUsed([2.0], b(2, 0, 0))).toEqual([2]);
  });

  it('0 拼房客、2 整间 → 物理 = 2（与床位口径一致）', () => {
    expect(computePhysicalUsed([2], b(0, 0, 0))).toEqual([2]);
  });

  it('仅 1 位拼房客 → 床位 0.5，落单向上取整为整间 → 物理 1', () => {
    expect(computePhysicalUsed([0.5], b(1, 0, 0))).toEqual([1]);
  });

  it('浮点误差（0.5 累加）不影响整间余数取整', () => {
    // 3 位拼房（两男一女）+ 2 整间：床位 = 1.5 + 2 = 3.5（可能带 0.999… 误差）
    const usedWithError = 0.5 + 0.5 + 0.5 + 1 + 1; // = 3.5，构造累加路径
    // ceil(2/2)+ceil(1/2)=2, 整间 2 → 4
    expect(computePhysicalUsed([usedWithError], b(2, 1, 0))).toEqual([4]);
  });
});

describe('getBoard physicalUsed / physicalRemaining', () => {
  const male = { order: { passengers: [{ gender: 'M' }] } };
  const female = { order: { passengers: [{ gender: 'F' }] } };

  function boardClient(orderItems: unknown[], rooms = 5): PrismaClient {
    return {
      hotelBlockPeriod: {
        findMany: vi.fn().mockResolvedValue([
          {
            hotelId: 'h1',
            dateFrom: day(0),
            dateTo: day(2),
            rooms,
            unitPrice: null,
            hotel: { name: '美溪海滩酒店' },
          },
        ]),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue(orderItems) },
    } as unknown as PrismaClient;
  }

  it('销控板输出物理房间口径（block=5，D0 两男一女→物理 2，余 3）', async () => {
    const rt = { hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } } };
    const client = boardClient([
      // D0：两男一女拼房客 → 床位 1.5、物理 ceil(2/2)+ceil(1/2)=2
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...male, ...rt },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...male, ...rt },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...female, ...rt },
      // D1：两男拼房客 + 1 整间 → 床位 2.0、物理 ceil(2/2)+1=2
      { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 0.5, ...male, ...rt },
      { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 0.5, ...male, ...rt },
      { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 1, ...male, ...rt },
    ]);
    const board = await getBoard({ from: dayStr(0), to: dayStr(2) }, client);
    const rows = board.hotels[0]!.rows;
    // 床位口径不变
    expect(rows.used).toEqual([1.5, 2, 0]);
    // 物理房间口径：D0=2, D1=2, D2=0
    expect(rows.physicalUsed).toEqual([2, 2, 0]);
    // 物理余量 = block(5) - physicalUsed
    expect(rows.physicalRemaining).toEqual([3, 3, 5]);
  });

  it('反馈场景：卢瑟特里同晚一男一女各 1 位拼房客（block=10）→ 物理 2、余量 8', async () => {
    const rt = { hotelRoomType: { hotelId: 'h1', hotel: { name: '卢瑟特里' } } };
    const client = boardClient(
      [
        // 订单甲：1 位男拼房客；订单乙：1 位女拼房客；异性不能拼 → 各占 1 间
        { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...male, ...rt },
        { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...female, ...rt },
      ],
      10,
    );
    const board = await getBoard({ from: dayStr(0), to: dayStr(0) }, client);
    const rows = board.hotels[0]!.rows;
    // 床位口径 used = 1.0，但物理房间 = 2（异性各占 1 间），余量 = 10 − 2 = 8
    expect(rows.used).toEqual([1]);
    expect(rows.physicalUsed).toEqual([2]);
    expect(rows.physicalRemaining).toEqual([8]);
    // 两位都落单（无法互相配对）
    expect(rows.sharedUnpaired).toEqual([2]);
  });
});

/**
 * getHotelNightlyRemaining 返回物理房间口径 physicalRemaining（分房表「当日余房」列消费）：
 * 与 getBoard 的 physicalRemaining 同公式（expandSharedHalfByDate + computePhysicalUsed），
 * 床位口径 remaining 保持原值不动——既有调用方（前台可售/下单校验等）不受影响。
 */
describe('getHotelNightlyRemaining physicalRemaining（物理房间口径）', () => {
  const male = { order: { passengers: [{ gender: 'M' }] } };
  const female = { order: { passengers: [{ gender: 'F' }] } };

  function nightlyClient(orderItems: unknown[], rooms = 10): PrismaClient {
    return {
      hotelBlockPeriod: {
        findMany: vi.fn().mockResolvedValue([
          { hotelId: 'h1', dateFrom: day(0), dateTo: day(2), rooms },
        ]),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue(orderItems) },
    } as unknown as PrismaClient;
  }

  it('一男一女各 1 位拼房客（block=10）→ remaining=9（床位）、physicalRemaining=8（物理）', async () => {
    const client = nightlyClient([
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...male },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...female },
    ]);
    const res = await getHotelNightlyRemaining('h1', [dayStr(0)], client);
    expect(res.hasBlock).toBe(true);
    // 床位口径维持原值（0.5+0.5=1 → 10-1=9）
    expect(res.remaining).toEqual([9]);
    // 物理口径：异性不能拼一间 → 各占 1 间 → 10-2=8（不是 8.5/9）
    expect(res.physicalRemaining).toEqual([8]);
  });

  it('两男拼房 + 1 整间 → remaining=8（床位 2）、physicalRemaining=8（物理 2，同性可拼）', async () => {
    const client = nightlyClient([
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...male },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...male },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 1, ...male },
    ]);
    const res = await getHotelNightlyRemaining('h1', [dayStr(0)], client);
    expect(res.remaining).toEqual([8]);
    expect(res.physicalRemaining).toEqual([8]);
  });

  it('无周期（hasBlock=false）→ physicalRemaining 同为空数组', async () => {
    const client = {
      hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue([]) },
      orderItem: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    const res = await getHotelNightlyRemaining('h1', [dayStr(0)], client);
    expect(res.hasBlock).toBe(false);
    expect(res.remaining).toEqual([]);
    expect(res.physicalRemaining).toEqual([]);
  });
});

// ── 权威分房表优先（Order.roomAssignment.roomGroups → 物理间数直计）──────────
describe('assignedPhysicalRooms（分房表物理间数）', () => {
  it('两个有乘客的房间盒子 → 2；空乘客盒子不计', () => {
    expect(assignedPhysicalRooms(roomAssignmentOf([1, 1]))).toBe(2);
    expect(
      assignedPhysicalRooms({
        roomGroups: [
          { id: 'g1', passengerIds: ['p1', 'p2'] },
          { id: 'g2', passengerIds: [] },
        ],
      }),
    ).toBe(1);
  });

  it('无分房表 / 形状不符 / 全盒子无人 → null（走性别推算 fallback）', () => {
    expect(assignedPhysicalRooms(null)).toBeNull();
    expect(assignedPhysicalRooms(undefined)).toBeNull();
    expect(assignedPhysicalRooms('bogus')).toBeNull();
    expect(assignedPhysicalRooms({})).toBeNull();
    expect(assignedPhysicalRooms({ roomGroups: [] })).toBeNull();
    expect(assignedPhysicalRooms({ roomGroups: 'oops' })).toBeNull();
    expect(assignedPhysicalRooms({ roomGroups: [{ id: 'g1', passengerIds: [] }] })).toBeNull();
  });
});

describe('expandAssignedPhysicalByDate（拆分 + 订单级去重）', () => {
  const dates = [dayStr(0), dayStr(1), dayStr(2)];

  it('分房表订单逐日直计间数；无分房表行原样进 fallback', () => {
    const assigned = {
      hotelCheckIn: day(0),
      hotelCheckOut: day(2),
      roomsBilled: 1,
      order: { id: 'o1', roomAssignment: roomAssignmentOf([1, 1]), passengers: [] },
    };
    const fallback = {
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      roomsBilled: 0.5,
      order: { id: 'o2', roomAssignment: null, passengers: [] },
    };
    const res = expandAssignedPhysicalByDate([assigned, fallback], dates);
    // 分房表 2 个有乘客盒子 → D0、D1 各 2 间
    expect(res.assignedPhysical).toEqual([2, 2, 0]);
    expect(res.fallbackItems).toEqual([fallback]);
  });

  it('同单多行（分段住 / 两房型）订单级去重：每晚只按分房表间数计一次', () => {
    const order = { id: 'o1', roomAssignment: roomAssignmentOf([1, 1]), passengers: [] };
    const rows = [
      // 分段住：D0..D1 + D1..D2；D1 由两行同时覆盖也只计一次
      { hotelCheckIn: day(0), hotelCheckOut: day(2), roomsBilled: 2, order },
      { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: null, order },
    ];
    const res = expandAssignedPhysicalByDate(rows, dates);
    expect(res.assignedPhysical).toEqual([2, 2, 0]);
    expect(res.fallbackItems).toEqual([]);
  });
});

describe('expandAssignedPhysicalByDate 房组归属过滤（一单两酒店不双算）', () => {
  const dates = [dayStr(0), dayStr(1), dayStr(2)];

  /** 带归属的分房表：groups[i] = { orderItemId?, hotelName?, size }。*/
  const attributedAssignment = (
    groups: Array<{ orderItemId?: string; hotelName?: string; size?: number }>,
  ) => ({
    roomGroups: groups.map((g, i) => ({
      id: `g${i + 1}`,
      hotelName: g.hotelName ?? '美溪海滩酒店',
      roomType: '标间',
      passengerIds: Array.from({ length: g.size ?? 1 }, (_, j) => `p${i + 1}-${j + 1}`),
      ...(g.orderItemId ? { orderItemId: g.orderItemId } : {}),
    })),
  });

  it('两行分住 A/B 两店、房组各有归属 → 各酒店只记自己组的数（双算修复的回归锚）', () => {
    const order = {
      id: 'o1',
      roomAssignment: attributedAssignment([
        { orderItemId: 'item-a', hotelName: '酒店A' },
        { orderItemId: 'item-b', hotelName: '酒店B' },
      ]),
      passengers: [],
    };
    const itemA = {
      id: 'item-a',
      hotelCheckIn: day(0),
      hotelCheckOut: day(2),
      roomsBilled: 1,
      hotelRoomType: { hotel: { name: '酒店A' } },
      order,
    };
    const itemB = {
      id: 'item-b',
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      roomsBilled: 1,
      hotelRoomType: { hotel: { name: '酒店B' } },
      order,
    };
    // A 店只统计 A 店的行：只计归属 item-a 的那 1 组（旧口径会记整单 2 组 → 双算）
    const atA = expandAssignedPhysicalByDate([itemA], dates);
    expect(atA.assignedPhysical).toEqual([1, 1, 0]);
    expect(atA.fallbackItems).toEqual([]);
    // B 店同理，且区间按 B 行自己的住宿区间
    const atB = expandAssignedPhysicalByDate([itemB], dates);
    expect(atB.assignedPhysical).toEqual([1, 0, 0]);
    expect(atB.fallbackItems).toEqual([]);
  });

  it('无 orderItemId 的组按 hotelName 匹配归属；组都归属在别的行/别的酒店 → 本店记 0 且不进性别 fallback', () => {
    const order = {
      id: 'o1',
      roomAssignment: attributedAssignment([
        { orderItemId: 'item-a', hotelName: '酒店A' },
        { hotelName: '酒店A' }, // 无归属，按酒店名匹配到 A 店
      ]),
      passengers: [{ gender: 'M' as Gender }],
    };
    const itemA = {
      id: 'item-a',
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      roomsBilled: 2,
      hotelRoomType: { hotel: { name: '酒店A' } },
      order,
    };
    const itemB = {
      id: 'item-b',
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      roomsBilled: 1,
      hotelRoomType: { hotel: { name: '酒店B' } },
      order,
    };
    const atA = expandAssignedPhysicalByDate([itemA], dates);
    expect(atA.assignedPhysical).toEqual([2, 0, 0]); // 归属 1 + 按名匹配 1
    // B 店：组都在 A（按 id / 按名都不命中）→ 0，且绝不能落回性别推算（那正是双算）
    const atB = expandAssignedPhysicalByDate([itemB], dates);
    expect(atB.assignedPhysical).toEqual([0, 0, 0]);
    expect(atB.fallbackItems).toEqual([]);
  });

  it('旧数据（整单房组都无归属）→ 回退现行为：每家店都记整单数', () => {
    const order = { id: 'o1', roomAssignment: roomAssignmentOf([1, 1]), passengers: [] };
    const itemA = {
      id: 'item-a',
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      roomsBilled: 1,
      hotelRoomType: { hotel: { name: '酒店A' } },
      order,
    };
    expect(expandAssignedPhysicalByDate([itemA], dates).assignedPhysical).toEqual([2, 0, 0]);
  });

  it('调用方未升级（本批行不带 id）→ 即便房组带归属也回退整单口径，兼容旧调用', () => {
    const order = {
      id: 'o1',
      roomAssignment: attributedAssignment([{ orderItemId: 'item-a' }, { orderItemId: 'item-b' }]),
      passengers: [],
    };
    const legacyRow = { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 1, order };
    expect(expandAssignedPhysicalByDate([legacyRow], dates).assignedPhysical).toEqual([2, 0, 0]);
  });
});

describe('expandAssignedPhysicalByDate · roomFraction 求和再取整（拆单劈半不双算）', () => {
  const dates = [dayStr(0), dayStr(1)];
  /** 带 roomFraction / splitPairKey 的分房表。*/
  const fractionAssignment = (
    groups: Array<{ id: string; fraction?: number; splitPairKey?: string; roomType?: string }>,
  ) => ({
    roomGroups: groups.map((g) => ({
      id: g.id,
      hotelName: '美溪海滩酒店',
      roomType: g.roomType ?? '标间',
      passengerIds: [`${g.id}-p1`],
      ...(g.fraction != null ? { roomFraction: g.fraction } : {}),
      ...(g.splitPairKey ? { splitPairKey: g.splitPairKey } : {}),
    })),
  });

  it('拆单劈半：一间房变成两张单的两个 0.5 组 → 该日物理占用仍是 1 间（拆前拆后不变）', () => {
    const before = expandAssignedPhysicalByDate(
      [
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          order: { id: 'o1', roomAssignment: fractionAssignment([{ id: 'g1' }]), passengers: [] },
        },
      ],
      dates,
    );
    expect(before.assignedPhysical).toEqual([1, 0]);

    // 拆单后：源单留半间、新单半间，两侧写同一个 splitPairKey
    const after = expandAssignedPhysicalByDate(
      [
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 0.5,
          order: {
            id: 'o1',
            roomAssignment: fractionAssignment([
              { id: 'g1', fraction: 0.5, splitPairKey: 'g1:tok' },
            ]),
            passengers: [],
          },
        },
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 0.5,
          order: {
            id: 'o2',
            roomAssignment: fractionAssignment([
              { id: 'g1-split', fraction: 0.5, splitPairKey: 'g1:tok' },
            ]),
            passengers: [],
          },
        },
      ],
      dates,
    );
    expect(after.assignedPhysical).toEqual([1, 0]);
  });

  it('夫妻拼房被拆开（一男一女各半间，同 splitPairKey）→ 仍是 1 间（配对键不看性别）', () => {
    const res = expandAssignedPhysicalByDate(
      [
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 0.5,
          order: {
            id: 'o1',
            roomAssignment: fractionAssignment([
              { id: 'g1', fraction: 0.5, splitPairKey: 'g1:tok', roomType: '大床' },
            ]),
            passengers: [{ gender: 'M' as Gender }],
          },
        },
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 0.5,
          order: {
            id: 'o2',
            roomAssignment: fractionAssignment([
              // 拆出侧房型字段被改过也无所谓：配对键优先于房型桶
              { id: 'g1-split', fraction: 0.5, splitPairKey: 'g1:tok', roomType: '标间' },
            ]),
            passengers: [{ gender: 'F' as Gender }],
          },
        },
      ],
      dates,
    );
    expect(res.assignedPhysical).toEqual([1, 0]);
  });

  // 真拼房：两张不相干的单各出一位客人合住（分房接口允许运营手填 0.5），**没有**配对键。
  // 按房型合桶会把两个 0.5 加成 1.0 → 只占 1 间，可地接那边要给两张单各留一间 —— 少算一间。
  it('两张单各一个无配对键的 0.5 半组（同房型）→ 各占 1 间，共 2 间', () => {
    const res = expandAssignedPhysicalByDate(
      [
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 0.5,
          order: {
            id: 'o1',
            roomAssignment: fractionAssignment([{ id: 'g1', fraction: 0.5, roomType: '标间' }]),
            passengers: [],
          },
        },
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 0.5,
          order: {
            id: 'o2',
            roomAssignment: fractionAssignment([{ id: 'g2', fraction: 0.5, roomType: '标间' }]),
            passengers: [],
          },
        },
      ],
      dates,
    );
    expect(res.assignedPhysical).toEqual([2, 0]);
  });

  it('同一张单里两个无配对键的 0.5 半组（同房型）→ 同样各占 1 间', () => {
    const res = expandAssignedPhysicalByDate(
      [
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          order: {
            id: 'o1',
            roomAssignment: fractionAssignment([
              { id: 'g1', fraction: 0.5, roomType: '标间' },
              { id: 'g2', fraction: 0.5, roomType: '标间' },
            ]),
            passengers: [],
          },
        },
      ],
      dates,
    );
    expect(res.assignedPhysical).toEqual([2, 0]);
  });

  it('落单的半间组（配不上对）→ 仍向上取整成 1 间，绝不少算', () => {
    const res = expandAssignedPhysicalByDate(
      [
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 0.5,
          order: {
            id: 'o1',
            roomAssignment: fractionAssignment([{ id: 'g1', fraction: 0.5 }]),
            passengers: [],
          },
        },
      ],
      dates,
    );
    expect(res.assignedPhysical).toEqual([1, 0]);
  });

  it('整间组仍按整间计（缺省 roomFraction = 1，老数据行为不变）', () => {
    const res = expandAssignedPhysicalByDate(
      [
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 2,
          order: { id: 'o1', roomAssignment: roomAssignmentOf([2, 2]), passengers: [] },
        },
      ],
      dates,
    );
    expect(res.assignedPhysical).toEqual([2, 0]);
  });
});

describe('expandSplitPairedByDate · 无分房表侧按配对键配回整间', () => {
  const dates = [dayStr(0), dayStr(1)];

  it('两张单各半间、同 splitPairKey → 1 间；且不再进性别推算', () => {
    const rows = [
      {
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        roomsBilled: 0.5,
        metadata: { splitPairKey: 'ih:tok' },
        order: { id: 'o1', roomAssignment: null, passengers: [{ gender: 'M' as Gender }] },
      },
      {
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        roomsBilled: 0.5,
        metadata: { splitPairKey: 'ih:tok' },
        order: { id: 'o2', roomAssignment: null, passengers: [{ gender: 'F' as Gender }] },
      },
    ];
    const res = expandSplitPairedByDate(rows, dates);
    expect(res.pairedPhysical).toEqual([1, 0]);
    expect(res.remainingItems).toEqual([]);
  });

  it('没有配对键的行原样留给性别推算', () => {
    const row = {
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      roomsBilled: 0.5,
      metadata: null,
      order: { id: 'o1', roomAssignment: null, passengers: [{ gender: 'M' as Gender }] },
    };
    const res = expandSplitPairedByDate([row], dates);
    expect(res.pairedPhysical).toEqual([0, 0]);
    expect(res.remainingItems).toEqual([row]);
  });
});

describe('getBoard 权威分房表优先（物理口径）', () => {
  const rt = { hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } } };

  function boardClient(orderItems: unknown[], rooms = 10): PrismaClient {
    return {
      hotelBlockPeriod: {
        findMany: vi.fn().mockResolvedValue([
          {
            hotelId: 'h1',
            dateFrom: day(0),
            dateTo: day(2),
            rooms,
            unitPrice: null,
            hotel: { name: '美溪海滩酒店' },
          },
        ]),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue(orderItems) },
    } as unknown as PrismaClient;
  }

  it('运营反馈场景：一男一女各半间已分 2 房（roomsBilled 塌缩为 1.0）→ 物理 2、余 8、不标「拼」', async () => {
    const client = boardClient([
      {
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        roomsBilled: 1, // 分房保存把 Σ roomFraction(0.5+0.5) 塌缩写进首个酒店行
        order: {
          id: 'o1',
          roomAssignment: roomAssignmentOf([1, 1]), // 房间1 + 房间2
          passengers: [{ gender: 'M' }, { gender: 'F' }],
        },
        ...rt,
      },
    ]);
    const board = await getBoard({ from: dayStr(0), to: dayStr(0) }, client);
    const rows = board.hotels[0]!.rows;
    // 床位口径不变（roomsBilled=1.0）
    expect(rows.used).toEqual([1]);
    // 物理间数 = 分房表有乘客盒子数 = 2（不再按塌缩后的 roomsBilled 推算成 1）
    expect(rows.physicalUsed).toEqual([2]);
    expect(rows.physicalRemaining).toEqual([8]);
    // 已有完整分房表 → 不进拼房桶、不标「拼」
    expect(rows.sharedHalfCount).toEqual([0]);
    expect(rows.sharedUnpaired).toEqual([0]);
    expect(rows.sharedOdd).toEqual([false]);
  });

  it('分房表半间单不再按性别落单；无分房表 fallback 单维持原推算', async () => {
    const client = boardClient([
      // 有分房表的单：物理间数 = Σ roomFraction 向上取整（此处 1 组缺省 1 间）→ 1 间、不落单
      {
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        roomsBilled: 0.5,
        order: { id: 'o1', roomAssignment: roomAssignmentOf([1]), passengers: [{ gender: 'M' }] },
        ...rt,
      },
      // fallback 半间单（无分房表）：仍按性别推算，落单 1
      {
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        roomsBilled: 0.5,
        order: { id: 'o2', roomAssignment: null, passengers: [{ gender: 'F' }] },
        ...rt,
      },
    ]);
    const board = await getBoard({ from: dayStr(0), to: dayStr(0) }, client);
    const rows = board.hotels[0]!.rows;
    // 拼房口径只数 fallback 拼房客
    expect(rows.sharedHalfCount).toEqual([1]);
    expect(rows.sharedUnpaired).toEqual([1]);
    expect(rows.sharedOdd).toEqual([true]);
    // 物理 = 分房表 1 + fallback 落单 1 = 2
    expect(rows.physicalUsed).toEqual([2]);
    expect(rows.physicalRemaining).toEqual([8]);
  });

  it('fallback 回归：无分房表的同性两半间仍配成 1 间', async () => {
    const client = boardClient([
      {
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        roomsBilled: 0.5,
        order: { id: 'o1', roomAssignment: null, passengers: [{ gender: 'M' }] },
        ...rt,
      },
      {
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        roomsBilled: 0.5,
        order: { id: 'o2', passengers: [{ gender: 'M' }] }, // roomAssignment 字段缺省同样走 fallback
        ...rt,
      },
    ]);
    const board = await getBoard({ from: dayStr(0), to: dayStr(0) }, client);
    const rows = board.hotels[0]!.rows;
    expect(rows.used).toEqual([1]);
    expect(rows.physicalUsed).toEqual([1]);
    expect(rows.sharedUnpaired).toEqual([0]);
    expect(rows.physicalRemaining).toEqual([9]);
  });
});

describe('getHotelNightlyRemaining 权威分房表优先（物理口径）', () => {
  it('一男一女各半间已分 2 房（塌缩 roomsBilled=1.0，block=10）→ 床位余 9、物理余 8', async () => {
    const client = {
      hotelBlockPeriod: {
        findMany: vi.fn().mockResolvedValue([
          { hotelId: 'h1', dateFrom: day(0), dateTo: day(2), rooms: 10 },
        ]),
      },
      orderItem: {
        findMany: vi.fn().mockResolvedValue([
          {
            hotelCheckIn: day(0),
            hotelCheckOut: day(1),
            roomsBilled: 1,
            order: {
              id: 'o1',
              roomAssignment: roomAssignmentOf([1, 1]),
              passengers: [{ gender: 'M' }, { gender: 'F' }],
            },
          },
        ]),
      },
    } as unknown as PrismaClient;
    const res = await getHotelNightlyRemaining('h1', [dayStr(0)], client);
    expect(res.hasBlock).toBe(true);
    // 床位口径维持原值（10 - 1.0 = 9）
    expect(res.remaining).toEqual([9]);
    // 物理口径按分房表直计 2 间 → 10 - 2 = 8
    expect(res.physicalRemaining).toEqual([8]);
  });

  it('拆单劈半后两张单各半间（同 splitPairKey）→ 物理仍占 1 间，余量与拆前一致', async () => {
    const half = (orderId: string, groupId: string) => ({
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      roomsBilled: 0.5,
      metadata: { splitPairKey: 'ih:tok' },
      order: {
        id: orderId,
        roomAssignment: {
          roomGroups: [
            {
              id: groupId,
              hotelName: '美溪海滩酒店',
              roomType: '标间',
              passengerIds: [`${orderId}-p1`],
              roomFraction: 0.5,
              splitPairKey: 'g1:tok',
            },
          ],
        },
        passengers: [{ gender: orderId === 'o1' ? 'M' : 'F' }],
      },
    });
    const client = {
      hotelBlockPeriod: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ hotelId: 'h1', dateFrom: day(0), dateTo: day(2), rooms: 10 }]),
      },
      orderItem: {
        findMany: vi.fn().mockResolvedValue([half('o1', 'g1'), half('o2', 'g1-split')]),
      },
    } as unknown as PrismaClient;
    const res = await getHotelNightlyRemaining('h1', [dayStr(0)], client);
    // 床位口径 0.5 + 0.5 = 1.0；物理口径两个半间配回一间 → 10 - 1 = 9（拆前也是 9）
    expect(res.remaining).toEqual([9]);
    expect(res.physicalRemaining).toEqual([9]);
  });
});

describe('getOccupyingOrders', () => {
  function occupantsClient(items: unknown[]): PrismaClient {
    return {
      orderItem: { findMany: vi.fn().mockResolvedValue(items) },
    } as unknown as PrismaClient;
  }

  it('查询过滤：hotelId + 覆盖当晚 [hotelCheckIn<=date<hotelCheckOut] + COUNTED_STATUSES', async () => {
    const client = occupantsClient([]);
    await getOccupyingOrders('h9', '2026-08-01', client);
    const findMany = client.orderItem.findMany as unknown as ReturnType<typeof vi.fn>;
    const where = findMany.mock.calls[0][0].where;
    expect(where.hotelRoomTypeId).toEqual({ not: null });
    expect(where.hotelRoomType).toEqual({ hotelId: 'h9' });
    expect(where.hotelCheckIn).toEqual({ lte: new Date('2026-08-01T00:00:00.000Z') });
    expect(where.hotelCheckOut).toEqual({ gt: new Date('2026-08-01T00:00:00.000Z') });
    expect(where.order.status.in).toContain('PAID');
    expect(where.order.status.in).not.toContain('CANCELLED');
    expect(where.order.status.in).not.toContain('REFUND_REQUESTED');
  });

  it('返回订单/联系人/出行人姓名（中文名优先，无则回落护照名）/间数/入住区间/代理；占位联系人（documentNumber=N/A）不计入人数也不列名', async () => {
    const client = occupantsClient([
      {
        roomsBilled: 1,
        metadata: null,
        hotelCheckIn: day(0),
        hotelCheckOut: day(2),
        order: {
          id: 'o1',
          orderNumber: 'ST-0001',
          status: 'PAID',
          contactName: '张三',
          agent: { companyName: '成都国旅' },
          passengers: [
            { documentNumber: 'E1', chineseName: '张三', fullName: 'ZHANG/SAN' },
            { documentNumber: 'E2', chineseName: null, fullName: 'LI/SI' },
            { documentNumber: 'N/A', chineseName: null, fullName: '占位联系人' },
          ],
        },
      },
    ]);
    const occupants = await getOccupyingOrders('h1', dayStr(0), client);
    expect(occupants).toEqual([
      {
        orderId: 'o1',
        orderNumber: 'ST-0001',
        status: 'PAID',
        contactName: '张三',
        passengerCount: 2,
        passengerNames: ['张三', 'LI/SI'],
        rooms: 1,
        checkIn: dayStr(0),
        checkOut: dayStr(2),
        agentName: '成都国旅',
      },
    ]);
  });

  it('间数回落 metadata.roomsNeeded（roomsBilled 缺省）；无代理显示「直客」', async () => {
    const client = occupantsClient([
      {
        roomsBilled: null,
        metadata: { roomsNeeded: 3 },
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        order: {
          id: 'o2',
          orderNumber: 'ST-0002',
          status: 'TICKETED',
          contactName: '李四',
          agent: null,
          passengers: [{ documentNumber: 'E3', chineseName: '李四', fullName: 'LI/SI' }],
        },
      },
    ]);
    const occupants = await getOccupyingOrders('h1', dayStr(0), client);
    expect(occupants[0]!.rooms).toBe(3);
    expect(occupants[0]!.agentName).toBe('直客');
  });

  it('有权威分房表的订单：间数按有乘客的房间盒子数展示（覆盖被塌缩的 roomsBilled）', async () => {
    const client = occupantsClient([
      {
        roomsBilled: 1, // 分房保存塌缩后的床位数
        metadata: null,
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        order: {
          id: 'o9',
          orderNumber: 'ST-0009',
          status: 'PAID',
          contactName: '张三',
          agent: null,
          roomAssignment: roomAssignmentOf([1, 1]),
          passengers: [
            { documentNumber: 'E1', chineseName: null, fullName: 'ZHANG/SAN' },
            { documentNumber: 'E2', chineseName: null, fullName: 'LI/SI' },
          ],
        },
      },
    ]);
    const occupants = await getOccupyingOrders('h1', dayStr(0), client);
    expect(occupants[0]!.rooms).toBe(2);
  });

  it('同一酒店该晚多行占房（如两种房型）→ 逐行返回，不做订单级合并', async () => {
    const base = {
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      roomsBilled: 1,
      metadata: null,
      order: {
        id: 'o3',
        orderNumber: 'ST-0003',
        status: 'PAID',
        contactName: '王五',
        agent: null,
        passengers: [{ documentNumber: 'E4', chineseName: '王五', fullName: 'WANG/WU' }],
      },
    };
    const client = occupantsClient([base, { ...base, roomsBilled: 2 }]);
    const occupants = await getOccupyingOrders('h1', dayStr(0), client);
    expect(occupants).toHaveLength(2);
    expect(occupants.map((o) => o.rooms)).toEqual([1, 2]);
  });

  it('房组带归属：一单两店时每家明细只显示自己组的数（不再每行都记整单房组总数）', async () => {
    const order = {
      id: 'o5',
      orderNumber: 'ST-0005',
      status: 'PAID',
      contactName: '赵六',
      agent: null,
      roomAssignment: {
        roomGroups: [
          { id: 'g1', hotelName: '酒店A', roomType: '标间', passengerIds: ['p1'], orderItemId: 'item-a' },
          { id: 'g2', hotelName: '酒店B', roomType: '标间', passengerIds: ['p2'], orderItemId: 'item-b' },
        ],
      },
      passengers: [
        { documentNumber: 'E1', chineseName: null, fullName: 'ZHAO/LIU' },
        { documentNumber: 'E2', chineseName: null, fullName: 'QIAN/QI' },
      ],
    };
    // 酒店A 的下钻：只有 item-a 这行被选中（scopeItemWhere 按 hotelId 过滤）
    const client = occupantsClient([
      {
        id: 'item-a',
        roomsBilled: 2, // 分房保存前的旧塌缩值——归属口径必须压过它
        metadata: null,
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        hotelRoomType: { hotel: { name: '酒店A' } },
        order,
      },
    ]);
    const occupants = await getOccupyingOrders('h1', dayStr(0), client);
    // 旧口径 assignedPhysicalRooms 会显示整单 2 组；归属过滤后只显示归属本行的 1 组
    expect(occupants[0]!.rooms).toBe(1);
  });

  it('房组部分归属：本行 = 归属本行的组 + 无归属但酒店名匹配本行的组；组都在别行 → 0', async () => {
    const order = {
      id: 'o6',
      orderNumber: 'ST-0006',
      status: 'PAID',
      contactName: '孙七',
      agent: null,
      roomAssignment: {
        roomGroups: [
          { id: 'g1', hotelName: '酒店A', roomType: '标间', passengerIds: ['p1'], orderItemId: 'item-a' },
          { id: 'g2', hotelName: '酒店A', roomType: '标间', passengerIds: ['p2'] }, // 无归属，按名匹配 A
          { id: 'g3', hotelName: '酒店A', roomType: '标间', passengerIds: [] }, // 空盒子不计
        ],
      },
      passengers: [{ documentNumber: 'E1', chineseName: null, fullName: 'SUN/QI' }],
    };
    const rowA = {
      id: 'item-a',
      roomsBilled: 1,
      metadata: null,
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      hotelRoomType: { hotel: { name: '酒店A' } },
      order,
    };
    const rowB = {
      id: 'item-b',
      roomsBilled: 1,
      metadata: null,
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      hotelRoomType: { hotel: { name: '酒店B' } },
      order,
    };
    const atA = await getOccupyingOrders('h1', dayStr(0), occupantsClient([rowA]));
    expect(atA[0]!.rooms).toBe(2); // 归属 1 + 按名匹配 1
    // B 店行：组都归属在 A 行 / 名字也不匹配 → 0（真实占房就是 0，不能显示整单数）
    const atB = await getOccupyingOrders('h2', dayStr(0), occupantsClient([rowB]));
    expect(atB[0]!.rooms).toBe(0);
  });
});

describe('getNightlyRemainingForRoomType', () => {
  function roomTypeClient(opts: {
    hotelId: string | null;
    periods: unknown[];
    items: unknown[];
  }): PrismaClient {
    return {
      hotelRoomType: {
        findUnique: vi.fn().mockResolvedValue(opts.hotelId ? { hotelId: opts.hotelId } : null),
      },
      hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue(opts.periods) },
      orderItem: { findMany: vi.fn().mockResolvedValue(opts.items) },
    } as unknown as PrismaClient;
  }

  it('房型不存在 → 抛「房型不存在」', async () => {
    const client = roomTypeClient({ hotelId: null, periods: [], items: [] });
    await expect(
      getNightlyRemainingForRoomType('rt-missing', dayStr(0), dayStr(2), client),
    ).rejects.toThrow('房型不存在');
  });

  it('解出 hotelId 后复用 getHotelNightlyRemaining：2 晚、包房 3 间、首晚 1 间占用 → remaining [2,3]', async () => {
    const client = roomTypeClient({
      hotelId: 'h1',
      periods: [
        { hotelId: 'h1', dateFrom: day(0), dateTo: day(5), rooms: 3, unitPrice: null, hotel: { name: 'X' } },
      ],
      items: [
        { hotelCheckIn: day(0), hotelCheckOut: day(1), hotelRoomType: { hotelId: 'h1', hotel: { name: 'X' } } },
      ],
    });
    const result = await getNightlyRemainingForRoomType('rt1', dayStr(0), dayStr(2), client);
    expect(result.dates).toEqual([dayStr(0), dayStr(1)]);
    expect(result.hasBlock).toBe(true);
    expect(result.block).toEqual([3, 3]);
    expect(result.remaining).toEqual([2, 3]);
  });

  it('整段无包房周期 → hasBlock=false；dates 仍按 [checkIn,checkOut) 给出，remaining/block 为空数组', async () => {
    const client = roomTypeClient({ hotelId: 'h2', periods: [], items: [] });
    const result = await getNightlyRemainingForRoomType('rt2', dayStr(0), dayStr(3), client);
    expect(result.dates).toEqual([dayStr(0), dayStr(1), dayStr(2)]);
    expect(result.hasBlock).toBe(false);
    expect(result.remaining).toEqual([]);
    expect(result.block).toEqual([]);
  });
});

// ── 物理房间口径前瞻闸：checkHotelPhysicalFit / assertHotelPhysicalFit ──────────
/**
 * 卖货闸从「床位口径」切到「物理房间口径」后的核心保护网。
 *
 * 为什么不能拿 physicalRemaining >= rooms 直接比：一个**新**拼房客的物理增量是 0 还是 1，
 * 取决于当晚有没有可配对的同性落单——存量余量数字里根本看不出来。所以必须把人塞进
 * 性别桶后重算（前瞻闸）。下面的用例逐条钉死这件事。
 */
describe('checkHotelPhysicalFit（物理房间口径前瞻闸）', () => {
  function fitClient(orderItems: unknown[], rooms: number): PrismaClient {
    return {
      hotelBlockPeriod: {
        findMany: vi.fn().mockResolvedValue([{ hotelId: 'h1', dateFrom: day(0), dateTo: day(2), rooms }]),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue(orderItems) },
    } as unknown as PrismaClient;
  }
  /** n 位同性拼房客（各 roomsBilled=0.5，占 day0 当晚）。*/
  const solosOf = (gender: Gender, n: number) =>
    Array.from({ length: n }, () => ({
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      roomsBilled: 0.5,
      ...solo(gender),
    }));

  it('超卖路径：包房 20 间 + 已有 20男19女 拼房客 → 再来 1 位男（21男19女）需 21 间 → 拒；同一状态下来 1 位女（20男20女）需 20 间 → 放行', async () => {
    // 床位口径：Σ roomsBilled = 39×0.5 = 19.5 → 余 0.5 → 「还够卖半间」，两种性别都会被放行。
    // 物理口径：ceil(m/2)+ceil(f/2) —— 性别决定成败，这一维床位口径永远看不见。
    const client = fitClient([...solosOf('M', 20), ...solosOf('F', 19)], 20);

    const male = await checkHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 0, solos: ['M'] }, {}, client);
    // 21 男 → ceil(21/2)=11；19 女 → ceil(19/2)=10 → 共 21 间 > 包房 20 间
    expect(male.physicalUsedAfter).toEqual([21]);
    expect(male.violations).toHaveLength(1);
    expect(male.violations[0]).toMatchObject({ date: dayStr(0), block: 20, physicalUsed: 21, shortfall: 1 });

    const female = await checkHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 0, solos: ['F'] }, {}, client);
    // 20 男 → 10；20 女 → 10 → 共 20 间 == 包房 20 间 → 装得下
    expect(female.physicalUsedAfter).toEqual([20]);
    expect(female.violations).toEqual([]);
  });

  it('拆单劈半的两个半间不再各占一间 → 前瞻闸不再误拒新单（C1 回归锚）', async () => {
    // 场景：包房 1 间，已有一张 2 人单占满这 1 间；该单被拆单劈成两张单的两个半间。
    // 旧口径把两个半间数成 2 间 → 该晚「已占 2 间 > 包房 1 间」，随便来一笔操作都被判超卖。
    const half = (orderId: string, groupId: string) => ({
      id: `item-${orderId}`,
      hotelCheckIn: day(0),
      hotelCheckOut: day(1),
      roomsBilled: 0.5,
      metadata: { splitPairKey: 'ih:tok' },
      hotelRoomType: { hotel: { name: '美溪海滩酒店' } },
      order: {
        id: orderId,
        roomAssignment: {
          roomGroups: [
            {
              id: groupId,
              hotelName: '美溪海滩酒店',
              roomType: '标间',
              passengerIds: [`${orderId}-p1`],
              roomFraction: 0.5,
              splitPairKey: 'g1:tok',
              orderItemId: `item-${orderId}`,
            },
          ],
        },
        passengers: [{ gender: orderId === 'o1' ? 'M' : 'F' }],
      },
    });
    const client = fitClient([half('o1', 'g1'), half('o2', 'g1-split')], 1);
    const res = await checkHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 0, solos: [] }, {}, client);
    expect(res.physicalUsedBefore).toEqual([1]);
    expect(res.violations).toEqual([]);
    // 再来 1 间整间 → 2 间 > 包房 1 间 → 照常拒（闸没被放松，只是不再重复计）
    const oneMore = await checkHotelPhysicalFit(
      'h1',
      [dayStr(0)],
      { wholeRooms: 1, solos: [] },
      {},
      client,
    );
    expect(oneMore.physicalUsedAfter).toEqual([2]);
    expect(oneMore.violations).toHaveLength(1);
  });

  it('配对语义：physicalRemaining=0 但当晚有同性落单 → 同性拼房客增量 0 → 放行；异性 / 性别未知 → 增量 1 → 拒', async () => {
    // 包房 1 间 + 已有 1 位男拼房客 → physicalUsed=1 → physicalRemaining=0。
    // 「physicalRemaining >= rooms」这种比法会把三种情况**一律**拒掉——那是错的。
    const client = fitClient(solosOf('M', 1), 1);
    const at = async (g: 'M' | 'F' | 'U') =>
      checkHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 0, solos: [g] }, {}, client);

    const male = await at('M'); // 男+男 → ceil(2/2)=1 → 增量 0
    expect(male.physicalUsedBefore).toEqual([1]);
    expect(male.physicalUsedAfter).toEqual([1]);
    expect(male.violations).toEqual([]);

    const female = await at('F'); // 男+女不能拼 → 1+1=2 → 增量 1
    expect(female.physicalUsedAfter).toEqual([2]);
    expect(female.violations).toHaveLength(1);

    // 「拼单性别未知就把它单独出来」：不参与自动配对，保守独占 1 间
    const unknown = await at('U');
    expect(unknown.physicalUsedAfter).toEqual([2]);
    expect(unknown.violations).toHaveLength(1);
  });

  it('看板 8 / 系统别再卖第 9 间：block=10 一男一女各 1 位拼房客（床位余 9、物理余 8）→ 9 间整房单被拒、8 间放行', async () => {
    const client = fitClient(
      [
        { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...solo('M') },
        { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...solo('F') },
      ],
      10,
    );
    // 床位口径 used=1 → 余 9：旧闸会放行 9 间整房单（1+9=10 <= 10）——那正是超卖。
    const nine = await checkHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 9, solos: [] }, {}, client);
    expect(nine.physicalUsedAfter).toEqual([11]); // 异性各占 1 间 = 2，+9 = 11 > 10
    expect(nine.violations).toHaveLength(1);

    const eight = await checkHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 8, solos: [] }, {}, client);
    expect(eight.physicalUsedAfter).toEqual([10]);
    expect(eight.violations).toEqual([]);
  });

  it('未配包房周期 → hasBlock=false，不拦截（房控哲学：未配包房 ≠ 售罄）', async () => {
    const client = {
      hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue([]) },
      orderItem: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    const fit = await checkHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 99, solos: [] }, {}, client);
    expect(fit.hasBlock).toBe(false);
    expect(fit.violations).toEqual([]);
    await expect(
      assertHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 99, solos: [] }, {}, client),
    ).resolves.toEqual([]);
  });

  it('excludeOrderId 透传到查询：改存量单时排除该单自身既有占房，避免算两遍', async () => {
    const client = fitClient([], 5);
    await checkHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 1, solos: [] }, { excludeOrderId: 'o9' }, client);
    const where = (client.orderItem.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.order.id).toEqual({ not: 'o9' });
  });

  it('excludeOrderItemIds（行级排除）：只排指定行、不排整单 —— 同单另一行在目标酒店的占用照常计入', async () => {
    const client = fitClient([], 5);
    await checkHotelPhysicalFit(
      'h1',
      [dayStr(0)],
      { wholeRooms: 1, solos: [] },
      { excludeOrderItemIds: ['item-swap'] },
      client,
    );
    const where = (client.orderItem.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.id).toEqual({ notIn: ['item-swap'] });
    // 关键差异：订单级排除**不**出现 —— 同单其它行的真实占用不再被误排（旧口径放行超卖）
    expect(where.order.id).toBeUndefined();
  });

  it('excludeOrderItemIds 语义：同单另一行占掉最后 1 间 → 换酒店挪 1 间进来被拒（整单排除法会误放行）', async () => {
    // 包房 1 间；目标酒店已有「同一订单的另一条行」占 1 整间（无分房表 → 床位口径直计）。
    const client = fitClient(
      [
        {
          id: 'item-other',
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          order: { id: 'o1', roomAssignment: null, passengers: [] },
        },
      ],
      1,
    );
    const fit = await checkHotelPhysicalFit(
      'h1',
      [dayStr(0)],
      { wholeRooms: 1, solos: [] },
      { excludeOrderItemIds: ['item-swap'] },
      client,
    );
    // 1（另一行存量）+ 1（挪进来）= 2 > 包房 1 → 拒。excludeOrderId: 'o1' 的旧口径会把
    // 存量排掉 → 1 <= 1 误放行 —— 这正是行级排除要修的超卖口子。
    expect(fit.physicalUsedAfter).toEqual([2]);
    expect(fit.violations).toHaveLength(1);
  });

  it('归属过滤走进前瞻闸：同单房组分住两店，目标店只计归属到目标店行的组', async () => {
    // 订单 o1 有两行：item-b 在目标酒店 h1（归属 1 组）；item-a 在别的酒店（归属 1 组）。
    // 目标店存量应只算 item-b 的 1 间，而不是整单 2 间。
    const order = {
      id: 'o1',
      roomAssignment: {
        roomGroups: [
          { id: 'g1', hotelName: '酒店A', roomType: '标间', passengerIds: ['p1'], orderItemId: 'item-a' },
          { id: 'g2', hotelName: '酒店B', roomType: '标间', passengerIds: ['p2'], orderItemId: 'item-b' },
        ],
      },
      passengers: [],
    };
    const client = fitClient(
      [
        {
          id: 'item-b',
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          hotelRoomType: { hotel: { name: '酒店B' } },
          order,
        },
      ],
      2,
    );
    const fit = await checkHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 1, solos: [] }, {}, client);
    // 存量 1（仅 g2）+ 新增 1 = 2 <= 包房 2 → 放行；整单口径会算存量 2 → 3 > 2 误拒
    expect(fit.physicalUsedBefore).toEqual([1]);
    expect(fit.physicalUsedAfter).toEqual([2]);
    expect(fit.violations).toEqual([]);
  });

  it('assertHotelPhysicalFit：装不下抛 BadRequestError；allowNonWorsening 放行「改完不比改前差」的重排', async () => {
    // 包房 1 间，已有 2 位性别未知拼房客（各独占 1 间）→ 存量已物理超卖（need 2 > block 1）
    const client = fitClient(solosOf('X' as Gender, 2), 1);
    // 新增占房 → 更差 → 必须拒
    await expect(
      assertHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 1, solos: [] }, {}, client),
    ).rejects.toThrow(/房间不足/);
    // 不新增占房（重排）→ after == before → allowNonWorsening 放行，运营才能去补救存量超卖
    await expect(
      assertHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 0, solos: [] }, { allowNonWorsening: true }, client),
    ).resolves.toEqual([]);
  });

  // ── 限额内超售放行（内部录单口子）：销控售罄后运营仍可录单，当天临时向酒店加房是常态业务 ──
  it('maxOversellRooms：累计缺口 ≤ 上限 → 放行并返回被容忍的超卖明细（供调用方写 WARNING 审计）', async () => {
    // 包房 2 间、要录 3 间 → 缺口 1 ≤ 上限 3 → 放行，销控板显示 -1
    const client = fitClient([], 2);
    const tolerated = await assertHotelPhysicalFit(
      'h1',
      [dayStr(0)],
      { wholeRooms: 3, solos: [] },
      { maxOversellRooms: 3 },
      client,
    );
    expect(tolerated).toHaveLength(1);
    expect(tolerated[0]).toMatchObject({ date: dayStr(0), block: 2, physicalUsed: 3, shortfall: 1 });
  });

  it('maxOversellRooms：任一晚累计缺口超上限 → 仍拒（防手滑大团录错日期一次打穿），文案点名上限', async () => {
    const client = fitClient([], 2);
    await expect(
      assertHotelPhysicalFit(
        'h1',
        [dayStr(0)],
        { wholeRooms: 6, solos: [] }, // 缺口 4 > 上限 3
        { maxOversellRooms: 3 },
        client,
      ),
    ).rejects.toThrow(/超售容忍上限 3 间/);
  });

  it('maxOversellRooms 缺省（前台散客/代理下单）→ 缺口 1 间也硬拒，口子只对内部录单开', async () => {
    const client = fitClient([], 2);
    await expect(
      assertHotelPhysicalFit('h1', [dayStr(0)], { wholeRooms: 3, solos: [] }, {}, client),
    ).rejects.toThrow(/房间不足/);
  });
});

// ── 事务内互斥版前瞻闸：assertHotelPhysicalFitWithinTx ─────────────────────────
/**
 * 只读闸拦不住并发：两个请求同时抢最后 1 间，各自读到的都是「还剩 1 间」的旧快照，
 * 双双通过、双双落库 —— 账面直接超卖。互斥的唯一正解是让它们在数据库里排队，
 * 所以事务内版本必须先对该酒店该区间的包房周期行 FOR UPDATE 加锁，再跑判定。
 *
 * 这些用例钉的是「锁真的发出去了、且在读之前发」——把 lockHotelBlockPeriodsWithinTx
 * 那一行删掉，下面两条会红。
 */
describe('assertHotelPhysicalFitWithinTx（事务内加锁版前瞻闸）', () => {
  /** 假 tx：$queryRaw 记录被 tag 的 SQL 片段与参数，两个 findMany 复用具体酒店闸的口径。*/
  function fakeTx(orderItems: unknown[], rooms: number) {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const tx = {
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?'), values });
        return Promise.resolve([]);
      }),
      hotelBlockPeriod: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ hotelId: 'h1', dateFrom: day(0), dateTo: day(2), rooms }]),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue(orderItems) },
    };
    return { tx, calls };
  }

  type TxArg = Parameters<typeof assertHotelPhysicalFitWithinTx>[0];

  it('判定之前先对包房周期行 FOR UPDATE 加锁（并发下单在此串行）', async () => {
    const { tx, calls } = fakeTx([], 10);
    await assertHotelPhysicalFitWithinTx(
      tx as unknown as TxArg,
      'h1',
      [dayStr(0), dayStr(1)],
      { wholeRooms: 1, solos: [] },
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('"HotelBlockPeriod"');
    expect(sql).toContain('FOR UPDATE');
    // 按 id 排序加锁：两个事务锁同一批行的顺序一致，不会互相死锁
    expect(sql).toContain('ORDER BY id');
    // 锁的是本酒店 + 本次入住区间（首晚 ~ 末晚），不是全表
    expect(calls[0].values[0]).toBe('h1');
    // 锁必须发生在读占房之前 —— 先读后锁等于没锁
    const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0];
    const readOrder = tx.orderItem.findMany.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(readOrder);
  });

  it('拿的是同一把判定尺子：装不下照样抛「房间不足」（口径与非事务版一字不差）', async () => {
    // 包房 1 间 + 已有 1 位男拼房客 → 再来 1 间整房 → 需 2 间 > 1
    const { tx } = fakeTx(
      [{ hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...solo('M') }],
      1,
    );
    await expect(
      assertHotelPhysicalFitWithinTx(tx as unknown as TxArg, 'h1', [dayStr(0)], {
        wholeRooms: 1,
        solos: [],
      }),
    ).rejects.toThrow(/房间不足/);
    // 拒绝路径上锁一样要加过（否则并发下「都装得下」的判定仍是脏读）
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('空 nightDates（无入住区间）→ 不发锁也不判定，安静返回', async () => {
    const { tx } = fakeTx([], 1);
    await expect(
      lockHotelBlockPeriodsWithinTx(tx as unknown as TxArg, 'h1', []),
    ).resolves.toBeUndefined();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

// ── getRecentRoomChanges（近期用房变更；读审计流）──────────────────────────
describe('getRecentRoomChanges', () => {
  /** 造一条审计日志行（形状同 AuditLog.findMany 的 select 结果）。*/
  const auditRow = (over: Partial<Record<string, unknown>>): Record<string, unknown> => ({
    id: 'a1',
    action: 'UPDATE_ROOM_ASSIGNMENT',
    targetId: 'o1',
    targetLabel: 'CO250722001',
    before: null,
    after: null,
    severity: 'INFO',
    createdAt: day(0),
    actorLabel: null,
    actorRole: 'STAFF',
    actor: null,
    ...over,
  });

  function auditClient(
    rows: Array<Record<string, unknown>>,
    orderRows: Array<Record<string, unknown>> = [],
  ): {
    client: PrismaClient;
    findMany: ReturnType<typeof vi.fn>;
    orderFindMany: ReturnType<typeof vi.fn>;
  } {
    const findMany = vi.fn().mockResolvedValue(rows);
    const orderFindMany = vi.fn().mockResolvedValue(orderRows);
    return {
      client: { auditLog: { findMany }, order: { findMany: orderFindMany } } as unknown as PrismaClient,
      findMany,
      orderFindMany,
    };
  }

  it('查询口径：五类 action + createdAt>=近 N 天 + 倒序 + 上限 100', async () => {
    const { client, findMany } = auditClient([]);
    const res = await getRecentRoomChanges(7, client);

    expect(res).toEqual({ days: 7, count: 0, changes: [] });
    const arg = findMany.mock.calls[0][0];
    expect(arg.where.action).toEqual({
      in: [
        'UPDATE_ROOM_ASSIGNMENT',
        'SWAP_ORDER_ITEM_HOTEL',
        'ADD_ROOM_SUPPLEMENT',
        'RESCHEDULE_ORDER_ITEM',
        // 酒店改期直接改动逐晚占房（挪住宿区间），房控面板必须看得见
        'RESCHEDULE_ORDER_ITEM_HOTEL',
      ],
    });
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.take).toBe(100);
    // createdAt.gte ≈ 今天 -7 天（容忍执行耗时的小漂移）
    const since = arg.where.createdAt.gte as Date;
    const expectedMs = Date.now() - 7 * DAY_MS;
    expect(Math.abs(since.getTime() - expectedMs)).toBeLessThan(5000);
  });

  it('调整分房：计费房数 X→Y 摘要', async () => {
    const { client } = auditClient([
      auditRow({
        action: 'UPDATE_ROOM_ASSIGNMENT',
        before: { roomsBilled: 2 },
        after: { roomsBilled: 3 },
      }),
    ]);
    const res = await getRecentRoomChanges(7, client);
    expect(res.changes[0]).toMatchObject({
      action: 'UPDATE_ROOM_ASSIGNMENT',
      actionLabel: '调整分房',
      orderId: 'o1',
      orderNumber: 'CO250722001',
      summary: '计费房数 2 → 3 间',
    });
    // ISO8601 时间串
    expect(res.changes[0].at).toBe(day(0).toISOString());
  });

  it('换酒店：原酒店·房型 → 新酒店·房型 摘要', async () => {
    const { client } = auditClient([
      auditRow({
        action: 'SWAP_ORDER_ITEM_HOTEL',
        severity: 'WARNING',
        before: { hotelName: '美溪海滩酒店', roomTypeName: '海景房' },
        after: { hotelName: '珊瑚湾酒店', roomTypeName: '花园房' },
      }),
    ]);
    const res = await getRecentRoomChanges(7, client);
    expect(res.changes[0]).toMatchObject({
      actionLabel: '换酒店',
      summary: '换酒店 美溪海滩酒店·海景房 → 珊瑚湾酒店·花园房',
      severity: 'WARNING',
    });
  });

  it('补收单房差：单价×晚数=金额 摘要', async () => {
    const { client } = auditClient([
      auditRow({
        action: 'ADD_ROOM_SUPPLEMENT',
        after: { perNightCny: 300, nights: 2, amountCny: 600 },
      }),
    ]);
    const res = await getRecentRoomChanges(7, client);
    expect(res.changes[0]).toMatchObject({
      actionLabel: '补收单房差',
      summary: '补收单房差 300元 × 2 晚 = 600 元',
    });
  });

  it('操作人：优先 displayName → email → actorLabel → 角色', async () => {
    const { client } = auditClient([
      auditRow({ id: 'a1', actor: { displayName: '运营小组A', email: 'ops@x.com' } }),
      auditRow({ id: 'a2', actor: { displayName: null, email: 'ops@x.com' } }),
      auditRow({ id: 'a3', actor: null, actorLabel: 'label-only' }),
      auditRow({ id: 'a4', actor: null, actorLabel: null, actorRole: 'ADMIN' }),
    ]);
    const res = await getRecentRoomChanges(7, client);
    expect(res.changes.map((c) => c.actor)).toEqual([
      '运营小组A',
      'ops@x.com',
      'label-only',
      'ADMIN',
    ]);
  });

  it('缺字段降级：before/after 缺关键字段时退回中性摘要，不抛错', async () => {
    const { client } = auditClient([
      auditRow({ action: 'UPDATE_ROOM_ASSIGNMENT', before: null, after: null }),
      auditRow({ id: 'a2', action: 'SWAP_ORDER_ITEM_HOTEL', before: null, after: null }),
      auditRow({ id: 'a3', action: 'ADD_ROOM_SUPPLEMENT', before: null, after: null }),
    ]);
    const res = await getRecentRoomChanges(7, client);
    expect(res.count).toBe(3);
    expect(res.changes.map((c) => c.summary)).toEqual([
      '分房调整',
      '换酒店 原酒店 → 新酒店',
      '补收单房差',
    ]);
  });

  it('改期纳入动作集：actionLabel「改期」，摘要读 before/after.departure 简述新旧出发日', async () => {
    const { client, orderFindMany } = auditClient([
      auditRow({
        action: 'RESCHEDULE_ORDER_ITEM',
        before: { orderItemId: 'oi1', scheduleId: 's1', departure: '2026-08-01T03:00:00.000Z' },
        after: { scheduleId: 's2', departure: '2026-08-05T03:00:00.000Z', feeCny: 200 },
      }),
    ]);
    const res = await getRecentRoomChanges(7, client);
    expect(res.changes[0]).toMatchObject({
      action: 'RESCHEDULE_ORDER_ITEM',
      actionLabel: '改期',
      summary: '改期 2026-08-01 → 2026-08-05',
    });
    // 按 orderId 去重批量查订单
    expect(orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['o1'] } } }),
    );
  });

  it('批量补充乘客/出行日期/订单金额：命中订单时按 FLIGHT 行出发时间升序取去程/回程', async () => {
    const { client } = auditClient(
      [auditRow({ id: 'a1', targetId: 'o1' }), auditRow({ id: 'a2', targetId: 'o1' })],
      [
        {
          id: 'o1',
          total: 3980,
          passengers: [
            { documentNumber: 'E12345678', chineseName: '王小明', fullName: 'WANG/XIAOMING' },
            { documentNumber: 'N/A', chineseName: null, fullName: '占位联系人' }, // 占位联系人不列入
          ],
          items: [
            {
              flightSchedule: {
                departureTime: new Date('2026-08-10T02:00:00.000Z'),
                departureTz: 'Asia/Shanghai',
              },
            },
            {
              flightSchedule: {
                departureTime: new Date('2026-08-15T02:00:00.000Z'),
                departureTz: 'Asia/Shanghai',
              },
            },
          ],
        },
      ],
    );
    const res = await getRecentRoomChanges(7, client);
    // 两条 audit 行同指向 o1，各自都拿到同一份订单信息（不因去重批量查而漏填）
    for (const change of res.changes) {
      expect(change).toMatchObject({
        passengerNames: ['王小明'],
        departDate: '2026-08-10',
        returnDate: '2026-08-15',
        orderAmountCny: 3980,
      });
    }
  });

  it('订单查不到（软删/id 失效）：新字段容错置 null/[]，不抛错', async () => {
    const { client } = auditClient([auditRow({ targetId: 'o-gone' })], []);
    const res = await getRecentRoomChanges(7, client);
    expect(res.changes[0]).toMatchObject({
      passengerNames: [],
      departDate: null,
      returnDate: null,
      orderAmountCny: null,
    });
  });
});

// ── 星级随机档（三星随机 / 四星随机）─────────────────────────────────────────
/**
 * 随机档**不是**单独切的库存池，而是同星级酒店库存的派生聚合：
 *   随机N星余量(d) = Σ(starRating=N 且非国际五星的酒店当晚余量) − 当晚未落位随机单占用
 * 核心不变量（下面逐条钉死）：
 *   1. 卖具体酒店 → 随机档合计随之少；卖随机 → 合计少；
 *   2. 把随机单落位到具体酒店 → 该酒店用房 +1、未落位 −1 ⇒ **合计不变**（对账恒等）；
 *   3. 国际五星不进聚合；存量的随机档周期一律不计入任何读路径。
 */
describe('星级随机档：销控板聚合组', () => {
  function poolBoardClient(periods: unknown[], items: unknown[]): PrismaClient {
    return {
      hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue(periods) },
      orderItem: { findMany: vi.fn().mockResolvedValue(items) },
    } as unknown as PrismaClient;
  }
  /** 具体酒店的包房周期 fixture（hotel 关联带星级，供聚合分组）。*/
  const hotelPeriod = (
    hotelId: string,
    name: string,
    starRating: number,
    rooms: number,
    over: Record<string, unknown> = {},
  ) => ({
    hotelId,
    randomStarTier: null,
    dateFrom: day(0),
    dateTo: day(2),
    rooms,
    unitPrice: null,
    hotel: { name, starRating, intlFiveStar: false },
    ...over,
  });
  /** 已落到具体酒店的占房行 fixture。*/
  const hotelItem = (
    hotelId: string,
    name: string,
    starRating: number,
    over: Record<string, unknown> = {},
  ) => ({
    hotelCheckIn: day(0),
    hotelCheckOut: day(1),
    randomStarTier: null,
    hotelRoomType: { hotelId, hotel: { name, starRating, intlFiveStar: false } },
    ...over,
  });
  /** 未落位随机单 fixture：无房型（hotelRoomType 为 null）、randomStarTier 非空。*/
  const pendingItem = (tier: number, over: Record<string, unknown> = {}) => ({
    hotelCheckIn: day(0),
    hotelCheckOut: day(1),
    hotelRoomType: null,
    randomStarTier: tier,
    ...over,
  });

  it('包房 = 同星级酒店合计；用房 = 未落位随机单；余量 = 同星级余量合计 − 未落位', async () => {
    const client = poolBoardClient(
      [hotelPeriod('h1', '明月酒店', 3, 5), hotelPeriod('h2', '海棠酒店', 3, 4)],
      [pendingItem(3), pendingItem(3)],
    );
    const board = await getBoard({ from: dayStr(0), to: dayStr(1) }, client);
    const tier = board.hotels.find((h) => h.randomStarTier === 3)!;
    expect(tier).toMatchObject({ hotelId: 'random-star-3', hotelName: '三星随机', unitPrice: null });
    // 聚合组排在最前，房控一眼先看「随机还剩多少」
    expect(board.hotels[0].hotelId).toBe('random-star-3');
    expect(tier.rows.block).toEqual([9, 9]);
    expect(tier.rows.used).toEqual([2, 0]);
    expect(tier.rows.remaining).toEqual([7, 9]);
  });

  it('卖具体酒店 → 随机档合计随之少（不再是"互不扣减"的第二本账）', async () => {
    const client = poolBoardClient(
      [hotelPeriod('h1', '明月酒店', 3, 5)],
      [hotelItem('h1', '明月酒店', 3), hotelItem('h1', '明月酒店', 3)],
    );
    const board = await getBoard({ from: dayStr(0), to: dayStr(0) }, client);
    const hotel = board.hotels.find((h) => h.hotelId === 'h1')!;
    const tier = board.hotels.find((h) => h.randomStarTier === 3)!;
    expect(hotel.rows.remaining).toEqual([3]);
    // 该酒店卖掉 2 间 → 三星随机也只剩 3
    expect(tier.rows.block).toEqual([5]);
    expect(tier.rows.used).toEqual([0]);
    expect(tier.rows.remaining).toEqual([3]);
  });

  it('对账恒等：把随机单落位到具体酒店，随机档合计余量不变', async () => {
    const before = await getBoard(
      { from: dayStr(0), to: dayStr(0) },
      poolBoardClient([hotelPeriod('h1', '明月酒店', 4, 6)], [pendingItem(4), pendingItem(4)]),
    );
    // 落位 = 其中一行写上 hotelRoomTypeId、清掉 randomStarTier（换酒店流程做的事）
    const after = await getBoard(
      { from: dayStr(0), to: dayStr(0) },
      poolBoardClient(
        [hotelPeriod('h1', '明月酒店', 4, 6)],
        [pendingItem(4), hotelItem('h1', '明月酒店', 4)],
      ),
    );
    const tierOf = (b: typeof before) => b.hotels.find((h) => h.randomStarTier === 4)!;
    expect(tierOf(before).rows.remaining).toEqual([4]);
    // 该酒店用房 +1、未落位 −1 → 合计原地不动
    expect(tierOf(after).rows.remaining).toEqual([4]);
    expect(tierOf(after).rows.used).toEqual([1]);
    expect(after.hotels.find((h) => h.hotelId === 'h1')!.rows.used).toEqual([1]);
  });

  it('国际五星不进聚合；星级不匹配的酒店也不进', async () => {
    const client = poolBoardClient(
      [
        hotelPeriod('h1', '明月酒店', 4, 5),
        // 国际五星（starRating 4 只是为了钉死"看 intlFiveStar 而不是只看星级"这条排除）
        hotelPeriod('h2', '洲际酒店', 4, 8, { hotel: { name: '洲际酒店', starRating: 4, intlFiveStar: true } }),
        hotelPeriod('h3', '快捷酒店', 2, 9),
      ],
      [],
    );
    const board = await getBoard({ from: dayStr(0), to: dayStr(0) }, client);
    const tier4 = board.hotels.find((h) => h.randomStarTier === 4)!;
    expect(tier4.rows.block).toEqual([5]); // 只有明月的 5 间，洲际/快捷都不算
    expect(board.hotels.some((h) => h.randomStarTier === 2)).toBe(false);
  });

  it('存量的随机档周期不计入任何余量（数据保留，读路径不认）', async () => {
    const client = poolBoardClient(
      [
        hotelPeriod('h1', '明月酒店', 3, 5),
        // 历史遗留的池周期：hotelId 为 null、randomStarTier 非空
        { hotelId: null, randomStarTier: 3, dateFrom: day(0), dateTo: day(2), rooms: 99, unitPrice: 480, hotel: null },
      ],
      [],
    );
    const board = await getBoard({ from: dayStr(0), to: dayStr(0) }, client);
    const tier = board.hotels.find((h) => h.randomStarTier === 3)!;
    expect(tier.rows.block).toEqual([5]); // 存量池的 99 间没进来
    expect(tier.rows.remaining).toEqual([5]);
  });

  it('聚合组照吃「异性不能拼一间」的物理口径：未落位的一男一女各半间 → 物理占 2 间', async () => {
    const client = poolBoardClient(
      [hotelPeriod('h1', '明月酒店', 3, 2)],
      [
        pendingItem(3, { roomsBilled: 0.5, ...solo('M') }),
        pendingItem(3, { roomsBilled: 0.5, ...solo('F') }),
      ],
    );
    const board = await getBoard({ from: dayStr(0), to: dayStr(0) }, client);
    const tier = board.hotels.find((h) => h.randomStarTier === 3)!;
    expect(tier.rows.used).toEqual([1]); // 床位口径 0.5+0.5
    expect(tier.rows.physicalUsed).toEqual([2]); // 物理口径：异性各独占
    expect(tier.rows.remaining).toEqual([1]); // 床位余量：2 − 1
    expect(tier.rows.physicalRemaining).toEqual([0]); // 物理余量：2 − 2
  });

  it('聚合余量 < 0 进超卖提醒（缺口取 −余量）；富余提醒跳过聚合组不重复推送', async () => {
    const client = {
      ...poolBoardClient(
        [hotelPeriod('h1', '明月酒店', 3, 1)],
        [pendingItem(3), pendingItem(3)],
      ),
      flightSchedule: { findMany: vi.fn().mockResolvedValue([]) },
      passenger: { count: vi.fn() },
    } as unknown as PrismaClient;
    const alerts = await getAlerts(2, client);
    const tierOversold = alerts.oversold.find((o) => o.hotelName === '三星随机')!;
    expect(tierOversold).toMatchObject({ date: dayStr(0), block: 1, used: 2, deficit: 1 });
    // 次日：明月还剩 1 间富余 → 只报明月，不报「三星随机」
    expect(alerts.surplusSoon.some((s) => s.hotelName === '三星随机')).toBe(false);
    expect(alerts.surplusSoon.some((s) => s.hotelName === '明月酒店')).toBe(true);
  });

  // ── 占位酒店（早期用假酒店承载随机档留下的形态）──────────────────────────
  /**
   * 占位酒店 = Hotel.randomTierPlaceholder 非空。它不是真房源：
   *   1. 不作为酒店组出现在销控板上（否则板面会既有「随机三星」酒店组又有同名聚合组）；
   *   2. 名下的切房周期不计入包房（否则与同星级真酒店的库存双记一笔账）；
   *   3. 落在它房型上的订单行 = **未落位**占用，计进该档次聚合组的用房；
   *   4. 把它落位到真酒店 → 该酒店用房 +1、未落位 −1 ⇒ 聚合合计不变（对账恒等照样成立）。
   * 判定一律看该列，绝不按酒店名字匹配。
   */
  /** 占位酒店的切房周期 fixture（存量数据，读路径一律不认）。*/
  const placeholderPeriod = (
    hotelId: string,
    name: string,
    tier: number,
    rooms: number,
  ) =>
    hotelPeriod(hotelId, name, tier, rooms, {
      hotel: { name, starRating: tier, intlFiveStar: false, randomTierPlaceholder: tier },
    });
  /** 伪落位行：房型挂在占位酒店上（业务上还没落到任何真酒店）。*/
  const placeholderItem = (
    hotelId: string,
    name: string,
    tier: number,
    over: Record<string, unknown> = {},
  ) =>
    hotelItem(hotelId, name, tier, {
      hotelRoomType: {
        hotelId,
        hotel: { name, starRating: tier, intlFiveStar: false, randomTierPlaceholder: tier },
      },
      ...over,
    });

  it('占位酒店不作为酒店组出现，名下切房周期一律不计入包房', async () => {
    const client = poolBoardClient(
      [
        hotelPeriod('h1', '明月酒店', 3, 5),
        placeholderPeriod('ph3', '随机三星', 3, 20),
      ],
      [],
    );
    const board = await getBoard({ from: dayStr(0), to: dayStr(0) }, client);
    expect(board.hotels.some((h) => h.hotelId === 'ph3')).toBe(false);
    const tier = board.hotels.find((h) => h.randomStarTier === 3)!;
    expect(tier.rows.block).toEqual([5]); // 占位项的 20 间没进来
    expect(tier.rows.remaining).toEqual([5]);
  });

  it('落在占位酒店房型上的订单行算「未落位」，计进聚合组的用房', async () => {
    const client = poolBoardClient(
      [hotelPeriod('h1', '明月酒店', 3, 5), placeholderPeriod('ph3', '随机三星', 3, 20)],
      [placeholderItem('ph3', '随机三星', 3), pendingItem(3)],
    );
    const board = await getBoard({ from: dayStr(0), to: dayStr(0) }, client);
    const tier = board.hotels.find((h) => h.randomStarTier === 3)!;
    // 伪落位 1 间 + 正规未落位随机单 1 间，两类同吃「未落位」这一行
    expect(tier.rows.used).toEqual([2]);
    expect(tier.rows.remaining).toEqual([3]);
    // 占位项没有自己的酒店行，那 1 间不会在别处被重复计一笔
    expect(board.hotels.filter((h) => h.rows.used[0] > 0)).toHaveLength(1);
  });

  it('对账恒等：把伪落位行落到真酒店，随机档合计余量不变', async () => {
    const periods = [hotelPeriod('h1', '明月酒店', 4, 6), placeholderPeriod('ph4', '随机四星', 4, 40)];
    const before = await getBoard(
      { from: dayStr(0), to: dayStr(0) },
      poolBoardClient(periods, [placeholderItem('ph4', '随机四星', 4)]),
    );
    const after = await getBoard(
      { from: dayStr(0), to: dayStr(0) },
      poolBoardClient(periods, [hotelItem('h1', '明月酒店', 4)]),
    );
    const tierOf = (b: typeof before) => b.hotels.find((h) => h.randomStarTier === 4)!;
    expect(tierOf(before).rows.remaining).toEqual([5]);
    expect(tierOf(after).rows.remaining).toEqual([5]); // 合计原地不动
    // 用房从「未落位」转到明月名下
    expect(tierOf(before).rows.used).toEqual([1]);
    expect(tierOf(after).rows.used).toEqual([0]);
    expect(after.hotels.find((h) => h.hotelId === 'h1')!.rows.used).toEqual([1]);
  });

  it('五星随机聚合组成立，但国际五星仍被排除在合计外', async () => {
    const client = poolBoardClient(
      [
        hotelPeriod('h1', '棕榈五星', 5, 7),
        hotelPeriod('h2', '洲际酒店', 5, 30, {
          hotel: { name: '洲际酒店', starRating: 5, intlFiveStar: true, randomTierPlaceholder: null },
        }),
        placeholderPeriod('ph5', '随机五星', 5, 50),
      ],
      [placeholderItem('ph5', '随机五星', 5)],
    );
    const board = await getBoard({ from: dayStr(0), to: dayStr(0) }, client);
    const tier5 = board.hotels.find((h) => h.randomStarTier === 5)!;
    expect(tier5.hotelName).toBe('五星随机');
    expect(tier5.rows.block).toEqual([7]); // 只有棕榈的 7 间：国际五星与占位项都不算
    expect(tier5.rows.used).toEqual([1]);
    expect(tier5.rows.remaining).toEqual([6]);
    // 国际五星仍作为普通酒店组自己列一行（只是不进聚合）
    expect(board.hotels.some((h) => h.hotelId === 'h2')).toBe(true);
  });

  it('远期总量：控房不含聚合组（否则同一批房算两遍），收客含未落位随机单', async () => {
    const client = poolBoardClient(
      [hotelPeriod('h1', '明月酒店', 3, 5)],
      [hotelItem('h1', '明月酒店', 3), pendingItem(3)],
    );
    const forward = await getForward({ from: dayStr(0), to: dayStr(0) }, client);
    expect(forward.held).toEqual([5]); // 只数明月，不把「三星随机」的派生合计再加一遍
    expect(forward.occupied).toEqual([2]); // 明月 1 间 + 未落位随机单 1 间
    expect(forward.remaining).toEqual([3]);
  });
});

describe('星级随机档：未落位随机单的占房下钻', () => {
  it('getOccupyingOrders 支持随机档作用域：按「无房型 + 同档次」查未落位的单', async () => {
    const client = {
      orderItem: {
        findMany: vi.fn().mockResolvedValue([
          {
            roomsBilled: 1,
            metadata: null,
            hotelCheckIn: day(0),
            hotelCheckOut: day(2),
            order: {
              id: 'o1',
              orderNumber: 'CT250001',
              status: 'PAID',
              contactName: '李四',
              roomAssignment: null,
              agent: null,
              passengers: [{ documentNumber: 'E1', chineseName: '李四', fullName: 'LI/SI' }],
            },
          },
        ]),
      },
    } as unknown as PrismaClient;
    const occupants = await getOccupyingOrders({ randomStarTier: 4 }, dayStr(0), client);
    expect(occupants).toHaveLength(1);
    expect(occupants[0].orderNumber).toBe('CT250001');
    const where = (client.orderItem.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    // 两类未落位行都要下钻得到：正规随机单（无房型 + 档次命中）＋ 挂在占位酒店房型上的伪落位行
    expect(where.OR).toEqual([
      { hotelRoomTypeId: null, randomStarTier: 4 },
      { hotelRoomType: { hotel: { randomTierPlaceholder: 4 } } },
    ]);
  });
});

describe('星级随机档：下单闸 assertRandomTierFit / getRandomTierAggregate', () => {
  /**
   * 聚合闸的 fake client：hotel.findMany 给档次内的酒店，hotelBlockPeriod.findMany 给周期，
   * orderItem.findMany 被调两次（先已落位、后未落位），按调用顺序返回。
   */
  function aggClient(opts: {
    hotelIds: string[];
    periods: unknown[];
    hotelItems?: unknown[];
    pendingItems?: unknown[];
  }): PrismaClient {
    const orderItemFindMany = vi
      .fn()
      .mockResolvedValueOnce(opts.hotelItems ?? [])
      .mockResolvedValueOnce(opts.pendingItems ?? []);
    return {
      hotel: { findMany: vi.fn().mockResolvedValue(opts.hotelIds.map((id) => ({ id }))) },
      hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue(opts.periods) },
      orderItem: { findMany: orderItemFindMany },
    } as unknown as PrismaClient;
  }
  const stay = (over: Record<string, unknown> = {}) => ({
    hotelCheckIn: day(0),
    hotelCheckOut: day(1),
    ...over,
  });

  it('聚合余量 = Σ酒店包房 − 已落位占房 − 未落位随机单', async () => {
    const client = aggClient({
      hotelIds: ['h1', 'h2'],
      periods: [{ dateFrom: day(0), dateTo: day(1), rooms: 4 }, { dateFrom: day(0), dateTo: day(1), rooms: 3 }],
      hotelItems: [stay(), stay()],
      pendingItems: [stay()],
    });
    const agg = await getRandomTierAggregate(3, [dayStr(0)], {}, client);
    expect(agg).toMatchObject({ hasBlock: true, block: [7], hotelUsed: [2], pendingUsed: [1] });
    expect(agg.remaining).toEqual([4]);
    // 档次筛选口径：starRating 命中，且排除国际五星与占位酒店（两者都不是该档的真房源）
    const hotelWhere = (client.hotel.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(hotelWhere).toMatchObject({
      starRating: 3,
      intlFiveStar: false,
      randomTierPlaceholder: null,
    });
    // 未落位占用同吃两类行：正规随机单 ＋ 挂在该档占位酒店房型上的伪落位行
    const pendingWhere = (client.orderItem.findMany as ReturnType<typeof vi.fn>).mock.calls[1][0]
      .where;
    expect(pendingWhere.OR).toEqual([
      { hotelRoomTypeId: null, randomStarTier: 3 },
      { hotelRoomType: { hotel: { randomTierPlaceholder: 3 } } },
    ]);
  });

  it('余量够 → 放行；不够 → 拦下并点名档次与该晚余量', async () => {
    const ok = aggClient({
      hotelIds: ['h1'],
      periods: [{ dateFrom: day(0), dateTo: day(1), rooms: 3 }],
      pendingItems: [stay()],
    });
    await expect(assertRandomTierFit(4, [dayStr(0)], 2, {}, ok)).resolves.toEqual([]);

    const tight = aggClient({
      hotelIds: ['h1'],
      periods: [{ dateFrom: day(0), dateTo: day(1), rooms: 3 }],
      pendingItems: [stay()],
    });
    await expect(assertRandomTierFit(4, [dayStr(0)], 3, {}, tight)).rejects.toThrow(
      /四星随机余量不足.*余量 2 间.*本次需 3 间/,
    );
  });

  it('内部需求池传 Infinity → 任意大缺口放行，并返回缺口明细；对外缺省仍拒', async () => {
    const internal = aggClient({
      hotelIds: ['h1'],
      periods: [{ dateFrom: day(0), dateTo: day(1), rooms: 3 }],
      pendingItems: [stay()],
    });
    await expect(
      assertRandomTierFit(
        3,
        [dayStr(0)],
        99,
        { maxOversellRooms: Number.POSITIVE_INFINITY },
        internal,
      ),
    ).resolves.toMatchObject([{ date: dayStr(0), shortfall: 97 }]);

    const external = aggClient({
      hotelIds: ['h1'],
      periods: [{ dateFrom: day(0), dateTo: day(1), rooms: 3 }],
      pendingItems: [stay()],
    });
    await expect(assertRandomTierFit(3, [dayStr(0)], 99, {}, external)).rejects.toThrow(
      /三星随机余量不足/,
    );
  });

  it('该档次一家酒店都没切房 → 未管控，不拦截（未配包房 ≠ 售罄）', async () => {
    const noHotels = aggClient({ hotelIds: [], periods: [] });
    await expect(assertRandomTierFit(3, [dayStr(0)], 99, {}, noHotels)).resolves.toEqual([]);

    const noPeriods = aggClient({ hotelIds: ['h1'], periods: [] });
    await expect(assertRandomTierFit(3, [dayStr(0)], 99, {}, noPeriods)).resolves.toEqual([]);
  });

  it('内部需求池：整段未切房或单晚 block=0 也返回缺口；对外仍不拦截', async () => {
    const noPeriods = aggClient({ hotelIds: ['h1'], periods: [] });
    await expect(
      assertRandomTierFit(
        3,
        [dayStr(0)],
        99,
        { maxOversellRooms: Number.POSITIVE_INFINITY },
        noPeriods,
      ),
    ).resolves.toMatchObject([{ date: dayStr(0), remaining: 0, rooms: 99, shortfall: 99 }]);

    const partialBlock = aggClient({
      hotelIds: ['h1'],
      periods: [{ dateFrom: day(1), dateTo: day(2), rooms: 3 }],
    });
    const partialViolations = await assertRandomTierFit(
      3,
      [dayStr(0), dayStr(1)],
      4,
      { maxOversellRooms: Number.POSITIVE_INFINITY },
      partialBlock,
    );
    expect(partialViolations).toContainEqual(
      expect.objectContaining({ date: dayStr(0), remaining: 0, rooms: 4, shortfall: 4 }),
    );

    const externalPartialBlock = aggClient({
      hotelIds: ['h1'],
      periods: [{ dateFrom: day(1), dateTo: day(2), rooms: 3 }],
    });
    await expect(
      assertRandomTierFit(3, [dayStr(0), dayStr(1)], 4, {}, externalPartialBlock),
    ).rejects.toThrow(/三星随机余量不足/);
  });

  it('拼房半间按床位口径吃 0.5：余 0.5 时还能再塞一位拼房客', async () => {
    const client = aggClient({
      hotelIds: ['h1'],
      periods: [{ dateFrom: day(0), dateTo: day(1), rooms: 2 }],
      pendingItems: [stay({ roomsBilled: 1.5 })],
    });
    await expect(assertRandomTierFit(3, [dayStr(0)], 0.5, {}, client)).resolves.toEqual([]);
  });

  it('未切任何包房时仍保留随机需求占用，供清单显示未切房缺口', async () => {
    const client = aggClient({
      hotelIds: ['h1'],
      periods: [],
      pendingItems: [stay({ roomsBilled: 1.5 })],
    });
    await expect(getRandomTierAggregate(3, [dayStr(0)], {}, client)).resolves.toMatchObject({
      hasBlock: false,
      block: [0],
      hotelUsed: [0],
      pendingUsed: [1.5],
      remaining: [-1.5],
    });
  });

  // ── 限额内超售放行（内部录单口子，语义同 assertHotelPhysicalFit.maxOversellRooms）──
  it('maxOversellRooms：累计缺口 ≤ 上限 → 放行并返回被容忍的超卖明细；超上限仍拒', async () => {
    // 合计包房 3、已占 1 → 余 2；录 4 间 → 缺口 2 ≤ 上限 3 → 放行
    const within = aggClient({
      hotelIds: ['h1'],
      periods: [{ dateFrom: day(0), dateTo: day(1), rooms: 3 }],
      pendingItems: [stay()],
    });
    const tolerated = await assertRandomTierFit(4, [dayStr(0)], 4, { maxOversellRooms: 3 }, within);
    expect(tolerated).toHaveLength(1);
    expect(tolerated[0]).toMatchObject({ date: dayStr(0), remaining: 2, rooms: 4, shortfall: 2 });

    // 录 6 间 → 缺口 4 > 上限 3 → 仍拒，文案点名上限
    const beyond = aggClient({
      hotelIds: ['h1'],
      periods: [{ dateFrom: day(0), dateTo: day(1), rooms: 3 }],
      pendingItems: [stay()],
    });
    await expect(
      assertRandomTierFit(4, [dayStr(0)], 6, { maxOversellRooms: 3 }, beyond),
    ).rejects.toThrow(/超售容忍上限 3 间/);
  });
});

// ── 随机档事务内加锁版下单闸：assertRandomTierFitWithinTx ───────────────────
/**
 * 同 assertHotelPhysicalFitWithinTx 的并发漏洞：只读聚合闸两个请求同时抢随机档最后
 * 一间，各自读到旧快照，双双通过。事务内版本必须先把「该档次全部真酒店」名下、覆盖
 * 该区间的包房周期行一并 FOR UPDATE，再复用同一把聚合判定尺子。
 */
describe('assertRandomTierFitWithinTx（随机档事务内加锁版下单闸）', () => {
  /** 假 tx：$queryRaw 记录 SQL 片段/参数；orderItem.findMany 按 getRandomTierAggregate
   *  的调用顺序（先已落位 hotelItems、后未落位 pendingItems）依次返回。 */
  function fakeTierTx(opts: { hotelIds: string[]; periods: unknown[]; pendingItems?: unknown[] }) {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const tx = {
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?'), values });
        return Promise.resolve([]);
      }),
      hotel: { findMany: vi.fn().mockResolvedValue(opts.hotelIds.map((id) => ({ id }))) },
      hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue(opts.periods) },
      orderItem: { findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(opts.pendingItems ?? []) },
    };
    return { tx, calls };
  }

  type TxArg = Parameters<typeof assertRandomTierFitWithinTx>[0];

  it('判定之前先对该档次全部真酒店的包房周期行 FOR UPDATE 加锁（并发抢随机档在此串行）', async () => {
    const { tx, calls } = fakeTierTx({
      hotelIds: ['h1', 'h2'],
      periods: [{ dateFrom: day(0), dateTo: day(1), rooms: 5 }],
    });
    await assertRandomTierFitWithinTx(tx as unknown as TxArg, 3, [dayStr(0)], 1);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('"HotelBlockPeriod"');
    expect(sql).toContain('FOR UPDATE');
    // 按 id 排序加锁：两个事务锁同一批行的顺序一致，不会互相死锁
    expect(sql).toContain('ORDER BY id');
    // 锁的是「该档次全部真酒店」的周期行，不是单一酒店——先查了这批酒店 id
    expect(tx.hotel.findMany).toHaveBeenCalled();
    expect(tx.hotel.findMany.mock.calls[0][0].where).toMatchObject({
      starRating: 3,
      intlFiveStar: false,
      randomTierPlaceholder: null,
    });
    // 锁必须发生在读占房之前 —— 先读后锁等于没锁
    const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0];
    const readOrder = tx.orderItem.findMany.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(readOrder);
  });

  it('拿的是同一把判定尺子：装不下照样抛「余量不足」（口径与非事务版一字不差）', async () => {
    const { tx } = fakeTierTx({
      hotelIds: ['h1'],
      periods: [{ dateFrom: day(0), dateTo: day(1), rooms: 3 }],
      pendingItems: [{ hotelCheckIn: day(0), hotelCheckOut: day(1) }],
    });
    await expect(
      assertRandomTierFitWithinTx(tx as unknown as TxArg, 4, [dayStr(0)], 3),
    ).rejects.toThrow(/四星随机余量不足/);
    // 拒绝路径上锁一样要加过（否则并发下「都装得下」的判定仍是脏读）
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('该档次一家真酒店都没有 → 无行可锁，安静返回（未纳入管控）', async () => {
    const { tx } = fakeTierTx({ hotelIds: [], periods: [] });
    await expect(
      lockRandomTierBlockPeriodsWithinTx(tx as unknown as TxArg, 3, [dayStr(0)]),
    ).resolves.toBeUndefined();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('事务内内部需求池：未切房也返回缺口明细；对外缺省仍返回空数组', async () => {
    const internal = fakeTierTx({ hotelIds: ['h1'], periods: [] });
    await expect(
      assertRandomTierFitWithinTx(
        internal.tx as unknown as TxArg,
        3,
        [dayStr(0)],
        99,
        { maxOversellRooms: Number.POSITIVE_INFINITY },
      ),
    ).resolves.toMatchObject([{ date: dayStr(0), shortfall: 99 }]);

    const external = fakeTierTx({ hotelIds: ['h1'], periods: [] });
    await expect(
      assertRandomTierFitWithinTx(external.tx as unknown as TxArg, 3, [dayStr(0)], 99),
    ).resolves.toEqual([]);
  });

  it('空 nightDates（无入住区间）→ 连酒店都不查，安静返回', async () => {
    const { tx } = fakeTierTx({ hotelIds: ['h1'], periods: [] });
    await expect(lockRandomTierBlockPeriodsWithinTx(tx as unknown as TxArg, 3, [])).resolves.toBeUndefined();
    expect(tx.hotel.findMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('createBlockPeriod：只能挂具体酒店（随机档已废建池）', () => {
  const baseBody = { dateFrom: dayStr(0), dateTo: dayStr(3), rooms: 5 };
  function createClient(hotel: Record<string, unknown> = { id: 'h1' }): PrismaClient {
    return {
      hotel: { findUnique: vi.fn().mockResolvedValue(hotel) },
      hotelBlockPeriod: {
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 'bp1',
            ...data,
            note: null,
            unitPrice: null,
            updatedAt: new Date('2026-08-01T00:00:00.000Z'),
            hotel: data.hotelId ? { name: '明月酒店' } : null,
          }),
        ),
      },
    } as unknown as PrismaClient;
  }

  it('不给酒店 → 拒（不落孤儿周期）', async () => {
    await expect(
      createBlockPeriod({ ...baseBody } as never, createClient()),
    ).rejects.toThrow(/必须指定一家酒店/);
  });

  it('给随机档 → 拒，文案说清改成同星级合计了', async () => {
    await expect(
      createBlockPeriod({ ...baseBody, randomStarTier: 3 } as never, createClient()),
    ).rejects.toThrow(/随机档已改为同星级酒店合计，无需单独切池/);
  });

  it('酒店 + 随机档都给 → 同样拒（随机档优先报废建池）', async () => {
    await expect(
      createBlockPeriod({ ...baseBody, hotelId: 'h1', randomStarTier: 3 } as never, createClient()),
    ).rejects.toThrow(/无需单独切池/);
  });

  it('只给酒店 → 正常落库（randomStarTier 恒为 null，不打已停用标）', async () => {
    const period = await createBlockPeriod(
      { ...baseBody, hotelId: 'h1' } as never,
      createClient(),
    );
    expect(period).toMatchObject({
      hotelId: 'h1',
      randomStarTier: null,
      hotelName: '明月酒店',
      disabled: false,
    });
  });

  it('给随机档占位酒店 → 拒（它不是真房源，切房会与同星级真酒店双记一笔账）', async () => {
    await expect(
      createBlockPeriod(
        { ...baseBody, hotelId: 'ph3' } as never,
        createClient({ id: 'ph3', randomTierPlaceholder: 3 }),
      ),
    ).rejects.toThrow(/星级随机档占位项，不能切房/);
  });
});

// ── updateBlockPeriod / deleteBlockPeriod：缩减/删除占用守卫 ─────────────────
/**
 * 照抄机票侧 FLIGHT_MAX_OVERSELL_SEATS 的哲学：允许把包房改小（真实退房场景），但
 * 缺口（已占用物理间数 − 新包房）超过 HOTEL_MAX_OVERSELL_ROOMS 就拒绝；未超阈值但
 * 确实形成超占则放行并写 WARNING 审计。删除周期没有这道阈值豁免——只要会让任何一晚
 * 变成「已占用 > 删除后剩余包房」就直接拒绝，不给「差一点点也算了」的口子。
 */
describe('updateBlockPeriod / deleteBlockPeriod：占用守卫', () => {
  beforeEach(() => auditMock.mockClear());

  const existingPeriod = (over: Record<string, unknown> = {}) => ({
    id: 'bp1',
    hotelId: 'h1',
    randomStarTier: null,
    dateFrom: day(0),
    dateTo: day(3),
    rooms: 5,
    unitPrice: null,
    note: null,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    hotel: { name: '明月酒店', randomTierPlaceholder: null },
    ...over,
  });

  /** 4 个整间占房行（roomsBilled=1，无分房表），逐晚覆盖 day(0)..day(3)：occupied=4/晚。*/
  const fourWholeRoomItems = () =>
    Array.from({ length: 4 }, (_, i) => ({
      hotelCheckIn: day(0),
      hotelCheckOut: day(4),
      roomsBilled: 1,
      metadata: null,
      order: { id: `o${i + 1}`, roomAssignment: null, passengers: [] },
    }));

  function guardClient(opts: {
    existing: Record<string, unknown>;
    others?: unknown[];
    items?: unknown[];
  }): PrismaClient {
    return {
      hotelBlockPeriod: {
        findUnique: vi.fn().mockResolvedValue(opts.existing),
        findMany: vi.fn().mockResolvedValue(opts.others ?? []),
        update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...opts.existing, ...data, hotel: (opts.existing as { hotel: unknown }).hotel }),
        ),
        delete: vi.fn().mockResolvedValue({}),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue(opts.items ?? []) },
    } as unknown as PrismaClient;
  }

  describe('updateBlockPeriod', () => {
    it('改小但仍够住（新包房 >= 已占用）→ 直接放行，不写审计', async () => {
      const client = guardClient({ existing: existingPeriod(), items: fourWholeRoomItems() });
      const period = await updateBlockPeriod('bp1', { rooms: 4 } as never, client);
      expect(period.rooms).toBe(4);
      expect(auditMock).not.toHaveBeenCalled();
    });

    it('改小到阈值内的超占（缺口 <= HOTEL_MAX_OVERSELL_ROOMS）→ 放行但写 WARNING 审计', async () => {
      const client = guardClient({ existing: existingPeriod(), items: fourWholeRoomItems() });
      // occupied=4，新包房=3 → 缺口 1（<= 默认阈值 3）
      const period = await updateBlockPeriod('bp1', { rooms: 3 } as never, client);
      expect(period.rooms).toBe(3);
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE_HOTEL_BLOCK_PERIOD_OVERSOLD',
          severity: 'WARNING',
          targetId: 'h1',
        }),
      );
    });

    it('改小超过阈值（缺口 > HOTEL_MAX_OVERSELL_ROOMS）→ 400 拒绝，不落库', async () => {
      const client = guardClient({ existing: existingPeriod(), items: fourWholeRoomItems() });
      // occupied=4，新包房=0 → 缺口 4（> 默认阈值 3）
      await expect(updateBlockPeriod('bp1', { rooms: 0 } as never, client)).rejects.toThrow(
        /超过超卖上限/,
      );
      expect((client.hotelBlockPeriod.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('单纯改价/改备注（rooms 不变）→ 不查占用、不触发守卫', async () => {
      const client = guardClient({ existing: existingPeriod(), items: fourWholeRoomItems() });
      await updateBlockPeriod('bp1', { note: '换个备注' } as never, client);
      expect(client.orderItem.findMany).not.toHaveBeenCalled();
    });

    it('扩容（rooms 变大）→ 不触发守卫（增容不可能造成超占）', async () => {
      const client = guardClient({ existing: existingPeriod(), items: fourWholeRoomItems() });
      await updateBlockPeriod('bp1', { rooms: 8 } as never, client);
      expect(client.orderItem.findMany).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });

    it('日期区间收窄丢了原覆盖的日子 → 视同缩减，一并守卫（不只看 rooms 字段）', async () => {
      // rooms 不变（5），但 dateTo 从 day(3) 收窄到 day(1) → day(2)/day(3) 两晚容量归零
      const client = guardClient({ existing: existingPeriod(), items: fourWholeRoomItems() });
      await expect(
        updateBlockPeriod('bp1', { dateTo: dayStr(1) } as never, client),
      ).rejects.toThrow(/超过超卖上限/);
    });

    it('随机档存量周期（hotelId 为 null）→ 跳过守卫（本就不计入任何余量）', async () => {
      const client = guardClient({
        existing: existingPeriod({ hotelId: null, randomStarTier: 3, hotel: null }),
      });
      const period = await updateBlockPeriod('bp1', { rooms: 0 } as never, client);
      expect(period.rooms).toBe(0);
      expect(client.orderItem.findMany).not.toHaveBeenCalled();
    });

    it('占位酒店名下的周期 → 跳过守卫（不是真房源）', async () => {
      const client = guardClient({
        existing: existingPeriod({ hotel: { name: '三星占位', randomTierPlaceholder: 3 } }),
      });
      const period = await updateBlockPeriod('bp1', { rooms: 0 } as never, client);
      expect(period.rooms).toBe(0);
      expect(client.orderItem.findMany).not.toHaveBeenCalled();
    });
  });

  describe('deleteBlockPeriod', () => {
    it('无占用 → 正常删除', async () => {
      const client = guardClient({ existing: existingPeriod(), items: [] });
      await expect(deleteBlockPeriod('bp1', client)).resolves.toEqual({ id: 'bp1' });
      expect(client.hotelBlockPeriod.delete).toHaveBeenCalledWith({ where: { id: 'bp1' } });
    });

    it('有占用且删除后会短缺 → 拒绝，不给阈值豁免（零容忍，删除比缩容更激进）', async () => {
      const client = guardClient({ existing: existingPeriod(), items: fourWholeRoomItems() });
      await expect(deleteBlockPeriod('bp1', client)).rejects.toThrow(/请先处理相关订单再删除/);
      expect(client.hotelBlockPeriod.delete).not.toHaveBeenCalled();
    });

    it('有占用但另有其他周期兜底不短缺 → 放行', async () => {
      const client = guardClient({
        existing: existingPeriod(),
        others: [{ dateFrom: day(0), dateTo: day(3), rooms: 4 }],
        items: fourWholeRoomItems(),
      });
      await expect(deleteBlockPeriod('bp1', client)).resolves.toEqual({ id: 'bp1' });
    });

    it('随机档存量周期 → 跳过守卫，直接删除', async () => {
      const client = guardClient({
        existing: existingPeriod({ hotelId: null, randomStarTier: 3, hotel: null }),
      });
      await expect(deleteBlockPeriod('bp1', client)).resolves.toEqual({ id: 'bp1' });
      expect(client.orderItem.findMany).not.toHaveBeenCalled();
    });
  });
});

describe('listBlockPeriods：已停用标记（不计入余量的存量周期）', () => {
  function listClient(rows: unknown[]): PrismaClient {
    return {
      hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue(rows) },
    } as unknown as PrismaClient;
  }
  const row = (over: Record<string, unknown>) => ({
    id: 'bp1',
    hotelId: 'h1',
    randomStarTier: null,
    dateFrom: day(0),
    dateTo: day(3),
    rooms: 5,
    unitPrice: null,
    note: null,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    hotel: { name: '明月酒店', randomTierPlaceholder: null },
    ...over,
  });

  it('真酒店周期 → 正常计入（disabled=false）', async () => {
    const [p] = await listBlockPeriods({}, listClient([row({})]));
    expect(p.disabled).toBe(false);
  });

  it('存量随机档池周期 → 已停用', async () => {
    const [p] = await listBlockPeriods(
      {},
      listClient([row({ hotelId: null, randomStarTier: 3, hotel: null })]),
    );
    expect(p).toMatchObject({ disabled: true, hotelName: '三星随机' });
  });

  it('挂在占位酒店名下的周期 → 同款已停用', async () => {
    const [p] = await listBlockPeriods(
      {},
      listClient([
        row({ hotelId: 'ph3', hotel: { name: '随机三星', randomTierPlaceholder: 3 } }),
      ]),
    );
    expect(p).toMatchObject({ disabled: true, hotelName: '随机三星' });
  });
});

// ── 超售容忍上限（运营可调）：DB 配置优先，无/非法回落 env 缺省 ────────────────
describe('getHotelOversellCapRooms', () => {
  const withSetting = (value: string | null) =>
    ({
      systemSetting: {
        findUnique: vi.fn().mockResolvedValue(value == null ? null : { value }),
      },
    }) as unknown as PrismaClient;

  it('DB 有合法配置 → 用 DB 值（房控页改完即刻生效）', async () => {
    await expect(getHotelOversellCapRooms(withSetting('5'))).resolves.toBe(5);
    await expect(getHotelOversellCapRooms(withSetting('0'))).resolves.toBe(0);
  });

  it('无记录 / 非法值（非整数、负数、超上限）→ 回落 env 缺省 3', async () => {
    await expect(getHotelOversellCapRooms(withSetting(null))).resolves.toBe(3);
    await expect(getHotelOversellCapRooms(withSetting('abc'))).resolves.toBe(3);
    await expect(getHotelOversellCapRooms(withSetting('2.5'))).resolves.toBe(3);
    await expect(getHotelOversellCapRooms(withSetting('-1'))).resolves.toBe(3);
    await expect(getHotelOversellCapRooms(withSetting('999'))).resolves.toBe(3);
  });

  it('client 没有 systemSetting delegate（测试 mock/事务子集）→ 回落 env 缺省不炸', async () => {
    await expect(
      getHotelOversellCapRooms({} as unknown as PrismaClient),
    ).resolves.toBe(3);
  });
});
