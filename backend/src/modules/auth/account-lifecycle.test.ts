import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => {
  const mock = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    refreshToken: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    agent: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation(async (callback: (tx: typeof mock) => unknown) => callback(mock));
  return mock;
});
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const passwordMock = vi.hoisted(() => ({
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));
vi.mock('../../lib/password.js', () => passwordMock);

import { AuthService } from './auth.service.js';
import { BadRequestError, ForbiddenError, UnauthorizedError } from '../../lib/errors.js';

const fakeApp = {
  jwt: { sign: vi.fn(() => 'access-token') },
} as unknown as FastifyInstance;
const service = new AuthService(fakeApp);

const baseUser = {
  id: 'user-1',
  email: 'staff@example.com',
  passwordHash: 'old-hash',
  role: UserRole.STAFF,
  displayName: '运营账号',
  mustChangePassword: true,
  disabledAt: null,
  authVersion: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  passwordMock.hashPassword.mockResolvedValue('new-hash');
  prismaMock.refreshToken.create.mockResolvedValue({});
  prismaMock.user.update.mockResolvedValue({ ...baseUser, passwordHash: 'new-hash', mustChangePassword: false, authVersion: 1 });
});

describe('AuthService.changePassword', () => {
  it('当前密码不正确 → 401', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    passwordMock.verifyPassword.mockResolvedValue(false);

    await expect(service.changePassword(baseUser.id, 'wrong', 'new-password')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('微信专属账号没有 passwordHash → 400', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...baseUser, passwordHash: null });

    await expect(service.changePassword(baseUser.id, 'current', 'new-password')).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(passwordMock.verifyPassword).not.toHaveBeenCalled();
  });

  it('成功后清除 mustChangePassword、撤销旧会话并签发当前设备新令牌', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    passwordMock.verifyPassword.mockResolvedValue(true);
    prismaMock.user.update.mockResolvedValue({ ...baseUser, passwordHash: 'new-hash', mustChangePassword: false, authVersion: 1 });

    const result = await service.changePassword(baseUser.id, 'current', 'new-password', {
      userAgent: 'test-agent',
      ipAddress: '127.0.0.1',
    });

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: baseUser.id },
      data: { passwordHash: 'new-hash', mustChangePassword: false, authVersion: { increment: 1 } },
    });
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: baseUser.id, revokedAt: null },
      data: { revokedAt: expect.any(Date), expiresAt: expect.any(Date) },
    });
    const revoke = prismaMock.refreshToken.updateMany.mock.calls[0][0].data as { expiresAt: Date };
    expect(revoke.expiresAt.getTime()).toBeLessThan(Date.now());
    expect(result.user.mustChangePassword).toBe(false);
    expect(result.tokens.accessToken).toBe('access-token');
    expect(prismaMock.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ authVersion: 1 }),
    });
  });

  it('新密码不能与当前密码相同 → 400', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    passwordMock.verifyPassword.mockResolvedValue(true);

    await expect(service.changePassword(baseUser.id, 'same-password', 'same-password')).rejects.toMatchObject({
      statusCode: 400,
      message: '新密码不能与当前密码相同',
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe('AuthService.login / refresh · disabledAt', () => {
  it('disabledAt 非空登录 → 403', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...baseUser, disabledAt: new Date() });
    passwordMock.verifyPassword.mockResolvedValue(true);

    await expect(service.login({ email: baseUser.email, password: 'correct' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(fakeApp.jwt.sign).not.toHaveBeenCalled();
  });

  it('正常登录返回 mustChangePassword', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    passwordMock.verifyPassword.mockResolvedValue(true);
    prismaMock.user.update.mockResolvedValue({});

    const result = await service.login({ email: baseUser.email, password: 'correct' });
    expect(result.user.mustChangePassword).toBe(true);
  });

  it('已停用用户 refresh → 401', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      userId: baseUser.id,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { ...baseUser, disabledAt: new Date() },
      authVersion: baseUser.authVersion,
    });

    await expect(service.refresh('refresh-token')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('refresh 版本不匹配 → 401', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      userId: baseUser.id,
      authVersion: 0,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { ...baseUser, authVersion: 1 },
    });

    await expect(service.refresh('refresh-token')).rejects.toMatchObject({
      statusCode: 401,
      message: '会话已失效，请重新登录',
    });
    expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('refresh 版本匹配 → 正常放行', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      userId: baseUser.id,
      authVersion: 1,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { ...baseUser, authVersion: 1 },
    });
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.refreshToken.create.mockResolvedValue({});

    const result = await service.refresh('refresh-token');
    expect(result.accessToken).toBe('access-token');
    expect(prismaMock.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ authVersion: 1 }),
    });
  });
});

describe('AuthService.adminResetPassword / createInternalUser', () => {
  it('管理员重置后设置 mustChangePassword 并撤销全部 refresh token', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);

    const result = await service.adminResetPassword(baseUser.id, 'temporary-password');

    expect(result).toEqual({ id: baseUser.id, email: baseUser.email, displayName: baseUser.displayName });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: baseUser.id },
      data: { passwordHash: 'new-hash', mustChangePassword: true, authVersion: { increment: 1 } },
    });
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: baseUser.id, revokedAt: null },
      data: { revokedAt: expect.any(Date), expiresAt: expect.any(Date) },
    });
  });

  it('微信专属账号不能被管理员重置密码 → 400', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...baseUser, email: null });
    await expect(service.adminResetPassword(baseUser.id, 'temporary-password')).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(passwordMock.hashPassword).not.toHaveBeenCalled();
  });

  it('内部开户写入 STAFF 岗位与 mustChangePassword，不签发 token', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({
      id: 'new-user',
      email: 'new@example.com',
      displayName: '新账号',
      role: UserRole.STAFF,
      staffRole: 'TICKETING',
    });

    const result = await service.createInternalUser({
      email: 'new@example.com',
      password: 'temporary-password',
      displayName: '新账号',
      role: UserRole.STAFF,
      staffRole: 'TICKETING',
    });

    expect(result).toEqual({
      id: 'new-user',
      email: 'new@example.com',
      displayName: '新账号',
      role: UserRole.STAFF,
      staffRole: 'TICKETING',
    });
    expect(prismaMock.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        passwordHash: 'new-hash',
        role: UserRole.STAFF,
        staffRole: 'TICKETING',
        mustChangePassword: true,
      }),
      select: { id: true, email: true, displayName: true, role: true, staffRole: true },
    });
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });
});
