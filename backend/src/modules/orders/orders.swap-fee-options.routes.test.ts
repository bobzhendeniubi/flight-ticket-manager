/**
 * 换人费档位 + 换人预览 · 路由级单测（鉴权、校验、审计留痕）
 *
 * 服务层口径见 orders.swap-reprice.test.ts；这里只管路由这一层：
 *   1. GET  /orders/swap-fee-options —— 任意登录角色可读（代理换人也要填这笔钱，界面按档位预填）。
 *   2. PUT  /orders/swap-fee-options —— 仅 ADMIN；写 SystemSetting + WARNING 审计；越界值 400。
 *   3. GET  /orders/:id/passengers/:passengerId/swap-preview —— 带 agentId 进服务，原样回包。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }),
  },
  agent: { findUnique: vi.fn() },
  systemSetting: { findUnique: vi.fn(), upsert: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const serviceMocks = vi.hoisted(() => ({ swapPreview: vi.fn() }));
vi.mock('./orders.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orders.service.js')>();
  return {
    ...actual,
    OrderService: vi.fn().mockImplementation(() => serviceMocks),
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

describe('换人费档位 / 换人预览路由', () => {
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
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      agentProfile: { isActive: true },
    });
    prismaMock.agent.findUnique.mockResolvedValue({ id: 'ag-1', isActive: true });
    prismaMock.systemSetting.findUnique.mockResolvedValue(null);
    prismaMock.systemSetting.upsert.mockResolvedValue({});
  });

  const tokenFor = (role: UserRole) => app.jwt.sign({ sub: `u-${role}`, role });
  const call = (method: 'GET' | 'PUT', url: string, role: UserRole, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${tokenFor(role)}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  // ── 1. 读档位 ───────────────────────────────────────────────────────────
  describe('GET /orders/swap-fee-options', () => {
    it('未配置 → 缺省两档；任意登录角色可读', async () => {
      for (const role of [UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT]) {
        const res = await call('GET', '/orders/swap-fee-options', role);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ options: [450, 550] });
      }
    });

    it('已配置 → 按配置回（逗号分隔）', async () => {
      prismaMock.systemSetting.findUnique.mockResolvedValue({ value: '450,550,600' });
      const res = await call('GET', '/orders/swap-fee-options', UserRole.AGENT);
      expect(res.json()).toEqual({ options: [450, 550, 600] });
    });

    it('未登录 → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/orders/swap-fee-options' });
      expect(res.statusCode).toBe(401);
    });

    // 复审 L3：换人费档位是我方与代理之间的收费口径，客户侧根本没有换人这条通道。
    it('客户 → 403，不读配置', async () => {
      const res = await call('GET', '/orders/swap-fee-options', UserRole.CUSTOMER);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: '仅运营/代理可查看换人费档位' });
      expect(prismaMock.systemSetting.findUnique).not.toHaveBeenCalled();
    });
  });

  // ── 2. 改档位 ───────────────────────────────────────────────────────────
  describe('PUT /orders/swap-fee-options', () => {
    it('运营（STAFF）也不许改 → 403，不写库', async () => {
      const res = await call('PUT', '/orders/swap-fee-options', UserRole.STAFF, {
        options: [450],
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: '仅管理员可修改换人费档位' });
      expect(prismaMock.systemSetting.upsert).not.toHaveBeenCalled();
    });

    it('管理员改档位 → 写 SystemSetting（逗号分隔）+ WARNING 审计（前后对照）', async () => {
      const res = await call('PUT', '/orders/swap-fee-options', UserRole.ADMIN, {
        options: [450, 550, 600],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ options: [450, 550, 600] });
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith({
        where: { key: 'orders.swapFeeOptionsCny' },
        create: {
          key: 'orders.swapFeeOptionsCny',
          value: '450,550,600',
          updatedById: 'u-ADMIN',
        },
        update: { value: '450,550,600', updatedById: 'u-ADMIN' },
      });
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE_SWAP_FEE_OPTIONS',
          targetId: 'orders.swapFeeOptionsCny',
          before: { options: [450, 550] },
          after: { options: [450, 550, 600] },
          severity: 'WARNING',
        }),
      );
    });

    it.each([
      ['空清单', { options: [] }],
      ['超过 5 档', { options: [1, 2, 3, 4, 5, 6] }],
      ['非整数', { options: [450.5] }],
      ['负数', { options: [-1] }],
      ['超出上限', { options: [100_001] }],
    ])('%s → 400，不写库', async (_label, payload) => {
      const res = await call('PUT', '/orders/swap-fee-options', UserRole.ADMIN, payload);
      expect(res.statusCode).toBe(400);
      expect(prismaMock.systemSetting.upsert).not.toHaveBeenCalled();
    });
  });

  // ── 3. 换人预览 ─────────────────────────────────────────────────────────
  describe('GET /orders/:id/passengers/:passengerId/swap-preview', () => {
    it('代理可读自家单 → 带 agentId 进服务，原样回包', async () => {
      serviceMocks.swapPreview.mockResolvedValue({
        basisCny: 1000,
        oldShareCny: 1200,
        newSettlementCny: 800,
        diffCny: 200,
        calendarSource: 'BUNDLE_SETTLEMENT_CALENDAR',
        settlementLocked: false,
        feeOptions: [450, 550],
      });
      const res = await call('GET', '/orders/o1/passengers/p1/swap-preview', UserRole.AGENT);
      expect(res.statusCode).toBe(200);
      // 差价基准（成交那天的日历价）与这个人的每人份额是两个数，界面两个都要拿到。
      expect(res.json()).toMatchObject({
        basisCny: 1000,
        oldShareCny: 1200,
        newSettlementCny: 800,
        diffCny: 200,
      });
      expect(serviceMocks.swapPreview).toHaveBeenCalledWith('o1', 'p1', {
        userId: 'u-AGENT',
        role: UserRole.AGENT,
        agentId: 'ag-1',
      });
    });

    it('取不到日历基准（非日历成交）→ 回 NOT_CALENDAR_PRICED，界面据此提示走人工调价', async () => {
      serviceMocks.swapPreview.mockResolvedValue({
        basisCny: null,
        oldShareCny: 1200,
        newSettlementCny: null,
        diffCny: 0,
        calendarSource: null,
        settlementLocked: false,
        repriceSkipped: 'NOT_CALENDAR_PRICED',
        feeOptions: [450, 550],
      });
      const res = await call('GET', '/orders/o1/passengers/p1/swap-preview', UserRole.STAFF);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        basisCny: null,
        newSettlementCny: null,
        repriceSkipped: 'NOT_CALENDAR_PRICED',
      });
    });

    it('归属/角色不符（服务抛 403）→ 原样把理由回给界面', async () => {
      const { ForbiddenError } = await import('../../lib/errors.js');
      serviceMocks.swapPreview.mockRejectedValue(new ForbiddenError('仅运营/代理可查看换人预览'));
      const res = await call('GET', '/orders/o1/passengers/p1/swap-preview', UserRole.CUSTOMER);
      expect(res.statusCode).toBe(403);
      // 统一错误处理器把 AppError 包成 { error: { code, message } }。
      expect(res.json()).toEqual({
        error: { code: 'FORBIDDEN', message: '仅运营/代理可查看换人预览' },
      });
    });
  });
});
