/**
 * 机票行成本快照 · 真 DB 集成测试
 *
 * 这条链路的价值全在两端之间：建单时算出的成本要**真的落进库**，报表才不再把毛利报成
 * 「未知」。中间任何一环断掉（快照没写、写了但报表没读、拆单没按人搬）在单测里都看不出来
 * ——单测里 Prisma 是 mock 的，写没写进去长得一模一样。
 *
 * 覆盖：
 *   1. 建单 → 机票行 totalCostCny 真的有数（不再恒 NULL）；
 *   2. 同一批单跑 getSalesReport：毛利不再是 null，且 = 收入 − 成本；
 *   3. 按航线维度分桶，往返单只进去程那一桶；
 *   4. 改期换班次 → 快照按新班次重打；
 *   5. 拆单 → 行成本按人搬，两侧相加守恒；
 *   6. 班次没录成本的单：快照留 NULL，报表照旧报「未知」（这条是防退化的关键——
 *      一旦哪天变成落 0，毛利就系统性虚高，而且再也没人会发现）。
 *
 * 跑：
 *   TEST_DATABASE_URL=... npm run test:integration --workspace=backend
 */
import { describe, it, expect } from 'vitest';
import { CabinClass, OrderItemKind, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService, type OrderRequester } from './orders.service.js';
import { getSalesReport } from '../reports/reports.service.js';

const service = new OrderService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** requestToken 必须是 uuid：拼一个固定形状、按 tag 区分的 v4。 */
function token(tag: string): string {
  return `00000000-0000-4000-8000-0000000${tag.padStart(5, '0')}`;
}

/**
 * 建单 / 改期 / 拆单统一用 ADMIN 身份跑。
 * STAFF 还要看岗位（staffRole）才拿得到改期、拆单这类能力，本文件测的是成本快照口径，
 * 不是权限矩阵——权限那条线由 capabilities.matrix 快照与各自的路由测试盖。
 */
async function adminRequester(): Promise<OrderRequester> {
  const u = await prisma.user.create({
    data: { email: `${uniq('u')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: u.id, role: UserRole.ADMIN };
}

function passenger(name: string) {
  return {
    fullName: name,
    documentType: 'PASSPORT' as const,
    documentNumber: uniq('P'),
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
    // 有机票航段的单强制要护照有效期（临期提示闸的前置），不给会在建单就被拒。
    passportExpiry: '2031-01-01',
  };
}

/**
 * 一条班次。成本按「包机 180000 ÷ 180 座 = 每座 1000」给，另加机场税 50 + 燃油 30
 * → 每座 1080。`withCost=false` 时七个科目全空（且不配周期）= 成本真未知。
 */
async function createSchedule(opts: {
  withCost: boolean;
  origin?: string;
  destination?: string;
  daysFromNow?: number;
}): Promise<{ id: string; flightId: string }> {
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `T${Math.floor(Math.random() * 1_000_000)}`,
      originCode: opts.origin ?? 'MFM',
      destinationCode: opts.destination ?? 'DAD',
      isActive: true,
    },
  });
  const departureTime = new Date(Date.now() + (opts.daysFromNow ?? 10) * 24 * 3600_000);
  const cost = opts.withCost
    ? {
        charterCostCny: new Prisma.Decimal(180_000),
        airportTaxDepCny: new Prisma.Decimal(50),
        fuelCostCny: new Prisma.Decimal(30),
      }
    : {};
  return prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: 'Asia/Macau',
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
      ...cost,
      seatClasses: {
        create: [
          {
            cabin: CabinClass.ECONOMY,
            capacity: 180,
            sold: 0,
            basePrice: new Prisma.Decimal(1500),
          },
        ],
      },
    },
    select: { id: true, flightId: true },
  });
}

function flightItem(scheduleId: string, quantity: number, description = '去程（经济舱）') {
  return {
    kind: 'FLIGHT' as const,
    description,
    quantity,
    unitPrice: 1500,
    flightScheduleId: scheduleId,
    flightCabin: CabinClass.ECONOMY,
  };
}

/** 今天的业务区间（报表按 createdAt 落区间，新建的单必然在里面）。 */
function todayRange(): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  return { from: today, to: today };
}

async function itemsOf(orderId: string) {
  return prisma.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
}

function num(v: Prisma.Decimal | null): number | null {
  return v == null ? null : Number(v.toString());
}

describe('机票行成本快照（真 DB）', () => {
  it('建单：机票行 totalCostCny 真的落库，不再恒 NULL', async () => {
    const requester = await adminRequester();
    const sched = await createSchedule({ withCost: true });

    const order = await service.createOrder(
      {
        contactName: '成本快照建单',
        contactPhone: '13800138000',
        items: [flightItem(sched.id, 2)],
        passengers: [passenger('ZHANG SAN'), passenger('LI SI')],
      },
      requester,
    );

    const [flight] = await itemsOf(order.id);
    expect(flight!.kind).toBe(OrderItemKind.FLIGHT);
    // 每座 (180000/180 + 50 + 30) = 1080，两座 = 2160
    expect(num(flight!.totalCostCny)).toBe(2160);
    expect(num(flight!.unitCostCny)).toBe(1080);
  });

  it('建单后跑经营报表：毛利不再是「未知」，且 = 收入 − 成本', async () => {
    const requester = await adminRequester();
    const sched = await createSchedule({ withCost: true });

    await service.createOrder(
      {
        contactName: '报表毛利',
        contactPhone: '13800138000',
        items: [flightItem(sched.id, 2)],
        passengers: [passenger('ZHANG SAN'), passenger('LI SI')],
      },
      requester,
    );

    const report = await getSalesReport(todayRange(), 'kind');
    const flightRow = report.rows.find((r) => r.key === 'FLIGHT')!;

    // 这一条就是整个改动要买的东西：以前这里恒 null（毛利率恒 100%），现在有数。
    expect(flightRow.missingCostItemCount).toBe(0);
    expect(flightRow.grossMarginCny).not.toBeNull();
    expect(flightRow.grossMarginCny).toBe(flightRow.revenueCny - flightRow.costCny);
    expect(flightRow.costCny).toBe(2160);
  });

  it('班次没录成本：快照留 NULL，报表照旧报「未知」（绝不落 0 让毛利虚高）', async () => {
    const requester = await adminRequester();
    const sched = await createSchedule({ withCost: false });

    const order = await service.createOrder(
      {
        contactName: '缺成本',
        contactPhone: '13800138000',
        items: [flightItem(sched.id, 1)],
        passengers: [passenger('WANG WU')],
      },
      requester,
    );

    const [flight] = await itemsOf(order.id);
    expect(flight!.totalCostCny).toBeNull();

    const report = await getSalesReport(todayRange(), 'kind');
    const flightRow = report.rows.find((r) => r.key === 'FLIGHT')!;
    expect(flightRow.missingCostItemCount).toBeGreaterThan(0);
    expect(flightRow.grossMarginCny).toBeNull();
  });

  it('按航线分桶：往返单只进去程那一桶，两条线的账不串', async () => {
    const requester = await adminRequester();
    const outbound = await createSchedule({ withCost: true, origin: 'MFM', destination: 'DAD' });
    const inbound = await createSchedule({
      withCost: true,
      origin: 'DAD',
      destination: 'MFM',
      daysFromNow: 14,
    });

    await service.createOrder(
      {
        contactName: '往返单航线',
        contactPhone: '13800138000',
        items: [flightItem(outbound.id, 1, '去程'), flightItem(inbound.id, 1, '回程')],
        passengers: [passenger('ZHAO LIU')],
      },
      requester,
    );

    const report = await getSalesReport(todayRange(), 'route');

    // 往返两条腿在库里是两条不同航线的航班；按「任一航段命中」分桶会把这张单数两遍。
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.key).toBe('MFM-DAD');
    expect(report.rows[0]!.orderCount).toBe(1);
    // 两条腿的收入都归这一桶（航线是订单级属性）。
    expect(report.rows[0]!.revenueCny).toBe(report.totals.revenueCny);
  });

  it('改期换班次：快照按新班次重打，不留原班次那份成本', async () => {
    const requester = await adminRequester();
    const from = await createSchedule({ withCost: true });
    // 新班次更贵：包机不变但机场税抬到 250 → 每座 1000 + 250 + 30 = 1280。
    const to = await createSchedule({ withCost: true, daysFromNow: 20 });
    await prisma.flightSchedule.update({
      where: { id: to.id },
      data: { airportTaxDepCny: new Prisma.Decimal(250) },
    });

    const order = await service.createOrder(
      {
        contactName: '改期重打成本',
        contactPhone: '13800138000',
        items: [flightItem(from.id, 1)],
        passengers: [passenger('SUN QI')],
      },
      requester,
    );
    const [before] = await itemsOf(order.id);
    expect(num(before!.totalCostCny)).toBe(1080);

    await service.rescheduleOrderItem(
      order.id,
      { orderItemId: before!.id, newScheduleId: to.id, requestToken: token('1') },
      { userId: requester.userId, role: UserRole.ADMIN },
    );

    const [after] = await itemsOf(order.id);
    expect(after!.flightScheduleId).toBe(to.id);
    expect(num(after!.totalCostCny)).toBe(1280);
  });

  it('拆单：行成本按人搬，两侧相加与拆前守恒', async () => {
    const requester = await adminRequester();
    const sched = await createSchedule({ withCost: true });

    const order = await service.createOrder(
      {
        contactName: '拆单成本守恒',
        contactPhone: '13800138000',
        items: [flightItem(sched.id, 3)],
        passengers: [passenger('PAX A'), passenger('PAX B'), passenger('PAX C')],
      },
      requester,
    );
    const [before] = await itemsOf(order.id);
    const costBefore = num(before!.totalCostCny)!;
    expect(costBefore).toBe(3240); // 每座 1080 × 3

    const created = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { passengers: { select: { id: true }, orderBy: { createdAt: 'asc' } } },
    });

    const result = await service.splitOrder(
      order.id,
      {
        passengerIds: [created.passengers[0]!.id],
        requestToken: token('2'),
        reason: '成本按人搬',
      },
      { userId: requester.userId, role: UserRole.ADMIN },
    );

    const keptCost = (await itemsOf(order.id))
      .filter((i) => i.kind === OrderItemKind.FLIGHT)
      .reduce((s, i) => s + (num(i.totalCostCny) ?? 0), 0);
    const movedCost = (await itemsOf(result.targetOrderId))
      .filter((i) => i.kind === OrderItemKind.FLIGHT)
      .reduce((s, i) => s + (num(i.totalCostCny) ?? 0), 0);

    // 拆走 1/3 人 → 成本按人搬，两侧相加恰好等于拆前（不凭空多出或少掉成本）。
    expect(movedCost).toBe(1080);
    expect(keptCost).toBe(2160);
    expect(keptCost + movedCost).toBe(costBefore);
  });
});
