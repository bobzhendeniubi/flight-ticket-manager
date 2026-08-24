/**
 * AuthService.refresh · 刷新令牌轮换 + 并发宽限窗单测（vitest，mock prisma）
 *
 * 回归本次修复：正常使用中的毫秒级并发刷新（多标签 / 定时续期与 401 重试撞车 / 双挂载）
 * 不再被后端一次性轮换判定为「token 重放」而撤销整个会话——只拒绝那一次并发请求。
 * 真正的重放（旧 token 很久以前就被作废）仍然全撤销强制重登录。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => {
  const mock: {
    refreshToken: {
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    agent: { findUnique: ReturnType<typeof vi.fn> };
  } = {
    refreshToken: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn() },
    agent: { findUnique: vi.fn() },
  };
  return mock;
});
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const passwordMock = vi.hoisted(() => ({
  verifyPassword: vi.fn(),
}));
vi.mock('../../lib/password.js', () => passwordMock);

import { AuthService, RefreshTokenRaceError } from './auth.service.js';
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js';

const fakeApp = {
  jwt: { sign: vi.fn(() => 'header.payload.signature') },
} as unknown as FastifyInstance;

const service = new AuthService(fakeApp);

const baseUser = { id: 'user-1', email: 'a@b.c', role: 'STAFF', displayName: 'Op', authVersion: 0 };

function makeRecord(over: Partial<{ revokedAt: Date | null; expiresAt: Date; authVersion: number }> = {}) {
  return {
    id: 'rt-1',
    userId: baseUser.id,
    tokenHash: 'hash',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    user: baseUser,
    authVersion: baseUser.authVersion,
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

  it('迟到并发（作废于宽限窗内，30s 前）：仍判并发竞争，不撤销整会话', async () => {
    // 回归多标签场景：后台隐藏标签被节流，兄弟标签轮换后几十秒才拿旧 token 来刷。
    // 30s 仍在 60s 宽限窗内 → 必须按 REFRESH_TOKEN_RACE 处理（旧 10s 窗会误判成重放而全撤销）。
    prismaMock.refreshToken.findUnique.mockResolvedValue(
      makeRecord({ revokedAt: new Date(Date.now() - 30 * 1000) }),
    );

    await expect(service.refresh('raw-refresh-token')).rejects.toBeInstanceOf(
      RefreshTokenRaceError,
    );
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
      // 同时把 expiresAt 打到过去 —— 被撤销的兄弟会话必须直接吃 401，不能在宽限窗里当良性竞争
      data: { revokedAt: expect.any(Date), expiresAt: expect.any(Date) },
    });
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });

  it('重放全撤销：兄弟 token 的 expiresAt 被打到过去 → 它们下一次刷新走 401 而非 409', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(
      makeRecord({ revokedAt: new Date(Date.now() - 60 * 60 * 1000) }),
    );
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 3 });

    await expect(service.refresh('replayed')).rejects.toBeInstanceOf(UnauthorizedError);

    const written = prismaMock.refreshToken.updateMany.mock.calls[0][0].data as { expiresAt: Date };
    expect(written.expiresAt.getTime()).toBeLessThan(Date.now());

    // 关键回归：拿一枚「刚刚被全撤销」的兄弟 token 再来刷。它的 revokedAt 就在 60s 宽限窗内，
    // 旧实现会判成良性并发竞争（409·可重试）；现在 expiresAt 已过期 → 走会话终结分支（401）。
    prismaMock.refreshToken.findUnique.mockResolvedValue(
      makeRecord({ revokedAt: new Date(), expiresAt: written.expiresAt }),
    );
    const err = await service.refresh('sibling-of-revoked').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).not.toBeInstanceOf(RefreshTokenRaceError);
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

  it('同一枚 token 两个并发刷新：只有 CAS 抢到的那个发新令牌，另一个是 409 而非会话失效', async () => {
    // 回归「access token 过期瞬间页面并行请求全体 401」的场景：即便前端 single-flight 失手
    // 漏出第二个刷新，后端也只能有一个赢；输的那个必须是可重试的 409，绝不能撤销会话。
    prismaMock.refreshToken.findUnique.mockResolvedValue(makeRecord());
    let casCalls = 0;
    prismaMock.refreshToken.updateMany.mockImplementation(async () => {
      casCalls += 1;
      return { count: casCalls === 1 ? 1 : 0 }; // 第一个抢到，第二个抢空
    });
    prismaMock.refreshToken.create.mockResolvedValue({});

    const [winner, loser] = await Promise.allSettled([
      service.refresh('same-raw-token'),
      service.refresh('same-raw-token'),
    ]);

    expect(winner.status).toBe('fulfilled');
    expect(loser.status).toBe('rejected');
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(RefreshTokenRaceError);
    // 只发了一份新令牌，且没有任何一次全撤销（updateMany 两次都是 CAS，不是按 userId 撤销）
    expect(prismaMock.refreshToken.create).toHaveBeenCalledTimes(1);
    for (const call of prismaMock.refreshToken.updateMany.mock.calls) {
      expect(call[0].where).toHaveProperty('id');
    }
  });
});

describe('AuthService.logout · 主动登出是确凿的会话终结', () => {
  it('登出把 revokedAt 与 expiresAt 一起写掉 —— 登出后再刷是 401，不落进并发宽限窗', async () => {
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });

    await service.logout('raw-refresh-token');

    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    const { data } = prismaMock.refreshToken.updateMany.mock.calls[0][0] as {
      data: { revokedAt: Date; expiresAt: Date };
    };
    expect(data.revokedAt).toBeInstanceOf(Date);
    expect(data.expiresAt.getTime()).toBeLessThan(Date.now());

    // 用登出后的那条记录再刷：revokedAt 刚刚发生（宽限窗内），但 expiresAt 已过期 →
    // 必须是 401（请重新登录），而不是 409（稍后重试）。
    prismaMock.refreshToken.findUnique.mockResolvedValue(
      makeRecord({ revokedAt: data.revokedAt, expiresAt: data.expiresAt }),
    );
    const err = await service.refresh('raw-refresh-token').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).not.toBeInstanceOf(RefreshTokenRaceError);
  });
});

describe('AuthService.login · 代理停用拦截', () => {
  const agentUser = { ...baseUser, id: 'agent-user-1', role: UserRole.AGENT, passwordHash: 'hash' };

  it('role=AGENT 且 Agent.isActive=false → 403，不签发 token / 不更新 lastLoginAt', async () => {
    prismaMock.user.findUnique.mockResolvedValue(agentUser);
    passwordMock.verifyPassword.mockResolvedValue(true);
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: false });

    await expect(
      service.login({ email: agentUser.email, password: 'correct-password' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.login({ email: agentUser.email, password: 'correct-password' }),
    ).rejects.toThrow(/账号已停用/);

    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(fakeApp.jwt.sign).not.toHaveBeenCalled();
  });

  it('role=AGENT 且 Agent.isActive=true → 正常登录发 token', async () => {
    prismaMock.user.findUnique.mockResolvedValue(agentUser);
    passwordMock.verifyPassword.mockResolvedValue(true);
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: true });
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.refreshToken.create.mockResolvedValue({});

    const result = await service.login({ email: agentUser.email, password: 'correct-password' });

    expect(result.tokens.accessToken).toBe('header.payload.signature');
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: agentUser.id },
      data: { lastLoginAt: expect.any(Date) },
    });
  });

  it('role≠AGENT（如 STAFF）→ 不查 Agent.isActive，正常登录', async () => {
    const staffUser = { ...baseUser, passwordHash: 'hash' }; // baseUser.role === 'STAFF'
    prismaMock.user.findUnique.mockResolvedValue(staffUser);
    passwordMock.verifyPassword.mockResolvedValue(true);
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.refreshToken.create.mockResolvedValue({});

    const result = await service.login({ email: staffUser.email, password: 'correct-password' });

    expect(result.tokens.accessToken).toBe('header.payload.signature');
    expect(prismaMock.agent.findUnique).not.toHaveBeenCalled();
  });

  it('密码错误 → 401（先于停用检查）', async () => {
    prismaMock.user.findUnique.mockResolvedValue(agentUser);
    passwordMock.verifyPassword.mockResolvedValue(false);

    await expect(
      service.login({ email: agentUser.email, password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.agent.findUnique).not.toHaveBeenCalled();
  });
});
