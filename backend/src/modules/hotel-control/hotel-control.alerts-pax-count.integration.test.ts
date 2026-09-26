/**
 * 房控提醒 · 班次超员的乘客计数 · 真 DB 集成测试
 *
 * getAlerts 的班次乘客数由「逐班次 passenger.count」改成一条按班次分组的聚合查询。
 * 本测试在真库上把两种算法摆在一起逐班比对，并覆盖口径里的每个分支：
 *   - 同一订单在同一班次有两条 FLIGHT 行 → 乘客只计一次；
 *   - 一张单同时有去程 / 回程两个班次 → 两个班次各计一次；
 *   - 已取消（不在 COUNTED_STATUSES）、已软删的订单不计；
 *   - 非 FLIGHT 行（套餐 / 酒店行）不因同单而被算进班次；
 *   - 一个乘客都没有的班次按 0 计（不报超员）。
 *
 * 跑：docker compose -f ../docker-compose.test.yml up -d && npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { CabinClass, OrderItemKind, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { COUNTED_STATUSES, getAlerts } from './hotel-control.service.js';

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 距今 hours 小时起飞的班次；舱位容量 0 → 只要有人就进超员列表，便于直接读出计数。*/
async function createSchedule(hoursFromNow: number) {
  const departureTime = new Date(Date.now() + hoursFromNow * 3600 * 1000);
  const flight = await prisma.flight.create({
    data: { flightNumber: uniq('T'), originCode: 'MFM', destinationCode: 'DAD', isActive: true },
  });
  return prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: 'Asia/Macau',
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
      seatClasses: {
        create: [{ cabin: CabinClass.ECONOMY, capacity: 0, sold: 0, basePrice: new Prisma.Decimal(1000) }],
      },
    },
    include: { flight: true },
  });
}

async function createOrder(opts: {
  status: OrderStatus;
  passengers: number;
  flightScheduleIds: string[];
  deleted?: boolean;
  withBundleRow?: boolean;
}) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('ORD'),
      status: opts.status,
      subtotal: new Prisma.Decimal(1000),
      total: new Prisma.Decimal(1000),
      contactName: 'Test User',
      contactPhone: '13800138000',
      deletedAt: opts.deleted ? new Date() : null,
      items: {
        create: [
          ...opts.flightScheduleIds.map((flightScheduleId) => ({
            kind: OrderItemKind.FLIGHT,
            description: '机票',
            quantity: opts.passengers,
            unitPrice: new Prisma.Decimal(500),
            amount: new Prisma.Decimal(500 * opts.passengers),
            flightScheduleId,
            flightCabin: CabinClass.ECONOMY,
          })),
          ...(opts.withBundleRow
            ? [
                {
                  kind: OrderItemKind.BUNDLE,
                  description: '套餐',
                  quantity: 1,
                  unitPrice: new Prisma.Decimal(500),
                  amount: new Prisma.Decimal(500),
                },
              ]
            : []),
        ],
      },
      passengers: {
        create: Array.from({ length: opts.passengers }, (_, i) => ({
          fullName: `PAX ${i + 1}`,
          documentType: 'PASSPORT' as const,
          documentNumber: uniq('P'),
          dateOfBirth: new Date('1990-01-01'),
          nationality: 'CHN',
        })),
      },
    },
  });
}

/** 旧算法：逐班次 passenger.count（改造前 getAlerts 的原样 where）。*/
async function legacyPaxCount(scheduleId: string): Promise<number> {
  return prisma.passenger.count({
    where: {
      order: {
        deletedAt: null,
        status: { in: COUNTED_STATUSES },
        items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: scheduleId } },
      },
    },
  });
}

describe('getAlerts · 班次乘客数（一条聚合查询，与逐班计数同口径）', () => {
  it('去重 / 取消 / 软删 / 非机票行 / 空班次，逐班与旧算法一致', async () => {
    const s1 = await createSchedule(26);
    const s2 = await createSchedule(50);
    const s3 = await createSchedule(74); // 没有任何订单

    // 往返单：两位乘客，去程 s1、回程 s2 → 两个班次各 +2
    await createOrder({ status: OrderStatus.PAID, passengers: 2, flightScheduleIds: [s1.id, s2.id] });
    // 同一班次两条 FLIGHT 行（如拆段）→ s1 只 +1
    await createOrder({ status: OrderStatus.PENDING_PAYMENT, passengers: 1, flightScheduleIds: [s1.id, s1.id] });
    // 已取消 → 不计
    await createOrder({ status: OrderStatus.CANCELLED, passengers: 3, flightScheduleIds: [s1.id] });
    // 已软删 → 不计
    await createOrder({ status: OrderStatus.PAID, passengers: 4, flightScheduleIds: [s1.id], deleted: true });
    // 已出票 + 同单还有套餐行 → s2 +1（套餐行不影响）
    await createOrder({
      status: OrderStatus.TICKETED,
      passengers: 1,
      flightScheduleIds: [s2.id],
      withBundleRow: true,
    });
    // 只有套餐行、没有机票行 → 哪个班次都不计
    await createOrder({ status: OrderStatus.PAID, passengers: 5, flightScheduleIds: [], withBundleRow: true });

    const alerts = await getAlerts(14);
    const byFlight = new Map(alerts.overCapacitySchedules.map((s) => [s.flightNumber, s.paxCount]));

    expect(byFlight.get(s1.flight.flightNumber)).toBe(3);
    expect(byFlight.get(s2.flight.flightNumber)).toBe(3);
    expect(byFlight.has(s3.flight.flightNumber)).toBe(false);

    // 与改造前的逐班 passenger.count 逐班对齐
    for (const s of [s1, s2]) {
      expect(byFlight.get(s.flight.flightNumber)).toBe(await legacyPaxCount(s.id));
    }
    expect(await legacyPaxCount(s3.id)).toBe(0);
  });
});
