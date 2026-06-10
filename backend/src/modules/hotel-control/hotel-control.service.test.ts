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
import { getAlerts } from './hotel-control.service.js';

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
