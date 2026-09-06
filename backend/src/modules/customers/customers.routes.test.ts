/**
 * 客户路由权限单测（B-3）。
 *
 * 覆盖：
 *   - AGENT 带 primaryAgentId 改客户归属 → 403（口径同 PATCH /orders/:id/agent：改归属只归运营）
 *   - AGENT 不带 primaryAgentId 的普通编辑照常放行
 *   - ADMIN / STAFF 改归属不受影响
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn().mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: null,
      agentProfile: { isActive: true },
    }),
  },
  agent: { findUnique: vi.fn().mockResolvedValue({ id: 'agent-self' }) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

vi.mock('../../lib/agent-tree.js', () => ({
  getDescendantAgentIds: vi.fn().mockResolvedValue(['agent-self', 'agent-child']),
}));

const getByIdMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
vi.mock('./customers.service.js', () => ({
  CustomersService: class {
    list = vi.fn();
    getById = getByIdMock;
    update = updateMock;
  },
}));

vi.mock('../../lib/audit.js', () => ({
  actorFromRequest: vi.fn(() => ({})),
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { customerRoutes } from './customers.routes.js';

const customerRow = {
  id: 'cust-1',
  displayName: '客户一',
  email: null,
  phone: null,
  profile: { idNumber: null, primaryAgentId: 'agent-child', primaryAgent: null, tags: [], notes: null },
};

describe('PATCH /customers/:id 归属代理越权闸', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(customerRoutes, { prefix: '/customers' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: null,
      agentProfile: { isActive: true },
    });
    prismaMock.agent.findUnique.mockResolvedValue({ id: 'agent-self' });
    getByIdMock.mockResolvedValue(customerRow);
    updateMock.mockResolvedValue(customerRow);
  });

  function tokenFor(sub: string, role: UserRole): string {
    return app.jwt.sign({ sub, role });
  }

  it('AGENT 带 primaryAgentId 改客户归属 → 403 且不落库', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/customers/cust-1',
      headers: { authorization: `Bearer ${tokenFor('agent-user', UserRole.AGENT)}` },
      payload: { primaryAgentId: 'agent-self' },
    });

    expect(res.statusCode).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('AGENT 传 primaryAgentId:null（脱钩成直客）同样 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/customers/cust-1',
      headers: { authorization: `Bearer ${tokenFor('agent-user', UserRole.AGENT)}` },
      payload: { primaryAgentId: null },
    });

    expect(res.statusCode).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('AGENT 改备注/标签（不带 primaryAgentId）照常放行', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/customers/cust-1',
      headers: { authorization: `Bearer ${tokenFor('agent-user', UserRole.AGENT)}` },
      payload: { notes: '老客户' },
    });

    expect(res.statusCode).toBe(200);
    expect(updateMock).toHaveBeenCalledWith('cust-1', { notes: '老客户' });
  });

  it('STAFF 改客户归属代理不受影响', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: null,
      agentProfile: null,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/customers/cust-1',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
      payload: { primaryAgentId: 'agent-other' },
    });

    expect(res.statusCode).toBe(200);
    expect(updateMock).toHaveBeenCalledWith('cust-1', { primaryAgentId: 'agent-other' });
  });
});
