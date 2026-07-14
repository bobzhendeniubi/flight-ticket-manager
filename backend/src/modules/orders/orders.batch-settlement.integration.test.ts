/**
 * OrderService 批量建单（B5 productType）+ B4 改结算价 · 真 DB 集成测试
 *
 * 覆盖：
 *   (a) batchCreateOrders FLIGHT_ROUNDTRIP → 每位出行人 2 条 FLIGHT 行（去/回），
 *       去程 + 返程两个班次 sold 各 +N（两段都原子扣座）。
 *   (b) batchCreateOrders BUNDLE → 子单含盖了酒店房型 + 入住日期的订单行（房控/销控据此计入套餐占房）。
 *   (c) updateItemSettlementPrice → 改某 FLIGHT 行 unitPrice，amount/order.total 同步更新（不走 adjustmentCny）。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { CabinClass, OrderItemKind, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService, addDaysToYmd, type OrderRequester } from './orders.service.js';
import { localDate } from '../finances/finances.cost.service.js';

const service = new OrderService();

// ── Fixtures ───────────────────────────────────────────────────────────────
function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createUser(role: UserRole = UserRole.STAFF) {
  return prisma.user.create({
    data: { email: `${uniq('u')}@test.com`, role },
  });
}

/** 建一个班次（含一个 ECONOMY 舱位）。 */
async function createSchedule(opts: { capacity?: number; sold?: number; basePrice?: number }) {
  const capacity = opts.capacity ?? 50;
  const sold = opts.sold ?? 0;
  const departureTime = new Date(Date.now() + 200 * 3600 * 1000);
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `T${Math.floor(Math.random() * 100000)}`,
      originCode: 'MFM',
      destinationCode: 'DAD',
      isActive: true,
    },
  });
  const schedule = await prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: 'Asia/Macau',
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
      seatClasses: {
        create: [
          {
            cabin: CabinClass.ECONOMY,
            capacity,
            sold,
            basePrice: new Prisma.Decimal(opts.basePrice ?? 1000),
          },
        ],
      },
    },
    include: { seatClasses: true },
  });
  return schedule;
}

async function soldEconomy(scheduleId: string): Promise<number> {
  const sc = await prisma.flightSeatClass.findFirstOrThrow({
    where: { scheduleId, cabin: CabinClass.ECONOMY },
  });
  return sc.sold;
}

/** 建一个绑定航班号（去程 MFM→DAD / 回程 DAD→MFM）的班次，本地出发日 == 目标 ymd。 */
async function createBoundSchedule(opts: {
  ymd: string;
  tz: string;
  originCode: string;
  destinationCode: string;
  capacity?: number;
  sold?: number;
  basePrice?: number;
}) {
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `T${Math.floor(Math.random() * 1000000)}`,
      originCode: opts.originCode,
      destinationCode: opts.destinationCode,
      isActive: true,
    },
  });
  // T04:00:00Z 落在 UTC+7/+8 当天（11:00/12:00 本地）→ localDate == ymd（不跨日）。
  const departureTime = new Date(`${opts.ymd}T04:00:00Z`);
  const schedule = await prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: opts.tz,
      arrivalTz: opts.tz,
      isActive: true,
      seatClasses: {
        create: [
          {
            cabin: CabinClass.ECONOMY,
            capacity: opts.capacity ?? 50,
            sold: opts.sold ?? 0,
            basePrice: new Prisma.Decimal(opts.basePrice ?? 1000),
          },
        ],
      },
    },
    include: { seatClasses: true },
  });
  return { flight, schedule };
}

/**
 * 建一个「绑定去/回程航班号 + 绑酒店房型」的往返套餐（地面价非 0，含 HOTEL 组件）。
 * 去/回程班次的本地出发日分别 = departDate / departDate+晚数，供批量套餐单按出发日期匹配当日班次并占座。
 * 出发日期取「未来 30 天」（避免过去日期），returnDate = departDate + 晚数。
 */
async function createBundleWithHotel(opts: {
  hotelNights?: number;
  outboundCapacity?: number;
  outboundSold?: number;
}) {
  const nights = opts.hotelNights ?? 3;
  // 出发日期 = 未来 30 天（按 Asia/Macau 本地日）。
  const departDate = localDate(new Date(Date.now() + 30 * 86_400_000), 'Asia/Macau');
  const returnDate = addDaysToYmd(departDate, nights);

  const go = await createBoundSchedule({
    ymd: departDate,
    tz: 'Asia/Macau',
    originCode: 'MFM',
    destinationCode: 'DAD',
    capacity: opts.outboundCapacity ?? 50,
    sold: opts.outboundSold ?? 0,
  });
  const ret = await createBoundSchedule({
    ymd: returnDate,
    tz: 'Asia/Ho_Chi_Minh',
    originCode: 'DAD',
    destinationCode: 'MFM',
  });

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
      capacity: 3,
      maxAdults: 2,
      maxChildren: 1,
      basePrice: new Prisma.Decimal(600),
    },
  });
  const bundle = await prisma.bundle.create({
    data: {
      name: uniq('Bundle'),
      // items: 1 个 HOTEL 组件（qty=入住晚数, unitPrice=每间每晚）+ 占位 FLIGHT（unitPrice=0）
      items: [
        { kind: 'HOTEL', productName: '酒店', qty: nights, unitPrice: 600 },
        { kind: 'FLIGHT', productName: '机票', qty: 1, unitPrice: 0 },
      ] as Prisma.InputJsonValue,
      groundDiscount: new Prisma.Decimal(0),
      hotelRoomTypeId: roomType.id,
      hotelNights: nights,
      defaultDepartDate: departDate,
      // 绑定去/回程航班号（模板绑法）+ 往返 2 段 → 批量套餐单据此匹配当日班次并占座。
      outboundFlightId: go.flight.id,
      returnFlightId: ret.flight.id,
      legs: 2,
      isActive: true,
    },
  });
  return {
    hotel,
    roomType,
    bundle,
    outbound: go.schedule,
    ret: ret.schedule,
    departDate,
    returnDate,
  };
}

function passenger(i: number) {
  return {
    fullName: `WANG XIAO ${i}`,
    documentType: 'PASSPORT' as const,
    documentNumber: uniq(`P${i}`),
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
  };
}

async function staffRequester(): Promise<OrderRequester> {
  const u = await createUser(UserRole.STAFF);
  return { userId: u.id, role: UserRole.STAFF };
}

// ══════════════════════════════════════════════════════════════════════════
// (a) 批量 FLIGHT_ROUNDTRIP
// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.batchCreateOrders · FLIGHT_ROUNDTRIP · 真 DB E2E', () => {
  it('每位出行人 2 条 FLIGHT 行（去/回），去程 + 返程班次 sold 各 +2', async () => {
    const requester = await staffRequester();
    const outbound = await createSchedule({ capacity: 50, sold: 0 });
    const ret = await createSchedule({ capacity: 50, sold: 0 });

    const result = await service.batchCreateOrders(
      {
        productType: 'FLIGHT_ROUNDTRIP',
        outboundScheduleId: outbound.id,
        returnScheduleId: ret.id,
        flightCabin: CabinClass.ECONOMY,
        description: 'MFM→DAD 往返',
        passengers: [passenger(1), passenger(2)],
      },
      requester,
    );

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);

    // 两个班次各扣 2 个座位（每人去/回各占一段）
    expect(await soldEconomy(outbound.id)).toBe(2);
    expect(await soldEconomy(ret.id)).toBe(2);

    // 每张子单 = 2 条 FLIGHT 行（去程 + 返程），分别指向两个班次
    const firstOrderId = result.results.find((r) => r.success)?.orderId;
    expect(firstOrderId).toBeTruthy();
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: firstOrderId! },
      include: { items: true },
    });
    const flightItems = order.items.filter((it) => it.kind === OrderItemKind.FLIGHT);
    expect(flightItems).toHaveLength(2);
    const scheduleIds = flightItems.map((it) => it.flightScheduleId).sort();
    expect(scheduleIds).toEqual([outbound.id, ret.id].sort());
  });
});

// ══════════════════════════════════════════════════════════════════════════
// (b) 批量 BUNDLE → 子单盖酒店房型 + 入住日期（房控计入）
// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.batchCreateOrders · BUNDLE · 真 DB E2E', () => {
  it('每张子单含去/回程 FLIGHT 航段行 → 去/回程班次各扣座；地面行盖酒店房型 + 入住日期（房控计入）', async () => {
    const requester = await staffRequester();
    const { roomType, bundle, outbound, ret, departDate } = await createBundleWithHotel({ hotelNights: 3 });

    const result = await service.batchCreateOrders(
      {
        productType: 'BUNDLE',
        bundleId: bundle.id,
        bundleNights: 3,
        // 出发日期由弹窗传入（= 套餐去程班次本地出发日）；后端据此匹配当日班次并注入机票航段行。
        bundleDepartDate: departDate,
        description: '海岛 5 日套餐',
        passengers: [passenger(11), passenger(12)],
      },
      requester,
    );

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);

    // 核心修复点：批量套餐单现在真正扣座 —— 去程 + 回程班次各 +2（每子单 1 座 × 2 子单）。
    expect(await soldEconomy(outbound.id)).toBe(2);
    expect(await soldEconomy(ret.id)).toBe(2);

    const orderId = result.results.find((r) => r.success)?.orderId;
    expect(orderId).toBeTruthy();
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId! },
      include: { items: true },
    });
    // 每张子单 = 去程 + 回程 2 条 FLIGHT 航段行（各指向匹配到的班次，quantity=1、经济舱）
    const flightItems = order.items.filter((it) => it.kind === OrderItemKind.FLIGHT);
    expect(flightItems).toHaveLength(2);
    expect(flightItems.map((it) => it.flightScheduleId).sort()).toEqual([outbound.id, ret.id].sort());
    expect(flightItems.every((it) => it.quantity === 1 && it.flightCabin === CabinClass.ECONOMY)).toBe(true);

    // BUNDLE 行盖了酒店房型 + 入住/退房日期 → 房控板据此计入套餐占房
    const bundleItem = order.items.find((it) => it.kind === OrderItemKind.BUNDLE);
    expect(bundleItem).toBeTruthy();
    expect(bundleItem!.hotelRoomTypeId).toBe(roomType.id);
    // 房控盖章入住日 == 机票去程本地出发日（同源）；退房日 = 入住 + 3 晚。
    expect(localDate(bundleItem!.hotelCheckIn!, 'Asia/Macau')).toBe(departDate);
    expect(localDate(bundleItem!.hotelCheckOut!, 'Asia/Macau')).toBe(addDaysToYmd(departDate, 3));
    // 机票去程班次本地出发日与房控入住日一致（日期同步的直接对照）。
    const goItem = flightItems.find((it) => it.flightScheduleId === outbound.id)!;
    expect(localDate(outbound.departureTime, outbound.departureTz)).toBe(
      localDate(bundleItem!.hotelCheckIn!, 'Asia/Macau'),
    );
    expect(goItem.flightScheduleId).toBe(outbound.id);
    // 套餐地面价（HOTEL 600×3 晚）> 0 — 服务端权威重算（非前端传值）
    expect(Number(bundleItem!.amount)).toBeGreaterThan(0);
  });

  it('去程余位不足 → 卖穿子单逐单失败，不影响其它单；已成功单座位保住（逐单事务隔离）', async () => {
    const requester = await staffRequester();
    // 去程只剩 1 座（capacity 1 / sold 0）；回程充足 → 第 2 位在去程卖穿。
    const { bundle, outbound, ret, departDate } = await createBundleWithHotel({
      hotelNights: 3,
      outboundCapacity: 1,
      outboundSold: 0,
    });

    const result = await service.batchCreateOrders(
      {
        productType: 'BUNDLE',
        bundleId: bundle.id,
        bundleNights: 3,
        bundleDepartDate: departDate,
        description: '海岛 5 日套餐',
        passengers: [passenger(21), passenger(22)],
      },
      requester,
    );

    // 第 1 位成功（占去程唯一 1 座 + 回程 1 座）；第 2 位去程卖穿 → 逐单失败，不阻断整批。
    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    const failed = result.results.find((r) => !r.success);
    expect(failed?.error).toMatch(/余票|余位|售罄/);

    // 去程 sold=1（打满、未超卖）；回程 sold=1（只有成功那单占了；失败单事务回滚，未留半占座）。
    expect(await soldEconomy(outbound.id)).toBe(1);
    expect(await soldEconomy(ret.id)).toBe(1);
  });

  it('套餐未绑定航班 → 整批逐单优雅失败（不建任何零座位套餐单）', async () => {
    const requester = await staffRequester();
    // 不绑航班的套餐（仅酒店，无 outboundFlightId）。
    const hotel = await prisma.hotel.create({
      data: { name: uniq('Hotel'), cityCode: 'DAD', address: 'x', starRating: 5, isActive: true },
    });
    const roomType = await prisma.hotelRoomType.create({
      data: {
        hotelId: hotel.id,
        name: uniq('Room'),
        capacity: 3,
        maxAdults: 2,
        maxChildren: 1,
        basePrice: new Prisma.Decimal(600),
      },
    });
    const bundle = await prisma.bundle.create({
      data: {
        name: uniq('Bundle'),
        items: [{ kind: 'HOTEL', productName: '酒店', qty: 3, unitPrice: 600 }] as Prisma.InputJsonValue,
        groundDiscount: new Prisma.Decimal(0),
        hotelRoomTypeId: roomType.id,
        hotelNights: 3,
        defaultDepartDate: '2026-09-15',
        legs: 2,
        isActive: true,
        // outboundFlightId / returnFlightId 均为 null（未绑航班）
      },
    });

    const result = await service.batchCreateOrders(
      {
        productType: 'BUNDLE',
        bundleId: bundle.id,
        bundleNights: 3,
        bundleDepartDate: '2026-09-15',
        description: '未绑航班套餐',
        passengers: [passenger(31), passenger(32)],
      },
      requester,
    );

    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(2);
    expect(result.results.every((r) => /套餐未绑定航班/.test(r.error ?? ''))).toBe(true);
    // 没有落任何订单（不建零座位套餐单）。
    const orders = await prisma.order.findMany({ where: { items: { some: { bundleId: bundle.id } } } });
    expect(orders).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// (c) B4 改结算价
// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.updateItemSettlementPrice · 真 DB E2E', () => {
  it('改 FLIGHT 行 unitPrice → item.amount + order.subtotal/total 同步（不走 adjustmentCny）', async () => {
    const actorUser = await createUser(UserRole.ADMIN);
    const actor = { userId: actorUser.id, role: UserRole.ADMIN as const };
    const outbound = await createSchedule({ capacity: 50, sold: 0, basePrice: 1000 });
    const requester = await staffRequester();

    const batch = await service.batchCreateOrders(
      {
        productType: 'FLIGHT_ONEWAY',
        outboundScheduleId: outbound.id,
        flightCabin: CabinClass.ECONOMY,
        description: 'MFM→DAD 单程',
        passengers: [passenger(21)],
      },
      requester,
    );
    const orderId = batch.results[0].orderId!;
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
    const flightItem = order.items.find((it) => it.kind === OrderItemKind.FLIGHT)!;
    expect(Number(order.total)).toBe(1000); // 动态价 = basePrice

    const res = await service.updateItemSettlementPrice(
      orderId,
      flightItem.id,
      { unitPriceCny: 1234, reason: '团队议价订正' },
      actor,
    );

    // item 改价
    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: flightItem.id } });
    expect(Number(reloadedItem.unitPrice)).toBe(1234);
    expect(Number(reloadedItem.amount)).toBe(1234); // qty=1
    // order.subtotal/total 重算（不动 adjustmentCny）
    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(Number(reloadedOrder.subtotal)).toBe(1234);
    expect(Number(reloadedOrder.total)).toBe(1234);
    expect(reloadedOrder.adjustmentCny).toBe(0);
    // 序列化返回里 total 也更新
    expect(res.order.total).toBe('1234');
    expect(res.audit.after.total).toBe('1234');
  });

  it('对非 FLIGHT 行（BUNDLE）改结算价 → BadRequestError', async () => {
    const actorUser = await createUser(UserRole.ADMIN);
    const actor = { userId: actorUser.id, role: UserRole.ADMIN as const };
    const { bundle, departDate } = await createBundleWithHotel({ hotelNights: 3 });
    const requester = await staffRequester();
    const batch = await service.batchCreateOrders(
      {
        productType: 'BUNDLE',
        bundleId: bundle.id,
        bundleNights: 3,
        bundleDepartDate: departDate,
        description: '套餐',
        passengers: [passenger(33)],
      },
      requester,
    );
    const orderId = batch.results[0].orderId!;
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
    const bundleItem = order.items.find((it) => it.kind === OrderItemKind.BUNDLE)!;

    await expect(
      service.updateItemSettlementPrice(orderId, bundleItem.id, { unitPriceCny: 500 }, actor),
    ).rejects.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// (d) 单笔录单 套餐：机票航段行 + 地面套餐行 → 扣机票座位（0624 #2 回归）
//     后台单笔录单的套餐现在像前台一样拆成 FLIGHT 航段行 + 地面 BUNDLE 行；
//     FLIGHT 行才会扣 FlightSeatClass.sold。此前只发一条 BUNDLE 行 → 座位不减。
// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.createOrder · 套餐(机票航段 + 地面行) · 真 DB E2E', () => {
  it('套餐订单含 FLIGHT 航段行 → 对应班次 sold + 占座人数；地面行仍盖酒店房型', async () => {
    const requester = await staffRequester();
    const outbound = await createSchedule({ capacity: 50, sold: 0 });
    // 本用例用 createOrder（非 batch）显式拼装机票航段 + 地面套餐行，与套餐绑定航班无关；hotelNights 即可。
    const { roomType, bundle } = await createBundleWithHotel({ hotelNights: 3 });
    const before = await soldEconomy(outbound.id);

    // 与前台商城 / 后台 SingleOrderModal 同结构：机票航段行在前 + 地面套餐行在后。
    const order = await service.createOrder(
      {
        contactName: '套餐录单测试',
        contactPhone: '13800138000',
        items: [
          {
            kind: 'FLIGHT',
            description: `${bundle.name} · 去程（经济舱）`,
            quantity: 2, // 占座人数 = 2 位成人
            flightScheduleId: outbound.id,
            flightCabin: CabinClass.ECONOMY,
          },
          {
            kind: 'BUNDLE',
            description: `${bundle.name} · 2成人`,
            quantity: 1,
            bundleId: bundle.id,
            unitPrice: 0, // 服务端权威重算（仅地面部分）
            adultCount: 2,
            childCount: 0,
            infantCount: 0,
            singleCount: 0,
            businessCount: 0,
            // goDate 用于盖酒店入住章（createOrder 仅在有 goDate 时盖章）；模拟模态框默认填充。
            metadata: { adultCount: 2, childCount: 0, infantCount: 0, goDate: '2026-07-13' },
          },
        ],
        passengers: [passenger(41), passenger(42)],
      },
      requester,
    );

    // 核心回归点：去程班次 sold + 2（此前套餐订单完全不动 sold）
    expect(await soldEconomy(outbound.id)).toBe(before + 2);

    const created = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    const flightItems = created.items.filter((it) => it.kind === OrderItemKind.FLIGHT);
    expect(flightItems).toHaveLength(1);
    expect(flightItems[0].flightScheduleId).toBe(outbound.id);
    expect(flightItems[0].quantity).toBe(2);
    // 地面套餐行仍盖酒店房型（房控计入），价格仅地面部分（机票走上面的 FLIGHT 行）
    const bundleItem = created.items.find((it) => it.kind === OrderItemKind.BUNDLE);
    expect(bundleItem).toBeTruthy();
    expect(bundleItem!.hotelRoomTypeId).toBe(roomType.id);
    expect(Number(bundleItem!.amount)).toBeGreaterThan(0);
  });
});
