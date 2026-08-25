import { OrderStatus, type PrismaClient } from '@prisma/client';
import { localDateISO } from '../../src/lib/flight-time.js';

type DedupeDb = Pick<PrismaClient, 'legacyTicket' | 'order'>;

interface LegacyCandidate {
  id: string;
  bookingNo: string | null;
  documentNumberNorm: string | null;
  outboundDate: Date | null;
}

interface CurrentOrder {
  id: string;
  passengers: Array<{ documentNumber: string }>;
  items: Array<{ flightSchedule: { departureTime: Date; departureTz: string } | null }>;
}

export interface DedupeMismatch {
  legacyTicketId: string;
  bookingNo: string | null;
  documentNumberNorm: string;
  legacyOutboundDate: string | null;
  currentOrderIds: string[];
  recent: boolean;
}

export interface DedupeReport {
  primaryHits: number;
  passportFlightMismatches: DedupeMismatch[];
}

function normalizeDocument(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized || null;
}

function dateKey(value: Date | null | undefined, timezone?: string | null): string | null {
  if (!value) return null;
  return localDateISO(value, timezone);
}

/** Mark old rows that have an equivalent current order; this never creates a relation. */
export async function runDedupe(db: DedupeDb): Promise<DedupeReport> {
  const [legacyRows, orderRows] = await Promise.all([
    db.legacyTicket.findMany({
      where: { documentNumberNorm: { not: null } },
      select: { id: true, bookingNo: true, documentNumberNorm: true, outboundDate: true },
    }),
    db.order.findMany({
      where: {
        deletedAt: null,
        status: {
          notIn: [
            OrderStatus.CANCELLED,
            OrderStatus.PAYMENT_TIMEOUT,
            OrderStatus.REFUNDED,
            OrderStatus.FAILED,
          ],
        },
      },
      select: {
        id: true,
        passengers: { select: { documentNumber: true } },
        items: {
          where: { kind: 'FLIGHT' },
          select: { flightSchedule: { select: { departureTime: true, departureTz: true } } },
        },
      },
    }),
  ]) as [LegacyCandidate[], CurrentOrder[]];

  const ordersByDocument = new Map<string, Array<{ orderId: string; departureDate: string | null }>>();
  for (const order of orderRows) {
    const firstFlight = order.items
      .map((item) => item.flightSchedule)
      .filter((schedule): schedule is NonNullable<typeof schedule> => schedule !== null)
      .sort((a, b) => a.departureTime.getTime() - b.departureTime.getTime())[0];
    const departureDate = dateKey(firstFlight?.departureTime, firstFlight?.departureTz);
    for (const passenger of order.passengers) {
      const document = normalizeDocument(passenger.documentNumber);
      if (!document) continue;
      const existing = ordersByDocument.get(document) ?? [];
      existing.push({ orderId: order.id, departureDate });
      ordersByDocument.set(document, existing);
    }
  }

  const looseThreshold = new Date(Date.UTC(2026, 7, 1));
  let primaryHits = 0;
  const passportFlightMismatches: DedupeMismatch[] = [];

  for (const legacy of legacyRows) {
    const document = normalizeDocument(legacy.documentNumberNorm);
    if (!document) continue;
    const matches = ordersByDocument.get(document) ?? [];
    if (matches.length === 0) continue;
    const legacyDate = dateKey(legacy.outboundDate);
    const primary = matches.find((match) => legacyDate !== null && match.departureDate === legacyDate);
    if (primary) {
      await db.legacyTicket.update({
        where: { id: legacy.id },
        data: { supersededByOrderId: primary.orderId },
      });
      primaryHits += 1;
      continue;
    }

    passportFlightMismatches.push({
      legacyTicketId: legacy.id,
      bookingNo: legacy.bookingNo,
      documentNumberNorm: document,
      legacyOutboundDate: legacyDate,
      currentOrderIds: matches.map((match) => match.orderId),
      recent: legacy.outboundDate !== null && legacy.outboundDate >= looseThreshold,
    });
  }

  return { primaryHits, passportFlightMismatches };
}
