/** authenticate · 首登强制改密的服务端强制：白名单外一律 403 FORCE_PASSWORD_CHANGE。 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(authPlugin);
  registerErrorHandler(app);
  // 业务路由（白名单外）
  app.get('/orders', { preHandler: app.authenticate }, async () => ({ ok: true }));
  // 白名单路由：路径需与真实注册（含前缀）一致
  app.post('/auth/change-password', { preHandler: app.authenticate }, async () => ({ ok: true }));
  app.get('/users/me', { preHandler: app.authenticate }, async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function userRow(mustChangePassword: boolean) {
  return {
    disabledAt: null,
    authVersion: 0,
    staffRole: null,
    mustChangePassword,
    agentProfile: null,
  };
}

function tokenFor(sub: string, role: UserRole): string {
  return app.jwt.sign({ sub, role, ver: 0 });
}

async function hit(method: 'GET' | 'POST', url: string, role = UserRole.STAFF) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokenFor('u-1', role)}` },
  });
}

describe('authenticate · mustChangePassword 服务端强制', () => {
  it('mustChangePassword=true 访问业务路由 → 403 FORCE_PASSWORD_CHANGE（不能绕开前端跳过改密）', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow(true));
    const res = await hit('GET', '/orders');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORCE_PASSWORD_CHANGE');
  });

  it('mustChangePassword=true 仍可调 /auth/change-password（完成改密的通道保持畅通）', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow(true));
    const res = await hit('POST', '/auth/change-password');
    expect(res.statusCode).toBe(200);
  });

  it('mustChangePassword=true 仍可调 /users/me（改密页需要当前用户信息）', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow(true));
    const res = await hit('GET', '/users/me');
    expect(res.statusCode).toBe(200);
  });

  it('mustChangePassword=false 业务路由正常放行', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow(false));
    const res = await hit('GET', '/orders');
    expect(res.statusCode).toBe(200);
  });

  it.each<UserRole>([UserRole.ADMIN, UserRole.STAFF, UserRole.CUSTOMER])(
    '%s 角色同样被强制（强制口径不区分角色）',
    async (role) => {
      prismaMock.user.findUnique.mockResolvedValue(userRow(true));
      const res = await hit('GET', '/orders', role);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORCE_PASSWORD_CHANGE');
    },
  );
});
