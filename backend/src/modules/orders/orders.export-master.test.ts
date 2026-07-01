/**
 * 全岗总表导出 · 单元测试（vitest）
 *
 * 只测纯函数 orderToMasterRows / visibleColumns / masterExportFilename 的映射口径：
 *   - 一行/乘客；金额均摊到人
 *   - 关键列填满：酒店中文名、结算价格、航段数（飞行次数）、护照签发地回落、分房情况、订单成本
 *   - role 裁列（票务/签证视图隐藏无关列，通用列保留）
 * 取数 SQL（COUNTED_STATUSES、出发日期区间）由集成环境验证，不在此 mock prisma 查询。
 */
import { describe, it, expect, vi } from 'vitest';

// 模块链路（orders.export-master → orders.service）顶层引用 prisma —— mock 掉
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  orderToMasterRows,
  visibleColumns,
  masterExportFilename,
  type OrderForMasterExport,
} from './orders.export-master.js';

const D = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/**
 * 一张往返套餐订单 fixture：
 *   - 两段航班（往返 → 航段数=2）
 *   - 酒店行带中文名「明月酒店」
 *   - 2 位乘客：张三（护照签发地齐全 + 分房组）、李四（只有名字：无签发地 → 回落颁发国 CHN，未分房）
 *   - 一条订单成本（操作费 20）
 *   - total 10000 / paid 4000 → 人均结算 5000、已到账 2000、尾款 3000
 */
function fixtureRoundTripBundle(): OrderForMasterExport {
  return {
    id: 'o1',
    orderNumber: 'FTM2026070100001',
    status: 'PAID',
    invoiceStatus: 'NONE',
    visaStatus: 'E_VISA',
    total: 10000,
    paidAmount: 4000,
    notes: '尽量高层',
    noteHotel: null,
    noteVisa: null,
    notePayment: null,
    noteSpecial: null,
    guestName: null,
    createdAt: D('2026-06-20'),
    roomAssignment: {
      roomGroups: [
        { id: 'g1', hotelName: '明月酒店', roomType: '大床房', passengerIds: ['p1'], notes: '蜜月' },
      ],
    },
    agent: { companyName: '成都国旅' },
    user: { displayName: '前台小王', email: 'wang@ftm.local' },
    payments: [],
    refunds: [],
    costItems: [{ category: 'OPERATION_FEE', amountCny: 20 }],
    passengers: [
      {
        id: 'p1',
        fullName: '张三',
        chineseName: '张三',
        lastName: 'ZHANG',
        firstName: 'SAN',
        gender: 'M',
        dateOfBirth: D('1990-01-15'),
        passengerType: 'ADULT',
        nationality: 'CN',
        documentType: 'PASSPORT',
        documentNumber: 'E12345678',
        passportIssueDate: D('2020-03-10'),
        passportIssuePlace: '北京',
        passportIssueCountry: 'CHN',
        passportExpiry: D('2030-03-09'),
        placeOfBirth: '四川',
      },
      {
        id: 'p2',
        fullName: '李四',
        chineseName: null,
        lastName: null,
        firstName: null,
        gender: 'F',
        dateOfBirth: D('1988-07-30'),
        passengerType: 'CHILD',
        nationality: 'CN',
        documentType: 'PASSPORT',
        documentNumber: 'E87654321',
        passportIssueDate: null,
        passportIssuePlace: null, // 无签发地 → 回落颁发国
        passportIssueCountry: 'CHN',
        passportExpiry: null,
        placeOfBirth: null,
      },
    ],
    items: [
      {
        kind: 'FLIGHT',
        flightCabin: 'ECONOMY',
        hotelRoomTypeId: null,
        amount: 0,
        metadata: null,
        flightSchedule: {
          departureTime: D('2026-07-10'),
          flight: { flightNumber: 'ZJ8888', originCode: 'CTU', destinationCode: 'CXR' },
        },
        hotelRoomType: null,
        visa: null,
        fulfillmentTasks: [],
      },
      {
        kind: 'FLIGHT',
        flightCabin: 'ECONOMY',
        hotelRoomTypeId: null,
        amount: 0,
        metadata: null,
        flightSchedule: {
          departureTime: D('2026-07-14'),
          flight: { flightNumber: 'ZJ8889', originCode: 'CXR', destinationCode: 'CTU' },
        },
        hotelRoomType: null,
        visa: null,
        fulfillmentTasks: [],
      },
      {
        kind: 'HOTEL',
        flightCabin: null,
        hotelRoomTypeId: 'hrt1',
        amount: 0,
        metadata: { singleRoomDiff: 800 },
        flightSchedule: null,
        hotelRoomType: { name: '标准双床', hotel: { name: '明月酒店' } },
        visa: null,
        fulfillmentTasks: [],
      },
      {
        kind: 'VISA',
        flightCabin: null,
        hotelRoomTypeId: null,
        amount: 500,
        metadata: null,
        flightSchedule: null,
        hotelRoomType: null,
        visa: { visaName: '越南电子签', visaType: 'E-visa' },
        fulfillmentTasks: [{ type: 'VISA_APPLICATION', status: 'IN_PROGRESS' }],
      },
    ],
  } as unknown as OrderForMasterExport;
}

/**
 * 一张套餐(BUNDLE)订单 fixture：酒店房型 + 签证履约任务都盖在 kind:'BUNDLE' 行上，
 * 没有独立 kind:'HOTEL' / kind:'VISA' 行（与 orders.service BUNDLE 分支的真实写入形态一致）。
 *   - 1 位乘客，无分房分配（roomAssignment 空）→ 有酒店但未分房，应显示"未分房"
 *   - 订单级 visaStatus 缺省 → 签证状态回落 BUNDLE 行上的 VISA_APPLICATION 任务
 *   - 套餐定义 bundle.items 含 VISA 组件（越南 E-visa ¥220）→ 签证金额从套餐挂牌价捞出（非 0）
 */
function fixtureBundleHotelStampedOnBundleItem(): OrderForMasterExport {
  return {
    id: 'o2',
    orderNumber: 'FTM2026070150143',
    status: 'PAID',
    invoiceStatus: 'NONE',
    visaStatus: null, // 订单级签证状态缺省 → 回落履约任务
    total: 8000,
    paidAmount: 8000,
    notes: null,
    noteHotel: null,
    noteVisa: null,
    notePayment: null,
    noteSpecial: null,
    guestName: null,
    createdAt: D('2026-06-25'),
    roomAssignment: null, // 未分房
    agent: null,
    user: { displayName: '前台小李', email: 'li@ftm.local' },
    payments: [],
    refunds: [],
    costItems: [],
    passengers: [
      {
        id: 'p1',
        fullName: '王五',
        chineseName: '王五',
        lastName: 'WANG',
        firstName: 'WU',
        gender: 'M',
        dateOfBirth: D('1992-05-05'),
        passengerType: 'ADULT',
        nationality: 'CN',
        documentType: 'PASSPORT',
        documentNumber: 'E11223344',
        passportIssueDate: D('2021-06-01'),
        passportIssuePlace: '上海',
        passportIssueCountry: 'CHN',
        passportExpiry: D('2031-05-31'),
        placeOfBirth: '浙江',
      },
    ],
    items: [
      {
        // 套餐行：酒店房型 + 签证履约任务都盖在这一行（无独立 HOTEL / VISA 行）
        kind: 'BUNDLE',
        flightCabin: null,
        hotelRoomTypeId: 'hrt_dn4s',
        amount: 8000,
        metadata: { singleRoomDiff: 0 },
        flightSchedule: null,
        hotelRoomType: { name: '海景房', hotel: { name: '岘港四季度假村' } },
        visa: null,
        // 套餐定义：含签证组件（越南 E-visa 挂牌价 ¥220 × 1）+ 其它组件（用于验证只加总 VISA）
        bundle: {
          items: [
            { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回经济舱 × 1 人', qty: 1, unitPrice: 0 },
            { kind: 'HOTEL', productName: '岘港四季度假村 海景房 4 晚', qty: 4, unitPrice: 3680 },
            { kind: 'VISA', productName: '越南 E-visa 30 天', qty: 1, unitPrice: 220 },
          ],
        },
        fulfillmentTasks: [{ type: 'VISA_APPLICATION', status: 'IN_PROGRESS' }],
      },
    ],
  } as unknown as OrderForMasterExport;
}

describe('orderToMasterRows', () => {
  it('一行/乘客，2 位乘客 → 2 行', () => {
    const rows = orderToMasterRows(fixtureRoundTripBundle());
    expect(rows).toHaveLength(2);
  });

  it('关键列填满：酒店中文名、结算价格、航段数、护照签发地回落、分房情况、订单成本', () => {
    const [r1, r2] = orderToMasterRows(fixtureRoundTripBundle());

    // 酒店中文名（来自 hotelRoomType.hotel.name）
    expect(r1.hotelName).toBe('明月酒店');

    // 结算价格 = total/pax = 10000/2 = 5000；已到账 = 4000/2 = 2000；尾款 = 6000/2 = 3000
    expect(r1.settlePrice).toBe(5000);
    expect(r1.settleReceived).toBe(2000);
    expect(r1.balanceDue).toBe(3000);
    expect(r1.settled).toBe('否'); // paid < total

    // 飞行次数 = 航段数（往返 → 2）；订单类型往返票
    expect(r1.flightCount).toBe('2');
    expect(r1.orderType).toBe('往返票');
    expect(r1.flightNumbers).toBe('ZJ8888 ⇌ ZJ8889');
    expect(r1.travelDates).toBe('2026-07-10 / 2026-07-14');
    expect(r1.cabin).toBe('经济舱');

    // 护照签发地：p1 有签发地「北京」；p2 无 → 回落颁发国 CHN
    expect(r1.passportIssuePlace).toBe('北京');
    expect(r2.passportIssuePlace).toBe('CHN');

    // 证件签发日 / 有效期（p1 有，p2 空）
    expect(r1.issueDate).toBe('2020-03-10');
    expect(r1.expiryDate).toBe('2030-03-09');
    expect(r2.issueDate).toBe('');
    expect(r2.expiryDate).toBe('');

    // 分房情况：p1 分房组 → 房1·整间；p2 未分房但有酒店 → 未分房
    expect(r1.distribution).toBe('房1·整间');
    expect(r2.distribution).toBe('未分房');

    // 订单成本（OrderCostItem）
    expect(r1.orderCost).toBe('操作费 20');

    // 单房差 metadata 汇总 800 / 2 人 = 400；签证金额 500/2 = 250
    expect(r1.singleRoomDiff).toBe(400);
    expect(r1.visaAmount).toBe(250);

    // 签证状态：订单级 E_VISA 优先 → 电子签
    expect(r1.visaStatus).toBe('电子签');

    // 姓名 / 中文名 / 类型 / 性别 / 国籍 / 证件类型
    expect(r1.chineseName).toBe('张三');
    expect(r1.passengerName).toBe('ZHANG/SAN');
    expect(r2.chineseName).toBe('李四'); // chineseName 缺 → 回落 fullName
    expect(r1.passengerType).toBe('成人');
    expect(r2.passengerType).toBe('儿童');
    expect(r1.gender).toBe('男');
    expect(r1.nationality).toBe('CHN'); // toAlpha3(CN)
    expect(r1.documentType).toBe('护照');

    // 代理机构 / 录入人员 / 开票状态 / 订单编号
    expect(r1.agency).toBe('成都国旅');
    expect(r1.recordedBy).toBe('前台小王');
    expect(r1.invoiceStatus).toBe('未开');
    expect(r1.orderNumber).toBe('FTM2026070100001');

    // 备注：订单备注 + p1 分房组备注（酒店/房型/组备注）
    expect(r1.notes).toContain('尽量高层');
    expect(r1.notes).toContain('蜜月');
  });

  it('单程订单 → 航段数=1、订单类型单程票', () => {
    const order = fixtureRoundTripBundle();
    // 去掉回程 → 单程
    (order.items as unknown[]).splice(1, 1);
    const [r1] = orderToMasterRows(order);
    expect(r1.flightCount).toBe('1');
    expect(r1.orderType).toBe('单程票');
    expect(r1.flightNumbers).toBe('ZJ8888');
  });

  it('无乘客 → 空数组', () => {
    const order = fixtureRoundTripBundle();
    (order as { passengers: unknown[] }).passengers = [];
    expect(orderToMasterRows(order)).toEqual([]);
  });

  it('套餐单酒店盖在 BUNDLE 行（无独立 HOTEL 行）→ 酒店中文名填满 + 未分房乘客显示"未分房"', () => {
    const order = fixtureBundleHotelStampedOnBundleItem();
    const [r1] = orderToMasterRows(order);

    // 酒店房型盖在 BUNDLE 行上 → 酒店中文名仍应取到（此前只认 kind==='HOTEL' 会留空）
    expect(r1.hotelName).toBe('岘港四季度假村');
    // 有酒店但该乘客未分房 → "未分房"（此前 hasHotel 只认 HOTEL 行会永远留空）
    expect(r1.distribution).toBe('未分房');
    // 套餐签证费并入套餐价，但从套餐定义 items 的 VISA 组件挂牌价捞出 → 220×1 / 1 人 = 220（非 0）
    expect(r1.visaAmount).toBe(220);
    // 签证履约任务挂在 BUNDLE 行上、订单级 visaStatus 缺省 → 回落任务状态"处理中"
    expect(r1.visaStatus).toBe('处理中');
  });
});

describe('visibleColumns（role 裁列）', () => {
  it('all（默认）= 全部列，含结算价格/分房情况/订单成本/酒店中文名称', () => {
    const headers = visibleColumns('all').map((c) => c.header);
    expect(headers).toContain('结算价格');
    expect(headers).toContain('分房情况');
    expect(headers).toContain('订单成本');
    expect(headers).toContain('酒店中文名称');
  });

  it('ticketing（票务）隐藏财务/分房列，保留航班/证件列', () => {
    const headers = visibleColumns('ticketing').map((c) => c.header);
    expect(headers).toContain('航班号');
    expect(headers).toContain('飞行次数');
    expect(headers).toContain('证件编号');
    // 财务/分房列隐藏
    expect(headers).not.toContain('结算价格');
    expect(headers).not.toContain('分房情况');
    expect(headers).not.toContain('订单成本');
  });

  it('visa（签证）保留酒店/签证/证件列，隐藏航班/财务列', () => {
    const headers = visibleColumns('visa').map((c) => c.header);
    expect(headers).toContain('酒店中文名称');
    expect(headers).toContain('签证金额');
    expect(headers).toContain('护照签发地');
    expect(headers).toContain('证件有效期');
    // 航班/财务列隐藏
    expect(headers).not.toContain('航班号');
    expect(headers).not.toContain('结算价格');
  });

  it('所有视图都保留通用列（序号/代理机构/乘客中文名/订单编号）', () => {
    for (const role of ['all', 'ticketing', 'visa'] as const) {
      const headers = visibleColumns(role).map((c) => c.header);
      expect(headers).toContain('序号');
      expect(headers).toContain('代理机构');
      expect(headers).toContain('乘客中文名');
      expect(headers).toContain('订单编号');
    }
  });
});

describe('masterExportFilename', () => {
  it('区间 / 单缺省两种文件名', () => {
    expect(masterExportFilename('2026-07-01', '2026-07-31')).toBe('全岗总表_2026-07-01_2026-07-31.xlsx');
    expect(masterExportFilename('2026-07-10')).toBe('全岗总表_2026-07-10_2026-07-10.xlsx');
    expect(masterExportFilename()).toBe('全岗总表_全部_全部.xlsx');
  });
});
