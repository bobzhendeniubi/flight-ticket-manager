/**
 * 占位单库存链单测：占位单是无名单库存实体，余量统一为
 * capacity − sold − 未过期 ACTIVE 锁位 − 占位余座。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CabinClass, HoldAmountRule, HoldInstallmentStatus, HoldOrderStatus, HoldOwnerType } from '@prisma/client';

const { prismaMock, auditMock, enqueueWaitlistCheckMock } = vi.hoisted(() => {
  const mock = {
    holdOrder: {
      aggregate: vi.fn(),
      groupBy: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    holdInstallment: { update: vi.fn(), findMany: vi.fn() },
    seatLock: { aggregate: vi.fn() },
    agent: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return {
    prismaMock: mock,
    auditMock: vi.fn(async () => undefined),
    enqueueWaitlistCheckMock: vi.fn(async () => undefined),
  };
});

vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../../lib/audit.js', () => ({ writeAudit: auditMock }));
vi.mock('../../queues/queue.js', () => ({ enqueueWaitlistCheck: enqueueWaitlistCheckMock }));

import { heldSeatsBySeatClass, heldSeatsForCabin, heldSeatsForSeatClass } from './held-seats.js';
import { HoldOrderService } from './hold-orders.service.js';

const service = new HoldOrderService();

function hold(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hold_1',
    holdNo: 'H20260824AB12',
    flightScheduleId: 'schedule_1',
    seatClassId: 'seat_class_1',
    ownerType: HoldOwnerType.AGENT,
    agentId: 'agent_1',
    seats: 20,
    seatsConverted: 0,
    seatsCancelled: 0,
    perSeatPriceCny: 1200,
    freeCancelRatio: null,
    freeCancelUsed: 0,
    status: HoldOrderStatus.HOLDING,
    notes: null,
    createdById: 'user_1',
    releasedAt: null,
    cancelledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    installments: [
      { id: 'i1', seq: 1, label: '定金', amountRule: HoldAmountRule.PER_PERSON_FIXED, perPersonCny: 300, amountCny: 6000, seatsBasis: 20, status: HoldInstallmentStatus.PENDING, paidAt: null, dueDate: new Date('2026-09-01T00:00:00Z'), allocations: [] },
      { id: 'i2', seq: 2, label: '尾款', amountRule: HoldAmountRule.REMAINDER, perPersonCny: null, amountCny: 18000, seatsBasis: 20, status: HoldInstallmentStatus.PENDING, paidAt: null, dueDate: new Date('2026-09-10T00:00:00Z'), allocations: [] },
    ],
    reductions: [],
    flightSchedule: { id: 'schedule_1', departureTime: new Date('2026-09-20T00:00:00Z'), departureTz: 'UTC', flight: { flightNumber: 'CA1' } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
  prismaMock.$queryRaw.mockResolvedValue([
    { id: 'seat_class_1', scheduleId: 'schedule_1', capacity: 100, sold: 10 },
  ]);
  prismaMock.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 5 } });
  prismaMock.holdOrder.aggregate.mockResolvedValue({
    _sum: { seats: 20, seatsConverted: 0, seatsCancelled: 0 },
  });
  prismaMock.agent.findUnique.mockResolvedValue({ id: 'agent_1' });
  prismaMock.holdOrder.create.mockResolvedValue(hold());
  prismaMock.holdOrder.update.mockResolvedValue({});
  prismaMock.holdInstallment.findMany.mockResolvedValue(hold().installments);
});

describe('held-seats helper', () => {
  it('按占座状态聚合 seats − converted − cancelled', async () => {
    expect(await heldSeatsForSeatClass(prismaMock as never, 'seat_class_1')).toBe(20);
    expect(prismaMock.holdOrder.aggregate).toHaveBeenCalledWith({
      _sum: { seats: true, seatsConverted: true, seatsCancelled: true },
      where: { seatClassId: 'seat_class_1', status: { in: expect.any(Array) } },
    });
  });

  it('批量返回按舱位索引的 Map，并支持按班次舱等聚合', async () => {
    prismaMock.holdOrder.groupBy.mockResolvedValue([
      { seatClassId: 'sc_1', _sum: { seats: 15, seatsConverted: 2, seatsCancelled: 3 } },
    ]);
    expect(await heldSeatsBySeatClass(prismaMock as never, ['sc_1'])).toEqual(new Map([['sc_1', 10]]));
    prismaMock.holdOrder.aggregate.mockResolvedValue({
      _sum: { seats: 12, seatsConverted: 1, seatsCancelled: 2 },
    });
    expect(await heldSeatsForCabin(prismaMock as never, 'schedule_1', CabinClass.ECONOMY)).toBe(9);
  });
});

describe('HoldOrderService.create', () => {
  it('建单成功，创建 HOLDING 占位并占用公共余量', async () => {
    const result = await service.create(
      {
        flightScheduleId: 'schedule_1',
        cabin: CabinClass.ECONOMY,
        seats: 60,
        perSeatPriceCny: 1200,
        mode: 'RESERVE',
        ownerType: HoldOwnerType.AGENT,
        agentId: 'agent_1',
      },
      'user_1',
      { userId: 'user_1' },
    );

    expect(result.status).toBe(HoldOrderStatus.HOLDING);
    expect(prismaMock.holdOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        holdNo: expect.stringMatching(/^H\d{8}[A-Z0-9]{4}$/u),
        seats: 60,
        perSeatPriceCny: 1200,
        status: HoldOrderStatus.HOLDING,
      }),
      include: { installments: { orderBy: { seq: 'asc' } } },
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE_HOLD_ORDER' }));
  });

  it('占位后余量不足时建单返回 409，不写入', async () => {
    prismaMock.holdOrder.aggregate.mockResolvedValue({
      _sum: { seats: 80, seatsConverted: 0, seatsCancelled: 0 },
    });

    await expect(
      service.create(
        {
          flightScheduleId: 'schedule_1',
          cabin: CabinClass.ECONOMY,
          seats: 6,
          perSeatPriceCny: 0,
          mode: 'RESERVE',
          ownerType: HoldOwnerType.CUSTOMER,
          groupName: '春季团',
        },
        'user_1',
      ),
    ).rejects.toThrow('仅剩 5 张');
    expect(prismaMock.holdOrder.create).not.toHaveBeenCalled();
  });
});

describe('HoldOrderService actions', () => {
  it('释放后状态为 RELEASED，审计状态变化', async () => {
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold());
    prismaMock.holdOrder.update.mockResolvedValue({});

    await expect(service.release('hold_1', { userId: 'user_1' })).resolves.toEqual({
      id: 'hold_1',
      status: HoldOrderStatus.RELEASED,
    });
    expect(prismaMock.holdOrder.update).toHaveBeenCalledWith({
      where: { id: 'hold_1' },
      data: expect.objectContaining({ status: HoldOrderStatus.RELEASED, releasedAt: expect.any(Date) }),
    });
    expect(enqueueWaitlistCheckMock).toHaveBeenCalledWith('seat_class_1');
  });

  it('释放后占位聚合归零，公共余量恢复', async () => {
    let holding = true;
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold());
    prismaMock.holdOrder.aggregate.mockImplementation(async () => ({
      _sum: holding
        ? { seats: 20, seatsConverted: 0, seatsCancelled: 0 }
        : { seats: null, seatsConverted: null, seatsCancelled: null },
    }));
    prismaMock.holdOrder.update.mockImplementation(async () => {
      holding = false;
      return { count: 1 };
    });

    expect(await heldSeatsForSeatClass(prismaMock as never, 'seat_class_1')).toBe(20);
    await service.release('hold_1');
    expect(await heldSeatsForSeatClass(prismaMock as never, 'seat_class_1')).toBe(0);
  });

  it('非 HOLDING 状态不能释放/取消/改价', async () => {
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold({ status: HoldOrderStatus.RELEASED }));
    prismaMock.holdOrder.update.mockResolvedValue({});

    await expect(service.release('hold_1')).rejects.toThrow('当前状态不可操作');
    await expect(service.cancel('hold_1')).rejects.toThrow('当前状态不可操作');
    await expect(
      service.updatePrice('hold_1', { perSeatPriceCny: 1300, reason: '财务确认改价' }),
    ).rejects.toThrow('当前状态不可改价');
    expect(prismaMock.holdOrder.update).toHaveBeenCalledTimes(0);
  });

  it('改价审计记录 before/after 价格和原因', async () => {
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold());
    prismaMock.holdOrder.update.mockResolvedValue({});

    await service.updatePrice('hold_1', { perSeatPriceCny: 1300, reason: '运营确认成本变化' });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'UPDATE_HOLD_ORDER_PRICE',
      before: { perSeatPriceCny: 1200 },
      after: { perSeatPriceCny: 1300, reason: '运营确认成本变化', status: HoldOrderStatus.HOLDING },
    }));
  });
});
