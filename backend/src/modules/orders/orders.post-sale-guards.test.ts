/**
 * 售后改单守卫 · 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖三条修复：
 *   A. swapPassenger / swapItemHotel 缺「有效订单」双闸（状态 + 软删）——
 *      此前可在已取消/已退款/回收站单上换人换酒店并顺带加收费用，死单凭空长出应收；
 *      swapItemHotel 还是唯一不加订单行锁的写路径（adjustmentCny 读-改-写会丢更新）。
 *   B. 「开票标齐 → 自动推进 TICKETED」把系统调用者前缀写成冒号（system:），
 *      判定用的是连字符（system-）→ 走真实 actorUserId → 外键违例 → 事务回滚 → 被静默吞掉。
 *   C. 改期端点是免费升舱后门：newCabin 无任何限制且 feeCny 可为 0 → 座位真搬走、一分不收。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderItemKind, Prisma, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    passenger: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    hotelRoomType: { findUnique: vi.fn(), findMany: vi.fn() },
    hotelBlockPeriod: { findMany: vi.fn() },
    fulfillmentTask: { updateMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;

/** 事务内的调用顺序留痕（证明行锁排在写之前）。*/
const callTrace: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  callTrace.length = 0;
});

// ══════════════════════════════════════════════════════════════════════════
describe('swapPassenger · 有效订单守卫（状态 + 软删）', () => {
  function mountSwapPassenger(o: { status?: string; deletedAt?: Date | null } = {}) {
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'ord-1',
          adjustmentCny: 0,
          adjustments: null,
          status: o.status ?? 'PAID',
          deletedAt: o.deletedAt ?? null,
        },
      ]),
      passenger: {
        findUnique: vi.fn(async () => ({
          id: 'pax-1',
          orderId: 'ord-1',
          fullName: '张三',
          documentNumber: 'E11111111',
          visaExempt: false,
        })),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        update: vi.fn(async () => ({ id: 'pax-1' })),
      },
      orderItem: { findMany: vi.fn(async () => []), update: vi.fn() },
      order: { findUnique: vi.fn(async () => null), update: vi.fn() },
      fulfillmentTask: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue(null);
    return tx;
  }

  it('已取消订单上换人 → 拒，文案点名当前状态，且出行人一个字都不改', async () => {
    const tx = mountSwapPassenger({ status: 'CANCELLED' });

    await expect(
      service.swapPassenger('ord-1', 'pax-1', { fullName: '李四', feeCny: 500 }, ADMIN),
    ).rejects.toThrow(
      '订单当前状态（已取消）不可换人：仅占座中的有效订单可换人（已取消/已退款/超时订单请勿换人）',
    );
    expect(tx.passenger.update).not.toHaveBeenCalled();
  });

  it('已退款订单上换人并加收换人费 → 拒（死单不能凭空长出应收）', async () => {
    const tx = mountSwapPassenger({ status: 'REFUNDED' });

    await expect(
      service.swapPassenger('ord-1', 'pax-1', { fullName: '李四', feeCny: 500 }, ADMIN),
    ).rejects.toThrow(/不可换人/);
    // 加收费用的写入（order.update 改 adjustmentCny）必须一次都没发生
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('回收站（软删）订单上换人 → 拒，提示先恢复', async () => {
    const tx = mountSwapPassenger({
      status: 'PAID',
      deletedAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    await expect(
      service.swapPassenger('ord-1', 'pax-1', { fullName: '李四' }, ADMIN),
    ).rejects.toThrow('订单在回收站（已软删），不可换人；如需操作请先恢复');
    expect(tx.passenger.update).not.toHaveBeenCalled();
  });

  it('占座中的有效订单（已支付）→ 放行，正常改身份（闸不误伤正常路径）', async () => {
    const tx = mountSwapPassenger({ status: 'PAID' });

    await service
      .swapPassenger('ord-1', 'pax-1', { fullName: '李四' }, ADMIN)
      .catch(() => undefined);

    expect(tx.passenger.update).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('swapItemHotel · 有效订单守卫 + 订单行锁', () => {
  function mountSwapHotel(o: { status?: string; deletedAt?: Date | null } = {}) {
    // 事务前的行/房型读取（同酒店换房型 → 净房量不变、不跑房量闸，专注验守卫与行锁）
    mockPrisma.orderItem.findUnique.mockResolvedValue({
      id: 'item-1',
      orderId: 'ord-1',
      kind: OrderItemKind.HOTEL,
      description: '明月酒店 · 标准间',
      quantity: 2,
      hotelRoomTypeId: 'rt-old',
      randomStarTier: null,
      hotelCheckIn: new Date('2026-09-01T00:00:00.000Z'),
      hotelCheckOut: new Date('2026-09-03T00:00:00.000Z'),
      roomsBilled: new Prisma.Decimal(1),
      unitCostCny: null,
      totalCostCny: null,
    });
    mockPrisma.hotelRoomType.findUnique
      .mockResolvedValueOnce({
        id: 'rt-old',
        name: '标准间',
        hotelId: 'hotel-1',
        hotel: { name: '明月酒店', randomTierPlaceholder: null },
      })
      .mockResolvedValueOnce({
        id: 'rt-new',
        name: '豪华间',
        hotelId: 'hotel-1', // 同酒店
        costPriceCny: new Prisma.Decimal(300),
        hotel: { name: '明月酒店', isActive: true, starRating: 4 },
      });

    const tx = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
        if (sql.includes('"Order"')) callTrace.push('LOCK_ORDER');
        return [{ id: 'ord-1' }];
      }),
      order: {
        findUnique: vi.fn(async () => ({
          id: 'ord-1',
          orderNumber: 'FTM-1',
          status: o.status ?? 'PAID',
          deletedAt: o.deletedAt ?? null,
          adjustmentCny: 0,
          adjustments: null,
          roomAssignment: null,
          total: new Prisma.Decimal(5000),
        })),
        update: vi.fn(),
      },
      orderItem: {
        update: vi.fn(async () => {
          callTrace.push('UPDATE_ITEM');
          return { id: 'item-1' };
        }),
      },
      passenger: { findMany: vi.fn(async () => []) },
      hotelRoomType: { findMany: vi.fn(async () => []) },
      hotelBlockPeriod: { findMany: vi.fn(async () => []) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue(null);
    return tx;
  }

  it('已取消订单上换酒店 → 拒，文案点名当前状态，且订单行不改房型', async () => {
    const tx = mountSwapHotel({ status: 'CANCELLED' });

    await expect(
      service.swapItemHotel('ord-1', 'item-1', { newHotelRoomTypeId: 'rt-new' } as never, ADMIN),
    ).rejects.toThrow(
      '订单当前状态（已取消）不可换酒店：仅占座中的有效订单可换酒店（已取消/已退款/超时订单请勿换酒店）',
    );
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('回收站（软删）订单上换酒店 → 拒，提示先恢复；差价也不落账', async () => {
    const tx = mountSwapHotel({
      status: 'PAID',
      deletedAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    await expect(
      service.swapItemHotel(
        'ord-1',
        'item-1',
        { newHotelRoomTypeId: 'rt-new', feeCny: 300 } as never,
        ADMIN,
      ),
    ).rejects.toThrow('订单在回收站（已软删），不可换酒店；如需操作请先恢复');
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('有效订单 → 放行，且写订单行之前先对 Order 行加过 FOR UPDATE 行锁', async () => {
    const tx = mountSwapHotel({ status: 'PAID' });

    await service
      .swapItemHotel('ord-1', 'item-1', { newHotelRoomTypeId: 'rt-new' } as never, ADMIN)
      .catch(() => undefined);

    expect(tx.orderItem.update).toHaveBeenCalled();
    expect(callTrace).toEqual(['LOCK_ORDER', 'UPDATE_ITEM']);
  });

  it('换酒店差价 +¥300 落账：adjustmentCny 基于锁内读到的值累加（读-改-写全在锁内）', async () => {
    const tx = mountSwapHotel({ status: 'PAID' });

    await service
      .swapItemHotel(
        'ord-1',
        'item-1',
        { newHotelRoomTypeId: 'rt-new', feeCny: 300 } as never,
        ADMIN,
      )
      .catch(() => undefined);

    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ adjustmentCny: 300 }),
      }),
    );
    expect(callTrace[0]).toBe('LOCK_ORDER');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('setInvoiceFlags · 航段标记翻齐后自动推进「出票完成」', () => {
  /** setInvoiceFlags 自身的事务（写三个布尔位）。*/
  function mountInvoiceFlagsTx() {
    return {
      order: {
        findUnique: vi.fn(async () => ({
          id: 'ord-1',
          orderNumber: 'FTM-1',
          status: 'PROCESSING',
          deletedAt: null,
          outboundInvoiced: false,
          returnInvoiced: false,
          systemInvoiced: false,
          _count: { passengers: 1 },
          items: [
            {
              flightScheduleId: 'sch-1',
              flightSchedule: { departureTime: new Date('2026-09-01T02:00:00.000Z') },
            },
          ],
        })),
        update: vi.fn(async () => ({
          id: 'ord-1',
          orderNumber: 'FTM-1',
          outboundInvoiced: true,
          returnInvoiced: false,
          systemInvoiced: false,
        })),
      },
      flightSeatClass: { findMany: vi.fn(async () => []) },
      passenger: { findMany: vi.fn(async () => []) },
    };
  }

  /** 事务后重读：状态仍 PROCESSING、去程已标、只有一条航段 → 满足自动推进条件。*/
  function mountAfterRead() {
    mockPrisma.order.findUnique.mockResolvedValue({
      status: 'PROCESSING',
      outboundInvoiced: true,
      returnInvoiced: false,
      items: [{ flightScheduleId: 'sch-1' }],
    });
  }

  it('单程单标齐去程 → 以「系统调用者」身份推进 TICKETED（连字符前缀 + actorType SYSTEM）', async () => {
    const flagsTx = mountInvoiceFlagsTx();
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(flagsTx));
    mountAfterRead();
    const updateStatusSpy = vi
      .spyOn(service, 'updateStatus')
      .mockResolvedValue({ id: 'ord-1' } as never);

    await service.setInvoiceFlags('ord-1', { outboundInvoiced: true });

    expect(updateStatusSpy).toHaveBeenCalledTimes(1);
    const [orderId, toStatus, requester] = updateStatusSpy.mock.calls[0];
    expect(orderId).toBe('ord-1');
    expect(toStatus).toBe('TICKETED');
    // 两个系统调用者标识都必须齐 —— 缺任一都会让 OrderStatusEvent 去写一个不存在的
    // actorUserId、撞外键 → 事务回滚 → 功能静默失效。
    expect(requester.actorType).toBe('SYSTEM');
    expect(requester.userId.startsWith('system-')).toBe(true);
    expect(requester.userId).not.toContain(':');
    updateStatusSpy.mockRestore();
  });

  it('端到端：自动推进真的落到 TICKETED，且状态事件的 actorUserId 写 null（不撞用户外键）', async () => {
    const flagsTx = mountInvoiceFlagsTx();
    const statusTx = {
      $queryRaw: vi.fn(async () => []),
      order: {
        findUnique: vi
          .fn()
          // _updateStatusWithinTx 开头读整单
          .mockResolvedValueOnce({
            id: 'ord-1',
            userId: 'u-1',
            agentId: null,
            status: 'PROCESSING',
            deletedAt: null,
            paidAmount: new Prisma.Decimal(0),
            items: [],
          })
          // TICKETED 派生闸再读一次开票位
          .mockResolvedValueOnce({
            outboundInvoiced: true,
            returnInvoiced: false,
            items: [{ flightScheduleId: 'sch-1' }],
          }),
        updateMany: vi.fn(async () => ({ count: 1 })),
        // 事务尾部重读整单交给 serializeOrder —— 一份最小可序列化的订单。
        findUniqueOrThrow: vi.fn(async () => ({
          id: 'ord-1',
          orderNumber: 'FTM-1',
          status: 'TICKETED',
          subtotal: new Prisma.Decimal(0),
          taxesAndFees: new Prisma.Decimal(0),
          discountTotal: new Prisma.Decimal(0),
          total: new Prisma.Decimal(0),
          paidAmount: new Prisma.Decimal(0),
          prepaymentOffset: new Prisma.Decimal(0),
          adjustmentCny: 0,
          items: [],
          passengers: [],
        })),
      },
      orderStatusEvent: { create: vi.fn(async () => ({ id: 'ev-1' })) },
      fulfillmentTask: { updateMany: vi.fn(async () => ({ count: 0 })) },
      commissionRecord: { findMany: vi.fn(async () => []) },
      refund: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    let txCall = 0;
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => {
      txCall += 1;
      return fn(txCall === 1 ? flagsTx : statusTx);
    });
    mountAfterRead();

    await service.setInvoiceFlags('ord-1', { outboundInvoiced: true });

    expect(statusTx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'TICKETED' }) }),
    );
    expect(statusTx.orderStatusEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ toStatus: 'TICKETED', actorUserId: null }),
      }),
    );
  });

  it('自动推进失败不再被静默吞掉 —— 至少留一条错误日志，且开票标记本身照常成功', async () => {
    const flagsTx = mountInvoiceFlagsTx();
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(flagsTx));
    mountAfterRead();
    const updateStatusSpy = vi
      .spyOn(service, 'updateStatus')
      .mockRejectedValue(new Error('外键违例（模拟）'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      service.setInvoiceFlags('ord-1', { outboundInvoiced: true }),
    ).resolves.toBeDefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to auto-advance order to TICKETED'),
      'ord-1',
      expect.any(Error),
    );

    errorSpy.mockRestore();
    updateStatusSpy.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('rescheduleOrderItem · 改期不许同时改舱（免费升舱后门）', () => {
  function mountReschedule() {
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
        })),
        findMany: vi.fn(async () => []),
        update: vi.fn(async () => {
          callTrace.push('UPDATE_ITEM');
          return { id: 'item-1' };
        }),
      },
      flightSeatClass: { findFirst: vi.fn(async () => ({ id: 'sc-1' })) },
      flightSchedule: { findUnique: vi.fn(async () => null) },
      seatLock: { aggregate: vi.fn(async () => ({ _sum: { qty: 0 } })) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue(null);
    return tx;
  }

  it('经济舱行借改期改成商务舱 → 拒，并指向升舱端点；座位一个都不搬', async () => {
    const tx = mountReschedule();

    await expect(
      service.rescheduleOrderItem(
        'ord-1',
        { orderItemId: 'item-1', newScheduleId: 'sch-new', newCabin: 'BUSINESS' },
        ADMIN,
      ),
    ).rejects.toThrow(
      '改期不能同时更改舱位：改期只搬班次、不重算差价。如需升舱请走「升舱」操作（差价由系统按航班差价源×人数自动计算）。',
    );
    expect(callTrace).not.toContain('SEAT_MOVE');
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('改期费填 0 也照拒 —— 后门的杀伤力正是「不传金额」', async () => {
    mountReschedule();

    await expect(
      service.rescheduleOrderItem(
        'ord-1',
        { orderItemId: 'item-1', newScheduleId: 'sch-new', newCabin: 'BUSINESS', feeCny: 0 },
        ADMIN,
      ),
    ).rejects.toThrow(/改期不能同时更改舱位/);
  });

  it('显式传原舱位（同舱改期）→ 放行，正常搬班次', async () => {
    const tx = mountReschedule();

    await service
      .rescheduleOrderItem(
        'ord-1',
        { orderItemId: 'item-1', newScheduleId: 'sch-new', newCabin: 'ECONOMY' },
        ADMIN,
      )
      .catch(() => undefined);

    expect(tx.orderItem.update).toHaveBeenCalled();
  });

  it('不传 newCabin（最常见的纯改期）→ 放行', async () => {
    const tx = mountReschedule();

    await service
      .rescheduleOrderItem('ord-1', { orderItemId: 'item-1', newScheduleId: 'sch-new' }, ADMIN)
      .catch(() => undefined);

    expect(tx.orderItem.update).toHaveBeenCalled();
  });
});
