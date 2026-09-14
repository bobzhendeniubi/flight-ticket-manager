/**
 * 跨单分房（共享房）· 物理房间口径单元测试（vitest）
 *
 * 覆盖 docs/跨单分房-需求方案.md v2 §四 + astra 评审 finding 1/2 的反例：
 *   - 共享房逐晚去重计 1 间，与份额（roomFraction，含显式 0）无关；
 *   - 带 sharedRoomId 的房组不再参与基于 JSON 的桶求和聚合（避免 0 被读成 1、避免双算）；
 *   - getHotelNightlyRemaining 把两套口径（普通房组 JSON + 共享房去重）相加，
 *     三人合住 1+0 的反例只占 1 间物理房，不是 2 间。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  computeSharedRoomPhysicalByDate,
  assignedPhysicalRooms,
  expandAssignedPhysicalByDate,
  getHotelNightlyRemaining,
} from './hotel-control.service.js';
import { businessDateISO } from '../../lib/business-time.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const todayStr = businessDateISO(new Date());
const todayMs = new Date(`${todayStr}T00:00:00.000Z`).getTime();
const day = (n: number): Date => new Date(todayMs + n * DAY_MS);
const dayStr = (n: number): string => day(n).toISOString().slice(0, 10);

describe('computeSharedRoomPhysicalByDate（共享房逐晚去重物理间数）', () => {
  it('两个成员（一个有效订单一个已取消）→ 覆盖夜晚仍计 1 间，不是 0 也不是 2', async () => {
    const client = {
      sharedRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            checkIn: day(0),
            checkOut: day(2),
            members: [
              { order: { status: 'PAID', deletedAt: null } },
              { order: { status: 'CANCELLED', deletedAt: null } },
            ],
          },
        ]),
      },
    } as unknown as PrismaClient;
    const out = await computeSharedRoomPhysicalByDate('h1', [dayStr(0), dayStr(1)], client);
    expect(out).toEqual([1, 1]);
  });

  it('全部成员订单都已失效（取消/软删）→ 该晚不计入物理房', async () => {
    const client = {
      sharedRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            checkIn: day(0),
            checkOut: day(1),
            members: [
              { order: { status: 'CANCELLED', deletedAt: null } },
              { order: { status: 'PAID', deletedAt: day(-1) } }, // 软删
            ],
          },
        ]),
      },
    } as unknown as PrismaClient;
    const out = await computeSharedRoomPhysicalByDate('h1', [dayStr(0)], client);
    expect(out).toEqual([0]);
  });

  it('两间不同共享房同晚有效 → 各计 1 间，合计 2', async () => {
    const client = {
      sharedRoom: {
        findMany: vi.fn().mockResolvedValue([
          { checkIn: day(0), checkOut: day(1), members: [{ order: { status: 'PAID', deletedAt: null } }] },
          { checkIn: day(0), checkOut: day(1), members: [{ order: { status: 'TICKETED', deletedAt: null } }] },
        ]),
      },
    } as unknown as PrismaClient;
    const out = await computeSharedRoomPhysicalByDate('h1', [dayStr(0)], client);
    expect(out).toEqual([2]);
  });

  it('mock client 没有 sharedRoom delegate（老测试未升级）→ 防御式回落全 0，不抛错', async () => {
    const client = {} as unknown as PrismaClient;
    const out = await computeSharedRoomPhysicalByDate('h1', [dayStr(0), dayStr(1)], client);
    expect(out).toEqual([0, 0]);
  });

  it('空 dates → 空数组，不查库', async () => {
    const findMany = vi.fn();
    const client = { sharedRoom: { findMany } } as unknown as PrismaClient;
    const out = await computeSharedRoomPhysicalByDate('h1', [], client);
    expect(out).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('assignedPhysicalRooms / expandAssignedPhysicalByDate 跳过共享房组（finding 1）', () => {
  it('房组只有 sharedRoomId、roomFraction=0（主单让份）→ 不再被 groupRoomFraction 读成 1 间；JSON 侧物理为 0（null）', () => {
    const rooms = assignedPhysicalRooms({
      roomGroups: [
        {
          id: 'g1',
          hotelName: 'X酒店',
          roomType: '',
          passengerIds: ['p1'],
          sharedRoomId: 'sr1',
          roomFraction: 0,
        },
      ],
    });
    // 共享房组被整体跳过 → 本单 JSON 侧物理房数 = 0 → assignedPhysicalRooms 按「无有效分房表」返回 null
    // （真实物理占用由 computeSharedRoomPhysicalByDate 另算，两者相加才是完整口径）。
    expect(rooms).toBeNull();
  });

  it('一个普通房组 + 一个共享房组 → 只计普通房组（1 间），共享房组不贡献 JSON 侧物理数', () => {
    const rooms = assignedPhysicalRooms({
      roomGroups: [
        { id: 'g1', hotelName: 'X酒店', roomType: '', passengerIds: ['p1', 'p2'] },
        {
          id: 'g2',
          hotelName: 'X酒店',
          roomType: '',
          passengerIds: ['p3'],
          sharedRoomId: 'sr1',
          roomFraction: 1,
        },
      ],
    });
    expect(rooms).toBe(1);
  });

  it('expandAssignedPhysicalByDate：带归属的共享房组不进 own/unattributed 桶（跨单 1+0 由外部相加，不在此处重复计）', () => {
    const items = [
      {
        id: 'item1',
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        hotelRoomType: { hotel: { name: 'X酒店' } },
        order: {
          id: 'orderA',
          roomAssignment: {
            roomGroups: [
              {
                id: 'g1',
                hotelName: 'X酒店',
                roomType: '',
                passengerIds: ['p1'],
                orderItemId: 'item1',
                sharedRoomId: 'sr1',
                roomFraction: 1,
              },
            ],
          },
          passengers: [{ gender: 'M' as const }],
        },
      },
    ];
    const { assignedPhysical, fallbackItems } = expandAssignedPhysicalByDate(items, [dayStr(0)]);
    // 不进 fallback（有权威分房表，即便全是共享房组，也绝不能回退性别推算重新算一遍）
    expect(fallbackItems).toEqual([]);
    // 也不在 JSON 侧计物理房（共享房物理另算）
    expect(assignedPhysical).toEqual([0]);
  });
});

describe('getHotelNightlyRemaining：普通房组 JSON + 共享房去重口径相加（跨单 1+0 反例）', () => {
  it('两张订单各出 1 位客人合住一间共享房（份额 1+0）→ 物理只占 1 间，不是 2 间', async () => {
    const items = [
      {
        id: 'itemA',
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        roomsBilled: 1,
        metadata: null,
        hotelRoomType: { hotel: { name: 'X酒店' } },
        order: {
          id: 'orderA',
          roomAssignment: {
            roomGroups: [
              {
                id: 'g1',
                hotelName: 'X酒店',
                roomType: '',
                passengerIds: ['p1'],
                orderItemId: 'itemA',
                sharedRoomId: 'sr1',
                roomFraction: 1,
              },
            ],
          },
          passengers: [{ gender: 'M' }],
        },
      },
      {
        id: 'itemB',
        hotelCheckIn: day(0),
        hotelCheckOut: day(1),
        roomsBilled: 0,
        metadata: null,
        hotelRoomType: { hotel: { name: 'X酒店' } },
        order: {
          id: 'orderB',
          roomAssignment: {
            roomGroups: [
              {
                id: 'g2',
                hotelName: 'X酒店',
                roomType: '',
                passengerIds: ['p2'],
                orderItemId: 'itemB',
                sharedRoomId: 'sr1',
                roomFraction: 0,
              },
            ],
          },
          passengers: [{ gender: 'F' }],
        },
      },
    ];
    const client = {
      hotelBlockPeriod: {
        findMany: vi.fn().mockResolvedValue([{ dateFrom: day(0), dateTo: day(1), rooms: 5 }]),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue(items) },
      sharedRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            checkIn: day(0),
            checkOut: day(1),
            members: [
              { order: { status: 'PAID', deletedAt: null } },
              { order: { status: 'PAID', deletedAt: null } },
            ],
          },
        ]),
      },
    } as unknown as PrismaClient;

    const res = await getHotelNightlyRemaining('h1', [dayStr(0)], client);
    expect(res.hasBlock).toBe(true);
    // 物理：5 间包房 − 1 间共享房占用 = 4（不是 3，即不是把两单各算 1 间）
    expect(res.physicalRemaining).toEqual([4]);
  });
});
