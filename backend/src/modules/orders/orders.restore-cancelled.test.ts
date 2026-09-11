/**
 * OrderService.restoreCancelledOrder · 已取消单恢复占位 · 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 口径（2026-09-11 拍板）：已取消 / 支付超时 → 待支付（原本付清过且实收仍覆盖应收 → 已支付），
 * 恢复即重新扣座 / 占房，库存不够就拒。本文件覆盖：
 *   1. 取消 → 恢复：按 flightSeatQuantity 扣回座（婴儿 seatQuantity=0 的行一座不扣）；
 *   2. 机票余位不足：未确认 → 409 OVERSELL_CONFIRMATION_REQUIRED；确认后限额内超售放行 + CRITICAL 审计；
 *      超上限 → 409 OVERSELL_LIMIT_EXCEEDED；
 *   3. 酒店房量不足 → 400（走建单同一把事务内房量闸），且不碰座位账；
 *   4. 已起飞航段 / REFUNDED / 退款申请中 一律拒；
 *   5. 幂等：同 requestToken 重放不二次占座、不二次落状态；
 *   6. 支付超时：后台单 paymentExpiresAt=null 不入队；散客单 now+30min 并重入队；
 *   7. 付清单回 PAID 且履约任务重建（CANCELLED 的任务视为不存在）；
 *   8. 权限：AGENT 403；
 *   9. 佣金恢复计提（2026-09-11 拍板「恢复的单佣金也算」）：回 PAID 时取消冲销的佣金另建等额 ACCRUED
 *      记录（冲销记录不动）；已结算的不动只给 warnings；幂等（已有存活记录 / 同 token 回放不重复）；
 *      回待支付的在之后收款推 PAID 时恢复；admin force 老路径与「恢复后又取消」的单不恢复。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CabinClass, OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';

const { mockPrisma, hotelControlMocks, queueMocks } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    orderStatusEvent: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    orderItem: { findMany: vi.fn() },
    hotelRoomType: { findMany: vi.fn() },
    flightSeatClass: { findFirst: vi.fn() },
    seatLock: { aggregate: vi.fn() },
    holdOrder: { aggregate: vi.fn() },
    refund: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    payment: { aggregate: vi.fn(), updateMany: vi.fn() },
    fulfillmentTask: { updateMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    commissionRecord: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    passenger: { findMany: vi.fn() },
    agent: { findUnique: vi.fn() },
    commissionRule: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  hotelControlMocks: {
    assertHotelPhysicalFit: vi.fn(),
    assertHotelPhysicalFitWithinTx: vi.fn(),
    assertRandomTierFit: vi.fn(),
    assertRandomTierFitWithinTx: vi.fn(),
    checkHotelPhysicalFit: vi.fn(),
    getHotelNightlyRemaining: vi.fn(),
    getHotelOversellCapRooms: vi.fn(),
    getRandomTierAggregate: vi.fn(),
    lockHotelBlockPeriodsWithinTx: vi.fn(),
    randomStarTierLabel: vi.fn(),
  },
  queueMocks: {
    scheduleSeatHoldRelease: vi.fn(),
    cancelSeatHoldRelease: vi.fn(),
    fulfillmentQueue: { add: vi.fn() },
  },
}));
// 事务句柄 = 同一批 vi.fn()（$transaction 直接把 mockPrisma 当 tx 传给回调）。
const mockTx = mockPrisma;

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../hotel-control/hotel-control.service.js', () => hotelControlMocks);
vi.mock('../../queues/queue.js', () => queueMocks);

import { OrderService, ORDER_RESTORED_ADJUSTMENT_TYPE } from './orders.service.js';
import { AppError, BadRequestError, ForbiddenError } from '../../lib/errors.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const STAFF = { userId: 'staff-1', role: UserRole.STAFF } as const;
const AGENT = { userId: 'agent-1', role: UserRole.AGENT } as const;
const TOKEN = '00000000-0000-4000-8000-00000000c0de';

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const PAST = new Date(Date.now() - 24 * 3600 * 1000);

function flightItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item1',
    kind: OrderItemKind.FLIGHT,
    description: 'QH9588 广州→芽庄',
    quantity: 1,
    unitPrice: new Prisma.Decimal(1000),
    amount: new Prisma.Decimal(1000),
    flightScheduleId: 'sched1',
    flightCabin: CabinClass.ECONOMY,
    hotelRoomTypeId: null,
    hotelCheckIn: null,
    hotelCheckOut: null,
    roomsBilled: null,
    randomStarTier: null,
    metadata: { seatQuantity: 1 },
    flightSchedule: {
      departureTime: FUTURE,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    },
    ...overrides,
  };
}

function hotelItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-hotel',
    kind: OrderItemKind.HOTEL,
    description: '芽庄某酒店 · 标准间',
    quantity: 2,
    unitPrice: new Prisma.Decimal(300),
    amount: new Prisma.Decimal(600),
    flightScheduleId: null,
    flightCabin: null,
    hotelRoomTypeId: 'rt1',
    hotelCheckIn: new Date('2026-10-01T00:00:00.000Z'),
    hotelCheckOut: new Date('2026-10-03T00:00:00.000Z'),
    roomsBilled: new Prisma.Decimal(1),
    randomStarTier: null,
    metadata: null,
    flightSchedule: null,
    ...overrides,
  };
}

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord1',
    orderNumber: 'FTM-RESTORE-001',
    status: OrderStatus.CANCELLED,
    deletedAt: null,
    userId: 'user1',
    agentId: null,
    subtotal: new Prisma.Decimal(1000),
    taxesAndFees: new Prisma.Decimal(0),
    discountTotal: new Prisma.Decimal(0),
    total: new Prisma.Decimal(1000),
    paidAmount: new Prisma.Decimal(0),
    prepaymentOffset: new Prisma.Decimal(0),
    adjustmentCny: 0,
    adjustments: null,
    outboundInvoiced: false,
    returnInvoiced: false,
    visaStatus: null,
    items: [flightItem()],
    passengers: [],
    payments: [],
    refunds: [],
    statusEvents: [],
    ...overrides,
  };
}

/** 装配一张可恢复的单：默认后台（STAFF 录入）、余位充足、无酒店行。 */
function mount(order = buildOrder(), opts: { ownerRole?: UserRole | null } = {}) {
  mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(mockTx));
  mockPrisma.$queryRaw.mockResolvedValue([{ id: order.id }]);
  mockPrisma.$executeRaw.mockResolvedValue(1);
  mockPrisma.order.findUnique.mockResolvedValue(order);
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(order);
  mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.order.update.mockResolvedValue({});
  mockPrisma.orderStatusEvent.create.mockResolvedValue({});
  mockPrisma.orderStatusEvent.count.mockResolvedValue(0);
  mockPrisma.orderStatusEvent.findFirst.mockResolvedValue(null);
  mockPrisma.commissionRecord.count.mockResolvedValue(0);
  mockPrisma.commissionRecord.create.mockResolvedValue({ id: 'cr-new' });
  mockPrisma.orderItem.findMany.mockResolvedValue([]);
  mockPrisma.hotelRoomType.findMany.mockResolvedValue([]);
  mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: null } });
  mockPrisma.holdOrder.aggregate.mockResolvedValue({
    _sum: { seats: null, seatsConverted: null, seatsCancelled: null },
  });
  mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
  mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.fulfillmentTask.create.mockResolvedValue({ id: 'task-new' });
  mockPrisma.commissionRecord.findMany.mockResolvedValue([]);
  mockPrisma.auditLog.create.mockResolvedValue({});
  mockPrisma.passenger.findMany.mockResolvedValue([]);
  mockPrisma.user.findUnique.mockResolvedValue(
    opts.ownerRole === null ? null : { role: opts.ownerRole ?? UserRole.STAFF },
  );
  hotelControlMocks.getHotelOversellCapRooms.mockResolvedValue(3);
  hotelControlMocks.assertHotelPhysicalFitWithinTx.mockResolvedValue([]);
  hotelControlMocks.assertRandomTierFitWithinTx.mockResolvedValue([]);
}

/** $executeRaw 是 tagged template：calls[i] = [strings, ...values]；占座 SQL 的第一个插值就是 qty。 */
const executeRawQtys = (): number[] =>
  mockPrisma.$executeRaw.mock.calls.map((call) => call[1] as number);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('restoreCancelledOrder · 取消 → 恢复重新占座', () => {
  it('已取消 → 待支付：按 flightSeatQuantity 扣回座，婴儿行（seatQuantity=0）一座不扣', async () => {
    mount(
      buildOrder({
        items: [
          flightItem({ id: 'adult', quantity: 1, metadata: { seatQuantity: 1 } }),
          flightItem({ id: 'infant', quantity: 1, metadata: { seatQuantity: 0 } }),
        ],
      }),
    );

    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);

    expect(audit.fromStatus).toBe(OrderStatus.CANCELLED);
    expect(audit.toStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(audit.replayed).toBe(false);
    // 只有成人行进 CAS，且只占 1 座；婴儿行 qty=0 在 retakeSeat 入口短路。
    expect(executeRawQtys()).toEqual([1]);
    expect(audit.seatTotal).toBe(1);
    expect(audit.oversold).toBe(false);
    expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ord1', status: OrderStatus.CANCELLED },
        data: expect.objectContaining({ status: OrderStatus.PENDING_PAYMENT }),
      }),
    );
    // 幂等键落在 adjustments 的 ORDER_RESTORED 流水上，金额恒 0。
    const updateArg = mockPrisma.order.update.mock.calls[0][0] as {
      data: { adjustments: Array<Record<string, unknown>>; paymentExpiresAt: Date | null };
    };
    expect(updateArg.data.adjustments).toEqual([
      expect.objectContaining({ type: ORDER_RESTORED_ADJUSTMENT_TYPE, requestToken: TOKEN, amountCny: 0 }),
    ]);
  });

  it('支付超时 → 待支付 同样放行（PAYMENT_TIMEOUT 属可恢复集合）', async () => {
    mount(buildOrder({ status: OrderStatus.PAYMENT_TIMEOUT }));
    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, STAFF);
    expect(audit.toStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(executeRawQtys()).toEqual([1]);
  });

  it('余位不足且未确认 → 409 OVERSELL_CONFIRMATION_REQUIRED，状态不落地', async () => {
    mount();
    mockPrisma.$executeRaw.mockResolvedValue(0);
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ capacity: 10, sold: 10 });

    const err = await service
      .restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('OVERSELL_CONFIRMATION_REQUIRED');
    expect((err as AppError).message).toContain('余位不足');
    // 没有走超售直加（只有那一次失败的 CAS）。
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('余位不足 + allowOversell：限额内超售放行、记 CRITICAL 审计', async () => {
    mount();
    // 第一次 CAS 失败（余位 0），第二次是超售直加成功。
    mockPrisma.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ capacity: 10, sold: 10 });

    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: true }, ADMIN);

    expect(audit.toStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(audit.oversold).toBe(true);
    expect(audit.oversoldBy).toBe(1);
    expect(audit.seats[0]).toEqual(
      expect.objectContaining({ scheduleId: 'sched1', cabin: CabinClass.ECONOMY, quantity: 1, oversold: true }),
    );
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'RESTORE_CANCELLED_ORDER_OVERSOLD', severity: 'CRITICAL' }),
      }),
    );
  });

  it('余位不足 + allowOversell 但超过超售上限 → 409 OVERSELL_LIMIT_EXCEEDED，不占座', async () => {
    mount();
    mockPrisma.$executeRaw.mockResolvedValue(0);
    // 已经超卖 5 座（= 缺省上限），再加 1 就是累计 6 > 5。
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ capacity: 10, sold: 15 });

    const err = await service
      .restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: true }, ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('OVERSELL_LIMIT_EXCEEDED');
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('酒店房量不足 → 400（建单同一把事务内房量闸），且不碰座位账', async () => {
    mount(buildOrder({ items: [flightItem(), hotelItem()] }));
    mockPrisma.hotelRoomType.findMany.mockResolvedValue([
      { id: 'rt1', hotelId: 'h1', hotel: { randomTierPlaceholder: null } },
    ]);
    hotelControlMocks.assertHotelPhysicalFitWithinTx.mockRejectedValue(
      new BadRequestError('芽庄某酒店 2026-10-01 房量不足：需要 1 间，仅剩 0 间'),
    );

    await expect(
      service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN),
    ).rejects.toThrow(/房量不足/);
    // 房量闸在状态 CAS 与占座之前：座位账一次都没碰、状态没落地。
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    // 闸收到的是本单的占房行（内部录单限额 3 间）。
    expect(hotelControlMocks.assertHotelPhysicalFitWithinTx).toHaveBeenCalledWith(
      mockTx,
      'h1',
      ['2026-10-01', '2026-10-02'],
      expect.objectContaining({ wholeRooms: 1 }),
      expect.objectContaining({ maxOversellRooms: 3 }),
    );
  });

  it('酒店限额内超卖 → 放行并把明细带回 audit.hotelOversold', async () => {
    mount(buildOrder({ items: [flightItem(), hotelItem()] }));
    mockPrisma.hotelRoomType.findMany.mockResolvedValue([
      { id: 'rt1', hotelId: 'h1', hotel: { randomTierPlaceholder: null } },
    ]);
    hotelControlMocks.assertHotelPhysicalFitWithinTx.mockResolvedValue([
      { date: '2026-10-01', shortfallRooms: 1 },
    ]);
    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);
    expect(audit.toStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(audit.hotelOversold).toEqual([
      { hotelId: 'h1', violations: [{ date: '2026-10-01', shortfallRooms: 1 }] },
    ]);
  });
});

describe('restoreCancelledOrder · 准入闸', () => {
  it('有已起飞的航段 → 400「已起飞的航段不能恢复」', async () => {
    mount(
      buildOrder({
        items: [flightItem({ flightSchedule: { departureTime: PAST, departureTz: 'Asia/Shanghai', flight: { flightNumber: 'QH9588' } } })],
      }),
    );
    await expect(
      service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN),
    ).rejects.toThrow(/已起飞的航段不能恢复/);
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('REFUNDED 一律拒（钱已退）', async () => {
    mount(buildOrder({ status: OrderStatus.REFUNDED }));
    await expect(
      service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN),
    ).rejects.toThrow(/已退款/);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('非取消族状态（如 PAID）→ 400，不是恢复的对象', async () => {
    mount(buildOrder({ status: OrderStatus.PAID }));
    await expect(
      service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN),
    ).rejects.toThrow(/只有「已取消」「支付超时」/);
  });

  it('有处理中的退款申请 → 400，提示先处理退款', async () => {
    mount(buildOrder({ refunds: [{ status: 'REQUESTED' }] }));
    await expect(
      service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN),
    ).rejects.toThrow(/退款申请/);
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('软删单 → 400', async () => {
    mount(buildOrder({ deletedAt: new Date() }));
    await expect(
      service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN),
    ).rejects.toThrow(/回收站/);
  });

  it('AGENT → 403，不触库', async () => {
    mount();
    await expect(
      service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, AGENT),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('restoreCancelledOrder · 幂等 / 支付超时 / 回 PAID', () => {
  it('同 requestToken 重放：直接回放既有结果，不二次占座、不二次落状态', async () => {
    mount(
      buildOrder({
        status: OrderStatus.PENDING_PAYMENT,
        adjustments: [
          {
            type: ORDER_RESTORED_ADJUSTMENT_TYPE,
            label: '恢复已取消订单',
            amountCny: 0,
            at: new Date().toISOString(),
            by: 'admin-1',
            requestToken: TOKEN,
            detail: { fromStatus: 'CANCELLED', toStatus: 'PENDING_PAYMENT', seatTotal: 1, oversold: false },
          },
        ],
      }),
    );
    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);
    expect(audit.replayed).toBe(true);
    expect(audit.fromStatus).toBe(OrderStatus.CANCELLED);
    expect(audit.toStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(audit.seatTotal).toBe(1);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('后台单（下单人是内部账号）：paymentExpiresAt=null，不排队超时释放', async () => {
    mount(buildOrder(), { ownerRole: UserRole.STAFF });
    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);
    expect(audit.paymentExpiresAt).toBeNull();
    const updateArg = mockPrisma.order.update.mock.calls[0][0] as { data: { paymentExpiresAt: Date | null } };
    expect(updateArg.data.paymentExpiresAt).toBeNull();
    expect(queueMocks.scheduleSeatHoldRelease).not.toHaveBeenCalled();
  });

  it('代理单（agentId 非空）：同样 paymentExpiresAt=null，不查下单人角色', async () => {
    mount(buildOrder({ agentId: 'ag-1' }), { ownerRole: UserRole.CUSTOMER });
    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);
    expect(audit.paymentExpiresAt).toBeNull();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('散客单（下单人是客户）：paymentExpiresAt=now+30min 并重新入队超时释放', async () => {
    mount(buildOrder(), { ownerRole: UserRole.CUSTOMER });
    const before = Date.now();
    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);
    expect(audit.paymentExpiresAt).not.toBeNull();
    const expiresAt = new Date(audit.paymentExpiresAt as string).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(30 * 60 * 1000 - 50);
    expect(expiresAt - before).toBeLessThanOrEqual(30 * 60 * 1000 + 5000);
    expect(queueMocks.scheduleSeatHoldRelease).toHaveBeenCalledWith('ord1', expect.any(Number));
  });

  it('付清过的单（到过 PAID 且实收 ≥ 应收）→ 回 PAID，履约任务重建；无代理归属不触佣金', async () => {
    mount(buildOrder({ paidAmount: new Prisma.Decimal(1000) }));
    mockPrisma.orderStatusEvent.count.mockResolvedValue(1);
    // createFulfillmentTasks：取消时被终态化的 FLIGHT_TICKETING 视为不存在 → 重建 PENDING。
    mockPrisma.orderItem.findMany.mockResolvedValue([
      {
        id: 'item1',
        kind: OrderItemKind.FLIGHT,
        bundleId: null,
        fulfillmentTasks: [{ type: 'FLIGHT_TICKETING', status: 'CANCELLED' }],
      },
    ]);

    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);

    expect(audit.toStatus).toBe(OrderStatus.PAID);
    expect(audit.paymentExpiresAt).toBeNull();
    expect(audit.commissionsReaccrued).toBe(false);
    expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: OrderStatus.PAID }) }),
    );
    expect(mockPrisma.fulfillmentTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderItemId: 'item1', type: 'FLIGHT_TICKETING', status: 'PENDING' }),
      }),
    );
    // 无代理归属 → 不会触达佣金计提，也没有可恢复的冲销记录。
    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
    expect(audit.commissionsReaccrued).toBe(false);
    expect(audit.commissionsReaccruedCny).toBe(0);
  });

  it('到过 PAID 但实收不足应收 → 回待支付而非已支付', async () => {
    mount(buildOrder({ paidAmount: new Prisma.Decimal(500) }));
    mockPrisma.orderStatusEvent.count.mockResolvedValue(1);
    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);
    expect(audit.toStatus).toBe(OrderStatus.PENDING_PAYMENT);
  });
});

// ── 佣金恢复计提（2026-09-11 拍板：恢复的单佣金也算）────────────────────────────
type CommissionRowOverrides = Partial<{
  id: string;
  agentId: string;
  productKind: string;
  chainDepth: number;
  baseAmount: number;
  rate: number;
  amount: number;
  status: string;
  settlementId: string | null;
  createdAt: Date;
}>;

/** 一条 CommissionRecord 行（默认：卖家代理 FLIGHT 档、取消时被翻成 REVERSED 的正数死行）。 */
function commissionRow(o: CommissionRowOverrides = {}) {
  return {
    id: o.id ?? 'cr-dead-1',
    agentId: o.agentId ?? 'ag-1',
    productKind: o.productKind ?? 'FLIGHT',
    chainDepth: o.chainDepth ?? 0,
    baseAmount: new Prisma.Decimal(o.baseAmount ?? 1000),
    rate: new Prisma.Decimal(o.rate ?? 0.05),
    amount: new Prisma.Decimal(o.amount ?? 50),
    status: o.status ?? 'REVERSED',
    settlementId: o.settlementId ?? null,
    createdAt: o.createdAt ?? PAST,
  };
}

/** 装配一张付清过的代理单（回 PAID），并给出本单现有的佣金记录。 */
function mountPaidAgentOrder(rows: ReturnType<typeof commissionRow>[], orderOverrides: Record<string, unknown> = {}) {
  mount(buildOrder({ agentId: 'ag-1', paidAmount: new Prisma.Decimal(1000), ...orderOverrides }));
  mockPrisma.orderStatusEvent.count.mockResolvedValue(1);
  // createFulfillmentTasks / createCommissionsForOrder 共用的 orderItem.findMany：一条 FLIGHT 行。
  mockPrisma.orderItem.findMany.mockResolvedValue([
    { id: 'item1', kind: OrderItemKind.FLIGHT, bundleId: null, fulfillmentTasks: [] },
  ]);
  mockPrisma.commissionRecord.findMany.mockResolvedValue(rows);
  let seq = 0;
  mockPrisma.commissionRecord.create.mockImplementation(async () => ({ id: `cr-new-${++seq}` }));
}

const createdCommissionRows = () =>
  mockPrisma.commissionRecord.create.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);

describe('restoreCancelledOrder · 佣金恢复计提', () => {
  it('代理单回 PAID：取消时冲销的每档每级各建一条等额 ACCRUED 记录，冲销记录不动，记审计', async () => {
    mountPaidAgentOrder([
      commissionRow({ id: 'cr-dead-seller', chainDepth: 0, amount: 50 }),
      commissionRow({ id: 'cr-dead-parent', agentId: 'ag-parent', chainDepth: 1, amount: 20 }),
    ]);

    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);

    expect(audit.toStatus).toBe(OrderStatus.PAID);
    expect(audit.commissionsReaccrued).toBe(true);
    expect(audit.commissionsReaccruedCny).toBe(70);

    const created = createdCommissionRows();
    expect(created).toHaveLength(2);
    expect(created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'ag-1', chainDepth: 0, status: 'ACCRUED', settlementId: null }),
        expect.objectContaining({ agentId: 'ag-parent', chainDepth: 1, status: 'ACCRUED', settlementId: null }),
      ]),
    );
    expect(created.map((d) => Number(String(d.amount))).sort()).toEqual([20, 50]);
    // 冲销记录原样保留：不翻状态、不改金额
    expect(mockPrisma.commissionRecord.update).not.toHaveBeenCalled();

    // 审计：哪条死行 → 哪条新记录
    const auditCalls = mockPrisma.auditLog.create.mock.calls.map(
      (c) => (c[0] as { data: { action: string; after: Record<string, unknown> } }).data,
    );
    const reaccrual = auditCalls.find((a) => a.action === 'COMMISSION_REACCRUED_ON_RESTORE');
    expect(reaccrual).toBeDefined();
    expect(reaccrual!.after.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromRecordId: 'cr-dead-seller', newRecordId: expect.stringMatching(/^cr-new-/) })]),
    );

    // 流水 detail 记下真实结果（回放时原样带回）
    const updateArg = mockPrisma.order.update.mock.calls[0][0] as { data: { adjustments: Array<{ type: string; detail: Record<string, unknown> }> } };
    const entry = updateArg.data.adjustments.find((e) => e.type === ORDER_RESTORED_ADJUSTMENT_TYPE);
    expect(entry?.detail).toMatchObject({ commissionsReaccrued: true, commissionsReaccruedCny: 70 });
  });

  it('已结算的佣金不动：原 SETTLED 记录与负数补偿行都不碰、不新建，只给 warnings 提醒财务', async () => {
    mountPaidAgentOrder([
      commissionRow({ id: 'cr-settled', status: 'SETTLED', settlementId: 'st-1', amount: 50 }),
      commissionRow({ id: 'cr-comp', status: 'REVERSED', amount: -50, baseAmount: -1000 }),
    ]);

    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);

    expect(audit.toStatus).toBe(OrderStatus.PAID);
    expect(audit.commissionsReaccrued).toBe(false);
    expect(audit.commissionsReaccruedCny).toBe(0);
    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
    expect(mockPrisma.commissionRecord.update).not.toHaveBeenCalled();
    expect(audit.warnings.some((w) => w.includes('已结算') && w.includes('请财务'))).toBe(true);
  });

  it('幂等：该档已有存活的 ACCRUED 记录（此前已恢复过）→ 不再新建', async () => {
    mountPaidAgentOrder([
      commissionRow({ id: 'cr-dead-1', status: 'REVERSED', amount: 50 }),
      commissionRow({ id: 'cr-live', status: 'ACCRUED', amount: 50, createdAt: new Date() }),
    ]);

    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);

    expect(audit.commissionsReaccrued).toBe(false);
    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
    expect(audit.warnings).toEqual([]);
  });

  it('再次取消后再次恢复：两条死行只从最近一条复制一份，绝不叠加', async () => {
    mountPaidAgentOrder([
      commissionRow({ id: 'cr-dead-old', amount: 50, createdAt: new Date(PAST.getTime() - 1000) }),
      commissionRow({ id: 'cr-dead-new', amount: 50, createdAt: PAST }),
    ]);

    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);

    expect(audit.commissionsReaccruedCny).toBe(50);
    expect(createdCommissionRows()).toHaveLength(1);
    const reaccrual = mockPrisma.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: { action: string; after: { records: Array<{ fromRecordId: string }> } } }).data)
      .find((a) => a.action === 'COMMISSION_REACCRUED_ON_RESTORE');
    expect(reaccrual?.after.records[0]?.fromRecordId).toBe('cr-dead-new');
  });

  it('同 requestToken 回放：带回流水里记的恢复结果，不再新建记录', async () => {
    mount(
      buildOrder({
        agentId: 'ag-1',
        status: OrderStatus.PAID,
        adjustments: [
          {
            type: ORDER_RESTORED_ADJUSTMENT_TYPE,
            label: '恢复已取消订单',
            amountCny: 0,
            at: new Date().toISOString(),
            by: 'admin-1',
            requestToken: TOKEN,
            detail: {
              fromStatus: 'CANCELLED',
              toStatus: 'PAID',
              seatTotal: 1,
              oversold: false,
              commissionsReaccrued: true,
              commissionsReaccruedCny: 70,
            },
          },
        ],
      }),
    );
    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);
    expect(audit.replayed).toBe(true);
    expect(audit.commissionsReaccrued).toBe(true);
    expect(audit.commissionsReaccruedCny).toBe(70);
    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
    expect(mockPrisma.commissionRecord.findMany).not.toHaveBeenCalled();
  });

  it('代理单回待支付：不恢复佣金，只在确有冲销记录时提示「收款转已支付时自动恢复」', async () => {
    mount(buildOrder({ agentId: 'ag-1' }));
    mockPrisma.commissionRecord.count.mockResolvedValue(1);

    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);

    expect(audit.toStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(audit.commissionsReaccrued).toBe(false);
    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
    expect(audit.warnings.some((w) => w.includes('自动恢复计提'))).toBe(true);
  });

  it('代理单回待支付且本无冲销记录（从未付过款）：不提示佣金', async () => {
    mount(buildOrder({ agentId: 'ag-1' }));
    mockPrisma.commissionRecord.count.mockResolvedValue(0);
    const { audit } = await service.restoreCancelledOrder('ord1', { requestToken: TOKEN, allowOversell: false }, ADMIN);
    expect(audit.warnings.some((w) => w.includes('佣金'))).toBe(false);
  });
});

describe('恢复到待支付后的收款 / force 老路径 · 佣金', () => {
  const REQ = { userId: 'admin-1', role: UserRole.ADMIN, actorType: 'USER' as const };

  function mountPendingRestoredOrder(o: { restoredAt: Date; lastCancelAt: Date | null; status?: OrderStatus }) {
    mount(
      buildOrder({
        agentId: 'ag-1',
        status: o.status ?? OrderStatus.PENDING_PAYMENT,
        paidAmount: new Prisma.Decimal(1000),
        adjustments: [
          {
            type: ORDER_RESTORED_ADJUSTMENT_TYPE,
            label: '恢复已取消订单',
            amountCny: 0,
            at: o.restoredAt.toISOString(),
            by: 'admin-1',
            requestToken: '11111111-0000-4000-8000-000000000001',
            detail: { fromStatus: 'CANCELLED', toStatus: 'PENDING_PAYMENT' },
          },
        ],
      }),
    );
    mockPrisma.orderStatusEvent.findFirst.mockResolvedValue(
      o.lastCancelAt ? { createdAt: o.lastCancelAt } : null,
    );
    mockPrisma.orderItem.findMany.mockResolvedValue([
      { id: 'item1', kind: OrderItemKind.FLIGHT, bundleId: null, fulfillmentTasks: [] },
    ]);
    mockPrisma.commissionRecord.findMany.mockResolvedValue([commissionRow({ amount: 50 })]);
  }

  it('恢复到待支付 → 之后正常收款推 PAID：曾被恢复且此后未再取消 → 恢复计提', async () => {
    const restoredAt = new Date();
    mountPendingRestoredOrder({ restoredAt, lastCancelAt: new Date(restoredAt.getTime() - 3600_000) });

    await service.updateStatus('ord1', OrderStatus.PAID, REQ, '收款到账');

    expect(createdCommissionRows()).toEqual([
      expect.objectContaining({ agentId: 'ag-1', status: 'ACCRUED', settlementId: null }),
    ]);
  });

  it('恢复后又被取消（取消事件晚于恢复留痕）→ admin force 复活不恢复佣金', async () => {
    const restoredAt = new Date(Date.now() - 2 * 3600_000);
    mountPendingRestoredOrder({
      restoredAt,
      lastCancelAt: new Date(restoredAt.getTime() + 3600_000),
      status: OrderStatus.CANCELLED,
    });

    await service.updateStatus('ord1', OrderStatus.PAID, REQ, '误操作复活', true);

    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
  });

  it('从未恢复过的已取消单 admin force → PAID：老路径不变，不重复付佣', async () => {
    mount(buildOrder({ agentId: 'ag-1', paidAmount: new Prisma.Decimal(1000) }));
    mockPrisma.orderItem.findMany.mockResolvedValue([
      { id: 'item1', kind: OrderItemKind.FLIGHT, bundleId: null, fulfillmentTasks: [] },
    ]);
    mockPrisma.commissionRecord.findMany.mockResolvedValue([commissionRow({ amount: 50 })]);

    await service.updateStatus('ord1', OrderStatus.PAID, REQ, '误操作复活', true);

    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
    expect(mockPrisma.orderStatusEvent.findFirst).not.toHaveBeenCalled();
  });
});
