/**
 * 代理售后自助（出票前任意时候：改期 / 换酒店 / 单住拼住）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 口径（2026-09-13 拍板）：
 *   1. computeAgentAfterSalesGate 纯函数：改期口径看票（已出票 / 开票位 / PNR·票号），住宿口径不看票。
 *   2. rescheduleOrderItemAsAgent / reschedulePassengersAsAgent：只有代理进得来；归属（自家含下级）
 *      与未出票闸在入口判，运营专属字段（feeCny / allowDepartedTarget …）根本不透传。
 *   3. rescheduleOrderItem 带 agentAfterSales 旗子：差价在事务锁内按 quoteFlightCorrectionDelta
 *      ×本行人数算（可正可负），请求体金额不认。
 *   4. swapItemHotel 代理通道：同星级放行、差价按系统口径算（单独酒店行 = 挂牌价差 × 晚数 × 间数；
 *      套餐行 = 指定酒店加价差 × 占座人数）；跨星级 / 入住日已过 / 非自家单一律拒。
 *   5. setPassengerSingleRoom：单住 ↔ 拼住来回一次金额守恒（+单房差 FEE、−单房差 DISCOUNT），
 *      计费房数同步升降；结算价已锁拒；幂等短路；代理限自家单。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';

const { mockPrisma, mockGetHotelOversellCapRooms } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    // 代理归属判定（getDescendantAgentIds 的递归 CTE）。事务内的行锁走各测试自己的 tx 对象。
    $queryRaw: vi.fn(),
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    passenger: { findMany: vi.fn() },
    flightSchedule: { findUnique: vi.fn() },
    flightSeatClass: { findFirst: vi.fn() },
    hotelRoomType: { findUnique: vi.fn(), findMany: vi.fn() },
    bundle: { findUnique: vi.fn() },
  },
  mockGetHotelOversellCapRooms: vi.fn(),
}));
vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
// 房量闸的超售上限读的是系统设置表：这里固定成常数，其余房控符号沿用真实实现。
vi.mock('../hotel-control/hotel-control.service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../hotel-control/hotel-control.service.js')>();
  return { ...actual, getHotelOversellCapRooms: mockGetHotelOversellCapRooms };
});

import {
  AGENT_AFTER_SALES_REASON,
  computeAgentAfterSalesGate,
  OrderService,
} from './orders.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { BadRequestError, ConflictError, ForbiddenError } from '../../lib/errors.js';

const service = new OrderService();
const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);

const STAFF = { userId: 'u-staff', role: UserRole.STAFF } as const;
const AGENT = { userId: 'u-agent', role: UserRole.AGENT, agentId: 'ag-1' } as const;

/** 代理自家的、还没出票的一张单（入口闸读的形状：归属 + 状态 + 开票位 + 乘客票号）。 */
const ownOpenOrder = (over: Record<string, unknown> = {}) => ({
  userId: null,
  agentId: 'ag-1',
  createdAt: new Date(),
  status: OrderStatus.PAID,
  deletedAt: null,
  outboundInvoiced: false,
  returnInvoiced: false,
  systemInvoiced: false,
  settlementLocked: false,
  passengers: [{ pnr: null, eticketNumber: null }],
  ...over,
});

/** serializeOrder 要吃的最小完整订单（各成功路径末尾回读用）。 */
const finalOrderStub = () => ({
  id: 'o1',
  orderNumber: 'FTM-1',
  status: OrderStatus.PAID,
  createdAt: new Date(),
  subtotal: dec(1000),
  taxesAndFees: dec(0),
  discountTotal: dec(0),
  total: dec(1000),
  paidAmount: dec(0),
  prepaymentOffset: dec(0),
  adjustmentCny: 0,
  items: [],
  passengers: [],
  payments: [],
  refunds: [],
  reminders: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  // 默认：代理树里只有自己（归属判定放行 ag-1 的单）。
  mockPrisma.$queryRaw.mockResolvedValue([{ id: 'ag-1' }]);
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(finalOrderStub());
  mockGetHotelOversellCapRooms.mockResolvedValue(3);
});

// ── 1. 纯函数：售后自助闸 ─────────────────────────────────────────────────
describe('computeAgentAfterSalesGate', () => {
  it('未出票的占座单 → 改期与住宿两种口径都放行', () => {
    const order = ownOpenOrder();
    expect(computeAgentAfterSalesGate(order, 'FLIGHT_RESCHEDULE')).toEqual({ open: true, reason: null });
    expect(computeAgentAfterSalesGate(order, 'HOTEL')).toEqual({ open: true, reason: null });
  });

  it.each([
    ['状态已出票', { status: OrderStatus.TICKETED }, AGENT_AFTER_SALES_REASON.TICKETED],
    ['任一开票位已开', { returnInvoiced: true }, AGENT_AFTER_SALES_REASON.INVOICED],
    ['任一乘客已有 PNR', { passengers: [{ pnr: 'ABC123', eticketNumber: null }] }, AGENT_AFTER_SALES_REASON.BOOKED],
    ['任一乘客已有票号', { passengers: [{ pnr: null, eticketNumber: '999-1' }] }, AGENT_AFTER_SALES_REASON.BOOKED],
  ])('%s → 改期关闭、住宿口径不受影响', (_label, over, reason) => {
    const order = ownOpenOrder(over);
    expect(computeAgentAfterSalesGate(order, 'FLIGHT_RESCHEDULE')).toEqual({ open: false, reason });
    expect(computeAgentAfterSalesGate(order, 'HOTEL').open).toBe(true);
  });

  it('已完成 / 取消族 / 回收站 → 两种口径都关闭', () => {
    expect(computeAgentAfterSalesGate(ownOpenOrder({ status: OrderStatus.COMPLETED }), 'HOTEL').open).toBe(false);
    expect(computeAgentAfterSalesGate(ownOpenOrder({ status: OrderStatus.CANCELLED }), 'FLIGHT_RESCHEDULE').open).toBe(false);
    expect(computeAgentAfterSalesGate(ownOpenOrder({ deletedAt: new Date() }), 'HOTEL')).toEqual({
      open: false,
      reason: AGENT_AFTER_SALES_REASON.DELETED,
    });
  });
});

// ── 2. 改期入口：只有代理进得来，归属 + 未出票在入口判，运营字段不透传 ─────────
describe('rescheduleOrderItemAsAgent / reschedulePassengersAsAgent · 入口闸', () => {
  const body = { orderItemId: 'item-1', newScheduleId: 'sch-new', note: '客人改行程' };

  it('运营走这个入口 → 403（运营有自己的改期通道）', async () => {
    await expect(service.rescheduleOrderItemAsAgent('o1', body, STAFF)).rejects.toThrow('本入口仅供代理使用');
  });

  it('代理改别人家的单 → 归属闸 403，不进事务', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownOpenOrder({ agentId: 'ag-other' }));
    await expect(service.rescheduleOrderItemAsAgent('o1', body, AGENT)).rejects.toThrow('无权查看该订单');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['已出票', { status: OrderStatus.TICKETED }, AGENT_AFTER_SALES_REASON.TICKETED],
    ['已开票', { systemInvoiced: true }, AGENT_AFTER_SALES_REASON.INVOICED],
    ['已订座', { passengers: [{ pnr: 'PNR001', eticketNumber: null }] }, AGENT_AFTER_SALES_REASON.BOOKED],
  ])('代理自家单但%s → 403 指路改单申请，不进事务', async (_label, over, reason) => {
    mockPrisma.order.findUnique.mockResolvedValue(ownOpenOrder(over));
    const err = await service.rescheduleOrderItemAsAgent('o1', body, AGENT).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe(reason);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('代理自家未出票单 → 放行到 rescheduleOrderItem，只带 orderItemId/newScheduleId/note + 售后旗子', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownOpenOrder());
    const spy = vi
      .spyOn(service, 'rescheduleOrderItem')
      .mockResolvedValue({} as Awaited<ReturnType<OrderService['rescheduleOrderItem']>>);
    await service.rescheduleOrderItemAsAgent('o1', body, AGENT);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({
      orderItemId: 'item-1',
      newScheduleId: 'sch-new',
      note: '客人改行程',
      agentAfterSales: true,
    });
    expect(spy.mock.calls[0][2]).toEqual({ userId: 'u-agent', role: UserRole.AGENT });
  });

  it('按人改期：代理自家未出票单 → 放行到 reschedulePassengers，feeCny / allowDepartedTarget 不透传', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownOpenOrder());
    const spy = vi
      .spyOn(service, 'reschedulePassengers')
      .mockResolvedValue({} as Awaited<ReturnType<OrderService['reschedulePassengers']>>);
    await service.reschedulePassengersAsAgent(
      'o1',
      { passengerIds: ['p1'], orderItemId: 'item-1', newScheduleId: 'sch-new', requestToken: 'tok-12345678' },
      AGENT,
    );
    expect(spy.mock.calls[0][1]).toEqual({
      passengerIds: ['p1'],
      orderItemId: 'item-1',
      newScheduleId: 'sch-new',
      note: undefined,
      roomSplit: undefined,
      requestToken: 'tok-12345678',
      agentAfterSales: true,
    });
  });

  it('按人改期：已出票 → 拆单之前就拒（不会留下一张多余的新单）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownOpenOrder({ status: OrderStatus.TICKETED }));
    const spy = vi.spyOn(service, 'reschedulePassengers');
    await expect(
      service.reschedulePassengersAsAgent(
        'o1',
        { passengerIds: ['p1'], orderItemId: 'item-1', newScheduleId: 'sch-new', requestToken: 'tok-12345678' },
        AGENT,
      ),
    ).rejects.toThrow(AGENT_AFTER_SALES_REASON.TICKETED);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── 3. 改期事务：代理售后差价在锁内按系统口径算 ───────────────────────────
describe('rescheduleOrderItem · agentAfterSales 系统差价', () => {
  const OLD_DEPARTURE = new Date('2026-10-01T02:00:00.000Z');
  const NEW_DEPARTURE = new Date('2026-10-03T02:00:00.000Z');

  function mountReschedule(opts: { passengers?: Array<{ pnr?: string | null }> } = {}) {
    const passengers = (opts.passengers ?? [{ pnr: null }]).map((p) => ({
      pnr: p.pnr ?? null,
      eticketNumber: null,
      gender: 'M' as const,
    }));
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'o1' }]),
      $executeRaw: vi.fn(async () => 1),
      order: {
        findUnique: vi.fn(async () => ({
          id: 'o1',
          status: OrderStatus.PAID,
          deletedAt: null,
          adjustmentCny: 0,
          adjustments: null,
          createdAt: new Date(),
          outboundInvoiced: false,
          returnInvoiced: false,
          systemInvoiced: false,
          settlementLocked: false,
        })),
        update: vi.fn(),
      },
      orderItem: {
        findUnique: vi.fn(async () => ({
          id: 'item-1',
          orderId: 'o1',
          kind: OrderItemKind.FLIGHT,
          quantity: 2,
          bundleId: null,
          flightScheduleId: 'sch-old',
          flightCabin: 'ECONOMY',
          metadata: null,
          unitPrice: dec(1000),
          flightSchedule: { flightId: 'fl-1', departureTime: OLD_DEPARTURE, departureTz: 'Asia/Shanghai' },
        })),
        findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
          const where = args?.where ?? {};
          if (where.hotelCheckIn) return [];
          if (where.kind === OrderItemKind.FLIGHT) {
            return [
              {
                id: 'item-1',
                flightScheduleId: 'sch-new',
                metadata: null,
                flightSchedule: { departureTime: NEW_DEPARTURE, departureTz: 'Asia/Shanghai' },
              },
            ];
          }
          return [];
        }),
        update: vi.fn(async () => ({ id: 'item-1' })),
      },
      passenger: {
        findMany: vi.fn(async () => passengers),
        updateMany: vi.fn(async () => ({ count: passengers.length })),
      },
      flightSeatClass: { findFirst: vi.fn(async () => ({ id: 'sc-1' })) },
      flightSchedule: {
        findUnique: vi.fn(async () => ({
          id: 'sch-new',
          flightId: 'fl-1',
          departureTime: NEW_DEPARTURE,
          departureTz: 'Asia/Shanghai',
        })),
      },
      hotelRoomType: { findMany: vi.fn(async () => []) },
      seatLock: { aggregate: vi.fn(async () => ({ _sum: { qty: 0 } })) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    mockPrisma.flightSchedule.findUnique.mockResolvedValue(null);
    return tx;
  }

  const AGENT_INPUT = { orderItemId: 'item-1', newScheduleId: 'sch-new', agentAfterSales: true } as const;

  it.each([
    ['改到更贵班次', 1200, 400],
    ['改到更便宜班次', 800, -400],
    ['同价班次', 1000, 0],
  ])('%s → 差价 = (目标建单口径单价 − 成交单价) × 人数 = %i', async (_label, toPrice, expectedFee) => {
    vi.spyOn(PricingService.prototype, 'calculatePrice').mockResolvedValue({
      averageUnitPrice: toPrice,
    } as unknown as Awaited<ReturnType<PricingService['calculatePrice']>>);
    const tx = mountReschedule();

    const { audit } = await service.rescheduleOrderItem(
      'o1',
      // 请求体里就算塞了 feeCny 也不认：代理售后的差价只认系统算的那份。
      { ...AGENT_INPUT, feeCny: 99999 } as Parameters<OrderService['rescheduleOrderItem']>[1],
      { userId: 'u-agent', role: UserRole.AGENT },
    );

    expect(audit.toScheduleId).toBe('sch-new');
    expect(audit.feeCny).toBe(expectedFee);
    const adjustmentWrite = tx.order.update.mock.calls.find(
      (c) => (c[0] as { data?: { adjustmentCny?: unknown } }).data?.adjustmentCny !== undefined,
    );
    if (expectedFee === 0) {
      expect(adjustmentWrite).toBeUndefined();
    } else {
      expect((adjustmentWrite![0] as { data: { adjustmentCny: number } }).data.adjustmentCny).toBe(expectedFee);
    }
  });

  it('锁内复查：拿到锁时乘客已有 PNR → 403 指路改单申请，一个座都不搬', async () => {
    vi.spyOn(PricingService.prototype, 'calculatePrice').mockResolvedValue({
      averageUnitPrice: 1000,
    } as unknown as Awaited<ReturnType<PricingService['calculatePrice']>>);
    const tx = mountReschedule({ passengers: [{ pnr: 'PNR001' }] });
    await expect(
      service.rescheduleOrderItem('o1', { ...AGENT_INPUT }, { userId: 'u-agent', role: UserRole.AGENT }),
    ).rejects.toThrow(AGENT_AFTER_SALES_REASON.BOOKED);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('代理不带任何旗子直接调 → 仍旧 403（运营闸没被削弱）', async () => {
    mountReschedule();
    await expect(
      service.rescheduleOrderItem(
        'o1',
        { orderItemId: 'item-1', newScheduleId: 'sch-new' },
        { userId: 'u-agent', role: UserRole.AGENT },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ── 4. 换酒店：代理通道差价按系统口径算 ────────────────────────────────────
describe('swapItemHotel · 代理系统差价', () => {
  const FUTURE_IN = new Date('2026-12-01T00:00:00.000Z');
  const FUTURE_OUT = new Date('2026-12-03T00:00:00.000Z');

  function mountTx() {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'o1' }]),
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'o1',
          orderNumber: 'FTM-1',
          status: OrderStatus.PAID,
          deletedAt: null,
          adjustmentCny: 0,
          adjustments: [],
          roomAssignment: null,
          total: dec(1000),
          createdAt: new Date(),
          outboundInvoiced: false,
          returnInvoiced: false,
          systemInvoiced: false,
          settlementLocked: false,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      orderItem: { update: vi.fn().mockResolvedValue({}) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    return tx;
  }

  function mountRoomTypes(opts: { newStar?: number; newBasePrice?: number; newSurcharge?: number } = {}) {
    mockPrisma.hotelRoomType.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'rt-old'
        ? {
            id: 'rt-old',
            name: '大床房',
            hotelId: 'h1',
            hotel: { name: '海湾酒店', starRating: 4, randomTierPlaceholder: null },
          }
        : {
            id: 'rt-new',
            name: '海景房',
            hotelId: 'h1',
            basePrice: opts.newBasePrice != null ? dec(opts.newBasePrice) : null,
            costPriceCny: null,
            costPriceVnd: null,
            costFxName: null,
            costPeriods: [],
            hotel: {
              name: '海湾酒店',
              isActive: true,
              starRating: opts.newStar ?? 4,
              intlFiveStar: false,
              randomTierPlaceholder: null,
              designationSurchargeCnyPerPerson: opts.newSurcharge ?? 0,
            },
          },
    );
  }

  const hotelRow = (over: Record<string, unknown> = {}) => ({
    id: 'i1',
    orderId: 'o1',
    kind: OrderItemKind.HOTEL,
    description: '旧描述',
    quantity: 2,
    hotelRoomTypeId: 'rt-old',
    randomStarTier: null,
    bundleId: null,
    hotelCheckIn: FUTURE_IN,
    hotelCheckOut: FUTURE_OUT,
    roomsBilled: 1,
    unitPrice: dec(500),
    unitCostCny: null,
    totalCostCny: null,
    metadata: null,
    ...over,
  });

  // 请求体里的差价对代理一律不认（下面各例都塞 9999 进去）。
  const body = { newHotelRoomTypeId: 'rt-new', feeCny: 9999, feeLabel: '乱填' };

  it('单独酒店行 · 同星级更贵房型 → 差价 = (挂牌价 − 成交单价) × 晚数 × 间数，费用名系统缺省', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownOpenOrder());
    mockPrisma.orderItem.findUnique.mockResolvedValue(hotelRow());
    mountRoomTypes({ newBasePrice: 800 });
    const tx = mountTx();

    const { audit } = await service.swapItemHotel('o1', 'i1', body, AGENT);

    expect(audit.feeCny).toBe(600); // (800 − 500) × 2 晚 × 1 间
    const call = tx.order.update.mock.calls[0][0] as {
      data: { adjustmentCny: number; adjustments: Array<{ type: string; label: string; amountCny: number }> };
    };
    expect(call.data.adjustmentCny).toBe(600);
    expect(call.data.adjustments[0]).toMatchObject({ type: 'HOTEL_SWAP_FEE', label: '换酒店差价', amountCny: 600 });
  });

  it('套餐行 · 同星级换到指定加价更高的店 → 差价 = 加价差 × 占座人数，留痕改写成新店', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownOpenOrder());
    mockPrisma.orderItem.findUnique.mockResolvedValue(
      hotelRow({
        kind: OrderItemKind.BUNDLE,
        bundleId: 'b1',
        metadata: { adultCount: 2, designatedHotel: { surchargeCnyPerPerson: 100, pax: 2, totalCny: 200 } },
      }),
    );
    mockPrisma.bundle.findUnique.mockResolvedValue({ id: 'b1', name: '四星套餐', settlementTier: null });
    mountRoomTypes({ newSurcharge: 250 });
    const tx = mountTx();

    const { audit } = await service.swapItemHotel('o1', 'i1', body, AGENT);

    expect(audit.feeCny).toBe(300); // (250 − 100) × 2 人
    const itemUpdate = tx.orderItem.update.mock.calls[0][0] as {
      data: { metadata: { designatedHotel: { surchargeCnyPerPerson: number; pax: number; totalCny: number } } };
    };
    expect(itemUpdate.data.metadata.designatedHotel).toMatchObject({ surchargeCnyPerPerson: 250, pax: 2, totalCny: 500 });
  });

  it('跨星级 → 400 指路改档申请，一个字都不落库', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownOpenOrder());
    mockPrisma.orderItem.findUnique.mockResolvedValue(hotelRow());
    mountRoomTypes({ newStar: 5, newBasePrice: 800 });
    const tx = mountTx();
    await expect(service.swapItemHotel('o1', 'i1', body, AGENT)).rejects.toThrow(
      '代理只能换同星级酒店，升降星请提交改档申请或联系运营',
    );
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('入住日已过 → 400，交运营处理', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownOpenOrder());
    mockPrisma.orderItem.findUnique.mockResolvedValue(
      hotelRow({ hotelCheckIn: new Date('2020-01-01T00:00:00.000Z'), hotelCheckOut: new Date('2020-01-03T00:00:00.000Z') }),
    );
    mountRoomTypes({ newBasePrice: 800 });
    const err = await service.swapItemHotel('o1', 'i1', body, AGENT).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as Error).message).toBe(AGENT_AFTER_SALES_REASON.CHECKED_IN);
  });

  it('运营同一请求 → 手填差价照旧生效（系统计价只针对代理通道）', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(hotelRow());
    mountRoomTypes({ newBasePrice: 800 });
    mountTx();
    const { audit } = await service.swapItemHotel('o1', 'i1', body, STAFF);
    expect(audit.feeCny).toBe(9999);
  });
});

// ── 5. 单住 ↔ 拼住：金额守恒 / 房数同步 / 锁价拒 / 归属 ───────────────────
describe('setPassengerSingleRoom', () => {
  /** 2 成人套餐、单房差 ¥300/晚 × 2 晚、房型最多 2 成人：拼住 1 间 ↔ 一人单住 2 间。 */
  function mountToggle(opts: { singleRoomNow: boolean; settlementLocked?: boolean; withBundle?: boolean }) {
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'o1',
          orderNumber: 'FTM-1',
          status: OrderStatus.PAID,
          deletedAt: null,
          adjustments: [],
          settlementLocked: opts.settlementLocked ?? false,
          outboundInvoiced: false,
          returnInvoiced: false,
          systemInvoiced: false,
        },
      ]),
      orderItem: {
        findUnique: vi.fn(async () => null),
        findMany: vi.fn(async () =>
          opts.withBundle === false
            ? []
            : [
                {
                  id: 'b-row',
                  metadata: {
                    adultCount: 2,
                    addOns: { singleSupplementCnyPerNight: 300, nights: 2, adultCount: 2, childCount: 0, infantCount: 0 },
                  },
                  roomsBilled: dec(opts.singleRoomNow ? 2 : 1),
                  hotelRoomTypeId: null,
                  hotelCheckIn: null,
                  hotelCheckOut: null,
                  randomStarTier: null,
                  unitCostCny: null,
                  bundle: {
                    hotelRoomTypeId: 'rt-b',
                    hotelRoomType: {
                      maxAdults: 2,
                      maxChildren: 1,
                      costPriceCny: null,
                      costPriceVnd: null,
                      costFxName: null,
                      costPeriods: [],
                    },
                  },
                },
              ],
        ),
        count: vi.fn(async () => (opts.withBundle === false ? 1 : 0)),
        update: vi.fn(async () => ({})),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: `row-${created.length}` };
        }),
        aggregate: vi.fn(async () => ({ _sum: { amount: dec(1000 + (opts.singleRoomNow ? -600 : 600)) } })),
      },
      passenger: {
        findUnique: vi.fn(async () => ({
          id: 'p1',
          orderId: 'o1',
          fullName: 'PAX ONE',
          singleRoom: opts.singleRoomNow,
          passengerType: 'ADULT',
        })),
        update: vi.fn(async () => ({})),
        // 翻转之后的单住人数：改单住 → 1，改拼住 → 0
        count: vi.fn(async () => (opts.singleRoomNow ? 0 : 1)),
        findMany: vi.fn(async () => [{ gender: 'M' }, { gender: 'M' }]),
      },
      order: { update: vi.fn(async () => ({})) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    return { tx, created };
  }

  it('拼住 → 单住 → 拼住：一进一出金额守恒，计费房数 1 → 2 → 1', async () => {
    const on = mountToggle({ singleRoomNow: false });
    const onResult = await service.setPassengerSingleRoom(
      'o1',
      'p1',
      { singleRoom: true, requestToken: 'tok-on-12345678' },
      STAFF,
    );
    expect(onResult.audit).toMatchObject({
      amountCny: 600,
      perNightCny: 300,
      nights: 2,
      before: { singleRoom: false, roomsBilled: 1 },
      after: { singleRoom: true, roomsBilled: 2 },
    });
    expect(on.created[0]).toMatchObject({
      kind: OrderItemKind.FEE,
      passengerId: 'p1',
      idempotencyKey: 'tok-on-12345678',
      amount: dec(600),
    });
    expect(on.tx.orderItem.update).toHaveBeenCalledWith({ where: { id: 'b-row' }, data: { roomsBilled: dec(2) } });
    expect(on.tx.passenger.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { singleRoom: true } });

    const off = mountToggle({ singleRoomNow: true });
    const offResult = await service.setPassengerSingleRoom(
      'o1',
      'p1',
      { singleRoom: false, requestToken: 'tok-off-12345678' },
      STAFF,
    );
    expect(offResult.audit).toMatchObject({
      amountCny: -600,
      before: { singleRoom: true, roomsBilled: 2 },
      after: { singleRoom: false, roomsBilled: 1 },
    });
    expect(off.created[0]).toMatchObject({ kind: OrderItemKind.DISCOUNT, passengerId: 'p1', amount: dec(-600) });
    expect(off.tx.orderItem.update).toHaveBeenCalledWith({ where: { id: 'b-row' }, data: { roomsBilled: dec(1) } });

    // 守恒：两条钱行合计 0，订单总额回到起点。
    const sum = Number(on.created[0].amount as Prisma.Decimal) + Number(off.created[0].amount as Prisma.Decimal);
    expect(sum).toBe(0);
    type LogWrite = { data: { adjustments: Array<{ type: string; amountCny: number }> } };
    const logOn = (on.tx.order.update.mock.calls[0][0] as LogWrite).data.adjustments[0];
    const logOff = (off.tx.order.update.mock.calls[0][0] as LogWrite).data.adjustments[0];
    expect(logOn).toMatchObject({ type: 'ROOM_SUPPLEMENT', amountCny: 600 });
    expect(logOff).toMatchObject({ type: 'ROOM_SUPPLEMENT_REFUND', amountCny: -600 });
  });

  it('结算价已锁 → 409 且不翻标记、不建行', async () => {
    const { tx, created } = mountToggle({ singleRoomNow: false, settlementLocked: true });
    const err = await service
      .setPassengerSingleRoom('o1', 'p1', { singleRoom: true }, STAFF)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toContain('结算价已锁定');
    expect(tx.passenger.update).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('目标值与现值相同 → 幂等短路：不建行、audit 为 null', async () => {
    const { created } = mountToggle({ singleRoomNow: true });
    const res = await service.setPassengerSingleRoom('o1', 'p1', { singleRoom: true }, STAFF);
    expect(res.idempotent).toBe(true);
    expect(res.audit).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('纯酒店行订单 → 只改标记不动钱，warning 说明', async () => {
    const { tx, created } = mountToggle({ singleRoomNow: false, withBundle: false });
    const res = await service.setPassengerSingleRoom('o1', 'p1', { singleRoom: true }, STAFF);
    expect(created).toHaveLength(0);
    expect(tx.passenger.update).toHaveBeenCalledTimes(1);
    expect(res.warning).toContain('只改单住/拼住标记');
  });

  it('代理自家单 → 放行；别人家的单 → 403 不进事务', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownOpenOrder());
    const { created } = mountToggle({ singleRoomNow: false });
    await service.setPassengerSingleRoom('o1', 'p1', { singleRoom: true }, AGENT);
    expect(created).toHaveLength(1);

    mockPrisma.$transaction.mockClear();
    mockPrisma.order.findUnique.mockResolvedValue(ownOpenOrder({ agentId: 'ag-other' }));
    await expect(service.setPassengerSingleRoom('o1', 'p1', { singleRoom: true }, AGENT)).rejects.toThrow(
      '无权查看该订单',
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('客户 → 403', async () => {
    await expect(
      service.setPassengerSingleRoom('o1', 'p1', { singleRoom: true }, { userId: 'c', role: UserRole.CUSTOMER }),
    ).rejects.toThrow('仅运营 / 代理可自助改单');
  });
});
