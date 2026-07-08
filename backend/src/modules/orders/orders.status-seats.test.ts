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
    // Bug 6（佣金幂等）用：createCommissionsForOrder 只在 order.agentId 非空且 toStatus===PAID 时触达。
    // findMany 另外还被"释放型流转的佣金冲销"步骤用到（wasHolding&&isReleasing 且非 PENDING_PAYMENT
    // 来源时无条件触达，即便订单没有代理——见 Bug 1 的 H→DRAFT 测试）。
    commissionRecord: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    agent: { findUnique: vi.fn() },
    commissionRule: { findMany: vi.fn() },
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
    // 幂等命中：已有佣金记录 → createCommissionsForOrder 直接 return，不查链路/不建新记录。
    mockPrisma.commissionRecord.findFirst.mockResolvedValueOnce({ id: 'existing-commission' });
    mockPrisma.orderItem.findMany.mockResolvedValueOnce([]); // createFulfillmentTasks：无行可建任务
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

    expect(mockPrisma.commissionRecord.findFirst).toHaveBeenCalledWith({
      where: { orderId: 'ord1' },
      select: { id: true },
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
    mockPrisma.commissionRecord.findFirst.mockResolvedValueOnce(null); // 首次 → 无既有记录
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
