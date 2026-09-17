/**
 * 订单号发号器 · 真 DB 集成测试（vitest）
 *
 * 覆盖单测（mock Prisma）验证不了的东西：
 *   (a) 同一业务日并发发号，全部不重复且正好连号 1..N（ON CONFLICT DO UPDATE 的原子性）。
 *   (b) 不同业务日各自从 00001 起。
 *   (c) 在事务里发号、事务回滚 → 序号不烧掉。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { prisma } from '../../db/prisma.js';
import { generateOrderNumber } from './order-number.js';

const NOON_0917 = new Date('2026-09-17T04:00:00Z'); // 北京 12:00

describe('generateOrderNumber（真 DB）', () => {
  it('同一业务日并发发 200 个号：全部不重复且连号', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 200 }, () => generateOrderNumber(prisma, NOON_0917)),
    );
    expect(new Set(numbers).size).toBe(200);
    expect(numbers.every((n) => /^FTM20260917\d{5}$/.test(n))).toBe(true);
    const seqs = numbers.map((n) => Number(n.slice(-5))).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });

  it('不同业务日各自从 00001 起', async () => {
    expect(await generateOrderNumber(prisma, NOON_0917)).toBe('FTM2026091700001');
    expect(await generateOrderNumber(prisma, NOON_0917)).toBe('FTM2026091700002');
    expect(await generateOrderNumber(prisma, new Date('2026-09-18T04:00:00Z'))).toBe('FTM2026091800001');
  });

  it('事务回滚不烧号', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await generateOrderNumber(tx, NOON_0917);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await generateOrderNumber(prisma, NOON_0917)).toBe('FTM2026091700001');
  });
});
