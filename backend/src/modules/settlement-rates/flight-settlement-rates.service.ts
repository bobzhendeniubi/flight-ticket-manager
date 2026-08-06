/**
 * 机票结算价日历 service — 运营维护「航班号 × 出发日期」的每人同业结算价（CNY）。
 *
 * 口径（与地面结算价 settlement-rates.service.ts 完全对称，复用其 date-only 折算工具）：
 *   - date-only 匹配：FlightSettlementRate.departDate 是 @db.Date；YMD 字符串统一按 UTC 零点
 *     折成 Date 再存/查（ymdToUtcDate），避免本地时区把日期挪前一天。读回同样按 UTC 口径 slice。
 *   - 唯一键 (flightNumber, departDate)：一个航班一天一个每人价；批量 upsert 以此幂等。
 *   - 航班号统一大写（schema 已 transform）；查询侧也大写归一，避免大小写造成"查不到价"。
 *   - getFlightSettlementRate 供代理下单自动取价复用（orders.service）——只查不改，
 *     命中返回价、未维护返回 null（调用方据此决定是否放弃自动取价）。
 *
 * 写操作由 routes 层负责 ADMIN/STAFF 鉴权 + 审计。
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError } from '../../lib/errors.js';
import type { FlightRateEntry, ListFlightRatesQuery } from './flight-settlement-rates.schemas.js';
import { utcDateToYmd, ymdToUtcDate } from './settlement-rates.service.js';

export interface FlightSettlementRateDto {
  id: string;
  flightNumber: string;
  departDate: string; // YMD
  pricePerPersonCny: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string; // ISO
}

function serialize(row: {
  id: string;
  flightNumber: string;
  departDate: Date;
  pricePerPersonCny: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}): FlightSettlementRateDto {
  return {
    id: row.id,
    flightNumber: row.flightNumber,
    departDate: utcDateToYmd(row.departDate),
    pricePerPersonCny: row.pricePerPersonCny,
    note: row.note,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 月度网格查询：按出发日期区间（含端点）+ 可选航班号列表，供 admin 机票结算价页渲染。
 * 排序：日期 → 航班号（稳定顺序，前端按此铺网格）。
 */
export async function listFlightRates(
  q: ListFlightRatesQuery,
  client: PrismaClient = defaultPrisma,
): Promise<FlightSettlementRateDto[]> {
  if (q.from > q.to) {
    throw new BadRequestError('起始日期不能晚于结束日期');
  }
  const rows = await client.flightSettlementRate.findMany({
    where: {
      departDate: { gte: ymdToUtcDate(q.from), lte: ymdToUtcDate(q.to) },
      ...(q.flightNumbers && q.flightNumbers.length > 0
        ? { flightNumber: { in: q.flightNumbers } }
        : {}),
    },
    orderBy: [{ departDate: 'asc' }, { flightNumber: 'asc' }],
  });
  return rows.map(serialize);
}

/**
 * 批量 upsert（网格整批保存 / Excel 粘贴块）：每格按 (flightNumber, departDate) 幂等 upsert。
 * 事务包裹——整批同成同败，避免半保存造成网格与库不一致。updatedBy 记最近更新人。
 */
export async function upsertFlightRates(
  rates: FlightRateEntry[],
  updatedBy: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<FlightSettlementRateDto[]> {
  const rows = await client.$transaction(
    rates.map((r) =>
      client.flightSettlementRate.upsert({
        where: {
          flightNumber_departDate: {
            flightNumber: r.flightNumber,
            departDate: ymdToUtcDate(r.departDate),
          },
        },
        create: {
          flightNumber: r.flightNumber,
          departDate: ymdToUtcDate(r.departDate),
          pricePerPersonCny: r.pricePerPersonCny,
          note: r.note ?? null,
          updatedBy,
        },
        update: {
          pricePerPersonCny: r.pricePerPersonCny,
          note: r.note ?? null,
          updatedBy,
        },
      }),
    ),
  );
  return rows.map(serialize);
}

/** 删除一格（网格清空某单元格）。返回被删行（供审计留痕），不存在返回 null。 */
export async function deleteFlightRate(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<FlightSettlementRateDto | null> {
  const existing = await client.flightSettlementRate.findUnique({ where: { id } });
  if (!existing) return null;
  await client.flightSettlementRate.delete({ where: { id } });
  return serialize(existing);
}

/**
 * 查价函数（代理下单自动取价 / 网格单格回显复用）：按 (航班号, 出发日期) 命中当日每人结算价。
 *   - departDate 为 YMD 字符串（调用方已按班次出发地本地日折算），内部按 UTC date-only 匹配。
 *   - flightNumber 大写归一后再查（库里存的是大写）。
 *   - 命中返回每人价（+ 元数据），未维护返回 null（调用方据此放弃自动取价 / 显示空格）。
 */
export async function getFlightSettlementRate(
  flightNumber: string,
  departDate: string,
  client: PrismaClient = defaultPrisma,
): Promise<FlightSettlementRateDto | null> {
  const row = await client.flightSettlementRate.findUnique({
    where: {
      flightNumber_departDate: {
        flightNumber: flightNumber.trim().toUpperCase(),
        departDate: ymdToUtcDate(departDate),
      },
    },
  });
  return row ? serialize(row) : null;
}
