/**
 * 签证台「出发日期」筛选的订单集合 · 真 DB 集成测试
 *
 * departureDateWhere 的原生 SQL 由「每行机票各跑一次相关子查询取本单 MIN」改成「按订单 GROUP BY
 * 一次算出最早出发 / 最早签证日，再连回来」。本测试把改前那条 SQL 原样留作参照，在真库上逐区间
 * 比对两者命中的订单集合，覆盖口径里的每个分支：
 *   - 往返单只看最早一段（回程落在区间里的不算）；
 *   - 同一瞬间起飞、时区不同的两段并列最早：任一段的当地日落在区间里即命中；
 *   - 跨 UTC 日边界：按出发地时区折当地日；
 *   - 纯签证单按最早一行签证预计出行日期；有航班的单签证日期不插手；
 *   - 没有班次的机票行、没有预计出行日期的签证行不参与；
 *   - 区间只给一侧（开区间）。
 *
 * 跑：TEST_DATABASE_URL=… npm run test:integration -- src/modules/fulfillment/fulfillment.departure-date-filter.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { CabinClass, FulfillmentStatus, FulfillmentType, OrderItemKind, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { FulfillmentService } from './fulfillment.service.js';

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createSchedule(departureIso: string, tz: string) {
  const departureTime = new Date(departureIso);
  const flight = await prisma.flight.create({
    data: { flightNumber: uniq('T'), originCode: 'MFM', destinationCode: 'DAD', isActive: true },
  });
  return prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: tz,
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
    },
  });
}

type ItemSpec =
  | { kind: 'FLIGHT'; scheduleId: string | null }
  | { kind: 'VISA'; visaIntendedDate: string | null };

async function createOrder(label: string, items: ItemSpec[]) {
  const order = await prisma.order.create({
    data: {
      orderNumber: uniq(label),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(500),
      total: new Prisma.Decimal(500),
      contactName: label,
      contactPhone: '13800138000',
      items: {
        create: items.map((it) =>
          it.kind === 'FLIGHT'
            ? {
                kind: OrderItemKind.FLIGHT,
                description: '机票',
                quantity: 1,
                unitPrice: new Prisma.Decimal(100),
                amount: new Prisma.Decimal(100),
                flightScheduleId: it.scheduleId,
                flightCabin: CabinClass.ECONOMY,
              }
            : {
                kind: OrderItemKind.VISA,
                description: '签证',
                quantity: 1,
                unitPrice: new Prisma.Decimal(100),
                amount: new Prisma.Decimal(100),
                visaIntendedDate: it.visaIntendedDate ? new Date(`${it.visaIntendedDate}T00:00:00.000Z`) : null,
              },
        ),
      },
      passengers: {
        create: [
          {
            fullName: 'PAX',
            documentType: 'PASSPORT' as const,
            documentNumber: uniq('E'),
            nationality: 'CN',
            dateOfBirth: new Date('1990-01-01'),
          },
        ],
      },
    },
    include: { items: true },
  });
  await prisma.fulfillmentTask.create({
    data: { orderItemId: order.items[0].id, type: FulfillmentType.VISA_APPLICATION, status: FulfillmentStatus.PENDING },
  });
  return order;
}

/** 改前的原生 SQL（逐行相关子查询取 MIN），原样保留作参照实现。*/
async function legacyOrderIds(from: string | undefined, to: string | undefined): Promise<string[]> {
  const dayBounds = (localDay: Prisma.Sql): Prisma.Sql => {
    const bounds: Prisma.Sql[] = [];
    if (from) bounds.push(Prisma.sql`${localDay} >= ${from}`);
    if (to) bounds.push(Prisma.sql`${localDay} <= ${to}`);
    return Prisma.join(bounds, ' AND ');
  };
  const flightLocalDay = Prisma.sql`to_char(
    fs."departureTime" AT TIME ZONE 'UTC' AT TIME ZONE fs."departureTz",
    'YYYY-MM-DD'
  )`;
  const visaAnchorDay = Prisma.sql`to_char(v."visaIntendedDate", 'YYYY-MM-DD')`;
  const rows = await prisma.$queryRaw<Array<{ orderId: string }>>(Prisma.sql`
    SELECT DISTINCT oi."orderId" AS "orderId"
    FROM "OrderItem" oi
    JOIN "FlightSchedule" fs ON fs."id" = oi."flightScheduleId"
    WHERE oi."kind"::text = 'FLIGHT'
      AND fs."departureTime" = (
        SELECT MIN(fs2."departureTime")
        FROM "OrderItem" oi2
        JOIN "FlightSchedule" fs2 ON fs2."id" = oi2."flightScheduleId"
        WHERE oi2."orderId" = oi."orderId" AND oi2."kind"::text = 'FLIGHT'
      )
      AND ${dayBounds(flightLocalDay)}
    UNION
    SELECT DISTINCT v."orderId" AS "orderId"
    FROM "OrderItem" v
    WHERE v."kind"::text = 'VISA'
      AND v."visaIntendedDate" IS NOT NULL
      AND v."visaIntendedDate" = (
        SELECT MIN(v2."visaIntendedDate")
        FROM "OrderItem" v2
        WHERE v2."orderId" = v."orderId" AND v2."kind"::text = 'VISA'
      )
      AND NOT EXISTS (
        SELECT 1 FROM "OrderItem" f
        WHERE f."orderId" = v."orderId"
          AND f."kind"::text = 'FLIGHT' AND f."flightScheduleId" IS NOT NULL
      )
      AND ${dayBounds(visaAnchorDay)}
  `);
  return [...new Set(rows.map((r) => r.orderId))].sort();
}

/** 现行实现命中的订单集合（departureDateWhere 并回关系过滤前的那份 id 列表）。*/
async function currentOrderIds(from: string | undefined, to: string | undefined): Promise<string[]> {
  const service = new FulfillmentService() as unknown as {
    departureDateWhere(
      from: string | undefined,
      to: string | undefined,
    ): Promise<{ order: { OR: Array<{ id?: { in: string[] } }> } }>;
  };
  const where = await service.departureDateWhere(from, to);
  return [...(where.order.OR[0].id?.in ?? [])].sort();
}

describe('签证台出发日期筛选 · 订单集合（GROUP BY 改写与原逐行子查询一致）', () => {
  it('往返 / 并列最早跨时区 / 跨 UTC 日 / 纯签证 / 无锚点 / 开区间，逐区间与原 SQL 一致', async () => {
    // 澳门 10-05 23:30 当地 = 10-05 15:30Z；回程 10-08
    const out1005 = await createSchedule('2026-10-05T15:30:00.000Z', 'Asia/Macau');
    const ret1008 = await createSchedule('2026-10-08T15:30:00.000Z', 'Asia/Ho_Chi_Minh');
    // 同一瞬间起飞的两段：澳门当地 10-06 00:30（= 10-05 16:30Z），胡志明当地 10-05 23:30
    const tieMacau = await createSchedule('2026-10-05T16:30:00.000Z', 'Asia/Macau');
    const tieHcm = await createSchedule('2026-10-05T16:30:00.000Z', 'Asia/Ho_Chi_Minh');
    const out1007 = await createSchedule('2026-10-07T02:00:00.000Z', 'Asia/Macau');

    const roundTrip = await createOrder('RT', [
      { kind: 'FLIGHT', scheduleId: out1005.id },
      { kind: 'FLIGHT', scheduleId: ret1008.id },
    ]);
    const tie = await createOrder('TIE', [
      { kind: 'FLIGHT', scheduleId: tieMacau.id },
      { kind: 'FLIGHT', scheduleId: tieHcm.id },
    ]);
    const flightPlusVisa = await createOrder('FV', [
      { kind: 'FLIGHT', scheduleId: out1007.id },
      { kind: 'VISA', visaIntendedDate: '2026-10-05' },
    ]);
    const pureVisa = await createOrder('PV', [
      { kind: 'VISA', visaIntendedDate: '2026-10-09' },
      { kind: 'VISA', visaIntendedDate: '2026-10-06' },
      { kind: 'VISA', visaIntendedDate: null },
    ]);
    const noSchedule = await createOrder('NS', [
      { kind: 'FLIGHT', scheduleId: null },
      { kind: 'VISA', visaIntendedDate: '2026-10-05' },
    ]);
    const noAnchor = await createOrder('NA', [{ kind: 'VISA', visaIntendedDate: null }]);

    const ranges: Array<[string | undefined, string | undefined]> = [
      ['2026-10-05', '2026-10-05'],
      ['2026-10-06', '2026-10-06'],
      ['2026-10-07', '2026-10-07'],
      ['2026-10-08', '2026-10-08'],
      ['2026-10-09', '2026-10-09'],
      ['2026-10-05', '2026-10-09'],
      ['2026-10-06', undefined],
      [undefined, '2026-10-05'],
    ];
    for (const [from, to] of ranges) {
      expect(await currentOrderIds(from, to), `${from}~${to}`).toEqual(await legacyOrderIds(from, to));
    }

    // 关键分支的期望值（不只和旧 SQL 比，也钉住口径本身）
    const hit = async (from: string, to: string) => new Set(await currentOrderIds(from, to));
    const d1005 = await hit('2026-10-05', '2026-10-05');
    expect(d1005.has(roundTrip.id)).toBe(true); // 去程当地 10-05
    expect(d1005.has(tie.id)).toBe(true); // 并列最早：胡志明那段当地 10-05
    expect(d1005.has(noSchedule.id)).toBe(true); // 机票行没挂班次 = 无航班 → 按签证日期
    expect(d1005.has(flightPlusVisa.id)).toBe(false); // 有航班，签证日期不插手
    const d1006 = await hit('2026-10-06', '2026-10-06');
    expect(d1006.has(tie.id)).toBe(true); // 并列最早：澳门那段当地 10-06
    expect(d1006.has(pureVisa.id)).toBe(true); // 纯签证单：最早签证日 10-06
    const d1008 = await hit('2026-10-08', '2026-10-08');
    expect(d1008.has(roundTrip.id)).toBe(false); // 回程不算
    const d1009 = await hit('2026-10-09', '2026-10-09');
    expect(d1009.has(pureVisa.id)).toBe(false); // 不是最早那一行
    const all = await hit('2026-10-01', '2026-10-31');
    expect(all.has(noAnchor.id)).toBe(false); // 无锚点单由关系过滤的另一支保留，不在这份集合里
  });
});
