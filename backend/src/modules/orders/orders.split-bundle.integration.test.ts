/**
 * 套餐单拆单（split PNR · BUNDLE）· **真 DB** 集成测试
 *
 * 为什么非得走真库：套餐单拆分的正确性全在「派生账」上 —— Σ total / Σ paid / Σ 成本 /
 * Σ 房数 / 逐班次 Σ 座位 / 逐班次 Σ 升舱位 / Σ 佣金，七条守恒同时成立才算拆对。
 * mock 版里这些数字都是常量，「劈错了」和「劈对了」长得一模一样。
 *
 * 夹具为什么直接用 prisma 建而不走 createOrder：createOrder 会按套餐产品**服务端重算**金额，
 * 房数与加项随房型容量浮动，断言就只能写成「大于 0」。这里要的恰恰是逐分逐半间的精确对比，
 * 所以订单行按下单后的落库形状直接铺好；班次与舱位仍是真的（no-show 释放走的是真座位账）。
 *
 * 覆盖：
 *   1. 3 人套餐往返单（1 人单住 + 2 人拼房、去程 1 人升舱、含同业立减与已计提佣金）
 *      拆出拼房中的 1 位 → 七条守恒 + addOns 人数按乘客现势重建 + 房组劈成两个半组。
 *   2. 锁跟随 / 售后费分摊 / 佣金进结算后拒拆 / 待确认改档申请拒拆。
 *   3. 拆完之后两侧各自改档：都不报错，且按**各自的人数**算（addOns 抄错人数在这里必炸）。
 *   4. markNoShow 只标部分乘客 → 自动拆单 + 对新单标记 + 释放回程座位（座位账守恒）。
 *
 * 跑：
 *   1. docker compose -f ../docker-compose.test.yml up -d
 *   2. npx vitest run -c vitest.integration.config.ts src/modules/orders/orders.split-bundle.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  CabinClass,
  CommissionStatus,
  DocumentType,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  Prisma,
  ProductKind,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from './orders.service.js';

const service = new OrderService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** requestToken 必须是 uuid：拼一个固定形状、按 tag 区分的 v4。 */
function token(tag: string): string {
  return `00000000-0000-4000-8000-0000000${tag.padStart(5, '0')}`;
}

async function adminActor(): Promise<{ userId: string; role: UserRole }> {
  const u = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: u.id, role: UserRole.ADMIN };
}

/** 建一个班次（含 ECONOMY + BUSINESS 两个舱位，供升舱拆座使用）。 */
async function createSchedule(opts: {
  hoursFromNow: number;
  economySold?: number;
  businessSold?: number;
}) {
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `T${Math.floor(Math.random() * 1000000)}`,
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
        create: [
          {
            cabin: CabinClass.ECONOMY,
            capacity: 50,
            sold: opts.economySold ?? 0,
            basePrice: new Prisma.Decimal(1000),
          },
          {
            cabin: CabinClass.BUSINESS,
            capacity: 10,
            sold: opts.businessSold ?? 0,
            basePrice: new Prisma.Decimal(3000),
          },
        ],
      },
    },
    include: { seatClasses: true },
  });
}

async function soldOf(scheduleId: string, cabin: CabinClass): Promise<number> {
  const sc = await prisma.flightSeatClass.findFirstOrThrow({ where: { scheduleId, cabin } });
  return sc.sold;
}

/**
 * 未落位的随机档占位酒店 + 房型。
 * 挂占位酒店（randomTierPlaceholder 非空）= 业务上「还没落位」→ 改档不会被「已落位」闸拦住，
 * 同时 hotelRoomTypeId 非空，房控仍按 (房型, 区间, roomsBilled) 计占房 —— 正是要测的那条路。
 */
async function createPlaceholderRoomType() {
  const hotel = await prisma.hotel.create({
    data: {
      name: uniq('RandomTierHotel'),
      cityCode: 'DAD',
      address: 'Test address',
      starRating: 4,
      randomTierPlaceholder: 4,
      isActive: true,
    },
  });
  return prisma.hotelRoomType.create({
    data: {
      hotelId: hotel.id,
      name: uniq('Deluxe'),
      capacity: 3,
      maxAdults: 2,
      maxChildren: 1,
      basePrice: new Prisma.Decimal(600),
    },
  });
}

/** 建一个套餐产品（地面价来自 HOTEL 组件；费率显式给全，避免默认值漂移影响断言）。 */
async function createBundle(opts: {
  nights: number;
  hotelRoomTypeId: string | null;
  unitPriceCny: number;
}) {
  return prisma.bundle.create({
    data: {
      name: uniq('Bundle'),
      items: [
        { kind: 'HOTEL', productName: '酒店', qty: opts.nights, unitPrice: opts.unitPriceCny },
      ] as Prisma.InputJsonValue,
      groundDiscount: new Prisma.Decimal(0),
      discountPct: 0,
      hotelRoomTypeId: opts.hotelRoomTypeId,
      hotelNights: opts.nights,
      operationFeeCny: 20,
      singleSupplementCnyPerNight: 300,
      businessUpgradeCnyPerLeg: 800,
      childSeatDiscountCnyPerPerson: 500,
      infantPriceCny: 0,
      selfVisaDeductCny: 400,
      legs: 2,
      isActive: true,
    },
  });
}

function passengerData(i: number, over: Record<string, unknown> = {}) {
  return {
    fullName: `WANG XIAO ${i}`,
    documentType: DocumentType.PASSPORT,
    documentNumber: uniq(`P${i}`),
    dateOfBirth: new Date('1990-01-01'),
    nationality: 'CN',
    passengerType: PassengerType.ADULT,
    passportExpiry: new Date('2031-01-01'),
    ...over,
  };
}

/** 下单时落库的 addOns 快照（3 人全成人：1 人单住 4 晚、1 人去程升舱）。 */
const ADD_ONS_3PAX = {
  singleCount: 1,
  businessCount: 1,
  businessCountOutbound: 1,
  businessCountReturn: 0,
  adultCount: 3,
  childCount: 0,
  infantCount: 0,
  seatPax: 3,
  headCount: 3,
  rooms: 2,
  nights: 4,
  legs: 2,
  singleSupplementCnyPerNight: 300,
  businessUpgradeCnyPerLeg: 800,
  childSeatDiscountCnyPerPerson: 500,
  infantPriceCny: 0,
  selfProvidedVisaCount: 0,
  selfProvidedVisa: false,
  selfVisaDeductCny: 400,
  singleSupplementTotal: 1200,
  businessUpgradeTotal: 800,
  childSeatDiscountTotal: 0,
  infantPriceTotal: 0,
  selfVisaDeductTotal: 0,
  total: 2000,
};

/**
 * 3 人套餐往返单：
 *   · BUNDLE 行 ¥30000 / 成本 ¥21000 / 2 间（p1 单住 1 间 + p2p3 拼 1 间）/ 4 晚，挂随机档占位房型；
 *   · 去程 FLIGHT 3 座（其中 1 人升商务：BUSINESS sold 1 + ECONOMY sold 2）+ 回程 FLIGHT 3 座；
 *   · 同业立减 ¥100/人 × 3 人。应收 = 30000 − 300 = 29700，已全额收款。
 */
async function createBundleOrder(opts: { withUpgrade?: boolean } = {}) {
  const withUpgrade = opts.withUpgrade ?? true;
  const roomType = await createPlaceholderRoomType();
  const bundle = await createBundle({ nights: 4, hotelRoomTypeId: roomType.id, unitPriceCny: 600 });
  const outbound = await createSchedule({
    hoursFromNow: 48,
    economySold: withUpgrade ? 2 : 3,
    businessSold: withUpgrade ? 1 : 0,
  });
  const ret = await createSchedule({ hoursFromNow: 24 * 10, economySold: 3 });

  const order = await prisma.order.create({
    data: {
      orderNumber: uniq('TEST-SPLITB'),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(29700),
      total: new Prisma.Decimal(29700),
      paidAmount: new Prisma.Decimal(29700),
      contactName: 'BUNDLE SPLIT E2E',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.BUNDLE,
            description: '海岛 5 日套餐',
            quantity: 1,
            unitPrice: new Prisma.Decimal(28000),
            amount: new Prisma.Decimal(30000),
            unitCostCny: new Prisma.Decimal(21000),
            totalCostCny: new Prisma.Decimal(21000),
            bundleId: bundle.id,
            hotelRoomTypeId: roomType.id,
            hotelCheckIn: new Date('2026-11-01'),
            hotelCheckOut: new Date('2026-11-05'),
            roomsBilled: new Prisma.Decimal(2),
            metadata: {
              roomsNeeded: 2,
              addOns: ADD_ONS_3PAX,
              operationFee: { perPaxCny: 20, pax: 3, totalCny: 60 },
              visaListSnapshotCny: 900,
            } as Prisma.InputJsonValue,
          },
          {
            kind: OrderItemKind.FLIGHT,
            description: '去程（经济舱）',
            quantity: 3,
            unitPrice: new Prisma.Decimal(0),
            amount: new Prisma.Decimal(0),
            totalCostCny: new Prisma.Decimal(1800),
            flightScheduleId: outbound.id,
            flightCabin: CabinClass.ECONOMY,
            metadata: (withUpgrade ? { businessUpgradeCount: 1 } : {}) as Prisma.InputJsonValue,
          },
          {
            kind: OrderItemKind.FLIGHT,
            description: '回程（经济舱）',
            quantity: 3,
            unitPrice: new Prisma.Decimal(0),
            amount: new Prisma.Decimal(0),
            totalCostCny: new Prisma.Decimal(1200),
            flightScheduleId: ret.id,
            flightCabin: CabinClass.ECONOMY,
          },
          {
            kind: OrderItemKind.DISCOUNT,
            description: '同业立减 ¥100/人 × 3人',
            quantity: 1,
            unitPrice: new Prisma.Decimal(-300),
            amount: new Prisma.Decimal(-300),
            totalCostCny: new Prisma.Decimal(0),
            metadata: {
              priceAdjustment: true,
              reasonCode: 'DISCOUNT',
              settlementDiscount: true,
              discountPerPersonCny: 100,
              pax: 3,
            } as Prisma.InputJsonValue,
          },
        ],
      },
      passengers: {
        create: [passengerData(1, { singleRoom: true }), passengerData(2), passengerData(3)],
      },
    },
    include: { items: true, passengers: true },
  });

  // 分房表：g1 = p1 单住整间；g2 = p2 + p3 拼一间（两组都挂在套餐住宿行上）。
  const bundleItem = order.items.find((it) => it.kind === OrderItemKind.BUNDLE)!;
  const [p1, p2, p3] = order.passengers;
  await prisma.order.update({
    where: { id: order.id },
    data: {
      roomAssignment: {
        roomGroups: [
          {
            id: 'g1',
            hotelName: '随机四星',
            roomType: '大床房',
            passengerIds: [p1.id],
            roomFraction: 1,
            orderItemId: bundleItem.id,
          },
          {
            id: 'g2',
            hotelName: '随机四星',
            roomType: '双床房',
            passengerIds: [p2.id, p3.id],
            roomFraction: 1,
            orderItemId: bundleItem.id,
          },
        ],
      } as Prisma.InputJsonValue,
    },
  });

  return { order, bundle, roomType, outbound, ret, bundleItem, p1, p2, p3 };
}

/** 给订单挂一条已计提（未进结算）的佣金记录。 */
async function accrueCommission(orderId: string, amountCny: number) {
  const agentUser = await prisma.user.create({
    data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT },
  });
  const agent = await prisma.agent.create({
    data: {
      userId: agentUser.id,
      companyName: uniq('Agent'),
      contactName: '联系人',
      contactPhone: '13900139000',
      isActive: true,
    },
  });
  await prisma.order.update({ where: { id: orderId }, data: { agentId: agent.id } });
  return prisma.commissionRecord.create({
    data: {
      agentId: agent.id,
      orderId,
      productKind: ProductKind.BUNDLE,
      baseAmount: new Prisma.Decimal(29700),
      rate: new Prisma.Decimal(0.05),
      amount: new Prisma.Decimal(amountCny),
      status: CommissionStatus.ACCRUED,
      chainDepth: 0,
    },
  });
}

/** 两单合起来的派生账（守恒断言的观测口径）。 */
async function ledgerOf(orderIds: string[]) {
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    include: { items: true },
  });
  const items = orders.flatMap((o) => o.items);
  const half = (v: Prisma.Decimal | null) => (v == null ? 0 : Math.round(Number(v) * 2));
  return {
    total: orders.reduce((s, o) => s + Number(o.total), 0),
    paid: orders.reduce((s, o) => s + Number(o.paidAmount), 0),
    adjustment: orders.reduce((s, o) => s + o.adjustmentCny, 0),
    costCents: items.reduce(
      (s, it) => s + (it.totalCostCny == null ? 0 : Math.round(Number(it.totalCostCny) * 100)),
      0,
    ),
    roomsHalf: items.reduce((s, it) => s + half(it.roomsBilled), 0),
    seats: items
      .filter((it) => it.kind === OrderItemKind.FLIGHT)
      .reduce((s, it) => s + it.quantity, 0),
    upgrades: items
      .filter((it) => it.kind === OrderItemKind.FLIGHT)
      .reduce(
        (s, it) =>
          s +
          Number((it.metadata as { businessUpgradeCount?: number })?.businessUpgradeCount ?? 0),
        0,
      ),
  };
}

// ══════════════════════════════════════════════════════════════════════════
describe('套餐单拆单 · 七条守恒（真 DB）', () => {
  it('3 人套餐单拆出拼房中的 1 位：total/paid/成本/房数/座位/升舱/佣金全部守恒', async () => {
    const actor = await adminActor();
    const { order, p2 } = await createBundleOrder();
    await accrueCommission(order.id, 1485);
    const before = await ledgerOf([order.id]);

    // 预检：套餐住宿行带「套餐住宿 ·」前缀 + 建议间数；升舱行回显；房组冲突需自动劈半
    const preview = await service.previewOrderSplit(
      order.id,
      { passengerIds: [p2.id], autoSplitRoomGroups: true },
      actor,
    );
    expect(preview.eligible).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.roomGroupConflict).toBe(true);
    expect(preview.commission).toEqual({ mode: 'SPLIT', amountCny: 1485, reversalCny: 0 });
    const stay = preview.hotelItems.find((h) => h.isBundleStay)!;
    expect(stay.description.startsWith('套餐住宿 · ')).toBe(true);
    expect(stay.suggestedRoomsToMove).toBe(0.5);
    expect(preview.upgradeItems).toEqual([
      expect.objectContaining({ leg: 'OUTBOUND', businessUpgradeCount: 1, suggestedToMove: 0 }),
    ]);

    const result = await service.splitOrder(
      order.id,
      { passengerIds: [p2.id], requestToken: token('b1'), autoSplitRoomGroups: true },
      actor,
    );
    expect(result.replayed).toBe(false);
    expect(result.movedShareCny).toBe(9900); // 29700 / 3

    const after = await ledgerOf([order.id, result.targetOrderId]);
    expect(after.total).toBe(before.total);
    expect(after.paid).toBe(before.paid);
    expect(after.adjustment).toBe(before.adjustment);
    expect(after.costCents).toBe(before.costCents);
    expect(after.roomsHalf).toBe(before.roomsHalf);
    expect(after.seats).toBe(before.seats);
    expect(after.upgrades).toBe(before.upgrades);

    const commissionAfter = await prisma.commissionRecord.findMany({
      where: { orderId: { in: [order.id, result.targetOrderId] } },
    });
    expect(commissionAfter).toHaveLength(2);
    expect(commissionAfter.reduce((s, c) => s + Number(c.amount), 0)).toBe(1485);
    // 费率与链深不因拆单变（佣金是与代理谈定的）
    expect(commissionAfter.every((c) => Number(c.rate) === 0.05 && c.chainDepth === 0)).toBe(true);

    // 两侧各自的钱：新单 9900、源单 19800
    const [src, tgt] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } }),
      prisma.order.findUniqueOrThrow({
        where: { id: result.targetOrderId },
        include: { items: true, passengers: true },
      }),
    ]);
    expect(Number(tgt.total)).toBe(9900);
    expect(Number(src.total)).toBe(19800);
    expect(tgt.passengers).toHaveLength(1);
    expect(tgt.passengers[0].id).toBe(p2.id);

    // 套餐行：两侧各一条，金额 1:2 劈开，bundleId 跟着走（既有 bug：此前新行不复制 bundleId）
    const srcBundle = src.items.find((it) => it.kind === OrderItemKind.BUNDLE)!;
    const tgtBundle = tgt.items.find((it) => it.kind === OrderItemKind.BUNDLE)!;
    expect(Number(tgtBundle.amount)).toBe(10000);
    expect(Number(srcBundle.amount)).toBe(20000);
    expect(tgtBundle.bundleId).toBe(srcBundle.bundleId);
    expect(tgtBundle.quantity).toBe(1);
    expect(tgtBundle.hotelRoomTypeId).toBe(srcBundle.hotelRoomTypeId);
    expect(Number(tgtBundle.roomsBilled)).toBe(0.5);
    expect(Number(srcBundle.roomsBilled)).toBe(1.5);

    // addOns 按乘客现势重建：拆出侧 1 人（无单住、无升舱），留守侧 2 人（1 单住 + 1 升舱）
    const tgtAddOns = (tgtBundle.metadata as { addOns: Record<string, number> }).addOns;
    const srcAddOns = (srcBundle.metadata as { addOns: Record<string, number> }).addOns;
    expect(tgtAddOns).toMatchObject({
      adultCount: 1,
      seatPax: 1,
      headCount: 1,
      singleCount: 0,
      businessCountOutbound: 0,
      singleSupplementTotal: 0,
      businessUpgradeTotal: 0,
    });
    expect(srcAddOns).toMatchObject({
      adultCount: 2,
      seatPax: 2,
      headCount: 2,
      singleCount: 1,
      businessCountOutbound: 1,
      singleSupplementTotal: 1200,
      businessUpgradeTotal: 800,
    });
    // 操作费按份额缩放 Σ 恒等；签证挂牌价快照是每人口径，两侧原样继承（不切半）
    const tgtMeta = tgtBundle.metadata as {
      operationFee: { totalCny: number };
      visaListSnapshotCny: number;
    };
    const srcMeta = srcBundle.metadata as {
      operationFee: { totalCny: number };
      visaListSnapshotCny: number;
    };
    expect(tgtMeta.operationFee.totalCny + srcMeta.operationFee.totalCny).toBe(60);
    expect(tgtMeta.visaListSnapshotCny).toBe(900);
    expect(srcMeta.visaListSnapshotCny).toBe(900);

    // 立减行按人数拆两行
    const isDiscountRow = (it: { kind: OrderItemKind; metadata: unknown }) =>
      it.kind === OrderItemKind.DISCOUNT &&
      (it.metadata as { settlementDiscount?: boolean })?.settlementDiscount === true;
    const tgtDiscount = tgt.items.find(isDiscountRow)!;
    const srcDiscount = src.items.find(isDiscountRow)!;
    expect(Number(tgtDiscount.amount)).toBe(-100);
    expect(Number(srcDiscount.amount)).toBe(-200);
    expect(tgtDiscount.description).toBe('同业立减 ¥100/人 × 1人');

    // 升舱位留在源单（拆走的那位没升舱）
    const srcOut = src.items.find(
      (it) => it.kind === OrderItemKind.FLIGHT && it.description.includes('去程'),
    )!;
    const tgtOut = tgt.items.find(
      (it) => it.kind === OrderItemKind.FLIGHT && it.description.includes('去程'),
    )!;
    expect((srcOut.metadata as { businessUpgradeCount: number }).businessUpgradeCount).toBe(1);
    expect((tgtOut.metadata as { businessUpgradeCount: number }).businessUpgradeCount).toBe(0);

    // 房组：混合组 g2 被劈成两个半组，源单留 g1(1 间) + g2 半间，新单拿走另外半间
    const srcGroups = (src.roomAssignment as { roomGroups: Array<Record<string, unknown>> })
      .roomGroups;
    const tgtGroups = (tgt.roomAssignment as { roomGroups: Array<Record<string, unknown>> })
      .roomGroups;
    expect(srcGroups).toHaveLength(2);
    expect(tgtGroups).toHaveLength(1);
    expect(tgtGroups[0].passengerIds).toEqual([p2.id]);
    expect(Number(tgtGroups[0].roomFraction)).toBe(0.5);
    // 拆出的那一组重新挂到新单的套餐行上（不再指向源单的行）
    expect(tgtGroups[0].orderItemId).toBe(tgtBundle.id);
    const srcFractionSum = srcGroups.reduce((s, g) => s + Number(g.roomFraction ?? 1), 0);
    expect(srcFractionSum + Number(tgtGroups[0].roomFraction)).toBe(2);
  });

  it('两把锁跟随到新单（不写就是静默解锁）', async () => {
    const actor = await adminActor();
    const { order, p2 } = await createBundleOrder();
    const lockedAt = new Date('2026-09-01T02:00:00.000Z');
    await prisma.order.update({
      where: { id: order.id },
      data: {
        settlementLocked: true,
        settlementLockedAt: lockedAt,
        settlementLockedBy: actor.userId,
        paymentsLocked: true,
        paymentsLockedAt: lockedAt,
        paymentsLockedBy: actor.userId,
      },
    });

    const result = await service.splitOrder(
      order.id,
      { passengerIds: [p2.id], requestToken: token('b2'), autoSplitRoomGroups: true },
      actor,
    );
    const tgt = await prisma.order.findUniqueOrThrow({ where: { id: result.targetOrderId } });
    expect(tgt.settlementLocked).toBe(true);
    expect(tgt.paymentsLocked).toBe(true);
    expect(tgt.settlementLockedAt?.toISOString()).toBe(lockedAt.toISOString());
    expect(tgt.paymentsLockedBy).toBe(actor.userId);
  });

  it('售后费按份额分摊：Σ adjustmentCny 与 Σ 应收都不变', async () => {
    const actor = await adminActor();
    const { order, p2 } = await createBundleOrder();
    await prisma.order.update({ where: { id: order.id }, data: { adjustmentCny: 300 } });

    const result = await service.splitOrder(
      order.id,
      { passengerIds: [p2.id], requestToken: token('b3'), autoSplitRoomGroups: true },
      actor,
    );
    const [src, tgt] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      prisma.order.findUniqueOrThrow({ where: { id: result.targetOrderId } }),
    ]);
    expect(src.adjustmentCny + tgt.adjustmentCny).toBe(300);
    // 应收 = total + adjustmentCny：拆前 29700 + 300 = 30000，拆后两侧合计不变
    expect(Number(src.total) + src.adjustmentCny + Number(tgt.total) + tgt.adjustmentCny).toBe(
      30000,
    );
    // 售后费不会被算两遍（新单 total 已经把随拆的那份摘出去了）
    expect(Number(tgt.total) + tgt.adjustmentCny).toBe(10000);
  });

  it('佣金已进结算流程 → 拒拆，文案指向财务', async () => {
    const actor = await adminActor();
    const { order, p2 } = await createBundleOrder();
    const commission = await accrueCommission(order.id, 1485);
    await prisma.commissionRecord.update({
      where: { id: commission.id },
      data: { status: CommissionStatus.SETTLEMENT_REQUESTED },
    });

    const preview = await service.previewOrderSplit(order.id, { passengerIds: [p2.id] }, actor);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers.join()).toContain('本单佣金已进结算流程，请财务先处理后再拆');
    await expect(
      service.splitOrder(
        order.id,
        { passengerIds: [p2.id], requestToken: token('b4'), autoSplitRoomGroups: true },
        actor,
      ),
    ).rejects.toThrow(/佣金已进结算流程/);
  });

  it('有待确认的套餐改档申请 → 拒拆', async () => {
    const actor = await adminActor();
    const { order, bundle, p2 } = await createBundleOrder();
    await prisma.bundleChangeRequest.create({
      data: {
        orderId: order.id,
        requestedById: actor.userId,
        fromBundleId: bundle.id,
        fromBundleName: bundle.name,
        toBundleId: bundle.id,
        toBundleName: '目标套餐',
      },
    });
    const preview = await service.previewOrderSplit(order.id, { passengerIds: [p2.id] }, actor);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers.join()).toContain('待确认的套餐改档申请');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 婴儿不占座：机票行的 quantity 是**占座数**（2 大 1 婴 → 2 座），拿人头数（3）去比会把
// 「拆 1 大 + 1 婴」判成整行搬走 —— 留守那位大人的座位跟着被搬到新单，源单一条航段行都不剩。
describe('含婴儿的单拆单 · 机票行按占座数劈（真 DB）', () => {
  /** 2 成人 + 1 婴儿：机票行 2 座，套餐行 headCount 3 / seatPax 2。 */
  async function createInfantOrder() {
    const outbound = await createSchedule({ hoursFromNow: 48, economySold: 2 });
    const ret = await createSchedule({ hoursFromNow: 24 * 10, economySold: 2 });
    const order = await prisma.order.create({
      data: {
        orderNumber: uniq('TEST-SPLITI'),
        status: OrderStatus.PAID,
        subtotal: new Prisma.Decimal(20000),
        total: new Prisma.Decimal(20000),
        paidAmount: new Prisma.Decimal(20000),
        contactName: 'INFANT SPLIT E2E',
        contactPhone: '13800138000',
        items: {
          create: [
            {
              kind: OrderItemKind.FLIGHT,
              description: '去程（经济舱）',
              quantity: 2,
              unitPrice: new Prisma.Decimal(5000),
              amount: new Prisma.Decimal(10000),
              totalCostCny: new Prisma.Decimal(1200),
              flightScheduleId: outbound.id,
              flightCabin: CabinClass.ECONOMY,
            },
            {
              kind: OrderItemKind.FLIGHT,
              description: '回程（经济舱）',
              quantity: 2,
              unitPrice: new Prisma.Decimal(5000),
              amount: new Prisma.Decimal(10000),
              totalCostCny: new Prisma.Decimal(1200),
              flightScheduleId: ret.id,
              flightCabin: CabinClass.ECONOMY,
            },
          ],
        },
        passengers: {
          create: [
            passengerData(1),
            passengerData(2),
            passengerData(3, {
              passengerType: PassengerType.INFANT,
              dateOfBirth: new Date('2026-01-01'),
            }),
          ],
        },
      },
      include: { items: true, passengers: true },
    });
    const [p1, p2, infant] = order.passengers;
    return { order, outbound, ret, p1, p2, infant };
  }

  it('拆「大人 A + 婴儿」：两侧各留 1 座，绝不整行搬走', async () => {
    const actor = await adminActor();
    const { order, p1, infant } = await createInfantOrder();
    const before = await ledgerOf([order.id]);

    const res = await service.splitOrder(
      order.id,
      { passengerIds: [p1.id, infant.id], requestToken: token('e1') },
      actor,
    );

    const src = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, passengers: true },
    });
    const tgt = await prisma.order.findUniqueOrThrow({
      where: { id: res.targetOrderId },
      include: { items: true, passengers: true },
    });

    const seatsOf = (items: Array<{ kind: OrderItemKind; quantity: number }>) =>
      items.filter((it) => it.kind === OrderItemKind.FLIGHT).reduce((n, it) => n + it.quantity, 0);
    // 去程 + 回程各劈成 1/1：两侧各 2 座（一去一回），合计仍是 4。
    expect(seatsOf(src.items)).toBe(2);
    expect(seatsOf(tgt.items)).toBe(2);
    // 婴儿跟着走，人头 2 / 1。
    expect(tgt.passengers).toHaveLength(2);
    expect(src.passengers).toHaveLength(1);

    // 座位与钱守恒。
    const after = await ledgerOf([order.id, res.targetOrderId]);
    expect(after.seats).toBe(before.seats);
    expect(after.total).toBe(before.total);
    expect(after.paid).toBe(before.paid);
    expect(after.costCents).toBe(before.costCents);
  });

  it('只拆婴儿：机票行一座不搬，源单座位分毫不动', async () => {
    const actor = await adminActor();
    const { order, infant } = await createInfantOrder();
    const before = await ledgerOf([order.id]);

    const res = await service.splitOrder(
      order.id,
      { passengerIds: [infant.id], requestToken: token('e2') },
      actor,
    );

    const src = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    const tgt = await prisma.order.findUniqueOrThrow({
      where: { id: res.targetOrderId },
      include: { items: true, passengers: true },
    });
    const seatsOf = (items: Array<{ kind: OrderItemKind; quantity: number }>) =>
      items.filter((it) => it.kind === OrderItemKind.FLIGHT).reduce((n, it) => n + it.quantity, 0);
    expect(seatsOf(src.items)).toBe(4); // 去 2 + 回 2，一座没动
    expect(seatsOf(tgt.items)).toBe(0); // 婴儿不占座 → 新单没有航段行
    expect(tgt.passengers).toHaveLength(1);

    const after = await ledgerOf([order.id, res.targetOrderId]);
    expect(after.seats).toBe(before.seats);
    expect(after.total).toBe(before.total);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('套餐单拆完之后改档 · 两侧各按各自人数算', () => {
  it('源单（2 人）与新单（1 人）都能改档，且新档金额随各自人数不同', async () => {
    const actor = await adminActor();
    const { order, roomType, p2 } = await createBundleOrder();
    const targetBundle = await createBundle({
      nights: 4,
      hotelRoomTypeId: roomType.id,
      unitPriceCny: 900, // 比原档贵
    });

    const result = await service.splitOrder(
      order.id,
      { passengerIds: [p2.id], requestToken: token('c1'), autoSplitRoomGroups: true },
      actor,
    );

    // 两侧各改一次档：都不报错（addOns 抄错人数时这里会按 3 人算钱，两侧金额会一模一样）
    const srcChanged = await service.changeOrderBundle(
      order.id,
      { bundleId: targetBundle.id, note: '拆后改档（留守 2 人）' },
      actor,
    );
    const tgtChanged = await service.changeOrderBundle(
      result.targetOrderId,
      { bundleId: targetBundle.id, note: '拆后改档（拆出 1 人）' },
      actor,
    );

    const srcAfter = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id, kind: OrderItemKind.BUNDLE },
    });
    const tgtAfter = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: result.targetOrderId, kind: OrderItemKind.BUNDLE },
    });
    // 改档按各自人数重算 addOns：留守 2 人（含 1 单住 + 1 升舱）、拆出 1 人（都没有）
    const srcAddOns = (srcAfter.metadata as { addOns: Record<string, number> }).addOns;
    const tgtAddOns = (tgtAfter.metadata as { addOns: Record<string, number> }).addOns;
    expect(srcAddOns.seatPax).toBe(2);
    expect(srcAddOns.singleCount).toBe(1);
    expect(srcAddOns.businessCountOutbound).toBe(1);
    expect(tgtAddOns.seatPax).toBe(1);
    expect(tgtAddOns.singleCount).toBe(0);
    expect(tgtAddOns.businessCountOutbound).toBe(0);
    // 两侧改档后的应收不可能相同（人数不同 → 房数与加项都不同）
    expect(srcChanged.audit.after.total).not.toBe(tgtChanged.audit.after.total);
    // 改档后仍各自只有一条套餐行（拆出的新行没有变成第二条 BUNDLE 行）
    const tgtBundleRows = await prisma.orderItem.count({
      where: { orderId: result.targetOrderId, kind: OrderItemKind.BUNDLE },
    });
    expect(tgtBundleRows).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('no-show 只标部分乘客 · 拆 + 标 + 释放（真 DB）', () => {
  it('套餐单里 1 位没登机：自动拆出新单、对新单打标、回程该释放的座位真的放回库存', async () => {
    const actor = await adminActor();
    const { order, outbound, ret, p2 } = await createBundleOrder({ withUpgrade: false });
    // no-show 的前提是去程真的飞了 —— 建完再把去程班次改到过去。
    await prisma.flightSchedule.update({
      where: { id: outbound.id },
      data: { departureTime: new Date(Date.now() - 3 * 24 * 3600_000) },
    });

    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(3);
    const before = await ledgerOf([order.id]);

    const res = await service.markNoShow(
      order.id,
      { passengerIds: [p2.id], requestToken: token('d1'), releaseReturn: true },
      actor,
    );

    // 拆出了一张新单，标记打在新单上
    expect(res.targetOrderId).not.toBe(order.id);
    const tgt = await prisma.order.findUniqueOrThrow({
      where: { id: res.targetOrderId },
      include: { items: true, passengers: true },
    });
    expect(tgt.passengers.map((p) => p.id)).toEqual([p2.id]);
    const tgtOutbound = tgt.items.find(
      (it) => it.kind === OrderItemKind.FLIGHT && it.description.includes('去程'),
    )!;
    expect((tgtOutbound.metadata as { noShow?: { at?: string } }).noShow?.at).toBeTruthy();

    // 释放的是**新单那 1 座**，源单留守 2 位的回程座位分毫不动
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(2);
    const srcReturn = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id, kind: OrderItemKind.FLIGHT, description: { contains: '回程' } },
    });
    expect(srcReturn.flightScheduleId).toBe(ret.id);
    expect(srcReturn.quantity).toBe(2);

    // 钱与成本仍然守恒（no-show 与拆单都不改价）
    const after = await ledgerOf([order.id, res.targetOrderId]);
    expect(after.total).toBe(before.total);
    expect(after.paid).toBe(before.paid);
    expect(after.costCents).toBe(before.costCents);
    expect(after.roomsHalf).toBe(before.roomsHalf);
  });
});
