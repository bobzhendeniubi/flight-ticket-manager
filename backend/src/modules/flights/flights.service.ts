import {
  AuditSeverity,
  AuditTargetType,
  CabinClass,
  Prisma,
  SeatLockStatus,
  WaitlistStatus,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { AuditActor } from '../../lib/audit.js';
import { PricingService } from '../pricing/pricing.service.js';
import type { PriceResult } from '../pricing/pricing.service.js';
import { parseFareBuckets } from '../pricing/pricing.schemas.js';
import type { FareBucketsInput } from '../pricing/pricing.schemas.js';
import { localDate } from '../finances/finances.cost.service.js';
import { localDateISO, localDateTime, localToUtc } from '../../lib/flight-time.js';
import { heldSeatsBySeatClass } from '../hold-orders/held-seats.js';
import type { FareBucket } from '../pricing/pricing.calc.js';
import type {
  BaggagePolicyItem,
  BatchUpdateCapacityBody,
  BatchUpdateScheduleTimesBody,
  CreateFlightBody,
  CreateScheduleBody,
  FlightSearchQuery,
  UpdateFlightBody,
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
// 按"占舱位容量比例"分档（而非绝对张数）——固定张数口径下，一个 20 座商务舱订满
// 也会被绝对阈值（原 41 张才算充足）误标"紧张"；改成比例后，满仓永远是 AMPLE，
// 无论这个舱位是 7 座、20 座还是 200 座。
//
// 档位（available 相对 capacity 的占比，向上取整到"张"，并夹到 < capacity，
// 保证 available === capacity 时必为 AMPLE）：
//   available ≤ 0                              → SOLD_OUT 售罄
//   available ≤ ceil(capacity × 5%)             → VERY_LOW 极少
//   available ≤ ceil(capacity × 15%)            → LOW 紧张
//   available ≤ ceil(capacity × 40%)            → TIGHT 偏紧
//   否则                                         → AMPLE 充足
// 注：运营可能随销售节奏调整这些比例（改这里即可，全局唯一来源）。
export const AVAILABILITY_TIER_THRESHOLDS = {
  VERY_LOW_MAX_RATIO: 0.05,
  LOW_MAX_RATIO: 0.15,
  TIGHT_MAX_RATIO: 0.4,
} as const;

// 未传 capacity 的历史调用方（如 bundle-availability.service 按日聚合多班次求和后的口径，
// 那里没有单一 capacity 可传）沿用此参考容量——100 时新比例门槛 5/15/40 与旧版绝对阈值
// 完全数值等价，因此这些调用方行为不受本次改动影响。
const LEGACY_REFERENCE_CAPACITY = 100;

export type AvailabilityTier = 'AMPLE' | 'TIGHT' | 'LOW' | 'VERY_LOW' | 'SOLD_OUT';

/**
 * 公开端点（/flights/search、/flights/price）的余位数值封顶：≤9 报真实值（与单笔锁位上限 9 一致），
 * >9 一律报 9。精确 capacity/sold/locked 不对公开端点输出——此前匿名轮询可重建每个班次的
 * 实时销售数据（公测检查发现）；「只展示档位」必须由服务端契约保证，不能只靠前端不渲染。
 * 档位（availabilityTier）仍按真实余量计算；带角色守卫的管理/代理路由不受影响。
 */
export const PUBLIC_AVAILABLE_CAP = 9;

/** 公开口径余位数值：夹到 [0, PUBLIC_AVAILABLE_CAP]。 */
export function capPublicAvailable(available: number): number {
  return Math.min(Math.max(0, available), PUBLIC_AVAILABLE_CAP);
}

// ── 公开响应白名单序列化（唯一出口）──────────────────────────────────────────
// 口径：公开端点（/flights/search、/flights/price）一律「选字段」而非「删字段」。
// 逐字段剥离（`({ availExact: _a, ...pub })`）只挡得住写它时想到的那几个字段——内部对象
// 后补的字段会原样透传出去。dateRank（公司内部日期等级 A/B/C/D）就是这么漏出去的：
// 剥离那行只摘了 availExact。白名单反过来：默认不透传，要给客户看的字段必须显式写进来。
// 带角色守卫的内部路由不经过这层（运营内部参考仍需 dateRank 等字段），见 serializeScheduleForAgent。

/** 公开口径的 perSeatBreakdown 单项——只含计价展示字段。 */
export interface PublicSeatBreakdownView {
  seatIndex: number;
  bucket: number;
  bucketMultiplier: number;
  unitPrice: number;
}

/**
 * 公开端点 /flights/price 的 perSeatBreakdown 白名单 + seatIndex 脱敏。
 * seatIndex 原值 = sold + 1 + i（该班次这个舱位历史上第几张票，绝对张数）——匿名端拿到后
 * 可直接反推 sold（如 qty=1 时 sold = seatIndex − 1），是与 capPublicAvailable 同一类侧信道
 * 泄露（都能重建实时销量），只是走的是 perSeatBreakdown 而非 currentBucketRemaining。
 * 改成相对索引 1..qty（本次请求内第几张，不含历史销量信息）；bucket/unitPrice 等计价字段不变，
 * 价格展示不受影响。需要真实 seatIndex 的内部调用方（如下单时写入订单行 metadata 存证）
 * 直接用 PricingService.calculatePrice 的原始结果，不经过这层。
 */
export function toPublicSeatBreakdown(
  breakdown: readonly PublicSeatBreakdownView[],
): PublicSeatBreakdownView[] {
  return breakdown.map((seat, i) => ({
    seatIndex: i + 1, // 相对索引，不含历史销量信息
    bucket: seat.bucket,
    bucketMultiplier: seat.bucketMultiplier,
    unitPrice: seat.unitPrice,
  }));
}

/** 公开口径的 /flights/price 响应——不含 dateRank/dateMultiplier。 */
export interface PublicPriceView {
  scheduleId: string;
  cabin: CabinClass;
  qty: number;
  pricingMode: 'LADDER' | 'AUTO';
  basePrice: number;
  bucketSize: number;
  totalBuckets: number;
  currentBucket: number;
  currentBucketRemaining: number;
  perSeatBreakdown: PublicSeatBreakdownView[];
  totalPrice: number;
  averageUnitPrice: number;
}

/**
 * 公开端点 /flights/price 的响应白名单。
 * 剔除 dateRank（内部日期等级，不对客户输出）与 dateMultiplier（恒为 1，对客户零信息量）；
 * currentBucketRemaining 封顶、perSeatBreakdown 走 toPublicSeatBreakdown（防反推实时销量）。
 */
export function toPublicPrice(pricing: PriceResult): PublicPriceView {
  return {
    scheduleId: pricing.scheduleId,
    cabin: pricing.cabin,
    qty: pricing.qty,
    pricingMode: pricing.pricingMode,
    basePrice: pricing.basePrice,
    bucketSize: pricing.bucketSize,
    totalBuckets: pricing.totalBuckets,
    currentBucket: pricing.currentBucket,
    // 精确档内剩余是内部计价真值，对匿名端封顶输出
    currentBucketRemaining: capPublicAvailable(pricing.currentBucketRemaining),
    perSeatBreakdown: toPublicSeatBreakdown(pricing.perSeatBreakdown),
    totalPrice: pricing.totalPrice,
    averageUnitPrice: pricing.averageUnitPrice,
  };
}

/** 公开口径的行李额——未配置 = null。 */
export interface PublicBaggageView {
  checkedKg: number | null;
  checkedPieces: number | null;
  carryOnKg: number | null;
  note: string | null;
}

/** 公开口径的搜索结果舱位——不含 availExact/capacity/sold/locked/dateRank/dateMultiplier。 */
export interface PublicSeatClassView {
  seatClassId: string;
  cabin: CabinClass;
  available: number;
  availabilityTier: AvailabilityTier;
  basePrice: string;
  dynamicPrice: string;
  totalForQty: number;
  baggage: PublicBaggageView | null;
}

/**
 * 公开端点 /flights/search 的舱位白名单。
 * 入参是内部计算对象（带 availExact 精确余位真值、dateRank 内部日期等级等）；
 * 出参只含客户该看到的字段——余位只给封顶值 + 档位，日期等级一律不出现。
 */
export function toPublicSeatClass(seat: {
  seatClassId: string;
  cabin: CabinClass;
  available: number;
  availabilityTier: AvailabilityTier;
  basePrice: string;
  dynamicPrice: string;
  totalForQty: number;
  baggage: PublicBaggageView | null;
}): PublicSeatClassView {
  return {
    seatClassId: seat.seatClassId, // 锁位接口（POST /seat-locks）需要
    cabin: seat.cabin,
    available: seat.available, // 调用方已过 capPublicAvailable
    availabilityTier: seat.availabilityTier,
    basePrice: seat.basePrice,
    dynamicPrice: seat.dynamicPrice,
    totalForQty: seat.totalForQty,
    baggage: seat.baggage
      ? {
          checkedKg: seat.baggage.checkedKg,
          checkedPieces: seat.baggage.checkedPieces,
          carryOnKg: seat.baggage.carryOnKg,
          note: seat.baggage.note,
        }
      : null,
  };
}

/**
 * AGENT 视角班次的座位舱位——只含余位/售价类字段，不含任何成本字段。
 * 库存侧只吐 available 一个数：capacity/sold/locked 任意再多给一个，代理就能用
 * 四则运算反推出 held（capacity − sold − locked − available）或实时销量——
 * 其他代理/直客的占位规模与销售进度都是不该给代理看的经营信息。
 */
export interface AgentScheduleSeatClassView {
  id: string;
  cabin: CabinClass;
  basePrice: Prisma.Decimal;
  fareBuckets: FareBucket[] | null;
  available: number;
}

/** AGENT 视角班次——只含航班/时刻/舱位/余位/售价类字段，不含任何成本字段。 */
export interface AgentScheduleView {
  id: string;
  flightId: string;
  departureTime: Date;
  arrivalTime: Date;
  departureTz: string;
  arrivalTz: string;
  isActive: boolean;
  seatClasses: AgentScheduleSeatClassView[];
}

/**
 * AGENT 视角 schedule 序列化——白名单而非黑名单。
 *
 * `FlightSchedule`（schema.prisma）上挂了一串 per-passenger 成本字段：
 * charterCostCny / airportTaxDepCny / airportTaxArrCny / fuelCostCny / peakSurchargeCny /
 * aircraftAdjustCny / takeoffDiscountCny —— 这些字段能直接反推毛利，绝不能下发给 AGENT。
 * 只挑 AGENT 批量创单实际需要的字段（航班/时刻/舱位/余位/售价类）逐个搬进返回值；
 * 以后 FlightSchedule 上再加成本字段，不会因为这里是"删字段"的黑名单而漏改自动泄露。
 */
export function serializeScheduleForAgent(schedule: {
  id: string;
  flightId: string;
  departureTime: Date;
  arrivalTime: Date;
  departureTz: string;
  arrivalTz: string;
  isActive: boolean;
  seatClasses: readonly {
    id: string;
    cabin: CabinClass;
    capacity: number;
    sold: number;
    basePrice: Prisma.Decimal;
    fareBuckets: FareBucket[] | null;
    locked: number;
    available: number;
  }[];
}): AgentScheduleView {
  return {
    id: schedule.id,
    flightId: schedule.flightId,
    departureTime: schedule.departureTime,
    arrivalTime: schedule.arrivalTime,
    departureTz: schedule.departureTz,
    arrivalTz: schedule.arrivalTz,
    isActive: schedule.isActive,
    seatClasses: schedule.seatClasses.map((c) => ({
      id: c.id,
      cabin: c.cabin,
      basePrice: c.basePrice,
      fareBuckets: c.fareBuckets,
      available: c.available,
    })),
  };
}

/**
 * 把锁位感知的可售余量（available）相对舱位容量（capacity）折算成档位。
 * capacity 缺省 = LEGACY_REFERENCE_CAPACITY（100）——未传时数值上完全复现旧版
 * 绝对阈值（5/15/40），供尚未改造的历史调用方（不在本次改动范围内）零行为变更接入。
 */
export function computeAvailabilityTier(
  available: number,
  capacity: number = LEGACY_REFERENCE_CAPACITY,
): AvailabilityTier {
  if (available <= 0) return 'SOLD_OUT';
  // 门槛 = ceil(capacity × ratio)，并夹到 capacity−1 以内——防止小容量舱位的门槛
  // 反超总容量，导致满仓（available === capacity）也被误判进紧张档。
  const cap = Math.max(capacity, 0);
  const cut = (ratio: number) => Math.min(cap - 1, Math.ceil(cap * ratio));
  if (available <= cut(AVAILABILITY_TIER_THRESHOLDS.VERY_LOW_MAX_RATIO)) return 'VERY_LOW';
  if (available <= cut(AVAILABILITY_TIER_THRESHOLDS.LOW_MAX_RATIO)) return 'LOW';
  if (available <= cut(AVAILABILITY_TIER_THRESHOLDS.TIGHT_MAX_RATIO)) return 'TIGHT';
  return 'AMPLE';
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
    const heldBySeatClass = await heldSeatsBySeatClass(prisma, seatClassIds);

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
            const heldQty = heldBySeatClass.get(c.id) ?? 0;
            const avail = Math.max(0, c.capacity - c.sold - lockedQty - heldQty);
            // 动态价：为请求人数算平均单价
            let dynamicPrice: string = c.basePrice.toString();
            let dateRank = 'C';
            let dateMultiplier = 1.0;
            let totalForQty = Number(c.basePrice) * q.passengers;
            // 展示用「原价」：默认取舱位 basePrice；商务舱价格联动时 basePrice 不参与计价，
            // 用派生现价当原价，避免前台把（被忽略的）商务舱底价当作划线原价误显示成打折。
            let displayBasePrice: string = c.basePrice.toString();
            try {
              if (avail >= q.passengers) {
                const pr = await pricingService.calculatePrice(s.id, c.cabin, q.passengers);
                dynamicPrice = pr.averageUnitPrice.toString();
                dateRank = pr.dateRank;
                dateMultiplier = pr.dateMultiplier;
                totalForQty = pr.totalPrice;
                if (pr.businessLinked) displayBasePrice = pr.averageUnitPrice.toString();
              }
            } catch {
              // fallback to basePrice
            }
            const baggage = baggageByFlightCabin.get(`${s.flightId}:${c.cabin}`);
            return {
              // 内部真值：hasSpace 过滤用，不出现在公开响应里（toPublicSeatClass 不选它）
              availExact: avail,
              // 内部日期等级：公司内部口径，不对客户输出（同上，白名单不选它）
              dateRank,
              dateMultiplier,
              seatClassId: c.id, // 锁位接口（POST /seat-locks）需要
              cabin: c.cabin,
              // 公开口径：不输出 capacity/sold/locked，余位数值 ≤9 封顶（档位仍按真值算）
              available: capPublicAvailable(avail),
              availabilityTier: computeAvailabilityTier(avail, c.capacity),
              basePrice: displayBasePrice,
              dynamicPrice,
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
        const hasSpace = availableSeats.some((c) => c.availExact >= q.passengers);
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
          // 白名单序列化：内部字段（availExact/dateRank/…）默认不透传，见 toPublicSeatClass
          seatClasses: availableSeats.map(toPublicSeatClass),
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
      // 升舱差价单一配置源（¥/程/座）+ 商务舱价格联动开关（前端据此渲染航班级编辑区 & 派生商务舱现价）
      businessUpgradeCnyPerLeg: f.businessUpgradeCnyPerLeg,
      businessPriceLinked: f.businessPriceLinked,
      scheduleCount: f._count.schedules,
      createdAt: f.createdAt.toISOString(),
    }));
  }

  /**
   * 航班级编辑：升舱差价（¥/程/座，单一配置源）+ 商务舱价格联动开关。
   * PATCH 语义：只写传入的字段。开启联动后，该航班所有班次的商务舱现价由 PricingService 统一派生
   *（= 经济舱当前售价 + businessUpgradeCnyPerLeg），无需逐班次改商务舱 basePrice。
   */
  async updateFlight(flightId: string, body: UpdateFlightBody) {
    const flight = await prisma.flight.findUnique({ where: { id: flightId } });
    if (!flight) throw new NotFoundError('航班不存在');
    const data: Prisma.FlightUpdateInput = {};
    if (body.businessUpgradeCnyPerLeg !== undefined) {
      data.businessUpgradeCnyPerLeg = body.businessUpgradeCnyPerLeg;
    }
    if (body.businessPriceLinked !== undefined) {
      data.businessPriceLinked = body.businessPriceLinked;
    }
    return prisma.flight.update({ where: { id: flightId }, data });
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
   * 给一组班次的每个 seatClass 算锁位与占位占用量（与前台 search() 同口径）。
   * 让 admin 的余位 = capacity − sold − locked − held，消灭不同库存页面的口径偏差。
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

  private async heldMapForSchedules(
    schedules: { seatClasses: { id: string }[] }[],
  ): Promise<Map<string, number>> {
    const seatClassIds = schedules.flatMap((s) => s.seatClasses.map((c) => c.id));
    return heldSeatsBySeatClass(prisma, seatClassIds);
  }

  async listSchedules(flightId: string) {
    const schedules = await prisma.flightSchedule.findMany({
      where: { flightId },
      orderBy: { departureTime: 'asc' },
      include: {
        seatClasses: true,
      },
    });
    const [lockedMap, heldMap] = await Promise.all([
      this.lockedMapForSchedules(schedules),
      this.heldMapForSchedules(schedules),
    ]);
    return schedules.map((s) => ({
      ...s,
      seatClasses: s.seatClasses.map((c) => {
        const locked = lockedMap.get(c.id) ?? 0;
        const held = heldMap.get(c.id) ?? 0;
        return {
          ...c,
          fareBuckets: parseFareBuckets(c.fareBuckets),
          locked,
          held,
          // 权威余位口径（与前台一致）：capacity − sold − 他人未过期锁位 − 占位余座。
          // 不夹 0：航司减配/换机型把容量压到已售之下时余位为负 = 超售张数，
          // 运营端要看见这个负数去协调（前台公开口径另走 capPublicAvailable，仍夹 0）。
          available: c.capacity - c.sold - locked - held,
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
    const [lockedMap, heldMap] = await Promise.all([
      this.lockedMapForSchedules(schedules),
      this.heldMapForSchedules(schedules),
    ]);
    return schedules.map((s) => ({
      id: s.id,
      flightId: s.flightId,
      flightNumber: s.flight.flightNumber,
      originCode: s.flight.originCode,
      destinationCode: s.flight.destinationCode,
      departureTime: s.departureTime.toISOString(),
      departureTz: s.departureTz,
      // 关柜提前分钟数：no-show 批量页选完班次、还没预检之前，角标要按这一班自己的值粗估，
      // 否则班次自配了分钟数的会先显示「未关柜」、预检后又翻成「已关柜」。null = 系统默认。
      checkinCloseMinutes: s.checkinCloseMinutes,
      seatClasses: s.seatClasses.map((c) => {
        const locked = lockedMap.get(c.id) ?? 0;
        const held = heldMap.get(c.id) ?? 0;
        return {
          id: c.id,
          cabin: c.cabin,
          capacity: c.capacity,
          sold: c.sold,
          locked,
          held,
          // 与 listSchedules 同口径，不夹 0：负数 = 超售张数（座位统计据此标红）
          available: c.capacity - c.sold - locked - held,
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

  // 开票上限无独立写入口：上限 = Σ 舱位 capacity（见 orders/ticketing-cap.ts）。
  // 要放宽/收紧上限就是改舱位容量 —— 走下面的 updateSchedule（seatClasses[].capacity）。

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
      // ── A11 已售班次改点闸（2026-07-17）：时刻真实变化 && 已售 > 0 → 必须显式二次确认 ──
      // 改点影响存量订单的客人通知/护照签证时点/酒店入住/已导出的航司名单，不能一改了之。
      // 旧行为只写 WARNING 审计（留痕不是防线）；现改为：不带 confirmSoldTimeChange 一律拦下，
      // 报文里带上已售座数让运营看清影响面，确认后放行（审计照记 WARNING）。
      const timeActuallyChanged =
        newDep.getTime() !== schedule.departureTime.getTime() ||
        newArr.getTime() !== schedule.arrivalTime.getTime();
      if (timeActuallyChanged) {
        const soldTotal = schedule.seatClasses.reduce((sum, c) => sum + c.sold, 0);
        if (soldTotal > 0 && body.confirmSoldTimeChange !== true) {
          throw new BadRequestError(
            `该班次已售 ${soldTotal} 座，改时刻将影响存量订单（客人通知/签证时点/酒店入住/已提交航司的名单）。` +
              '请确认后重试（带确认标志）；改点后请逐项跟进：通知客人、复核护照/签证有效期、核对酒店入住日、重新导出航司名单。',
          );
        }
      }

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
    // 容量下调不再一刀切拦下「低于已售 + 占位」：航司减配 / 换机型会把真实容量压到
    // 有效占用之下，运营必须能录入真实容量、在座位统计里看到「超售 N」去协调。
    // 锁位不计入有效占用：锁位只有 10 分钟，是瞬态库存；计入容量编辑会让结果随锁位
    // 到期时间随机变化，导致容量调整无故失败。销售侧仍按 sold+qty+locked+held ≤ capacity
    // 的原子 CAS 防止继续超卖。命中超售的舱位更新后写 WARNING 审计。
    const oversoldSeatChanges: Array<{
      cabin: CabinClass;
      sold: number;
      held: number;
      capacityBefore: number;
      capacityAfter: number;
      oversoldBy: number;
    }> = [];
    await prisma.$transaction(async (tx) => {
      const capacityUpdates = seatUpdates.filter((upd) => upd.capacity !== undefined);
      if (typeof tx.$queryRaw === 'function') {
        for (const upd of capacityUpdates) {
          const current = seatClassByCabin.get(upd.cabin);
          if (current) {
            await tx.$queryRaw`
              SELECT id FROM "FlightSeatClass" WHERE id = ${current.id} FOR UPDATE
            `;
          }
        }
      }

      // 同一事务读取占位余座，避免容量调整与建占位并发时使用过期数据。
      const heldBySeatClass = await heldSeatsBySeatClass(
        tx,
        capacityUpdates.flatMap((upd) => {
          const current = seatClassByCabin.get(upd.cabin);
          return current ? [current.id] : [];
        }),
      );
      for (const upd of seatUpdates) {
        const current = seatClassByCabin.get(upd.cabin);
        if (!current) {
          throw new BadRequestError(`该班次没有${CABIN_LABEL[upd.cabin]}（${upd.cabin}）`);
        }
        if (upd.capacity !== undefined) {
          const held = heldBySeatClass.get(current.id) ?? 0;
          const oversoldBy = current.sold + held - upd.capacity;
          if (oversoldBy > 0) {
            oversoldSeatChanges.push({
              cabin: upd.cabin,
              sold: current.sold,
              held,
              capacityBefore: current.capacity,
              capacityAfter: upd.capacity,
              oversoldBy,
            });
          }
        }
      }

      // 有效占用 = sold + held；锁位不计入（锁位只有 10 分钟，是瞬态库存）。
      const maxOversell = env.FLIGHT_MAX_OVERSELL_SEATS;
      const overCapChanges = oversoldSeatChanges.filter((c) => c.oversoldBy > maxOversell);
      if (overCapChanges.length > 0) {
        throw new BadRequestError(
          `超售 ${overCapChanges
            .map((c) => `${CABIN_LABEL[c.cabin]}${c.oversoldBy}（已售${c.sold}+占位${c.held}）`)
            .join('、')} 座超过上限 ${maxOversell} 座，请核对容量是否输错；上限可调`,
        );
      }

      // 时刻 + isActive 一次写（减少 round-trips）
      const scheduleData: Prisma.FlightScheduleUpdateInput = {};
      if (body.isActive !== undefined) scheduleData.isActive = body.isActive;
      if (newDep) scheduleData.departureTime = newDep;
      if (newArr) scheduleData.arrivalTime = newArr;
      // 关柜提前分钟数：给了数就写，给 null 是「清空、回落系统默认」（见 lib/checkin-close.ts）；
      // 不传则整项不动。不设二次确认闸 —— 它只影响 no-show 从哪一刻起可标，不动钱也不动座。
      if (body.checkinCloseMinutes !== undefined) {
        scheduleData.checkinCloseMinutes = body.checkinCloseMinutes;
      }
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
        // 审计页给人看：时刻按本班次 departureTz 折成当地钟点（站内一律用「当地时间」表述）。
        // 直接拼 toISOString() 会把 UTC 串怼到运营眼前，跟航司改点公告差 7/8 小时。
        // before/after 里仍留 ISO UTC 原值，机器对账用。
        targetLabel: `班次 ${scheduleId}（${localDateTime(
          schedule.departureTime,
          schedule.departureTz,
        )} → ${localDateTime(updated.departureTime, schedule.departureTz)}，当地时间）`,
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

    // ── 超售审计：容量被压到 sold + held 之下（航司减配/换机型）──────────────
    // 库存变成"账面欠座"，需要人工与航司/操作部协调，必须可追溯到人和时点。
    if (oversoldSeatChanges.length > 0) {
      await writeAudit({
        actor: actor ?? {},
        action: 'UPDATE_SCHEDULE_CAPACITY_OVERSOLD',
        targetType: AuditTargetType.FLIGHT,
        targetId: scheduleId,
        targetLabel: `班次 ${scheduleId} 容量低于已售+占位（超售 ${oversoldSeatChanges
          .map((c) => `${CABIN_LABEL[c.cabin]}${c.oversoldBy}`)
          .join('、')}）`,
        before: {
          seatClasses: oversoldSeatChanges.map((c) => ({
            cabin: c.cabin,
            capacity: c.capacityBefore,
            sold: c.sold,
            held: c.held,
          })),
        },
        after: {
          seatClasses: oversoldSeatChanges.map((c) => ({
            cabin: c.cabin,
            capacity: c.capacityAfter,
            sold: c.sold,
            held: c.held,
            oversoldBy: c.oversoldBy,
          })),
        },
        severity: AuditSeverity.WARNING,
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
   * （提示改用「售罄」即停用，保留历史数据）。
   * 同理：本班次若有生效中的锁位（SeatLock ACTIVE）或候补（SeatWaitlist ACTIVE），
   * 也禁删 —— 这两张表都是 onDelete: Cascade 挂在 FlightSchedule 上，硬删班次会
   * 把这些生效记录一并静默清空（用户占的位/候补资格无声消失）。
   * 任何占位单记录（含 RELEASED / CANCELLED / CONVERTED 历史态）都拦截；
   * 无销售、无生效锁位/候补/占位单才硬删（级联清掉舱位 / 仓位阶梯）。
   * 占位单已纳入删除守卫；旧切位模块按冻结策略不在本链路改动。
   */
  async deleteSchedule(scheduleId: string) {
    const schedule = await prisma.flightSchedule.findUnique({
      where: { id: scheduleId },
      include: {
        orderItems: { take: 1 },
        seatClasses: { select: { sold: true } },
        seatLocks: { where: { status: SeatLockStatus.ACTIVE }, select: { id: true }, take: 1 },
        seatWaitlists: {
          where: { status: WaitlistStatus.ACTIVE },
          select: { id: true },
          take: 1,
        },
        holdOrders: {
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!schedule) throw new NotFoundError('班次不存在');

    const hasSold = schedule.seatClasses.some((c) => c.sold > 0);
    const hasOrders = schedule.orderItems.length > 0;
    if (hasSold || hasOrders) {
      throw new BadRequestError('该班次已有销售，不能删除（请改用售罄）');
    }
    if (schedule.seatLocks.length > 0 || schedule.seatWaitlists.length > 0) {
      throw new BadRequestError('该班次有生效中的锁位/候补，暂不能删除');
    }
    if ((schedule.holdOrders?.length ?? 0) > 0) {
      throw new BadRequestError('该班次已有占位单记录，不能删除（请改用停用，保留历史数据）');
    }

    // 无销售、无生效锁位/候补/占位单：硬删（onDelete: Cascade 自动清掉 seatClasses 及其 fareBuckets）
    await prisma.flightSchedule.delete({ where: { id: scheduleId } });
    return { id: scheduleId, deleted: true };
  }

  /**
   * 批量删除班次（路由层限 ADMIN/STAFF）。
   * 场景：一天两班、整月排期，运营想按出发日区间删掉其中某档班次，又不想逐个点。
   * 出发日区间 [from, to]（出发地当地 UTC+8 日，闭区间）内选出班次；flightId 省略=全部航班。
   * 每个班次沿用 deleteSchedule 同口径的"有销售则禁删"守卫（任一舱位 sold>0，或有订单项关联，
   * 或有锁位/候补/任何占位单记录）：命中守卫 → 跳过（不删），记入 skipped；否则硬删（级联清掉舱位 / 仓位阶梯）。
   * 事务内一次删掉本批可删项，保证要么全部落库、要么整体回滚（已跳过项不参与删除，天然安全）。
   * 删除成功后写审计（删除数 + 已删/跳过的 scheduleId），批量删的爆炸半径大，必须留痕可追溯。
   * 占位单已纳入删除守卫；旧切位模块按冻结策略不在本链路改动。
   */
  async batchDeleteSchedules(
    body: { flightId?: string; from: string; to: string },
    actor?: AuditActor,
  ) {
    // from/to 是出发地当地(UTC+8)日期；折算到 UTC 瞬间（与 listSchedulesInRange 同口径，避免 8h 边界偏移）。
    const localDayStartUtc = (d: string) => {
      const [y, m, dd] = d.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, dd, -8, 0, 0));
    };
    const where: Prisma.FlightScheduleWhereInput = {
      departureTime: {
        gte: localDayStartUtc(body.from),
        lte: new Date(localDayStartUtc(body.to).getTime() + 24 * 3600 * 1000 - 1),
      },
      ...(body.flightId ? { flightId: body.flightId } : {}),
    };

    const schedules = await prisma.flightSchedule.findMany({
      where,
      orderBy: { departureTime: 'asc' },
      include: {
        orderItems: { take: 1 },
        seatClasses: { select: { sold: true } },
        seatLocks: { where: { status: SeatLockStatus.ACTIVE }, select: { id: true }, take: 1 },
        seatWaitlists: {
          where: { status: WaitlistStatus.ACTIVE },
          select: { id: true },
          take: 1,
        },
        holdOrders: {
          select: { id: true },
          take: 1,
        },
      },
    });

    // 先分流：哪些可删、哪些因已售/有生效锁位、候补或占位单跳过（沿用单删守卫口径）。
    const deletableIds: string[] = [];
    const skipped: Array<{ scheduleId: string; reason: string }> = [];
    for (const s of schedules) {
      const hasSold = s.seatClasses.some((c) => c.sold > 0);
      const hasOrders = s.orderItems.length > 0;
      const hasActiveLockOrWaitlist = s.seatLocks.length > 0 || s.seatWaitlists.length > 0;
      const hasHoldOrder = (s.holdOrders?.length ?? 0) > 0;
      if (hasSold || hasOrders) {
        skipped.push({ scheduleId: s.id, reason: '已售' });
      } else if (hasActiveLockOrWaitlist) {
        skipped.push({ scheduleId: s.id, reason: '有生效中的锁位/候补' });
      } else if (hasHoldOrder) {
        skipped.push({ scheduleId: s.id, reason: '有占位单记录' });
      } else {
        deletableIds.push(s.id);
      }
    }

    if (deletableIds.length > 0) {
      // 事务内一次删掉所有可删班次（onDelete: Cascade 自动清舱位/阶梯）。
      await prisma.$transaction([
        prisma.flightSchedule.deleteMany({ where: { id: { in: deletableIds } } }),
      ]);

      // 批量删爆炸半径大 —— 写审计留痕（删除数 + 已删/跳过明细）。
      // 沿用 updateSchedule 的 writeAudit 口径（fire-and-forget，不参与上面的删除事务）。
      const skippedIds = skipped.map((s) => s.scheduleId);
      await writeAudit({
        actor: actor ?? {},
        action: 'BATCH_DELETE_SCHEDULES',
        targetType: AuditTargetType.FLIGHT,
        targetId: body.flightId,
        targetLabel: `批量删除班次 ${deletableIds.length} 条（出发日 ${body.from} ~ ${body.to}${
          body.flightId ? `，航班 ${body.flightId}` : '，全部航班'
        }）`,
        after: {
          deletedCount: deletableIds.length,
          deletedScheduleIds: deletableIds,
          skippedScheduleIds: skippedIds,
        },
        severity: AuditSeverity.WARNING,
      });
    }

    return { deleted: deletableIds.length, skipped };
  }

  /**
   * 批量改容量（路由层限 ADMIN）。
   * 场景：航司调整机型/客舱布局，运营要把一批班次的某舱位容量从旧值改到新值
   * （如经济 180→184、商务 20→7），逐个点太慢。
   * 按 scheduleId 列表逐条处理（scheduleId 由前端按"日期区间 + 星期几"筛出，
   * 复用批量改价面板已有的班次选择范围）：
   *   - 每条按 cabin 定位舱位，套用与单班次编辑（updateSchedule）同口径：有效占用为
   *     sold + held（锁位是 10 分钟瞬态，不计入容量调整），容量可以低于有效占用，
   *     在返回体的 oversold 明细与审计里点名，销售侧照旧按 CAS 拒卖；
   *   - 超售张数超过上限（FLIGHT_MAX_OVERSELL_SEATS，防手滑）→ 该班次整条不改，
   *     放进 skipped 带原因，不拖累批次里其它班次（不是整批失败）；
   *   - 该班次没有请求里的某个舱位 → 那一项静默跳过（不算失败）；
   *   - 请求的舱位在该班次里一个都不存在 → 整个班次跳过，记入 skipped；
   *   - scheduleId 查无此班次 → 跳过，记入 skipped。
   * 可执行的改动一次事务写入，保证要么全部落库、要么整体回滚。
   * 写审计留痕（改了几个班次 + 已改/跳过明细），批量操作爆炸半径大，必须可追溯。
   */
  async batchUpdateCapacity(body: BatchUpdateCapacityBody, actor?: AuditActor) {
    // 判定与写入同一事务：先锁涉及的舱位行（FOR UPDATE），锁到手后重读 sold、同事务读 held，
    // 再算超售/上限。与 updateSchedule 单班次路径同一纪律——否则批处理期间新落地的
    // 占位单/订单会让超售判定与审计口径用到过期快照（真正的卖票防线仍在 orders/hold-orders
    // 的 CAS，这里保证的是提示与审计数字的准确）。
    const { appliedIds, skipped, oversold } = await prisma.$transaction(async (tx) => {
      // 第一读只为拿锁定目标（舱位行 id），数值以锁后的重读为准。
      const lockTargets = await tx.flightSchedule.findMany({
        where: { id: { in: body.scheduleIds } },
        include: { seatClasses: true },
      });
      const seatClassIds = lockTargets.flatMap((s) => s.seatClasses.map((c) => c.id));
      if (typeof tx.$queryRaw === 'function') {
        for (const seatClassId of seatClassIds) {
          await tx.$queryRaw`
            SELECT id FROM "FlightSeatClass" WHERE id = ${seatClassId} FOR UPDATE
          `;
        }
      }
      const schedules = await tx.flightSchedule.findMany({
        where: { id: { in: body.scheduleIds } },
        include: { seatClasses: true },
      });
      const scheduleById = new Map(schedules.map((s) => [s.id, s]));
      const heldBySeatClass = await heldSeatsBySeatClass(
        tx,
        schedules.flatMap((s) => s.seatClasses.map((c) => c.id)),
      );

      const appliedIds: string[] = [];
      const skipped: Array<{ scheduleId: string; reason: string }> = [];
      const updates: Array<{ seatClassId: string; capacity: number }> = [];
      // 目标容量低于 sold + held 的班次：照改，但单列出来提示运营去协调（返回体 + 审计）。
      // 锁位不计入：锁位只有 10 分钟，是瞬态库存，避免容量编辑随机受锁位到期影响。
      const oversold: Array<{ scheduleId: string; cabin: CabinClass; sold: number; held: number; capacity: number; oversoldBy: number }> = [];
      // 超售上限守卫（同 updateSchedule 口径，防止批量场景手滑输错容量炸更大的坑）
      const maxOversell = env.FLIGHT_MAX_OVERSELL_SEATS;

      for (const scheduleId of body.scheduleIds) {
        const schedule = scheduleById.get(scheduleId);
        if (!schedule) {
          skipped.push({ scheduleId, reason: '班次不存在' });
          continue;
        }
        const seatClassByCabin = new Map(schedule.seatClasses.map((c) => [c.cabin, c]));
        const scheduleUpdates: Array<{ seatClassId: string; capacity: number }> = [];
        const scheduleOversold: typeof oversold = [];
        let overCapReason: string | null = null;
        for (const item of body.seatClasses) {
          const current = seatClassByCabin.get(item.cabin);
          if (!current) continue; // 该班次没有此舱位：这一项静默跳过，不算失败
          const held = heldBySeatClass.get(current.id) ?? 0;
          const oversoldBy = current.sold + held - item.capacity;
          if (oversoldBy > 0) {
            if (oversoldBy > maxOversell) {
              // 超过上限：整个班次不改（不部分应用），放进 skipped 带原因，不拖累其它班次
              overCapReason = `${CABIN_LABEL[item.cabin]}超售 ${oversoldBy} 座（已售${current.sold}+占位${held}）超过上限 ${maxOversell} 座，请核对容量是否输错；上限可调`;
              break;
            }
            scheduleOversold.push({
              scheduleId,
              cabin: item.cabin,
              sold: current.sold,
              held,
              capacity: item.capacity,
              oversoldBy,
            });
          }
          scheduleUpdates.push({ seatClassId: current.id, capacity: item.capacity });
        }
        if (overCapReason) {
          skipped.push({ scheduleId, reason: overCapReason });
          continue;
        }
        if (scheduleUpdates.length === 0) {
          skipped.push({ scheduleId, reason: '该班次没有匹配的舱位' });
          continue;
        }
        updates.push(...scheduleUpdates);
        oversold.push(...scheduleOversold);
        appliedIds.push(scheduleId);
      }

      for (const u of updates) {
        await tx.flightSeatClass.update({
          where: { id: u.seatClassId },
          data: { capacity: u.capacity },
        });
      }

      return { appliedIds, skipped, oversold };
    });

    if (appliedIds.length > 0) {
      // 批量改动爆炸半径大 —— 写审计留痕（沿用 batchDeleteSchedules 的 fire-and-forget 口径）。
      await writeAudit({
        actor: actor ?? {},
        action: 'BATCH_UPDATE_CAPACITY',
        targetType: AuditTargetType.FLIGHT,
        targetLabel: `批量改容量 ${appliedIds.length} 个班次${
          oversold.length > 0 ? `（其中 ${oversold.length} 个舱位容量低于已售+占位 → 超售）` : ''
        }`,
        after: {
          appliedScheduleIds: appliedIds,
          skipped,
          seatClasses: body.seatClasses,
          oversold,
        },
        severity: AuditSeverity.WARNING,
      });
    }

    return { applied: appliedIds.length, skipped, oversold };
  }

  /**
   * 批量改时刻（路由层限 ADMIN）。
   * 场景：航司整段改点——"8/5 起这批班次都改成当地 16:40 起飞 / 17:35 到达"。
   * 之前只能一个班次点一次「改时刻」，一百来个班次要点一百来次。
   *
   * 口径（关键，别按 UTC 理解）：
   *   - 运营填的是**当地钟点** HH:mm。每个班次拿自己现有的当地出发日（按 departureTz 折算），
   *     配上新钟点，再折回 UTC 落库 —— 所以各班次的当地出发日不变，只有钟点变。
   *     正因为出发日不变，「一个航班号一天只能一班」不可能被这个操作打破，无需再查重。
   *   - 到达日 = 出发当地日（arrivalNextDay 为 true 时 +1 天），按 arrivalTz 折算成 UTC。
   *     跨时区航段两头时区不同（澳门 +8 / 越南 +7），必须各按各的折。
   *   - 到达不晚于出发 → 该班次跳过（不改），记入 skipped，不拖累批次里其它班次。
   *
   * 已售闸：与单班次 updateSchedule 同一道 —— 批次里只要有一个已售班次时刻真的会变，
   * 且没带 confirmSoldTimeChange，就整批拒绝并回报影响面（几个班次、共几座）。
   * 改点影响存量订单的客人通知 / 签证时点 / 酒店入住 / 已提交航司的名单，不能一改了之。
   *
   * 可执行的改动一次事务写入；写 WARNING 审计留痕（批量操作爆炸半径大，必须可追溯）。
   */
  async batchUpdateScheduleTimes(body: BatchUpdateScheduleTimesBody, actor?: AuditActor) {
    const schedules = await prisma.flightSchedule.findMany({
      where: { id: { in: body.scheduleIds } },
      include: { seatClasses: { select: { sold: true } } },
    });
    const scheduleById = new Map(schedules.map((s) => [s.id, s]));

    const skipped: Array<{ scheduleId: string; reason: string }> = [];
    const updates: Array<{ scheduleId: string; departureTime: Date; arrivalTime: Date }> = [];
    // 时刻真的会变、且已售 > 0 的班次——用于二次确认闸的影响面报文
    let soldSchedules = 0;
    let soldSeats = 0;

    for (const scheduleId of body.scheduleIds) {
      const schedule = scheduleById.get(scheduleId);
      if (!schedule) {
        skipped.push({ scheduleId, reason: '班次不存在' });
        continue;
      }

      // 出发当地日锚定在班次现有值上，只换钟点
      const depLocalDay = localDateISO(schedule.departureTime, schedule.departureTz);
      const arrLocalDay = body.arrivalNextDay ? addLocalDays(depLocalDay, 1) : depLocalDay;

      let newDep: Date;
      let newArr: Date;
      try {
        newDep = localToUtc(depLocalDay, body.departureLocalTime, schedule.departureTz);
        newArr = localToUtc(arrLocalDay, body.arrivalLocalTime, schedule.arrivalTz);
      } catch {
        skipped.push({ scheduleId, reason: '时刻折算失败（时区或日期异常）' });
        continue;
      }

      if (newArr <= newDep) {
        skipped.push({
          scheduleId,
          reason: '到达不晚于出发（跨零点到达请勾选「到达次日」）',
        });
        continue;
      }

      const changed =
        newDep.getTime() !== schedule.departureTime.getTime() ||
        newArr.getTime() !== schedule.arrivalTime.getTime();
      if (!changed) {
        skipped.push({ scheduleId, reason: '时刻与现值相同，无需修改' });
        continue;
      }

      const sold = schedule.seatClasses.reduce((sum, c) => sum + c.sold, 0);
      if (sold > 0) {
        soldSchedules += 1;
        soldSeats += sold;
      }
      updates.push({ scheduleId, departureTime: newDep, arrivalTime: newArr });
    }

    if (soldSchedules > 0 && body.confirmSoldTimeChange !== true) {
      throw new BadRequestError(
        `这批里有 ${soldSchedules} 个班次已售共 ${soldSeats} 座，改时刻将影响存量订单` +
          '（客人通知/签证时点/酒店入住/已提交航司的名单）。请确认后重试（带确认标志）；' +
          '改点后请逐项跟进：通知客人、复核护照/签证有效期、核对酒店入住日、重新导出航司名单。',
      );
    }

    if (updates.length > 0) {
      await prisma.$transaction(
        updates.map((u) =>
          prisma.flightSchedule.update({
            where: { id: u.scheduleId },
            data: { departureTime: u.departureTime, arrivalTime: u.arrivalTime },
          }),
        ),
      );

      await writeAudit({
        actor: actor ?? {},
        action: 'BATCH_UPDATE_SCHEDULE_TIMES',
        targetType: AuditTargetType.FLIGHT,
        targetLabel:
          `批量改时刻 ${updates.length} 个班次 → 当地 ${body.departureLocalTime}` +
          `-${body.arrivalLocalTime}${body.arrivalNextDay ? '(次日到达)' : ''}` +
          `${soldSchedules > 0 ? `（其中 ${soldSchedules} 个已售共 ${soldSeats} 座）` : ''}`,
        after: {
          appliedScheduleIds: updates.map((u) => u.scheduleId),
          departureLocalTime: body.departureLocalTime,
          arrivalLocalTime: body.arrivalLocalTime,
          arrivalNextDay: body.arrivalNextDay,
          soldSchedules,
          soldSeats,
          skipped,
        },
        severity: AuditSeverity.WARNING,
      });
    }

    return { applied: updates.length, skipped, soldSchedules, soldSeats };
  }
}

/** 当地日 'YYYY-MM-DD' 加减天数（纯日历运算，不涉时区偏移）。 */
function addLocalDays(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}
