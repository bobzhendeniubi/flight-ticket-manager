/**
 * 批量开票（票务岗）· POST /orders/batch-invoice-flags
 *
 * 覆盖：
 *   1. batchSetInvoiceFlagsBodySchema：flags 全空 / orderIds 空 → 校验拒绝
 *   2. 路由权限：非 ADMIN/STAFF → 403；ADMIN/STAFF → 200 且逐单调用 service，
 *      每个成功单各写一条 UPDATE_INVOICE_STATUS 审计
 *
 * 批量翻转“超班次开票上限时单单失败、其余成功”的业务语义已在 ticketing-cap.test.ts 的
 * `OrderService.batchSetInvoiceFlags` 用例里覆盖（复用其 setInvoiceFlags 校验路径）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';
import { batchSetInvoiceFlagsBodySchema } from './orders.schemas.js';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }) },
  agent: { findUnique: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const batchSetInvoiceFlagsMock = vi.hoisted(() => vi.fn());
vi.mock('./orders.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orders.service.js')>();
  return {
    ...actual,
    OrderService: vi.fn().mockImplementation(() => ({
      batchSetInvoiceFlags: batchSetInvoiceFlagsMock,
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

// ── batchSetInvoiceFlagsBodySchema（zod 层，独立于路由/网络）────────────────
describe('batchSetInvoiceFlagsBodySchema', () => {
  it('flags 全空 → 拒绝', () => {
    expect(() =>
      batchSetInvoiceFlagsBodySchema.parse({ orderIds: ['o1'], flags: {} }),
    ).toThrow();
  });

  it('orderIds 空数组 → 拒绝', () => {
    expect(() =>
      batchSetInvoiceFlagsBodySchema.parse({ orderIds: [], flags: { outboundInvoiced: true } }),
    ).toThrow();
  });

  it('合法 body → 通过', () => {
    expect(() =>
      batchSetInvoiceFlagsBodySchema.parse({
        orderIds: ['o1', 'o2'],
        flags: { outboundInvoiced: true },
      }),
    ).not.toThrow();
  });
});

// ── POST /orders/batch-invoice-flags（路由层：权限 + 逐单审计）─────────────
describe('POST /orders/batch-invoice-flags', () => {
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
    // AGENT 角色的 authenticate 中间件会额外查 Agent.isActive（见 auth.ts）；
    // 本测试组不关心停用场景，默认给活跃代理，避免误判成 401 掩盖了我们要测的 403。
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: true });
  });

  function tokenFor(sub: string, role: UserRole): string {
    return app.jwt.sign({ sub, role });
  }

  function hitBatchInvoiceFlags(token: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/orders/batch-invoice-flags',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  it.each<UserRole>([UserRole.CUSTOMER, UserRole.AGENT])(
    'role=%s → 403（仅运营/管理员可批量修改开票状态）',
    async (role) => {
      const token = tokenFor(`user-${role}`, role);
      const res = await hitBatchInvoiceFlags(token, {
        orderIds: ['o1'],
        flags: { outboundInvoiced: true },
      });
      expect(res.statusCode).toBe(403);
      expect(batchSetInvoiceFlagsMock).not.toHaveBeenCalled();
    },
  );

  it('flags 全空 → 400', async () => {
    const token = tokenFor('staff-1', UserRole.STAFF);
    const res = await hitBatchInvoiceFlags(token, { orderIds: ['o1'], flags: {} });
    expect(res.statusCode).toBe(400);
    expect(batchSetInvoiceFlagsMock).not.toHaveBeenCalled();
  });

  it('STAFF + 合法 body → 200，逐单调用 service，成功单各写一条审计', async () => {
    batchSetInvoiceFlagsMock.mockResolvedValue({
      succeeded: 1,
      failed: 1,
      results: [
        {
          id: 'ord1',
          orderNumber: 'ORD-001',
          ok: true,
          outboundInvoiced: true,
          returnInvoiced: false,
          systemInvoiced: false,
        },
        { id: 'ord2', ok: false, error: '该班次已开票 191 张，最多 191 张，无法继续开票' },
      ],
    });
    const token = tokenFor('staff-1', UserRole.STAFF);
    const res = await hitBatchInvoiceFlags(token, {
      orderIds: ['ord1', 'ord2'],
      flags: { outboundInvoiced: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      succeeded: 1,
      failed: 1,
      results: [
        {
          id: 'ord1',
          orderNumber: 'ORD-001',
          ok: true,
          outboundInvoiced: true,
          returnInvoiced: false,
          systemInvoiced: false,
        },
        { id: 'ord2', ok: false, error: '该班次已开票 191 张，最多 191 张，无法继续开票' },
      ],
    });
    expect(batchSetInvoiceFlagsMock).toHaveBeenCalledWith(['ord1', 'ord2'], {
      outboundInvoiced: true,
    });
    // 只有成功单（ord1）写审计，失败单（ord2）不写
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE_INVOICE_STATUS',
        targetType: 'ORDER',
        targetId: 'ord1',
        targetLabel: 'ORD-001',
        after: { outboundInvoiced: true, returnInvoiced: false, systemInvoiced: false },
      }),
    );
  });

  // ── 旧订单级开票端点已删除（0716 H11b）────────────────────────────────────
  // 它是六态开票之前的遗留：不走开票状态闸（取消族/回收站单照样能标），写进的
  // Order.invoiceStatus 也已无人读 —— 两本账。删掉后必须真的没有这条路由，
  // 否则前端/脚本一旦还在调，就会绕过 invoice-flags 的两道闸悄悄写脏数据。
  it('PATCH /orders/:id/invoice-status 已删除 → 404（开票唯一入口是 invoice-flags）', async () => {
    const token = tokenFor('staff-1', UserRole.STAFF);
    const res = await app.inject({
      method: 'PATCH',
      url: '/orders/ord1/invoice-status',
      headers: { authorization: `Bearer ${token}` },
      payload: { invoiceStatus: 'ISSUED' },
    });
    expect(res.statusCode).toBe(404);
  });
});
