/**
 * 动态定价 · 单元测试（vitest）
 *
 * 这些测试覆盖 pricing.calc.ts 里所有的纯数学。
 * 注意：pricing.service.ts 里 calculatePrice 内部 inline 写的同一套公式，
 * 必须与本文件保持一致。如果未来重构把 service 改成调用 calc，
 * 这些测试会立即捕获回归。
 */
import { describe, it, expect } from 'vitest';
import {
  BUCKET_SIZE,
  BUCKET_START_MULT,
  BUCKET_END_MULT,
  RANK_MULTIPLIER,
  getBucketMultiplier,
  getDateMultiplier,
  bucketOfSeat,
  totalBucketsForCapacity,
  computePerSeatBreakdown,
} from './pricing.calc.js';

describe('getDateMultiplier', () => {
  it('A=1.5, B=1.2, C=1.0, D=0.8', () => {
    expect(getDateMultiplier('A')).toBe(1.5);
    expect(getDateMultiplier('B')).toBe(1.2);
    expect(getDateMultiplier('C')).toBe(1.0);
    expect(getDateMultiplier('D')).toBe(0.8);
  });
  it('未知 rank 默认 1.0', () => {
    expect(getDateMultiplier('Z')).toBe(1.0);
    expect(getDateMultiplier('')).toBe(1.0);
  });
  it('与 RANK_MULTIPLIER 表保持一致', () => {
    for (const [k, v] of Object.entries(RANK_MULTIPLIER)) {
      expect(getDateMultiplier(k)).toBe(v);
    }
  });
});

describe('bucketOfSeat', () => {
  it('1-10 张票 → bucket 0', () => {
    expect(bucketOfSeat(1)).toBe(0);
    expect(bucketOfSeat(10)).toBe(0);
  });
  it('11-20 张票 → bucket 1', () => {
    expect(bucketOfSeat(11)).toBe(1);
    expect(bucketOfSeat(20)).toBe(1);
  });
  it('171-180 张票 → bucket 17（标准 180 座飞机最贵档）', () => {
    expect(bucketOfSeat(171)).toBe(17);
    expect(bucketOfSeat(180)).toBe(17);
  });
});

describe('totalBucketsForCapacity', () => {
  it('容量 180 → 18 个 bucket', () => {
    expect(totalBucketsForCapacity(180)).toBe(18);
  });
  it('容量 20（小机型）→ 2 个 bucket', () => {
    expect(totalBucketsForCapacity(20)).toBe(2);
  });
  it('容量 1 → 至少 1 个 bucket（防除以 0）', () => {
    expect(totalBucketsForCapacity(1)).toBe(1);
  });
  it('容量 0 → 仍返回 1（边界保护）', () => {
    expect(totalBucketsForCapacity(0)).toBe(1);
  });
  it('容量 11（不能整除）→ ceil = 2', () => {
    expect(totalBucketsForCapacity(11)).toBe(2);
  });
});

describe('getBucketMultiplier', () => {
  it('单 bucket → 永远 1.0（小机型不动态调价）', () => {
    expect(getBucketMultiplier(0, 1)).toBe(1.0);
    expect(getBucketMultiplier(5, 1)).toBe(1.0);
  });
  it('totalBuckets=18：bucket 0 = 0.7（最便宜）', () => {
    expect(getBucketMultiplier(0, 18)).toBeCloseTo(BUCKET_START_MULT, 6);
  });
  it('totalBuckets=18：bucket 17 = 1.55（最贵）', () => {
    expect(getBucketMultiplier(17, 18)).toBeCloseTo(BUCKET_END_MULT, 6);
  });
  it('线性递增（总差 0.85）', () => {
    const step = (BUCKET_END_MULT - BUCKET_START_MULT) / 17; // 0.85 / 17 = 0.05
    expect(getBucketMultiplier(1, 18) - getBucketMultiplier(0, 18)).toBeCloseTo(step, 6);
    expect(getBucketMultiplier(10, 18) - getBucketMultiplier(9, 18)).toBeCloseTo(step, 6);
  });
  it('bucket index 超过 totalBuckets → clamp 到最贵档（防越界）', () => {
    expect(getBucketMultiplier(100, 18)).toBeCloseTo(BUCKET_END_MULT, 6);
  });
});

describe('computePerSeatBreakdown — 基本场景', () => {
  it('空机（sold=0）买 1 张经济舱 ¥1000，C 平峰 → bucket 0 × 0.7 = 700', () => {
    const r = computePerSeatBreakdown({
      basePrice: 1000,
      dateRank: 'C',
      capacity: 180,
      sold: 0,
      qty: 1,
    });
    expect(r.dateMultiplier).toBe(1.0);
    expect(r.totalBuckets).toBe(18);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0]).toMatchObject({ seatIndex: 1, bucket: 0 });
    expect(r.breakdown[0].unitPrice).toBe(700); // 1000 × 1.0 × 0.7
    expect(r.totalPrice).toBe(700);
    expect(r.averageUnitPrice).toBe(700);
  });

  it('A 黄金 ×1.5 + bucket 0 ×0.7 → 1000 × 1.5 × 0.7 = 1050', () => {
    const r = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'A', capacity: 180, sold: 0, qty: 1 });
    expect(r.breakdown[0].unitPrice).toBe(1050);
  });

  it('D 优惠 ×0.8 + bucket 0 ×0.7 → 1000 × 0.8 × 0.7 = 560', () => {
    const r = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'D', capacity: 180, sold: 0, qty: 1 });
    expect(r.breakdown[0].unitPrice).toBe(560);
  });

  it('已售 100 张（bucket 10 起步）→ 中段倍率', () => {
    const r = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: 100, qty: 1 });
    expect(r.breakdown[0].seatIndex).toBe(101);
    expect(r.breakdown[0].bucket).toBe(10);
    // bucket 10 multiplier = 0.7 + (1.55-0.7) * 10/17 = 0.7 + 0.5 = 1.2
    expect(r.breakdown[0].bucketMultiplier).toBeCloseTo(1.2, 6);
    expect(r.breakdown[0].unitPrice).toBe(1200);
  });
});

describe('computePerSeatBreakdown — 跨 bucket 自动升价（核心 feature）', () => {
  it('已售 8（bucket 0 剩 2 张）+ 买 5 张 → 前 2 张当前价 + 后 3 张下一 bucket', () => {
    const r = computePerSeatBreakdown({
      basePrice: 1000,
      dateRank: 'C',
      capacity: 180,
      sold: 8,
      qty: 5,
    });
    // seat 9, 10 → bucket 0 (×0.7)
    // seat 11, 12, 13 → bucket 1 (×0.75)
    expect(r.breakdown[0].bucket).toBe(0);
    expect(r.breakdown[1].bucket).toBe(0);
    expect(r.breakdown[2].bucket).toBe(1);
    expect(r.breakdown[3].bucket).toBe(1);
    expect(r.breakdown[4].bucket).toBe(1);

    expect(r.breakdown[0].unitPrice).toBe(700);
    expect(r.breakdown[2].unitPrice).toBe(750); // 0.05 step

    // total = 700×2 + 750×3 = 1400 + 2250 = 3650
    expect(r.totalPrice).toBe(3650);
    expect(r.averageUnitPrice).toBe(730); // round(3650/5)
    expect(r.currentBucket).toBe(0);
    expect(r.currentBucketRemaining).toBe(2);
  });

  it('正好 buckets 边界：sold=10 + 买 1 张 → bucket 1', () => {
    const r = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: 10, qty: 1 });
    expect(r.breakdown[0].bucket).toBe(1);
    expect(r.currentBucket).toBe(1);
    expect(r.currentBucketRemaining).toBe(BUCKET_SIZE);
  });

  it('容量末尾（接近 180）的剩余正确（防越界）', () => {
    const r = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: 175, qty: 5 });
    expect(r.breakdown).toHaveLength(5);
    expect(r.breakdown[0].bucket).toBe(17); // seat 176
    expect(r.breakdown[4].bucket).toBe(17); // seat 180
    expect(r.currentBucketRemaining).toBe(5); // 180 - 175
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
  it('每张 unitPrice = round(basePrice × dateMul × bucketMul)', () => {
    const r = computePerSeatBreakdown({ basePrice: 829, dateRank: 'B', capacity: 180, sold: 47, qty: 6 });
    for (const seat of r.breakdown) {
      expect(seat.unitPrice).toBe(Math.round(829 * r.dateMultiplier * seat.bucketMultiplier));
    }
  });
  it('seatIndex 严格递增 sold+1 .. sold+qty', () => {
    const r = computePerSeatBreakdown({ basePrice: 1000, dateRank: 'C', capacity: 180, sold: 50, qty: 8 });
    expect(r.breakdown.map((b: { seatIndex: number }) => b.seatIndex)).toEqual([51, 52, 53, 54, 55, 56, 57, 58]);
  });
});
