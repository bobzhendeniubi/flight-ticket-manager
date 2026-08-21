import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  marketingPoster: {
    count: vi.fn(),
    groupBy: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import {
  assertPosterQuota,
  buildMarketingUsage,
  getMarketingUsage,
  MarketingQuotaError,
  marketingQuotaErrorBody,
} from './marketing.service.js';

describe('海报每日配额', () => {
  it('按用户配额：未达可生成，刚好达到和超出都拒绝', () => {
    expect(() => assertPosterQuota({ mine: 9, total: 49 }, { perUser: 10, total: 50 })).not.toThrow();
    expect(() => assertPosterQuota({ mine: 10, total: 10 }, { perUser: 10, total: 50 })).toThrow('今日已生成 10/10 张，明日恢复');
    expect(() => assertPosterQuota({ mine: 11, total: 11 }, { perUser: 10, total: 50 })).toThrow(MarketingQuotaError);
  });

  it('按团队配额：未达可生成，刚好达到和超出都拒绝', () => {
    expect(() => assertPosterQuota({ mine: 2, total: 49 }, { perUser: 10, total: 50 })).not.toThrow();
    expect(() => assertPosterQuota({ mine: 2, total: 50 }, { perUser: 10, total: 50 })).toThrow('今日团队额度已用完（50/50 张），明日恢复');
    expect(() => assertPosterQuota({ mine: 2, total: 51 }, { perUser: 10, total: 50 })).toThrow(MarketingQuotaError);
  });

  it('429 使用稳定的 error 结构并提示联系管理员', () => {
    const error = new MarketingQuotaError('user', 10, 10);
    expect(error.statusCode).toBe(429);
    expect(marketingQuotaErrorBody(error)).toEqual({
      error: {
        code: 'POSTER_DAILY_USER_LIMIT',
        message: '今日已生成 10/10 张，明日恢复；如需调整，请联系管理员',
        details: { scope: 'user', current: 10, limit: 10 },
      },
    });
  });
});

describe('海报用量统计', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('按 imageModel 分组，并把 attempts 求和为真实调用次数', async () => {
    prismaMock.$transaction.mockResolvedValue([
      12,
      4,
      31,
      [
        { imageModel: 'qwen-image-3.0-pro', _count: { _all: 3 }, _sum: { attempts: 7 } },
        { imageModel: 'qwen-image-2.0-pro', _count: { _all: 28 }, _sum: { attempts: 31 } },
      ],
    ]);

    const usage = await getMarketingUsage('staff-1', new Date('2026-08-21T09:00:00'));

    expect(usage).toEqual({
      today: { total: 12, mine: 4, limitPerUser: 10, limitTotal: 50 },
      month: {
        total: 31,
        byModel: [
          { model: 'qwen-image-2.0-pro', count: 28, attempts: 31 },
          { model: 'qwen-image-3.0-pro', count: 3, attempts: 7 },
        ],
      },
    });
  });

  it('用量格式化保留模型分组并按模型名稳定排序', () => {
    const usage = buildMarketingUsage(
      { mine: 1, total: 2, monthTotal: 3 },
      [
        { model: 'wan2.1', count: 1, attempts: 2 },
        { model: 'qwen-image-2.0-pro', count: 2, attempts: 2 },
      ],
    );
    expect(usage.month.byModel.map((item) => item.model)).toEqual([
      'qwen-image-2.0-pro',
      'wan2.1',
    ]);
  });
});
