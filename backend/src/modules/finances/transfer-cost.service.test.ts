/**
 * 车队结算价越南盾折算 · 单测（vitest，不依赖真 DB）
 *
 * 覆盖：
 *   1. 人民币价源直取；越南盾按服务日生效的 VND 汇率行（名称行 → 通用行）÷ 折人民币，两位小数。
 *   2. 缺汇率 / 没给汇率 Map → cny null，source 标 missingFx（如实缺，不落 0）。
 *   3. 两者都填以越南盾为准；都没填 → { null, null }。
 *   4. 服务日分层回退：行上日期 → 去程出发日 → 下单日（北京业务日）→ 今天；用了哪层写进 source.fxDateBasis。
 *   5. 去程出发日 = 最早航段按各自 departureTz 折的当地日。
 *   6. 批量取数：只有越南盾价源才查 VND 汇率表。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import { groupFxRatesByName, type FxRateDto } from './finances.fx.service.js';
import {
  earliestDepartureLocalDate,
  loadTransferCostFxRatesIfNeeded,
  resolveTransferServiceDate,
  resolveTransferUnitCost,
  transferCostNeedsFx,
} from './transfer-cost.service.js';

function fx(name: string | null, effectiveFrom: string, rate: number): FxRateDto {
  return {
    id: `fx-${name ?? 'generic'}-${effectiveFrom}`,
    name,
    currency: 'VND',
    effectiveFrom,
    rate,
    note: null,
    updatedBy: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const RATES = groupFxRatesByName([
  fx('车队越南盾', '2026-01-01', 3740),
  fx('车队越南盾', '2026-10-02', 3700),
  fx(null, '2026-01-01', 3600),
]);

describe('resolveTransferUnitCost · 价源与折算', () => {
  it('人民币价源直取（不需要日期 / 汇率）', () => {
    expect(resolveTransferUnitCost({ costPriceCny: 300, costPriceVnd: null, costFxName: null })).toEqual({
      cny: 300,
      source: { currency: 'CNY', unitAmount: 300 },
    });
  });

  it('越南盾按服务日生效的名称行折人民币，两位小数（3,740,000 ÷ 3700 = 1010.81）', () => {
    const r = resolveTransferUnitCost({
      costPriceCny: null,
      costPriceVnd: 3_740_000,
      costFxName: '车队越南盾',
      date: { ymd: '2026-10-05', basis: 'FLIGHT_DEPARTURE' },
      fxRates: RATES,
    });
    expect(r.cny).toBe(1010.81);
    expect(r.source).toEqual({
      currency: 'VND',
      unitAmount: 3_740_000,
      fxName: '车队越南盾',
      fxRate: 3700,
      fxEffectiveFrom: '2026-10-02',
      fxDate: '2026-10-05',
      fxDateBasis: 'FLIGHT_DEPARTURE',
    });
  });

  it('服务日早于新汇率生效日 → 用旧行（跨汇率生效日按日取）', () => {
    const r = resolveTransferUnitCost({
      costPriceVnd: 3_740_000,
      costFxName: '车队越南盾',
      date: { ymd: '2026-10-01', basis: 'ORDER_CREATED' },
      fxRates: RATES,
    });
    expect(r.cny).toBe(1000);
    expect(r.source).toMatchObject({ fxRate: 3740, fxEffectiveFrom: '2026-01-01', fxDateBasis: 'ORDER_CREATED' });
  });

  it('名称没有汇率行 → 回落同币种通用行；名称留空也走通用行', () => {
    const named = resolveTransferUnitCost({
      costPriceVnd: 360_000,
      costFxName: '别的车队',
      date: '2026-10-05',
      fxRates: RATES,
    });
    expect(named.cny).toBe(100);
    expect(named.source).toMatchObject({ fxName: '别的车队', fxRate: 3600, fxDateBasis: 'ORDER_ITEM' });
    const generic = resolveTransferUnitCost({ costPriceVnd: 360_000, costFxName: '  ', date: '2026-10-05', fxRates: RATES });
    expect(generic.cny).toBe(100);
    expect(generic.source).toMatchObject({ fxName: null, fxRate: 3600 });
  });

  it('缺汇率（生效日在服务日之后 / 没给 Map）→ cny null，source 标 missingFx，不落 0', () => {
    const tooEarly = resolveTransferUnitCost({
      costPriceVnd: 3_740_000,
      costFxName: '车队越南盾',
      date: '2025-12-31',
      fxRates: RATES,
    });
    expect(tooEarly.cny).toBeNull();
    expect(tooEarly.source).toMatchObject({ currency: 'VND', fxRate: null, fxEffectiveFrom: null, missingFx: true });

    const noMap = resolveTransferUnitCost({ costPriceVnd: 3_740_000, costFxName: '车队越南盾', date: '2026-10-05' });
    expect(noMap.cny).toBeNull();
    expect(noMap.source).toMatchObject({ missingFx: true });
  });

  it('两者都填以越南盾为准（越南盾是更晚的显式选择）；都没填 → { null, null }', () => {
    const both = resolveTransferUnitCost({
      costPriceCny: 300,
      costPriceVnd: 3_740_000,
      costFxName: '车队越南盾',
      date: '2026-10-01',
      fxRates: RATES,
    });
    expect(both.cny).toBe(1000);
    expect(both.source?.currency).toBe('VND');
    expect(resolveTransferUnitCost({ costPriceCny: null, costPriceVnd: null })).toEqual({ cny: null, source: null });
  });

  it('Decimal 字符串形态的价也能喂（DB 行直接进）', () => {
    const r = resolveTransferUnitCost({
      costPriceVnd: '3740000.00',
      costFxName: '车队越南盾',
      date: '2026-10-01',
      fxRates: RATES,
    });
    expect(r.cny).toBe(1000);
    expect(r.source).toMatchObject({ unitAmount: 3_740_000 });
  });

  it('越南盾没给日期 → 按今天（北京业务日）折，fxDateBasis = TODAY', () => {
    const r = resolveTransferUnitCost({ costPriceVnd: 360_000, fxRates: RATES });
    expect(r.cny).toBe(100);
    expect(r.source).toMatchObject({ fxDateBasis: 'TODAY' });
  });
});

describe('resolveTransferServiceDate · 服务日分层回退', () => {
  it('行上接送日期优先（Date 按 UTC 日历日、字符串截 10 位）', () => {
    expect(resolveTransferServiceDate({ itemDate: new Date('2026-10-05T00:00:00.000Z'), outboundDepartureDate: '2026-10-01' })).toEqual({
      ymd: '2026-10-05',
      basis: 'ORDER_ITEM',
    });
    expect(resolveTransferServiceDate({ itemDate: '2026-10-05T23:00:00' })).toEqual({ ymd: '2026-10-05', basis: 'ORDER_ITEM' });
  });

  it('没有行日期 → 去程出发日', () => {
    expect(
      resolveTransferServiceDate({ outboundDepartureDate: '2026-10-01', orderCreatedAt: new Date('2026-09-20T00:00:00.000Z') }),
    ).toEqual({ ymd: '2026-10-01', basis: 'FLIGHT_DEPARTURE' });
  });

  it('没有航段 → 下单日按北京业务日折（UTC 20:00 = 北京次日）', () => {
    expect(resolveTransferServiceDate({ orderCreatedAt: new Date('2026-09-20T20:00:00.000Z') })).toEqual({
      ymd: '2026-09-21',
      basis: 'ORDER_CREATED',
    });
  });

  it('都没有 → 今天（北京业务日）', () => {
    expect(resolveTransferServiceDate({ now: new Date('2026-09-20T20:00:00.000Z') })).toEqual({
      ymd: '2026-09-21',
      basis: 'TODAY',
    });
  });
});

describe('earliestDepartureLocalDate · 去程出发日', () => {
  it('取最早出发的那段，按它自己的 departureTz 折当地日（红眼班次不早一天）', () => {
    const date = earliestDepartureLocalDate([
      { departureTime: new Date('2026-10-05T10:00:00.000Z'), departureTz: 'Asia/Ho_Chi_Minh' },
      // UTC 10-01 17:30 = 澳门 10-02 01:30 → 当地日 10-02
      { departureTime: new Date('2026-10-01T17:30:00.000Z'), departureTz: 'Asia/Macau' },
      null,
    ]);
    expect(date).toBe('2026-10-02');
  });

  it('没有航段 → null；tz 缺失回退 UTC', () => {
    expect(earliestDepartureLocalDate([])).toBeNull();
    expect(earliestDepartureLocalDate([{ departureTime: new Date('2026-10-01T17:30:00.000Z'), departureTz: null }])).toBe(
      '2026-10-01',
    );
  });
});

describe('批量取数 · 只有越南盾价源才拉 VND 汇率表', () => {
  it('transferCostNeedsFx：任一条有越南盾 → true；全人民币 / 空 → false', () => {
    expect(transferCostNeedsFx([{ costPriceCny: 300 }, null, undefined])).toBe(false);
    expect(transferCostNeedsFx([{ costPriceCny: 300 }, { costPriceVnd: '1.00' }])).toBe(true);
    expect(transferCostNeedsFx([])).toBe(false);
  });

  it('loadTransferCostFxRatesIfNeeded：全人民币不查库；有越南盾查一次 VND 行并按名称分组', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'fx1',
        name: '车队越南盾',
        currency: 'VND',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        rate: 3740,
        note: null,
        updatedBy: null,
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]);
    const client = { fxRate: { findMany } } as unknown as PrismaClient;

    expect(await loadTransferCostFxRatesIfNeeded([{ costPriceCny: 300 }], client)).toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();

    const map = await loadTransferCostFxRatesIfNeeded([{ costPriceVnd: 3_740_000 }], client);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0].where).toMatchObject({ currency: 'VND' });
    expect(map?.get('车队越南盾')?.[0]).toMatchObject({ rate: 3740, effectiveFrom: '2026-01-01' });
  });
});
