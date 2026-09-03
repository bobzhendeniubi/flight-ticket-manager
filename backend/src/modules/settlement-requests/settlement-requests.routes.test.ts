/**
 * 结算价申请路由 · 提交口的鉴权与审计口径（app.inject，service 被 mock）
 *
 * 盯的是「钱动了要看得出来」：代理自助直通改的是真金白银的应收、又没有第二个人经手，
 * 必须落成独立 action（AGENT_SELF_SETTLEMENT）+ WARNING 级；只落 PENDING 的照旧是创建流水。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { SettlementRequestStatus, UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }),
  },
  agent: { findUnique: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const createMock = vi.hoisted(() => vi.fn());
vi.mock('./settlement-requests.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settlement-requests.service.js')>();
  return {
    ...actual,
    SettlementRequestsService: vi.fn().mockImplementation(() => ({ create: createMock })),
  };
});

vi.mock('../../lib/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/audit.js')>();
  return { ...actual, writeAudit: vi.fn().mockResolvedValue(undefined) };
});

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { orderSettlementRequestRoutes } from './settlement-requests.routes.js';
import { writeAudit } from '../../lib/audit.js';

/** service.create 的返回体（序列化后的申请 + selfApplied/appliedDiffCny）。 */
function createdRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    orderId: 'order-1',
    orderNumber: 'FTM2026090100001',
    agentId: 'agent-1',
    agentName: '示例商旅',
    passengerCount: 2,
    requestedById: 'agent-user-1',
    requestedTotalCny: '12800.00',
    systemTotalCny: '13500.00',
    currentTotalCny: '12800.00',
    diffCny: '0.00',
    note: '代理自助：同行价',
    status: SettlementRequestStatus.APPROVED,
    decidedById: 'agent-user-1',
    decidedAt: '2026-09-01T00:00:00.000Z',
    decisionNote: null,
    appliedAdjustmentItemId: 'item-9',
    createdAt: '2026-09-01T00:00:00.000Z',
    selfApplied: true,
    appliedDiffCny: '-700.00',
    ...overrides,
  };
}

describe('POST /orders/:id/settlement-requests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(orderSettlementRequestRoutes, { prefix: '/orders' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      agentProfile: { isActive: true },
    });
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: true });
  });

  function submit(sub: string, role: UserRole, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/orders/order-1/settlement-requests',
      headers: { authorization: `Bearer ${app.jwt.sign({ sub, role })}` },
      payload,
    });
  }

  it('代理自助生效 → 201 带 selfApplied，审计走 AGENT_SELF_SETTLEMENT（WARNING）', async () => {
    createMock.mockResolvedValue(createdRequest());

    const res = await submit('agent-user-1', UserRole.AGENT, {
      requestedTotalCny: 12800,
      note: '同行价',
    });

    expect(res.statusCode).toBe(201);
    expect((res.json() as { request: { selfApplied: boolean } }).request.selfApplied).toBe(true);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AGENT_SELF_SETTLEMENT',
        targetType: 'ORDER',
        targetId: 'order-1',
        severity: 'WARNING',
        after: expect.objectContaining({
          requestId: 'req-1',
          requestedTotalCny: '12800.00',
          // 自助支路记的是**实际落地**的差额，不是「现在还差多少」（改完已是 0）。
          diffCny: '-700.00',
          appliedAdjustmentItemId: 'item-9',
          selfApplied: true,
        }),
      }),
    );
  });

  it('只落待确认申请 → 审计仍是 SETTLEMENT_REQUEST_CREATED，不升 WARNING', async () => {
    createMock.mockResolvedValue(
      createdRequest({
        status: SettlementRequestStatus.PENDING,
        decidedById: null,
        decidedAt: null,
        appliedAdjustmentItemId: null,
        currentTotalCny: '13500.00',
        diffCny: '-700.00',
        note: '同行价',
        selfApplied: false,
        appliedDiffCny: null,
      }),
    );

    const res = await submit('agent-user-1', UserRole.AGENT, { requestedTotalCny: 12800 });

    expect(res.statusCode).toBe(201);
    const entry = vi.mocked(writeAudit).mock.calls[0][0];
    expect(entry.action).toBe('SETTLEMENT_REQUEST_CREATED');
    expect(entry.severity).toBeUndefined();
    expect(entry.after).toMatchObject({
      diffCny: '-700.00',
      appliedAdjustmentItemId: null,
      selfApplied: false,
    });
  });

  it('CUSTOMER 提交 → 403，不进 service', async () => {
    const res = await submit('u-cust', UserRole.CUSTOMER, { requestedTotalCny: 12800 });
    expect(res.statusCode).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });
});
