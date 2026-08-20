import { prisma } from '../../db/prisma.js';

/** 超过这个天数的海报只保留元信息，清空图片。 */
export const POSTER_IMAGE_RETENTION_DAYS = 90;
/** 无论时间，最多保留这么多张「还带图」的海报。 */
export const POSTER_IMAGE_KEEP_MAX = 200;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export async function pruneposterImages(now: Date): Promise<{ pruned: number }> {
  const cutoff = new Date(
    now.getTime() - POSTER_IMAGE_RETENTION_DAYS * MILLISECONDS_PER_DAY,
  );
  const candidates = await prisma.marketingPoster.findMany({
    where: { imageDataUrl: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, createdAt: true },
  });

  const idsToPrune = candidates
    .filter(
      (poster, index) =>
        poster.createdAt < cutoff || index >= POSTER_IMAGE_KEEP_MAX,
    )
    .map((poster) => poster.id);

  if (idsToPrune.length === 0) return { pruned: 0 };

  const result = await prisma.marketingPoster.updateMany({
    where: {
      id: { in: idsToPrune },
      imageDataUrl: { not: null },
    },
    data: { imageDataUrl: null },
  });

  return { pruned: result.count };
}
