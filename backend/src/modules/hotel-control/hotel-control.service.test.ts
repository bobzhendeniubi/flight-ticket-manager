/**
 * getAlerts（提醒线）· 单元测试（vitest）
 *
 * 注入 fake PrismaClient（getBoard/getAlerts 都支持 client 参数），覆盖三类提醒：
 *   1. oversold        余量 < 0 → 提醒加房（deficit = used - block）
 *   2. surplusSoon     距今 3 天内 block > 0 且 remaining > 0 → 提示退房
 *   3. overCapacity    出发 30 天内班次计入口径乘客数 > ticketingCap（默认 191）
 *
 * 日期 fixture 全部相对"今天"动态生成，避免用例随日历过期。
 */
import { describe, it, expect, vi } from 'vitest';

// 默认 prisma 不参与（全部走注入 client）—— 仍需 mock 掉避免真实连接配置
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { Gender, PrismaClient } from '@prisma/client';

/** 拼房单出行人性别 fixture：单出行人套餐单的 order.passengers 形状（gender 明确类型，避免 string 收窄丢失）。*/
const solo = (gender: Gender | null): { order: { passengers: { gender: Gender | null }[] } } => ({
  order: { passengers: [{ gender }] },
});
import {
  getAlerts,
  getBoard,
  getOccupyingOrders,
  getNightlyRemainingForRoomType,
  getHotelNightlyRemaining,
  expandSharedHalfByDate,
  computePhysicalUsed,
  assignedPhysicalRooms,
  expandAssignedPhysicalByDate,
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
const todayStr = new Date().toISOString().slice(0, 10);
const todayMs = new Date(`${todayStr}T00:00:00.000Z`).getTime();

/** 距今 n 天的 UTC 零点 Date / YYYY-MM-DD。*/
const day = (n: number): Date => new Date(todayMs + n * DAY_MS);
const dayStr = (n: number): string => day(n).toISOString().slice(0, 10);

function fakeClient(opts: { paxCounts: number[] }): PrismaClient {
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
    orderItem: {
      findMany: vi.fn().mockResolvedValue([
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
      ]),
    },
    flightSchedule: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 's1',
          departureTime: day(1),
          ticketingCap: 191,
          flight: { flightNumber: 'QH9589' },
        },
        {
          id: 's2',
          departureTime: day(2),
          ticketingCap: 191,
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
      { flightNumber: 'QH9589', departureDate: dayStr(1), paxCount: 195 },
    ]);
  });

  it('乘客数恰好等于上限不报（> 才报）', async () => {
    const client = fakeClient({ paxCounts: [191, 191] });
    const alerts = await getAlerts(14, client);
    expect(alerts.overCapacitySchedules).toEqual([]);
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
      // 有分房表的半间单：物理 1 间、不落单
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
