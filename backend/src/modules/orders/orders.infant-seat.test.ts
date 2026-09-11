/**
 * createOrder · 婴儿不占座（占座数独立于 quantity）服务级单测。
 *
 * 公测反馈：婴儿单独一张纯机票单录进去占了 1 座。收口：机票行 quantity 仍 = 出行人数（乘客数校验 /
 * 金额口径不动），占座数按服务端派生的 passengerType 写进 metadata.seatQuantity，扣座 CAS 只吃占座数。
 *
 * mock 风格对齐 orders.payment-timeout.test.ts：vi.mock Prisma + queue，spy 掉护照/查重/最早出发日，
 * **不** spy priceAndValidateItems（占座数就是在那里盖章的），只 spy 底层 pricing.calculatePrice。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => {
  const prisma = {
    order: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    orderCostItem: { create: vi.fn() },
    orderItem: { findMany: vi.fn() },
    flightSchedule: { findMany: vi.fn() },
    seatLock: { aggregate: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    fulfillmentTask: { findFirst: vi.fn(), create: vi.fn() },
    holdOrder: { aggregate: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { mockPrisma: prisma };
});

const mockTx = mockPrisma;
mockPrisma.$transaction.mockImplementation(
  async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
);

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../queues/queue.js', () => ({
  scheduleSeatHoldRelease: vi.fn(),
  cancelSeatLockExpiry: vi.fn(),
}));

import { OrderService } from './orders.service.js';
import type { CreateOrderBody, OrderItemInput } from './orders.schemas.js';
import type { OrderRequester } from './orders.service.js';

/** 最早出发日固定为 2026-10-01：2025-06-15 出生的孩子届时 1 岁 → 服务端派生 INFANT。 */
const DEPARTURE = new Date('2026-10-01T00:00:00.000Z');

const flightRow = (quantity: number, scheduleId = 'sched-go') => ({
  kind: 'FLIGHT' as const,
  description: 'QH9589 澳门→岘港 经济舱',
  quantity,
  flightScheduleId: scheduleId,
  flightCabin: 'ECONOMY' as const,
});

// 客户端一律传 ADULT：占座数必须按**服务端派生**的类型算，不信前端。
const adult = {
  fullName: 'ZHANG/SAN',
  documentType: 'PASSPORT' as const,
  documentNumber: 'E11111111',
  dateOfBirth: '1990-01-01',
  nationality: 'CN',
  passengerType: 'ADULT' as const,
  passportExpiry: '2031-01-01',
};
const infant = {
  fullName: 'ZHANG/BAO',
  documentType: 'PASSPORT' as const,
  documentNumber: 'E22222222',
  dateOfBirth: '2025-06-15',
  nationality: 'CN',
  passengerType: 'ADULT' as const,
  passportExpiry: '2031-01-01',
};

const staff: OrderRequester = { userId: 'staff1', role: 'STAFF' };

function makeService(): { service: OrderService; calculatePrice: ReturnType<typeof vi.fn> } {
  const service = new OrderService();
  const anyService = service as unknown as Record<string, unknown>;
  vi.spyOn(anyService as never, 'assertNoDuplicatePassengersOnFlights' as never).mockResolvedValue(
    [] as never,
  );
  vi.spyOn(anyService as never, 'applyPassportExpiryRule' as never).mockResolvedValue(
    undefined as never,
  );
  vi.spyOn(anyService as never, 'resolveEarliestFlightDepartureDate' as never).mockResolvedValue(
    DEPARTURE as never,
  );
  const calculatePrice = vi.fn(async (_s: string, _c: string, qty: number) => ({
    averageUnitPrice: 1000,
    totalPrice: 1000 * qty,
    dateRank: 0,
    dateMultiplier: 1,
    perSeatBreakdown: [],
  }));
  (service as unknown as { pricing: { calculatePrice: unknown } }).pricing.calculatePrice =
    calculatePrice;
  return { service, calculatePrice };
}

function body(items: OrderItemInput[], passengers: Array<typeof adult>): CreateOrderBody {
  return {
    contactName: '联系人',
    contactPhone: '13800000000',
    items,
    passengers,
  } as unknown as CreateOrderBody;
}

type CreatedItem = { quantity: number; amount: { toString(): string }; metadata?: Record<string, unknown> };
function createdItems(): CreatedItem[] {
  const call = mockPrisma.order.create.mock.calls[0];
  return (call[0] as { data: { items: { create: CreatedItem[] } } }).data.items.create;
}
function createdPassengerTypes(): string[] {
  const call = mockPrisma.order.create.mock.calls[0];
  return (
    call[0] as { data: { passengers: { create: Array<{ passengerType: string }> } } }
  ).data.passengers.create.map((p) => p.passengerType);
}
/** 扣座 CAS 调用（模板含 `sold = sold +`）的 qty 列表：${qty} 是第 1 个占位符。 */
function seatCasQtys(): number[] {
  return mockPrisma.$executeRaw.mock.calls
    .filter((call) => (call[0] as readonly string[]).join('?').includes('sold = sold +'))
    .map((call) => call[1] as number);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });
  mockPrisma.seatLock.findMany.mockResolvedValue([]);
  mockPrisma.holdOrder.aggregate.mockResolvedValue({
    _sum: { seats: null, seatsConverted: null, seatsCancelled: null },
  });
  mockPrisma.$executeRaw.mockResolvedValue(1);
  mockPrisma.orderCostItem.create.mockResolvedValue({});
  mockPrisma.order.findUnique.mockResolvedValue({ visaStatus: null });
  mockPrisma.orderItem.findMany.mockResolvedValue([]);
  mockPrisma.flightSchedule.findMany.mockResolvedValue([]);
  mockPrisma.order.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'ord1',
    orderNumber: args.data.orderNumber,
    paymentExpiresAt: null,
    items: [],
    passengers: [],
    statusEvents: [],
  }));
});

describe('createOrder · 婴儿不占座（纯机票单）', () => {
  it('1 成人 + 1 婴儿（客户端都传 ADULT）→ 行 quantity 2、扣 1 座、metadata 盖 seatQuantity=1/infantCount=1', async () => {
    const { service, calculatePrice } = makeService();

    await service.createOrder(body([flightRow(2)], [adult, infant]), staff);

    // 服务端按出生日期 × 出发日派生：第二位是 INFANT（客户端的 ADULT 被覆盖）。
    expect(createdPassengerTypes()).toEqual(['ADULT', 'INFANT']);
    // 乘客数校验通过（quantity 2 === 2 位出行人），金额仍按 quantity 2 张算 —— 不动钱。
    const [row] = createdItems();
    expect(row.quantity).toBe(2);
    expect(row.amount.toString()).toBe('2000');
    expect(row.metadata).toMatchObject({ seatQuantity: 1, infantCount: 1 });
    // 座位账只吃占座数：CAS 恰好一次、qty 1（不是 2）。
    expect(seatCasQtys()).toEqual([1]);
    // 余票预检同样按占座数（价格仍按 2 张）。
    expect(calculatePrice).toHaveBeenCalledWith('sched-go', 'ECONOMY', 2, { seatDemand: 1 });
  });

  it('婴儿单独一单 → quantity 1、金额不变、乘客数校验通过、一座不扣（不进 CAS）', async () => {
    const { service, calculatePrice } = makeService();

    await expect(service.createOrder(body([flightRow(1)], [infant]), staff)).resolves.toBeDefined();

    expect(createdPassengerTypes()).toEqual(['INFANT']);
    const [row] = createdItems();
    expect(row.quantity).toBe(1);
    expect(row.amount.toString()).toBe('1000');
    expect(row.metadata).toMatchObject({ seatQuantity: 0, infantCount: 1 });
    expect(seatCasQtys()).toEqual([]);
    // 售罄班次照样能录：余票预检按 0 座。
    expect(calculatePrice).toHaveBeenCalledWith('sched-go', 'ECONOMY', 1, { seatDemand: 0 });
  });

  it('往返两段 · 2 成人 + 1 婴儿 → 每段 quantity 3、各扣 2 座', async () => {
    const { service } = makeService();
    const adult2 = { ...adult, fullName: 'LI/SI', documentNumber: 'E33333333' };

    await service.createOrder(
      body([flightRow(3, 'sched-go'), flightRow(3, 'sched-ret')], [adult, adult2, infant]),
      staff,
    );

    const rows = createdItems();
    expect(rows.map((r) => r.quantity)).toEqual([3, 3]);
    expect(rows.map((r) => r.metadata?.seatQuantity)).toEqual([2, 2]);
    expect(seatCasQtys()).toEqual([2, 2]);
  });

  it('客户端伪造 metadata.seatQuantity=0 → 被剥掉，按服务端派生重算（1 成人 = 1 座）', async () => {
    const { service } = makeService();
    const forged = { ...flightRow(1), metadata: { seatQuantity: 0, infantCount: 1 } };

    await service.createOrder(body([forged as OrderItemInput], [adult]), staff);

    expect(createdItems()[0].metadata).toMatchObject({ seatQuantity: 1, infantCount: 0 });
    expect(seatCasQtys()).toEqual([1]);
  });

  it('没有婴儿 → 占座 = quantity，行为与旧版一致', async () => {
    const { service, calculatePrice } = makeService();
    const adult2 = { ...adult, fullName: 'LI/SI', documentNumber: 'E33333333' };

    await service.createOrder(body([flightRow(2)], [adult, adult2]), staff);

    expect(createdItems()[0].metadata).toMatchObject({ seatQuantity: 2, infantCount: 0 });
    expect(seatCasQtys()).toEqual([2]);
    expect(calculatePrice).toHaveBeenCalledWith('sched-go', 'ECONOMY', 2, { seatDemand: 2 });
  });
});
