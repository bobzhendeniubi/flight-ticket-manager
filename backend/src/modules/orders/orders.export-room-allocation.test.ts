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

// 当日余房取数（buildDailyRemainingLookup）委托 getHotelNightlyRemaining —— mock 掉，
// 单测只关心「拿到 physicalRemaining/remaining 后怎么选」，不重复覆盖房控内部查库逻辑
// （房控自己的 getHotelNightlyRemaining 单测见 hotel-control.service.test.ts）。
vi.mock('../hotel-control/hotel-control.service.js', () => ({
  getHotelNightlyRemaining: vi.fn(),
}));

import type { PrismaClient } from '@prisma/client';
import { getHotelNightlyRemaining } from '../hotel-control/hotel-control.service.js';
import {
  buildRoomAllocationSheets,
  buildRoomAllocationWorkbook,
  buildDailyRemainingLookup,
  filterRoomItemsByDepartDate,
  roomAllocationExportFilename,
  roomAllocationExportFilenameByDepart,
  COLUMNS,
  type RoomItemForExport,
} from './orders.export-room-allocation.js';

const D = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
/** 带时分秒的完整 ISO 时间戳（录入时间 enteredAt 断言用，D() 只到日粒度）。*/
const D2 = (iso: string): Date => new Date(iso);

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
    total: 4800,
    createdAt: D2('2026-07-01T13:04:02.000Z'),
    passengers: [
      {
        id: 'p1',
        fullName: '张三',
        lastName: 'zhang',
        firstName: 'san',
        gender: 'M',
        dateOfBirth: D('1997-12-11'),
        documentNumber: 'E12345678',
        passportIssueDate: D('2020-06-15'),
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
        passportIssueDate: null,
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
    total: 1000,
    createdAt: D2('2026-07-02T09:30:00.000Z'),
    passengers: [
      {
        id: 'p3',
        fullName: '王五',
        lastName: 'WANG',
        firstName: 'WU',
        gender: null,
        dateOfBirth: D('1988-03-09'),
        documentNumber: 'E00000001',
        passportIssueDate: null,
        passportExpiry: D('2031-12-31'),
        bedPref: null,
      },
    ],
    items: [{ kind: 'HOTEL', flightSchedule: null }],
  };

  return [
    {
      orderId: 'o1',
      hotelCheckIn: D('2026-07-10'),
      hotelRoomType: { name: '标准双床', bedType: '双床', hotel: { name: 'B酒店' } },
      order: o1,
    },
    {
      orderId: 'o2',
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
    expect(r1.issueDate).toBe('15-06-2020');
    expect(r1.passportExpiry).toBe('05-01-2030');
    expect(r1.roomType).toBe('大床房'); // roomGroup.roomType 优先
    expect(r1.notes).toBe('蜜月 / 尽量高层'); // 组备注 + 订单备注
    expect(r1.upgradeReason).toBe('');

    // 李四：未分房 → 姓名回落 fullName、房型回落行上床型、备注只剩订单备注
    expect(r2.pnrName).toBe('李四');
    expect(r2.gender).toBe('F');
    expect(r2.issueDate).toBe(''); // passportIssueDate 缺失 → 留空
    expect(r2.passportExpiry).toBe('');
    expect(r2.roomType).toBe('双床');
    expect(r2.notes).toBe('尽量高层');
  });

  it('结算价格 = 订单总价 / 乘客数（人均，同订单每行相同）；录入时间取 order.createdAt 含秒（北京时间）', () => {
    const sheets = buildRoomAllocationSheets(fixtureItems());
    const [r1, r2] = sheets[0].rows;

    // o1：total=4800，2 位乘客 → 人均 2400，两行相同
    expect(r1.settlePrice).toBe(2400);
    expect(r2.settlePrice).toBe(2400);
    // createdAt = 2026-07-01T13:04:02Z → 北京时间 21:04:02（容器 TZ 是 UTC，不折算会少 8 小时）
    expect(r1.enteredAt).toBe('2026-07-01 21:04:02');
    expect(r2.enteredAt).toBe('2026-07-01 21:04:02');
  });

  it('录入时间跨日：UTC 20:00 → 北京时间次日 04:00，日期进位', () => {
    const items = fixtureItems().map((it) =>
      it.orderId === 'o1'
        ? ({ ...it, order: { ...it.order, createdAt: D2('2026-07-01T20:00:00.000Z') } } as typeof it)
        : it,
    );
    const [r1] = buildRoomAllocationSheets(items)[0].rows;

    expect(r1.enteredAt).toBe('2026-07-02 04:00:00');
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
    // o2：total=1000，1 位乘客 → 人均 1000；录入时间取自己订单的 createdAt
    expect(r3.settlePrice).toBe(1000);
    expect(r3.enteredAt).toBe('2026-07-02 17:30:00');
    expect(r3.issueDate).toBe(''); // 王五未录 passportIssueDate
  });

  it('空输入 → 无 sheet', () => {
    expect(buildRoomAllocationSheets([])).toEqual([]);
  });
});

describe('COLUMNS 列序（对齐旧系统 0713 房控反馈）', () => {
  it('旧系统 16 列原序 + 当前系统特有 3 列（房间号/升级原因/当日余房）追加末位', () => {
    expect(COLUMNS.map((c) => c.header)).toEqual([
      '序号',
      '代理机构',
      '备注',
      '酒店类型',
      '中文名称',
      '乘客姓名',
      '飞行次数',
      '出发(往返)日期',
      '结算价格',
      '乘客生日',
      '性别',
      '证件编号',
      '签发日期',
      '有效日期',
      '录入时间',
      '房型',
      '房间号',
      '升级原因',
      '当日余房',
    ]);
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
  /** passengerId → 性别（'M'/'F'/'X'/null）；缺省视为未知（null）。*/
  genders?: Record<string, string | null>;
}): RoomItemForExport {
  return {
    // 单元测试各自独立一单一 item，orderId 用酒店名即可保证跨用例不撞号
    orderId: `order-${opts.hotelName}`,
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
        gender: opts.genders?.[id] ?? null,
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

  it('同酒店未分房乘客按容量打包：满 capacity 开新房（同性别才拼房）', () => {
    const [sheet] = buildRoomAllocationSheets([
      roomNoItem({
        checkIn: '2026-08-01',
        hotelName: 'D酒店',
        capacity: 2,
        passengerIds: ['a', 'b', 'c'],
        genders: { a: 'M', b: 'M', c: 'M' },
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

/**
 * 回归：自动打包（未人工分房）曾经按取数顺序无视性别按容量硬拼，会把一男一女塞进同一
 * 物理房间号——与销控"异性不能拼一间"口径矛盾（见 hotel-control.service.ts
 * computePhysicalUsed 的 JSDoc）。修复后未分房乘客先按性别分组，组内再按容量打包。
 */
describe('buildRoomAllocationSheets 房间号 — 自动打包按性别分组（异性不拼同房号）', () => {
  it('一男一女两个未分房乘客 → 各自开新房，不是同一个房号', () => {
    const [sheet] = buildRoomAllocationSheets([
      roomNoItem({
        checkIn: '2026-08-05',
        hotelName: 'H酒店',
        capacity: 2,
        passengerIds: ['m1', 'f1'],
        genders: { m1: 'M', f1: 'F' },
      }),
    ]);
    const byDoc = new Map(sheet.rows.map((r) => [r.documentNumber, r.roomNo]));
    expect(byDoc.get('X0')).toBe('房1'); // m1
    expect(byDoc.get('X1')).toBe('房2'); // f1
    expect(sheet.rows.map((r) => r.roomNo)).toEqual(['房1', '房2']);
  });

  it('2 男 + 1 女未分房：男生两两拼房，女生单独开房，互不混住', () => {
    const [sheet] = buildRoomAllocationSheets([
      roomNoItem({
        checkIn: '2026-08-06',
        hotelName: 'I酒店',
        capacity: 2,
        passengerIds: ['m1', 'm2', 'f1'],
        genders: { m1: 'M', m2: 'M', f1: 'F' },
      }),
    ]);
    // m1/m2 同房（男生组按容量打包）；f1 女生组另开一间——不是 3 人硬凑成 2 间混住
    expect(sheet.rows.map((r) => r.roomNo)).toEqual(['房1', '房1', '房2']);
  });

  it('性别未知（X / 缺失）不与任何人拼房，各自单间', () => {
    const [sheet] = buildRoomAllocationSheets([
      roomNoItem({
        checkIn: '2026-08-07',
        hotelName: 'J酒店',
        capacity: 2,
        passengerIds: ['u1', 'u2'],
        genders: { u1: 'X', u2: null },
      }),
    ]);
    expect(sheet.rows.map((r) => r.roomNo)).toEqual(['房1', '房2']);
  });

  it('人工分房组不受性别分组影响：组内异性仍共号（人工分房为准）', () => {
    const [sheet] = buildRoomAllocationSheets([
      roomNoItem({
        checkIn: '2026-08-08',
        hotelName: 'K酒店',
        capacity: 2,
        passengerIds: ['m1', 'f1'],
        genders: { m1: 'M', f1: 'F' },
        roomGroups: [{ id: 'grpMF', hotelName: 'K酒店', passengerIds: ['m1', 'f1'] }],
      }),
    ]);
    expect(sheet.rows.map((r) => r.roomNo)).toEqual(['房1', '房1']);
  });
});

/**
 * 回归：同订单 2 条占房 item（2 家酒店/2 种房型），4 位乘客分两组各自入住一家。
 * 旧实现对每条 item 都遍历订单全部 4 位乘客 → 2 item × 4 乘客 = 8 行（2N，N=4），
 * 其中一半是「张冠李戴」的 Frankenstein 组合（正确的酒店名配上另一条 item 的房型名）。
 * 修复后应 correlate 到各自 roomGroup 归属的 item，恰好 4 行（N），无重复、无错配。
 */
function twoHotelItemOrderFixture(): RoomItemForExport[] {
  const order = {
    notes: null,
    roomAssignment: {
      roomGroups: [
        { id: 'gX', hotelName: '酒店X', roomType: '大床房', passengerIds: ['p1', 'p2'] },
        { id: 'gY', hotelName: '酒店Y', roomType: '双床房', passengerIds: ['p3', 'p4'] },
      ],
    },
    agent: null,
    items: [{ kind: 'HOTEL', flightSchedule: null }],
    passengers: ['p1', 'p2', 'p3', 'p4'].map((id, i) => ({
      id,
      fullName: `客${id}`,
      lastName: null,
      firstName: null,
      gender: null,
      dateOfBirth: D('1990-01-01'),
      documentNumber: `M${i}`,
      passportExpiry: null,
      bedPref: null,
    })),
  };

  const itemX = {
    orderId: 'ord-multi',
    hotelCheckIn: D('2026-09-01'),
    hotelRoomType: {
      hotelId: 'hx',
      name: '大床房',
      bedType: '大床',
      capacity: 2,
      hotel: { name: '酒店X' },
    },
    order,
  };
  const itemY = {
    orderId: 'ord-multi',
    hotelCheckIn: D('2026-09-01'),
    hotelRoomType: {
      hotelId: 'hy',
      name: '双床房',
      bedType: '双床',
      capacity: 2,
      hotel: { name: '酒店Y' },
    },
    order,
  };

  return [itemX, itemY] as unknown as RoomItemForExport[];
}

describe('buildRoomAllocationSheets 多 item 订单（回归：曾经 item×乘客笛卡尔积产生重复行）', () => {
  it('2 hotel item 的订单 → 恰好 N=4 行（不是 2N=8），酒店/房型按 roomGroup 正确配对不串号', () => {
    const sheets = buildRoomAllocationSheets(twoHotelItemOrderFixture());

    // 同一入住日 → 只有 1 个 sheet
    expect(sheets).toHaveLength(1);
    // 修复前：2 item × 4 乘客 = 8 行；修复后：每位乘客 correlate 到自己的房间，恰好 4 行
    expect(sheets[0].rows).toHaveLength(4);

    const byName = new Map(sheets[0].rows.map((r) => [r.chineseName, r]));
    // p1/p2 → 酒店X · 大床房；p3/p4 → 酒店Y · 双床房（不是 Frankenstein 组合）
    expect(byName.get('客p1')?.hotelType).toBe('酒店X · 大床房');
    expect(byName.get('客p2')?.hotelType).toBe('酒店X · 大床房');
    expect(byName.get('客p3')?.hotelType).toBe('酒店Y · 双床房');
    expect(byName.get('客p4')?.hotelType).toBe('酒店Y · 双床房');

    // 同组共号，且两家酒店各自独立编号
    expect(byName.get('客p1')?.roomNo).toBe('房1');
    expect(byName.get('客p2')?.roomNo).toBe('房1');
    expect(byName.get('客p3')?.roomNo).toBe('房1');
    expect(byName.get('客p4')?.roomNo).toBe('房1');
  });
});

/** 单乘客极简 item（专测「中文名称」列取值优先级：chineseName → fullName 含中文 → 留空）。*/
function chineseNameItem(passenger: { fullName: string; chineseName?: string | null }): RoomItemForExport {
  return {
    orderId: `order-cn-${passenger.fullName}`,
    hotelCheckIn: D('2026-08-10'),
    hotelRoomType: {
      name: '双床',
      bedType: '双床',
      capacity: 2,
      hotel: { name: 'G酒店' },
    },
    order: {
      notes: null,
      roomAssignment: null,
      agent: null,
      items: [{ kind: 'HOTEL', flightSchedule: null }],
      passengers: [
        {
          id: 'cn1',
          fullName: passenger.fullName,
          chineseName: passenger.chineseName ?? null,
          lastName: null,
          firstName: null,
          gender: null,
          dateOfBirth: D('1990-01-01'),
          documentNumber: 'X0',
          passportExpiry: null,
          bedPref: null,
        },
      ],
    },
  } as unknown as RoomItemForExport;
}

describe('buildRoomAllocationSheets 中文名称列取值优先级', () => {
  it('有 chineseName → 优先取 chineseName（即便 fullName 是拼音）', () => {
    const [sheet] = buildRoomAllocationSheets([
      chineseNameItem({ fullName: 'YANG, MIAOMIAO', chineseName: '杨苗苗' }),
    ]);
    expect(sheet.rows[0].chineseName).toBe('杨苗苗');
  });

  it('无 chineseName 但 fullName 是中文（直客直接录中文名）→ 用 fullName', () => {
    const [sheet] = buildRoomAllocationSheets([
      chineseNameItem({ fullName: '王小明', chineseName: null }),
    ]);
    expect(sheet.rows[0].chineseName).toBe('王小明');
  });

  it('chineseName 为空白字符串、fullName 是拼音 → 都取不到，留空', () => {
    const [sheet] = buildRoomAllocationSheets([
      chineseNameItem({ fullName: 'ZHANG, SAN', chineseName: '   ' }),
    ]);
    expect(sheet.rows[0].chineseName).toBe('');
  });
});

describe('roomAllocationExportFilename', () => {
  it('单日 / 区间两种文件名', () => {
    expect(roomAllocationExportFilename('2026-07-10', '2026-07-10')).toBe('分房表_2026-07-10.xlsx');
    expect(roomAllocationExportFilename('2026-07-10', '2026-07-12')).toBe(
      '分房表_2026-07-10_2026-07-12.xlsx',
    );
  });

  it('按出发日文件名', () => {
    expect(roomAllocationExportFilenameByDepart('2026-07-10')).toBe('分房表_出发2026-07-10.xlsx');
  });
});

/**
 * 回归：「当日余房」列曾经取床位口径 remaining（拼房场景会出现 8.5 这种物理上不存在的
 * 半间余量），与房态导出/销控板的物理房间口径不一致。修复后改取 getHotelNightlyRemaining
 * 新增的 physicalRemaining。这里 mock 掉 getHotelNightlyRemaining 本身（其内部查库口径由
 * hotel-control.service.test.ts 覆盖），只验证 buildDailyRemainingLookup 选用了哪个字段。
 */
describe('buildDailyRemainingLookup — 当日余房取物理房间口径（不是床位口径）', () => {
  it('remaining=8.5（床位口径）而 physicalRemaining=8（物理口径）时，取 8', async () => {
    vi.mocked(getHotelNightlyRemaining).mockResolvedValue({
      remaining: [8.5],
      physicalRemaining: [8],
      block: [10],
      hasBlock: true,
    });

    const items = [
      {
        hotelRoomType: { hotelId: 'h1' },
        hotelCheckIn: D('2026-09-01'),
      },
    ] as unknown as RoomItemForExport[];

    const lookup = await buildDailyRemainingLookup(items, {} as PrismaClient);

    expect(lookup.get('h1|2026-09-01')).toBe('8');
    expect(getHotelNightlyRemaining).toHaveBeenCalledWith('h1', ['2026-09-01'], {});
  });

  it('block[i]===0（该晚无周期覆盖）→ "未配"，不据 physicalRemaining 判断', async () => {
    vi.mocked(getHotelNightlyRemaining).mockResolvedValue({
      remaining: [3],
      physicalRemaining: [3],
      block: [0],
      hasBlock: true,
    });

    const items = [
      { hotelRoomType: { hotelId: 'h2' }, hotelCheckIn: D('2026-09-02') },
    ] as unknown as RoomItemForExport[];

    const lookup = await buildDailyRemainingLookup(items, {} as PrismaClient);

    expect(lookup.get('h2|2026-09-02')).toBe('未配');
  });
});

/**
 * 选单口径（WHERE 构造）验证：注入捕获 findMany 参数的假 client，导出后断言查询条件。
 * 不落库、不 mock 复杂返回——findMany 返回 []（导出走空 sheet 收尾），只校验选单意图。
 */
function captureClient(): { client: PrismaClient; findMany: ReturnType<typeof vi.fn> } {
  const findMany = vi.fn().mockResolvedValue([]);
  const client = { orderItem: { findMany } } as unknown as PrismaClient;
  return { client, findMany };
}

const UTC = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

describe('buildRoomAllocationWorkbook 选单口径', () => {
  it('按出发日：召回窗口按 ±1 天放宽（当地日↔UTC 日差一天），且不按入住日切范围（导全部入住晚）', async () => {
    const { client, findMany } = captureClient();
    await buildRoomAllocationWorkbook({ departDate: '2026-07-10' }, client);

    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where;

    // 只取占房 item；关键：出发日口径**不**按 hotelCheckIn 切区间（要导整段入住晚）
    expect(where.hotelRoomTypeId).toEqual({ not: null });
    expect(where.hotelCheckIn).toBeUndefined();

    // 主口径：召回窗口 [前一日, 次日+1) —— 班次 departureTime 存 UTC，当地出发日与 UTC 日
    // 最多差一天（当地凌晨起飞的班次 UTC 还在前一天）。窗口只负责别漏，
    // 精确到底是不是该日出发由 filterRoomItemsByDepartDate 按当地日判定。
    const [flightOr] = where.order.OR;
    expect(flightOr.items.some.kind).toBe('FLIGHT');
    expect(flightOr.items.some.flightSchedule.departureTime).toEqual({
      gte: UTC('2026-07-09'),
      lt: UTC('2026-07-12'),
    });
  });

  it('按出发日：回落口径覆盖无航班订单（无挂班次 FLIGHT 行 + 占房 item hotelCheckIn == 该日）', async () => {
    const { client, findMany } = captureClient();
    await buildRoomAllocationWorkbook({ departDate: '2026-07-10' }, client);

    const where = findMany.mock.calls[0][0].where;
    const fallback = where.order.OR[1].AND;
    // 该订单没有任何挂了班次的 FLIGHT 行
    expect(fallback[0].items.none).toEqual({ kind: 'FLIGHT', flightScheduleId: { not: null } });
    // 且有一条占房 item 在该日入住
    expect(fallback[1].items.some.hotelRoomTypeId).toEqual({ not: null });
    expect(fallback[1].items.some.hotelCheckIn).toEqual(UTC('2026-07-10'));
  });

  it('区间口径保持不变：按 hotelCheckIn [from,to] 选、无出发日 OR 分支', async () => {
    const { client, findMany } = captureClient();
    await buildRoomAllocationWorkbook({ from: '2026-07-10', to: '2026-07-12' }, client);

    const where = findMany.mock.calls[0][0].where;
    expect(where.hotelCheckIn).toEqual({ gte: UTC('2026-07-10'), lte: UTC('2026-07-12') });
    expect(where.order.OR).toBeUndefined();
  });

  it('区间口径跨度超 14 天 → 抛 400，不落库', async () => {
    const { client, findMany } = captureClient();
    await expect(
      buildRoomAllocationWorkbook({ from: '2026-07-01', to: '2026-08-01' }, client),
    ).rejects.toThrow(/14/u);
    expect(findMany).not.toHaveBeenCalled();
  });
});

/**
 * 出发日精确细筛（0722 房控反馈）：取数主口径按「任意 FLIGHT 段落在该日」召回，会把
 * 「去程 21 号、回程 22 号」的往返单也带进 22 号表；这里按整单最早航段出发日二次剔除。
 * 纯酒店/未挂班次单（无航班段）由取数回落分支已精确命中，本过滤放行不动。
 */
describe('filterRoomItemsByDepartDate（出发日精确细筛）', () => {
  const roomItem = (
    orderId: string,
    flightDepartures: string[],
    checkIn: string,
  ): RoomItemForExport =>
    ({
      orderId,
      hotelCheckIn: D(checkIn),
      hotelRoomType: { name: '标准双床', bedType: '双床', hotel: { name: 'B酒店' } },
      order: {
        items: flightDepartures.map((iso) => ({
          kind: 'FLIGHT',
          flightSchedule: { departureTime: new Date(iso) },
        })),
      },
    }) as unknown as RoomItemForExport;

  it('去程 21 号、返程 22 号的往返单 → 按 22 号导出被剔除；当天出发单保留', () => {
    const items = [
      roomItem('roundtrip-21-22', ['2026-07-21T02:00:00.000Z', '2026-07-22T05:00:00.000Z'], '2026-07-22'),
      roomItem('depart-22', ['2026-07-22T09:00:00.000Z'], '2026-07-22'),
    ];
    const kept = filterRoomItemsByDepartDate(items, '2026-07-22');
    expect(kept.map((it) => it.orderId)).toEqual(['depart-22']);
  });

  it('22 号 00:xx 出发（+8 当地时刻按 UTC 分量存）→ 归入 22 号，不漏', () => {
    const items = [roomItem('early-22', ['2026-07-22T00:30:00.000Z'], '2026-07-22')];
    const kept = filterRoomItemsByDepartDate(items, '2026-07-22');
    expect(kept.map((it) => it.orderId)).toEqual(['early-22']);
  });

  it('纯酒店/未挂班次单（无航班段）→ 无出发日判定，按 check-in 命中的回落分支放行不动', () => {
    const items = [roomItem('hotel-only', [], '2026-07-22')];
    const kept = filterRoomItemsByDepartDate(items, '2026-07-22');
    expect(kept.map((it) => it.orderId)).toEqual(['hotel-only']);
  });

  // 红眼班次：澳门当地 7/22 00:30 起飞 = 7/21 16:30Z。按 UTC 日会归到 21 号 →
  // 房控按 22 号导分房表就漏了这一单。判定必须走出发地当地日。
  it('当地凌晨起飞（UTC 还在前一天）→ 按当地出发日归入 22 号，不按 UTC 归到 21 号', () => {
    const redEye = (orderId: string): RoomItemForExport =>
      ({
        orderId,
        hotelCheckIn: D('2026-07-22'),
        hotelRoomType: { name: '标准双床', bedType: '双床', hotel: { name: 'B酒店' } },
        order: {
          items: [
            {
              kind: 'FLIGHT',
              flightSchedule: {
                departureTime: new Date('2026-07-21T16:30:00.000Z'), // 澳门 7/22 00:30
                departureTz: 'Asia/Macau',
              },
            },
          ],
        },
      }) as unknown as RoomItemForExport;

    expect(filterRoomItemsByDepartDate([redEye('red-eye')], '2026-07-22').map((it) => it.orderId)).toEqual([
      'red-eye',
    ]);
    // 反向：按 21 号导时不该把它算进来
    expect(filterRoomItemsByDepartDate([redEye('red-eye')], '2026-07-21')).toEqual([]);
  });
});
