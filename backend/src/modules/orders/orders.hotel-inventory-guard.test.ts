/**
 * 酒店房量闸（事务内互斥版）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 背景：座位有 CAS 防超卖，房量此前只有套餐分支在**事务外**做了一次只读前瞻判定，
 * 单独 HOTEL 行（指定房型）与补录房费更是一道闸都没有 —— 售罄后照样落库占房，销控板变负。
 *
 * 覆盖：
 *   1. assertHotelStaysFitWithinTx：判定口径 / 先锁后读 / 同单多行合并 / 占位酒店跳过 / 文案分流。
 *   2. createOrder 指定房型 HOTEL 行：售罄拒单且订单不落库；房量够时正常落库且加过行锁。
 *   3. addGroundItem 补录房费：同一把闸，且不排除本单自身的存量占房。
 *
 * 房量闸用的是**真实**的 hotel-control 模块（不 mock）：闸的正确性正是要验的东西，
 * mock 掉就只剩「调没调用」这种空壳断言。prisma / tx 侧才是 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    orderItem: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    orderCostItem: { create: vi.fn() },
    passenger: { findMany: vi.fn(), count: vi.fn() },
    hotelRoomType: { findUnique: vi.fn(), findMany: vi.fn() },
    hotelBlockPeriod: { findMany: vi.fn() },
    flightSchedule: { findMany: vi.fn(), findUnique: vi.fn() },
    flightSeatClass: { findFirst: vi.fn() },
    seatLock: { aggregate: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    fulfillmentTask: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    agent: { findUnique: vi.fn() },
    visa: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import {
  OrderService,
  assertHotelStaysFitWithinTx,
  assertRandomTierStaysFitWithinTx,
  HOTEL_SOLD_OUT_MESSAGE,
} from './orders.service.js';
import { BadRequestError } from '../../lib/errors.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;

/** 调用顺序留痕：房量闸必须**先加行锁再读占房**，否则锁毫无意义。*/
const callTrace: string[] = [];

type FitFixture = {
  /** 该酒店该区间每晚包房间数；null = 一条周期都没有（未纳入管控）。*/
  blockRooms?: number | null;
  /** 已存在的占房行（床位口径 roomsBilled，各占整段）。*/
  existingRooms?: number[];
  /** hotelRoomType → hotelId / 占位档次。*/
  roomTypes?: Array<{ id: string; hotelId: string; randomTierPlaceholder?: number | null }>;
};

function buildFitTx(f: FitFixture = {}) {
  const blockRooms = f.blockRooms === undefined ? 2 : f.blockRooms;
  return {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('HotelBlockPeriod')) callTrace.push('LOCK_BLOCK_PERIODS');
      else if (sql.includes('"Order"')) callTrace.push('LOCK_ORDER');
      return [{ id: 'locked-row' }];
    }),
    $executeRaw: vi.fn(async () => 1),
    hotelRoomType: {
      findMany: vi.fn(async () =>
        (f.roomTypes ?? [{ id: 'rt-1', hotelId: 'hotel-1' }]).map((rt) => ({
          id: rt.id,
          hotelId: rt.hotelId,
          hotel: { randomTierPlaceholder: rt.randomTierPlaceholder ?? null },
        })),
      ),
      findUnique: vi.fn(),
    },
    hotelBlockPeriod: {
      findMany: vi.fn(async () => {
        callTrace.push('READ_BLOCK_PERIODS');
        return blockRooms == null
          ? []
          : [
              {
                dateFrom: new Date('2026-09-01T00:00:00.000Z'),
                dateTo: new Date('2026-09-30T00:00:00.000Z'),
                rooms: blockRooms,
              },
            ];
      }),
    },
    orderItem: {
      findMany: vi.fn(async () => {
        callTrace.push('READ_OCCUPANCY');
        return (f.existingRooms ?? []).map((rooms, i) => ({
          hotelCheckIn: new Date('2026-09-01T00:00:00.000Z'),
          hotelCheckOut: new Date('2026-09-03T00:00:00.000Z'),
          roomsBilled: new Prisma.Decimal(rooms),
          metadata: null,
          order: { id: `other-order-${i}`, roomAssignment: null, passengers: [] },
          flightScheduleId: null,
          flightSchedule: null,
        }));
      }),
      create: vi.fn(async () => ({ id: 'new-item' })),
      update: vi.fn(),
    },
    passenger: { findMany: vi.fn(async () => []), count: vi.fn(async () => 1) },
    orderCostItem: { create: vi.fn() },
    fulfillmentTask: { create: vi.fn(), findMany: vi.fn(async () => []) },
    order: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  };
}

const STAY = {
  hotelRoomTypeId: 'rt-1',
  hotelCheckIn: new Date('2026-09-01T00:00:00.000Z'),
  hotelCheckOut: new Date('2026-09-03T00:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  callTrace.length = 0;
});

// ══════════════════════════════════════════════════════════════════════════
describe('assertHotelStaysFitWithinTx · 事务内带行锁的物理房量闸', () => {
  it('包房 2 间、已占 2 间，再来 1 间 → 拒，且回中性话术（不泄露包房间数）', async () => {
    const tx = buildFitTx({ blockRooms: 2, existingRooms: [1, 1] });

    await expect(
      assertHotelStaysFitWithinTx(tx as never, [{ ...STAY, roomsBilled: 1 }], [], {
        buildMessage: () => HOTEL_SOLD_OUT_MESSAGE,
      }),
    ).rejects.toThrow(new BadRequestError(HOTEL_SOLD_OUT_MESSAGE));
  });

  it('包房 2 间、已占 1 间，再来 1 间 → 放行（恰好装满不算超卖）', async () => {
    const tx = buildFitTx({ blockRooms: 2, existingRooms: [1] });

    await expect(
      assertHotelStaysFitWithinTx(tx as never, [{ ...STAY, roomsBilled: 1 }], []),
    ).resolves.toBeUndefined();
  });

  it('未配包房周期（未纳入管控）→ 不拦截（房控哲学：未配包房 ≠ 售罄）', async () => {
    const tx = buildFitTx({ blockRooms: null, existingRooms: [9, 9, 9] });

    await expect(
      assertHotelStaysFitWithinTx(tx as never, [{ ...STAY, roomsBilled: 5 }], []),
    ).resolves.toBeUndefined();
  });

  it('必须先 FOR UPDATE 锁包房周期行、再读包房量/占房 —— 判定与落库之间不能有窗口', async () => {
    const tx = buildFitTx({ blockRooms: 5, existingRooms: [] });

    await assertHotelStaysFitWithinTx(tx as never, [{ ...STAY, roomsBilled: 1 }], []);

    expect(callTrace[0]).toBe('LOCK_BLOCK_PERIODS');
    expect(callTrace).toContain('READ_BLOCK_PERIODS');
    expect(callTrace).toContain('READ_OCCUPANCY');
    expect(callTrace.indexOf('LOCK_BLOCK_PERIODS')).toBeLessThan(
      callTrace.indexOf('READ_BLOCK_PERIODS'),
    );
  });

  it('同单同酒店同区间的两条行合并成一笔前瞻占房 —— 逐行各判一次会双双放行', async () => {
    // 包房 2 间、已占 1 间 → 余 1 间；本次要落两条各 1 间的行。
    // 逐行判定：每行各自看到「还剩 1 间」→ 两行都过 → 落库后占 3 间（超卖 1 间）。
    const tx = buildFitTx({ blockRooms: 2, existingRooms: [1] });

    await expect(
      assertHotelStaysFitWithinTx(
        tx as never,
        [
          { ...STAY, roomsBilled: 1 },
          { ...STAY, roomsBilled: 1 },
        ],
        [],
      ),
    ).rejects.toThrow(BadRequestError);
    // 合并后对该酒店该区间只加一次锁、只判一次
    expect(callTrace.filter((c) => c === 'LOCK_BLOCK_PERIODS')).toHaveLength(1);
  });

  it('房型挂在随机档占位酒店上 → 跳过本闸（那不是真房源，走随机档聚合闸）', async () => {
    const tx = buildFitTx({
      blockRooms: 1,
      existingRooms: [9],
      roomTypes: [{ id: 'rt-1', hotelId: 'hotel-placeholder', randomTierPlaceholder: 4 }],
    });

    await expect(
      assertHotelStaysFitWithinTx(tx as never, [{ ...STAY, roomsBilled: 3 }], []),
    ).resolves.toBeUndefined();
    expect(callTrace).not.toContain('LOCK_BLOCK_PERIODS');
  });

  it('无房型 / 无入住日期的行（未落位随机单等）→ 一条都不查库，直接返回', async () => {
    const tx = buildFitTx();

    await assertHotelStaysFitWithinTx(
      tx as never,
      [
        {
          hotelRoomTypeId: null,
          hotelCheckIn: STAY.hotelCheckIn,
          hotelCheckOut: STAY.hotelCheckOut,
        },
        { hotelRoomTypeId: 'rt-1', hotelCheckIn: null, hotelCheckOut: null },
      ],
      [],
    );

    expect(tx.hotelRoomType.findMany).not.toHaveBeenCalled();
    expect(callTrace).toHaveLength(0);
  });

  it('后台路径不传 buildMessage → 用带数字的明细文案（运营要看得见差多少间）', async () => {
    const tx = buildFitTx({ blockRooms: 1, existingRooms: [1] });

    const err = (await assertHotelStaysFitWithinTx(
      tx as never,
      [{ ...STAY, roomsBilled: 1 }],
      [],
    ).catch((e: Error) => e)) as Error;

    expect(err.message).toContain('酒店实际房间不足');
    expect(err.message).toContain('2026-09-01');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('createOrder · 指定房型 HOTEL 行的房量闸（CRITICAL）', () => {
  const body = {
    contactName: '联系人',
    contactPhone: '13800000000',
    items: [
      {
        kind: 'HOTEL' as const,
        description: '明月酒店 · 标准间 · 2 晚 × 1 间',
        quantity: 2,
        unitPrice: 500,
        hotelRoomTypeId: 'rt-1',
        checkIn: '2026-09-01',
        checkOut: '2026-09-03',
        roomsBilled: 1,
      },
    ],
    passengers: [
      {
        fullName: '张三',
        documentType: 'PASSPORT' as const,
        documentNumber: 'E12345678',
        dateOfBirth: '1990-01-01',
        nationality: 'CN',
        passengerType: 'ADULT' as const,
        gender: 'M' as const,
        passportExpiry: '2031-01-01',
      },
    ],
  };

  function mountCreateOrder(f: FitFixture) {
    const tx = buildFitTx(f);
    tx.order.create = vi.fn(async () => {
      callTrace.push('CREATE_ORDER');
      return {
        id: 'ord-new',
        orderNumber: 'FTM-NEW',
        items: [],
        passengers: [],
        statusEvents: [],
        paymentExpiresAt: null,
        total: new Prisma.Decimal(1000),
      };
    });
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    // 权威定价：房型单价从 DB 取（不信前端）
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue({
      basePrice: new Prisma.Decimal(500),
      costPriceCny: null,
      hotel: { isActive: true },
    });
    mockPrisma.passenger.findMany.mockResolvedValue([]);
    mockPrisma.flightSchedule.findMany.mockResolvedValue([]);
    // 事务提交后的 best-effort 建签证任务（失败只打日志、不影响本用例）——给一份空结果保持输出干净。
    mockPrisma.orderItem.findMany.mockResolvedValue([]);
    return tx;
  }

  it('目标酒店当晚已售罄 → 拒单（中性话术），且订单绝不落库', async () => {
    const tx = mountCreateOrder({ blockRooms: 2, existingRooms: [1, 1] });

    await expect(service.createOrder(body as never, ADMIN)).rejects.toThrow(HOTEL_SOLD_OUT_MESSAGE);
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('房量够 → 正常落库，且闸确实在写订单之前加过包房周期行锁', async () => {
    const tx = mountCreateOrder({ blockRooms: 5, existingRooms: [1] });

    await service.createOrder(body as never, ADMIN).catch(() => undefined);

    expect(tx.order.create).toHaveBeenCalled();
    expect(callTrace).toContain('LOCK_BLOCK_PERIODS');
    expect(callTrace.indexOf('LOCK_BLOCK_PERIODS')).toBeLessThan(callTrace.indexOf('CREATE_ORDER'));
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('addGroundItem · 补录房费的房量闸（同源无闸）', () => {
  const input = {
    kind: 'HOTEL' as const,
    hotelRoomTypeId: 'rt-1',
    nights: 2,
    rooms: 1,
    checkIn: '2026-09-01',
    unitPriceCny: 500,
  };

  function mountGroundItem(f: FitFixture) {
    const tx = buildFitTx(f);
    tx.order.findUnique = vi.fn(async () => ({
      id: 'ord-1',
      orderNumber: 'FTM-1',
      status: 'PAID',
      deletedAt: null,
      visaStatus: null,
      subtotal: new Prisma.Decimal(1000),
      total: new Prisma.Decimal(1000),
      items: [{ amount: new Prisma.Decimal(1000) }],
    }));
    tx.hotelRoomType.findUnique = vi.fn(async () => ({
      id: 'rt-1',
      name: '标准间',
      costPriceCny: new Prisma.Decimal(300),
      hotel: { name: '明月酒店', isActive: true },
    }));
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    return tx;
  }

  it('该酒店当晚已满 → 拒绝补录，行不落库', async () => {
    const tx = mountGroundItem({ blockRooms: 2, existingRooms: [1, 1] });

    await expect(service.addGroundItem('ord-1', input as never, ADMIN)).rejects.toThrow(
      /酒店实际房间不足/,
    );
    expect(tx.orderItem.create).not.toHaveBeenCalled();
  });

  it('房量够 → 照常补录（闸不误伤正常路径）', async () => {
    const tx = mountGroundItem({ blockRooms: 5, existingRooms: [1] });

    await service.addGroundItem('ord-1', input as never, ADMIN).catch(() => undefined);

    expect(tx.orderItem.create).toHaveBeenCalled();
  });

  it('本单在该酒店已有的占房算存量、不排除自己 —— 排除等于把自己占的房当空房', async () => {
    const tx = mountGroundItem({ blockRooms: 2, existingRooms: [2] });

    await expect(service.addGroundItem('ord-1', input as never, ADMIN)).rejects.toThrow(
      /酒店实际房间不足/,
    );
    // 占房查询里不得出现 excludeOrderId 派生的 `id: { not: … }`
    const where = (tx.orderItem.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.order.id).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 随机档聚合余量闸（事务内带行锁版）
// 与上面那道真酒店物理闸互补：未落位的随机档行占的是「同星级酒店合计余量」。
// 此前建单路径只在**事务外**跑只读版聚合判定 —— 两笔并发单抢同星级最后一间会各自读到
// 「还剩 1 间」的旧快照双双通过，落库后超卖。
// ══════════════════════════════════════════════════════════════════════════
type RandomTierFixture = {
  /** 该档次真酒店该区间每晚包房间数；null = 一条周期都没有（未纳入管控）。*/
  blockRooms?: number | null;
  /** 该档次已存在的未落位占用（床位口径，各占整段）。*/
  pendingRooms?: number[];
  /** 该档次已落位真酒店的占用。*/
  hotelRooms?: number[];
  /** hotelRoomType → 占位档次（非空 = 随机档占位酒店的伪房型）。*/
  roomTypes?: Array<{ id: string; randomTierPlaceholder: number | null }>;
};

function buildRandomTierTx(f: RandomTierFixture = {}) {
  const blockRooms = f.blockRooms === undefined ? 2 : f.blockRooms;
  const rows = (list: number[] | undefined) =>
    (list ?? []).map((rooms) => ({
      hotelCheckIn: new Date('2026-09-01T00:00:00.000Z'),
      hotelCheckOut: new Date('2026-09-03T00:00:00.000Z'),
      roomsBilled: new Prisma.Decimal(rooms),
      metadata: null,
    }));
  return {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('HotelBlockPeriod')) callTrace.push('LOCK_BLOCK_PERIODS');
      return [{ id: 'locked-row' }];
    }),
    hotel: {
      findMany: vi.fn(async () => {
        callTrace.push('READ_TIER_HOTELS');
        return [{ id: 'hotel-a' }, { id: 'hotel-b' }];
      }),
    },
    hotelRoomType: {
      findMany: vi.fn(async () =>
        (f.roomTypes ?? []).map((rt) => ({
          id: rt.id,
          hotel: { randomTierPlaceholder: rt.randomTierPlaceholder },
        })),
      ),
    },
    hotelBlockPeriod: {
      findMany: vi.fn(async () => {
        callTrace.push('READ_BLOCK_PERIODS');
        return blockRooms == null
          ? []
          : [
              {
                dateFrom: new Date('2026-09-01T00:00:00.000Z'),
                dateTo: new Date('2026-09-30T00:00:00.000Z'),
                rooms: blockRooms,
              },
            ];
      }),
    },
    orderItem: {
      // 聚合闸分两次查占用：已落位（where.hotelRoomTypeId.not）与未落位（where.OR）。
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        callTrace.push('READ_OCCUPANCY');
        return args.where.OR ? rows(f.pendingRooms) : rows(f.hotelRooms);
      }),
    },
  };
}

/** 一条未落位随机档占房（后台直接录「四星随机」）。*/
const RANDOM_STAY = {
  hotelRoomTypeId: null,
  randomStarTier: 4,
  hotelCheckIn: new Date('2026-09-01T00:00:00.000Z'),
  hotelCheckOut: new Date('2026-09-03T00:00:00.000Z'),
};

describe('assertRandomTierStaysFitWithinTx · 事务内带行锁的随机档聚合闸', () => {
  it('同星级包房 2 间、已占 1 间，再来 1 间 → 放行（恰好装满不算超卖）', async () => {
    const tx = buildRandomTierTx({ blockRooms: 2, pendingRooms: [1] });

    await expect(
      assertRandomTierStaysFitWithinTx(tx as never, [{ ...RANDOM_STAY, roomsBilled: 1 }]),
    ).resolves.toBeUndefined();
  });

  it('同星级包房 2 间、已占 1 间，再来 2 间 → 拒，且回中性话术（不泄露合计余量）', async () => {
    const tx = buildRandomTierTx({ blockRooms: 2, pendingRooms: [1] });

    await expect(
      assertRandomTierStaysFitWithinTx(tx as never, [{ ...RANDOM_STAY, roomsBilled: 2 }], {
        buildMessage: () => HOTEL_SOLD_OUT_MESSAGE,
      }),
    ).rejects.toThrow(new BadRequestError(HOTEL_SOLD_OUT_MESSAGE));
  });

  it('该档次整段没有任何包房周期 → 不拦截（未配包房 ≠ 售罄）', async () => {
    const tx = buildRandomTierTx({ blockRooms: null, pendingRooms: [9] });

    await expect(
      assertRandomTierStaysFitWithinTx(tx as never, [{ ...RANDOM_STAY, roomsBilled: 5 }]),
    ).resolves.toBeUndefined();
  });

  it('必须先 FOR UPDATE 锁该档次全部真酒店的包房周期行、再读余量', async () => {
    const tx = buildRandomTierTx({ blockRooms: 5 });

    await assertRandomTierStaysFitWithinTx(tx as never, [{ ...RANDOM_STAY, roomsBilled: 1 }]);

    expect(callTrace).toContain('LOCK_BLOCK_PERIODS');
    expect(callTrace.indexOf('LOCK_BLOCK_PERIODS')).toBeLessThan(
      callTrace.indexOf('READ_BLOCK_PERIODS'),
    );
  });

  it('同单同档次同区间的两条行合并成一笔 —— 逐行各判一次会双双放行', async () => {
    // 余 1 间；本次要落两条各 1 间的随机档行 → 合并后 2 间 > 1 间 → 拒。
    const tx = buildRandomTierTx({ blockRooms: 2, pendingRooms: [1] });

    await expect(
      assertRandomTierStaysFitWithinTx(tx as never, [
        { ...RANDOM_STAY, roomsBilled: 1 },
        { ...RANDOM_STAY, roomsBilled: 1 },
      ]),
    ).rejects.toThrow(BadRequestError);
    // 合并后对该档次只加一次锁、只判一次
    expect(callTrace.filter((c) => c === 'LOCK_BLOCK_PERIODS')).toHaveLength(1);
  });

  it('房型挂在随机档占位酒店上（套餐绑定占位房型）→ 同样归本闸，档次取 randomTierPlaceholder', async () => {
    const tx = buildRandomTierTx({
      blockRooms: 1,
      pendingRooms: [1],
      roomTypes: [{ id: 'rt-placeholder', randomTierPlaceholder: 4 }],
    });

    await expect(
      assertRandomTierStaysFitWithinTx(tx as never, [
        {
          hotelRoomTypeId: 'rt-placeholder',
          hotelCheckIn: RANDOM_STAY.hotelCheckIn,
          hotelCheckOut: RANDOM_STAY.hotelCheckOut,
          roomsBilled: 1,
        },
      ]),
    ).rejects.toThrow(BadRequestError);
  });

  it('具体真酒店的房型行 → 跳过本闸（走物理房量闸），一条都不锁', async () => {
    const tx = buildRandomTierTx({
      blockRooms: 1,
      pendingRooms: [1],
      roomTypes: [{ id: 'rt-real', randomTierPlaceholder: null }],
    });

    await expect(
      assertRandomTierStaysFitWithinTx(tx as never, [
        {
          hotelRoomTypeId: 'rt-real',
          hotelCheckIn: RANDOM_STAY.hotelCheckIn,
          hotelCheckOut: RANDOM_STAY.hotelCheckOut,
          roomsBilled: 9,
        },
      ]),
    ).resolves.toBeUndefined();
    expect(callTrace).not.toContain('LOCK_BLOCK_PERIODS');
  });

  it('无入住日期的行（纯机票行等）→ 一条都不查库，直接返回', async () => {
    const tx = buildRandomTierTx();

    await assertRandomTierStaysFitWithinTx(tx as never, [
      { hotelRoomTypeId: null, hotelCheckIn: null, hotelCheckOut: null },
    ]);

    expect(tx.hotelRoomType.findMany).not.toHaveBeenCalled();
    expect(callTrace).toHaveLength(0);
  });
});
