import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';
import { ConflictError } from '../../lib/errors.js';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }) },
  agent: { findUnique: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const setFlightScheduleCostLockMock = vi.hoisted(() => vi.fn());
const patchFlightScheduleCostMock = vi.hoisted(() => vi.fn());
vi.mock('./finances.cost.service.js', () => ({
  createCostPeriod: vi.fn(),
  deleteCostPeriod: vi.fn(),
  listCostPeriods: vi.fn(),
  listSchedulesWithCost: vi.fn(),
  patchFlightScheduleCost: patchFlightScheduleCostMock,
  patchHotelRoomTypeCost: vi.fn(),
  patchVisaCost: vi.fn(),
  patchTransferCost: vi.fn(),
  setFlightScheduleCostLock: setFlightScheduleCostLockMock,
  updateCostPeriod: vi.fn(),
}));

const writeAuditMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../lib/audit.js', () => ({
  actorFromRequest: vi.fn((req: { user?: { sub: string; role: UserRole } }) => ({
    userId: req.user?.sub,
    role: req.user?.role,
  })),
  writeAudit: writeAuditMock,
}));

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { financesRoutes } from './finances.routes.js';

describe('班次成本锁定路由', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(financesRoutes, { prefix: '/finances' });
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

  it('STAFF 可以锁定班次并记录固化前后的成本审计', async () => {
    const lockedAt = new Date('2026-07-23T03:00:00.000Z');
    setFlightScheduleCostLockMock.mockResolvedValue({
      id: 's1',
      targetLabel: 'FT100 2026-07-22',
      changed: true,
      costLocked: true,
      costLockedAt: lockedAt,
      costLockedBy: 'staff-1',
      before: { costs: { charterCostCny: 100 }, costLocked: false },
      after: { costs: { charterCostCny: 100 }, costLocked: true },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/finances/schedules/s1/cost-lock',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
      payload: { lock: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: 's1',
      costLocked: true,
      costLockedAt: lockedAt.toISOString(),
      costLockedBy: 'staff-1',
    });
    expect(setFlightScheduleCostLockMock).toHaveBeenCalledWith('s1', true, 'staff-1');
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LOCK_FLIGHT_SCHEDULE_COST',
        targetType: 'FLIGHT',
        before: expect.any(Object),
        after: expect.any(Object),
      }),
    );
  });

  it('锁定班次后成本写入返回 409', async () => {
    patchFlightScheduleCostMock.mockRejectedValue(
      new ConflictError('该班次成本已锁定，请先解锁再修改'),
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/finances/cost/flight-schedule/s1',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.ADMIN)}` },
      payload: { charterCostCny: 123 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'CONFLICT', message: '该班次成本已锁定，请先解锁再修改' },
    });
  });

  it('客户角色不能调用锁定端点', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/finances/schedules/s1/cost-lock',
      headers: { authorization: `Bearer ${tokenFor('customer-1', UserRole.CUSTOMER)}` },
      payload: { lock: true },
    });

    expect(res.statusCode).toBe(403);
    expect(setFlightScheduleCostLockMock).not.toHaveBeenCalled();
  });

  it('STAFF 可以保存班次成本（含负数机型调整）', async () => {
    patchFlightScheduleCostMock.mockResolvedValue({ id: 's1' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/finances/cost/flight-schedule/s1',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
      payload: { charterCostCny: 100_000, aircraftAdjustCny: -500, takeoffDiscountCny: -200 },
    });

    expect(res.statusCode).toBe(200);
    expect(patchFlightScheduleCostMock).toHaveBeenCalledWith('s1', {
      charterCostCny: 100_000,
      aircraftAdjustCny: -500,
      takeoffDiscountCny: -200,
    });
  });

  it('客户角色不能保存班次成本', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/finances/cost/flight-schedule/s1',
      headers: { authorization: `Bearer ${tokenFor('customer-1', UserRole.CUSTOMER)}` },
      payload: { charterCostCny: 100 },
    });

    expect(res.statusCode).toBe(403);
    expect(patchFlightScheduleCostMock).not.toHaveBeenCalled();
  });
});
