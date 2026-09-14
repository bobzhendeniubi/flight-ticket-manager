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
import { randomUUID } from 'node:crypto';
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

  it('astra finding A1 反例：同酒店换房型触发解绑，只有 1 间时必须拒（先解绑再算 before 会把 1 间伪装成 2 间存量而放行）', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(1); // 该酒店整段只有 1 间包房
    const otherRoomType = await prisma.hotelRoomType.create({
      data: {
        hotelId: hotel.id,
        name: uniq('Suite'),
        capacity: 2,
        maxAdults: 2,
        maxChildren: 0,
        basePrice: new Prisma.Decimal(900),
      },
    });
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

    // 换房型前：A/B 合住去重，该酒店物理只占 1 间（与 block=1 打平，没有余量）。
    expect((await getHotelNightlyRemaining(hotel.id, [CHECK_IN])).physicalRemaining).toEqual([0]);

    // B（0 份额那张）换到同酒店另一房型——解绑后 A 仍占 1 间（S 只剩 A），B 变普通房组
    // 再占 1 间，该酒店真实需要 2 间，但只有 1 间包房 → 必须被拒，不能放行超卖。
    await expect(
      service.swapItemHotel(
        orderB.id,
        orderB.items[0].id,
        { newHotelRoomTypeId: otherRoomType.id, feeCny: 0 },
        { userId: actor.userId, role: UserRole.ADMIN },
      ),
    ).rejects.toThrow(/实际房间不足/);

    // 闸没通过 → 解绑绝不能落库：orderB 仍是共享成员，房型也没变。
    const stillMember = await prisma.sharedRoomMember.findMany({
      where: { orderId: orderB.id, orderItemId: orderB.items[0].id },
    });
    expect(stillMember).toHaveLength(1);
    const itemBAfter = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderB.items[0].id } });
    expect(itemBAfter.hotelRoomTypeId).toBe(roomType.id);

    // 物理占用维持原状（仍是打平的 1 间，没有被拒绝的操作污染）。
    expect((await getHotelNightlyRemaining(hotel.id, [CHECK_IN])).physicalRemaining).toEqual([0]);
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
    // astra finding A8：承载行成本必须显式是 0（Prisma.Decimal），不能是 null——写 null 会被
    // 财务报表的「snapshot 为 null 就回退按酒店实际房价现查现算」兜底，让这条本不占库存的
    // ¥0 承载行凭空长出成本；也会被毛利明细的「totalCostCny 为 null = 缺成本」判成未知，
    // 拖累整单毛利算不出来。
    expect(targetItems[0].unitCostCny).not.toBeNull();
    expect(Number(targetItems[0].unitCostCny)).toBe(0);
    expect(targetItems[0].totalCostCny).not.toBeNull();
    expect(Number(targetItems[0].totalCostCny)).toBe(0);

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

  it('astra finding A14 反例：换酒店碰真正的共享成员锁冲突（不是无关的第三张单）——两者都不能死锁，最终状态自洽', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const { roomType: otherRoomType } = await (async () => {
      const rt = await prisma.hotelRoomType.create({
        data: {
          hotelId: hotel.id,
          name: uniq('Suite'),
          capacity: 2,
          maxAdults: 2,
          maxChildren: 0,
          basePrice: new Prisma.Decimal(900),
        },
      });
      return { roomType: rt };
    })();
    // orderA / orderB 是共享房的**双方**——不是无关的第三张单：并发操作都会去锁同一个
    // SharedRoom 行（saveSharedRooms 显式锁；swapItemHotel 触发 planUnbind 也锁同一行），
    // 才是真正验证「加锁顺序不会互相等成死锁」的场景（旧测试的第三方单只碰包房周期锁，
    // 碰不到 SharedRoom 行锁）。
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

    // 并发 A：跨单分房工作台重存同一间共享房（改备注，成员不变）——会锁 SharedRoom 行。
    const concurrentSave = saveSharedRooms(
      {
        hotelId: hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        expectedVersions: { [saved.rooms[0].sharedRoomId]: saved.rooms[0].version },
        rooms: [
          {
            sharedRoomId: saved.rooms[0].sharedRoomId,
            hotelRoomTypeId: roomType.id,
            notes: 'concurrent-note-real-member',
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
    // 并发 B：orderB（真正的共享成员，0 份额那侧）换到同酒店另一房型——触发 planUnbind，
    // 对同一个 SharedRoom 行 FOR UPDATE。
    const concurrentSwap = service.swapItemHotel(
      orderB.id,
      orderB.items[0].id,
      { newHotelRoomTypeId: otherRoomType.id, feeCny: 0 },
      { userId: actor.userId, role: UserRole.ADMIN },
    );

    const [saveOutcome, swapOutcome] = await Promise.allSettled([concurrentSave, concurrentSwap]);
    for (const outcome of [saveOutcome, swapOutcome]) {
      if (outcome.status === 'rejected') {
        expect(String(outcome.reason)).not.toMatch(/deadlock/i);
      }
    }
    expect([saveOutcome.status, swapOutcome.status]).toContain('fulfilled');

    // 最终状态自洽：不管谁先落地，orderB 这一行要么仍是共享成员（save 后写，swap 的
    // 解绑输给了并发版本冲突而整体回滚），要么已解绑变普通房组（swap 后写）——不允许
    // 出现「JSON 说已解绑、成员表却还在」或反过来的分叉态。
    const memberRows = await prisma.sharedRoomMember.findMany({
      where: { orderId: orderB.id, orderItemId: orderB.items[0].id },
    });
    const orderBAfter = await prisma.order.findUniqueOrThrow({
      where: { id: orderB.id },
      select: { roomAssignment: true },
    });
    const orderBGroup = (
      orderBAfter.roomAssignment as { roomGroups: Array<Record<string, unknown>> }
    ).roomGroups.find((g) => g.orderItemId === orderB.items[0].id);
    const jsonSaysShared = typeof orderBGroup?.sharedRoomId === 'string';
    expect(memberRows.length > 0).toBe(jsonSaysShared);
  });

  it('入口 B（酒店改期）：共享行改期先解绑，新旧区间都过闸，物理口径 floor 回 1 间', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4, CHECK_IN, '2026-10-06');
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

    const newCheckIn = '2026-10-04';
    const newCheckOut = '2026-10-06';
    const { audit } = await service.rescheduleItemHotel(
      orderB.id,
      orderB.items[0].id,
      { newCheckIn, newCheckOut, feeCny: 0 },
      { userId: actor.userId, role: UserRole.ADMIN },
    );
    expect(audit.warnings.length).toBeGreaterThan(0);

    const remainingMembers = await prisma.sharedRoomMember.findMany({
      where: { orderId: orderB.id, orderItemId: orderB.items[0].id },
    });
    expect(remainingMembers).toHaveLength(0);

    // 旧区间（10/1~10/3）：orderA 单独还在，物理仍是 1 间。
    expect((await getHotelNightlyRemaining(hotel.id, [CHECK_IN])).physicalRemaining).toEqual([3]); // block4-1
    // 新区间（10/4~10/6）：orderB 解绑后 floor 回 1 间普通房组。
    expect((await getHotelNightlyRemaining(hotel.id, [newCheckIn])).physicalRemaining).toEqual([3]); // block4-1
  });

  it('入口 F（按房组拆行）：0 份额共享组允许搬行，SharedRoomMember.orderItemId 跟着改指到新行', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 2 });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    // orderA 两位乘客：p1 是共享成员（0 份额，随行拆出）；p2 只是让源行 roomsBilled 保持 1（p2 走
    // 普通房组，不受影响）——用两个房组表达「一条行同时有普通房 + 共享房」（§三）。
    await prisma.order.update({
      where: { id: orderA.id },
      data: {
        roomAssignment: {
          roomGroups: [
            {
              id: 'plain-1',
              hotelName: '',
              roomType: '',
              passengerIds: [orderA.passengers[1].id],
              orderItemId: orderA.items[0].id,
              roomFraction: 1,
            },
          ],
        },
      },
    });

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

    const reloaded = await prisma.order.findUniqueOrThrow({
      where: { id: orderA.id },
      select: { roomAssignment: true },
    });
    const groups = (reloaded.roomAssignment as { roomGroups: Array<{ id: string; sharedRoomId?: string }> })
      .roomGroups;
    const sharedGroup = groups.find((g) => g.sharedRoomId === saved.rooms[0].sharedRoomId);
    expect(sharedGroup).toBeDefined();

    const { audit } = await service.splitHotelItemByRoomGroup(
      orderA.id,
      orderA.items[0].id,
      { roomGroupId: sharedGroup!.id },
      { userId: actor.userId, role: UserRole.ADMIN },
    );
    expect(audit.after.newRoomsBilled).toBe(0);
    expect(audit.after.fromRoomsBilled).toBe(1); // 普通组（p2）的 1 间原样留在源行

    const member = await prisma.sharedRoomMember.findFirstOrThrow({
      where: { passengerId: orderA.passengers[0].id },
    });
    expect(member.orderId).toBe(orderA.id); // 拆行不跨单，仍是同一张单
    expect(member.orderItemId).toBe(audit.newItemId); // 但已改指到新拆出的行
    expect(member.orderItemId).not.toBe(audit.fromItemId);
  });

  it('astra finding A7 ⑤ 反例：源行总计费房数为 0 的共享组仍允许按房组拆行（旧闸把 0 间源行一律拒了）', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    // orderA 整行 roomsBilled=0（纯粹的让份行，真实占房在共享房另一侧的 orderB 上）；
    // totalCostCny 给一个非零存量值，专门验证 0 份额搬行不会拿它去做比例除法（除零）。
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    await prisma.orderItem.update({
      where: { id: orderA.items[0].id },
      data: { roomsBilled: new Prisma.Decimal(0), totalCostCny: new Prisma.Decimal(500) },
    });
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
    const reloaded = await prisma.order.findUniqueOrThrow({
      where: { id: orderA.id },
      select: { roomAssignment: true },
    });
    const sharedGroup = (
      reloaded.roomAssignment as { roomGroups: Array<{ id: string; sharedRoomId?: string }> }
    ).roomGroups.find((g) => g.sharedRoomId === saved.rooms[0].sharedRoomId);
    expect(sharedGroup).toBeDefined();

    // 旧闸「源行未记录计费房数（roomsBilled≤0）」会在这里直接拒掉；共享组应当放行。
    const { audit } = await service.splitHotelItemByRoomGroup(
      orderA.id,
      orderA.items[0].id,
      { roomGroupId: sharedGroup!.id },
      { userId: actor.userId, role: UserRole.ADMIN },
    );
    expect(audit.after.fromRoomsBilled).toBe(0);
    expect(audit.after.newRoomsBilled).toBe(0);
    expect(audit.after.newTotalCostCny).toBe(0); // 0 份额成本恒为 0（不除零、不报错）

    const member = await prisma.sharedRoomMember.findFirstOrThrow({
      where: { passengerId: orderA.passengers[0].id },
    });
    expect(member.orderId).toBe(orderA.id);
    expect(member.orderItemId).toBe(audit.newItemId);
  });

  it('入口 H（恢复）：共享房已被解散后恢复取消单，一致性校验触发解绑 + 警告', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
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

    // 取消 orderA（成员表原样保留——波 1 设计）。
    await prisma.order.update({ where: { id: orderA.id }, data: { status: OrderStatus.CANCELLED } });
    // 房控工作台把这间共享房解散掉（模拟“订单取消期间共享房状态被改”）。
    await prisma.sharedRoom.update({
      where: { id: saved.rooms[0].sharedRoomId },
      data: { status: 'DISSOLVED', dissolvedAt: new Date(), dissolvedReason: 'test-dissolve' },
    });

    const { audit } = await service.restoreCancelledOrder(
      orderA.id,
      { requestToken: randomUUID(), allowOversell: false, allowFlownLegs: false },
      { userId: actor.userId, role: UserRole.ADMIN },
    );
    expect(audit.warnings.some((w) => w.includes('合住'))).toBe(true);

    // 一致性校验命中：orderA 这一行的共享成员已被解绑（房已 DISSOLVED，不再一致）。
    const members = await prisma.sharedRoomMember.findMany({
      where: { orderId: orderA.id, orderItemId: orderA.items[0].id },
    });
    expect(members).toHaveLength(0);
  });

  it('astra finding A2 反例：恢复时共享房一致（保留合住）不能被当成「凭空新增一间」拒掉——只有 1 间也该放行', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(1); // 该酒店整段只有 1 间包房
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

    // 取消 orderA——orderB（0 份额）仍有效，共享房去重仍占 1 间（与验收反例 2 同一口径）。
    await prisma.order.update({ where: { id: orderA.id }, data: { status: OrderStatus.CANCELLED } });
    expect((await getHotelNightlyRemaining(hotel.id, [CHECK_IN])).physicalRemaining).toEqual([0]);

    // 恢复 orderA：房间状态与日期都一致（未被动过）→ 应保留合住关系，物理占用仍是去重后
    // 的 1 间（A、B 本就合住同一间），不该被老式「按份额直接前瞻加回一整间」误判成需要
    // 2 间而拒绝——block 只有 1 间，若真被当成新增 1 间就会 400。
    await expect(
      service.restoreCancelledOrder(
        orderA.id,
        { requestToken: randomUUID(), allowOversell: false, allowFlownLegs: false },
        { userId: actor.userId, role: UserRole.ADMIN },
      ),
    ).resolves.toBeDefined();

    // 合住关系原样保留：orderA 仍是该共享房成员，没有被误判触发解绑。
    const members = await prisma.sharedRoomMember.findMany({
      where: { sharedRoomId: saved.rooms[0].sharedRoomId },
    });
    expect(members.map((m) => m.orderId).sort()).toEqual([orderA.id, orderB.id].sort());

    // 恢复后物理占用仍是去重后的 1 间（不是被拆成两间）。
    expect((await getHotelNightlyRemaining(hotel.id, [CHECK_IN])).physicalRemaining).toEqual([0]);
  });

  it('astra finding A7 ①②③④ 反例：混合共享房组手工拆单——份额留源单、不写 splitPairKey、成员表不翻倍', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    // orderA：2 位乘客（p1 拆出、p2 留守）共用同一个 0 份额共享房组——多人 0 份额房组
    // 本身就是 finding ① 要放行的场景（旧闸把它当「脏数据」拒在拆单门外）。
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 2 });
    const [p1, p2] = orderA.passengers;
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
                orderId: orderB.id,
                orderItemId: orderB.items[0].id,
                passengerIds: [orderB.passengers[0].id],
                roomFraction: 1,
              },
              {
                orderId: orderA.id,
                orderItemId: orderA.items[0].id,
                passengerIds: [p1.id, p2.id],
                roomFraction: 0,
              },
            ],
          },
        ],
        dissolve: [],
      },
      actor,
    );
    const sharedRoomId = saved.rooms[0].sharedRoomId!;
    const versionBefore = (
      await prisma.sharedRoom.findUniqueOrThrow({ where: { id: sharedRoomId }, select: { version: true } })
    ).version;

    // 手工拆单（不传 autoSplitRoomGroups）：只拆出 p1，留下 p2——闸 15 对普通房组会拒绝
    // 「同时含拆出与留下的乘客」，但共享组不吃这道闸；旧的「脏数据」检查（0 份额房组住了
    // 2 人）也不该拦下这个合法的共享组。
    const result = await service.splitOrder(
      orderA.id,
      { passengerIds: [p1.id], requestToken: splitToken('a7') },
      actor,
    );

    // 房组 JSON：两侧都保留 sharedRoomId、都不带 splitPairKey（astra finding ②④）。
    const [sourceOrder, targetOrder] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: orderA.id }, select: { roomAssignment: true } }),
      prisma.order.findUniqueOrThrow({ where: { id: result.targetOrderId }, select: { roomAssignment: true } }),
    ]);
    const sourceGroups = (sourceOrder.roomAssignment as { roomGroups: Array<Record<string, unknown>> })
      .roomGroups;
    const targetGroups = (targetOrder.roomAssignment as { roomGroups: Array<Record<string, unknown>> })
      .roomGroups;
    const keptGroup = sourceGroups.find((g) => g.sharedRoomId === sharedRoomId);
    const movedGroup = targetGroups.find((g) => g.sharedRoomId === sharedRoomId);
    expect(keptGroup).toBeDefined();
    expect(movedGroup).toBeDefined();
    expect(keptGroup?.splitPairKey).toBeUndefined();
    expect(movedGroup?.splitPairKey).toBeUndefined();
    // 份额默认整块留源单：p2（留守）那一侧保留原份额 0，p1（拆出）那一侧份额也是 0——
    // 本例份额本就是 0，用另一条断言（下面 SharedRoomMember 汇总）证明「不是按人头强劈」。
    expect(keptGroup?.roomFraction).toBe(0);
    expect(movedGroup?.roomFraction).toBe(0);

    // SharedRoomMember 真值表同步更新，且按 (orderId, orderItemId) 去重求和后份额守恒
    // （astra finding ③：旧代码只搬 orderId/orderItemId 不改 roomFraction，两侧各自
    // 还留着拆分前的合并值，去重求和会翻倍）。
    const members = await prisma.sharedRoomMember.findMany({
      where: { sharedRoomId },
      select: { orderId: true, orderItemId: true, passengerId: true, roomFraction: true },
    });
    const p1Member = members.find((m) => m.passengerId === p1.id)!;
    const p2Member = members.find((m) => m.passengerId === p2.id)!;
    expect(p1Member.orderId).toBe(result.targetOrderId); // p1 真已随人搬到新单
    expect(p2Member.orderId).toBe(orderA.id); // p2 留守原单
    // 只看 orderA 这一侧拆出来的两个 (orderId, orderItemId) 组合（orderB 的成员未受本次
    // 拆单影响，混进整间的求和会掩盖本例本就是 0 的事实——非零场景见下一条用例）。
    const p1p2Fraction = Number(p1Member.roomFraction) + Number(p2Member.roomFraction);
    expect(p1p2Fraction).toBe(0); // 本例份额本就是 0：翻倍的话仍是 0，用下面非零场景再钉一遍

    // SharedRoom.version 递增（astra finding ②：份额变了要体现在 CAS 版本上）。
    const versionAfter = (
      await prisma.sharedRoom.findUniqueOrThrow({ where: { id: sharedRoomId }, select: { version: true } })
    ).version;
    expect(versionAfter).toBeGreaterThan(versionBefore);
  });

  it('astra finding A7 ③ 反例（非零份额）：混合共享组拆分后份额按 (orderId,orderItemId) 去重求和必须等于拆分前，不能翻倍', async () => {
    const actor = await adminActor();
    const { hotel, roomType } = await createHotelWithRoomType(4);
    // orderA：2 位乘客共享同一个房组，roomFraction=1（真实付钱占房的一侧）；p1 拆出、p2 留守。
    const orderA = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 2 });
    const [p1, p2] = orderA.passengers;
    await prisma.orderItem.update({
      where: { id: orderA.items[0].id },
      data: { roomsBilled: new Prisma.Decimal(1) },
    });
    const orderB = await createOrderWithPassengers({ roomTypeId: roomType.id, passengerCount: 1 });
    await prisma.orderItem.update({
      where: { id: orderB.items[0].id },
      data: { roomsBilled: new Prisma.Decimal(0) },
    });

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
                passengerIds: [p1.id, p2.id],
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
    const sharedRoomId = saved.rooms[0].sharedRoomId!;

    const result = await service.splitOrder(
      orderA.id,
      { passengerIds: [p1.id], requestToken: splitToken('a7v2') },
      actor,
    );

    // 份额默认整块留源单：p2 侧仍是 1，p1（拆出）侧是 0——不是按人头强劈成 0.5/0.5。
    const members = await prisma.sharedRoomMember.findMany({
      where: { sharedRoomId },
      select: { orderId: true, orderItemId: true, passengerId: true, roomFraction: true },
    });
    const p1Member = members.find((m) => m.passengerId === p1.id)!;
    const p2Member = members.find((m) => m.passengerId === p2.id)!;
    expect(Number(p2Member.roomFraction)).toBe(1);
    expect(Number(p1Member.roomFraction)).toBe(0);
    expect(p1Member.orderId).toBe(result.targetOrderId);
    expect(p1Member.orderId).not.toBe(p2Member.orderId);

    // 按 (orderId, orderItemId) 去重求和 = 1（拆分前后守恒）——旧代码两侧各自保留原值 1，
    // 去重求和会是 2（翻倍）。
    const byOrderItem = new Map<string, number>();
    for (const m of members) {
      byOrderItem.set(`${m.orderId}:${m.orderItemId}`, Number(m.roomFraction));
    }
    const totalFraction = [...byOrderItem.values()].reduce((s, v) => s + v, 0);
    expect(totalFraction).toBe(1);
  });
});
