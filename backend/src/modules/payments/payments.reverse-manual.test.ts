import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus, PaymentStatus, Prisma, UserRole } from '@prisma/client';

const { mockPrisma, mockTx, writeAuditMock } = vi.hoisted(() => {
  const tx = {
    payment: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    holdConversionRecord: {
      findFirst: vi.fn(),
    },
    order: {
      update: vi.fn(),
    },
    commissionRecord: {
      groupBy: vi.fn(),
    },
    refund: {
      aggregate: vi.fn(),
    },
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

import { ConflictError, BadRequestError } from '../../lib/errors.js';
import { PaymentsService } from './payments.service.js';

const ACTOR = { userId: 'user-1', role: UserRole.STAFF };

function configure({
  payload,
  order = {},
  refundedTotal = 0,
  casCount = 1,
  paymentStatus = PaymentStatus.SUCCEEDED,
  commissionGroups = [],
}: {
  payload: unknown;
  order?: Partial<{
    status: OrderStatus;
    paidAmount: number;
    total: number;
    adjustmentCny: number;
    prepaymentOffset: number;
    paymentsLocked: boolean;
    deletedAt: Date | null;
  }>;
  refundedTotal?: number;
  casCount?: number;
  paymentStatus?: PaymentStatus;
  commissionGroups?: Array<{ agentId: string; amount: number }>;
}) {
  mockTx.payment.findUnique.mockResolvedValue({
    id: 'payment-1',
    orderId: 'order-1',
    amount: new Prisma.Decimal(300),
    status: paymentStatus,
    gatewayPayload: payload,
  });
  mockTx.holdConversionRecord.findFirst.mockResolvedValue(null);
  mockTx.$queryRaw.mockResolvedValue([
    {
      id: 'order-1',
      orderNumber: 'ORD-1',
      total: new Prisma.Decimal(order.total ?? 1000),
      adjustmentCny: order.adjustmentCny ?? 0,
      paidAmount: new Prisma.Decimal(order.paidAmount ?? 500),
      prepaymentOffset: new Prisma.Decimal(order.prepaymentOffset ?? 0),
      status: order.status ?? OrderStatus.PAID,
      deletedAt: order.deletedAt ?? null,
      paymentsLocked: order.paymentsLocked ?? false,
    },
  ]);
  mockTx.refund.aggregate.mockResolvedValue({
    _sum: { amount: new Prisma.Decimal(refundedTotal) },
  });
  mockTx.commissionRecord.groupBy.mockResolvedValue(
    commissionGroups.map((group) => ({
      agentId: group.agentId,
      _sum: { amount: new Prisma.Decimal(group.amount) },
    })),
  );
  mockTx.payment.updateMany.mockResolvedValue({ count: casCount });
  mockTx.order.update.mockResolvedValue({});
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => unknown) => fn(mockTx));
}

describe('PaymentsService.reverseManualPayment · 手工收款冲销', () => {
  const service = new PaymentsService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('占位单结转款禁止从订单侧冲销', async () => {
    configure({ payload: { manual: true, note: '占位单结转' } });
    mockTx.holdConversionRecord.findFirst.mockResolvedValueOnce({ holdOrder: { holdNo: 'H20260824AB12' } });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '误操作' }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('需回占位单侧处理') });
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it('纯手工收款冲销成功：Payment 置 REFUNDED、订单已付减回并写审计', async () => {
    configure({ payload: { manual: true, note: '线下转账', confirmedBy: 'user-1' } });

    const result = await service.reverseManualPayment('payment-1', { reason: '录入金额错误' }, ACTOR);

    expect(result.ok).toBe(true);
    expect(result.reversedAmount).toBe(300);
    expect(result.order.paidAmount).toBe(200);
    expect(result.order.balanceDue).toBe(800);
    expect(result.order.status).toBe(OrderStatus.PAID);
    expect(mockTx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'payment-1', status: PaymentStatus.SUCCEEDED },
        data: expect.objectContaining({ status: PaymentStatus.REFUNDED }),
      }),
    );
    expect(mockTx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { paidAmount: new Prisma.Decimal(200) },
    });
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'REVERSE_MANUAL_PAYMENT',
        before: { paidAmount: 500 },
        after: expect.objectContaining({
          paymentId: 'payment-1',
          reversedAmount: 300,
          reason: '录入金额错误',
          orderPaidAmount: 200,
        }),
        severity: 'CRITICAL',
      }),
    );
  });

  it('同一代理 SETTLED 正数加 REVERSED 负数补偿抵平时正常冲销', async () => {
    configure({
      payload: { manual: true },
      commissionGroups: [{ agentId: 'agent-a', amount: 0 }],
    });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '佣金已冲平' }, ACTOR),
    ).resolves.toMatchObject({ ok: true, reversedAmount: 300 });
  });

  it('代理A 有存活佣金、代理B 有孤立负数时仍拒绝冲销', async () => {
    configure({
      payload: { manual: true },
      commissionGroups: [
        { agentId: 'agent-a', amount: 50 },
        { agentId: 'agent-b', amount: -50 },
      ],
    });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '跨代理不能抵消' }, ACTOR),
    ).rejects.toThrow(/已计提代理佣金 ¥50\.00/);
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it('只有孤立负数 REVERSED 行时正常冲销', async () => {
    configure({
      payload: { manual: true },
      commissionGroups: [{ agentId: 'agent-b', amount: -50 }],
    });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '仅有负数补偿' }, ACTOR),
    ).resolves.toMatchObject({ ok: true, reversedAmount: 300 });
  });

  it('ACCRUED 翻牌为 REVERSED 后正数被剔除，正常冲销', async () => {
    configure({ payload: { manual: true }, commissionGroups: [] });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '佣金已翻牌冲销' }, ACTOR),
    ).resolves.toMatchObject({ ok: true, reversedAmount: 300 });

    expect(mockTx.commissionRecord.groupBy).toHaveBeenCalledWith({
      by: ['agentId'],
      where: {
        orderId: 'order-1',
        OR: [{ status: { not: 'REVERSED' } }, { amount: { lt: 0 } }],
      },
      _sum: { amount: true },
    });
  });

  it('无佣金记录时正常冲销', async () => {
    configure({ payload: { manual: true }, commissionGroups: [] });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '无佣金记录' }, ACTOR),
    ).resolves.toMatchObject({ ok: true, reversedAmount: 300 });
  });

  it('认款生成的收款即使 manual=true 也拒绝，且零写操作', async () => {
    configure({ payload: { manual: true, source: 'reconciliation', receiptNo: 'RCP-1' } });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '不应直接冲销' }, ACTOR),
    ).rejects.toThrow(/收款对账台/);

    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it.each([
    ['allocationId', { manual: true, allocationId: 'alloc-1' }],
    ['大写 source', { manual: true, source: 'RECONCILIATION' }],
    ['其它 source', { manual: true, source: 'other-source' }],
    ['receiptNo', { manual: true, receiptNo: 'RCP-9' }],
    ['带前后空白的旧备注', { manual: true, note: '  对账认领 RCP-8  ' }],
  ])('出现认款专有字段（%s）即拒绝且零写', async (_label, payload) => {
    configure({ payload });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '认款来源加固' }, ACTOR),
    ).rejects.toThrow(/收款对账台/);

    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it('旧数据按对账认领备注前缀识别并拒绝，且零写操作', async () => {
    configure({ payload: { manual: true, note: '对账认领 RCP-OLD' } });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '旧认款记录' }, ACTOR),
    ).rejects.toThrow(/收款对账台/);

    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it.each([
    ['载荷为空', null],
    ['manual 标记不是 true', { manual: false }],
  ])('非手工收款（%s）拒绝', async (_label, payload) => {
    configure({ payload });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '不是手工收款' }, ACTOR),
    ).rejects.toThrow(BadRequestError);
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it('收款已锁定的订单拒绝', async () => {
    configure({ payload: { manual: true }, order: { paymentsLocked: true } });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '收款已锁定' }, ACTOR),
    ).rejects.toThrow(/收款已锁定/);
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it.each([OrderStatus.REFUNDED, OrderStatus.REFUND_REQUESTED])(
    '订单状态 %s 拒绝冲销',
    async (status) => {
      configure({ payload: { manual: true }, order: { status } });

      await expect(
        service.reverseManualPayment('payment-1', { reason: '退款状态不可冲销' }, ACTOR),
      ).rejects.toThrow(/不能撤销收款/);
      expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
      expect(mockTx.order.update).not.toHaveBeenCalled();
    },
  );

  it('撤销后低于已完成退款额时拒绝', async () => {
    configure({ payload: { manual: true }, order: { paidAmount: 500 }, refundedTotal: 300 });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '会造成退款倒挂' }, ACTOR),
    ).rejects.toThrow(/账目倒挂/);
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it('CAS count=0 时按并发冲销冲突拒绝', async () => {
    configure({ payload: { manual: true }, casCount: 0 });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '并发重复冲销' }, ACTOR),
    ).rejects.toThrow(ConflictError);
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it('Payment 非 SUCCEEDED 时先明确拒绝，且零写', async () => {
    configure({
      payload: { manual: true, note: '线下转账', confirmedBy: 'user-1' },
      paymentStatus: PaymentStatus.REFUNDED,
      order: { paidAmount: 100 },
    });

    await expect(
      service.reverseManualPayment('payment-1', { reason: '重复冲销' }, ACTOR),
    ).rejects.toThrow('该笔收款当前不是已入账状态（可能已被撤销），无法撤销。请刷新后确认。');
    expect(mockTx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it('从已结清撤销后重新产生尾款时返回 warning', async () => {
    configure({
      payload: { manual: true },
      order: { paidAmount: 1000, total: 1000 },
    });

    const result = await service.reverseManualPayment('payment-1', { reason: '重复录入' }, ACTOR);

    expect(result.warning).toBe(
      '订单 ORD-1 撤销后重新产生尾款 ¥300.00，订单状态仍为原状态（佣金与履约任务不回退），请据实跟进收款。',
    );
  });
});
