import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRandomTierShortfall,
  type RandomTierShortfallReport,
} from './hotel-control.shortfall.js';
import { randomTierShortfallQuerySchema } from './hotel-control.schemas.js';
import type { RandomTierAggregate, RandomTierScope } from './hotel-control.service.js';

const { mockGetRandomTierAggregate, mockListRandomTierCities } = vi.hoisted(() => ({
  mockGetRandomTierAggregate: vi.fn(),
  mockListRandomTierCities: vi.fn(),
}));

vi.mock('./hotel-control.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hotel-control.service.js')>();
  return {
    RANDOM_STAR_TIERS: [3, 4, 5],
    randomStarTierLabel: (tier: number) => `${tier}星随机`,
    cityLabel: actual.cityLabel,
    normalizeCityCode: actual.normalizeCityCode,
    getRandomTierAggregate: mockGetRandomTierAggregate,
    listRandomTierCities: mockListRandomTierCities,
  };
});

function aggregate(
  block: number[],
  hotelUsed: number[],
  pendingUsed: number[],
  hasBlock = true,
  hotelCount = 1,
): RandomTierAggregate {
  return {
    hasBlock,
    hotelCount,
    block,
    hotelUsed,
    pendingUsed,
    remaining: block.map((value, i) => value - hotelUsed[i] - pendingUsed[i]),
  };
}

const EMPTY = aggregate([0, 0], [0, 0], [0, 0], false, 0);

describe('getRandomTierShortfall：每日加房清单', () => {
  beforeEach(() => {
    mockGetRandomTierAggregate.mockReset();
    mockListRandomTierCities.mockReset();
  });

  it('按天按档输出同一聚合口径，缺口保留 0.5 且需加房向上取整；每行带城市', async () => {
    mockListRandomTierCities.mockResolvedValue(['DAD']);
    mockGetRandomTierAggregate.mockImplementation((scope: RandomTierScope) => {
      if (scope.tier === 3) return Promise.resolve(aggregate([5, 5], [2, 2], [1, 1]));
      if (scope.tier === 4) return Promise.resolve(aggregate([4, 3], [3, 2], [2, 1.5]));
      return Promise.resolve(EMPTY);
    });

    const result = await getRandomTierShortfall('2026-09-02', '2026-09-03');

    expect(mockGetRandomTierAggregate).toHaveBeenCalledTimes(3);
    expect(mockGetRandomTierAggregate.mock.calls.map((c) => c[0])).toEqual([
      { cityCode: 'DAD', tier: 3 },
      { cityCode: 'DAD', tier: 4 },
      { cityCode: 'DAD', tier: 5 },
    ]);
    expect(result).toMatchObject({
      from: '2026-09-02',
      to: '2026-09-03',
      cities: [{ cityCode: 'DAD', cityLabel: '岘港' }],
    });
    expect(result.days).toHaveLength(2);
    expect(result.days[0].tiers).toHaveLength(2); // 五星无包房且无未落位占用时省略
    expect(result.days[0].tiers[1]).toMatchObject({
      cityCode: 'DAD',
      cityLabel: '岘港',
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

  it('两城分条：岘港三星缺 1 不影响会安三星；会安没有这一档真酒店且无占用时不出空行', async () => {
    mockListRandomTierCities.mockResolvedValue(['DAD', 'HOA']);
    mockGetRandomTierAggregate.mockImplementation((scope: RandomTierScope) => {
      if (scope.cityCode === 'DAD' && scope.tier === 3) return Promise.resolve(aggregate([2], [2], [1]));
      if (scope.cityCode === 'HOA' && scope.tier === 4) return Promise.resolve(aggregate([3], [1], [0]));
      return Promise.resolve(aggregate([0], [0], [0], false, 0));
    });

    const result = await getRandomTierShortfall('2026-09-02', '2026-09-02');

    // 每个 (城市, 档次) 各调一次聚合：2 城 × 3 档
    expect(mockGetRandomTierAggregate).toHaveBeenCalledTimes(6);
    expect(result.cities).toEqual([
      { cityCode: 'DAD', cityLabel: '岘港' },
      { cityCode: 'HOA', cityLabel: '会安' },
    ]);
    const rows = result.days[0].tiers.map((t) => ({ city: t.cityCode, tier: t.tier, shortfall: t.shortfall }));
    expect(rows).toEqual([
      { city: 'DAD', tier: 3, shortfall: 1 },
      { city: 'HOA', tier: 4, shortfall: 0 },
    ]);
  });

  it('cityCode 筛选：只算这一个城市（码归一），不再查城市清单', async () => {
    mockListRandomTierCities.mockClear();
    mockGetRandomTierAggregate.mockResolvedValue(aggregate([1], [0], [0]));

    const result = await getRandomTierShortfall('2026-09-02', '2026-09-02', undefined, { cityCode: 'hoa' });

    expect(mockListRandomTierCities).not.toHaveBeenCalled();
    expect(result.cities).toEqual([{ cityCode: 'HOA', cityLabel: '会安' }]);
    expect(mockGetRandomTierAggregate.mock.calls.every((c) => c[0].cityCode === 'HOA')).toBe(true);
  });

  it('五星无包房但有未落位占用时仍列出，缺口按需求池占用计算', async () => {
    mockListRandomTierCities.mockResolvedValue(['DAD']);
    mockGetRandomTierAggregate.mockImplementation((scope: RandomTierScope) =>
      Promise.resolve(
        scope.tier === 5
          ? aggregate([0], [0], [0.5], false, 0)
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
    mockListRandomTierCities.mockResolvedValue(['DAD']);
    mockGetRandomTierAggregate.mockImplementation((scope: RandomTierScope) =>
      Promise.resolve(
        scope.tier === 3
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
  it('to 缺省为 from 起 14 天，倒序和超过 60 天拒绝；cityCode 可选', () => {
    expect(randomTierShortfallQuerySchema.parse({ from: '2026-09-02' })).toEqual({
      from: '2026-09-02',
      to: '2026-09-15',
      cityCode: undefined,
    });
    expect(randomTierShortfallQuerySchema.parse({ from: '2026-09-02', cityCode: ' hoa ' })).toMatchObject({
      cityCode: 'hoa',
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
    expect(randomTierShortfallQuerySchema.parse({ from: '2024-02-29', to: '2024-03-01' })).toMatchObject({
      from: '2024-02-29',
      to: '2024-03-01',
    });
  });
});
