/**
 * 酒店房量闸的**并发互斥** · 真 DB 集成测试
 *
 * 单测能证明「闸判得准」和「锁在读之前」，但证明不了「两个人同时抢最后一间只能成一个」——
 * 那要两条真实数据库连接真的撞在一起。这里就干这件事：
 *   包房 1 间 → 同时发两笔各占 1 间的下单 → 必须恰好 1 成 1 败，且失败的那笔零占房落库。
 *
 * 没有行锁时的失败模式（本测试正是为它而写）：两笔各自读到「还剩 1 间」的旧快照，
 * 双双通过前瞻闸、双双落库 → 该晚占 2 间、销控板变负。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from './orders.service.js';

const service = new OrderService();

const CHECK_IN = '2026-09-01';
const CHECK_OUT = '2026-09-03';
const SOLD_OUT_MESSAGE = '该出发日期酒店可用房量不足，请更换日期或联系客服';

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function adminActor() {
  const admin = await prisma.user.create({
    data: { email: `${uniq('u')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: admin.id, role: UserRole.ADMIN as const };
}

/** 前台散客：无限额内超售豁免（硬闸），并发互斥语义用它来钉。*/
async function customerActor() {
  const customer = await prisma.user.create({
    data: { email: `${uniq('c')}@test.com`, role: UserRole.CUSTOMER },
  });
  return { userId: customer.id, role: UserRole.CUSTOMER as const };
}

/** 建酒店 + 房型 + 包房周期（rooms 间/晚，覆盖整个住宿区间）。*/
async function createHotelWithBlock(rooms: number) {
  const hotel = await prisma.hotel.create({
    data: {
      name: uniq('Hotel'),
      cityCode: 'DAD',
      address: 'Test address',
      starRating: 5,
      isActive: true,
    },
  });
  const roomType = await prisma.hotelRoomType.create({
    data: {
      hotelId: hotel.id,
      name: uniq('Deluxe'),
      capacity: 2,
      maxAdults: 2,
      maxChildren: 1,
      basePrice: new Prisma.Decimal(600),
    },
  });
  await prisma.hotelBlockPeriod.create({
    data: {
      hotelId: hotel.id,
      dateFrom: new Date(`${CHECK_IN}T00:00:00.000Z`),
      dateTo: new Date(`${CHECK_OUT}T00:00:00.000Z`),
      rooms,
    },
  });
  return { hotel, roomType };
}

/** 一笔占 1 间的指定房型 HOTEL 行下单请求体。*/
function orderBody(roomTypeId: string, seq: number) {
  return {
    contactName: `联系人${seq}`,
    contactPhone: '13800138000',
    items: [
      {
        kind: 'HOTEL' as const,
        description: `测试酒店 · 标准间 · ${CHECK_IN}~${CHECK_OUT} · 2晚 × 1间`,
        quantity: 2,
        unitPrice: 600,
        hotelRoomTypeId: roomTypeId,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        roomsBilled: 1,
      },
    ],
    passengers: [
      {
        fullName: `TEST/PAX${seq}`,
        documentType: 'PASSPORT' as const,
        documentNumber: `E1000000${seq}`,
        dateOfBirth: '1990-01-01',
        nationality: 'CN',
        passengerType: 'ADULT' as const,
        gender: 'M' as const,
        passportExpiry: '2031-01-01',
      },
    ],
  };
}

/** 该酒店「有效订单」的落库占房合计（床位口径）。*/
async function committedRooms(hotelId: string): Promise<number> {
  const rows = await prisma.orderItem.findMany({
    where: {
      hotelRoomType: { hotelId },
      order: { deletedAt: null, status: { not: OrderStatus.CANCELLED } },
    },
    select: { roomsBilled: true },
  });
  return rows.reduce((sum, r) => sum + Number(r.roomsBilled?.toString() ?? '1'), 0);
}

describe('酒店房量闸 · 并发互斥', () => {
  it('包房 1 间、两笔并发各抢 1 间（前台散客硬闸）→ 恰好 1 成 1 败，落库占房恒为 1 间', async () => {
    const actor = await customerActor();
    const { hotel, roomType } = await createHotelWithBlock(1);

    // 同时发出：不 await 第一笔就发第二笔，两条连接真的重叠
    const results = await Promise.allSettled([
      service.createOrder(orderBody(roomType.id, 1) as never, actor),
      service.createOrder(orderBody(roomType.id, 2) as never, actor),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as Error).message).toBe(SOLD_OUT_MESSAGE);

    // 真账：该酒店只落了 1 间占房（没有第二张单偷偷落库）
    expect(await committedRooms(hotel.id)).toBe(1);
    expect(
      await prisma.orderItem.count({
        where: { hotelRoomTypeId: roomType.id, kind: OrderItemKind.HOTEL },
      }),
    ).toBe(1);
  });

  it('包房 2 间、两笔并发各占 1 间 → 两笔都成，落库合计 2 间（闸不误伤）', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithBlock(2);

    const results = await Promise.allSettled([
      service.createOrder(orderBody(roomType.id, 3) as never, actor),
      service.createOrder(orderBody(roomType.id, 4) as never, actor),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await committedRooms(hotel.id)).toBe(2);
  });

  it('串行第二笔（包房 1 间、第一笔已提交、前台散客硬闸）→ 明确被拒，不留残行', async () => {
    const actor = await customerActor();
    const { hotel, roomType } = await createHotelWithBlock(1);

    await service.createOrder(orderBody(roomType.id, 5) as never, actor);

    await expect(service.createOrder(orderBody(roomType.id, 6) as never, actor)).rejects.toThrow(
      SOLD_OUT_MESSAGE,
    );
    expect(await committedRooms(hotel.id)).toBe(1);
  });

  // ── 内部录单限额内超售（销控售罄后仍可录单，当天临时向酒店加房是常态业务）──────
  it('包房 1 间已占满，内部 ADMIN 再录 1 间 → 缺口 1 在上限内放行落库，并写 WARNING 超售审计', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithBlock(1);

    await service.createOrder(orderBody(roomType.id, 7) as never, actor);
    const oversold = await service.createOrder(orderBody(roomType.id, 8) as never, actor);

    // 两单都落库：该晚占 2 间 > 包房 1 间（销控板显示 -1，提醒线报「超卖加房」）
    expect(await committedRooms(hotel.id)).toBe(2);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'CREATE_ORDER_HOTEL_OVERSOLD', targetId: oversold.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.severity).toBe('WARNING');
  });

  it('缺口超过超售上限（默认 3）→ 内部 ADMIN 录单也拒（防手滑打穿），不留残行', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithBlock(1);

    const body = orderBody(roomType.id, 9);
    // 一次要 5 间 → 缺口 4 > 上限 3
    await expect(
      service.createOrder(
        { ...body, items: [{ ...body.items[0], roomsBilled: 5 }] } as never,
        actor,
      ),
    ).rejects.toThrow(/超售容忍上限/);
    expect(await committedRooms(hotel.id)).toBe(0);
  });
});
