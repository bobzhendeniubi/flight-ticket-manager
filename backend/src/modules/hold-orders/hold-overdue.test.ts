import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldInstallmentStatus, HoldOrderStatus, HoldOverdueAction } from '@prisma/client';

const { auditMock, enqueueMock } = vi.hoisted(() => ({ auditMock: vi.fn(), enqueueMock: vi.fn() }));
vi.mock('../../lib/audit.js', () => ({ writeAudit: auditMock }));
vi.mock('../../queues/queue.js', () => ({ enqueueWaitlistCheck: enqueueMock }));

import { markOverdueHolds } from './hold-overdue.js';

function client(action: HoldOverdueAction) {
  const db = {
    holdOrderConfig: { findFirst: vi.fn().mockResolvedValue({ overdueAction: action }) },
    holdOrder: {
      findMany: vi.fn().mockResolvedValue([{ id: 'hold_1' }]),
      findUnique: vi.fn().mockResolvedValue({
        id: 'hold_1', holdNo: 'H1', seatClassId: 'seat_1', status: HoldOrderStatus.HOLDING,
        installments: [{ id: 'i1', dueDate: new Date('2026-08-23T00:00:00Z'), status: HoldInstallmentStatus.PENDING }],
        flightSchedule: { departureTz: 'UTC' },
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
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
});
