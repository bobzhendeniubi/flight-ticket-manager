import { Prisma, PrismaClient } from '@prisma/client';
import { LEGACY_TABLE_COLUMNS, parseDump, type DumpEvent, type ParseIssue, type RawSqlValue } from './parser.js';
import {
  cleanDate,
  cleanDateTime,
  cleanGender,
  cleanInt,
  cleanMoney,
  cleanPassengerType,
  cleanRemark,
  cleanText,
  normalizeDocumentNumber,
  normalizeUpper,
  rawBoolean,
  rawInteger,
} from './cleaners.js';
import {
  emptyManualFixes,
  loadManualFixes,
  passengerNameKey,
  type ManualDateField,
  type ManualFixes,
} from './manual-fixes.js';
import { runDedupe, type DedupeReport } from './dedupe.js';

const BATCH_SIZE = 2_000;

export interface ImportOptions {
  dumpPath: string;
  wipe: boolean;
  skipDedupe: boolean;
  dateFixesPath?: string;
  nameFlagsPath?: string;
}

interface TableReport {
  parsed: number;
  inserted: number;
  rejected: number;
  deleted?: number;
}

export interface ImportReport {
  tables: Record<string, TableReport>;
  sums: {
    parsedFinalPrice: string;
    storedFinalPrice: string;
    parsedReceiptAmount: string;
    storedReceiptAmount: string;
  };
  dataIssues: Record<string, number>;
  danglingReceipts: number;
  danglingTicketFlights: number;
  manualDateFixes: number;
  nameFlags: number;
  dedupe?: DedupeReport;
}

export interface ManualFixCounts {
  manualDateFixes: number;
  nameFlags: number;
}

interface SourceFlight {
  id: string;
  flightNo: string | null;
  departDate: Date | null;
}

interface SourceTicketFlight {
  id: string;
  ticketId: string;
  flightId: string;
  legType: number;
}

const tableReports: Record<string, TableReport> = Object.fromEntries(
  Object.keys(LEGACY_TABLE_COLUMNS).map((table) => [table, { parsed: 0, inserted: 0, rejected: 0 }]),
);

function reportFor(table: string): TableReport {
  const report = tableReports[table];
  if (!report) throw new Error(`Unsupported source table: ${table}`);
  return report;
}

function value(values: RawSqlValue[], index: number): RawSqlValue {
  return values[index] ?? null;
}

function requiredId(raw: RawSqlValue, table: string): string {
  const id = cleanText(raw);
  if (!id) throw new Error(`${table}: missing primary key`);
  return id;
}

function decimalValue(raw: RawSqlValue, issueKey: string, issues: string[]): Prisma.Decimal | null {
  const result = cleanMoney(raw, issueKey);
  issues.push(...result.issues);
  return result.value === null ? null : new Prisma.Decimal(result.value);
}

function integerValue(raw: RawSqlValue, issueKey: string, issues?: string[]): number | null {
  const result = cleanInt(raw, issueKey);
  issues?.push(...result.issues);
  return result.value;
}

function addIssueCounts(issues: string[], counts: Record<string, number>): void {
  for (const issue of new Set(issues)) counts[issue] = (counts[issue] ?? 0) + 1;
}

function sourceFlight(values: RawSqlValue[]): SourceFlight {
  const date = cleanDate(value(values, 7), 'startDay').value;
  return {
    id: requiredId(value(values, 0), 'rs_flight'),
    flightNo: cleanText(value(values, 6)),
    departDate: date,
  };
}

function mapFlight(values: RawSqlValue[]): Prisma.LegacyFlightCreateManyInput {
  return {
    id: requiredId(value(values, 0), 'rs_flight'),
    flightNo: cleanText(value(values, 6)),
    departDate: cleanDate(value(values, 7), 'startDay').value,
    departTime: cleanText(value(values, 8)),
    arriveTime: cleanText(value(values, 9)),
    originCode: cleanText(value(values, 10)),
    destCode: cleanText(value(values, 11)),
    businessTotal: integerValue(value(values, 2), 'businessTotal'),
    economyTotal: integerValue(value(values, 3), 'economyTotal'),
    adultBusinessPrice: decimalValue(value(values, 16), 'adultBusinessPrice', []),
    adultEconomyPrice: decimalValue(value(values, 17), 'adultEconomyPrice', []),
    isProduct: rawBoolean(value(values, 24)),
  };
}

function sourceTicketFlight(values: RawSqlValue[]): SourceTicketFlight {
  return {
    id: requiredId(value(values, 0), 'rs_ticket_flight'),
    ticketId: requiredId(value(values, 1), 'rs_ticket_flight.ticket_id'),
    flightId: requiredId(value(values, 2), 'rs_ticket_flight.flight_id'),
    legType: rawInteger(value(values, 3)) ?? 0,
  };
}

function relatedFlight(
  links: SourceTicketFlight[],
  legType: number,
  flights: Map<string, SourceFlight>,
  issues: string[],
): { flightNo: string | null; date: Date | null } {
  const related = links
    .filter((link) => link.legType === legType)
    .map((link) => flights.get(link.flightId))
    .filter((flight): flight is SourceFlight => flight !== undefined)
    .sort((a, b) => (a.departDate?.getTime() ?? Number.POSITIVE_INFINITY) - (b.departDate?.getTime() ?? Number.POSITIVE_INFINITY));
  if (related.length > 1) issues.push(`flight:multiple-${legType === 0 ? 'outbound' : 'return'}`);
  const first = related[0];
  return { flightNo: first?.flightNo ?? null, date: first?.departDate ?? null };
}

export function mapTicket(
  values: RawSqlValue[],
  flights: Map<string, SourceFlight>,
  linksByTicket: Map<string, SourceTicketFlight[]>,
  orgNames: Map<string, string>,
  issueCounts: Record<string, number>,
  manualFixes: ManualFixes = emptyManualFixes(),
  manualFixCounts: ManualFixCounts = { manualDateFixes: 0, nameFlags: 0 },
): Prisma.LegacyTicketCreateManyInput {
  const issues: string[] = [];
  const id = requiredId(value(values, 0), 'rs_ticket');
  const ticketLinks = linksByTicket.get(id) ?? [];
  const outbound = relatedFlight(ticketLinks, 0, flights, issues);
  const inbound = relatedFlight(ticketLinks, 1, flights, issues);

  const documentNumberKey = normalizeDocumentNumber(value(values, 24));
  const dateFixes = documentNumberKey ? manualFixes.dateFixesByDocument.get(documentNumberKey) : undefined;
  const cleanManualDate = (
    field: ManualDateField,
    source: RawSqlValue,
    issueKey: string,
  ) => {
    const correctedValue = dateFixes?.[field];
    if (correctedValue === undefined) return cleanDate(source, issueKey);
    manualFixCounts.manualDateFixes += 1;
    issues.push(`${field}:manual-fix`);
    return cleanDate(correctedValue, issueKey);
  };
  const birth = cleanManualDate('birth', value(values, 21), 'birth');
  const issueDate = cleanManualDate('date_of_issue', value(values, 25), 'issueDate');
  const expiryDate = cleanManualDate('expiry_date', value(values, 26), 'expiryDate');
  issues.push(...birth.issues, ...issueDate.issues, ...expiryDate.issues);
  const finalPrice = decimalValue(value(values, 11), 'finalPrice', issues);
  const truePrice = decimalValue(value(values, 7), 'truePrice', issues);
  const depositPrice = decimalValue(value(values, 12), 'depositPrice', issues);
  const hotelPrice = decimalValue(value(values, 60), 'hotelPrice', issues);
  const hotelTruePrice = decimalValue(value(values, 61), 'hotelTruePrice', issues);
  const visaPrice = decimalValue(value(values, 62), 'visaPrice', issues);
  const visaTruePrice = decimalValue(value(values, 63), 'visaTruePrice', issues);
  const discountPrice = decimalValue(value(values, 64), 'discountPrice', issues);
  const deductionPrice = decimalValue(value(values, 54), 'deductionPrice', issues);
  const legacyCreateTime = cleanDateTime(value(values, 29), 'createTime');
  const legacyUpdateTime = cleanDateTime(value(values, 31), 'updateTime');
  issues.push(...legacyCreateTime.issues, ...legacyUpdateTime.issues);
  const orgId = cleanText(value(values, 27));
  const nameFlags = manualFixes.nameFlagsByPassenger.get(passengerNameKey(value(values, 14), value(values, 15)));
  if (nameFlags) {
    for (const problemType of nameFlags) issues.push(`name:${problemType}`);
    manualFixCounts.nameFlags += nameFlags.size;
  }
  if (expiryDate.value && issueDate.value && expiryDate.value < issueDate.value) {
    issues.push('passport:expiry-before-issue');
  }
  if (issueDate.value && legacyCreateTime.value && issueDate.value > legacyCreateTime.value) {
    issues.push('passport:issued-after-order');
  }
  if (birth.value && legacyCreateTime.value && birth.value > legacyCreateTime.value) {
    issues.push('birth:after-order');
  }
  const birthYear = birth.value?.getUTCFullYear();
  if (birthYear !== undefined && (birthYear < 1920 || birthYear > 2026)) {
    issues.push('birth:year-out-of-range');
  }
  if (expiryDate.value && outbound.date && expiryDate.value < outbound.date) {
    issues.push('passport:expired-at-departure');
  }
  addIssueCounts(issues, issueCounts);

  return {
    id,
    bookingNo: cleanText(value(values, 2)),
    teamNo: cleanText(value(values, 1)),
    tripType: integerValue(value(values, 4), 'tripType'),
    cabinLevel: integerValue(value(values, 6), 'cabinLevel'),
    fullName: cleanText(value(values, 15)),
    chineseName: cleanText(value(values, 14)),
    documentName: cleanText(value(values, 18)),
    gender: cleanGender(value(values, 20), value(values, 19)),
    birthDate: birth.value,
    nationality: normalizeUpper(value(values, 22)),
    documentTypeRaw: value(values, 23),
    documentNumber: value(values, 24),
    documentNumberNorm: normalizeDocumentNumber(value(values, 24)),
    issueDate: issueDate.value,
    expiryDate: expiryDate.value,
    birthPlace: cleanText(value(values, 52)),
    passengerType: cleanPassengerType(value(values, 16)),
    infantAdultName: cleanText(value(values, 17)),
    finalPrice,
    truePrice,
    depositPrice,
    hotelPrice,
    hotelTruePrice,
    visaPrice,
    visaTruePrice,
    discountPrice,
    deductionPrice,
    finalPriceRemark: cleanText(value(values, 65)),
    fileId: cleanText(value(values, 34)),
    paymentFileId: cleanText(value(values, 66)),
    paymentConfirmed: rawInteger(value(values, 5)) === 1,
    stateRaw: integerValue(value(values, 5), 'stateRaw'),
    isDeleted: rawInteger(value(values, 35)) === 2,
    outboundTicketed: rawBoolean(value(values, 36)),
    returnTicketed: rawBoolean(value(values, 59)),
    systemTicketed: rawBoolean(value(values, 58)),
    visaStateRaw: integerValue(value(values, 38), 'visaStateRaw'),
    hotelTypeName: cleanText(value(values, 43)),
    orgId,
    orgName: orgId ? orgNames.get(orgId) ?? null : null,
    remark: cleanRemark(value(values, 33)),
    legacyCreateTime: legacyCreateTime.value,
    legacyUpdateTime: legacyUpdateTime.value,
    outboundFlightNo: outbound.flightNo,
    outboundDate: outbound.date,
    returnFlightNo: inbound.flightNo,
    returnDate: inbound.date,
    supersededByOrderId: null,
    dataIssues: [...new Set(issues)],
  };
}

function mapReceipt(values: RawSqlValue[], issueCounts: Record<string, number>): Prisma.LegacyReceiptCreateManyInput {
  const amount = cleanMoney(value(values, 3), 'receiptAmount');
  const receivedAt = cleanDateTime(value(values, 4), 'receivedAt');
  const legacyCreateTime = cleanDateTime(value(values, 7), 'receiptCreateTime');
  const issues = [...amount.issues, ...receivedAt.issues, ...legacyCreateTime.issues];
  addIssueCounts(issues, issueCounts);
  return {
    id: requiredId(value(values, 0), 'rs_receipt'),
    ticketId: cleanText(value(values, 1)),
    sequence: integerValue(value(values, 2), 'receiptSequence'),
    amount: amount.value === null ? null : new Prisma.Decimal(amount.value),
    receivedAt: receivedAt.value,
    channelCode: rawInteger(value(values, 5)),
    legacyCreateTime: legacyCreateTime.value,
  };
}

async function forEachDumpEvent(
  dumpPath: string,
  callback: (event: DumpEvent) => Promise<void> | void,
): Promise<void> {
  for await (const event of parseDump(dumpPath)) await callback(event);
}

async function createManyBatches<T>(rows: T[], createMany: (data: T[]) => Promise<{ count: number }>): Promise<number> {
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    inserted += (await createMany(rows.slice(offset, offset + BATCH_SIZE))).count;
  }
  return inserted;
}

async function wipeLegacy(prisma: PrismaClient): Promise<void> {
  await prisma.legacyReceipt.deleteMany();
  await prisma.legacyTicketFlight.deleteMany();
  await prisma.legacyTicket.deleteMany();
  await prisma.legacyFlight.deleteMany();
}

async function assertLegacyTablesEmpty(prisma: PrismaClient): Promise<void> {
  const [flights, tickets, ticketFlights, receipts] = await Promise.all([
    prisma.legacyFlight.count(),
    prisma.legacyTicket.count(),
    prisma.legacyTicketFlight.count(),
    prisma.legacyReceipt.count(),
  ]);
  const occupied = [
    ['LegacyFlight', flights],
    ['LegacyTicket', tickets],
    ['LegacyTicketFlight', ticketFlights],
    ['LegacyReceipt', receipts],
  ].filter(([, count]) => count > 0);
  if (occupied.length > 0) {
    throw new Error(`legacy 档案表非空（${occupied.map(([table, count]) => `${table}: ${count}`).join('、')}），为避免主键冲突，请重跑时加 --wipe。`);
  }
}

function decimalString(value: Prisma.Decimal | null | undefined): string {
  return value?.toFixed(2) ?? '0.00';
}

function parseArgs(argv: string[]): ImportOptions {
  const dumpIndex = argv.indexOf('--dump');
  const dumpPath = dumpIndex >= 0 ? argv[dumpIndex + 1] : undefined;
  const optionPath = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const path = argv[index + 1];
    if (!path || path.startsWith('--')) throw new Error(`${name} 需要一个文件路径`);
    return path;
  };
  if (!dumpPath) throw new Error('Usage: import.ts --dump /path/to/flight_citur_dad.sql [--wipe] [--skip-dedupe] [--date-fixes path.tsv] [--name-flags path.tsv]');
  return {
    dumpPath,
    wipe: argv.includes('--wipe'),
    skipDedupe: argv.includes('--skip-dedupe'),
    dateFixesPath: optionPath('--date-fixes'),
    nameFlagsPath: optionPath('--name-flags'),
  };
}

export async function importLegacyArchive(options: ImportOptions, prisma: PrismaClient): Promise<ImportReport> {
  for (const report of Object.values(tableReports)) {
    report.parsed = 0;
    report.inserted = 0;
    report.rejected = 0;
    delete report.deleted;
  }
  const manualFixes = await loadManualFixes(options.dateFixesPath, options.nameFlagsPath);
  const manualFixCounts: ManualFixCounts = { manualDateFixes: 0, nameFlags: 0 };
  const flights = new Map<string, SourceFlight>();
  const linksByTicket = new Map<string, SourceTicketFlight[]>();
  const ticketIds = new Set<string>();
  const orgNames = new Map<string, string>();
  const issueCounts: Record<string, number> = {};
  let parserIssueCount = 0;
  const parserIssues: ParseIssue[] = [];

  await forEachDumpEvent(options.dumpPath, (event) => {
    if (event.kind === 'issue') {
      parserIssueCount += 1;
      const report = tableReports[event.issue.table];
      if (report) report.rejected += 1;
      if (parserIssues.length < 20) parserIssues.push(event.issue);
      return;
    }
    const report = reportFor(event.row.table);
    report.parsed += 1;
    const values = event.row.values;
    if (event.row.table === 'rs_ticket') ticketIds.add(requiredId(value(values, 0), 'rs_ticket'));
    if (event.row.table === 'rs_flight') flights.set(requiredId(value(values, 0), 'rs_flight'), sourceFlight(values));
    if (event.row.table === 'rs_ticket_flight') {
      const link = sourceTicketFlight(values);
      linksByTicket.set(link.ticketId, [...(linksByTicket.get(link.ticketId) ?? []), link]);
    }
    if (event.row.table === 'sys_emp') {
      const orgId = cleanText(value(values, 2));
      const orgName = cleanText(value(values, 3));
      if (orgId && orgName) orgNames.set(orgId, orgName);
    }
  });

  if (parserIssueCount > 0) {
    console.error(JSON.stringify({ parserIssueCount, issues: parserIssues }, null, 2));
    throw new Error('dump 解析存在问题，已在 --wipe 前终止；请先修复 issue 后再重跑。');
  }

  if (options.wipe) await wipeLegacy(prisma);
  else await assertLegacyTablesEmpty(prisma);

  // sys_emp is an auxiliary source used to enrich orgName; it has no archive target table.
  reportFor('sys_emp').inserted = reportFor('sys_emp').parsed;
  const flightRows: Prisma.LegacyFlightCreateManyInput[] = [];
  await forEachDumpEvent(options.dumpPath, (event) => {
    if (event.kind === 'row' && event.row.table === 'rs_flight') flightRows.push(mapFlight(event.row.values));
  });
  reportFor('rs_flight').inserted = await createManyBatches(flightRows, (data) => prisma.legacyFlight.createMany({ data }));

  const ticketBatch: Prisma.LegacyTicketCreateManyInput[] = [];
  const receiptBatch: Prisma.LegacyReceiptCreateManyInput[] = [];
  let ticketInserted = 0;
  let receiptInserted = 0;
  let deletedTicketCount = 0;
  let danglingReceipts = 0;
  let parsedFinalPrice = new Prisma.Decimal(0);
  let parsedReceiptAmount = new Prisma.Decimal(0);
  await forEachDumpEvent(options.dumpPath, async (event) => {
    if (event.kind !== 'row') return;
    if (event.row.table === 'rs_ticket') {
      const row = mapTicket(event.row.values, flights, linksByTicket, orgNames, issueCounts, manualFixes, manualFixCounts);
      ticketBatch.push(row);
      if (row.isDeleted) deletedTicketCount += 1;
      if (row.finalPrice) parsedFinalPrice = parsedFinalPrice.plus(String(row.finalPrice));
      if (ticketBatch.length >= BATCH_SIZE) {
        ticketInserted += (await prisma.legacyTicket.createMany({ data: ticketBatch.splice(0, BATCH_SIZE) })).count;
      }
    }
    if (event.row.table === 'rs_receipt') {
      const row = mapReceipt(event.row.values, issueCounts);
      if (row.ticketId && !ticketIds.has(row.ticketId)) danglingReceipts += 1;
      receiptBatch.push(row);
      if (row.amount) parsedReceiptAmount = parsedReceiptAmount.plus(String(row.amount));
      if (receiptBatch.length >= BATCH_SIZE) {
        receiptInserted += (await prisma.legacyReceipt.createMany({ data: receiptBatch.splice(0, BATCH_SIZE) })).count;
      }
    }
  });

  ticketInserted += (await prisma.legacyTicket.createMany({ data: ticketBatch })).count;
  receiptInserted += (await prisma.legacyReceipt.createMany({ data: receiptBatch })).count;
  reportFor('rs_ticket').inserted = ticketInserted;
  reportFor('rs_ticket').deleted = deletedTicketCount;
  reportFor('rs_receipt').inserted = receiptInserted;

  // Ticket-flight rows are scanned after tickets exist so the archive FK can stay useful.
  const ticketFlightBatch: Prisma.LegacyTicketFlightCreateManyInput[] = [];
  let ticketFlightInserted = 0;
  let danglingTicketFlights = 0;
  await forEachDumpEvent(options.dumpPath, async (event) => {
    if (event.kind !== 'row' || event.row.table !== 'rs_ticket_flight') return;
    const row = sourceTicketFlight(event.row.values);
    if (!ticketIds.has(row.ticketId) || !flights.has(row.flightId)) {
      danglingTicketFlights += 1;
      return;
    }
    ticketFlightBatch.push({ id: row.id, ticketId: row.ticketId, flightId: row.flightId, legType: row.legType });
    if (ticketFlightBatch.length >= BATCH_SIZE) {
      ticketFlightInserted += (await prisma.legacyTicketFlight.createMany({ data: ticketFlightBatch.splice(0, BATCH_SIZE) })).count;
    }
  });
  ticketFlightInserted += (await prisma.legacyTicketFlight.createMany({ data: ticketFlightBatch })).count;
  reportFor('rs_ticket_flight').inserted = ticketFlightInserted;

  const [storedFinal, storedReceipts] = await Promise.all([
    prisma.legacyTicket.aggregate({ _sum: { finalPrice: true } }),
    prisma.legacyReceipt.aggregate({ _sum: { amount: true } }),
  ]);
  const storedFinalPrice = decimalString(storedFinal._sum.finalPrice);
  const storedReceiptAmount = decimalString(storedReceipts._sum.amount);
  const report: ImportReport = {
    tables: tableReports,
    sums: {
      parsedFinalPrice: parsedFinalPrice.toFixed(2),
      storedFinalPrice,
      parsedReceiptAmount: parsedReceiptAmount.toFixed(2),
      storedReceiptAmount,
    },
    dataIssues: issueCounts,
    danglingReceipts,
    danglingTicketFlights,
    manualDateFixes: manualFixCounts.manualDateFixes,
    nameFlags: manualFixCounts.nameFlags,
  };

  if (!options.skipDedupe) report.dedupe = await runDedupe(prisma);
  console.log(JSON.stringify(report, null, 2));

  const rowMismatch = Object.entries(tableReports).some(([tableName, table]) => {
    const toleratedDangling = tableName === 'rs_ticket_flight' ? danglingTicketFlights : 0;
    return table.parsed !== table.inserted + toleratedDangling;
  });
  const sumMismatch = parsedFinalPrice.toFixed(2) !== storedFinalPrice || parsedReceiptAmount.toFixed(2) !== storedReceiptAmount;
  if (parserIssueCount > 0 || rowMismatch || sumMismatch) {
    throw new Error('Legacy archive conservation check failed; see the report above.');
  }
  return report;
}

if (process.argv[1]?.endsWith('/legacy-import/import.ts')) {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  importLegacyArchive(options, prisma)
    .catch((error: unknown) => {
      console.error(error);
      console.error('导入中途失败；如需重跑，请加 --wipe。');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
