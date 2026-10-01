/**
 * OrderService.markSwapped · 服务级测试（vitest）
 *
 * 覆盖「已换人」的准入闸门与状态集合口径：权限、金额校验、来源状态、进行中退款互斥、结算价锁、
 * 以及「不能绕过端点直接把状态翻成已换人」的账目闸（连 admin force 都拦）。
 * 真 DB 的算账（调价收敛 / 多付转存 / 座位释放 / 佣金冲销）见 orders.mark-swapped.integration.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus, Prisma, UserRole } from '@prisma/client';

const { mockPrisma, mockTx } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    refund: {
      count: vi.fn(),
      aggregate: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    order: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    orderItem: { findMany: vi.fn(), create: vi.fn() },
    orderStatusEvent: { create: vi.fn() },
    payment: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), aggregate: vi.fn() },
    receipt: { create: vi.fn() },
  };
  return {
    mockTx: tx,
    mockPrisma: {
      ...tx,
      $transaction: vi.fn(async (fn: (transaction: typeof tx) => unknown) => fn(tx)),
    },
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
  enqueueWaitlistCheck: vi.fn(),
  cancelSeatHoldRelease: vi.fn(),
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

import { BadRequestError, ConflictError, ForbiddenError } from '../../lib/errors.js';
import {
  ALLOWED_TRANSITIONS,
  FULFILLMENT_TERMINATING_STATUSES,
  OrderService,
  SEAT_HOLDING_STATUSES,
  SEAT_RELEASING_STATUSES,
  SWAP_ELIGIBLE_STATUSES,
} from './orders.service.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const STAFF = { userId: 'staff-1', role: UserRole.STAFF } as const;
const AGENT = { userId: 'agent-1', role: UserRole.AGENT, agentId: 'ag-1' } as const;

const dec = (value: number) => new Prisma.Decimal(value);

/** markSwapped 事务开头 FOR UPDATE 读到的订单行。 */
function lockedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-a',
    orderNumber: 'ORDER-A',
    agentId: 'ag-1',
    status: OrderStatus.PAID,
    deletedAt: null,
    total: dec(5154),
    adjustmentCny: 0,
    paidAmount: dec(5154),
    prepaymentOffset: dec(0),
    settlementLocked: false,
    paymentsLocked: false,
    internalNotes: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTx.refund.count.mockResolvedValue(0);
  mockTx.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
});

describe('状态集合口径：已换人 = 释放型终态', () => {
  it('SWAPPED 在释放集、不在占座集；履约任务随之终态化；状态机里是终态', () => {
    expect(SEAT_RELEASING_STATUSES).toContain(OrderStatus.SWAPPED);
    expect(SEAT_HOLDING_STATUSES).not.toContain(OrderStatus.SWAPPED);
    expect(FULFILLMENT_TERMINATING_STATUSES).toContain(OrderStatus.SWAPPED);
    expect(ALLOWED_TRANSITIONS[OrderStatus.SWAPPED]).toEqual([]);
  });

  it('可标记已换人的来源状态都是占座态，且不含已完成/出票失败', () => {
    for (const s of SWAP_ELIGIBLE_STATUSES) {
      expect(SEAT_HOLDING_STATUSES).toContain(s);
    }
    expect(SWAP_ELIGIBLE_STATUSES).not.toContain(OrderStatus.COMPLETED);
    expect(SWAP_ELIGIBLE_STATUSES).not.toContain(OrderStatus.FAILED);
    expect(SWAP_ELIGIBLE_STATUSES).toContain(OrderStatus.PENDING_PAYMENT);
  });
});

describe('markSwapped · 准入闸', () => {
  it('代理 → 403（代理走改单申请），不碰任何事务', async () => {
    await expect(
      service.markSwapped('order-a', { swapFeeCny: 450 }, AGENT),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('换人费必须是 ≥0 的整数：负数 / 小数一律 400', async () => {
    await expect(
      service.markSwapped('order-a', { swapFeeCny: -1 }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      service.markSwapped('order-a', { swapFeeCny: 450.5 }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('来源状态不在可换人集合（已完成）→ 400，文案列出可操作状态', async () => {
    mockTx.$queryRaw.mockResolvedValueOnce([lockedRow({ status: OrderStatus.COMPLETED })]);
    await expect(
      service.markSwapped('order-a', { swapFeeCny: 450 }, STAFF),
    ).rejects.toThrow(/「已完成」不可标记已换人/);
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it('回收站单 → 400', async () => {
    mockTx.$queryRaw.mockResolvedValueOnce([lockedRow({ deletedAt: new Date() })]);
    await expect(
      service.markSwapped('order-a', { swapFeeCny: 450 }, STAFF),
    ).rejects.toThrow(/回收站/);
  });

  it('有进行中的退款申请 → 409，先处理完退款再换人', async () => {
    mockTx.$queryRaw.mockResolvedValueOnce([lockedRow()]);
    mockTx.refund.count.mockResolvedValueOnce(1);
    await expect(
      service.markSwapped('order-a', { swapFeeCny: 450 }, STAFF),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockTx.order.update).not.toHaveBeenCalled();
  });

  it('结算价已锁定 → 409，提示先解锁（与事后调价同一把锁）', async () => {
    mockTx.$queryRaw.mockResolvedValueOnce([lockedRow({ settlementLocked: true })]);
    await expect(
      service.markSwapped('order-a', { swapFeeCny: 450 }, STAFF),
    ).rejects.toThrow(/结算价已锁定/);
  });

  it('收款已锁定且有多付要转存 → 409（锁着就拒，不绕过）', async () => {
    // 净收 5154 > 换人费 450 → 要转存 → 撞收款复核锁。
    mockTx.$queryRaw.mockResolvedValueOnce([lockedRow({ paymentsLocked: true })]);
    await expect(
      service.markSwapped('order-a', { swapFeeCny: 450 }, STAFF),
    ).rejects.toThrow(/收款已锁定/);
  });
});

describe('markSwapped · 应收基准 = Σ 明细行 + adjustmentCny（不用 Order.total）', () => {
  it('total 与明细行不一致：差额按 Σ 明细行算；调价后应收 ≠ 换人费 → 409 回滚，不转存多付', async () => {
    // Order.total 落了 5000，明细行却是 2577 × 2 = 5154（历史脏数据 / 旧路径裸改过 total）。
    // 旧实现按 total 算差额 = 1650 − 5000 = −3350，调价内核却按 Σ 明细行重算 total = 5154 − 3350 = 1804，
    // 落库应收 1804 ≠ 换人费 1650，多出的 154 会被原样搬进代理余额。
    mockTx.$queryRaw.mockResolvedValueOnce([lockedRow({ total: dec(5000), paidAmount: dec(5154) })]);
    mockTx.orderItem.findMany.mockResolvedValueOnce([{ amount: dec(2577) }, { amount: dec(2577) }]);
    // 模拟内核按「Σ 明细行 + 差额」之外的口径把 total 算歪（afterTotal 1804）：断言必须拦下并整单回滚。
    const adjustSpy = vi
      .spyOn(service, '_addPriceAdjustmentWithinTx')
      .mockResolvedValue({ itemId: 'adj-1', afterTotal: '1804' } as never);
    const creditSpy = vi.spyOn(service, '_creditOverpayToAgentWithinTx');

    await expect(
      service.markSwapped('order-a', { swapFeeCny: 1650 }, STAFF),
    ).rejects.toMatchObject({ constructor: ConflictError, message: expect.stringMatching(/与换人费 ¥1650 不一致/) });

    // 差额按 Σ 明细行（5154）算：1650 − 5154 = −3504，不是按 total 的 −3350。
    expect(adjustSpy).toHaveBeenCalledTimes(1);
    expect(adjustSpy.mock.calls[0][2]).toMatchObject({ amountCny: -3504, reasonCode: 'SWAP_FEE' });
    // 断言在多付转存之前：一分钱没动。
    expect(creditSpy).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
    adjustSpy.mockRestore();
    creditSpy.mockRestore();
  });

  it('差额为 0 但 total ≠ Σ 明细行：没有差额行去重算 total → 同样 409，不带着错账往下走', async () => {
    // Σ 明细行 1650 == 换人费 → 差额 0、不落调价行；但 total 还是脏的 1500 → 应收 1500 ≠ 1650。
    mockTx.$queryRaw.mockResolvedValueOnce([lockedRow({ total: dec(1500), paidAmount: dec(1650) })]);
    mockTx.orderItem.findMany.mockResolvedValueOnce([{ amount: dec(1650) }]);
    const adjustSpy = vi.spyOn(service, '_addPriceAdjustmentWithinTx');

    await expect(
      service.markSwapped('order-a', { swapFeeCny: 1650 }, STAFF),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(adjustSpy).not.toHaveBeenCalled();
    expect(mockTx.order.update).not.toHaveBeenCalled();
    adjustSpy.mockRestore();
  });
});

describe('账目闸：不能绕过端点直接把状态翻成「已换人」', () => {
  it('PATCH /status → SWAPPED（admin force）也被拦：只翻状态不会收敛应收、不会转存多付', async () => {
    mockTx.order.findUnique.mockResolvedValueOnce({
      id: 'order-a',
      orderNumber: 'ORDER-A',
      userId: null,
      agentId: null,
      status: OrderStatus.PAID,
      deletedAt: null,
      paidAmount: dec(1000),
      adjustmentCny: 0,
      items: [],
    });
    await expect(
      service._updateStatusWithinTx(
        mockTx as never,
        'order-a',
        OrderStatus.SWAPPED,
        { ...ADMIN, actorType: 'USER' },
        'force',
        [],
        true,
      ),
    ).rejects.toThrow(/不能直接置为「已换人」/);
    expect(mockTx.order.updateMany).not.toHaveBeenCalled();
    expect(mockTx.orderStatusEvent.create).not.toHaveBeenCalled();
  });

  it('via:swap 但来源状态不可换人（已取消）→ 同样拦（账目闸在白名单之前）', async () => {
    mockTx.order.findUnique.mockResolvedValueOnce({
      id: 'order-a',
      orderNumber: 'ORDER-A',
      userId: null,
      agentId: null,
      status: OrderStatus.CANCELLED,
      deletedAt: null,
      paidAmount: dec(0),
      adjustmentCny: 0,
      items: [],
    });
    await expect(
      service._updateStatusWithinTx(
        mockTx as never,
        'order-a',
        OrderStatus.SWAPPED,
        { ...STAFF, actorType: 'USER' },
        'swap',
        [],
        undefined,
        undefined,
        undefined,
        { via: 'swap' },
      ),
    ).rejects.toThrow(/本身也不可标记已换人/);
    expect(mockTx.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('已换人 = 真终态：任何来源为 SWAPPED 的状态流转一律拒绝（含 admin force / via:restore）', () => {
  function swappedOrder() {
    return {
      id: 'order-a',
      orderNumber: 'ORDER-A',
      userId: null,
      agentId: 'ag-1',
      status: OrderStatus.SWAPPED,
      deletedAt: null,
      paidAmount: dec(1650),
      adjustmentCny: 0,
      items: [],
    };
  }

  it.each([
    ['拉回占座态 PAID（admin force）', OrderStatus.PAID, ADMIN, true, undefined],
    ['拉到 CANCELLED（admin force）→ 换人费收入会从营收蒸发', OrderStatus.CANCELLED, ADMIN, true, undefined],
    ['拉到 REFUNDED（admin force）', OrderStatus.REFUNDED, ADMIN, true, undefined],
    ['运营不带 force 推 PROCESSING', OrderStatus.PROCESSING, STAFF, undefined, undefined],
    ['内部 via:restore 恢复到待支付', OrderStatus.PENDING_PAYMENT, ADMIN, undefined, { via: 'restore' as const }],
  ])('%s → 400「已换人单为终态」，不落任何状态/事件', async (_label, toStatus, who, force, opts) => {
    mockTx.order.findUnique.mockResolvedValueOnce(swappedOrder());
    await expect(
      service._updateStatusWithinTx(
        mockTx as never,
        'order-a',
        toStatus,
        { ...who, actorType: 'USER' },
        '试图撤销换人',
        [],
        force,
        undefined,
        undefined,
        opts,
      ),
    ).rejects.toThrow(/已换人单为终态；如需撤销请联系管理员走数据纠正/);
    expect(mockTx.order.updateMany).not.toHaveBeenCalled();
    expect(mockTx.orderStatusEvent.create).not.toHaveBeenCalled();
  });
});

describe('_overpayToPoolWithinTx · 挂账进账的「疑似归属」（标记已换人专用 hint）', () => {
  /** 直客单多付 550：FOR UPDATE 行 + 无已完成退款 + 最近一笔收款微信。 */
  function arrangePoolOverpay() {
    mockTx.$queryRaw.mockResolvedValueOnce([
      {
        id: 'order-a',
        orderNumber: 'ORDER-A',
        total: dec(450),
        adjustmentCny: 0,
        paidAmount: dec(1000),
        prepaymentOffset: dec(0),
        status: OrderStatus.PAID,
        deletedAt: null,
        paymentsLocked: false,
      },
    ]);
    mockTx.payment.findFirst.mockResolvedValueOnce({ method: 'WECHAT_PAY' });
    mockTx.receipt.create.mockResolvedValueOnce({ id: 'rcp-1', receiptNo: 'RCP1' });
  }

  it('不传 hint（独立「超额转入挂账池」端点）：进账照旧指回本单，备注「订单超额 X」', async () => {
    arrangePoolOverpay();
    await service._overpayToPoolWithinTx(mockTx as never, 'order-a', STAFF);
    expect(mockTx.receipt.create).toHaveBeenCalledTimes(1);
    expect(mockTx.receipt.create.mock.calls[0][0].data).toMatchObject({
      orderHintId: 'order-a',
      payerNote: '订单超额 ORDER-A',
      source: 'ORDER_OVERPAY',
    });
  });

  it('传 hint（标记已换人）：进账指向接手新单，备注写明认领去向；原单不再被提示「认领到本单」', async () => {
    arrangePoolOverpay();
    await service._overpayToPoolWithinTx(mockTx as never, 'order-a', STAFF, {
      payerNote: '订单 ORDER-A 已换人多付，请认领到接手订单 ORDER-NEW',
      orderHintId: 'order-new',
    });
    expect(mockTx.receipt.create.mock.calls[0][0].data).toMatchObject({
      orderHintId: 'order-new',
      payerNote: '订单 ORDER-A 已换人多付，请认领到接手订单 ORDER-NEW',
    });
  });

  it('传 hint 但没有接手单号：orderHintId 置空（不指回原单），只留文字说明', async () => {
    arrangePoolOverpay();
    await service._overpayToPoolWithinTx(mockTx as never, 'order-a', STAFF, {
      payerNote: '订单 ORDER-A 已换人多付，请认领到接手的新单（新单号录入后再认领，不要认回原单）',
      orderHintId: null,
    });
    expect(mockTx.receipt.create.mock.calls[0][0].data).toMatchObject({ orderHintId: null });
    expect(mockTx.receipt.create.mock.calls[0][0].data.payerNote).toMatch(/不要认回原单/);
  });
});
