/**
 * computePerPaxSettlement 单测（D2 每人结算价派生展示）。
 * 覆盖：均摊基本场景 / 余数兜底 / 单人调价不影响他人 / adjustmentCny 缺省 / 负数调整 / 0 人。
 */
import { describe, it, expect } from 'vitest';
import { computePerPaxSettlement, spreadableAdjustmentCny } from './perPaxSettlement';

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
    expect(result.excludedCny).toBe(0);
  });

  it('无 adjustments 入参 → excludedCny 为 0，行为与旧版一致', () => {
    const result = computePerPaxSettlement({
      totalCny: 3000,
      adjustmentCny: 500,
      passengerIds: ['p1', 'p2'],
      netByPassenger: new Map(),
    });
    expect(result.excludedCny).toBe(0);
    expect(result.payableCny).toBe(3500);
  });

  it('换人差价/换人费挂被换人（excludeFromPerPax）→ 不摊入同行人，合计相应减少', () => {
    const result = computePerPaxSettlement({
      totalCny: 3000,
      adjustmentCny: 800, // 换人费 200 + 差价 600，都挂被换人
      adjustments: [
        { amountCny: 200, excludeFromPerPax: true },
        { amountCny: 600, excludeFromPerPax: true },
      ],
      passengerIds: ['p1', 'p2'],
      netByPassenger: new Map(),
    });
    // 800 全部被排除 → 可摊基数仍是 3000，两人均分 1500
    expect(result.excludedCny).toBe(800);
    expect(result.payableCny).toBe(3000);
    expect(result.rows).toEqual([
      { passengerId: 'p1', netCny: 0, settlementCny: 1500 },
      { passengerId: 'p2', netCny: 0, settlementCny: 1500 },
    ]);
  });

  it('excludeFromPerPax 条目与普通可摊条目混合 → 只剔除被标记的那部分', () => {
    const result = computePerPaxSettlement({
      totalCny: 2000,
      adjustmentCny: 300, // 100 可摊（如整单改期费）+ 200 挂被换人
      adjustments: [
        { amountCny: 100 },
        { amountCny: 200, excludeFromPerPax: true },
      ],
      passengerIds: ['p1', 'p2'],
      netByPassenger: new Map(),
    });
    expect(result.excludedCny).toBe(200);
    // 可摊总额 = 2000 + 300 - 200 = 2100
    expect(result.payableCny).toBe(2100);
    const sum = result.rows.reduce((acc, r) => acc + r.settlementCny, 0);
    expect(sum).toBeCloseTo(result.payableCny, 2);
  });

  it('拆单后单人留守场景：total 1433 + adjustmentCny 217 − 挂被换人 650 → 应收 1000，不夹到 0（H3：不clamp）', () => {
    // 换人差价/换人费 650 全挂在被换人身上（excludeFromPerPax），比 adjustmentCny 本身还大——
    // 可摊调整额因此是负数（217 − 650 = −433），如果被错误地夹到 0，payableCny 就会算成
    // 1433 而不是 1000，留守的这 1 位乘客就会被多摊 433。这里钉死不clamp的口径。
    const result = computePerPaxSettlement({
      totalCny: 1433,
      adjustmentCny: 217,
      adjustments: [{ amountCny: 650, excludeFromPerPax: true }],
      passengerIds: ['p1'],
      netByPassenger: new Map(),
    });
    expect(result.excludedCny).toBe(650);
    expect(result.payableCny).toBe(1000);
    expect(result.rows).toEqual([{ passengerId: 'p1', netCny: 0, settlementCny: 1000 }]);
  });
});

describe('spreadableAdjustmentCny', () => {
  it('可摊调整额允许为负（不clamp到 0）：217 − 650 = −433，与后端口径一致', () => {
    expect(spreadableAdjustmentCny(217, [{ amountCny: 650, excludeFromPerPax: true }])).toBe(-433);
  });

  it('无 excludeFromPerPax 条目 → 原样返回 adjustmentCny', () => {
    expect(spreadableAdjustmentCny(500, [{ amountCny: 500 }])).toBe(500);
  });

  it('减去所有 excludeFromPerPax===true 条目之和', () => {
    expect(
      spreadableAdjustmentCny(800, [
        { amountCny: 200, excludeFromPerPax: true },
        { amountCny: 600, excludeFromPerPax: true },
      ]),
    ).toBe(0);
  });

  it('adjustmentCny 缺省按 0 处理', () => {
    expect(spreadableAdjustmentCny(null, [])).toBe(0);
    expect(spreadableAdjustmentCny(undefined, [])).toBe(0);
  });

  it('脏数据条目（amountCny 非数字 / null 条目）不参与排除计算，不产出 NaN（与后端防呆同口径）', () => {
    const adjustments = [
      { amountCny: 'abc' as unknown as number, excludeFromPerPax: true },
      null as unknown as { amountCny: number; excludeFromPerPax?: boolean },
      { amountCny: 200, excludeFromPerPax: true },
    ];
    const result = spreadableAdjustmentCny(800, adjustments);
    // 只有第 3 条（amountCny: 200，合法）被排除，前两条脏数据一律跳过，结果不是 NaN。
    expect(result).toBe(600);
    expect(Number.isFinite(result)).toBe(true);
  });
});
