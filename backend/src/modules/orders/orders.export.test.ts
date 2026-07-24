/**
 * 整班机订单导出（buildOrdersBySchedule）· 单元测试（vitest）
 *
 * 测试口径：
 *   - 往返单即使回程航段先录入（DB 顺序在前），路线串/航班号串仍按起飞时间升序拼接；
 *   - 「去程日期」= 最早航段日期，「回程日期」= 最末航段日期；
 *   - 单程单「回程日期」留空。
 * prisma 客户端注入假实现；开票进度取数（ticketing-cap）mock 为无座位库存路径。
 */
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';

// 顶层引用 prisma —— mock 掉，避免测试触发真实 DB 连接
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));
// 开票进度取数走独立集成验证；此处 mock 为「班次未配舱位」路径（无开票进度行）
vi.mock('./ticketing-cap.js', () => ({
  getScheduleSeatCapacity: vi.fn(async () => null),
  countIssuedPassengers: vi.fn(async () => 0),
}));

import { buildOrdersBySchedule } from './orders.export.js';

const D = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

interface FlightItemInput {
  flightNumber: string;
  originCode: string;
  destinationCode: string;
  departureTime: Date;
}

function flightItem(input: FlightItemInput): Record<string, unknown> {
  return {
    kind: 'FLIGHT',
    flightSchedule: {
      departureTime: input.departureTime,
      flight: {
        flightNumber: input.flightNumber,
        originCode: input.originCode,
        destinationCode: input.destinationCode,
      },
    },
    hotelRoomType: null,
    visa: null,
    transfer: null,
    bundle: null,
    hotelCheckIn: null,
    hotelCheckOut: null,
  };
}

function passenger(id: string): Record<string, unknown> {
  return {
    id,
    fullName: 'ZHANG/SAN',
    lastName: 'ZHANG',
    firstName: 'SAN',
    chineseName: '测试乘客',
    title: null,
    gender: 'M',
    dateOfBirth: D('1990-01-01'),
    documentNumber: 'E12345678',
    nationality: 'CHN',
    passportIssueDate: D('2020-01-01'),
    passportIssuePlace: null,
    passportIssueCountry: null,
    placeOfBirth: null,
    passportExpiry: D('2030-01-01'),
  };
}

function order(orderNumber: string, items: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    orderNumber,
    status: 'PAID',
    agent: null,
    contactName: '联系人',
    contactPhone: '13800000000',
    total: 1000,
    passengers: [passenger(`p-${orderNumber}`)],
    items,
    roomAssignment: null,
    notes: null,
    createdAt: D('2026-06-01'),
  };
}

/** 假 client：findMany 直接返回预置订单。*/
function fakeClient(orders: Array<Record<string, unknown>>) {
  return {
    order: { findMany: vi.fn(async () => orders) },
  } as never;
}

/** 解析导出 buffer → { header: string[], dataRows: string[][] }（无座位库存：row1=乘客数，row2=表头）。*/
async function parseSheet(buf: Buffer): Promise<{ header: string[]; dataRows: string[][] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const ws = wb.worksheets[0];
  const rowValues = (n: number): string[] => {
    const vals: string[] = [];
    ws.getRow(n).eachCell({ includeEmpty: true }, (cell) => {
      vals.push(cell.value == null ? '' : String(cell.value));
    });
    return vals;
  };
  const header = rowValues(2);
  const dataRows: string[][] = [];
  for (let n = 3; n <= ws.rowCount; n++) dataRows.push(rowValues(n));
  return { header, dataRows };
}

function cell(header: string[], row: string[], columnHeader: string): string {
  const idx = header.indexOf(columnHeader);
  expect(idx, `列「${columnHeader}」应存在`).toBeGreaterThanOrEqual(0);
  return row[idx] ?? '';
}

describe('buildOrdersBySchedule · 航段排序与去/回程日期', () => {
  it('回程航段先录入时，路线/航班号串仍按起飞时间升序，去/回程日期取首末航段', async () => {
    // Arrange：DB 顺序 = 回程在前（DPS→PVG 06-15），去程在后（PVG→DPS 06-10）
    const client = fakeClient([
      order('ORD-RT-001', [
        flightItem({
          flightNumber: 'ZJ8889',
          originCode: 'DPS',
          destinationCode: 'PVG',
          departureTime: D('2026-06-15'),
        }),
        flightItem({
          flightNumber: 'ZJ8888',
          originCode: 'PVG',
          destinationCode: 'DPS',
          departureTime: D('2026-06-10'),
        }),
      ]),
    ]);

    // Act
    const buf = await buildOrdersBySchedule('sched-1', client);
    const { header, dataRows } = await parseSheet(buf);

    // Assert
    expect(dataRows).toHaveLength(1);
    const row = dataRows[0];
    expect(cell(header, row, '路线')).toBe('PVG → DPS / DPS → PVG');
    expect(cell(header, row, '航班号')).toBe('ZJ8888 / ZJ8889');
    expect(cell(header, row, '去程日期')).toBe('2026-06-10');
    expect(cell(header, row, '回程日期')).toBe('2026-06-15');
  });

  it('单程单只有去程日期，回程日期留空', async () => {
    // Arrange
    const client = fakeClient([
      order('ORD-OW-001', [
        flightItem({
          flightNumber: 'ZJ8888',
          originCode: 'PVG',
          destinationCode: 'DPS',
          departureTime: D('2026-06-10'),
        }),
      ]),
    ]);

    // Act
    const buf = await buildOrdersBySchedule('sched-1', client);
    const { header, dataRows } = await parseSheet(buf);

    // Assert
    expect(dataRows).toHaveLength(1);
    const row = dataRows[0];
    expect(cell(header, row, '路线')).toBe('PVG → DPS');
    expect(cell(header, row, '去程日期')).toBe('2026-06-10');
    expect(cell(header, row, '回程日期')).toBe('');
  });
});
