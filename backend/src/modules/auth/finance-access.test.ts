/** requireFinanceAccess：ADMIN 或 STAFF+FINANCE 才能访问财务页与经营报表。 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  app.get(
    '/finance-protected',
    { preHandler: [app.authenticate, app.requireFinanceAccess] },
    async () => ({ ok: true }),
  );
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

async function hit(role: UserRole, staffRole: StaffRole | null): Promise<number> {
  prismaMock.user.findUnique.mockResolvedValue({
    disabledAt: null,
    authVersion: 0,
    staffRole,
    agentProfile: role === UserRole.AGENT ? { isActive: true } : null,
  });
  const res = await app.inject({
    method: 'GET',
    url: '/finance-protected',
    headers: { authorization: `Bearer ${tokenFor(`${role}-${staffRole ?? 'none'}`, role)}` },
  });
  return res.statusCode;
}

describe('requireFinanceAccess', () => {
  it('ADMIN → 放行', async () => {
    expect(await hit(UserRole.ADMIN, null)).toBe(200);
  });

  it('STAFF+FINANCE → 放行', async () => {
    expect(await hit(UserRole.STAFF, StaffRole.FINANCE)).toBe(200);
  });

  it('同一 access token 改岗后，下一个请求按最新岗位放行', async () => {
    const token = tokenFor('finance-change-1', UserRole.STAFF);
    const request = () =>
      app.inject({
        method: 'GET',
        url: '/finance-protected',
        headers: { authorization: `Bearer ${token}` },
      });

    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: StaffRole.TICKETING,
      agentProfile: null,
    });
    expect((await request()).statusCode).toBe(403);

    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: StaffRole.FINANCE,
      agentProfile: null,
    });
    expect((await request()).statusCode).toBe(200);
  });

  it.each([
    [UserRole.STAFF, StaffRole.TICKETING],
    [UserRole.STAFF, null],
    [UserRole.AGENT, null],
    // 非 STAFF 即使数据行异常挂着财务岗也不得放行——闸门条件必须同时校验 role 与岗位
    [UserRole.AGENT, StaffRole.FINANCE],
    [UserRole.CUSTOMER, StaffRole.FINANCE],
  ] as const)('%s+%s → 403', async (role, staffRole) => {
    expect(await hit(role, staffRole)).toBe(403);
  });

  it('无 token → 401（闸门 fail closed，不自行解析 Authorization）', async () => {
    const res = await app.inject({ method: 'GET', url: '/finance-protected' });
    expect(res.statusCode).toBe(401);
  });
});
