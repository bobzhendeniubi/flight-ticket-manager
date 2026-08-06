/**
 * 机票结算价日历 service · 单元测试（vitest）
 *
 * 用注入式 fake PrismaClient（service 函数都收 client 参数）驱动，不依赖真 DB：
 *   · getFlightSettlementRate：命中返回每人价 DTO、未维护返回 null、按 UTC 复合键查、航班号大写归一。
 *   · listFlightRates：from>to 拒绝、区间 + 航班号列表下发序列化 DTO。
 *   · upsertFlightRates：逐格幂等 upsert（事务包裹）、写 updatedBy、note 归一化。
 *   · deleteFlightRate：不存在返回 null、存在删除并回带被删行。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  deleteFlightRate,
  getFlightSettlementRate,
  listFlightRates,
  upsertFlightRates,
} from './flight-settlement-rates.service.js';

function rateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'fr1',
    flightNumber: 'QH9589',
    departDate: new Date(Date.UTC(2026, 7, 10)),
    pricePerPersonCny: 1000,
    note: null,
    updatedBy: 'u1',
    updatedAt: new Date('2026-08-05T03:00:00.000Z'),
    ...overrides,
  };
}

describe('getFlightSettlementRate', () => {
  it('命中 → 返回每人价 DTO（departDate 折成 YMD）', async () => {
    const findUnique = vi.fn().mockResolvedValue(rateRow());
    const client = { flightSettlementRate: { findUnique } } as unknown as PrismaClient;

    const dto = await getFlightSettlementRate('QH9589', '2026-08-10', client);

    expect(dto).toMatchObject({
      flightNumber: 'QH9589',
      departDate: '2026-08-10',
      pricePerPersonCny: 1000,
    });
    // 按 UTC 复合唯一键查
    const arg = findUnique.mock.calls[0][0];
    expect(arg.where.flightNumber_departDate.flightNumber).toBe('QH9589');
    expect(arg.where.flightNumber_departDate.departDate.toISOString()).toBe(
      '2026-08-10T00:00:00.000Z',
    );
  });

  it('航班号小写/带空格 → 大写归一后再查（避免大小写造成查不到价）', async () => {
    const findUnique = vi.fn().mockResolvedValue(rateRow());
    const client = { flightSettlementRate: { findUnique } } as unknown as PrismaClient;

    await getFlightSettlementRate('  qh9589 ', '2026-08-10', client);

    expect(findUnique.mock.calls[0][0].where.flightNumber_departDate.flightNumber).toBe('QH9589');
  });

  it('当日无价 → 返回 null（调用方据此放弃自动取价）', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const client = { flightSettlementRate: { findUnique } } as unknown as PrismaClient;
    expect(await getFlightSettlementRate('QH9588', '2026-08-12', client)).toBeNull();
  });
});

describe('listFlightRates', () => {
  it('from 晚于 to → 拒绝', async () => {
    const client = { flightSettlementRate: { findMany: vi.fn() } } as unknown as PrismaClient;
    await expect(
      listFlightRates({ from: '2026-08-31', to: '2026-08-01' }, client),
    ).rejects.toThrow();
  });

  it('区间 + 航班号列表 → 下发序列化 DTO 列表', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        rateRow(),
        rateRow({ id: 'fr2', flightNumber: 'QH9588', pricePerPersonCny: 1200 }),
      ]);
    const client = { flightSettlementRate: { findMany } } as unknown as PrismaClient;

    const rows = await listFlightRates(
      { from: '2026-08-01', to: '2026-08-31', flightNumbers: ['QH9589', 'QH9588'] },
      client,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ departDate: '2026-08-10', pricePerPersonCny: 1000 });
    expect(rows[1]).toMatchObject({ flightNumber: 'QH9588', pricePerPersonCny: 1200 });
    const where = findMany.mock.calls[0][0].where;
    expect(where.flightNumber.in).toEqual(['QH9589', 'QH9588']);
    expect(where.departDate.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(where.departDate.lte.toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });

  it('不传航班号 → 不加航班号过滤（返回区间内全部）', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { flightSettlementRate: { findMany } } as unknown as PrismaClient;
    await listFlightRates({ from: '2026-08-01', to: '2026-08-31' }, client);
    expect(findMany.mock.calls[0][0].where.flightNumber).toBeUndefined();
  });
});

describe('upsertFlightRates', () => {
  it('逐格幂等 upsert（事务包裹）+ 写 updatedBy + note 归一化', async () => {
    const upsert = vi.fn().mockImplementation(({ create }) =>
      Promise.resolve(
        rateRow({
          flightNumber: create.flightNumber,
          pricePerPersonCny: create.pricePerPersonCny,
          updatedBy: create.updatedBy,
        }),
      ),
    );
    const $transaction = vi
      .fn()
      .mockImplementation((arr: Promise<unknown>[]) => Promise.all(arr));
    const client = { flightSettlementRate: { upsert }, $transaction } as unknown as PrismaClient;

    const rows = await upsertFlightRates(
      [
        { flightNumber: 'QH9589', departDate: '2026-08-10', pricePerPersonCny: 1000 },
        {
          flightNumber: 'QH9588',
          departDate: '2026-08-12',
          pricePerPersonCny: 1200,
          note: '旺季',
        },
      ],
      'staff-1',
      client,
    );

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    const firstCall = upsert.mock.calls[0][0];
    expect(firstCall.where.flightNumber_departDate.flightNumber).toBe('QH9589');
    expect(firstCall.where.flightNumber_departDate.departDate.toISOString()).toBe(
      '2026-08-10T00:00:00.000Z',
    );
    expect(firstCall.create.updatedBy).toBe('staff-1');
    expect(firstCall.update.updatedBy).toBe('staff-1');
    expect(firstCall.create.note).toBeNull();
    expect(upsert.mock.calls[1][0].create.note).toBe('旺季');
  });
});

describe('deleteFlightRate', () => {
  it('不存在 → 返回 null，不删', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const del = vi.fn();
    const client = {
      flightSettlementRate: { findUnique, delete: del },
    } as unknown as PrismaClient;
    expect(await deleteFlightRate('missing', client)).toBeNull();
    expect(del).not.toHaveBeenCalled();
  });

  it('存在 → 删除并回带被删行（供审计）', async () => {
    const findUnique = vi.fn().mockResolvedValue(rateRow());
    const del = vi.fn().mockResolvedValue(rateRow());
    const client = {
      flightSettlementRate: { findUnique, delete: del },
    } as unknown as PrismaClient;
    const res = await deleteFlightRate('fr1', client);
    expect(del).toHaveBeenCalledWith({ where: { id: 'fr1' } });
    expect(res).toMatchObject({
      id: 'fr1',
      flightNumber: 'QH9589',
      departDate: '2026-08-10',
      pricePerPersonCny: 1000,
    });
  });
});
