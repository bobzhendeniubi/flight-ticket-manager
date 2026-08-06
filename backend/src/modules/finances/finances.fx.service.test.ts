/**
 * 美金汇率表 service · 单元测试（vitest）
 *
 * 用注入式 fake PrismaClient（service 函数都收 client 参数）驱动，不依赖真 DB。
 * findFirst 的 fake **真的按 lte + orderBy desc 过滤**，这样「≤date 取最新一条」的
 * 取数边界（同日 / 早于最早一条 / 多条取最新）测的是口径本身，不是 mock 的返回值。
 *   · ymdToUtcDate / utcDateToYmd：UTC 口径对称，非法输入拒绝。
 *   · getUsdFxRate：同日命中、跨日沿用、早于最早一条 → null、多条取最新。
 *   · upsertUsdFxRate：按 effectiveFrom 幂等（create/update 同值）、汇率必须 > 0。
 *   · listUsdFxRates：按生效日倒序下发序列化 DTO。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  getUsdFxRate,
  listUsdFxRates,
  upsertUsdFxRate,
  utcDateToYmd,
  ymdToUtcDate,
} from './finances.fx.service.js';

function rateRow(effectiveFrom: string, rate: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `fx-${effectiveFrom}`,
    effectiveFrom: ymdToUtcDate(effectiveFrom),
    rate,
    note: null,
    updatedBy: 'finance-1',
    updatedAt: new Date('2026-08-05T03:00:00.000Z'),
    ...overrides,
  };
}

/**
 * fake client：按 where.effectiveFrom.lte + orderBy effectiveFrom desc 真过滤，
 * 让「≤目标日期的最新一条」这条口径被真正验证。
 */
function fakeClient(rows: ReturnType<typeof rateRow>[]): PrismaClient {
  return {
    usdFxRate: {
      findFirst: vi.fn(({ where }: { where: { effectiveFrom: { lte: Date } } }) => {
        const hit = rows
          .filter((r) => r.effectiveFrom.getTime() <= where.effectiveFrom.lte.getTime())
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
        return Promise.resolve(hit ?? null);
      }),
      findMany: vi.fn(() =>
        Promise.resolve(
          [...rows].sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime()),
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

describe('getUsdFxRate — 「生效日 ≤ 目标日期的最新一条」', () => {
  const rows = [rateRow('2026-07-01', 7.05), rateRow('2026-08-05', 7.16)];

  it('目标日期 = 生效日当天 → 命中该条（边界含端点）', async () => {
    const dto = await getUsdFxRate('2026-08-05', fakeClient(rows));
    expect(dto).toMatchObject({ effectiveFrom: '2026-08-05', rate: 7.16 });
  });

  it('目标日期晚于生效日 → 沿用该条（区间由下一条隐含，无需结束日）', async () => {
    const dto = await getUsdFxRate('2026-09-30', fakeClient(rows));
    expect(dto).toMatchObject({ effectiveFrom: '2026-08-05', rate: 7.16 });
  });

  it('目标日期落在两条之间 → 取较早那条（而非最新那条）', async () => {
    const dto = await getUsdFxRate('2026-08-04', fakeClient(rows));
    expect(dto).toMatchObject({ effectiveFrom: '2026-07-01', rate: 7.05 });
  });

  it('目标日期早于最早一条 → null（不臆造汇率，前端让用户手填）', async () => {
    const dto = await getUsdFxRate('2026-06-30', fakeClient(rows));
    expect(dto).toBeNull();
  });

  it('表为空 → null', async () => {
    const dto = await getUsdFxRate('2026-08-05', fakeClient([]));
    expect(dto).toBeNull();
  });

  it('多条同时 ≤ 目标日期 → 取生效日最新的那条', async () => {
    const many = [
      rateRow('2026-06-01', 7.0),
      rateRow('2026-07-01', 7.05),
      rateRow('2026-08-05', 7.16),
    ];
    const dto = await getUsdFxRate('2026-12-31', fakeClient(many));
    expect(dto).toMatchObject({ effectiveFrom: '2026-08-05', rate: 7.16 });
  });

  it('查询按 UTC date-only 下发（不经本地时区挪日）', async () => {
    const client = fakeClient(rows);
    await getUsdFxRate('2026-08-05', client);
    const findFirst = (client as unknown as { usdFxRate: { findFirst: ReturnType<typeof vi.fn> } })
      .usdFxRate.findFirst;
    const arg = findFirst.mock.calls[0][0];
    expect(arg.where.effectiveFrom.lte.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    expect(arg.orderBy).toEqual({ effectiveFrom: 'desc' });
  });
});

describe('upsertUsdFxRate — 按生效日幂等', () => {
  it('同一生效日重复提交只覆盖不新增（唯一键 effectiveFrom，create/update 同值）', async () => {
    const upsert = vi
      .fn()
      .mockImplementation(({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve(
          rateRow('2026-08-05', create.rate as number, {
            note: create.note,
            updatedBy: create.updatedBy,
          }),
        ),
      );
    const client = { usdFxRate: { upsert } } as unknown as PrismaClient;

    const first = await upsertUsdFxRate(
      { effectiveFrom: '2026-08-05', rate: 7.16, note: '月初挂牌' },
      'finance-1',
      client,
    );
    const second = await upsertUsdFxRate(
      { effectiveFrom: '2026-08-05', rate: 7.16, note: '月初挂牌' },
      'finance-1',
      client,
    );

    expect(first).toEqual(second);
    // 幂等键 = 生效日（UTC 零点）；create/update 写同一组值，重复提交无副作用差异
    const arg = upsert.mock.calls[0][0];
    expect(arg.where.effectiveFrom.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    expect(arg.create).toMatchObject({ rate: 7.16, note: '月初挂牌', updatedBy: 'finance-1' });
    expect(arg.update).toMatchObject({ rate: 7.16, note: '月初挂牌', updatedBy: 'finance-1' });
  });

  it('note 缺省归一化为 null', async () => {
    const upsert = vi.fn().mockResolvedValue(rateRow('2026-08-05', 7.16));
    const client = { usdFxRate: { upsert } } as unknown as PrismaClient;
    await upsertUsdFxRate({ effectiveFrom: '2026-08-05', rate: 7.16 }, null, client);
    expect(upsert.mock.calls[0][0].create.note).toBeNull();
    expect(upsert.mock.calls[0][0].update.note).toBeNull();
  });

  it('汇率 ≤ 0 → 拒绝（不写库）', async () => {
    const upsert = vi.fn();
    const client = { usdFxRate: { upsert } } as unknown as PrismaClient;
    await expect(
      upsertUsdFxRate({ effectiveFrom: '2026-08-05', rate: 0 }, null, client),
    ).rejects.toThrow();
    await expect(
      upsertUsdFxRate({ effectiveFrom: '2026-08-05', rate: -1 }, null, client),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('非法生效日 → 拒绝（不写库）', async () => {
    const upsert = vi.fn();
    const client = { usdFxRate: { upsert } } as unknown as PrismaClient;
    await expect(
      upsertUsdFxRate({ effectiveFrom: '2026/08/05', rate: 7.16 }, null, client),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('listUsdFxRates', () => {
  it('按生效日倒序下发序列化 DTO（最近生效的排最前）', async () => {
    const rows = await listUsdFxRates(
      fakeClient([rateRow('2026-07-01', 7.05), rateRow('2026-08-05', 7.16)]),
    );
    expect(rows.map((r) => r.effectiveFrom)).toEqual(['2026-08-05', '2026-07-01']);
    expect(rows[0]).toMatchObject({ rate: 7.16, updatedBy: 'finance-1' });
  });
});
