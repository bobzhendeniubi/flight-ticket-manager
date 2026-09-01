import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma, UserRole } from '@prisma/client';

const {
  mockPrisma,
  mockTx,
  mockOrderStatusUpdate,
  cancelSeatHoldReleaseMock,
  enqueueWaitlistCheckMock,
  writeAuditMock,
} = vi.hoisted(() => {
  const tx = {
    order: { findUnique: vi.fn(), update: vi.fn() },
    payment: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    refund: { count: vi.fn(), aggregate: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
    prepaymentTransaction: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  };
  return {
    mockPrisma: { $transaction: vi.fn() },
    mockTx: tx,
    mockOrderStatusUpdate: vi.fn(),
    cancelSeatHoldReleaseMock: vi.fn().mockResolvedValue(undefined),
    enqueueWaitlistCheckMock: vi.fn().mockResolvedValue(undefined),
    writeAuditMock: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../lib/audit.js', () => ({ writeAudit: writeAuditMock }));
vi.mock('../../queues/queue.js', () => ({
  cancelSeatHoldRelease: cancelSeatHoldReleaseMock,
  enqueueWaitlistCheck: enqueueWaitlistCheckMock,
}));
vi.mock('../orders/orders.service.js', () => ({
  OrderService: class {
    _updateStatusWithinTx = mockOrderStatusUpdate;
  },
  SEAT_HOLDING_STATUSES: [
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAID,
    OrderStatus.PROCESSING,
    OrderStatus.TICKETED,
    OrderStatus.COMPLETED,
    OrderStatus.CHANGE_REQUESTED,
    OrderStatus.CHANGED,
  ],
}));

import { BadRequestError, ConflictError, ForbiddenError } from '../../lib/errors.js';
import { PaymentsService } from './payments.service.js';

const ACTOR = { userId: 'staff-1', role: UserRole.STAFF };
const INPUT = {
  targetOrderNumber: 'ORD-TGT',
  transferFeeCny: 450,
  reason: '原旅客临时无法出行',
};

type ConfigureOptions = {
  sourceStatus?: OrderStatus;
  targetStatus?: OrderStatus;
  sourcePaidAmount?: number;
  sourceRefundedAmount?: number;
  targetPaidAmount?: number;
  targetRefundedAmount?: number;
  sourceDeletedAt?: Date | null;
  targetDeletedAt?: Date | null;
  sourcePaymentsLocked?: boolean;
  pendingRefundCount?: number;
  sourceInternalNotes?: string | null;
  targetInternalNotes?: string | null;
  targetId?: string;
  sourceMethod?: PaymentMethod | null;
  sourceOffset?: boolean;
};

function configure(options: ConfigureOptions = {}): void {
  const {
    sourceStatus = OrderStatus.PAID,
    targetStatus = OrderStatus.PAID,
    sourcePaidAmount = 5000,
    sourceRefundedAmount = 0,
    targetPaidAmount = 100,
    targetRefundedAmount = 0,
    sourceDeletedAt = null,
    targetDeletedAt = null,
    sourcePaymentsLocked = false,
    pendingRefundCount = 0,
    sourceInternalNotes = '已有备注',
    targetInternalNotes = null,
    targetId = 'order-target',
    sourceMethod = PaymentMethod.BANK_CARD,
    sourceOffset = false,
  } = options;

  mockTx.order.findUnique.mockResolvedValue({
    id: targetId,
    orderNumber: INPUT.targetOrderNumber,
    deletedAt: targetDeletedAt,
  });
  mockTx.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const id = args[1];
    // 前三次分别是两单加锁和 B 入账内核加锁；末尾两次是本操作要求的 paidAmount 真值重读。
    // mock 也要模拟「数据库已写入」的结果，避免用事务开始时的快照假装守恒。
    if (mockTx.$queryRaw.mock.calls.length > 3) {
      const transferredAmount = Number(
        mockTx.payment.create.mock.calls[0]?.[0]?.data?.amount ?? 0,
      );
      return [{
        id,
        paidAmount: new Prisma.Decimal(
          id === 'order-source' ? sourcePaidAmount : targetPaidAmount + transferredAmount,
        ),
      }];
    }
    if (id === 'order-source') {
      return [
        {
          id: 'order-source',
          orderNumber: 'ORD-SRC',
          total: new Prisma.Decimal(5000),
          adjustmentCny: 0,
          paidAmount: new Prisma.Decimal(sourcePaidAmount),
          prepaymentOffset: new Prisma.Decimal(0),
          status: sourceStatus,
          deletedAt: sourceDeletedAt,
          paymentsLocked: sourcePaymentsLocked,
          agentId: null,
          internalNotes: sourceInternalNotes,
        },
      ];
    }
    return [
      {
        id: targetId,
        orderNumber: INPUT.targetOrderNumber,
        total: new Prisma.Decimal(10000),
        adjustmentCny: 0,
        paidAmount: new Prisma.Decimal(targetPaidAmount),
        prepaymentOffset: new Prisma.Decimal(0),
        status: targetStatus,
        deletedAt: targetDeletedAt,
        paymentsLocked: false,
        agentId: null,
        internalNotes: targetInternalNotes,
      },
    ];
  });
  mockTx.refund.count.mockResolvedValue(pendingRefundCount);
  mockTx.refund.aggregate.mockImplementation(async (args: { where: { orderId: string } }) => ({
    _sum: {
      amount: new Prisma.Decimal(
        args.where.orderId === 'order-source'
          ? sourceRefundedAmount +
            (mockTx.refund.create.mock.calls.length > 0
              ? Number(mockTx.refund.create.mock.calls[0][0].data.amount)
              : 0)
          : targetRefundedAmount,
      ),
    },
  }));
  mockTx.refund.create.mockResolvedValue({ id: 'refund-swap' });
  mockTx.refund.findUnique.mockResolvedValue({ status: 'COMPLETED' });
  mockTx.prepaymentTransaction.findFirst.mockResolvedValue(
    sourceOffset ? { id: 'offset-1' } : null,
  );
  mockTx.payment.findFirst.mockResolvedValue(
    sourceMethod === null ? null : { method: sourceMethod },
  );
  mockTx.payment.create.mockResolvedValue({ id: 'payment-target' });
  mockTx.payment.updateMany.mockResolvedValue({ count: 1 });
  mockTx.order.update.mockResolvedValue({});

  mockOrderStatusUpdate.mockImplementation(
    async (
      _tx: unknown,
      _orderId: string,
      toStatus: OrderStatus,
      _actor: unknown,
      _reason: string,
      _taskIds: string[],
      _force?: boolean,
      releasedSeatClassIds?: string[],
    ) => {
      if (toStatus === OrderStatus.REFUND_REQUESTED) {
        releasedSeatClassIds?.push('seat-class-1');
      }
      return {};
    },
  );
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  );
}

describe('PaymentsService.swapTransfer · 订单间转款与换人费', () => {
  const service = new PaymentsService();

  beforeEach(() => {
    vi.clearAllMocks();
    configure();
  });

  it('正常转出：源单留存换人费、目标单入账余额、源 Payment 不变且座位释放', async () => {
    const result = await service.swapTransfer('order-source', INPUT, ACTOR);

    expect(result).toEqual({
      sourceOrder: {
        id: 'order-source',
        orderNumber: 'ORD-SRC',
        paidAmount: 5000,
        netPaidAmount: 450,
        status: OrderStatus.REFUNDED,
      },
      targetOrder: {
        id: 'order-target',
        orderNumber: 'ORD-TGT',
        paidAmount: 4650,
        status: OrderStatus.PAID,
      },
      transferFeeCny: 450,
      transferredAmount: 4550,
      refundId: 'refund-swap',
      newPaymentId: 'payment-target',
    });

    expect(mockTx.refund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-source',
        amount: new Prisma.Decimal(4550),
        status: 'REQUESTED',
        reason: expect.stringContaining('请勿再打款'),
        gatewayPayload: expect.objectContaining({
          swapTransfer: true,
          nonCashRefund: true,
          transferredToOrderId: 'order-target',
          transferFeeCny: 450,
          transferredAmount: 4550,
        }),
      }),
    });
    expect(mockTx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-target',
        method: PaymentMethod.BANK_CARD,
        amount: new Prisma.Decimal(4550),
        status: PaymentStatus.SUCCEEDED,
        gatewayPayload: expect.objectContaining({
          swapTransfer: true,
          transferredIn: true,
          transferredFromOrderId: 'order-source',
          refundId: 'refund-swap',
        }),
      }),
    });
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(
      mockTx.order.update.mock.calls.some(
        (call) =>
          call[0].where?.id === 'order-source' && 'paidAmount' in (call[0].data ?? {}),
      ),
    ).toBe(false);
    expect(mockOrderStatusUpdate).toHaveBeenCalledTimes(2);
    expect(cancelSeatHoldReleaseMock).toHaveBeenCalledWith('order-source');
    expect(enqueueWaitlistCheckMock).toHaveBeenCalledWith('seat-class-1');
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SWAP_TRANSFER_ORDER',
        targetId: 'order-source',
        before: { status: OrderStatus.PAID, netPaidAmount: 5000 },
        after: expect.objectContaining({
          targetOrderNumber: 'ORD-TGT',
          transferFeeCny: 450,
          transferredAmount: 4550,
          status: OrderStatus.REFUNDED,
        }),
        severity: 'WARNING',
      }),
    );
  });

  it('换人费为 0 时全额转出', async () => {
    const result = await service.swapTransfer(
      'order-source',
      { ...INPUT, transferFeeCny: 0 },
      ACTOR,
    );

    expect(result.transferredAmount).toBe(5000);
    expect(result.sourceOrder.netPaidAmount).toBe(0);
    expect(result.targetOrder.paidAmount).toBe(5100);
  });

  it('换人费超过净收款时拒绝', async () => {
    await expect(
      service.swapTransfer('order-source', { ...INPUT, transferFeeCny: 5001 }, ACTOR),
    ).rejects.toThrow(BadRequestError);
    expect(mockTx.refund.create).not.toHaveBeenCalled();
    expect(mockTx.payment.create).not.toHaveBeenCalled();
  });

  it('换人费等于净收款时拒绝无余额转出', async () => {
    await expect(
      service.swapTransfer('order-source', { ...INPUT, transferFeeCny: 5000 }, ACTOR),
    ).rejects.toThrow('没有可转出的余额');
  });

  it.each([OrderStatus.CANCELLED, OrderStatus.REFUNDED])(
    '源单状态为 %s 时拒绝',
    async (sourceStatus) => {
      configure({ sourceStatus });
      await expect(
        service.swapTransfer('order-source', INPUT, ACTOR),
      ).rejects.toThrow(BadRequestError);
    },
  );

  it('源单在回收站时拒绝', async () => {
    configure({ sourceDeletedAt: new Date('2026-08-31T00:00:00.000Z') });

    await expect(service.swapTransfer('order-source', INPUT, ACTOR)).rejects.toThrow(
      '订单在回收站（已软删）',
    );
  });

  it('目标单已取消时拒绝', async () => {
    configure({ targetStatus: OrderStatus.CANCELLED });

    await expect(service.swapTransfer('order-source', INPUT, ACTOR)).rejects.toThrow(
      '已取消/已退款/已失效',
    );
  });

  it('目标单就是源单时拒绝', async () => {
    configure({ targetId: 'order-source' });

    await expect(service.swapTransfer('order-source', INPUT, ACTOR)).rejects.toThrow(
      '不能转到同一张订单',
    );
  });

  it('源单有待处理退款申请时拒绝', async () => {
    configure({ pendingRefundCount: 1 });

    await expect(service.swapTransfer('order-source', INPUT, ACTOR)).rejects.toThrow(
      ConflictError,
    );
  });

  it('源单收款已锁定时拒绝', async () => {
    configure({ sourcePaymentsLocked: true });

    await expect(service.swapTransfer('order-source', INPUT, ACTOR)).rejects.toThrow(
      '收款已锁定',
    );
  });

  it('源单用过代理预存余额抵扣时拒绝', async () => {
    configure({ sourceOffset: true });

    await expect(service.swapTransfer('order-source', INPUT, ACTOR)).rejects.toThrow(
      '用过代理预存余额抵扣',
    );
  });

  it('非 ADMIN/STAFF 角色被拒绝且不启动事务', async () => {
    await expect(
      service.swapTransfer('order-source', INPUT, { userId: 'agent-1', role: UserRole.AGENT }),
    ).rejects.toThrow(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('按净收款校验守恒：源单已完成退款时仍只转出净收款', async () => {
    configure({ sourcePaidAmount: 5000, sourceRefundedAmount: 500 });

    const result = await service.swapTransfer(
      'order-source',
      { ...INPUT, transferFeeCny: 450 },
      ACTOR,
    );

    expect(result.transferredAmount).toBe(4050);
    expect(result.sourceOrder.netPaidAmount).toBe(450);
    expect(result.targetOrder.paidAmount).toBe(4150);
    expect(toCents(5000 - 500 + 100)).toBe(
      toCents(result.sourceOrder.netPaidAmount + result.targetOrder.paidAmount),
    );
  });
});

function toCents(amount: number): number {
  return Math.round(amount * 100);
}
