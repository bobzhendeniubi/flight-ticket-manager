import { describe, expect, it, vi } from 'vitest';
import {
  getRandomTierShortfall,
  type RandomTierShortfallReport,
} from './hotel-control.shortfall.js';
import { randomTierShortfallQuerySchema } from './hotel-control.schemas.js';
import type { RandomTierAggregate } from './hotel-control.service.js';

const { mockGetRandomTierAggregate } = vi.hoisted(() => ({
  mockGetRandomTierAggregate: vi.fn(),
}));

vi.mock('./hotel-control.service.js', () => ({
  RANDOM_STAR_TIERS: [3, 4, 5],
  randomStarTierLabel: (tier: number) => `${tier}星随机`,
  getRandomTierAggregate: mockGetRandomTierAggregate,
}));

function aggregate(
  block: number[],
  hotelUsed: number[],
  pendingUsed: number[],
  hasBlock = true,
): RandomTierAggregate {
  return {
    hasBlock,
    block,
    hotelUsed,
    pendingUsed,
    remaining: block.map((value, i) => value - hotelUsed[i] - pendingUsed[i]),
  };
}

describe('getRandomTierShortfall：每日加房清单', () => {
  it('按天按档输出同一聚合口径，缺口保留 0.5 且需加房向上取整', async () => {
    mockGetRandomTierAggregate.mockImplementation((tier: number) => {
      if (tier === 3) return Promise.resolve(aggregate([5, 5], [2, 2], [1, 1]));
      if (tier === 4) return Promise.resolve(aggregate([4, 3], [3, 2], [2, 1.5]));
      return Promise.resolve(aggregate([0, 0], [0, 0], [0, 0], false));
    });

    const result = await getRandomTierShortfall('2026-09-02', '2026-09-03');

    expect(mockGetRandomTierAggregate).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ from: '2026-09-02', to: '2026-09-03' });
    expect(result.days).toHaveLength(2);
    expect(result.days[0].tiers).toHaveLength(2); // 五星无包房且无未落位占用时省略
    expect(result.days[0].tiers[1]).toMatchObject({
      tier: 4,
      block: 4,
      hotelUsed: 3,
      pendingUsed: 2,
      remaining: -1,
      shortfall: 1,
      roomsToRequest: 1,
    });
    expect(result.days[1].tiers[1]).toMatchObject({
      tier: 4,
      remaining: -0.5,
      shortfall: 0.5,
      roomsToRequest: 1,
    });
  });

  it('五星无包房但有未落位占用时仍列出，缺口按需求池占用计算', async () => {
    mockGetRandomTierAggregate.mockImplementation((tier: number) =>
      Promise.resolve(
        tier === 5
          ? aggregate([0], [0], [0.5], false)
          : aggregate([0], [0], [0], false),
      ),
    );

    const result: RandomTierShortfallReport = await getRandomTierShortfall(
      '2026-09-02',
      '2026-09-02',
    );
    expect(result.days[0].tiers).toHaveLength(3);
    expect(result.days[0].tiers.find((tier) => tier.tier === 5)).toMatchObject({
      tier: 5,
      hasBlock: false,
      pendingUsed: 0.5,
      shortfall: 0.5,
      roomsToRequest: 1,
    });
  });

  it('hasBlock 按日期由 block 派生，区间内部分切房不会污染其它日期', async () => {
    mockGetRandomTierAggregate.mockImplementation((tier: number) =>
      Promise.resolve(
        tier === 3
          ? aggregate([0, 4], [0, 1], [1, 1], true)
          : aggregate([0, 0], [0, 0], [0, 0], false),
      ),
    );

    const result = await getRandomTierShortfall('2026-09-02', '2026-09-03');
    expect(result.days[0].tiers.find((tier) => tier.tier === 3)).toMatchObject({
      hasBlock: false,
      block: 0,
      shortfall: 1,
    });
    expect(result.days[1].tiers.find((tier) => tier.tier === 3)).toMatchObject({
      hasBlock: true,
      block: 4,
      shortfall: 0,
    });
  });
});

describe('randomTierShortfallQuerySchema', () => {
  it('to 缺省为 from 起 14 天，倒序和超过 60 天拒绝', () => {
    expect(randomTierShortfallQuerySchema.parse({ from: '2026-09-02' })).toEqual({
      from: '2026-09-02',
      to: '2026-09-15',
    });
    expect(() =>
      randomTierShortfallQuerySchema.parse({ from: '2026-09-03', to: '2026-09-02' }),
    ).toThrow();
    expect(() =>
      randomTierShortfallQuerySchema.parse({ from: '2026-09-01', to: '2026-10-31' }),
    ).toThrow(/最多 60 天/);
  });

  it('拒绝不存在的真实日期，闰年日期按 UTC 历法校验', () => {
    expect(() =>
      randomTierShortfallQuerySchema.parse({ from: '2026-02-31', to: '2026-03-05' }),
    ).toThrow(/有效的日历日期/);
    expect(() =>
      randomTierShortfallQuerySchema.parse({ from: '2026-13-01' }),
    ).toThrow(/有效的日历日期/);
    expect(() =>
      randomTierShortfallQuerySchema.parse({ from: '2025-02-29' }),
    ).toThrow(/有效的日历日期/);
    expect(randomTierShortfallQuerySchema.parse({ from: '2024-02-29', to: '2024-03-01' })).toEqual({
      from: '2024-02-29',
      to: '2024-03-01',
    });
  });
});
