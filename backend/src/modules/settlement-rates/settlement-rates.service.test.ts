/**
 * 结算价日历 service · 单元测试（vitest）
 *
 * 用注入式 fake PrismaClient（service 函数都收 client 参数）驱动，不依赖真 DB：
 *   · date-only 折算：ymdToUtcDate / utcDateToYmd 对称、UTC 口径、非法输入拒绝。
 *   · getSettlementRate：命中返回每人价 DTO、未维护返回 null、按 UTC 复合键查。
 *   · listRates：from>to 拒绝、区间下发序列化 DTO。
 *   · upsertRates：逐格幂等 upsert（事务包裹）、写 updatedBy。
 *   · deleteRate：不存在返回 null、存在删除并回带被删行。
 */
import { describe, it, expect, vi } from 'vitest';
import { SettlementTier } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  deleteRate,
  getSettlementRate,
  listRates,
  upsertRates,
  utcDateToYmd,
  ymdToUtcDate,
} from './settlement-rates.service.js';

function rateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'r1',
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
  it('命中 → 返回每人价 DTO（departDate 折成 YMD）', async () => {
    const findUnique = vi.fn().mockResolvedValue(rateRow());
    const client = { settlementRate: { findUnique } } as unknown as PrismaClient;

    const dto = await getSettlementRate(
      SettlementTier.CITY_3STAR,
      1,
      '2026-07-24',
      client,
    );

    expect(dto).toMatchObject({
      tier: SettlementTier.CITY_3STAR,
      nights: 1,
      departDate: '2026-07-24',
      pricePerPersonCny: 2958,
    });
    // 按 UTC 复合唯一键查
    const arg = findUnique.mock.calls[0][0];
    expect(arg.where.tier_nights_departDate.tier).toBe(SettlementTier.CITY_3STAR);
    expect(arg.where.tier_nights_departDate.nights).toBe(1);
    expect(arg.where.tier_nights_departDate.departDate.toISOString()).toBe(
      '2026-07-24T00:00:00.000Z',
    );
  });

  it('当日无价 → 返回 null（调用方据此拒单）', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const client = { settlementRate: { findUnique } } as unknown as PrismaClient;
    const dto = await getSettlementRate(SettlementTier.INTL_5STAR, 3, '2026-08-01', client);
    expect(dto).toBeNull();
  });
});

describe('listRates', () => {
  it('from 晚于 to → 拒绝', async () => {
    const client = { settlementRate: { findMany: vi.fn() } } as unknown as PrismaClient;
    await expect(
      listRates({ from: '2026-07-31', to: '2026-07-01' }, client),
    ).rejects.toThrow();
  });

  it('区间查询 → 下发序列化 DTO 列表', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        rateRow(),
        rateRow({ id: 'r2', tier: SettlementTier.CITY_4STAR, pricePerPersonCny: 3588 }),
      ]);
    const client = { settlementRate: { findMany } } as unknown as PrismaClient;
    const rows = await listRates({ from: '2026-07-01', to: '2026-07-31', nights: 1 }, client);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ departDate: '2026-07-24', pricePerPersonCny: 2958 });
    expect(rows[1]).toMatchObject({ tier: SettlementTier.CITY_4STAR, pricePerPersonCny: 3588 });
    // 过滤条件带上 nights + UTC 区间
    const where = findMany.mock.calls[0][0].where;
    expect(where.nights).toBe(1);
    expect(where.departDate.gte.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(where.departDate.lte.toISOString()).toBe('2026-07-31T00:00:00.000Z');
  });
});

describe('upsertRates', () => {
  it('逐格幂等 upsert（事务包裹）+ 写 updatedBy', async () => {
    const upsert = vi.fn().mockImplementation(({ create }) =>
      Promise.resolve(
        rateRow({
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
          tier: SettlementTier.CITY_3STAR,
          nights: 1,
          departDate: '2026-07-24',
          pricePerPersonCny: 2958,
        },
        {
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
    // create/update 都带 updatedBy + note 归一化
    const firstCall = upsert.mock.calls[0][0];
    expect(firstCall.where.tier_nights_departDate.departDate.toISOString()).toBe(
      '2026-07-24T00:00:00.000Z',
    );
    expect(firstCall.create.updatedBy).toBe('staff-1');
    expect(firstCall.update.updatedBy).toBe('staff-1');
    expect(firstCall.create.note).toBeNull();
    const secondCall = upsert.mock.calls[1][0];
    expect(secondCall.create.note).toBe('旺季');
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

  it('存在 → 删除并回带被删行（供审计）', async () => {
    const findUnique = vi.fn().mockResolvedValue(rateRow());
    const del = vi.fn().mockResolvedValue(rateRow());
    const client = {
      settlementRate: { findUnique, delete: del },
    } as unknown as PrismaClient;
    const res = await deleteRate('r1', client);
    expect(del).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(res).toMatchObject({ id: 'r1', departDate: '2026-07-24', pricePerPersonCny: 2958 });
  });
});
