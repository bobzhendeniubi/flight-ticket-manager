/**
 * 按人份额 · 纯函数层一致性测试。
 *
 * 钉三件事：
 *   1. 落库形状 == 派生：六张黄金夹具上，每行 settlement / visa / singleRoomDiff 与 lib/order-money 的
 *      perPax*ByPassenger 逐分相等（本模块不许有第二套算法），base + net == settlement；
 *   2. 守恒：Σ 每人结算价 + 不摊条目（换人费）== 应收（payableCny），逐分；改一分就抛；
 *   3. 读侧优先级：库里完整一套（每位在单乘客一行 + 当前算法版本）→ PERSISTED；少一行 / 旧版本 / 没有 → DERIVED；
 *      多出来的旧行不算错。
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  payableCny,
  perPaxSettlementByPassenger,
  perPaxSingleRoomDiffByPassenger,
  perPaxVisaAmountByPassenger,
  toCents,
} from '../../lib/order-money.js';
import { allFixtures, fixtureMultiPax, fixtureSwapped } from '../../lib/order-money.golden.fixtures.js';
import {
  PASSENGER_SHARE_ALGO_VERSION,
  assertSharesReconcile,
  computePassengerShareRows,
  pickPersistedShares,
  resolvePassengerShares,
  shareRowsEqual,
  type PassengerShareRow,
  type PersistedShareLike,
} from './passenger-shares.js';

const asPersisted = (rows: PassengerShareRow[], over: Partial<PersistedShareLike> = {}): PersistedShareLike[] =>
  rows.map((r) => ({
    passengerId: r.passengerId,
    settlementCny: new Prisma.Decimal(r.settlementCny),
    baseCny: new Prisma.Decimal(r.baseCny),
    adjustmentCny: new Prisma.Decimal(r.adjustmentCny),
    visaCny: new Prisma.Decimal(r.visaCny),
    singleRoomDiffCny: new Prisma.Decimal(r.singleRoomDiffCny),
    discountCny: new Prisma.Decimal(r.discountCny),
    algoVersion: PASSENGER_SHARE_ALGO_VERSION,
    computedAt: new Date('2026-09-06T00:00:00Z'),
    ...over,
  }));

describe('computePassengerShareRows · 落库形状与派生逐分相等（黄金夹具）', () => {
  for (const o of allFixtures()) {
    it(`${o.orderNumber}：settlement / visa / singleRoomDiff 与 perPax*ByPassenger 同数，base + net = settlement`, () => {
      const settle = perPaxSettlementByPassenger(o);
      const visa = perPaxVisaAmountByPassenger(o);
      const single = perPaxSingleRoomDiffByPassenger(o);
      const comp = computePassengerShareRows(o);

      expect(comp.rows.map((r) => r.passengerId)).toEqual(o.passengers.map((p) => p.id));
      for (const r of comp.rows) {
        expect(toCents(r.settlementCny)).toBe(toCents(settle.get(r.passengerId)!));
        expect(toCents(r.visaCny)).toBe(toCents(visa.get(r.passengerId)!));
        expect(toCents(r.singleRoomDiffCny)).toBe(toCents(single.get(r.passengerId)!));
        expect(toCents(r.baseCny) + toCents(r.adjustmentCny)).toBe(toCents(r.settlementCny));
      }
      expect(comp.algoVersion).toBe(PASSENGER_SHARE_ALGO_VERSION);
    });

    it(`${o.orderNumber}：Σ 每人结算价 + 不摊条目 = 应收（payableCny）逐分`, () => {
      const comp = computePassengerShareRows(o);
      const sum = comp.rows.reduce((s, r) => s + toCents(r.settlementCny), 0);
      expect(sum + toCents(comp.excludedCny)).toBe(toCents(payableCny(o)));
      expect(() => assertSharesReconcile(comp)).not.toThrow();
    });
  }

  it('换人单：换人费挂在被换人头上，不进任何一行；excludedCny 就是那笔钱', () => {
    const o = fixtureSwapped();
    const comp = computePassengerShareRows(o);
    expect(comp.excludedCny).toBeGreaterThan(0);
    const sum = comp.rows.reduce((s, r) => s + toCents(r.settlementCny), 0);
    expect(sum).toBe(toCents(payableCny(o)) - toCents(comp.excludedCny));
  });

  it('多人单：按人调价净额如实落到 adjustmentCny，其余人为 0', () => {
    const o = fixtureMultiPax();
    const comp = computePassengerShareRows(o);
    const nonZero = comp.rows.filter((r) => r.adjustmentCny !== 0);
    expect(nonZero.length).toBeGreaterThan(0);
    for (const r of comp.rows) {
      expect(toCents(r.baseCny) + toCents(r.adjustmentCny)).toBe(toCents(r.settlementCny));
    }
  });

  it('无乘客：空行、不抛', () => {
    const o = { ...fixtureMultiPax(), passengers: [] };
    const comp = computePassengerShareRows(o);
    expect(comp.rows).toEqual([]);
    expect(() => assertSharesReconcile(comp)).not.toThrow();
  });
});

describe('assertSharesReconcile · 改一分就抛', () => {
  it('Σ 份额差一分 → 抛「守恒断言失败」', () => {
    const comp = computePassengerShareRows(fixtureMultiPax());
    const tampered = {
      ...comp,
      rows: comp.rows.map((r, i) =>
        i === 0 ? { ...r, settlementCny: r.settlementCny + 0.01, baseCny: r.baseCny + 0.01 } : r,
      ),
    };
    expect(() => assertSharesReconcile(tampered)).toThrow(/守恒断言失败/);
  });

  it('base + net ≠ settlement → 抛', () => {
    const comp = computePassengerShareRows(fixtureMultiPax());
    const tampered = {
      ...comp,
      rows: comp.rows.map((r, i) => (i === 0 ? { ...r, baseCny: r.baseCny + 1, adjustmentCny: r.adjustmentCny - 0.5 } : r)),
    };
    expect(() => assertSharesReconcile(tampered)).toThrow(/守恒断言失败/);
  });
});

describe('pickPersistedShares / resolvePassengerShares · 先读库，没有就派生', () => {
  const o = fixtureMultiPax();
  const derived = computePassengerShareRows(o).rows;

  it('库里完整一套（Decimal）→ PERSISTED，行值逐分等于派生', () => {
    const res = resolvePassengerShares({ ...o, passengerShares: asPersisted(derived) });
    expect(res.source).toBe('PERSISTED');
    expect(shareRowsEqual([...res.rows.values()], derived)).toBe(true);
    expect(res.computedAt?.toISOString()).toBe('2026-09-06T00:00:00.000Z');
    expect(res.payableCny).toBe(payableCny(o));
  });

  it('没有 passengerShares → DERIVED', () => {
    const res = resolvePassengerShares(o);
    expect(res.source).toBe('DERIVED');
    expect(shareRowsEqual([...res.rows.values()], derived)).toBe(true);
    expect(res.computedAt).toBeNull();
  });

  it('少一位乘客的行 → 视为没有（DERIVED）', () => {
    const res = resolvePassengerShares({ ...o, passengerShares: asPersisted(derived).slice(1) });
    expect(res.source).toBe('DERIVED');
  });

  it('算法版本不是当前 → 视为没有（DERIVED）', () => {
    const res = resolvePassengerShares({
      ...o,
      passengerShares: asPersisted(derived, { algoVersion: 'per-pax-share@2000-01-01' }),
    });
    expect(res.source).toBe('DERIVED');
    expect(pickPersistedShares({ ...o, passengerShares: asPersisted(derived, { algoVersion: null }) })).toBeNull();
  });

  it('多出来的旧行（乘客已不在单上）忽略，不算错', () => {
    const extra: PersistedShareLike = { ...asPersisted(derived)[0], passengerId: 'p-gone' };
    const res = resolvePassengerShares({ ...o, passengerShares: [...asPersisted(derived), extra] });
    expect(res.source).toBe('PERSISTED');
    expect(res.rows.has('p-gone')).toBe(false);
    expect(res.rows.size).toBe(o.passengers.length);
  });

  it('库里的数与派生不同也照读库（库是事实；一致性由写点与回填保证）', () => {
    const rows = asPersisted(derived);
    rows[0] = { ...rows[0], settlementCny: new Prisma.Decimal(1) };
    const res = resolvePassengerShares({ ...o, passengerShares: rows });
    expect(res.source).toBe('PERSISTED');
    expect(res.rows.get(derived[0].passengerId)?.settlementCny).toBe(1);
  });
});

describe('shareRowsEqual', () => {
  it('同数 → true；差一分 / 少一行 → false', () => {
    const a = computePassengerShareRows(fixtureMultiPax()).rows;
    expect(shareRowsEqual(a, a.map((r) => ({ ...r })))).toBe(true);
    expect(shareRowsEqual(a, a.map((r, i) => (i === 0 ? { ...r, visaCny: r.visaCny + 0.01 } : r)))).toBe(false);
    expect(shareRowsEqual(a, a.slice(1))).toBe(false);
  });
});
