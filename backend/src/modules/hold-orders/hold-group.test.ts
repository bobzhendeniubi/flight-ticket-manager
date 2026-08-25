/**
 * 建团占位（团号 / 多航段 / 整团同事务）与释放时的提醒收口。
 *
 * 背景：一张占位单只对应一个班次，团队的去程 / 回程此前是两条毫无关联的记录，
 * 既回答不了「这个团留了哪几天」，也没法在导出里按团核对漏留 / 留错。
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
    operationalReminder: { updateMany: vi.fn() },
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

import { HoldOrderService } from './hold-orders.service.js';
import { createHoldGroupBodySchema } from './hold-orders.schemas.js';

const service = new HoldOrderService();

function hold(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hold_1',
    holdNo: 'H20260825AB12',
    flightScheduleId: 'schedule_out',
    seatClassId: 'seat_class_out',
    ownerType: HoldOwnerType.AGENT,
    agentId: 'agent_1',
    groupName: null,
    groupRef: null,
    seats: 55,
    seatsConverted: 0,
    seatsCancelled: 0,
    perSeatPriceCny: 1450,
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
      { id: 'i1', seq: 1, label: '尾款', amountRule: HoldAmountRule.REMAINDER, perPersonCny: null, amountCny: 79750, seatsBasis: 55, status: HoldInstallmentStatus.PENDING, paidAt: null, dueDate: new Date('2026-09-01T00:00:00Z'), allocations: [] },
    ],
    reductions: [],
    flightSchedule: { id: 'schedule_out', departureTime: new Date('2026-09-04T04:30:00Z'), departureTz: 'UTC', flight: { flightNumber: 'QH9588' } },
    ...overrides,
  };
}

const GROUP_BODY = {
  legs: [
    { flightScheduleId: 'schedule_out', cabin: CabinClass.ECONOMY, perSeatPriceCny: 1450 },
    { flightScheduleId: 'schedule_back', cabin: CabinClass.ECONOMY, perSeatPriceCny: 1380 },
  ],
  seats: 55,
  mode: 'RESERVE' as const,
  ownerType: HoldOwnerType.AGENT,
  agentId: 'agent_1',
  groupName: '国旅九月团',
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
  prismaMock.$queryRaw.mockResolvedValue([
    { id: 'seat_class_out', scheduleId: 'schedule_out', capacity: 183, sold: 0 },
  ]);
  prismaMock.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });
  prismaMock.holdOrder.aggregate.mockResolvedValue({
    _sum: { seats: 0, seatsConverted: 0, seatsCancelled: 0 },
  });
  prismaMock.agent.findUnique.mockResolvedValue({ id: 'agent_1' });
  prismaMock.holdOrder.create.mockResolvedValue(hold());
  prismaMock.holdOrder.update.mockResolvedValue({});
  prismaMock.operationalReminder.updateMany.mockResolvedValue({ count: 1 });
});

describe('HoldOrderService.createGroup', () => {
  it('去程 + 回程一次建单，两张占位单落同一个团号', async () => {
    const result = await service.createGroup(GROUP_BODY, 'user_1', { userId: 'user_1' });

    expect(result.holdOrders).toHaveLength(2);
    expect(result.groupRef).toMatch(/^G\d{8}[A-Z0-9]{4}$/u);
    const refs = prismaMock.holdOrder.create.mock.calls.map((call) => call[0].data.groupRef);
    expect(new Set(refs).size).toBe(1);
    expect(refs[0]).toBe(result.groupRef);
  });

  it('团名对代理归属同样落库——代理团也要能按团名找回来', async () => {
    await service.createGroup(GROUP_BODY, 'user_1', { userId: 'user_1' });
    expect(prismaMock.holdOrder.create.mock.calls[0][0].data).toMatchObject({
      agentId: 'agent_1',
      groupName: '国旅九月团',
    });
  });

  it('逐段各自锁价：去程 1450、回程 1380，不互相覆盖', async () => {
    await service.createGroup(GROUP_BODY, 'user_1', { userId: 'user_1' });
    const prices = prismaMock.holdOrder.create.mock.calls.map((call) => call[0].data.perSeatPriceCny);
    expect(prices).toEqual([1450, 1380]);
  });

  it('回程余票不足 → 整团抛错，不留下只占了去程的半个团', async () => {
    // 第二段聚合出的占位余座吃满容量，触发余票不足
    prismaMock.holdOrder.aggregate
      .mockResolvedValueOnce({ _sum: { seats: 0, seatsConverted: 0, seatsCancelled: 0 } })
      .mockResolvedValueOnce({ _sum: { seats: 183, seatsConverted: 0, seatsCancelled: 0 } });

    await expect(service.createGroup(GROUP_BODY, 'user_1', { userId: 'user_1' })).rejects.toThrow(/余票不足/u);
    // 去程那一段建了，但整体在同一事务里 —— 抛出即回滚，不会有半个团留在库里
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it('同一班次同一舱位重复添加 → 入参层就拒绝（否则同一批人被留两遍）', () => {
    const result = createHoldGroupBodySchema.safeParse({
      ...GROUP_BODY,
      legs: [
        { flightScheduleId: 'schedule_out', cabin: CabinClass.ECONOMY, perSeatPriceCny: 1450 },
        { flightScheduleId: 'schedule_out', cabin: CabinClass.ECONOMY, perSeatPriceCny: 1450 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('单航段也走建团口径，同样拿到团号', async () => {
    const result = await service.createGroup({ ...GROUP_BODY, legs: [GROUP_BODY.legs[0]] }, 'user_1', { userId: 'user_1' });
    expect(result.holdOrders).toHaveLength(1);
    expect(prismaMock.holdOrder.create.mock.calls[0][0].data.groupRef).toBe(result.groupRef);
  });
});
