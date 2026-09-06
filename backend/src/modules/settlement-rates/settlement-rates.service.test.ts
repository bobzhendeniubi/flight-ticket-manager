/**
 * 结算价日历 service · 单元测试（vitest）
 *
 * 用注入式 fake PrismaClient（service 函数都收 client 参数）驱动，不依赖真 DB：
 *   · date-only 折算：ymdToUtcDate / utcDateToYmd 对称、UTC 口径、非法输入拒绝。
 *   · getSettlementRate：命中返回每人价 DTO、未维护返回 null、按 (航线, 档次, 晚数, 出发日) UTC 复合键查；
 *     两条航线同档同晚同日各取各的价，互不串。
 *   · listRates：from>to 拒绝、按航线 + 区间下发序列化 DTO。
 *   · upsertRates：逐格幂等 upsert（事务包裹）、写 routeKey + updatedBy。
 *   · deleteRate：不存在返回 null、存在删除并回带被删行。
 *   · listSettlementRoutes：表 distinct ∪ 活跃套餐派生 ∪ 活跃航班（只被绑成回程的航班不算一条线）。
 */
import { describe, it, expect, vi } from 'vitest';
import { SettlementTier } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  deleteRate,
  getSettlementRate,
  listRates,
  listSettlementRoutes,
  upsertRates,
  utcDateToYmd,
  ymdToUtcDate,
} from './settlement-rates.service.js';

const ROUTE = 'MFM-DAD';

function rateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'r1',
    routeKey: ROUTE,
    tier: SettlementTier.CITY_3STAR,
    nights: 1,
    departDate: new Date(Date.UTC(2026, 6, 24)),
    pricePerPersonCny: 2958,
    note: null,
    updatedBy: 'u1',
    updatedAt: new Date('2026-07-24T03:00:00.000Z'),
    ...overrides,
  };
}

describe('ymdToUtcDate / utcDateToYmd', () => {
  it('YMD → UTC 零点 Date，且往返对称', () => {
    const d = ymdToUtcDate('2026-07-24');
    expect(d.toISOString()).toBe('2026-07-24T00:00:00.000Z');
    expect(utcDateToYmd(d)).toBe('2026-07-24');
  });

  it('非法日期抛错', () => {
    expect(() => ymdToUtcDate('2026/07/24')).toThrow();
    expect(() => ymdToUtcDate('not-a-date')).toThrow();
  });
});

describe('getSettlementRate', () => {
  it('命中 → 返回每人价 DTO（departDate 折成 YMD，带 routeKey）', async () => {
    const findUnique = vi.fn().mockResolvedValue(rateRow());
    const client = { settlementRate: { findUnique } } as unknown as PrismaClient;

    const dto = await getSettlementRate(
      ROUTE,
      SettlementTier.CITY_3STAR,
      1,
      '2026-07-24',
      client,
    );

    expect(dto).toMatchObject({
      routeKey: ROUTE,
      tier: SettlementTier.CITY_3STAR,
      nights: 1,
      departDate: '2026-07-24',
      pricePerPersonCny: 2958,
    });
    // 按 (航线, 档次, 晚数, 出发日) UTC 复合唯一键查
    const key = findUnique.mock.calls[0][0].where.routeKey_tier_nights_departDate;
    expect(key.routeKey).toBe(ROUTE);
    expect(key.tier).toBe(SettlementTier.CITY_3STAR);
    expect(key.nights).toBe(1);
    expect(key.departDate.toISOString()).toBe('2026-07-24T00:00:00.000Z');
  });

  it('当日无价 → 返回 null（调用方据此拒单）', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const client = { settlementRate: { findUnique } } as unknown as PrismaClient;
    const dto = await getSettlementRate(ROUTE, SettlementTier.INTL_5STAR, 3, '2026-08-01', client);
    expect(dto).toBeNull();
  });

  it('两条航线同档同晚同日不同价 → 各取各的价，互不串；没维护的第三条线取不到，不退回别的线', async () => {
    const priceByRoute: Record<string, number> = { 'MFM-DAD': 2958, 'MFM-CXR': 3388 };
    const findUnique = vi.fn().mockImplementation(({ where }) => {
      const key = where.routeKey_tier_nights_departDate;
      const price = priceByRoute[key.routeKey];
      return Promise.resolve(
        price == null
          ? null
          : rateRow({ id: `r-${key.routeKey}`, routeKey: key.routeKey, pricePerPersonCny: price }),
      );
    });
    const client = { settlementRate: { findUnique } } as unknown as PrismaClient;

    const dad = await getSettlementRate('MFM-DAD', SettlementTier.CITY_3STAR, 1, '2026-07-24', client);
    const cxr = await getSettlementRate('MFM-CXR', SettlementTier.CITY_3STAR, 1, '2026-07-24', client);
    const han = await getSettlementRate('MFM-HAN', SettlementTier.CITY_3STAR, 1, '2026-07-24', client);

    expect(dad).toMatchObject({ routeKey: 'MFM-DAD', pricePerPersonCny: 2958 });
    expect(cxr).toMatchObject({ routeKey: 'MFM-CXR', pricePerPersonCny: 3388 });
    expect(han).toBeNull();
    // 三次查询各带各的航线，没有任何一次退回默认航线
    expect(
      findUnique.mock.calls.map((c) => c[0].where.routeKey_tier_nights_departDate.routeKey),
    ).toEqual(['MFM-DAD', 'MFM-CXR', 'MFM-HAN']);
  });
});

describe('listRates', () => {
  it('from 晚于 to → 拒绝', async () => {
    const client = { settlementRate: { findMany: vi.fn() } } as unknown as PrismaClient;
    await expect(
      listRates({ routeKey: ROUTE, from: '2026-07-31', to: '2026-07-01' }, client),
    ).rejects.toThrow();
  });

  it('按航线 + 区间查询 → 下发序列化 DTO 列表', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        rateRow(),
        rateRow({ id: 'r2', tier: SettlementTier.CITY_4STAR, pricePerPersonCny: 3588 }),
      ]);
    const client = { settlementRate: { findMany } } as unknown as PrismaClient;
    const rows = await listRates(
      { routeKey: ROUTE, from: '2026-07-01', to: '2026-07-31', nights: 1 },
      client,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ routeKey: ROUTE, departDate: '2026-07-24', pricePerPersonCny: 2958 });
    expect(rows[1]).toMatchObject({ tier: SettlementTier.CITY_4STAR, pricePerPersonCny: 3588 });
    // 过滤条件带上航线 + nights + UTC 区间
    const where = findMany.mock.calls[0][0].where;
    expect(where.routeKey).toBe(ROUTE);
    expect(where.nights).toBe(1);
    expect(where.departDate.gte.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(where.departDate.lte.toISOString()).toBe('2026-07-31T00:00:00.000Z');
  });
});

describe('upsertRates', () => {
  it('逐格幂等 upsert（事务包裹）+ 写 routeKey / updatedBy', async () => {
    const upsert = vi.fn().mockImplementation(({ create }) =>
      Promise.resolve(
        rateRow({
          routeKey: create.routeKey,
          tier: create.tier,
          nights: create.nights,
          pricePerPersonCny: create.pricePerPersonCny,
          updatedBy: create.updatedBy,
        }),
      ),
    );
    const $transaction = vi
      .fn()
      .mockImplementation((arr: Promise<unknown>[]) => Promise.all(arr));
    const client = { settlementRate: { upsert }, $transaction } as unknown as PrismaClient;

    const rows = await upsertRates(
      [
        {
          routeKey: ROUTE,
          tier: SettlementTier.CITY_3STAR,
          nights: 1,
          departDate: '2026-07-24',
          pricePerPersonCny: 2958,
        },
        {
          routeKey: 'MFM-CXR',
          tier: SettlementTier.CITY_5STAR,
          nights: 2,
          departDate: '2026-07-25',
          pricePerPersonCny: 5200,
          note: '旺季',
        },
      ],
      'staff-1',
      client,
    );

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    // 幂等键含航线；create/update 都带 updatedBy + note 归一化
    const firstCall = upsert.mock.calls[0][0];
    expect(firstCall.where.routeKey_tier_nights_departDate.routeKey).toBe(ROUTE);
    expect(firstCall.where.routeKey_tier_nights_departDate.departDate.toISOString()).toBe(
      '2026-07-24T00:00:00.000Z',
    );
    expect(firstCall.create.routeKey).toBe(ROUTE);
    expect(firstCall.create.updatedBy).toBe('staff-1');
    expect(firstCall.update.updatedBy).toBe('staff-1');
    expect(firstCall.create.note).toBeNull();
    const secondCall = upsert.mock.calls[1][0];
    expect(secondCall.where.routeKey_tier_nights_departDate.routeKey).toBe('MFM-CXR');
    expect(secondCall.create.routeKey).toBe('MFM-CXR');
    expect(secondCall.create.note).toBe('旺季');
    expect(rows[1].routeKey).toBe('MFM-CXR');
  });
});

describe('deleteRate', () => {
  it('不存在 → 返回 null，不删', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const del = vi.fn();
    const client = {
      settlementRate: { findUnique, delete: del },
    } as unknown as PrismaClient;
    const res = await deleteRate('missing', client);
    expect(res).toBeNull();
    expect(del).not.toHaveBeenCalled();
  });

  it('存在 → 删除并回带被删行（供审计，含航线）', async () => {
    const findUnique = vi.fn().mockResolvedValue(rateRow());
    const del = vi.fn().mockResolvedValue(rateRow());
    const client = {
      settlementRate: { findUnique, delete: del },
    } as unknown as PrismaClient;
    const res = await deleteRate('r1', client);
    expect(del).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(res).toMatchObject({
      id: 'r1',
      routeKey: ROUTE,
      departDate: '2026-07-24',
      pricePerPersonCny: 2958,
    });
  });
});

describe('listSettlementRoutes', () => {
  it('表 distinct ∪ 活跃套餐派生 ∪ 活跃航班去程方向；只被绑成回程的航班不算一条线；有价的排前', async () => {
    const client = {
      settlementRate: { findMany: vi.fn().mockResolvedValue([{ routeKey: 'MFM-DAD' }]) },
      settlementDiscountRule: { findMany: vi.fn().mockResolvedValue([{ routeKey: 'MFM-HAN' }]) },
      bundle: {
        findMany: vi.fn().mockResolvedValue([
          {
            outboundFlightId: 'f-out',
            returnFlightId: 'f-ret',
            outboundFlight: { originCode: 'MFM', destinationCode: 'DAD' },
            returnFlight: { originCode: 'DAD', destinationCode: 'MFM' },
          },
        ]),
      },
      flight: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'f-out', originCode: 'MFM', destinationCode: 'DAD' },
          // 只被绑成回程 → DAD-MFM 不该成为一条可维护航线
          { id: 'f-ret', originCode: 'DAD', destinationCode: 'MFM' },
          // 新线还没建套餐：两个方向都列出，运营可先备价
          { id: 'f-new-out', originCode: 'MFM', destinationCode: 'CXR' },
          { id: 'f-new-ret', originCode: 'CXR', destinationCode: 'MFM' },
        ]),
      },
    } as unknown as PrismaClient;

    const routes = await listSettlementRoutes(client);

    expect(routes.map((r) => r.routeKey)).toEqual(['MFM-DAD', 'CXR-MFM', 'MFM-CXR', 'MFM-HAN']);
    expect(routes[0]).toMatchObject({ origin: 'MFM', destination: 'DAD', hasRates: true });
    expect(routes.find((r) => r.routeKey === 'MFM-HAN')).toMatchObject({ hasRates: false });
    expect(routes.some((r) => r.routeKey === 'DAD-MFM')).toBe(false);
  });

  it('表里的脏键（不是「XXX-YYY」）不进下拉', async () => {
    const client = {
      settlementRate: { findMany: vi.fn().mockResolvedValue([{ routeKey: 'legacy' }]) },
      settlementDiscountRule: { findMany: vi.fn().mockResolvedValue([]) },
      bundle: { findMany: vi.fn().mockResolvedValue([]) },
      flight: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    await expect(listSettlementRoutes(client)).resolves.toEqual([]);
  });
});
