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
import { CabinClass, FulfillmentStatus, OrderStatus, UserRole } from '@prisma/client';

const { mockPrisma, mockGetHotelNightlyRemaining } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    orderStatusEvent: { create: vi.fn() },
    orderItem: { findMany: vi.fn() },
    hotelRoomType: { findMany: vi.fn() },
    flightSeatClass: { updateMany: vi.fn(), findFirst: vi.fn() },
    seatLock: { aggregate: vi.fn() },
    holdOrder: { aggregate: vi.fn() },
    // count：落 REFUNDED 前的账目完整性闸——必须先有 Refund（REQUESTED/COMPLETED），
    // 否则实收会永久卡死在单上（三道资金闸对 REFUNDED 全是黑名单）。
    refund: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    // 转 PAID 时按 SUCCEEDED Payment 台账认实收（不再因转 PAID 这个动作本身凭空补满额）。
    // updateMany：R4 转 PAID 时作废其它 PENDING 兄弟 Payment（FAILED + supersededByPaid）。
    payment: { aggregate: vi.fn(), updateMany: vi.fn() },
    // 取消族终态化履约任务（CANCELLED/REFUNDED/PAYMENT_TIMEOUT/FAILED）。
    fulfillmentTask: { updateMany: vi.fn() },
    // Bug 6（佣金幂等）用：createCommissionsForOrder 只在 order.agentId 非空且 toStatus===PAID 时触达。
    // findMany 另外还被"释放型流转的佣金冲销"步骤用到（wasHolding&&isReleasing 且非 PENDING_PAYMENT
    // 来源时无条件触达，即便订单没有代理——见 Bug 1 的 H→DRAFT 测试）。
    commissionRecord: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    // 零计提审计（writeAudit）走全局 prisma，而全局 prisma 在本文件被整体 mock 掉了；
    // 不给出 auditLog 桩，写审计会在 writeAudit 内部抛错被吞掉并刷 console.error。
    auditLog: { create: vi.fn() },
    agent: { findUnique: vi.fn() },
    commissionRule: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
    // R5：转 PAID 分支对 Order 行 FOR UPDATE 读最新 paidAmount。mock 返回 []（无 DB）→ 代码回退到
    // findUnique 读到的 order.paidAmount，与旧口径完全一致（真 DB FOR UPDATE 主路径由集成测试覆盖）。
    $queryRaw: vi.fn(),
  },
  mockGetHotelNightlyRemaining: vi.fn(),
}));
// _updateStatusWithinTx 直接传 tx 参数，这里的 mockTx 即传入的事务句柄（同一批 vi.fn()）。
const mockTx = mockPrisma;

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

vi.mock('../hotel-control/hotel-control.service.js', () => ({
  assertHotelPhysicalFit: vi.fn(),
  assertRandomTierFit: vi.fn(),
  checkHotelPhysicalFit: vi.fn(),
  getHotelNightlyRemaining: mockGetHotelNightlyRemaining,
  getRandomTierAggregate: vi.fn(),
  randomStarTierLabel: vi.fn(),
}));

import {
  OrderService,
  SEAT_HOLDING_STATUSES,
  SEAT_RELEASING_STATUSES,
  type OrderRequester,
} from './orders.service.js';
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
    orderNumber: 'ORD-001',
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
    // 默认：无 SUCCEEDED Payment（转 PAID 不抬 paidAmount）+ 履约任务终态化 no-op（用例可覆写）
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockPrisma.holdOrder.aggregate.mockResolvedValue({
      _sum: { seats: null, seatsConverted: null, seatsCancelled: null },
    });
    mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
    // 转 PAID 分支 FOR UPDATE 读 paidAmount：mock 返回 [] → 回退到 findUnique 的 order.paidAmount。
    mockPrisma.$queryRaw.mockResolvedValue([]);
    // 转 PAID 作废其它 PENDING 兄弟 Payment（默认无兄弟 → count 0）。
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
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
    mockPrisma.holdOrder.aggregate.mockResolvedValueOnce({
      _sum: { seats: 10, seatsConverted: 0, seatsCancelled: 0 },
    });
    mockPrisma.$executeRaw.mockResolvedValueOnce(0); // CAS 未命中：余位不足
    mockPrisma.flightSeatClass.findFirst.mockResolvedValueOnce({ capacity: 10, sold: 0 });

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
    expect((caught as Error).message).toMatch(/仅剩 0 张/);

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
    // 默认：无 SUCCEEDED Payment（转 PAID 不抬 paidAmount）+ 履约任务终态化 no-op（用例可覆写）
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockPrisma.holdOrder.aggregate.mockResolvedValue({
      _sum: { seats: null, seatsConverted: null, seatsCancelled: null },
    });
    mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
    // 转 PAID 分支 FOR UPDATE 读 paidAmount：mock 返回 [] → 回退到 findUnique 的 order.paidAmount。
    mockPrisma.$queryRaw.mockResolvedValue([]);
    // 转 PAID 作废其它 PENDING 兄弟 Payment（默认无兄弟 → count 0）。
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
  });

  it('PENDING_PAYMENT → PAYMENT_TIMEOUT：正常超时释放座位，走 floor 后的原子 SQL（Bug 2b 修复）', async () => {
    const order = buildOrder({ status: OrderStatus.PENDING_PAYMENT });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    // 释放分支改走 releaseSeatFloored（GREATEST(0, sold-qty) 原子 SQL），不再是普通 decrement——
    // 防止伪造 businessUpgradeCount 之类的场景把 sold 打成负数并卡死（见 Bug 2b）。
    mockPrisma.$executeRaw.mockResolvedValueOnce(1);
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

    // 旧路径（普通 decrement）不再使用。
    expect(mockPrisma.flightSeatClass.updateMany).not.toHaveBeenCalled();
    // 新路径：GREATEST(0, sold - qty) 原子 SQL；${qty} 第 1 个占位符、${scheduleId} 第 2 个、
    // ${cabin} 第 3 个（UPDATE ... SET sold = GREATEST(0, sold - ${qty}) ... WHERE "scheduleId" =
    // ${scheduleId} AND cabin = ${cabin}...），与重新占座分支的既有测试同款断言风格。
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    const releaseCall = mockPrisma.$executeRaw.mock.calls[0];
    expect(releaseCall[1]).toBe(1); // qty
    expect(releaseCall[2]).toBe('sched1'); // scheduleId
    expect(releaseCall[3]).toBe(CabinClass.ECONOMY); // cabin
    expect(releasedIds).toEqual(['sc1']);
    // 新增的重新占座分支绝不应该触发（新状态不是"占座中"）。
    expect(mockPrisma.seatLock.aggregate).not.toHaveBeenCalled();
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

describe('OrderService._updateStatusWithinTx · 退款申请即时释放与驳回回座', () => {
  const service = new OrderService();

  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockPrisma.holdOrder.aggregate.mockResolvedValue({
      _sum: { seats: null, seatsConverted: null, seatsCancelled: null },
    });
    mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockPrisma.refund.findMany.mockResolvedValue([]);
    mockPrisma.refund.updateMany.mockResolvedValue({ count: 0 });
    // 进 REFUND_REQUESTED 的账目闸：本组用例都发生在「已经走过取消流程、Refund 已建」之后，
    // 所以默认给一条待处理退款。闸本身另有专门用例（orders.status-account-guards.test.ts）。
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.commissionRecord.findMany.mockResolvedValue([]);
  });

  it('PAID → REFUND_REQUESTED：立即释放座位，套餐升舱按商务/经济舱镜像释放', async () => {
    const order = buildOrder({
      status: OrderStatus.PAID,
      items: [flightItem({ quantity: 3, metadata: { businessUpgradeCount: 1 } })],
    });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.flightSeatClass.findFirst
      .mockResolvedValueOnce({ id: 'business-seat-class' })
      .mockResolvedValueOnce({ id: 'economy-seat-class' });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({
      ...order,
      status: OrderStatus.REFUND_REQUESTED,
    });

    const releasedIds: string[] = [];
    const result = await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.REFUND_REQUESTED,
      adminRequester,
      undefined,
      [],
      false,
      releasedIds,
    );

    expect(result.status).toBe(OrderStatus.REFUND_REQUESTED);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(mockPrisma.$executeRaw.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(mockPrisma.$executeRaw.mock.calls.map((call) => call[3])).toEqual([
      CabinClass.BUSINESS,
      CabinClass.ECONOMY,
    ]);
    expect(releasedIds).toEqual(['business-seat-class', 'economy-seat-class']);
    // 申请退款不是退款批准：Refund、佣金与履约任务不提前推进。
    expect(mockPrisma.refund.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.commissionRecord.findMany).not.toHaveBeenCalled();
  });

  it('REFUND_REQUESTED → REFUNDED：释放 → 释放，不二次释放，但在批准退款时保留原有退款同步', async () => {
    const order = buildOrder({ status: OrderStatus.REFUND_REQUESTED });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ paidAmount: '1000' }]);
    // 走 cancel 流程留下的退款申请：账目完整性闸放行（无此记录一律拒绝落 REFUNDED）
    mockPrisma.refund.count.mockResolvedValueOnce(1);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.refund.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({
      ...order,
      status: OrderStatus.REFUNDED,
    });

    const releasedIds: string[] = [];
    const result = await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.REFUNDED,
      adminRequester,
      undefined,
      [],
      false,
      releasedIds,
    );

    expect(result.status).toBe(OrderStatus.REFUNDED);
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1); // 仅退款批准的 Order 行锁
    expect(mockPrisma.flightSeatClass.updateMany).not.toHaveBeenCalled();
    expect(releasedIds).toEqual([]);
    expect(mockPrisma.refund.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'ord1', status: 'REQUESTED' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    });
  });

  it('REFUND_REQUESTED → PROCESSING：驳回且余位足，原子 CAS 加回座位并拒绝 Refund', async () => {
    const order = buildOrder({ status: OrderStatus.REFUND_REQUESTED });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.seatLock.aggregate.mockResolvedValueOnce({ _sum: { qty: null } });
    mockPrisma.$executeRaw.mockResolvedValueOnce(1);
    mockPrisma.refund.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({
      ...order,
      status: OrderStatus.PROCESSING,
    });

    const result = await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PROCESSING,
      adminRequester,
      undefined,
      [],
      false,
      [],
    );

    expect(result.status).toBe(OrderStatus.PROCESSING);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$executeRaw.mock.calls[0][1]).toBe(1);
    expect(mockPrisma.$executeRaw.mock.calls[0][3]).toBe(CabinClass.ECONOMY);
    expect(mockPrisma.refund.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'ord1', status: 'REQUESTED' },
      data: expect.objectContaining({ status: 'REJECTED' }),
    });
  });

  it('REFUND_REQUESTED → PROCESSING：余位不足时拒绝驳回并给中文协调指引', async () => {
    const order = buildOrder({
      status: OrderStatus.REFUND_REQUESTED,
      items: [flightItem({ quantity: 2 })],
    });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.seatLock.aggregate.mockResolvedValueOnce({ _sum: { qty: null } });
    mockPrisma.$executeRaw.mockResolvedValueOnce(0);
    mockPrisma.flightSeatClass.findFirst.mockResolvedValueOnce({ capacity: 2, sold: 2 });

    await expect(
      service._updateStatusWithinTx(
        tx,
        'ord1',
        OrderStatus.PROCESSING,
        adminRequester,
        undefined,
        [],
        false,
        [],
      ),
    ).rejects.toThrow('座位已被售出，无法驳回退款申请，请协调换班次或继续退款');

    expect(mockPrisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mockPrisma.refund.updateMany).not.toHaveBeenCalled();
  });

  it('REFUND_REQUESTED → PROCESSING：酒店房量不足时拒绝驳回', async () => {
    const order = buildOrder({
      status: OrderStatus.REFUND_REQUESTED,
      items: [
        {
          kind: 'HOTEL',
          hotelRoomTypeId: 'room-type-1',
          randomStarTier: null,
          hotelCheckIn: new Date('2026-09-01T00:00:00.000Z'),
          hotelCheckOut: new Date('2026-09-02T00:00:00.000Z'),
        },
      ],
    });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.hotelRoomType.findMany.mockResolvedValueOnce([
      { id: 'room-type-1', hotelId: 'hotel-1', hotel: { randomTierPlaceholder: null } },
    ]);
    mockGetHotelNightlyRemaining.mockResolvedValueOnce({
      remaining: [-1],
      block: [1],
      hasBlock: true,
      physicalRemaining: [-1],
    });

    await expect(
      service._updateStatusWithinTx(
        tx,
        'ord1',
        OrderStatus.PROCESSING,
        adminRequester,
        undefined,
        [],
        false,
        [],
      ),
    ).rejects.toThrow('房量已被售出，无法驳回退款申请，请协调换房或继续退款');

    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    expect(mockPrisma.refund.updateMany).not.toHaveBeenCalled();
  });
});

describe('座位台账状态集合对称性', () => {
  it('完整覆盖 OrderStatus 且占座集与释放集不相交', () => {
    const holding = new Set(SEAT_HOLDING_STATUSES);
    const releasing = new Set(SEAT_RELEASING_STATUSES);
    const allStatuses = new Set(Object.values(OrderStatus));

    expect(SEAT_HOLDING_STATUSES).toHaveLength(holding.size);
    expect(SEAT_RELEASING_STATUSES).toHaveLength(releasing.size);
    expect(new Set([...holding, ...releasing])).toEqual(allStatuses);
    expect([...holding].filter((status) => releasing.has(status))).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Bug 1（CRITICAL）：DRAFT 座位账死区
//
// 修复前 DRAFT 既不在 SEAT_HOLDING_STATUSES 也不在 SEAT_RELEASING_STATUSES —— admin force 可以拿它
// 当套利死区：force H→DRAFT 不触发释放（sold 原地不动），再 force DRAFT→PAID 触发"非占座→占座"
// 分支重新占座一次（sold 又 +qty）。反复横跳每次 +qty，单订单就能让 sold 无界增长（超卖 DoS）。
// 修复：把 DRAFT 并入 SEAT_RELEASING_STATUSES（订单创建路径永远直接落 PENDING_PAYMENT 并与扣座同一
// 事务原子发生，从未有 DRAFT 状态本身持有真实库存的场景，归类为"释放型"是安全的）。
// ════════════════════════════════════════════════════════════════════════
describe('OrderService._updateStatusWithinTx · Bug 1：DRAFT 座位账死区闭环', () => {
  const service = new OrderService();

  beforeEach(() => {
    vi.resetAllMocks();
    // 默认：无 SUCCEEDED Payment（转 PAID 不抬 paidAmount）+ 履约任务终态化 no-op（用例可覆写）
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockPrisma.holdOrder.aggregate.mockResolvedValue({
      _sum: { seats: null, seatsConverted: null, seatsCancelled: null },
    });
    mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
    // 转 PAID 分支 FOR UPDATE 读 paidAmount：mock 返回 [] → 回退到 findUnique 的 order.paidAmount。
    mockPrisma.$queryRaw.mockResolvedValue([]);
    // 转 PAID 作废其它 PENDING 兄弟 Payment（默认无兄弟 → count 0）。
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
  });

  it('force PAID → DRAFT：H→DRAFT 走释放分支还库存（不再是死区）', async () => {
    const order = buildOrder({ status: OrderStatus.PAID });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order); // toStatus 不是 PAID，无第二次读
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.$executeRaw.mockResolvedValueOnce(1); // releaseSeatFloored 命中
    mockPrisma.flightSeatClass.findFirst.mockResolvedValueOnce({ id: 'sc1' });
    // wasHolding(PAID)&&isReleasing(DRAFT) 为真且来源不是 PENDING_PAYMENT → 无条件触达佣金冲销
    // 步骤（即便订单没有代理），_computeRefundRatioByKind 对非 REFUNDED 目标状态直接短路返回，
    // 不碰 tx；随后的 commissionRecord.findMany 需要显式 mock 成空数组（无代理→无佣金记录可冲）。
    mockPrisma.commissionRecord.findMany.mockResolvedValueOnce([]);
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.DRAFT });

    const releasedIds: string[] = [];
    const result = await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.DRAFT,
      adminRequester,
      undefined,
      [],
      true, // force：ALLOWED_TRANSITIONS[PAID] 不含 DRAFT
      releasedIds,
    );

    expect(result.status).toBe(OrderStatus.DRAFT);
    // 释放走 floor 后的原子 SQL，跟其余释放路径同一口径。
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    const releaseCall = mockPrisma.$executeRaw.mock.calls[0];
    expect(releaseCall[1]).toBe(1); // qty
    expect(releaseCall[2]).toBe('sched1'); // scheduleId
    expect(releaseCall[3]).toBe(CabinClass.ECONOMY); // cabin
    expect(releasedIds).toEqual(['sc1']);
    // 重新占座分支绝不应该同时触发（这是释放，不是占座）。
    expect(mockPrisma.seatLock.aggregate).not.toHaveBeenCalled();
  });

  it('force DRAFT → PAID：DRAFT→H 对称地重新占座（原子 CAS 命中）', async () => {
    const order = buildOrder({ status: OrderStatus.DRAFT });
    mockPrisma.order.findUnique
      .mockResolvedValueOnce(order) // _updateStatusWithinTx 自己的读
      .mockResolvedValueOnce({ visaStatus: null }); // createFulfillmentTasks 内部读（toStatus===PAID 必经）
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.seatLock.aggregate.mockResolvedValueOnce({ _sum: { qty: null } });
    mockPrisma.$executeRaw.mockResolvedValueOnce(1); // CAS 命中：sold = sold + qty 成功
    mockPrisma.orderItem.findMany.mockResolvedValueOnce([]); // createFulfillmentTasks：无行可建任务
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PAID });

    const result = await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PAID,
      adminRequester,
      undefined,
      [],
      true, // force：ALLOWED_TRANSITIONS[DRAFT] 只含 PENDING_PAYMENT/CANCELLED，不含 PAID
      [],
    );

    expect(result.status).toBe(OrderStatus.PAID);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    const retakeCall = mockPrisma.$executeRaw.mock.calls[0];
    expect(retakeCall[1]).toBe(1); // qty
    expect(retakeCall[2]).toBe('sched1'); // scheduleId
    expect(retakeCall[3]).toBe(CabinClass.ECONOMY); // cabin
    // 释放分支绝不会跟重新占座分支同时触发。
    expect(mockPrisma.flightSeatClass.updateMany).not.toHaveBeenCalled();
  });

  it('force DRAFT → PAID：余位不足则拒绝（与其它释放态拉回占座同一保护，不会超卖）', async () => {
    const order = buildOrder({
      status: OrderStatus.DRAFT,
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
    // 拒单必须在拿到"转换后"的最终订单之前中止 —— 调用方的 $transaction 才能整体回滚。
    expect(mockPrisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('force DRAFT → CANCELLED：释放 → 释放之间不触碰座位台账（DRAFT 本就没持有真实库存）', async () => {
    const order = buildOrder({ status: OrderStatus.DRAFT });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.refund.updateMany.mockResolvedValueOnce({ count: 0 }); // toStatus===CANCELLED 的 refund 同步步骤
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.CANCELLED });

    await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.CANCELLED,
      adminRequester,
      undefined,
      [],
      true, // force（非强制其实也允许，DRAFT→CANCELLED 在 ALLOWED_TRANSITIONS 里，这里统一用 force 复现场景）
      [],
    );

    // DRAFT 本身不在 SEAT_HOLDING_STATUSES，wasHolding=false → 释放分支短路，不会二次释放。
    expect(mockPrisma.flightSeatClass.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    expect(mockPrisma.seatLock.aggregate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Bug 6（MEDIUM）：force REFUNDED → PAID 佣金幂等
//
// createCommissionsForOrder 原本没有任何幂等保护——正常状态机每单只会经过一次 PENDING_PAYMENT→PAID，
// 但 admin force 能让同一订单二次触达 toStatus===PAID（例如误操作 force REFUNDED→PAID"复活"一张
// 已退款单），导致同一订单的佣金链路被重新跑一遍，代理端看见的应得佣金翻倍。
// 修复：createCommissionsForOrder 开头查该订单是否已有 CommissionRecord，有则直接跳过。
// ════════════════════════════════════════════════════════════════════════
describe('OrderService._updateStatusWithinTx · Bug 6：佣金创建幂等', () => {
  const service = new OrderService();

  beforeEach(() => {
    vi.resetAllMocks();
    // 默认：无 SUCCEEDED Payment（转 PAID 不抬 paidAmount）+ 履约任务终态化 no-op（用例可覆写）
  mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
  mockPrisma.holdOrder.aggregate.mockResolvedValue({
    _sum: { seats: null, seatsConverted: null, seatsCancelled: null },
  });
    mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
    // 转 PAID 分支 FOR UPDATE 读 paidAmount：mock 返回 [] → 回退到 findUnique 的 order.paidAmount。
    mockPrisma.$queryRaw.mockResolvedValue([]);
    // 转 PAID 作废其它 PENDING 兄弟 Payment（默认无兄弟 → count 0）。
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
  });

  it('force REFUNDED → PAID：已退款是终态，禁止"复活"回占座/已支付（即使 admin force）', async () => {
    // 产品决策：已退款订单强拉回 PAID 会让 Refund 记录停在 COMPLETED、订单却回 PAID，账目永久对不上；
    // 硬规则拒绝该转换，要重开须走正规重新下单。佣金幂等（下一条）仍作为纵深防御保留在代码里。
    const order = buildOrder({
      status: OrderStatus.REFUNDED,
      agentId: 'agent1',
      items: [{ id: 'item1', kind: 'HOTEL', quantity: 1, flightScheduleId: null, flightCabin: null, metadata: null }],
    });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);

    await expect(
      service._updateStatusWithinTx(tx, 'ord1', OrderStatus.PAID, adminRequester, undefined, [], true, []),
    ).rejects.toThrow('订单已退款（终态）');
    // 禁转在改状态前抛出：不落新状态、不建/查佣金。
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
  });

  it('force CANCELLED → PAID：订单已有佣金记录 → 跳过创建，不重复计佣（幂等纵深防御）', async () => {
    // HOTEL 行（非 FLIGHT）：force CANCELLED→PAID 的"非占座→占座"重新占座分支只处理 FLIGHT 行，
    // 用非 FLIGHT 行可以不必额外搭 seatLock/$executeRaw 的 mock，聚焦测佣金幂等本身。
    // （CANCELLED 非禁转终态，可复活；REFUNDED 已被上一条禁转拦下，故幂等改从 CANCELLED 路径验证。）
    const order = buildOrder({
      status: OrderStatus.CANCELLED,
      agentId: 'agent1',
      items: [{ id: 'item1', kind: 'HOTEL', quantity: 1, flightScheduleId: null, flightCabin: null, metadata: null }],
    });
    mockPrisma.order.findUnique
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce({ visaStatus: null }); // createFulfillmentTasks 内部读
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    // 幂等命中：本单的 HOTEL 档已有佣金记录 → 该档跳过；单上再无其它可计提档
    // → createCommissionsForOrder 提前 return，不查链路/不建新记录。
    mockPrisma.commissionRecord.findMany.mockResolvedValueOnce([{ productKind: 'HOTEL' }]);
    mockPrisma.orderItem.findMany
      .mockResolvedValueOnce([{ id: 'item1', kind: 'HOTEL', amount: 1000 }]) // createCommissionsForOrder 的读
      .mockResolvedValueOnce([]); // createFulfillmentTasks：无行可建任务
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PAID });

    await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PAID,
      adminRequester,
      undefined,
      [],
      true, // force：CANCELLED 是释放态，复活到 PAID 会触发 createCommissionsForOrder
      [],
    );

    expect(mockPrisma.commissionRecord.findMany).toHaveBeenCalledWith({
      where: { orderId: 'ord1' },
      select: { productKind: true },
      distinct: ['productKind'],
    });
    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
    // 幂等提前 return，链路解析（agent.findUnique/commissionRule.findMany）也不该被无谓触达。
    expect(mockPrisma.agent.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.commissionRule.findMany).not.toHaveBeenCalled();
  });

  it('正常路径（无既有佣金记录）：仍然按代理链路创建佣金——幂等修复没有破坏首次创建', async () => {
    const order = buildOrder({
      status: OrderStatus.PENDING_PAYMENT,
      agentId: 'agent1',
      items: [{ id: 'item1', kind: 'HOTEL', quantity: 1, flightScheduleId: null, flightCabin: null, metadata: null }],
    });
    mockPrisma.order.findUnique
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce({ visaStatus: null });
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.commissionRecord.findMany.mockResolvedValueOnce([]); // 首次 → 一档都没计提过
    mockPrisma.orderItem.findMany
      .mockResolvedValueOnce([{ id: 'item1', kind: 'HOTEL', amount: 1000 }]) // createCommissionsForOrder 的读
      .mockResolvedValueOnce([]); // createFulfillmentTasks 的读
    mockPrisma.agent.findUnique.mockResolvedValueOnce({ parentAgentId: null }); // 单级代理，无上级
    mockPrisma.commissionRule.findMany.mockResolvedValueOnce([
      { agentId: 'agent1', rate: 0.1, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
    ]);
    mockPrisma.commissionRecord.create.mockResolvedValueOnce({});
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PAID });

    await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PAID,
      adminRequester,
      undefined,
      [],
      false,
      [],
    );

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    const createCall = mockPrisma.commissionRecord.create.mock.calls[0][0];
    expect(createCall.data.agentId).toBe('agent1');
    expect(createCall.data.orderId).toBe('ord1');
    expect(Number(createCall.data.amount)).toBe(100); // 1000 × 10%
  });
});

// ── P0-3：转 PAID 不再"因转成 PAID 这个动作本身"隐式补满额 ────────────────
// paidAmount 只反映真实到账证据（SUCCEEDED Payment 台账 与 已记录 order.paidAmount 的较大者），
// 无流水则保留原值（订单可 PAID 但尾款如实 > 0），杜绝 STAFF/ADMIN 经 PATCH status 白得"已收全款"。
describe('OrderService._updateStatusWithinTx · P0-3：转 PAID 按真实到账证据', () => {
  const service = new OrderService();
  beforeEach(() => {
    vi.resetAllMocks();
  mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
  mockPrisma.holdOrder.aggregate.mockResolvedValue({
    _sum: { seats: null, seatsConverted: null, seatsCancelled: null },
  });
    mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
    // 转 PAID 分支 FOR UPDATE 读 paidAmount：mock 返回 [] → 回退到 findUnique 的 order.paidAmount。
    mockPrisma.$queryRaw.mockResolvedValue([]);
    // 转 PAID 作废其它 PENDING 兄弟 Payment（默认无兄弟 → count 0）。
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
  });

  function armPaidTransition(order: Record<string, unknown>) {
    mockPrisma.order.findUnique
      .mockResolvedValueOnce(order) // _updateStatusWithinTx 自己的读
      .mockResolvedValueOnce({ visaStatus: null }); // createFulfillmentTasks 内部读
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.orderItem.findMany.mockResolvedValueOnce([]); // createFulfillmentTasks：无行可建
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PAID });
  }

  it('有 SUCCEEDED Payment 台账（≥ total）→ paidAmount 抬到实收（网关回调口径）', async () => {
    const order = buildOrder({ status: OrderStatus.PENDING_PAYMENT, paidAmount: decimalLike(0), items: [flightItem()] });
    armPaidTransition(order);
    mockPrisma.payment.aggregate.mockResolvedValueOnce({ _sum: { amount: 1000 } });

    await service._updateStatusWithinTx(tx, 'ord1', OrderStatus.PAID, adminRequester, undefined, [], false, []);

    const casData = mockPrisma.order.updateMany.mock.calls[0][0].data;
    expect(casData.status).toBe(OrderStatus.PAID);
    expect(Number(casData.paidAmount.toString())).toBe(1000);
  });

  it('多付：Payment 台账 > total → paidAmount 保留多付额（不回压到 total）', async () => {
    const order = buildOrder({ status: OrderStatus.PENDING_PAYMENT, paidAmount: decimalLike(0), items: [flightItem()] });
    armPaidTransition(order);
    mockPrisma.payment.aggregate.mockResolvedValueOnce({ _sum: { amount: 1200 } });

    await service._updateStatusWithinTx(tx, 'ord1', OrderStatus.PAID, adminRequester, undefined, [], false, []);

    const casData = mockPrisma.order.updateMany.mock.calls[0][0].data;
    expect(Number(casData.paidAmount.toString())).toBe(1200);
  });

  it('无收款流水（admin force→PAID）→ 不写 paidAmount（保留原值，绝不伪造满额）', async () => {
    const order = buildOrder({ status: OrderStatus.PENDING_PAYMENT, paidAmount: decimalLike(0), items: [flightItem()] });
    armPaidTransition(order);
    // 默认 payment.aggregate → { _sum: { amount: null } }（无 SUCCEEDED Payment）

    await service._updateStatusWithinTx(tx, 'ord1', OrderStatus.PAID, adminRequester, undefined, [], false, []);

    const casData = mockPrisma.order.updateMany.mock.calls[0][0].data;
    expect(casData.status).toBe(OrderStatus.PAID);
    // 关键：不因转 PAID 就把 paidAmount 补到 total —— 台账无证据时不写该字段
    expect(casData.paidAmount).toBeUndefined();
  });

  it('调用方已累加 order.paidAmount（人工/余额抵扣，≥ total）→ 保留，不被更小的 Payment 台账回压', async () => {
    // 余额抵扣走 prepaymentTransaction 不入 Payment 台账 → 台账合计可能 < total，但 order.paidAmount 已满额
    const order = buildOrder({ status: OrderStatus.PENDING_PAYMENT, paidAmount: decimalLike(1000), items: [flightItem()] });
    armPaidTransition(order);
    mockPrisma.payment.aggregate.mockResolvedValueOnce({ _sum: { amount: 0 } });

    await service._updateStatusWithinTx(tx, 'ord1', OrderStatus.PAID, adminRequester, undefined, [], false, []);

    const casData = mockPrisma.order.updateMany.mock.calls[0][0].data;
    // 台账(0) 不大于 已记录(1000) → 不改写 paidAmount，保留 1000
    expect(casData.paidAmount).toBeUndefined();
  });
});

// ── P1-7 / P2-16 / P1-14：退款回退置 REJECTED、取消族终态化履约任务、软删单拒状态流转 ──
describe('OrderService._updateStatusWithinTx · 退款回退 / 任务终态化 / 软删守卫', () => {
  const service = new OrderService();
  beforeEach(() => {
    vi.resetAllMocks();
  mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
  mockPrisma.holdOrder.aggregate.mockResolvedValue({
    _sum: { seats: null, seatsConverted: null, seatsCancelled: null },
  });
    mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
    // 转 PAID 分支 FOR UPDATE 读 paidAmount：mock 返回 [] → 回退到 findUnique 的 order.paidAmount。
    mockPrisma.$queryRaw.mockResolvedValue([]);
    // 转 PAID 作废其它 PENDING 兄弟 Payment（默认无兄弟 → count 0）。
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
  });

  it('P1-7 REFUND_REQUESTED → PROCESSING（退款被拒回退）→ 关联 REQUESTED Refund 置 REJECTED', async () => {
    const order = buildOrder({ status: OrderStatus.REFUND_REQUESTED, items: [flightItem()] });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.seatLock.aggregate.mockResolvedValueOnce({ _sum: { qty: null } });
    mockPrisma.$executeRaw.mockResolvedValueOnce(1);
    mockPrisma.refund.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PROCESSING });

    await service._updateStatusWithinTx(tx, 'ord1', OrderStatus.PROCESSING, adminRequester, undefined, []);

    expect(mockPrisma.refund.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'ord1', status: 'REQUESTED' },
      data: { status: 'REJECTED', processedAt: expect.any(Date) },
    });
  });

  it('P2-16 → CANCELLED：把该订单 PENDING/IN_PROGRESS 履约任务终态化为 CANCELLED', async () => {
    // 用 HOTEL 行避开释放分支的座位 mock；PENDING_PAYMENT→CANCELLED 是允许转移（无需 force）。
    const order = buildOrder({
      status: OrderStatus.PENDING_PAYMENT,
      items: [{ id: 'item1', kind: 'HOTEL', quantity: 1, flightScheduleId: null, flightCabin: null, metadata: null }],
    });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.refund.updateMany.mockResolvedValueOnce({ count: 0 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.CANCELLED });

    await service._updateStatusWithinTx(tx, 'ord1', OrderStatus.CANCELLED, adminRequester, undefined, []);

    expect(mockPrisma.fulfillmentTask.updateMany).toHaveBeenCalledWith({
      where: {
        orderItem: { orderId: 'ord1' },
        status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS] },
      },
      data: { status: FulfillmentStatus.CANCELLED, completedAt: expect.any(Date) },
    });
  });

  it('P2-16 → PROCESSING（非取消族）：不终态化履约任务', async () => {
    const order = buildOrder({ status: OrderStatus.PAID, items: [{ id: 'item1', kind: 'HOTEL', quantity: 1, flightScheduleId: null, flightCabin: null, metadata: null }] });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PROCESSING });

    await service._updateStatusWithinTx(tx, 'ord1', OrderStatus.PROCESSING, adminRequester, undefined, []);

    expect(mockPrisma.fulfillmentTask.updateMany).not.toHaveBeenCalled();
  });

  it('P1-14 软删单（deletedAt 非空）→ 拒绝状态流转（BadRequestError），不落新状态', async () => {
    const order = buildOrder({ status: OrderStatus.CANCELLED, deletedAt: new Date('2026-07-01T00:00:00.000Z') });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);

    await expect(
      service._updateStatusWithinTx(tx, 'ord1', OrderStatus.PAID, adminRequester, undefined, [], true, []),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });
});
