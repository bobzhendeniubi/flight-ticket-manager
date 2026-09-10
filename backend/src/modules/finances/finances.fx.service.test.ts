/**
 * 汇率表 service · 单元测试（vitest）
 *
 * 用注入式 fake PrismaClient（service 函数都收 client 参数）驱动，不依赖真 DB。
 * findFirst 的 fake **真的按 name 等值 + currency 等值 + lte + orderBy desc 过滤**，这样「先名称、再通用、
 * ≤date 取最新一条、币种隔离」的取数边界测的是口径本身，不是 mock 的返回值。
 *   · toCny：USD = 金额 × 汇率；VND = 金额 ÷ 汇率（多少越南盾折 1 人民币）；两位小数；VND 汇率 ≤ 0 → null。
 *   · ymdToUtcDate / utcDateToYmd：UTC 口径对称，非法输入拒绝。
 *   · getFxRate / getUsdFxRate：名称优先 / 回落通用 / 名称 trim / 无名称只看通用 / 币种隔离 / 同日命中 /
 *     跨日沿用 / 早于最早一条 → null / 多条取最新。
 *   · resolveFxRateInMap / groupFxRatesByName：内存版同口径（酒店逐晚折算用）。
 *   · listEffectiveFxRates：每个名称各一条生效中的行（含通用行），晚于目标日的不列。
 *   · upsertFxRate：按（名称 × 币种 × 生效日）幂等、汇率必须 > 0、名称 trim + 空串→通用、名称填成金额拒绝、
 *     非法币种拒绝。
 *   · listFxRates：按币种、名称（通用行最后）、生效日倒序下发序列化 DTO。
 *   · listFxSupplierOptions / listFxNameOptions：签证供应商候选 + 越南盾建议项 + 表里已有名称。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  getFxRate,
  getUsdFxRate,
  groupFxRatesByName,
  listEffectiveFxRates,
  listFxNameOptions,
  listFxRates,
  listFxSupplierOptions,
  normalizeFxName,
  resolveFxRateInMap,
  toCny,
  upsertFxRate,
  utcDateToYmd,
  ymdToUtcDate,
  type FxCurrency,
  type FxRateDto,
} from './finances.fx.service.js';

function rateRow(
  effectiveFrom: string,
  rate: number,
  name: string | null = null,
  currency: FxCurrency = 'USD',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `fx-${currency}-${name ?? 'generic'}-${effectiveFrom}`,
    name,
    currency,
    effectiveFrom: ymdToUtcDate(effectiveFrom),
    rate,
    note: null,
    updatedBy: 'finance-1',
    updatedAt: new Date('2026-08-05T03:00:00.000Z'),
    ...overrides,
  };
}

type Row = ReturnType<typeof rateRow>;

interface FindArgs {
  where: { name?: string | null; currency: string; effectiveFrom?: { lte: Date } };
}

function sortListing(a: Row, b: Row): number {
  if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
  if (a.name !== b.name) {
    if (a.name == null) return 1;
    if (b.name == null) return -1;
    return a.name.localeCompare(b.name);
  }
  return b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
}

/**
 * fake client：按 where.name 等值（null 即通用行）+ where.currency + where.effectiveFrom.lte + orderBy desc 真过滤，
 * 让「先名称、再通用、≤目标日期的最新一条、币种隔离」这条口径被真正验证。
 */
function fakeClient(rows: Row[]): PrismaClient {
  const filter = ({ where }: FindArgs) =>
    rows
      .filter((r) => (where.name === undefined ? true : r.name === where.name))
      .filter((r) => r.currency === where.currency)
      .filter((r) => (where.effectiveFrom ? r.effectiveFrom.getTime() <= where.effectiveFrom.lte.getTime() : true));
  return {
    fxRate: {
      findFirst: vi.fn((args: FindArgs) => {
        const hit = filter(args).sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
        return Promise.resolve(hit ?? null);
      }),
      findMany: vi.fn((args?: FindArgs) =>
        Promise.resolve((args?.where ? filter(args) : [...rows]).sort(sortListing)),
      ),
    },
  } as unknown as PrismaClient;
}

describe('toCny — 两种记法一处统一', () => {
  it('USD：金额 × 汇率（1 美金 = rate 人民币），两位小数', () => {
    expect(toCny(31.5, 'USD', 7.2)).toBe(226.8);
    expect(toCny(10, 'USD', 7.0856)).toBe(70.86);
    expect(toCny(0, 'USD', 7.2)).toBe(0);
  });

  it('VND：金额 ÷ 汇率（rate 越南盾 = 1 人民币），两位小数', () => {
    expect(toCny(3740, 'VND', 3740)).toBe(1);
    expect(toCny(1_500_000, 'VND', 3740)).toBe(401.07);
    expect(toCny(1_000_000, 'VND', 3700)).toBe(270.27);
  });

  it('VND 汇率 ≤ 0 无法折算 → null；非有限数 → null', () => {
    expect(toCny(1000, 'VND', 0)).toBeNull();
    expect(toCny(1000, 'VND', -1)).toBeNull();
    expect(toCny(Number.NaN, 'USD', 7.2)).toBeNull();
    expect(toCny(10, 'USD', Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('ymdToUtcDate / utcDateToYmd', () => {
  it('YMD → UTC 零点 Date，且往返对称', () => {
    const d = ymdToUtcDate('2026-08-05');
    expect(d.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    expect(utcDateToYmd(d)).toBe('2026-08-05');
  });

  it('非法日期抛错', () => {
    expect(() => ymdToUtcDate('2026/08/05')).toThrow();
    expect(() => ymdToUtcDate('not-a-date')).toThrow();
  });
});

describe('normalizeFxName — 名称 trim，空即通用', () => {
  it('trim 后原样；空串 / 空白 / undefined / null → null', () => {
    expect(normalizeFxName('  甲公司 ')).toBe('甲公司');
    expect(normalizeFxName('')).toBeNull();
    expect(normalizeFxName('   ')).toBeNull();
    expect(normalizeFxName(undefined)).toBeNull();
    expect(normalizeFxName(null)).toBeNull();
  });
});

const generic = [rateRow('2026-07-01', 7.05), rateRow('2026-08-05', 7.16)];
const withNames = [
  ...generic,
  rateRow('2026-01-01', 7.2, '甲公司'),
  rateRow('2026-06-01', 7.0856, '乙公司'),
  rateRow('2026-09-01', 7.1, '乙公司'),
  rateRow('2026-01-01', 3740, '酒店越南盾', 'VND'),
  rateRow('2026-03-01', 3700, null, 'VND'),
];

describe('getFxRate — 先名称、再通用、「生效日 ≤ 目标日期的最新一条」、按币种隔离', () => {
  it('名称有自己的汇率 → 用名称行，不看通用行（即使通用行生效日更晚）', async () => {
    const dto = await getFxRate({ date: '2026-09-09', currency: 'USD', name: '甲公司' }, fakeClient(withNames));
    expect(dto).toMatchObject({ name: '甲公司', currency: 'USD', effectiveFrom: '2026-01-01', rate: 7.2 });
  });

  it('名称多条 → 取该名称 ≤date 的最新一条', async () => {
    const before = await getFxRate({ date: '2026-08-31', currency: 'USD', name: '乙公司' }, fakeClient(withNames));
    expect(before).toMatchObject({ name: '乙公司', effectiveFrom: '2026-06-01', rate: 7.0856 });
    const after = await getFxRate({ date: '2026-09-01', currency: 'USD', name: '乙公司' }, fakeClient(withNames));
    expect(after).toMatchObject({ name: '乙公司', effectiveFrom: '2026-09-01', rate: 7.1 });
  });

  it('名称没有任何 ≤date 的记录 → 回落同币种通用行（DTO.name 为 null 标明是回落）', async () => {
    const unknown = await getFxRate({ date: '2026-09-09', currency: 'USD', name: '丙公司' }, fakeClient(withNames));
    expect(unknown).toMatchObject({ name: null, currency: 'USD', effectiveFrom: '2026-08-05', rate: 7.16 });
    const laterOnly = [...withNames, rateRow('2026-10-01', 7.3, '丁公司')];
    const tooEarly = await getFxRate({ date: '2026-09-09', currency: 'USD', name: '丁公司' }, fakeClient(laterOnly));
    expect(tooEarly).toMatchObject({ name: null, effectiveFrom: '2026-08-05', rate: 7.16 });
  });

  it('币种隔离：VND 名称行 / VND 通用行不会串到 USD，USD 名称也不会串到 VND', async () => {
    const vndNamed = await getFxRate({ date: '2026-09-09', currency: 'VND', name: '酒店越南盾' }, fakeClient(withNames));
    expect(vndNamed).toMatchObject({ name: '酒店越南盾', currency: 'VND', rate: 3740 });
    const vndFallback = await getFxRate({ date: '2026-09-09', currency: 'VND', name: '甲公司' }, fakeClient(withNames));
    expect(vndFallback).toMatchObject({ name: null, currency: 'VND', rate: 3700, effectiveFrom: '2026-03-01' });
    const usdNoVnd = await getFxRate({ date: '2026-09-09', currency: 'USD', name: '酒店越南盾' }, fakeClient(withNames));
    expect(usdNoVnd).toMatchObject({ name: null, currency: 'USD', rate: 7.16 });
  });

  it('名称 trim 后精确匹配（前后空白不影响命中；不同名不命中）', async () => {
    const trimmed = await getFxRate({ date: '2026-09-09', currency: 'USD', name: '  甲公司 ' }, fakeClient(withNames));
    expect(trimmed).toMatchObject({ name: '甲公司', rate: 7.2 });
    const other = await getFxRate({ date: '2026-09-09', currency: 'USD', name: '甲公司分部' }, fakeClient(withNames));
    expect(other).toMatchObject({ name: null, rate: 7.16 });
  });

  it('无名称（null / 空串 / 空白 / 缺省）→ 只看通用行，且不发名称查询', async () => {
    for (const name of [null, undefined, '', '   ']) {
      const client = fakeClient(withNames);
      const dto = await getFxRate({ date: '2026-09-09', currency: 'USD', name }, client);
      expect(dto).toMatchObject({ name: null, effectiveFrom: '2026-08-05', rate: 7.16 });
      const findFirst = (client as unknown as { fxRate: { findFirst: ReturnType<typeof vi.fn> } }).fxRate.findFirst;
      expect(findFirst).toHaveBeenCalledTimes(1);
      expect(findFirst.mock.calls[0][0].where).toMatchObject({ name: null, currency: 'USD' });
    }
  });

  it('名称与通用都没有 → null（不臆造汇率）', async () => {
    const onlyOthers = [rateRow('2026-01-01', 7.2, '甲公司')];
    expect(await getFxRate({ date: '2026-09-09', currency: 'USD', name: '乙公司' }, fakeClient(onlyOthers))).toBeNull();
    expect(await getFxRate({ date: '2026-09-09', currency: 'USD' }, fakeClient(onlyOthers))).toBeNull();
    expect(await getFxRate({ date: '2026-08-05', currency: 'VND' }, fakeClient([]))).toBeNull();
  });

  it('目标日期 = 生效日当天 → 命中；晚于生效日 → 沿用；落在两条之间 → 取较早那条；早于最早一条 → null', async () => {
    expect(await getFxRate({ date: '2026-08-05', currency: 'USD' }, fakeClient(generic))).toMatchObject({
      effectiveFrom: '2026-08-05',
      rate: 7.16,
    });
    expect(await getFxRate({ date: '2026-09-30', currency: 'USD' }, fakeClient(generic))).toMatchObject({
      effectiveFrom: '2026-08-05',
    });
    expect(await getFxRate({ date: '2026-08-04', currency: 'USD' }, fakeClient(generic))).toMatchObject({
      effectiveFrom: '2026-07-01',
      rate: 7.05,
    });
    expect(await getFxRate({ date: '2026-06-30', currency: 'USD' }, fakeClient(generic))).toBeNull();
  });

  it('查询按 UTC date-only 下发（不经本地时区挪日），名称查询先于通用查询，且都带币种', async () => {
    const client = fakeClient(withNames);
    await getFxRate({ date: '2026-08-05', currency: 'USD', name: '丙公司' }, client);
    const findFirst = (client as unknown as { fxRate: { findFirst: ReturnType<typeof vi.fn> } }).fxRate.findFirst;
    expect(findFirst).toHaveBeenCalledTimes(2);
    const [own, generic2] = findFirst.mock.calls.map((c) => c[0]);
    expect(own.where).toMatchObject({ name: '丙公司', currency: 'USD' });
    expect(own.where.effectiveFrom.lte.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    expect(own.orderBy).toEqual({ effectiveFrom: 'desc' });
    expect(generic2.where).toMatchObject({ name: null, currency: 'USD' });
  });

  it('非法币种 → 拒绝', async () => {
    await expect(
      getFxRate({ date: '2026-08-05', currency: 'EUR' as FxCurrency }, fakeClient(withNames)),
    ).rejects.toThrow();
  });

  it('getUsdFxRate 是 USD 包装：supplier 即汇率名称，口径与 getFxRate 一致', async () => {
    const own = await getUsdFxRate('2026-09-09', '甲公司', fakeClient(withNames));
    expect(own).toMatchObject({ name: '甲公司', currency: 'USD', rate: 7.2 });
    const fallback = await getUsdFxRate('2026-09-09', '丙公司', fakeClient(withNames));
    expect(fallback).toMatchObject({ name: null, currency: 'USD', rate: 7.16 });
    expect(await getUsdFxRate('2026-09-09', null, fakeClient([]))).toBeNull();
  });
});

describe('resolveFxRateInMap / groupFxRatesByName — 内存版同口径（酒店逐晚折算用）', () => {
  const dtos: FxRateDto[] = [
    { id: 'a', name: '酒店越南盾', currency: 'VND', effectiveFrom: '2026-01-01', rate: 3740, note: null, updatedBy: null, updatedAt: '' },
    { id: 'b', name: '酒店越南盾', currency: 'VND', effectiveFrom: '2026-10-01', rate: 3700, note: null, updatedBy: null, updatedAt: '' },
    { id: 'c', name: null, currency: 'VND', effectiveFrom: '2026-05-01', rate: 3800, note: null, updatedBy: null, updatedAt: '' },
  ];

  it('按名称分组（通用行 key 为空串），组内生效日倒序', () => {
    const map = groupFxRatesByName(dtos);
    expect([...map.keys()].sort()).toEqual(['', '酒店越南盾']);
    expect(map.get('酒店越南盾')!.map((r) => r.effectiveFrom)).toEqual(['2026-10-01', '2026-01-01']);
  });

  it('先名称行 ≤date 最新一条、没有回落通用、都没有 null；名称 trim', () => {
    const map = groupFxRatesByName(dtos);
    expect(resolveFxRateInMap(map, '2026-09-30', ' 酒店越南盾 ')).toMatchObject({ id: 'a', rate: 3740 });
    expect(resolveFxRateInMap(map, '2026-10-01', '酒店越南盾')).toMatchObject({ id: 'b', rate: 3700 });
    expect(resolveFxRateInMap(map, '2026-09-30', '车队越南盾')).toMatchObject({ id: 'c', rate: 3800 });
    expect(resolveFxRateInMap(map, '2026-09-30', null)).toMatchObject({ id: 'c' });
    expect(resolveFxRateInMap(map, '2026-04-30', '车队越南盾')).toBeNull();
    expect(resolveFxRateInMap(new Map(), '2026-09-30', '酒店越南盾')).toBeNull();
  });
});

describe('listEffectiveFxRates — 目标日每个名称各一条生效中的行', () => {
  it('每名称取 ≤date 最新一条（含通用行）、晚于目标日的名称不列、只看该币种', async () => {
    const rows = await listEffectiveFxRates({ date: '2026-08-31', currency: 'USD' }, fakeClient(withNames));
    expect(rows.map((r) => `${r.name ?? '通用'}@${r.effectiveFrom}=${r.rate}`)).toEqual([
      '乙公司@2026-06-01=7.0856',
      '甲公司@2026-01-01=7.2',
      '通用@2026-08-05=7.16',
    ]);
    const vnd = await listEffectiveFxRates({ date: '2026-02-01', currency: 'VND' }, fakeClient(withNames));
    expect(vnd.map((r) => r.name)).toEqual(['酒店越南盾']);
  });
});

describe('upsertFxRate — 按（名称 × 币种 × 生效日）幂等', () => {
  function writableClient(existing: Row | null) {
    const findFirst = vi.fn().mockResolvedValue(existing ? { id: existing.id } : null);
    const update = vi
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...(existing as Row), ...data }),
      );
    const create = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(
        rateRow(
          utcDateToYmd(data.effectiveFrom as Date),
          data.rate as number,
          (data.name as string | null) ?? null,
          data.currency as FxCurrency,
          { note: data.note, updatedBy: data.updatedBy },
        ),
      ),
    );
    const client = { fxRate: { findFirst, update, create } } as unknown as PrismaClient;
    return { client, findFirst, update, create };
  }

  it('同名称同币种同生效日已有 → update 不 create（幂等键 = 名称 × 币种 × UTC 零点生效日）', async () => {
    const existing = rateRow('2026-08-05', 7.1, '甲公司');
    const { client, findFirst, update, create } = writableClient(existing);
    const dto = await upsertFxRate(
      { name: '甲公司', currency: 'USD', effectiveFrom: '2026-08-05', rate: 7.2, note: '月初挂牌' },
      'finance-1',
      client,
    );
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ name: '甲公司', currency: 'USD' });
    expect(findFirst.mock.calls[0][0].where.effectiveFrom.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    expect(update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: { rate: 7.2, note: '月初挂牌', updatedBy: 'finance-1' },
    });
    expect(create).not.toHaveBeenCalled();
    expect(dto).toMatchObject({ name: '甲公司', currency: 'USD', effectiveFrom: '2026-08-05', rate: 7.2 });
  });

  it('没有 → create，名称 trim 后落库，币种原样落库（VND 记法 3740）', async () => {
    const { client, update, create } = writableClient(null);
    const dto = await upsertFxRate(
      { name: '  酒店越南盾 ', currency: 'VND', effectiveFrom: '2026-08-05', rate: 3740 },
      'finance-1',
      client,
    );
    expect(update).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data).toMatchObject({
      name: '酒店越南盾',
      currency: 'VND',
      rate: 3740,
      note: null,
      updatedBy: 'finance-1',
    });
    expect(dto).toMatchObject({ name: '酒店越南盾', currency: 'VND', rate: 3740 });
  });

  it('名称留空 / 空白 / 缺省 → 通用行（name null），同币种同日通用行已有则覆盖', async () => {
    for (const name of [undefined, null, '', '  ']) {
      const { client, findFirst, create } = writableClient(null);
      await upsertFxRate({ name, currency: 'USD', effectiveFrom: '2026-08-05', rate: 7.16 }, null, client);
      expect(findFirst.mock.calls[0][0].where.name).toBeNull();
      expect(create.mock.calls[0][0].data.name).toBeNull();
    }
    const existingGeneric = rateRow('2026-08-05', 7.1);
    const { client, update, create } = writableClient(existingGeneric);
    await upsertFxRate({ currency: 'USD', effectiveFrom: '2026-08-05', rate: 7.16 }, null, client);
    expect(update).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('note 缺省 / 空白归一化为 null', async () => {
    const { client, create } = writableClient(null);
    await upsertFxRate({ currency: 'USD', effectiveFrom: '2026-08-05', rate: 7.16, note: '  ' }, null, client);
    expect(create.mock.calls[0][0].data.note).toBeNull();
  });

  it('名称填成金额（「31.5美金」）/ 汇率 ≤ 0 / 非法生效日 / 非法币种 → 拒绝（不写库）', async () => {
    const { client, findFirst, create } = writableClient(null);
    await expect(
      upsertFxRate({ name: '31.5美金', currency: 'USD', effectiveFrom: '2026-08-05', rate: 7.16 }, null, client),
    ).rejects.toThrow();
    await expect(upsertFxRate({ currency: 'USD', effectiveFrom: '2026-08-05', rate: 0 }, null, client)).rejects.toThrow();
    await expect(upsertFxRate({ currency: 'USD', effectiveFrom: '2026-08-05', rate: -1 }, null, client)).rejects.toThrow();
    await expect(
      upsertFxRate({ currency: 'USD', effectiveFrom: '2026/08/05', rate: 7.16 }, null, client),
    ).rejects.toThrow();
    await expect(
      upsertFxRate({ currency: 'EUR' as FxCurrency, effectiveFrom: '2026-08-05', rate: 7.16 }, null, client),
    ).rejects.toThrow();
    expect(findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('listFxRates', () => {
  it('按币种、名称（通用行最后）、同名称生效日倒序下发序列化 DTO', async () => {
    const client = fakeClient([
      rateRow('2026-07-01', 7.05),
      rateRow('2026-08-05', 7.16),
      rateRow('2026-06-01', 7.0856, 'B公司'),
      rateRow('2026-09-01', 7.1, 'B公司'),
      rateRow('2026-01-01', 7.2, 'A公司'),
      rateRow('2026-01-01', 3740, '酒店越南盾', 'VND'),
    ]);
    const rows = await listFxRates(client);
    expect(rows.map((r) => `${r.currency}:${r.name ?? '通用'}@${r.effectiveFrom}`)).toEqual([
      'USD:A公司@2026-01-01',
      'USD:B公司@2026-09-01',
      'USD:B公司@2026-06-01',
      'USD:通用@2026-08-05',
      'USD:通用@2026-07-01',
      'VND:酒店越南盾@2026-01-01',
    ]);
    expect(rows[0]).toMatchObject({ name: 'A公司', currency: 'USD', rate: 7.2, updatedBy: 'finance-1' });
    const findMany = (client as unknown as { fxRate: { findMany: ReturnType<typeof vi.fn> } }).fxRate.findMany;
    expect(findMany.mock.calls[0][0].orderBy).toEqual([
      { currency: 'asc' },
      { name: { sort: 'asc', nulls: 'last' } },
      { effectiveFrom: 'desc' },
    ]);
  });
});

describe('listFxSupplierOptions / listFxNameOptions — 名称候选', () => {
  function optionsClient(existingFxNames: Array<{ name: string | null; currency: string }>) {
    return {
      visa: {
        findMany: vi.fn().mockResolvedValue([{ supplier: '乙公司' }, { supplier: ' 甲公司 ' }, { supplier: '   ' }]),
      },
      fulfillmentTask: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ visaSupplier: '甲公司' }, { visaSupplier: '31.5美金' }, { visaSupplier: '丙公司' }]),
      },
      fxRate: { findMany: vi.fn().mockResolvedValue(existingFxNames) },
    } as unknown as PrismaClient;
  }

  it('签证供应商候选：产品供应商 ∪ 任务签证公司，去重 + trim + 剔除空值与金额型脏值，按中文排序', async () => {
    const client = optionsClient([]);
    const names = await listFxSupplierOptions(client);
    expect(names).toEqual(['丙公司', '甲公司', '乙公司'].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
    expect(names).not.toContain('31.5美金');
    const taskFindMany = (client as unknown as { fulfillmentTask: { findMany: ReturnType<typeof vi.fn> } })
      .fulfillmentTask.findMany;
    expect(taskFindMany.mock.calls[0][0].where).toMatchObject({ type: 'VISA_APPLICATION' });
  });

  it('按币种：USD = 签证供应商 ∪ 表里已有 USD 名称；VND = 酒店/车队越南盾建议项 ∪ 表里已有 VND 名称', async () => {
    const options = await listFxNameOptions(
      optionsClient([
        { name: '丁公司', currency: 'USD' },
        { name: '地接越南盾', currency: 'VND' },
        { name: '酒店越南盾', currency: 'VND' },
      ]),
    );
    expect(options.USD).toEqual(expect.arrayContaining(['甲公司', '乙公司', '丙公司', '丁公司']));
    expect(options.USD).not.toContain('酒店越南盾');
    expect(options.VND).toEqual(expect.arrayContaining(['酒店越南盾', '车队越南盾', '地接越南盾']));
    expect(new Set(options.VND).size).toBe(options.VND.length);
    expect(options.VND).not.toContain('甲公司');
  });
});
