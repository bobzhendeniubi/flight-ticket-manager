/**
 * OrderService.requestCancellation · 服务级测试（vitest）
 *
 * 用 vi.mock 把 Prisma 和 computeCancellationQuote 替换成可控的 fixture，
 * 不依赖真 DB。覆盖 3 条最关键的分支：
 *   1. 订单不存在 → NotFoundError
 *   2. 客户权限：尝试取消别人的订单 → ForbiddenError
 *   3. 幂等：已有 REQUESTED 退款 → 返回 isNew=false（不再创建第二条）
 *
 * 不覆盖（需要 stage 多层 transaction 调用，超出本次范围）：
 *   - 完整 happy path（创建 Refund + 状态流转）—— 真集成测试该用 testDB
 *   - quote.cancellable=false 的 BadRequestError —— 算法已在 cancellation.test.ts 测过
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 在 import OrderService 之前 mock 依赖 ──
// vi.mock 会被 hoist 到文件顶部，所以引用的变量也得 hoist
const { mockPrisma, mockComputeQuote } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  },
  mockComputeQuote: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../lib/cancellation.js', () => ({
  computeCancellationQuote: mockComputeQuote,
}));

// 现在才能 import service
import { OrderService } from './orders.service.js';

// ── Fixture helper：build 一个完整的 fake order（serializeOrder 要的字段全有） ──
const dec = (n: number) => ({ toString: () => String(n) });
function fakeFullOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord1',
    orderNumber: 'ORD-001',
    userId: 'me',
    agentId: null,
    status: 'PAID',
    subtotal: dec(100),
    taxesAndFees: dec(0),
    discountTotal: dec(0),
    total: dec(100),
    paidAmount: dec(100),
    prepaymentOffset: dec(0),
    totalAmount: dec(100),
    currency: 'CNY',
    contactName: 'X',
    contactPhone: 'Y',
    contactEmail: null,
    paymentExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [],
    passengers: [],
    payments: [],
    refunds: [],
    statusEvents: [],
    agent: null,
    user: { id: 'me', displayName: null, email: null },
    ...overrides,
  };
}

describe('OrderService.requestCancellation', () => {
  const service = new OrderService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('订单不存在 → 抛 NotFoundError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);

    await expect(
      service.requestCancellation('nonexistent-id', 'reason', {
        userId: 'u1',
        role: 'CUSTOMER',
        agentId: undefined,
      }),
    ).rejects.toThrow(/不存在/);
  });

  it('客户尝试取消别人的订单 → 抛 ForbiddenError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: 'ord1',
      userId: 'other-user',
      agentId: null,
      refunds: [],
    });

    await expect(
      service.requestCancellation('ord1', undefined, {
        userId: 'me',
        role: 'CUSTOMER',
        agentId: undefined,
      }),
    ).rejects.toThrow(/无权/);

    // 关键：根本没走到 quote 计算
    expect(mockComputeQuote).not.toHaveBeenCalled();
  });

  it('幂等：已有 pending Refund → 返回 isNew=false，不再创建', async () => {
    const existingRefund = { id: 'ref-existing', status: 'REQUESTED', amount: '100' };

    mockPrisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord1',
      userId: 'me',
      agentId: null,
      refunds: [existingRefund], // 已有 pending 退款
    });

    // mock findUniqueOrThrow（service 内部的二次查）
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce(
      fakeFullOrder({ refunds: [existingRefund] }),
    );

    mockComputeQuote.mockResolvedValue({
      orderId: 'ord1',
      orderNumber: 'ORD-001',
      paidAmount: 100,
      totalFee: 30,
      totalRefund: 70,
      items: [],
      cancellable: true,
    });

    const r = await service.requestCancellation('ord1', undefined, {
      userId: 'me',
      role: 'CUSTOMER',
      agentId: undefined,
    });

    expect(r.isNew).toBe(false);
    expect(r.refund).toBe(existingRefund);
    // 关键：service 不应该走 prisma.refund.create — 因为已经有 pending refund
    expect(mockComputeQuote).toHaveBeenCalledTimes(1); // 只为重算最新报价
  });

  it('ADMIN 角色绕过 owner 检查（即使不是订单 owner 也能调）', async () => {
    const existingRefund = { id: 'ref-1', status: 'REQUESTED', amount: '100' };

    mockPrisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord1',
      userId: 'someone-else',
      agentId: null,
      refunds: [existingRefund],
    });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce(
      fakeFullOrder({
        userId: 'someone-else',
        refunds: [existingRefund],
        user: { id: 'someone-else', displayName: null, email: null },
      }),
    );
    mockComputeQuote.mockResolvedValue({
      orderId: 'ord1',
      orderNumber: 'ORD-001',
      paidAmount: 100,
      totalFee: 30,
      totalRefund: 70,
      items: [],
      cancellable: true,
    });

    // ADMIN 应该能调通，不抛 Forbidden
    const r = await service.requestCancellation('ord1', undefined, {
      userId: 'admin-id',
      role: 'ADMIN',
      agentId: undefined,
    });
    expect(r.isNew).toBe(false);
  });

  it('客户取消自己的订单（happy 权限路径）→ 不抛 Forbidden', async () => {
    const existingRefund = { id: 'ref-1', status: 'REQUESTED', amount: '100' };

    mockPrisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord1',
      userId: 'me',
      agentId: null,
      refunds: [existingRefund],
    });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce(
      fakeFullOrder({ refunds: [existingRefund] }),
    );
    mockComputeQuote.mockResolvedValue({
      orderId: 'ord1',
      orderNumber: 'ORD-001',
      paidAmount: 100,
      totalFee: 30,
      totalRefund: 70,
      items: [],
      cancellable: true,
    });

    const r = await service.requestCancellation('ord1', '不去了', {
      userId: 'me',
      role: 'CUSTOMER',
      agentId: undefined,
    });
    expect(r.isNew).toBe(false);
    expect(r.order).toBeDefined();
    expect(r.quote.totalRefund).toBe(70);
  });
});
