import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HoldAmountRule,
  HoldInstallmentStatus,
  HoldOccupyOn,
  HoldOrderStatus,
  HoldOwnerType,
  ReceiptStatus,
} from '@prisma/client';

const { prismaMock, auditMock, enqueueMock } = vi.hoisted(() => {
  const mock = {
    holdOrder: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), aggregate: vi.fn() },
    holdReceiptAllocation: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    holdInstallment: { update: vi.fn(), findMany: vi.fn() },
    receipt: { update: vi.fn() },
    seatLock: { aggregate: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { prismaMock: mock, auditMock: vi.fn(async () => undefined), enqueueMock: vi.fn(async () => undefined) };
});

vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../../lib/audit.js', () => ({ writeAudit: auditMock }));
vi.mock('../../queues/queue.js', () => ({ enqueueWaitlistCheck: enqueueMock }));

import { HoldOrderService } from './hold-orders.service.js';

const service = new HoldOrderService();

function installment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'installment_1',
    seq: 1,
    label: '定金',
    amountRule: HoldAmountRule.PER_PERSON_FIXED,
    perPersonCny: 100,
    amountCny: 100,
    dueDate: new Date('2026-09-10T00:00:00Z'),
    status: HoldInstallmentStatus.PENDING,
    paidAt: null,
    allocations: [],
    ...overrides,
  };
}

function hold(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hold_1',
    holdNo: 'H20260824AB12',
    flightScheduleId: 'schedule_1',
    seatClassId: 'seat_1',
    ownerType: HoldOwnerType.AGENT,
    agentId: 'agent_1',
    groupName: null,
    seats: 1,
    seatsConverted: 0,
    seatsCancelled: 0,
    perSeatPriceCny: 100,
    freeCancelRatio: 0.1,
    freeCancelUsed: 0,
    occupyOn: HoldOccupyOn.CREATE,
    status: HoldOrderStatus.HOLDING,
    reductions: [],
    installments: [installment()],
    seatClass: { cabin: 'ECONOMY' },
    flightSchedule: { id: 'schedule_1', departureTime: new Date(), departureTz: 'UTC', flight: { flightNumber: 'CA1' } },
    agent: { id: 'agent_1', companyName: '代理', contactName: '联系人' },
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'receipt_1',
    receiptNo: 'RCP001',
    amountCny: 100,
    allocatedCny: 0,
    status: ReceiptStatus.OPEN,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (fn: (tx: typeof prismaMock) => unknown) => fn(prismaMock));
  prismaMock.holdOrder.aggregate.mockResolvedValue({ _sum: { seats: null, seatsConverted: null, seatsCancelled: null } });
  prismaMock.seatLock.aggregate.mockResolvedValue({ _sum: { qty: null } });
  prismaMock.holdReceiptAllocation.create.mockResolvedValue({ id: 'allocation_1', amountCny: '100' });
  prismaMock.holdReceiptAllocation.update.mockResolvedValue({});
  prismaMock.holdInstallment.update.mockResolvedValue({});
  prismaMock.holdInstallment.findMany.mockResolvedValue([installment()]);
  prismaMock.receipt.update.mockResolvedValue({});
  prismaMock.holdOrder.update.mockResolvedValue({});
});

describe('HoldOrderService installment allocation', () => {
  it('认满一期后标记 PAID，并在全期完成时推进 FULLY_PAID', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([receipt()])
      .mockResolvedValueOnce([{ id: 'hold_1' }]);
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold());
    prismaMock.holdInstallment.findMany.mockResolvedValue([installment({ status: HoldInstallmentStatus.PAID, paidAt: new Date(), allocations: [{ amountCny: 100, reversedAt: null }] })]);

    const result = await service.allocateInstallment('hold_1', 'installment_1', { receiptId: 'receipt_1', amountCny: 100 }, { userId: 'user_1' });

    expect(result.installmentPaid).toBe(true);
    expect(result.holdStatus).toBe(HoldOrderStatus.FULLY_PAID);
    expect(prismaMock.holdInstallment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: HoldInstallmentStatus.PAID }) }));
    expect(prismaMock.receipt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ allocatedCny: expect.anything(), status: ReceiptStatus.ALLOCATED }) }));
  });

  it('进账余额不足时返回 409，不写入认款', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([receipt({ amountCny: 100, allocatedCny: 60 })]);

    await expect(service.allocateInstallment('hold_1', 'installment_1', { receiptId: 'receipt_1', amountCny: 50 }, { userId: 'user_1' })).rejects.toMatchObject({ statusCode: 409 });
    expect(prismaMock.holdReceiptAllocation.create).not.toHaveBeenCalled();
  });

  it('切位单首期全款认满且余量足够时从 PENDING 转入 FULLY_PAID', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([receipt()])
      .mockResolvedValueOnce([{ id: 'hold_1' }])
      .mockResolvedValueOnce([{ capacity: 10, sold: 0 }]);
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold({ status: HoldOrderStatus.PENDING, occupyOn: HoldOccupyOn.FULL_PAYMENT, seats: 1 }));
    prismaMock.holdInstallment.findMany.mockResolvedValue([installment({ status: HoldInstallmentStatus.PAID, paidAt: new Date(), allocations: [{ amountCny: 100, reversedAt: null }] })]);

    const result = await service.allocateInstallment('hold_1', 'installment_1', { receiptId: 'receipt_1', amountCny: 100 }, { userId: 'user_1' });

    expect(result.holdStatus).toBe(HoldOrderStatus.FULLY_PAID);
    expect(result.warning).toBeNull();
  });

  it('切位单认款已记账但余量不足时保留 PENDING 并返回 warning', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([receipt()])
      .mockResolvedValueOnce([{ id: 'hold_1' }])
      .mockResolvedValueOnce([{ capacity: 0, sold: 0 }]);
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold({ status: HoldOrderStatus.PENDING, occupyOn: HoldOccupyOn.FULL_PAYMENT, seats: 1 }));
    prismaMock.holdInstallment.findMany.mockResolvedValue([installment({ status: HoldInstallmentStatus.PAID, paidAt: new Date(), allocations: [{ amountCny: 100, reversedAt: null }] })]);

    const result = await service.allocateInstallment('hold_1', 'installment_1', { receiptId: 'receipt_1', amountCny: 100 }, { userId: 'user_1' });

    expect(result.holdStatus).toBe(HoldOrderStatus.PENDING);
    expect(result.warning).toContain('余量不足');
    expect(prismaMock.holdReceiptAllocation.create).toHaveBeenCalled();
  });
});

describe('HoldOrderService installment reversal', () => {
  it('撤销认款留痕、扣回 Receipt.allocatedCny，并把期回到 PENDING', async () => {
    const allocation = { id: 'allocation_1', receiptId: 'receipt_1', holdOrderId: 'hold_1', holdInstallmentId: 'installment_1', amountCny: 100, reversedAt: null };
    prismaMock.holdReceiptAllocation.findUnique
      .mockResolvedValueOnce(allocation)
      .mockResolvedValueOnce(allocation);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([receipt({ allocatedCny: 100, status: ReceiptStatus.ALLOCATED })])
      .mockResolvedValueOnce([{ id: 'hold_1' }]);
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold({ status: HoldOrderStatus.FULLY_PAID, installments: [installment({ status: HoldInstallmentStatus.PAID, paidAt: new Date(), allocations: [allocation] })] }));
    prismaMock.holdInstallment.findMany.mockResolvedValue([installment({ status: HoldInstallmentStatus.PAID, paidAt: new Date(), allocations: [] })]);

    const result = await service.reverseInstallmentAllocation('hold_1', 'installment_1', 'allocation_1', '挂接错误', { userId: 'user_1' });

    expect(result.holdStatus).toBe(HoldOrderStatus.HOLDING);
    expect(prismaMock.holdReceiptAllocation.update).toHaveBeenCalledWith(expect.objectContaining({ data: { reversedAt: expect.any(Date) } }));
    expect(prismaMock.receipt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ allocatedCny: expect.anything(), status: ReceiptStatus.OPEN }) }));
    expect(prismaMock.holdInstallment.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: HoldInstallmentStatus.PENDING, paidAt: null } }));
  });
});
