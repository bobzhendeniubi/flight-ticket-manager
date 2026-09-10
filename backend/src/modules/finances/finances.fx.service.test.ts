/**
 * 美金汇率表 service · 单元测试（vitest）
 *
 * 用注入式 fake PrismaClient（service 函数都收 client 参数）驱动，不依赖真 DB。
 * findFirst 的 fake **真的按 supplier 等值 + lte + orderBy desc 过滤**，这样「先公司、再通用、
 * ≤date 取最新一条」的取数边界（同日 / 早于最早一条 / 多条取最新 / 公司回落）测的是口径本身，
 * 不是 mock 的返回值。
 *   · ymdToUtcDate / utcDateToYmd：UTC 口径对称，非法输入拒绝。
 *   · getUsdFxRate：公司优先 / 回落通用 / 公司名 trim / 无公司只看通用 / 同日命中 / 跨日沿用 /
 *     早于最早一条 → null / 多条取最新。
 *   · upsertUsdFxRate：按（公司 × 生效日）幂等（先查后写：有则 update、无则 create）、汇率必须 > 0、
 *     公司名 trim + 空串→通用、公司格填成金额拒绝。
 *   · listUsdFxRates：按公司（通用行最后）、同公司生效日倒序下发序列化 DTO。
 *   · listFxSupplierOptions：产品供应商 ∪ 任务签证公司，去重 + trim + 剔除金额型脏值。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  getUsdFxRate,
  listFxSupplierOptions,
  listUsdFxRates,
  normalizeFxSupplier,
  upsertUsdFxRate,
  utcDateToYmd,
  ymdToUtcDate,
} from './finances.fx.service.js';

function rateRow(
  effectiveFrom: string,
  rate: number,
  supplier: string | null = null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `fx-${supplier ?? 'generic'}-${effectiveFrom}`,
    supplier,
    effectiveFrom: ymdToUtcDate(effectiveFrom),
    rate,
    note: null,
    updatedBy: 'finance-1',
    updatedAt: new Date('2026-08-05T03:00:00.000Z'),
    ...overrides,
  };
}

type Row = ReturnType<typeof rateRow>;

/**
 * fake client：按 where.supplier 等值（null 即通用行）+ where.effectiveFrom.lte + orderBy desc 真过滤，
 * 让「先公司、再通用、≤目标日期的最新一条」这条口径被真正验证。
 */
function fakeClient(rows: Row[]): PrismaClient {
  return {
    usdFxRate: {
      findFirst: vi.fn(
        ({ where }: { where: { supplier: string | null; effectiveFrom: { lte: Date } } }) => {
          const hit = rows
            .filter((r) => r.supplier === where.supplier)
            .filter((r) => r.effectiveFrom.getTime() <= where.effectiveFrom.lte.getTime())
            .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
          return Promise.resolve(hit ?? null);
        },
      ),
      findMany: vi.fn(() =>
        Promise.resolve(
          [...rows].sort((a, b) => {
            if (a.supplier !== b.supplier) {
              if (a.supplier == null) return 1;
              if (b.supplier == null) return -1;
              return a.supplier.localeCompare(b.supplier);
            }
            return b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
          }),
        ),
      ),
    },
  } as unknown as PrismaClient;
}

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

describe('normalizeFxSupplier — 公司名 trim，空即通用', () => {
  it('trim 后原样；空串 / 空白 / undefined / null → null', () => {
    expect(normalizeFxSupplier('  甲公司 ')).toBe('甲公司');
    expect(normalizeFxSupplier('')).toBeNull();
    expect(normalizeFxSupplier('   ')).toBeNull();
    expect(normalizeFxSupplier(undefined)).toBeNull();
    expect(normalizeFxSupplier(null)).toBeNull();
  });
});

describe('getUsdFxRate — 先公司、再通用、「生效日 ≤ 目标日期的最新一条」', () => {
  const generic = [rateRow('2026-07-01', 7.05), rateRow('2026-08-05', 7.16)];
  const withSuppliers = [
    ...generic,
    rateRow('2026-01-01', 7.2, '甲公司'),
    rateRow('2026-06-01', 7.0856, '乙公司'),
    rateRow('2026-09-01', 7.1, '乙公司'),
  ];

  it('公司有自己的汇率 → 用公司行，不看通用行（即使通用行生效日更晚）', async () => {
    const dto = await getUsdFxRate('2026-09-09', '甲公司', fakeClient(withSuppliers));
    expect(dto).toMatchObject({ supplier: '甲公司', effectiveFrom: '2026-01-01', rate: 7.2 });
  });

  it('公司多条 → 取该公司 ≤date 的最新一条', async () => {
    const before = await getUsdFxRate('2026-08-31', '乙公司', fakeClient(withSuppliers));
    expect(before).toMatchObject({ supplier: '乙公司', effectiveFrom: '2026-06-01', rate: 7.0856 });
    const after = await getUsdFxRate('2026-09-01', '乙公司', fakeClient(withSuppliers));
    expect(after).toMatchObject({ supplier: '乙公司', effectiveFrom: '2026-09-01', rate: 7.1 });
  });

  it('公司没有任何 ≤date 的记录 → 回落通用行（DTO.supplier 为 null 标明是回落）', async () => {
    const unknown = await getUsdFxRate('2026-09-09', '丙公司', fakeClient(withSuppliers));
    expect(unknown).toMatchObject({ supplier: null, effectiveFrom: '2026-08-05', rate: 7.16 });
    // 公司行存在但都晚于目标日 → 同样回落通用
    const laterOnly = [...withSuppliers, rateRow('2026-10-01', 7.3, '丁公司')];
    const tooEarly = await getUsdFxRate('2026-09-09', '丁公司', fakeClient(laterOnly));
    expect(tooEarly).toMatchObject({ supplier: null, effectiveFrom: '2026-08-05', rate: 7.16 });
  });

  it('公司名 trim 后精确匹配（前后空白不影响命中；不同名不命中）', async () => {
    const trimmed = await getUsdFxRate('2026-09-09', '  甲公司 ', fakeClient(withSuppliers));
    expect(trimmed).toMatchObject({ supplier: '甲公司', rate: 7.2 });
    const other = await getUsdFxRate('2026-09-09', '甲公司分部', fakeClient(withSuppliers));
    expect(other).toMatchObject({ supplier: null, rate: 7.16 });
  });

  it('无公司（null / 空串 / 空白）→ 只看通用行，且不发公司查询', async () => {
    for (const supplier of [null, undefined, '', '   ']) {
      const client = fakeClient(withSuppliers);
      const dto = await getUsdFxRate('2026-09-09', supplier, client);
      expect(dto).toMatchObject({ supplier: null, effectiveFrom: '2026-08-05', rate: 7.16 });
      const findFirst = (client as unknown as { usdFxRate: { findFirst: ReturnType<typeof vi.fn> } })
        .usdFxRate.findFirst;
      expect(findFirst).toHaveBeenCalledTimes(1);
      expect(findFirst.mock.calls[0][0].where.supplier).toBeNull();
    }
  });

  it('公司与通用都没有 → null（不臆造汇率）', async () => {
    const onlyOthers = [rateRow('2026-01-01', 7.2, '甲公司')];
    expect(await getUsdFxRate('2026-09-09', '乙公司', fakeClient(onlyOthers))).toBeNull();
    expect(await getUsdFxRate('2026-09-09', null, fakeClient(onlyOthers))).toBeNull();
    expect(await getUsdFxRate('2026-08-05', null, fakeClient([]))).toBeNull();
  });

  it('目标日期 = 生效日当天 → 命中该条（边界含端点）', async () => {
    const dto = await getUsdFxRate('2026-08-05', null, fakeClient(generic));
    expect(dto).toMatchObject({ effectiveFrom: '2026-08-05', rate: 7.16 });
  });

  it('目标日期晚于生效日 → 沿用该条（区间由下一条隐含，无需结束日）', async () => {
    const dto = await getUsdFxRate('2026-09-30', null, fakeClient(generic));
    expect(dto).toMatchObject({ effectiveFrom: '2026-08-05', rate: 7.16 });
  });

  it('目标日期落在两条之间 → 取较早那条（而非最新那条）', async () => {
    const dto = await getUsdFxRate('2026-08-04', null, fakeClient(generic));
    expect(dto).toMatchObject({ effectiveFrom: '2026-07-01', rate: 7.05 });
  });

  it('目标日期早于最早一条 → null', async () => {
    const dto = await getUsdFxRate('2026-06-30', null, fakeClient(generic));
    expect(dto).toBeNull();
  });

  it('查询按 UTC date-only 下发（不经本地时区挪日），公司查询先于通用查询', async () => {
    const client = fakeClient(withSuppliers);
    await getUsdFxRate('2026-08-05', '丙公司', client);
    const findFirst = (client as unknown as { usdFxRate: { findFirst: ReturnType<typeof vi.fn> } })
      .usdFxRate.findFirst;
    expect(findFirst).toHaveBeenCalledTimes(2);
    const [own, generic2] = findFirst.mock.calls.map((c) => c[0]);
    expect(own.where.supplier).toBe('丙公司');
    expect(own.where.effectiveFrom.lte.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    expect(own.orderBy).toEqual({ effectiveFrom: 'desc' });
    expect(generic2.where.supplier).toBeNull();
  });
});

describe('upsertUsdFxRate — 按（公司 × 生效日）幂等', () => {
  function writableClient(existing: Row | null) {
    const findFirst = vi.fn().mockResolvedValue(existing ? { id: existing.id } : null);
    const update = vi
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...(existing as Row), ...data }),
      );
    const create = vi
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(
          rateRow(
            utcDateToYmd(data.effectiveFrom as Date),
            data.rate as number,
            (data.supplier as string | null) ?? null,
            { note: data.note, updatedBy: data.updatedBy },
          ),
        ),
      );
    const client = { usdFxRate: { findFirst, update, create } } as unknown as PrismaClient;
    return { client, findFirst, update, create };
  }

  it('同公司同生效日已有 → update 不 create（幂等键 = 公司 × UTC 零点生效日）', async () => {
    const existing = rateRow('2026-08-05', 7.1, '甲公司');
    const { client, findFirst, update, create } = writableClient(existing);
    const dto = await upsertUsdFxRate(
      { supplier: '甲公司', effectiveFrom: '2026-08-05', rate: 7.2, note: '月初挂牌' },
      'finance-1',
      client,
    );
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ supplier: '甲公司' });
    expect(findFirst.mock.calls[0][0].where.effectiveFrom.toISOString()).toBe(
      '2026-08-05T00:00:00.000Z',
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: { rate: 7.2, note: '月初挂牌', updatedBy: 'finance-1' },
    });
    expect(create).not.toHaveBeenCalled();
    expect(dto).toMatchObject({ supplier: '甲公司', effectiveFrom: '2026-08-05', rate: 7.2 });
  });

  it('没有 → create，公司名 trim 后落库', async () => {
    const { client, update, create } = writableClient(null);
    const dto = await upsertUsdFxRate(
      { supplier: '  甲公司 ', effectiveFrom: '2026-08-05', rate: 7.2 },
      'finance-1',
      client,
    );
    expect(update).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data).toMatchObject({
      supplier: '甲公司',
      rate: 7.2,
      note: null,
      updatedBy: 'finance-1',
    });
    expect(dto.supplier).toBe('甲公司');
  });

  it('公司留空 / 空白 / 缺省 → 通用行（supplier null），同日通用行已有则覆盖', async () => {
    for (const supplier of [undefined, null, '', '  ']) {
      const { client, findFirst, create } = writableClient(null);
      await upsertUsdFxRate({ supplier, effectiveFrom: '2026-08-05', rate: 7.16 }, null, client);
      expect(findFirst.mock.calls[0][0].where.supplier).toBeNull();
      expect(create.mock.calls[0][0].data.supplier).toBeNull();
    }
    const existingGeneric = rateRow('2026-08-05', 7.1);
    const { client, update, create } = writableClient(existingGeneric);
    await upsertUsdFxRate({ effectiveFrom: '2026-08-05', rate: 7.16 }, null, client);
    expect(update).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('note 缺省 / 空白归一化为 null', async () => {
    const { client, create } = writableClient(null);
    await upsertUsdFxRate({ effectiveFrom: '2026-08-05', rate: 7.16, note: '  ' }, null, client);
    expect(create.mock.calls[0][0].data.note).toBeNull();
  });

  it('公司格填成金额（「31.5美金」）→ 拒绝（不写库）', async () => {
    const { client, findFirst, create } = writableClient(null);
    await expect(
      upsertUsdFxRate({ supplier: '31.5美金', effectiveFrom: '2026-08-05', rate: 7.16 }, null, client),
    ).rejects.toThrow();
    expect(findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('汇率 ≤ 0 → 拒绝（不写库）', async () => {
    const { client, findFirst, create } = writableClient(null);
    await expect(
      upsertUsdFxRate({ effectiveFrom: '2026-08-05', rate: 0 }, null, client),
    ).rejects.toThrow();
    await expect(
      upsertUsdFxRate({ effectiveFrom: '2026-08-05', rate: -1 }, null, client),
    ).rejects.toThrow();
    expect(findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('非法生效日 → 拒绝（不写库）', async () => {
    const { client, create } = writableClient(null);
    await expect(
      upsertUsdFxRate({ effectiveFrom: '2026/08/05', rate: 7.16 }, null, client),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('listUsdFxRates', () => {
  it('按公司分组（通用行最后）、同公司生效日倒序下发序列化 DTO', async () => {
    const client = fakeClient([
      rateRow('2026-07-01', 7.05),
      rateRow('2026-08-05', 7.16),
      rateRow('2026-06-01', 7.0856, 'B公司'),
      rateRow('2026-09-01', 7.1, 'B公司'),
      rateRow('2026-01-01', 7.2, 'A公司'),
    ]);
    const rows = await listUsdFxRates(client);
    expect(rows.map((r) => `${r.supplier ?? '通用'}@${r.effectiveFrom}`)).toEqual([
      'A公司@2026-01-01',
      'B公司@2026-09-01',
      'B公司@2026-06-01',
      '通用@2026-08-05',
      '通用@2026-07-01',
    ]);
    expect(rows[0]).toMatchObject({ supplier: 'A公司', rate: 7.2, updatedBy: 'finance-1' });
    const findMany = (client as unknown as { usdFxRate: { findMany: ReturnType<typeof vi.fn> } })
      .usdFxRate.findMany;
    expect(findMany.mock.calls[0][0].orderBy).toEqual([
      { supplier: { sort: 'asc', nulls: 'last' } },
      { effectiveFrom: 'desc' },
    ]);
  });
});

describe('listFxSupplierOptions — 产品供应商 ∪ 任务签证公司', () => {
  it('去重 + trim + 剔除空值与金额型脏值，按中文排序', async () => {
    const client = {
      visa: {
        findMany: vi.fn().mockResolvedValue([
          { supplier: '乙公司' },
          { supplier: ' 甲公司 ' },
          { supplier: '   ' },
        ]),
      },
      fulfillmentTask: {
        findMany: vi.fn().mockResolvedValue([
          { visaSupplier: '甲公司' },
          { visaSupplier: '31.5美金' },
          { visaSupplier: '丙公司' },
        ]),
      },
    } as unknown as PrismaClient;
    const names = await listFxSupplierOptions(client);
    expect(names).toEqual(['丙公司', '甲公司', '乙公司'].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
    expect(names).not.toContain('31.5美金');
    const taskFindMany = (client as unknown as { fulfillmentTask: { findMany: ReturnType<typeof vi.fn> } })
      .fulfillmentTask.findMany;
    expect(taskFindMany.mock.calls[0][0].where).toMatchObject({ type: 'VISA_APPLICATION' });
  });
});
