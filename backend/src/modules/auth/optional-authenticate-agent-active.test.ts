/** optionalAuthenticate · 停用账号按既有口径降级为游客。 */
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
  app.get('/optional', { preHandler: app.optionalAuthenticate }, async (req) => ({
    identified: Boolean(req.user),
    role: req.user?.role ?? null,
    sub: req.user?.sub ?? null,
  }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function tokenFor(sub: string, role: UserRole): string {
  return app.jwt.sign({ sub, role });
}

async function hitOptional(headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: '/optional', headers });
}

describe('optionalAuthenticate · 停用账号降级为匿名', () => {
  it('AGENT 不活跃 → 游客 200', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ disabledAt: null, agentProfile: { isActive: false } });
    const res = await hitOptional({ authorization: `Bearer ${tokenFor('agent-user-1', UserRole.AGENT)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identified: false, role: null, sub: null });
  });

  it('AGENT 画像缺失 → 游客 200', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ disabledAt: null, agentProfile: null });
    const res = await hitOptional({ authorization: `Bearer ${tokenFor('agent-user-2', UserRole.AGENT)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().identified).toBe(false);
  });

  it('AGENT 活跃 → 保留身份', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } });
    const res = await hitOptional({ authorization: `Bearer ${tokenFor('agent-user-3', UserRole.AGENT)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identified: true, role: 'AGENT', sub: 'agent-user-3' });
  });

  it.each<UserRole>([UserRole.STAFF, UserRole.ADMIN, UserRole.CUSTOMER])(
    '%s 正常用户 → 保留身份',
    async (role) => {
      prismaMock.user.findUnique.mockResolvedValue({ disabledAt: null, agentProfile: null });
      const res = await hitOptional({ authorization: `Bearer ${tokenFor(`user-${role}`, role)}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ identified: true, role, sub: `user-${role}` });
      expect(prismaMock.user.findUnique).toHaveBeenCalled();
    },
  );

  it('disabledAt 非空 → 游客 200', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ disabledAt: new Date(), agentProfile: null });
    const res = await hitOptional({ authorization: `Bearer ${tokenFor('disabled-user', UserRole.CUSTOMER)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identified: false, role: null, sub: null });
  });

  it('用户不存在 → 游客 200', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const res = await hitOptional({ authorization: `Bearer ${tokenFor('missing-user', UserRole.CUSTOMER)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().identified).toBe(false);
  });

  it('无 Authorization → 游客放行且不查数据库', async () => {
    const res = await hitOptional();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identified: false, role: null, sub: null });
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it('无效 token → 401 且不查数据库', async () => {
    const res = await hitOptional({ authorization: 'Bearer not-a-real-token' });
    expect(res.statusCode).toBe(401);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});
