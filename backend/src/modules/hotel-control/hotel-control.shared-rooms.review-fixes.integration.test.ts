/**
 * 跨单分房 · 上线前评审两条修复的真 DB 回归（2026-09-20）
 *
 *   F1（整房落位 · 住宿行 ≠ 物理房间）：一条住宿行同时承载本共享房以外的房组（普通房组 /
 *      另一间共享房）时，整房落位会把整条行连同别的房组一起迁走、却只把本房主档转酒店房。
 *      短修：锁后校验，任一成员行还承载别的房组 → 400、不落任何库；单房独占住宿行照常成功。
 *
 *   F2（随机池增量闸 · 前瞻闸必须与实际占用同口径）：池聚合只数房控有效订单，已取消的
 *      计费方从池里消失时并没有「释放」库存；工作台移除它、把份额转给别人保存，增量必须只
 *      统计房控有效订单（否则 −1 抵掉 +1，真实 +1 绕过闸）。酒店房同款闸的变更后快照同口径。
 *
 * 跑：docker compose -f ../docker-compose.test.yml up -d && npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { saveSharedRooms } from './hotel-control.shared-rooms.js';
import type { SaveSharedRoomsBody } from './hotel-control.schemas.js';
import { placeSharedRoom } from './shared-room-placement.js';
import {
  computeSharedRoomPhysicalByDate,
  getHotelNightlyRemaining,
  getRandomTierAggregate,
} from './hotel-control.service.js';

const CHECK_IN = '2026-10-01';
const CHECK_OUT = '2026-10-03';
const NIGHTS = ['2026-10-01', '2026-10-02'];
const TIER = 4;

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
const requestToken = () => uniq('req');

async function adminActor(): Promise<{ userId: string; role: UserRole }> {
  const admin = await prisma.user.create({ data: { email: `${uniq('u')}@test.com`, role: UserRole.ADMIN } });
  return { userId: admin.id, role: UserRole.ADMIN };
}

/** 真酒店（星级默认 4）+ 房型 + 包房周期（rooms 间；0 = 不切房）。*/
async function createRealHotel(rooms: number, opts: { starRating?: number } = {}) {
  const hotel = await prisma.hotel.create({
    data: {
      name: uniq('Hotel'),
      cityCode: 'DAD',
      address: 'Test address',
      starRating: opts.starRating ?? TIER,
      isActive: true,
      designationSurchargeCnyPerPerson: 0,
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

/** PAID 订单，1 条 HOTEL 行 + N 位乘客。形态①随机行：randomStarTier；真酒店行：roomTypeId。*/
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
/** 该单第 paxIndex 位乘客、挂在唯一住宿行上的成员组。*/
const group = (o: Created, fraction: number, paxIndex = 0) => ({
  orderId: o.id,
  orderItemId: o.items[0]!.id,
  passengerIds: [o.passengers[paxIndex]!.id],
  roomFraction: fraction,
});

async function roomsBilledOf(o: Created): Promise<number> {
  return Number((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } })).roomsBilled);
}

describe('F1 · 整房落位：成员住宿行必须只承载本共享房', () => {
  it('同一住宿行承载两间档次房（A1+B 合住 S1、A2+C 合住 S2）→ 对 S1 整房落位 400，两间房与三张单都不动', async () => {
    const actor = await adminActor();
    const target = await createRealHotel(2, { starRating: 5 });
    await createRealHotel(3); // 四星真酒店切房 → 该档 hasBlock
    const a = await createOrder({ randomStarTier: TIER, passengerCount: 2 });
    const b = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    const c = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    const saved = await saveSharedRooms(
      {
        randomStarTier: TIER,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [
          { groups: [group(a, 1, 0), group(b, 0)] }, // S1：A 的住宿行 IA 上的 A1 + B
          { groups: [group(a, 0, 1), group(c, 1)] }, // S2：同一条 IA 上的 A2 + C
        ],
        dissolve: [],
      },
      actor,
    );
    const [s1, s2] = saved.rooms;
    expect(await roomsBilledOf(a)).toBe(1); // IA 在 S1 计 1、在 S2 计 0 → 行级 Σ = 1
    const poolBefore = await getRandomTierAggregate(TIER, NIGHTS);
    expect(poolBefore.pendingUsed).toEqual([2, 2]); // IA(1) + IC(1)

    await expect(
      placeSharedRoom(s1!.sharedRoomId, { hotelRoomTypeId: target.roomType.id, expectedVersion: s1!.version }, actor),
    ).rejects.toThrow(new RegExp(`整房落位未执行.*${a.orderNumber}.*还承载 1 间其它共享房.*拆房组`));

    // 拒绝路径什么都没写：两间房仍是档次房、版本不动；三条行仍未落位；目标酒店无占用；池不动
    for (const r of [s1!, s2!]) {
      const room = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: r.sharedRoomId }, include: { members: true } });
      expect(room.status).toBe('ACTIVE');
      expect(room.hotelId).toBeNull();
      expect(room.randomStarTier).toBe(TIER);
      expect(room.version).toBe(r.version);
      expect(room.members).toHaveLength(2);
    }
    for (const o of [a, b, c]) {
      const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } });
      expect(item.hotelRoomTypeId).toBeNull();
      expect(item.randomStarTier).toBe(TIER);
    }
    const orderA = await prisma.order.findUniqueOrThrow({ where: { id: a.id } });
    const groupsA = (orderA.roomAssignment as { roomGroups: Array<Record<string, unknown>> }).roomGroups;
    expect(groupsA.map((g) => g.roomType)).toEqual(['待落位', '待落位']);
    expect((await getHotelNightlyRemaining(target.hotel.id, NIGHTS)).physicalRemaining).toEqual([2, 2]);
    expect(await computeSharedRoomPhysicalByDate(target.hotel.id, NIGHTS)).toEqual([0, 0]);
    expect((await getRandomTierAggregate(TIER, NIGHTS)).pendingUsed).toEqual(poolBefore.pendingUsed);
    expect(await prisma.auditLog.count({ where: { action: { in: ['PLACE_SHARED_ROOM', 'SWAP_ORDER_ITEM_HOTEL'] } } })).toBe(0);
  });

  it('同一住宿行还承载一个普通房组（A2 单独一组）→ 整房落位 400，文案点名普通房组', async () => {
    const actor = await adminActor();
    const target = await createRealHotel(2, { starRating: 5 });
    const a = await createOrder({ randomStarTier: TIER, passengerCount: 2 });
    const b = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    const saved = await saveSharedRooms(
      {
        randomStarTier: TIER,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [{ groups: [group(a, 1, 0), group(b, 0)] }],
        dissolve: [],
      },
      actor,
    );
    const s1 = saved.rooms[0]!;
    // 单单分房编辑器给 A2 在同一条住宿行上另开一个普通房组（归属 IA、不带 sharedRoomId）
    const orderA = await prisma.order.findUniqueOrThrow({ where: { id: a.id } });
    const groupsA = (orderA.roomAssignment as { roomGroups: Array<Record<string, unknown>> }).roomGroups;
    await prisma.order.update({
      where: { id: a.id },
      data: {
        roomAssignment: {
          roomGroups: [
            ...groupsA,
            {
              id: uniq('g'),
              hotelName: '四星随机（待落位）',
              roomType: '待落位',
              passengerIds: [a.passengers[1]!.id],
              orderItemId: a.items[0]!.id,
              roomFraction: 1,
            },
          ],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await expect(
      placeSharedRoom(s1.sharedRoomId, { hotelRoomTypeId: target.roomType.id, expectedVersion: s1.version }, actor),
    ).rejects.toThrow(new RegExp(`${a.orderNumber}.*还承载 1 个普通房组`));
    const room = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: s1.sharedRoomId } });
    expect(room.randomStarTier).toBe(TIER);
    expect(room.version).toBe(s1.version);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: a.items[0]!.id } })).hotelRoomTypeId).toBeNull();
    expect(await computeSharedRoomPhysicalByDate(target.hotel.id, NIGHTS)).toEqual([0, 0]);
  });

  it('N3：同一住宿行上还挂着一个无归属（orderItemId 为空）的随机占位房组（旧数据/手改 JSON）→ 400，落库不动', async () => {
    // 只取 roomGroupItemId(g) === it.id 的房组做行独占校验，会漏掉这类孤儿房组
    // （2026-09-20 第二轮复审 N3）：它既不算「本行归属」也不会在落位后被刷新，
    // 得靠校验里把「本单无归属且 hotelName 是本档随机文案」的组一并计入 plainGroupCount 挡住。
    const actor = await adminActor();
    const target = await createRealHotel(2, { starRating: 5 });
    const a = await createOrder({ randomStarTier: TIER, passengerCount: 2 });
    const b = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    const saved = await saveSharedRooms(
      {
        randomStarTier: TIER,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [{ groups: [group(a, 1, 0), group(b, 0)] }],
        dissolve: [],
      },
      actor,
    );
    const s1 = saved.rooms[0]!;
    // 手改 JSON：追加一个孤儿房组，文本与本档随机占位文案一致，但不带 orderItemId 归属。
    const orderA = await prisma.order.findUniqueOrThrow({ where: { id: a.id } });
    const groupsA = (orderA.roomAssignment as { roomGroups: Array<Record<string, unknown>> }).roomGroups;
    await prisma.order.update({
      where: { id: a.id },
      data: {
        roomAssignment: {
          roomGroups: [
            ...groupsA,
            {
              id: uniq('g'),
              hotelName: '四星随机（待落位）',
              roomType: '待落位',
              passengerIds: [a.passengers[1]!.id],
              orderItemId: null,
              roomFraction: 1,
            },
          ],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await expect(
      placeSharedRoom(s1.sharedRoomId, { hotelRoomTypeId: target.roomType.id, expectedVersion: s1.version }, actor),
    ).rejects.toThrow(new RegExp(`${a.orderNumber}.*还承载 1 个普通房组`));
    const room = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: s1.sharedRoomId } });
    expect(room.randomStarTier).toBe(TIER);
    expect(room.version).toBe(s1.version);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: a.items[0]!.id } })).hotelRoomTypeId).toBeNull();
    expect(await computeSharedRoomPhysicalByDate(target.hotel.id, NIGHTS)).toEqual([0, 0]);
  });

  it('回归：每位成员的住宿行只承载本房 → 整房落位照常成功，目标酒店物理占 1 间', async () => {
    const actor = await adminActor();
    const target = await createRealHotel(1, { starRating: 5 });
    const a = await createOrder({ randomStarTier: TIER, passengerCount: 2 });
    const b = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    const saved = await saveSharedRooms(
      {
        randomStarTier: TIER,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        // A 的两位乘客同在一组：一条行、一间房、没有别的房组
        rooms: [{ groups: [{ ...group(a, 1, 0), passengerIds: a.passengers.map((p) => p.id) }, group(b, 0)] }],
        dissolve: [],
      },
      actor,
    );
    const s1 = saved.rooms[0]!;
    const result = await placeSharedRoom(s1.sharedRoomId, { hotelRoomTypeId: target.roomType.id, expectedVersion: s1.version }, actor);
    expect(result.placedItems.map((p) => p.orderId).sort()).toEqual([a.id, b.id].sort());
    const room = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: s1.sharedRoomId }, include: { members: true } });
    expect(room.hotelId).toBe(target.hotel.id);
    expect(room.randomStarTier).toBeNull();
    expect(room.members).toHaveLength(3);
    expect(await computeSharedRoomPhysicalByDate(target.hotel.id, NIGHTS)).toEqual([1, 1]);
    expect((await getHotelNightlyRemaining(target.hotel.id, NIGHTS)).physicalRemaining).toEqual([0, 0]);
    expect((await getRandomTierAggregate(TIER, NIGHTS)).pendingUsed).toEqual([0, 0]);
  });
});

describe('F2 · 随机池增量闸只统计房控有效订单（与池聚合同口径）', () => {
  /** 四星池只切 blockRooms 间；S = A(1)+B(0)+C(0)；A 取消后再有一张随机单 D 占 1 间。*/
  async function seedCancelledPayer(blockRooms: number) {
    const actor = await adminActor();
    await createRealHotel(blockRooms);
    const a = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    const b = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    const c = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    const saved = await saveSharedRooms(
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
    const room = saved.rooms[0]!;
    await prisma.order.update({ where: { id: a.id }, data: { status: OrderStatus.CANCELLED } });
    const d = await createOrder({ randomStarTier: TIER, passengerCount: 1 });
    // 池现状：A 已取消不计；D 占 1 → pendingUsed 1
    expect((await getRandomTierAggregate(TIER, NIGHTS)).pendingUsed).toEqual([1, 1]);
    return { actor, a, b, c, d, room };
  }

  const transferToB = (room: { sharedRoomId: string; version: number }, b: Created, c: Created): SaveSharedRoomsBody => ({
    randomStarTier: TIER,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    requestToken: requestToken(),
    expectedVersions: { [room.sharedRoomId]: room.version },
    rooms: [{ sharedRoomId: room.sharedRoomId, groups: [group(b, 1), group(c, 0)] }],
    dissolve: [] as string[],
  });

  it('计费方已取消、池已满：移除 A 并把份额转给 B → 400（A 的 −1 不是可释放库存），落库不动', async () => {
    const { actor, a, b, c, room } = await seedCancelledPayer(1); // block 1，D 已占满
    await expect(saveSharedRooms(transferToB(room, b, c), actor)).rejects.toThrow(
      /四星随机余量不足（2026-10-01 同星级酒店合计余量 0 间，本次分房后需再占 1 间）/,
    );
    expect((await getRandomTierAggregate(TIER, NIGHTS)).pendingUsed).toEqual([1, 1]);
    expect(await roomsBilledOf(a)).toBe(1); // 取消单的行没被改
    expect(await roomsBilledOf(b)).toBe(0);
    const current = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: room.sharedRoomId }, include: { members: true } });
    expect(current.version).toBe(room.version);
    expect(current.members.map((m) => m.orderId).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('计费方已取消、池未满：同一操作成功，池占用 +1（D 的 1 + B 的 1）', async () => {
    const { actor, a, b, c, d, room } = await seedCancelledPayer(2); // block 2，还剩 1
    const result = await saveSharedRooms(transferToB(room, b, c), actor);
    expect(result.rooms[0]!.version).toBe(room.version + 1);
    expect((await getRandomTierAggregate(TIER, NIGHTS)).pendingUsed).toEqual([2, 2]);
    expect(await roomsBilledOf(b)).toBe(1);
    expect(await roomsBilledOf(c)).toBe(0);
    expect(await roomsBilledOf(a)).toBe(0); // A 被移出：行级显式写 0（本就不计入池）
    expect(await roomsBilledOf(d)).toBe(1);
    const current = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: room.sharedRoomId }, include: { members: true } });
    expect(current.members.map((m) => m.orderId).sort()).toEqual([b.id, c.id].sort());
    expect(await computeSharedRoomPhysicalByDate({ randomStarTier: TIER }, NIGHTS)).toEqual([1, 1]);
  });

  it('酒店房同款闸：取消成员的行不再算进「变更后」快照（此前会把它当新增 1 间误拒）', async () => {
    const actor = await adminActor();
    const hotel = await createRealHotel(1); // 只包 1 间：S 本身就占满
    const a = await createOrder({ roomTypeId: hotel.roomType.id, passengerCount: 1 });
    const b = await createOrder({ roomTypeId: hotel.roomType.id, passengerCount: 1 });
    const saved = await saveSharedRooms(
      {
        hotelId: hotel.hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [{ hotelRoomTypeId: hotel.roomType.id, groups: [group(a, 1), group(b, 0)] }],
        dissolve: [],
      },
      actor,
    );
    const room = saved.rooms[0]!;
    await prisma.order.update({ where: { id: a.id }, data: { status: OrderStatus.CANCELLED } });
    expect((await getHotelNightlyRemaining(hotel.hotel.id, NIGHTS)).physicalRemaining).toEqual([0, 0]); // S（B 有效）占 1

    // 移除 A、份额转给 B：变更前后都是 S 占 1 间，不该被 A 的行误算成 2 间
    const result = await saveSharedRooms(
      {
        hotelId: hotel.hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        expectedVersions: { [room.sharedRoomId]: room.version },
        rooms: [{ sharedRoomId: room.sharedRoomId, hotelRoomTypeId: hotel.roomType.id, groups: [group(b, 1)] }],
        dissolve: [],
      },
      actor,
    );
    expect(result.rooms[0]!.version).toBe(room.version + 1);
    expect(await roomsBilledOf(b)).toBe(1);
    expect((await getHotelNightlyRemaining(hotel.hotel.id, NIGHTS)).physicalRemaining).toEqual([0, 0]);
    expect(await computeSharedRoomPhysicalByDate(hotel.hotel.id, NIGHTS)).toEqual([1, 1]);
  });
});
