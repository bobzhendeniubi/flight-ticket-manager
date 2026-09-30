/**
 * 改期 · 住宿处理方式（hotelMode）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 运营需求：改期时弹「房是否一起变动」——选是则住宿按新行程重排、不改档、价格只加手填改期费。
 *   FOLLOW_TRIP  入住/离店锚定新去程/回程出发日（保留原相对偏移），晚数增减；成本按实住晚数重打快照；
 *                行价冻结；单程单退化为 SHIFT。
 *   SHIFT        缺省 = 既有整体平移保晚数（未显式传参的调用方行为不变）。
 *   KEEP         住宿不动。
 * 权限：非缺省只认 ADMIN/STAFF，代理传了 403。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    orderItem: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(async () => 0),
    },
    passenger: { findMany: vi.fn(), updateMany: vi.fn() },
    flightSeatClass: { findFirst: vi.fn() },
    flightSchedule: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
    hotelRoomType: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
    hotelBlockPeriod: { findMany: vi.fn(async () => []) },
    seatLock: { aggregate: vi.fn(async () => ({ _sum: { qty: 0 } })) },
    receipt: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(), findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma)),
    $queryRaw: vi.fn(async () => [{ id: 'ord1' }]),
    $executeRaw: vi.fn(async () => 1),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../hotel-control/hotel-control.service.js', () => ({
  getHotelNightlyRemaining: vi.fn(),
  assertRandomTierFit: vi.fn(),
  // 随机档行的事务内聚合闸：这里只测日期/成本写入，闸放行（返回无超卖明细）。
  assertRandomTierFitWithinTx: vi.fn(async () => []),
  getHotelOversellCapRooms: async () => 3,
  floorProspectiveOccupancyByAssignedRooms: (prospective: unknown) => prospective,
  floorZeroRoomsBilledByAssignedRooms: (roomsBilled: unknown) => roomsBilled,
}));
vi.mock('../../queues/queue.js', () => ({
  enqueueWaitlistCheck: vi.fn(),
  scheduleSeatHoldRelease: vi.fn(),
}));

import { OrderService, planFollowTripHotelStay } from './orders.service.js';
import { ForbiddenError } from '../../lib/errors.js';

const ADMIN = { userId: 'admin1', role: 'ADMIN' } as const;
const dec = (n: number) => ({ toString: () => String(n) });

function fakeFullOrder() {
  return {
    id: 'ord1',
    orderNumber: 'ORD-001',
    userId: 'me',
    agentId: null,
    status: 'PAID',
    subtotal: dec(100),
    taxesAndFees: dec(0),
    discountTotal: dec(0),
    total: dec(100),
    paidAmount: dec(100),
    prepaymentOffset: dec(0),
    totalAmount: dec(100),
    currency: 'CNY',
    contactName: 'X',
    contactPhone: 'Y',
    contactEmail: null,
    paymentExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [],
    passengers: [],
    payments: [],
    refunds: [],
    statusEvents: [],
    agent: null,
    user: { id: 'me', displayName: null, email: null },
  };
}

type Leg = { id: string; scheduleId: string; departIso: string };
type HotelRow = {
  id: string;
  kind: 'HOTEL' | 'BUNDLE';
  description: string;
  hotelRoomTypeId: string | null;
  randomStarTier: number | null;
  hotelCheckIn: Date;
  hotelCheckOut: Date | null;
  roomsBilled: { toString: () => string } | null;
  unitCostCny?: { toString: () => string } | null;
  metadata?: Record<string, unknown> | null;
};

const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

const HOTEL_ROW = (over: Partial<HotelRow> = {}): HotelRow => ({
  id: 'hot1',
  kind: 'HOTEL',
  description: '海边酒店 · 标准房 · 2027-09-22~2027-09-23 · 1晚 × 1间',
  hotelRoomTypeId: 'rt1',
  randomStarTier: null,
  hotelCheckIn: day('2027-09-22'),
  hotelCheckOut: day('2027-09-23'),
  roomsBilled: dec(1),
  unitCostCny: dec(100),
  metadata: {},
  ...over,
});

/**
 * 挂一张可改期的订单：legsBefore = 改期前航段；改的是 target 行，改到 newDepartIso 的 sched-new。
 * findMany 三路分发：机票行（改期后重查，被改行已是新班次）/ 占房行 / 立减行。
 */
function mount(opts: {
  legsBefore: Leg[];
  targetItemId: string;
  newDepartIso: string;
  hotelRows: HotelRow[];
  roomTypeCost?: number | null;
}): void {
  const target = opts.legsBefore.find((l) => l.id === opts.targetItemId)!;
  mockPrisma.order.findUnique.mockReset().mockResolvedValue({
    id: 'ord1',
    status: 'PAID',
    deletedAt: null,
    adjustmentCny: 0,
    adjustments: [],
    createdAt: new Date('2027-01-01T00:00:00.000Z'),
    outboundInvoiced: false,
    returnInvoiced: false,
    systemInvoiced: false,
    settlementLocked: false,
  });
  mockPrisma.orderItem.findUnique.mockReset().mockResolvedValue({
    id: target.id,
    orderId: 'ord1',
    kind: 'FLIGHT',
    quantity: 1,
    bundleId: null,
    flightScheduleId: target.scheduleId,
    flightCabin: 'ECONOMY',
    metadata: {},
    flightSchedule: { departureTime: new Date(target.departIso), departureTz: null },
  });
  mockPrisma.orderItem.findMany.mockReset().mockImplementation(
    async (args: { where?: { kind?: string; hotelCheckIn?: unknown } }) => {
      if (args.where?.hotelCheckIn) return opts.hotelRows.map((r) => ({ ...r }));
      if (args.where?.kind === 'DISCOUNT') return [];
      return opts.legsBefore.map((l) =>
        l.id === target.id
          ? {
              id: l.id,
              flightScheduleId: 'sched-new',
              metadata: {},
              flightSchedule: { departureTime: new Date(opts.newDepartIso), departureTz: null },
            }
          : {
              id: l.id,
              flightScheduleId: l.scheduleId,
              metadata: {},
              flightSchedule: { departureTime: new Date(l.departIso), departureTz: null },
            },
      );
    },
  );
  mockPrisma.hotelRoomType.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.hotelRoomType.findUnique.mockReset().mockResolvedValue({
    id: 'rt1',
    costPriceCny: opts.roomTypeCost === undefined ? 100 : opts.roomTypeCost,
    costPriceVnd: null,
    costFxName: null,
    costPeriods: [],
  });
  mockPrisma.passenger.findMany.mockReset().mockResolvedValue([{ gender: 'M' }]);
  mockPrisma.passenger.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.flightSeatClass.findFirst.mockReset().mockResolvedValue({
    id: 'seat-new',
    schedule: { departureTime: new Date(opts.newDepartIso), departureTz: null },
  });
  mockPrisma.orderItem.update.mockReset().mockResolvedValue({});
  mockPrisma.order.update.mockReset().mockResolvedValue({});
  mockPrisma.flightSchedule.findUnique.mockReset().mockResolvedValue({
    departureTime: new Date(target.departIso),
    departureTz: null,
    flight: { flightNumber: 'XX101' },
  });
  mockPrisma.order.findUniqueOrThrow.mockReset().mockResolvedValue(fakeFullOrder());
}

function itemWrite(id: string): Record<string, unknown> | undefined {
  return mockPrisma.orderItem.update.mock.calls
    .map((call) => call[0] as { where: { id: string }; data: Record<string, unknown> })
    .find((arg) => arg.where.id === id)?.data;
}

function newService(): OrderService {
  const service = new OrderService();
  vi.spyOn(service, '_updateStatusWithinTx').mockResolvedValue(undefined as never);
  return service;
}

/** 去程 9/22、回程 9/23 的往返单（酒店 22~23，1 晚）。 */
const ROUND_TRIP: Leg[] = [
  { id: 'fl-out', scheduleId: 'sched-out', departIso: '2027-09-22T02:00:00.000Z' },
  { id: 'fl-ret', scheduleId: 'sched-ret', departIso: '2027-09-23T02:00:00.000Z' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rescheduleOrderItem · hotelMode=FOLLOW_TRIP（房跟着新行程走）', () => {
  it('去程 9/22 → 9/21、回程不动 → 住宿 21~23（1 晚 → 2 晚），行价冻结，成本按新晚数重打快照，审计带 mode/晚数', async () => {
    const service = newService();
    mount({
      legsBefore: ROUND_TRIP,
      targetItemId: 'fl-out',
      newDepartIso: '2027-09-21T02:00:00.000Z',
      hotelRows: [HOTEL_ROW()],
    });

    const result = await service.rescheduleOrderItem(
      'ord1',
      { orderItemId: 'fl-out', newScheduleId: 'sched-new', hotelMode: 'FOLLOW_TRIP' },
      ADMIN,
    );

    const write = itemWrite('hot1');
    expect(write?.hotelCheckIn).toEqual(day('2027-09-21'));
    expect(write?.hotelCheckOut).toEqual(day('2027-09-23'));
    expect(write?.description).toBe('海边酒店 · 标准房 · 2027-09-21~2027-09-23 · 2晚 × 1间');
    // 行价冻结：改期不动 amount / unitPrice / quantity / roomsBilled
    expect(write).not.toHaveProperty('amount');
    expect(write).not.toHaveProperty('unitPrice');
    expect(write).not.toHaveProperty('quantity');
    expect(write).not.toHaveProperty('roomsBilled');
    // 成本：按房型净房价逐晚重打（¥100 × 2 晚 × 1 间）
    expect(write?.unitCostCny).toBe(100);
    expect(write?.totalCostCny).toBe(200);
    expect(
      (write?.metadata as { costSource: { nights: number; unitAmountPerNight: number } }).costSource,
    ).toMatchObject({ currency: 'CNY', nights: 2, unitAmountPerNight: 100 });
    expect(result.audit.hotelMode).toBe('FOLLOW_TRIP');
    expect(result.audit.hotelDateSync).toEqual([
      {
        orderItemId: 'hot1',
        mode: 'FOLLOW_TRIP',
        fromCheckIn: '2027-09-22',
        toCheckIn: '2027-09-21',
        fromCheckOut: '2027-09-23',
        toCheckOut: '2027-09-23',
        fromNights: 1,
        toNights: 2,
      },
    ]);
  });

  it('回程 9/25 → 9/23、去程不动 → 住宿 22~25 缩成 22~23（3 晚 → 1 晚），成本随之减少', async () => {
    const service = newService();
    mount({
      legsBefore: [
        ROUND_TRIP[0],
        { id: 'fl-ret', scheduleId: 'sched-ret', departIso: '2027-09-25T02:00:00.000Z' },
      ],
      targetItemId: 'fl-ret',
      newDepartIso: '2027-09-23T02:00:00.000Z',
      hotelRows: [
        HOTEL_ROW({
          description: '海边酒店 · 标准房 · 2027-09-22~2027-09-25 · 3晚 × 1间',
          hotelCheckOut: day('2027-09-25'),
        }),
      ],
    });

    const result = await service.rescheduleOrderItem(
      'ord1',
      { orderItemId: 'fl-ret', newScheduleId: 'sched-new', hotelMode: 'FOLLOW_TRIP' },
      ADMIN,
    );

    const write = itemWrite('hot1');
    expect(write?.hotelCheckIn).toEqual(day('2027-09-22'));
    expect(write?.hotelCheckOut).toEqual(day('2027-09-23'));
    expect(write?.description).toBe('海边酒店 · 标准房 · 2027-09-22~2027-09-23 · 1晚 × 1间');
    expect(write?.totalCostCny).toBe(100);
    expect(result.audit.hotelDateSync[0]).toMatchObject({ mode: 'FOLLOW_TRIP', fromNights: 3, toNights: 1 });
  });

  it('单程单（无回程）退化为整体平移：去程 9/22 → 9/21，住宿 21~22 仍 1 晚，行记 mode=SHIFT、成本不动', async () => {
    const service = newService();
    mount({
      legsBefore: [ROUND_TRIP[0]],
      targetItemId: 'fl-out',
      newDepartIso: '2027-09-21T02:00:00.000Z',
      hotelRows: [HOTEL_ROW()],
    });

    const result = await service.rescheduleOrderItem(
      'ord1',
      { orderItemId: 'fl-out', newScheduleId: 'sched-new', hotelMode: 'FOLLOW_TRIP' },
      ADMIN,
    );

    const write = itemWrite('hot1');
    expect(write?.hotelCheckIn).toEqual(day('2027-09-21'));
    expect(write?.hotelCheckOut).toEqual(day('2027-09-22'));
    expect(write).not.toHaveProperty('totalCostCny');
    expect(mockPrisma.hotelRoomType.findUnique).not.toHaveBeenCalled();
    expect(result.audit.hotelMode).toBe('FOLLOW_TRIP');
    expect(result.audit.hotelDateSync[0]).toMatchObject({ mode: 'SHIFT', fromNights: 1, toNights: 1 });
  });

  it('改期费：填 300 走调价行（RESCHEDULE_FEE）计入应收；填 0 不加任何行——住宿晚数变了也不自动计价', async () => {
    const service = newService();
    mount({
      legsBefore: ROUND_TRIP,
      targetItemId: 'fl-out',
      newDepartIso: '2027-09-21T02:00:00.000Z',
      hotelRows: [HOTEL_ROW()],
    });
    await service.rescheduleOrderItem(
      'ord1',
      { orderItemId: 'fl-out', newScheduleId: 'sched-new', hotelMode: 'FOLLOW_TRIP', feeCny: 0 },
      ADMIN,
    );
    const moneyWrites = () =>
      mockPrisma.order.update.mock.calls
        .map((call) => (call[0] as { data: Record<string, unknown> }).data)
        .filter((data) => 'adjustmentCny' in data);
    expect(moneyWrites()).toHaveLength(0);

    mount({
      legsBefore: ROUND_TRIP,
      targetItemId: 'fl-out',
      newDepartIso: '2027-09-21T02:00:00.000Z',
      hotelRows: [HOTEL_ROW()],
    });
    const result = await service.rescheduleOrderItem(
      'ord1',
      { orderItemId: 'fl-out', newScheduleId: 'sched-new', hotelMode: 'FOLLOW_TRIP', feeCny: 300 },
      ADMIN,
    );
    expect(result.audit.feeCny).toBe(300);
    const [money] = moneyWrites();
    expect(money?.adjustmentCny).toBe(300);
    const log = money?.adjustments as Array<{ type: string; amountCny: number }>;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ type: 'RESCHEDULE_FEE', amountCny: 300 });
  });

  it('BUNDLE 行：日期跟上、metadata.goDate/returnDate 同步、套餐名里的「N天N晚」不改、成本不动（不改档）', async () => {
    const service = newService();
    mount({
      legsBefore: ROUND_TRIP,
      targetItemId: 'fl-out',
      newDepartIso: '2027-09-21T02:00:00.000Z',
      hotelRows: [
        HOTEL_ROW({
          id: 'bun1',
          kind: 'BUNDLE',
          description: '岘港2天1晚',
          unitCostCny: null,
          metadata: { goDate: '2027-09-22', returnDate: '2027-09-23', roomsNeeded: 1 },
        }),
      ],
    });

    await service.rescheduleOrderItem(
      'ord1',
      { orderItemId: 'fl-out', newScheduleId: 'sched-new', hotelMode: 'FOLLOW_TRIP' },
      ADMIN,
    );

    const write = itemWrite('bun1');
    expect(write?.hotelCheckIn).toEqual(day('2027-09-21'));
    expect(write?.hotelCheckOut).toEqual(day('2027-09-23'));
    expect(write).not.toHaveProperty('description');
    expect(write).not.toHaveProperty('unitCostCny');
    expect(write).not.toHaveProperty('totalCostCny');
    expect(write?.metadata).toEqual({ goDate: '2027-09-21', returnDate: '2027-09-23', roomsNeeded: 1 });
    expect(mockPrisma.hotelRoomType.findUnique).not.toHaveBeenCalled();
  });

  it('随机档行（无房型）：保留快照单价、总成本按新晚数重算', async () => {
    const service = newService();
    mount({
      legsBefore: ROUND_TRIP,
      targetItemId: 'fl-out',
      newDepartIso: '2027-09-21T02:00:00.000Z',
      hotelRows: [
        HOTEL_ROW({
          id: 'rnd1',
          description: '三星随机 · 2027-09-22~2027-09-23 · 1晚 × 1间',
          hotelRoomTypeId: null,
          randomStarTier: 3,
          unitCostCny: dec(80),
        }),
      ],
    });

    await service.rescheduleOrderItem(
      'ord1',
      { orderItemId: 'fl-out', newScheduleId: 'sched-new', hotelMode: 'FOLLOW_TRIP' },
      ADMIN,
    );

    const write = itemWrite('rnd1');
    expect(write?.hotelCheckIn).toEqual(day('2027-09-21'));
    expect(write?.totalCostCny).toBe(160);
    expect(write).not.toHaveProperty('unitCostCny');
  });

  it('房型没录成本 → 成本两栏如实写 null（不落 0 虚高，与换酒店同口径）', async () => {
    const service = newService();
    mount({
      legsBefore: ROUND_TRIP,
      targetItemId: 'fl-out',
      newDepartIso: '2027-09-21T02:00:00.000Z',
      hotelRows: [HOTEL_ROW()],
      roomTypeCost: null,
    });

    await service.rescheduleOrderItem(
      'ord1',
      { orderItemId: 'fl-out', newScheduleId: 'sched-new', hotelMode: 'FOLLOW_TRIP' },
      ADMIN,
    );

    const write = itemWrite('hot1');
    expect(write?.unitCostCny).toBeNull();
    expect(write?.totalCostCny).toBeNull();
    expect(write).not.toHaveProperty('metadata');
  });

  it('重排出的住宿区间无效（回程改到与去程同一天、酒店原本比行程短）→ 400 指路另外两种口径，一个字段都不写', async () => {
    const service = newService();
    mount({
      legsBefore: [
        ROUND_TRIP[0],
        { id: 'fl-ret', scheduleId: 'sched-ret', departIso: '2027-09-25T02:00:00.000Z' },
      ],
      targetItemId: 'fl-ret',
      newDepartIso: '2027-09-22T10:00:00.000Z',
      // 酒店 22~23 而回程 25：离店相对回程的偏移是 −2 天；回程改到 22 → 离店排到 20，早于入住。
      hotelRows: [HOTEL_ROW()],
    });

    await expect(
      service.rescheduleOrderItem(
        'ord1',
        { orderItemId: 'fl-ret', newScheduleId: 'sched-new', hotelMode: 'FOLLOW_TRIP' },
        ADMIN,
      ),
    ).rejects.toThrow(/住宿区间无效.*整体平移/);
    expect(itemWrite('hot1')).toBeUndefined();
  });

  it('代理（售后自助旗子）传 FOLLOW_TRIP → 403，事务根本不开', async () => {
    const service = newService();
    mount({
      legsBefore: ROUND_TRIP,
      targetItemId: 'fl-out',
      newDepartIso: '2027-09-21T02:00:00.000Z',
      hotelRows: [HOTEL_ROW()],
    });

    await expect(
      service.rescheduleOrderItem(
        'ord1',
        { orderItemId: 'fl-out', newScheduleId: 'sched-new', hotelMode: 'FOLLOW_TRIP', agentAfterSales: true },
        { userId: 'agent1', role: 'AGENT' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('rescheduleOrderItem · hotelMode=SHIFT（缺省）与 KEEP', () => {
  it('不传 hotelMode = 既有整体平移：去程 9/22 → 9/21，住宿 21~22 保 1 晚，成本不碰', async () => {
    const service = newService();
    mount({
      legsBefore: ROUND_TRIP,
      targetItemId: 'fl-out',
      newDepartIso: '2027-09-21T02:00:00.000Z',
      hotelRows: [HOTEL_ROW()],
    });

    const result = await service.rescheduleOrderItem(
      'ord1',
      { orderItemId: 'fl-out', newScheduleId: 'sched-new' },
      ADMIN,
    );

    const write = itemWrite('hot1');
    expect(write?.hotelCheckIn).toEqual(day('2027-09-21'));
    expect(write?.hotelCheckOut).toEqual(day('2027-09-22'));
    expect(write?.description).toBe('海边酒店 · 标准房 · 2027-09-21~2027-09-22 · 1晚 × 1间');
    expect(write).not.toHaveProperty('totalCostCny');
    expect(write).not.toHaveProperty('metadata');
    expect(mockPrisma.hotelRoomType.findUnique).not.toHaveBeenCalled();
    expect(result.audit.hotelMode).toBe('SHIFT');
    expect(result.audit.hotelDateSync[0]).toMatchObject({ mode: 'SHIFT', fromNights: 1, toNights: 1 });
  });

  it('SHIFT 下只改回程（最早出发日没动）→ 住宿不动（既有口径）', async () => {
    const service = newService();
    mount({
      legsBefore: ROUND_TRIP,
      targetItemId: 'fl-ret',
      newDepartIso: '2027-09-25T02:00:00.000Z',
      hotelRows: [HOTEL_ROW()],
    });

    const result = await service.rescheduleOrderItem(
      'ord1',
      { orderItemId: 'fl-ret', newScheduleId: 'sched-new' },
      ADMIN,
    );

    expect(itemWrite('hot1')).toBeUndefined();
    expect(result.audit.hotelDateSync).toEqual([]);
  });

  it('KEEP → 住宿原地不动，审计 hotelMode=KEEP、同步明细为空；机票行照改', async () => {
    const service = newService();
    mount({
      legsBefore: ROUND_TRIP,
      targetItemId: 'fl-out',
      newDepartIso: '2027-09-21T02:00:00.000Z',
      hotelRows: [HOTEL_ROW()],
    });

    const result = await service.rescheduleOrderItem(
      'ord1',
      { orderItemId: 'fl-out', newScheduleId: 'sched-new', hotelMode: 'KEEP' },
      ADMIN,
    );

    expect(itemWrite('hot1')).toBeUndefined();
    expect(result.audit.hotelMode).toBe('KEEP');
    expect(result.audit.hotelDateSync).toEqual([]);
    expect(itemWrite('fl-out')?.flightScheduleId).toBe('sched-new');
  });

  it('代理传 KEEP 同样 403（非缺省住宿处理方式只认运营岗）', async () => {
    const service = newService();
    mount({
      legsBefore: ROUND_TRIP,
      targetItemId: 'fl-out',
      newDepartIso: '2027-09-21T02:00:00.000Z',
      hotelRows: [HOTEL_ROW()],
    });
    await expect(
      service.rescheduleOrderItem(
        'ord1',
        { orderItemId: 'fl-out', newScheduleId: 'sched-new', hotelMode: 'KEEP', agentAfterSales: true },
        { userId: 'agent1', role: 'AGENT' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('planFollowTripHotelStay（纯函数：按行程锚点重排住宿）', () => {
  const anchors = {
    fromOutbound: '2027-09-22',
    fromReturn: '2027-09-23',
    toOutbound: '2027-09-21',
    toReturn: '2027-09-25',
  };

  it('单行整程住宿：入住 = 新去程日、离店 = 新回程日', () => {
    const plan = planFollowTripHotelStay(
      [{ id: 'a', hotelCheckIn: day('2027-09-22'), hotelCheckOut: day('2027-09-23') }],
      anchors,
    );
    expect(plan).toEqual([{ id: 'a', newCheckIn: day('2027-09-21'), newCheckOut: day('2027-09-25') }]);
  });

  it('保留相对航段的偏移：次日才入住的单，改期后仍是新去程日的次日入住', () => {
    const plan = planFollowTripHotelStay(
      [{ id: 'a', hotelCheckIn: day('2027-09-23'), hotelCheckOut: day('2027-09-24') }],
      { ...anchors, fromReturn: '2027-09-24', toReturn: '2027-09-26' },
    );
    expect(plan[0].newCheckIn).toEqual(day('2027-09-22'));
    expect(plan[0].newCheckOut).toEqual(day('2027-09-26'));
  });

  it('分段住（两家酒店接力）：只在两头伸缩，中间的交接日不动，不会拉成两段整程重复占房', () => {
    const plan = planFollowTripHotelStay(
      [
        { id: 'first', hotelCheckIn: day('2027-09-22'), hotelCheckOut: day('2027-09-23') },
        { id: 'second', hotelCheckIn: day('2027-09-23'), hotelCheckOut: day('2027-09-24') },
      ],
      { fromOutbound: '2027-09-22', fromReturn: '2027-09-24', toOutbound: '2027-09-21', toReturn: '2027-09-26' },
    );
    expect(plan).toEqual([
      { id: 'first', newCheckIn: day('2027-09-21'), newCheckOut: day('2027-09-23') },
      { id: 'second', newCheckIn: day('2027-09-23'), newCheckOut: day('2027-09-26') },
    ]);
  });

  it('没有离店日期的行只跟入住', () => {
    const plan = planFollowTripHotelStay(
      [{ id: 'a', hotelCheckIn: day('2027-09-22'), hotelCheckOut: null }],
      anchors,
    );
    expect(plan).toEqual([{ id: 'a', newCheckIn: day('2027-09-21'), newCheckOut: null }]);
  });

  it('空输入 → 空计划', () => {
    expect(planFollowTripHotelStay([], anchors)).toEqual([]);
  });
});
