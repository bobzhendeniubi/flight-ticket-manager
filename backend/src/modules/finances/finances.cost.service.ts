/**
 * 财务成本编辑 + 汇率管理 service
 *
 * 给 admin-web「成本维护」tab 和产品管理页提供：
 *   - 汇率（ExchangeRate）的读取 / upsert
 *   - 各产品成本字段（charter/ticket/airport-tax/hotel/visa/transfer）的 patch
 *
 * 所有写操作由 routes 层负责 ADMIN 鉴权 + 审计日志。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';

export type FxCurrency = 'USD' | 'VND';
export type FxKind = 'FLIGHT' | 'AIRPORT_TAX' | 'HOTEL' | 'VISA' | 'GENERAL';

export interface ExchangeRateDto {
  id: string;
  currency: string;
  kind: string;
  rateToCny: number;
  note: string | null;
  updatedAt: string;
}

// 没配汇率时的兜底（2026 估算：1 USD≈7.1 CNY；1 VND≈0.000292 CNY）
export const DEFAULT_FX: Record<string, number> = {
  'USD:FLIGHT': 7.1,
  'USD:AIRPORT_TAX': 7.1,
  'USD:VISA': 7.1,
  'USD:GENERAL': 7.1,
  'VND:HOTEL': 0.000292,
  'VND:GENERAL': 0.000292,
};

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

export async function listExchangeRates(
  client: PrismaClient = defaultPrisma,
): Promise<ExchangeRateDto[]> {
  const rows = await client.exchangeRate.findMany({
    orderBy: [{ currency: 'asc' }, { kind: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    currency: r.currency,
    kind: r.kind,
    rateToCny: dec(r.rateToCny),
    note: r.note,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function upsertExchangeRate(
  input: { currency: FxCurrency; kind: FxKind; rateToCny: number; note?: string },
  client: PrismaClient = defaultPrisma,
): Promise<ExchangeRateDto> {
  const row = await client.exchangeRate.upsert({
    where: { currency_kind: { currency: input.currency, kind: input.kind } },
    create: {
      currency: input.currency,
      kind: input.kind,
      rateToCny: input.rateToCny,
      note: input.note ?? null,
    },
    update: { rateToCny: input.rateToCny, note: input.note ?? null },
  });
  return {
    id: row.id,
    currency: row.currency,
    kind: row.kind,
    rateToCny: dec(row.rateToCny),
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 把 ExchangeRate 行解析成一张快速查表，缺失时用 DEFAULT_FX 兜底 */
export async function loadFxMap(
  client: PrismaClient = defaultPrisma,
): Promise<Record<string, number>> {
  const rows = await client.exchangeRate.findMany();
  const map: Record<string, number> = { ...DEFAULT_FX };
  for (const r of rows) {
    map[`${r.currency}:${r.kind}`] = dec(r.rateToCny);
  }
  return map;
}

// ── 产品成本 patch ───────────────────────────────────────────────────────────

export async function patchFlightScheduleCost(
  id: string,
  data: {
    charterCostCny?: number | null;
    ticketCostUsd?: number | null;
    airportTaxDepUsd?: number | null;
    airportTaxArrUsd?: number | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.flightSchedule.update({ where: { id }, data });
  return { id };
}

export async function patchHotelRoomTypeCost(
  id: string,
  data: { costPriceCny?: number | null; costPriceVnd?: number | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.hotelRoomType.update({ where: { id }, data });
  return { id };
}

export async function patchVisaCost(
  id: string,
  data: { costPriceCny?: number | null; costPriceUsd?: number | null },
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
