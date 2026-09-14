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
import { saveSharedRooms, getSharedRoomWorkbench } from './hotel-control.shared-rooms.js';
import { getHotelNightlyRemaining } from './hotel-control.service.js';
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
    await flushFireAndForgetAudit(); // 审计原先是 fire-and-forget，断言前先等它落定

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

/**
 * astra B7：工作台重存会清除本单房组备注。带 touched 共享键的旧组整体重建时，它在
 * 订单 JSON 里自己的 notes（单单编辑器维护的本地备注）没有被搬进重建后的对象——运营
 * 在单单分房编辑器里给某个房组写的备注，只要房控页跨单分房工作台对同一间房再保存一次
 * （哪怕只是加了一位新成员，不碰原有成员），这条备注就会消失。
 */
describe('saveSharedRooms · 真 DB E2E · 工作台重存保留本单房组备注（astra B7）', () => {
  afterEach(() => flushFireAndForgetAudit());

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
});

/**
 * astra B1：房组 id 曾经编码成 `shared:<sharedRoomId>:<orderItemId>` /
 * `plain:<sharedRoomId>:<orderItemId>`，代理/客户视角的 serializeRoomGroupsFor 只挑字段
 * 不改值，原样把这个 id 透传出去——等于把内部共享房 id 泄露给代理。用 saveSharedRooms
 * 真正落库产出的形状（不是手搭的干净 fixture）过一遍脱敏函数，断言整份响应的 JSON
 * 字符串里不包含 sharedRoomId 的真实值，而不只是检查某个字段不存在。
 */
describe('saveSharedRooms · 真 DB E2E · 房组 id 不泄露 sharedRoomId（astra B1）', () => {
  afterEach(() => flushFireAndForgetAudit());

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
  afterEach(() => flushFireAndForgetAudit());

  it('读模型：成员带 orderStatus / isActive，取消单的成员 isActive=false', async () => {
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
    expect(memberA).toMatchObject({ orderStatus: 'PAID', isActive: true });
    expect(memberB).toMatchObject({ orderStatus: 'CANCELLED', isActive: false });
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
  afterEach(() => flushFireAndForgetAudit());

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
