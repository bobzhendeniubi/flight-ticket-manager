import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import { listSchedulesWithCost } from './finances.cost.service.js';

describe('listSchedulesWithCost', () => {
  it('输出航班代码，供前端识别同日反向配对班次', async () => {
    const client = {
      flightSchedule: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'schedule-1',
            departureTime: new Date('2026-07-22T08:00:00.000Z'),
            flight: {
              id: 'flight-1',
              flightNumber: 'CT100',
              originCode: 'CAN',
              destinationCode: 'BKK',
            },
            seatClasses: [],
            charterCostCny: null,
            airportTaxDepCny: null,
            airportTaxArrCny: null,
            fuelCostCny: null,
            peakSurchargeCny: null,
            aircraftAdjustCny: null,
            takeoffDiscountCny: null,
          },
        ]),
      },
      flightCostPeriod: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaClient;

    const rows = await listSchedulesWithCost(undefined, client);

    expect(rows[0]).toMatchObject({
      flightNumber: 'CT100',
      originCode: 'CAN',
      destinationCode: 'BKK',
      origin: 'CAN',
      destination: 'BKK',
    });
  });
});
