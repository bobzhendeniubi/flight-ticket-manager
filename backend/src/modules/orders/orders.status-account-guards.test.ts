/**
 * OrderService._updateStatusWithinTx · 派生闸 / 账目闸 · 服务级测试（vitest）
 *
 * 三件事，都是「状态是别处事实的派生，而不是一个可以手点的标签」：
 *
 *   1. →REFUND_REQUESTED 账目闸（与既有的 →REFUNDED 账目闸对称）：
 *      状态机把 PAID/PROCESSING/TICKETED/CHANGED/FAILED → REFUND_REQUESTED 全部放行且零校验，
 *      于是「退款申请中」可以是一张没有任何 Refund 记录的空壳单：座位当场释放、订单从有效口径
 *      里消失，却既没有应退报价、也没有可批准的对象，最终两头卡死。
 *   2. →CHANGED 派生闸（与既有的 →TICKETED 派生闸同构）：
 *      「已改期」必须有航段真的被改过（改期端点在 FLIGHT 行 metadata 落 flightChanged 标记），
 *      否则会出现「状态说已改期、航段还是原班次」——旅客照原航班出行。
 *   3. 取消族恢复复检开票额度：订单落取消族时释放它占的开票额度，那份额度可能已被别的单开走；
 *      force 拉回计数态时开票标记会凭空补回额度，把班次撑过座位库存上限。
 *
 * 直接调用 _updateStatusWithinTx（不经公开的 updateStatus）——与 orders.status-seats.test.ts
 * 同一套路：该方法的文档就写明「供 payments.handleCallback 等外部事务复用」，传自制 tx mock
 * 是符合设计意图的用法，也避开了 updateStatus 事务提交后真去连 Redis 的那段。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CabinClass, OrderStatus, RefundStatus, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
    },
    orderStatusEvent: { create: vi.fn() },
    orderItem: { findMany: vi.fn() },
    flightSeatClass: { updateMany: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    seatLock: { aggregate: vi.fn() },
    holdOrder: { aggregate: vi.fn() },
    refund: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    payment: { aggregate: vi.fn(), updateMany: vi.fn() },
    fulfillmentTask: { updateMany: vi.fn() },
    commissionRecord: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    agent: { findUnique: vi.fn() },
    commissionRule: { findMany: vi.fn() },
    prepaymentTransaction: { findMany: vi.fn(), create: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));
const mockTx = mockPrisma;

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

vi.mock('../hotel-control/hotel-control.service.js', () => ({
  assertHotelPhysicalFit: vi.fn(),
  assertHotelPhysicalFitWithinTx: vi.fn(),
  assertRandomTierFit: vi.fn(),
  // 事务内带行锁版（建单/改日期的权威判定走它）：桩与真模块导出对齐。
  assertRandomTierFitWithinTx: vi.fn(),
  checkHotelPhysicalFit: vi.fn(),
  getHotelNightlyRemaining: vi.fn(),
  getRandomTierAggregate: vi.fn(),
  lockHotelBlockPeriodsWithinTx: vi.fn(),
  randomStarTierLabel: vi.fn(),
}));

import { OrderService, type OrderRequester } from './orders.service.js';
import { BadRequestError } from '../../lib/errors.js';

type UpdateStatusTxArg = Parameters<OrderService['_updateStatusWithinTx']>[0];
const tx = mockTx as unknown as UpdateStatusTxArg;

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
    status: OrderStatus.PAID,
    userId: 'user1',
    agentId: null,
    paidAmount: decimalLike(0),
    total: decimalLike(1000),
    adjustmentCny: 0,
    items: [flightItem()],
    ...overrides,
  };
}

const adminRequester: OrderRequester = { userId: 'admin1', role: UserRole.ADMIN, actorType: 'USER' };
const staffRequester: OrderRequester = { userId: 'staff1', role: UserRole.STAFF, actorType: 'USER' };

const service = new OrderService();

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
  mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.holdOrder.aggregate.mockResolvedValue({
    _sum: { seats: null, seatsConverted: null, seatsCancelled: null },
  });
  mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.refund.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
  mockPrisma.refund.findMany.mockResolvedValue([]);
  mockPrisma.commissionRecord.findMany.mockResolvedValue([]);
  mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: null } });
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.$executeRaw.mockResolvedValue(1);
  mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.orderStatusEvent.create.mockResolvedValue({});
});

// ══════════════════════════════════════════════════════════════════════════
// 1. →REFUND_REQUESTED 账目闸
// ══════════════════════════════════════════════════════════════════════════
describe('_updateStatusWithinTx · →REFUND_REQUESTED 必须已有待处理退款', () => {
  it('无任何 Refund → 拒绝，并指向「取消订单」流程', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(buildOrder({ status: OrderStatus.PAID }));
    mockPrisma.refund.count.mockResolvedValueOnce(0);

    await expect(
      service._updateStatusWithinTx(tx, 'ord1', OrderStatus.REFUND_REQUESTED, adminRequester, undefined, []),
    ).rejects.toThrow(BadRequestError);

    // 拦在 CAS 之前：状态没落地、座位没被释放
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('报错文案指路「取消订单」，不让运营去猜', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(buildOrder({ status: OrderStatus.TICKETED }));
    mockPrisma.refund.count.mockResolvedValueOnce(0);

    await expect(
      service._updateStatusWithinTx(tx, 'ord1', OrderStatus.REFUND_REQUESTED, adminRequester, undefined, []),
    ).rejects.toThrow(/取消订单/);
  });

  it('只认未终结的退款三态（REJECTED/COMPLETED 的旧单不能当通行证）', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(buildOrder({ status: OrderStatus.PAID }));
    mockPrisma.refund.count.mockResolvedValueOnce(0);

    await expect(
      service._updateStatusWithinTx(tx, 'ord1', OrderStatus.REFUND_REQUESTED, adminRequester, undefined, []),
    ).rejects.toThrow(BadRequestError);

    expect(mockPrisma.refund.count).toHaveBeenCalledWith({
      where: {
        orderId: 'ord1',
        status: {
          in: [RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING],
        },
      },
    });
  });

  it('admin force 同样拦 —— 账目完整性不是流程便利性', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(buildOrder({ status: OrderStatus.COMPLETED }));
    mockPrisma.refund.count.mockResolvedValueOnce(0);

    await expect(
      service._updateStatusWithinTx(
        tx,
        'ord1',
        OrderStatus.REFUND_REQUESTED,
        adminRequester,
        undefined,
        [],
        true, // force
      ),
    ).rejects.toThrow(BadRequestError);
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('已有待处理 Refund（正门 cancel 流程建的）→ 放行并照常释放座位', async () => {
    const order = buildOrder({ status: OrderStatus.PAID });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.refund.count.mockResolvedValueOnce(1);
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ id: 'economy-seat-class' });
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
    expect(releasedIds).toEqual(['economy-seat-class']);
  });

  it('FAILED（出票失败）→ REFUND_REQUESTED：有退款申请即放行，且不二次释放座位', async () => {
    // FAILED 属 SEAT_RELEASING：座位在落 FAILED 时已还库存，这里绝不能再放一次（会把 sold 打负）。
    const order = buildOrder({ status: OrderStatus.FAILED });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.refund.count.mockResolvedValueOnce(1);
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({
      ...order,
      status: OrderStatus.REFUND_REQUESTED,
    });

    const releasedIds: string[] = [];
    const result = await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.REFUND_REQUESTED,
      staffRequester,
      '出票失败退款',
      [],
      false,
      releasedIds,
    );

    expect(result.status).toBe(OrderStatus.REFUND_REQUESTED);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled(); // 无二次放座
    expect(releasedIds).toEqual([]);
    // 申请退款不是批准退款：Refund 与佣金都不提前推进
    expect(mockPrisma.refund.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.commissionRecord.findMany).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. →CHANGED 派生闸
// ══════════════════════════════════════════════════════════════════════════
describe('_updateStatusWithinTx · →CHANGED 必须真有航段被改过', () => {
  it('没有 flightChanged 标记 → 拒绝并指向「改期」功能', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(
      buildOrder({ status: OrderStatus.CHANGE_REQUESTED }),
    );
    mockPrisma.orderItem.findMany.mockResolvedValueOnce([{ metadata: null }, { metadata: {} }]);

    await expect(
      service._updateStatusWithinTx(tx, 'ord1', OrderStatus.CHANGED, staffRequester, undefined, []),
    ).rejects.toThrow(/改期/);

    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('该行带 flightChanged 标记（改期端点落的）→ 放行', async () => {
    const order = buildOrder({ status: OrderStatus.CHANGE_REQUESTED });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.orderItem.findMany.mockResolvedValueOnce([
      {
        metadata: {
          businessUpgradeCount: 0,
          flightChanged: { at: '2026-08-25T00:00:00.000Z', fromScheduleId: 'sched0' },
        },
      },
    ]);
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.CHANGED });

    const result = await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.CHANGED,
      staffRequester,
      '改期',
      [],
    );
    expect(result.status).toBe(OrderStatus.CHANGED);
  });

  it('ADMIN force 跳过（应急通道，也放行改期标记出现之前的存量单）', async () => {
    const order = buildOrder({ status: OrderStatus.PAID });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.CHANGED });

    const result = await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.CHANGED,
      adminRequester,
      '存量单补状态',
      [],
      true, // force
    );

    expect(result.status).toBe(OrderStatus.CHANGED);
    // force 路径不去查 FLIGHT 行 metadata
    expect(mockPrisma.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('STAFF 即便传 force 也拦（force 只对 ADMIN 生效）', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(
      buildOrder({ status: OrderStatus.CHANGE_REQUESTED }),
    );
    mockPrisma.orderItem.findMany.mockResolvedValueOnce([{ metadata: null }]);

    await expect(
      service._updateStatusWithinTx(
        tx,
        'ord1',
        OrderStatus.CHANGED,
        staffRequester,
        undefined,
        [],
        true,
      ),
    ).rejects.toThrow(BadRequestError);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. 取消族恢复 → 复检班次开票额度
// ══════════════════════════════════════════════════════════════════════════
describe('_updateStatusWithinTx · 取消族恢复复检开票额度', () => {
  const OUT = 'schOut';
  const OUT_ISO = '2026-07-10T02:00:00Z';

  /** 恢复分支里那次「读开票位 + 航段」的查询结果。 */
  function stubInvoiceRead(flags: { outboundInvoiced: boolean; returnInvoiced: boolean }) {
    mockPrisma.order.findUnique.mockResolvedValueOnce({
      ...flags,
      items: [{ flightScheduleId: OUT, flightSchedule: { departureTime: new Date(OUT_ISO) } }],
    });
  }

  /** countIssuedPassengers 的取数：该班次上已开票的 n 个座（各自唯一证件号，不被去重合并）。 */
  function stubIssued(n: number) {
    mockPrisma.order.findMany.mockResolvedValue([
      {
        outboundInvoiced: true,
        returnInvoiced: false,
        passengers: Array.from({ length: n }, (_, i) => ({
          id: `p${i}`,
          documentNumber: `DOC${i}`,
          passengerType: 'ADULT',
        })),
        items: [{ flightScheduleId: OUT, flightSchedule: { departureTime: new Date(OUT_ISO) } }],
      },
    ]);
  }

  it('额度已被别的单占满 → 清掉去程开票标记并回警示语', async () => {
    const order = buildOrder({
      status: OrderStatus.CANCELLED,
      items: [flightItem({ flightScheduleId: OUT })],
    });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order); // 方法开头的读
    stubInvoiceRead({ outboundInvoiced: true, returnInvoiced: false });
    mockPrisma.flightSeatClass.findMany.mockResolvedValue([{ capacity: 2 }]); // 座位库存 2
    stubIssued(3); // 恢复后该班次已开 3 张 → 越过库存
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ id: 'sc1', capacity: 100, sold: 0 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PAID });
    mockPrisma.orderItem.findMany.mockResolvedValue([]); // createFulfillmentTasks：无行可建任务

    const warnings: string[] = [];
    await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PAID,
      adminRequester,
      '恢复误取消单',
      [],
      true, // CANCELLED 是终态，只能强转
      [],
      warnings,
    );

    expect(mockPrisma.order.update).toHaveBeenCalledWith({
      where: { id: 'ord1' },
      data: { outboundInvoiced: false },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/去程/);
    expect(warnings[0]).toMatch(/重新标记开票/);
  });

  it('额度仍够 → 开票标记原样保留，不产生警示', async () => {
    const order = buildOrder({
      status: OrderStatus.CANCELLED,
      items: [flightItem({ flightScheduleId: OUT })],
    });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    stubInvoiceRead({ outboundInvoiced: true, returnInvoiced: false });
    mockPrisma.flightSeatClass.findMany.mockResolvedValue([{ capacity: 190 }]);
    stubIssued(3);
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ id: 'sc1', capacity: 100, sold: 0 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PAID });
    mockPrisma.orderItem.findMany.mockResolvedValue([]);

    const warnings: string[] = [];
    await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PAID,
      adminRequester,
      '恢复误取消单',
      [],
      true,
      [],
      warnings,
    );

    expect(warnings).toEqual([]);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('没有任何开票标记 → 跳过复检（不白查一遍班次）', async () => {
    const order = buildOrder({
      status: OrderStatus.CANCELLED,
      items: [flightItem({ flightScheduleId: OUT })],
    });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    stubInvoiceRead({ outboundInvoiced: false, returnInvoiced: false });
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ id: 'sc1', capacity: 100, sold: 0 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PAID });
    mockPrisma.orderItem.findMany.mockResolvedValue([]);

    const warnings: string[] = [];
    await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PAID,
      adminRequester,
      undefined,
      [],
      true,
      [],
      warnings,
    );

    expect(warnings).toEqual([]);
    expect(mockPrisma.flightSeatClass.findMany).not.toHaveBeenCalled();
  });

  it('计数态之间流转（PAID → PROCESSING）不触发复检', async () => {
    const order = buildOrder({ status: OrderStatus.PAID, items: [flightItem({ flightScheduleId: OUT })] });
    mockPrisma.order.findUnique.mockResolvedValueOnce(order);
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({
      ...order,
      status: OrderStatus.PROCESSING,
    });

    const warnings: string[] = [];
    await service._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.PROCESSING,
      staffRequester,
      undefined,
      [],
      false,
      [],
      warnings,
    );

    expect(warnings).toEqual([]);
    // 复检分支那次 order.findUnique 根本没发生
    expect(mockPrisma.order.findUnique).toHaveBeenCalledTimes(1);
  });
});
