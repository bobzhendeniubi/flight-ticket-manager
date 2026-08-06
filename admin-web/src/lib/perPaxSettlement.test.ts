/**
 * computePerPaxSettlement 单测（D2 每人结算价派生展示）。
 * 覆盖：均摊基本场景 / 余数兜底 / 单人调价不影响他人 / adjustmentCny 缺省 / 负数调整 / 0 人。
 */
import { describe, it, expect } from 'vitest';
import { computePerPaxSettlement } from './perPaxSettlement';

describe('computePerPaxSettlement', () => {
  it('无任何调整 → 平均分摊，合计等于 total', () => {
    const result = computePerPaxSettlement({
      totalCny: 3000,
      adjustmentCny: 0,
      passengerIds: ['p1', 'p2', 'p3'],
      netByPassenger: new Map(),
    });
    expect(result.payableCny).toBe(3000);
    expect(result.rows).toEqual([
      { passengerId: 'p1', netCny: 0, settlementCny: 1000 },
      { passengerId: 'p2', netCny: 0, settlementCny: 1000 },
      { passengerId: 'p3', netCny: 0, settlementCny: 1000 },
    ]);
    const sum = result.rows.reduce((acc, r) => acc + r.settlementCny, 0);
    expect(sum).toBe(result.payableCny);
  });

  it('某乘客补办签证多收 800 → 只有她的结算价 +800，其余人不受影响', () => {
    const result = computePerPaxSettlement({
      totalCny: 3000,
      adjustmentCny: 0,
      passengerIds: ['p1', 'p2', 'p3'],
      netByPassenger: new Map([['p2', 800]]),
    });
    // 基准每人 = (3000 - 800) / 3 = 733.33...，用分做整数运算
    expect(result.rows[0].settlementCny).toBeCloseTo(733.33, 2);
    expect(result.rows[2].passengerId).toBe('p3');
    // p2 = 基准 + 800
    expect(result.rows[1].settlementCny).toBeCloseTo(result.rows[0].settlementCny + 800, 2);
    const sum = result.rows.reduce((acc, r) => acc + r.settlementCny, 0);
    expect(sum).toBeCloseTo(result.payableCny, 2);
  });

  it('除不尽时余数兜给最后一位乘客，合计仍恰好等于应收总额', () => {
    const result = computePerPaxSettlement({
      totalCny: 1000,
      adjustmentCny: 0,
      passengerIds: ['p1', 'p2', 'p3'],
      netByPassenger: new Map(),
    });
    const cents = result.rows.map((r) => Math.round(r.settlementCny * 100));
    const totalCents = cents.reduce((a, b) => a + b, 0);
    expect(totalCents).toBe(Math.round(result.payableCny * 100));
  });

  it('真正除不尽的金额（100 CNY / 3 人）→ 合计仍精确等于应收总额（分级校验）', () => {
    const result = computePerPaxSettlement({
      totalCny: 100,
      adjustmentCny: 0,
      passengerIds: ['p1', 'p2', 'p3'],
      netByPassenger: new Map(),
    });
    const cents = result.rows.map((r) => Math.round(r.settlementCny * 100));
    const totalCents = cents.reduce((a, b) => a + b, 0);
    expect(totalCents).toBe(10000); // 100 CNY = 10000 分
    // 前两位相同，最后一位兜余数
    expect(cents[0]).toBe(cents[1]);
  });

  it('应收总额 = total + adjustmentCny（含改期费/换人费）', () => {
    const result = computePerPaxSettlement({
      totalCny: 3000,
      adjustmentCny: 500,
      passengerIds: ['p1', 'p2'],
      netByPassenger: new Map(),
    });
    expect(result.payableCny).toBe(3500);
    expect(result.rows[0].settlementCny + result.rows[1].settlementCny).toBe(3500);
  });

  it('adjustmentCny 缺省（undefined/null）按 0 处理', () => {
    const result = computePerPaxSettlement({
      totalCny: 2000,
      passengerIds: ['p1', 'p2'],
      netByPassenger: new Map(),
    });
    expect(result.payableCny).toBe(2000);
  });

  it('负数调整（优惠）→ 该乘客结算价低于基准，合计仍对得上', () => {
    const result = computePerPaxSettlement({
      totalCny: 3000,
      adjustmentCny: 0,
      passengerIds: ['p1', 'p2', 'p3'],
      netByPassenger: new Map([['p1', -300]]),
    });
    expect(result.rows[0].settlementCny).toBeLessThan(result.rows[1].settlementCny);
    const sum = result.rows.reduce((acc, r) => acc + r.settlementCny, 0);
    expect(sum).toBeCloseTo(result.payableCny, 2);
  });

  it('0 名乘客 → 空行，不抛错', () => {
    const result = computePerPaxSettlement({
      totalCny: 1000,
      adjustmentCny: 0,
      passengerIds: [],
      netByPassenger: new Map(),
    });
    expect(result.rows).toEqual([]);
    expect(result.payableCny).toBe(1000);
  });
});
