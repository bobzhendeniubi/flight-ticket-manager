import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { StaffRole, UserRole } from '@prisma/client';
import { ConflictError } from '../../lib/errors.js';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn().mockResolvedValue({ disabledAt: null, authVersion: 0, staffRole: null, agentProfile: { isActive: true } }) },
  agent: { findUnique: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const getFinancesSummaryMock = vi.hoisted(() => vi.fn());
vi.mock('./finances.service.js', () => ({
  getFinancesSummary: getFinancesSummaryMock,
  getFlightPnl: vi.fn(),
  getOrderPnl: vi.fn(),
  getOrderPnlDetail: vi.fn(),
  getMonthlyTrend: vi.fn(),
}));

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

const hotelCostPeriodMocks = vi.hoisted(() => ({
  createHotelRoomTypeCostPeriod: vi.fn(),
  deleteHotelRoomTypeCostPeriod: vi.fn(),
  listHotelRoomTypeCostPeriods: vi.fn(),
  updateHotelRoomTypeCostPeriod: vi.fn(),
}));
vi.mock('./hotel-cost.service.js', () => hotelCostPeriodMocks);

const fxMocks = vi.hoisted(() => ({
  getUsdFxRate: vi.fn(),
  listFxSupplierOptions: vi.fn(),
  listUsdFxRates: vi.fn(),
  upsertUsdFxRate: vi.fn(),
}));
vi.mock('./finances.fx.service.js', () => fxMocks);

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

  it('STAFF+FINANCE 可以访问损益汇总', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: StaffRole.FINANCE,
      agentProfile: null,
    });
    getFinancesSummaryMock.mockResolvedValue({ revenueCny: 0 });

    const res = await app.inject({
      method: 'GET',
      url: '/finances/summary?from=2026-08-01&to=2026-08-24',
      headers: { authorization: `Bearer ${tokenFor('finance-1', UserRole.STAFF)}` },
    });

    expect(res.statusCode).toBe(200);
    expect(getFinancesSummaryMock).toHaveBeenCalledWith({ from: '2026-08-01', to: '2026-08-24' });
  });

  it('STAFF 通用岗位访问损益汇总 → 403', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: null,
      agentProfile: null,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/finances/summary',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });

    expect(res.statusCode).toBe(403);
    expect(getFinancesSummaryMock).not.toHaveBeenCalled();
  });

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

describe('酒店房型净房价按日期区间路由（ADMIN/STAFF）', () => {
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
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: null,
      agentProfile: { isActive: true },
    });
  });

  function tokenFor(sub: string, role: UserRole): string {
    return app.jwt.sign({ sub, role });
  }

  const periodDto = {
    id: 'hp1',
    roomTypeId: 'rt1',
    effectiveFrom: '2026-10-01',
    effectiveTo: '2026-10-07',
    costPriceCny: 900,
    note: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
  };

  it('STAFF 新增区间 → 200，按房型 id + 校验后的 body 调服务，并写 UPDATE_FINANCE_COST 审计', async () => {
    hotelCostPeriodMocks.createHotelRoomTypeCostPeriod.mockResolvedValue(periodDto);
    const res = await app.inject({
      method: 'POST',
      url: '/finances/cost/hotel-room-type/rt1/periods',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
      payload: { effectiveFrom: '2026-10-01', effectiveTo: '2026-10-07', costPriceCny: 900, note: '国庆' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ period: periodDto });
    expect(hotelCostPeriodMocks.createHotelRoomTypeCostPeriod).toHaveBeenCalledWith('rt1', {
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-07',
      costPriceCny: 900,
      note: '国庆',
    });
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UPDATE_FINANCE_COST', targetId: 'hotel-room-type:rt1:period:hp1' }),
    );
  });

  it('区间重叠 → 服务抛 ConflictError → 409，中文消息原样透出', async () => {
    hotelCostPeriodMocks.createHotelRoomTypeCostPeriod.mockRejectedValue(
      new ConflictError('日期区间与该房型现有区间重叠（2026-10-01 → 2026-10-07）'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/finances/cost/hotel-room-type/rt1/periods',
      headers: { authorization: `Bearer ${tokenFor('admin-1', UserRole.ADMIN)}` },
      payload: { effectiveFrom: '2026-10-05', effectiveTo: '2026-10-10', costPriceCny: 800 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('重叠');
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('日期格式不对 / 净房价为负 → 400，不调服务', async () => {
    const bad = await app.inject({
      method: 'PATCH',
      url: '/finances/cost/hotel-room-type-periods/hp1',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
      payload: { effectiveFrom: '2026/10/01' },
    });
    expect(bad.statusCode).toBe(400);
    const negative = await app.inject({
      method: 'POST',
      url: '/finances/cost/hotel-room-type/rt1/periods',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
      payload: { effectiveFrom: '2026-10-01', effectiveTo: '2026-10-07', costPriceCny: -1 },
    });
    expect(negative.statusCode).toBe(400);
    expect(hotelCostPeriodMocks.updateHotelRoomTypeCostPeriod).not.toHaveBeenCalled();
    expect(hotelCostPeriodMocks.createHotelRoomTypeCostPeriod).not.toHaveBeenCalled();
  });

  it('PATCH / DELETE / GET 走对应服务；DELETE 审计 targetId 带房型 id', async () => {
    hotelCostPeriodMocks.updateHotelRoomTypeCostPeriod.mockResolvedValue({ ...periodDto, costPriceCny: 950 });
    hotelCostPeriodMocks.deleteHotelRoomTypeCostPeriod.mockResolvedValue({ id: 'hp1', roomTypeId: 'rt1' });
    hotelCostPeriodMocks.listHotelRoomTypeCostPeriods.mockResolvedValue([periodDto]);
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };

    const patched = await app.inject({
      method: 'PATCH',
      url: '/finances/cost/hotel-room-type-periods/hp1',
      headers: auth,
      payload: { costPriceCny: 950 },
    });
    expect(patched.statusCode).toBe(200);
    expect(hotelCostPeriodMocks.updateHotelRoomTypeCostPeriod).toHaveBeenCalledWith('hp1', { costPriceCny: 950 });

    const deleted = await app.inject({ method: 'DELETE', url: '/finances/cost/hotel-room-type-periods/hp1', headers: auth });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: 'hp1' });
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UPDATE_FINANCE_COST', targetId: 'hotel-room-type:rt1:period:hp1' }),
    );

    const listed = await app.inject({ method: 'GET', url: '/finances/cost/hotel-room-type/rt1/periods', headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ periods: [periodDto] });
  });

  it('AGENT 一律 403，不触碰服务', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/finances/cost/hotel-room-type/rt1/periods',
      headers: { authorization: `Bearer ${tokenFor('agent-1', UserRole.AGENT)}` },
    });
    expect(res.statusCode).toBe(403);
    expect(hotelCostPeriodMocks.listHotelRoomTypeCostPeriods).not.toHaveBeenCalled();
  });
});

describe('美金汇率表路由（按签证公司 × 生效日）', () => {
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

  const fxDto = {
    id: 'fx1',
    supplier: '甲公司',
    effectiveFrom: '2026-01-01',
    rate: 7.2,
    note: null,
    updatedBy: 'staff-1',
    updatedAt: '2026-09-09T00:00:00.000Z',
  };

  it('GET /effective 透传 date + supplier 给服务；省略 supplier 时传 null（只看通用行）', async () => {
    fxMocks.getUsdFxRate.mockResolvedValue(fxDto);
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };

    const withSupplier = await app.inject({
      method: 'GET',
      url: '/finances/usd-fx-rates/effective?date=2026-09-09&supplier=' + encodeURIComponent('甲公司'),
      headers: auth,
    });
    expect(withSupplier.statusCode).toBe(200);
    expect(withSupplier.json()).toEqual({ rate: fxDto });
    expect(fxMocks.getUsdFxRate).toHaveBeenCalledWith('2026-09-09', '甲公司');

    fxMocks.getUsdFxRate.mockResolvedValue(null);
    const generic = await app.inject({
      method: 'GET',
      url: '/finances/usd-fx-rates/effective?date=2026-09-09',
      headers: auth,
    });
    expect(generic.statusCode).toBe(200);
    expect(generic.json()).toEqual({ rate: null });
    expect(fxMocks.getUsdFxRate).toHaveBeenLastCalledWith('2026-09-09', null);
  });

  it('GET /effective 日期格式不对 → 400，不调服务', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/finances/usd-fx-rates/effective?date=2026/09/09',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });
    expect(res.statusCode).toBe(400);
    expect(fxMocks.getUsdFxRate).not.toHaveBeenCalled();
  });

  it('PUT 带 supplier 透传给服务并审计（targetLabel 带公司名）；不带 supplier 也能存通用行', async () => {
    fxMocks.upsertUsdFxRate.mockResolvedValue(fxDto);
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };

    const res = await app.inject({
      method: 'PUT',
      url: '/finances/usd-fx-rates',
      headers: auth,
      payload: { supplier: '甲公司', effectiveFrom: '2026-01-01', rate: 7.2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rate: fxDto });
    expect(fxMocks.upsertUsdFxRate).toHaveBeenCalledWith(
      { supplier: '甲公司', effectiveFrom: '2026-01-01', rate: 7.2 },
      'staff-1',
    );
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPSERT_USD_FX_RATE',
        targetId: 'fx1',
        targetLabel: expect.stringContaining('甲公司'),
      }),
    );

    fxMocks.upsertUsdFxRate.mockResolvedValue({ ...fxDto, id: 'fx2', supplier: null, rate: 6.7 });
    const generic = await app.inject({
      method: 'PUT',
      url: '/finances/usd-fx-rates',
      headers: auth,
      payload: { effectiveFrom: '2026-01-01', rate: 6.7 },
    });
    expect(generic.statusCode).toBe(200);
    expect(fxMocks.upsertUsdFxRate).toHaveBeenLastCalledWith(
      { effectiveFrom: '2026-01-01', rate: 6.7 },
      'staff-1',
    );
    expect(writeAuditMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetLabel: expect.stringContaining('通用') }),
    );
  });

  it('PUT 汇率 ≤ 0 / supplier 超长 → 400，不调服务', async () => {
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };
    const zero = await app.inject({
      method: 'PUT',
      url: '/finances/usd-fx-rates',
      headers: auth,
      payload: { effectiveFrom: '2026-01-01', rate: 0 },
    });
    expect(zero.statusCode).toBe(400);
    const tooLong = await app.inject({
      method: 'PUT',
      url: '/finances/usd-fx-rates',
      headers: auth,
      payload: { supplier: 'x'.repeat(101), effectiveFrom: '2026-01-01', rate: 7.2 },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(fxMocks.upsertUsdFxRate).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('GET 列表 / GET 公司候选 走对应服务', async () => {
    fxMocks.listUsdFxRates.mockResolvedValue([fxDto]);
    fxMocks.listFxSupplierOptions.mockResolvedValue(['甲公司', '乙公司']);
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };

    const listed = await app.inject({ method: 'GET', url: '/finances/usd-fx-rates', headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ rates: [fxDto] });

    const options = await app.inject({
      method: 'GET',
      url: '/finances/usd-fx-rates/supplier-options',
      headers: auth,
    });
    expect(options.statusCode).toBe(200);
    expect(options.json()).toEqual({ suppliers: ['甲公司', '乙公司'] });
  });

  it('AGENT 一律 403，不触碰服务', async () => {
    const auth = { authorization: `Bearer ${tokenFor('agent-1', UserRole.AGENT)}` };
    for (const url of [
      '/finances/usd-fx-rates',
      '/finances/usd-fx-rates/supplier-options',
      '/finances/usd-fx-rates/effective?date=2026-09-09',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode).toBe(403);
    }
    expect(fxMocks.listUsdFxRates).not.toHaveBeenCalled();
    expect(fxMocks.listFxSupplierOptions).not.toHaveBeenCalled();
    expect(fxMocks.getUsdFxRate).not.toHaveBeenCalled();
  });
});
