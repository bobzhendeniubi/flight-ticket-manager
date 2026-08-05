/**
 * optionalAuthenticate 中间件 · 停用代理降级为匿名（vitest，mock prisma）
 *
 * 背景（P0 安全绕过）：optionalAuthenticate 是「可选登录」——免登录路由（游客下单 POST /orders、
 * 产品列表定价、评价）在带有效 token 时会解析出身份并据此绑定/计价。此前它只做 jwtVerify、
 * 不复核 Agent.isActive，因此停用代理持旧 access token 仍能被当作代理身份下单/拿代理价。
 *
 * 修复口径：optionalAuthenticate 对 role=AGENT 补一次 Agent.isActive 校验；停用（或 Agent 记录缺失）
 * 则「降级为匿名」——清空 req.user，让下游按游客处理，而不是硬 401（避免连累匿名下单路径）。
 * ADMIN/STAFF/CUSTOMER 不查 Agent.isActive。
 *
 * 另含 optionalAuthenticate 的三态口径回归（见第二个 describe）：
 *   无 Authorization 头 → 游客 200；有效 token → 解析身份 200；无效/过期 token → 401。
 * 最后一档是本次口径变更：过去静默降级为游客（200），会让刚过期的登录用户拿到游客视角且
 * 永不自愈（客户端的 401 续期通道不被触发）。停用代理的「降级为匿名」是另一回事，仍保留。
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
  // 回显身份是否被解析出来：identified=true 表示按登录身份处理，false 表示按游客处理。
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

describe('optionalAuthenticate 中间件 · 停用代理降级为匿名', () => {
  it('role=AGENT 且 Agent.isActive=false → 降级为匿名（req.user 清空），HTTP 200 非 401', async () => {
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: false });
    const token = tokenFor('agent-user-1', 'AGENT');

    const res = await hitOptional({ authorization: `Bearer ${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identified: false, role: null, sub: null });
    expect(prismaMock.agent.findUnique).toHaveBeenCalledWith({
      where: { userId: 'agent-user-1' },
      select: { isActive: true },
    });
  });

  it('role=AGENT 且 Agent 记录不存在 → 同样降级为匿名（不当作放行的代理身份）', async () => {
    prismaMock.agent.findUnique.mockResolvedValue(null);
    const token = tokenFor('agent-user-2', 'AGENT');

    const res = await hitOptional({ authorization: `Bearer ${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identified: false, role: null, sub: null });
  });

  it('role=AGENT 且 Agent.isActive=true → 保留代理身份', async () => {
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: true });
    const token = tokenFor('agent-user-3', 'AGENT');

    const res = await hitOptional({ authorization: `Bearer ${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identified: true, role: 'AGENT', sub: 'agent-user-3' });
  });

  it.each<UserRole>([UserRole.STAFF, UserRole.ADMIN, UserRole.CUSTOMER])(
    'role=%s → 不查 Agent.isActive，保留身份',
    async (role) => {
      const token = tokenFor(`user-${role}`, role);

      const res = await hitOptional({ authorization: `Bearer ${token}` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ identified: true, role, sub: `user-${role}` });
      expect(prismaMock.agent.findUnique).not.toHaveBeenCalled();
    },
  );

  it('无 Authorization 头 → 游客放行，不查 Agent.isActive', async () => {
    const res = await hitOptional();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identified: false, role: null, sub: null });
    expect(prismaMock.agent.findUnique).not.toHaveBeenCalled();
  });

});

describe('optionalAuthenticate 中间件 · 三态（无 token 游客 / 有效 token 用户 / 无效 token 401）', () => {
  it('无 Authorization 头 → 游客放行 200，req.user 为空，不查 Agent.isActive', async () => {
    const res = await hitOptional();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identified: false, role: null, sub: null });
    expect(prismaMock.agent.findUnique).not.toHaveBeenCalled();
  });

  it('有效 token → 200 且解析出身份', async () => {
    const res = await hitOptional({
      authorization: `Bearer ${tokenFor('user-9', UserRole.CUSTOMER)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identified: true, role: 'CUSTOMER', sub: 'user-9' });
  });

  it('无效/伪造 token → 401（不再静默降级为游客），不查 Agent.isActive', async () => {
    // 口径变更：静默降级会让「刚过期」的登录用户拿到游客视角且永不自愈——响应是 200，
    // 客户端的 401 续期通道压根不会被触发。改 401 后客户端续期完会自动重试。
    const res = await hitOptional({ authorization: 'Bearer not-a-real-token' });

    expect(res.statusCode).toBe(401);
    expect(prismaMock.agent.findUnique).not.toHaveBeenCalled();
  });

  it('已过期 token → 401（与无效 token 同口径）', async () => {
    // payload 自带 exp 会覆盖插件的 sign.expiresIn —— 直接签一枚 60 秒前就到期的 token。
    const expired = app.jwt.sign({
      sub: 'user-8',
      role: UserRole.CUSTOMER,
      exp: Math.floor(Date.now() / 1000) - 60,
    });

    const res = await hitOptional({ authorization: `Bearer ${expired}` });

    expect(res.statusCode).toBe(401);
    expect(prismaMock.agent.findUnique).not.toHaveBeenCalled();
  });

  it('空 Authorization 头 → 仍按游客放行 200（不当成无效 token）', async () => {
    const res = await hitOptional({ authorization: '' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identified: false, role: null, sub: null });
  });
});
