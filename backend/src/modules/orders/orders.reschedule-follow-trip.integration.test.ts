/**
 * 改期 · hotelMode=FOLLOW_TRIP（房跟着新行程走）· 真 DB 集成测试
 *
 * 覆盖：
 *   - 去程提前一天、回程不动 → 住宿多住一晚（入住提前、离店不动），行价冻结、成本按实住晚数重打快照，
 *     座位从旧班次搬到新班次。
 *   - 新增的那一晚房量不足（包房 1 间、当晚已被另一单占满）→ 整单回滚：机票行仍在旧班次、座位数不动、
 *     住宿日期/成本一个字不改，错误文案指路「整体平移 / 房不动」。
 *
 * 跑（必须指向本 lane 自己的测试库，别连共享库）：
 *   export TEST_DATABASE_URL=postgresql://ftm@127.0.0.1:5432/ftm_wt_<slug>_test?schema=public
 *   npx vitest run -c vitest.integration.config.ts src/modules/orders/orders.reschedule-follow-trip.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { CabinClass, OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from './orders.service.js';

const service = new OrderService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function adminActor() {
  const admin = await prisma.user.create({
    data: { email: `${uniq('u')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: admin.id, role: UserRole.ADMIN as const };
}

/** 建一个班次（一个经济舱 FlightSeatClass，已售 1），出发时刻 = 现在 + N 小时。 */
async function createSchedule(departureHoursFromNow: number) {
  const departureTime = new Date(Date.now() + departureHoursFromNow * 3600 * 1000);
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `T${Math.floor(Math.random() * 100000)}`,
      originCode: 'MFM',
      destinationCode: 'DAD',
      isActive: true,
    },
  });
  return prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: 'Asia/Macau',
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
      seatClasses: {
        create: [{ cabin: CabinClass.ECONOMY, capacity: 50, sold: 1, basePrice: new Prisma.Decimal(1000) }],
      },
    },
  });
}

async function soldCount(scheduleId: string): Promise<number> {
  const sc = await prisma.flightSeatClass.findFirstOrThrow({ where: { scheduleId, cabin: CabinClass.ECONOMY } });
  return sc.sold;
}

/** 一家酒店 + 标准房（净房价 ¥300/晚）+ 整月只配 1 间包房。 */
async function createHotelWithOneRoom() {
  const hotel = await prisma.hotel.create({
    data: { name: uniq('测试酒店'), cityCode: 'DAD', address: 'Test Rd 1', starRating: 4, isActive: true },
  });
  const roomType = await prisma.hotelRoomType.create({
    data: {
      hotelId: hotel.id,
      name: '标准房',
      capacity: 2,
      basePrice: new Prisma.Decimal(500),
      costPriceCny: new Prisma.Decimal(300),
    },
  });
  await prisma.hotelBlockPeriod.create({
    data: {
      hotelId: hotel.id,
      dateFrom: new Date('2026-09-01T00:00:00.000Z'),
      dateTo: new Date('2026-09-30T00:00:00.000Z'),
      rooms: 1,
    },
  });
  return { hotel, roomType };
}

function passenger(name: string) {
  return {
    fullName: name,
    lastName: name.split(' ')[0],
    firstName: name.split(' ')[1] ?? name,
    gender: 'M' as const,
    documentType: 'PASSPORT',
    documentNumber: uniq('P'),
    dateOfBirth: new Date('1990-01-01'),
    nationality: 'CHN',
  };
}

/** 往返 PAID 单：去程 + 回程各 1 座，酒店 9/5~9/6 一晚（成本快照 ¥300 × 1 晚）。 */
async function createRoundTripOrderWithHotel(opts: {
  outboundScheduleId: string;
  returnScheduleId: string;
  hotelName: string;
  roomTypeId: string;
}) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('ORD'),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(2500),
      total: new Prisma.Decimal(2500),
      paidAmount: new Prisma.Decimal(2500),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.FLIGHT,
            description: 'TEST MFM→DAD',
            quantity: 1,
            unitPrice: new Prisma.Decimal(1000),
            amount: new Prisma.Decimal(1000),
            flightScheduleId: opts.outboundScheduleId,
            flightCabin: CabinClass.ECONOMY,
          },
          {
            kind: OrderItemKind.FLIGHT,
            description: 'TEST DAD→MFM',
            quantity: 1,
            unitPrice: new Prisma.Decimal(1000),
            amount: new Prisma.Decimal(1000),
            flightScheduleId: opts.returnScheduleId,
            flightCabin: CabinClass.ECONOMY,
          },
          {
            kind: OrderItemKind.HOTEL,
            description: `${opts.hotelName} · 标准房 · 2026-09-05~2026-09-06 · 1晚 × 1间`,
            quantity: 1,
            unitPrice: new Prisma.Decimal(500),
            amount: new Prisma.Decimal(500),
            hotelRoomTypeId: opts.roomTypeId,
            hotelCheckIn: new Date('2026-09-05T00:00:00.000Z'),
            hotelCheckOut: new Date('2026-09-06T00:00:00.000Z'),
            roomsBilled: new Prisma.Decimal(1),
            unitCostCny: new Prisma.Decimal(300),
            totalCostCny: new Prisma.Decimal(300),
          },
        ],
      },
      passengers: { create: [passenger('WANG XIAO')] },
    },
    include: { items: true, passengers: true },
  });
}

describe('rescheduleOrderItem · hotelMode=FOLLOW_TRIP（真 DB）', () => {
  it('去程提前一天、回程不动 → 住宿 9/4~9/6（1 晚 → 2 晚），行价冻结、成本重打为 ¥300 × 2 晚，座位搬到新班次', async () => {
    const actor = await adminActor();
    const outbound = await createSchedule(300);
    const returnLeg = await createSchedule(324);
    const outboundEarlier = await createSchedule(276); // 比原去程早 24h → 出发地当地日 −1 天
    const { hotel, roomType } = await createHotelWithOneRoom();
    const order = await createRoundTripOrderWithHotel({
      outboundScheduleId: outbound.id,
      returnScheduleId: returnLeg.id,
      hotelName: hotel.name,
      roomTypeId: roomType.id,
    });
    const outboundItem = order.items.find((it) => it.flightScheduleId === outbound.id)!;
    const hotelItem = order.items.find((it) => it.kind === OrderItemKind.HOTEL)!;

    const result = await service.rescheduleOrderItem(
      order.id,
      { orderItemId: outboundItem.id, newScheduleId: outboundEarlier.id, hotelMode: 'FOLLOW_TRIP' },
      actor,
    );

    // 座位：旧去程 1 → 0，新去程 1 → 2
    expect(await soldCount(outbound.id)).toBe(0);
    expect(await soldCount(outboundEarlier.id)).toBe(2);

    // 住宿：入住提前一天、离店不动 → 2 晚；行价/间数冻结；成本按实住晚数重打快照
    const reloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: hotelItem.id } });
    expect(reloaded.hotelCheckIn).toEqual(new Date('2026-09-04T00:00:00.000Z'));
    expect(reloaded.hotelCheckOut).toEqual(new Date('2026-09-06T00:00:00.000Z'));
    expect(reloaded.description).toBe(`${hotel.name} · 标准房 · 2026-09-04~2026-09-06 · 2晚 × 1间`);
    expect(Number(reloaded.amount)).toBe(500);
    expect(Number(reloaded.unitPrice)).toBe(500);
    expect(reloaded.quantity).toBe(1);
    expect(Number(reloaded.roomsBilled)).toBe(1);
    expect(Number(reloaded.unitCostCny)).toBe(300);
    expect(Number(reloaded.totalCostCny)).toBe(600);
    expect((reloaded.metadata as { costSource?: { nights?: number } } | null)?.costSource?.nights).toBe(2);

    // 不自动计价：没填改期费 → 应收不动
    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloadedOrder.adjustmentCny).toBe(0);

    expect(result.audit.hotelMode).toBe('FOLLOW_TRIP');
    expect(result.audit.hotelDateSync).toEqual([
      {
        orderItemId: hotelItem.id,
        mode: 'FOLLOW_TRIP',
        fromCheckIn: '2026-09-05',
        toCheckIn: '2026-09-04',
        fromCheckOut: '2026-09-06',
        toCheckOut: '2026-09-06',
        fromNights: 1,
        toNights: 2,
      },
    ]);
  });

  it('新增的那一晚房量不足（包房 1 间、9/4 已被另一单占满）→ 整单回滚：座位、机票行、住宿日期、成本全部不动', async () => {
    const actor = await adminActor();
    const outbound = await createSchedule(300);
    const returnLeg = await createSchedule(324);
    const outboundEarlier = await createSchedule(276);
    const { hotel, roomType } = await createHotelWithOneRoom();
    const order = await createRoundTripOrderWithHotel({
      outboundScheduleId: outbound.id,
      returnScheduleId: returnLeg.id,
      hotelName: hotel.name,
      roomTypeId: roomType.id,
    });
    // 另一张纯酒店单把 9/4 那一晚唯一的一间占掉。
    await prisma.order.create({
      data: {
        orderNumber: uniq('ORD'),
        status: OrderStatus.PAID,
        subtotal: new Prisma.Decimal(500),
        total: new Prisma.Decimal(500),
        paidAmount: new Prisma.Decimal(500),
        contactName: 'Other User',
        contactPhone: '13900139000',
        items: {
          create: [
            {
              kind: OrderItemKind.HOTEL,
              description: `${hotel.name} · 标准房 · 2026-09-04~2026-09-05 · 1晚 × 1间`,
              quantity: 1,
              unitPrice: new Prisma.Decimal(500),
              amount: new Prisma.Decimal(500),
              hotelRoomTypeId: roomType.id,
              hotelCheckIn: new Date('2026-09-04T00:00:00.000Z'),
              hotelCheckOut: new Date('2026-09-05T00:00:00.000Z'),
              roomsBilled: new Prisma.Decimal(1),
            },
          ],
        },
        passengers: { create: [passenger('LI SI')] },
      },
    });
    const outboundItem = order.items.find((it) => it.flightScheduleId === outbound.id)!;
    const hotelItem = order.items.find((it) => it.kind === OrderItemKind.HOTEL)!;

    await expect(
      service.rescheduleOrderItem(
        order.id,
        { orderItemId: outboundItem.id, newScheduleId: outboundEarlier.id, hotelMode: 'FOLLOW_TRIP' },
        actor,
      ),
    ).rejects.toThrow(/按新行程重排住宿.*房量不足.*整体平移/);

    // 整事务回滚：座位没搬、机票行仍在旧班次、住宿与成本一个字没改
    expect(await soldCount(outbound.id)).toBe(1);
    expect(await soldCount(outboundEarlier.id)).toBe(1);
    const flightRow = await prisma.orderItem.findUniqueOrThrow({ where: { id: outboundItem.id } });
    expect(flightRow.flightScheduleId).toBe(outbound.id);
    const hotelRow = await prisma.orderItem.findUniqueOrThrow({ where: { id: hotelItem.id } });
    expect(hotelRow.hotelCheckIn).toEqual(new Date('2026-09-05T00:00:00.000Z'));
    expect(hotelRow.hotelCheckOut).toEqual(new Date('2026-09-06T00:00:00.000Z'));
    expect(Number(hotelRow.totalCostCny)).toBe(300);
    expect(hotelRow.description).toBe(`${hotel.name} · 标准房 · 2026-09-05~2026-09-06 · 1晚 × 1间`);
  });
});
