/**
 * 分房表（成都格式）行/Sheet 构建 · 单元测试（vitest）
 *
 * 只测纯函数 buildRoomAllocationSheets 的映射口径：
 *   - 按入住日期分 sheet，名 'M-D'，日期升序
 *   - roomGroup.hotelName 优先归组；行按酒店名排序、序号 per-sheet 重编
 *   - 姓名/生日/性别/有效期/出发日期/房型/备注的格式与回落规则
 * 取数 SQL（COUNTED_STATUSES、入住区间）由集成环境验证，不在此 mock prisma 查询。
 */
import { describe, it, expect, vi } from 'vitest';

// 模块链路（orders.export-templates → orders.service）顶层引用 prisma —— mock 掉
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  buildRoomAllocationSheets,
  roomAllocationExportFilename,
  type RoomItemForExport,
} from './orders.export-room-allocation.js';

const D = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/** 两单 fixture：O1 有分房 + 两段航班；O2 无分房、无航班、有代理。*/
function fixtureItems(): RoomItemForExport[] {
  const o1 = {
    notes: '尽量高层',
    roomAssignment: {
      roomGroups: [
        {
          id: 'g1',
          hotelName: 'A酒店',
          roomType: '大床房',
          passengerIds: ['p1'],
          notes: '蜜月',
        },
      ],
    },
    agent: null,
    passengers: [
      {
        id: 'p1',
        fullName: '张三',
        lastName: 'zhang',
        firstName: 'san',
        gender: 'M',
        dateOfBirth: D('1997-12-11'),
        documentNumber: 'E12345678',
        passportExpiry: D('2030-01-05'),
        bedPref: null,
      },
      {
        id: 'p2',
        fullName: '李四',
        lastName: null,
        firstName: null,
        gender: 'F',
        dateOfBirth: D('2000-01-02'),
        documentNumber: 'E87654321',
        passportExpiry: null,
        bedPref: null,
      },
    ],
    items: [
      { kind: 'FLIGHT', flightSchedule: { departureTime: D('2026-07-10') } },
      { kind: 'FLIGHT', flightSchedule: { departureTime: D('2026-07-14') } },
      { kind: 'HOTEL', flightSchedule: null },
    ],
  };

  const o2 = {
    notes: null,
    roomAssignment: null,
    agent: { companyName: '成都国旅' },
    passengers: [
      {
        id: 'p3',
        fullName: '王五',
        lastName: 'WANG',
        firstName: 'WU',
        gender: null,
        dateOfBirth: D('1988-03-09'),
        documentNumber: 'E00000001',
        passportExpiry: D('2031-12-31'),
        bedPref: null,
      },
    ],
    items: [{ kind: 'HOTEL', flightSchedule: null }],
  };

  return [
    {
      hotelCheckIn: D('2026-07-10'),
      hotelRoomType: { name: '标准双床', bedType: '双床', hotel: { name: 'B酒店' } },
      order: o1,
    },
    {
      hotelCheckIn: D('2026-07-11'),
      hotelRoomType: { name: '高级房', bedType: null, hotel: { name: 'C酒店' } },
      order: o2,
    },
  ] as unknown as RoomItemForExport[];
}

describe('buildRoomAllocationSheets', () => {
  it('按入住日期分 sheet（名 M-D、升序），酒店名排序后 per-sheet 编号', () => {
    const sheets = buildRoomAllocationSheets(fixtureItems());

    expect(sheets.map((s) => s.name)).toEqual(['7-10', '7-11']);
    expect(sheets[0].date).toBe('2026-07-10');

    // p1 分到 A酒店（roomGroup 覆盖行上 B酒店），排在 B酒店的 p2 前面
    const [r1, r2] = sheets[0].rows;
    expect(sheets[0].rows).toHaveLength(2);
    expect([r1.seq, r2.seq]).toEqual([1, 2]);
    expect(r1.hotelType).toBe('A酒店 · 标准双床');
    expect(r2.hotelType).toBe('B酒店 · 标准双床');
  });

  it('字段口径：姓名大写 LAST/FIRST、dd-mm-yyyy、M/F、往返日期、房型与备注回落', () => {
    const sheets = buildRoomAllocationSheets(fixtureItems());
    const [r1, r2] = sheets[0].rows;

    // 张三：有分房组
    expect(r1.agency).toBe('直客');
    expect(r1.chineseName).toBe('张三');
    expect(r1.pnrName).toBe('ZHANG/SAN');
    expect(r1.flightCount).toBe('');
    expect(r1.travelDates).toBe('2026-07-10 / 2026-07-14');
    expect(r1.dateOfBirth).toBe('11-12-1997');
    expect(r1.gender).toBe('M');
    expect(r1.documentNumber).toBe('E12345678');
    expect(r1.issueDate).toBe('');
    expect(r1.passportExpiry).toBe('05-01-2030');
    expect(r1.roomType).toBe('大床房'); // roomGroup.roomType 优先
    expect(r1.notes).toBe('蜜月 / 尽量高层'); // 组备注 + 订单备注
    expect(r1.upgradeReason).toBe('');

    // 李四：未分房 → 姓名回落 fullName、房型回落行上床型、备注只剩订单备注
    expect(r2.pnrName).toBe('李四');
    expect(r2.gender).toBe('F');
    expect(r2.passportExpiry).toBe('');
    expect(r2.roomType).toBe('双床');
    expect(r2.notes).toBe('尽量高层');
  });

  it('无航班订单出发日期回落入住日；床型缺失时房型留空；代理显示公司名', () => {
    const sheets = buildRoomAllocationSheets(fixtureItems());
    const [r3] = sheets[1].rows;

    expect(r3.agency).toBe('成都国旅');
    expect(r3.travelDates).toBe('2026-07-11');
    expect(r3.gender).toBe('');
    expect(r3.roomType).toBe('');
    expect(r3.notes).toBe('');
    expect(r3.hotelType).toBe('C酒店 · 高级房');
  });

  it('空输入 → 无 sheet', () => {
    expect(buildRoomAllocationSheets([])).toEqual([]);
  });
});

/** 单酒店、指定容量、可设分房组的极简 item（专测房间号分配）。*/
function roomNoItem(opts: {
  checkIn: string;
  hotelName: string;
  capacity: number;
  passengerIds: string[];
  roomGroups?: Array<{
    id: string;
    hotelName: string;
    roomType?: string;
    roomFraction?: number;
    passengerIds: string[];
  }>;
}): RoomItemForExport {
  return {
    hotelCheckIn: D(opts.checkIn),
    hotelRoomType: {
      name: '双床',
      bedType: '双床',
      capacity: opts.capacity,
      hotel: { name: opts.hotelName },
    },
    order: {
      notes: null,
      roomAssignment: opts.roomGroups ? { roomGroups: opts.roomGroups } : null,
      agent: null,
      items: [{ kind: 'HOTEL', flightSchedule: null }],
      passengers: opts.passengerIds.map((id, i) => ({
        id,
        fullName: `客${id}`,
        lastName: null,
        firstName: null,
        gender: null,
        dateOfBirth: D('1990-01-01'),
        documentNumber: `X${i}`,
        passportExpiry: null,
        bedPref: null,
      })),
    },
  } as unknown as RoomItemForExport;
}

describe('buildRoomAllocationSheets 房间号', () => {
  it('房间号 per 酒店各自从 1 起（同房型名不同酒店不撞号）', () => {
    const sheets = buildRoomAllocationSheets(fixtureItems());
    const [r1, r2] = sheets[0].rows;
    expect(r1.roomNo).toBe('房1'); // p1 → A酒店（分房组）
    expect(r2.roomNo).toBe('房1'); // p2 → B酒店，另一酒店独立从 1 起
  });

  it('同酒店未分房乘客按容量打包：满 capacity 开新房', () => {
    const [sheet] = buildRoomAllocationSheets([
      roomNoItem({
        checkIn: '2026-08-01',
        hotelName: 'D酒店',
        capacity: 2,
        passengerIds: ['a', 'b', 'c'],
      }),
    ]);
    expect(sheet.rows.map((r) => r.roomNo)).toEqual(['房1', '房1', '房2']);
  });

  it('已分房同组共号、未分房续在其后', () => {
    const [sheet] = buildRoomAllocationSheets([
      roomNoItem({
        checkIn: '2026-08-03',
        hotelName: 'F酒店',
        capacity: 2,
        passengerIds: ['g1a', 'g1b', 'u1'],
        roomGroups: [{ id: 'grp1', hotelName: 'F酒店', passengerIds: ['g1a', 'g1b'] }],
      }),
    ]);
    // grp1 两人 = 房1；未分房 u1 续号 = 房2
    expect(sheet.rows.map((r) => r.roomNo)).toEqual(['房1', '房1', '房2']);
  });

  it('半间/拼房组（roomFraction 0.5）房号标 (½)', () => {
    const [sheet] = buildRoomAllocationSheets([
      roomNoItem({
        checkIn: '2026-08-02',
        hotelName: 'E酒店',
        capacity: 2,
        passengerIds: ['x', 'y'],
        roomGroups: [
          { id: 'gh', hotelName: 'E酒店', roomFraction: 0.5, passengerIds: ['x', 'y'] },
        ],
      }),
    ]);
    expect(sheet.rows.map((r) => r.roomNo)).toEqual(['房1(½)', '房1(½)']);
  });
});

describe('roomAllocationExportFilename', () => {
  it('单日 / 区间两种文件名', () => {
    expect(roomAllocationExportFilename('2026-07-10', '2026-07-10')).toBe('分房表_2026-07-10.xlsx');
    expect(roomAllocationExportFilename('2026-07-10', '2026-07-12')).toBe(
      '分房表_2026-07-10_2026-07-12.xlsx',
    );
  });
});
