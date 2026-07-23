/**
 * 全岗总表导出 · 单元测试（vitest）
 *
 * 只测纯函数 orderToMasterRows / visibleColumns / masterExportFilename 的映射口径：
 *   - 一行/乘客；金额均摊到人
 *   - 关键列填满：酒店中文名、结算价格、护照签发地回落、分房情况、订单成本
 *   - 飞行次数 = 常旅客档案历史飞行次数（每位乘客各不相同，不是本单航段数）
 *   - role 裁列（票务/签证视图隐藏无关列，通用列保留）
 * 取数 SQL（COUNTED_STATUSES、出发日期区间）由集成环境验证，不在此 mock prisma 查询；
 * loadTripCountMap 的档案取数/合并指针跟随用注入的假 client 驱动（见文末 describe）。
 */
import { describe, it, expect, vi } from 'vitest';

// 模块链路（orders.export-master → orders.service）顶层引用 prisma —— mock 掉
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  orderToMasterRows,
  loadTripCountMap,
  visibleColumns,
  masterExportFilename,
  type OrderForMasterExport,
  type TripCountMap,
} from './orders.export-master.js';
import { filterExportOrdersByDepartDate } from './orders.export-depart-filter.js';
import { docKey } from '../travelers/traveler-profiles.aggregate.js';

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
    invoiceStatus: 'NONE', // 旧字段：六态开票改造后不再回写，导出不应再读它（P2-15a）
    outboundInvoiced: false,
    returnInvoiced: false,
    systemInvoiced: false,
    adjustmentCny: 0,
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
        // flightScheduleId 供 determineFlightLegs 判定去程/回程（P2-15a 开票状态列用到）
        flightScheduleId: 'fs-out',
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
        flightScheduleId: 'fs-ret',
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
        visa: { visaName: '越南电子签', visaType: 'E-visa', supplier: '越南A签证公司' },
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

  it('关键列填满：酒店中文名、结算价格、航班/日期、护照签发地回落、分房情况、订单成本', () => {
    const [r1, r2] = orderToMasterRows(fixtureRoundTripBundle());

    // 酒店中文名（来自 hotelRoomType.hotel.name）
    expect(r1.hotelName).toBe('明月酒店');

    // 结算价格 = total/pax = 10000/2 = 5000；已到账 = 4000/2 = 2000；尾款 = 6000/2 = 3000
    expect(r1.settlePrice).toBe(5000);
    expect(r1.settleReceived).toBe(2000);
    expect(r1.balanceDue).toBe(3000);
    expect(r1.settled).toBe('否'); // paid < total

    // 订单类型往返票（飞行次数不再由航段推导 —— 见「飞行次数」describe）
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

    // 签证公司（财务反馈：核对签证金额属于哪家供应商）：取 VISA 行关联产品的 supplier
    expect(r1.visaSupplier).toBe('越南A签证公司');

    // 姓名 / 中文名 / 类型 / 性别 / 国籍 / 证件类型
    expect(r1.chineseName).toBe('张三');
    // 称谓（0711 反馈「订单导出缺 MR/MS」）：成人男性 → 姓名后加 " MR"。
    expect(r1.passengerName).toBe('ZHANG/SAN MR');
    // 纯拼音名（0720 公测反馈：MR/MS 影响财务对数匹配）：同名不带称谓。
    expect(r1.cleanName).toBe('ZHANG/SAN');
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

  it('单程订单 → 订单类型单程票', () => {
    const order = fixtureRoundTripBundle();
    // 去掉回程 → 单程
    (order.items as unknown[]).splice(1, 1);
    const [r1] = orderToMasterRows(order);
    expect(r1.orderType).toBe('单程票');
    expect(r1.flightNumbers).toBe('ZJ8888');
  });

  // ── 飞行次数 = 常旅客历史飞行次数（B23）───────────────────────────────────
  // 旧实现填的是「本单航段数」（往返2/单程1），且按订单算一次贴给该单每位乘客 ——
  // 同一订单所有乘客恒等、与「这个人飞过几次」零关系。改接 TravelerProfile.tripCount
  // （按证件号归拢，只计去程已起飞的行程）后，每位乘客各不相同。
  describe('飞行次数 = 常旅客档案历史飞行次数', () => {
    it('同一订单不同乘客的飞行次数各按本人证件取，不再恒等（旧口径下两人都是航段数 2）', () => {
      const order = fixtureRoundTripBundle(); // p1=E12345678、p2=E87654321，往返 2 段
      const tripCounts: TripCountMap = new Map([
        [docKey('PASSPORT', 'E12345678'), 7], // 老客
        [docKey('PASSPORT', 'E87654321'), 1], // 飞过一次
      ]);
      const [r1, r2] = orderToMasterRows(order, tripCounts);

      expect(r1.flightCount).toBe('7');
      expect(r2.flightCount).toBe('1');
      // 关键回归：同单两位乘客不再相同，也不再等于航段数
      expect(r1.flightCount).not.toBe(r2.flightCount);
      expect(r1.flightCount).not.toBe('2');
    });

    it('匹配不上档案的乘客（新客）→ 留空，不写 0', () => {
      const tripCounts: TripCountMap = new Map([[docKey('PASSPORT', 'E12345678'), 7]]);
      const [r1, r2] = orderToMasterRows(fixtureRoundTripBundle(), tripCounts);
      expect(r1.flightCount).toBe('7');
      expect(r2.flightCount).toBe(''); // 档案里没有 → 留空（0 会被读成"从没飞过"）
    });

    it('档案里 tripCount=0（已建档但去程都还没起飞）→ 如实写 0，与"匹配不上"区分', () => {
      const tripCounts: TripCountMap = new Map([[docKey('PASSPORT', 'E12345678'), 0]]);
      const [r1] = orderToMasterRows(fixtureRoundTripBundle(), tripCounts);
      expect(r1.flightCount).toBe('0');
    });

    it('证件号大小写/空格变体 → 仍按 docKey 归一命中（与档案聚合同款归一）', () => {
      const order = fixtureRoundTripBundle();
      (order.passengers[0] as { documentNumber: string }).documentNumber = ' e12345678 ';
      const tripCounts: TripCountMap = new Map([[docKey('PASSPORT', 'E12345678'), 7]]);
      const [r1] = orderToMasterRows(order, tripCounts);
      expect(r1.flightCount).toBe('7');
    });

    it('缺省 tripCounts（未传）→ 整列留空，绝不回落成航段数', () => {
      const [r1, r2] = orderToMasterRows(fixtureRoundTripBundle());
      expect(r1.flightCount).toBe('');
      expect(r2.flightCount).toBe('');
    });
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

  // ── 开票状态：改读三布尔，不再读旧字段 invoiceStatus（P2-15a）──────────────
  // 六态开票只写 outboundInvoiced/returnInvoiced/systemInvoiced，旧字段不再回写；
  // 旧实现读 order.invoiceStatus 会让已开票订单在这张表上恒显示"未开"。
  describe('开票状态：三布尔组合文案（P2-15a）', () => {
    it('去程已开 + 系统已开（回程未开）→ "去程已开/系统已开"，旧字段 invoiceStatus 不影响结果', () => {
      const order = fixtureRoundTripBundle();
      (order as unknown as { invoiceStatus: string }).invoiceStatus = 'ISSUED'; // 旧字段刻意给"已开"，验证不被读取
      (order as unknown as { outboundInvoiced: boolean }).outboundInvoiced = true;
      (order as unknown as { returnInvoiced: boolean }).returnInvoiced = false;
      (order as unknown as { systemInvoiced: boolean }).systemInvoiced = true;
      const [r1] = orderToMasterRows(order);
      expect(r1.invoiceStatus).toBe('去程已开/系统已开');
    });

    it('去程+回程都已开 → "去程已开/回程已开"（往返单，两段都判定为占额航段）', () => {
      const order = fixtureRoundTripBundle();
      (order as unknown as { outboundInvoiced: boolean }).outboundInvoiced = true;
      (order as unknown as { returnInvoiced: boolean }).returnInvoiced = true;
      const [r1] = orderToMasterRows(order);
      expect(r1.invoiceStatus).toBe('去程已开/回程已开');
    });

    it('单程订单：returnInvoiced=true 但无回程航段 → 不计入"回程已开"（与 full 模板同口径）', () => {
      const order = fixtureRoundTripBundle();
      (order.items as unknown[]).splice(1, 1); // 去掉回程段 → 单程
      (order as unknown as { outboundInvoiced: boolean }).outboundInvoiced = true;
      (order as unknown as { returnInvoiced: boolean }).returnInvoiced = true; // 脏数据：单程单不该有回程已开
      const [r1] = orderToMasterRows(order);
      expect(r1.invoiceStatus).toBe('去程已开');
    });

    it('三布尔全 false → "未开"', () => {
      const [r1] = orderToMasterRows(fixtureRoundTripBundle());
      expect(r1.invoiceStatus).toBe('未开');
    });
  });

  // ── 尾款含售后调整 adjustmentCny（P1-9 / P2-15b）──────────────────────────
  describe('尾款/是否清账含 adjustmentCny', () => {
    it('尾款 = max(0, total + adjustmentCny - paid) / 人数，不再漏掉改期费/换人费', () => {
      const order = fixtureRoundTripBundle();
      // total 10000 / paid 4000 / adjustment +800（如改期费）→ 应付 10800，尾款 6800/2人=3400
      (order as unknown as { adjustmentCny: number }).adjustmentCny = 800;
      const [r1] = orderToMasterRows(order);
      expect(r1.balanceDue).toBe(3400);
      expect(r1.settled).toBe('否');
    });

    it('paid 覆盖 total 但不覆盖 adjustmentCny → 仍未清账、尾款>0（此前会被误判"已清账"）', () => {
      const order = fixtureRoundTripBundle();
      (order as unknown as { paidAmount: number }).paidAmount = 10000; // 已付清基础价
      (order as unknown as { adjustmentCny: number }).adjustmentCny = 500; // 后加的换人费未付
      const [r1] = orderToMasterRows(order);
      expect(r1.balanceDue).toBe(250); // 500/2人
      expect(r1.settled).toBe('否');
    });

    it('adjustmentCny 为负（如减免）→ 应付相应减少，仍不产出负数尾款', () => {
      const order = fixtureRoundTripBundle();
      (order as unknown as { paidAmount: number }).paidAmount = 10000;
      (order as unknown as { adjustmentCny: number }).adjustmentCny = -2000; // 减免
      const [r1] = orderToMasterRows(order);
      expect(r1.balanceDue).toBe(0); // max(0, 10000-2000-10000)=0，不产出负数
      expect(r1.settled).toBe('是');
    });
  });

  // ── 尾款/是否清账含代理预付款抵扣 prepaymentOffset（与财务/提醒/报表口径一致）──────
  // 尾款 = max(0, total + adjustmentCny − paid − prepaymentOffset) / 人数；
  // 已清账 = paid + prepaymentOffset ≥ total + adjustmentCny。
  // 漏掉抵扣会让用预付款抵扣过的代理订单尾款偏大、已结清误显示未结清。
  describe('尾款/是否清账含 prepaymentOffset', () => {
    it('尾款扣减预付款抵扣（2 人均摊）', () => {
      const order = fixtureRoundTripBundle();
      // total 10000 / paid 4000 / offset 2000 → 应付余额 4000，尾款 4000/2人=2000
      (order as unknown as { prepaymentOffset: number }).prepaymentOffset = 2000;
      const [r1] = orderToMasterRows(order);
      expect(r1.balanceDue).toBe(2000);
      expect(r1.settled).toBe('否');
    });

    it('已付 + 预付款抵扣 ≥ 应付 → 尾款 0 且已清账', () => {
      const order = fixtureRoundTripBundle();
      // paid 8000 + offset 2000 = 10000 ≥ total 10000 → 已清账、尾款 0
      (order as unknown as { paidAmount: number }).paidAmount = 8000;
      (order as unknown as { prepaymentOffset: number }).prepaymentOffset = 2000;
      const [r1] = orderToMasterRows(order);
      expect(r1.balanceDue).toBe(0);
      expect(r1.settled).toBe('是');
    });

    it('售后调整与预付款抵扣同时生效（应付 = total + adjustment − paid − offset）', () => {
      const order = fixtureRoundTripBundle();
      // total 10000 + adjustment 800 − paid 4000 − offset 2000 = 4800 → /2人 = 2400
      (order as unknown as { adjustmentCny: number }).adjustmentCny = 800;
      (order as unknown as { prepaymentOffset: number }).prepaymentOffset = 2000;
      const [r1] = orderToMasterRows(order);
      expect(r1.balanceDue).toBe(2400);
      expect(r1.settled).toBe('否');
    });
  });
});

// ── 酒店中文名称跟房控实际数据（0722 财务反馈）────────────────────────────────
// 「酒店中文名称」列改乘客行级：优先该乘客分房组的实际酒店（房控人工排房结果，房控换过酒店
// 也照房控走），无分房组回退订单项酒店口径（录单时选的房型所属酒店，现状值），绝不留空。
describe('酒店中文名称跟房控实际数据（乘客行级）', () => {
  it('乘客有分房组 → 取房控分房组酒店（与订单项酒店不同也跟房控）；无分房组乘客回退订单项酒店', () => {
    const order = fixtureRoundTripBundle();
    // 房控把 p1 排到了「椰林湾度假村」；订单项酒店仍是录单时选的「明月酒店」
    (order as unknown as { roomAssignment: unknown }).roomAssignment = {
      roomGroups: [
        { id: 'g1', hotelName: '椰林湾度假村', roomType: '海景大床', passengerIds: ['p1'], notes: '蜜月' },
      ],
    };
    const [r1, r2] = orderToMasterRows(order);
    expect(r1.hotelName).toBe('椰林湾度假村'); // p1 跟房控
    expect(r2.hotelName).toBe('明月酒店'); // p2 无分房组 → 回退订单项酒店
  });

  it('乘客无任何分房记录 → 回退订单项酒店口径（保持现状，绝不留空）', () => {
    const order = fixtureRoundTripBundle();
    (order as unknown as { roomAssignment: unknown }).roomAssignment = null;
    const [r1, r2] = orderToMasterRows(order);
    expect(r1.hotelName).toBe('明月酒店');
    expect(r2.hotelName).toBe('明月酒店');
  });

  it('分房组酒店名为自由文本（房控手输）→ 原样使用不做匹配清洗', () => {
    const order = fixtureRoundTripBundle();
    (order as unknown as { roomAssignment: unknown }).roomAssignment = {
      roomGroups: [{ id: 'g1', hotelName: '岘港 A酒店(待定/换房中)', roomType: '', passengerIds: ['p1'] }],
    };
    const [r1] = orderToMasterRows(order);
    expect(r1.hotelName).toBe('岘港 A酒店(待定/换房中)');
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
    expect(headers).toContain('签证公司');
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

// ── 档案取数：一次查询 + mergedIntoId 指针跟随（B23）────────────────────────
// 合并过的档案 tripCount 累积在主档案上，指针行留的是合并前的残值 —— 直读源档案会少算。
describe('loadTripCountMap', () => {
  const REFRESHED = new Date('2026-07-15T03:00:00.000Z');

  /** 假 client：记录每次 findMany 的 where，按 OR 证件对 / id in 两种形态返回预置行。*/
  function fakeClient(rows: Record<string, unknown>[]) {
    const calls: Record<string, unknown>[] = [];
    const client = {
      travelerProfile: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          calls.push(where);
          if (Array.isArray(where.OR)) {
            const pairs = where.OR as { documentType: string; documentNumber: string }[];
            return rows.filter((r) =>
              pairs.some(
                (p) =>
                  p.documentType === r.documentType && p.documentNumber === r.documentNumber,
              ),
            );
          }
          const ids = (where.id as { in: string[] }).in;
          return rows.filter((r) => ids.includes(r.id as string));
        }),
      },
    };
    return { client, calls };
  }

  const profile = (over: Record<string, unknown>) => ({
    id: 'tp1',
    documentType: 'PASSPORT',
    documentNumber: 'E12345678',
    tripCount: 0,
    refreshedAt: REFRESHED,
    mergedIntoId: null,
    ...over,
  });

  it('canonical 档案：一条查询拉回全部乘客 → docKey → tripCount', async () => {
    const { client, calls } = fakeClient([
      profile({ id: 'tp1', documentNumber: 'E12345678', tripCount: 7 }),
      profile({ id: 'tp2', documentNumber: 'E87654321', tripCount: 1 }),
    ]);
    const { tripCounts, oldestRefreshedAt } = await loadTripCountMap(
      [
        { documentType: 'PASSPORT', documentNumber: 'E12345678' },
        { documentType: 'PASSPORT', documentNumber: 'E87654321' },
      ],
      client as never,
    );

    expect(tripCounts.get(docKey('PASSPORT', 'E12345678'))).toBe(7);
    expect(tripCounts.get(docKey('PASSPORT', 'E87654321'))).toBe(1);
    // 无 N+1：两位乘客只有一条查询（没有指针行 → 不需要补拉主档案）
    expect(calls).toHaveLength(1);
    expect(oldestRefreshedAt).toEqual(REFRESHED);
  });

  it('几百位乘客（含大量重复证件）仍只有一条查询，证件对去重后再查', async () => {
    const { client, calls } = fakeClient([
      profile({ id: 'tp1', documentNumber: 'E12345678', tripCount: 7 }),
    ]);
    const passengers = Array.from({ length: 300 }, () => ({
      documentType: 'PASSPORT' as const,
      documentNumber: 'E12345678',
    }));
    await loadTripCountMap(passengers, client as never);

    expect(calls).toHaveLength(1);
    expect((calls[0].OR as unknown[]).length).toBe(1); // 300 位 → 去重成 1 个证件对
  });

  it('命中指针行（客人报旧护照号）→ 跟 mergedIntoId 取主档案的 tripCount，不是残值', async () => {
    const { client, calls } = fakeClient([
      // 旧证：合并前只飞过 2 次的残值，且指向主档案
      profile({ id: 'tp-old', documentNumber: 'E00000001', tripCount: 2, mergedIntoId: 'tp-master' }),
      // 主档案：归一后的真实次数
      profile({ id: 'tp-master', documentNumber: 'E99999999', tripCount: 9 }),
    ]);
    const { tripCounts } = await loadTripCountMap(
      [{ documentType: 'PASSPORT', documentNumber: 'E00000001' }],
      client as never,
    );

    // 旧证件号这一行应拿到主档案的 9，而不是指针行残值 2
    expect(tripCounts.get(docKey('PASSPORT', 'E00000001'))).toBe(9);
    expect(calls).toHaveLength(2); // 一条查证件对 + 一条按 id 补拉主档案
  });

  it('合并链（脏数据：指针→指针→主）→ 跟到最终主档案', async () => {
    const { client } = fakeClient([
      profile({ id: 'tp-a', documentNumber: 'E00000001', tripCount: 1, mergedIntoId: 'tp-b' }),
      profile({ id: 'tp-b', documentNumber: 'E00000002', tripCount: 3, mergedIntoId: 'tp-c' }),
      profile({ id: 'tp-c', documentNumber: 'E00000003', tripCount: 9 }),
    ]);
    const { tripCounts } = await loadTripCountMap(
      [{ documentType: 'PASSPORT', documentNumber: 'E00000001' }],
      client as never,
    );
    expect(tripCounts.get(docKey('PASSPORT', 'E00000001'))).toBe(9);
  });

  it('环（脏数据：a→b→a）→ 停在当前行，不死循环', async () => {
    const { client } = fakeClient([
      profile({ id: 'tp-a', documentNumber: 'E00000001', tripCount: 4, mergedIntoId: 'tp-b' }),
      profile({ id: 'tp-b', documentNumber: 'E00000002', tripCount: 5, mergedIntoId: 'tp-a' }),
    ]);
    const { tripCounts } = await loadTripCountMap(
      [{ documentType: 'PASSPORT', documentNumber: 'E00000001' }],
      client as never,
    );
    // 不抛错、不挂起；取到环上停下那一行的值（脏数据只影响这一条）
    expect(tripCounts.get(docKey('PASSPORT', 'E00000001'))).toBe(5);
  });

  it('断链（主档案已被删）→ 用指针行残值兜底，不抛错', async () => {
    const { client } = fakeClient([
      profile({ id: 'tp-old', documentNumber: 'E00000001', tripCount: 2, mergedIntoId: 'gone' }),
    ]);
    const { tripCounts } = await loadTripCountMap(
      [{ documentType: 'PASSPORT', documentNumber: 'E00000001' }],
      client as never,
    );
    expect(tripCounts.get(docKey('PASSPORT', 'E00000001'))).toBe(2);
  });

  it('乘客证件号缺失 / 一位乘客都没有 → 不查库，返回空 Map', async () => {
    const { client, calls } = fakeClient([]);
    const a = await loadTripCountMap([], client as never);
    const b = await loadTripCountMap(
      [{ documentType: 'PASSPORT', documentNumber: '' }],
      client as never,
    );
    expect(a.tripCounts.size).toBe(0);
    expect(b.tripCounts.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('快照新鲜度：取用到的档案里最旧的一条 refreshedAt（表头批注标出这列有多旧）', async () => {
    const older = new Date('2026-07-01T00:00:00.000Z');
    const { client } = fakeClient([
      profile({ id: 'tp1', documentNumber: 'E12345678', tripCount: 7, refreshedAt: REFRESHED }),
      profile({ id: 'tp2', documentNumber: 'E87654321', tripCount: 1, refreshedAt: older }),
    ]);
    const { oldestRefreshedAt } = await loadTripCountMap(
      [
        { documentType: 'PASSPORT', documentNumber: 'E12345678' },
        { documentType: 'PASSPORT', documentNumber: 'E87654321' },
      ],
      client as never,
    );
    expect(oldestRefreshedAt).toEqual(older);
  });
});

describe('masterExportFilename', () => {
  it('区间 / 单缺省两种文件名', () => {
    expect(masterExportFilename('2026-07-01', '2026-07-31')).toBe('全岗总表_2026-07-01_2026-07-31.xlsx');
    expect(masterExportFilename('2026-07-10')).toBe('全岗总表_2026-07-10_2026-07-10.xlsx');
    expect(masterExportFilename()).toBe('全岗总表_全部_全部.xlsx');
  });
});

// ── 出发日期精确细筛（0722 财务反馈）──────────────────────────────────────────
// 共享 helper（全岗总表 / 三模板共用）：取回内存后按整单「出发日」（列表列同口径）二次过滤，
// 把取数 where 宽召回带进来的「返程日 / ±1 天邻日在窗口内、但整单出发日不在区间」的单剔除。
describe('filterExportOrdersByDepartDate（出发日精确细筛）', () => {
  const flight = (departISO: string) => ({
    kind: 'FLIGHT',
    flightSchedule: { departureTime: new Date(departISO) },
    hotelCheckIn: null,
  });
  const hotel = (checkIn: string) => ({
    kind: 'HOTEL',
    flightSchedule: null,
    hotelCheckIn: new Date(`${checkIn}T00:00:00.000Z`),
  });
  const mkOrder = (id: string, items: unknown[]) => ({ id, items });

  it('去程 21 号、返程 22 号的往返单 → 按 22 号导出时被排除（整单出发日=21）', () => {
    const orders = [
      mkOrder('roundtrip-21-22', [
        flight('2026-07-21T02:00:00.000Z'),
        flight('2026-07-22T05:00:00.000Z'),
      ]),
      mkOrder('depart-22', [flight('2026-07-22T09:00:00.000Z')]),
    ];
    const kept = filterExportOrdersByDepartDate(orders, '2026-07-22', '2026-07-22');
    expect(kept.map((o) => o.id)).toEqual(['depart-22']);
  });

  it('22 号 00:xx 出发（+8 当地时刻按 UTC 分量存）→ 归入 22 号，不漏', () => {
    const orders = [mkOrder('early-22', [flight('2026-07-22T00:30:00.000Z')])];
    const kept = filterExportOrdersByDepartDate(orders, '2026-07-22', '2026-07-22');
    expect(kept.map((o) => o.id)).toEqual(['early-22']);
  });

  it('无航班的酒店单 → 按最早入住日归日（22 号入住命中、21 号入住排除）', () => {
    const orders = [
      mkOrder('hotel-in-22', [hotel('2026-07-22')]),
      mkOrder('hotel-in-21', [hotel('2026-07-21')]),
    ];
    const kept = filterExportOrdersByDepartDate(orders, '2026-07-22', '2026-07-22');
    expect(kept.map((o) => o.id)).toEqual(['hotel-in-22']);
  });

  it('纯签证单（既无航班也无入住日）→ 无出发日，带出发区间导出时维持现状口径被排除', () => {
    const orders = [
      mkOrder('visa-only', [{ kind: 'VISA', flightSchedule: null, hotelCheckIn: null }]),
      mkOrder('depart-22', [flight('2026-07-22T09:00:00.000Z')]),
    ];
    const kept = filterExportOrdersByDepartDate(orders, '2026-07-22', '2026-07-22');
    expect(kept.map((o) => o.id)).toEqual(['depart-22']);
  });

  it('未给 travelFrom/travelTo（如勾选/整班导出）→ 原样放行，不过滤', () => {
    const orders = [
      mkOrder('a', [flight('2026-07-21T02:00:00.000Z')]),
      mkOrder('b', [{ kind: 'VISA', flightSchedule: null, hotelCheckIn: null }]),
    ];
    const kept = filterExportOrdersByDepartDate(orders, undefined, undefined);
    expect(kept.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('开区间：只给 travelFrom（含起点及之后）', () => {
    const orders = [
      mkOrder('d20', [flight('2026-07-20T02:00:00.000Z')]),
      mkOrder('d22', [flight('2026-07-22T02:00:00.000Z')]),
    ];
    const kept = filterExportOrdersByDepartDate(orders, '2026-07-21', undefined);
    expect(kept.map((o) => o.id)).toEqual(['d22']);
  });
});
