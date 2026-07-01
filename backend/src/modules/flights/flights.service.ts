import { AuditSeverity, AuditTargetType, CabinClass, Prisma, SeatLockStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { AuditActor } from '../../lib/audit.js';
import { PricingService } from '../pricing/pricing.service.js';
import { parseFareBuckets } from '../pricing/pricing.schemas.js';
import type { FareBucketsInput } from '../pricing/pricing.schemas.js';
import { localDate } from '../finances/finances.cost.service.js';
import type {
  BaggagePolicyItem,
  CreateFlightBody,
  CreateScheduleBody,
  FlightSearchQuery,
  UpdateScheduleBody,
} from './flights.schemas.js';

const CABIN_LABEL: Record<CabinClass, string> = {
  [CabinClass.ECONOMY]: '经济舱',
  [CabinClass.PREMIUM_ECONOMY]: '超级经济舱',
  [CabinClass.BUSINESS]: '商务舱',
  [CabinClass.FIRST]: '头等舱',
};

const pricingService = new PricingService();

/**
 * 把 zod 校验过的 fareBuckets 输入折叠成 Prisma Json? 写入值。
 * 非空数组 → 原样写入（已按给定顺序，index 0 先卖）。
 * undefined / null / [] → Prisma.JsonNull（写 SQL NULL = 清空阶梯 = 回退自动定价）。
 */
function fareBucketsToPrisma(
  input: FareBucketsInput | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (input && input.length > 0) {
    return input as unknown as Prisma.InputJsonValue;
  }
  return Prisma.JsonNull;
}

// ── 余位档位（服务端权威口径，前端只展示档位不展示精确数字）────────────────
// 阈值（张）：>40 充足 AMPLE；16-40 偏紧 TIGHT；6-15 紧张 LOW；1-5 极少 VERY_LOW；≤0 售罄 SOLD_OUT
// 注：运营可能随销售节奏调整这些阈值（改这里即可，全局唯一来源）。
export const AVAILABILITY_TIER_THRESHOLDS = {
  AMPLE_MIN: 41,
  TIGHT_MIN: 16,
  LOW_MIN: 6,
  VERY_LOW_MIN: 1,
} as const;

export type AvailabilityTier = 'AMPLE' | 'TIGHT' | 'LOW' | 'VERY_LOW' | 'SOLD_OUT';

/** 把锁位感知的可售余量（available）折算成档位。 */
export function computeAvailabilityTier(available: number): AvailabilityTier {
  if (available >= AVAILABILITY_TIER_THRESHOLDS.AMPLE_MIN) return 'AMPLE';
  if (available >= AVAILABILITY_TIER_THRESHOLDS.TIGHT_MIN) return 'TIGHT';
  if (available >= AVAILABILITY_TIER_THRESHOLDS.LOW_MIN) return 'LOW';
  if (available >= AVAILABILITY_TIER_THRESHOLDS.VERY_LOW_MIN) return 'VERY_LOW';
  return 'SOLD_OUT';
}

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

    // 行李规则：视野内所有航班一次性查出（flightId+cabin 定位），避免 N+1
    const flightIds = [...new Set(schedules.map((s) => s.flightId))];
    const baggageRows = flightIds.length > 0
      ? await prisma.flightBaggagePolicy.findMany({ where: { flightId: { in: flightIds } } })
      : [];
    const baggageByFlightCabin = new Map(
      baggageRows.map((b) => [`${b.flightId}:${b.cabin}`, b]),
    );

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
            const baggage = baggageByFlightCabin.get(`${s.flightId}:${c.cabin}`);
            return {
              seatClassId: c.id, // 锁位接口（POST /seat-locks）需要
              cabin: c.cabin,
              capacity: c.capacity,
              sold: c.sold,
              locked: lockedQty,
              available: avail,
              availabilityTier: computeAvailabilityTier(avail),
              basePrice: c.basePrice.toString(),
              dynamicPrice,
              dateRank,
              dateMultiplier,
              totalForQty,
              // 行李规则（按 航班×舱等 配置；未配置 = null，前端不展示）
              baggage: baggage
                ? {
                    checkedKg: baggage.checkedKg,
                    checkedPieces: baggage.checkedPieces,
                    carryOnKg: baggage.carryOnKg,
                    note: baggage.note,
                  }
                : null,
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

  /**
   * 管理员：列出某航班的所有班次。
   * 保留 FlightSchedule 全部顶层字段（成本字段由路由层按角色脱敏）；
   * 每个 seatClass 额外把 fareBuckets 从 Json 解析成 FareBucket[]（null=未配置），
   * 使管理端月历库存视图可直接读/编辑仓位阶梯，basePrice 保留原 Decimal 形态不变更其它消费方。
   */
  /**
   * 给一组班次的每个 seatClass 算"他人 ACTIVE 未过期锁位"占用量（与前台 search() 同口径）。
   * 让 admin 的余位 = capacity − sold − locked，消灭"航班管理/座位统计比前台多算锁位张数"的偏差。
   */
  private async lockedMapForSchedules(
    schedules: { seatClasses: { id: string }[] }[],
  ): Promise<Map<string, number>> {
    const seatClassIds = schedules.flatMap((s) => s.seatClasses.map((c) => c.id));
    if (seatClassIds.length === 0) return new Map();
    const lockSums = await prisma.seatLock.groupBy({
      by: ['seatClassId'],
      where: {
        seatClassId: { in: seatClassIds },
        status: SeatLockStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
      _sum: { qty: true },
    });
    return new Map(lockSums.map((r) => [r.seatClassId, r._sum.qty ?? 0]));
  }

  async listSchedules(flightId: string) {
    const schedules = await prisma.flightSchedule.findMany({
      where: { flightId },
      orderBy: { departureTime: 'asc' },
      include: {
        seatClasses: true,
      },
    });
    const lockedMap = await this.lockedMapForSchedules(schedules);
    return schedules.map((s) => ({
      ...s,
      seatClasses: s.seatClasses.map((c) => {
        const locked = lockedMap.get(c.id) ?? 0;
        return {
          ...c,
          fareBuckets: parseFareBuckets(c.fareBuckets),
          locked,
          // 权威余位口径（与前台一致）：capacity − sold − 他人未过期锁位
          available: Math.max(0, c.capacity - c.sold - locked),
        };
      }),
    }));
  }

  /**
   * 座位统计：按出发日区间一次列出"所有航班"的班次（含 locked/available），
   * 取代前端 N+1（每航班一拉）。range 省略则返回全部。
   */
  async listSchedulesInRange(range: { from?: string; to?: string }) {
    // from/to 是出发地当地(Asia/Macau, UTC+8)日期；折算到 UTC 瞬间，避免 8h 边界偏移。
    const localDayStartUtc = (d: string) => {
      const [y, m, dd] = d.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, dd, -8, 0, 0));
    };
    const where: Prisma.FlightScheduleWhereInput = {};
    if (range.from || range.to) {
      where.departureTime = {};
      if (range.from) where.departureTime.gte = localDayStartUtc(range.from);
      if (range.to)
        where.departureTime.lte = new Date(localDayStartUtc(range.to).getTime() + 24 * 3600 * 1000 - 1);
    }
    const schedules = await prisma.flightSchedule.findMany({
      where,
      orderBy: { departureTime: 'asc' },
      include: {
        flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
        seatClasses: true,
      },
    });
    const lockedMap = await this.lockedMapForSchedules(schedules);
    return schedules.map((s) => ({
      id: s.id,
      flightId: s.flightId,
      flightNumber: s.flight.flightNumber,
      originCode: s.flight.originCode,
      destinationCode: s.flight.destinationCode,
      departureTime: s.departureTime.toISOString(),
      departureTz: s.departureTz,
      ticketingCap: s.ticketingCap,
      seatClasses: s.seatClasses.map((c) => {
        const locked = lockedMap.get(c.id) ?? 0;
        return {
          id: c.id,
          cabin: c.cabin,
          capacity: c.capacity,
          sold: c.sold,
          locked,
          available: Math.max(0, c.capacity - c.sold - locked),
          basePrice: c.basePrice.toString(),
        };
      }),
    }));
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

    // 约束：一个航班号一天只能一班（套餐绑航班号后，买家选出发日须能唯一解析出班次）。
    // 用出发地时区把 departureTime 折成本地日比较（避免 UTC 边界导致跨天误判）。
    const depLocalDay = localDate(dep, body.departureTz);
    const sameFlightSchedules = await prisma.flightSchedule.findMany({
      where: { flightId: flight.id },
      select: { departureTime: true, departureTz: true },
    });
    const clash = sameFlightSchedules.some(
      (s) => localDate(s.departureTime, s.departureTz) === depLocalDay,
    );
    if (clash) {
      throw new BadRequestError('该航班号当天已有班次，一个航班号一天只能一班');
    }

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
        ...(body.ticketingCap !== undefined && { ticketingCap: body.ticketingCap }),
        seatClasses: {
          create: seats.map((c) => ({
            cabin: c.cabin,
            capacity: c.capacity,
            basePrice: c.basePrice,
            // 仓位阶梯（可选）：给了非空数组就存；省略 / null / [] 存 NULL（无阶梯）
            fareBuckets: fareBucketsToPrisma(c.fareBuckets),
          })),
        },
      },
      include: { seatClasses: true },
    });
    return this.serializeSchedule(schedule);
  }

  /** 调整班次开票上限（航司临时放宽/收紧时运营改）。 */
  async updateTicketingCap(scheduleId: string, ticketingCap: number) {
    const schedule = await prisma.flightSchedule.findUnique({ where: { id: scheduleId } });
    if (!schedule) throw new NotFoundError('班次不存在');
    return prisma.flightSchedule.update({
      where: { id: scheduleId },
      data: { ticketingCap },
      select: { id: true, ticketingCap: true },
    });
  }

  /**
   * 单班次编辑（月历库存视图：改价 / 改容量 / 停用启用 / 改时刻）。
   * 事务内：isActive 整班次改；seatClasses 按 cabin 定位逐条改 basePrice/capacity；
   * departureTime/arrivalTime 按航司改点写入。
   *
   * 时刻变更守卫：
   *   - arrival 必须晚于 departure（允许跨天到达）
   *   - 若该班次任意舱位已售（sold>0）则允许改时刻，但额外写审计（WARNING 级）
   *   - 返回与 listSchedules 同形
   */
  async updateSchedule(scheduleId: string, body: UpdateScheduleBody, actor?: AuditActor) {
    const schedule = await prisma.flightSchedule.findUnique({
      where: { id: scheduleId },
      include: { seatClasses: true },
    });
    if (!schedule) throw new NotFoundError('班次不存在');

    const seatClassByCabin = new Map(schedule.seatClasses.map((c) => [c.cabin, c]));
    const seatUpdates = body.seatClasses ?? [];

    // ── 时刻变更校验 ─────────────────────────────────────────────────────────
    let newDep: Date | undefined;
    let newArr: Date | undefined;
    if (body.departureTime !== undefined || body.arrivalTime !== undefined) {
      newDep = body.departureTime ? new Date(body.departureTime) : schedule.departureTime;
      newArr = body.arrivalTime ? new Date(body.arrivalTime) : schedule.arrivalTime;
      if (newArr <= newDep) {
        throw new BadRequestError('到达时间必须晚于出发时间（跨天到达请使用次日时间）');
      }

      // 约束：一个航班号一天只能一班（与 createSchedule 同口径）。改点若把本地出发日挪到
      // 同航班号已有班次占用的那一天 → 拒绝，避免编辑绕过创建时的当天唯一性校验。
      // 用出发地时区把出发时间折成本地日比较（复用 createSchedule 的 localDate 折叠，避免 UTC 边界跨天误判）。
      // updateSchedule 不改时区，故沿用本班次现有 departureTz；仅当本地出发日实际改变才校验。
      const oldLocalDay = localDate(schedule.departureTime, schedule.departureTz);
      const newLocalDay = localDate(newDep, schedule.departureTz);
      if (newLocalDay !== oldLocalDay) {
        const sameFlightSchedules = await prisma.flightSchedule.findMany({
          where: { flightId: schedule.flightId, id: { not: scheduleId } },
          select: { departureTime: true, departureTz: true },
        });
        const clash = sameFlightSchedules.some(
          (s) => localDate(s.departureTime, s.departureTz) === newLocalDay,
        );
        if (clash) {
          throw new BadRequestError('该航班号当天已有班次，一个航班号一天只能一班');
        }
      }
    }

    // ── 座位类校验 ───────────────────────────────────────────────────────────
    for (const upd of seatUpdates) {
      const current = seatClassByCabin.get(upd.cabin);
      if (!current) {
        throw new BadRequestError(`该班次没有${CABIN_LABEL[upd.cabin]}（${upd.cabin}）`);
      }
      if (upd.capacity !== undefined && upd.capacity < current.sold) {
        throw new BadRequestError(
          `${CABIN_LABEL[upd.cabin]}已售 ${current.sold}，容量不能低于 ${current.sold}`,
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      // 时刻 + isActive 一次写（减少 round-trips）
      const scheduleData: Prisma.FlightScheduleUpdateInput = {};
      if (body.isActive !== undefined) scheduleData.isActive = body.isActive;
      if (newDep) scheduleData.departureTime = newDep;
      if (newArr) scheduleData.arrivalTime = newArr;
      if (Object.keys(scheduleData).length > 0) {
        await tx.flightSchedule.update({ where: { id: scheduleId }, data: scheduleData });
      }

      for (const upd of seatUpdates) {
        const current = seatClassByCabin.get(upd.cabin)!;
        await tx.flightSeatClass.update({
          where: { id: current.id },
          data: {
            ...(upd.basePrice !== undefined && { basePrice: upd.basePrice }),
            ...(upd.capacity !== undefined && { capacity: upd.capacity }),
            // fareBuckets 给了才动：数组=设置阶梯；null / [] = 清空（写 NULL，回退自动定价）
            ...(upd.fareBuckets !== undefined && {
              fareBuckets: fareBucketsToPrisma(upd.fareBuckets),
            }),
          },
        });
      }
    });

    const updated = await prisma.flightSchedule.findUniqueOrThrow({
      where: { id: scheduleId },
      include: { seatClasses: true },
    });

    // ── 时刻变更审计（有已售座位时额外标 WARNING）────────────────────────────
    if (newDep || newArr) {
      const totalSold = schedule.seatClasses.reduce((sum, c) => sum + c.sold, 0);
      const hasSold = totalSold > 0;
      await writeAudit({
        actor: actor ?? {},
        action: 'UPDATE_SCHEDULE_TIME',
        targetType: AuditTargetType.FLIGHT,
        targetId: scheduleId,
        targetLabel: `班次 ${scheduleId}（${schedule.departureTime.toISOString()} → ${updated.departureTime.toISOString()}）`,
        before: {
          departureTime: schedule.departureTime.toISOString(),
          arrivalTime: schedule.arrivalTime.toISOString(),
        },
        after: {
          departureTime: updated.departureTime.toISOString(),
          arrivalTime: updated.arrivalTime.toISOString(),
        },
        severity: hasSold ? AuditSeverity.WARNING : AuditSeverity.INFO,
      });
    }

    return this.serializeSchedule(updated);
  }

  /**
   * listSchedules / createSchedule / updateSchedule 共用的序列化。
   * 时间 ISO、basePrice 转字符串；fareBuckets 从 Json 安全解析（脏数据 → null）。
   * 管理端月历库存视图据此读/编辑仓位阶梯。
   */
  private serializeSchedule(s: {
    id: string;
    flightId: string;
    departureTime: Date;
    arrivalTime: Date;
    departureTz: string;
    arrivalTz: string;
    isActive: boolean;
    seatClasses: Array<{
      id: string;
      cabin: CabinClass;
      capacity: number;
      sold: number;
      basePrice: Prisma.Decimal;
      fareBuckets?: Prisma.JsonValue | null;
    }>;
  }) {
    return {
      id: s.id,
      flightId: s.flightId,
      departureTime: s.departureTime.toISOString(),
      arrivalTime: s.arrivalTime.toISOString(),
      departureTz: s.departureTz,
      arrivalTz: s.arrivalTz,
      isActive: s.isActive,
      seatClasses: s.seatClasses.map((c) => ({
        id: c.id,
        cabin: c.cabin,
        capacity: c.capacity,
        sold: c.sold,
        basePrice: c.basePrice.toString(),
        // 仓位阶梯：解析过的 FareBucket[]（最便宜在前）；null = 未配置（走自动定价）
        fareBuckets: parseFareBuckets(c.fareBuckets),
      })),
    };
  }

  /** 行李规则：列出某航班全部舱等配置（ADMIN/STAFF 维护页用） */
  async listBaggagePolicies(flightId: string) {
    const flight = await prisma.flight.findUnique({ where: { id: flightId }, select: { id: true } });
    if (!flight) throw new NotFoundError('航班不存在');
    return prisma.flightBaggagePolicy.findMany({
      where: { flightId },
      orderBy: { cabin: 'asc' },
    });
  }

  /** 行李规则：整体替换式 upsert — 数组里未出现的舱等删除，出现的按 flightId+cabin upsert */
  async upsertBaggagePolicies(flightId: string, items: BaggagePolicyItem[]) {
    const flight = await prisma.flight.findUnique({ where: { id: flightId }, select: { id: true } });
    if (!flight) throw new NotFoundError('航班不存在');

    const cabins = items.map((i) => i.cabin);
    await prisma.$transaction([
      prisma.flightBaggagePolicy.deleteMany({
        where: { flightId, cabin: { notIn: cabins } },
      }),
      ...items.map((i) =>
        prisma.flightBaggagePolicy.upsert({
          where: { flightId_cabin: { flightId, cabin: i.cabin } },
          create: {
            flightId,
            cabin: i.cabin,
            checkedKg: i.checkedKg ?? null,
            checkedPieces: i.checkedPieces ?? null,
            carryOnKg: i.carryOnKg ?? null,
            note: i.note ?? null,
          },
          update: {
            checkedKg: i.checkedKg ?? null,
            checkedPieces: i.checkedPieces ?? null,
            carryOnKg: i.carryOnKg ?? null,
            note: i.note ?? null,
          },
        }),
      ),
    ]);
    return this.listBaggagePolicies(flightId);
  }

  /**
   * 删除班次（路由层限 ADMIN）。
   * 有销售则禁删 —— 任一舱位已售 sold>0，或已有订单项关联本班次，一律 400 拒绝
   * （提示改用「售罄」即停用，保留历史数据）。无销售才硬删（级联清掉舱位 / 仓位阶梯）。
   */
  async deleteSchedule(scheduleId: string) {
    const schedule = await prisma.flightSchedule.findUnique({
      where: { id: scheduleId },
      include: {
        orderItems: { take: 1 },
        seatClasses: { select: { sold: true } },
      },
    });
    if (!schedule) throw new NotFoundError('班次不存在');

    const hasSold = schedule.seatClasses.some((c) => c.sold > 0);
    const hasOrders = schedule.orderItems.length > 0;
    if (hasSold || hasOrders) {
      throw new BadRequestError('该班次已有销售，不能删除（请改用售罄）');
    }

    // 无销售：硬删（onDelete: Cascade 自动清掉 seatClasses 及其 fareBuckets）
    await prisma.flightSchedule.delete({ where: { id: scheduleId } });
    return { id: scheduleId, deleted: true };
  }
}
