/**
 * 批量收款复核锁 / 批量事后调价 / 批量建单议价鉴权 · 路由级单测（鉴权、去重、回包、逐单审计）
 *
 * 服务层口径见 orders.batch-finance.test.ts、orders.batch-manual-price.test.ts；这里只管路由这一层：
 *   1. 仅 ADMIN/STAFF 可达（代理/客户 403，且不触服务）——含批量建单的结算价通道（整批价 / 逐人价同权）。
 *   2. 重复勾选的订单号在入参处收敛成一份再进服务。
 *   3. 只给真正改动的订单写审计，且带 batch 标记（与单单入口共用 action，靠旗子区分入口）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }),
  },
  agent: { findUnique: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const batchSetPaymentsLockMock = vi.hoisted(() => vi.fn());
const batchAddPriceAdjustmentMock = vi.hoisted(() => vi.fn());
const batchCreateOrdersMock = vi.hoisted(() => vi.fn());
vi.mock('./orders.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orders.service.js')>();
  return {
    ...actual,
    OrderService: vi.fn().mockImplementation(() => ({
      batchSetPaymentsLock: batchSetPaymentsLockMock,
      batchAddPriceAdjustment: batchAddPriceAdjustmentMock,
      batchCreateOrders: batchCreateOrdersMock,
    })),
  };
});

vi.mock('../../lib/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/audit.js')>();
  return { ...actual, writeAudit: vi.fn().mockResolvedValue(undefined) };
});

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { orderRoutes } from './orders.routes.js';
import { writeAudit } from '../../lib/audit.js';

describe('批量收款锁 / 批量调价路由', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(orderRoutes, { prefix: '/orders' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: true });
  });

  function tokenFor(sub: string, role: UserRole): string {
    return app.jwt.sign({ sub, role });
  }

  function post(url: string, token: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  it.each<UserRole>([UserRole.CUSTOMER, UserRole.AGENT])(
    'role=%s 打不开批量收款锁',
    async (role) => {
      const res = await post('/orders/batch/payments-lock', tokenFor(`u-${role}`, role), {
        orderIds: ['o1'],
        locked: true,
      });
      expect(res.statusCode).toBe(403);
      expect(batchSetPaymentsLockMock).not.toHaveBeenCalled();
    },
  );

  it.each<UserRole>([UserRole.CUSTOMER, UserRole.AGENT])('role=%s 打不开批量调价', async (role) => {
    const res = await post('/orders/batch/price-adjustment', tokenFor(`u-${role}`, role), {
      orderIds: ['o1'],
      mode: 'PER_PAX',
      amountCny: 40,
      reasonCode: 'MISC_FEE',
    });
    expect(res.statusCode).toBe(403);
    expect(batchAddPriceAdjustmentMock).not.toHaveBeenCalled();
  });

  it.each([true, false])('STAFF 批量 locked=%s：去重入参、只给改动单写审计', async (locked) => {
    const at = new Date('2026-09-04T02:00:00.000Z');
    batchSetPaymentsLockMock.mockResolvedValue({
      updated: 1,
      skipped: 1,
      results: [
        {
          orderId: 'o1',
          orderNumber: 'ORD-001',
          ok: true,
          beforeLocked: !locked,
          paymentsLockedAt: locked ? at : null,
        },
        { orderId: 'o2', orderNumber: 'ORD-002', ok: false, reason: '订单在回收站，请先恢复' },
      ],
    });

    const res = await post('/orders/batch/payments-lock', tokenFor('staff-1', UserRole.STAFF), {
      orderIds: ['o1', 'o1', 'o2'],
      locked,
    });

    expect(res.statusCode).toBe(200);
    // 重复勾选的 o1 只进一次服务
    expect(batchSetPaymentsLockMock).toHaveBeenCalledWith(['o1', 'o2'], locked, 'staff-1');
    expect(res.json()).toEqual({
      updated: 1,
      skipped: 1,
      results: [
        { orderId: 'o1', orderNumber: 'ORD-001', ok: true },
        { orderId: 'o2', orderNumber: 'ORD-002', ok: false, reason: '订单在回收站，请先恢复' },
      ],
    });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: locked ? 'LOCK_PAYMENTS' : 'UNLOCK_PAYMENTS',
        targetType: 'ORDER',
        targetId: 'o1',
        targetLabel: 'ORD-001',
        severity: 'WARNING',
        after: expect.objectContaining({ paymentsLocked: locked, batch: true }),
      }),
    );
  });

  it('STAFF 批量调价：回包带每单落库金额，审计记 mode + 实际金额', async () => {
    batchAddPriceAdjustmentMock.mockResolvedValue({
      updated: 1,
      skipped: 1,
      results: [
        {
          orderId: 'o1',
          orderNumber: 'ORD-001',
          ok: true,
          appliedAmountCny: 80,
          itemId: 'item-1',
          before: { subtotal: '1000', total: '1000' },
          after: { subtotal: '1080', total: '1080' },
        },
        {
          orderId: 'o2',
          orderNumber: 'ORD-002',
          ok: false,
          appliedAmountCny: null,
          reason: '结算价已锁定，请先解锁再修改',
        },
      ],
    });

    const res = await post('/orders/batch/price-adjustment', tokenFor('staff-1', UserRole.STAFF), {
      orderIds: ['o1', 'o2'],
      mode: 'PER_PAX',
      amountCny: 40,
      reasonCode: 'MISC_FEE',
    });

    expect(res.statusCode).toBe(200);
    expect(batchAddPriceAdjustmentMock).toHaveBeenCalledWith(
      ['o1', 'o2'],
      { mode: 'PER_PAX', amountCny: 40, reasonCode: 'MISC_FEE' },
      { userId: 'staff-1', role: UserRole.STAFF },
    );
    expect(res.json()).toEqual({
      updated: 1,
      skipped: 1,
      results: [
        { orderId: 'o1', orderNumber: 'ORD-001', ok: true, appliedAmountCny: 80 },
        {
          orderId: 'o2',
          orderNumber: 'ORD-002',
          ok: false,
          appliedAmountCny: null,
          reason: '结算价已锁定，请先解锁再修改',
        },
      ],
    });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ADD_ORDER_PRICE_ADJUSTMENT',
        targetId: 'o1',
        severity: 'WARNING',
        after: expect.objectContaining({
          amountCny: 80,
          mode: 'PER_PAX',
          batch: true,
          reasonCode: 'MISC_FEE',
          itemId: 'item-1',
          total: '1080',
        }),
      }),
    );
  });

  it('原因选「其它」却没写说明 → 400，不进服务', async () => {
    const res = await post('/orders/batch/price-adjustment', tokenFor('staff-1', UserRole.STAFF), {
      orderIds: ['o1'],
      mode: 'PER_ORDER',
      amountCny: 40,
      reasonCode: 'OTHER',
    });
    expect(res.statusCode).toBe(400);
    expect(batchAddPriceAdjustmentMock).not.toHaveBeenCalled();
  });

  // ── 批量建单的结算价通道：整批价与名单逐人价同权（仅运营），代理一律 403 ───────────
  function batchCreateBody(passengers: Array<Record<string, unknown>>): Record<string, unknown> {
    return {
      productType: 'FLIGHT_ONEWAY',
      outboundScheduleId: 's-1',
      flightCabin: 'ECONOMY',
      description: 'QH9588 DAD→MFM 2026-08-15 经济舱',
      passengers,
    };
  }
  const batchPax = (settlementPriceCny?: number): Record<string, unknown> => ({
    fullName: 'WU/FEILAI',
    documentNumber: 'EB9452866',
    dateOfBirth: '1983-09-20',
    nationality: 'CN',
    passportExpiry: '2030-01-01',
    ...(settlementPriceCny === undefined ? {} : { settlementPriceCny }),
  });

  it('AGENT 在名单里填逐人结算价 → 放行进服务（代理自助结算价，2026-09-20 与单张录单同口径）', async () => {
    batchCreateOrdersMock.mockResolvedValue({ successCount: 1, failureCount: 0, results: [] });
    const res = await post(
      '/orders/batch',
      tokenFor('agent-1', UserRole.AGENT),
      batchCreateBody([batchPax(3200)]),
    );
    expect(res.statusCode).toBe(201);
    expect(batchCreateOrdersMock).toHaveBeenCalledTimes(1);
    // 归属收口不在路由层：requester 只带登录身份，agentId 由服务端 resolveOrderAgentId 强制取本人。
    expect(batchCreateOrdersMock.mock.calls[0][1]).toMatchObject({ userId: 'agent-1', role: UserRole.AGENT });
  });

  it('AGENT 填整批结算价 → 同样放行进服务', async () => {
    batchCreateOrdersMock.mockResolvedValue({ successCount: 1, failureCount: 0, results: [] });
    const res = await post(
      '/orders/batch',
      tokenFor('agent-1', UserRole.AGENT),
      { ...batchCreateBody([batchPax()]), settlementPriceCny: 3600 },
    );
    expect(res.statusCode).toBe(201);
    expect(batchCreateOrdersMock).toHaveBeenCalledTimes(1);
  });

  it('AGENT 带 OTA 手动结算单价 manualUnitPriceCny → 403，不进服务（只给运营）', async () => {
    const res = await post(
      '/orders/batch',
      tokenFor('agent-1', UserRole.AGENT),
      { ...batchCreateBody([batchPax()]), manualUnitPriceCny: 1000 },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: '仅运营/管理员可手动录入结算单价' });
    expect(batchCreateOrdersMock).not.toHaveBeenCalled();
  });

  it('AGENT 带批量优惠 discountPerPersonCny → 403，不进服务（只给运营）', async () => {
    const res = await post(
      '/orders/batch',
      tokenFor('agent-1', UserRole.AGENT),
      { ...batchCreateBody([batchPax()]), discountPerPersonCny: 50 },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: '仅运营/管理员可录入优惠' });
    expect(batchCreateOrdersMock).not.toHaveBeenCalled();
  });

  it('CUSTOMER 在名单里填逐人结算价 → 403，不进服务', async () => {
    const res = await post(
      '/orders/batch',
      tokenFor('cust-1', UserRole.CUSTOMER),
      batchCreateBody([batchPax(3200)]),
    );
    expect(res.statusCode).toBe(403);
    expect(batchCreateOrdersMock).not.toHaveBeenCalled();
  });

  it('AGENT 名单不填结算价 → 不被这道闸拦（照旧进服务）', async () => {
    batchCreateOrdersMock.mockResolvedValue({ successCount: 1, failureCount: 0, results: [] });
    const res = await post(
      '/orders/batch',
      tokenFor('agent-1', UserRole.AGENT),
      batchCreateBody([batchPax()]),
    );
    expect(res.statusCode).toBe(201);
    expect(batchCreateOrdersMock).toHaveBeenCalledTimes(1);
  });
});
