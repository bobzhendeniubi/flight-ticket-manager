import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import { listSchedulesWithCost } from './finances.cost.service.js';

describe('listSchedulesWithCost — 财务口径：包机费÷全部座位，空座成本单列', () => {
  function schedule(opts: {
    id: string;
    charterCostCny: number | null;
    seatClasses: { capacity: number; sold: number }[];
  }) {
    return {
      id: opts.id,
      flightId: 'f1',
      departureTime: new Date('2026-07-22T10:00:00.000Z'),
      departureTz: 'UTC',
      charterCostCny: opts.charterCostCny,
      airportTaxDepCny: null,
      airportTaxArrCny: null,
      fuelCostCny: null,
      peakSurchargeCny: null,
      aircraftAdjustCny: null,
      takeoffDiscountCny: null,
      seatClasses: opts.seatClasses,
      flight: { id: 'f1', flightNumber: 'FT100', originCode: 'AAA', destinationCode: 'BBB' },
    };
  }

  function client(schedules: unknown[]): PrismaClient {
    return {
      flightSchedule: { findMany: vi.fn().mockResolvedValue(schedules) },
      flightCostPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
  }

  it('使用总座位分母，并返回空座成本', async () => {
    const [row] = await listSchedulesWithCost(
      undefined,
      client([schedule({ id: 's1', charterCostCny: 1000, seatClasses: [{ capacity: 10, sold: 2 }] })]),
    );

    expect(row.perSeatCostCny).toBe(100);
    expect(row.emptySeatCostCny).toBe(800);
  });

  it('总座位为 0 或包机费缺失时，单座和空座成本均为 null', async () => {
    const rows = await listSchedulesWithCost(
      undefined,
      client([
        schedule({ id: 'zero-seats', charterCostCny: 1000, seatClasses: [] }),
        schedule({ id: 'no-charter', charterCostCny: null, seatClasses: [{ capacity: 10, sold: 2 }] }),
      ]),
    );

    expect(rows[0]).toMatchObject({ perSeatCostCny: null, emptySeatCostCny: null });
    expect(rows[1]).toMatchObject({ perSeatCostCny: null, emptySeatCostCny: null });
  });
});
