import { describe, expect, it } from 'vitest';
import { HoldInstallmentStatus, HoldOrderStatus } from '@prisma/client';
import { deriveHoldStatus } from './hold-status.js';

const hold = { status: HoldOrderStatus.HOLDING };

describe('deriveHoldStatus', () => {
  it('按未撤销认款合计派生全款、逾期和占座中', () => {
    const date = new Date('2026-08-24T00:00:00Z');
    expect(deriveHoldStatus(hold, [{ amountCny: 100, allocatedCny: 100, status: HoldInstallmentStatus.PENDING, dueDate: date }], '2026-08-24')).toBe(HoldOrderStatus.FULLY_PAID);
    expect(deriveHoldStatus(hold, [{ amountCny: 100, allocatedCny: 0, status: HoldInstallmentStatus.PENDING, dueDate: new Date('2026-08-23T00:00:00Z') }], '2026-08-24')).toBe(HoldOrderStatus.OVERDUE);
    expect(deriveHoldStatus(hold, [{ amountCny: 100, allocatedCny: 0, status: HoldInstallmentStatus.PENDING, dueDate: date }], '2026-08-24')).toBe(HoldOrderStatus.HOLDING);
  });

  it('amount=0 的期视为已结清', () => {
    expect(deriveHoldStatus(hold, [{ amountCny: 0, allocatedCny: 0, dueDate: new Date('2020-01-01T00:00:00Z') }], '2026-08-24')).toBe(HoldOrderStatus.FULLY_PAID);
  });
});
