/**
 * 跨单分房波 2「入口矩阵」· 真 DB 集成测试
 *
 * 覆盖 docs/跨单分房-需求方案.md v2 §十三验收反例（波 2 负责的部分）：
 *   2. 主单取消，只剩 0 份额成员：物理仍 1 间，看板有提示（sharedRoomOrphaned）
 *   5. 混合归属旧单被换酒店：解绑后物理房数与看板一致
 *   6. 0 份额成员 no-show 自动拆单：成员搬到新单，目标单建 ¥0 行，Σ roomsBilled 不变
 *      （直接调用 splitOrder({ autoSplitRoomGroups: true })——no-show 编排与按人改期编排
 *      都复用同一个 executeSplitWithinTx 内核，此处验证的正是那个共用内核）
 *   12. 改单住 / 补房差在共享行被拒
 *  另覆盖反例 7 的「换酒店」一路：跨单分房保存 vs 换酒店并发触碰同一酒店的包房锁，
 *  断言两者都能正常完成（无死锁），不是重复反例 7 已覆盖的「跨单保存 vs 单单保存」。
 *
 * 跑：
 *   1. docker compose -f ../docker-compose.test.yml up -d（或本机 Postgres 指到 TEST_DATABASE_URL）
 *   2. npm run test:integration
 */
import { describe, it, expect, afterEach } from 'vitest';
import { OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { saveSharedRooms } from '../hotel-control/hotel-control.shared-rooms.js';
import { getAlerts, getHotelNightlyRemaining } from '../hotel-control/hotel-control.service.js';
import { OrderService } from './orders.service.js';

const service = new OrderService();

const CHECK_IN = '2026-10-01';
const CHECK_OUT = '2026-10-03';

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function requestToken(): string {
  return uniq('req');
}

/** requestToken 给 splitOrder 用必须是 uuid 形状。 */
function splitToken(tag: string): string {
  return `00000000-0000-4000-8000-0000000${tag.padStart(5, '0')}`;
}

async function adminActor(): Promise<{ userId: string; role: UserRole }> {
  const admin = await prisma.user.create({
    data: { email: `${uniq('u')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: admin.id, role: UserRole.ADMIN };
}

async function createHotelWithRoomType(rooms: number, checkIn = CHECK_IN, checkOut = CHECK_OUT) {
  const hotel = await prisma.hotel.create({
    data: { name: uniq('Hotel'), cityCode: 'DAD', address: 'Test address', starRating: 5, isActive: true },
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
      dateFrom: new Date(`${checkIn}T00:00:00.000Z`),
      dateTo: new Date(`${checkOut}T00:00:00.000Z`),
      rooms,
    },
  });
  return { hotel, roomType };
}

/** 建一个 PAID 订单，含 1 条 HOTEL 行 + N 位乘客。 */
async function createOrderWithPassengers(opts: {
  roomTypeId: string;
  passengerCount: number;
  checkIn?: string;
  checkOut?: string;
  itemKind?: typeof OrderItemKind.HOTEL | typeof OrderItemKind.BUNDLE;
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
      items: {
        create: [
          {
            kind: opts.itemKind ?? OrderItemKind.HOTEL,
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

/** 审计是 fire-and-forget，紧跟着的下一用例 TRUNCATE 偶发撞上飞行中的 INSERT 会死锁——给点时间落定。 */
function flushFireAndForgetAudit(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 80));
}

describe('跨单分房波 2 入口矩阵 · 真 DB E2E', () => {
  afterEach(() => flushFireAndForgetAudit());

  it('验收反例 2：主单取消只剩 0 份额成员——物理仍占 1 间，房控看板 sharedRoomOrphaned 有提示', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(1);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });

    const saved = await saveSharedRooms(
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

    // 主单（付钱那张，fraction=1）取消——0 份额的 orderB 仍是有效成员，继续白住。
    await prisma.order.update({ where: { id: orderA.id }, data: { status: OrderStatus.CANCELLED } });

    // 物理仍占 1 间：block=1，唯一还有效的成员（orderB）让共享房去重仍计 1。
    const nightly = await getHotelNightlyRemaining(hotel.id, [CHECK_IN]);
    expect(nightly.physicalRemaining).toEqual([0]);

    const alerts = await getAlerts(30);
    const orphan = alerts.sharedRoomOrphaned.find((o) => o.sharedRoomId === saved.rooms[0].sharedRoomId);
    expect(orphan).toBeDefined();
    expect(orphan?.memberOrderNumbers).toEqual([orderB.orderNumber]);
  });

  it('验收反例 5：混合归属旧单被换酒店——解绑后物理房数与看板一致（0 份额方 floor 回 1 间）', async () => {
    const actor = await adminActor();
    const { hotel: hotelOld, roomType: roomTypeOld } = await createHotelWithRoomType(1);
    const { hotel: hotelNew, roomType: roomTypeNew } = await createHotelWithRoomType(2);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomTypeOld.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomTypeOld.id, passengerCount: 1 });

    await saveSharedRooms(
      {
        hotelId: hotelOld.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [
          {
            hotelRoomTypeId: roomTypeOld.id,
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

    // 换酒店前：旧酒店物理 1 间（A+B 合住去重），新酒店物理 0 间。
    expect((await getHotelNightlyRemaining(hotelOld.id, [CHECK_IN])).physicalRemaining).toEqual([0]);
    expect((await getHotelNightlyRemaining(hotelNew.id, [CHECK_IN])).physicalRemaining).toEqual([2]);

    // 0 份额方（orderB）换到新酒店——解绑后应 floor 成物理 1 间落到新酒店。
    const { audit } = await service.swapItemHotel(
      orderB.id,
      orderB.items[0].id,
      { newHotelRoomTypeId: roomTypeNew.id, feeCny: 0 },
      { userId: actor.userId, role: UserRole.ADMIN },
    );
    expect(audit.warnings.length).toBeGreaterThan(0);

    // 解绑落库校验：SharedRoomMember 里已不再有 orderB 这一行的记录。
    const remainingMembers = await prisma.sharedRoomMember.findMany({
      where: { orderId: orderB.id, orderItemId: orderB.items[0].id },
    });
    expect(remainingMembers).toHaveLength(0);

    // 换酒店后：旧酒店仍是 1 间（orderA 单独还在，去重后不变）；
    // 新酒店：orderB 解绑后按普通房组 floor 回 1 间物理占用（block=2，故不会超卖）。
    expect((await getHotelNightlyRemaining(hotelOld.id, [CHECK_IN])).physicalRemaining).toEqual([0]);
    expect((await getHotelNightlyRemaining(hotelNew.id, [CHECK_IN])).physicalRemaining).toEqual([1]);
  });

  it('验收反例 6：0 份额成员随拆单搬到新单——目标单建 ¥0 行承载，Σ roomsBilled 守恒', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    // orderA：itemA 计费房数 0（纯让份），2 位乘客——p1 是共享成员（0 份额），p2 无住宿关联。
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 2 });
    await prisma.orderItem.update({
      where: { id: orderA.items[0].id },
      data: { roomsBilled: new Prisma.Decimal(0) },
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
                orderId: orderB.id,
                orderItemId: orderB.items[0].id,
                passengerIds: [orderB.passengers[0].id],
                roomFraction: 1,
              },
              {
                orderId: orderA.id,
                orderItemId: orderA.items[0].id,
                passengerIds: [orderA.passengers[0].id],
                roomFraction: 0,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );

    const sumRoomsBilledBefore = await prisma.orderItem.aggregate({
      where: { orderId: { in: [orderA.id] }, hotelRoomTypeId: { not: null } },
      _sum: { roomsBilled: true },
    });
    expect(Number(sumRoomsBilledBefore._sum.roomsBilled ?? 0)).toBe(0);

    // 模拟 no-show 自动拆单：把 p1（0 份额共享成员）单独拆出去（走 autoSplitRoomGroups=true，
    // no-show / 按人改期编排都复用同一个 executeSplitWithinTx 内核）。
    const result = await service.splitOrder(
      orderA.id,
      {
        passengerIds: [orderA.passengers[0].id],
        requestToken: splitToken('6'),
        autoSplitRoomGroups: true,
      },
      actor,
    );

    // 源行（itemA）未被扣减——搬走份额是 0，符合「源行是 NONE 时搬走份额只能是 0」的守恒前提。
    const itemAAfter = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderA.items[0].id } });
    expect(Number(itemAAfter.roomsBilled)).toBe(0);

    // 目标单新建了一条 ¥0 HOTEL 承载行，roomsBilled=0（搬走份额），金额恒 0。
    const targetItems = await prisma.orderItem.findMany({
      where: { orderId: result.targetOrderId, hotelRoomTypeId: { not: null } },
    });
    expect(targetItems).toHaveLength(1);
    expect(Number(targetItems[0].roomsBilled)).toBe(0);
    expect(Number(targetItems[0].amount)).toBe(0);
    expect(targetItems[0].hotelCheckIn?.toISOString().slice(0, 10)).toBe(CHECK_IN);

    // SharedRoomMember 真值已随人搬到新单新行。
    const p1Member = await prisma.sharedRoomMember.findFirstOrThrow({
      where: { passengerId: orderA.passengers[0].id },
    });
    expect(p1Member.orderId).toBe(result.targetOrderId);
    expect(p1Member.orderItemId).toBe(targetItems[0].id);

    // Σ roomsBilled 守恒：源行 0 + 新承载行 0 = 拆前 0。
    const sumRoomsBilledAfter = await prisma.orderItem.aggregate({
      where: { orderId: { in: [orderA.id, result.targetOrderId] }, hotelRoomTypeId: { not: null } },
      _sum: { roomsBilled: true },
    });
    expect(Number(sumRoomsBilledAfter._sum.roomsBilled ?? 0)).toBe(0);

    // 物理口径不变：orderB 仍是付钱方，去重后物理仍是 1 间（拆单不改变住宿事实）。
    expect((await getHotelNightlyRemaining(hotel.id, [CHECK_IN])).physicalRemaining).toEqual([3]); // block=4-1
  });

  it('验收反例 12：改单住 / 补单房差在共享行被拒（400，指向跨单分房解除合住）', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({
      roomTypeId: roomType.id,
      passengerCount: 1,
      itemKind: OrderItemKind.BUNDLE,
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

    await expect(
      service.setPassengerSingleRoom(
        orderA.id,
        orderA.passengers[0].id,
        { singleRoom: true },
        { userId: actor.userId, role: UserRole.ADMIN },
      ),
    ).rejects.toThrow(/与他单合住/);

    await expect(
      service.addRoomSupplement(
        orderA.id,
        { perNightCny: 100, nights: 2, passengerId: orderA.passengers[0].id },
        { userId: actor.userId, role: UserRole.ADMIN },
      ),
    ).rejects.toThrow(/与他单合住/);

    // 确认拒绝是真拒绝：没有副作用（乘客标记、房数都没被动过）。
    const untouched = await prisma.passenger.findUniqueOrThrow({ where: { id: orderA.passengers[0].id } });
    expect(untouched.singleRoom).toBe(false);
  });

  it('反例 7（换酒店一路）：跨单分房保存 vs 换酒店并发触碰同一酒店的包房锁，两者都正常完成（无死锁）', async () => {
    const actor = await adminActor();
    const { hotel: sharedHotel, roomType: sharedRoomType } = await createHotelWithRoomType(4);
    const { hotel: thirdHotel, roomType: thirdRoomType } = await createHotelWithRoomType(4);
    void thirdHotel;
    const orderA = await createOrderWithPassengers({ roomTypeId: sharedRoomType.id, passengerCount: 1 });
    const orderB = await createOrderWithPassengers({ roomTypeId: sharedRoomType.id, passengerCount: 1 });
    // orderC 换酒店的目标正是 sharedHotel——与跨单分房保存抢同一个酒店的包房周期锁。
    const orderC = await createOrderWithPassengers({ roomTypeId: thirdRoomType.id, passengerCount: 1 });

    const saved = await saveSharedRooms(
      {
        hotelId: sharedHotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [
          {
            hotelRoomTypeId: sharedRoomType.id,
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

    const concurrentSave = saveSharedRooms(
      {
        hotelId: sharedHotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        expectedVersions: { [saved.rooms[0].sharedRoomId]: saved.rooms[0].version },
        rooms: [
          {
            sharedRoomId: saved.rooms[0].sharedRoomId,
            hotelRoomTypeId: sharedRoomType.id,
            notes: 'concurrent-note',
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
    const concurrentSwap = service.swapItemHotel(
      orderC.id,
      orderC.items[0].id,
      { newHotelRoomTypeId: sharedRoomType.id, feeCny: 0 },
      { userId: actor.userId, role: UserRole.ADMIN },
    );

    const [saveOutcome, swapOutcome] = await Promise.allSettled([concurrentSave, concurrentSwap]);
    // 两者都必须落定（fulfilled 或 rejected 均可——版本冲突/房量不足都是合法业务结果），
    // 关键是**都在测试超时内返回**（Promise.allSettled 本身已保证不会挂起），且没有一方
    // 是数据库驱动抛出的裸死锁错误（40P01）——那才代表加锁顺序真的有问题。
    for (const outcome of [saveOutcome, swapOutcome]) {
      if (outcome.status === 'rejected') {
        expect(String(outcome.reason)).not.toMatch(/deadlock/i);
      }
    }
    // 至少一方成功——不是两边互相绞死全部失败。
    expect([saveOutcome.status, swapOutcome.status]).toContain('fulfilled');
  });
});
