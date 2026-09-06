import { describe, expect, it } from 'vitest';
import { HoldAmountRule, HoldInstallmentStatus } from '@prisma/client';
import {
  attributableReceivedCny,
  conversionCarryCny,
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

  // B-11：整元 floor 的余数不能留在一张随即 CONVERTED 的占位单上。
  describe('conversionCarryCny · 末批把余数一起带走', () => {
    const ledger = { reductions: [{ forfeitCny: 0, surplusCny: 1 }] };

    it('非末批：仍按人均 floor × 人数，余数留给后面几批', () => {
      // 可归属实收 2999、余座 3：人均 floor = 999，转 1 人结转 999
      expect(conversionCarryCny(3000, 3, 1, ledger)).toBe(999);
      expect(conversionCarryCny(3000, 3, 2, ledger)).toBe(1998);
    });

    it('末批全转：结转全部可归属实收，2 元余数不再凭空消失', () => {
      expect(perSeatAttributableCny(3000, 3, ledger) * 3).toBe(2997);
      expect(conversionCarryCny(3000, 3, 3, ledger)).toBe(2999);
    });

    it('整除时末批与人均口径一致（回归：常规单不受影响）', () => {
      expect(conversionCarryCny(3000, 10, 10, {})).toBe(3000);
      expect(conversionCarryCny(3000, 10, 4, {})).toBe(1200);
    });

    it('可归属实收被历史账本扣成负数时结转 0，不倒扣', () => {
      expect(conversionCarryCny(1000, 2, 2, { conversions: [{ carryCny: 1500 }] })).toBe(0);
    });
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
