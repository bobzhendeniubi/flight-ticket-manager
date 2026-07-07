/**
 * OrderService._updateStatusWithinTx · 座位台账对称性修复 · 服务级测试（vitest）
 *
 * CRITICAL bug 背景：释放分支（wasHolding && isReleasing，转出「占座中」状态时退库存）一直都有，
 * 但没有镜像的「非占座 → 占座」重新占座分支。此前只要把订单从一个已释放座位的状态（CANCELLED /
 * PAYMENT_TIMEOUT / REFUNDED / FAILED）拉回「占座中」状态（主要是 admin force 转移，比如
 * PAYMENT_TIMEOUT →(force) PAID），sold 完全不变——订单显示已 PAID，库存却看不见它，会被继续卖出去
 * 造成超卖。本文件聚焦测新加的「非占座 → 占座」重新占座分支，并确认没有破坏既有的释放/占座路径。
 *
 * 直接调用 _updateStatusWithinTx（不经公开的 updateStatus）：
 *   - _updateStatusWithinTx 的文档就写明"供 payments.handleCallback 等外部事务复用"，直接传自制
 *     tx mock 调用是符合设计意图的用法（payments.service.ts 本就是这么用的）。
 *   - updateStatus 外层在事务提交后会真的 import('../../queues/queue.js') 连 Redis
 *     （cancelSeatHoldRelease 等），不适合在无 DB/无 Redis 的纯 mock 单测里触达。
 *   - mock 只需覆盖 _updateStatusWithinTx 实际会碰的 tx.* 方法，比全量搭 updateStatus 的依赖链省得多。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CabinClass, OrderStatus, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    orderStatusEvent: { create: vi.fn() },
    orderItem: { findMany: vi.fn() },
    flightSeatClass: { updateMany: vi.fn(), findFirst: vi.fn() },
    seatLock: { aggregate: vi.fn() },
    refund: { updateMany: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));
// _updateStatusWithinTx 直接传 tx 参数，这里的 mockTx 即传入的事务句柄（同一批 vi.fn()）。
const mockTx = mockPrisma;

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService, type OrderRequester } from './orders.service.js';
import { BadRequestError } from '../../lib/errors.js';

// tx 参数类型是 Prisma.TransactionClient（几十个 delegate），mock 只搭了用得到的几个 —— 借用
// 既有测试文件里 `tx as Parameters<typeof fn>[0]` 的套路，从 unknown 转型，绕开"重叠不足"的类型报错。
type UpdateStatusTxArg = Parameters<OrderService['_updateStatusWithinTx']>[0];
const tx = mockTx as unknown as UpdateStatusTxArg;

// ── fixtures ──────────────────────────────────────────────────────────────

// 最小 Decimal-like stub：_updateStatusWithinTx 只在 toStatus==='PAID' 时调用
// order.paidAmount.greaterThan(order.total) 这一处，其余分支不碰，无需实现完整 Decimal API。
const decimalLike = (n: number) => ({
  toString: () => String(n),
  greaterThan: (o: { toString: () => string }) => n > Number(o.toString()),
});

function flightItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item1',
    kind: 'FLIGHT',
    description: 'CA1234 上海→东京',
    quantity: 1,
    flightScheduleId: 'sched1',
    flightCabin: CabinClass.ECONOMY,
    metadata: null,
    ...overrides,
  };
}

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord1',
    status: OrderStatus.PENDING_PAYMENT,
    userId: 'user1',
    agentId: null,
    paidAmount: decimalLike(0),
    total: decimalLike(1000),
    items: [flightItem()],
    ...overrides,
  };
}

const adminRequester: OrderRequester = { userId: 'admin1', role: UserRole.ADMIN, actorType: 'USER' };

describe('OrderService._updateStatusWithinTx · 非占座 → 占座 重新占座（对称于释放分支）', () => {
  const service = new OrderService();

  // resetAllMocks（而非 clearAllMocks）：每条用例都链了好几个 mockResolvedValueOnce，
  // 必须连实现一起清空，避免上一条用例没消费完的排队值串到下一条。
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('force PAYMENT_TIMEOUT → PAID：命中原子 CAS 重新占座', async () => {
    const order = buildOrder({ status: OrderStatus.PAYMENT_TIMEOUT });
    mockPrisma.order.findUnique
      .mockResolvedValueOnce(order) // _updateStatusWithinTx 自己的读
      .mockResolvedValueOnce({ visaStatus: null }); // createFulfillmentTasks 内部读（toStatus===PAID 必经）
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.seatLock.aggregate.mockResolvedValueOnce({ _sum: { qty: null } });
    mockPrisma.$executeRaw.mockResolvedValueOnce(1); // CAS 命中：sold = sold + qty 成功
    mockPrisma.orderItem.findMany.mockResolvedValueOnce([]); // createFulfillmentTasks：无行可建任务
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PAID });

    const newTaskIds: string[] = [];
    const releasedIds: string[] = [];
    const result = await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PAID,
      adminRequester,
      undefined,
      newTaskIds,
      true, // force
      releasedIds,
    );

    expect(result.status).toBe(OrderStatus.PAID);

    // 原子 CAS 恰好被调用一次（另一段商务舱 split=0 直接短路，不产生调用）。
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    // SQL 模板里 ${qty} 是第 1 个占位符、${scheduleId} 第 2 个、${cabin} 第 3 个
    // （UPDATE ... SET sold = sold + ${qty} ... WHERE "scheduleId" = ${scheduleId} AND cabin = ${cabin}...）。
    const casCall = mockPrisma.$executeRaw.mock.calls[0];
    expect(casCall[1]).toBe(1); // qty
    expect(casCall[2]).toBe('sched1'); // scheduleId
    expect(casCall[3]).toBe(CabinClass.ECONOMY); // cabin

    // 锁位口径与下单一致：排除订单本人的 ACTIVE 锁位，只让"他人"锁位占余票。
    const aggCall = mockPrisma.seatLock.aggregate.mock.calls[0][0];
    expect(aggCall.where.seatClass).toEqual({ scheduleId: 'sched1', cabin: CabinClass.ECONOMY });
    expect(aggCall.where.userId).toEqual({ not: 'user1' });

    // 释放分支绝不会跟重新占座分支同时触发。
    expect(mockPrisma.flightSeatClass.updateMany).not.toHaveBeenCalled();
  });

  it('force PAYMENT_TIMEOUT → PAID：余位不足则整单拒绝（BadRequestError），不落地新状态', async () => {
    const order = buildOrder({
      status: OrderStatus.PAYMENT_TIMEOUT,
      items: [flightItem({ quantity: 2 })],
    });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.seatLock.aggregate.mockResolvedValueOnce({ _sum: { qty: null } });
    mockPrisma.$executeRaw.mockResolvedValueOnce(0); // CAS 未命中：余位不足
    mockPrisma.flightSeatClass.findFirst.mockResolvedValueOnce({ capacity: 2, sold: 2 }); // 已售罄

    let caught: unknown;
    try {
      await service._updateStatusWithinTx(
        tx,
        'ord1',
        OrderStatus.PAID,
        adminRequester,
        undefined,
        [],
        true, // force
        [],
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BadRequestError);
    expect((caught as Error).message).toMatch(/恢复为持有座位状态需重新占座/);
    expect((caught as Error).message).toMatch(/无法转换/);

    // 失败必须在拿到"转换后"的最终订单之前中止 —— 函数提前 throw，调用方的 $transaction 才能整体回滚
    // （真实 DB 下单状态 CAS/事件写入会跟着回滚；此处单测职责只到"函数正确抛错"，真实回滚见 live 回归）。
    expect(mockPrisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('force 恢复占座时按 metadata.businessUpgradeCount 拆分：商务舱、经济舱各占一次', async () => {
    const order = buildOrder({
      status: OrderStatus.PAYMENT_TIMEOUT,
      // 3 人经济舱套餐行，其中 1 人选了升舱 —— 应拆成 BUSINESS 占 1 + ECONOMY 占 2，净占座仍=3。
      items: [flightItem({ quantity: 3, metadata: { businessUpgradeCount: 1 } })],
    });
    mockPrisma.order.findUnique
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce({ visaStatus: null });
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: null } });
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.orderItem.findMany.mockResolvedValueOnce([]);
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PAID });

    await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PAID,
      adminRequester,
      undefined,
      [],
      true,
      [],
    );

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
    const cabinsLocked = mockPrisma.seatLock.aggregate.mock.calls.map(
      (c) => c[0].where.seatClass.cabin,
    );
    expect(cabinsLocked).toEqual([CabinClass.BUSINESS, CabinClass.ECONOMY]);
    const qtysRequested = mockPrisma.$executeRaw.mock.calls.map((c) => c[1]);
    expect(qtysRequested).toEqual([1, 2]); // BUSINESS 拿升舱的 1 人，ECONOMY 拿剩下的 2 人
  });
});

describe('OrderService._updateStatusWithinTx · 既有释放/占座路径不受影响', () => {
  const service = new OrderService();

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('PENDING_PAYMENT → PAYMENT_TIMEOUT：正常超时释放座位，行为不变', async () => {
    const order = buildOrder({ status: OrderStatus.PENDING_PAYMENT });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.flightSeatClass.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.flightSeatClass.findFirst.mockResolvedValueOnce({ id: 'sc1' });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PAYMENT_TIMEOUT });

    const releasedIds: string[] = [];
    await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PAYMENT_TIMEOUT,
      adminRequester,
      undefined,
      [],
      false,
      releasedIds,
    );

    expect(mockPrisma.flightSeatClass.updateMany).toHaveBeenCalledWith({
      where: { scheduleId: 'sched1', cabin: CabinClass.ECONOMY },
      data: { sold: { decrement: 1 } },
    });
    expect(releasedIds).toEqual(['sc1']);
    // 新增的重新占座分支绝不应该触发（新状态不是"占座中"）。
    expect(mockPrisma.seatLock.aggregate).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('PAID → PROCESSING：占座 → 占座之间不触碰座位台账（不会双重扣减）', async () => {
    const order = buildOrder({ status: OrderStatus.PAID });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PROCESSING });

    await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PROCESSING,
      adminRequester,
      undefined,
      [],
      false,
      [],
    );

    expect(mockPrisma.flightSeatClass.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.seatLock.aggregate).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('PAYMENT_TIMEOUT → CANCELLED：释放 → 释放之间不触碰座位台账（早已释放过，不会二次释放）', async () => {
    const order = buildOrder({ status: OrderStatus.PAYMENT_TIMEOUT });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.refund.updateMany.mockResolvedValueOnce({ count: 0 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.CANCELLED });

    await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.CANCELLED,
      adminRequester,
      undefined,
      [],
      false,
      [],
    );

    expect(mockPrisma.flightSeatClass.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.seatLock.aggregate).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });
});
