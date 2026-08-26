import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldInstallmentStatus, HoldOrderStatus, HoldOverdueAction } from '@prisma/client';

const { auditMock, enqueueMock } = vi.hoisted(() => ({ auditMock: vi.fn(), enqueueMock: vi.fn() }));
vi.mock('../../lib/audit.js', () => ({ writeAudit: auditMock }));
vi.mock('../../queues/queue.js', () => ({ enqueueWaitlistCheck: enqueueMock }));

import { markOverdueHolds } from './hold-overdue.js';

function client(action: HoldOverdueAction, holdOverrides: Record<string, unknown> = {}) {
  const db = {
    holdOrderConfig: { findFirst: vi.fn().mockResolvedValue({ overdueAction: action }) },
    holdOrder: {
      findMany: vi.fn().mockResolvedValue([{ id: 'hold_1' }]),
      findUnique: vi.fn().mockResolvedValue({
        id: 'hold_1', holdNo: 'H1', seatClassId: 'seat_1', status: HoldOrderStatus.HOLDING,
        seats: 20, seatsConverted: 0, seatsCancelled: 0,
        installments: [{ id: 'i1', dueDate: new Date('2026-08-23T00:00:00Z'), status: HoldInstallmentStatus.PENDING }],
        flightSchedule: { departureTz: 'UTC' },
        ...holdOverrides,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    holdReceiptAllocation: { count: vi.fn().mockResolvedValue(0) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'hold_1' }]),
    $transaction: vi.fn(),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db;
}

beforeEach(() => { vi.clearAllMocks(); enqueueMock.mockResolvedValue(undefined); });

describe('markOverdueHolds', () => {
  it('REMIND_ONLY 标记 OVERDUE 并保留座位', async () => {
    const db = client(HoldOverdueAction.REMIND_ONLY);
    await expect(markOverdueHolds(db as never, new Date('2026-08-24T01:00:00Z'))).resolves.toMatchObject({ marked: 1, released: 0 });
    expect(db.holdOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: HoldOrderStatus.OVERDUE } }));
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('AUTO_RELEASE 转 RELEASED 并检查候补', async () => {
    const db = client(HoldOverdueAction.AUTO_RELEASE);
    await expect(markOverdueHolds(db as never, new Date('2026-08-24T01:00:00Z'))).resolves.toMatchObject({ marked: 0, released: 1 });
    expect(db.holdOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: HoldOrderStatus.RELEASED, releasedAt: expect.any(Date) }) }));
    expect(enqueueMock).toHaveBeenCalledWith('seat_1');
  });

  it('AUTO_RELEASE 钱闸：已有实收且座位未清算 → 不自动释放，退回 OVERDUE 交人工处理', async () => {
    const db = client(HoldOverdueAction.AUTO_RELEASE);
    db.holdReceiptAllocation.count.mockResolvedValue(1);

    await expect(markOverdueHolds(db as never, new Date('2026-08-24T01:00:00Z'))).resolves.toMatchObject({
      marked: 1, released: 0, blockedByReceipt: 1,
    });
    expect(db.holdOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: HoldOrderStatus.OVERDUE } }));
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'HOLD_OVERDUE_AUTO_RELEASE_BLOCKED_RECEIPT' }),
    );
  });

  it('AUTO_RELEASE 钱闸：座位已全部清算完（remaining=0）→ 已收款也照常自动释放', async () => {
    const db = client(HoldOverdueAction.AUTO_RELEASE, { seatsCancelled: 20 });
    db.holdReceiptAllocation.count.mockResolvedValue(1);

    await expect(markOverdueHolds(db as never, new Date('2026-08-24T01:00:00Z'))).resolves.toMatchObject({
      marked: 0, released: 1, blockedByReceipt: 0,
    });
    expect(db.holdOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: HoldOrderStatus.RELEASED }) }));
    // remaining=0 时不该再去查实收——没有座位悬空可谈
    expect(db.holdReceiptAllocation.count).not.toHaveBeenCalled();
  });
});
