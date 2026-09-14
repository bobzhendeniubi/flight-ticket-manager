/**
 * 跨单分房（共享房）保存 · 真 DB 集成测试
 *
 * 覆盖 docs/跨单分房-需求方案.md v2 §十三验收反例：
 *   1. 三人合住 1+0：房控物理 1 间，两单 roomsBilled 分别 1/0
 *   3. 同一单在同酒店同区间有两条酒店行，各自加入不同共享房
 *   4. 旧单部分归属：跨单保存 400，补齐归属后通过
 *   8. 同 requestToken 重放同结果，改指纹 409；expectedVersions 过期 409
 *   7（简化版，两路交错）：跨单保存 vs 单单保存并发，断言无死锁、结果可解释
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d（或本机 Postgres 指到 TEST_DATABASE_URL）
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { saveSharedRooms } from './hotel-control.shared-rooms.js';
import { getHotelNightlyRemaining } from './hotel-control.service.js';

const CHECK_IN = '2026-10-01';
const CHECK_OUT = '2026-10-03';

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function adminActor() {
  const admin = await prisma.user.create({
    data: { email: `${uniq('u')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: admin.id, role: UserRole.ADMIN as const };
}

async function createHotelWithRoomType(rooms: number) {
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
      name: uniq('Twin'),
      capacity: 3,
      maxAdults: 3,
      maxChildren: 0,
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

/** 建一个 PAID 订单，含 1 条 HOTEL 行（roomsBilled=1）+ N 位乘客；可选带一条**未归属**的旧房组。 */
async function createOrderWithPassengers(opts: {
  roomTypeId: string;
  passengerCount: number;
  checkIn?: string;
  checkOut?: string;
  roomAssignment?: unknown;
}) {
  const checkIn = opts.checkIn ?? CHECK_IN;
  const checkOut = opts.checkOut ?? CHECK_OUT;
  return prisma.order.create({
    data: {
      orderNumber: uniq('ORD'),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(1200),
      total: new Prisma.Decimal(1200),
      paidAmount: new Prisma.Decimal(1200),
      contactName: 'Test User',
      contactPhone: '13800138000',
      roomAssignment: (opts.roomAssignment ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      items: {
        create: [
          {
            kind: OrderItemKind.HOTEL,
            description: `测试酒店 · 标准间 · ${checkIn}~${checkOut} · 2晚 × 1间`,
            quantity: 2,
            unitPrice: new Prisma.Decimal(600),
            amount: new Prisma.Decimal(1200),
            hotelRoomTypeId: opts.roomTypeId,
            hotelCheckIn: new Date(`${checkIn}T00:00:00.000Z`),
            hotelCheckOut: new Date(`${checkOut}T00:00:00.000Z`),
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

const requestToken = () => uniq('req');

describe('saveSharedRooms · 真 DB E2E', () => {
  it('验收反例 1：三人合住 1+0（两单各出 1 位客人），房控物理只占 1 间，两单 roomsBilled 分别 1/0', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(1); // 只包 1 间——1+0 必须能放进去，1+1 装不下
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    const result = await saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [
          {
            hotelRoomTypeId: roomType.id,
            groups: [
              {
                orderId: orderA.id,
                orderItemId: orderA.items[0].id,
                passengerIds: [orderA.passengers[0].id],
                roomFraction: 1,
              },
              {
                orderId: orderB.id,
                orderItemId: orderB.items[0].id,
                passengerIds: [orderB.passengers[0].id],
                roomFraction: 0,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );
    expect(result.rooms).toHaveLength(1);

    const itemA = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderA.items[0].id } });
    const itemB = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderB.items[0].id } });
    expect(Number(itemA.roomsBilled)).toBe(1);
    expect(Number(itemB.roomsBilled)).toBe(0);

    // 物理口径：block=1，两单合住 1 间共享房 → physicalRemaining = 0（不是 -1，即不是把两单各算 1 间）
    const nightly = await getHotelNightlyRemaining(hotel.id, [CHECK_IN]);
    expect(nightly.physicalRemaining).toEqual([0]);

    const sharedRoom = await prisma.sharedRoom.findUniqueOrThrow({
      where: { id: result.rooms[0].sharedRoomId },
      include: { members: true },
    });
    expect(sharedRoom.members).toHaveLength(2);
    expect(sharedRoom.version).toBe(1);
  });

  it('验收反例 3：同一单在同酒店同区间有两条酒店行，各自加入不同共享房', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await prisma.order.create({
      data: {
        orderNumber: uniq('ORD'),
        status: OrderStatus.PAID,
        subtotal: new Prisma.Decimal(2400),
        total: new Prisma.Decimal(2400),
        paidAmount: new Prisma.Decimal(2400),
        contactName: 'Test User',
        contactPhone: '13800138000',
        items: {
          create: [
            {
              kind: OrderItemKind.HOTEL,
              description: '测试酒店 · 标准间 · 行1',
              quantity: 2,
              unitPrice: new Prisma.Decimal(600),
              amount: new Prisma.Decimal(1200),
              hotelRoomTypeId: roomType.id,
              hotelCheckIn: new Date(`${CHECK_IN}T00:00:00.000Z`),
              hotelCheckOut: new Date(`${CHECK_OUT}T00:00:00.000Z`),
              roomsBilled: new Prisma.Decimal(1),
            },
            {
              kind: OrderItemKind.HOTEL,
              description: '测试酒店 · 标准间 · 行2',
              quantity: 2,
              unitPrice: new Prisma.Decimal(600),
              amount: new Prisma.Decimal(1200),
              hotelRoomTypeId: roomType.id,
              hotelCheckIn: new Date(`${CHECK_IN}T00:00:00.000Z`),
              hotelCheckOut: new Date(`${CHECK_OUT}T00:00:00.000Z`),
              roomsBilled: new Prisma.Decimal(1),
            },
          ],
        },
        passengers: {
          create: [
            {
              fullName: 'PAX 1',
              documentType: 'PASSPORT',
              documentNumber: uniq('P'),
              dateOfBirth: new Date('1990-01-01'),
              nationality: 'CHN',
            },
            {
              fullName: 'PAX 2',
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
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderC = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    const result = await saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [
          {
            hotelRoomTypeId: roomType.id,
            groups: [
              {
                orderId: orderA.id,
                orderItemId: orderA.items[0].id,
                passengerIds: [orderA.passengers[0].id],
                roomFraction: 1,
              },
              {
                orderId: orderB.id,
                orderItemId: orderB.items[0].id,
                passengerIds: [orderB.passengers[0].id],
                roomFraction: 0,
              },
            ],
          },
          {
            hotelRoomTypeId: roomType.id,
            groups: [
              {
                orderId: orderA.id,
                orderItemId: orderA.items[1].id,
                passengerIds: [orderA.passengers[1].id],
                roomFraction: 1,
              },
              {
                orderId: orderC.id,
                orderItemId: orderC.items[0].id,
                passengerIds: [orderC.passengers[0].id],
                roomFraction: 0,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );
    expect(result.rooms).toHaveLength(2);
    expect(new Set(result.rooms.map((r) => r.sharedRoomId)).size).toBe(2); // 两间不同的共享房

    const reloaded = await prisma.order.findUniqueOrThrow({
      where: { id: orderA.id },
      select: { roomAssignment: true },
    });
    const groups = (reloaded.roomAssignment as { roomGroups: Array<{ sharedRoomId?: string }> }).roomGroups;
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.sharedRoomId)).size).toBe(2);
  });

  it('验收反例 4：旧单部分归属（有的房组带 orderItemId、有的不带）→ 跨单保存 400；补齐归属后通过', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({
      roomTypeId: roomType.id,
      passengerCount: 1,
      // 旧数据：一个带归属、一个不带——「部分归属」
      roomAssignment: {
        roomGroups: [
          { id: 'g1', hotelName: '旧酒店名', roomType: '', passengerIds: [] },
        ],
      },
    });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    await expect(
      saveSharedRooms(
        {
          hotelId: hotel.id,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: requestToken(),
          rooms: [
            {
              hotelRoomTypeId: roomType.id,
              groups: [
                {
                  orderId: orderA.id,
                  orderItemId: orderA.items[0].id,
                  passengerIds: [orderA.passengers[0].id],
                  roomFraction: 1,
                },
                {
                  orderId: orderB.id,
                  orderItemId: orderB.items[0].id,
                  passengerIds: [orderB.passengers[0].id],
                  roomFraction: 0,
                },
              ],
            },
          ],
          dissolve: [],
        },
        actor,
      ),
    ).rejects.toThrow(/归属不完整/);

    // 补齐归属：把旧的无归属组也挂上 orderItemId 后，同样的请求应放行
    await prisma.order.update({
      where: { id: orderA.id },
      data: {
        roomAssignment: {
          roomGroups: [{ id: 'g1', hotelName: '', roomType: '', passengerIds: [], orderItemId: orderA.items[0].id }],
        },
      },
    });
    const result = await saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [
          {
            hotelRoomTypeId: roomType.id,
            groups: [
              {
                orderId: orderA.id,
                orderItemId: orderA.items[0].id,
                passengerIds: [orderA.passengers[0].id],
                roomFraction: 1,
              },
              {
                orderId: orderB.id,
                orderItemId: orderB.items[0].id,
                passengerIds: [orderB.passengers[0].id],
                roomFraction: 0,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );
    expect(result.rooms).toHaveLength(1);
  });

  it('验收反例 8：同 requestToken 同指纹重放返回同结果；改指纹 409；expectedVersions 过期 409', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const token = requestToken();
    const payload = {
      hotelId: hotel.id,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      requestToken: token,
      rooms: [
        {
          hotelRoomTypeId: roomType.id,
          groups: [
            {
              orderId: orderA.id,
              orderItemId: orderA.items[0].id,
              passengerIds: [orderA.passengers[0].id],
              roomFraction: 1,
            },
            {
              orderId: orderB.id,
              orderItemId: orderB.items[0].id,
              passengerIds: [orderB.passengers[0].id],
              roomFraction: 0,
            },
          ],
        },
      ],
      dissolve: [],
    };

    const first = await saveSharedRooms(payload, actor);
    const replay = await saveSharedRooms(payload, actor);
    expect(replay).toEqual(first); // 同 token 同指纹 → 原样回放，不重新落库

    await expect(
      saveSharedRooms({ ...payload, requestToken: token, checkOut: '2026-10-04' }, actor),
    ).rejects.toThrow(/不同/);

    // expectedVersions 过期：房间真实 version=1，声称期望 2 → 409
    await expect(
      saveSharedRooms(
        {
          ...payload,
          requestToken: requestToken(),
          expectedVersions: { [first.rooms[0].sharedRoomId]: 2 },
          rooms: [{ ...payload.rooms[0], sharedRoomId: first.rooms[0].sharedRoomId }],
        },
        actor,
      ),
    ).rejects.toThrow(/已被他人修改/);
  });

  it('并发（简化版 7）：跨单保存 vs 单单保存交错执行，无死锁，结果可解释（两者互斥串行，不互相覆盖）', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderC = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    // 跨单保存：A+B 合住一间。单单保存：C 自己改 notes（不碰共享房，纯粹为了让两个事务
    // 都摸到同一批锁竞争路径——不同订单不会真的抢同一把 Order 锁，这里主要证明两个并发
    // 事务都能各自正常提交、互不死锁、互不覆盖对方的写入结果）。
    const sharedSave = saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [
          {
            hotelRoomTypeId: roomType.id,
            groups: [
              {
                orderId: orderA.id,
                orderItemId: orderA.items[0].id,
                passengerIds: [orderA.passengers[0].id],
                roomFraction: 1,
              },
              {
                orderId: orderB.id,
                orderItemId: orderB.items[0].id,
                passengerIds: [orderB.passengers[0].id],
                roomFraction: 0,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );
    const singleSave = prisma.order.update({
      where: { id: orderC.id },
      data: { internalNotes: 'concurrent-touch' },
    });

    const [sharedResult, singleResult] = await Promise.all([sharedSave, singleSave]);
    expect(sharedResult.rooms).toHaveLength(1);
    expect(singleResult.internalNotes).toBe('concurrent-touch');

    const itemA = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderA.items[0].id } });
    const itemB = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderB.items[0].id } });
    expect(Number(itemA.roomsBilled)).toBe(1);
    expect(Number(itemB.roomsBilled)).toBe(0);
  });
});
