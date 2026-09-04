/**
 * 改单申请 · 路由级单测（鉴权、回包形状、审计留痕）。
 *
 * 服务层口径见 order-change-requests.service.test.ts；这里只管路由这一层：
 *   1. 提交 —— 客户打不开；代理/运营可达，201 回 { request }，审计 ORDER_CHANGE_REQUEST_CREATED。
 *   2. 批量提交 —— 换酒店/升舱被服务层拒 → 400 带原话。
 *   3. 队列 / 角标 —— 角标只给运营。
 *   4. 确认 / 驳回 / 批量确认 —— 只有运营可达；确认失败 400 且回包带原因。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  OrderChangeKind,
  OrderChangeRequestStatus,
  UserRole,
  VisaRequirement,
} from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }),
  },
  agent: { findUnique: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const serviceMocks = vi.hoisted(() => ({
  create: vi.fn(),
  createBatch: vi.fn(),
  list: vi.fn(),
  pendingCount: vi.fn(),
  approve: vi.fn(),
  batchApprove: vi.fn(),
  reject: vi.fn(),
}));
vi.mock('./order-change-requests.service.js', () => ({
  OrderChangeRequestsService: vi.fn().mockImplementation(() => serviceMocks),
}));

vi.mock('../../lib/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/audit.js')>();
  return { ...actual, writeAudit: vi.fn().mockResolvedValue(undefined) };
});

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { writeAudit } from '../../lib/audit.js';
import { BadRequestError, ConflictError } from '../../lib/errors.js';
import {
  orderChangeRequestOrderRoutes,
  orderChangeRequestRoutes,
} from './order-change-requests.routes.js';

const REQUEST_FIXTURE = {
  id: 'req-1',
  orderId: 'o1',
  orderNumber: 'FTM0000000000000',
  agentId: 'ag-1',
  agentName: '示例商旅',
  requestedById: 'u-AGENT',
  requestedByLabel: null,
  batchId: null,
  kind: OrderChangeKind.VISA,
  payload: { toVisaStatus: VisaRequirement.NOT_NEEDED, fromVisaStatus: VisaRequirement.NEEDED },
  summary: '签证状态 需要 → 不需要',
  note: null,
  status: OrderChangeRequestStatus.PENDING,
  decidedById: null,
  decidedAt: null,
  decisionNote: null,
  appliedAt: null,
  applyError: null,
  createdAt: '2026-09-04T00:00:00.000Z',
  // 前端契约：升舱补差（所有角色）/ 换酒店成本变动（仅运营）
  amountCny: null,
  costDeltaCny: null,
};

describe('改单申请路由', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(orderChangeRequestOrderRoutes, { prefix: '/orders' });
    await app.register(orderChangeRequestRoutes, { prefix: '/order-change-requests' });
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
  });

  const tokenFor = (role: UserRole) => app.jwt.sign({ sub: `u-${role}`, role });

  const call = (method: 'POST' | 'GET', url: string, role: UserRole, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${tokenFor(role)}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  // ── 1. 提交 ───────────────────────────────────────────────────────────────
  describe('POST /orders/:id/change-requests', () => {
    const body = {
      kind: OrderChangeKind.VISA,
      payload: { toVisaStatus: VisaRequirement.NOT_NEEDED },
    };

    it('客户打不开 → 403，不触服务', async () => {
      const res = await call('POST', '/orders/o1/change-requests', UserRole.CUSTOMER, body);
      expect(res.statusCode).toBe(403);
      expect(serviceMocks.create).not.toHaveBeenCalled();
    });

    it('代理提交 → 201 回 { request }，审计记 kind + 摘要', async () => {
      serviceMocks.create.mockResolvedValue(REQUEST_FIXTURE);
      const res = await call('POST', '/orders/o1/change-requests', UserRole.AGENT, body);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ request: REQUEST_FIXTURE });
      expect(serviceMocks.create).toHaveBeenCalledWith(
        { userId: 'u-AGENT', role: UserRole.AGENT },
        'o1',
        expect.objectContaining({ kind: OrderChangeKind.VISA }),
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ORDER_CHANGE_REQUEST_CREATED',
          targetType: 'ORDER',
          targetId: 'o1',
          targetLabel: 'FTM0000000000000',
          after: expect.objectContaining({
            requestId: 'req-1',
            kind: OrderChangeKind.VISA,
            summary: '签证状态 需要 → 不需要',
          }),
        }),
      );
    });

    it('同类重复 → 服务层 409 原样透出', async () => {
      serviceMocks.create.mockRejectedValue(new ConflictError('该订单已有待处理的同类改单申请'));
      const res = await call('POST', '/orders/o1/change-requests', UserRole.AGENT, body);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('该订单已有待处理的同类改单申请');
    });

    it('已签证 → 服务层 400 原样透出', async () => {
      serviceMocks.create.mockRejectedValue(
        new BadRequestError('「已签证」由签证岗确认，改单申请里改不了'),
      );
      const res = await call('POST', '/orders/o1/change-requests', UserRole.AGENT, {
        kind: OrderChangeKind.VISA,
        payload: { toVisaStatus: VisaRequirement.HAS_VISA },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('「已签证」由签证岗确认，改单申请里改不了');
    });
  });

  // ── 2. 批量提交 ───────────────────────────────────────────────────────────
  describe('POST /order-change-requests/batch', () => {
    it('按航段批量 → 透传 orderIds/kind/payload，回批次结果', async () => {
      serviceMocks.createBatch.mockResolvedValue({
        batchId: 'batch-1',
        created: 2,
        skipped: 0,
        results: [
          { orderId: 'o1', orderNumber: 'FTM0000000000000', ok: true, requestId: 'req-1' },
          { orderId: 'o2', orderNumber: 'FTM0000000000001', ok: true, requestId: 'req-2' },
        ],
      });

      const res = await call('POST', '/order-change-requests/batch', UserRole.AGENT, {
        orderIds: ['o1', 'o2'],
        kind: OrderChangeKind.FLIGHT,
        payload: { leg: 'RETURN', newScheduleId: 'sched-new' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ batchId: 'batch-1', created: 2, skipped: 0 });
      expect(serviceMocks.createBatch).toHaveBeenCalledWith(
        { userId: 'u-AGENT', role: UserRole.AGENT },
        expect.objectContaining({
          orderIds: ['o1', 'o2'],
          kind: OrderChangeKind.FLIGHT,
          payload: { leg: 'RETURN', newScheduleId: 'sched-new' },
        }),
      );
      // 成功的每单各写一条提交审计
      expect(writeAudit).toHaveBeenCalledTimes(2);
    });

    it('换酒店不支持批量 → 400 带原话', async () => {
      serviceMocks.createBatch.mockRejectedValue(
        new BadRequestError('换酒店 / 升舱要按行选，只能单张单提交，不支持批量'),
      );
      const res = await call('POST', '/order-change-requests/batch', UserRole.AGENT, {
        orderIds: ['o1'],
        kind: OrderChangeKind.HOTEL,
        payload: { itemId: 'i1', toHotelRoomTypeId: 'room-new' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('换酒店 / 升舱要按行选，只能单张单提交，不支持批量');
    });

    it('订单数超上限 → 400（zod）', async () => {
      const res = await call('POST', '/order-change-requests/batch', UserRole.AGENT, {
        orderIds: Array.from({ length: 201 }, (_, i) => `o${i}`),
        kind: OrderChangeKind.VISA,
        payload: { toVisaStatus: VisaRequirement.NOT_NEEDED },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('一次最多 200 张订单');
      expect(serviceMocks.createBatch).not.toHaveBeenCalled();
    });
  });

  // ── 3. 队列 / 角标 ────────────────────────────────────────────────────────
  describe('GET /order-change-requests', () => {
    it('列表透传筛选 + 游标', async () => {
      serviceMocks.list.mockResolvedValue({ requests: [REQUEST_FIXTURE], nextCursor: null });
      const res = await call(
        'GET',
        '/order-change-requests?status=PENDING&kind=VISA&orderId=o1&limit=20',
        UserRole.ADMIN,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requests: [REQUEST_FIXTURE], nextCursor: null });
      expect(serviceMocks.list).toHaveBeenCalledWith(
        { userId: 'u-ADMIN', role: UserRole.ADMIN },
        expect.objectContaining({
          status: OrderChangeRequestStatus.PENDING,
          kind: OrderChangeKind.VISA,
          orderId: 'o1',
          limit: 20,
        }),
      );
    });

    it('代理查已处理的申请 + since → 透传给服务层', async () => {
      serviceMocks.list.mockResolvedValue({ requests: [], nextCursor: null });
      const res = await call(
        'GET',
        '/order-change-requests?status=APPROVED&since=2026-09-01T00:00:00.000Z',
        UserRole.AGENT,
      );
      expect(res.statusCode).toBe(200);
      expect(serviceMocks.list).toHaveBeenCalledWith(
        { userId: 'u-AGENT', role: UserRole.AGENT },
        expect.objectContaining({
          status: OrderChangeRequestStatus.APPROVED,
          since: new Date('2026-09-01T00:00:00.000Z'),
        }),
      );
    });

    it('since 不是合法时间 → 400（zod）', async () => {
      const res = await call('GET', '/order-change-requests?since=昨天', UserRole.AGENT);
      expect(res.statusCode).toBe(400);
      expect(serviceMocks.list).not.toHaveBeenCalled();
    });

    it('角标只给运营 → 代理 403', async () => {
      serviceMocks.pendingCount.mockResolvedValue({ count: 3 });
      const ok = await call('GET', '/order-change-requests/pending-count', UserRole.STAFF);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ count: 3 });

      const denied = await call('GET', '/order-change-requests/pending-count', UserRole.AGENT);
      expect(denied.statusCode).toBe(403);
    });
  });

  // ── 4. 确认 / 驳回 / 批量确认 ─────────────────────────────────────────────
  describe('POST /order-change-requests/:id/approve', () => {
    const approved = {
      request: { ...REQUEST_FIXTURE, status: OrderChangeRequestStatus.APPROVED },
      order: { id: 'o1' },
      audit: {
        orderId: 'o1',
        orderNumber: 'FTM0000000000000',
        requestedById: 'u-AGENT',
        kind: OrderChangeKind.VISA,
        summary: '签证状态 需要 → 不需要',
      },
    };

    it('代理打不开 → 403', async () => {
      const res = await call('POST', '/order-change-requests/req-1/approve', UserRole.AGENT, {});
      expect(res.statusCode).toBe(403);
      expect(serviceMocks.approve).not.toHaveBeenCalled();
    });

    it('运营确认 → 200 回 { request, order }，审计 WARNING', async () => {
      serviceMocks.approve.mockResolvedValue(approved);
      const res = await call('POST', '/order-change-requests/req-1/approve', UserRole.STAFF, {});

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ request: approved.request, order: { id: 'o1' } });
      expect(serviceMocks.approve).toHaveBeenCalledWith(
        { userId: 'u-STAFF', role: UserRole.STAFF },
        'req-1',
        {},
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ORDER_CHANGE_REQUEST_APPROVED',
          targetType: 'ORDER',
          targetId: 'o1',
          severity: 'WARNING',
          before: { status: 'PENDING' },
          after: expect.objectContaining({ status: OrderChangeRequestStatus.APPROVED }),
        }),
      );
    });

    it('带星级放行原因确认 → 原样透传给服务层', async () => {
      serviceMocks.approve.mockResolvedValue(approved);
      const res = await call('POST', '/order-change-requests/req-1/approve', UserRole.ADMIN, {
        decisionNote: '已与客人确认',
        designatedHotelStarMismatchReason: '客人自愿降档，差额已线下退回',
      });

      expect(res.statusCode).toBe(200);
      expect(serviceMocks.approve).toHaveBeenCalledWith({ userId: 'u-ADMIN', role: UserRole.ADMIN }, 'req-1', {
        decisionNote: '已与客人确认',
        designatedHotelStarMismatchReason: '客人自愿降档，差额已线下退回',
      });
    });

    it('放行原因超 200 字 → 400（zod），不触服务', async () => {
      const res = await call('POST', '/order-change-requests/req-1/approve', UserRole.ADMIN, {
        designatedHotelStarMismatchReason: '很'.repeat(201),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('放行原因最多 200 字');
      expect(serviceMocks.approve).not.toHaveBeenCalled();
    });

    it('执行失败 → 400 把原因回给运营，不写确认审计', async () => {
      serviceMocks.approve.mockRejectedValue(
        new BadRequestError('本单含套餐立减，改班次要重算补差'),
      );
      const res = await call('POST', '/order-change-requests/req-1/approve', UserRole.ADMIN, {});
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('本单含套餐立减，改班次要重算补差');
      expect(writeAudit).not.toHaveBeenCalled();
    });
  });

  describe('POST /order-change-requests/:id/reject', () => {
    it('运营驳回 → 回 { request }，审计 ORDER_CHANGE_REQUEST_REJECTED', async () => {
      serviceMocks.reject.mockResolvedValue({
        request: { ...REQUEST_FIXTURE, status: OrderChangeRequestStatus.REJECTED },
        audit: {
          orderId: 'o1',
          orderNumber: 'FTM0000000000000',
          requestedById: 'u-AGENT',
          kind: OrderChangeKind.VISA,
          summary: '签证状态 需要 → 不需要',
        },
      });
      const res = await call('POST', '/order-change-requests/req-1/reject', UserRole.ADMIN, {
        decisionNote: '客人已确认不改',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().request.status).toBe(OrderChangeRequestStatus.REJECTED);
      expect(serviceMocks.reject).toHaveBeenCalledWith(
        { userId: 'u-ADMIN', role: UserRole.ADMIN },
        'req-1',
        { decisionNote: '客人已确认不改' },
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ORDER_CHANGE_REQUEST_REJECTED', severity: 'WARNING' }),
      );
    });

    it('申请正在执行中 → 服务层 409 原样透出', async () => {
      serviceMocks.reject.mockRejectedValue(new ConflictError('该申请正在执行中，请稍后刷新'));
      const res = await call('POST', '/order-change-requests/req-1/reject', UserRole.ADMIN, {});
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('该申请正在执行中，请稍后刷新');
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('代理打不开 → 403', async () => {
      const res = await call('POST', '/order-change-requests/req-1/reject', UserRole.AGENT, {});
      expect(res.statusCode).toBe(403);
      expect(serviceMocks.reject).not.toHaveBeenCalled();
    });
  });

  describe('POST /order-change-requests/batch-approve', () => {
    it('部分成功 → 回 { approved, failed, results }，成功那条写审计', async () => {
      serviceMocks.batchApprove.mockResolvedValue({
        approved: 1,
        failed: 1,
        results: [
          { id: 'req-1', ok: true },
          { id: 'req-2', ok: false, error: '改单申请不存在' },
        ],
        approvedRequests: [
          {
            request: { ...REQUEST_FIXTURE, status: OrderChangeRequestStatus.APPROVED },
            audit: {
              orderId: 'o1',
              orderNumber: 'FTM0000000000000',
              requestedById: 'u-AGENT',
              kind: OrderChangeKind.VISA,
              summary: '签证状态 需要 → 不需要',
            },
          },
        ],
      });

      const res = await call('POST', '/order-change-requests/batch-approve', UserRole.ADMIN, {
        ids: ['req-1', 'req-2'],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        approved: 1,
        failed: 1,
        results: [
          { id: 'req-1', ok: true },
          { id: 'req-2', ok: false, error: '改单申请不存在' },
        ],
      });
      // approvedRequests 是给审计用的内部字段，不回给前端
      expect(res.json().approvedRequests).toBeUndefined();
      expect(writeAudit).toHaveBeenCalledTimes(1);
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ORDER_CHANGE_REQUEST_APPROVED',
          after: expect.objectContaining({ batchApprove: true }),
        }),
      );
    });

    it('代理打不开 → 403', async () => {
      const res = await call('POST', '/order-change-requests/batch-approve', UserRole.AGENT, {
        ids: ['req-1'],
      });
      expect(res.statusCode).toBe(403);
      expect(serviceMocks.batchApprove).not.toHaveBeenCalled();
    });
  });
});
