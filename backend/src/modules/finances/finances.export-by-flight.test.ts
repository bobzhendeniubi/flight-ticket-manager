import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { buildFinanceExportByFlightWorkbook } from './finances.export-by-flight.js';

describe('buildFinanceExportByFlightWorkbook — 空座成本列', () => {
  it('导出总座单座成本和空座成本，并对零座/缺包机输出 null', async () => {
    const schedules = [
      {
        id: 's1',
        flightId: 'f1',
        departureTime: new Date('2026-07-22T10:00:00.000Z'),
        departureTz: 'UTC',
        charterCostCny: 1000,
        airportTaxDepCny: null,
        airportTaxArrCny: null,
        fuelCostCny: null,
        peakSurchargeCny: null,
        aircraftAdjustCny: null,
        takeoffDiscountCny: null,
        seatClasses: [{ capacity: 10, sold: 2 }],
        flight: { id: 'f1', flightNumber: 'FT100', originCode: 'AAA', destinationCode: 'BBB' },
      },
      {
        id: 's2',
        flightId: 'f2',
        departureTime: new Date('2026-07-22T11:00:00.000Z'),
        departureTz: 'UTC',
        charterCostCny: 1000,
        airportTaxDepCny: null,
        airportTaxArrCny: null,
        fuelCostCny: null,
        peakSurchargeCny: null,
        aircraftAdjustCny: null,
        takeoffDiscountCny: null,
        seatClasses: [],
        flight: { id: 'f2', flightNumber: 'FT200', originCode: 'AAA', destinationCode: 'CCC' },
      },
      {
        id: 's3',
        flightId: 'f3',
        departureTime: new Date('2026-07-22T12:00:00.000Z'),
        departureTz: 'UTC',
        charterCostCny: null,
        airportTaxDepCny: null,
        airportTaxArrCny: null,
        fuelCostCny: null,
        peakSurchargeCny: null,
        aircraftAdjustCny: null,
        takeoffDiscountCny: null,
        seatClasses: [{ capacity: 10, sold: 2 }],
        flight: { id: 'f3', flightNumber: 'FT300', originCode: 'AAA', destinationCode: 'DDD' },
      },
    ];
    const client = {
      flightSchedule: { findMany: vi.fn().mockResolvedValue(schedules) },
      orderItem: { findMany: vi.fn().mockResolvedValue([]) },
      flightCostPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await buildFinanceExportByFlightWorkbook(
        { from: '2026-07-22', to: '2026-07-22' },
        client,
      )) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.getWorksheet('财务按航班 P&L')!;
    const headers = sheet.getRow(1).values as unknown[];
    const perSeatColumn = headers.indexOf('单座成本(÷总座)');
    const emptySeatColumn = headers.indexOf('空座成本');

    expect(perSeatColumn).toBeGreaterThan(0);
    expect(emptySeatColumn).toBeGreaterThan(0);
    expect(sheet.getRow(2).getCell(perSeatColumn).value).toBe(100);
    expect(sheet.getRow(2).getCell(emptySeatColumn).value).toBe(800);
    expect(sheet.getRow(3).getCell(perSeatColumn).value).toBeNull();
    expect(sheet.getRow(3).getCell(emptySeatColumn).value).toBeNull();
    expect(sheet.getRow(4).getCell(perSeatColumn).value).toBeNull();
    expect(sheet.getRow(4).getCell(emptySeatColumn).value).toBeNull();
  });
});

describe('buildFinanceExportByFlightWorkbook — 释放/作废的航段腿不进平摊分母', () => {
  /** 一个只有去程班次落在导出区间里的往返单：回程行的班次已被释放置空。 */
  function makeClient(returnScheduleId: string | null) {
    const schedules = [
      {
        id: 'sch-out',
        flightId: 'f1',
        departureTime: new Date('2026-09-10T02:00:00.000Z'),
        departureTz: 'UTC',
        charterCostCny: null,
        airportTaxDepCny: null,
        airportTaxArrCny: null,
        fuelCostCny: null,
        peakSurchargeCny: null,
        aircraftAdjustCny: null,
        takeoffDiscountCny: null,
        seatClasses: [{ capacity: 10, sold: 2 }],
        flight: { id: 'f1', flightNumber: 'FT100', originCode: 'AAA', destinationCode: 'BBB' },
      },
    ];
    const order = {
      id: 'ord-1',
      passengers: [],
      costItems: [{ category: 'MISC', amountCny: 600 }],
      items: [
        {
          kind: 'FLIGHT',
          flightScheduleId: 'sch-out',
          amount: 4000,
          quantity: 2,
          totalCostCny: null,
          hotelCheckIn: null,
          hotelCheckOut: null,
          hotelRoomType: null,
          visa: null,
          transfer: null,
          fulfillmentTasks: [],
        },
        {
          kind: 'FLIGHT',
          flightScheduleId: returnScheduleId,
          amount: 4000,
          quantity: 2,
          totalCostCny: null,
          hotelCheckIn: null,
          hotelCheckOut: null,
          hotelRoomType: null,
          visa: null,
          transfer: null,
          fulfillmentTasks: [],
        },
      ],
    };
    return {
      flightSchedule: { findMany: vi.fn().mockResolvedValue(schedules) },
      orderItem: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ orderId: 'ord-1', flightScheduleId: 'sch-out' }]),
      },
      order: { findMany: vi.fn().mockResolvedValue([order]) },
      flightCostPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
  }

  async function readRow(client: PrismaClient) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await buildFinanceExportByFlightWorkbook(
        { from: '2026-09-10', to: '2026-09-10' },
        client,
      )) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.getWorksheet('财务按航班 P&L')!;
    const headers = sheet.getRow(1).values as unknown[];
    const cell = (header: string) => sheet.getRow(2).getCell(headers.indexOf(header)).value;
    return { flightRevenue: cell('机票收入'), miscCost: cell('杂项成本') };
  }

  it('回程行班次置空后：去程班次拿满整单机票收入与杂项成本（100%，不再对半分）', async () => {
    const released = await readRow(makeClient(null));
    expect(released.flightRevenue).toBe(8000);
    expect(released.miscCost).toBe(600);
  });

  it('两腿都还挂着班次时照旧对半平摊（回归保护）', async () => {
    const intact = await readRow(makeClient('sch-return'));
    expect(intact.flightRevenue).toBe(4000);
    expect(intact.miscCost).toBe(300);
  });
});

// ── 已换人（SWAPPED）单：换人费照记该班收入，房费/签证/车费/杂项一律不计（order-cost-policy）──
describe('buildFinanceExportByFlightWorkbook — 已换人单成本按 0', () => {
  /** 同一班次上的一张单：机票行 + 房费快照 800 + 签证任务人均 226.8 + 杂项 600；只有状态/票价不同。 */
  function orderOn(id: string, status: string, flightAmount: number) {
    const bare = {
      hotelCheckIn: null,
      hotelCheckOut: null,
      hotelRoomTypeId: null,
      hotelRoomType: null,
      visa: null,
      transfer: null,
      flightSchedule: null,
      fulfillmentTasks: [],
    };
    return {
      id,
      status,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      passengers: [{ id: `${id}-p1`, visaExempt: false }],
      costItems: [{ category: 'OTHER', amountCny: 600 }],
      items: [
        {
          ...bare,
          kind: 'FLIGHT',
          flightScheduleId: 'sch-1',
          amount: flightAmount,
          quantity: 1,
          totalCostCny: null,
          flightSchedule: { departureTime: new Date('2026-09-10T02:00:00.000Z'), departureTz: 'UTC' },
        },
        { ...bare, kind: 'HOTEL', flightScheduleId: null, amount: 300, quantity: 1, totalCostCny: 800 },
        {
          ...bare,
          kind: 'VISA',
          flightScheduleId: null,
          amount: 150,
          quantity: 1,
          totalCostCny: null,
          visa: { costPriceCny: 220 },
          fulfillmentTasks: [{ visaUnitCostCny: 226.8 }],
        },
      ],
    };
  }

  it('同一班次上：已换人单只贡献收入；已支付单照常计房费 / 签证 / 杂项', async () => {
    const schedules = [
      {
        id: 'sch-1',
        flightId: 'f1',
        departureTime: new Date('2026-09-10T02:00:00.000Z'),
        departureTz: 'UTC',
        charterCostCny: null,
        airportTaxDepCny: null,
        airportTaxArrCny: null,
        fuelCostCny: null,
        peakSurchargeCny: null,
        aircraftAdjustCny: null,
        takeoffDiscountCny: null,
        seatClasses: [{ capacity: 10, sold: 1 }],
        flight: { id: 'f1', flightNumber: 'FT100', originCode: 'AAA', destinationCode: 'BBB' },
      },
    ];
    const orders = [orderOn('ord-swapped', 'SWAPPED', 450), orderOn('ord-paid', 'PAID', 1000)];
    const client = {
      flightSchedule: { findMany: vi.fn().mockResolvedValue(schedules) },
      orderItem: {
        findMany: vi
          .fn()
          .mockResolvedValue(orders.map((o) => ({ orderId: o.id, flightScheduleId: 'sch-1' }))),
      },
      order: { findMany: vi.fn().mockResolvedValue(orders) },
      flightCostPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await buildFinanceExportByFlightWorkbook(
        { from: '2026-09-10', to: '2026-09-10' },
        client,
      )) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.getWorksheet('财务按航班 P&L')!;
    const headers = sheet.getRow(1).values as unknown[];
    const cell = (header: string) => {
      const index = headers.indexOf(header);
      expect(index).toBeGreaterThan(0);
      return sheet.getRow(2).getCell(index).value;
    };

    // 收入：两单都算（机票 450 + 1000；其他 = 房 300 + 签 150，两单各一份）。
    expect(cell('机票收入')).toBe(1450);
    expect(cell('其他收入')).toBe(900);
    // 成本：只有已支付单那份（房费快照 800、签证任务 226.8 × 1 位需签乘客、杂项 600）。
    expect(cell('房费')).toBe(800);
    expect(cell('签证费')).toBe(226.8);
    expect(cell('杂项成本')).toBe(600);
    expect(cell('总成本(不含空座成本)')).toBe(1626.8);
    expect(cell('整班毛利')).toBe(723.2);
  });
});
