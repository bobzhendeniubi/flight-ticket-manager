/**
 * 销控板占房行取数 · 真 DB 集成测试
 *
 * getBoard / getForward / getAlerts 的占房行由「orderItem.findMany 三层嵌套 select」改成
 * loadBoardItems 一条 SQL。本测试把改前的 findMany 原样留作参照，在真库上逐行比对两者
 * 交给下游算法的全部输入：
 *   - 命中范围：房控有效状态、未软删；入住区间与查询区间相交（checkIn ≤ to 且 checkOut > from）；
 *     有房型的行 + 无房型但有随机档的行；
 *   - 房型 / 酒店字段（含占位酒店的 randomTierPlaceholder）、订单分房表原样；
 *   - 出行人性别按原取回顺序（拼房性别取第一位 M/F），含 null 性别、无出行人；
 *   - metadata 的三个下游读键：roomsNeeded / rooms（数字、数字字符串、缺省、JSON null、
 *     metadata 本身是数组 / JSON null）经 itemRoomCount 算出的间数一致；splitPairKey
 *     （字符串才算、数字不算）一致。
 *
 * 跑：TEST_DATABASE_URL=… npm run test:integration -- src/modules/hotel-control/hotel-control.board-items.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { Gender, OrderItemKind, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { countedOrderWhere, itemRoomCount, loadBoardItems } from './hotel-control.service.js';

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

async function createHotel(opts: { starRating: number; placeholderTier?: number }) {
  const hotel = await prisma.hotel.create({
    data: {
      name: uniq('Hotel'),
      cityCode: 'DAD',
      address: '-',
      starRating: opts.starRating,
      randomTierPlaceholder: opts.placeholderTier ?? null,
    },
  });
  const roomType = await prisma.hotelRoomType.create({
    data: { hotelId: hotel.id, name: uniq('Twin'), capacity: 2, basePrice: new Prisma.Decimal(500) },
  });
  return { hotel, roomType };
}

async function createOrder(opts: {
  status?: OrderStatus;
  deleted?: boolean;
  genders?: Array<Gender | null>;
  roomAssignment?: Prisma.InputJsonValue;
  item: {
    kind?: OrderItemKind;
    hotelRoomTypeId?: string | null;
    randomStarTier?: number | null;
    checkIn: string;
    checkOut: string;
    roomsBilled?: number | null;
    metadata?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  };
}) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('ORD'),
      status: opts.status ?? OrderStatus.PAID,
      subtotal: new Prisma.Decimal(1000),
      total: new Prisma.Decimal(1000),
      contactName: 'Test',
      contactPhone: '13800138000',
      deletedAt: opts.deleted ? new Date() : null,
      roomAssignment: opts.roomAssignment,
      items: {
        create: [
          {
            kind: opts.item.kind ?? OrderItemKind.BUNDLE,
            description: '住宿',
            quantity: 1,
            unitPrice: new Prisma.Decimal(1000),
            amount: new Prisma.Decimal(1000),
            hotelRoomTypeId: opts.item.hotelRoomTypeId ?? null,
            randomStarTier: opts.item.randomStarTier ?? null,
            hotelCheckIn: d(opts.item.checkIn),
            hotelCheckOut: d(opts.item.checkOut),
            roomsBilled: opts.item.roomsBilled == null ? null : new Prisma.Decimal(opts.item.roomsBilled),
            metadata: opts.item.metadata,
          },
        ],
      },
      passengers: {
        create: (opts.genders ?? []).map((gender, i) => ({
          fullName: `PAX ${i + 1}`,
          gender,
          documentType: 'PASSPORT' as const,
          documentNumber: uniq('E'),
          nationality: 'CN',
          dateOfBirth: new Date('1990-01-01'),
        })),
      },
    },
  });
}

/** 改前 getBoard 的取数（原样），作参照。*/
async function legacyBoardItems(fromD: Date, toD: Date) {
  return prisma.orderItem.findMany({
    where: {
      OR: [{ hotelRoomTypeId: { not: null } }, { randomStarTier: { not: null } }],
      hotelCheckIn: { lte: toD },
      hotelCheckOut: { gt: fromD },
      order: countedOrderWhere(),
    },
    select: {
      id: true,
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
      metadata: true,
      randomStarTier: true,
      hotelRoomType: {
        select: {
          hotelId: true,
          hotel: { select: { name: true, starRating: true, intlFiveStar: true, randomTierPlaceholder: true } },
        },
      },
      order: { select: { id: true, roomAssignment: true, passengers: { select: { gender: true } } } },
    },
  });
}

/** 两边统一成「下游算法实际读到的值」再比较。*/
function normalize(
  items: Array<{
    id: string;
    hotelCheckIn: Date | null;
    hotelCheckOut: Date | null;
    roomsBilled: Prisma.Decimal | null;
    metadata: unknown;
    randomStarTier: number | null;
    hotelRoomType: unknown;
    order: { id: string; roomAssignment: unknown; passengers: Array<{ gender: Gender | null }> };
  }>,
) {
  return items
    .map((it) => {
      const meta =
        it.metadata != null && typeof it.metadata === 'object' ? (it.metadata as Record<string, unknown>) : null;
      return {
        id: it.id,
        hotelCheckIn: it.hotelCheckIn?.toISOString() ?? null,
        hotelCheckOut: it.hotelCheckOut?.toISOString() ?? null,
        roomsBilled: it.roomsBilled == null ? null : Number(it.roomsBilled.toString()),
        rooms: itemRoomCount(it),
        splitPairKey: meta != null && typeof meta.splitPairKey === 'string' ? meta.splitPairKey : '',
        randomStarTier: it.randomStarTier,
        hotelRoomType: it.hotelRoomType,
        orderId: it.order.id,
        roomAssignment: it.order.roomAssignment,
        genders: it.order.passengers.map((p) => p.gender),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe('销控板占房行 · 一条 SQL 取数与原嵌套 findMany 逐行一致', () => {
  it('范围 / 状态 / 房型酒店 / 分房表 / 性别顺序 / metadata 各形态', async () => {
    const real = await createHotel({ starRating: 4 });
    const placeholder = await createHotel({ starRating: 3, placeholderTier: 3 });
    const rt = real.roomType.id;

    // 拼房半间 + 混合性别（取第一位 M/F）+ 拆单配对键 + roomsNeeded 数字
    await createOrder({
      genders: [Gender.F, Gender.M],
      item: { hotelRoomTypeId: rt, checkIn: '2026-10-10', checkOut: '2026-10-12', roomsBilled: 0.5, metadata: { roomsNeeded: 2, splitPairKey: 'k1', other: { deep: [1, 2] } } },
    });
    // 未落位随机单：无房型、roomsBilled 空、roomsNeeded 是数字字符串、性别空
    await createOrder({
      status: OrderStatus.PENDING_PAYMENT,
      genders: [null],
      item: { kind: OrderItemKind.HOTEL, randomStarTier: 3, checkIn: '2026-10-11', checkOut: '2026-10-12', metadata: { roomsNeeded: '2' } },
    });
    // 占位酒店（伪落位）+ metadata 是数组
    await createOrder({
      genders: [Gender.M],
      item: { hotelRoomTypeId: placeholder.roomType.id, checkIn: '2026-10-10', checkOut: '2026-10-11', metadata: [1, 2, 3] },
    });
    // 分房表 + metadata.rooms + 数字型 splitPairKey（不算配对键）
    await createOrder({
      genders: [Gender.M, Gender.M, Gender.F],
      roomAssignment: { roomGroups: [{ id: 'g1', hotelName: real.hotel.name, passengerIds: ['a', 'b'], roomFraction: 1 }] },
      item: { hotelRoomTypeId: rt, checkIn: '2026-10-09', checkOut: '2026-10-11', metadata: { rooms: 3, splitPairKey: 5 } },
    });
    // metadata 整列 JSON null、键值为 null
    await createOrder({
      genders: [Gender.F],
      item: { hotelRoomTypeId: rt, checkIn: '2026-10-11', checkOut: '2026-10-13', roomsBilled: 1, metadata: Prisma.JsonNull },
    });
    await createOrder({
      genders: [],
      item: { hotelRoomTypeId: rt, checkIn: '2026-10-11', checkOut: '2026-10-12', metadata: { roomsNeeded: null, rooms: 0 } },
    });
    // 边界：checkIn == to 命中；checkOut == from 不命中
    await createOrder({ genders: [Gender.M], item: { hotelRoomTypeId: rt, checkIn: '2026-10-12', checkOut: '2026-10-13', roomsBilled: 1 } });
    await createOrder({ genders: [Gender.M], item: { hotelRoomTypeId: rt, checkIn: '2026-10-08', checkOut: '2026-10-10', roomsBilled: 1 } });
    // 不计：已取消 / 已软删 / 既无房型也无随机档
    await createOrder({ status: OrderStatus.CANCELLED, genders: [Gender.M], item: { hotelRoomTypeId: rt, checkIn: '2026-10-10', checkOut: '2026-10-11', roomsBilled: 1 } });
    await createOrder({ deleted: true, genders: [Gender.M], item: { hotelRoomTypeId: rt, checkIn: '2026-10-10', checkOut: '2026-10-11', roomsBilled: 1 } });
    await createOrder({ genders: [Gender.M], item: { kind: OrderItemKind.HOTEL, checkIn: '2026-10-10', checkOut: '2026-10-11', roomsBilled: 1 } });

    const fromD = d('2026-10-10');
    const toD = d('2026-10-12');
    const legacy = normalize(await legacyBoardItems(fromD, toD));
    const current = normalize(await loadBoardItems(prisma, fromD, toD));

    expect(current).toEqual(legacy);
    // 钉住几条口径本身（不只和旧写法比）
    expect(current).toHaveLength(7);
    expect(current.map((r) => r.rooms).sort()).toEqual([0, 0.5, 1, 1, 1, 2, 3]);
    expect(current.filter((r) => r.splitPairKey === 'k1')).toHaveLength(1);
    expect(current.find((r) => r.genders.length === 2)?.genders).toEqual([Gender.F, Gender.M]);
  });
});
