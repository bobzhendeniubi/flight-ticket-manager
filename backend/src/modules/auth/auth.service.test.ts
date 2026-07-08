/**
 * AuthService.refresh · 刷新令牌轮换 + 并发宽限窗单测（vitest，mock prisma）
 *
 * 回归本次修复：正常使用中的毫秒级并发刷新（多标签 / 定时续期与 401 重试撞车 / 双挂载）
 * 不再被后端一次性轮换判定为「token 重放」而撤销整个会话——只拒绝那一次并发请求。
 * 真正的重放（旧 token 很久以前就被作废）仍然全撤销强制重登录。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const prismaMock = vi.hoisted(() => {
  const mock: {
    refreshToken: {
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    user: { update: ReturnType<typeof vi.fn> };
  } = {
    refreshToken: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    user: { update: vi.fn() },
  };
  return mock;
});
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import { AuthService, RefreshTokenRaceError } from './auth.service.js';
import { UnauthorizedError } from '../../lib/errors.js';

const fakeApp = {
  jwt: { sign: vi.fn(() => 'header.payload.signature') },
} as unknown as FastifyInstance;

const service = new AuthService(fakeApp);

const baseUser = { id: 'user-1', email: 'a@b.c', role: 'STAFF', displayName: 'Op' };

function makeRecord(over: Partial<{ revokedAt: Date | null; expiresAt: Date }> = {}) {
  return {
    id: 'rt-1',
    userId: baseUser.id,
    tokenHash: 'hash',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    user: baseUser,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuthService.refresh · 轮换 + 宽限窗', () => {
  it('正常刷新：有效未作废 token → CAS 抢到 → 轮换发新令牌', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(makeRecord());
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 }); // CAS 抢到
    prismaMock.refreshToken.create.mockResolvedValue({});

    const tokens = await service.refresh('raw-refresh-token');

    expect(tokens.accessToken).toBe('header.payload.signature');
    expect(typeof tokens.refreshToken).toBe('string');
    // 只调用了一次 updateMany（CAS 作废旧 token），没有走全撤销
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.refreshToken.create).toHaveBeenCalledTimes(1);
  });

  it('并发竞争（宽限窗内已被作废）：只拒绝这一次，不撤销整会话', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(
      makeRecord({ revokedAt: new Date(Date.now() - 1000) }), // 1s 前刚被兄弟刷新轮换掉
    );

    await expect(service.refresh('raw-refresh-token')).rejects.toBeInstanceOf(
      RefreshTokenRaceError,
    );
    // 关键：没有全撤销、没有发新 token
    expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });

  it('真正的重放（很久以前已作废，超过宽限窗）：撤销该用户所有会话 + 401', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(
      makeRecord({ revokedAt: new Date(Date.now() - 60 * 60 * 1000) }), // 1 小时前作废
    );
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 3 });

    await expect(service.refresh('raw-refresh-token')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    // 走了全撤销（按 userId 撤销所有未作废 token）
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: baseUser.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });

  it('CAS 抢锁失败（count=0，find 与 CAS 之间被并发轮换）：竞争错误，不撤销整会话', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(makeRecord()); // 读到时还没作废
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 0 }); // 抢锁失败

    await expect(service.refresh('raw-refresh-token')).rejects.toBeInstanceOf(
      RefreshTokenRaceError,
    );
    // 只调用了一次 updateMany（那次失败的 CAS），没有第二次全撤销
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });

  it('token 不存在 → 401', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(null);
    await expect(service.refresh('nope')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('token 已过期 → 401（不看 revokedAt）', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(
      makeRecord({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(service.refresh('expired')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});
