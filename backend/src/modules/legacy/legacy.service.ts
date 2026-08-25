import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

export interface LegacyTicketListQuery {
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  orgId?: string;
  paymentConfirmed?: boolean;
  dataIssue?: string;
  includeDeleted?: boolean;
  page: number;
  pageSize: number;
}

function dateStart(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateEndExclusive(value: string): Date {
  const date = dateStart(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function dateIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function money(value: unknown): string | null {
  return value == null ? null : String(value);
}

function serializeTicket(ticket: Record<string, unknown>): Record<string, unknown> {
  const result = { ...ticket };
  for (const key of [
    'birthDate', 'issueDate', 'expiryDate', 'legacyCreateTime', 'legacyUpdateTime',
    'outboundDate', 'returnDate',
  ]) {
    result[key] = dateIso(ticket[key] as Date | null | undefined);
  }
  for (const key of [
    'finalPrice', 'truePrice', 'depositPrice', 'hotelPrice', 'hotelTruePrice',
    'visaPrice', 'visaTruePrice', 'discountPrice', 'deductionPrice',
  ]) {
    result[key] = money(ticket[key]);
  }
  return result;
}

const listSelect = {
  id: true,
  bookingNo: true,
  teamNo: true,
  fullName: true,
  chineseName: true,
  documentNumber: true,
  documentNumberNorm: true,
  outboundFlightNo: true,
  outboundDate: true,
  returnFlightNo: true,
  returnDate: true,
  finalPrice: true,
  truePrice: true,
  paymentConfirmed: true,
  isDeleted: true,
  orgId: true,
  orgName: true,
  legacyCreateTime: true,
  supersededByOrderId: true,
} satisfies Prisma.LegacyTicketSelect;

function buildWhere(query: LegacyTicketListQuery): Prisma.LegacyTicketWhereInput {
  const where: Prisma.LegacyTicketWhereInput = {};
  if (!query.includeDeleted) where.isDeleted = false;
  if (query.paymentConfirmed !== undefined) where.paymentConfirmed = query.paymentConfirmed;
  if (query.orgId) where.orgId = query.orgId;
  if (query.dataIssue) where.dataIssues = { has: query.dataIssue };
  if (query.dateFrom || query.dateTo) {
    where.legacyCreateTime = {
      ...(query.dateFrom ? { gte: dateStart(query.dateFrom) } : {}),
      ...(query.dateTo ? { lt: dateEndExclusive(query.dateTo) } : {}),
    };
  }
  const q = query.q?.trim();
  if (q) {
    where.OR = [
      { fullName: { contains: q, mode: 'insensitive' } },
      { chineseName: { contains: q, mode: 'insensitive' } },
      { documentNumberNorm: { contains: q.toUpperCase(), mode: 'insensitive' } },
      { bookingNo: { contains: q, mode: 'insensitive' } },
      { teamNo: { contains: q, mode: 'insensitive' } },
    ];
  }
  return where;
}

export async function listLegacyTickets(query: LegacyTicketListQuery) {
  const where = buildWhere(query);
  const [rows, total] = await Promise.all([
    prisma.legacyTicket.findMany({
      where,
      select: listSelect,
      orderBy: [{ legacyCreateTime: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.legacyTicket.count({ where }),
  ]);
  return {
    items: rows.map((row) => serializeTicket(row as unknown as Record<string, unknown>)),
    pagination: { page: query.page, pageSize: query.pageSize, total },
  };
}

export async function getLegacyTicket(id: string) {
  const ticket = await prisma.legacyTicket.findUnique({
    where: { id },
    include: {
      flights: { include: { flight: true }, orderBy: { legType: 'asc' } },
    },
  });
  if (!ticket) return null;
  const receipts = await prisma.legacyReceipt.findMany({
    where: { ticketId: id },
    orderBy: [{ receivedAt: 'asc' }, { sequence: 'asc' }, { id: 'asc' }],
  });
  return {
    ...serializeTicket(ticket as unknown as Record<string, unknown>),
    flights: ticket.flights.map((link) => ({
      id: link.id,
      ticketId: link.ticketId,
      flightId: link.flightId,
      legType: link.legType,
      flight: {
        ...link.flight,
        departDate: dateIso(link.flight.departDate),
        adultBusinessPrice: money(link.flight.adultBusinessPrice),
        adultEconomyPrice: money(link.flight.adultEconomyPrice),
      },
    })),
    receipts: receipts.map((receipt) => ({
      ...receipt,
      amount: money(receipt.amount),
      receivedAt: dateIso(receipt.receivedAt),
      legacyCreateTime: dateIso(receipt.legacyCreateTime),
    })),
  };
}

export async function getLegacyPassengerHistory(document: string) {
  const documentNumberNorm = document.trim().toUpperCase();
  const where = { documentNumberNorm, isDeleted: false };
  const [total, superseded, rows] = await Promise.all([
    prisma.legacyTicket.count({ where }),
    prisma.legacyTicket.count({ where: { ...where, supersededByOrderId: { not: null } } }),
    prisma.legacyTicket.findMany({
      where,
      select: listSelect,
      orderBy: [{ legacyCreateTime: 'desc' }, { id: 'desc' }],
    }),
  ]);
  return {
    total,
    superseded,
    items: rows.map((row) => serializeTicket(row as unknown as Record<string, unknown>)),
  };
}

export async function getLegacyStats() {
  const [total, uniquePassengers, timeRange, receiptCount, superseded] = await Promise.all([
    prisma.legacyTicket.count({ where: { isDeleted: false } }),
    prisma.legacyTicket.groupBy({
      by: ['documentNumberNorm'],
      where: { documentNumberNorm: { not: null }, isDeleted: false },
    }),
    prisma.legacyTicket.aggregate({
      where: { isDeleted: false },
      _min: { legacyCreateTime: true },
      _max: { legacyCreateTime: true },
    }),
    prisma.legacyReceipt.count(),
    prisma.legacyTicket.count({ where: { isDeleted: false, supersededByOrderId: { not: null } } }),
  ]);
  return {
    total,
    uniquePassengers: uniquePassengers.length,
    dateFrom: dateIso(timeRange._min.legacyCreateTime),
    dateTo: dateIso(timeRange._max.legacyCreateTime),
    receiptCount,
    superseded,
  };
}

interface LegacyDashboardMonthlyRow {
  month: string;
  count: bigint;
  finalPriceSum: string | null;
}

interface LegacyDashboardPaymentRow {
  confirmed: bigint;
  unconfirmed: bigint;
}

interface LegacyDashboardTotalsRow {
  finalPriceSum: string | null;
  truePriceSum: string | null;
  superseded: bigint;
}

interface LegacyDashboardReceiptRow {
  receiptCount: bigint;
  receiptAmountSum: string | null;
}

interface LegacyDashboardOrgRow {
  orgId: string | null;
  orgName: string | null;
  count: bigint;
  finalPriceSum: string | null;
}

interface LegacyDashboardFlightRow {
  flightNo: string;
  count: bigint;
}

interface LegacyDashboardIssueRow {
  issue: string;
  count: bigint;
}

function sumString(value: unknown): string {
  return value == null ? '0' : String(value);
}

function countNumber(value: bigint | number): number {
  return Number(value);
}

export async function getLegacyDashboard() {
  const [monthly, payment, totals, receipts, topOrgs, topFlights, dataIssues] = await Promise.all([
    prisma.$queryRaw<LegacyDashboardMonthlyRow[]>`
      SELECT
        to_char(date_trunc('month', "legacyCreateTime"), 'YYYY-MM') AS month,
        COUNT(*)::bigint AS count,
        COALESCE(SUM("finalPrice"), 0)::text AS "finalPriceSum"
      FROM "LegacyTicket"
      WHERE "isDeleted" = false AND "legacyCreateTime" IS NOT NULL
      GROUP BY date_trunc('month', "legacyCreateTime")
      ORDER BY month ASC
    `,
    prisma.$queryRaw<LegacyDashboardPaymentRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE "paymentConfirmed" = true)::bigint AS confirmed,
        COUNT(*) FILTER (WHERE "paymentConfirmed" = false)::bigint AS unconfirmed
      FROM "LegacyTicket"
      WHERE "isDeleted" = false
    `,
    prisma.$queryRaw<LegacyDashboardTotalsRow[]>`
      SELECT
        COALESCE(SUM("finalPrice"), 0)::text AS "finalPriceSum",
        COALESCE(SUM("truePrice"), 0)::text AS "truePriceSum",
        COUNT(*) FILTER (WHERE "supersededByOrderId" IS NOT NULL)::bigint AS superseded
      FROM "LegacyTicket"
      WHERE "isDeleted" = false
    `,
    prisma.$queryRaw<LegacyDashboardReceiptRow[]>`
      SELECT
        COUNT(*)::bigint AS "receiptCount",
        COALESCE(SUM(receipt."amount"), 0)::text AS "receiptAmountSum"
      FROM "LegacyReceipt" AS receipt
      INNER JOIN "LegacyTicket" AS ticket ON ticket."id" = receipt."ticketId"
      WHERE ticket."isDeleted" = false
    `,
    prisma.$queryRaw<LegacyDashboardOrgRow[]>`
      SELECT
        "orgId",
        "orgName",
        COUNT(*)::bigint AS count,
        COALESCE(SUM("finalPrice"), 0)::text AS "finalPriceSum"
      FROM "LegacyTicket"
      WHERE "isDeleted" = false
      GROUP BY "orgId", "orgName"
      ORDER BY count DESC, "orgId" ASC NULLS LAST
      LIMIT 10
    `,
    prisma.$queryRaw<LegacyDashboardFlightRow[]>`
      SELECT
        "outboundFlightNo" AS "flightNo",
        COUNT(*)::bigint AS count
      FROM "LegacyTicket"
      WHERE "isDeleted" = false AND "outboundFlightNo" IS NOT NULL AND "outboundFlightNo" <> ''
      GROUP BY "outboundFlightNo"
      ORDER BY count DESC, "outboundFlightNo" ASC
      LIMIT 10
    `,
    prisma.$queryRaw<LegacyDashboardIssueRow[]>`
      SELECT
        issue.value AS issue,
        COUNT(*)::bigint AS count
      FROM "LegacyTicket" AS ticket
      CROSS JOIN LATERAL unnest(ticket."dataIssues") AS issue(value)
      WHERE ticket."isDeleted" = false
      GROUP BY issue.value
      ORDER BY count DESC, issue.value ASC
    `,
  ]) as [
    LegacyDashboardMonthlyRow[],
    LegacyDashboardPaymentRow[],
    LegacyDashboardTotalsRow[],
    LegacyDashboardReceiptRow[],
    LegacyDashboardOrgRow[],
    LegacyDashboardFlightRow[],
    LegacyDashboardIssueRow[],
  ];

  const paymentRow = payment[0];
  const totalsRow = totals[0];
  const receiptRow = receipts[0];
  return {
    monthly: monthly.map((row) => ({
      month: row.month,
      count: countNumber(row.count),
      finalPriceSum: sumString(row.finalPriceSum),
    })),
    payment: {
      confirmed: countNumber(paymentRow?.confirmed ?? 0n),
      unconfirmed: countNumber(paymentRow?.unconfirmed ?? 0n),
    },
    totals: {
      finalPriceSum: sumString(totalsRow?.finalPriceSum),
      truePriceSum: sumString(totalsRow?.truePriceSum),
      receiptCount: countNumber(receiptRow?.receiptCount ?? 0n),
      receiptAmountSum: sumString(receiptRow?.receiptAmountSum),
    },
    topOrgs: topOrgs.map((row) => ({
      orgId: row.orgId,
      orgName: row.orgName,
      count: countNumber(row.count),
      finalPriceSum: sumString(row.finalPriceSum),
    })),
    topFlights: topFlights.map((row) => ({ flightNo: row.flightNo, count: countNumber(row.count) })),
    dataIssues: dataIssues.map((row) => ({ issue: row.issue, count: countNumber(row.count) })),
    superseded: countNumber(totalsRow?.superseded ?? 0n),
  };
}
