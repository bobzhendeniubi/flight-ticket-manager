import { CabinClass, Prisma, SeatLockStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { PricingService } from '../pricing/pricing.service.js';
import type { CreateFlightBody, CreateScheduleBody, FlightSearchQuery } from './flights.schemas.js';

const pricingService = new PricingService();

export class FlightService {
  /** 面向销售端的航班搜索 — 仅返回自营、激活且未来出发、且可售座位 > 0 的班次 */
  async search(q: FlightSearchQuery) {
    const now = new Date();

    const where: Prisma.FlightScheduleWhereInput = {
      isActive: true,
      flight: { isActive: true },
      departureTime: { gte: now },
    };

    if (q.origin || q.destination) {
      where.flight = {
        isActive: true,
        ...(q.origin ? { originCode: q.origin } : {}),
        ...(q.destination ? { destinationCode: q.destination } : {}),
      };
    }

    if (q.date) {
      // 用户给的是出发地本地日期 (假定 Asia/Shanghai, UTC+8)；折算到 UTC 区间
      const [y, m, d] = q.date.split('-').map(Number);
      // 本地 00:00 = UTC 前一天 16:00
      const startUtc = new Date(Date.UTC(y, m - 1, d, -8, 0, 0));
      const endUtc = new Date(Date.UTC(y, m - 1, d + 1, -8, 0, 0));
      where.departureTime = { gte: startUtc, lt: endUtc };
    }

    const schedules = await prisma.flightSchedule.findMany({
      where,
      include: {
        flight: true,
        seatClasses: true,
      },
      orderBy: { departureTime: 'asc' },
      take: 50,
    });

    // 锁位占用：视野内所有舱位一次 groupBy（ACTIVE 且未过期），买家看到真实可售量
    const seatClassIds = schedules.flatMap((s) => s.seatClasses.map((c) => c.id));
    const lockSums = seatClassIds.length > 0
      ? await prisma.seatLock.groupBy({
          by: ['seatClassId'],
          where: {
            seatClassId: { in: seatClassIds },
            status: SeatLockStatus.ACTIVE,
            expiresAt: { gt: now },
          },
          _sum: { qty: true },
        })
      : [];
    const lockedBySeatClass = new Map(lockSums.map((r) => [r.seatClassId, r._sum.qty ?? 0]));

    // 异步 map — 每个班次的每个舱位都要算动态价
    const mapped = await Promise.all(
      schedules.map(async (s) => {
        const seats = q.cabin ? s.seatClasses.filter((c) => c.cabin === q.cabin) : s.seatClasses;
        const availableSeats = await Promise.all(
          seats.map(async (c) => {
            const lockedQty = lockedBySeatClass.get(c.id) ?? 0;
            const avail = Math.max(0, c.capacity - c.sold - lockedQty);
            // 动态价：为请求人数算平均单价
            let dynamicPrice: string = c.basePrice.toString();
            let dateRank = 'C';
            let dateMultiplier = 1.0;
            let totalForQty = Number(c.basePrice) * q.passengers;
            try {
              if (avail >= q.passengers) {
                const pr = await pricingService.calculatePrice(s.id, c.cabin, q.passengers);
                dynamicPrice = pr.averageUnitPrice.toString();
                dateRank = pr.dateRank;
                dateMultiplier = pr.dateMultiplier;
                totalForQty = pr.totalPrice;
              }
            } catch {
              // fallback to basePrice
            }
            return {
              seatClassId: c.id, // 锁位接口（POST /seat-locks）需要
              cabin: c.cabin,
              capacity: c.capacity,
              sold: c.sold,
              locked: lockedQty,
              available: avail,
              basePrice: c.basePrice.toString(),
              dynamicPrice,
              dateRank,
              dateMultiplier,
              totalForQty,
            };
          }),
        );
        const hasSpace = availableSeats.some((c) => c.available >= q.passengers);
        return {
          scheduleId: s.id,
          flightId: s.flightId,
          flightNumber: s.flight.flightNumber,
          originCode: s.flight.originCode,
          destinationCode: s.flight.destinationCode,
          aircraftType: s.flight.aircraftType,
          departureTime: s.departureTime.toISOString(),
          arrivalTime: s.arrivalTime.toISOString(),
          departureTz: s.departureTz,
          arrivalTz: s.arrivalTz,
          durationMinutes: Math.round((s.arrivalTime.getTime() - s.departureTime.getTime()) / 60000),
          seatClasses: availableSeats,
          hasSpace,
        };
      }),
    );
    return mapped
      .filter((s) => s.hasSpace && s.seatClasses.length > 0);
  }

  /** 管理员：列出所有航班（不论激活） */
  async listFlights() {
    const flights = await prisma.flight.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { schedules: true } },
      },
    });
    return flights.map((f) => ({
      id: f.id,
      flightNumber: f.flightNumber,
      originCode: f.originCode,
      destinationCode: f.destinationCode,
      aircraftType: f.aircraftType,
      isActive: f.isActive,
      scheduleCount: f._count.schedules,
      createdAt: f.createdAt.toISOString(),
    }));
  }

  async createFlight(body: CreateFlightBody) {
    const exists = await prisma.flight.findUnique({
      where: { flightNumber: body.flightNumber.toUpperCase() },
    });
    if (exists) throw new ConflictError(`航班号 ${body.flightNumber} 已存在`);

    const flight = await prisma.flight.create({
      data: {
        flightNumber: body.flightNumber.toUpperCase(),
        originCode: body.originCode.toUpperCase(),
        destinationCode: body.destinationCode.toUpperCase(),
        aircraftType: body.aircraftType,
      },
    });
    return flight;
  }

  async deactivateFlight(flightId: string) {
    const flight = await prisma.flight.findUnique({ where: { id: flightId } });
    if (!flight) throw new NotFoundError('航班不存在');
    return prisma.flight.update({ where: { id: flightId }, data: { isActive: !flight.isActive } });
  }

  /** 管理员：列出某航班的所有班次 */
  async listSchedules(flightId: string) {
    return prisma.flightSchedule.findMany({
      where: { flightId },
      orderBy: { departureTime: 'asc' },
      include: {
        seatClasses: true,
      },
    });
  }

  async createSchedule(body: CreateScheduleBody) {
    const flight = await prisma.flight.findUnique({ where: { id: body.flightId } });
    if (!flight) throw new NotFoundError('航班不存在');

    const dep = new Date(body.departureTime);
    const arr = new Date(body.arrivalTime);
    if (arr <= dep) throw new BadRequestError('到达时间必须晚于出发时间');

    // 避免同一航班同一 departureTime 创建重复班次
    const dup = await prisma.flightSchedule.findFirst({
      where: { flightId: flight.id, departureTime: dep },
    });
    if (dup) throw new ConflictError('该航班在此出发时间已有班次');

    const seats = body.seatClasses;
    // 确保同一舱等不重复
    const cabins = new Set<CabinClass>();
    for (const c of seats) {
      if (cabins.has(c.cabin)) throw new BadRequestError(`舱等 ${c.cabin} 重复`);
      cabins.add(c.cabin);
    }

    const schedule = await prisma.flightSchedule.create({
      data: {
        flightId: flight.id,
        departureTime: dep,
        arrivalTime: arr,
        departureTz: body.departureTz,
        arrivalTz: body.arrivalTz,
        seatClasses: {
          create: seats.map((c) => ({
            cabin: c.cabin,
            capacity: c.capacity,
            basePrice: c.basePrice,
          })),
        },
      },
      include: { seatClasses: true },
    });
    return schedule;
  }

  async deleteSchedule(scheduleId: string) {
    const schedule = await prisma.flightSchedule.findUnique({
      where: { id: scheduleId },
      include: { orderItems: { take: 1 } },
    });
    if (!schedule) throw new NotFoundError('班次不存在');
    if (schedule.orderItems.length > 0) {
      // 有订单关联 — 只能停用
      return prisma.flightSchedule.update({
        where: { id: scheduleId },
        data: { isActive: !schedule.isActive },
      });
    }
    await prisma.flightSchedule.delete({ where: { id: scheduleId } });
    return { id: scheduleId, deleted: true };
  }
}
