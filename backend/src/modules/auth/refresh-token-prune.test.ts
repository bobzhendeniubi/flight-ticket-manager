/**
 * RefreshToken 过期行清理 · 单测。
 * 钉住两件事：删的是「过期超过保留窗口」的行（不是刚过期就删），以及返回值是删掉的行数。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import { pruneExpiredRefreshTokens, REFRESH_TOKEN_RETAIN_DAYS } from './refresh-token-prune.js';

describe('pruneExpiredRefreshTokens', () => {
  it('只删过期超过保留窗口的行：cutoff = now − RETAIN_DAYS', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const now = new Date('2026-09-17T06:00:00.000Z');

    const deleted = await pruneExpiredRefreshTokens(now, { refreshToken: { deleteMany } } as never);

    expect(deleted).toBe(3);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const where = deleteMany.mock.calls[0][0].where;
    const expectedCutoff = new Date(now.getTime() - REFRESH_TOKEN_RETAIN_DAYS * 86_400_000);
    expect(where).toEqual({ expiresAt: { lt: expectedCutoff } });
  });

  it('保留窗口是 30 天（刚过期的行先留着，供安全排查翻登录设备）', () => {
    expect(REFRESH_TOKEN_RETAIN_DAYS).toBe(30);
  });
});
