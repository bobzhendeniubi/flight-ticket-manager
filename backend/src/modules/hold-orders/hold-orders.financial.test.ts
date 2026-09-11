import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HoldAmountRule,
  HoldInstallmentStatus,
  HoldOccupyOn,
  HoldOrderStatus,
  HoldOwnerType,
  PaymentMethod,
  Prisma,
  ReceiptStatus,
} from '@prisma/client';

const { prismaMock, auditMock, enqueueMock, createReceiptMock } = vi.hoisted(() => {
  const mock = {
    holdOrder: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), aggregate: vi.fn() },
    holdReceiptAllocation: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    holdInstallment: { update: vi.fn(), findMany: vi.fn() },
    receipt: { update: vi.fn() },
    seatLock: { aggregate: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return {
    prismaMock: mock,
    auditMock: vi.fn(async () => undefined),
    enqueueMock: vi.fn(async () => undefined),
    createReceiptMock: vi.fn(),
  };
});

vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../../lib/audit.js', () => ({ writeAudit: auditMock }));
vi.mock('../../queues/queue.js', () => ({ enqueueWaitlistCheck: enqueueMock }));
vi.mock('../receipts/receipts.service.js', () => ({ createOpenReceiptWithinTx: createReceiptMock }));

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
    // 相对当前时间：写死日期过期后期数会被判 OVERDUE，整组用例自然失效
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
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
    conversions: [],
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
  createReceiptMock.mockResolvedValue({ id: 'receipt_1', receiptNo: 'RCP001' });
});

// F-14：认款弹窗双击会把同一笔到账认两次（收款期「已认」翻倍、进账余额多扣一次，
// 只能靠撤销认款纠正）。请求令牌折成认款行主键 → 同一 token 重放只记一笔钱。
describe('HoldOrderService 认款幂等（请求令牌）', () => {
  const requestToken = '00000000-0000-4000-8000-0000000000f1';

  it('带令牌首次认款：认款行用令牌折出的确定性主键落库', async () => {
    prismaMock.holdReceiptAllocation.findUnique.mockResolvedValue(null);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([receipt()])
      .mockResolvedValueOnce([{ id: 'hold_1' }]);
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold());

    await service.allocateInstallment('hold_1', 'installment_1', { receiptId: 'receipt_1', amountCny: 100, requestToken }, { userId: 'user_1' });

    const created = prismaMock.holdReceiptAllocation.create.mock.calls[0][0].data;
    expect(created.id).toMatch(/^hra_[0-9a-f]{32}$/u);
    // 查重用的正是同一个键
    expect(prismaMock.holdReceiptAllocation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: created.id } }),
    );
  });

  it('同一令牌重放：回放首次那笔认款，不再写认款、不再扣进账余额', async () => {
    prismaMock.holdReceiptAllocation.findUnique.mockResolvedValue({
      id: 'hra_replay',
      holdOrderId: 'hold_1',
      holdInstallmentId: 'installment_1',
      receiptId: 'receipt_1',
      amountCny: 100,
      reversedAt: null,
      receipt: { receiptNo: 'RCP001' },
      holdInstallment: { seq: 1, status: HoldInstallmentStatus.PAID },
    });
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold({ status: HoldOrderStatus.FULLY_PAID }));

    const result = await service.allocateInstallment('hold_1', 'installment_1', { receiptId: 'receipt_1', amountCny: 100, requestToken }, { userId: 'user_1' });

    expect(result).toMatchObject({ allocated: 100, installmentPaid: true, holdStatus: HoldOrderStatus.FULLY_PAID, replayed: true });
    expect(prismaMock.holdReceiptAllocation.create).not.toHaveBeenCalled();
    expect(prismaMock.receipt.update).not.toHaveBeenCalled();
    expect(prismaMock.holdInstallment.update).not.toHaveBeenCalled();
    // 没动钱就不该再写一条「又认了一笔」的审计
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('两次提交几乎同时到达：后一笔撞唯一约束 → 翻成重放返回，而不是 500', async () => {
    const existing = {
      id: 'hra_replay',
      holdOrderId: 'hold_1',
      holdInstallmentId: 'installment_1',
      receiptId: 'receipt_1',
      amountCny: 100,
      reversedAt: null,
      receipt: { receiptNo: 'RCP001' },
      holdInstallment: { seq: 1, status: HoldInstallmentStatus.PAID },
    };
    // 第一次查（本事务开始前还没有那条认款）→ null；写入时撞主键；重查 → 已经在了
    prismaMock.holdReceiptAllocation.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([receipt()])
      .mockResolvedValueOnce([{ id: 'hold_1' }]);
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold({ status: HoldOrderStatus.FULLY_PAID }));
    prismaMock.holdReceiptAllocation.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    );

    const result = await service.allocateInstallment('hold_1', 'installment_1', { receiptId: 'receipt_1', amountCny: 100, requestToken }, { userId: 'user_1' });

    expect(result).toMatchObject({ allocated: 100, replayed: true });
  });

  it('不带令牌：口径不变（老客户端照常认款，不受幂等层影响）', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([receipt()])
      .mockResolvedValueOnce([{ id: 'hold_1' }]);
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold());

    await service.allocateInstallment('hold_1', 'installment_1', { receiptId: 'receipt_1', amountCny: 100 }, { userId: 'user_1' });

    expect(prismaMock.holdReceiptAllocation.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.holdReceiptAllocation.create.mock.calls[0][0].data.id).toBeUndefined();
  });

  it('手工到账重放：连 OPS_CLAIM 进账都不再建（重放判定在建进账之前）', async () => {
    prismaMock.holdReceiptAllocation.findUnique.mockResolvedValue({
      id: 'hra_replay',
      holdOrderId: 'hold_1',
      holdInstallmentId: 'installment_1',
      receiptId: 'receipt_1',
      amountCny: 100,
      reversedAt: null,
      receipt: { receiptNo: 'RCP001' },
      holdInstallment: { seq: 1, status: HoldInstallmentStatus.PAID },
    });
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold({ status: HoldOrderStatus.FULLY_PAID }));

    const result = await service.manualReceiptInstallment(
      'hold_1',
      'installment_1',
      { amountCny: 100, method: PaymentMethod.WECHAT_PAY, requestToken },
      { userId: 'user_1' },
    );

    expect(result).toMatchObject({ allocated: 100, replayed: true });
    expect(createReceiptMock).not.toHaveBeenCalled();
    expect(prismaMock.holdReceiptAllocation.create).not.toHaveBeenCalled();
  });
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
  it('已有转正结转记录时禁止撤销认款，避免同一笔资金被重复使用', async () => {
    const allocation = { id: 'allocation_1', receiptId: 'receipt_1', holdOrderId: 'hold_1', holdInstallmentId: 'installment_1', amountCny: 100, reversedAt: null };
    prismaMock.holdReceiptAllocation.findUnique
      .mockResolvedValueOnce(allocation)
      .mockResolvedValueOnce(allocation);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([receipt({ allocatedCny: 100, status: ReceiptStatus.ALLOCATED })])
      .mockResolvedValueOnce([{ id: 'hold_1' }]);
    prismaMock.holdOrder.findUnique.mockResolvedValue(hold({ conversions: [{ carryCny: 100 }] }));

    await expect(
      service.reverseInstallmentAllocation('hold_1', 'installment_1', 'allocation_1', '挂接错误', { userId: 'user_1' }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('资金重复使用') });
    expect(prismaMock.holdReceiptAllocation.update).not.toHaveBeenCalled();
    expect(prismaMock.receipt.update).not.toHaveBeenCalled();
  });

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
