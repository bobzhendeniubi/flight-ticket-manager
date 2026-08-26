import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma, StaffRole, UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => {
  const mock = {
    user: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(), create: vi.fn() },
    refreshToken: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation(async (callback: (tx: typeof mock) => unknown) => callback(mock));
  return mock;
});
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const passwordMock = vi.hoisted(() => ({ hashPassword: vi.fn(), verifyPassword: vi.fn() }));
vi.mock('../../lib/password.js', () => passwordMock);

vi.mock('../../lib/audit.js', () => ({
  actorFromRequest: vi.fn(() => ({ userId: 'admin-1', role: UserRole.ADMIN })),
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { userRoutes } from './users.routes.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { writeAudit } from '../../lib/audit.js';

let app: FastifyInstance;
let authenticatedUserId = 'admin-1';
let authenticatedRole = UserRole.ADMIN;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.decorate('authenticate', async (req) => {
    req.user = { sub: authenticatedUserId, role: authenticatedRole };
  });
  app.decorate('requireRole', (...roles: UserRole[]) => async (req) => {
    if (!roles.includes(req.user.role)) {
      const { ForbiddenError } = await import('../../lib/errors.js');
      throw new ForbiddenError();
    }
  });
  registerErrorHandler(app);
  await app.register(userRoutes, { prefix: '/users' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  authenticatedUserId = 'admin-1';
  authenticatedRole = UserRole.ADMIN;
  passwordMock.hashPassword.mockResolvedValue('hash');
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock));
  prismaMock.user.update.mockResolvedValue({ disabledAt: new Date() });
  prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
});

type TestPayload = Record<string, string | boolean | null>;

function request(method: 'GET' | 'POST' | 'PATCH', url: string, body?: TestPayload) {
  return app.inject({ method, url, payload: body });
}

describe('GET /users/me', () => {
  it('返回当前账号岗位，供前端在登录后刷新财务导航', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'finance@example.com',
      phone: null,
      role: UserRole.STAFF,
      staffRole: StaffRole.FINANCE,
      displayName: '财务',
      emailVerified: true,
      phoneVerified: false,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      lastLoginAt: null,
      disabledAt: null,
      mustChangePassword: false,
    });

    const res = await request('GET', '/users/me');

    expect(res.statusCode).toBe(200);
    expect(res.json().user.staffRole).toBe(StaffRole.FINANCE);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'admin-1' },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        staffRole: true,
        displayName: true,
        emailVerified: true,
        phoneVerified: true,
        createdAt: true,
        lastLoginAt: true,
        disabledAt: true,
        mustChangePassword: true,
      },
    });
  });
});

describe('POST /users/staff', () => {
  it('创建带岗位 STAFF，且审计不接触密码', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({
      id: 'staff-1',
      email: 'staff@example.com',
      displayName: '票务',
      role: UserRole.STAFF,
      staffRole: StaffRole.TICKETING,
    });

    const res = await request('POST', '/users/staff', {
      email: 'staff@example.com',
      password: 'temporary-password',
      displayName: '票务',
      role: 'STAFF',
      staffRole: 'TICKETING',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().user).not.toHaveProperty('passwordHash');
    expect(prismaMock.user.create.mock.calls[0][0].data).toMatchObject({
      staffRole: StaffRole.TICKETING,
      mustChangePassword: true,
    });
  });

  it('邮箱冲突 → 409', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'existing' });
    const res = await request('POST', '/users/staff', {
      email: 'staff@example.com',
      password: 'temporary-password',
      displayName: '票务',
      role: 'STAFF',
    });
    expect(res.statusCode).toBe(409);
  });

  it('仅接受 ADMIN/STAFF 角色', async () => {
    const res = await request('POST', '/users/staff', {
      email: 'staff@example.com',
      password: 'temporary-password',
      displayName: '票务',
      role: 'CUSTOMER',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /users/:id/disabled', () => {
  it('不能停用自己的账号', async () => {
    const res = await request('PATCH', '/users/admin-1/disabled', { disabled: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('不能停用自己的账号');
  });

  it('最后一个可用 ADMIN 不允许停用', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'admin-2', role: UserRole.ADMIN, email: 'a@example.com', displayName: '管理员', disabledAt: null,
    });
    prismaMock.user.count.mockResolvedValue(0);
    const res = await request('PATCH', '/users/admin-2/disabled', { disabled: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('至少保留一个可用的管理员账号');
  });

  it('停用用户并撤销全部未撤销 refresh token', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'staff-1', role: UserRole.STAFF, email: 's@example.com', displayName: '运营', disabledAt: null,
    });
    prismaMock.user.update.mockResolvedValue({ disabledAt: new Date() });
    const res = await request('PATCH', '/users/staff-1/disabled', { disabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'staff-1', revokedAt: null },
      data: { revokedAt: expect.any(Date), expiresAt: expect.any(Date) },
    });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'staff-1' },
      data: { disabledAt: expect.any(Date), authVersion: { increment: 1 } },
      select: { disabledAt: true },
    });
    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });

  it('STAFF 访问开户/停用端点为 403；重置内部账号密码也 403', async () => {
    authenticatedUserId = 'staff-actor';
    authenticatedRole = UserRole.STAFF;

    const create = await request('POST', '/users/staff', {
      email: 'staff@example.com', password: 'temporary-password', displayName: '票务', role: 'STAFF',
    });
    const disable = await request('PATCH', '/users/staff-1/disabled', { disabled: true });
    // 重置密码端点对 STAFF 放行到目标校验层：目标是内部账号（STAFF/ADMIN）仍拒绝
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'staff-1', email: 's@example.com', displayName: '运营', mustChangePassword: false, role: UserRole.STAFF,
    });
    const reset = await request('POST', '/users/staff-1/reset-password', { newPassword: 'temporary-password' });

    expect(create.statusCode).toBe(403);
    expect(disable.statusCode).toBe(403);
    expect(reset.statusCode).toBe(403);
    expect(reset.json().error.message).toBe('员工只能重置代理账号的密码；内部账号请找管理员');
  });

  it('STAFF 可重置代理（AGENT）账号密码', async () => {
    authenticatedUserId = 'staff-actor';
    authenticatedRole = UserRole.STAFF;
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'agent-1', email: 'a@example.com', displayName: '代理', mustChangePassword: false, role: UserRole.AGENT,
    });

    const reset = await request('POST', '/users/agent-1/reset-password', { newPassword: 'temporary-password' });

    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ ok: true });
  });

  it('Serializable 冲突 → 400 操作冲突，请重试', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('serialization conflict', {
        code: 'P2034',
        clientVersion: '5.22.0',
      }),
    );
    const res = await request('PATCH', '/users/staff-1/disabled', { disabled: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('操作冲突，请重试');
  });
});

describe('POST /users/:id/reset-password', () => {
  it('无邮箱账号 → 400', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'wechat-1', email: null, displayName: '微信用户', mustChangePassword: false,
    });
    const res = await request('POST', '/users/wechat-1/reset-password', { newPassword: 'temporary-password' });
    expect(res.statusCode).toBe(400);
  });

  it('成功后只返回 ok，并撤销会话', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'staff-1', email: 's@example.com', displayName: '运营', mustChangePassword: false,
    });
    const res = await request('POST', '/users/staff-1/reset-password', { newPassword: 'temporary-password' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.json()).not.toHaveProperty('passwordHash');
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalled();
  });

  it('不能重置自己的密码', async () => {
    const res = await request('POST', '/users/admin-1/reset-password', { newPassword: 'temporary-password' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('不能重置自己的密码，请使用「修改密码」');
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('账号管理审计不记录密码', () => {
  it('所有管理操作的审计入参序列化后均不含明文密码', async () => {
    const createPassword = 'create-secret-123';
    const resetPassword = 'reset-secret-456';

    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    prismaMock.user.create.mockResolvedValue({
      id: 'staff-1', email: 'staff@example.com', displayName: '票务', role: UserRole.STAFF, staffRole: null,
    });
    await request('POST', '/users/staff', {
      email: 'staff@example.com', password: createPassword, displayName: '票务', role: 'STAFF',
    });

    prismaMock.user.findUnique.mockResolvedValue({
      id: 'staff-1', role: UserRole.STAFF, email: 's@example.com', displayName: '运营', disabledAt: null,
    });
    await request('PATCH', '/users/staff-1/disabled', { disabled: true });

    prismaMock.user.findUnique.mockResolvedValue({
      id: 'staff-1', email: 's@example.com', displayName: '运营', mustChangePassword: false,
    });
    await request('POST', '/users/staff-1/reset-password', { newPassword: resetPassword });

    const auditInput = JSON.stringify(vi.mocked(writeAudit).mock.calls);
    expect(auditInput).not.toContain(createPassword);
    expect(auditInput).not.toContain(resetPassword);
  });
});
