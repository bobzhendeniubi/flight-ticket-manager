/**
 * 每人份额权威口径（拆单用）· 与前端实现的数值对拍
 *
 * expected 全部来自 admin-web/src/lib/perPaxSettlement.ts 的 computePerPaxSettlement
 * 实跑输出（硬编码快照，双向验证）：后端端口若与前端漂移，这里必红。
 * 覆盖：均摊整除 / 除不尽余数兜最后一位 / 按乘客净额（正负） / 负份额（净额超过应收）/
 * 售后费用叠加 / 空乘客 / 合计守恒。
 */
import { describe, it, expect } from 'vitest';

import { computePerPaxShares } from './per-pax-share.js';

const nets = (obj: Record<string, number>) => new Map(Object.entries(obj));

describe('computePerPaxShares · 与前端 computePerPaxSettlement 对拍（硬编码快照）', () => {
  it('整除均摊：3000 / 3 人', () => {
    const r = computePerPaxShares({
      totalCny: 3000,
      adjustmentCny: 0,
      passengerIds: ['p1', 'p2', 'p3'],
      netByPassenger: nets({}),
    });
    expect(r.payableCny).toBe(3000);
    expect(r.rows.map((x) => x.shareCny)).toEqual([1000, 1000, 1000]);
  });

  it('除不尽：1000.01 / 3 人 → 余数兜最后一位', () => {
    const r = computePerPaxShares({
      totalCny: 1000.01,
      adjustmentCny: 0,
      passengerIds: ['p1', 'p2', 'p3'],
      netByPassenger: nets({}),
    });
    expect(r.payableCny).toBe(1000.01);
    expect(r.rows.map((x) => x.shareCny)).toEqual([333.33, 333.33, 333.35]);
  });

  it('按乘客净额（正负混合）：5000 / 4 人，p2 +800、p3 −100', () => {
    const r = computePerPaxShares({
      totalCny: 5000,
      adjustmentCny: 0,
      passengerIds: ['p1', 'p2', 'p3', 'p4'],
      netByPassenger: nets({ p2: 800, p3: -100 }),
    });
    expect(r.rows).toEqual([
      { passengerId: 'p1', netCny: 0, shareCny: 1075 },
      { passengerId: 'p2', netCny: 800, shareCny: 1875 },
      { passengerId: 'p3', netCny: -100, shareCny: 975 },
      { passengerId: 'p4', netCny: 0, shareCny: 1075 },
    ]);
  });

  it('净额超过应收 → 出现负份额，负余数同样兜最后一位', () => {
    const r = computePerPaxShares({
      totalCny: 100,
      adjustmentCny: 0,
      passengerIds: ['p1', 'p2', 'p3'],
      netByPassenger: nets({ p1: 200 }),
    });
    expect(r.rows.map((x) => x.shareCny)).toEqual([166.67, -33.33, -33.34]);
  });

  it('售后费用叠加 + 7 人小数：8888.88 + adj 300', () => {
    const r = computePerPaxShares({
      totalCny: 8888.88,
      adjustmentCny: 300,
      passengerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
      netByPassenger: nets({ p4: 123.45, p7: -67.89 }),
    });
    expect(r.payableCny).toBe(9188.88);
    expect(r.rows.map((x) => x.shareCny)).toEqual([
      1304.76, 1304.76, 1304.76, 1428.21, 1304.76, 1304.76, 1236.87,
    ]);
  });

  it('乘客数 0 → 空行 + payable 照算', () => {
    const r = computePerPaxShares({
      totalCny: 1234.56,
      passengerIds: [],
      netByPassenger: nets({}),
    });
    expect(r.rows).toEqual([]);
    expect(r.payableCny).toBe(1234.56);
  });

  it('合计守恒：任意输入 Σ shareCny 恒等于 payableCny（分级精确）', () => {
    const samples: Array<{ total: number; adj: number; n: number; nets: Record<string, number> }> = [
      { total: 999.97, adj: 0, n: 6, nets: { p1: 33.33 } },
      { total: 0.05, adj: 0, n: 3, nets: {} },
      { total: 76543.21, adj: -120, n: 11, nets: { p3: -0.01, p9: 4000 } },
    ];
    for (const s of samples) {
      const ids = Array.from({ length: s.n }, (_, i) => `p${i + 1}`);
      const r = computePerPaxShares({
        totalCny: s.total,
        adjustmentCny: s.adj,
        passengerIds: ids,
        netByPassenger: nets(s.nets),
      });
      const sumCents = r.rows.reduce((acc, row) => acc + Math.round(row.shareCny * 100), 0);
      expect(sumCents).toBe(Math.round(r.payableCny * 100));
    }
  });
});
