/** AuthService.refresh · 停用代理在续期口即被拦截（与 login 同口径，防单点依赖 authenticate）。 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  refreshToken: { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  user: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import { authPlugin } from '../../plugins/auth.js';
import { AuthService } from './auth.service.js';

let app: FastifyInstance;
let service: AuthService;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(authPlugin);
  await app.ready();
  service = new AuthService(app);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function refreshRecord(overrides: { isActive?: boolean; agentProfile?: null; role?: UserRole }) {
  const agentProfile =
    overrides.agentProfile === null ? null : { isActive: overrides.isActive ?? true };
  return {
    id: 'rt-1',
    userId: 'u-1',
    tokenHash: 'hash',
    authVersion: 0,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: 'u-1',
      email: 'agent@example.com',
      role: overrides.role ?? UserRole.AGENT,
      displayName: '代理',
      disabledAt: null,
      authVersion: 0,
      mustChangePassword: false,
      agentProfile,
    },
  };
}

describe('refresh · 代理停用复核', () => {
  it('AGENT 已停用 → 401，且不进入轮换（不产生任何新 token）', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(refreshRecord({ isActive: false }));
    await expect(service.refresh('raw-token')).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining('账号已停用'),
    });
    expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });

  it('AGENT 画像缺失 → 401（fail closed）', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(refreshRecord({ agentProfile: null }));
    await expect(service.refresh('raw-token')).rejects.toMatchObject({ statusCode: 401 });
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });

  it('AGENT 活跃 → 正常轮换签发新 token', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(refreshRecord({ isActive: true }));
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.refreshToken.create.mockResolvedValue({});
    const tokens = await service.refresh('raw-token');
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
  });

  it('非 AGENT 角色无代理画像 → 不受此复核影响', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(
      refreshRecord({ agentProfile: null, role: UserRole.STAFF }),
    );
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.refreshToken.create.mockResolvedValue({});
    const tokens = await service.refresh('raw-token');
    expect(tokens.accessToken).toBeTruthy();
  });
});
