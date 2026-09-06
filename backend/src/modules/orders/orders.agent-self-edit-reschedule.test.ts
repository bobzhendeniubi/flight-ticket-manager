/**
 * 代理自助纠错落到「改期事务里」的那几道闸 · 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * correctFlightSchedule 只是入口，真正搬座位、平移酒店日期的是 rescheduleOrderItem。
 * 自助旗子（selfServiceCorrection）把代理放进了这条本来只给运营的通道，所以锁内还得有闸：
 *
 *   1. 旗子确实能越过「仅运营/管理员可改期」那句话（代理带旗子进得来，不带一律 403）；
 *   2. 已订座/已出票的单，自助一律不碰（换班次会清全单 PNR/票号并翻回开票位）；
 *   3. 窗口在**锁内**再判一次（入口那次是锁外快照，中间可能已出票/已开票/跨过当天 24:00）；
 *   4. 酒店日期随出发日平移时，随机档超售上限按「代理吃标准上限、运营不闸单」分开走。
 *
 * 三条收紧都只对**代理**成立：运营走的是同一条纠错通道、带着同一面旗子，行为一字不变。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderItemKind, Prisma, UserRole } from '@prisma/client';

const { mockPrisma, mockAssertRandomTierFitWithinTx, mockAssertHotelPhysicalFitWithinTx } =
  vi.hoisted(() => ({
    mockPrisma: {
      $transaction: vi.fn(),
      $queryRaw: vi.fn(),
      order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
      orderItem: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
      passenger: { findMany: vi.fn(), updateMany: vi.fn() },
      flightSchedule: { findUnique: vi.fn() },
      flightSeatClass: { findFirst: vi.fn() },
      hotelRoomType: { findMany: vi.fn() },
    },
    mockAssertRandomTierFitWithinTx: vi.fn(),
    mockAssertHotelPhysicalFitWithinTx: vi.fn(),
  }));
vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
// 房控只替换这两处判定（其余符号沿用真实实现：星级文案、聚合归并口径都在被测路径上）。
vi.mock('../hotel-control/hotel-control.service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../hotel-control/hotel-control.service.js')>();
  return {
    ...actual,
    assertRandomTierFitWithinTx: mockAssertRandomTierFitWithinTx,
    assertHotelPhysicalFitWithinTx: mockAssertHotelPhysicalFitWithinTx,
  };
});

import { AGENT_SELF_EDIT_REASON, OrderService } from './orders.service.js';
import { BadRequestError, ForbiddenError } from '../../lib/errors.js';

const service = new OrderService();
const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);
const DAY_MS = 24 * 60 * 60 * 1000;

const AGENT = { userId: 'u-agent', role: UserRole.AGENT } as const;
const STAFF = { userId: 'u-staff', role: UserRole.STAFF } as const;

/** 纠错通道的固定入参（与 correctFlightSchedule 传给本方法的完全一致）。 */
const CORRECTION_INPUT = {
  orderItemId: 'item-1',
  newScheduleId: 'sch-new',
  feeCny: 0,
  guard: { correction: true, forbidTicketed: true },
  selfServiceCorrection: true,
} as const;

const OLD_DEPARTURE = new Date('2026-10-01T02:00:00.000Z');
const NEW_DEPARTURE = new Date('2026-10-03T02:00:00.000Z'); // 当地日 +2 天 → 酒店要平移

/** 事务内调用留痕：证明「拒了就一个座都没搬」。 */
const callTrace: string[] = [];

function mountReschedule(
  opts: {
    createdAt?: Date;
    passengers?: Array<{ pnr?: string | null; eticketNumber?: string | null }>;
    /** 挂一条随机档占房行 → 走「酒店入住日随出发日平移」那段（H3 的现场）。 */
    withRandomTierHotelRow?: boolean;
  } = {},
) {
  const passengers = (opts.passengers ?? [{ pnr: null, eticketNumber: null }]).map((p) => ({
    pnr: p.pnr ?? null,
    eticketNumber: p.eticketNumber ?? null,
    gender: 'M' as const,
  }));
  const hotelRows = opts.withRandomTierHotelRow
    ? [
        {
          id: 'hotel-item',
          description: '四星随机 · 2 晚',
          hotelRoomTypeId: null,
          randomStarTier: 4,
          hotelCheckIn: new Date('2026-10-01T00:00:00.000Z'),
          hotelCheckOut: new Date('2026-10-03T00:00:00.000Z'),
          roomsBilled: null,
        },
      ]
    : [];

  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'ord-1' }]),
    $executeRaw: vi.fn(async () => {
      callTrace.push('SEAT_MOVE');
      return 1;
    }),
    order: {
      findUnique: vi.fn(async () => ({
        id: 'ord-1',
        status: 'PAID',
        deletedAt: null,
        adjustmentCny: 0,
        adjustments: null,
        createdAt: opts.createdAt ?? new Date(),
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
        orderId: 'ord-1',
        kind: OrderItemKind.FLIGHT,
        quantity: 2,
        bundleId: null,
        flightScheduleId: 'sch-old',
        flightCabin: 'ECONOMY',
        metadata: null,
        flightSchedule: { departureTime: OLD_DEPARTURE, departureTz: 'Asia/Shanghai' },
      })),
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
        const where = args?.where ?? {};
        // 平移用的占房行（where 带 hotelCheckIn 的那一次）
        if (where.hotelCheckIn) return hotelRows;
        // 本单航段行（改期已写入新班次 → 出发日已是新的）
        if (where.kind === OrderItemKind.FLIGHT) {
          return [
            {
              id: 'item-1',
              flightScheduleId: 'sch-new',
              flightSchedule: { departureTime: NEW_DEPARTURE, departureTz: 'Asia/Shanghai' },
            },
          ];
        }
        return [];
      }),
      update: vi.fn(async () => {
        callTrace.push('UPDATE_ITEM');
        return { id: 'item-1' };
      }),
    },
    passenger: {
      findMany: vi.fn(async () => passengers),
      updateMany: vi.fn(async () => ({ count: passengers.length })),
    },
    flightSeatClass: { findFirst: vi.fn(async () => ({ id: 'sc-1' })) },
    // findMany：改期后重打机票行成本快照要按新班次取成本（见 item-cost-snapshot.ts）。
    // 返回空 = 查不到班次 → 快照转 NULL，与「班次没录成本」同一条分支，不影响本文件的断言。
    flightSchedule: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    hotelRoomType: { findMany: vi.fn(async () => []) },
    seatLock: { aggregate: vi.fn(async () => ({ _sum: { qty: 0 } })) },
  };
  mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
  mockPrisma.flightSchedule.findUnique.mockResolvedValue(null);
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue({
    id: 'ord-1',
    orderNumber: 'FTM-1',
    status: 'PAID',
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
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
  callTrace.length = 0;
  mockAssertRandomTierFitWithinTx.mockResolvedValue([]);
  mockAssertHotelPhysicalFitWithinTx.mockResolvedValue([]);
});

// ── 1. 自助旗子确实是代理进这条通道的唯一钥匙 ─────────────────────────────
describe('rescheduleOrderItem · selfServiceCorrection 旁路', () => {
  it('代理带自助旗子 → 越过「仅运营/管理员可改期」，座位真的搬到新班次', async () => {
    const tx = mountReschedule();

    const { audit } = await service.rescheduleOrderItem('ord-1', { ...CORRECTION_INPUT }, AGENT);

    expect(audit.fromScheduleId).toBe('sch-old');
    expect(audit.toScheduleId).toBe('sch-new');
    expect(audit.feeCny).toBe(0);
    expect(callTrace).toContain('SEAT_MOVE');
    expect(tx.orderItem.update).toHaveBeenCalledTimes(1);
  });

  it('代理不带旗子 → 仍旧 403，事务一次都不开', async () => {
    mountReschedule();

    await expect(
      service.rescheduleOrderItem(
        'ord-1',
        { orderItemId: 'item-1', newScheduleId: 'sch-new', feeCny: 500 },
        AGENT,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ── 2. C2：已订座/已出票的单，自助不碰 ────────────────────────────────────
// 换班次会把全单乘客的 PNR / 票号清空、并翻回被改航段的开票标记 —— 那是运营对着航司做的事。
describe('rescheduleOrderItem · 自助遇已订座/已出票', () => {
  it.each([
    ['已订座（有 PNR）', { pnr: 'ABC123' }],
    ['已出票（有电子票号）', { eticketNumber: '999-1234567890' }],
  ])('代理自助纠错 · %s → 400 指路改单申请，一个座都不搬', async (_label, ticketFields) => {
    const tx = mountReschedule({ passengers: [{ ...ticketFields }] });

    const err = await service
      .rescheduleOrderItem('ord-1', { ...CORRECTION_INPUT }, AGENT)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as Error).message).toBe('已订座/已出票，请提交改单申请由运营处理');
    expect(callTrace).not.toContain('SEAT_MOVE');
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.passenger.updateMany).not.toHaveBeenCalled();
  });

  it('空串的 PNR/票号不算已订座（占位字段照旧放行）', async () => {
    mountReschedule({ passengers: [{ pnr: '  ', eticketNumber: '' }] });

    await expect(
      service.rescheduleOrderItem('ord-1', { ...CORRECTION_INPUT }, AGENT),
    ).resolves.toMatchObject({ audit: { toScheduleId: 'sch-new' } });
  });

  it('运营走同一条纠错通道 → 已出票照改（清票号本就是运营的活）', async () => {
    const tx = mountReschedule({ passengers: [{ pnr: 'ABC123' }] });

    await service.rescheduleOrderItem('ord-1', { ...CORRECTION_INPUT }, STAFF);
    expect(callTrace).toContain('SEAT_MOVE');
    expect(tx.passenger.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'ord-1' },
      data: { pnr: null, eticketNumber: null },
    });
  });
});

// ── 3. L3：窗口在锁内再判一次 ─────────────────────────────────────────────
describe('rescheduleOrderItem · 锁内复查自助窗口', () => {
  it('拿到锁时订单已是「昨天的单」→ 403，理由与入口那句一模一样', async () => {
    const tx = mountReschedule({ createdAt: new Date(Date.now() - 3 * DAY_MS) });

    const err = await service
      .rescheduleOrderItem('ord-1', { ...CORRECTION_INPUT }, AGENT)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe(AGENT_SELF_EDIT_REASON.NEXT_DAY);
    expect(callTrace).not.toContain('SEAT_MOVE');
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('同一张「昨天的单」运营纠错照常放行（锁内复查只针对代理）', async () => {
    mountReschedule({ createdAt: new Date(Date.now() - 3 * DAY_MS) });

    await expect(
      service.rescheduleOrderItem('ord-1', { ...CORRECTION_INPUT }, STAFF),
    ).resolves.toMatchObject({ audit: { toScheduleId: 'sch-new' } });
  });
});

// ── 4. H3：酒店日期平移时的随机档超售上限 ─────────────────────────────────
// 自助只是把录错的班次改对，不该顺手把随机档的超售闸整个卸掉：平移日期挤爆某天的随机档，
// 最后是房控半夜加房。运营沿用内部录单的「需求池不闸单」口径。
describe('rescheduleOrderItem · 平移酒店日期时的随机档上限', () => {
  /** 取本次传给随机档闸的 maxOversellRooms。 */
  function capPassedToGate(): unknown {
    const opts = mockAssertRandomTierFitWithinTx.mock.calls[0]?.[4] as
      | { maxOversellRooms?: unknown }
      | undefined;
    return opts?.maxOversellRooms;
  }

  it('代理自助 → 吃标准上限（后台可配，缺省 3 间）', async () => {
    mountReschedule({ withRandomTierHotelRow: true });

    await service.rescheduleOrderItem('ord-1', { ...CORRECTION_INPUT }, AGENT);

    expect(mockAssertRandomTierFitWithinTx).toHaveBeenCalledTimes(1);
    expect(capPassedToGate()).toBe(3);
  });

  it('运营 → 沿用内部录单的「需求池不闸单」（不设上限）', async () => {
    mountReschedule({ withRandomTierHotelRow: true });

    await service.rescheduleOrderItem('ord-1', { ...CORRECTION_INPUT }, STAFF);

    expect(capPassedToGate()).toBe(Number.POSITIVE_INFINITY);
  });

  it('自助超出上限 → 整笔改期取消，报错说清是平移了几天、房量不够', async () => {
    mountReschedule({ withRandomTierHotelRow: true });
    mockAssertRandomTierFitWithinTx.mockRejectedValueOnce(
      new BadRequestError('4 星随机 10-03 房量不足'),
    );

    await expect(
      service.rescheduleOrderItem('ord-1', { ...CORRECTION_INPUT }, AGENT),
    ).rejects.toThrow('改期需同步酒店入住日期（随出发日平移 +2 天），新日期房量不足');
  });
});
