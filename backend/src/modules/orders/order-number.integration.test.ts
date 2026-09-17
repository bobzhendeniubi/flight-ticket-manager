/**
 * 订单号发号器 · 真 DB 集成测试（vitest）
 *
 * 覆盖单测（mock Prisma）验证不了的东西：
 *   (a) 同一业务日并发发号，全部不重复，且正好是序号 1..N 过置换后的那一组（ON CONFLICT DO UPDATE 的原子性）。
 *   (b) 不同业务日各自从序号 1 起。
 *   (c) 在事务里发号、事务回滚 → 序号不烧掉。
 *   (d) 候选号撞上存量单（切换当天的旧随机号）→ 顺延到下一个序号。
 *   (e) 占位转正建单在调用方事务里发号：事务回滚后计数器没被动过（证明走的是 tx 不是全局 prisma）。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { CabinClass, HoldOwnerType, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { businessDateISO } from '../../lib/business-time.js';
import { OrderService } from './orders.service.js';
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

describe('占位转正建单在调用方事务里发号（真 DB）', () => {
  const service = new OrderService();

  async function holdFixture() {
    const user = await prisma.user.create({
      data: { email: `hold-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`, role: UserRole.STAFF },
    });
    const flight = await prisma.flight.create({
      data: { flightNumber: `TEST${Math.floor(Math.random() * 10000)}`, originCode: 'MFM', destinationCode: 'DAD', isActive: true },
    });
    const departureTime = new Date(Date.now() + 100 * 3600 * 1000);
    const schedule = await prisma.flightSchedule.create({
      data: {
        flightId: flight.id,
        departureTime,
        arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
        departureTz: 'Asia/Macau',
        arrivalTz: 'Asia/Ho_Chi_Minh',
        isActive: true,
      },
    });
    const seatClass = await prisma.flightSeatClass.create({
      data: { scheduleId: schedule.id, cabin: CabinClass.ECONOMY, capacity: 5, basePrice: new Prisma.Decimal(1000) },
    });
    const hold = await prisma.holdOrder.create({
      data: {
        holdNo: `H${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        flightScheduleId: schedule.id,
        seatClassId: seatClass.id,
        ownerType: HoldOwnerType.CUSTOMER,
        seats: 2,
        perSeatPriceCny: 1000,
        createdById: user.id,
      },
    });
    return { user, schedule, hold };
  }

  function conversionInput(fx: Awaited<ReturnType<typeof holdFixture>>, tag: string) {
    return {
      holdOrderId: fx.hold.id,
      holdNo: fx.hold.holdNo,
      flightScheduleId: fx.schedule.id,
      cabin: CabinClass.ECONOMY,
      quantity: 1,
      unitPriceCny: 1000,
      passengers: [
        {
          fullName: `HOLD PAX ${tag}`,
          documentType: 'PASSPORT' as const,
          documentNumber: `HP${tag}${Date.now()}`,
          dateOfBirth: '1990-01-01',
          nationality: 'CN',
          passengerType: 'ADULT' as const,
        },
      ],
      contactName: '转正测试',
      contactPhone: '13800138000',
      actorUserId: fx.user.id,
    };
  }

  it('(e) 事务回滚 → 计数器没被动过；提交 → 单号是当天序号 1 的置换值', async () => {
    const fx = await holdFixture();
    await expect(
      prisma.$transaction(async (tx) => {
        await service.createHoldConversionOrderWithinTx(tx, conversionInput(fx, 'A'));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    // 走的是 tx：发号随事务一起回滚，计数器一行都没有。走全局 prisma 的话这里会留下 nextSeq=1。
    expect(await prisma.orderNumberCounter.findMany()).toEqual([]);

    const created = await prisma.$transaction((tx) =>
      service.createHoldConversionOrderWithinTx(tx, conversionInput(fx, 'B')),
    );
    const today = businessDateISO(new Date()).replaceAll('-', '');
    expect(created.order.orderNumber).toBe(numberFor(today, 1));
    expect(await prisma.orderNumberCounter.findMany()).toMatchObject([{ nextSeq: 1 }]);
  });
});
