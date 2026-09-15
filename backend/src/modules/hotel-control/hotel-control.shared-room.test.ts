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
  assertHotelFitAfterChange,
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

  it('L5 修复（批 10）：生产环境（NODE_ENV=production）缺 sharedRoom delegate → 直接抛错，不回落成 0', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const client = {} as unknown as PrismaClient;
      await expect(computeSharedRoomPhysicalByDate('h1', [dayStr(0)], client)).rejects.toThrow(
        'sharedRoom delegate missing on production client',
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
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

// ── assertHotelFitAfterChange（§五 变更前后全量比较闸）──────────────────────
describe('assertHotelFitAfterChange', () => {
  type TxArg = Parameters<typeof assertHotelFitAfterChange>[0];

  /** 假 tx：block=rooms 间；liveItems=本酒店当前全部有效占房行；sharedRooms=当前共享房。*/
  function fakeTx(opts: { rooms: number; liveItems?: unknown[]; sharedRooms?: unknown[] }) {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const tx = {
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?'), values });
        return Promise.resolve([]);
      }),
      hotelBlockPeriod: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ dateFrom: day(0), dateTo: day(2), rooms: opts.rooms }]),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue(opts.liveItems ?? []) },
      sharedRoom: { findMany: vi.fn().mockResolvedValue(opts.sharedRooms ?? []) },
    };
    return { tx, calls };
  }

  it('无包房周期（未纳管）→ 不查占房、直接放行', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue([]) },
      orderItem: { findMany: vi.fn() },
    };
    await expect(
      assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
        affectedOrderIds: ['orderA'],
      }),
    ).resolves.toEqual([]);
    expect(tx.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('判定前先加锁包房周期行（与 assertHotelPhysicalFitWithinTx 同一把锁）', async () => {
    const { tx, calls } = fakeTx({ rooms: 5 });
    await assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
      affectedOrderIds: ['orderA'],
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(calls[0].sql).toContain('FOR UPDATE');
  });

  it('受影响订单撤掉一个共享成员（份额→0 但仍是成员）不影响物理——共享房仍占 1 间，装得下就放行', async () => {
    const { tx } = fakeTx({
      rooms: 1,
      sharedRooms: [
        {
          id: 'sr1',
          checkIn: day(0),
          checkOut: day(1),
          members: [{ order: { status: 'PAID', deletedAt: null } }],
        },
      ],
    });
    await expect(
      assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
        affectedOrderIds: ['orderA'],
        nextSharedRooms: [
          { sharedRoomId: 'sr1', checkIn: day(0), checkOut: day(1), activeMemberOrderIds: ['orderA'] },
        ],
      }),
    ).resolves.toEqual([]);
  });

  // ── nextSharedRooms 覆盖项按 hotelId 过滤（跨批需求）──────────────────────────
  it('覆盖项自带 hotelId：传了别家酒店的共享房不影响本酒店结果', async () => {
    const { tx } = fakeTx({ rooms: 1 }); // h1 只有 1 间包房，当前没有其它占用
    await expect(
      assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
        affectedOrderIds: ['orderA'],
        nextSharedRooms: [
          // 本酒店（h1）新建一间共享房，装得下（1 间 ≤ block 1 间）。
          { checkIn: day(0), checkOut: day(1), activeMemberOrderIds: ['orderA'], hotelId: 'h1' },
          // 别家酒店（h2）的共享房覆盖项——不该被算进 h1 的统计，否则会把这行的日期误加
          // 进 h1 的逐晚累计，凭空多算 1 间导致本该放行的操作被误拒。
          {
            sharedRoomId: 'sr-other-hotel',
            checkIn: day(0),
            checkOut: day(1),
            activeMemberOrderIds: ['orderC'],
            hotelId: 'h2',
          },
        ],
      }),
    ).resolves.toEqual([]);
  });

  it('覆盖项没带 hotelId 但带 sharedRoomId：查库补齐真实归属，别家酒店的房仍不影响本酒店结果', async () => {
    const calls: unknown[] = [];
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue([{ dateFrom: day(0), dateTo: day(2), rooms: 1 }]) },
      orderItem: { findMany: vi.fn().mockResolvedValue([]) },
      sharedRoom: {
        findMany: vi.fn((args: { where?: Record<string, unknown> }) => {
          calls.push(args);
          // 查真实归属（按 id in [...] 查）：sr-mine 属于 h1，sr-other 属于 h2。
          if (args.where?.id) {
            return Promise.resolve([
              { id: 'sr-mine', hotelId: 'h1' },
              { id: 'sr-other', hotelId: 'h2' },
            ]);
          }
          return Promise.resolve([]); // 「本酒店现存活跃共享房」查询：现状没有
        }),
      },
    };
    await expect(
      assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
        affectedOrderIds: ['orderA'],
        nextSharedRooms: [
          // 没带 hotelId，但 sharedRoomId 查出来真实属于 h1——应当计入。
          { sharedRoomId: 'sr-mine', checkIn: day(0), checkOut: day(1), activeMemberOrderIds: ['orderA'] },
          // 没带 hotelId，sharedRoomId 查出来真实属于 h2——不该计入 h1 的统计。
          { sharedRoomId: 'sr-other', checkIn: day(0), checkOut: day(1), activeMemberOrderIds: ['orderC'] },
        ],
      }),
    ).resolves.toEqual([]); // 只有 sr-mine 的 1 间计入，1 ≤ block 1，放行
  });

  // ── astra N1（回归）：新建共享房预生成的 sharedRoomId 库里查不到 = 待创建，不是「不属于
  // 本酒店」——不能被 hotelId 兜底过滤悄悄漏计 ──────────────────────────────────────
  it('astra N1：新房覆盖项带预生成 sharedRoomId 但库里还查不到——按待创建计入本酒店，不被漏计', async () => {
    // 包房 1 间；已有另一张不受影响的订单占了 1 间普通房——单看这行已经打平 block。
    const { tx } = fakeTx({
      rooms: 1,
      liveItems: [
        {
          id: 'itemOther',
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          metadata: null,
          hotelRoomType: { hotel: { name: 'X酒店' } },
          order: { id: 'orderOther', roomAssignment: null, passengers: [{ gender: 'M' }] },
        },
      ],
    });
    // orderA 本次要新建一间共享房——sharedRoomId 是调用方（saveSharedRooms 的
    // resolvedRoomIds）预先生成、这次请求结束前才会真正落库的随机 id，此刻查库必然查不到。
    // 不带 hotelId 模拟旧调用方漏传的场景：修复前，被查不到归属的 hotelId 过滤器悄悄
    // 排除，闸内只看到 otherItems 的 1 间，装得下；修复后应正确算上这间新房，1+1=2 超限。
    await expect(
      assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
        affectedOrderIds: ['orderA'],
        nextSharedRooms: [
          {
            sharedRoomId: 'new-room-pending-creation',
            checkIn: day(0),
            checkOut: day(1),
            activeMemberOrderIds: ['orderA'],
          },
        ],
      }),
    ).rejects.toThrow(/房间不足/);
  });

  it('新建共享房把一个第三方订单的独立占房行合并进来 → 变更后物理从 2 降到 1，装得下', async () => {
    // 现状：两张订单各占普通房组 1 间（block=1，物理已超卖 2>1，仅靠 allowNonWorsening 才能放行改动）
    const { tx } = fakeTx({
      rooms: 1,
      liveItems: [
        {
          id: 'itemA',
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          metadata: null,
          hotelRoomType: { hotel: { name: 'X酒店' } },
          order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'M' }] },
        },
        {
          id: 'itemB',
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          metadata: null,
          hotelRoomType: { hotel: { name: 'X酒店' } },
          order: { id: 'orderB', roomAssignment: null, passengers: [{ gender: 'M' }] },
        },
      ],
    });
    await expect(
      assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
        affectedOrderIds: ['orderA', 'orderB'],
        // 两单在本酒店变更后都不再有独立占房行——都并进新共享房
        nextOrderItems: new Map([
          ['orderA', []],
          ['orderB', []],
        ]),
        nextSharedRooms: [
          { checkIn: day(0), checkOut: day(1), activeMemberOrderIds: ['orderA', 'orderB'] },
        ],
        options: { allowNonWorsening: true },
      }),
    ).resolves.toEqual([]);
  });

  it('变更后比变更前更差（新增占用超出包房量）→ 抛错，不放行', async () => {
    const { tx } = fakeTx({
      rooms: 1,
      liveItems: [
        {
          id: 'itemA',
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          metadata: null,
          hotelRoomType: { hotel: { name: 'X酒店' } },
          order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'M' }] },
        },
      ],
    });
    await expect(
      assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
        affectedOrderIds: ['orderA'],
        // 本单变更后又新增一间不相干的普通占房行（模拟新增占用而非平移）
        nextOrderItems: new Map([
          [
            'orderA',
            [
              {
                id: 'itemA',
                hotelCheckIn: day(0),
                hotelCheckOut: day(1),
                roomsBilled: 1,
                metadata: null,
                hotelRoomType: { hotel: { name: 'X酒店' } },
                order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'M' }] },
              },
              {
                id: 'itemA2',
                hotelCheckIn: day(0),
                hotelCheckOut: day(1),
                roomsBilled: 1,
                metadata: null,
                hotelRoomType: { hotel: { name: 'X酒店' } },
                order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'F' }] },
              },
            ],
          ],
        ]),
      }),
    ).rejects.toThrow(/房间不足/);
  });

  // ── maxOversellRooms：内部录单限额内超售放行（跨批需求，语义照抄 assertHotelPhysicalFit）──
  it('maxOversellRooms：累计缺口 ≤ 上限 → 放行并返回被容忍的超卖明细（供调用方写 WARNING 审计）', async () => {
    const { tx } = fakeTx({
      rooms: 1,
      liveItems: [
        {
          id: 'itemA',
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          metadata: null,
          hotelRoomType: { hotel: { name: 'X酒店' } },
          order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'M' }] },
        },
      ],
    });
    const tolerated = await assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
      affectedOrderIds: ['orderA'],
      // 变更后新增一间不相干的占房行——包房 1 间，变更后需 2 间，缺口 1 ≤ 上限 1。
      nextOrderItems: new Map([
        [
          'orderA',
          [
            {
              id: 'itemA',
              hotelCheckIn: day(0),
              hotelCheckOut: day(1),
              roomsBilled: 1,
              metadata: null,
              hotelRoomType: { hotel: { name: 'X酒店' } },
              order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'M' }] },
            },
            {
              id: 'itemA2',
              hotelCheckIn: day(0),
              hotelCheckOut: day(1),
              roomsBilled: 1,
              metadata: null,
              hotelRoomType: { hotel: { name: 'X酒店' } },
              order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'F' }] },
            },
          ],
        ],
      ]),
      options: { maxOversellRooms: 1 },
    });
    expect(tolerated).toHaveLength(1);
    expect(tolerated[0]).toMatchObject({ date: dayStr(0), block: 1, physicalUsed: 2, shortfall: 1 });
  });

  it('maxOversellRooms：任一晚累计缺口超上限 → 仍拒，文案点名上限', async () => {
    const { tx } = fakeTx({
      rooms: 1,
      liveItems: [
        {
          id: 'itemA',
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          metadata: null,
          hotelRoomType: { hotel: { name: 'X酒店' } },
          order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'M' }] },
        },
      ],
    });
    await expect(
      assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
        affectedOrderIds: ['orderA'],
        nextOrderItems: new Map([
          [
            'orderA',
            [
              {
                id: 'itemA',
                hotelCheckIn: day(0),
                hotelCheckOut: day(1),
                roomsBilled: 1,
                metadata: null,
                hotelRoomType: { hotel: { name: 'X酒店' } },
                order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'M' }] },
              },
              {
                id: 'itemA2',
                hotelCheckIn: day(0),
                hotelCheckOut: day(1),
                roomsBilled: 1,
                metadata: null,
                hotelRoomType: { hotel: { name: 'X酒店' } },
                order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'F' }] },
              },
            ],
          ],
        ]),
        options: { maxOversellRooms: 0 }, // 缺口 1 > 上限 0
      }),
    ).rejects.toThrow(/超售容忍上限 0 间/);
  });

  it('maxOversellRooms 缺省 → 缺口 1 间也硬拒，口子只对内部录单开', async () => {
    const { tx } = fakeTx({
      rooms: 1,
      liveItems: [
        {
          id: 'itemA',
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          metadata: null,
          hotelRoomType: { hotel: { name: 'X酒店' } },
          order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'M' }] },
        },
      ],
    });
    await expect(
      assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
        affectedOrderIds: ['orderA'],
        nextOrderItems: new Map([
          [
            'orderA',
            [
              {
                id: 'itemA',
                hotelCheckIn: day(0),
                hotelCheckOut: day(1),
                roomsBilled: 1,
                metadata: null,
                hotelRoomType: { hotel: { name: 'X酒店' } },
                order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'M' }] },
              },
              {
                id: 'itemA2',
                hotelCheckIn: day(0),
                hotelCheckOut: day(1),
                roomsBilled: 1,
                metadata: null,
                hotelRoomType: { hotel: { name: 'X酒店' } },
                order: { id: 'orderA', roomAssignment: null, passengers: [{ gender: 'F' }] },
              },
            ],
          ],
        ]),
      }),
    ).rejects.toThrow(/房间不足/);
  });

  it('L5 修复（批 10）：生产环境（NODE_ENV=production）+ tx 没有 sharedRoom delegate → 直接抛错，不回落', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      // 有包房周期（不走「未纳管直接放行」早退），tx 里故意不搭 sharedRoom delegate——
      // 模拟生产客户端初始化坏了的场景。
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        hotelBlockPeriod: {
          findMany: vi.fn().mockResolvedValue([{ dateFrom: day(0), dateTo: day(2), rooms: 5 }]),
        },
        orderItem: { findMany: vi.fn().mockResolvedValue([]) },
      };
      await expect(
        assertHotelFitAfterChange(tx as unknown as TxArg, 'h1', [dayStr(0)], {
          affectedOrderIds: ['orderA'],
        }),
      ).rejects.toThrow('sharedRoom delegate missing on production client');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
