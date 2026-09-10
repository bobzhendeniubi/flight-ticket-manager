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
const patchHotelRoomTypeCostMock = vi.hoisted(() => vi.fn());
vi.mock('./finances.cost.service.js', () => ({
  createCostPeriod: vi.fn(),
  deleteCostPeriod: vi.fn(),
  listCostPeriods: vi.fn(),
  listSchedulesWithCost: vi.fn(),
  patchFlightScheduleCost: patchFlightScheduleCostMock,
  patchHotelRoomTypeCost: patchHotelRoomTypeCostMock,
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
  FX_CURRENCIES: ['USD', 'VND'] as const,
  getFxRate: vi.fn(),
  listEffectiveFxRates: vi.fn(),
  listFxNameOptions: vi.fn(),
  listFxRates: vi.fn(),
  listFxSupplierOptions: vi.fn(),
  upsertFxRate: vi.fn(),
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

describe('汇率表路由（汇率名称 × 币种 × 生效日；/fx-rates 与 /usd-fx-rates 别名）', () => {
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
    name: '甲公司',
    currency: 'USD',
    effectiveFrom: '2026-01-01',
    rate: 7.2,
    note: null,
    updatedBy: 'staff-1',
    updatedAt: '2026-09-09T00:00:00.000Z',
  };

  it('GET /effective 透传 date + currency + name；旧路径 supplier 等价 name；省略时 name 为 null、币种缺省 USD', async () => {
    fxMocks.getFxRate.mockResolvedValue(fxDto);
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };

    const withName = await app.inject({
      method: 'GET',
      url: '/finances/fx-rates/effective?date=2026-09-09&currency=USD&name=' + encodeURIComponent('甲公司'),
      headers: auth,
    });
    expect(withName.statusCode).toBe(200);
    expect(withName.json()).toEqual({ rate: fxDto });
    expect(fxMocks.getFxRate).toHaveBeenCalledWith({ date: '2026-09-09', currency: 'USD', name: '甲公司' });

    const legacy = await app.inject({
      method: 'GET',
      url: '/finances/usd-fx-rates/effective?date=2026-09-09&supplier=' + encodeURIComponent('甲公司'),
      headers: auth,
    });
    expect(legacy.statusCode).toBe(200);
    expect(fxMocks.getFxRate).toHaveBeenLastCalledWith({ date: '2026-09-09', currency: 'USD', name: '甲公司' });

    fxMocks.getFxRate.mockResolvedValue(null);
    const vnd = await app.inject({
      method: 'GET',
      url: '/finances/fx-rates/effective?date=2026-09-09&currency=VND',
      headers: auth,
    });
    expect(vnd.statusCode).toBe(200);
    expect(vnd.json()).toEqual({ rate: null });
    expect(fxMocks.getFxRate).toHaveBeenLastCalledWith({ date: '2026-09-09', currency: 'VND', name: null });

    const omitted = await app.inject({ method: 'GET', url: '/finances/fx-rates/effective?date=2026-09-09', headers: auth });
    expect(omitted.statusCode).toBe(200);
    expect(fxMocks.getFxRate).toHaveBeenLastCalledWith({ date: '2026-09-09', currency: 'USD', name: null });
  });

  it('GET /effective 非法日期 / 非法币种 → 400，不调服务', async () => {
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };
    const badDate = await app.inject({ method: 'GET', url: '/finances/fx-rates/effective?date=2026/09/09', headers: auth });
    expect(badDate.statusCode).toBe(400);
    const badCurrency = await app.inject({
      method: 'GET',
      url: '/finances/fx-rates/effective?date=2026-09-09&currency=EUR',
      headers: auth,
    });
    expect(badCurrency.statusCode).toBe(400);
    expect(fxMocks.getFxRate).not.toHaveBeenCalled();
  });

  it('GET /effective-list 透传 date + currency（目标日每个名称各一条）', async () => {
    fxMocks.listEffectiveFxRates.mockResolvedValue([fxDto]);
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };
    const res = await app.inject({
      method: 'GET',
      url: '/finances/fx-rates/effective-list?date=2026-09-09&currency=USD',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rates: [fxDto] });
    expect(fxMocks.listEffectiveFxRates).toHaveBeenCalledWith({ date: '2026-09-09', currency: 'USD' });
  });

  it('PUT 幂等 upsert：name/currency 透传 + 审计 UPSERT_FX_RATE；旧路径 supplier 等价 name、币种缺省 USD；VND 3740 放行', async () => {
    fxMocks.upsertFxRate.mockResolvedValue(fxDto);
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };

    const res = await app.inject({
      method: 'PUT',
      url: '/finances/fx-rates',
      headers: auth,
      payload: { name: '甲公司', currency: 'USD', effectiveFrom: '2026-01-01', rate: 7.2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rate: fxDto });
    expect(fxMocks.upsertFxRate).toHaveBeenCalledWith(
      expect.objectContaining({ name: '甲公司', currency: 'USD', effectiveFrom: '2026-01-01', rate: 7.2 }),
      'staff-1',
    );
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPSERT_FX_RATE',
        targetId: 'fx1',
        targetLabel: expect.stringContaining('甲公司'),
      }),
    );

    const legacy = await app.inject({
      method: 'PUT',
      url: '/finances/usd-fx-rates',
      headers: auth,
      payload: { supplier: '乙公司', effectiveFrom: '2026-01-01', rate: 7.1 },
    });
    expect(legacy.statusCode).toBe(200);
    expect(fxMocks.upsertFxRate).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: '乙公司', currency: 'USD', effectiveFrom: '2026-01-01', rate: 7.1 }),
      'staff-1',
    );

    fxMocks.upsertFxRate.mockResolvedValue({ ...fxDto, id: 'fx2', name: null, currency: 'VND', rate: 3740 });
    const vnd = await app.inject({
      method: 'PUT',
      url: '/finances/fx-rates',
      headers: auth,
      payload: { currency: 'VND', effectiveFrom: '2026-01-01', rate: 3740 },
    });
    expect(vnd.statusCode).toBe(200);
    expect(fxMocks.upsertFxRate).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: null, currency: 'VND', rate: 3740 }),
      'staff-1',
    );
    expect(writeAuditMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetLabel: expect.stringContaining('通用') }),
    );
  });

  it('PUT 汇率 ≤ 0 / 名称超长 / 非法币种 → 400，不调服务', async () => {
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };
    const zero = await app.inject({
      method: 'PUT',
      url: '/finances/fx-rates',
      headers: auth,
      payload: { currency: 'USD', effectiveFrom: '2026-01-01', rate: 0 },
    });
    expect(zero.statusCode).toBe(400);
    const tooLong = await app.inject({
      method: 'PUT',
      url: '/finances/fx-rates',
      headers: auth,
      payload: { name: 'x'.repeat(101), currency: 'USD', effectiveFrom: '2026-01-01', rate: 7.2 },
    });
    expect(tooLong.statusCode).toBe(400);
    const badCurrency = await app.inject({
      method: 'PUT',
      url: '/finances/fx-rates',
      headers: auth,
      payload: { currency: 'EUR', effectiveFrom: '2026-01-01', rate: 7.2 },
    });
    expect(badCurrency.statusCode).toBe(400);
    expect(fxMocks.upsertFxRate).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('GET 列表 / 名称候选 / 旧公司候选 走对应服务', async () => {
    fxMocks.listFxRates.mockResolvedValue([fxDto]);
    fxMocks.listFxNameOptions.mockResolvedValue({ USD: ['甲公司'], VND: ['酒店越南盾', '车队越南盾'] });
    fxMocks.listFxSupplierOptions.mockResolvedValue(['甲公司', '乙公司']);
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };

    const listed = await app.inject({ method: 'GET', url: '/finances/fx-rates', headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ rates: [fxDto] });

    const names = await app.inject({ method: 'GET', url: '/finances/fx-rates/name-options', headers: auth });
    expect(names.statusCode).toBe(200);
    expect(names.json()).toEqual({ options: { USD: ['甲公司'], VND: ['酒店越南盾', '车队越南盾'] } });

    const options = await app.inject({ method: 'GET', url: '/finances/usd-fx-rates/supplier-options', headers: auth });
    expect(options.statusCode).toBe(200);
    expect(options.json()).toEqual({ suppliers: ['甲公司', '乙公司'] });
  });

  it('PATCH /cost/hotel-room-type/:id：人民币与越南盾同时给数 → 400；越南盾 + 汇率名称透传', async () => {
    patchHotelRoomTypeCostMock.mockResolvedValue({ id: 'rt1' });
    const auth = { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` };
    const both = await app.inject({
      method: 'PATCH',
      url: '/finances/cost/hotel-room-type/rt1',
      headers: auth,
      payload: { costPriceCny: 400, costPriceVnd: 1_500_000 },
    });
    expect(both.statusCode).toBe(400);
    expect(patchHotelRoomTypeCostMock).not.toHaveBeenCalled();

    const vnd = await app.inject({
      method: 'PATCH',
      url: '/finances/cost/hotel-room-type/rt1',
      headers: auth,
      payload: { costPriceVnd: 1_500_000, costFxName: '酒店越南盾' },
    });
    expect(vnd.statusCode).toBe(200);
    expect(patchHotelRoomTypeCostMock).toHaveBeenCalledWith('rt1', {
      costPriceVnd: 1_500_000,
      costFxName: '酒店越南盾',
    });
  });

  it('AGENT 一律 403，不触碰服务', async () => {
    const auth = { authorization: `Bearer ${tokenFor('agent-1', UserRole.AGENT)}` };
    for (const url of [
      '/finances/fx-rates',
      '/finances/fx-rates/name-options',
      '/finances/fx-rates/effective?date=2026-09-09',
      '/finances/fx-rates/effective-list?date=2026-09-09',
      '/finances/usd-fx-rates',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode).toBe(403);
    }
    expect(fxMocks.listFxRates).not.toHaveBeenCalled();
    expect(fxMocks.listFxNameOptions).not.toHaveBeenCalled();
    expect(fxMocks.listEffectiveFxRates).not.toHaveBeenCalled();
    expect(fxMocks.getFxRate).not.toHaveBeenCalled();
  });
});
