/**
 * 释放占位单时的提醒收口。
 *
 * 释放与取消一样让座位回到公共库存，但此前只有取消会关掉未结的期款提醒：
 * 占位单已经不占座了，催款提醒还挂在提醒中心，谁也关不掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldAmountRule, HoldInstallmentStatus, HoldOrderStatus, HoldOwnerType, ReminderStatus } from '@prisma/client';

const { prismaMock, auditMock, enqueueWaitlistCheckMock } = vi.hoisted(() => {
  const mock = {
    holdOrder: { findUnique: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
    operationalReminder: { updateMany: vi.fn() },
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

const service = new HoldOrderService();

function hold() {
  return {
    id: 'hold_1',
    holdNo: 'H20260825K7Z9',
    flightScheduleId: 'schedule_1',
    seatClassId: 'seat_class_1',
    ownerType: HoldOwnerType.AGENT,
    agentId: 'agent_1',
    seats: 55,
    seatsConverted: 0,
    seatsCancelled: 0,
    perSeatPriceCny: 1450,
    status: HoldOrderStatus.HOLDING,
    createdById: 'user_1',
    createdAt: new Date(),
    installments: [
      { id: 'i1', seq: 1, label: '尾款', amountRule: HoldAmountRule.REMAINDER, perPersonCny: null, amountCny: 79750, seatsBasis: 55, status: HoldInstallmentStatus.PENDING, paidAt: null, dueDate: new Date('2026-09-01T00:00:00Z'), allocations: [] },
    ],
    reductions: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.holdOrder.findUnique.mockResolvedValue(hold());
  prismaMock.holdOrder.update.mockResolvedValue({});
  prismaMock.operationalReminder.updateMany.mockResolvedValue({ count: 1 });
});

describe('HoldOrderService.release', () => {
  it('释放占位单时一并关掉未结的期款提醒——座位回池了催款提醒不该还挂着', async () => {
    await service.release('hold_1', { userId: 'user_1' });

    expect(prismaMock.holdOrder.update).toHaveBeenCalledWith({
      where: { id: 'hold_1' },
      data: expect.objectContaining({ status: HoldOrderStatus.RELEASED }),
    });
    expect(prismaMock.operationalReminder.updateMany).toHaveBeenCalledWith({
      where: { ruleKey: { startsWith: 'HOLD_DUE:i1:' }, status: ReminderStatus.OPEN },
      data: expect.objectContaining({ status: ReminderStatus.SKIPPED, resolvedNote: '占位单已释放' }),
    });
  });
});
