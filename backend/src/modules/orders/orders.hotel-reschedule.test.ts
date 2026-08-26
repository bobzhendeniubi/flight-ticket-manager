/**
 * 单订酒店：改结算价 + 酒店改期 · 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖两件运营要的能力：
 *   A. 改结算价放开 HOTEL 行 —— 机票按「每张 × 张数」，酒店按「每间每晚 × 晚数 × 房数」，
 *      漏乘房数会让多间/拼房的单订酒店单直接算错金额，这里钉死这个乘数。
 *   B. 酒店改期（甲案：行价冻结）—— 只挪 hotelCheckIn/hotelCheckOut 与 description 里的
 *      日期/晚数段；unitPrice/amount/quantity/roomsBilled 一个字不动，差额走售后费行。
 *      新区间房量不足 / 死单 / 回收站单 / 退房不晚于入住 一律拒绝，且订单行分毫不改。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderItemKind, Prisma, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    passenger: { findMany: vi.fn() },
    hotelRoomType: { findUnique: vi.fn() },
    hotelBlockPeriod: { findMany: vi.fn() },
    hotel: { findMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService, rewriteHotelStayDescription } from './orders.service.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const STAFF = { userId: 'staff-1', role: UserRole.STAFF } as const;

beforeEach(() => {
  vi.clearAllMocks();
  // serializeOrder 走不到（返回 null 会抛）—— 成功路径一律 .catch(() => undefined) 后断言写入。
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(null);
});

// ══════════════════════════════════════════════════════════════════════════
// A. 改结算价：放开 HOTEL 行
// ══════════════════════════════════════════════════════════════════════════
describe('updateItemSettlementPrice · 放开单订酒店行', () => {
  function mountSettlement(item: {
    kind: OrderItemKind;
    quantity: number;
    roomsBilled?: Prisma.Decimal | null;
  }) {
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'ord-1',
          orderNumber: 'FTM-1',
          status: 'PAID',
          deletedAt: null,
          subtotal: new Prisma.Decimal(2400),
          total: new Prisma.Decimal(2400),
          paidAmount: new Prisma.Decimal(0),
          outboundInvoiced: false,
          returnInvoiced: false,
          systemInvoiced: false,
          settlementLocked: false,
        },
      ]),
      orderItem: {
        findMany: vi.fn(async () => [
          {
            id: 'item-1',
            kind: item.kind,
            quantity: item.quantity,
            unitPrice: new Prisma.Decimal(800),
            amount: new Prisma.Decimal(2400),
            roomsBilled: item.roomsBilled ?? null,
          },
        ]),
        update: vi.fn(async () => ({ id: 'item-1' })),
        aggregate: vi.fn(async () => ({ _sum: { amount: new Prisma.Decimal(3000) } })),
      },
      order: {
        update: vi.fn(async () => ({
          subtotal: new Prisma.Decimal(3000),
          total: new Prisma.Decimal(3000),
        })),
      },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    return tx;
  }

  it('HOTEL 行按「每间每晚 × 晚数 × 房数」重算金额（2 间 3 晚 × ¥1000 = ¥6000）', async () => {
    const tx = mountSettlement({
      kind: OrderItemKind.HOTEL,
      quantity: 3,
      roomsBilled: new Prisma.Decimal(2),
    });

    await service
      .updateItemSettlementPrice('ord-1', 'item-1', { unitPriceCny: 1000 }, ADMIN)
      .catch(() => undefined);

    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { unitPrice: new Prisma.Decimal(1000), amount: new Prisma.Decimal(6000) },
    });
  });

  it('拼房行（0.5 间）金额也按房数折半（1 晚 × ¥1000 × 0.5 = ¥500）', async () => {
    const tx = mountSettlement({
      kind: OrderItemKind.HOTEL,
      quantity: 1,
      roomsBilled: new Prisma.Decimal(0.5),
    });

    await service
      .updateItemSettlementPrice('ord-1', 'item-1', { unitPriceCny: 1000 }, STAFF)
      .catch(() => undefined);

    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { unitPrice: new Prisma.Decimal(1000), amount: new Prisma.Decimal(500) },
    });
  });

  it('roomsBilled 缺失的存量酒店行按 1 间兜底（不因缺数据把金额算成 0）', async () => {
    const tx = mountSettlement({ kind: OrderItemKind.HOTEL, quantity: 3, roomsBilled: null });

    await service
      .updateItemSettlementPrice('ord-1', 'item-1', { unitPriceCny: 1000 }, ADMIN)
      .catch(() => undefined);

    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { unitPrice: new Prisma.Decimal(1000), amount: new Prisma.Decimal(3000) },
    });
  });

  it('FLIGHT 行口径不变：每张 × 张数，绝不乘房数', async () => {
    const tx = mountSettlement({ kind: OrderItemKind.FLIGHT, quantity: 3 });

    await service
      .updateItemSettlementPrice('ord-1', 'item-1', { unitPriceCny: 1000 }, ADMIN)
      .catch(() => undefined);

    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { unitPrice: new Prisma.Decimal(1000), amount: new Prisma.Decimal(3000) },
    });
  });

  it('其它 kind（签证行）仍然拒绝，且一个字不写', async () => {
    const tx = mountSettlement({ kind: OrderItemKind.VISA, quantity: 1 });

    await expect(
      service.updateItemSettlementPrice('ord-1', 'item-1', { unitPriceCny: 1000 }, ADMIN),
    ).rejects.toThrow('只能对机票行（FLIGHT）或酒店行（HOTEL）改结算价');
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B. 酒店改期
// ══════════════════════════════════════════════════════════════════════════
/** 单订酒店行 fixture：2026-09-01~2026-09-03（2 晚 × 1 间）。*/
function hotelItem(over: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    orderId: 'ord-1',
    kind: OrderItemKind.HOTEL,
    description: '明月酒店 · 标准间 · 2026-09-01~2026-09-03 · 2晚 × 1间',
    hotelRoomTypeId: 'rt-1',
    randomStarTier: null,
    hotelCheckIn: new Date('2026-09-01T00:00:00.000Z'),
    hotelCheckOut: new Date('2026-09-03T00:00:00.000Z'),
    roomsBilled: new Prisma.Decimal(1),
    ...over,
  };
}

/**
 * 挂载事务内依赖。
 * @param o.blockRooms 目标区间包房间数（undefined = 该酒店该区间没配包房 → 未管控，放行）
 * @param o.foreignRoomsUsed 他单在目标区间已占的整间数（用来造「房量不足」）
 */
function mountReschedule(
  o: {
    status?: string;
    deletedAt?: Date | null;
    adjustmentCny?: number;
    total?: number;
    blockRooms?: number;
    foreignRoomsUsed?: number;
  } = {},
) {
  // 落库参数留痕：直接读数组比从 mock.calls 里挖元组省事，也让断言类型干净。
  const itemUpdates: Array<{ data: Record<string, unknown> }> = [];
  const orderUpdates: Array<{ data: Record<string, unknown> }> = [];
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'ord-1' }]),
    order: {
      findUnique: vi.fn(async () => ({
        id: 'ord-1',
        orderNumber: 'FTM-1',
        status: o.status ?? 'PAID',
        deletedAt: o.deletedAt ?? null,
        adjustmentCny: o.adjustmentCny ?? 0,
        adjustments: null,
        total: new Prisma.Decimal(o.total ?? 5000),
      })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        orderUpdates.push(args);
        return { id: 'ord-1' };
      }),
    },
    orderItem: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        itemUpdates.push(args);
        return { id: 'item-1' };
      }),
      findMany: vi.fn(async () =>
        Array.from({ length: o.foreignRoomsUsed ?? 0 }, (_, i) => ({
          hotelCheckIn: new Date('2026-09-05T00:00:00.000Z'),
          hotelCheckOut: new Date('2026-09-09T00:00:00.000Z'),
          roomsBilled: new Prisma.Decimal(1),
          metadata: null,
          order: { id: `other-${i}`, roomAssignment: null, passengers: [] },
        })),
      ),
    },
    passenger: { findMany: vi.fn(async () => []) },
    hotelBlockPeriod: {
      findMany: vi.fn(async () =>
        o.blockRooms == null
          ? []
          : [
              {
                dateFrom: new Date('2026-09-01T00:00:00.000Z'),
                dateTo: new Date('2026-09-30T00:00:00.000Z'),
                rooms: o.blockRooms,
              },
            ],
      ),
    },
    hotel: { findMany: vi.fn(async () => []) },
  };
  mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
  mockPrisma.hotelRoomType.findUnique.mockResolvedValue({ id: 'rt-1', hotelId: 'hotel-1' });
  return { tx, itemUpdates, orderUpdates };
}

const NEW_STAY = { newCheckIn: '2026-09-05', newCheckOut: '2026-09-09' } as const;

describe('rescheduleItemHotel · 入参与行类型守卫', () => {
  it('非 ADMIN/STAFF → 拒（服务层也把关，不只靠路由）', async () => {
    await expect(
      service.rescheduleItemHotel(
        'ord-1',
        'item-1',
        { ...NEW_STAY },
        { userId: 'a-1', role: UserRole.AGENT },
      ),
    ).rejects.toThrow('仅运营/管理员可改酒店入住日期');
  });

  it('退房日期不晚于入住日期 → 拒', async () => {
    await expect(
      service.rescheduleItemHotel(
        'ord-1',
        'item-1',
        { newCheckIn: '2026-09-05', newCheckOut: '2026-09-05' },
        ADMIN,
      ),
    ).rejects.toThrow('退房日期必须晚于入住日期');
  });

  it('不存在的日期（2026-02-31）不许被 Date 悄悄顺延 → 拒', async () => {
    await expect(
      service.rescheduleItemHotel(
        'ord-1',
        'item-1',
        { newCheckIn: '2026-02-31', newCheckOut: '2026-03-05' },
        ADMIN,
      ),
    ).rejects.toThrow('入住日期无效');
  });

  it('住宿区间超过上限 → 拒（不让一次改期占住半年房量）', async () => {
    await expect(
      service.rescheduleItemHotel(
        'ord-1',
        'item-1',
        { newCheckIn: '2026-09-01', newCheckOut: '2027-09-01' },
        ADMIN,
      ),
    ).rejects.toThrow(/住宿区间过长/);
  });

  it('机票行 → 拒（酒店改期只认 HOTEL 行）', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(hotelItem({ kind: OrderItemKind.FLIGHT }));

    await expect(
      service.rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN),
    ).rejects.toThrow('只能对酒店行（HOTEL）改期');
  });

  it('套餐行（BUNDLE，住宿日期跟行程走）→ 拒', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(hotelItem({ kind: OrderItemKind.BUNDLE }));

    await expect(
      service.rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN),
    ).rejects.toThrow('只能对酒店行（HOTEL）改期');
  });

  it('订单行不属于本订单 → 拒', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(hotelItem({ orderId: 'ord-9' }));

    await expect(
      service.rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN),
    ).rejects.toThrow('订单项不存在或不属于该订单');
  });

  it('没有入住/退房日期的酒店行 → 拒（无从判定占的是哪几晚）', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(
      hotelItem({ hotelCheckIn: null, hotelCheckOut: null }),
    );

    await expect(
      service.rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN),
    ).rejects.toThrow('该酒店行没有入住/退房日期，无法改期');
  });

  it('新区间与当前完全相同 → 拒（无意义改期）', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(hotelItem());

    await expect(
      service.rescheduleItemHotel(
        'ord-1',
        'item-1',
        { newCheckIn: '2026-09-01', newCheckOut: '2026-09-03' },
        ADMIN,
      ),
    ).rejects.toThrow('新入住/退房日期与当前相同，无需改期');
  });
});

describe('rescheduleItemHotel · 有效订单守卫', () => {
  beforeEach(() => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(hotelItem());
  });

  it('已取消订单 → 拒，订单行不动', async () => {
    const { tx } = mountReschedule({ status: 'CANCELLED' });

    await expect(
      service.rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN),
    ).rejects.toThrow(/不可改期/);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('回收站（软删）订单 → 拒，差价也不落账', async () => {
    const { tx } = mountReschedule({ deletedAt: new Date('2026-08-01T00:00:00.000Z') });

    await expect(
      service.rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY, feeCny: 500 }, ADMIN),
    ).rejects.toThrow('订单在回收站（已软删），不可改期；如需操作请先恢复');
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});

describe('rescheduleItemHotel · 新区间房量闸', () => {
  beforeEach(() => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(hotelItem());
  });

  it('新区间房量不足 → 整体拒绝，订单行分毫不改（旧区间占房保住）', async () => {
    // 目标区间只切了 1 间，且已被他单占满；本行再挪进来就是第 2 间 → 装不下。
    const { tx } = mountReschedule({ blockRooms: 1, foreignRoomsUsed: 1 });

    await expect(
      service.rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN),
    ).rejects.toThrow(/实际房间不足/);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('新区间房量够 → 放行并落库', async () => {
    const { tx } = mountReschedule({ blockRooms: 5, foreignRoomsUsed: 1 });

    await service
      .rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN)
      .catch(() => undefined);

    expect(tx.orderItem.update).toHaveBeenCalled();
  });

  it('目标区间未配包房周期 → 视为未管控放行（未配包房 ≠ 售罄）', async () => {
    const { tx } = mountReschedule({});

    await service
      .rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN)
      .catch(() => undefined);

    expect(tx.orderItem.update).toHaveBeenCalled();
  });

  it('未落位随机档行走随机档聚合闸（不去查某一家酒店的房型）', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(
      hotelItem({ hotelRoomTypeId: null, randomStarTier: 4 }),
    );
    const { tx } = mountReschedule({});

    await service
      .rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN)
      .catch(() => undefined);

    // 聚合闸的第一步是按星级捞真酒店集合；具体酒店的物理前瞻闸则从不查 hotel 表。
    expect(tx.hotel.findMany).toHaveBeenCalled();
    expect(mockPrisma.hotelRoomType.findUnique).not.toHaveBeenCalled();
    expect(tx.orderItem.update).toHaveBeenCalled();
  });
});

describe('rescheduleItemHotel · 甲案：行价冻结，差额走售后费', () => {
  beforeEach(() => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(hotelItem());
  });

  it('只写住宿区间与描述；unitPrice/amount/quantity/roomsBilled 一个字不动', async () => {
    const { itemUpdates } = mountReschedule({});

    await service
      .rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN)
      .catch(() => undefined);

    const data = itemUpdates[0].data;
    expect(Object.keys(data).sort()).toEqual(['description', 'hotelCheckIn', 'hotelCheckOut']);
    expect(data.hotelCheckIn).toEqual(new Date('2026-09-05T00:00:00.000Z'));
    expect(data.hotelCheckOut).toEqual(new Date('2026-09-09T00:00:00.000Z'));
  });

  it('description 里的日期段与晚数段按新区间改写，酒店名/房型/间数原样保留', async () => {
    const { itemUpdates } = mountReschedule({});

    await service
      .rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN)
      .catch(() => undefined);

    expect(itemUpdates[0].data.description).toBe('明月酒店 · 标准间 · 2026-09-05~2026-09-09 · 4晚 × 1间');
  });

  it('不填差价 → 订单应收一分不动（不写 order）', async () => {
    const { tx } = mountReschedule({});

    await service
      .rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY }, ADMIN)
      .catch(() => undefined);

    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('填了差价 → 记一条「酒店改期差价」售后费并累加 adjustmentCny', async () => {
    const { orderUpdates } = mountReschedule({ adjustmentCny: 200 });

    await service
      .rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY, feeCny: 800 }, ADMIN)
      .catch(() => undefined);

    const data = orderUpdates[0].data as {
      adjustmentCny: number;
      adjustments: Array<Record<string, unknown>>;
    };
    expect(data.adjustmentCny).toBe(1000);
    expect(data.adjustments).toHaveLength(1);
    expect(data.adjustments[0]).toMatchObject({
      type: 'HOTEL_RESCHEDULE_FEE',
      label: '酒店改期差价',
      amountCny: 800,
      by: 'admin-1',
    });
  });

  it('减价合法（缩短住宿退钱）→ 记一条负数售后费', async () => {
    const { orderUpdates } = mountReschedule({ total: 5000, adjustmentCny: 0 });

    await service
      .rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY, feeCny: -800 }, ADMIN)
      .catch(() => undefined);

    expect((orderUpdates[0].data as { adjustmentCny: number }).adjustmentCny).toBe(-800);
  });

  it('减价超过当前应付 → 拒（账面不许凭空欠客户钱），订单行也不改', async () => {
    const { tx } = mountReschedule({ total: 1000, adjustmentCny: 0 });

    await expect(
      service.rescheduleItemHotel('ord-1', 'item-1', { ...NEW_STAY, feeCny: -5000 }, ADMIN),
    ).rejects.toThrow('减价金额不能超过当前应付（最多减到应付为 0）');
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('rewriteHotelStayDescription · 就地改写日期段与晚数段', () => {
  const stay = { checkIn: '2026-09-05', checkOut: '2026-09-09', nights: 4 };

  it('标准建单/换酒店格式：日期段与晚数段都改，其余原样', () => {
    expect(
      rewriteHotelStayDescription('明月酒店 · 标准间 · 2026-09-01~2026-09-03 · 2晚 × 1间', stay),
    ).toBe('明月酒店 · 标准间 · 2026-09-05~2026-09-09 · 4晚 × 1间');
  });

  it('后台补录房费格式（没有日期段）：只改晚数，不硬塞日期', () => {
    expect(rewriteHotelStayDescription('明月酒店 · 标准间 × 2晚 × 0.5间', stay)).toBe(
      '明月酒店 · 标准间 × 4晚 × 0.5间',
    );
  });

  it('自由文本（两段都没有）：原样返回，不报错', () => {
    expect(rewriteHotelStayDescription('客户指定的家庭房，含早', stay)).toBe('客户指定的家庭房，含早');
  });

  it('只替换第一处日期段，备注里的旧日期不误伤', () => {
    expect(
      rewriteHotelStayDescription(
        '明月酒店 · 2026-09-01~2026-09-03 · 2晚 × 1间（原定 2026-08-01~2026-08-03）',
        stay,
      ),
    ).toBe('明月酒店 · 2026-09-05~2026-09-09 · 4晚 × 1间（原定 2026-08-01~2026-08-03）');
  });
});
