import { describe, expect, it } from 'vitest';
import { HoldAmountRule, HoldInstallmentStatus } from '@prisma/client';
import {
  attributableReceivedCny,
  holdLedgerTotals,
  perSeatAttributableCny,
  rebaseInstallmentsForRemainingSeats,
} from './hold-settlement.js';

const received = (amountCny: number) => ({ amountCny, reversedAt: null });

describe('占位单转正后账本口径', () => {
  it('结转后减员按 carry 扣减可归属实收，非整除残差仍留在可归属实收', () => {
    const ledger = { conversions: [{ carryCny: 300 }] };
    expect(holdLedgerTotals(ledger)).toEqual({ forfeitCny: 0, surplusCny: 0, carryCny: 300 });
    expect(perSeatAttributableCny(1001, 10, ledger)).toBe(70);
    expect(attributableReceivedCny(1001, ledger)).toBe(701);
    // 转走 3 座后，carry=3×floor(1001/10)=300，余数 1 不进入 surplus。
    expect(attributableReceivedCny(1001, { conversions: [{ carryCny: 300 }] }) - 700).toBe(1);
  });

  it('转正与减员共用座位基数变化后的固定期/尾款重算', () => {
    const installments = [
      {
        seq: 1,
        amountRule: HoldAmountRule.PER_PERSON_FIXED,
        perPersonCny: 300,
        amountCny: 3000,
        status: HoldInstallmentStatus.PAID,
        allocations: [received(3000)],
      },
      {
        seq: 2,
        amountRule: HoldAmountRule.PER_PERSON_FIXED,
        perPersonCny: 300,
        amountCny: 3000,
        status: HoldInstallmentStatus.PENDING,
        allocations: [],
      },
      {
        seq: 3,
        amountRule: HoldAmountRule.REMAINDER,
        perPersonCny: null,
        amountCny: 4000,
        status: HoldInstallmentStatus.PENDING,
        allocations: [],
      },
    ];
    const rebased = rebaseInstallmentsForRemainingSeats(
      installments,
      7,
      7000,
      2400,
      false,
    );
    expect(rebased.surplusCny).toBe(0);
    expect(rebased.updates).toEqual([
      { seq: 2, amountCny: 2100, seatsBasis: 7, status: HoldInstallmentStatus.PENDING, creditAppliedCny: 0 },
      { seq: 3, amountCny: 2500, seatsBasis: 7, status: HoldInstallmentStatus.PENDING, creditAppliedCny: 0 },
    ]);
  });
});
