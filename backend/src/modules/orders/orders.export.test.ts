/**
 * 整班机订单导出（buildOrdersBySchedule）· 单元测试（vitest）
 *
 * 测试口径：
 *   - 往返单即使回程航段先录入（DB 顺序在前），路线串/航班号串仍按起飞时间升序拼接；
 *   - 「去程日期」= 最早航段日期，「回程日期」= 最末航段日期；
 *   - 单程单「回程日期」留空。
 *   - 列尾「房号 / 当日余房」两列（房控核对用，口径对齐分房表导出）。
 * prisma 客户端注入假实现；开票进度取数（ticketing-cap）mock 为无座位库存路径。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';

// 顶层引用 prisma —— mock 掉，避免测试触发真实 DB 连接
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));
// 开票进度取数走独立集成验证；此处 mock 为「班次未配舱位」路径（无开票进度行）
vi.mock('./ticketing-cap.js', () => ({
  getScheduleSeatCapacity: vi.fn(async () => null),
  countIssuedPassengers: vi.fn(async () => 0),
}));
// 「当日余房」底层取数（销控口径本身由 hotel-control.service.test.ts 覆盖）——
// 此处按 hotelId 预置返回，只验证导出端三态展示（数字 / 未配 / —）。
const nightlyByHotel = vi.hoisted(
  () => new Map<string, { hasBlock: boolean; block?: number; physicalRemaining?: number }>(),
);
vi.mock('../hotel-control/hotel-control.service.js', () => ({
  getHotelNightlyRemaining: vi.fn(async (hotelId: string, dates: readonly string[]) => {
    const cfg = nightlyByHotel.get(hotelId);
    if (!cfg || !cfg.hasBlock) {
      // 与真实实现一致：该酒店无任何包房周期 → hasBlock=false + 空数组
      return { remaining: [], hasBlock: false, block: [], physicalRemaining: [] };
    }
    return {
      remaining: dates.map(() => cfg.physicalRemaining ?? 0),
      hasBlock: true,
      block: dates.map(() => cfg.block ?? 10),
      physicalRemaining: dates.map(() => cfg.physicalRemaining ?? 0),
    };
  }),
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

function passenger(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

interface HotelItemInput {
  hotelId: string;
  hotelName: string;
  roomTypeName: string;
  capacity: number;
  checkIn: string; // YYYY-MM-DD
}

function hotelItem(input: HotelItemInput): Record<string, unknown> {
  return {
    kind: 'HOTEL',
    flightSchedule: null,
    hotelRoomType: {
      hotelId: input.hotelId,
      name: input.roomTypeName,
      bedType: null,
      capacity: input.capacity,
      hotel: { name: input.hotelName },
    },
    visa: null,
    transfer: null,
    bundle: null,
    hotelCheckIn: D(input.checkIn),
    hotelCheckOut: D(input.checkIn),
  };
}

interface RandomStarItemInput {
  /** 星级随机档（3 = 三星随机、4 = 四星随机）*/
  tier: number;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
}

/** 未落位的星级随机占房行：无 hotelRoomType（还没落到具体酒店），只有 randomStarTier。*/
function randomStarItem(input: RandomStarItemInput): Record<string, unknown> {
  return {
    kind: 'HOTEL',
    flightSchedule: null,
    hotelRoomType: null,
    randomStarTier: input.tier,
    visa: null,
    transfer: null,
    bundle: null,
    hotelCheckIn: D(input.checkIn),
    hotelCheckOut: D(input.checkOut),
  };
}

function order(
  orderNumber: string,
  items: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    ...overrides,
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

  it('回程座位已释放：回程日期写「已释放」，航段状态列出两态', async () => {
    // Arrange：去程正常 + 已标 no-show；回程行班次已置空（座位放回库存）
    const released = {
      ...flightItem({
        flightNumber: 'ZJ8889',
        originCode: 'DPS',
        destinationCode: 'PVG',
        departureTime: D('2026-06-15'),
      }),
      flightSchedule: null,
      flightScheduleId: null,
      metadata: {
        returnReleased: { at: '2026-06-11T02:00:00.000Z', originalScheduleId: 'sch-ret' },
      },
    };
    const outbound = {
      ...flightItem({
        flightNumber: 'ZJ8888',
        originCode: 'PVG',
        destinationCode: 'DPS',
        departureTime: D('2026-06-10'),
      }),
      flightScheduleId: 'sch-out',
      metadata: { noShow: { at: '2026-06-11T02:00:00.000Z', leg: 'OUTBOUND' } },
    };
    const client = fakeClient([order('ORD-NS-001', [outbound, released])]);

    // Act
    const buf = await buildOrdersBySchedule('sched-1', client);
    const { header, dataRows } = await parseSheet(buf);

    // Assert：留空会被当成单程单，必须写「已释放」
    const row = dataRows[0];
    expect(cell(header, row, '去程日期')).toBe('2026-06-10');
    expect(cell(header, row, '回程日期')).toBe('已释放');
    expect(cell(header, row, '航段状态')).toBe('去程未登机 / 回程座位已释放');
  });

  it('航段状态列紧跟「回程日期」，正常单留空', async () => {
    const client = fakeClient([
      order('ORD-RT-002', [
        flightItem({
          flightNumber: 'ZJ8888',
          originCode: 'PVG',
          destinationCode: 'DPS',
          departureTime: D('2026-06-10'),
        }),
      ]),
    ]);
    const { header, dataRows } = await parseSheet(await buildOrdersBySchedule('sched-1', client));
    expect(header[header.indexOf('回程日期') + 1]).toBe('航段状态');
    expect(cell(header, dataRows[0], '航段状态')).toBe('');
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

describe('buildOrdersBySchedule · 房号 / 当日余房（房控核对列，口径对齐分房表导出）', () => {
  beforeEach(() => {
    nightlyByHotel.clear();
  });

  it('两列追加在现有列尾（不动原列序）', async () => {
    const client = fakeClient([
      order('ORD-COL-001', [
        flightItem({
          flightNumber: 'ZJ8888',
          originCode: 'PVG',
          destinationCode: 'DPS',
          departureTime: D('2026-06-10'),
        }),
      ]),
    ]);

    const buf = await buildOrdersBySchedule('sched-1', client);
    const { header } = await parseSheet(buf);

    expect(header[header.length - 2]).toBe('房号');
    expect(header[header.length - 1]).toBe('当日余房');
    // 原列尾（备注）仍在两新列之前
    expect(header[header.length - 3]).toBe('备注');
  });

  it('有分房组：同 roomGroup 同号，半间/拼房组标 (½)；当日余房为数字余量', async () => {
    // Arrange：4 位乘客，g1 整间（2 人）+ g2 半间（2 人），同酒店同入住日
    nightlyByHotel.set('h1', { hasBlock: true, block: 10, physicalRemaining: 5 });
    const client = fakeClient([
      order(
        'ORD-RG-001',
        [hotelItem({ hotelId: 'h1', hotelName: '椰风酒店', roomTypeName: '双床房', capacity: 2, checkIn: '2026-06-10' })],
        {
          passengers: [
            passenger('pa1'),
            passenger('pa2', { gender: 'F' }),
            passenger('pb1'),
            passenger('pb2', { gender: 'F' }),
          ],
          roomAssignment: {
            roomGroups: [
              { id: 'g1', hotelName: '椰风酒店', roomType: '双床房', passengerIds: ['pa1', 'pa2'] },
              {
                id: 'g2',
                hotelName: '椰风酒店',
                roomType: '双床房',
                passengerIds: ['pb1', 'pb2'],
                roomFraction: 0.5,
              },
            ],
          },
        },
      ),
    ]);

    // Act
    const buf = await buildOrdersBySchedule('sched-1', client);
    const { header, dataRows } = await parseSheet(buf);

    // Assert：同组同号（人工分房不受性别打包影响），半间组标 (½)
    expect(dataRows).toHaveLength(4);
    expect(dataRows.map((r) => cell(header, r, '房号'))).toEqual([
      '房1',
      '房1',
      '房2(½)',
      '房2(½)',
    ]);
    for (const r of dataRows) expect(cell(header, r, '当日余房')).toBe('5');
  });

  it('未分房：按性别 + 房型容量打包（异性不拼房），跨订单同酒店同入住日一起编号', async () => {
    // Arrange：订单 A（男 1 + 女 1）+ 订单 B（男 1），同酒店同入住日，容量 2/间；
    // 该酒店无包房周期 → 当日余房 "未配"
    const h2Item = () =>
      hotelItem({ hotelId: 'h2', hotelName: '海棠居', roomTypeName: '标间', capacity: 2, checkIn: '2026-06-10' });
    const client = fakeClient([
      order('ORD-PK-A', [h2Item()], {
        passengers: [passenger('pm1'), passenger('pf1', { gender: 'F' })],
      }),
      order('ORD-PK-B', [h2Item()], { passengers: [passenger('pm2')] }),
    ]);

    // Act
    const buf = await buildOrdersBySchedule('sched-1', client);
    const { header, dataRows } = await parseSheet(buf);

    // Assert：男 pm1/pm2（跨订单）拼 房1，女 pf1 独开 房2
    expect(dataRows).toHaveLength(3);
    expect(dataRows.map((r) => cell(header, r, '房号'))).toEqual(['房1', '房2', '房1']);
    for (const r of dataRows) expect(cell(header, r, '当日余房')).toBe('未配');
  });

  it('无酒店行（纯机票乘客）：房号留空，当日余房 "—"', async () => {
    const client = fakeClient([
      order('ORD-FL-001', [
        flightItem({
          flightNumber: 'ZJ8888',
          originCode: 'PVG',
          destinationCode: 'DPS',
          departureTime: D('2026-06-10'),
        }),
      ]),
    ]);

    const buf = await buildOrdersBySchedule('sched-1', client);
    const { header, dataRows } = await parseSheet(buf);

    expect(dataRows).toHaveLength(1);
    expect(cell(header, dataRows[0], '房号')).toBe('');
    expect(cell(header, dataRows[0], '当日余房')).toBe('—');
  });

  it('分房组人工酒店名与关联酒店不一致：归属不确定，当日余房 "—"（不瞎标）', async () => {
    // Arrange：h1 配了包房（余 5），但乘客分房组人工填了别家酒店名 → 不能按 h1 的余量标
    nightlyByHotel.set('h1', { hasBlock: true, block: 10, physicalRemaining: 5 });
    const client = fakeClient([
      order(
        'ORD-MM-001',
        [hotelItem({ hotelId: 'h1', hotelName: '椰风酒店', roomTypeName: '双床房', capacity: 2, checkIn: '2026-06-10' })],
        {
          passengers: [passenger('px1')],
          roomAssignment: {
            roomGroups: [{ id: 'g1', hotelName: '手填别家酒店', roomType: '', passengerIds: ['px1'] }],
          },
        },
      ),
    ]);

    // Act
    const buf = await buildOrdersBySchedule('sched-1', client);
    const { header, dataRows } = await parseSheet(buf);

    // Assert：房号仍按分房组分配；余房因归属不确定标 "—"
    expect(dataRows).toHaveLength(1);
    expect(cell(header, dataRows[0], '房号')).toBe('房1');
    expect(cell(header, dataRows[0], '当日余房')).toBe('—');
  });
});

describe('buildOrdersBySchedule · 星级随机未落位行（口径对齐分房表导出）', () => {
  beforeEach(() => {
    nightlyByHotel.clear();
  });

  it('未落位随机档行照样上表：酒店列标「三星随机（待落位）」，余房 "—"，容量回落 2 人/间', async () => {
    // Arrange：三星随机档还没落到具体酒店（无 hotelRoomType，只有 randomStarTier），
    // 同住 2 位男客；早先这类行被整类筛掉，乘客在整班机导出里酒店列全空。
    const client = fakeClient([
      order(
        'ORD-RANDOM-001',
        [randomStarItem({ tier: 3, checkIn: '2026-06-10', checkOut: '2026-06-12' })],
        { passengers: [passenger('pr1'), passenger('pr2')] },
      ),
    ]);

    // Act
    const buf = await buildOrdersBySchedule('sched-1', client);
    const { header, dataRows } = await parseSheet(buf);

    // Assert
    expect(dataRows).toHaveLength(2);
    for (const row of dataRows) {
      expect(cell(header, row, '酒店名称')).toBe('三星随机（待落位）');
      // 未落位时不再拼「· 待落位」（酒店名本身已说明房型未定），入住区间照常带上
      expect(cell(header, row, '酒店房型')).toBe('三星随机（待落位） (2026-06-10 ~ 2026-06-12)');
      // 没定店 → 谈不上哪家酒店的余量
      expect(cell(header, row, '当日余房')).toBe('—');
    }
    // 容量回落 2 人/间：两位同性客拼一间
    expect(dataRows.map((r) => cell(header, r, '房号'))).toEqual(['房1', '房1']);
  });

  it('未落位随机档但房控已人工排房：酒店跟房控走，房型仍标「待落位」', async () => {
    // Arrange：房控在分房组里填了实际酒店名，随机档行仍未回写 FK
    const client = fakeClient([
      order(
        'ORD-RANDOM-002',
        [randomStarItem({ tier: 4, checkIn: '2026-06-10', checkOut: '2026-06-11' })],
        {
          passengers: [passenger('pr3')],
          roomAssignment: {
            roomGroups: [{ id: 'g1', hotelName: '椰风酒店', roomType: '', passengerIds: ['pr3'] }],
          },
        },
      ),
    ]);

    // Act
    const buf = await buildOrdersBySchedule('sched-1', client);
    const { header, dataRows } = await parseSheet(buf);

    // Assert
    expect(dataRows).toHaveLength(1);
    expect(cell(header, dataRows[0], '酒店名称')).toBe('椰风酒店');
    expect(cell(header, dataRows[0], '酒店房型')).toBe(
      '椰风酒店 · 待落位 (2026-06-10 ~ 2026-06-11)',
    );
    expect(cell(header, dataRows[0], '房号')).toBe('房1');
    expect(cell(header, dataRows[0], '当日余房')).toBe('—');
  });
});
