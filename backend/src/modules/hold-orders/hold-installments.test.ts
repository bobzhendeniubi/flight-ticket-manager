import { describe, expect, it } from 'vitest';
import { HoldAmountRule } from '@prisma/client';
import { buildInstallmentsFromOverride, foldInstallments } from './hold-installments.js';
import { createHoldOrderBodySchema } from './hold-orders.schemas.js';

const base = {
  seats: 10,
  perSeatPriceCny: 1000,
      createdAt: new Date('2026-09-14T03:00:00Z'),
  departureTime: new Date('2026-09-23T03:00:00Z'),
  departureTz: 'Asia/Shanghai',
};

describe('foldInstallments', () => {
  it('按 D-30/D-10/D-5 计算并折叠建单日以前的期，金额合并且 seq 重排', () => {
    const result = foldInstallments({
      ...base,
      templates: [
        { label: '定金', amountRule: HoldAmountRule.PER_PERSON_FIXED, perPersonCny: 100, dueOffsetDays: 30 },
        { label: '二定', amountRule: HoldAmountRule.PER_PERSON_FIXED, perPersonCny: 200, dueOffsetDays: 10 },
        { label: '尾款', amountRule: HoldAmountRule.REMAINDER, dueOffsetDays: 5 },
      ],
    });
    expect(result).toEqual([
      expect.objectContaining({ seq: 1, label: '定金+二定', amountCny: 3000, dueDate: new Date('2026-09-14T00:00:00Z') }),
      expect.objectContaining({ seq: 2, label: '尾款', amountCny: 7000, dueDate: new Date('2026-09-18T00:00:00Z') }),
    ]);
  });

  it('D-5 建单时三期全部折叠为首期', () => {
    const result = foldInstallments({
      ...base,
      createdAt: new Date('2026-09-19T03:00:00Z'),
      templates: [
        { label: '定金', amountRule: HoldAmountRule.PER_PERSON_FIXED, perPersonCny: 100, dueOffsetDays: null },
        { label: '二定', amountRule: HoldAmountRule.PER_PERSON_FIXED, perPersonCny: 200, dueOffsetDays: 10 },
        { label: '尾款', amountRule: HoldAmountRule.REMAINDER, dueOffsetDays: 5 },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ seq: 1, label: '定金+二定+尾款', amountCny: 10000 });
  });

  it('定金总额超过总价时拒绝', () => {
    expect(() => foldInstallments({
      ...base,
      perSeatPriceCny: 100,
      templates: [
        { label: '定金', amountRule: HoldAmountRule.PER_PERSON_FIXED, perPersonCny: 101, dueOffsetDays: null },
        { label: '尾款', amountRule: HoldAmountRule.REMAINDER, dueOffsetDays: 7 },
      ],
  })).toThrow('超过占位总价');
  });

  it('建单日按 departureTz 取当地日历日，而不是 UTC 日期', () => {
    const result = foldInstallments({
      ...base,
      createdAt: new Date('2026-09-14T23:30:00Z'),
      templates: [{ label: '尾款', amountRule: HoldAmountRule.REMAINDER, dueOffsetDays: null }],
    });
    expect(result[0].dueDate).toEqual(new Date('2026-09-15T00:00:00Z'));
  });

  it('override 只接受固定每人金额，尾款恒由合同总价减固定期重算', () => {
    const result = buildInstallmentsFromOverride({
      seats: 2,
      perSeatPriceCny: 1000,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      departureTz: 'UTC',
      overrides: [
        { label: '定金', perPersonCny: 300, dueDate: '2026-09-01' },
        { label: '尾款', dueDate: '2026-09-20' },
      ],
    });
    expect(result.map((row) => row.amountCny)).toEqual([600, 1400]);
    expect(() => createHoldOrderBodySchema.parse({
      flightScheduleId: 's', cabin: 'ECONOMY', seats: 2, perSeatPriceCny: 1000, ownerType: 'CUSTOMER', groupName: '团',
      installmentsOverride: [{ label: '尾款', amountCny: 100, dueDate: '2026-09-20' }],
    })).toThrow();
    expect(() => buildInstallmentsFromOverride({
      seats: 2,
      perSeatPriceCny: 100,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      departureTz: 'UTC',
      overrides: [{ label: '定金', perPersonCny: 101, dueDate: '2026-09-01' }, { label: '尾款', dueDate: '2026-09-20' }],
    })).toThrow('超过占位合同总价');
  });
});
