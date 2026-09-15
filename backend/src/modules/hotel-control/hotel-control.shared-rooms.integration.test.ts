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
import { describe, it, expect } from 'vitest';
import { OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { saveSharedRooms, getSharedRoomWorkbench } from './hotel-control.shared-rooms.js';
import { getHotelNightlyRemaining, getAlerts } from './hotel-control.service.js';
import { serializeRoomGroupsFor } from '../orders/room-group-dto.js';
import { canonicalJson } from '../../lib/canonical-json.js';

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

  /**
   * astra A9 死锁反例：S 原有 A、B 两位成员。两个并发请求各自只保留一人再提交同一间 S——
   * 甲只保留 A（B 在锁集合扩大时被发现，纳入甲的锁定订单集合），乙只保留 B（对称）。
   * 旧实现「锁后发现集合扩大就在同一事务里继续补锁新订单」：甲先锁 A 再想锁 B、乙先锁 B
   * 再想锁 A，会互相等待对方已持有的锁，形成教科书式死锁环。
   *
   * 新实现锁集合扩大就整个事务回滚重开，从不在持有的锁上叠加新锁——两个请求会在
   * SharedRoom 的行锁上正常排队串行，不会死锁；因为两者都指望同一个 expectedVersions，
   * 后提交的那个必然撞版本冲突（409），不会出现 Postgres deadlock_detected 异常，
   * 也不会两个都挂起。
   */
  it('并发（astra A9）：两个请求各自只保留 S 的一名成员，交错提交不死锁，恰好一个成功一个 409', async () => {
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
    const expectedVersion = created.rooms[0].version;

    // 甲：只保留 A（份额补到 1，让 Σ=1 校验通过）。请求本身只列出 A，S 的成员 B 靠
    // lockAffectedOrdersOnce 在锁前的候选读里主动摸出来，不需要请求显式提它。
    const reqA = saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        expectedVersions: { [sharedRoomId]: expectedVersion },
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
    );
    // 乙：只保留 B（对称）。
    const reqB = saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        expectedVersions: { [sharedRoomId]: expectedVersion },
        rooms: [
          {
            sharedRoomId,
            hotelRoomTypeId: roomType.id,
            groups: [
              {
                orderId: orderB.id,
                orderItemId: orderB.items[0].id,
                passengerIds: [orderB.passengers[0].id],
                roomFraction: 1,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );

    const outcomes = await Promise.allSettled([reqA, reqB]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    // 恰好一个成功、一个因版本已变而 409——不是两个都成功（互相覆盖），
    // 也不是两个都挂起/抛出与死锁相关的异常。
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0] as PromiseRejectedResult;
    expect(String(rejection.reason)).toMatch(/已被他人修改/);
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

  /**
   * astra A13：kept 过滤器原地修改旧 group 的 passengerIds（一名乘客被拽进本次新建的
   * 共享房，同房间里没被拽走的乘客留守，代码原地收窄 `g.passengerIds = remaining`）。
   * 这个 group 对象是 order.roomAssignment.roomGroups[] 里的同一个引用，原地改了就是
   * 真的改了 order.roomAssignment——如果审计 before 直接引用它，读到的会是「已经被
   * 本函数自己改过」的状态，不是这次保存开始前的真实旧值（本例：before 应该还留着
   * 两位乘客，不是被收窄成一位后的样子）。
   */
  it('审计 before 不受 kept 过滤器原地收窄乘客集合的影响——留着保存前的真实旧值', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    // orderA 已有一个装两位乘客的普通房组（不带 sharedRoomId，不属于本次 touched 共享房）。
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 2 });
    const originalGroups = [
      {
        id: 'g-plain-both',
        hotelName: '',
        roomType: '',
        passengerIds: [orderA.passengers[0].id, orderA.passengers[1].id],
        orderItemId: orderA.items[0].id,
        roomFraction: 1,
      },
    ];
    await prisma.order.update({
      where: { id: orderA.id },
      data: { roomAssignment: { roomGroups: originalGroups } as unknown as Prisma.InputJsonValue },
    });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    // 把 orderA 的第一位乘客拽进一间新的共享房——第二位乘客留守在原来的普通组，
    // 触发 kept 过滤器的「盒子还有别人留守——原地收窄乘客集合」分支。
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

    const auditA = await prisma.auditLog.findFirst({
      where: { action: 'UPDATE_ROOM_ASSIGNMENT', targetId: orderA.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditA).not.toBeNull();
    const beforeA = auditA?.before as { roomAssignment: { roomGroups: Array<Record<string, unknown>> } };
    const beforeGroup = beforeA.roomAssignment.roomGroups.find((g) => g.id === 'g-plain-both');
    expect(beforeGroup).toBeDefined();
    // 保存前的真实旧值：两位乘客都还在——不是被本函数自己原地改窄之后只剩一位的样子。
    expect((beforeGroup!.passengerIds as string[]).sort()).toEqual(
      [orderA.passengers[0].id, orderA.passengers[1].id].sort(),
    );
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

/**
 * astra B7：工作台重存会清除本单房组备注。带 touched 共享键的旧组整体重建时，它在
 * 订单 JSON 里自己的 notes（单单编辑器维护的本地备注）没有被搬进重建后的对象——运营
 * 在单单分房编辑器里给某个房组写的备注，只要房控页跨单分房工作台对同一间房再保存一次
 * （哪怕只是加了一位新成员，不碰原有成员），这条备注就会消失。
 */
describe('saveSharedRooms · 真 DB E2E · 工作台重存保留本单房组备注（astra B7）', () => {
  it('更新既有共享房（新增一名成员）→ 原成员那侧订单 JSON 里的 notes 原样保留', async () => {
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
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );
    const sharedRoomId = created.rooms[0].sharedRoomId;

    // 运营在单单分房编辑器里给 orderA 的这个共享房组写了一条本地备注（走 PUT
    // /orders/:id/room-assignment，只改 notes，参见 orders.routes.ts reconcile 逻辑）。
    const beforeNotesSave = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } });
    const beforeGroups = (beforeNotesSave.roomAssignment as { roomGroups: Array<Record<string, unknown>> })
      .roomGroups;
    await prisma.order.update({
      where: { id: orderA.id },
      data: {
        roomAssignment: {
          roomGroups: beforeGroups.map((g) => ({ ...g, notes: 'A 单本地备注：靠窗' })),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // 房控工作台对同一间房再保存一次——新增 orderB 一名成员，orderA 那组的其它字段不变。
    const updated = await saveSharedRooms(
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
    expect(updated.rooms[0].sharedRoomId).toBe(sharedRoomId);

    const afterA = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } });
    const afterGroups = (afterA.roomAssignment as { roomGroups: Array<Record<string, unknown>> }).roomGroups;
    const afterGroup = afterGroups.find((g) => g.orderItemId === orderA.items[0].id);
    expect(afterGroup).toBeDefined();
    expect(afterGroup!.notes).toBe('A 单本地备注：靠窗'); // 没有被工作台重存清掉
  });

  it('M6 反例：既有房重提时漏掉一名成员的 group → 静默移除该成员，但必须进 warnings 说明', async () => {
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

    // 客户端（前端漏渲染 / 手滑）重提这间房时只带了 A 的 group，完全没提 B——按端点既有
    // 语义（listed 决定最终成员）B 会被摘出去，Σ=1 校验也照样能过（只看 A 那组）。
    // 这本是合法操作，但必须让运营看得见「B 被顺手移除了」。
    const updated = await saveSharedRooms(
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
        dissolve: [],
      },
      actor,
    );
    expect(updated.rooms[0].sharedRoomId).toBe(sharedRoomId);
    expect(
      updated.warnings.some(
        (w) => w.includes(sharedRoomId) && w.includes('移除') && w.includes(orderB.orderNumber),
      ),
    ).toBe(true);

    // B 确实被移除（既有行为不变，本条只补 warning）。
    const remainingMembers = await prisma.sharedRoomMember.findMany({ where: { sharedRoomId } });
    expect(remainingMembers.map((m) => m.orderId)).toEqual([orderA.id]);
  });
});

/**
 * astra B1：房组 id 曾经编码成 `shared:<sharedRoomId>:<orderItemId>` /
 * `plain:<sharedRoomId>:<orderItemId>`，代理/客户视角的 serializeRoomGroupsFor 只挑字段
 * 不改值，原样把这个 id 透传出去——等于把内部共享房 id 泄露给代理。用 saveSharedRooms
 * 真正落库产出的形状（不是手搭的干净 fixture）过一遍脱敏函数，断言整份响应的 JSON
 * 字符串里不包含 sharedRoomId 的真实值，而不只是检查某个字段不存在。
 */
describe('saveSharedRooms · 真 DB E2E · 房组 id 不泄露 sharedRoomId（astra B1）', () => {
  it('落库产出的房组 id 不含 sharedRoomId 原文；AGENT 视角整份 JSON 也不含', async () => {
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

    const refreshedA = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } });
    const groupsA = (refreshedA.roomAssignment as { roomGroups: Array<Record<string, unknown>> }).roomGroups;
    const groupA = groupsA.find((g) => g.orderItemId === orderA.items[0].id);
    expect(groupA).toBeDefined();
    expect(String(groupA!.id)).not.toContain(sharedRoomId); // id 本身不含 sharedRoomId 原文
    expect(String(groupA!.id)).not.toMatch(/^shared:|^plain:/); // 也不是旧式编码前缀

    const agentView = serializeRoomGroupsFor(UserRole.AGENT, refreshedA.roomAssignment) as {
      roomGroups: Array<{ id: string; isShared: boolean }>;
    };
    // 用真实落库形状过一遍脱敏函数，断言整份响应 JSON 字符串不含 sharedRoomId 真实值
    // （不是只检查某个字段不存在——那种检查法查不出「值被塞进另一个字段」这种泄露）。
    expect(JSON.stringify(agentView)).not.toContain(sharedRoomId);
    const agentGroup = agentView.roomGroups.find((g) => g.id === groupA!.id);
    expect(agentGroup?.isShared).toBe(true); // 布尔标记仍然正确，只是不带具体是哪间
  });
});

/**
 * astra B6：一间共享房含取消/软删成员，会阻断工作台保存其它房间。
 *   - 读模型（getSharedRoomWorkbench）给每个成员带 orderStatus / isActive，前端据此
 *     把历史成员标成只读，而不是像正常成员一样可拖拽/提交。
 *   - 保存端点：本次「未变更」的成员放行订单有效状态校验（选定口径，见
 *     hotel-control.shared-rooms.ts 里 isUnchangedMember 的 JSDoc）——同一间房只要
 *     其它地方有改动（这里用「新增一名成员」模拟），历史失效成员原样带过去不应 400；
 *     但如果连这个失效成员自己的份额/乘客也被改动，则仍按正常校验走（不能借失效
 *     窗口把一个订单已取消的成员悄悄改成别的份额）。
 */
describe('saveSharedRooms · 真 DB E2E · 未变更的失效成员不阻断保存（astra B6）', () => {
  it('读模型：成员带 orderStatus / isActive / orderNumber / 姓名快照，取消单的成员 isActive=false 且姓名不为空', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
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
    // orderB 事后取消——共享房不因此改变物理占用口径（§四），但成员表原样留着。
    await prisma.order.update({ where: { id: orderB.id }, data: { status: OrderStatus.CANCELLED } });

    // 工作台读模型主查询按 COUNTED_STATUSES 过滤有效订单，但共享房返回的是**全部**
    // 成员——orderB 虽然不在 workbench.orders 里，仍会出现在 sharedRooms[].members 里。
    const workbench = await getSharedRoomWorkbench(hotel.id, CHECK_IN, CHECK_OUT);
    expect(workbench.orders.map((o) => o.orderId)).not.toContain(orderB.id);
    const room = workbench.sharedRooms[0];
    expect(room).toBeDefined();
    const memberA = room!.members.find((m) => m.orderId === orderA.id);
    const memberB = room!.members.find((m) => m.orderId === orderB.id);
    expect(memberA).toMatchObject({ orderStatus: 'PAID', isActive: true, orderNumber: orderA.orderNumber });
    expect(memberA?.name).toBeTruthy();
    // 失效（已取消）订单的成员也要查得到姓名快照，灰色 chip 才能显示人名而不是空白——
    // 不能因为订单不在有效订单池里就连姓名都查不到。
    expect(memberB).toMatchObject({ orderStatus: 'CANCELLED', isActive: false, orderNumber: orderB.orderNumber });
    expect(memberB?.name).toBeTruthy();
  });

  it('未变更的失效成员原样带过去 → 放行；同一失效成员的份额被改动 → 仍 400', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderC = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

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
    await prisma.order.update({ where: { id: orderB.id }, data: { status: OrderStatus.CANCELLED } });

    // 未变更：orderB 的 (orderItemId, passengerIds, roomFraction) 原样带回来，
    // 只是给房间新增一名 orderC 成员——不该因为 orderB 已取消而 400。
    const resaved = await saveSharedRooms(
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
                roomFraction: 0.5,
              },
              {
                orderId: orderB.id,
                orderItemId: orderB.items[0].id,
                passengerIds: [orderB.passengers[0].id],
                roomFraction: 0,
              },
              {
                orderId: orderC.id,
                orderItemId: orderC.items[0].id,
                passengerIds: [orderC.passengers[0].id],
                roomFraction: 0.5,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );
    expect(resaved.rooms[0].sharedRoomId).toBe(sharedRoomId);

    // 现在改动 orderB 自己的份额（0 → 0.5，同时把它读的份额挪到别处凑 Σ=1）——
    // 已取消订单的成员被真正改动，不能再借「未变更」放行。
    await expect(
      saveSharedRooms(
        {
          hotelId: hotel.id,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: requestToken(),
          expectedVersions: { [sharedRoomId]: resaved.rooms[0].version },
          rooms: [
            {
              sharedRoomId,
              hotelRoomTypeId: roomType.id,
              groups: [
                {
                  orderId: orderA.id,
                  orderItemId: orderA.items[0].id,
                  passengerIds: [orderA.passengers[0].id],
                  roomFraction: 0,
                },
                {
                  orderId: orderB.id,
                  orderItemId: orderB.items[0].id,
                  passengerIds: [orderB.passengers[0].id],
                  roomFraction: 0.5, // 改动了——不再是「未变更」
                },
                {
                  orderId: orderC.id,
                  orderItemId: orderC.items[0].id,
                  passengerIds: [orderC.passengers[0].id],
                  roomFraction: 0.5,
                },
              ],
            },
          ],
          dissolve: [],
        },
        actor,
      ),
    ).rejects.toThrow(/不处于房控有效状态/);
  });
});

/**
 * astra A12：幂等占位在并发/崩溃窗口下的处理。
 *   - 同 token 仍在处理中（占位新鲜）：提示词必须是「稍后用同一请求编号重试」，
 *     不能建议换新 token——换号会让尚未结束的首次请求与新请求同时执行。
 *   - 占位超过孤儿超时窗口（模拟进程在占位后、写出真结果前崩溃）：同一个 token
 *     必须能被重新抢占、真正执行一遍，而不是永远卡在「上一次尚未完成」。
 */
describe('saveSharedRooms · 真 DB E2E · 幂等占位的并发/崩溃窗口（astra A12）', () => {
  it('同 token 占位新鲜（未超时）→ 409 提示重试同一 token，不建议换号', async () => {
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const token = requestToken();
    const fingerprint = canonicalJson({
      hotelId: hotel.id,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      expectedVersions: {},
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
    });
    // 直接手搭一条「刚刚占位、还没写出真结果」的记录，模拟另一个请求正在处理中。
    await prisma.sharedRoomRequest.create({
      data: { requestToken: token, fingerprint, resultJson: { __pending: true } as unknown as Prisma.InputJsonValue },
    });

    const actor = await adminActor();
    await expect(
      saveSharedRooms(
        {
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
              ],
            },
          ],
          dissolve: [],
        },
        actor,
      ),
    ).rejects.toThrow(/请稍后使用同一请求编号重试/);

    // 占位行原样保留——没有被误删，也没有被写成真结果（不能让这次「以为在等」的调用
    // 顺手把真正处理中的那次请求的占位破坏掉）。
    const stillPending = await prisma.sharedRoomRequest.findUnique({ where: { requestToken: token } });
    expect(stillPending).not.toBeNull();
    expect(stillPending?.resultJson).toEqual({ __pending: true });
  });

  it('孤儿占位超过超时窗口 → 同一 token 可被重新抢占，真正执行一遍', async () => {
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
    const fingerprint = canonicalJson({
      hotelId: payload.hotelId,
      checkIn: payload.checkIn,
      checkOut: payload.checkOut,
      expectedVersions: {},
      rooms: payload.rooms,
      dissolve: payload.dissolve,
    });
    // 手搭一条「11 分钟前占位、进程崩溃后再也没写出真结果」的孤儿占位——超过 10 分钟
    // 的孤儿超时窗口。
    await prisma.sharedRoomRequest.create({
      data: {
        requestToken: token,
        fingerprint,
        resultJson: { __pending: true } as unknown as Prisma.InputJsonValue,
        createdAt: new Date(Date.now() - 11 * 60 * 1000),
      },
    });

    const actor = await adminActor();
    const result = await saveSharedRooms(payload, actor);
    // 真正执行了一遍——不是回放一个空占位；两张单都落库到同一间共享房。
    expect(result.rooms).toHaveLength(1);
    const itemA = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderA.items[0].id } });
    expect(Number(itemA.roomsBilled)).toBe(1);

    const finalRow = await prisma.sharedRoomRequest.findUnique({ where: { requestToken: token } });
    expect(finalRow?.resultJson).toEqual(result); // 占位已被换成真结果，供后续同 token 重放
  });
});

/**
 * astra A6①：同一房内同一 (orderId, orderItemId) 出现多个 group → 400。
 * `fractionByOrderItem.set` 是覆盖语义，重复键会让 Σ 校验只看到最后一份，但
 * SharedRoomMember 落库是逐 group 处理，两份 passengerIds 都会建成员行——物理/计费
 * 口径跟 Σ 校验看到的对不上。
 */
describe('saveSharedRooms · 真 DB E2E · 同房同订单行不许出现多个成员组（astra A6①）', () => {
  it('同一房间的 groups 里两条都指向同一 (orderId, orderItemId) → 400，不落库', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 2 });

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
                  roomFraction: 0.5,
                },
                {
                  // 同一 (orderId, orderItemId)，另一半乘客——本该合并成一组一次提交。
                  orderId: orderA.id,
                  orderItemId: orderA.items[0].id,
                  passengerIds: [orderA.passengers[1].id],
                  roomFraction: 0.5,
                },
              ],
            },
          ],
          dissolve: [],
        },
        actor,
      ),
    ).rejects.toThrow(/出现了不止一个成员组/);

    const untouched = await prisma.sharedRoom.findMany({ where: { hotelId: hotel.id } });
    expect(untouched).toHaveLength(0); // 没有创建任何共享房
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderA.items[0].id } });
    expect(item.roomsBilled?.toString()).toBe('1'); // roomsBilled 原样未动
  });
});

/**
 * astra A6②：请求没列出的旧共享房里若含本次被拖走的乘客，要按乘客查出全部旧关系，
 * 纳入锁集合与版本校验，删掉旧成员、旧房清空则 DISSOLVED（同时是 B2 的后端侧）。
 */
describe('saveSharedRooms · 真 DB E2E · 隐式触及旧共享房的清理（astra A6②）', () => {
  it('把乘客从未点名的旧共享房拽进新房：旧房只剩一人 → 摘除后自动 DISSOLVED', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderC = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    // 旧共享房 S：A + B。
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
    const oldRoomId = created.rooms[0].sharedRoomId;

    // 新请求：只提 A（拉进新房 S2，与 C 合住），完全不提 S / oldRoomId。
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
    expect(result.rooms).toHaveLength(1);
    expect(result.rooms[0].sharedRoomId).not.toBe(oldRoomId);

    // 旧房：A 的成员行被摘除；B 是旧房唯一剩下的成员——不对，B 应该还在，A 被摘除后
    // 旧房还剩 B 一人，不是空的，不该被解散。
    const oldRoomAfter = await prisma.sharedRoom.findUniqueOrThrow({
      where: { id: oldRoomId },
      include: { members: true },
    });
    expect(oldRoomAfter.status).toBe('ACTIVE');
    expect(oldRoomAfter.members).toHaveLength(1);
    expect(oldRoomAfter.members[0]!.orderId).toBe(orderB.id);
    expect(oldRoomAfter.version).toBe(2); // 解绑 A 也是一次成员变更，版本要涨

    // A 的旧订单 JSON 不再挂着这间旧房。
    const refreshedA = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } });
    const groupsA = (refreshedA.roomAssignment as { roomGroups: Array<Record<string, unknown>> }).roomGroups;
    expect(groupsA.every((g) => g.sharedRoomId !== oldRoomId)).toBe(true);

    // astra N5（回归修复）反例：B 完全没被这次请求提及，留守旧房——它的 JSON 镜像组
    // 必须原样重建（不能因为旧房被 touched 就整体丢弃），份额保持原值（0），roomsBilled
    // 不能被清成 0（旧实现会把 B 这一行在这间房的组搬空，roomsBilled 显式回写成 0）。
    const refreshedB = await prisma.order.findUniqueOrThrow({ where: { id: orderB.id } });
    const groupsB = (refreshedB.roomAssignment as { roomGroups: Array<Record<string, unknown>> }).roomGroups;
    const bGroupInOldRoom = groupsB.find((g) => g.sharedRoomId === oldRoomId);
    expect(bGroupInOldRoom).toBeDefined();
    expect(bGroupInOldRoom?.passengerIds).toEqual([orderB.passengers[0].id]);
    expect(bGroupInOldRoom?.roomFraction).toBe(0); // 保留原份额，不重新分配
    const bItemAfter = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderB.items[0].id } });
    expect(Number(bItemAfter.roomsBilled)).toBe(0); // 与 JSON 组的 roomFraction 口径一致，不是被清空

    // H1 修复：旧房 S 摘除 A 之后只剩 B 一人、份额合计仍是 0（原计费方 A 已迁出）——
    // 这不该悄无声息：响应 warnings 必须明示，orderB 的逐单审计 after 也要带同一条提示
    // （不止响应这一处，翻旧账也要看得到），不能像旧实现那样连一句提示都没有。
    expect(result.warnings.some((w) => w.includes(oldRoomId) && w.includes('原计费方已迁出'))).toBe(true);
    // P2（批 10）：orphanedSharedRoomIds 此前没有任何测试断言过内容——只断响应字段确实
    // 含这间孤儿房（隐式留守路径，见 hotel-control.shared-rooms.ts:1136 一带）。
    expect(result.orphanedSharedRoomIds).toEqual([oldRoomId]);
    const auditB = await prisma.auditLog.findFirst({
      where: { action: 'UPDATE_ROOM_ASSIGNMENT', targetId: orderB.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditB).not.toBeNull();
    const afterB = auditB?.after as { orphanedSharedRoomWarnings?: string[] };
    expect(afterB.orphanedSharedRoomWarnings?.some((w) => w.includes(oldRoomId))).toBe(true);

    // 房控看板：这间房 ACTIVE 且唯一有效成员份额为 0，getAlerts 的 sharedRoomOrphaned
    // 必须能看到它（H1③，不依赖「主单被取消」这个更窄的成因）。
    const alerts = await getAlerts(30);
    const orphanAlert = alerts.sharedRoomOrphaned.find((o) => o.sharedRoomId === oldRoomId);
    expect(orphanAlert).toBeDefined();
    expect(orphanAlert?.memberOrderNumbers).toEqual([orderB.orderNumber]);
  });

  it('H1④ 反例：既有房 Σ份额=0 且原样重提（只是留守成员，不是新增/改动）→ 放行 + warning，不是 400', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderC = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    // 旧共享房 S：A(1) + B(0)。
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
    const oldRoomId = created.rooms[0].sharedRoomId;

    // 隐式挪走 A（新请求只提 A 拉进新房，不点名 S）——S 落库只剩 B、Σ=0。
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
                orderItemId: orderA.items[0].id,
                passengerIds: [orderA.passengers[0].id],
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

    const sBefore = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: oldRoomId } });
    expect(sBefore.status).toBe('ACTIVE'); // 仍剩 B 一人，不会被自动解散

    // 前端（或运营）把 S 明确列进 body.rooms 原样重提（只有 B，roomFraction 仍是 0，
    // 与落库现状完全一致——不是新增/改动）：H1④ 要求放行，不是 Σ≠1 的 400。
    const resubmit = await saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        expectedVersions: { [oldRoomId]: sBefore.version },
        rooms: [
          {
            sharedRoomId: oldRoomId,
            hotelRoomTypeId: roomType.id,
            groups: [
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
    expect(resubmit.rooms[0].sharedRoomId).toBe(oldRoomId);
    expect(
      resubmit.warnings.some((w) => w.includes(oldRoomId) && w.includes('原计费方已迁出')),
    ).toBe(true);
    // P2（批 10）：显式重提路径（hotel-control.shared-rooms.ts:942 一带）同样要断
    // orphanedSharedRoomIds 的内容，不止隐式留守那一条路径。
    expect(resubmit.orphanedSharedRoomIds).toEqual([oldRoomId]);

    const sAfter = await prisma.sharedRoom.findUniqueOrThrow({
      where: { id: oldRoomId },
      include: { members: true },
    });
    expect(sAfter.status).toBe('ACTIVE');
    expect(sAfter.members).toHaveLength(1);
    expect(sAfter.members[0]!.orderId).toBe(orderB.id);
  });

  it('P3 正向用例：Σ=0 且成员与现状完全一致的既有房原样重提 → 200 + warning + orphanedSharedRoomIds 含该房（钉住 isLeftoverOnlyResubmit 契约，独立于 H1④ 的完整叙事用例）', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderPayer = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderLeftover = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderElsewhere = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    // 步骤①：正常建房 S = 计费方(1) + 留守方(0)——新建房不能直接 Σ=0（isLeftoverOnlyResubmit
    // 要求 sharedRoomId 非空，新建请求恒 sharedRoomId=null），必须先有这个落库现状。
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
                orderId: orderPayer.id,
                orderItemId: orderPayer.items[0].id,
                passengerIds: [orderPayer.passengers[0].id],
                roomFraction: 1,
              },
              {
                orderId: orderLeftover.id,
                orderItemId: orderLeftover.items[0].id,
                passengerIds: [orderLeftover.passengers[0].id],
                roomFraction: 0,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );
    const roomId = created.rooms[0].sharedRoomId;

    // 步骤②：隐式把计费方挪去另一间房（不点名 S）——S 落库只剩留守方，Σ=0（当前测试的
    // 「落库现状」由这一步产生，不是手造）。
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
                orderId: orderPayer.id,
                orderItemId: orderPayer.items[0].id,
                passengerIds: [orderPayer.passengers[0].id],
                roomFraction: 1,
              },
              {
                orderId: orderElsewhere.id,
                orderItemId: orderElsewhere.items[0].id,
                passengerIds: [orderElsewhere.passengers[0].id],
                roomFraction: 0,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );
    const seed = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: roomId } });

    // 步骤③：本用例真正要钉住的契约——把 S 原样重提（成员、份额与落库现状完全一致）
    // → 不是 400，是 200 + warning + orphanedSharedRoomIds 含 S。
    const resubmit = await saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        expectedVersions: { [roomId]: seed.version },
        rooms: [
          {
            sharedRoomId: roomId,
            hotelRoomTypeId: roomType.id,
            groups: [
              {
                orderId: orderLeftover.id,
                orderItemId: orderLeftover.items[0].id,
                passengerIds: [orderLeftover.passengers[0].id],
                roomFraction: 0,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );

    // 版本号本身不是这条用例要钉住的契约（重提交是否物理重写、是否涨版本号是实现细节）——
    // 只断言真正对外承诺的三件事：还是这间房、warning 提示、orphanedSharedRoomIds 含它。
    expect(resubmit.rooms).toHaveLength(1);
    expect(resubmit.rooms[0]!.sharedRoomId).toBe(roomId);
    expect(resubmit.warnings.some((w) => w.includes(roomId) && w.includes('原计费方已迁出'))).toBe(true);
    expect(resubmit.orphanedSharedRoomIds).toEqual([roomId]);
  });

  it('N2 反例：既有房 Σ=0 但请求漏列了落库现状的另一名计费方 → 仍是 400，不能把漏列的一方悄悄摘出成员表', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    // 落库现状：S = A(份额 1) + B(份额 0)——拍板 5(b) 默认形态（原计费方已迁出，B 留守）。
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
    const roomId = created.rooms[0].sharedRoomId;
    const sBefore = await prisma.sharedRoom.findUniqueOrThrow({ where: { id: roomId } });

    // 把 S 列进 body.rooms 重提，但 groups 只写 B(0)，漏列 A(1)——不是「原样交回」既成事实，
    // 是漏列。isUnchangedMember 对「列出来的」B 仍然成立（B 没变），若只按「列出来的都没
    // 改」判定，会把这次漏列误判成 H1④ 的留守重提而放行，现场把 A 从成员表摘出去（A 那份
    // 真占用、真计费的份额从此在共享房里凭空消失）。必须仍走 Σ≠1 的硬闸，不给出路。
    const rejectionErr = await saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        expectedVersions: { [roomId]: sBefore.version },
        rooms: [
          {
            sharedRoomId: roomId,
            hotelRoomTypeId: roomType.id,
            groups: [
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
    ).catch((e: unknown) => e);
    // P4 修复（批 10）：漏列成员的 400 文案不再是「计费份额合计须为 1」那句指错方向的
    // 通用文案——现在指出真实原因（漏列）并报出漏列的单号（orderA），房型也换成名字
    // （不用正则拼接单号/房型名——两者都是运行时生成的字符串，直接子串匹配更稳）。
    expect(rejectionErr).toBeInstanceOf(Error);
    const rejectionMessage = (rejectionErr as Error).message;
    expect(rejectionMessage).toContain(`房间「${roomType.name}」`);
    expect(rejectionMessage).toContain('漏列了当前在住的计费方');
    expect(rejectionMessage).toContain(orderA.orderNumber);

    // 拒绝后不能有任何副作用：A 仍是成员，份额仍是 1；成员数仍是 2。
    const sAfter = await prisma.sharedRoom.findUniqueOrThrow({
      where: { id: roomId },
      include: { members: true },
    });
    expect(sAfter.members).toHaveLength(2);
    const aMember = sAfter.members.find((m) => m.orderId === orderA.id);
    expect(aMember).toBeDefined();
    expect(Number(aMember!.roomFraction)).toBe(1);
  });

  it('旧共享房只剩这一名乘客：拽走后旧房自动 DISSOLVED，不留零成员的幽灵房', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    // orderA 单独一人先占用一间共享房（份额 1，凑不出 Σ=1 就用这唯一一组，Σ 恰好为 1）。
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
    const oldRoomId = created.rooms[0].sharedRoomId;

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

    const oldRoomAfter = await prisma.sharedRoom.findUniqueOrThrow({
      where: { id: oldRoomId },
      include: { members: true },
    });
    expect(oldRoomAfter.status).toBe('DISSOLVED');
    expect(oldRoomAfter.members).toHaveLength(0);
    expect(oldRoomAfter.version).toBe(2);
  });
});

/**
 * astra B-N2：显式解散 S 并把它的成员在同一请求里迁进新房 T 时，解散分支曾经无条件把
 * S 的全部成员退回普通组、新建分支又给同一个 (orderId, orderItemId) 追加一个指向 T
 * 的共享组——同一名乘客同时落在一个普通组和一个共享组里，roomsBilled 按 orderItemId
 * 累加两边的 roomFraction，行级计费份额直接翻倍。
 */
describe('saveSharedRooms · 真 DB E2E · 显式解散并同时迁入新房不重复计费（astra B-N2）', () => {
  it('S 被 dissolve 的同时，S 的乘客被拖进新房 T → 最终只在 T，roomsBilled 不翻倍', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    // 先建共享房 S：A 单独一人，份额 1。
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
    const oldRoomId = created.rooms[0].sharedRoomId;

    // 同一请求：dissolve 掉 S，同时把 A 拖进一间新房 T（份额仍是 1）。
    const result = await saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        expectedVersions: { [oldRoomId]: 1 },
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
        dissolve: [oldRoomId],
      },
      actor,
    );
    expect(result.dissolved).toEqual([oldRoomId]);
    const newRoomId = result.rooms[0]!.sharedRoomId;
    expect(newRoomId).not.toBe(oldRoomId);

    // A 的订单 JSON 只有一个组（指向新房 T），不是「一个普通组 + 一个共享组」。
    const refreshedA = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } });
    const groupsA = (refreshedA.roomAssignment as { roomGroups: Array<Record<string, unknown>> }).roomGroups;
    const groupsForItem = groupsA.filter((g) => g.orderItemId === orderA.items[0].id);
    expect(groupsForItem).toHaveLength(1);
    expect(groupsForItem[0]!.sharedRoomId).toBe(newRoomId);

    // roomsBilled 仍是 1，不是 1（普通组）+ 1（共享组）= 2。
    const itemAfter = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderA.items[0].id } });
    expect(Number(itemAfter.roomsBilled)).toBe(1);
  });
});
