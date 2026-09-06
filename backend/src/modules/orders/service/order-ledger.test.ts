/**
 * 账本快照 / 守恒断言 · 纯函数单测（OrderMutation 内核的守恒腿）。
 *
 * 只测口径本身：五维求和怎么算、哪个维度变了报哪句、账本恒等式每一类违反怎么判、
 * 「只拦本次新引入的不平」这条规则。读库那一层由 order-mutation 单测与集成测试盖。
 */
import { describe, it, expect } from 'vitest';
import { OrderItemKind, CabinClass, Prisma } from '@prisma/client';
import {
  assertLedgerUnchanged,
  assertNoNewLedgerViolations,
  buildLedgerSnapshot,
  ledgerIdentityViolations,
  type LedgerItemRow,
  type LedgerOrderRow,
} from './order-ledger.js';

function flight(over: Partial<LedgerItemRow> = {}): LedgerItemRow {
  return {
    id: 'i-flight',
    kind: OrderItemKind.FLIGHT,
    description: '去程',
    amount: new Prisma.Decimal(1000),
    quantity: 2,
    passengerId: null,
    flightScheduleId: 'sch-1',
    flightCabin: CabinClass.ECONOMY,
    metadata: null,
    roomsBilled: null,
    totalCostCny: new Prisma.Decimal(600),
    ...over,
  };
}

function hotel(over: Partial<LedgerItemRow> = {}): LedgerItemRow {
  return {
    id: 'i-hotel',
    kind: OrderItemKind.HOTEL,
    description: '酒店 2 晚',
    amount: new Prisma.Decimal(800),
    quantity: 2,
    passengerId: null,
    flightScheduleId: null,
    flightCabin: null,
    metadata: null,
    roomsBilled: new Prisma.Decimal(1.5),
    totalCostCny: new Prisma.Decimal(500),
    ...over,
  };
}

/** 账本平的一张单：subtotal = total = Σ items = 1800。 */
function consistentOrder(over: Partial<LedgerOrderRow> = {}): LedgerOrderRow {
  return {
    id: 'o1',
    orderNumber: 'FTM-1',
    subtotal: new Prisma.Decimal(1800),
    total: new Prisma.Decimal(1800),
    adjustmentCny: 0,
    adjustments: [],
    paidAmount: new Prisma.Decimal(1000),
    prepaymentOffset: new Prisma.Decimal(0),
    passengers: [{ id: 'p1' }, { id: 'p2' }],
    items: [flight(), hotel()],
    ...over,
  };
}

describe('buildLedgerSnapshot · 五维求和', () => {
  it('应收 = Σ(total + 售后费)，已收 = Σ(paidAmount + 预存抵扣)，座位按班次舱位、房数按半间、成本按分', () => {
    const snap = buildLedgerSnapshot(
      ['o1', 'o2'],
      [
        consistentOrder({ adjustmentCny: 200, prepaymentOffset: new Prisma.Decimal(50) }),
        consistentOrder({
          id: 'o2',
          items: [
            flight({ id: 'i2', quantity: 1, metadata: { businessUpgradeCount: 1 } }),
            hotel({ id: 'h2', roomsBilled: 0.5 }),
          ],
        }),
      ],
    );
    expect(snap.receivableCents).toBe((1800 + 200 + 1800) * 100);
    expect(snap.paidCents).toBe((1000 + 50 + 1000) * 100);
    expect(snap.seats.get('sch-1|ECONOMY')).toBe(3);
    expect(snap.upgrades.get('sch-1|ECONOMY')).toBe(1);
    expect(snap.roomsHalves).toBe(3 + 1);
    expect(snap.costCents).toBe((600 + 500 + 600 + 500) * 100);
  });

  it('订单不存在（拆单前的新单）→ 不计入，缺的字段按 0 计', () => {
    const snap = buildLedgerSnapshot(['o1', 'o-new'], [{ id: 'o1' }]);
    expect(snap.rows).toHaveLength(1);
    expect(snap.receivableCents).toBe(0);
    expect(snap.seats.size).toBe(0);
  });
});

describe('assertLedgerUnchanged · 点名维度前后 Σ 恒等', () => {
  const before = buildLedgerSnapshot(['o1'], [consistentOrder()]);

  it('全平 → 不抛', () => {
    const after = buildLedgerSnapshot(['o1'], [consistentOrder()]);
    expect(() =>
      assertLedgerUnchanged(before, after, ['receivable', 'paid', 'seats', 'rooms', 'cost'], '测试'),
    ).not.toThrow();
  });

  it('已收变了、只点名 paid → 抛且文案带维度与前后值', () => {
    const after = buildLedgerSnapshot(['o1'], [consistentOrder({ paidAmount: new Prisma.Decimal(1100) })]);
    expect(() => assertLedgerUnchanged(before, after, ['paid'], '换人')).toThrow(
      /换人守恒断言失败：已收.*¥1000→¥1100（已回滚）/,
    );
  });

  it('变的维度没被点名 → 不抛（动作本来就要改它）', () => {
    const after = buildLedgerSnapshot(['o1'], [
      consistentOrder({ total: new Prisma.Decimal(900), subtotal: new Prisma.Decimal(900) }),
    ]);
    expect(() =>
      assertLedgerUnchanged(before, after, ['paid', 'seats', 'rooms', 'cost'], '取消回程'),
    ).not.toThrow();
  });

  it('座位：某班次舱位 Σquantity 变了 → 抛，文案带 key 与前后数', () => {
    const after = buildLedgerSnapshot(['o1'], [consistentOrder({ items: [flight({ quantity: 1 }), hotel()] })]);
    expect(() => assertLedgerUnchanged(before, after, ['seats'], '作废回程')).toThrow(
      /座位.*sch-1\|ECONOMY 2→1/,
    );
  });

  it('座位：升舱位凭空多出 → 抛', () => {
    const after = buildLedgerSnapshot(['o1'], [
      consistentOrder({ items: [flight({ metadata: { businessUpgradeCount: 2 } }), hotel()] }),
    ]);
    expect(() => assertLedgerUnchanged(before, after, ['seats'], 'x')).toThrow(/升舱位 sch-1\|ECONOMY 0→2/);
  });

  it('房数 / 成本各自独立判', () => {
    const rooms = buildLedgerSnapshot(['o1'], [consistentOrder({ items: [flight(), hotel({ roomsBilled: 2 })] })]);
    expect(() => assertLedgerUnchanged(before, rooms, ['rooms'], 'x')).toThrow(/计费房数 1\.5→2 间/);
    expect(() => assertLedgerUnchanged(before, rooms, ['cost'], 'x')).not.toThrow();
    const cost = buildLedgerSnapshot(['o1'], [consistentOrder({ items: [flight({ totalCostCny: 0 }), hotel()] })]);
    expect(() => assertLedgerUnchanged(before, cost, ['cost'], 'x')).toThrow(/成本 ¥1100→¥500/);
  });
});

describe('ledgerIdentityViolations · 单张订单账本恒等式', () => {
  it('账本平的单 → 无违反（含 Σ 每人份额 = 应收）', () => {
    expect(ledgerIdentityViolations(consistentOrder())).toEqual([]);
  });

  it('subtotal ≠ Σ items.amount', () => {
    const v = ledgerIdentityViolations(
      consistentOrder({ subtotal: new Prisma.Decimal(1700), total: new Prisma.Decimal(1700) }),
    );
    expect(v.map((x) => x.kind)).toEqual(['SUBTOTAL_NE_ITEMS']);
    expect(v[0]!.detail).toMatch(/subtotal ¥1700 ≠ Σ items.amount ¥1800/);
  });

  it('total ≠ subtotal（当前无 taxes / discount）', () => {
    const v = ledgerIdentityViolations(consistentOrder({ total: new Prisma.Decimal(1750) }));
    expect(v.map((x) => x.kind)).toEqual(['TOTAL_NE_SUBTOTAL']);
  });

  it('应收为负', () => {
    const v = ledgerIdentityViolations(
      consistentOrder({
        subtotal: new Prisma.Decimal(-10),
        total: new Prisma.Decimal(-10),
        items: [flight({ amount: -10 })],
      }),
    );
    expect(v.map((x) => x.kind)).toEqual(['NEGATIVE_TOTAL']);
  });

  it('挂人的调价行找不到人（按人调价行跟人走，拆单 / 换人后不该留孤儿）', () => {
    const v = ledgerIdentityViolations(
      consistentOrder({
        subtotal: new Prisma.Decimal(1900),
        total: new Prisma.Decimal(1900),
        items: [
          flight(),
          hotel(),
          {
            id: 'i-adj',
            kind: OrderItemKind.FEE,
            description: '补收杂费',
            amount: 100,
            quantity: 1,
            passengerId: 'p-gone',
            flightScheduleId: null,
            flightCabin: null,
            metadata: { priceAdjustment: true, reasonCode: 'MISC' },
            roomsBilled: null,
            totalCostCny: null,
          },
        ],
      }),
    );
    expect(v.map((x) => x.kind)).toEqual(['ORPHAN_PER_PAX_ADJUSTMENT']);
    expect(v[0]!.detail).toMatch(/¥100 挂在不在本单的乘客 p-gone/);
  });
});

describe('assertNoNewLedgerViolations · 只拦本次新引入的不平', () => {
  it('前后都不平（存量脏单）→ 放行', () => {
    const dirty = consistentOrder({ subtotal: new Prisma.Decimal(1), total: new Prisma.Decimal(1) });
    const before = buildLedgerSnapshot(['o1'], [dirty]);
    const after = buildLedgerSnapshot(['o1'], [dirty]);
    expect(() => assertNoNewLedgerViolations(before, after, 'x')).not.toThrow();
  });

  it('前平后不平 → 抛，文案带单号 / 类型 / 明细', () => {
    const before = buildLedgerSnapshot(['o1'], [consistentOrder()]);
    const after = buildLedgerSnapshot(['o1'], [
      consistentOrder({ total: new Prisma.Decimal(-5), subtotal: new Prisma.Decimal(-5) }),
    ]);
    expect(() => assertNoNewLedgerViolations(before, after, '取消回程')).toThrow(
      /取消回程账本恒等式失败：FTM-1 SUBTOTAL_NE_ITEMS.*FTM-1 NEGATIVE_TOTAL.*（已回滚）/,
    );
  });

  it('新出现的订单（拆单新单）本身就要平', () => {
    const before = buildLedgerSnapshot(['o1', 'o2'], [consistentOrder()]);
    const after = buildLedgerSnapshot(['o1', 'o2'], [
      consistentOrder(),
      consistentOrder({
        id: 'o2',
        orderNumber: 'FTM-2',
        subtotal: new Prisma.Decimal(5),
        total: new Prisma.Decimal(5),
        items: [],
      }),
    ]);
    expect(() => assertNoNewLedgerViolations(before, after, '拆单')).toThrow(/FTM-2 SUBTOTAL_NE_ITEMS/);
  });
});
