import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import { listSchedulesWithCost, resolveFlightItemCost } from './finances.cost.service.js';

function itemSchedule(overrides: Partial<{
  charterCostCny: number | null;
  airportTaxDepCny: number | null;
  airportTaxArrCny: number | null;
  fuelCostCny: number | null;
  peakSurchargeCny: number | null;
  aircraftAdjustCny: number | null;
  takeoffDiscountCny: number | null;
  seatClasses: { capacity: number }[];
  departureTime: Date;
  departureTz: string;
}>) {
  return {
    departureTime: new Date('2026-07-22T10:00:00.000Z'),
    departureTz: 'UTC',
    charterCostCny: null,
    airportTaxDepCny: null,
    airportTaxArrCny: null,
    fuelCostCny: null,
    peakSurchargeCny: null,
    aircraftAdjustCny: null,
    takeoffDiscountCny: null,
    seatClasses: [{ capacity: 10 }],
    ...overrides,
  };
}

describe('resolveFlightItemCost — 订单机票行实时成本', () => {
  it('按班次生效成本和该行人数计算', () => {
    expect(
      resolveFlightItemCost(
        itemSchedule({
          charterCostCny: 1000,
          airportTaxDepCny: 80,
          airportTaxArrCny: 70,
          fuelCostCny: 20,
          peakSurchargeCny: 30,
          aircraftAdjustCny: 10,
          takeoffDiscountCny: 5,
        }),
        [],
        2,
      ),
    ).toBe(610);
  });

  it('班次所有成本字段为空时返回 null', () => {
    expect(resolveFlightItemCost(itemSchedule(), [], 2)).toBeNull();
  });

  it('包机费存在但总座位为 0 时按除零口径返回 null', () => {
    expect(
      resolveFlightItemCost(itemSchedule({ charterCostCny: 1000, seatClasses: [] }), [], 2),
    ).toBeNull();
  });

  it('多腿订单的两条机票行分别按各自班次和人数计算', () => {
    const outbound = itemSchedule({ charterCostCny: 1000, airportTaxDepCny: 50 });
    const inbound = itemSchedule({ charterCostCny: 2000, airportTaxArrCny: 80 });
    expect(resolveFlightItemCost(outbound, [], 2)).toBe(300);
    expect(resolveFlightItemCost(inbound, [], 3)).toBe(840);
  });
});

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

  it('输出航班代码，供前端识别同日反向配对班次', async () => {
    const rows = await listSchedulesWithCost(
      undefined,
      client([
        {
          ...schedule({ id: 'schedule-1', charterCostCny: null, seatClasses: [] }),
          flight: { id: 'flight-1', flightNumber: 'CT100', originCode: 'CAN', destinationCode: 'BKK' },
        },
      ]),
    );

    expect(rows[0]).toMatchObject({
      flightNumber: 'CT100',
      originCode: 'CAN',
      destinationCode: 'BKK',
      origin: 'CAN',
      destination: 'BKK',
      // departureTz=UTC 时当地出发日 = UTC 日期；配对同录按此字段判定同一天
      localDepartureDate: '2026-07-22',
    });
  });
});
