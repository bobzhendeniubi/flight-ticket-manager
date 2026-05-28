/**
 * 一次性回填脚本：给 FlightSchedule / HotelRoomType / Visa / Transfer / OrderItem
 * 补上成本字段。Idempotent —— 只回填 NULL 值。
 *
 * 跑法：
 *   docker exec ftm-backend-prod node /app/dist/scripts/backfill-finance-costs.js
 *   或 backend/ 目录: npx tsx scripts/backfill-finance-costs.ts
 *
 * 估算口径（demo 数据用，生产应改成由 staff 手动录入真实成本）：
 *   - FlightSchedule.charterCostCny = Σ(seatClass.capacity × basePrice) × 0.70
 *   - HotelRoomType.costPriceCny    = basePrice × 0.70
 *   - Visa.costPriceCny             = basePrice × 0.55
 *   - Transfer.costPriceCny         = basePrice × 0.65
 *   - OrderItem.unitCostCny / totalCostCny → 按 kind 查对应产品的 costPrice 估算
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function dec(v: { toString(): string } | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// 默认汇率（2026 估算）— 仅当库里没有该 (currency,kind) 时插入
const FX_DEFAULTS: Array<{ currency: string; kind: string; rate: number }> = [
  { currency: 'USD', kind: 'FLIGHT', rate: 7.1 },
  { currency: 'USD', kind: 'AIRPORT_TAX', rate: 7.1 },
  { currency: 'USD', kind: 'VISA', rate: 7.1 },
  { currency: 'USD', kind: 'GENERAL', rate: 7.1 },
  { currency: 'VND', kind: 'HOTEL', rate: 0.000292 },
  { currency: 'VND', kind: 'GENERAL', rate: 0.000292 },
];
const FX_FLIGHT = 7.1;
const FX_VISA = 7.1;
const FX_HOTEL_VND = 0.000292;

async function seedExchangeRates(): Promise<number> {
  let n = 0;
  for (const f of FX_DEFAULTS) {
    const existing = await prisma.exchangeRate.findUnique({
      where: { currency_kind: { currency: f.currency, kind: f.kind } },
    });
    if (existing) continue;
    await prisma.exchangeRate.create({
      data: { currency: f.currency, kind: f.kind, rateToCny: f.rate, note: 'backfill 默认值' },
    });
    n += 1;
  }
  return n;
}

async function backfillFlightSchedules(): Promise<number> {
  // charterCostCny 回填（老逻辑）
  const needCharter = await prisma.flightSchedule.findMany({
    where: { charterCostCny: null },
    include: { seatClasses: { select: { capacity: true, basePrice: true } } },
  });
  let updated = 0;
  for (const s of needCharter) {
    const fullSellThrough = s.seatClasses.reduce(
      (acc, c) => acc + c.capacity * dec(c.basePrice),
      0,
    );
    if (fullSellThrough === 0) continue;
    await prisma.flightSchedule.update({
      where: { id: s.id },
      data: { charterCostCny: round2(fullSellThrough * 0.7) },
    });
    updated += 1;
  }

  // ticketCostUsd / airportTax 回填（按已填的 charterCostCny 折算 + demo 机场税）
  const needUsd = await prisma.flightSchedule.findMany({
    where: { ticketCostUsd: null, charterCostCny: { not: null } },
    include: { seatClasses: { select: { capacity: true } } },
  });
  for (const s of needUsd) {
    const totalSeats = s.seatClasses.reduce((a, c) => a + c.capacity, 0);
    if (totalSeats === 0) continue;
    const perSeatCny = dec(s.charterCostCny) / totalSeats;
    await prisma.flightSchedule.update({
      where: { id: s.id },
      data: {
        ticketCostUsd: round2(perSeatCny / FX_FLIGHT),
        airportTaxDepUsd: 18, // demo：出发地机场税
        airportTaxArrUsd: 25, // demo：目的地机场税
      },
    });
  }

  return updated;
}

async function backfillHotelRoomTypes(): Promise<number> {
  let updated = 0;
  // costPriceCny
  const needCny = await prisma.hotelRoomType.findMany({ where: { costPriceCny: null } });
  for (const r of needCny) {
    const cost = round2(dec(r.basePrice) * 0.7);
    if (cost <= 0) continue;
    await prisma.hotelRoomType.update({ where: { id: r.id }, data: { costPriceCny: cost } });
    updated += 1;
  }
  // costPriceVnd（按 costPriceCny / 汇率 折成原币）
  const needVnd = await prisma.hotelRoomType.findMany({
    where: { costPriceVnd: null, costPriceCny: { not: null } },
  });
  for (const r of needVnd) {
    await prisma.hotelRoomType.update({
      where: { id: r.id },
      data: { costPriceVnd: round2(dec(r.costPriceCny) / FX_HOTEL_VND) },
    });
  }
  return updated;
}

async function backfillVisas(): Promise<number> {
  let updated = 0;
  const needCny = await prisma.visa.findMany({ where: { costPriceCny: null } });
  for (const r of needCny) {
    const cost = round2(dec(r.basePrice) * 0.55);
    if (cost <= 0) continue;
    await prisma.visa.update({ where: { id: r.id }, data: { costPriceCny: cost } });
    updated += 1;
  }
  const needUsd = await prisma.visa.findMany({
    where: { costPriceUsd: null, costPriceCny: { not: null } },
  });
  for (const r of needUsd) {
    await prisma.visa.update({
      where: { id: r.id },
      data: { costPriceUsd: round2(dec(r.costPriceCny) / FX_VISA) },
    });
  }
  return updated;
}

async function backfillTransfers(): Promise<number> {
  const rows = await prisma.transfer.findMany({ where: { costPriceCny: null } });
  let updated = 0;
  for (const r of rows) {
    const cost = round2(dec(r.basePrice) * 0.65);
    if (cost <= 0) continue;
    await prisma.transfer.update({ where: { id: r.id }, data: { costPriceCny: cost } });
    updated += 1;
  }
  return updated;
}

async function backfillOrderItems(): Promise<number> {
  const items = await prisma.orderItem.findMany({
    where: { totalCostCny: null },
    include: {
      flightSchedule: {
        select: {
          charterCostCny: true,
          seatClasses: { select: { capacity: true } },
        },
      },
      hotelRoomType: { select: { costPriceCny: true, basePrice: true } },
      visa: { select: { costPriceCny: true, basePrice: true } },
      transfer: { select: { costPriceCny: true, basePrice: true } },
    },
  });

  let updated = 0;
  for (const it of items) {
    let unitCost: number | null = null;
    switch (it.kind) {
      case 'FLIGHT': {
        const fs = it.flightSchedule;
        if (fs?.charterCostCny != null) {
          const totalSeats = fs.seatClasses.reduce((a, c) => a + c.capacity, 0);
          if (totalSeats > 0) {
            unitCost = round2(dec(fs.charterCostCny) / totalSeats);
          }
        }
        if (unitCost == null) unitCost = round2(dec(it.unitPrice) * 0.7);
        break;
      }
      case 'HOTEL': {
        const h = it.hotelRoomType;
        unitCost =
          h?.costPriceCny != null
            ? round2(dec(h.costPriceCny))
            : round2(dec(it.unitPrice) * 0.7);
        break;
      }
      case 'VISA': {
        const v = it.visa;
        unitCost =
          v?.costPriceCny != null
            ? round2(dec(v.costPriceCny))
            : round2(dec(it.unitPrice) * 0.55);
        break;
      }
      case 'TRANSFER': {
        const t = it.transfer;
        unitCost =
          t?.costPriceCny != null
            ? round2(dec(t.costPriceCny))
            : round2(dec(it.unitPrice) * 0.65);
        break;
      }
      case 'BUNDLE':
      case 'INSURANCE':
      default:
        unitCost = round2(dec(it.unitPrice) * 0.7);
        break;
    }

    const totalCost = round2(unitCost * it.quantity);
    await prisma.orderItem.update({
      where: { id: it.id },
      data: { unitCostCny: unitCost, totalCostCny: totalCost },
    });
    updated += 1;
  }
  return updated;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[backfill] 开始回填财务成本字段（仅 NULL 值）…');
  const fx = await seedExchangeRates();
  const f = await backfillFlightSchedules();
  const h = await backfillHotelRoomTypes();
  const v = await backfillVisas();
  const t = await backfillTransfers();
  const o = await backfillOrderItems();
  // eslint-disable-next-line no-console
  console.log(
    `[backfill] 完成 — ExchangeRate:${fx} FlightSchedule:${f} HotelRoomType:${h} Visa:${v} Transfer:${t} OrderItem:${o}`,
  );
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[backfill] 失败:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
