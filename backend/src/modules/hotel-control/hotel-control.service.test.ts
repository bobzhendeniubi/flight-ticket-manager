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

import type { PrismaClient } from '@prisma/client';
import {
  getAlerts,
  getBoard,
  expandSharedHalfByDate,
  computePhysicalUsed,
} from './hotel-control.service.js';

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

describe('expandSharedHalfByDate', () => {
  const dates = [dayStr(0), dayStr(1), dayStr(2)];

  it('只数 roomsBilled==0.5 的行，整间/其它房量不计', () => {
    const items = [
      // 拼房客 A：D0..D1 覆盖 D0
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5 },
      // 整间：不计
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 1 },
      // 拼房客 B：D0..D2 覆盖 D0、D1
      { hotelCheckIn: day(0), hotelCheckOut: day(2), roomsBilled: 0.5 },
    ];
    // D0: A+B=2；D1: B=1；D2: 0
    expect(expandSharedHalfByDate(items, dates)).toEqual([2, 1, 0]);
  });

  it('缺 check-in/out 或非 0.5 的行跳过', () => {
    const items = [
      { hotelCheckIn: null, hotelCheckOut: day(1), roomsBilled: 0.5 },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: null },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.25 },
    ];
    expect(expandSharedHalfByDate(items, dates)).toEqual([0, 0, 0]);
  });
});

describe('getBoard sharedHalfCount / sharedOdd', () => {
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

  it('拼房客奇数标 sharedOdd，偶数不标；整间不影响', async () => {
    const client = boardClient([
      // D0 两位拼房（偶数）+ 一整间
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } } },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } } },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 1, hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } } },
      // D1 一位拼房（奇数）→ 落单
      { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 0.5, hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } } },
    ]);
    const board = await getBoard({ from: dayStr(0), to: dayStr(2) }, client);
    const rows = board.hotels[0]!.rows;
    // D0=2（偶）, D1=1（奇）, D2=0
    expect(rows.sharedHalfCount).toEqual([2, 1, 0]);
    expect(rows.sharedOdd).toEqual([false, true, false]);
    // 既有口径不受影响
    expect(rows.remaining.length).toBe(3);
  });
});

describe('computePhysicalUsed', () => {
  it('3 位拼房客 → 床位 1.5，物理 ceil(3/2)+0 = 2 间', () => {
    // used = 3 * 0.5 = 1.5；无整间预订
    expect(computePhysicalUsed([1.5], [3])).toEqual([2]);
  });

  it('2 位拼房客 + 1 整间 → 床位 2.0，物理 ceil(2/2)+1 = 2 间', () => {
    // used = 2*0.5 + 1 = 2.0
    expect(computePhysicalUsed([2.0], [2])).toEqual([2]);
  });

  it('0 拼房客、2 整间 → 物理 = 2（与床位口径一致）', () => {
    expect(computePhysicalUsed([2], [0])).toEqual([2]);
  });

  it('仅 1 位拼房客 → 床位 0.5，落单向上取整为整间 → 物理 1', () => {
    expect(computePhysicalUsed([0.5], [1])).toEqual([1]);
  });

  it('浮点误差（0.5 累加）不影响整间余数取整', () => {
    // 3 位拼房 + 2 整间：床位 = 1.5 + 2 = 3.5（可能带 0.999… 误差）
    const usedWithError = 0.5 + 0.5 + 0.5 + 1 + 1; // = 3.5，构造累加路径
    expect(computePhysicalUsed([usedWithError], [3])).toEqual([2 + 2]); // ceil(3/2)=2, 整间 2 → 4
  });
});

describe('getBoard physicalUsed / physicalRemaining', () => {
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

  it('销控板输出物理房间口径（block=5，D0 3 拼房→物理 2，余 3）', async () => {
    const rt = { hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } } };
    const client = boardClient([
      // D0：3 位拼房客（奇数，落单）→ 床位 1.5、物理 2
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...rt },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...rt },
      { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 0.5, ...rt },
      // D1：2 位拼房客 + 1 整间 → 床位 2.0、物理 2
      { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 0.5, ...rt },
      { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 0.5, ...rt },
      { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 1, ...rt },
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
});
