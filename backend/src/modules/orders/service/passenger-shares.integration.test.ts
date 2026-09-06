/**
 * 按人份额落库（R1）· **真 DB** 集成测试
 *
 * 钉的是「写路径末尾落库的行 == 派生」这条主线，逐步走完 create → 按人调价 → 拆单 → 换人：
 *   1. 建单即有每人一行，persisted == derived 逐分，Σ 每人结算价 = 应收；
 *   2. 按人调价后行更新（p1 多 200，其余人不动）；
 *   3. 拆单：源单删掉被拆走乘客的行、新单补建，两侧各自 Σ 份额 = 各自应收；
 *   4. 换人：份额随乘客 id 走（同一行被覆盖），换人费不摊（Σ 份额 + 换人费 = 应收）；
 *   5. 读侧 lazy 回填：删掉份额行后读详情 → 行重建、DTO 标 PERSISTED；别人持锁时读不失败、标 DERIVED；
 *   6. 回填内核幂等：全删后回填齐，再跑一次 scanned = 0 / remaining = 0；算法换版老行重挑。
 *
 * 跑：
 *   TEST_DATABASE_URL=… npx vitest run -c vitest.integration.config.ts src/modules/orders/service/passenger-shares.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CabinClass, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import { OrderService, type OrderRequester } from '../orders.service.js';
import { payableCny, toCents } from '../../../lib/order-money.js';
import {
  PASSENGER_SHARE_ALGO_VERSION,
  computePassengerShareRows,
  shareRowsEqual,
  type PassengerShareRow,
} from '../passenger-shares.js';
import {
  backfillPassengerShares,
  countOrdersMissingShares,
  SHARE_SOURCE_SELECT,
} from './passenger-shares.js';

const service = new OrderService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function adminActor(): Promise<{ userId: string; role: UserRole }> {
  const u = await prisma.user.create({ data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN } });
  return { userId: u.id, role: UserRole.ADMIN };
}

async function staffRequester(): Promise<OrderRequester> {
  const u = await prisma.user.create({ data: { email: `${uniq('staff')}@test.com`, role: UserRole.STAFF } });
  return { userId: u.id, role: UserRole.STAFF };
}

async function createSchedule(opts: { hoursFromNow: number; capacity?: number }) {
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `S${Math.floor(Math.random() * 1000000)}`,
      originCode: 'MFM',
      destinationCode: 'DAD',
      isActive: true,
    },
  });
  const departureTime = new Date(Date.now() + opts.hoursFromNow * 3600_000);
  return prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: 'Asia/Macau',
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
      seatClasses: {
        create: [{ cabin: CabinClass.ECONOMY, capacity: opts.capacity ?? 50, sold: 0, basePrice: new Prisma.Decimal(1000) }],
      },
    },
  });
}

function passenger(i: number) {
  return {
    fullName: `WANG XIAO ${i}`,
    documentType: 'PASSPORT' as const,
    documentNumber: uniq(`P${i}`),
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
    passportExpiry: '2031-01-01',
  };
}

/** 三人单程机票单（每张 1000）。 */
async function createThreePaxOrder() {
  const requester = await staffRequester();
  const outbound = await createSchedule({ hoursFromNow: 72 });
  const created = await service.createOrder(
    {
      contactName: 'SHARES IT',
      contactPhone: '13800138000',
      items: [
        {
          kind: 'FLIGHT',
          description: '去程（经济舱）',
          quantity: 3,
          flightScheduleId: outbound.id,
          flightCabin: CabinClass.ECONOMY,
        },
      ],
      passengers: [passenger(1), passenger(2), passenger(3)],
    },
    requester,
  );
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: created.id },
    include: { passengers: { orderBy: { fullName: 'asc' } } },
  });
  return { order, requester };
}

async function persistedRows(orderId: string): Promise<PassengerShareRow[]> {
  const rows = await prisma.orderPassengerShare.findMany({ where: { orderId } });
  return rows.map((r) => ({
    passengerId: r.passengerId,
    settlementCny: Number(r.settlementCny),
    baseCny: Number(r.baseCny),
    adjustmentCny: Number(r.adjustmentCny),
    visaCny: Number(r.visaCny),
    singleRoomDiffCny: Number(r.singleRoomDiffCny),
    discountCny: Number(r.discountCny),
  }));
}

/** 落库 == 派生（逐分）+ Σ 每人结算价 + 不摊条目 = 应收；返回派生结果供进一步断言。 */
async function expectPersistedEqualsDerived(orderId: string) {
  const source = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: SHARE_SOURCE_SELECT });
  const derived = computePassengerShareRows(source);
  const persisted = await persistedRows(orderId);
  expect(persisted.length).toBe(source.passengers.length);
  expect(shareRowsEqual(persisted, derived.rows)).toBe(true);
  const sum = persisted.reduce((s, r) => s + toCents(r.settlementCny), 0);
  expect(sum + toCents(derived.excludedCny)).toBe(toCents(payableCny(source)));
  const versions = await prisma.orderPassengerShare.findMany({ where: { orderId }, select: { algoVersion: true } });
  expect(versions.every((v) => v.algoVersion === PASSENGER_SHARE_ALGO_VERSION)).toBe(true);
  return { derived, persisted, source };
}

describe('按人份额 · 写路径落库（真 DB）', () => {
  it('建单 → 按人调价 → 拆单 → 换人：每一步落库值 == 派生，两侧 Σ 份额 = 各自应收', async () => {
    const admin = await adminActor();
    const { order } = await createThreePaxOrder();
    const [p1, p2, p3] = order.passengers;

    // ── 1. 建单即落库：三行、各 1000 ──
    const step1 = await expectPersistedEqualsDerived(order.id);
    expect(step1.persisted.map((r) => r.settlementCny)).toEqual([1000, 1000, 1000]);

    // ── 2. 按人调价：p1 多收 200 → p1 1200，其余 1000 ──
    await service.addPriceAdjustment(order.id, { amountCny: 200, reasonCode: 'MISC_FEE', passengerId: p1.id }, admin);
    const step2 = await expectPersistedEqualsDerived(order.id);
    const byPid2 = new Map(step2.persisted.map((r) => [r.passengerId, r]));
    expect(byPid2.get(p1.id)).toMatchObject({ settlementCny: 1200, baseCny: 1000, adjustmentCny: 200 });
    expect(byPid2.get(p2.id)).toMatchObject({ settlementCny: 1000, adjustmentCny: 0 });
    expect(byPid2.get(p3.id)).toMatchObject({ settlementCny: 1000, adjustmentCny: 0 });

    // ── 3. 拆单：p3 拆走 → 源单只剩 p1/p2 两行，新单一行 p3；两侧各自守恒 ──
    const split = await service.splitOrder(order.id, { passengerIds: [p3.id], requestToken: randomUUID() }, admin);
    const src = await expectPersistedEqualsDerived(order.id);
    const dst = await expectPersistedEqualsDerived(split.targetOrderId);
    expect(src.persisted.map((r) => r.passengerId).sort()).toEqual([p1.id, p2.id].sort());
    expect(dst.persisted.map((r) => r.passengerId)).toEqual([p3.id]);
    expect(dst.persisted[0].settlementCny).toBe(1000);
    // 源单没有残留 p3 的旧行
    expect(await prisma.orderPassengerShare.count({ where: { orderId: order.id, passengerId: p3.id } })).toBe(0);

    // ── 4. 换人：p2 换成新客 + 换人费 100 → 同一乘客 id 的行被覆盖；换人费不摊，Σ 份额 + 100 = 应收 ──
    const before = await prisma.orderPassengerShare.findUniqueOrThrow({
      where: { orderId_passengerId: { orderId: order.id, passengerId: p2.id } },
    });
    await service.swapPassenger(
      order.id,
      p2.id,
      {
        fullName: 'LI NEW',
        documentNumber: uniq('N'),
        dateOfBirth: '1992-02-02',
        nationality: 'CN',
        passportExpiry: '2033-01-01',
        feeCny: 100,
      },
      admin,
    );
    const step4 = await expectPersistedEqualsDerived(order.id);
    expect(step4.derived.excludedCny).toBe(100);
    const after = await prisma.orderPassengerShare.findUniqueOrThrow({
      where: { orderId_passengerId: { orderId: order.id, passengerId: p2.id } },
    });
    expect(after.id).toBe(before.id); // 份额随人（同一乘客 id）走：同一行被更新，不是删了重建
    expect(after.computedAt.getTime()).toBeGreaterThanOrEqual(before.computedAt.getTime());
    expect(step4.persisted.map((r) => r.passengerId).sort()).toEqual([p1.id, p2.id].sort());
  });
});

describe('按人份额 · 读侧 lazy 回填与回填内核（真 DB）', () => {
  it('删掉份额行后读详情 → 顺手回填、DTO 标 PERSISTED；别人持锁时读不失败、标 DERIVED', async () => {
    const { order, requester } = await createThreePaxOrder();
    await prisma.orderPassengerShare.deleteMany({ where: { orderId: order.id } });

    // 别人正持有这张单的行锁（模拟正在跑的写路径）：NOWAIT 拿不到锁 → 放弃回填，读照常返回派生值。
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const locking = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    const whileLocked = await service.getOrder(order.id, requester);
    expect(whileLocked.sharesSource).toBe('DERIVED');
    expect(whileLocked.passengerShares?.map((r) => r.settlementCny)).toEqual([1000, 1000, 1000]);
    expect(await prisma.orderPassengerShare.count({ where: { orderId: order.id } })).toBe(0);
    release();
    await locking;

    // 锁放开后再读：顺手回填 → 库里有了、DTO 标 PERSISTED，值与派生一致
    const dto = await service.getOrder(order.id, requester);
    expect(dto.sharesSource).toBe('PERSISTED');
    expect(dto.sharesComputedAt).toBeInstanceOf(Date);
    await expectPersistedEqualsDerived(order.id);
    expect(dto.passengerShares?.map((r) => r.settlementCny)).toEqual([1000, 1000, 1000]);
  });

  it('回填内核：全删后一次补齐、幂等（第二次 scanned = 0、remaining = 0）；算法换版老行重挑', async () => {
    const a = await createThreePaxOrder();
    const b = await createThreePaxOrder();
    await prisma.orderPassengerShare.deleteMany({});
    expect(await countOrdersMissingShares(prisma)).toBe(2);

    const first = await backfillPassengerShares({ limit: 10, client: prisma });
    expect(first).toMatchObject({ scanned: 2, persisted: 2, locked: 0, failed: 0, remaining: 0 });
    await expectPersistedEqualsDerived(a.order.id);
    await expectPersistedEqualsDerived(b.order.id);

    const second = await backfillPassengerShares({ limit: 10, client: prisma });
    expect(second).toMatchObject({ scanned: 0, persisted: 0, remaining: 0 });

    await prisma.orderPassengerShare.updateMany({ where: { orderId: a.order.id }, data: { algoVersion: 'old' } });
    expect(await countOrdersMissingShares(prisma)).toBe(1);
    const third = await backfillPassengerShares({ limit: 10, client: prisma });
    expect(third).toMatchObject({ scanned: 1, persisted: 1, remaining: 0 });
    await expectPersistedEqualsDerived(a.order.id);
  });
});
