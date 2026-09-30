/**
 * OrderService._updateStatusWithinTx · 已付款族「钱已撤干净」直接取消 · 服务级测试（vitest）
 *
 * 背景：撤销到账刻意不改订单状态，钱撤光的单仍停在「已支付」；状态机又不给已付款族到「已取消」的边，
 * 运营只能找管理员强制。口径（已拍板）：净收款 ≤ 0 且无进行中退款（且余额抵扣已退回）时，
 * 运营/管理员可不带强制直接取消；副作用与既有取消路径同一条（放座 / 佣金冲销 / 履约终态化）。
 *
 * 直接调 _updateStatusWithinTx 传自制 tx mock（与 orders.status-seats.test.ts 同套路）：
 * updateStatus 外层提交后会 import 队列连 Redis，不适合纯 mock 单测。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CabinClass,
  CommissionStatus,
  FulfillmentStatus,
  OrderStatus,
  PrepaymentTxType,
  UserRole,
} from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    orderStatusEvent: { create: vi.fn() },
    orderItem: { findMany: vi.fn() },
    flightSeatClass: { updateMany: vi.fn(), findFirst: vi.fn() },
    refund: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    prepaymentTransaction: { findMany: vi.fn() },
    fulfillmentTask: { updateMany: vi.fn() },
    commissionRecord: { findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));
const mockTx = mockPrisma;

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService, type OrderRequester } from './orders.service.js';
import { BadRequestError, ForbiddenError } from '../../lib/errors.js';

type UpdateStatusTxArg = Parameters<OrderService['_updateStatusWithinTx']>[0];
const tx = mockTx as unknown as UpdateStatusTxArg;

const decimalLike = (n: number) => ({
  toString: () => String(n),
  greaterThan: (o: { toString: () => string }) => n > Number(o.toString()),
});

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord1',
    orderNumber: 'ORD-001',
    status: OrderStatus.PAID,
    userId: 'user1',
    agentId: 'agent1',
    paidAmount: decimalLike(0),
    prepaymentOffset: decimalLike(0),
    total: decimalLike(1000),
    deletedAt: null,
    items: [
      {
        id: 'item1',
        kind: 'FLIGHT',
        description: 'CA1234 上海→东京',
        quantity: 2,
        flightScheduleId: 'sched1',
        flightCabin: CabinClass.ECONOMY,
        metadata: null,
      },
    ],
    ...overrides,
  };
}

const adminRequester: OrderRequester = { userId: 'admin1', role: UserRole.ADMIN, actorType: 'USER' };
const staffRequester: OrderRequester = { userId: 'staff1', role: UserRole.STAFF, actorType: 'USER' };

/** 锁内读到的 Order 行（FOR UPDATE）+ 退款 / 余额流水的钱口径事实。 */
function arrangeMoney(opts: {
  lockedPaid?: number;
  completedRefunds?: number;
  openRefunds?: number;
  ledger?: Array<{ type: PrepaymentTxType; amount: number }>;
}) {
  mockPrisma.$queryRaw.mockResolvedValueOnce([
    { paidAmount: decimalLike(opts.lockedPaid ?? 0), prepaymentOffset: decimalLike(0) },
  ]);
  mockPrisma.refund.aggregate.mockResolvedValueOnce({
    _sum: { amount: opts.completedRefunds ? decimalLike(opts.completedRefunds) : null },
  });
  mockPrisma.refund.count.mockResolvedValueOnce(opts.openRefunds ?? 0);
  mockPrisma.prepaymentTransaction.findMany.mockResolvedValueOnce(
    (opts.ledger ?? []).map((r) => ({ type: r.type, amount: decimalLike(r.amount) })),
  );
}

async function cancel(requester: OrderRequester = adminRequester, releasedIds: string[] = []) {
  const service = new OrderService();
  return service._updateStatusWithinTx(
    tx,
    'ord1',
    OrderStatus.CANCELLED,
    requester,
    '到账已撤销，客人不走了',
    [],
    false, // 不带强制
    releasedIds,
  );
}

async function expectRejected(pattern: RegExp) {
  let caught: unknown;
  try {
    await cancel();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(BadRequestError);
  expect((caught as Error).message).toMatch(/不允许从「已支付」转移到「已取消」/);
  expect((caught as Error).message).toMatch(pattern);
  // 被拒必须发生在任何写库之前：状态 CAS、状态事件、放座都不能动。
  expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  expect(mockPrisma.orderStatusEvent.create).not.toHaveBeenCalled();
  expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
}

describe('OrderService._updateStatusWithinTx · 已付款族钱撤干净直接取消', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.refund.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.commissionRecord.findMany.mockResolvedValue([]);
    mockPrisma.$executeRaw.mockResolvedValue(1);
  });

  it('净收 0 + 无退款 + 无余额抵扣 → 不带强制也能取消，副作用与既有取消路径一致', async () => {
    const order = buildOrder();
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    arrangeMoney({});
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.flightSeatClass.findFirst.mockResolvedValueOnce({ id: 'economy-seat-class' });
    mockPrisma.commissionRecord.findMany.mockResolvedValueOnce([
      { id: 'c1', status: CommissionStatus.ACCRUED, productKind: 'FLIGHT' },
    ]);
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.CANCELLED });

    const releasedIds: string[] = [];
    const result = await cancel(adminRequester, releasedIds);

    expect(result.status).toBe(OrderStatus.CANCELLED);
    // 锁 Order 行后才判钱（与收款 / 认款串行）
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    // 状态 CAS 带来源状态
    expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord1', status: OrderStatus.PAID },
      data: { status: OrderStatus.CANCELLED },
    });
    expect(mockPrisma.orderStatusEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: OrderStatus.PAID,
        toStatus: OrderStatus.CANCELLED,
        actorUserId: 'admin1',
      }),
    });
    // 放座：占座 → 释放，按航段释放 2 座
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(releasedIds).toEqual(['economy-seat-class']);
    // 已计提佣金整单冲销
    expect(mockPrisma.commissionRecord.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: CommissionStatus.REVERSED },
    });
    // 履约任务终态化
    expect(mockPrisma.fulfillmentTask.updateMany).toHaveBeenCalledWith({
      where: {
        orderItem: { orderId: 'ord1' },
        status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS] },
      },
      data: { status: FulfillmentStatus.CANCELLED, completedAt: expect.any(Date) },
    });
  });

  it.each([
    OrderStatus.PROCESSING,
    OrderStatus.TICKETED,
    OrderStatus.CHANGE_REQUESTED,
    OrderStatus.CHANGED,
  ])('%s 同口径：钱撤干净可由运营直接取消', async (status) => {
    const order = buildOrder({ status, items: [] });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    arrangeMoney({});
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.CANCELLED });

    const result = await cancel(staffRequester);
    expect(result.status).toBe(OrderStatus.CANCELLED);
  });

  it('已收与已完成退款相抵（净收 0）→ 可取消', async () => {
    const order = buildOrder({ paidAmount: decimalLike(800), items: [] });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    arrangeMoney({ lockedPaid: 800, completedRefunds: 800 });
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.CANCELLED });

    const result = await cancel();
    expect(result.status).toBe(OrderStatus.CANCELLED);
  });

  it('净收款 > 0 → 拒，提示走退款/换人', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(buildOrder({ paidAmount: decimalLike(500) }));
    arrangeMoney({ lockedPaid: 500 });
    await expectRejected(/净收款 ¥500\.00.*退款/);
  });

  it('按锁内读到的已收判定：开头快照为 0、锁内已有并发到账 → 拒', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(buildOrder({ paidAmount: decimalLike(0) }));
    arrangeMoney({ lockedPaid: 300 });
    await expectRejected(/净收款 ¥300\.00/);
  });

  it('有进行中的退款 → 拒', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(buildOrder());
    arrangeMoney({ openRefunds: 1 });
    await expectRejected(/进行中的退款申请/);
  });

  it('代理余额抵扣未退回（paidAmount 已被压到 0）→ 拒', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(buildOrder());
    arrangeMoney({ ledger: [{ type: PrepaymentTxType.OFFSET, amount: -300 }] });
    await expectRejected(/预存余额抵扣的 ¥300\.00 尚未退回/);
  });

  it('代理不能借此取消已付款单（权限闸在前，连钱都不查）', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(buildOrder());
    // getDescendantAgentIds 的递归 CTE：返回代理自己
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'agent1' }]);
    const agent: OrderRequester = {
      userId: 'agent-user',
      role: UserRole.AGENT,
      agentId: 'agent1',
      actorType: 'USER',
    };
    await expect(cancel(agent)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.refund.count).not.toHaveBeenCalled();
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });
});
