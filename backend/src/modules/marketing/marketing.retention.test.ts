import { beforeEach, describe, expect, it, vi } from 'vitest';

const marketingPoster = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: { marketingPoster } }));

import {
  POSTER_IMAGE_KEEP_MAX,
  POSTER_IMAGE_RETENTION_DAYS,
  pruneposterImages,
} from './marketing.retention.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-08-20T00:00:00.000Z');

function candidate(id: string, createdAt: Date) {
  return { id, createdAt };
}

describe('pruneposterImages — 海报图片保留期清理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    marketingPoster.findMany.mockResolvedValue([]);
    marketingPoster.updateMany.mockResolvedValue({ count: 0 });
  });

  it('清空超过保留期的图片，保留未超过保留期的图片', async () => {
    const cutoff = new Date(
      now.getTime() - POSTER_IMAGE_RETENTION_DAYS * MILLISECONDS_PER_DAY,
    );
    marketingPoster.findMany.mockResolvedValue([
      candidate(
        'too-old',
        new Date(cutoff.getTime() - MILLISECONDS_PER_DAY),
      ),
      candidate('at-cutoff', cutoff),
      candidate('recent', new Date(cutoff.getTime() + MILLISECONDS_PER_DAY)),
    ]);
    marketingPoster.updateMany.mockResolvedValue({ count: 1 });

    const result = await pruneposterImages(now);

    expect(result).toEqual({ pruned: 1 });
    expect(marketingPoster.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['too-old'] },
        imageDataUrl: { not: null },
      },
      data: { imageDataUrl: null },
    });
  });

  it('清空超过数量上限的旧图片，保留最近的 200 张图片', async () => {
    const posters = Array.from({ length: POSTER_IMAGE_KEEP_MAX + 2 }, (_, index) =>
      candidate(
        `poster-${index}`,
        new Date(now.getTime() - index * 60 * 1000),
      ),
    );
    marketingPoster.findMany.mockResolvedValue(posters);
    marketingPoster.updateMany.mockResolvedValue({ count: 2 });

    const result = await pruneposterImages(now);

    expect(result).toEqual({ pruned: 2 });
    expect(marketingPoster.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [`poster-${POSTER_IMAGE_KEEP_MAX}`, `poster-${POSTER_IMAGE_KEEP_MAX + 1}`] },
        imageDataUrl: { not: null },
      },
      data: { imageDataUrl: null },
    });
  });

  it('不重复处理已经没有图片的记录', async () => {
    const result = await pruneposterImages(now);

    expect(result).toEqual({ pruned: 0 });
    expect(marketingPoster.findMany).toHaveBeenCalledWith({
      where: { imageDataUrl: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true },
    });
    expect(marketingPoster.updateMany).not.toHaveBeenCalled();
  });

  it('更新时只清空图片字段，其它字段不变', async () => {
    marketingPoster.findMany.mockResolvedValue([
      candidate(
        'old-poster',
        new Date(
          now.getTime() -
            (POSTER_IMAGE_RETENTION_DAYS + 1) * MILLISECONDS_PER_DAY,
        ),
      ),
    ]);
    marketingPoster.updateMany.mockResolvedValue({ count: 1 });

    await pruneposterImages(now);

    expect(marketingPoster.updateMany).toHaveBeenCalledTimes(1);
    expect(marketingPoster.updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        id: { in: ['old-poster'] },
        imageDataUrl: { not: null },
      },
      data: { imageDataUrl: null },
    });
  });
});
