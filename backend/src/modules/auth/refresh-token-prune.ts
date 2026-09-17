/**
 * RefreshToken 过期行清理。
 *
 * 每次登录 / 每次刷新轮换都会新增一行（旧行只标 revokedAt，不删），从没有清理过：
 * 2026-09-17 实测库 22618 行里 16068 行早已过期。过期行既不能再换 access token（refresh 先看
 * expiresAt），也不参与任何统计，留着只是让表和索引白长。
 *
 * 只删「过期超过 REFRESH_TOKEN_RETAIN_DAYS 天」的行：刚过期的先留一段时间，排查「某账号什么时候
 * 在哪台设备登过」这类安全问题时还能翻到 userAgent / ipAddress；登出会把 expiresAt 打到过去，
 * 同样按这个窗口保留后再删。
 */
import { prisma } from '../../db/prisma.js';

/** 过期后再保留多少天才物理删除。 */
export const REFRESH_TOKEN_RETAIN_DAYS = 30;

type PruneDb = Pick<typeof prisma, 'refreshToken'>;

/** 删除过期超过保留窗口的 refresh token 行，返回删掉的行数。 */
export async function pruneExpiredRefreshTokens(
  now: Date = new Date(),
  client: PruneDb = prisma,
): Promise<number> {
  const cutoff = new Date(now.getTime() - REFRESH_TOKEN_RETAIN_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await client.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return count;
}
