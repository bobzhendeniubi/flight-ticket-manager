import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryRaw } = vi.hoisted(() => ({ mockQueryRaw: vi.fn() }));

vi.mock('../../db/prisma.js', () => ({
  prisma: { $queryRaw: mockQueryRaw },
}));

import { generateOrderNumber } from './order-number.js';

/** 把 $queryRaw 收到的模板串与参数摊平成可读 SQL（只为断言）。 */
function lastSql(fn: ReturnType<typeof vi.fn>): { text: string; values: unknown[] } {
  const call = fn.mock.calls.at(-1) as unknown[] | undefined;
  if (!call) throw new Error('no call');
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return { text: strings.join('?').replace(/\s+/g, ' ').trim(), values };
}

describe('generateOrderNumber', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('按北京业务日 + 5 位零填充序号拼单号', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ nextSeq: 57 }]);
    // 2026-09-16 17:30 UTC = 北京 09-17 01:30 → 业务日是 17 号，不是 UTC 的 16 号
    const no = await generateOrderNumber(undefined, new Date('2026-09-16T17:30:00Z'));
    expect(no).toBe('FTM2026091700057');
  });

  it('序号顶到 99999 仍是 13 位数字', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ nextSeq: 99999 }]);
    const no = await generateOrderNumber(undefined, new Date('2026-09-17T04:00:00Z'));
    expect(no).toBe('FTM2026091799999');
    expect(no).toMatch(/^FTM\d{13}$/);
  });

  it('用一条 INSERT … ON CONFLICT DO UPDATE … RETURNING 原子自增，业务日作参数', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ nextSeq: 1 }]);
    await generateOrderNumber(undefined, new Date('2026-09-17T04:00:00Z'));
    const { text, values } = lastSql(mockQueryRaw);
    expect(text).toContain('INSERT INTO "OrderNumberCounter"');
    expect(text).toContain('ON CONFLICT ("businessDate") DO UPDATE SET "nextSeq" = "OrderNumberCounter"."nextSeq" + 1');
    expect(text).toContain('RETURNING "nextSeq"');
    expect(values).toEqual(['2026-09-17']);
  });

  it('传入事务客户端时用它发号，不碰全局 prisma', async () => {
    const txQueryRaw = vi.fn().mockResolvedValueOnce([{ nextSeq: 3 }]);
    const no = await generateOrderNumber({ $queryRaw: txQueryRaw } as never, new Date('2026-09-17T04:00:00Z'));
    expect(no).toBe('FTM2026091700003');
    expect(txQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('序号超过 99999 时抛错而不是生成 14 位单号', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ nextSeq: 100000 }]);
    await expect(generateOrderNumber(undefined, new Date('2026-09-17T04:00:00Z'))).rejects.toThrow('序号已超过 99999');
  });

  it('计数器没返回行时抛错', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await expect(generateOrderNumber(undefined, new Date('2026-09-17T04:00:00Z'))).rejects.toThrow('没有返回序号');
  });
});
