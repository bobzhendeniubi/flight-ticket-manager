import { describe, expect, it, vi } from 'vitest';
import { runDedupe } from './dedupe.js';

describe('legacy dedupe marking', () => {
  it('marks exact matches and reports passport hits whose earliest flight date differs', async () => {
    const updates: Array<{ id: string; data: unknown }> = [];
    const rows = [
      { id: 'legacy-exact', bookingNo: 'B-1', documentNumberNorm: 'P-EXACT', outboundDate: new Date('2026-08-10T00:00:00Z') },
      { id: 'legacy-loose', bookingNo: 'B-2', documentNumberNorm: 'P-LOOSE', outboundDate: new Date('2026-08-02T00:00:00Z') },
      { id: 'legacy-mismatch', bookingNo: 'B-3', documentNumberNorm: 'P-MISMATCH', outboundDate: new Date('2025-07-01T00:00:00Z') },
    ];
    const db = {
      legacyTicket: {
        findMany: vi.fn().mockResolvedValue(rows),
        findUnique: vi.fn().mockResolvedValue({ dataIssues: [] }),
        update: vi.fn().mockImplementation(async (input: { where: { id: string }; data: unknown }) => {
          updates.push({ id: input.where.id, data: input.data });
          return {};
        }),
      },
      order: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'order-exact', passengers: [{ documentNumber: ' p-exact ' }], items: [{ flightSchedule: { departureTime: new Date('2026-08-10T14:00:00Z') } }] },
          { id: 'order-loose', passengers: [{ documentNumber: 'P-LOOSE' }], items: [{ flightSchedule: { departureTime: new Date('2026-09-01T14:00:00Z') } }] },
          { id: 'order-mismatch', passengers: [{ documentNumber: 'P-MISMATCH' }], items: [{ flightSchedule: { departureTime: new Date('2025-09-01T14:00:00Z') } }] },
        ]),
      },
    };

    const report = await runDedupe(db as never);
    expect(report.primaryHits).toBe(1);
    expect(report.passportFlightMismatches.map((item) => item.legacyTicketId)).toEqual(['legacy-loose', 'legacy-mismatch']);
    expect(report.passportFlightMismatches.map((item) => item.recent)).toEqual([true, false]);
    expect(updates).toEqual([
      { id: 'legacy-exact', data: { supersededByOrderId: 'order-exact' } },
    ]);
    expect(db.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        deletedAt: null,
        status: { notIn: ['CANCELLED', 'PAYMENT_TIMEOUT', 'REFUNDED', 'FAILED'] },
      },
    }));
    expect(db.legacyTicket.findUnique).not.toHaveBeenCalled();
  });
});
