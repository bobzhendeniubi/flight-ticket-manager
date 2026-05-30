/**
 * 财务成本编辑 service
 *
 * 给 admin-web「成本维护」tab 和产品管理页提供：
 *   - 各产品成本字段的 patch（CNY，已移除汇率/多币种）
 *   - 航班班次成本的 flat 列表（listSchedulesWithCost）—— 让财务能在一个页面集中管所有班次成本
 * 所有写操作由 routes 层负责 ADMIN 鉴权 + 审计日志。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';

function dec(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── 航班成本列表（财务页用，admin-only）──────────────────────────────────────

export interface FinanceScheduleRow {
  scheduleId: string;
  flightId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: string; // ISO
  charterCostCny: number | null;
  airportTaxDepCny: number | null;
  airportTaxArrCny: number | null;
  totalSeats: number;
  soldSeats: number;
  /** 单座(已售)成本 = charterCostCny ÷ soldSeats —— "保本线"；charter 缺失或 0 座售出时 null */
  perSoldSeatCostCny: number | null;
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
  return schedules.map<FinanceScheduleRow>((s) => {
    const totalSeats = s.seatClasses.reduce((a, c) => a + c.capacity, 0);
    const soldSeats = s.seatClasses.reduce((a, c) => a + c.sold, 0);
    const charter = dec(s.charterCostCny);
    const taxDep = dec(s.airportTaxDepCny);
    const taxArr = dec(s.airportTaxArrCny);
    const perSoldSeat = charter != null && soldSeats > 0 ? charter / soldSeats : null;
    return {
      scheduleId: s.id,
      flightId: s.flight.id,
      flightNumber: s.flight.flightNumber,
      origin: s.flight.originCode,
      destination: s.flight.destinationCode,
      departureTime: s.departureTime.toISOString(),
      charterCostCny: charter == null ? null : round2(charter),
      airportTaxDepCny: taxDep == null ? null : round2(taxDep),
      airportTaxArrCny: taxArr == null ? null : round2(taxArr),
      totalSeats,
      soldSeats,
      perSoldSeatCostCny: perSoldSeat == null ? null : round2(perSoldSeat),
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
