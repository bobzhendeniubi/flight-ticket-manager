import { describe, expect, it } from 'vitest';
import { HoldAmountRule, HoldInstallmentStatus } from '@prisma/client';
import { computeReduction, type ReductionHold, type ReductionInstallment, type ReductionResult } from './hold-reduction.js';

const allocation = (amountCny: number, createdAt = new Date('2026-08-24T00:00:00Z')) => ({ amountCny, reversedAt: null, createdAt });

function baseHold(overrides: Partial<ReductionHold> = {}): ReductionHold {
  return {
    seats: 10,
    seatsConverted: 0,
    seatsCancelled: 0,
    perSeatPriceCny: 1000,
    freeCancelRatio: 0.1,
    freeCancelUsed: 0,
    ...overrides,
  };
}

function plan(overrides: Partial<ReductionInstallment>[] = []): ReductionInstallment[] {
  const defaults: ReductionInstallment[] = [
    { seq: 1, amountRule: HoldAmountRule.PER_PERSON_FIXED, perPersonCny: 300, amountCny: 3000, seatsBasis: 10, status: HoldInstallmentStatus.PAID, allocations: [allocation(3000)] },
    { seq: 2, amountRule: HoldAmountRule.PER_PERSON_FIXED, perPersonCny: 300, amountCny: 3000, seatsBasis: 10, status: HoldInstallmentStatus.PENDING, allocations: [] },
    { seq: 3, amountRule: HoldAmountRule.REMAINDER, perPersonCny: null, amountCny: 4000, seatsBasis: 10, status: HoldInstallmentStatus.PENDING, allocations: [] },
  ];
  return defaults.map((item, index) => ({ ...item, ...(overrides[index] ?? {}) }));
}

function activeReceived(item: ReductionInstallment): number {
  return (item.allocations ?? []).filter((a) => !a.reversedAt).reduce((sum, a) => sum + Number(a.amountCny), 0);
}

interface FirstPrinciplesExpected {
  totalReceived: number;
  attributable: number;
  unpaidReceivable: number;
  freeSeats: number;
  forfeitSeats: number;
  perSeatPaidCny: number;
  forfeitCny: number;
  creditCny: number;
  surplusCny: number;
  carryCny?: number;
}

/** 只用输入实收、历史清算记录和合同额验证第一性等式，不复刻清算实现的中间推导。 */
function assertFirstPrinciples(
  hold: ReductionHold,
  installments: ReductionInstallment[],
  n: number,
  result: ReductionResult,
  expected: FirstPrinciplesExpected,
) {
  const totalReceived = installments.reduce((sum, item) => sum + activeReceived(item), 0);
  const historicalForfeit = (hold.reductions ?? []).reduce((sum, row) => sum + (row.forfeitCny ?? 0), 0);
  const historicalSurplus = (hold.reductions ?? []).reduce((sum, row) => sum + (row.surplusCny ?? 0), 0);
  const historicalCarry = (hold.conversions ?? []).reduce((sum, row) => sum + (row.carryCny ?? 0), 0);
  const attributable = totalReceived - historicalForfeit - historicalSurplus - historicalCarry - result.forfeitCny - result.surplusCny;
  const finalInstallments = installments.map((item) => {
    const update = result.installmentUpdates.find((candidate) => candidate.seq === item.seq);
    return { ...item, amountCny: update?.amountCny ?? item.amountCny };
  });
  const unpaidReceivable = finalInstallments.reduce((sum, item) => Math.max(0, item.amountCny - activeReceived(item)) + sum, 0);
  const remainingContract = (hold.seats - hold.seatsConverted - hold.seatsCancelled - n) * hold.perSeatPriceCny;

  expect(totalReceived).toBe(expected.totalReceived);
  expect(result.freeSeats).toBe(expected.freeSeats);
  expect(result.forfeitSeats).toBe(expected.forfeitSeats);
  expect(result.perSeatPaidCny).toBe(expected.perSeatPaidCny);
  expect(result.forfeitCny).toBe(expected.forfeitCny);
  expect(result.creditCny).toBe(expected.creditCny);
  expect(result.surplusCny).toBe(expected.surplusCny);
  expect(historicalCarry).toBe(expected.carryCny ?? 0);
  expect(attributable).toBe(expected.attributable);
  expect(unpaidReceivable).toBe(expected.unpaidReceivable);

  // 总实收 = 没收累计 + 挂账累计 + 结转累计 + 可归属实收
  expect(totalReceived).toBe(
    historicalForfeit + historicalSurplus + historicalCarry + result.forfeitCny + result.surplusCny + attributable,
  );
  // Σ未付期（应收−已认） + 可归属实收 = 剩余合同额
  expect(unpaidReceivable + attributable).toBe(remainingContract);
}

describe('computeReduction · D2/D3 守恒不变量', () => {
  it.each([
    ['部分认款', baseHold(), plan([{}, { status: HoldInstallmentStatus.PENDING, allocations: [allocation(900)] }]), 2, { totalReceived: 3900, attributable: 3510, unpaidReceivable: 4490, freeSeats: 1, forfeitSeats: 1, perSeatPaidCny: 390, forfeitCny: 390, creditCny: 390, surplusCny: 0 }],
    ['跨免损额度', baseHold(), plan(), 3, { totalReceived: 3000, attributable: 2400, unpaidReceivable: 4600, freeSeats: 1, forfeitSeats: 2, perSeatPaidCny: 300, forfeitCny: 600, creditCny: 300, surplusCny: 0 }],
    ['尾款已付全损', baseHold({ freeCancelRatio: 0.5 }), plan([{}, {}, { status: HoldInstallmentStatus.PAID, amountCny: 4000, allocations: [allocation(4000)] }]), 2, { totalReceived: 7000, attributable: 5600, unpaidReceivable: 2400, freeSeats: 0, forfeitSeats: 2, perSeatPaidCny: 700, forfeitCny: 1400, creditCny: 0, surplusCny: 0 }],
    ['非整除尾款', baseHold({ freeCancelRatio: 0, perSeatPriceCny: 100 }), [{ seq: 1, amountRule: HoldAmountRule.REMAINDER, perPersonCny: null, amountCny: 1001, seatsBasis: 10, status: HoldInstallmentStatus.PAID, allocations: [allocation(1001)] }], 1, { totalReceived: 1001, attributable: 900, unpaidReceivable: 0, freeSeats: 0, forfeitSeats: 1, perSeatPaidCny: 100, forfeitCny: 100, creditCny: 0, surplusCny: 1 }],
    ['历史损失后重算', baseHold({ freeCancelRatio: 0, seatsCancelled: 2, freeCancelUsed: 1, reductions: [{ forfeitCny: 200, surplusCny: 100 }] }), plan(), 1, { totalReceived: 3000, attributable: 2363, unpaidReceivable: 4637, freeSeats: 0, forfeitSeats: 1, perSeatPaidCny: 337, forfeitCny: 337, creditCny: 0, surplusCny: 0 }],
    ['转正后再减员（含结转）', baseHold({ freeCancelRatio: 0, seatsConverted: 2, conversions: [{ carryCny: 600 }] }), plan(), 1, { totalReceived: 3000, attributable: 2100, unpaidReceivable: 4900, freeSeats: 0, forfeitSeats: 1, perSeatPaidCny: 300, forfeitCny: 300, creditCny: 0, surplusCny: 0, carryCny: 600 }],
  ])('%s：第一性等式守恒', (_label, hold, installments, n, expected) => {
    const result = computeReduction(hold, installments, n);
    assertFirstPrinciples(hold, installments, n, result, expected);
  });

  it('连续减员按余座重摊：定金300/人、尾款付清后再次减员没收1000且无挂账', () => {
    const initialHold = baseHold();
    const initialPlan = plan([{ status: HoldInstallmentStatus.PAID, allocations: [allocation(3000)] }, {}, { amountCny: 7000 }]);
    const first = computeReduction(initialHold, initialPlan, 1);
    expect(first).toMatchObject({ freeSeats: 1, forfeitSeats: 0, perSeatPaidCny: 300, creditCny: 300, surplusCny: 0 });

    const secondHold: ReductionHold = {
      ...initialHold,
      seatsCancelled: 1,
      freeCancelUsed: 1,
      reductions: [{ forfeitCny: 0, surplusCny: 0, createdAt: new Date('2026-08-24T00:00:00Z') }],
    };
    const secondPlan: ReductionInstallment[] = [
      { seq: 1, amountRule: HoldAmountRule.PER_PERSON_FIXED, perPersonCny: 300, amountCny: 3000, seatsBasis: 10, status: HoldInstallmentStatus.PAID, allocations: [allocation(3000)] },
      { seq: 2, amountRule: HoldAmountRule.REMAINDER, perPersonCny: null, amountCny: 6000, seatsBasis: 9, status: HoldInstallmentStatus.PAID, paidAt: new Date('2026-08-25T00:00:00Z'), allocations: [allocation(6000)] },
    ];
    const second = computeReduction(secondHold, secondPlan, 1);
    assertFirstPrinciples(secondHold, secondPlan, 1, second, {
      totalReceived: 9000,
      attributable: 8000,
      unpaidReceivable: 0,
      freeSeats: 0,
      forfeitSeats: 1,
      perSeatPaidCny: 1000,
      forfeitCny: 1000,
      creditCny: 0,
      surplusCny: 0,
    });
  });

  it('freeQuota 使用千分位整数，50×0.29 精确四舍五入为 15', () => {
    const result = computeReduction(baseHold({ seats: 50, freeCancelRatio: '0.29' }), [{ seq: 1, amountRule: HoldAmountRule.REMAINDER, perPersonCny: null, amountCny: 0, seatsBasis: 50, status: HoldInstallmentStatus.PENDING, allocations: [] }], 1);
    expect(result.freeQuota).toBe(15);
  });
});
