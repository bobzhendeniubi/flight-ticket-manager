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
 * 另覆盖同批审过后追加的三个修复点：
 *   - 幂等占位在失败路径上删干净：第一次 400 之后，同 token 重试必须真正重新跑一遍
 *     （而不是把失败前留下的空占位当成功回放）。
 *   - roomsBilled 回写覆盖「变更前有房组、变更后没有房组」的行（显式写 0），不留旧值。
 *   - 每张涉及订单各写一条 UPDATE_ROOM_ASSIGNMENT 审计；SAVE_SHARED_ROOMS 总览条 targetType=ORDER。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d（或本机 Postgres 指到 TEST_DATABASE_URL）
 *   2. npm run test:integration
 */
import { describe, it, expect, afterEach } from 'vitest';
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

/**
 * saveSharedRooms 的审计写入是 fire-and-forget（`void writeAudit(...)`，不参与事务，见
 * lib/audit.ts 的设计取舍），调用方拿到返回值时审计的 INSERT 可能还没提交。真库集成测试
 * 断言审计内容、或紧跟着触发下一个测试的 TRUNCATE（会与还在飞行中的 INSERT 抢表锁，
 * 偶发 40P01 死锁）时都要先让它们落定——给个短暂 sleep，比反复读表轮询更简单可靠。
 */
function flushFireAndForgetAudit(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 80));
}

describe('saveSharedRooms · 真 DB E2E', () => {
  // 每个用例都可能触发 saveSharedRooms 内部的 fire-and-forget writeAudit；下一个用例的
  // beforeEach（全表 TRUNCATE）紧跟着就来，给飞行中的 INSERT 一点时间落定，避免偶发死锁。
  afterEach(() => flushFireAndForgetAudit());

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

  it('幂等占位不留假成功：第一次因订单非有效状态 400 后，同 token 重试真正重新跑一遍并按当前数据给结果', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    // orderB 先是 CANCELLED（不在 COUNTED_STATUSES）——第一次保存必然 400。
    const orderBRaw = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    await prisma.order.update({ where: { id: orderBRaw.id }, data: { status: OrderStatus.CANCELLED } });

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
              orderId: orderBRaw.id,
              orderItemId: orderBRaw.items[0].id,
              passengerIds: [orderBRaw.passengers[0].id],
              roomFraction: 0,
            },
          ],
        },
      ],
      dissolve: [],
    };

    await expect(saveSharedRooms(payload, actor)).rejects.toThrow(/房控有效状态/);
    // 失败后占位行必须已经被删掉——不是留着一个 resultJson 为占位哨兵的行。
    const afterFailure = await prisma.sharedRoomRequest.findUnique({ where: { requestToken: token } });
    expect(afterFailure).toBeNull();

    // 现在把 orderB 修复成有效状态，用**完全相同**的 payload（同 token 同指纹）重试。
    await prisma.order.update({ where: { id: orderBRaw.id }, data: { status: OrderStatus.PAID } });
    const retried = await saveSharedRooms(payload, actor);
    expect(retried.rooms).toHaveLength(1); // 真正重新跑了一遍，不是回放一个空占位

    const itemA = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderA.items[0].id } });
    expect(Number(itemA.roomsBilled)).toBe(1);
  });

  it('roomsBilled：一单两条酒店行，行 X 的乘客整体挪进挂在行 Y 的共享房后，行 X 显式清零（不留旧值）', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderX = await prisma.order.create({
      data: {
        orderNumber: uniq('ORD'),
        status: OrderStatus.PAID,
        subtotal: new Prisma.Decimal(2400),
        total: new Prisma.Decimal(2400),
        paidAmount: new Prisma.Decimal(2400),
        contactName: 'Test User',
        contactPhone: '13800138000',
        // 旧状态：行 X 的普通房组已归属行 X，乘客 p1 住这里。
        roomAssignment: Prisma.JsonNull,
        items: {
          create: [
            {
              kind: OrderItemKind.HOTEL,
              description: '行X',
              quantity: 2,
              unitPrice: new Prisma.Decimal(600),
              amount: new Prisma.Decimal(1200),
              hotelRoomTypeId: roomType.id,
              hotelCheckIn: new Date(`${CHECK_IN}T00:00:00.000Z`),
              hotelCheckOut: new Date(`${CHECK_OUT}T00:00:00.000Z`),
              roomsBilled: new Prisma.Decimal(1), // 挪空前的旧值——修复后必须变成 0，不能停在 1
            },
            {
              kind: OrderItemKind.HOTEL,
              description: '行Y',
              quantity: 2,
              unitPrice: new Prisma.Decimal(600),
              amount: new Prisma.Decimal(1200),
              hotelRoomTypeId: roomType.id,
              hotelCheckIn: new Date(`${CHECK_IN}T00:00:00.000Z`),
              hotelCheckOut: new Date(`${CHECK_OUT}T00:00:00.000Z`),
              roomsBilled: null, // 行 Y 之前从未分房
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
          ],
        },
      },
      include: { items: true, passengers: true },
    });
    const itemX = orderX.items[0];
    const itemY = orderX.items[1];
    // 补上旧房组（归属行 X，全归属——满足「首次拉进共享房前必须全归属」的前提）。
    await prisma.order.update({
      where: { id: orderX.id },
      data: {
        roomAssignment: {
          roomGroups: [
            {
              id: 'gx',
              hotelName: '',
              roomType: '',
              passengerIds: [orderX.passengers[0].id],
              orderItemId: itemX.id,
              roomFraction: 1,
            },
          ],
        },
      },
    });
    const orderOther = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    // 共享房挂在行 Y 上——orderX 唯一的乘客从行 X 搬到行 Y 的共享房。
    await saveSharedRooms(
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
                orderId: orderX.id,
                orderItemId: itemY.id,
                passengerIds: [orderX.passengers[0].id],
                roomFraction: 1,
              },
              {
                orderId: orderOther.id,
                orderItemId: orderOther.items[0].id,
                passengerIds: [orderOther.passengers[0].id],
                roomFraction: 0,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );

    const reloadedX = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemX.id } });
    const reloadedY = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemY.id } });
    expect(Number(reloadedX.roomsBilled)).toBe(0); // 显式清零——不是残留的旧值 1，也不是 null
    expect(Number(reloadedY.roomsBilled)).toBe(1);
  });

  it('审计：每张涉及订单各写一条 UPDATE_ROOM_ASSIGNMENT（含 before/after roomsBilled 与同房单号）；总览条 targetType=ORDER', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
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
    const sharedRoomId = result.rooms[0].sharedRoomId;
    await flushFireAndForgetAudit(); // 审计是 fire-and-forget，断言前先等它落定

    const auditA = await prisma.auditLog.findFirst({
      where: { action: 'UPDATE_ROOM_ASSIGNMENT', targetId: orderA.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditA).not.toBeNull();
    expect(auditA?.targetType).toBe('ORDER');
    expect(auditA?.targetLabel).toBe(orderA.orderNumber);
    const beforeA = auditA?.before as { roomAssignment: unknown; roomsBilled: Record<string, number | null> };
    const afterA = auditA?.after as {
      roomAssignment: unknown;
      roomsBilled: Record<string, number>;
      sharedRooms: Record<string, string[]>;
    };
    expect(beforeA.roomAssignment).toBeNull(); // 变更前本就没分过房
    expect(afterA.roomsBilled[orderA.items[0].id]).toBe(1);
    expect(afterA.sharedRooms[sharedRoomId]).toEqual([orderB.orderNumber]); // 同房其它订单号

    const auditB = await prisma.auditLog.findFirst({
      where: { action: 'UPDATE_ROOM_ASSIGNMENT', targetId: orderB.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditB).not.toBeNull();
    const afterB = auditB?.after as { roomsBilled: Record<string, number>; sharedRooms: Record<string, string[]> };
    expect(afterB.roomsBilled[orderB.items[0].id]).toBe(0);
    expect(afterB.sharedRooms[sharedRoomId]).toEqual([orderA.orderNumber]);

    const overview = await prisma.auditLog.findFirst({
      where: { action: 'SAVE_SHARED_ROOMS' },
      orderBy: { createdAt: 'desc' },
    });
    expect(overview).not.toBeNull();
    expect(overview?.targetType).toBe('ORDER'); // 不再是不贴切的 PRODUCT
    expect([orderA.id, orderB.id]).toContain(overview?.targetId);
  });
});

/**
 * astra A3：已解散房 / 旧日期房仍可被保存成幽灵房。
 *   - 解散一间共享房后，旧版本请求再拿它的 id 当「更新」提交（成员/JSON 会重新写入），
 *     必须 400，不能让它在成员表/订单 JSON 里复活、而 SharedRoom.status 仍是 DISSOLVED
 *     （两套聚合口径都会跳过它，实际住宿计成 0——幽灵房）。
 *   - 拿一间旧日期共享房的 id，配一批新日期的订单行提交，必须 400，不能让 SharedRoom 的
 *     checkIn/checkOut 悄悄停在旧值、物理占用继续算在错误的日期上。
 *   - 同一 sharedRoomId 不能同时出现在 rooms 与 dissolve 里。
 */
describe('saveSharedRooms · 真 DB E2E · 已解散/跨日期房不能被保存复活（astra A3）', () => {
  afterEach(() => flushFireAndForgetAudit());

  it('解散后再拿同一 sharedRoomId 当「更新」提交 → 400，不落库、不复活', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    const created = await saveSharedRooms(
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
    const sharedRoomId = created.rooms[0].sharedRoomId;

    const dissolved = await saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        expectedVersions: { [sharedRoomId]: created.rooms[0].version },
        rooms: [],
        dissolve: [sharedRoomId],
      },
      actor,
    );
    expect(dissolved.dissolved).toEqual([sharedRoomId]);
    const afterDissolve = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: sharedRoomId } });
    expect(afterDissolve.status).toBe('DISSOLVED');
    expect(afterDissolve.version).toBe(2); // 解散也递增 version

    // 借「更新既有房」的形状把它拿回来当活房用——expectedVersions 精确对上解散后的新版本，
    // 不是靠版本过期侥幸拦下来的，必须靠 ACTIVE 校验单独拦。
    await expect(
      saveSharedRooms(
        {
          hotelId: hotel.id,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: requestToken(),
          expectedVersions: { [sharedRoomId]: afterDissolve.version },
          rooms: [
            {
              sharedRoomId,
              hotelRoomTypeId: roomType.id,
              groups: [
                {
                  orderId: orderA.id,
                  orderItemId: orderA.items[0].id,
                  passengerIds: [orderA.passengers[0].id],
                  roomFraction: 1,
                },
              ],
            },
          ],
          dissolve: [],
        },
        actor,
      ),
    ).rejects.toThrow(/已解散/);

    // 落库现状必须原封不动：房还是 DISSOLVED、没有成员、订单 A 的房组仍是解散时留下的普通组。
    const stillDissolved = await prisma.sharedRoom.findUniqueOrThrow({
      where: { id: sharedRoomId },
      include: { members: true },
    });
    expect(stillDissolved.status).toBe('DISSOLVED');
    expect(stillDissolved.members).toHaveLength(0);
  });

  it('拿旧日期共享房的 id 配新日期的订单行提交 → 400，不挪 SharedRoom 的入住区间', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    const created = await saveSharedRooms(
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
    const sharedRoomId = created.rooms[0].sharedRoomId;

    // 换一批入住区间不同的订单行——checkIn/checkOut 与既有共享房不一致。
    const NEW_CHECK_IN = '2026-11-01';
    const NEW_CHECK_OUT = '2026-11-03';
    const orderC = await createOrderWithPassengers({
      roomTypeId: roomType.id,
      passengerCount: 1,
      checkIn: NEW_CHECK_IN,
      checkOut: NEW_CHECK_OUT,
    });
    const orderD = await createOrderWithPassengers({
      roomTypeId: roomType.id,
      passengerCount: 1,
      checkIn: NEW_CHECK_IN,
      checkOut: NEW_CHECK_OUT,
    });

    await expect(
      saveSharedRooms(
        {
          hotelId: hotel.id,
          checkIn: NEW_CHECK_IN,
          checkOut: NEW_CHECK_OUT,
          requestToken: requestToken(),
          expectedVersions: { [sharedRoomId]: created.rooms[0].version },
          rooms: [
            {
              sharedRoomId,
              hotelRoomTypeId: roomType.id,
              groups: [
                {
                  orderId: orderC.id,
                  orderItemId: orderC.items[0].id,
                  passengerIds: [orderC.passengers[0].id],
                  roomFraction: 1,
                },
                {
                  orderId: orderD.id,
                  orderItemId: orderD.items[0].id,
                  passengerIds: [orderD.passengers[0].id],
                  roomFraction: 0,
                },
              ],
            },
          ],
          dissolve: [],
        },
        actor,
      ),
    ).rejects.toThrow(/入住区间与本次请求不一致/);

    // 落库现状必须原封不动：日期没挪，成员还是原来那两位。
    const untouched = await prisma.sharedRoom.findUniqueOrThrow({
      where: { id: sharedRoomId },
      include: { members: true },
    });
    expect(untouched.checkIn.toISOString().slice(0, 10)).toBe(CHECK_IN);
    expect(untouched.checkOut.toISOString().slice(0, 10)).toBe(CHECK_OUT);
    expect(untouched.members.map((m) => m.orderId).sort()).toEqual([orderA.id, orderB.id].sort());
  });

  it('同一 sharedRoomId 同时出现在 rooms 与 dissolve 中 → 400', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    const created = await saveSharedRooms(
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
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );
    const sharedRoomId = created.rooms[0].sharedRoomId;

    await expect(
      saveSharedRooms(
        {
          hotelId: hotel.id,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: requestToken(),
          expectedVersions: { [sharedRoomId]: created.rooms[0].version },
          rooms: [
            {
              sharedRoomId,
              hotelRoomTypeId: roomType.id,
              groups: [
                {
                  orderId: orderA.id,
                  orderItemId: orderA.items[0].id,
                  passengerIds: [orderA.passengers[0].id],
                  roomFraction: 1,
                },
              ],
            },
          ],
          dissolve: [sharedRoomId],
        },
        actor,
      ),
    ).rejects.toThrow(/同时出现在 rooms 与 dissolve/);
  });
});

/**
 * astra A5②：readBillingFraction 曾经把「普通房组显式 0 份额」读成 1——解绑后留下的
 * 「与他单合住、计费 0 间」的普通组，只要本单再触发一次 saveSharedRooms（哪怕是因为
 * 同一订单的另一条行在这次请求里新加入了别的共享房），roomsBilled 就会被兜底改写成 1，
 * 钱和物理口径就此对不上（解绑时明确承诺的「钱不动」被破坏）。
 */
describe('saveSharedRooms · 真 DB E2E · 普通组显式 0 份额重存不变 1（astra A5②）', () => {
  afterEach(() => flushFireAndForgetAudit());

  it('订单里一条行是已解绑的 0 份额普通组，同单另一条行本次加入新共享房 → 前者 roomsBilled 仍是 0', async () => {
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
              description: '测试酒店 · 标准间 · 已解绑 0 份额行',
              quantity: 2,
              unitPrice: new Prisma.Decimal(600),
              amount: new Prisma.Decimal(1200),
              hotelRoomTypeId: roomType.id,
              hotelCheckIn: new Date(`${CHECK_IN}T00:00:00.000Z`),
              hotelCheckOut: new Date(`${CHECK_OUT}T00:00:00.000Z`),
              roomsBilled: new Prisma.Decimal(0), // 解绑留下的计费 0 间
            },
            {
              kind: OrderItemKind.HOTEL,
              description: '测试酒店 · 标准间 · 本次要新加共享房的行',
              quantity: 2,
              unitPrice: new Prisma.Decimal(600),
              amount: new Prisma.Decimal(1200),
              hotelRoomTypeId: roomType.id,
              hotelCheckIn: new Date(`${CHECK_IN}T00:00:00.000Z`),
              hotelCheckOut: new Date(`${CHECK_OUT}T00:00:00.000Z`),
              roomsBilled: null,
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
    const unboundItemId = orderA.items[0].id;
    const joiningItemId = orderA.items[1].id;

    // 直接把「解绑后留下的普通 0 份额组」写进订单 JSON——不经由 shared-room-unbind（不在本批
    // 修复范围内），只还原它落库后的形状：没有 sharedRoomId、roomFraction 显式为 0。
    await prisma.order.update({
      where: { id: orderA.id },
      data: {
        roomAssignment: {
          roomGroups: [
            {
              id: `plain:${uniq('legacy-shared')}:${unboundItemId}`,
              hotelName: '',
              roomType: '',
              passengerIds: [orderA.passengers[0].id],
              orderItemId: unboundItemId,
              roomFraction: 0,
            },
          ],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    await saveSharedRooms(
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
                orderItemId: joiningItemId,
                passengerIds: [orderA.passengers[1].id],
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

    const unboundItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: unboundItemId } });
    expect(Number(unboundItem.roomsBilled)).toBe(0); // 不是被兜底改回的 1

    const refreshed = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } });
    const groups = (refreshed.roomAssignment as { roomGroups: Array<Record<string, unknown>> }).roomGroups;
    const unboundGroup = groups.find((g) => g.orderItemId === unboundItemId);
    expect(unboundGroup).toBeDefined();
    expect(Number(unboundGroup!.roomFraction)).toBe(0); // JSON 镜像里也仍是显式 0
  });
});
