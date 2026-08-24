/** authenticate · User.disabledAt 与 AGENT.isActive 的逐请求校验。 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { StaffRole, UserRole } from '@prisma/client';

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
  app.get('/protected', { preHandler: app.authenticate }, async (req) => ({
    ok: true,
    role: req.user.role,
    staffRole: req.staffRole ?? null,
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

function tokenWithVersion(sub: string, role: UserRole, ver: number): string {
  return app.jwt.sign({ sub, role, ver });
}

async function hitProtected(token: string) {
  return app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('authenticate · 停用账号存量 token 立即失效', () => {
  it('AGENT 不活跃 → 401', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ disabledAt: null, authVersion: 0, staffRole: null, agentProfile: { isActive: false } });
    const res = await hitProtected(tokenFor('agent-user-1', UserRole.AGENT));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/账号已停用/);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'agent-user-1' },
      select: {
        disabledAt: true,
        authVersion: true,
        staffRole: true,
        mustChangePassword: true,
        agentProfile: { select: { isActive: true } },
      },
    });
  });

  it('AGENT 画像缺失 → 401', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ disabledAt: null, authVersion: 0, staffRole: null, agentProfile: null });
    const res = await hitProtected(tokenFor('agent-user-2', UserRole.AGENT));
    expect(res.statusCode).toBe(401);
  });

  it('AGENT 活跃 → 放行', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ disabledAt: null, authVersion: 0, staffRole: null, agentProfile: { isActive: true } });
    const res = await hitProtected(tokenFor('agent-user-3', UserRole.AGENT));
    expect(res.statusCode).toBe(200);
  });

  it.each<UserRole>([UserRole.STAFF, UserRole.ADMIN, UserRole.CUSTOMER])(
    '%s 正常用户 → 放行',
    async (role) => {
      prismaMock.user.findUnique.mockResolvedValue({ disabledAt: null, authVersion: 0, staffRole: null, agentProfile: null });
      const res = await hitProtected(tokenFor(`user-${role}`, role));
      expect(res.statusCode).toBe(200);
      expect(prismaMock.user.findUnique).toHaveBeenCalled();
    },
  );

  it('任意角色 disabledAt 非空 → 401', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ disabledAt: new Date(), authVersion: 0, staffRole: null, agentProfile: null });
    const res = await hitProtected(tokenFor('disabled-user', UserRole.STAFF));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/账号已停用/);
  });

  it('access token ver 与用户 authVersion 不匹配 → 401', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ disabledAt: null, authVersion: 2, staffRole: null, agentProfile: null });
    const res = await hitProtected(tokenWithVersion('stale-user', UserRole.STAFF, 1));
    expect(res.statusCode).toBe(401);
  });

  it('无 ver 的旧 token → 跳过版本检查并放行', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ disabledAt: null, authVersion: 2, staffRole: null, agentProfile: null });
    const res = await hitProtected(tokenFor('legacy-user', UserRole.STAFF));
    expect(res.statusCode).toBe(200);
  });

  it('用户不存在 → 401（fail closed）', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const res = await hitProtected(tokenFor('missing-user', UserRole.STAFF));
    expect(res.statusCode).toBe(401);
  });

  it('STAFF 的岗位从当前 User 查询挂到 request，不依赖 token', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: StaffRole.FINANCE,
      agentProfile: null,
    });
    const res = await hitProtected(tokenFor('finance-user', UserRole.STAFF));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: UserRole.STAFF, staffRole: StaffRole.FINANCE });
  });

  it('无效 token → 401，且不查数据库', async () => {
    const res = await hitProtected('not-a-real-token');
    expect(res.statusCode).toBe(401);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});
