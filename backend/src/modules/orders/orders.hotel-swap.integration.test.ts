/**
 * OrderService.swapItemHotel（换酒店）· 真 DB 集成测试
 *
 * 定价哲学（owner 批准 A+B）：价格默认冻结——客户已付的钱不变，换酒店只改「住哪」，
 * 绝不用新房型的 basePrice 重算 unitPrice/amount。差价是可选的人工调整（走与改期费/
 * 换人费相同的 adjustmentCny 机制）。
 *
 * 覆盖：
 *   - 冻结定价：swap 后 amount/unitPrice 不变（HOTEL 行、BUNDLE 行两种 kind）
 *   - 差价：feeCny（正/负）进 adjustmentCny + adjustments 流水 HOTEL_SWAP_FEE
 *   - 逐晚余量校验：目标酒店实际房间不足 → 拒单并列出夜晚；未配包房（block=0）→ 放行 + 标记 untrackedNights
 *   - 同酒店换房型跳过余量校验（净房量不变，不受本单自身占用影响）
 *   - Order.roomAssignment.roomGroups 里匹配旧酒店名的组被改名，不匹配的组不动
 *   - 非酒店行 / 房型相同 / 目标酒店下架 / 非 ADMIN·STAFF 调用被拒
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

// ── Fixtures ───────────────────────────────────────────────────────────────
function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createUser(role: UserRole = UserRole.CUSTOMER) {
  return prisma.user.create({ data: { email: `${uniq('u')}@test.com`, role } });
}

async function adminActor() {
  const admin = await createUser(UserRole.ADMIN);
  return { userId: admin.id, role: UserRole.ADMIN as const };
}

/** 建一个酒店 + 一个房型（默认在架，¥600/晚）。 */
async function createHotelWithRoomType(
  opts: {
    hotelName?: string;
    roomTypeName?: string;
    isActive?: boolean;
    basePrice?: number;
  } = {},
) {
  const hotel = await prisma.hotel.create({
    data: {
      name: opts.hotelName ?? uniq('Hotel'),
      cityCode: 'DAD',
      address: 'Test address',
      starRating: 5,
      isActive: opts.isActive ?? true,
    },
  });
  const roomType = await prisma.hotelRoomType.create({
    data: {
      hotelId: hotel.id,
      name: opts.roomTypeName ?? uniq('Deluxe'),
      capacity: 2,
      maxAdults: 2,
      maxChildren: 1,
      basePrice: new Prisma.Decimal(opts.basePrice ?? 600),
    },
  });
  return { hotel, roomType };
}

async function createBlockPeriod(hotelId: string, dateFrom: string, dateTo: string, rooms: number) {
  return prisma.hotelBlockPeriod.create({
    data: {
      hotelId,
      dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
      dateTo: new Date(`${dateTo}T00:00:00.000Z`),
      rooms,
    },
  });
}

/** 建一个 PAID 订单，含 1 条订单行（kind=HOTEL 或已盖章酒店的 BUNDLE），占 roomsBilled 间。 */
async function createHotelOrder(opts: {
  kind?: 'HOTEL' | 'BUNDLE';
  roomTypeId: string;
  hotelName: string;
  roomTypeName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  roomsBilled?: number;
  unitPrice?: number;
  amount?: number;
  roomAssignment?: unknown;
}) {
  const kind = opts.kind ?? 'HOTEL';
  const rooms = opts.roomsBilled ?? 1;
  const unitPrice = opts.unitPrice ?? 600;
  const amount = opts.amount ?? unitPrice * opts.nights * rooms;
  const description =
    kind === 'HOTEL'
      ? `${opts.hotelName} · ${opts.roomTypeName} · ${opts.checkIn}~${opts.checkOut} · ${opts.nights}晚 × ${rooms}间`
      : '海岛套餐 · 2大1小';
  return prisma.order.create({
    data: {
      orderNumber: uniq('ORD'),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(amount),
      total: new Prisma.Decimal(amount),
      paidAmount: new Prisma.Decimal(amount),
      contactName: 'Test User',
      contactPhone: '13800138000',
      roomAssignment: (opts.roomAssignment ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      items: {
        create: [
          {
            kind: kind === 'HOTEL' ? OrderItemKind.HOTEL : OrderItemKind.BUNDLE,
            description,
            quantity: kind === 'HOTEL' ? opts.nights : 1,
            unitPrice: new Prisma.Decimal(unitPrice),
            amount: new Prisma.Decimal(amount),
            hotelRoomTypeId: opts.roomTypeId,
            hotelCheckIn: new Date(`${opts.checkIn}T00:00:00.000Z`),
            hotelCheckOut: new Date(`${opts.checkOut}T00:00:00.000Z`),
            roomsBilled: new Prisma.Decimal(rooms),
          },
        ],
      },
      passengers: {
        create: [
          {
            fullName: 'WANG XIAO',
            lastName: 'WANG',
            firstName: 'XIAO',
            documentType: 'PASSPORT',
            documentNumber: uniq('P'),
            dateOfBirth: new Date('1990-01-01'),
            nationality: 'CHN',
          },
        ],
      },
    },
    include: { items: true, passengers: true },
  });
}

// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.swapItemHotel · 真 DB E2E', () => {
  it('冻结定价（HOTEL 行）：swap 后 amount/unitPrice 不变，即使目标房型单价不同 + description 用新酒店重建', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType({ basePrice: 600 });
    const dest = await createHotelWithRoomType({ basePrice: 999 }); // 故意设不同价，证明不会被拿来重算
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
      unitPrice: 600,
    });

    const result = await service.swapItemHotel(
      order.id,
      order.items[0].id,
      { newHotelRoomTypeId: dest.roomType.id },
      actor,
    );

    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
    expect(item.hotelRoomTypeId).toBe(dest.roomType.id);
    expect(Number(item.unitPrice)).toBe(600); // 冻结：未按目标房型 999 重算
    expect(Number(item.amount)).toBe(1200); // 冻结：600×2晚×1间，未变
    expect(item.description).toContain(dest.hotel.name);
    expect(item.description).toContain(dest.roomType.name);
    expect(item.description).toContain('2晚 × 1间');

    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloadedOrder.adjustmentCny).toBe(0); // 未填 feeCny → 不产生调整

    // 响应即时带正确联查（不用调用方再刷一次详情）
    const respItem = result.order.items.find((i) => i.id === order.items[0].id) as unknown as {
      hotelName: string;
      roomTypeName: string;
    };
    expect(respItem.hotelName).toBe(dest.hotel.name);
    expect(respItem.roomTypeName).toBe(dest.roomType.name);
  });

  it('冻结定价（BUNDLE 行）：swap 后 amount/unitPrice/description 不变，只换 hotelRoomTypeId 盖章', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType({ basePrice: 600 });
    const dest = await createHotelWithRoomType({ basePrice: 999 });
    const order = await createHotelOrder({
      kind: 'BUNDLE',
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
      amount: 3600,
      unitPrice: 3600,
    });
    const originalDescription = order.items[0].description;

    await service.swapItemHotel(order.id, order.items[0].id, { newHotelRoomTypeId: dest.roomType.id }, actor);

    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
    expect(item.hotelRoomTypeId).toBe(dest.roomType.id);
    expect(item.description).toBe(originalDescription); // BUNDLE 行 description 不含酒店名，不重建
    expect(Number(item.unitPrice)).toBe(3600);
    expect(Number(item.amount)).toBe(3600);
  });

  it('换酒店差价：feeCny 正数进 adjustmentCny + adjustments 流水 HOTEL_SWAP_FEE', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType();
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
    });

    const result = await service.swapItemHotel(
      order.id,
      order.items[0].id,
      { newHotelRoomTypeId: dest.roomType.id, feeCny: 50, feeLabel: '客人要求升级', note: 'x' },
      actor,
    );

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(50);
    const log = reloaded.adjustments as Array<{ type: string; amountCny: number; label: string }>;
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe('HOTEL_SWAP_FEE');
    expect(log[0].amountCny).toBe(50);
    expect(log[0].label).toBe('客人要求升级');
    expect(result.order.adjustmentCny).toBe(50);
    expect(result.audit.feeCny).toBe(50);
  });

  it('换酒店差价可为负（减价）：adjustmentCny 相应减少', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType();
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
    });

    await service.swapItemHotel(order.id, order.items[0].id, { newHotelRoomTypeId: dest.roomType.id, feeCny: -80 }, actor);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(-80);
    const log = reloaded.adjustments as Array<{ type: string; amountCny: number }>;
    expect(log[0].amountCny).toBe(-80);
  });

  // ── Bug 3：减价没有相对订单价值的下限，能把 effectivePayable 冲成任意负数 ─────────────
  it('减价超过当前应付 → 400 拒绝，订单/订单行完全不被改动（Bug 3 修复）', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType();
    // amount = 600 × 2 晚 × 1 间 = 1200；adjustmentCny 起始 0 → effectivePayable = 1200。
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
      unitPrice: 600,
    });

    await expect(
      service.swapItemHotel(
        order.id,
        order.items[0].id,
        { newHotelRoomTypeId: dest.roomType.id, feeCny: -1201 }, // 1200 - 1201 = -1，越界
        actor,
      ),
    ).rejects.toThrow(/减价金额不能超过当前应付/);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(0); // 未被改动
    expect(reloaded.adjustments).toEqual([]);
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
    expect(item.hotelRoomTypeId).toBe(src.roomType.id); // 房型也没被换——拒单必须整体不生效
  });

  it('减价刚好把应付冲到 0（边界值）→ 放行，不多不少', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType();
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
      unitPrice: 600, // amount = 1200
    });

    await service.swapItemHotel(
      order.id,
      order.items[0].id,
      { newHotelRoomTypeId: dest.roomType.id, feeCny: -1200 },
      actor,
    );

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(-1200); // 应付冲到 0，允许（不是负数）
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
    expect(item.hotelRoomTypeId).toBe(dest.roomType.id); // 放行时房型正常换成功
  });

  it('减价按已有 adjustmentCny 累计应付判断——第二次减价把叠加后的应付冲负 → 拒绝，第一次的结果保留', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const mid = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType();
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
      unitPrice: 600, // amount = 1200
    });

    // 第一次：减 700（合法，剩余应付 500）
    await service.swapItemHotel(order.id, order.items[0].id, { newHotelRoomTypeId: mid.roomType.id, feeCny: -700 }, actor);
    // 第二次：再减 600（应付只剩 500，减 600 会冲到 -100）→ 拒绝
    await expect(
      service.swapItemHotel(order.id, order.items[0].id, { newHotelRoomTypeId: dest.roomType.id, feeCny: -600 }, actor),
    ).rejects.toThrow(/减价金额不能超过当前应付/);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(-700); // 停在第一次的结果，第二次没生效
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
    expect(item.hotelRoomTypeId).toBe(mid.roomType.id); // 第二次没换成功
  });

  it('加价（正 feeCny）不受应付下限约束——照常放行', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType();
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
      unitPrice: 600,
    });

    await service.swapItemHotel(order.id, order.items[0].id, { newHotelRoomTypeId: dest.roomType.id, feeCny: 5000 }, actor);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.adjustmentCny).toBe(5000);
  });

  it('目标酒店实际房间不足 → 拒单并在错误信息里列出不足的夜晚；订单行不被改动', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType();
    // 目标酒店包房 1 间，覆盖住宿区间
    await createBlockPeriod(dest.hotel.id, '2026-08-01', '2026-08-02', 1);
    // 目标酒店已被另一订单占满（1 间）
    await createHotelOrder({
      roomTypeId: dest.roomType.id,
      hotelName: dest.hotel.name,
      roomTypeName: dest.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
    });
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
    });

    await expect(
      service.swapItemHotel(order.id, order.items[0].id, { newHotelRoomTypeId: dest.roomType.id }, actor),
    ).rejects.toThrow(/目标酒店.*实际房间不足/);

    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
    expect(item.hotelRoomTypeId).toBe(src.roomType.id); // 拒单后未被改动
  });

  it('目标酒店未配置任何包房周期 → 放行并把全部夜晚标记为 untrackedNights', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType(); // 不配置任何包房周期
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
    });

    const result = await service.swapItemHotel(
      order.id,
      order.items[0].id,
      { newHotelRoomTypeId: dest.roomType.id },
      actor,
    );

    expect([...result.audit.untrackedNights].sort()).toEqual(['2026-08-01', '2026-08-02']);
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
    expect(item.hotelRoomTypeId).toBe(dest.roomType.id);
  });

  it('目标酒店部分夜晚未配包房 → 该晚放行计入 untrackedNights，覆盖到的夜晚仍按余量校验', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType();
    // 只覆盖第一晚（8/1），第二晚（8/2）未被任何周期覆盖
    await createBlockPeriod(dest.hotel.id, '2026-08-01', '2026-08-01', 5);
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
    });

    const result = await service.swapItemHotel(
      order.id,
      order.items[0].id,
      { newHotelRoomTypeId: dest.roomType.id },
      actor,
    );

    expect(result.audit.untrackedNights).toEqual(['2026-08-02']);
  });

  it('同酒店换房型跳过余量校验（净房量不变）——即使该酒店当晚已满仍放行', async () => {
    const actor = await adminActor();
    const hotel = await createHotelWithRoomType();
    const otherRoomType = await prisma.hotelRoomType.create({
      data: {
        hotelId: hotel.hotel.id,
        name: uniq('Suite'),
        capacity: 2,
        maxAdults: 2,
        maxChildren: 1,
        basePrice: new Prisma.Decimal(900),
      },
    });
    // 包房只 1 间，且订单自身已占满这 1 间（remaining=0，若真的校验会拒）
    await createBlockPeriod(hotel.hotel.id, '2026-08-01', '2026-08-02', 1);
    const order = await createHotelOrder({
      roomTypeId: hotel.roomType.id,
      hotelName: hotel.hotel.name,
      roomTypeName: hotel.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
    });

    const result = await service.swapItemHotel(
      order.id,
      order.items[0].id,
      { newHotelRoomTypeId: otherRoomType.id },
      actor,
    );

    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
    expect(item.hotelRoomTypeId).toBe(otherRoomType.id);
    expect(result.audit.untrackedNights).toEqual([]); // 同酒店跳过校验，未产生 untracked 标记
  });

  it('Order.roomAssignment.roomGroups 里匹配旧酒店名+旧房型的组被改名+改房型，不匹配的组保持原样', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType();
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
      roomAssignment: {
        roomGroups: [
          { id: 'g1', hotelName: src.hotel.name, roomType: src.roomType.name, passengerIds: [] },
          { id: 'g2', hotelName: '别的手填酒店名', roomType: '别的房型', passengerIds: [] },
        ],
      },
    });

    await service.swapItemHotel(order.id, order.items[0].id, { newHotelRoomTypeId: dest.roomType.id }, actor);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const groups = (
      reloaded.roomAssignment as { roomGroups: Array<{ id: string; hotelName: string; roomType: string }> }
    ).roomGroups;
    expect(groups.find((g) => g.id === 'g1')?.hotelName).toBe(dest.hotel.name);
    // Bug 4 修复：roomType 也要同步改写为新房型名（旧版只改 hotelName，留下一个目标酒店根本
    // 不存在的旧房型名，分房表货不对板）。
    expect(groups.find((g) => g.id === 'g1')?.roomType).toBe(dest.roomType.name);
    expect(groups.find((g) => g.id === 'g2')?.hotelName).toBe('别的手填酒店名'); // 不匹配，保持原样
    expect(groups.find((g) => g.id === 'g2')?.roomType).toBe('别的房型');
  });

  it('Bug 4 修复：一个订单里 2 条 HOTEL 行同住一家酒店（不同房型）——只换其中一行时，只有那一行对应的分房组被改名+改房型，另一行的组完全不受影响（旧版会用纯 hotelName 匹配把两组都误伤改名）', async () => {
    const actor = await adminActor();
    const sharedHotel = await prisma.hotel.create({
      data: { name: uniq('SharedHotel'), cityCode: 'DAD', address: 'Test address', starRating: 4, isActive: true },
    });
    const roomTypeA = await prisma.hotelRoomType.create({
      data: {
        hotelId: sharedHotel.id,
        name: uniq('Standard'),
        capacity: 2,
        maxAdults: 2,
        maxChildren: 1,
        basePrice: new Prisma.Decimal(600),
      },
    });
    const roomTypeB = await prisma.hotelRoomType.create({
      data: {
        hotelId: sharedHotel.id,
        name: uniq('Deluxe'),
        capacity: 2,
        maxAdults: 2,
        maxChildren: 1,
        basePrice: new Prisma.Decimal(800),
      },
    });
    const dest = await createHotelWithRoomType();

    const order = await prisma.order.create({
      data: {
        orderNumber: uniq('ORD'),
        status: OrderStatus.PAID,
        subtotal: new Prisma.Decimal(2800),
        total: new Prisma.Decimal(2800),
        paidAmount: new Prisma.Decimal(2800),
        contactName: 'Test User',
        contactPhone: '13800138000',
        roomAssignment: {
          roomGroups: [
            { id: 'gA', hotelName: sharedHotel.name, roomType: roomTypeA.name, passengerIds: [] },
            { id: 'gB', hotelName: sharedHotel.name, roomType: roomTypeB.name, passengerIds: [] },
          ],
        },
        items: {
          create: [
            {
              kind: OrderItemKind.HOTEL,
              description: `${sharedHotel.name} · ${roomTypeA.name} · 2026-08-01~2026-08-03 · 2晚 × 1间`,
              quantity: 2,
              unitPrice: new Prisma.Decimal(600),
              amount: new Prisma.Decimal(1200),
              hotelRoomTypeId: roomTypeA.id,
              hotelCheckIn: new Date('2026-08-01T00:00:00.000Z'),
              hotelCheckOut: new Date('2026-08-03T00:00:00.000Z'),
              roomsBilled: new Prisma.Decimal(1),
            },
            {
              kind: OrderItemKind.HOTEL,
              description: `${sharedHotel.name} · ${roomTypeB.name} · 2026-08-01~2026-08-03 · 2晚 × 1间`,
              quantity: 2,
              unitPrice: new Prisma.Decimal(800),
              amount: new Prisma.Decimal(1600),
              hotelRoomTypeId: roomTypeB.id,
              hotelCheckIn: new Date('2026-08-01T00:00:00.000Z'),
              hotelCheckOut: new Date('2026-08-03T00:00:00.000Z'),
              roomsBilled: new Prisma.Decimal(1),
            },
          ],
        },
      },
      include: { items: true },
    });
    const itemA = order.items.find((i) => i.hotelRoomTypeId === roomTypeA.id)!;
    const itemB = order.items.find((i) => i.hotelRoomTypeId === roomTypeB.id)!;

    // 只换 A 行到 dest 酒店
    await service.swapItemHotel(order.id, itemA.id, { newHotelRoomTypeId: dest.roomType.id }, actor);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const groups = (
      reloaded.roomAssignment as { roomGroups: Array<{ id: string; hotelName: string; roomType: string }> }
    ).roomGroups;
    const gA = groups.find((g) => g.id === 'gA')!;
    const gB = groups.find((g) => g.id === 'gB')!;
    expect(gA.hotelName).toBe(dest.hotel.name); // A 组正确改名
    expect(gA.roomType).toBe(dest.roomType.name);
    expect(gB.hotelName).toBe(sharedHotel.name); // B 组完全不受影响（旧版会被误伤改成 dest）
    expect(gB.roomType).toBe(roomTypeB.name);

    // 订单行本身也各改各的：A 行换了，B 行的 hotelRoomTypeId 原样不动。
    const itemAReloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemA.id } });
    const itemBReloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemB.id } });
    expect(itemAReloaded.hotelRoomTypeId).toBe(dest.roomType.id);
    expect(itemBReloaded.hotelRoomTypeId).toBe(roomTypeB.id);
  });

  it('非酒店行（VISA）调用换酒店 → 拒绝', async () => {
    const actor = await adminActor();
    const dest = await createHotelWithRoomType();
    const order = await prisma.order.create({
      data: {
        orderNumber: uniq('ORD'),
        status: OrderStatus.PAID,
        subtotal: new Prisma.Decimal(500),
        total: new Prisma.Decimal(500),
        paidAmount: new Prisma.Decimal(500),
        contactName: 'X',
        contactPhone: '1',
        items: {
          create: [
            {
              kind: OrderItemKind.VISA,
              description: '签证',
              quantity: 1,
              unitPrice: new Prisma.Decimal(500),
              amount: new Prisma.Decimal(500),
            },
          ],
        },
      },
      include: { items: true },
    });

    await expect(
      service.swapItemHotel(order.id, order.items[0].id, { newHotelRoomTypeId: dest.roomType.id }, actor),
    ).rejects.toThrow(/不含酒店/);
  });

  it('目标房型与当前房型相同 → 拒绝', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
    });

    await expect(
      service.swapItemHotel(order.id, order.items[0].id, { newHotelRoomTypeId: src.roomType.id }, actor),
    ).rejects.toThrow(/相同/);
  });

  it('目标酒店已下架 → 拒绝', async () => {
    const actor = await adminActor();
    const src = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType({ isActive: false });
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
    });

    await expect(
      service.swapItemHotel(order.id, order.items[0].id, { newHotelRoomTypeId: dest.roomType.id }, actor),
    ).rejects.toThrow(/下架/);
  });

  it('非 ADMIN/STAFF 调用换酒店 → 拒绝', async () => {
    const agent = await createUser(UserRole.AGENT);
    const src = await createHotelWithRoomType();
    const dest = await createHotelWithRoomType();
    const order = await createHotelOrder({
      roomTypeId: src.roomType.id,
      hotelName: src.hotel.name,
      roomTypeName: src.roomType.name,
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      nights: 2,
    });

    await expect(
      service.swapItemHotel(
        order.id,
        order.items[0].id,
        { newHotelRoomTypeId: dest.roomType.id },
        { userId: agent.id, role: UserRole.AGENT },
      ),
    ).rejects.toThrow(/仅运营\/管理员/);
  });
});
