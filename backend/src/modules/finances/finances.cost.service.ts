/**
 * 财务成本编辑 service
 *
 * 给 admin-web「成本维护」tab 和产品管理页提供：
 *   - 产品成本字段的 patch（CNY，已移除汇率/多币种）
 *   - 航班班次成本列表（listSchedulesWithCost）
 *   - 航班成本周期（FlightCostPeriod）CRUD —— 按航班号+日期段定包机/机场税
 *
 * 成本解析（每字段独立）：
 *   effective = schedule.<field>(override) ?? matchedPeriod.<field>(period) ?? null
 *   班次自己的字段为 null 时落回所在日期段的周期默认。日期匹配按航班出发地时区算。
 *
 * 所有写操作由 routes 层负责 ADMIN 鉴权 + 审计日志。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function dec(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 返回 'YYYY-MM-DD'，按指定 IANA 时区算的日期。tz 不识别时回退 UTC。 */
export function localDate(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Prisma DateTime @db.Date 返回 UTC 0:00 的 Date；序列化为 'YYYY-MM-DD'。 */
export function fmtDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── 成本解析（per-field override → period → null）────────────────────────────

export type CostSource = 'override' | 'period' | 'none';

export interface EffectiveCost {
  charterCostCny: number | null;
  airportTaxDepCny: number | null;
  airportTaxArrCny: number | null;
  fuelCostCny: number | null;
  peakSurchargeCny: number | null;
  aircraftAdjustCny: number | null;
  takeoffDiscountCny: number | null;
  charterCostCnySource: CostSource;
  airportTaxDepCnySource: CostSource;
  airportTaxArrCnySource: CostSource;
  fuelCostCnySource: CostSource;
  peakSurchargeCnySource: CostSource;
  aircraftAdjustCnySource: CostSource;
  takeoffDiscountCnySource: CostSource;
}

interface ScheduleCostInputs {
  departureTime: Date;
  departureTz: string;
  charterCostCny: Prisma.Decimal | null;
  airportTaxDepCny: Prisma.Decimal | null;
  airportTaxArrCny: Prisma.Decimal | null;
  fuelCostCny: Prisma.Decimal | null;
  peakSurchargeCny: Prisma.Decimal | null;
  aircraftAdjustCny: Prisma.Decimal | null;
  takeoffDiscountCny: Prisma.Decimal | null;
}

interface PeriodInputs {
  effectiveFrom: Date;
  effectiveTo: Date;
  charterCostCny: Prisma.Decimal | null;
  airportTaxDepCny: Prisma.Decimal | null;
  airportTaxArrCny: Prisma.Decimal | null;
  fuelCostCny: Prisma.Decimal | null;
  peakSurchargeCny: Prisma.Decimal | null;
  aircraftAdjustCny: Prisma.Decimal | null;
  takeoffDiscountCny: Prisma.Decimal | null;
}

/** 在给定航班的周期列表里，找覆盖该班次出发日（按航班出发地时区）的那一条。 */
export function findMatchedPeriod<P extends PeriodInputs>(
  schedule: ScheduleCostInputs,
  periodsForFlight: P[],
): P | null {
  const dateStr = localDate(schedule.departureTime, schedule.departureTz);
  return (
    periodsForFlight.find(
      (p) => fmtDateOnly(p.effectiveFrom) <= dateStr && dateStr <= fmtDateOnly(p.effectiveTo),
    ) ?? null
  );
}

/** 把班次 + 命中周期解析为生效成本（每字段独立 override→period→null）。 */
export function resolveScheduleCost(
  schedule: ScheduleCostInputs,
  matchedPeriod: PeriodInputs | null,
): EffectiveCost {
  const pick = (
    override: Prisma.Decimal | null,
    period: Prisma.Decimal | null | undefined,
  ): { value: number | null; source: CostSource } => {
    const o = dec(override);
    if (o != null) return { value: round2(o), source: 'override' };
    const p = dec(period ?? null);
    if (p != null) return { value: round2(p), source: 'period' };
    return { value: null, source: 'none' };
  };
  const c = pick(schedule.charterCostCny, matchedPeriod?.charterCostCny);
  const dep = pick(schedule.airportTaxDepCny, matchedPeriod?.airportTaxDepCny);
  const arr = pick(schedule.airportTaxArrCny, matchedPeriod?.airportTaxArrCny);
  const fuel = pick(schedule.fuelCostCny, matchedPeriod?.fuelCostCny);
  const peak = pick(schedule.peakSurchargeCny, matchedPeriod?.peakSurchargeCny);
  const adj = pick(schedule.aircraftAdjustCny, matchedPeriod?.aircraftAdjustCny);
  const disc = pick(schedule.takeoffDiscountCny, matchedPeriod?.takeoffDiscountCny);
  return {
    charterCostCny: c.value,
    airportTaxDepCny: dep.value,
    airportTaxArrCny: arr.value,
    fuelCostCny: fuel.value,
    peakSurchargeCny: peak.value,
    aircraftAdjustCny: adj.value,
    takeoffDiscountCny: disc.value,
    charterCostCnySource: c.source,
    airportTaxDepCnySource: dep.source,
    airportTaxArrCnySource: arr.source,
    fuelCostCnySource: fuel.source,
    peakSurchargeCnySource: peak.source,
    aircraftAdjustCnySource: adj.source,
    takeoffDiscountCnySource: disc.source,
  };
}

/** 给一批 flightIds 批量预加载周期，返回 Map<flightId, periods[]>。用 listSchedulesWithCost/getFlightPnl/export 这种批处理。 */
export async function loadPeriodsByFlightIds(
  flightIds: string[],
  client: PrismaClient = defaultPrisma,
): Promise<Map<string, PeriodInputs[]>> {
  if (flightIds.length === 0) return new Map();
  const periods = await client.flightCostPeriod.findMany({
    where: { flightId: { in: flightIds } },
    orderBy: { effectiveFrom: 'desc' },
    select: {
      flightId: true,
      effectiveFrom: true,
      effectiveTo: true,
      charterCostCny: true,
      airportTaxDepCny: true,
      airportTaxArrCny: true,
      fuelCostCny: true,
      peakSurchargeCny: true,
      aircraftAdjustCny: true,
      takeoffDiscountCny: true,
    },
  });
  const map = new Map<string, PeriodInputs[]>();
  for (const p of periods) {
    const arr = map.get(p.flightId) ?? [];
    arr.push(p);
    map.set(p.flightId, arr);
  }
  return map;
}

// ── 航班成本周期（CRUD，admin-only）─────────────────────────────────────────

export interface CostPeriodDto {
  id: string;
  flightId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string; // YYYY-MM-DD
  charterCostCny: number | null;
  airportTaxDepCny: number | null;
  airportTaxArrCny: number | null;
  fuelCostCny: number | null;
  peakSurchargeCny: number | null;
  aircraftAdjustCny: number | null;
  takeoffDiscountCny: number | null;
  note: string | null;
  updatedAt: string;
}

type PeriodWriteInput = {
  flightId: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string; // YYYY-MM-DD
  charterCostCny?: number | null;
  airportTaxDepCny?: number | null;
  airportTaxArrCny?: number | null;
  fuelCostCny?: number | null;
  peakSurchargeCny?: number | null;
  aircraftAdjustCny?: number | null;
  takeoffDiscountCny?: number | null;
  // A2 汇率四元组（可空审计留痕）：包机原币种/原币金额/汇率/折算日；CNY 仍是唯一入账口径
  charterSourceCurrency?: string | null;
  charterSourceAmount?: number | null;
  charterFxRate?: number | null;
  charterFxDate?: string | null; // YYYY-MM-DD
  note?: string | null;
};

function toDateOnly(s: string): Date {
  // 'YYYY-MM-DD' → UTC midnight. Prisma @db.Date stores date-only, this is the canonical input.
  return new Date(`${s}T00:00:00.000Z`);
}

function toDto(row: {
  id: string;
  flightId: string;
  effectiveFrom: Date;
  effectiveTo: Date;
  charterCostCny: Prisma.Decimal | null;
  airportTaxDepCny: Prisma.Decimal | null;
  airportTaxArrCny: Prisma.Decimal | null;
  fuelCostCny: Prisma.Decimal | null;
  peakSurchargeCny: Prisma.Decimal | null;
  aircraftAdjustCny: Prisma.Decimal | null;
  takeoffDiscountCny: Prisma.Decimal | null;
  note: string | null;
  updatedAt: Date;
  flight: { flightNumber: string; originCode: string; destinationCode: string };
}): CostPeriodDto {
  const r2 = (v: Prisma.Decimal | null): number | null => {
    const d = dec(v);
    return d == null ? null : round2(d);
  };
  return {
    id: row.id,
    flightId: row.flightId,
    flightNumber: row.flight.flightNumber,
    origin: row.flight.originCode,
    destination: row.flight.destinationCode,
    effectiveFrom: fmtDateOnly(row.effectiveFrom),
    effectiveTo: fmtDateOnly(row.effectiveTo),
    charterCostCny: r2(row.charterCostCny),
    airportTaxDepCny: r2(row.airportTaxDepCny),
    airportTaxArrCny: r2(row.airportTaxArrCny),
    fuelCostCny: r2(row.fuelCostCny),
    peakSurchargeCny: r2(row.peakSurchargeCny),
    aircraftAdjustCny: r2(row.aircraftAdjustCny),
    takeoffDiscountCny: r2(row.takeoffDiscountCny),
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCostPeriods(
  filter: { flightId?: string } = {},
  client: PrismaClient = defaultPrisma,
): Promise<CostPeriodDto[]> {
  const rows = await client.flightCostPeriod.findMany({
    where: filter.flightId ? { flightId: filter.flightId } : undefined,
    orderBy: [{ flightId: 'asc' }, { effectiveFrom: 'desc' }],
    include: {
      flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
    },
  });
  return rows.map(toDto);
}

/** 校验：from ≤ to + 同 flightId 不允许跟现有周期重叠（excludeId 用于 update 时排除自己）。抛 Error。 */
async function assertNoOverlap(
  flightId: string,
  from: Date,
  to: Date,
  excludeId: string | null,
  client: PrismaClient,
): Promise<void> {
  if (from.getTime() > to.getTime()) {
    throw new Error('起始日不能晚于结束日');
  }
  const overlap = await client.flightCostPeriod.findFirst({
    where: {
      flightId,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
      AND: [
        { effectiveFrom: { lte: to } },
        { effectiveTo: { gte: from } },
      ],
    },
    select: { id: true, effectiveFrom: true, effectiveTo: true },
  });
  if (overlap) {
    throw new Error(
      `周期与现有周期重叠（${fmtDateOnly(overlap.effectiveFrom)} → ${fmtDateOnly(overlap.effectiveTo)}）`,
    );
  }
}

export async function createCostPeriod(
  input: PeriodWriteInput,
  client: PrismaClient = defaultPrisma,
): Promise<CostPeriodDto> {
  const from = toDateOnly(input.effectiveFrom);
  const to = toDateOnly(input.effectiveTo);
  await assertNoOverlap(input.flightId, from, to, null, client);
  const row = await client.flightCostPeriod.create({
    data: {
      flightId: input.flightId,
      effectiveFrom: from,
      effectiveTo: to,
      charterCostCny: input.charterCostCny ?? null,
      airportTaxDepCny: input.airportTaxDepCny ?? null,
      airportTaxArrCny: input.airportTaxArrCny ?? null,
      fuelCostCny: input.fuelCostCny ?? null,
      peakSurchargeCny: input.peakSurchargeCny ?? null,
      aircraftAdjustCny: input.aircraftAdjustCny ?? null,
      takeoffDiscountCny: input.takeoffDiscountCny ?? null,
      charterSourceCurrency: input.charterSourceCurrency ?? null,
      charterSourceAmount: input.charterSourceAmount ?? null,
      charterFxRate: input.charterFxRate ?? null,
      charterFxDate: input.charterFxDate ? toDateOnly(input.charterFxDate) : null,
      note: input.note ?? null,
    },
    include: {
      flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
    },
  });
  return toDto(row);
}

export async function updateCostPeriod(
  id: string,
  input: Partial<Omit<PeriodWriteInput, 'flightId'>>,
  client: PrismaClient = defaultPrisma,
): Promise<CostPeriodDto> {
  const existing = await client.flightCostPeriod.findUnique({ where: { id } });
  if (!existing) throw new Error('周期不存在');
  const from = input.effectiveFrom ? toDateOnly(input.effectiveFrom) : existing.effectiveFrom;
  const to = input.effectiveTo ? toDateOnly(input.effectiveTo) : existing.effectiveTo;
  if (input.effectiveFrom || input.effectiveTo) {
    await assertNoOverlap(existing.flightId, from, to, id, client);
  }
  const data: Prisma.FlightCostPeriodUpdateInput = {};
  if (input.effectiveFrom) data.effectiveFrom = from;
  if (input.effectiveTo) data.effectiveTo = to;
  if (input.charterCostCny !== undefined) data.charterCostCny = input.charterCostCny ?? null;
  if (input.airportTaxDepCny !== undefined) data.airportTaxDepCny = input.airportTaxDepCny ?? null;
  if (input.airportTaxArrCny !== undefined) data.airportTaxArrCny = input.airportTaxArrCny ?? null;
  if (input.fuelCostCny !== undefined) data.fuelCostCny = input.fuelCostCny ?? null;
  if (input.peakSurchargeCny !== undefined) data.peakSurchargeCny = input.peakSurchargeCny ?? null;
  if (input.aircraftAdjustCny !== undefined) data.aircraftAdjustCny = input.aircraftAdjustCny ?? null;
  if (input.takeoffDiscountCny !== undefined) data.takeoffDiscountCny = input.takeoffDiscountCny ?? null;
  if (input.charterSourceCurrency !== undefined) data.charterSourceCurrency = input.charterSourceCurrency ?? null;
  if (input.charterSourceAmount !== undefined) data.charterSourceAmount = input.charterSourceAmount ?? null;
  if (input.charterFxRate !== undefined) data.charterFxRate = input.charterFxRate ?? null;
  if (input.charterFxDate !== undefined)
    data.charterFxDate = input.charterFxDate ? toDateOnly(input.charterFxDate) : null;
  if (input.note !== undefined) data.note = input.note ?? null;
  const row = await client.flightCostPeriod.update({
    where: { id },
    data,
    include: {
      flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
    },
  });
  return toDto(row);
}

export async function deleteCostPeriod(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.flightCostPeriod.delete({ where: { id } });
  return { id };
}

// ── 航班成本列表（财务页用，admin-only）──────────────────────────────────────

export interface FinanceScheduleRow {
  scheduleId: string;
  flightId: string;
  flightNumber: string;
  originCode: string;
  destinationCode: string;
  origin: string;
  destination: string;
  departureTime: string; // ISO
  // 生效值（override → period → null）—— 给显示用
  charterCostCny: number | null;
  airportTaxDepCny: number | null;
  airportTaxArrCny: number | null;
  fuelCostCny: number | null;
  peakSurchargeCny: number | null;
  aircraftAdjustCny: number | null;
  takeoffDiscountCny: number | null;
  // 班次自己存的值（即"覆盖"）—— 给编辑输入框绑定用；null = 不覆盖，用周期
  charterCostCnyOverride: number | null;
  airportTaxDepCnyOverride: number | null;
  airportTaxArrCnyOverride: number | null;
  fuelCostCnyOverride: number | null;
  peakSurchargeCnyOverride: number | null;
  aircraftAdjustCnyOverride: number | null;
  takeoffDiscountCnyOverride: number | null;
  // 命中周期的默认值 —— 给输入框 placeholder 用
  charterCostCnyPeriod: number | null;
  airportTaxDepCnyPeriod: number | null;
  airportTaxArrCnyPeriod: number | null;
  fuelCostCnyPeriod: number | null;
  peakSurchargeCnyPeriod: number | null;
  aircraftAdjustCnyPeriod: number | null;
  takeoffDiscountCnyPeriod: number | null;
  // 每字段的来源：override / period / none
  charterCostCnySource: CostSource;
  airportTaxDepCnySource: CostSource;
  airportTaxArrCnySource: CostSource;
  fuelCostCnySource: CostSource;
  peakSurchargeCnySource: CostSource;
  aircraftAdjustCnySource: CostSource;
  takeoffDiscountCnySource: CostSource;
  // 命中周期的信息（命中时非 null）
  matchedPeriodId: string | null;
  matchedPeriodFrom: string | null; // YYYY-MM-DD
  matchedPeriodTo: string | null;
  // 座位 + 派生
  totalSeats: number;
  soldSeats: number;
  /** 财务口径：包机费 ÷ 全部座位；包机费缺失或总座位为 0 时 null */
  perSeatCostCny: number | null;
  /** 财务口径：单座成本 × 未售座位数；包机费缺失或总座位为 0 时 null */
  emptySeatCostCny: number | null;
}

export async function listSchedulesWithCost(
  range?: { from?: string; to?: string },
  client: PrismaClient = defaultPrisma,
): Promise<FinanceScheduleRow[]> {
  const where: Prisma.FlightScheduleWhereInput = {};
  if (range?.from || range?.to) {
    where.departureTime = {};
    if (range.from) where.departureTime.gte = new Date(`${range.from}T00:00:00.000Z`);
    if (range.to) where.departureTime.lte = new Date(`${range.to}T23:59:59.999Z`);
  }
  const schedules = await client.flightSchedule.findMany({
    where,
    orderBy: { departureTime: 'desc' },
    include: {
      flight: {
        select: { id: true, flightNumber: true, originCode: true, destinationCode: true },
      },
      seatClasses: { select: { capacity: true, sold: true } },
    },
  });

  // 批量预加载所有相关航班的周期，避免 N+1
  const flightIds = Array.from(new Set(schedules.map((s) => s.flight.id)));
  const periodsMap = await loadPeriodsByFlightIds(flightIds, client);
  // 同时拉一下完整的周期行（含 id/from/to）以便 row 上能带"命中周期"信息
  const fullPeriods = await client.flightCostPeriod.findMany({
    where: { flightId: { in: flightIds } },
    orderBy: { effectiveFrom: 'desc' },
    select: {
      id: true,
      flightId: true,
      effectiveFrom: true,
      effectiveTo: true,
      charterCostCny: true,
      airportTaxDepCny: true,
      airportTaxArrCny: true,
      fuelCostCny: true,
      peakSurchargeCny: true,
      aircraftAdjustCny: true,
      takeoffDiscountCny: true,
    },
  });
  const fullByFlight = new Map<string, typeof fullPeriods>();
  for (const p of fullPeriods) {
    const arr = fullByFlight.get(p.flightId) ?? [];
    arr.push(p);
    fullByFlight.set(p.flightId, arr);
  }

  return schedules.map<FinanceScheduleRow>((s) => {
    const totalSeats = s.seatClasses.reduce((a, c) => a + c.capacity, 0);
    const soldSeats = s.seatClasses.reduce((a, c) => a + c.sold, 0);
    const periodsForFlight = periodsMap.get(s.flight.id) ?? [];
    const matched = findMatchedPeriod(s, periodsForFlight);
    const eff = resolveScheduleCost(s, matched);
    // 找完整的命中周期行（取 id/from/to）
    const matchedFull =
      matched == null
        ? null
        : (fullByFlight.get(s.flight.id) ?? []).find(
            (p) =>
              p.effectiveFrom.getTime() === matched.effectiveFrom.getTime() &&
              p.effectiveTo.getTime() === matched.effectiveTo.getTime(),
          ) ?? null;
    const r2n = (v: Prisma.Decimal | null | undefined): number | null => {
      const d = dec(v ?? null);
      return d == null ? null : round2(d);
    };
    // 财务口径：包机费÷全部座位，空座成本单列。
    const perSeat =
      eff.charterCostCny != null && totalSeats > 0 ? eff.charterCostCny / totalSeats : null;
    const emptySeatCost = perSeat == null ? null : perSeat * (totalSeats - soldSeats);
    return {
      scheduleId: s.id,
      flightId: s.flight.id,
      flightNumber: s.flight.flightNumber,
      originCode: s.flight.originCode,
      destinationCode: s.flight.destinationCode,
      origin: s.flight.originCode,
      destination: s.flight.destinationCode,
      departureTime: s.departureTime.toISOString(),
      // effective
      charterCostCny: eff.charterCostCny,
      airportTaxDepCny: eff.airportTaxDepCny,
      airportTaxArrCny: eff.airportTaxArrCny,
      fuelCostCny: eff.fuelCostCny,
      peakSurchargeCny: eff.peakSurchargeCny,
      aircraftAdjustCny: eff.aircraftAdjustCny,
      takeoffDiscountCny: eff.takeoffDiscountCny,
      // override (schedule own)
      charterCostCnyOverride: r2n(s.charterCostCny),
      airportTaxDepCnyOverride: r2n(s.airportTaxDepCny),
      airportTaxArrCnyOverride: r2n(s.airportTaxArrCny),
      fuelCostCnyOverride: r2n(s.fuelCostCny),
      peakSurchargeCnyOverride: r2n(s.peakSurchargeCny),
      aircraftAdjustCnyOverride: r2n(s.aircraftAdjustCny),
      takeoffDiscountCnyOverride: r2n(s.takeoffDiscountCny),
      // period default
      charterCostCnyPeriod: r2n(matched?.charterCostCny),
      airportTaxDepCnyPeriod: r2n(matched?.airportTaxDepCny),
      airportTaxArrCnyPeriod: r2n(matched?.airportTaxArrCny),
      fuelCostCnyPeriod: r2n(matched?.fuelCostCny),
      peakSurchargeCnyPeriod: r2n(matched?.peakSurchargeCny),
      aircraftAdjustCnyPeriod: r2n(matched?.aircraftAdjustCny),
      takeoffDiscountCnyPeriod: r2n(matched?.takeoffDiscountCny),
      // sources
      charterCostCnySource: eff.charterCostCnySource,
      airportTaxDepCnySource: eff.airportTaxDepCnySource,
      airportTaxArrCnySource: eff.airportTaxArrCnySource,
      fuelCostCnySource: eff.fuelCostCnySource,
      peakSurchargeCnySource: eff.peakSurchargeCnySource,
      aircraftAdjustCnySource: eff.aircraftAdjustCnySource,
      takeoffDiscountCnySource: eff.takeoffDiscountCnySource,
      matchedPeriodId: matchedFull?.id ?? null,
      matchedPeriodFrom: matched ? fmtDateOnly(matched.effectiveFrom) : null,
      matchedPeriodTo: matched ? fmtDateOnly(matched.effectiveTo) : null,
      totalSeats,
      soldSeats,
      perSeatCostCny: perSeat == null ? null : round2(perSeat),
      emptySeatCostCny: emptySeatCost == null ? null : round2(emptySeatCost),
    };
  });
}

// ── 产品成本 patch（统一 CNY）─────────────────────────────────────────────────

export async function patchFlightScheduleCost(
  id: string,
  data: {
    charterCostCny?: number | null;
    airportTaxDepCny?: number | null;
    airportTaxArrCny?: number | null;
    fuelCostCny?: number | null;
    peakSurchargeCny?: number | null;
    aircraftAdjustCny?: number | null;
    takeoffDiscountCny?: number | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.flightSchedule.update({ where: { id }, data });
  return { id };
}

export async function patchHotelRoomTypeCost(
  id: string,
  data: { costPriceCny?: number | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.hotelRoomType.update({ where: { id }, data });
  return { id };
}

export async function patchVisaCost(
  id: string,
  data: { costPriceCny?: number | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.visa.update({ where: { id }, data });
  return { id };
}

export async function patchTransferCost(
  id: string,
  data: { costPriceCny?: number | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.transfer.update({ where: { id }, data });
  return { id };
}
