/**
 * 机票结算价日历自动取价（A1/E2）· 服务级单测（vitest，mock Prisma + mock 查价，不依赖真 DB）
 *
 * 业务口径：运营的机票报价表（行=日期、列=去/回程航班、每格一个 OTA 结算价/人）进系统后，
 * 代理下**纯机票单**时服务端按每条航段「航班号 × 出发地本地日」自动查表，结算总价 =
 * Σ(每人价 × 该航段人数)，再走既有「结算总价 → SETTLEMENT 差额行」机制把订单总额收敛过去。
 *
 * 覆盖：
 *   1. 取价口径：单程/往返全命中、每条航段按自己的出发日取价（回程不套用去程日）。
 *   2. 边界：任一航段无价 / 班次查不到 → 整单放弃自动取价（返回 null），绝不半单收敛。
 *   3. 含套餐行的单不参与（套餐走地面结算价日历，两张表各管各的）。
 *   4. createOrder 收敛路径：代理单命中 → 生成 reasonCode=SETTLEMENT 差额行，总额=日历价。
 *   5. 与手工价互斥：手工结算总价 / 团队议价 / OTA 手动调价在场 → 日历一律不介入。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGetFlightSettlementRate, mockGetSettlementRate } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    orderItem: { findMany: vi.fn() },
    orderCostItem: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    agent: { findUnique: vi.fn() },
    bundle: { findMany: vi.fn() },
    flightSchedule: { findMany: vi.fn() },
    flightSeatClass: { findFirst: vi.fn() },
    seatLock: { aggregate: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    fulfillmentTask: { findFirst: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  mockGetFlightSettlementRate: vi.fn(),
  mockGetSettlementRate: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../settlement-rates/flight-settlement-rates.service.js', () => ({
  getFlightSettlementRate: mockGetFlightSettlementRate,
}));
vi.mock('../settlement-rates/settlement-rates.service.js', () => ({
  getSettlementRate: mockGetSettlementRate,
}));
// localDate 只负责把班次 departureTime 折成出发地本地日；这里按 UTC 日取，让每条航段日期可控。
vi.mock('../finances/finances.cost.service.js', () => ({
  localDate: vi.fn((d: Date) => d.toISOString().slice(0, 10)),
}));
vi.mock('../../queues/queue.js', () => ({
  scheduleSeatHoldRelease: vi.fn(),
  cancelSeatLockExpiry: vi.fn(),
}));

import { OrderService } from './orders.service.js';
import type { CreateOrderBody } from './orders.schemas.js';

const ADMIN = { userId: 'u-admin', role: 'ADMIN' } as const;

const OUTBOUND_SCHED = {
  id: 's-out',
  departureTime: new Date('2026-08-10T00:30:00Z'),
  departureTz: 'Asia/Macau',
  flight: { flightNumber: 'QH9589' },
};
const RETURN_SCHED = {
  id: 's-ret',
  departureTime: new Date('2026-08-12T05:30:00Z'),
  departureTz: 'Asia/Ho_Chi_Minh',
  flight: { flightNumber: 'QH9588' },
};

/** 纯机票单 body：单程 1 条 FLIGHT（2 人）；往返再加一条回程行。 */
function flightBody(roundTrip = false): CreateOrderBody {
  const items = [
    {
      kind: 'FLIGHT',
      description: 'QH9589 MFM→DAD',
      quantity: 2,
      flightScheduleId: 's-out',
      flightCabin: 'ECONOMY',
    },
    ...(roundTrip
      ? [
          {
            kind: 'FLIGHT',
            description: 'QH9588 DAD→MFM',
            quantity: 2,
            flightScheduleId: 's-ret',
            flightCabin: 'ECONOMY',
          },
        ]
      : []),
  ];
  return { items } as unknown as CreateOrderBody;
}

type CalendarResult = { totalCny: number; audit: Record<string, unknown> } | null;
const resolveFlightCalendar = (
  service: OrderService,
  body: CreateOrderBody,
): Promise<CalendarResult> =>
  (
    service as unknown as {
      resolveFlightSettlementCalendarTotal: (b: CreateOrderBody) => Promise<CalendarResult>;
    }
  ).resolveFlightSettlementCalendarTotal(body);

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockPrisma.flightSchedule.findMany.mockResolvedValue([OUTBOUND_SCHED, RETURN_SCHED]);
  // 缺省：两个航班号都有价（去程 ¥1000、回程 ¥1200）
  mockGetFlightSettlementRate.mockImplementation(async (flightNumber: string, ymd: string) =>
    flightNumber === 'QH9589'
      ? { pricePerPersonCny: 1000, departDate: ymd }
      : { pricePerPersonCny: 1200, departDate: ymd },
  );
  mockGetSettlementRate.mockResolvedValue(null);
});

// ════════════════════════════════════════════════════════════════════════════
// 取价口径
// ════════════════════════════════════════════════════════════════════════════
describe('resolveFlightSettlementCalendarTotal · 取价口径', () => {
  it('单程全命中 → 结算总价 = 每人价 × 人数，审计留逐行明细', async () => {
    const r = await resolveFlightCalendar(new OrderService(), flightBody());
    expect(r).not.toBeNull();
    expect(r!.totalCny).toBe(2000);
    expect(r!.audit.source).toBe('FLIGHT_SETTLEMENT_CALENDAR');
    const lines = r!.audit.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      flightNumber: 'QH9589',
      departDate: '2026-08-10',
      pricePerPersonCny: 1000,
      pax: 2,
      lineTotalCny: 2000,
    });
    expect(String(lines[0].note)).toContain('QH9589 2026-08-10 ¥1000/人×2');
  });

  it('往返 → 去/回程各按自己的出发日与航班号取价，合计相加', async () => {
    const r = await resolveFlightCalendar(new OrderService(), flightBody(true));
    expect(r!.totalCny).toBe(2000 + 2400);
    const calls = mockGetFlightSettlementRate.mock.calls;
    expect(calls).toContainEqual(['QH9589', '2026-08-10']);
    expect(calls).toContainEqual(['QH9588', '2026-08-12']);
  });

  it('部分命中（回程当日无价）→ 整单放弃自动取价，返回 null（绝不半单收敛）', async () => {
    mockGetFlightSettlementRate.mockImplementation(async (flightNumber: string) =>
      flightNumber === 'QH9589' ? { pricePerPersonCny: 1000 } : null,
    );
    expect(await resolveFlightCalendar(new OrderService(), flightBody(true))).toBeNull();
  });

  it('整表未维护（全无价）→ 返回 null，回退现状动态定价', async () => {
    mockGetFlightSettlementRate.mockResolvedValue(null);
    expect(await resolveFlightCalendar(new OrderService(), flightBody())).toBeNull();
  });

  it('班次查不到 → 返回 null（不猜价）', async () => {
    mockPrisma.flightSchedule.findMany.mockResolvedValue([]);
    expect(await resolveFlightCalendar(new OrderService(), flightBody())).toBeNull();
  });

  it('无 FLIGHT 行 → 返回 null（不查表）', async () => {
    const body = {
      items: [{ kind: 'TRANSFER', description: '接送', quantity: 1, unitPrice: 150 }],
    } as unknown as CreateOrderBody;
    expect(await resolveFlightCalendar(new OrderService(), body)).toBeNull();
    expect(mockGetFlightSettlementRate).not.toHaveBeenCalled();
  });

  it('含套餐行 → 不参与（套餐走地面结算价日历，机票表不接管整单）', async () => {
    const body = {
      items: [
        ...flightBody().items,
        { kind: 'BUNDLE', description: '三星 2天1晚', quantity: 1, bundleId: 'b-1' },
      ],
    } as unknown as CreateOrderBody;
    expect(await resolveFlightCalendar(new OrderService(), body)).toBeNull();
    expect(mockGetFlightSettlementRate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// createOrder 收敛路径
// ════════════════════════════════════════════════════════════════════════════
type CreatedItemRow = {
  kind: string;
  description: string;
  amount: { toString(): string };
  metadata?: Record<string, unknown>;
};

/** 建 service 并 spy 掉定价/护照/查重，权威合计固定为 authoritativeTotal。 */
function makeService(authoritativeTotal: number): OrderService {
  const service = new OrderService();
  const priced = [
    {
      kind: 'FLIGHT' as const,
      description: 'QH9589 MFM→DAD',
      quantity: 2,
      unitPrice: authoritativeTotal / 2,
      amount: authoritativeTotal,
    },
  ];
  const anyService = service as unknown as Record<string, unknown>;
  vi.spyOn(anyService as never, 'assertNoDuplicatePassengersOnFlights' as never).mockResolvedValue(
    [] as never,
  );
  vi.spyOn(anyService as never, 'priceAndValidateItems' as never).mockResolvedValue(priced as never);
  vi.spyOn(anyService as never, 'applyPassportExpiryRule' as never).mockResolvedValue(
    undefined as never,
  );
  return service;
}

/** 套餐日历收敛测试：权威套餐行带指定酒店加项，createOrder 仍走真实收敛路径。 */
function makeGroundService(): OrderService {
  const service = new OrderService();
  const anyService = service as unknown as Record<string, unknown>;
  vi.spyOn(anyService as never, 'assertNoDuplicatePassengersOnFlights' as never).mockResolvedValue(
    [] as never,
  );
  vi.spyOn(anyService as never, 'priceAndValidateItems' as never).mockResolvedValue([
    {
      kind: 'FLIGHT' as const,
      description: 'QH9589 MFM→DAD',
      quantity: 2,
      unitPrice: 1300,
      amount: 2600,
    },
    {
      kind: 'BUNDLE' as const,
      description: '三星套餐（指定酒店）',
      quantity: 1,
      unitPrice: 4000,
      amount: 4000,
      bundleId: 'b-1',
      settlementAddOnCny: 80,
    },
  ] as never);
  vi.spyOn(anyService as never, 'applyPassportExpiryRule' as never).mockResolvedValue(
    undefined as never,
  );
  return service;
}

function groundOrderBody(priceAdjustment: Record<string, unknown>): CreateOrderBody {
  return {
    contactName: '联系人',
    contactPhone: '13800000000',
    agentId: 'ag-1',
    items: [
      {
        kind: 'FLIGHT',
        description: 'QH9589 MFM→DAD',
        quantity: 2,
        flightScheduleId: 's-out',
        flightCabin: 'ECONOMY',
      },
      {
        kind: 'BUNDLE',
        description: '三星套餐（指定酒店）',
        quantity: 1,
        unitPrice: 0,
        bundleId: 'b-1',
        adultCount: 2,
        childCount: 0,
        infantCount: 0,
        designatedHotelRoomTypeId: 'rt-designated',
        metadata: { goDate: '2026-08-10' },
      },
    ],
    passengers: [
      {
        fullName: '张三',
        documentNumber: 'E1234567',
        dateOfBirth: '1990-01-01',
        nationality: 'CN',
        passportExpiry: '2030-01-01',
      },
      {
        fullName: '李四',
        documentNumber: 'E7654321',
        dateOfBirth: '1991-01-01',
        nationality: 'CN',
        passportExpiry: '2030-01-01',
      },
    ],
    priceAdjustment,
  } as unknown as CreateOrderBody;
}

function itemsPassedToCreate(): CreatedItemRow[] {
  const call = mockPrisma.order.create.mock.calls[0];
  return (call[0] as { data: { items: { create: CreatedItemRow[] } } }).data.items.create;
}

function totalPassedToCreate(): number {
  const call = mockPrisma.order.create.mock.calls[0];
  return Number((call[0] as { data: { total: { toString(): string } } }).data.total.toString());
}

function findSettlementRow(items: CreatedItemRow[]): CreatedItemRow | undefined {
  return items.find(
    (it) => (it.metadata as Record<string, unknown> | undefined)?.reasonCode === 'SETTLEMENT',
  );
}

function agentOrderBody(overrides: Record<string, unknown> = {}): CreateOrderBody {
  return {
    contactName: '联系人',
    contactPhone: '13800000000',
    agentId: 'ag-1',
    items: flightBody().items,
    // 后台录含机票的单：每位出行人护照有效期必填
    passengers: [
      {
        fullName: '张三',
        documentNumber: 'E1234567',
        dateOfBirth: '1990-01-01',
        nationality: 'CN',
        passportExpiry: '2030-01-01',
      },
      {
        fullName: '李四',
        documentNumber: 'E7654321',
        dateOfBirth: '1991-01-01',
        nationality: 'CN',
        passportExpiry: '2030-01-01',
      },
    ],
    ...overrides,
  } as unknown as CreateOrderBody;
}

/** createOrder 全链路所需的 Prisma 桩（事务、代理、座位、审计、建单回显）。 */
function stubCreateOrderPrisma(): void {
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma),
  );
  mockPrisma.agent.findUnique.mockResolvedValue({ id: 'ag-1', isActive: true });
  mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });
  mockPrisma.seatLock.findMany.mockResolvedValue([]);
  mockPrisma.orderCostItem.create.mockResolvedValue({});
  mockPrisma.auditLog.create.mockResolvedValue({});
  mockPrisma.order.findUnique.mockResolvedValue(null);
  mockPrisma.orderItem.findMany.mockResolvedValue([]);
  mockPrisma.order.create.mockImplementation(
    async (args: {
      data: {
        orderNumber: string;
        total: unknown;
        paymentExpiresAt: Date | null;
        items: { create: unknown[] };
        passengers: { create: unknown[] };
      };
    }) => ({
      id: 'order-1',
      orderNumber: args.data.orderNumber,
      total: args.data.total,
      paymentExpiresAt: args.data.paymentExpiresAt,
      items: args.data.items.create,
      passengers: args.data.passengers.create,
      statusEvents: [],
    }),
  );
}

describe('createOrder · 机票结算价日历收敛', () => {
  beforeEach(stubCreateOrderPrisma);

  it('代理单命中日历 → 生成 SETTLEMENT 差额行，订单总额收敛到日历价', async () => {
    // 权威系统价 ¥2600，日历价 ¥1000/人 × 2 = ¥2000 → 差额 −600（DISCOUNT）
    const service = makeService(2600);
    await service.createOrder(agentOrderBody(), ADMIN);

    const row = findSettlementRow(itemsPassedToCreate());
    expect(row).toBeDefined();
    expect(row!.kind).toBe('DISCOUNT');
    expect(Number(row!.amount.toString())).toBe(-600);
    expect(row!.metadata).toMatchObject({
      reasonCode: 'SETTLEMENT',
      settlementPrice: true,
      authoritativeTotalCny: 2600,
      settlementTotalCny: 2000,
    });
    expect(totalPassedToCreate()).toBe(2000);
  });

  it('审计留取价来源 FLIGHT_SETTLEMENT_CALENDAR + 逐行明细', async () => {
    const service = makeService(2600);
    await service.createOrder(agentOrderBody(), ADMIN);

    const settlementAudit = mockPrisma.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.action === 'APPLY_SETTLEMENT_TOTAL');
    expect(settlementAudit).toBeDefined();
    const after = settlementAudit!.after as Record<string, unknown>;
    const calendar = after.settlementCalendar as Record<string, unknown>;
    expect(calendar.source).toBe('FLIGHT_SETTLEMENT_CALENDAR');
    expect(calendar.lines as unknown[]).toHaveLength(1);
    expect(calendar).not.toHaveProperty('discountCny');
  });

  it('非代理单（无 agentId）→ 日历不介入，不生成差额行', async () => {
    const service = makeService(2600);
    await service.createOrder(agentOrderBody({ agentId: undefined }), ADMIN);

    expect(findSettlementRow(itemsPassedToCreate())).toBeUndefined();
    expect(mockGetFlightSettlementRate).not.toHaveBeenCalled();
    expect(totalPassedToCreate()).toBe(2600);
  });

  it('日历未维护 → 不生成差额行，总额=系统权威价（回退现状）', async () => {
    mockGetFlightSettlementRate.mockResolvedValue(null);
    const service = makeService(2600);
    await service.createOrder(agentOrderBody(), ADMIN);

    expect(findSettlementRow(itemsPassedToCreate())).toBeUndefined();
    expect(totalPassedToCreate()).toBe(2600);
  });
});

describe('createOrder · 机票日历与手工价互斥（手工价一律优先，日历不介入）', () => {
  beforeEach(stubCreateOrderPrisma);

  it('手工「本单结算总价」在场 → 日历不查表，按手工价收敛', async () => {
    const service = makeService(2600);
    await service.createOrder(agentOrderBody({ settlementTotalCny: 2400 }), ADMIN);

    expect(mockGetFlightSettlementRate).not.toHaveBeenCalled();
    expect(totalPassedToCreate()).toBe(2400);
  });

  it('OTA 手动结算单价（priceAdjustment）在场 → 日历不介入（避免双重砸价）', async () => {
    const service = makeService(2600);
    await service.createOrder(
      agentOrderBody({ priceAdjustment: { amountCny: -100, reasonCode: 'DISCOUNT' } }),
      ADMIN,
    );

    expect(mockGetFlightSettlementRate).not.toHaveBeenCalled();
    expect(findSettlementRow(itemsPassedToCreate())).toBeUndefined();
  });

  it('批量同业优惠与日历收敛叠加 → 最终总额 = 日历价 − 优惠', async () => {
    const service = makeService(2600);
    await service.createOrder(
      agentOrderBody({
        priceAdjustment: {
          amountCny: -100,
          reasonCode: 'DISCOUNT',
          reasonText: '同业优惠 ¥50/人×2',
          stackWithSettlementCalendar: true,
        },
      }),
      ADMIN,
    );

    const items = itemsPassedToCreate();
    expect(items.find((item) => item.metadata?.reasonCode === 'DISCOUNT')?.amount.toString()).toBe('-100');
    expect(findSettlementRow(items)?.amount.toString()).toBe('-600');
    expect(totalPassedToCreate()).toBe(1900);
    const settlementAudit = mockPrisma.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.action === 'APPLY_SETTLEMENT_TOTAL');
    const calendar = (settlementAudit!.after as { settlementCalendar: Record<string, unknown> }).settlementCalendar;
    expect(calendar.discountCny).toBe(100);
    expect(
      (calendar.lines as Array<Record<string, unknown>>).reduce(
        (sum, line) => sum + Number(line.lineTotalCny),
        0,
      ) - Number(calendar.discountCny),
    ).toBe(1900);
  });

  it('GROUND 套餐日历 + 优惠 + 指定酒店加项并存 → 总额 = 日历价 + 加价×人数 − 优惠×人数', async () => {
    stubCreateOrderPrisma();
    mockPrisma.bundle.findMany.mockResolvedValue([
      { id: 'b-1', name: '三星套餐', settlementTier: 'THREE_STAR', settlementNights: 1 },
    ]);
    mockGetSettlementRate.mockResolvedValue({ pricePerPersonCny: 1500 });
    const service = makeGroundService();
    await service.createOrder(
      groundOrderBody({
        amountCny: -100,
        reasonCode: 'DISCOUNT',
        reasonText: '同业优惠 ¥50/人×2',
        stackWithSettlementCalendar: true,
      }),
      ADMIN,
    );

    // 日历 ¥1500/人×2 + 指定酒店 ¥40/人×2 − 优惠 ¥50/人×2 = ¥2980。
    expect(totalPassedToCreate()).toBe(2980);
    const settlementAudit = mockPrisma.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.action === 'APPLY_SETTLEMENT_TOTAL');
    const calendar = settlementAudit!.after as { settlementCalendar: Record<string, unknown> };
    expect(calendar.settlementCalendar.discountCny).toBe(100);
    const lines = calendar.settlementCalendar.lines as Array<Record<string, unknown>>;
    expect(lines.reduce((sum, line) => sum + Number(line.lineTotalCny), 0) - Number(calendar.settlementCalendar.discountCny)).toBe(
      2980,
    );
  });

  it('普通 DISCOUNT 无结构化标记：套餐日历吞掉调价，机票日历仍阻断接管', async () => {
    stubCreateOrderPrisma();
    mockPrisma.bundle.findMany.mockResolvedValue([
      { id: 'b-1', name: '三星套餐', settlementTier: 'THREE_STAR', settlementNights: 1 },
    ]);
    mockGetSettlementRate.mockResolvedValue({ pricePerPersonCny: 1500 });
    await makeGroundService().createOrder(
      groundOrderBody({ amountCny: -100, reasonCode: 'DISCOUNT' }),
      ADMIN,
    );
    expect(totalPassedToCreate()).toBe(3080);
    expect(
      (mockPrisma.auditLog.create.mock.calls
        .map((c) => (c[0] as { data: Record<string, unknown> }).data)
        .find((d) => d.action === 'APPLY_SETTLEMENT_TOTAL')?.after as Record<string, unknown>)
        .settlementCalendar,
    ).not.toHaveProperty('discountCny');

    vi.clearAllMocks();
    stubCreateOrderPrisma();
    mockGetSettlementRate.mockResolvedValue(null);
    const flightService = makeService(2600);
    await flightService.createOrder(
      agentOrderBody({ priceAdjustment: { amountCny: -100, reasonCode: 'DISCOUNT' } }),
      ADMIN,
    );
    expect(mockGetFlightSettlementRate).not.toHaveBeenCalled();
    expect(findSettlementRow(itemsPassedToCreate())).toBeUndefined();
  });

  it('团队议价结算价（flightSettlementPriceCny）在场 → 日历不介入', async () => {
    const service = makeService(2600);
    await service.createOrder(agentOrderBody({ flightSettlementPriceCny: 1300 }), ADMIN);

    expect(mockGetFlightSettlementRate).not.toHaveBeenCalled();
    expect(findSettlementRow(itemsPassedToCreate())).toBeUndefined();
  });
});
