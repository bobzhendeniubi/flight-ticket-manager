import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import { ConflictError } from '../../lib/errors.js';
import {
  listSchedulesWithCost,
  patchFlightScheduleCost,
  resolveFlightItemCost,
  setFlightScheduleCostLock,
} from './finances.cost.service.js';

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
      costLocked: false,
      costLockedAt: null,
      costLockedBy: null,
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
      costLocked: false,
      costLockedAt: null,
      costLockedBy: null,
      // departureTz=UTC 时当地出发日 = UTC 日期；配对同录按此字段判定同一天
      localDepartureDate: '2026-07-22',
    });
  });

  it('锁定时把 override 优先、period 回退的生效值固化到班次', async () => {
    const schedule = {
      id: 's-lock',
      flightId: 'f1',
      departureTime: new Date('2026-07-22T10:00:00.000Z'),
      departureTz: 'UTC',
      charterCostCny: 100,
      airportTaxDepCny: null,
      airportTaxArrCny: null,
      fuelCostCny: null,
      peakSurchargeCny: null,
      aircraftAdjustCny: null,
      takeoffDiscountCny: null,
      costLocked: false,
      costLockedAt: null,
      costLockedBy: null,
      flight: { flightNumber: 'FT100' },
    };
    const update = vi.fn().mockResolvedValue(schedule);
    const tx = {
      flightSchedule: { findUnique: vi.fn().mockResolvedValue(schedule), update },
      flightCostPeriod: {
        findMany: vi.fn().mockResolvedValue([
          {
            effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
            effectiveTo: new Date('2026-07-31T00:00:00.000Z'),
            charterCostCny: 900,
            airportTaxDepCny: 20,
            airportTaxArrCny: null,
            fuelCostCny: 30,
            peakSurchargeCny: null,
            aircraftAdjustCny: null,
            takeoffDiscountCny: null,
          },
        ]),
      },
    };
    const client = {
      $transaction: vi.fn(async (fn: (arg: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaClient;

    const result = await setFlightScheduleCostLock('s-lock', true, 'staff-1', client);

    expect(update).toHaveBeenCalledWith({
      where: { id: 's-lock' },
      data: expect.objectContaining({
        charterCostCny: 100,
        airportTaxDepCny: 20,
        fuelCostCny: 30,
        costLocked: true,
        costLockedBy: 'staff-1',
      }),
    });
    expect(result.before.costs).toMatchObject({ charterCostCny: 100, airportTaxDepCny: null });
    expect(result.after.costs).toMatchObject({ charterCostCny: 100, airportTaxDepCny: 20, fuelCostCny: 30 });
  });

  it('解锁只清除锁定元数据，不回滚已经固化的 override', async () => {
    const lockedAt = new Date('2026-07-23T03:00:00.000Z');
    const schedule = {
      id: 's-unlock',
      flightId: 'f1',
      departureTime: new Date('2026-07-22T10:00:00.000Z'),
      departureTz: 'UTC',
      charterCostCny: 100,
      airportTaxDepCny: 20,
      airportTaxArrCny: null,
      fuelCostCny: 30,
      peakSurchargeCny: null,
      aircraftAdjustCny: null,
      takeoffDiscountCny: null,
      costLocked: true,
      costLockedAt: lockedAt,
      costLockedBy: 'staff-1',
      flight: { flightNumber: 'FT100' },
    };
    const update = vi.fn().mockResolvedValue(schedule);
    const tx = {
      flightSchedule: { findUnique: vi.fn().mockResolvedValue(schedule), update },
      flightCostPeriod: { findMany: vi.fn() },
    };
    const client = {
      $transaction: vi.fn(async (fn: (arg: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaClient;

    const result = await setFlightScheduleCostLock('s-unlock', false, 'staff-1', client);

    expect(update).toHaveBeenCalledWith({
      where: { id: 's-unlock' },
      data: { costLocked: false, costLockedAt: null, costLockedBy: null },
    });
    expect(tx.flightCostPeriod.findMany).not.toHaveBeenCalled();
    expect(result.after.costs).toEqual(result.before.costs);
    expect(result.after.costLocked).toBe(false);
  });

  it('锁定班次的成本写入被拒绝', async () => {
    const update = vi.fn();
    const client = {
      flightSchedule: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({ costLocked: true }),
        update,
      },
    } as unknown as PrismaClient;

    await expect(
      patchFlightScheduleCost('s-locked', { charterCostCny: 123 }, client),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      patchFlightScheduleCost('s-locked', { charterCostCny: 123 }, client),
    ).rejects.toThrow('该班次成本已锁定，请先解锁再修改');
    expect(update).not.toHaveBeenCalled();
  });
});
