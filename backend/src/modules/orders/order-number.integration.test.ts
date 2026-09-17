/**
 * 订单号发号器 · 真 DB 集成测试（vitest）
 *
 * 覆盖单测（mock Prisma）验证不了的东西：
 *   (a) 同一业务日并发发号，全部不重复，且正好是序号 1..N 过置换后的那一组（ON CONFLICT DO UPDATE 的原子性）。
 *   (b) 不同业务日各自从序号 1 起。
 *   (c) 在事务里发号、事务回滚 → 序号不烧掉。
 *   (d) 候选号撞上存量单（切换当天的旧随机号）→ 顺延到下一个序号。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { generateOrderNumber, permuteSeq } from './order-number.js';

const NOON_0917 = new Date('2026-09-17T04:00:00Z'); // 北京 12:00

function numberFor(datePart: string, seq: number): string {
  return `FTM${datePart}${String(permuteSeq(seq)).padStart(5, '0')}`;
}

describe('generateOrderNumber（真 DB）', () => {
  it('(a) 同一业务日并发发 200 个号：全部不重复，正好是序号 1..200 那一组', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 200 }, () => generateOrderNumber(prisma, NOON_0917)),
    );
    expect(new Set(numbers).size).toBe(200);
    expect(numbers.every((n) => /^FTM20260917\d{5}$/.test(n))).toBe(true);
    const expected = Array.from({ length: 200 }, (_, i) => numberFor('20260917', i + 1));
    expect([...numbers].sort()).toEqual([...expected].sort());
  });

  it('(b) 不同业务日各自从序号 1 起', async () => {
    expect(await generateOrderNumber(prisma, NOON_0917)).toBe(numberFor('20260917', 1));
    expect(await generateOrderNumber(prisma, NOON_0917)).toBe(numberFor('20260917', 2));
    expect(await generateOrderNumber(prisma, new Date('2026-09-18T04:00:00Z'))).toBe(numberFor('20260918', 1));
  });

  it('(c) 事务回滚不烧号', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await generateOrderNumber(tx, NOON_0917);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await generateOrderNumber(prisma, NOON_0917)).toBe(numberFor('20260917', 1));
  });

  it('(d) 候选号撞上存量单 → 顺延下一个序号', async () => {
    await prisma.order.create({
      data: {
        orderNumber: numberFor('20260917', 1),
        status: OrderStatus.PAID,
        subtotal: new Prisma.Decimal(1),
        total: new Prisma.Decimal(1),
        contactName: '旧随机号存量单',
        contactPhone: '13800138000',
      },
    });
    expect(await generateOrderNumber(prisma, NOON_0917)).toBe(numberFor('20260917', 2));
    const counter = await prisma.orderNumberCounter.findMany();
    expect(counter.map((c) => c.nextSeq)).toEqual([2]);
  });
});
