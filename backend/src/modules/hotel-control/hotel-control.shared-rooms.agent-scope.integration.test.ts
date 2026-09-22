/**
 * 跨单分房 · 代理自助拼房（2026-09-21 拍板）· 真 DB 集成测试
 *
 * 场景：代理 A（含下级 A'）与代理 B 各有同酒店同日期的单；运营已把 A1 + B1 合成一间共享房。
 *   - A 的工作台：候选只含自家（含下级）的单；A1+B1 那间 readOnly、B1 脱敏成「其他代理客人」；
 *     B 的工作台对称（A1 脱敏）；ADMIN 工作台原样（回归）。
 *   - A 越界：点名 B 的单 403；解散 / 更新运营安排的混合房 403；把自家客人从混合房拽走 403；
 *     整房落位含 B 成员的档次房 403。
 *   - A 自助：自家两张（本人 + 下级）随机档单合成一间档次房 → 整房落位到真实酒店成功，
 *     审计带 selfService；酒店房作用域下自家两单也能合住。
 *   - 归属范围只由调用方（路由层）给定；本测试直接调 service 模拟路由层已解析好的 scope。
 *
 * 跑：docker compose -f ../docker-compose.test.yml up -d && npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import { ForbiddenError } from '../../lib/errors.js';
import {
  AGENT_SCOPE_ORDER_FORBIDDEN,
  AGENT_SCOPE_PLACE_FORBIDDEN,
  AGENT_SCOPE_ROOM_FORBIDDEN,
  EXTERNAL_MEMBER_LABEL,
  getSharedRoomWorkbench,
  saveSharedRooms,
  type SharedRoomAgentScope,
} from './hotel-control.shared-rooms.js';
import { placeSharedRoom } from './shared-room-placement.js';

const CHECK_IN = '2026-10-01';
const CHECK_OUT = '2026-10-03';
const TIER = 4;

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
const requestToken = () => uniq('req');

interface Actor {
  userId: string;
  role: UserRole;
}

async function adminActor(): Promise<Actor> {
  const admin = await prisma.user.create({ data: { email: `${uniq('u')}@test.com`, role: UserRole.ADMIN } });
  return { userId: admin.id, role: UserRole.ADMIN };
}

/** 代理账号 + Agent 档案（可挂上级）；返回 actor 与路由层会解析出的归属范围（自己 + 下级）。*/
async function createAgent(parentAgentId?: string) {
  const user = await prisma.user.create({ data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT } });
  const agent = await prisma.agent.create({
    data: {
      userId: user.id,
      contactName: '测试代理',
      contactPhone: '13800138000',
      isActive: true,
      parentAgentId: parentAgentId ?? null,
      tier: parentAgentId ? 2 : 1,
    },
  });
  return { actor: { userId: user.id, role: UserRole.AGENT } as Actor, agentId: agent.id };
}

/** 与路由层 resolveSharedRoomAgentScope 同一口径：自己 + 全部下级。*/
async function scopeOf(agentId: string): Promise<SharedRoomAgentScope> {
  return new Set(await getDescendantAgentIds(agentId));
}

/** 真酒店（星级默认 4）+ 房型 + 包房周期（rooms 间）。*/
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

/** PAID 订单，1 条 HOTEL 行 + N 位乘客，可挂归属代理（省略 = 直客）。*/
async function createOrder(opts: {
  agentId?: string;
  roomTypeId?: string;
  randomStarTier?: number;
  passengerCount: number;
}) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('ORD'),
      status: OrderStatus.PAID,
      agentId: opts.agentId ?? null,
      subtotal: new Prisma.Decimal(1200),
      total: new Prisma.Decimal(1200),
      paidAmount: new Prisma.Decimal(1200),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.HOTEL,
            description: `酒店 · ${CHECK_IN}~${CHECK_OUT} · 2晚 × 1间`,
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

/**
 * 基线：真酒店包 3 间；代理 A（含下级 A'）、代理 B、直客各有单；运营把 A1 + B1 合成一间酒店房。
 */
async function seedMixedScenario() {
  const admin = await adminActor();
  const real = await createRealHotel(3);
  const A = await createAgent();
  const Achild = await createAgent(A.agentId);
  const B = await createAgent();
  const a1 = await createOrder({ agentId: A.agentId, roomTypeId: real.roomType.id, passengerCount: 1 });
  const a2 = await createOrder({ agentId: Achild.agentId, roomTypeId: real.roomType.id, passengerCount: 1 });
  const b1 = await createOrder({ agentId: B.agentId, roomTypeId: real.roomType.id, passengerCount: 1 });
  const direct = await createOrder({ roomTypeId: real.roomType.id, passengerCount: 1 });
  const merged = await saveSharedRooms(
    {
      hotelId: real.hotel.id,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      requestToken: requestToken(),
      rooms: [{ hotelRoomTypeId: real.roomType.id, groups: [group(a1, 1), group(b1, 0)] }],
      dissolve: [],
    },
    admin,
  );
  const mixedRoomId = merged.rooms[0]!.sharedRoomId;
  const mixedVersion = merged.rooms[0]!.version;
  return { admin, real, A, Achild, B, a1, a2, b1, direct, mixedRoomId, mixedVersion };
}

describe('代理自助拼房 · 工作台可见范围', () => {
  it('A 的候选只含自家（含下级）单；A1+B1 那间 readOnly 且 B1 脱敏；B 对称；ADMIN 原样（回归）', async () => {
    const s = await seedMixedScenario();
    const scopeA = await scopeOf(s.A.agentId);

    const wbA = await getSharedRoomWorkbench({ hotelId: s.real.hotel.id }, CHECK_IN, CHECK_OUT, undefined, {
      agentScope: scopeA,
    });
    expect(wbA.orders.map((o) => o.orderId).sort()).toEqual([s.a1.id, s.a2.id].sort());
    expect(wbA.orders.map((o) => o.orderId)).not.toContain(s.b1.id);
    expect(wbA.orders.map((o) => o.orderId)).not.toContain(s.direct.id);

    const mixed = wbA.sharedRooms.find((r) => r.sharedRoomId === s.mixedRoomId)!;
    expect(mixed).toBeDefined();
    expect(mixed.readOnly).toBe(true);
    expect(mixed.externalMemberCount).toBe(1);
    const ownMember = mixed.members.find((m) => m.orderId === s.a1.id)!;
    expect(ownMember.orderNumber).toBe(s.a1.orderNumber);
    const external = mixed.members.find((m) => m.orderId !== s.a1.id)!;
    expect(external.orderNumber).toBe(EXTERNAL_MEMBER_LABEL);
    expect(external.name).toBe(EXTERNAL_MEMBER_LABEL);
    expect(external.chineseName).toBeNull();
    expect(external.roomFraction).toBe(0);
    const json = JSON.stringify(wbA);
    expect(json.includes(s.b1.id)).toBe(false);
    expect(json.includes(s.b1.orderNumber)).toBe(false);
    expect(json.includes(s.b1.passengers[0]!.id)).toBe(false);

    // B 对称：只看见 B1；同一间房里 A1 被脱敏
    const wbB = await getSharedRoomWorkbench({ hotelId: s.real.hotel.id }, CHECK_IN, CHECK_OUT, undefined, {
      agentScope: await scopeOf(s.B.agentId),
    });
    expect(wbB.orders.map((o) => o.orderId)).toEqual([s.b1.id]);
    const mixedForB = wbB.sharedRooms.find((r) => r.sharedRoomId === s.mixedRoomId)!;
    expect(mixedForB.readOnly).toBe(true);
    expect(JSON.stringify(wbB).includes(s.a1.orderNumber)).toBe(false);

    // ADMIN：全量、不脱敏、readOnly=false
    const wbAdmin = await getSharedRoomWorkbench({ hotelId: s.real.hotel.id }, CHECK_IN, CHECK_OUT);
    expect(wbAdmin.orders.map((o) => o.orderId).sort()).toEqual([s.a1.id, s.a2.id, s.b1.id, s.direct.id].sort());
    const mixedAdmin = wbAdmin.sharedRooms.find((r) => r.sharedRoomId === s.mixedRoomId)!;
    expect(mixedAdmin.readOnly).toBe(false);
    expect(mixedAdmin.externalMemberCount).toBe(0);
    expect(mixedAdmin.members.map((m) => m.orderNumber).sort()).toEqual([s.a1.orderNumber, s.b1.orderNumber].sort());
  });

  it('运营备注：混合房对代理置空、纯别家房整间不返回；ADMIN 原样（F4）', async () => {
    const s = await seedMixedScenario();
    // 运营在备注里写了别家客人的姓名 / 单号（真实场景的自由文本）
    const sensitive = `${s.b1.orderNumber} ${s.b1.passengers[0]!.fullName} 13800000000 要靠窗`;
    await prisma.sharedRoom.update({ where: { id: s.mixedRoomId }, data: { notes: sensitive } });
    // 纯别家房：只有直客单，A 的范围里一个成员都没有
    const foreign = await saveSharedRooms(
      {
        hotelId: s.real.hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [
          { hotelRoomTypeId: s.real.roomType.id, groups: [group(s.direct, 1)], notes: sensitive },
        ],
        dissolve: [],
      },
      s.admin,
    );
    const foreignRoomId = foreign.rooms[0]!.sharedRoomId;

    const wbA = await getSharedRoomWorkbench({ hotelId: s.real.hotel.id }, CHECK_IN, CHECK_OUT, undefined, {
      agentScope: await scopeOf(s.A.agentId),
    });
    const ids = wbA.sharedRooms.map((r) => r.sharedRoomId);
    expect(ids).toContain(s.mixedRoomId);
    expect(ids).not.toContain(foreignRoomId);
    expect(wbA.sharedRooms.find((r) => r.sharedRoomId === s.mixedRoomId)!.notes).toBeNull();
    const jsonA = JSON.stringify(wbA);
    expect(jsonA.includes(sensitive)).toBe(false);
    expect(jsonA.includes(s.b1.orderNumber)).toBe(false);
    expect(jsonA.includes(s.direct.orderNumber)).toBe(false);

    // ADMIN 回归：两间房都在，备注原样
    const wbAdmin = await getSharedRoomWorkbench({ hotelId: s.real.hotel.id }, CHECK_IN, CHECK_OUT);
    const adminIds = wbAdmin.sharedRooms.map((r) => r.sharedRoomId);
    expect(adminIds).toContain(s.mixedRoomId);
    expect(adminIds).toContain(foreignRoomId);
    for (const r of wbAdmin.sharedRooms) expect(r.notes).toBe(sensitive);
  });
});

describe('代理自助拼房 · 越界一律 403，库不动', () => {
  it('点名 B 的单 / 直客单 → 403「只能分配自己名下的订单」，不建房', async () => {
    const s = await seedMixedScenario();
    const scopeA = await scopeOf(s.A.agentId);
    const before = await prisma.sharedRoom.count();
    for (const other of [s.b1, s.direct]) {
      await expect(
        saveSharedRooms(
          {
            hotelId: s.real.hotel.id,
            checkIn: CHECK_IN,
            checkOut: CHECK_OUT,
            requestToken: requestToken(),
            rooms: [{ hotelRoomTypeId: s.real.roomType.id, groups: [group(s.a2, 1), group(other, 0)] }],
            dissolve: [],
          },
          s.A.actor,
          undefined,
          { agentScope: scopeA },
        ),
      ).rejects.toThrow(AGENT_SCOPE_ORDER_FORBIDDEN);
    }
    expect(await prisma.sharedRoom.count()).toBe(before);
    // 幂等占位行已清理，不留 PENDING 哨兵
    expect(await prisma.sharedRoomRequest.count()).toBe(1); // 只剩运营那次合住的占位
  });

  it('解散 / 更新运营安排的混合房 → 403「该房间由运营安排、含其他代理客人」，房与成员原样', async () => {
    const s = await seedMixedScenario();
    const scopeA = await scopeOf(s.A.agentId);
    const common = { hotelId: s.real.hotel.id, checkIn: CHECK_IN, checkOut: CHECK_OUT };
    await expect(
      saveSharedRooms(
        { ...common, requestToken: requestToken(), expectedVersions: { [s.mixedRoomId]: s.mixedVersion }, rooms: [], dissolve: [s.mixedRoomId] },
        s.A.actor,
        undefined,
        { agentScope: scopeA },
      ),
    ).rejects.toThrow(AGENT_SCOPE_ROOM_FORBIDDEN);
    // 用「更新」改自家那份份额同样不行（房里有 B）
    await expect(
      saveSharedRooms(
        {
          ...common,
          requestToken: requestToken(),
          expectedVersions: { [s.mixedRoomId]: s.mixedVersion },
          rooms: [{ sharedRoomId: s.mixedRoomId, hotelRoomTypeId: s.real.roomType.id, groups: [group(s.a1, 0.5)] }],
          dissolve: [],
        },
        s.A.actor,
        undefined,
        { agentScope: scopeA },
      ),
    ).rejects.toThrow(ForbiddenError);
    const room = await prisma.sharedRoom.findUnique({ where: { id: s.mixedRoomId }, include: { members: true } });
    expect(room!.status).toBe('ACTIVE');
    expect(room!.version).toBe(s.mixedVersion);
    expect(room!.members.map((m) => m.orderId).sort()).toEqual([s.a1.id, s.b1.id].sort());
  });

  it('把自家客人从混合房拽进自家新房（隐式触及只读房）→ 403，混合房成员不变', async () => {
    const s = await seedMixedScenario();
    const scopeA = await scopeOf(s.A.agentId);
    await expect(
      saveSharedRooms(
        {
          hotelId: s.real.hotel.id,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          requestToken: requestToken(),
          rooms: [{ hotelRoomTypeId: s.real.roomType.id, groups: [group(s.a1, 1), group(s.a2, 0)] }],
          dissolve: [],
        },
        s.A.actor,
        undefined,
        { agentScope: scopeA },
      ),
    ).rejects.toThrow(AGENT_SCOPE_ROOM_FORBIDDEN);
    const members = await prisma.sharedRoomMember.findMany({ where: { sharedRoomId: s.mixedRoomId } });
    expect(members.map((m) => m.orderId).sort()).toEqual([s.a1.id, s.b1.id].sort());
  });

  it('整房落位含 B 成员的档次房 → 403，房仍是档次房', async () => {
    const admin = await adminActor();
    const real = await createRealHotel(3);
    const A = await createAgent();
    const B = await createAgent();
    const a1 = await createOrder({ agentId: A.agentId, randomStarTier: TIER, passengerCount: 1 });
    const b1 = await createOrder({ agentId: B.agentId, randomStarTier: TIER, passengerCount: 1 });
    const merged = await saveSharedRooms(
      { randomStarTier: TIER, checkIn: CHECK_IN, checkOut: CHECK_OUT, requestToken: requestToken(), rooms: [{ groups: [group(a1, 1), group(b1, 0)] }], dissolve: [] },
      admin,
    );
    const roomId = merged.rooms[0]!.sharedRoomId;
    await expect(
      placeSharedRoom(
        roomId,
        { hotelRoomTypeId: real.roomType.id, expectedVersion: merged.rooms[0]!.version },
        A.actor,
        undefined,
        { agentScope: await scopeOf(A.agentId) },
      ),
    ).rejects.toThrow(AGENT_SCOPE_PLACE_FORBIDDEN);
    const room = await prisma.sharedRoom.findUnique({ where: { id: roomId } });
    expect(room!.randomStarTier).toBe(TIER);
    expect(room!.hotelId).toBeNull();
  });
});

describe('代理自助拼房 · 自家单之间照常合住 / 落位', () => {
  it('酒店房：A 本人单 + 下级单合住成功，roomsBilled 1/0，审计带 selfService', async () => {
    const s = await seedMixedScenario();
    const scopeA = await scopeOf(s.A.agentId);
    // a1 已在混合房里；这里用另两张自家单：a2（下级）+ a3（本人）
    const a3 = await createOrder({ agentId: s.A.agentId, roomTypeId: s.real.roomType.id, passengerCount: 1 });
    const result = await saveSharedRooms(
      {
        hotelId: s.real.hotel.id,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestToken: requestToken(),
        rooms: [{ hotelRoomTypeId: s.real.roomType.id, groups: [group(a3, 1), group(s.a2, 0)] }],
        dissolve: [],
      },
      s.A.actor,
      undefined,
      { agentScope: scopeA },
    );
    expect(result.rooms).toHaveLength(1);
    const members = await prisma.sharedRoomMember.findMany({ where: { sharedRoomId: result.rooms[0]!.sharedRoomId } });
    expect(members.map((m) => m.orderId).sort()).toEqual([a3.id, s.a2.id].sort());
    const items = await prisma.orderItem.findMany({ where: { orderId: { in: [a3.id, s.a2.id] } } });
    const billed = Object.fromEntries(items.map((it) => [it.orderId, Number(it.roomsBilled?.toString())]));
    expect(billed[a3.id]).toBe(1);
    expect(billed[s.a2.id]).toBe(0);
    // 工作台里这间房对 A 可编辑
    const wb = await getSharedRoomWorkbench({ hotelId: s.real.hotel.id }, CHECK_IN, CHECK_OUT, undefined, { agentScope: scopeA });
    const own = wb.sharedRooms.find((r) => r.sharedRoomId === result.rooms[0]!.sharedRoomId)!;
    expect(own.readOnly).toBe(false);
    expect(own.members.map((m) => m.orderNumber).sort()).toEqual([a3.orderNumber, s.a2.orderNumber].sort());
    // 审计留痕 selfService
    const summary = await prisma.auditLog.findFirst({
      where: { action: 'SAVE_SHARED_ROOMS', actorUserId: s.A.actor.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect((summary!.after as { selfService?: boolean }).selfService).toBe(true);
    const perOrder = await prisma.auditLog.findMany({
      where: { action: 'UPDATE_ROOM_ASSIGNMENT', actorUserId: s.A.actor.userId },
    });
    expect(perOrder.length).toBe(2);
    for (const row of perOrder) expect((row.after as { selfService?: boolean }).selfService).toBe(true);
  });

  it('档次房：A 自家两张随机档单合住 → 整房落位到真实酒店成功，共享房转酒店房，审计带 selfService', async () => {
    const real = await createRealHotel(1); // 只包 1 间也能落（整间去重计 1）
    const A = await createAgent();
    const Achild = await createAgent(A.agentId);
    const scopeA = await scopeOf(A.agentId);
    const a1 = await createOrder({ agentId: A.agentId, randomStarTier: TIER, passengerCount: 1 });
    const a2 = await createOrder({ agentId: Achild.agentId, randomStarTier: TIER, passengerCount: 1 });
    const merged = await saveSharedRooms(
      { randomStarTier: TIER, checkIn: CHECK_IN, checkOut: CHECK_OUT, requestToken: requestToken(), rooms: [{ groups: [group(a1, 1), group(a2, 0)] }], dissolve: [] },
      A.actor,
      undefined,
      { agentScope: scopeA },
    );
    const roomId = merged.rooms[0]!.sharedRoomId;
    const placed = await placeSharedRoom(
      roomId,
      { hotelRoomTypeId: real.roomType.id, expectedVersion: merged.rooms[0]!.version },
      A.actor,
      undefined,
      { agentScope: scopeA },
    );
    expect(placed.hotelId).toBe(real.hotel.id);
    expect(placed.placedItems.map((p) => p.orderId).sort()).toEqual([a1.id, a2.id].sort());
    const room = await prisma.sharedRoom.findUnique({ where: { id: roomId }, include: { members: true } });
    expect(room!.hotelId).toBe(real.hotel.id);
    expect(room!.hotelRoomTypeId).toBe(real.roomType.id);
    expect(room!.randomStarTier).toBeNull();
    expect(room!.members).toHaveLength(2);
    const items = await prisma.orderItem.findMany({ where: { orderId: { in: [a1.id, a2.id] } } });
    for (const it of items) expect(it.hotelRoomTypeId).toBe(real.roomType.id);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'PLACE_SHARED_ROOM', actorUserId: A.actor.userId } });
    expect((audit!.after as { selfService?: boolean }).selfService).toBe(true);
    // 落位后酒店作用域下这间房对 A 仍可编辑（全员自家）
    const wb = await getSharedRoomWorkbench({ hotelId: real.hotel.id }, CHECK_IN, CHECK_OUT, undefined, { agentScope: scopeA });
    expect(wb.sharedRooms.find((r) => r.sharedRoomId === roomId)!.readOnly).toBe(false);
  });
});
