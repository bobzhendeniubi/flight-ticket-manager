/**
 * OrderService.swapRefund · 服务级测试（vitest）
 *
 * 用可控的事务 fixture 覆盖换人退款的金额、状态、替代订单校验与权限闸门。
 * 资金只允许留在源订单：测试同时断言没有创建其它订单的 Payment，也没有写入其它订单的 paidAmount。
 * 真 DB 的落库、座位释放与迁移验证见 orders.swap-refund.integration.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus, Prisma, RefundStatus, UserRole } from '@prisma/client';

const { mockPrisma, mockTx, mockEnqueueWaitlistCheck, mockCancelSeatHoldRelease } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    refund: {
      count: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    order: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    orderStatusEvent: { create: vi.fn() },
    payment: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return {
    mockTx: tx,
    mockPrisma: {
      ...tx,
      $transaction: vi.fn(async (fn: (transaction: typeof tx) => unknown) => fn(tx)),
    },
    mockEnqueueWaitlistCheck: vi.fn(),
    mockCancelSeatHoldRelease: vi.fn(),
  };
});

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../lib/cancellation.js', () => ({
  CANCELLABLE_STATUSES: new Set([
    OrderStatus.PAID,
    OrderStatus.PROCESSING,
    OrderStatus.TICKETED,
    OrderStatus.CHANGE_REQUESTED,
    OrderStatus.CHANGED,
    OrderStatus.FAILED,
  ]),
}));
vi.mock('../../queues/queue.js', () => ({
  enqueueWaitlistCheck: mockEnqueueWaitlistCheck,
  cancelSeatHoldRelease: mockCancelSeatHoldRelease,
}));
vi.mock('../hotel-control/hotel-control.service.js', () => ({
  getHotelNightlyRemaining: vi.fn(),
  getHotelOversellCapRooms: vi.fn(async () => 3),
}));
vi.mock('../settlement-discounts/settlement-discounts.service.js', () => ({
  resolveAgentSettlementDiscount: vi.fn(),
  resolveRetailSettlementDiscount: vi.fn(),
}));
vi.mock('../settlement-rates/settlement-rates.service.js', () => ({
  getSettlementRate: vi.fn(),
}));

import { OrderService } from './orders.service.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const STAFF = { userId: 'staff-1', role: UserRole.STAFF } as const;
const AGENT = { userId: 'agent-1', role: UserRole.AGENT } as const;

const dec = (value: number) => new Prisma.Decimal(value);

function fullOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-a',
    orderNumber: 'ORDER-A',
    userId: 'customer-a',
    agentId: null,
    status: OrderStatus.REFUND_REQUESTED,
    subtotal: dec(1000),
    taxesAndFees: dec(0),
    discountTotal: dec(0),
    total: dec(1000),
    paidAmount: dec(1000),
    prepaymentOffset: dec(0),
    adjustmentCny: 0,
    currency: 'CNY',
    contactName: '测试客户',
    contactPhone: '13800000000',
    contactEmail: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [],
    passengers: [],
    payments: [],
    refunds: [],
    statusEvents: [],
    agent: null,
    user: { id: 'customer-a', displayName: null, email: null },
    internalNotes: '已有备注',
    swapRefundedAt: new Date(),
    swapFeeCny: 450,
    swapReplacementOrderNumber: 'ORDER-B',
    ...overrides,
  };
}

function prepareFixture(options?: {
  status?: OrderStatus;
  paidAmount?: number;
  completedRefundAmount?: number;
  deletedAt?: Date | null;
  existingReplacement?: { id: string; deletedAt: Date | null } | null;
  pendingRefundCount?: number;
}) {
  mockTx.refund.count.mockReset();
  mockTx.$queryRaw.mockResolvedValue([
    {
      id: 'order-a',
      orderNumber: 'ORDER-A',
      paidAmount: dec(options?.paidAmount ?? 1000),
      status: options?.status ?? OrderStatus.PAID,
      deletedAt: options?.deletedAt ?? null,
      internalNotes: '已有备注',
      swapReplacementOrderNumber: null,
    },
  ]);
  const pendingRefundCount = options?.pendingRefundCount ?? 0;
  mockTx.refund.count.mockResolvedValueOnce(pendingRefundCount).mockResolvedValue(1);
  mockTx.refund.aggregate.mockResolvedValue({
    _sum: { amount: dec(options?.completedRefundAmount ?? 0) },
  });
  mockTx.refund.create.mockResolvedValue({ id: 'refund-a', status: RefundStatus.REQUESTED });
  const sourceOrder = fullOrder({ status: options?.status ?? OrderStatus.PAID, items: [], deletedAt: null });
  mockTx.order.findUnique.mockImplementation(async (args: { where?: { id?: string; orderNumber?: string } }) => {
    if (args.where?.id === 'order-a') return sourceOrder;
    return options && 'existingReplacement' in options
      ? options.existingReplacement
      : { id: 'order-b', deletedAt: null };
  });
  mockTx.order.updateMany.mockResolvedValue({ count: 1 });
  mockTx.orderStatusEvent.create.mockResolvedValue({});
  mockTx.order.update.mockResolvedValue({});
  mockTx.order.findUniqueOrThrow.mockResolvedValue(fullOrder());
  mockTx.refund.findMany.mockResolvedValue([]);
  mockTx.refund.updateMany.mockResolvedValue({ count: 1 });
  mockEnqueueWaitlistCheck.mockResolvedValue(undefined);
  mockCancelSeatHoldRelease.mockResolvedValue(undefined);
}

async function runSwap(input?: Partial<{ swapFeeCny: number; replacementOrderNumber?: string; reason: string }>) {
  return service.swapRefund(
    'order-a',
    {
      swapFeeCny: 450,
      replacementOrderNumber: 'ORDER-B',
      reason: '客人临时无法出行',
      ...input,
    },
    ADMIN,
  );
}

describe('OrderService.swapRefund', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prepareFixture();
  });

  it('正常换人退款：净收 1000、换人费 450 → 建 550 退款申请并写入三个标记', async () => {
    const finalOrder = fullOrder();
    const updateStatusSpy = vi
      .spyOn(service, '_updateStatusWithinTx')
      .mockImplementation(async (...args) => {
        args[7]?.push('seat-class-a');
        return finalOrder as never;
      });
    mockTx.order.findUniqueOrThrow.mockResolvedValue(finalOrder);

    const result = await runSwap();

    expect(result.refundAmountCny).toBe(550);
    expect(result.netPaidCny).toBe(1000);
    expect(result.refundId).toBe('refund-a');
    expect(mockTx.refund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-a',
        amount: dec(550),
        status: RefundStatus.REQUESTED,
        reason: '换人退款（换人费 ¥450，接手订单 ORDER-B）：客人临时无法出行',
        gatewayPayload: expect.objectContaining({
          swapRefund: true,
          swapFeeCny: 450,
          netPaidCny: 1000,
          refundAmountCny: 550,
          replacementOrderNumber: 'ORDER-B',
        }),
      }),
    });
    expect(mockTx.refund.create.mock.calls[0][0].data.gatewayPayload).not.toHaveProperty('quoteSnapshot');
    expect(mockTx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-a' },
      data: {
        swapRefundedAt: expect.any(Date),
        swapFeeCny: 450,
        swapReplacementOrderNumber: 'ORDER-B',
      },
    });
    expect(updateStatusSpy).toHaveBeenCalledWith(
      mockTx,
      'order-a',
      OrderStatus.REFUND_REQUESTED,
      ADMIN,
      '客人临时无法出行',
      expect.any(Array),
      undefined,
      expect.any(Array),
    );
    expect(mockEnqueueWaitlistCheck).toHaveBeenCalledWith('seat-class-a');
    expect(mockCancelSeatHoldRelease).toHaveBeenCalledWith('order-a');
    updateStatusSpy.mockRestore();
  });

  it('换人费为 0 → 全额退款', async () => {
    vi.spyOn(service, '_updateStatusWithinTx').mockResolvedValue(fullOrder() as never);
    const result = await runSwap({ swapFeeCny: 0, replacementOrderNumber: undefined });
    expect(result.refundAmountCny).toBe(1000);
  });

  it('换人费等于净收款 → 允许通过且应退 0', async () => {
    vi.spyOn(service, '_updateStatusWithinTx').mockResolvedValue(fullOrder() as never);
    const result = await runSwap({ swapFeeCny: 1000 });
    expect(result.refundAmountCny).toBe(0);
    expect(mockTx.refund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: dec(0) }),
    });
  });

  it('换人费超过净收款 → BadRequestError', async () => {
    await expect(runSwap({ swapFeeCny: 1001 })).rejects.toThrow(/超过净收款/);
    expect(mockTx.refund.create).not.toHaveBeenCalled();
  });

  it('换人费不是非负整数 → BadRequestError', async () => {
    await expect(runSwap({ swapFeeCny: 1.5 })).rejects.toThrow(/整数/);
    prepareFixture();
    await expect(runSwap({ swapFeeCny: -1 })).rejects.toThrow(/大于等于 0/);
    expect(mockTx.refund.create).not.toHaveBeenCalled();
  });

  it('净收款小于等于 0 → BadRequestError', async () => {
    prepareFixture({ paidAmount: 1000, completedRefundAmount: 1000 });
    await expect(runSwap()).rejects.toThrow(/没有可退的已收款/);
    expect(mockTx.refund.create).not.toHaveBeenCalled();
  });

  it('非占座态 / 回收站订单 → BadRequestError', async () => {
    prepareFixture({ status: OrderStatus.CANCELLED });
    await expect(runSwap()).rejects.toThrow(/仅占座中的有效订单可做换人退款/);

    prepareFixture({ deletedAt: new Date() });
    await expect(runSwap()).rejects.toThrow(/回收站/);
    expect(mockTx.refund.create).not.toHaveBeenCalled();
  });

  it('已有待处理退款申请 → ConflictError', async () => {
    prepareFixture({ pendingRefundCount: 1 });
    await expect(runSwap()).rejects.toThrow(/待处理退款申请/);
    expect(mockTx.refund.aggregate).not.toHaveBeenCalled();
  });

  it('替代订单不存在或已软删 → BadRequestError', async () => {
    prepareFixture({ existingReplacement: null });
    await expect(runSwap()).rejects.toThrow(/新订单号不存在/);

    prepareFixture({ existingReplacement: { id: 'order-b', deletedAt: new Date() } });
    await expect(runSwap()).rejects.toThrow(/新订单号不存在/);
  });

  it('替代订单号填成本单自己 → BadRequestError', async () => {
    prepareFixture({ existingReplacement: { id: 'order-a', deletedAt: null } });
    await expect(runSwap()).rejects.toThrow(/不能填本单自己/);
  });

  it('非 ADMIN/STAFF → ForbiddenError', async () => {
    await expect(
      service.swapRefund(
        'order-a',
        { swapFeeCny: 0, reason: '客人临时无法出行' },
        AGENT,
      ),
    ).rejects.toThrow('仅运营/管理员可做换人退款');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('不产生跨订单资金动作：替代订单只被查存在，不建 Payment、不改 paidAmount', async () => {
    await runSwap();

    expect(mockTx.payment.create).not.toHaveBeenCalled();
    expect(mockTx.payment.update).not.toHaveBeenCalled();
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    for (const call of mockTx.order.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty('paidAmount');
    }
    expect(mockTx.order.findUnique).toHaveBeenCalledWith({
      where: { orderNumber: 'ORDER-B' },
      select: { id: true, deletedAt: true },
    });
    expect(mockTx.order.update.mock.calls.every((call) => call[0].where.id === 'order-a')).toBe(true);
  });

  it('可以补填接手订单号：只更新源订单记录并校验目标订单存在', async () => {
    const result = await service.updateSwapReplacementOrderNumber('order-a', ' ORDER-B ', ADMIN);

    expect(result.replacementOrderNumber).toBe('ORDER-B');
    expect(result.beforeReplacementOrderNumber).toBeNull();
    expect(mockTx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-a' },
      data: { swapReplacementOrderNumber: 'ORDER-B' },
    });
    expect(mockTx.order.update.mock.calls.every((call) => call[0].where.id === 'order-a')).toBe(true);
    expect(mockTx.order.findUnique).toHaveBeenCalledWith({
      where: { orderNumber: 'ORDER-B' },
      select: { id: true, deletedAt: true },
    });
  });

  it('补填接手订单号不能填不存在的订单或本单', async () => {
    prepareFixture({ existingReplacement: null });
    await expect(service.updateSwapReplacementOrderNumber('order-a', 'ORDER-B', ADMIN)).rejects.toThrow(
      /新订单号不存在/,
    );

    prepareFixture({ existingReplacement: { id: 'order-a', deletedAt: null } });
    await expect(service.updateSwapReplacementOrderNumber('order-a', 'ORDER-A', ADMIN)).rejects.toThrow(
      /不能填本单自己/,
    );
  });

  it('补填接手订单号仅允许 ADMIN/STAFF', async () => {
    await expect(
      service.updateSwapReplacementOrderNumber('order-a', 'ORDER-B', AGENT),
    ).rejects.toThrow('仅运营/管理员可补填接手订单号');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('驳回换人退款 → 退款置 REJECTED 且同事务清空三个换人标记', async () => {
    const rejectedOrder = fullOrder({ status: OrderStatus.REFUND_REQUESTED, items: [] });
    mockTx.order.findUnique.mockResolvedValueOnce(rejectedOrder);
    mockTx.refund.findMany.mockResolvedValueOnce([{ gatewayPayload: { swapRefund: true } }]);
    mockTx.order.findUniqueOrThrow.mockResolvedValueOnce(fullOrder({ status: OrderStatus.PROCESSING }));

    await service._updateStatusWithinTx(
      mockTx as unknown as Prisma.TransactionClient,
      'order-a',
      OrderStatus.PROCESSING,
      ADMIN,
      '驳回换人退款',
      [],
    );

    expect(mockTx.refund.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'order-a', status: 'REQUESTED' },
      data: { status: 'REJECTED', processedAt: expect.any(Date) },
    });
    expect(mockTx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-a' },
      data: {
        swapRefundedAt: null,
        swapFeeCny: null,
        swapReplacementOrderNumber: null,
      },
    });
  });

  it('STAFF 也可以发起换人退款', async () => {
    vi.spyOn(service, '_updateStatusWithinTx').mockResolvedValue(fullOrder() as never);
    const result = await service.swapRefund(
      'order-a',
      { swapFeeCny: 0, reason: '运营处理' },
      STAFF,
    );
    expect(result.refundAmountCny).toBe(1000);
  });
});
