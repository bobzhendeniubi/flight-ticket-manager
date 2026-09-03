/**
 * 按航班批量 no-show · **真 DB** 集成测试
 *
 * 为什么这一条非得走真库：批量的价值全在「一批下去，座位账到底对不对」。
 * mock 版里 `flightSeatClass` 是个返回常量的假对象、`$executeRaw` 恒返回 1，
 * 「放了 3 座」和「一座没放」长得一模一样。
 *
 * 覆盖一批两张单（业务上最典型的一批）：
 *   · 单 A —— 名单点到全员 → 整单标记，回程 2 座回库存；
 *   · 单 B —— 名单只点到 1 人 → 服务端先按人拆单（票随人走）、再对拆出的新单标记，
 *             回程 1 座回库存，留守那位的座位分毫不动。
 * 再加两条纪律：
 *   · 整批重试（同一个 requestToken）→ 逐单命中回放，sold 一座不动；
 *   · 拆单前后两张单的应收合计守恒 —— 这条链路一分钱都不该凭空多出来或少掉。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npx vitest run -c vitest.integration.config.ts \
 *        src/modules/orders/orders.no-show-batch.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { CabinClass, OrderItemKind, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService, type OrderRequester } from './orders.service.js';
import { executeNoShowBatch, previewNoShowBatch } from './no-show-batch.js';

const service = new OrderService();

const BATCH_TOKEN = 'b8f4f0f0-1c2d-4e3f-8a9b-0c1d2e3f4a5b';

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function adminActor(): Promise<{ userId: string; role: UserRole }> {
  const u = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: u.id, role: UserRole.ADMIN };
}

async function staffRequester(): Promise<OrderRequester> {
  const u = await prisma.user.create({
    data: { email: `${uniq('staff')}@test.com`, role: UserRole.STAFF },
  });
  return { userId: u.id, role: UserRole.STAFF };
}

async function createSchedule(hoursFromNow: number) {
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `T${Math.floor(Math.random() * 1000000)}`,
      originCode: 'MFM',
      destinationCode: 'DAD',
      isActive: true,
    },
  });
  const departureTime = new Date(Date.now() + hoursFromNow * 3600_000);
  return prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: 'Asia/Macau',
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
      seatClasses: {
        create: [
          {
            cabin: CabinClass.ECONOMY,
            capacity: 50,
            sold: 0,
            basePrice: new Prisma.Decimal(1000),
          },
        ],
      },
    },
    include: { seatClasses: true },
  });
}

async function soldOf(scheduleId: string): Promise<number> {
  const sc = await prisma.flightSeatClass.findFirstOrThrow({
    where: { scheduleId, cabin: CabinClass.ECONOMY },
  });
  return sc.sold;
}

/** 一位出行人：英文名 + 中文名 + 唯一证件号（三种匹配路子都覆盖得到）。 */
function passenger(fullName: string, chineseName: string, docTag: string) {
  return {
    fullName,
    chineseName,
    documentType: 'PASSPORT' as const,
    documentNumber: uniq(docTag).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
    passportExpiry: '2031-01-01',
  };
}

/** 建一张往返单（共用同一对班次）。 */
async function createRoundTripOrder(
  requester: OrderRequester,
  outboundId: string,
  returnId: string,
  pax: Array<ReturnType<typeof passenger>>,
) {
  const created = await service.createOrder(
    {
      contactName: 'NO SHOW BATCH E2E',
      contactPhone: '13800138000',
      items: [
        {
          kind: 'FLIGHT',
          description: '去程（经济舱）',
          quantity: pax.length,
          flightScheduleId: outboundId,
          flightCabin: CabinClass.ECONOMY,
        },
        {
          kind: 'FLIGHT',
          description: '回程（经济舱）',
          quantity: pax.length,
          flightScheduleId: returnId,
          flightCabin: CabinClass.ECONOMY,
        },
      ],
      passengers: pax,
    },
    requester,
  );
  return prisma.order.findUniqueOrThrow({
    where: { id: created.id },
    include: { passengers: true },
  });
}

/** 一张单的金额四字段 + 三合计（这条链路里必须前后一模一样）。 */
async function moneySnapshot(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { orderBy: { id: 'asc' } } },
  });
  return {
    subtotal: o.subtotal.toString(),
    total: o.total.toString(),
    paidAmount: o.paidAmount.toString(),
    items: o.items.map((it) => ({
      id: it.id,
      unitPrice: it.unitPrice.toString(),
      amount: it.amount.toString(),
      unitCostCny: it.unitCostCny?.toString() ?? null,
      totalCostCny: it.totalCostCny?.toString() ?? null,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════════
describe('按航班批量 no-show（真 DB）', () => {
  it('一批两张单：整单 + 部分乘客自动拆，座位账逐座对得上、钱守恒', async () => {
    const actor = await adminActor();
    const requester = await staffRequester();
    const outbound = await createSchedule(48);
    const ret = await createSchedule(24 * 10);

    // 单 A：2 人，名单点到全员 → 整单标记。
    const orderA = await createRoundTripOrder(requester, outbound.id, ret.id, [
      passenger('CHEN/ZHIYUAN', '陈志远', 'PA1'),
      passenger('LIN/XIAOMEI', '林晓梅', 'PA2'),
    ]);
    // 单 B：2 人，名单只点到 1 人 → 先拆单再标记。
    const orderB = await createRoundTripOrder(requester, outbound.id, ret.id, [
      passenger('ZHAO/MING', '赵明', 'PB1'),
      passenger('SUN/JIALE', '孙佳乐', 'PB2'),
    ]);

    expect(await soldOf(outbound.id)).toBe(4);
    expect(await soldOf(ret.id)).toBe(4);
    const moneyA0 = await moneySnapshot(orderA.id);
    const totalB0 = Number((await prisma.order.findUniqueOrThrow({ where: { id: orderB.id } })).total);

    // 去程改到 3 天前（no-show 的前提是「去程真的飞了」；建单时班次必须是未来的）。
    await prisma.flightSchedule.update({
      where: { id: outbound.id },
      data: { departureTime: new Date(Date.now() - 3 * 24 * 3600_000) },
    });

    // ── ① 贴名单预检 ────────────────────────────────────────────────────
    const paxB1 = orderB.passengers.find((p) => p.fullName === 'ZHAO/MING')!;
    const names = [
      '陈志远', // 中文名
      'XIAOMEI LIN', // 英文名「名 姓」顺序
      paxB1.documentNumber, // 护照号
      '某位不在本班的客人', // 匹配不上
    ].join('\n');

    const preview = await previewNoShowBatch({ service }, { scheduleId: outbound.id, names }, actor);
    expect(preview.schedule.departed).toBe(true);
    expect(preview.schedule.seatsSold).toBe(4);
    expect(preview.unmatched).toEqual(['某位不在本班的客人']);
    expect(preview.ambiguous).toEqual([]);
    expect(preview.matched).toHaveLength(3);

    const rowsA = preview.matched.filter((m) => m.orderId === orderA.id);
    const rowsB = preview.matched.filter((m) => m.orderId === orderB.id);
    expect(rowsA).toHaveLength(2);
    expect(rowsA.every((r) => r.eligible && r.scope === 'WHOLE')).toBe(true);
    expect(rowsA.every((r) => r.hasReturn && !r.returnDeparted)).toBe(true);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].eligible).toBe(true);
    expect(rowsB[0].scope).toBe('SPLIT_REQUIRED'); // 只点到 1/2 人 → 会先拆单
    expect(rowsB[0].matchedBy).toBe('DOCUMENT');
    // 对外只给证件号后 4 位。
    expect(rowsB[0].documentTail).toBe(paxB1.documentNumber.slice(-4));
    // 从库里读出来的证件号一个字符都不许出圈：单 A 两位的证件号从没出现在贴进来的名单里，
    // 响应里也就不该出现。（单 B 那位的完整号码之所以在响应里，是因为它就是操作员**自己贴的
    // 那一行原文** —— 原文必须原样回显给票务核对，那不是我们泄露的数据。）
    const serialized = JSON.stringify(preview);
    for (const p of orderA.passengers) {
      expect(serialized).not.toContain(p.documentNumber);
    }

    // ── ② 整批执行 ──────────────────────────────────────────────────────
    const entries = [
      { orderId: orderA.id, passengerIds: rowsA.map((r) => r.passengerId) },
      { orderId: orderB.id, passengerIds: [rowsB[0].passengerId] },
    ];
    const result = await executeNoShowBatch(
      { service },
      {
        requestToken: BATCH_TOKEN,
        scheduleId: outbound.id,
        entries,
        releaseReturn: true,
        note: '航司名单',
      },
      actor,
    );

    expect(result.summary).toEqual({ ok: 2, failed: 0, releasedSeats: 3, replayedCount: 0 });
    const resA = result.results.find((r) => r.orderId === orderA.id)!;
    const resB = result.results.find((r) => r.orderId === orderB.id)!;
    expect(resA).toMatchObject({ ok: true, releasedSeats: 2 });
    expect(resA.targetOrderNumber).toBe(orderA.orderNumber); // 整单：没有拆
    expect(resB).toMatchObject({ ok: true, releasedSeats: 1 });
    expect(resB.targetOrderNumber).not.toBe(orderB.orderNumber); // 部分乘客：拆出新单

    // 座位账：回程 4 → 1（A 放 2、B 拆出的那位放 1，留守那位分毫不动）；去程一座不动。
    expect(await soldOf(ret.id)).toBe(1);
    expect(await soldOf(outbound.id)).toBe(4);

    // 单 A：去程行被打了 no-show 标、回程行班次被置空。
    const itemsA = await prisma.orderItem.findMany({
      where: { orderId: orderA.id, kind: OrderItemKind.FLIGHT },
    });
    const outA = itemsA.find((i) => i.flightScheduleId === outbound.id)!;
    expect((outA.metadata as Record<string, unknown>).noShow).toBeTruthy();
    expect(itemsA.some((i) => i.flightScheduleId == null)).toBe(true);

    // 拆出来的新单：1 人、去程带标。
    const splitOrder = await prisma.order.findFirstOrThrow({
      where: { orderNumber: resB.targetOrderNumber! },
      include: { passengers: true, items: true },
    });
    expect(splitOrder.passengers).toHaveLength(1);
    expect(splitOrder.passengers[0].id).toBe(rowsB[0].passengerId);
    const splitOut = splitOrder.items.find(
      (i) => i.kind === OrderItemKind.FLIGHT && i.flightScheduleId === outbound.id,
    )!;
    expect((splitOut.metadata as Record<string, unknown>).noShow).toBeTruthy();

    // 源单 B 留守那位没被碰：还剩 1 人、去程没有 no-show 标。
    const remainB = await prisma.order.findUniqueOrThrow({
      where: { id: orderB.id },
      include: { passengers: true, items: true },
    });
    expect(remainB.passengers).toHaveLength(1);
    const remainOut = remainB.items.find(
      (i) => i.kind === OrderItemKind.FLIGHT && i.flightScheduleId === outbound.id,
    )!;
    expect((remainOut.metadata as Record<string, unknown> | null)?.noShow).toBeUndefined();

    // ── ③ 整批重试（同一个 requestToken）→ 逐单回放，座位一座不动 ──────────
    const replay = await executeNoShowBatch(
      { service },
      {
        requestToken: BATCH_TOKEN,
        scheduleId: outbound.id,
        entries,
        releaseReturn: true,
        note: '航司名单',
      },
      actor,
    );
    expect(replay.summary.ok).toBe(2);
    expect(await soldOf(ret.id)).toBe(1);
    expect(await soldOf(outbound.id)).toBe(4);

    // ── ④ 钱：整单那张逐字不变；拆单那张两侧合计守恒 ────────────────────
    expect(await moneySnapshot(orderA.id)).toEqual(moneyA0);
    const after = await prisma.order.findMany({
      where: { id: { in: [orderB.id, splitOrder.id] } },
      select: { total: true },
    });
    expect(after.reduce((n, o) => n + Number(o.total), 0)).toBeCloseTo(totalB0, 2);
  });

  it('该单去程不在本班次 → SCHEDULE_MISMATCH，绝不动它的座位', async () => {
    const actor = await adminActor();
    const requester = await staffRequester();
    const outbound = await createSchedule(48);
    const ret = await createSchedule(24 * 10);
    const order = await createRoundTripOrder(requester, outbound.id, ret.id, [
      passenger('WANG/XIAOHU', '王小虎', 'PC1'),
    ]);
    await prisma.flightSchedule.update({
      where: { id: outbound.id },
      data: { departureTime: new Date(Date.now() - 3 * 24 * 3600_000) },
    });

    const soldBefore = await soldOf(ret.id);
    const result = await executeNoShowBatch(
      { service },
      {
        requestToken: BATCH_TOKEN,
        // 贴的是回程那一班：这单的去程是 outbound，不该被这一批处理。
        scheduleId: ret.id,
        entries: [{ orderId: order.id, passengerIds: [order.passengers[0].id] }],
        releaseReturn: true,
      },
      actor,
    );
    expect(result.results[0]).toMatchObject({ ok: false, code: 'SCHEDULE_MISMATCH' });
    expect(await soldOf(ret.id)).toBe(soldBefore);
  });
});
