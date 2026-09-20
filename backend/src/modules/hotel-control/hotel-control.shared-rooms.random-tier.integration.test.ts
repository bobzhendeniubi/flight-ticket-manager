/**
 * 跨单分房 · 档次房（随机档待落位的单跨单合住，2026-09-20 拍板 A）· 真 DB 集成测试
 *
 * 覆盖任务要求的反例：
 *   - 档次模式候选查询 = 形态①（无房型 + randomStarTier）∪ 形态②（房型挂占位酒店）；
 *   - 跨模式混入 400（档次房里混真酒店行 / 酒店房里混随机行 / 档次不符）；
 *   - 随机池只占 1 间：三张单 1+0+0 合一间档次房，getRandomTierAggregate.pendingUsed = 1，
 *     销控板随机池行 used=1、physicalUsed=1；
 *   - 整房落位成功：目标酒店只包 1 间也能落（共享房整间去重计 1，不是 3 间）；共享房原地转酒店房、
 *     成员不解绑、随机池占用转到该酒店、逐单审计；
 *   - 整房落位拒绝：指定酒店加价 > 0（列出是谁）、版本过期 409、已是酒店房 400、星级低于档次 400、
 *     目标酒店包房不足 400；
 *   - 解绑矩阵不回退：单个成员单独换酒店仍自动解绑 + 警告，其余成员留在档次房；
 *   - 解散 / 成员单取消 三条路径对称（Σ份额守恒、物理去重、孤儿提醒带档次）。
 *
 * 跑：docker compose -f ../docker-compose.test.yml up -d && npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { saveSharedRooms, getSharedRoomWorkbench } from './hotel-control.shared-rooms.js';
import { placeSharedRoom } from './shared-room-placement.js';
import {
  computeSharedRoomPhysicalByDate,
  getAlerts,
  getBoard,
  getHotelNightlyRemaining,
  getRandomTierAggregate,
} from './hotel-control.service.js';
import { OrderService } from '../orders/orders.service.js';

const orderService = new OrderService();

const CHECK_IN = '2026-10-01';
const CHECK_OUT = '2026-10-03';
const TIER = 4;

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
const requestToken = () => uniq('req');

async function adminActor(): Promise<{ userId: string; role: UserRole }> {
  const admin = await prisma.user.create({ data: { email: `${uniq('u')}@test.com`, role: UserRole.ADMIN } });
  return { userId: admin.id, role: UserRole.ADMIN };
}

/** 真酒店（星级默认 4）+ 房型 + 包房周期（rooms 间）。*/
async function createRealHotel(rooms: number, opts: { starRating?: number; surcharge?: number } = {}) {
  const hotel = await prisma.hotel.create({
    data: {
      name: uniq('Hotel'),
      cityCode: 'DAD',
      address: 'Test address',
      starRating: opts.starRating ?? TIER,
      isActive: true,
      designationSurchargeCnyPerPerson: opts.surcharge ?? 0,
    },
  });
  const roomType = await prisma.hotelRoomType.create({
    data: {
      hotelId: hotel.id,
      name: uniq('Twin'),
      capacity: 3,
      maxAdults: 3,
      maxChildren: 0,
      basePrice: new Prisma.Decimal(600),
      costPriceCny: new Prisma.Decimal(300),
    },
  });
  if (rooms > 0) {
    await prisma.hotelBlockPeriod.create({
      data: {
        hotelId: hotel.id,
        dateFrom: new Date(`${CHECK_IN}T00:00:00.000Z`),
        dateTo: new Date(`${CHECK_OUT}T00:00:00.000Z`),
        rooms,
      },
    });
  }
  return { hotel, roomType };
}

/** 随机档占位酒店（形态②的宿主）+ 房型。*/
async function createPlaceholderHotel(tier = TIER) {
  const hotel = await prisma.hotel.create({
    data: {
      name: uniq('随机占位'),
      cityCode: 'DAD',
      address: '-',
      starRating: tier,
      isActive: true,
      randomTierPlaceholder: tier,
    },
  });
  const roomType = await prisma.hotelRoomType.create({
    data: { hotelId: hotel.id, name: uniq('占位房型'), capacity: 2, maxAdults: 2, maxChildren: 0, basePrice: new Prisma.Decimal(0) },
  });
  return { hotel, roomType };
}

/** PAID 订单，1 条 HOTEL 行 + N 位乘客。未落位形态①：roomTypeId 省略 + randomStarTier；真酒店/形态②：roomTypeId。*/
async function createOrder(opts: { roomTypeId?: string; randomStarTier?: number; passengerCount: number }) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('ORD'),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(1200),
      total: new Prisma.Decimal(1200),
      paidAmount: new Prisma.Decimal(1200),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.HOTEL,
            description: `四星随机 · ${CHECK_IN}~${CHECK_OUT} · 2晚 × 1间`,
            quantity: 2,
            unitPrice: new Prisma.Decimal(600),
            amount: new Prisma.Decimal(1200),
            hotelRoomTypeId: opts.roomTypeId ?? null,
            randomStarTier: opts.randomStarTier ?? null,
            hotelCheckIn: new Date(`${CHECK_IN}T00:00:00.000Z`),
            hotelCheckOut: new Date(`${CHECK_OUT}T00:00:00.000Z`),
            roomsBilled: new Prisma.Decimal(1),
          },
        ],
      },
      passengers: {
        create: Array.from({ length: opts.passengerCount }, (_, i) => ({
          fullName: `PAX ${i + 1}`,
          lastName: 'PAX',
          firstName: String(i + 1),
          documentType: 'PASSPORT' as const,
          documentNumber: uniq('P'),
          dateOfBirth: new Date('1990-01-01'),
          nationality: 'CHN',
        })),
      },
    },
    include: { items: true, passengers: true },
  });
}

type Created = Awaited<ReturnType<typeof createOrder>>;
const group = (o: Created, fraction: number) => ({
  orderId: o.id,
  orderItemId: o.items[0]!.id,
  passengerIds: [o.passengers[0]!.id],
  roomFraction: fraction,
});

/** 三张四星随机单（两张形态①、一张形态②）合成一间档次房 1+0+0。*/
async function seedTierRoom(actor: { userId: string; role: UserRole }) {
  const placeholder = await createPlaceholderHotel();
  const a = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
  const b = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
  const c = await createOrder({ roomTypeId: placeholder.roomType.id, passengerCount: 1 });
  const result = await saveSharedRooms(
    {
      randomStarTier: TIER,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      requestToken: requestToken(),
      rooms: [{ groups: [group(a, 1), group(b, 0), group(c, 0)] }],
      dissolve: [],
    },
    actor,
  );
  const sharedRoomId = result.rooms[0]!.sharedRoomId;
  return { placeholder, a, b, c, sharedRoomId, version: result.rooms[0]!.version };
}

describe('档次房 · 工作台候选与保存', () => {
  it('随机档作用域候选 = 形态① ∪ 形态②；真酒店作用域看不到它们', async () => {
    const placeholder = await createPlaceholderHotel();
    const real = await createRealHotel(2);
    const a = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    const c = await createOrder({ roomTypeId: placeholder.roomType.id, passengerCount: 1 });
    const other = await createOrder({ randomStarTier: 3, passengerCount: 1 }); // 三星随机，不在四星池
    const atReal = await createOrder({ roomTypeId: real.roomType.id, passengerCount: 1 });

    const wb = await getSharedRoomWorkbench({ randomStarTier: TIER }, CHECK_IN, CHECK_OUT);
    const ids = wb.orders.map((o) => o.orderId).sort();
    expect(ids).toEqual([a.id, c.id].sort());
    expect(ids).not.toContain(other.id);
    expect(ids).not.toContain(atReal.id);
    for (const o of wb.orders) {
      expect(o.items[0]!.randomStarTier).toBe(TIER);
      expect(o.items[0]!.roomTypeName).toBe('四星随机（待落位）');
    }
    const wbReal = await getSharedRoomWorkbench({ hotelId: real.hotel.id }, CHECK_IN, CHECK_OUT);
    expect(wbReal.orders.map((o) => o.orderId)).toEqual([atReal.id]);
  });

  it('三张单 1+0+0 合一间档次房：SharedRoom 是档次房、roomsBilled 1/0/0、随机池只占 1 间（聚合 + 销控板）', async () => {
    const actor = await adminActor();
    await createRealHotel(3); // 四星真酒店包 3 间 → 该档 hasBlock
    const { a, b, c, sharedRoomId } = await seedTierRoom(actor);

    const room = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: sharedRoomId }, include: { members: true } });
    expect(room.hotelId).toBeNull();
    expect(room.hotelRoomTypeId).toBeNull();
    expect(room.randomStarTier).toBe(TIER);
    expect(room.members).toHaveLength(3);

    const billed = await Promise.all(
      [a, b, c].map(async (o) => Number((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } })).roomsBilled)),
    );
    expect(billed).toEqual([1, 0, 0]);

    // 随机池床位口径：pendingUsed = Σ 未落位行 roomsBilled = 1（不是 3）
    const agg = await getRandomTierAggregate(TIER, [CHECK_IN, '2026-10-02']);
    expect(agg.pendingUsed).toEqual([1, 1]);
    expect(agg.hotelUsed).toEqual([0, 0]);

    // 销控板随机池行：used（床位）= 1，physicalUsed（共享房去重）= 1
    const board = await getBoard({ from: CHECK_IN, to: CHECK_IN });
    const pool = board.hotels.find((h) => h.randomStarTier === TIER);
    expect(pool).toBeDefined();
    expect(pool!.rows.used).toEqual([1]);
    expect(pool!.rows.physicalUsed).toEqual([1]);

    // 订单 JSON 镜像：共享组带 sharedRoomId，房型文本「待落位」
    const orderA = await prisma.order.findUniqueOrThrow({ where: { id: a.id } });
    const groups = (orderA.roomAssignment as { roomGroups: Array<Record<string, unknown>> }).roomGroups;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sharedRoomId).toBe(sharedRoomId);
    expect(groups[0]!.roomType).toBe('待落位');
  });

  it('跨模式混入：档次房里混真酒店行 400；酒店房里混随机行 400；三星行进四星档 400', async () => {
    const actor = await adminActor();
    const real = await createRealHotel(2);
    const a = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    const atReal = await createOrder({ roomTypeId: real.roomType.id, passengerCount: 1 });
    const three = await createOrder({ randomStarTier: 3, passengerCount: 1 });

    await expect(
      saveSharedRooms(
        {
          randomStarTier: TIER,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: requestToken(),
          rooms: [{ groups: [group(a, 1), group(atReal, 0)] }],
          dissolve: [],
        },
        actor,
      ),
    ).rejects.toThrow(/已落位到真实酒店/);

    await expect(
      saveSharedRooms(
        {
          hotelId: real.hotel.id,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: requestToken(),
          rooms: [{ hotelRoomTypeId: real.roomType.id, groups: [group(atReal, 1), group(a, 0)] }],
          dissolve: [],
        },
        actor,
      ),
    ).rejects.toThrow(/未落位的随机档/);

    await expect(
      saveSharedRooms(
        {
          randomStarTier: TIER,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: requestToken(),
          rooms: [{ groups: [group(a, 1), group(three, 0)] }],
          dissolve: [],
        },
        actor,
      ),
    ).rejects.toThrow(/三星随机，不属于四星随机/);

    // 没有任何一间房被建出来
    expect(await prisma.sharedRoom.count()).toBe(0);
  });

  it('档次房 Σ份额≠1 仍硬拒', async () => {
    const actor = await adminActor();
    const a = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    const b = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    await expect(
      saveSharedRooms(
        {
          randomStarTier: TIER,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: requestToken(),
          rooms: [{ groups: [group(a, 1), group(b, 0.5)] }],
          dissolve: [],
        },
        actor,
      ),
    ).rejects.toThrow(/计费份额合计须为 1/);
  });
});

describe('档次房 · 整房落位', () => {
  it('目标酒店只包 1 间也能整房落位：共享房转酒店房、成员不解绑、随机池占用转到该酒店、逐单审计', async () => {
    const actor = await adminActor();
    const target = await createRealHotel(1, { starRating: 5 });
    const { a, b, c, sharedRoomId, version } = await seedTierRoom(actor);

    const result = await placeSharedRoom(sharedRoomId, { hotelRoomTypeId: target.roomType.id, expectedVersion: version }, actor);
    expect(result.hotelId).toBe(target.hotel.id);
    expect(result.placedItems.map((p) => p.orderId).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(result.version).toBe(version + 1);

    const room = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: sharedRoomId }, include: { members: true } });
    expect(room.status).toBe('ACTIVE');
    expect(room.hotelId).toBe(target.hotel.id);
    expect(room.hotelRoomTypeId).toBe(target.roomType.id);
    expect(room.randomStarTier).toBeNull();
    expect(room.members).toHaveLength(3); // 不解绑

    for (const o of [a, b, c]) {
      const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } });
      expect(item.hotelRoomTypeId).toBe(target.roomType.id);
      expect(item.randomStarTier).toBeNull();
      expect(item.description).toContain(target.hotel.name);
      expect(Number(item.unitCostCny)).toBe(300); // HOTEL 行成本按新房型重打
    }
    const billed = await Promise.all(
      [a, b, c].map(async (o) => Number((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } })).roomsBilled)),
    );
    expect(billed).toEqual([1, 0, 0]); // 份额不动、钱不动

    // 随机池：未落位占用 0；目标酒店：床位 1、物理 1（去重），block=1 → physicalRemaining 0（不是 -2）
    const agg = await getRandomTierAggregate(TIER, [CHECK_IN]);
    expect(agg.pendingUsed).toEqual([0]);
    const nightly = await getHotelNightlyRemaining(target.hotel.id, [CHECK_IN]);
    expect(nightly.remaining).toEqual([0]);
    expect(nightly.physicalRemaining).toEqual([0]);
    expect(await computeSharedRoomPhysicalByDate({ randomStarTier: TIER }, [CHECK_IN])).toEqual([0]);
    expect(await computeSharedRoomPhysicalByDate(target.hotel.id, [CHECK_IN])).toEqual([1]);

    // 订单 JSON：共享组仍带 sharedRoomId，房型文本刷成真实房型名
    const orderA = await prisma.order.findUniqueOrThrow({ where: { id: a.id } });
    const groups = (orderA.roomAssignment as { roomGroups: Array<Record<string, unknown>> }).roomGroups;
    expect(groups[0]!.sharedRoomId).toBe(sharedRoomId);
    expect(groups[0]!.roomType).toBe(target.roomType.name);

    const swapAudits = await prisma.auditLog.count({ where: { action: 'SWAP_ORDER_ITEM_HOTEL' } });
    expect(swapAudits).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: 'PLACE_SHARED_ROOM' } })).toBe(1);

    // 落位后这间房在目标酒店的工作台里可见、且已是酒店房
    const wb = await getSharedRoomWorkbench({ hotelId: target.hotel.id }, CHECK_IN, CHECK_OUT);
    expect(wb.sharedRooms.map((r) => r.sharedRoomId)).toEqual([sharedRoomId]);
    expect(wb.sharedRooms[0]!.randomStarTier).toBeNull();
  });

  it('拒绝：指定酒店加价 > 0 整体 400 并列出每张单；版本过期 409；已是酒店房 400；星级低于档次 400', async () => {
    const actor = await adminActor();
    const { a, b, c, sharedRoomId, version } = await seedTierRoom(actor);
    const surcharged = await createRealHotel(3, { surcharge: 100 });
    const lowStar = await createRealHotel(3, { starRating: 3 });
    const target = await createRealHotel(3);

    await expect(
      placeSharedRoom(sharedRoomId, { hotelRoomTypeId: surcharged.roomType.id, expectedVersion: version }, actor),
    ).rejects.toThrow(new RegExp(`指定酒店加价 ¥100/人.*${a.orderNumber}.*${b.orderNumber}.*${c.orderNumber}`));
    await expect(
      placeSharedRoom(sharedRoomId, { hotelRoomTypeId: lowStar.roomType.id, expectedVersion: version }, actor),
    ).rejects.toThrow(/只能落到 4 星及以上/);
    await expect(
      placeSharedRoom(sharedRoomId, { hotelRoomTypeId: target.roomType.id, expectedVersion: version + 5 }, actor),
    ).rejects.toThrow(/已被他人修改/);
    // 拒绝路径什么都没写
    const untouched = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: sharedRoomId } });
    expect(untouched.randomStarTier).toBe(TIER);
    expect(untouched.version).toBe(version);
    expect(await prisma.auditLog.count({ where: { action: 'PLACE_SHARED_ROOM' } })).toBe(0);

    await placeSharedRoom(sharedRoomId, { hotelRoomTypeId: target.roomType.id, expectedVersion: version }, actor);
    await expect(
      placeSharedRoom(sharedRoomId, { hotelRoomTypeId: target.roomType.id, expectedVersion: version + 1 }, actor),
    ).rejects.toThrow(/已经是酒店房/);
  });

  it('拒绝：目标酒店包房不足（唯一 1 间已被别的单占着）→ §五闸 400，随机池不动', async () => {
    const actor = await adminActor();
    const target = await createRealHotel(1);
    await createOrder({ roomTypeId: target.roomType.id, passengerCount: 1 }); // 把唯一 1 间占掉
    const { sharedRoomId, version } = await seedTierRoom(actor);
    await expect(
      placeSharedRoom(sharedRoomId, { hotelRoomTypeId: target.roomType.id, expectedVersion: version }, actor),
    ).rejects.toThrow(/实际房间不足/);
    expect((await getRandomTierAggregate(TIER, [CHECK_IN])).pendingUsed).toEqual([1]);
  });
});

describe('档次房 · 解绑矩阵 / 解散 / 成员取消 三条路径对称', () => {
  it('单个成员单独换酒店（不走整房落位）→ 仍自动解绑 + 警告；其余成员留在档次房，之后整房落位照常', async () => {
    const actor = await adminActor();
    const target = await createRealHotel(2);
    const { a, b, c, sharedRoomId } = await seedTierRoom(actor);

    // 0 份额成员 c（形态②）单独落到真酒店 → 解绑
    const { audit } = await orderService.swapItemHotel(
      c.id,
      c.items[0]!.id,
      { newHotelRoomTypeId: target.roomType.id, feeCny: 0 },
      { userId: actor.userId, role: UserRole.ADMIN },
    );
    expect(audit.warnings.length).toBeGreaterThan(0);
    expect(await prisma.sharedRoomMember.count({ where: { orderId: c.id } })).toBe(0);
    const room = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: sharedRoomId }, include: { members: true } });
    expect(room.status).toBe('ACTIVE');
    expect(room.randomStarTier).toBe(TIER);
    expect(room.members.map((m) => m.orderId).sort()).toEqual([a.id, b.id].sort());
    // c 解绑后：钱不动（roomsBilled 仍 0），物理按普通房组 1 间落到目标酒店
    expect(Number((await prisma.orderItem.findUniqueOrThrow({ where: { id: c.items[0]!.id } })).roomsBilled)).toBe(0);
    expect((await getHotelNightlyRemaining(target.hotel.id, [CHECK_IN])).physicalRemaining).toEqual([1]);
    // 随机池：a(1)+b(0) 仍占 1 间床位、1 间物理
    expect((await getRandomTierAggregate(TIER, [CHECK_IN])).pendingUsed).toEqual([1]);
    expect(await computeSharedRoomPhysicalByDate({ randomStarTier: TIER }, [CHECK_IN])).toEqual([1]);

    // 剩下两人整房落位到同一家酒店（version 已因解绑 +1）
    const placed = await placeSharedRoom(sharedRoomId, { hotelRoomTypeId: target.roomType.id, expectedVersion: room.version }, actor);
    expect(placed.placedItems.map((p) => p.orderId).sort()).toEqual([a.id, b.id].sort());
    // 目标酒店：c 的普通组 1 间 + 共享房 1 间 = 2 间物理 → block 2 剩 0
    expect((await getHotelNightlyRemaining(target.hotel.id, [CHECK_IN])).physicalRemaining).toEqual([0]);
    expect((await getRandomTierAggregate(TIER, [CHECK_IN])).pendingUsed).toEqual([0]);
  });

  it('解散档次房：成员退回普通房组、份额原样保留（Σ roomsBilled 仍 1）、物理按普通组各 1 间', async () => {
    const actor = await adminActor();
    await createRealHotel(3);
    const { a, b, c, sharedRoomId, version } = await seedTierRoom(actor);
    const result = await saveSharedRooms(
      {
        randomStarTier: TIER,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        expectedVersions: { [sharedRoomId]: version },
        rooms: [],
        dissolve: [sharedRoomId],
      },
      actor,
    );
    expect(result.dissolved).toEqual([sharedRoomId]);
    const room = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: sharedRoomId } });
    expect(room.status).toBe('DISSOLVED');
    const billed = await Promise.all(
      [a, b, c].map(async (o) => Number((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } })).roomsBilled)),
    );
    expect(billed).toEqual([1, 0, 0]); // 钱不动
    expect((await getRandomTierAggregate(TIER, [CHECK_IN])).pendingUsed).toEqual([1]); // 床位口径 Σ 仍 1
    const board = await getBoard({ from: CHECK_IN, to: CHECK_IN });
    const pool = board.hotels.find((h) => h.randomStarTier === TIER)!;
    expect(pool.rows.used).toEqual([1]);
    expect(pool.rows.physicalUsed).toEqual([3]); // 三个普通房组各 1 间（0 份额普通组按 1 间计，§八解绑口径）
    expect(await computeSharedRoomPhysicalByDate({ randomStarTier: TIER }, [CHECK_IN])).toEqual([0]);
  });

  it('计费方订单取消：随机池床位口径降到 0，档次房物理仍 1 间（留守 0 份额成员），孤儿提醒带档次', async () => {
    const actor = await adminActor();
    await createRealHotel(3);
    const { a, sharedRoomId } = await seedTierRoom(actor);
    await prisma.order.update({ where: { id: a.id }, data: { status: OrderStatus.CANCELLED } });

    expect((await getRandomTierAggregate(TIER, [CHECK_IN])).pendingUsed).toEqual([0]);
    expect(await computeSharedRoomPhysicalByDate({ randomStarTier: TIER }, [CHECK_IN])).toEqual([1]);
    const alerts = await getAlerts(30);
    const orphan = alerts.sharedRoomOrphaned.find((x) => x.sharedRoomId === sharedRoomId);
    expect(orphan).toBeDefined();
    expect(orphan!.hotelId).toBeNull();
    expect(orphan!.randomStarTier).toBe(TIER);
    expect(orphan!.hotelName).toBe('四星随机');
  });
});
