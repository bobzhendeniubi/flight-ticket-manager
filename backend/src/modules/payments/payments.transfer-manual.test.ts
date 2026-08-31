import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommissionStatus, OrderStatus, PaymentMethod, PaymentStatus, Prisma, UserRole } from '@prisma/client';

const { mockPrisma, mockTx, writeAuditMock } = vi.hoisted(() => {
  const tx = {
    payment: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    order: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    receiptAllocation: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    holdConversionRecord: { findFirst: vi.fn() },
    refund: { aggregate: vi.fn() },
    commissionRecord: { aggregate: vi.fn(), groupBy: vi.fn() },
    $queryRaw: vi.fn(),
  };
  return {
    mockPrisma: { $transaction: vi.fn() },
    mockTx: tx,
    writeAuditMock: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../lib/audit.js', () => ({ writeAudit: writeAuditMock }));

import { BadRequestError, ConflictError } from '../../lib/errors.js';
import { PaymentsService } from './payments.service.js';

const ACTOR = { userId: 'staff-1', role: UserRole.STAFF };
const PAID_AT = new Date('2026-08-30T09:00:00.000Z');
const VERIFIED_AT = new Date('2026-08-30T09:05:00.000Z');

function configure({
  sourceStatus = OrderStatus.PAID,
  targetStatus = OrderStatus.PAID,
  sourcePaidAmount = 500,
  targetPaidAmount = 100,
  sourceAmount = 300,
  sourceMethod = PaymentMethod.BANK_CARD,
  targetTotal = 1000,
  targetOrderNumber = 'ORD-TGT',
  commissionAmount = 0,
  casCount = 1,
  paymentStatus = PaymentStatus.SUCCEEDED,
  sourceDeletedAt = null,
  targetDeletedAt = null,
  sourceGatewayPayload = { manual: true, note: '线下转账' },
}: {
  sourceStatus?: OrderStatus;
  targetStatus?: OrderStatus;
  sourcePaidAmount?: number;
  targetPaidAmount?: number;
  sourceAmount?: number;
  sourceMethod?: PaymentMethod;
  targetTotal?: number;
  targetOrderNumber?: string;
  commissionAmount?: number;
  casCount?: number;
  paymentStatus?: PaymentStatus;
  sourceDeletedAt?: Date | null;
  targetDeletedAt?: Date | null;
  sourceGatewayPayload?: Record<string, unknown>;
} = {}) {
  mockTx.payment.findUnique.mockResolvedValue({
    id: 'payment-source',
    orderId: 'order-source',
    method: sourceMethod,
    amount: new Prisma.Decimal(sourceAmount),
    status: paymentStatus,
    paidAt: PAID_AT,
    verifiedAt: VERIFIED_AT,
    verifiedById: 'finance-1',
    proofUrl: 'data:image/png;base64,proof',
    gatewayPayload: sourceGatewayPayload,
    order: {
      id: 'order-source',
      orderNumber: 'ORD-SRC',
      status: sourceStatus,
      deletedAt: sourceDeletedAt,
    },
  });
  mockTx.order.findUnique.mockResolvedValue({
    id: 'order-target',
    orderNumber: targetOrderNumber,
    status: targetStatus,
    deletedAt: targetDeletedAt,
  });
  mockTx.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const id = args[1];
    if (id === 'payment-source') {
      return [{
        id: 'payment-source',
        orderId: 'order-source',
        method: sourceMethod,
        amount: new Prisma.Decimal(sourceAmount),
        status: paymentStatus,
        paidAt: PAID_AT,
        verifiedAt: VERIFIED_AT,
        verifiedById: 'finance-1',
        proofUrl: 'data:image/png;base64,proof',
        gatewayPayload: sourceGatewayPayload,
      }];
    }
    if (id === 'order-source') {
      return [{
        id: 'order-source',
        orderNumber: 'ORD-SRC',
        total: new Prisma.Decimal(1000),
        adjustmentCny: 0,
        paidAmount: new Prisma.Decimal(sourcePaidAmount),
        prepaymentOffset: new Prisma.Decimal(0),
        status: sourceStatus,
        deletedAt: sourceDeletedAt,
        paymentsLocked: false,
      }];
    }
    return [{
      id: 'order-target',
      orderNumber: targetOrderNumber,
      total: new Prisma.Decimal(targetTotal),
      adjustmentCny: 0,
      paidAmount: new Prisma.Decimal(targetPaidAmount),
      prepaymentOffset: new Prisma.Decimal(0),
      status: targetStatus,
      deletedAt: targetDeletedAt,
      paymentsLocked: false,
    }];
  });
  mockTx.receiptAllocation.findUnique.mockResolvedValue(null);
  mockTx.receiptAllocation.findMany.mockResolvedValue([]);
  mockTx.holdConversionRecord.findFirst.mockResolvedValue(null);
  mockTx.refund.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } });
  mockTx.commissionRecord.aggregate.mockResolvedValue({
    _sum: { amount: commissionAmount === 0 ? null : new Prisma.Decimal(commissionAmount) },
  });
  // 佣金闸走 lib/commission-net 的按代理分组净额：0 = 无存活佣金（空分组），
  // 非 0 = 单代理一组正净额。
  mockTx.commissionRecord.groupBy.mockResolvedValue(
    commissionAmount === 0
      ? []
      : [{ agentId: 'agent-1', _sum: { amount: new Prisma.Decimal(commissionAmount) } }],
  );
  mockTx.payment.updateMany.mockResolvedValue({ count: casCount });
  mockTx.payment.create.mockResolvedValue({ id: 'payment-target' });
  mockTx.order.update.mockResolvedValue({});
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => unknown) => fn(mockTx));
}

describe('PaymentsService.transferManualPayment · 收款整笔转移', () => {
  const service = new PaymentsService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功转移：源单减、目标单加、金额守恒且双侧互链留痕', async () => {
    configure({
      sourceGatewayPayload: {
        manual: true,
        note: '线下转账',
        confirmedBy: 'ops-2',
        internalOnly: 'must-not-copy',
      },
    });

    const result = await service.transferManualPayment(
      'payment-source',
      { targetOrderNumber: 'ORD-TGT', reason: '换人后归属新单' },
      ACTOR,
    );

    expect(result).toEqual({
      paymentId: 'payment-source',
      sourceOrder: { id: 'order-source', orderNumber: 'ORD-SRC', paidAmount: 200 },
      targetOrder: { id: 'order-target', orderNumber: 'ORD-TGT', paidAmount: 400 },
      newPaymentId: 'payment-target',
      amount: 300,
    });
    expect(mockTx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'payment-source', status: PaymentStatus.SUCCEEDED },
      data: expect.objectContaining({
        status: PaymentStatus.REFUNDED,
        gatewayPayload: expect.objectContaining({
          transferredOut: true,
          transferredToOrderId: 'order-target',
          transferredToOrderNumber: 'ORD-TGT',
          transferReason: '换人后归属新单',
          transferredBy: 'staff-1',
        }),
      }),
    }));
    expect(mockTx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-source' },
      data: { paidAmount: new Prisma.Decimal(200) },
    });
    expect(mockTx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-target',
        method: PaymentMethod.BANK_CARD,
        amount: new Prisma.Decimal(300),
        status: PaymentStatus.SUCCEEDED,
        paidAt: PAID_AT,
        verifiedAt: VERIFIED_AT,
        verifiedById: 'finance-1',
        gatewayPayload: expect.objectContaining({
          manual: true,
          note: '线下转账',
          confirmedBy: 'ops-2',
          transferredIn: true,
          transferredFromOrderId: 'order-source',
          transferredFromOrderNumber: 'ORD-SRC',
          sourcePaymentId: 'payment-source',
          transferReason: '换人后归属新单',
          transferredBy: 'staff-1',
        }),
      }),
    });
    const targetPayload = mockTx.payment.create.mock.calls[0][0].data.gatewayPayload;
    expect(targetPayload).not.toHaveProperty('internalOnly');
    expect(writeAuditMock).toHaveBeenCalledTimes(2);
    expect(writeAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'TRANSFER_PAYMENT_OUT',
      targetId: 'order-source',
      after: expect.objectContaining({ newPaymentId: 'payment-target', targetOrderNumber: 'ORD-TGT' }),
    }));
    expect(writeAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'TRANSFER_PAYMENT_IN',
      targetId: 'order-target',
      after: expect.objectContaining({ sourcePaymentId: 'payment-source', sourceOrderNumber: 'ORD-SRC' }),
    }));
  });

  it('目标单取消时拒绝且不写源侧账目', async () => {
    configure({ targetStatus: OrderStatus.CANCELLED });

    await expect(
      service.transferManualPayment('payment-source', { targetOrderNumber: 'ORD-TGT', reason: '换人归属调整' }, ACTOR),
    ).rejects.toThrow('不能把收款转移到已取消/已退款/已失效的订单');
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.payment.create).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it('对账认款转移同步认领明细归属，避免对账台仍显示旧单', async () => {
    configure({
      sourceGatewayPayload: {
        source: 'reconciliation',
        receiptNo: 'RCP-1',
        allocationId: 'allocation-1',
      },
    });
    mockTx.receiptAllocation.findUnique.mockResolvedValue({
      id: 'allocation-1',
      orderId: 'order-source',
      amountCny: new Prisma.Decimal(300),
      receipt: { receiptNo: 'RCP-1', externalTxnId: 'TX-1' },
    });

    await service.transferManualPayment(
      'payment-source',
      { targetOrderNumber: 'ORD-TGT', reason: '对账认款归属调整' },
      ACTOR,
    );

    expect(mockTx.receiptAllocation.update).toHaveBeenCalledWith({
      where: { id: 'allocation-1' },
      data: { orderId: 'order-target' },
    });
    expect(mockTx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        gatewayPayload: expect.objectContaining({
          source: 'reconciliation',
          receiptNo: 'RCP-1',
          externalTxnId: 'TX-1',
          allocationId: 'allocation-1',
          transferredIn: true,
        }),
      }),
    });
  });

  it('源单退款流程中时拒绝且不写账', async () => {
    configure({ sourceStatus: OrderStatus.REFUND_REQUESTED });

    await expect(
      service.transferManualPayment('payment-source', { targetOrderNumber: 'ORD-TGT', reason: '退款流程中调整' }, ACTOR),
    ).rejects.toThrow(/不能转移收款.*退款流程/);
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.payment.create).not.toHaveBeenCalled();
  });

  it('代理预存款收款拒绝转移并提示走预存款流程', async () => {
    configure({ sourceMethod: PaymentMethod.AGENT_PREPAYMENT });

    await expect(
      service.transferManualPayment('payment-source', { targetOrderNumber: 'ORD-TGT', reason: '预存款误转保护' }, ACTOR),
    ).rejects.toThrow(/代理预存款有独立资金账本.*预存款流程/);
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.payment.create).not.toHaveBeenCalled();
  });

  it('占位单结转款拒绝转移', async () => {
    configure();
    mockTx.holdConversionRecord.findFirst.mockResolvedValue({
      holdOrder: { holdNo: 'HOLD-1' },
    });

    await expect(
      service.transferManualPayment('payment-source', { targetOrderNumber: 'ORD-TGT', reason: '占位结转误转保护' }, ACTOR),
    ).rejects.toThrow(/占位单 HOLD-1 的结转款.*不能直接转移/);
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.payment.create).not.toHaveBeenCalled();
  });

  it('历史对账认款匹配到多条 Allocation 时 fail-closed', async () => {
    configure({
      sourceGatewayPayload: { source: 'reconciliation', receiptNo: 'RCP-MULTI' },
    });
    mockTx.receiptAllocation.findMany.mockResolvedValue([
      {
        id: 'allocation-1',
        orderId: 'order-source',
        amountCny: new Prisma.Decimal(300),
        receipt: { receiptNo: 'RCP-MULTI', externalTxnId: 'TX-1' },
      },
      {
        id: 'allocation-2',
        orderId: 'order-source',
        amountCny: new Prisma.Decimal(300),
        receipt: { receiptNo: 'RCP-MULTI', externalTxnId: 'TX-1' },
      },
    ]);

    await expect(
      service.transferManualPayment('payment-source', { targetOrderNumber: 'ORD-TGT', reason: '多条认款明细保护' }, ACTOR),
    ).rejects.toThrow(/缺失、重复或金额不一致.*收款对账台/);
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.payment.create).not.toHaveBeenCalled();
  });

  it('源单仍有净佣金时拒绝', async () => {
    configure({ commissionAmount: 120 });

    await expect(
      service.transferManualPayment('payment-source', { targetOrderNumber: 'ORD-TGT', reason: '佣金未冲销调整' }, ACTOR),
    ).rejects.toThrow(/已计提代理佣金/);
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.payment.create).not.toHaveBeenCalled();
  });

  it('正数 REVERSED 死行按净佣金口径剔除后允许转移', async () => {
    configure({ commissionAmount: 0 });

    await expect(
      service.transferManualPayment('payment-source', { targetOrderNumber: 'ORD-TGT', reason: '佣金翻牌后转移' }, ACTOR),
    ).resolves.toMatchObject({ newPaymentId: 'payment-target' });
    expect(mockTx.commissionRecord.groupBy).toHaveBeenCalledWith({
      by: ['agentId'],
      where: {
        orderId: 'order-source',
        OR: [
          { status: { not: CommissionStatus.REVERSED } },
          { amount: { lt: 0 } },
        ],
      },
      _sum: { amount: true },
    });
  });

  it('CAS 未获胜时按并发冲突拒绝', async () => {
    configure({ casCount: 0 });

    await expect(
      service.transferManualPayment('payment-source', { targetOrderNumber: 'ORD-TGT', reason: '并发转移保护' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockTx.order.update).not.toHaveBeenCalled();
    expect(mockTx.payment.create).not.toHaveBeenCalled();
  });

  it('转移到同一张订单时拒绝', async () => {
    configure({ targetOrderNumber: 'ORD-SRC' });
    mockTx.order.findUnique.mockResolvedValue({
      id: 'order-source',
      orderNumber: 'ORD-SRC',
      status: OrderStatus.PAID,
      deletedAt: null,
    });

    await expect(
      service.transferManualPayment('payment-source', { targetOrderNumber: 'ORD-SRC', reason: '误选同单调整' }, ACTOR),
    ).rejects.toThrow('不能转移到同一张订单');
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.payment.create).not.toHaveBeenCalled();
  });

  it('目标单超收时沿用入账拒绝，并提示先调整目标单价格', async () => {
    configure({ targetPaidAmount: 800, targetTotal: 1000 });

    await expect(
      service.transferManualPayment('payment-source', { targetOrderNumber: 'ORD-TGT', reason: '新单金额尚未调整' }, ACTOR),
    ).rejects.toThrow(/先调整目标单价格再转移/);
    // 真实事务会回滚；这里至少确认目标入账内核拒绝了创建新 Payment。
    expect(mockTx.payment.create).not.toHaveBeenCalled();
  });

  it('非 SUCCEEDED 收款按转移专用 400 文案拒绝', async () => {
    configure({ paymentStatus: PaymentStatus.REFUNDED });

    await expect(
      service.transferManualPayment('payment-source', { targetOrderNumber: 'ORD-TGT', reason: '重复转移保护' }, ACTOR),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: '该笔收款不可转移（仅已成功的收款可转移）',
    });
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
  });
});
