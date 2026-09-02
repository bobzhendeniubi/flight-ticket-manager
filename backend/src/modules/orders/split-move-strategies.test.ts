/**
 * 拆单 · 按 kind 的搬移策略（纯函数层）· 单测
 *
 * 这一层决定的是「派生账」怎么分：座位、升舱位、房数、成本、套餐人数快照。
 * 钱的总数不归它管（两侧 total 由份额引擎 + SPLIT 平账行收敛），所以这里逐条盯的是
 * **Σ 守恒**与**人数现势**：任何一条对不上，事务内核的守恒断言就会把整笔拆单回滚。
 */
import { describe, it, expect } from 'vitest';
import { OrderItemKind } from '@prisma/client';
import {
  deriveRoomsToMove,
  moveBundle,
  moveDiscount,
  moveFlightLike,
  moveHotel,
  movePriceAdjustment,
  occupancyOfPassengers,
  planItemMove,
  rebuildAddOns,
  resolveUpgradeToMove,
  type SplitContext,
  type SplitItemView,
  type SplitOccupancy,
} from './split-move-strategies.js';

// ── fixtures ──────────────────────────────────────────────────────────────
const occ = (adult: number, child = 0, infant = 0): SplitOccupancy => ({
  adultCount: adult,
  childCount: child,
  infantCount: infant,
  seatPax: adult + child,
  headCount: adult + child + infant,
});

function ctx(over: Partial<SplitContext> = {}): SplitContext {
  const movedOccupancy = over.movedOccupancy ?? occ(1);
  const keptOccupancy = over.keptOccupancy ?? occ(2);
  return {
    movedIdSet: new Set(['p1']),
    k: movedOccupancy.headCount,
    totalPax: movedOccupancy.headCount + keptOccupancy.headCount,
    movedSeatPax: movedOccupancy.seatPax,
    totalSeatPax: movedOccupancy.seatPax + keptOccupancy.seatPax,
    movedOccupancy,
    keptOccupancy,
    movedSingleCount: 0,
    keptSingleCount: 0,
    movedSelfVisaCount: 0,
    keptSelfVisaCount: 0,
    roomSplitByItem: new Map(),
    upgradeSplitByItem: new Map(),
    movedUpgradeOutbound: 0,
    movedUpgradeReturn: 0,
    keptUpgradeOutbound: 0,
    keptUpgradeReturn: 0,
    autoDeriveRooms: true,
    ...over,
  };
}

const item = (over: Partial<SplitItemView> = {}): SplitItemView => ({
  id: 'i1',
  kind: OrderItemKind.FLIGHT,
  description: '测试机票 去程',
  quantity: 3,
  unitPrice: 1000,
  amount: 3000,
  totalCostCny: 1800,
  roomsBilled: null,
  passengerId: null,
  metadata: {},
  ...over,
});

/** 下单时落库的 addOns 快照（3 人：2 成人 1 占座儿童，1 人单住、1 人去程升舱、1 人自备签）。 */
const addOnsSnapshot = () => ({
  singleCount: 1,
  businessCount: 1,
  businessCountOutbound: 1,
  businessCountReturn: 0,
  adultCount: 2,
  childCount: 1,
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
  selfProvidedVisaCount: 1,
  selfProvidedVisa: true,
  selfVisaDeductCny: 400,
  singleSupplementTotal: 1200,
  businessUpgradeTotal: 800,
  childSeatDiscountTotal: 500,
  infantPriceTotal: 0,
  selfVisaDeductTotal: 400,
  total: 1100,
});

// ══════════════════════════════════════════════════════════════════════════
describe('occupancyOfPassengers · 乘客类型 → 占座计数', () => {
  it('婴儿不占座、但算出行人', () => {
    expect(
      occupancyOfPassengers([
        { passengerType: 'ADULT' },
        { passengerType: 'CHILD' },
        { passengerType: 'INFANT' },
      ]),
    ).toEqual({ adultCount: 1, childCount: 1, infantCount: 1, seatPax: 2, headCount: 3 });
  });

  it('缺省 / 未知类型按成人处理（老数据不会被漏算成 0 座）', () => {
    expect(occupancyOfPassengers([{ passengerType: null }, {}])).toMatchObject({
      adultCount: 2,
      seatPax: 2,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('moveFlightLike · 按人数行', () => {
  it('quantity ≤ 拆出人数 → 整行搬走，剥快照与描述前缀', () => {
    const plan = moveFlightLike(
      item({
        quantity: 1,
        description: '【去程未登机】测试机票 去程',
        metadata: { noShow: { at: '2026-09-01T00:00:00.000Z' }, foo: 'bar' },
      }),
      ctx(),
    );
    expect(plan.mode).toBe('WHOLE');
    if (plan.mode !== 'WHOLE') throw new Error('unreachable');
    expect(plan.update.description).toBe('测试机票 去程');
    expect(plan.update.metadata).toEqual({ foo: 'bar' });
  });

  it('按人数拆：quantity / amount / 成本同比例，unitPrice 冻结', () => {
    const plan = moveFlightLike(item(), ctx());
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    expect(plan.keep).toMatchObject({ quantity: 2, amount: 2000, totalCostCny: 1200 });
    expect(plan.move).toMatchObject({ quantity: 1, amount: 1000, totalCostCny: 600 });
    // Σ 守恒
    expect(plan.keep.amount! + plan.move.amount!).toBe(3000);
    expect(plan.keep.totalCostCny! + plan.move.totalCostCny!).toBe(1800);
  });

  it('升舱位自动派生：3 人 2 个升舱位、拆 1 人 → 拆出 1 / 留守 1（Σ 恒等）', () => {
    const plan = moveFlightLike(item({ metadata: { businessUpgradeCount: 2 } }), ctx());
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    expect((plan.move.metadata as Record<string, unknown>).businessUpgradeCount).toBe(1);
    expect((plan.keep.metadata as Record<string, unknown>).businessUpgradeCount).toBe(1);
  });

  it('升舱位显式指定优先于派生', () => {
    const plan = moveFlightLike(
      item({ metadata: { businessUpgradeCount: 2 } }),
      ctx({ upgradeSplitByItem: new Map([['i1', 0]]) }),
    );
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    expect((plan.move.metadata as Record<string, unknown>).businessUpgradeCount).toBe(0);
    expect((plan.keep.metadata as Record<string, unknown>).businessUpgradeCount).toBe(2);
  });

  it('没有 businessUpgradeCount 键的行不会被凭空加上这个键', () => {
    const plan = moveFlightLike(item(), ctx());
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    expect(plan.keep.metadata).toBeUndefined();
    expect(plan.move.metadata).not.toHaveProperty('businessUpgradeCount');
  });

  it('派生结果被两侧座位数夹住：拆 1 人不可能带走 3 个升舱位', () => {
    const view = item({ quantity: 3, metadata: { businessUpgradeCount: 3 } });
    expect(resolveUpgradeToMove(view, ctx(), 1, 2)).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('deriveRoomsToMove · 房数自动派生（0.5 网格）', () => {
  it('2 人拼 1 间、拆 1 人 → 各带半间', () => {
    const c = ctx({ movedOccupancy: occ(1), keptOccupancy: occ(1) });
    expect(deriveRoomsToMove(1, c)).toBe(0.5);
  });

  it('3 人 2 间（1 人单住 + 2 人拼房）、拆走拼房的一位 → 带走半间', () => {
    const c = ctx({
      movedOccupancy: occ(1),
      keptOccupancy: occ(2),
      movedSingleCount: 0,
      keptSingleCount: 1,
    });
    expect(deriveRoomsToMove(2, c)).toBe(0.5);
  });

  it('单住的人整间带走（留守两位继续拼一间）', () => {
    const c = ctx({
      movedOccupancy: occ(1),
      keptOccupancy: occ(2),
      movedSingleCount: 1,
      keptSingleCount: 0,
    });
    expect(deriveRoomsToMove(2, c)).toBe(1);
  });

  it('两侧都有人 → 各留至少半间（不出现「一侧 0 间却住着人」）', () => {
    const c = ctx({ movedOccupancy: occ(1), keptOccupancy: occ(9) });
    const moved = deriveRoomsToMove(5, c);
    expect(moved).toBeGreaterThanOrEqual(0.5);
    expect(5 - moved).toBeGreaterThanOrEqual(0.5);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('moveHotel · 酒店行', () => {
  const hotel = () =>
    item({
      id: 'ih',
      kind: OrderItemKind.HOTEL,
      description: '明月酒店 双床房',
      quantity: 4,
      unitPrice: 600,
      amount: 2400,
      totalCostCny: 1600,
      roomsBilled: 2,
    });

  it('未显式给间数且不允许自动派生 → 整行留守（手工拆单的 v1 行为不变）', () => {
    expect(moveHotel(hotel(), ctx({ autoDeriveRooms: false })).mode).toBe('NONE');
  });

  it('按间数比例拆金额与成本，Σ 恒等', () => {
    const plan = moveHotel(hotel(), ctx({ roomSplitByItem: new Map([['ih', 0.5]]) }));
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    expect(plan.move).toMatchObject({ roomsBilled: 0.5, amount: 600, totalCostCny: 400 });
    expect(plan.keep).toMatchObject({ roomsBilled: 1.5, amount: 1800, totalCostCny: 1200 });
  });

  it('搬走全部间数 → 整行过户', () => {
    expect(moveHotel(hotel(), ctx({ roomSplitByItem: new Map([['ih', 2]]) })).mode).toBe('WHOLE');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('moveBundle · 套餐行', () => {
  const bundleRow = () =>
    item({
      id: 'ib',
      kind: OrderItemKind.BUNDLE,
      description: '海岛 5 日套餐',
      quantity: 1,
      unitPrice: 8000,
      amount: 30000,
      totalCostCny: 21000,
      roomsBilled: 2,
      metadata: {
        roomsNeeded: 2,
        addOns: addOnsSnapshot(),
        designatedHotel: {
          hotelName: '明月酒店',
          surchargeCnyPerPerson: 200,
          pax: 3,
          totalCny: 600,
        },
        operationFee: { perPaxCny: 20, pax: 3, totalCny: 60 },
        visaListSnapshotCny: 900,
      },
    });

  /** 拆走那位占座儿童（3 人里 1 位），留守 2 位成人；留守侧还有 1 位单住 + 1 位自备签。 */
  const bundleCtx = () =>
    ctx({
      movedOccupancy: occ(0, 1),
      keptOccupancy: occ(2),
      movedSingleCount: 0,
      keptSingleCount: 1,
      movedSelfVisaCount: 0,
      keptSelfVisaCount: 1,
      movedUpgradeOutbound: 0,
      keptUpgradeOutbound: 1,
    });

  it('quantity 恒为 1；金额与成本按占座人头比例劈，Σ 恒等', () => {
    const plan = moveBundle(bundleRow(), bundleCtx());
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    expect(plan.move.quantity).toBe(1);
    expect(plan.move.amount).toBe(10000); // 30000 × 1/3
    expect(plan.keep.amount).toBe(20000);
    expect(plan.move.totalCostCny! + plan.keep.totalCostCny!).toBe(21000);
  });

  it('房数按人头派生（单住留守方整间留下），Σ roomsBilled 恒等', () => {
    const plan = moveBundle(bundleRow(), bundleCtx());
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    expect(plan.move.roomsBilled).toBe(0.5);
    expect(plan.keep.roomsBilled).toBe(1.5);
    expect(plan.move.roomsBilled! + plan.keep.roomsBilled!).toBe(2);
  });

  it('addOns 按乘客现势重建（不是照抄），两侧计数各自为政', () => {
    const plan = moveBundle(bundleRow(), bundleCtx());
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    const moved = (plan.move.metadata as Record<string, unknown>).addOns as Record<string, number>;
    const kept = (plan.keep.metadata as Record<string, unknown>).addOns as Record<string, number>;
    // 拆出侧 = 1 位占座儿童：无单住、无升舱、无自备签，只剩儿童折扣
    expect(moved).toMatchObject({
      adultCount: 0,
      childCount: 1,
      seatPax: 1,
      headCount: 1,
      singleCount: 0,
      businessCountOutbound: 0,
      businessCountReturn: 0,
      selfProvidedVisaCount: 0,
      childSeatDiscountTotal: 500,
      singleSupplementTotal: 0,
      businessUpgradeTotal: 0,
      total: -500,
    });
    // 留守侧 = 2 位成人：1 人单住 4 晚、1 人去程升舱、1 人自备签
    expect(kept).toMatchObject({
      adultCount: 2,
      childCount: 0,
      seatPax: 2,
      singleCount: 1,
      businessCountOutbound: 1,
      businessCount: 1,
      selfProvidedVisaCount: 1,
      singleSupplementTotal: 1200, // 1 × 300 × 4 晚
      businessUpgradeTotal: 800, // (1 + 0) × 800
      selfVisaDeductTotal: 400,
      childSeatDiscountTotal: 0,
      total: 1600,
    });
    // 费率 / 晚数 / 航段数原样带过去（拆单不重新定价）
    expect(kept.nights).toBe(4);
    expect(kept.legs).toBe(2);
    expect(kept.singleSupplementCnyPerNight).toBe(300);
  });

  it('roomsNeeded 跟随各侧房数', () => {
    const plan = moveBundle(bundleRow(), bundleCtx());
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    expect((plan.move.metadata as Record<string, unknown>).roomsNeeded).toBe(0.5);
    expect((plan.keep.metadata as Record<string, unknown>).roomsNeeded).toBe(1.5);
  });

  it('指定酒店 / 操作费 / 签证挂牌价快照按份额缩放，Σ 恒等', () => {
    const plan = moveBundle(bundleRow(), bundleCtx());
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    const moved = plan.move.metadata as Record<string, Record<string, number> & number>;
    const kept = plan.keep.metadata as Record<string, Record<string, number> & number>;
    expect(moved.designatedHotel.totalCny + kept.designatedHotel.totalCny).toBe(600);
    expect(moved.designatedHotel.pax).toBe(1);
    expect(kept.designatedHotel.pax).toBe(2);
    expect(moved.operationFee.totalCny + kept.operationFee.totalCny).toBe(60);
    expect(Number(moved.visaListSnapshotCny) + Number(kept.visaListSnapshotCny)).toBe(900);
  });

  it('老单（无 addOns、只有顶层三计数）→ 顶层计数同步刷新', () => {
    const plan = moveBundle(
      item({
        id: 'ib',
        kind: OrderItemKind.BUNDLE,
        quantity: 1,
        amount: 9000,
        totalCostCny: null,
        roomsBilled: null,
        metadata: { adultCount: 3, pax: 3 },
      }),
      ctx({ movedOccupancy: occ(1), keptOccupancy: occ(2) }),
    );
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    expect(plan.move.metadata).toMatchObject({ adultCount: 1, childCount: 0, pax: 1 });
    expect(plan.keep.metadata).toMatchObject({ adultCount: 2, childCount: 0, pax: 2 });
    expect(plan.move.totalCostCny).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('rebuildAddOns · 单程套餐回程升舱恒为 0', () => {
  it('legs=1 时回程升舱位一律清零（没有回程航段可占座）', () => {
    const rebuilt = rebuildAddOns(
      { ...addOnsSnapshot(), legs: 1 },
      {
        occupancy: occ(2),
        singleCount: 0,
        selfVisaCount: 0,
        upgradeOutbound: 1,
        upgradeReturn: 1,
      },
    );
    expect(rebuilt.businessCountReturn).toBe(0);
    expect(rebuilt.businessUpgradeTotal).toBe(800);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('调价 / 折扣行', () => {
  it('按人调整行跟人走', () => {
    const row = item({
      kind: OrderItemKind.FEE,
      passengerId: 'p1',
      metadata: { priceAdjustment: true, reasonCode: 'MISC_FEE' },
    });
    expect(movePriceAdjustment(row, ctx()).mode).toBe('WHOLE');
    expect(movePriceAdjustment({ ...row, passengerId: 'p9' }, ctx()).mode).toBe('NONE');
  });

  it('整单结算价差额行全留源单', () => {
    const row = item({
      kind: OrderItemKind.DISCOUNT,
      amount: -500,
      metadata: { priceAdjustment: true, reasonCode: 'SETTLEMENT', settlementPrice: true },
    });
    expect(movePriceAdjustment(row, ctx()).mode).toBe('NONE');
  });

  it('套餐改档差额行按份额劈两行，两侧都保留 bundleChange 身份标', () => {
    const row = item({
      kind: OrderItemKind.FEE,
      amount: 900,
      metadata: { priceAdjustment: true, bundleChange: true, reasonCode: 'SETTLEMENT' },
    });
    const plan = movePriceAdjustment(row, ctx({ movedOccupancy: occ(1), keptOccupancy: occ(2) }));
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    expect(plan.move.amount).toBe(300);
    expect(plan.keep.amount).toBe(600);
    expect((plan.move.metadata as Record<string, unknown>).bundleChange).toBe(true);
  });

  it('同业立减行按人数拆两行，描述随人数更新', () => {
    const row = item({
      kind: OrderItemKind.DISCOUNT,
      description: '同业立减 ¥100/人 × 3人',
      quantity: 1,
      unitPrice: -300,
      amount: -300,
      totalCostCny: 0,
      metadata: {
        priceAdjustment: true,
        settlementDiscount: true,
        discountPerPersonCny: 100,
        pax: 3,
      },
    });
    const plan = moveDiscount(row, ctx({ movedOccupancy: occ(1), keptOccupancy: occ(2) }));
    if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
    expect(plan.move).toMatchObject({ amount: -100, description: '同业立减 ¥100/人 × 1人' });
    expect(plan.keep).toMatchObject({ amount: -200, description: '同业立减 ¥100/人 × 2人' });
    expect((plan.move.metadata as Record<string, unknown>).pax).toBe(1);
    expect((plan.keep.metadata as Record<string, unknown>).pax).toBe(2);
    expect(plan.move.amount! + plan.keep.amount!).toBe(-300);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('planItemMove · 派单', () => {
  it('调价标优先于 kind 判定（FEE/DISCOUNT 的 kind 不代表它走折扣口径）', () => {
    const row = item({
      kind: OrderItemKind.DISCOUNT,
      passengerId: 'p1',
      metadata: { priceAdjustment: true, reasonCode: 'DISCOUNT' },
    });
    expect(planItemMove(row, ctx()).mode).toBe('WHOLE');
  });

  it('普通 FEE 行（非调价标）全留源单', () => {
    expect(planItemMove(item({ kind: OrderItemKind.FEE, metadata: {} }), ctx()).mode).toBe('NONE');
  });

  it('VISA / TRANSFER 走按人数行口径', () => {
    for (const kind of [OrderItemKind.VISA, OrderItemKind.TRANSFER] as const) {
      const plan = planItemMove(item({ kind }), ctx());
      if (plan.mode !== 'SPLIT') throw new Error('expected SPLIT');
      expect(plan.move.quantity).toBe(1);
      expect(plan.keep.quantity).toBe(2);
    }
  });
});
