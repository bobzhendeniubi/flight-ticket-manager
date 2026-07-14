/**
 * authenticate 中间件 · 停用代理存量 token 校验（vitest，mock prisma）
 *
 * 背景：登录时的停用拦截（见 auth.service.test.ts）只挡得住新登录——已签发的 access token
 * 在到期前仍能通过 jwtVerify，持有旧 token 的设备可以继续访问。本测试覆盖修复后的行为：
 * authenticate（plugins/auth.ts）对 role=AGENT 的每次请求都补一次 Agent.isActive 校验，
 * 停用后存量 token 立即被拒（401「账号已停用」），且不影响 ADMIN/STAFF/CUSTOMER 的请求路径。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  agent: { findUnique: vi.fn() },
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

async function hitProtected(token: string) {
  return app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('authenticate 中间件 · 停用代理存量 token 立即失效', () => {
  it('role=AGENT 且 Agent.isActive=false → 401「账号已停用」', async () => {
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: false });
    const token = tokenFor('agent-user-1', 'AGENT');

    const res = await hitProtected(token);

    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/账号已停用/);
    expect(prismaMock.agent.findUnique).toHaveBeenCalledWith({
      where: { userId: 'agent-user-1' },
      select: { isActive: true },
    });
  });

  it('role=AGENT 且 Agent 记录不存在 → 401（不当作放行）', async () => {
    prismaMock.agent.findUnique.mockResolvedValue(null);
    const token = tokenFor('agent-user-2', 'AGENT');

    const res = await hitProtected(token);

    expect(res.statusCode).toBe(401);
  });

  it('role=AGENT 且 Agent.isActive=true → 放行', async () => {
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: true });
    const token = tokenFor('agent-user-3', 'AGENT');

    const res = await hitProtected(token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, role: 'AGENT' });
  });

  it.each<UserRole>([UserRole.STAFF, UserRole.ADMIN, UserRole.CUSTOMER])(
    'role=%s → 不查 Agent.isActive，直接放行',
    async (role) => {
      const token = tokenFor(`user-${role}`, role);

      const res = await hitProtected(token);

      expect(res.statusCode).toBe(200);
      expect(prismaMock.agent.findUnique).not.toHaveBeenCalled();
    },
  );

  it('无效/伪造 token → 401（既有行为不变，不查 Agent.isActive）', async () => {
    const res = await hitProtected('not-a-real-token');

    expect(res.statusCode).toBe(401);
    expect(prismaMock.agent.findUnique).not.toHaveBeenCalled();
  });
});
