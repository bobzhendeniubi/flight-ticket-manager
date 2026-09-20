/**
 * 跨单分房 · 档次房（随机档待落位的单跨单合住，2026-09-20 拍板 A）单元测试（vitest）。
 *
 * 覆盖：
 *   - schema：hotelId | randomStarTier 二选一；档次房不能带房型、酒店房必须带房型；
 *   - itemPendingTier：形态①（无房型 + randomStarTier）∪ 形态②（房型挂占位酒店）；
 *   - planRoomsBilledAfter：Σ份额=1 之下三张单合一间档次房 → 三行 roomsBilled 合计 1
 *     （随机池是床位/计费口径，据此只占 1 间）；
 *   - computeSharedRoomPhysicalByDate / computeSharedRoomPhysicalBuckets 按作用域分桶；
 *   - assertRandomTierFitAfterChange：只判变差的夜晚、未纳管放行、超出 400；
 *   - getSharedRoomWorkbench 随机档作用域：候选查询两形态并集、房型名「X星随机（待落位）」。
 * 跨模式混入 400 / 整房落位 / 解绑矩阵走真库集成测试（*.random-tier.integration.test.ts）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  saveSharedRoomsBodySchema,
  sharedRoomWorkbenchQuerySchema,
  placeSharedRoomBodySchema,
} from './hotel-control.schemas.js';
import {
  getSharedRoomWorkbench,
  itemPendingTier,
  planRoomsBilledAfter,
  TIER_ROOM_DEFAULT_CAPACITY,
} from './hotel-control.shared-rooms.js';
import {
  assertRandomTierFitAfterChange,
  computeSharedRoomPhysicalBuckets,
  computeSharedRoomPhysicalByDate,
} from './hotel-control.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const base = new Date('2026-10-01T00:00:00.000Z').getTime();
const day = (n: number): Date => new Date(base + n * DAY_MS);
const dayStr = (n: number): string => day(n).toISOString().slice(0, 10);

describe('schema：作用域 hotelId | randomStarTier 二选一', () => {
  const groups = [{ orderId: 'o1', orderItemId: 'i1', passengerIds: ['p1'], roomFraction: 1 }];
  const common = { checkIn: '2026-10-01', checkOut: '2026-10-02', requestToken: 'tok' };

  it('保存：两个都给 / 都不给 → 拒绝', () => {
    expect(saveSharedRoomsBodySchema.safeParse({ ...common, rooms: [] }).success).toBe(false);
    expect(
      saveSharedRoomsBodySchema.safeParse({ ...common, hotelId: 'h1', randomStarTier: 4, rooms: [] }).success,
    ).toBe(false);
  });

  it('保存：档次房不能指定房型；酒店房必须指定房型', () => {
    const tierWithRoomType = saveSharedRoomsBodySchema.safeParse({
      ...common,
      randomStarTier: 4,
      rooms: [{ hotelRoomTypeId: 'rt1', groups }],
    });
    expect(tierWithRoomType.success).toBe(false);
    const tierOk = saveSharedRoomsBodySchema.safeParse({ ...common, randomStarTier: 4, rooms: [{ groups }] });
    expect(tierOk.success).toBe(true);
    const hotelMissing = saveSharedRoomsBodySchema.safeParse({ ...common, hotelId: 'h1', rooms: [{ groups }] });
    expect(hotelMissing.success).toBe(false);
    const hotelOk = saveSharedRoomsBodySchema.safeParse({
      ...common,
      hotelId: 'h1',
      rooms: [{ hotelRoomTypeId: 'rt1', groups }],
    });
    expect(hotelOk.success).toBe(true);
  });

  it('工作台查询：randomStarTier 走 coerce（query string），且与 hotelId 互斥', () => {
    const tier = sharedRoomWorkbenchQuerySchema.safeParse({ randomStarTier: '4', checkIn: '2026-10-01', checkOut: '2026-10-02' });
    expect(tier.success).toBe(true);
    if (tier.success) expect(tier.data.randomStarTier).toBe(4);
    expect(
      sharedRoomWorkbenchQuerySchema.safeParse({ hotelId: 'h1', randomStarTier: '4', checkIn: '2026-10-01', checkOut: '2026-10-02' })
        .success,
    ).toBe(false);
    expect(sharedRoomWorkbenchQuerySchema.safeParse({ checkIn: '2026-10-01', checkOut: '2026-10-02' }).success).toBe(false);
    // 2 星不是随机档
    expect(sharedRoomWorkbenchQuerySchema.safeParse({ randomStarTier: '2', checkIn: '2026-10-01', checkOut: '2026-10-02' }).success).toBe(false);
  });

  it('整房落位 body：房型 + 期望版本必填', () => {
    expect(placeSharedRoomBodySchema.safeParse({ hotelRoomTypeId: 'rt1', expectedVersion: 1 }).success).toBe(true);
    expect(placeSharedRoomBodySchema.safeParse({ hotelRoomTypeId: 'rt1' }).success).toBe(false);
  });
});

describe('itemPendingTier：两种未落位形态', () => {
  it('形态①：无房型 + randomStarTier', () => {
    expect(itemPendingTier({ hotelRoomTypeId: null, randomStarTier: 4, placeholderTier: null })).toBe(4);
  });
  it('形态②：房型挂在占位酒店上', () => {
    expect(itemPendingTier({ hotelRoomTypeId: 'rt-ph', randomStarTier: null, placeholderTier: 3 })).toBe(3);
  });
  it('已落位真酒店 → null；无房型也无档次 → null', () => {
    expect(itemPendingTier({ hotelRoomTypeId: 'rt1', randomStarTier: null, placeholderTier: null })).toBeNull();
    expect(itemPendingTier({ hotelRoomTypeId: null, randomStarTier: null, placeholderTier: null })).toBeNull();
  });
  it('档次房容量提示阈值是命名常量 2', () => {
    expect(TIER_ROOM_DEFAULT_CAPACITY).toBe(2);
  });
});

describe('planRoomsBilledAfter：随机池按 Σ roomsBilled 占用，三张单合一间档次房只占 1 间', () => {
  it('1 + 0 + 0 三个共享组各自落到三张单的三条行 → 三行合计 1', () => {
    const shared = (itemId: string, fraction: number) => ({
      id: `g-${itemId}`,
      hotelName: '',
      roomType: '待落位',
      passengerIds: [`p-${itemId}`],
      orderItemId: itemId,
      roomFraction: fraction,
      sharedRoomId: 'sr1',
    });
    const a = planRoomsBilledAfter([], [shared('iA', 1)]);
    const b = planRoomsBilledAfter([], [shared('iB', 0)]);
    const c = planRoomsBilledAfter([], [shared('iC', 0)]);
    expect(a).toEqual({ iA: 1 });
    expect(b).toEqual({ iB: 0 });
    expect(c).toEqual({ iC: 0 });
    expect(a.iA! + b.iB! + c.iC!).toBe(1);
  });

  it('0.5 + 0.5 两个半份额 → 合计 1，不向上取整成 2', () => {
    const a = planRoomsBilledAfter([], [{ id: 'g', passengerIds: ['p'], orderItemId: 'iA', roomFraction: 0.5, sharedRoomId: 'sr1' }]);
    const b = planRoomsBilledAfter([], [{ id: 'g', passengerIds: ['q'], orderItemId: 'iB', roomFraction: 0.5, sharedRoomId: 'sr1' }]);
    expect(a.iA! + b.iB!).toBe(1);
  });

  it('变更前引用过、变更后不再被任何组引用的行 → 显式写 0；从未分房的行不出现', () => {
    const out = planRoomsBilledAfter(
      [{ id: 'g-old', passengerIds: ['p1'], orderItemId: 'iOld', roomFraction: 1 }],
      [{ id: 'g-new', passengerIds: ['p1'], orderItemId: 'iNew', roomFraction: 1, sharedRoomId: 'sr1' }],
    );
    expect(out).toEqual({ iNew: 1, iOld: 0 });
    expect(out).not.toHaveProperty('iNever');
  });

  it('同一行同时有普通组（1）和共享组（0.5）→ 按行累加 1.5', () => {
    const out = planRoomsBilledAfter(
      [],
      [
        { id: 'g1', passengerIds: ['p1', 'p2'], orderItemId: 'i1', roomFraction: 1 },
        { id: 'g2', passengerIds: ['p3'], orderItemId: 'i1', roomFraction: 0.5, sharedRoomId: 'sr1' },
      ],
    );
    expect(out).toEqual({ i1: 1.5 });
  });
});

describe('computeSharedRoomPhysicalByDate / Buckets：按作用域分桶', () => {
  it('随机档作用域按 randomStarTier 查、不带 hotelId；档次房逐晚去重计 1', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        checkIn: day(0),
        checkOut: day(2),
        members: [
          { order: { status: 'PAID', deletedAt: null } },
          { order: { status: 'PAID', deletedAt: null } },
          { order: { status: 'CANCELLED', deletedAt: null } },
        ],
      },
    ]);
    const client = { sharedRoom: { findMany } } as unknown as PrismaClient;
    const out = await computeSharedRoomPhysicalByDate({ randomStarTier: 4 }, [dayStr(0), dayStr(1), dayStr(2)], client);
    expect(out).toEqual([1, 1, 0]);
    const where = (findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where.randomStarTier).toBe(4);
    expect(where).not.toHaveProperty('hotelId');
  });

  it('字符串入参仍按 hotelId 作用域（向后兼容）', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { sharedRoom: { findMany } } as unknown as PrismaClient;
    await computeSharedRoomPhysicalByDate('h1', [dayStr(0)], client);
    const where = (findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where.hotelId).toBe('h1');
    expect(where).not.toHaveProperty('randomStarTier');
  });

  it('Buckets：酒店房进 byHotelId、档次房进 byTier，互不串桶；无有效成员的房不计', async () => {
    const client = {
      sharedRoom: {
        findMany: vi.fn().mockResolvedValue([
          { hotelId: 'h1', randomStarTier: null, checkIn: day(0), checkOut: day(1), members: [{ order: { status: 'PAID', deletedAt: null } }] },
          { hotelId: null, randomStarTier: 4, checkIn: day(0), checkOut: day(2), members: [{ order: { status: 'PAID', deletedAt: null } }] },
          { hotelId: null, randomStarTier: 4, checkIn: day(1), checkOut: day(2), members: [{ order: { status: 'PAID', deletedAt: null } }] },
          { hotelId: null, randomStarTier: 3, checkIn: day(0), checkOut: day(1), members: [{ order: { status: 'CANCELLED', deletedAt: null } }] },
        ]),
      },
    } as unknown as PrismaClient;
    const b = await computeSharedRoomPhysicalBuckets([dayStr(0), dayStr(1)], client);
    expect(b.byHotelId.get('h1')).toEqual([1, 0]);
    expect(b.byTier.get(4)).toEqual([1, 2]);
    expect(b.byTier.has(3)).toBe(false);
  });

  it('Buckets：mock client 没有 sharedRoom delegate → 空桶不抛错', async () => {
    const b = await computeSharedRoomPhysicalBuckets([dayStr(0)], {} as unknown as PrismaClient);
    expect(b.byHotelId.size).toBe(0);
    expect(b.byTier.size).toBe(0);
  });
});

describe('assertRandomTierFitAfterChange：随机档床位口径「变更前后」闸', () => {
  function tierTx(opts: { blockRooms: number; hotelUsed?: number; pendingUsed?: number; hasHotels?: boolean }) {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const hotelFindMany = vi.fn().mockResolvedValue(opts.hasHotels === false ? [] : [{ id: 'h1' }]);
    const periodFindMany = vi.fn().mockResolvedValue(
      opts.blockRooms > 0 ? [{ dateFrom: day(0), dateTo: day(1), rooms: opts.blockRooms }] : [],
    );
    const item = (rooms: number) => ({ hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: rooms, metadata: null });
    const orderItemFindMany = vi
      .fn()
      .mockResolvedValueOnce(opts.hotelUsed ? [item(opts.hotelUsed)] : [])
      .mockResolvedValueOnce(opts.pendingUsed ? [item(opts.pendingUsed)] : []);
    const tx = {
      $queryRaw: queryRaw,
      hotel: { findMany: hotelFindMany },
      hotelBlockPeriod: { findMany: periodFindMany },
      orderItem: { findMany: orderItemFindMany },
    } as unknown as Prisma.TransactionClient;
    return { tx, queryRaw, periodFindMany };
  }
  const nights = [dayStr(0)];

  it('增量 ≤ 0（合住只会减少或不变）→ 不锁周期、不读聚合、直接放行', async () => {
    const { tx, queryRaw, periodFindMany } = tierTx({ blockRooms: 0 });
    await expect(
      assertRandomTierFitAfterChange(tx, 4, nights, {
        billedDeltas: [
          { hotelCheckIn: day(0), hotelCheckOut: day(1), delta: -1 },
          { hotelCheckIn: day(0), hotelCheckOut: day(1), delta: 0 },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
    expect(periodFindMany).not.toHaveBeenCalled();
  });

  it('增量 > 0 但同星级合计余量够 → 放行（先锁周期再读）', async () => {
    const { tx, queryRaw } = tierTx({ blockRooms: 3, hotelUsed: 1, pendingUsed: 1 }); // remaining = 1
    await expect(
      assertRandomTierFitAfterChange(tx, 4, nights, {
        billedDeltas: [{ hotelCheckIn: day(0), hotelCheckOut: day(1), delta: 0.5 }],
      }),
    ).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalled();
  });

  it('增量 > 0 且超出合计余量 → 400，文案带档次名与夜晚', async () => {
    const { tx } = tierTx({ blockRooms: 2, hotelUsed: 1, pendingUsed: 1 }); // remaining = 0
    await expect(
      assertRandomTierFitAfterChange(tx, 4, nights, {
        billedDeltas: [{ hotelCheckIn: day(0), hotelCheckOut: day(1), delta: 0.5 }],
      }),
    ).rejects.toThrow(/四星随机余量不足.*2026-10-01/);
  });

  it('该档整段没有任何包房周期（未纳管）→ 增量 > 0 也放行', async () => {
    const { tx } = tierTx({ blockRooms: 0, pendingUsed: 5 });
    await expect(
      assertRandomTierFitAfterChange(tx, 3, nights, {
        billedDeltas: [{ hotelCheckIn: day(0), hotelCheckOut: day(1), delta: 1 }],
      }),
    ).resolves.toBeUndefined();
  });
});

describe('getSharedRoomWorkbench · 随机档作用域', () => {
  it('候选 = 形态① ∪ 形态②（OR 两支），房型名统一「X星随机（待落位）」，共享房按 randomStarTier 查', async () => {
    const orderItemFindMany = vi.fn().mockResolvedValue([
      {
        id: 'i1',
        roomsBilled: 1,
        randomStarTier: 4,
        hotelRoomType: null, // 形态①
        order: {
          id: 'o1',
          orderNumber: 'FTM-1',
          status: 'PAID',
          agentId: null,
          sameHotelWith: null,
          roomAssignment: null,
          passengers: [{ id: 'p1', fullName: 'A', chineseName: null, gender: 'M' }],
        },
      },
      {
        id: 'i2',
        roomsBilled: 1,
        randomStarTier: null,
        hotelRoomType: { id: 'rt-ph', name: '占位房型', hotel: { randomTierPlaceholder: 4 } }, // 形态②
        order: {
          id: 'o2',
          orderNumber: 'FTM-2',
          status: 'PAID',
          agentId: null,
          sameHotelWith: null,
          roomAssignment: null,
          passengers: [{ id: 'p2', fullName: 'B', chineseName: null, gender: 'F' }],
        },
      },
    ]);
    const sharedRoomFindMany = vi.fn().mockResolvedValue([
      {
        id: 'sr1',
        hotelId: null,
        hotelRoomTypeId: null,
        randomStarTier: 4,
        version: 2,
        notes: null,
        members: [
          {
            orderId: 'o1',
            orderItemId: 'i1',
            passengerId: 'p1',
            roomFraction: 1,
            order: { status: 'PAID', deletedAt: null, orderNumber: 'FTM-1' },
            passenger: { fullName: 'A', chineseName: null },
          },
        ],
      },
    ]);
    const client = {
      orderItem: { findMany: orderItemFindMany },
      sharedRoom: { findMany: sharedRoomFindMany },
    } as unknown as PrismaClient;

    const wb = await getSharedRoomWorkbench({ randomStarTier: 4 }, dayStr(0), dayStr(1), client);
    expect(wb.hotelId).toBeNull();
    expect(wb.randomStarTier).toBe(4);
    const itemWhere = (orderItemFindMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(itemWhere.OR).toEqual([
      { hotelRoomTypeId: null, randomStarTier: 4 },
      { hotelRoomType: { hotel: { randomTierPlaceholder: 4 } } },
    ]);
    expect(wb.orders.map((o) => o.orderId).sort()).toEqual(['o1', 'o2']);
    for (const o of wb.orders) {
      expect(o.items[0]!.randomStarTier).toBe(4);
      expect(o.items[0]!.roomTypeName).toBe('四星随机（待落位）');
    }
    const roomWhere = (sharedRoomFindMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(roomWhere.randomStarTier).toBe(4);
    expect(roomWhere).not.toHaveProperty('hotelId');
    expect(wb.sharedRooms[0]).toMatchObject({ sharedRoomId: 'sr1', hotelId: null, hotelRoomTypeId: null, randomStarTier: 4 });
  });

  it('酒店作用域（字符串入参）不变：按 hotelRoomType.hotelId 查、返回 randomStarTier=null', async () => {
    const orderItemFindMany = vi.fn().mockResolvedValue([]);
    const sharedRoomFindMany = vi.fn().mockResolvedValue([]);
    const client = {
      orderItem: { findMany: orderItemFindMany },
      sharedRoom: { findMany: sharedRoomFindMany },
    } as unknown as PrismaClient;
    const wb = await getSharedRoomWorkbench('h1', dayStr(0), dayStr(1), client);
    expect(wb.hotelId).toBe('h1');
    expect(wb.randomStarTier).toBeNull();
    const itemWhere = (orderItemFindMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(itemWhere.hotelRoomType).toEqual({ hotelId: 'h1' });
  });
});
