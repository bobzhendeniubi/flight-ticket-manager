/**
 * 定价 · 单元测试（vitest）
 *
 * 覆盖 pricing.calc.ts 的纯数学。
 *
 * 所见即所得：无仓位阶梯（AUTO）= 固定底价 round(basePrice)，
 * 不再叠日期等级 / 余位 bucket 倍率（旧版动态定价老页已退役）。
 * pricing.service.ts 的 AUTO 分支须与本文件保持一致。
 */
import { describe, it, expect } from 'vitest';
import {
  computePerSeatBreakdown,
  bucketOfSeatInLadder,
  computeLadderBreakdown,
} from './pricing.calc.js';

import type { FareBucket } from './pricing.calc.js';

describe('computePerSeatBreakdown — 固定底价（无阶梯 = 所见即所得）', () => {
  it('空机（sold=0）买 1 张 ¥1000 → 固定底价 1000（无倍率）', () => {
    const r = computePerSeatBreakdown({
      basePrice: 1000,
      dateRank: 'C',
      capacity: 180,
      sold: 0,
      qty: 1,
    });
    expect(r.dateMultiplier).toBe(1);
    expect(r.totalBuckets).toBe(1);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0]).toMatchObject({ seatIndex: 1, bucket: 0, bucketMultiplier: 1 });
    expect(r.breakdown[0].unitPrice).toBe(1000); // 固定底价
    expect(r.totalPrice).toBe(1000);
    expect(r.averageUnitPrice).toBe(1000);
  });

  it('日期等级不再影响价格：A/D 都等于底价（旧版倍率已退役）', () => {
    const a = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'A', capacity: 180, sold: 0, qty: 1 });
    const d = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'D', capacity: 180, sold: 0, qty: 1 });
    expect(a.breakdown[0].unitPrice).toBe(1000);
    expect(d.breakdown[0].unitPrice).toBe(1000);
    expect(a.dateMultiplier).toBe(1);
    expect(d.dateMultiplier).toBe(1);
  });

  it('余位不再影响价格：已售 100 张时仍是底价（无 bucket 加价）', () => {
    const r = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: 100, qty: 1 });
    expect(r.breakdown[0].seatIndex).toBe(101);
    expect(r.breakdown[0].bucket).toBe(0);
    expect(r.breakdown[0].bucketMultiplier).toBe(1);
    expect(r.breakdown[0].unitPrice).toBe(1000);
  });

  it('basePrice 非整数 → round 到整数底价', () => {
    const r = computePerSeatBreakdown({ basePrice: 829.4, dateRank: 'B', capacity: 180, sold: 0, qty: 1 });
    expect(r.breakdown[0].unitPrice).toBe(829);
  });
});

describe('computePerSeatBreakdown — 多座 / 余位', () => {
  it('一次买多张：每张同底价，total = qty × 底价', () => {
    const r = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: 8, qty: 5 });
    expect(r.breakdown.map((b) => b.unitPrice)).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(r.breakdown.map((b) => b.bucket)).toEqual([0, 0, 0, 0, 0]);
    expect(r.totalPrice).toBe(5000);
    expect(r.averageUnitPrice).toBe(1000);
    expect(r.currentBucket).toBe(0);
    // 整段一个 bucket：剩余 = capacity − sold
    expect(r.currentBucketRemaining).toBe(172); // 180 − 8
  });

  it('currentBucketRemaining = capacity − sold（整段，不分档）', () => {
    const r = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: 175, qty: 5 });
    expect(r.breakdown).toHaveLength(5);
    expect(r.breakdown.every((b) => b.bucket === 0)).toBe(true);
    expect(r.currentBucketRemaining).toBe(5); // 180 − 175
  });
});

describe('computePerSeatBreakdown — 边界 / 错误', () => {
  it('qty=0 抛错', () => {
    expect(() => computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: 0, qty: 0 })).toThrow();
  });
  it('qty=-1 抛错', () => {
    expect(() => computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: 0, qty: -1 })).toThrow();
  });
  it('sold=-1 抛错', () => {
    expect(() => computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: -1, qty: 1 })).toThrow();
  });
  it('sold > capacity 抛错', () => {
    expect(() => computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: 181, qty: 1 })).toThrow();
  });
});

describe('computePerSeatBreakdown — 不变量', () => {
  it('totalPrice = sum(breakdown.unitPrice)', () => {
    const r = computePerSeatBreakdown({ basePrice: 829, dateRank: 'B', capacity: 180, sold: 47, qty: 6 });
    const sum = r.breakdown.reduce((s: number, b) => s + b.unitPrice, 0);
    expect(r.totalPrice).toBe(sum);
  });
  it('每张 unitPrice = round(basePrice)（固定底价，无倍率）', () => {
    const r = computePerSeatBreakdown({ basePrice: 829, dateRank: 'B', capacity: 180, sold: 47, qty: 6 });
    for (const seat of r.breakdown) {
      expect(seat.unitPrice).toBe(Math.round(829));
      expect(seat.bucketMultiplier).toBe(1);
    }
    expect(r.dateMultiplier).toBe(1);
  });
  it('seatIndex 严格递增 sold+1 .. sold+qty', () => {
    const r = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: 50, qty: 8 });
    expect(r.breakdown.map((b: { seatIndex: number }) => b.seatIndex)).toEqual([51, 52, 53, 54, 55, 56, 57, 58]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 仓位阶梯（显式动态加价）
// 阶梯 [20@1280, 30@1480, 50@1680] → 累计上界 20 / 50 / 100
// ════════════════════════════════════════════════════════════════════════════
const LADDER: FareBucket[] = [
  { quota: 20, price: 1280 },
  { quota: 30, price: 1480 },
  { quota: 50, price: 1680 },
];

describe('bucketOfSeatInLadder', () => {
  it('座位落在累计 quota 首次覆盖的那一档', () => {
    expect(bucketOfSeatInLadder(1, LADDER)).toBe(0); // ≤20 → 档0
    expect(bucketOfSeatInLadder(20, LADDER)).toBe(0); // 边界 ≤20 → 档0
    expect(bucketOfSeatInLadder(21, LADDER)).toBe(1); // 21..50 → 档1
    expect(bucketOfSeatInLadder(50, LADDER)).toBe(1); // 边界 ≤50 → 档1
    expect(bucketOfSeatInLadder(51, LADDER)).toBe(2); // 51..100 → 档2
    expect(bucketOfSeatInLadder(100, LADDER)).toBe(2);
  });
  it('超过 Σquota（>100）clamp 到最后一档', () => {
    expect(bucketOfSeatInLadder(101, LADDER)).toBe(2);
    expect(bucketOfSeatInLadder(9999, LADDER)).toBe(2);
  });
});

describe('computeLadderBreakdown — 单座定价（仓位价即成交价）', () => {
  it('seat 1（sold=0）→ 档0 价 1280', () => {
    const r = computeLadderBreakdown({ fareBuckets: LADDER, sold: 0, qty: 1 });
    expect(r.breakdown[0].unitPrice).toBe(1280);
    expect(r.breakdown[0].bucket).toBe(0);
    expect(r.totalPrice).toBe(1280);
    expect(r.averageUnitPrice).toBe(1280);
    expect(r.totalBuckets).toBe(3);
    expect(r.currentBucket).toBe(0);
    expect(r.currentBucketRemaining).toBe(20); // 整档 0 还没卖
  });

  it('seat 20（sold=19）→ 档0 价 1280（档0 最后一张）', () => {
    const r = computeLadderBreakdown({ fareBuckets: LADDER, sold: 19, qty: 1 });
    expect(r.breakdown[0].seatIndex).toBe(20);
    expect(r.breakdown[0].unitPrice).toBe(1280);
    expect(r.currentBucket).toBe(0);
    expect(r.currentBucketRemaining).toBe(1); // 档0（上界20）− sold19
  });

  it('seat 21（sold=20）→ 档1 价 1480（首次涨价）', () => {
    const r = computeLadderBreakdown({ fareBuckets: LADDER, sold: 20, qty: 1 });
    expect(r.breakdown[0].seatIndex).toBe(21);
    expect(r.breakdown[0].unitPrice).toBe(1480);
    expect(r.breakdown[0].bucket).toBe(1);
    expect(r.currentBucket).toBe(1);
    expect(r.currentBucketRemaining).toBe(30); // 整档 1
  });

  it('seat 51（sold=50）→ 档2 价 1680', () => {
    const r = computeLadderBreakdown({ fareBuckets: LADDER, sold: 50, qty: 1 });
    expect(r.breakdown[0].seatIndex).toBe(51);
    expect(r.breakdown[0].unitPrice).toBe(1680);
    expect(r.breakdown[0].bucket).toBe(2);
  });
});

describe('computeLadderBreakdown — 跨档订单 + clamp', () => {
  it('sold=18 买 3 张（座位 19,20,21）跨 档0→档1 → 1280+1280+1480 = 4040', () => {
    const r = computeLadderBreakdown({ fareBuckets: LADDER, sold: 18, qty: 3 });
    expect(r.breakdown.map((b) => b.unitPrice)).toEqual([1280, 1280, 1480]);
    expect(r.breakdown.map((b) => b.bucket)).toEqual([0, 0, 1]);
    expect(r.totalPrice).toBe(4040);
    expect(r.averageUnitPrice).toBe(Math.round(4040 / 3)); // 1347
    expect(r.currentBucket).toBe(0);
    expect(r.currentBucketRemaining).toBe(2); // 档0 上界20 − sold18
  });

  it('超过 Σquota（sold=100 起）→ 全部 clamp 到最后一档 1680', () => {
    const r = computeLadderBreakdown({ fareBuckets: LADDER, sold: 100, qty: 3 });
    expect(r.breakdown.map((b) => b.unitPrice)).toEqual([1680, 1680, 1680]);
    expect(r.breakdown.map((b) => b.bucket)).toEqual([2, 2, 2]);
    expect(r.currentBucket).toBe(2);
    expect(r.currentBucketRemaining).toBe(0); // Σquota=100 已售罄，最后一档无剩余
  });

  it('订单尾部跨出 Σquota：sold=98 买 4（座位 99,100,101,102）→ 1680×4（档2 + clamp）', () => {
    const r = computeLadderBreakdown({ fareBuckets: LADDER, sold: 98, qty: 4 });
    expect(r.breakdown.map((b) => b.unitPrice)).toEqual([1680, 1680, 1680, 1680]);
    expect(r.totalPrice).toBe(6720);
  });
});

describe('computeLadderBreakdown — 单档 / 边界 / 错误', () => {
  it('单档阶梯：所有座位同价，超出也 clamp 同价', () => {
    const single: FareBucket[] = [{ quota: 10, price: 999 }];
    const r = computeLadderBreakdown({ fareBuckets: single, sold: 8, qty: 4 }); // 座位 9..12，11/12 超 quota
    expect(r.breakdown.map((b) => b.unitPrice)).toEqual([999, 999, 999, 999]);
    expect(r.totalBuckets).toBe(1);
    expect(r.currentBucket).toBe(0);
    expect(r.currentBucketRemaining).toBe(2); // 10 − 8
  });
  it('totalPrice = Σ breakdown.unitPrice（不变量）', () => {
    const r = computeLadderBreakdown({ fareBuckets: LADDER, sold: 15, qty: 9 });
    const sum = r.breakdown.reduce((s, b) => s + b.unitPrice, 0);
    expect(r.totalPrice).toBe(sum);
  });
  it('qty=0 抛错', () => {
    expect(() => computeLadderBreakdown({ fareBuckets: LADDER, sold: 0, qty: 0 })).toThrow();
  });
  it('sold=-1 抛错', () => {
    expect(() => computeLadderBreakdown({ fareBuckets: LADDER, sold: -1, qty: 1 })).toThrow();
  });
  it('空阶梯抛错', () => {
    expect(() => computeLadderBreakdown({ fareBuckets: [], sold: 0, qty: 1 })).toThrow();
  });
});
