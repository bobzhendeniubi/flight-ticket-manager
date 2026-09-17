import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryRaw } = vi.hoisted(() => ({ mockQueryRaw: vi.fn() }));

vi.mock('../../db/prisma.js', () => ({
  prisma: { $queryRaw: mockQueryRaw },
}));

import { generateOrderNumber, permuteSeq } from './order-number.js';

/** 把 $queryRaw 收到的模板串与参数摊平成可读 SQL。 */
function flatten(call: unknown[]): { text: string; values: unknown[] } {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return { text: strings.join('?').replace(/\s+/g, ' ').trim(), values };
}

/** 计数器按 SQL 分流：INSERT 发序号（依次），SELECT 按 takenNumbers 答「已占」。 */
function installCounter(seqs: number[], takenNumbers: string[] = []) {
  const queue = [...seqs];
  mockQueryRaw.mockImplementation(async (...call: unknown[]) => {
    const { text, values } = flatten(call);
    if (text.startsWith('INSERT INTO "OrderNumberCounter"')) {
      const seq = queue.shift();
      return seq === undefined ? [] : [{ nextSeq: seq }];
    }
    if (text.startsWith('SELECT 1 AS one FROM "Order"')) {
      return takenNumbers.includes(String(values[0])) ? [{ one: 1 }] : [];
    }
    throw new Error(`unexpected sql: ${text}`);
  });
}

const NOON_0917 = new Date('2026-09-17T04:00:00Z');

describe('permuteSeq（序号 → 后缀的固定置换）', () => {
  it('0..99999 上是双射', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 100000; i++) {
      const y = permuteSeq(i);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(100000);
      seen.add(y);
    }
    expect(seen.size).toBe(100000);
  });

  it('排列固定（改常量会换一套号，这里钉住前三个）', () => {
    expect([permuteSeq(1), permuteSeq(2), permuteSeq(3)]).toEqual([64192, 54063, 72116]);
  });

  it('连号之间不是等差（看不出当天第几单）', () => {
    const diffs = Array.from({ length: 20 }, (_, i) => permuteSeq(i + 2) - permuteSeq(i + 1));
    expect(new Set(diffs).size).toBeGreaterThan(10);
  });

  it('越界抛错', () => {
    expect(() => permuteSeq(-1)).toThrow(RangeError);
    expect(() => permuteSeq(100000)).toThrow(RangeError);
    expect(() => permuteSeq(1.5)).toThrow(RangeError);
  });
});

describe('generateOrderNumber', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('按北京业务日 + 置换后的 5 位后缀拼单号', async () => {
    installCounter([1]);
    // 2026-09-16 17:30 UTC = 北京 09-17 01:30 → 业务日是 17 号，不是 UTC 的 16 号
    const no = await generateOrderNumber(undefined, new Date('2026-09-16T17:30:00Z'));
    expect(no).toBe('FTM2026091764192');
  });

  it('后缀不足 5 位时左补零，恒为 FTM + 13 位数字', async () => {
    const small = Array.from({ length: 100000 }, (_, i) => i).find((i) => i > 0 && permuteSeq(i) < 10000)!;
    installCounter([small]);
    const no = await generateOrderNumber(undefined, NOON_0917);
    expect(no).toBe(`FTM20260917${String(permuteSeq(small)).padStart(5, '0')}`);
    expect(no).toMatch(/^FTM\d{13}$/);
  });

  it('用一条 INSERT … ON CONFLICT DO UPDATE … RETURNING 原子自增，业务日作参数；再查一次是否已占', async () => {
    installCounter([1]);
    await generateOrderNumber(undefined, NOON_0917);
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    const insert = flatten(mockQueryRaw.mock.calls[0] as unknown[]);
    expect(insert.text).toContain('INSERT INTO "OrderNumberCounter"');
    expect(insert.text).toContain('ON CONFLICT ("businessDate") DO UPDATE SET "nextSeq" = "OrderNumberCounter"."nextSeq" + 1');
    expect(insert.text).toContain('RETURNING "nextSeq"');
    expect(insert.values).toEqual(['2026-09-17']);
    const check = flatten(mockQueryRaw.mock.calls[1] as unknown[]);
    expect(check.text).toContain('FROM "Order" WHERE "orderNumber" = ?');
    expect(check.values).toEqual(['FTM2026091764192']);
  });

  it('候选号已被存量单占用 → 顺延下一个序号', async () => {
    installCounter([1, 2], ['FTM2026091764192']);
    const no = await generateOrderNumber(undefined, NOON_0917);
    expect(no).toBe('FTM2026091754063');
  });

  it('连续 8 个候选号都被占 → 抛错', async () => {
    const seqs = Array.from({ length: 9 }, (_, i) => i + 1);
    const taken = seqs.map((s) => `FTM20260917${String(permuteSeq(s)).padStart(5, '0')}`);
    installCounter(seqs, taken);
    await expect(generateOrderNumber(undefined, NOON_0917)).rejects.toThrow('连续 8 个候选号都已被占用');
  });

  it('传入事务客户端时用它发号，不碰全局 prisma', async () => {
    const txQueryRaw = vi.fn(async (...call: unknown[]) => {
      const { text } = flatten(call);
      return text.startsWith('INSERT') ? [{ nextSeq: 3 }] : [];
    });
    const no = await generateOrderNumber({ $queryRaw: txQueryRaw } as never, NOON_0917);
    expect(no).toBe('FTM2026091772116');
    expect(txQueryRaw).toHaveBeenCalledTimes(2);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('序号超过 99999 时抛错而不是生成越界单号', async () => {
    installCounter([100000]);
    await expect(generateOrderNumber(undefined, NOON_0917)).rejects.toThrow('序号已超过 99999');
  });

  it('计数器没返回行时抛错', async () => {
    installCounter([]);
    await expect(generateOrderNumber(undefined, NOON_0917)).rejects.toThrow('没有返回序号');
  });
});
