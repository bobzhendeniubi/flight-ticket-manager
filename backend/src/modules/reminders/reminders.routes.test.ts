/**
 * GET /reminders/work-orders/summary · 顶栏角标端点
 *
 * 覆盖：
 *   1. ruleKey 前缀过滤：查询条件按 WORK_ORDER_RULE_KINDS 三个前缀 OR 拼 startsWith
 *   2. 状态过滤：open/inProgress 计数分别按 OPEN / IN_PROGRESS；items 只取 OPEN+IN_PROGRESS
 *   3. since 过滤：items 收窄到 createdAt > since 的新增行，但 open/inProgress 计数不受影响
 *   4. AGENT 访问 → 403（ADMIN/STAFF 专属）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ReminderPriority, ReminderStatus, StaffRole, UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  operationalReminder: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn(),
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

vi.mock('../../lib/audit.js', () => ({
  actorFromRequest: vi.fn(() => ({ userId: 'staff-1', role: UserRole.STAFF })),
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { reminderRoutes } from './reminders.routes.js';

describe('GET /reminders/work-orders/summary', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(reminderRoutes, { prefix: '/reminders' });
    await app.ready();
  });

  afterAll(async () => app.close());

  function tokenFor(sub: string, role: UserRole): string {
    return app.jwt.sign({ sub, role });
  }

  function setUser(role: UserRole): void {
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      mustChangePassword: false,
      staffRole: role === UserRole.STAFF ? StaffRole.TICKETING : null,
      agentProfile: role === UserRole.AGENT ? { isActive: true } : null,
    });
  }

  function workOrderRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rem-1',
      orderId: 'order-1',
      ruleKey: 'NOSHOW_WITHDRAW:item-1:token-1',
      title: '撤名单/退票：FTM2026090100001 · 回程 QH9588 2026-09-10 · 2 人',
      priority: ReminderPriority.HIGH,
      status: ReminderStatus.OPEN,
      dueAt: new Date('2026-09-02T00:00:00Z'),
      createdAt: new Date('2026-09-02T03:00:00Z'),
      claimedById: null,
      order: { orderNumber: 'FTM2026090100001' },
      ...overrides,
    };
  }

  // $transaction 按数组形式调用（count, count, findMany），逐个 await 即可模拟真实行为。
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
  });

  it('AGENT 访问 → 403，且不触达 prisma.operationalReminder', async () => {
    setUser(UserRole.AGENT);

    const res = await app.inject({
      method: 'GET',
      url: '/reminders/work-orders/summary',
      headers: { authorization: `Bearer ${tokenFor('agent-1', UserRole.AGENT)}` },
    });

    expect(res.statusCode).toBe(403);
    expect(prismaMock.operationalReminder.count).not.toHaveBeenCalled();
    expect(prismaMock.operationalReminder.findMany).not.toHaveBeenCalled();
  });

  it('ruleKey 按 WORK_ORDER_RULE_KINDS 三前缀 OR startsWith 过滤，且状态分别按 OPEN/IN_PROGRESS 计数', async () => {
    setUser(UserRole.STAFF);
    prismaMock.operationalReminder.count.mockResolvedValueOnce(3); // open
    prismaMock.operationalReminder.count.mockResolvedValueOnce(1); // inProgress
    prismaMock.operationalReminder.findMany.mockResolvedValueOnce([workOrderRow()]);

    const res = await app.inject({
      method: 'GET',
      url: '/reminders/work-orders/summary',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.open).toBe(3);
    expect(body.inProgress).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 'rem-1',
      ruleKey: 'NOSHOW_WITHDRAW:item-1:token-1',
      kind: 'WITHDRAW',
      orderId: 'order-1',
      orderNumber: 'FTM2026090100001',
      priority: 'HIGH',
      status: 'OPEN',
      assigneeUserId: null,
    });

    const expectedRuleKeyFilter = {
      OR: [
        { ruleKey: { startsWith: 'NOSHOW_WITHDRAW:' } },
        { ruleKey: { startsWith: 'NOSHOW_RELIST:' } },
        { ruleKey: { startsWith: 'LEG_CANCEL_WITHDRAW:' } },
      ],
    };
    expect(prismaMock.operationalReminder.count).toHaveBeenNthCalledWith(1, {
      where: { ...expectedRuleKeyFilter, status: ReminderStatus.OPEN },
    });
    expect(prismaMock.operationalReminder.count).toHaveBeenNthCalledWith(2, {
      where: { ...expectedRuleKeyFilter, status: ReminderStatus.IN_PROGRESS },
    });
    expect(prismaMock.operationalReminder.findMany).toHaveBeenCalledWith({
      where: {
        ...expectedRuleKeyFilter,
        status: { in: [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS] },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { order: { select: { orderNumber: true } } },
    });
  });

  it('kind 按前缀分别映射：NOSHOW_RELIST → RELIST，LEG_CANCEL_WITHDRAW → LEG_CANCEL_WITHDRAW', async () => {
    setUser(UserRole.ADMIN);
    prismaMock.operationalReminder.count.mockResolvedValueOnce(0);
    prismaMock.operationalReminder.count.mockResolvedValueOnce(0);
    prismaMock.operationalReminder.findMany.mockResolvedValueOnce([
      workOrderRow({
        id: 'rem-relist',
        ruleKey: 'NOSHOW_RELIST:item-2:token-2',
        createdAt: new Date('2026-09-02T05:00:00Z'),
      }),
      workOrderRow({
        id: 'rem-legcancel',
        ruleKey: 'LEG_CANCEL_WITHDRAW:item-3:token-3',
        createdAt: new Date('2026-09-02T04:00:00Z'),
      }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/reminders/work-orders/summary',
      headers: { authorization: `Bearer ${tokenFor('admin-1', UserRole.ADMIN)}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((r: { kind: string }) => r.kind)).toEqual(['RELIST', 'LEG_CANCEL_WITHDRAW']);
  });

  it('since 过滤：items 只保留 createdAt > since 的新增行，open/inProgress 计数不受影响', async () => {
    setUser(UserRole.STAFF);
    prismaMock.operationalReminder.count.mockResolvedValueOnce(5); // open 全量，不受 since 影响
    prismaMock.operationalReminder.count.mockResolvedValueOnce(2); // inProgress 全量
    prismaMock.operationalReminder.findMany.mockResolvedValueOnce([
      workOrderRow({ id: 'rem-new', createdAt: new Date('2026-09-02T06:00:00Z') }),
      workOrderRow({ id: 'rem-old', createdAt: new Date('2026-09-01T06:00:00Z') }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/reminders/work-orders/summary?since=2026-09-02T00:00:00.000Z',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.open).toBe(5);
    expect(body.inProgress).toBe(2);
    // latestAt 来自全量最近一条（未被 since 收窄），供前端下一轮轮询用作新 since 锚点。
    expect(body.latestAt).toBe('2026-09-02T06:00:00.000Z');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('rem-new');
  });

  it('不带 since 时返回最近 30 条内的全部 OPEN/IN_PROGRESS 明细', async () => {
    setUser(UserRole.STAFF);
    prismaMock.operationalReminder.count.mockResolvedValueOnce(0);
    prismaMock.operationalReminder.count.mockResolvedValueOnce(0);
    prismaMock.operationalReminder.findMany.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/reminders/work-orders/summary',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ open: 0, inProgress: 0, latestAt: null, items: [] });
  });
});
