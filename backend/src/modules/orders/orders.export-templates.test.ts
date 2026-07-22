/**
 * 三模板筛选导出 · 单元测试（vitest）
 *
 * 只测纯映射：orderToFullRows / orderToTicketingRows / buildOrderContext + 列定义，
 * 逐列对齐现用模版（《全岗可用》53 列、《票务专用》27 列）：
 *   - 列名列序与旧模版一致
 *   - 日期格式：生日/签发/有效 = DD-MM-YYYY；录入时间含秒；DOB(PNR) = DDMonYY
 *   - 姓名斜线拼接；乘客类型/性别/证件类型按旧模版原样枚举/代码
 *   - Passport Issue Country 列填「签发地」文本（旧模版口径），非 ISO 码
 *   - 系统暂无数据的列一律留空（绝不编造）
 */
import { describe, it, expect, vi } from 'vitest';

// 模块链路（orders.export-templates → orders.service）顶层引用 prisma —— mock 掉
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';
import {
  orderToFullRows,
  orderToTicketingRows,
  orderToVisaRows,
  buildOrderContext,
  buildOrderTemplateExportWorkbook,
  pnrName,
  nameWithTitle,
  FULL_COLUMNS,
  TICKETING_COLUMNS,
  type OrderForTemplateExport,
} from './orders.export-templates.js';

const D = (s: string): Date => new Date(s.length <= 10 ? `${s}T00:00:00.000Z` : `${s}Z`);

/**
 * 《全岗可用》模版 54 列表头（叶子列；末尾三列并入「订单成本」分组）。
 * 定金组四列已移除：系统无定金模型，四列恒空，且现行模版本身已删除该组。
 * 「纯拼音名」为旧模版之外新增：无 MR/MS 称谓的 LAST/FIRST，财务对数/名单匹配用。
 */
const FULL_HEADERS = [
  '序号', '是否是原订单', '代理机构', '备注', '酒店类型', '中文名称', '乘客姓名',
  '纯拼音名', '飞行次数', '出发(往返)日期', '航班号', '订单类型',
  '结算价格', '结算价到账金额', '结算价到账时间',
  '结算价到账渠道', '尾款金额', '单房差', '单房差到账金额', '签证金额', '签证到账金额',
  '抵扣金额', '抵扣到账金额', '抵扣人员', '抵扣订单', '是否清账', '退款金额', '退款时间',
  '退款渠道', '系统开票状态', '开票状态', '签证状态', '签证选项', '签证备注', '护照签发地',
  '出生地', '订单编号', '舱位等级', '乘客生日', '乘客类型', '分销状态', '性别', '国籍',
  '证件类型', '证件编号', '签发日期', '有效日期', '婴儿随行成员', '录入时间', '录入人员',
  '临时', '成本类型', '子类型', '金额',
];

/** 旧《票务专用》模版 27 列表头 = 代理 + 备注 + 航司 PNR 25 列。*/
const OLD_TICKETING_HEADERS = [
  '代理', '备注', 'Last Name', 'First Name and Middle Name', 'Title', 'PTC', 'Gender',
  'Date of Birth', 'Passport Last Name', 'Passport First Name', 'Passport Number',
  'Passport Nationality', 'Passport Issue Country', 'Passport Expiry Date', 'Visa Number',
  'Visa Type', 'Visa Issue Date', 'Place of Birth', 'Visa Place of Issue',
  'Visa Country of Application', 'Visa Expiry Date', 'Address Type', 'Address Country',
  'Address Details', 'Address City', 'Address State', 'Address Zip Code',
];

/**
 * 一张往返套餐订单 fixture（对标旧模版首行样例）：
 *   - 两段航班（往返 → 订单类型「往返票」，航班号 ⇌ 连接）
 *   - 酒店行 + 签证行（履约任务处理中）
 *   - 2 位乘客：王连波（签发地/中文名/护照签发日齐全）、李四（无签发地→回落颁发国、无中文名→回落 fullName）
 *   - total 2536 / paid 0 → 人均结算 1268、尾款 1268
 *   - createdAt 含时分秒 → 录入时间应保留秒
 */
function fixtureRoundTrip(): OrderForTemplateExport {
  return {
    id: 'o1',
    orderNumber: 'ACOAZR',
    status: 'PAID',
    invoiceStatus: 'NONE',
    total: 2536,
    paidAmount: 0,
    prepaymentOffset: 0,
    notes: '3人一间 三床房，市区四星 自备签证',
    noteHotel: null,
    noteVisa: null,
    notePayment: null,
    noteSpecial: null,
    contactName: '王连波',
    contactPhone: '13800000000',
    guestName: null,
    createdAt: D('2026-07-08T15:17:21.000'),
    roomAssignment: null,
    agent: { companyName: '世途3' },
    user: { displayName: 'citur011', email: 'op@ftm.local' },
    payments: [],
    refunds: [],
    passengers: [
      {
        id: 'p1',
        fullName: '王连波',
        chineseName: '王连波',
        lastName: 'WANG',
        firstName: 'LIANBO',
        title: 'MR',
        gender: 'M',
        dateOfBirth: D('1984-02-04'),
        passengerType: 'ADULT',
        nationality: 'CN',
        documentType: 'PASSPORT',
        documentNumber: 'EN7208993',
        passportIssueDate: D('2024-12-12'),
        passportIssuePlace: '河北',
        passportIssueCountry: 'CN',
        passportExpiry: D('2034-12-11'),
        placeOfBirth: '河北',
        visaNumber: null,
        visaType: null,
        visaIssueDate: null,
        visaPlaceOfIssue: null,
        visaCountryOfApplication: null,
        visaExpiry: null,
        addressType: null,
        addressCountry: null,
        addressDetails: null,
        addressCity: null,
        addressState: null,
        addressZip: null,
      },
      {
        id: 'p2',
        fullName: '李四',
        chineseName: null, // 无中文名 → 回落 fullName
        lastName: null,
        firstName: null,
        title: null,
        gender: 'F',
        // 去程 2026-07-13 时实足 7 岁 → PTC 按年龄推算 = CHD，与录入 passengerType 口径一致。
        dateOfBirth: D('2019-06-15'),
        passengerType: 'CHILD',
        nationality: 'CN',
        documentType: 'PASSPORT',
        documentNumber: 'E87654321',
        passportIssueDate: null,
        passportIssuePlace: null, // 无签发地 → 回落颁发国
        passportIssueCountry: 'CN',
        passportExpiry: null,
        placeOfBirth: null,
        visaNumber: null,
        visaType: null,
        visaIssueDate: null,
        visaPlaceOfIssue: null,
        visaCountryOfApplication: null,
        visaExpiry: null,
        addressType: null,
        addressCountry: null,
        addressDetails: null,
        addressCity: null,
        addressState: null,
        addressZip: null,
      },
    ],
    items: [
      {
        kind: 'FLIGHT',
        flightCabin: 'ECONOMY',
        amount: 0,
        description: '',
        metadata: null,
        hotelRoomTypeId: null,
        flightSchedule: {
          departureTime: D('2026-07-13'),
          flight: { flightNumber: 'QH9589', originCode: 'CTU', destinationCode: 'DAD' },
        },
        hotelRoomType: null,
        visa: null,
        transfer: null,
        bundle: null,
        fulfillmentTasks: [],
      },
      {
        kind: 'FLIGHT',
        flightCabin: 'ECONOMY',
        amount: 0,
        description: '',
        metadata: null,
        hotelRoomTypeId: null,
        flightSchedule: {
          departureTime: D('2026-07-14'),
          flight: { flightNumber: 'QH9588', originCode: 'DAD', destinationCode: 'CTU' },
        },
        hotelRoomType: null,
        visa: null,
        transfer: null,
        bundle: null,
        fulfillmentTasks: [],
      },
      {
        kind: 'HOTEL',
        flightCabin: null,
        amount: 0,
        description: '',
        metadata: null,
        hotelRoomTypeId: 'hrt1',
        flightSchedule: null,
        hotelRoomType: { name: '三床房', hotel: { name: '岘港四星', code: 'DN4' } },
        visa: null,
        transfer: null,
        bundle: null,
        fulfillmentTasks: [],
      },
      {
        kind: 'VISA',
        flightCabin: null,
        amount: 500,
        description: '越南电子签',
        metadata: null,
        hotelRoomTypeId: null,
        flightSchedule: null,
        hotelRoomType: null,
        visa: { code: 'VN-EVISA', visaName: '越南电子签', visaType: 'E-visa' },
        transfer: null,
        bundle: null,
        fulfillmentTasks: [{ type: 'VISA_APPLICATION', status: 'IN_PROGRESS' }],
      },
    ],
  } as unknown as OrderForTemplateExport;
}

describe('《全岗可用》full 模版 — 列定义对齐 54 列', () => {
  it('FULL_COLUMNS 列名列序与模版 54 列完全一致', () => {
    expect(FULL_COLUMNS.map((c) => c.header)).toEqual(FULL_HEADERS);
  });

  it('不输出定金组列（系统无定金模型，现行模版已删该组）', () => {
    expect(FULL_COLUMNS.map((c) => c.header).filter((h) => h.startsWith('定金'))).toEqual([]);
  });
});

describe('《全岗可用》full 模版 — 逐列取值/格式', () => {
  const order = fixtureRoundTrip();
  const ctx = buildOrderContext(order);
  const rows = orderToFullRows(order, ctx);
  const [r1, r2] = rows;

  it('一行/乘客', () => {
    expect(rows).toHaveLength(2);
  });

  it('中文名称：优先 chineseName，缺省回落 fullName', () => {
    expect(r1.chineseName).toBe('王连波');
    expect(r2.chineseName).toBe('李四');
  });

  it('乘客姓名：LAST/FIRST 斜线拼接，缺省回落 fullName；末尾附称谓（0711 反馈缺 MR/MS）', () => {
    // r1 成人男性（按出发日实足 42 岁）→ MR；r2 按出发日实足 7 岁 = 儿童、性别 F → MISS。
    expect(r1.passengerName).toBe('WANG/LIANBO MR');
    expect(r2.passengerName).toBe('李四 MISS');
  });

  it('纯拼音名：LAST/FIRST 不带称谓（财务对数用，0720 公测反馈 MR/MS 影响匹配）', () => {
    expect(r1.cleanName).toBe('WANG/LIANBO');
    expect(r2.cleanName).toBe('李四');
  });

  it('出发(往返)日期 / 航班号 / 订单类型：往返票口径', () => {
    expect(r1.travelDates).toBe('2026-07-13 / 2026-07-14');
    expect(r1.flightNumbers).toBe('QH9589 ⇌ QH9588');
    expect(r1.orderType).toBe('往返票');
  });

  it('日期格式：生日/签发/有效 = DD-MM-YYYY', () => {
    expect(r1.dateOfBirth).toBe('04-02-1984');
    expect(r1.issueDate).toBe('12-12-2024');
    expect(r1.expiryDate).toBe('11-12-2034');
  });

  it('缺省日期 → 留空（不编造）', () => {
    expect(r2.issueDate).toBe('');
    expect(r2.expiryDate).toBe('');
  });

  it('录入时间：YYYY-MM-DD HH:MM:SS（含秒）', () => {
    expect(r1.recordedAt).toBe('2026-07-08 15:17:21');
  });

  it('乘客类型/性别/证件类型：按旧模版原样枚举/代码', () => {
    expect(r1.passengerType).toBe('ADULT');
    expect(r2.passengerType).toBe('CHILD');
    expect(r1.gender).toBe('M');
    expect(r2.gender).toBe('F');
    expect(r1.documentType).toBe('P');
  });

  it('国籍：ISO alpha-3', () => {
    expect(r1.nationality).toBe('CHN');
  });

  it('护照签发地：优先 passportIssuePlace，缺省回落颁发国', () => {
    expect(r1.passportIssuePlace).toBe('河北');
    expect(r2.passportIssuePlace).toBe('CN');
  });

  it('金额均摊到人（结算/尾款）', () => {
    expect(r1.settlePrice).toBe(1268);
    expect(r1.balanceDue).toBe(1268);
  });

  it('系统暂无数据的列一律留空（绝不编造）', () => {
    for (const r of rows) {
      expect(r.isOriginalOrder).toBe('');
      expect(r.flightCount).toBe('');
      expect(r.singleRoomDiff).toBe('');
      expect(r.offsetPerson).toBe('');
      expect(r.offsetOrder).toBe('');
      expect(r.refundChannel).toBe('');
      expect(r.invoiceStatusManual).toBe('');
      expect(r.visaNote).toBe(''); // 本 fixture noteVisa=null → 留空（有值时填真值，见下）
      expect(r.distribution).toBe('');
      expect(r.infantWith).toBe('');
      expect(r.temp).toBe('');
      expect(r.costType).toBe('');
      expect(r.costSubType).toBe('');
      expect(r.costAmount).toBe('');
    }
  });

  it('签证状态/选项：填真值', () => {
    expect(r1.visaStatus).toBe('处理中');
    expect(r1.visaOption).toBe('越南电子签');
  });
});

// ── 套餐(BUNDLE)单：酒店/签证信息不再整列空白（0720 公测反馈）────────────────
// 套餐把房型盖在 BUNDLE 行上、签证任务也挂在 BUNDLE 行上、签证组件名在套餐定义
// items JSON 里 —— 修复前只认 kind==='HOTEL'/'VISA' 行，套餐单三列全空。
describe('《全岗可用》full 模版 — 套餐单酒店/签证/备注取值', () => {
  function fixtureBundle(): OrderForTemplateExport {
    const order = fixtureRoundTrip();
    const o = order as unknown as {
      visaStatus: string | null;
      noteVisa: string | null;
      items: unknown[];
    };
    o.noteVisa = '自备签，随团免签名单已交';
    o.visaStatus = null; // 订单级缺省 → 回落 BUNDLE 行任务状态
    // 只留两段航班 + 一个 BUNDLE 行（无独立 HOTEL/VISA 行）
    o.items = [
      ...order.items.filter((it) => it.kind === 'FLIGHT'),
      {
        kind: 'BUNDLE',
        flightCabin: null,
        amount: 3000,
        description: '岘港3天2晚随机 · 回程（经济舱）',
        metadata: null,
        hotelRoomTypeId: 'hrt9',
        flightSchedule: null,
        hotelRoomType: { name: '高级双床', hotel: { name: '岘港五星', code: 'DN5' } },
        visa: null,
        transfer: null,
        bundle: {
          code: 'BND1',
          items: [
            { kind: 'HOTEL', productName: '岘港五星', qty: 1, unitPrice: 800 },
            { kind: 'VISA', productName: '越南电子签(套餐)', qty: 2, unitPrice: 250 },
          ],
        },
        fulfillmentTasks: [{ type: 'VISA_APPLICATION', status: 'IN_PROGRESS' }],
      },
    ];
    return order;
  }

  const order = fixtureBundle();
  const [r1] = orderToFullRows(order, buildOrderContext(order));

  it('酒店类型：BUNDLE 行上的房型也算（酒店名 + 房型名）', () => {
    expect(r1.hotelInfo).toBe('岘港五星 高级双床');
  });

  it('签证状态：回落 BUNDLE 行上的签证履约任务', () => {
    expect(r1.visaStatus).toBe('处理中');
  });

  it('签证选项：取套餐定义里的签证组件名', () => {
    expect(r1.visaOption).toBe('越南电子签(套餐)');
  });

  it('签证备注：填订单「签证备注」结构化栏', () => {
    expect(r1.visaNote).toBe('自备签，随团免签名单已交');
  });

  it('订单级签证状态优先于履约任务（与全岗总表同口径）', () => {
    const o2 = fixtureBundle();
    (o2 as unknown as { visaStatus: string }).visaStatus = 'E_VISA';
    const [row] = orderToFullRows(o2, buildOrderContext(o2));
    expect(row.visaStatus).toBe('电子签');
  });
});

// ── 代理预付款抵扣（prepaymentOffset）· 尾款/清账口径 ──────────────────────────
// 尾款 = max(0, total + adjustmentCny − paid − prepaymentOffset) / 人数；
// 已清账 = paid + prepaymentOffset ≥ total + adjustmentCny。与财务/提醒/报表口径一致，
// 避免用预付款抵扣过的代理订单尾款偏大、已结清误显示未结清。
describe('《全岗可用》full 模版 — 代理预付款抵扣（prepaymentOffset）', () => {
  function fixtureWithOffset(over: {
    total?: number;
    paidAmount?: number;
    prepaymentOffset?: number;
    adjustmentCny?: number;
  }): OrderForTemplateExport {
    const order = fixtureRoundTrip();
    Object.assign(order as Record<string, unknown>, {
      total: over.total ?? 2536,
      paidAmount: over.paidAmount ?? 0,
      prepaymentOffset: over.prepaymentOffset ?? 0,
      adjustmentCny: over.adjustmentCny ?? 0,
    });
    return order;
  }

  it('尾款扣减预付款抵扣（2 人均摊）', () => {
    // total 2536 − paid 1000 − offset 500 = 1036 → /2人 = 518
    const order = fixtureWithOffset({ paidAmount: 1000, prepaymentOffset: 500 });
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows[0].balanceDue).toBe(518);
    expect(rows[0].settled).toBe('否');
  });

  it('已付 + 预付款抵扣 ≥ 应付 → 尾款 0 且已清账', () => {
    // paid 2036 + offset 500 = 2536 ≥ total 2536 → 已清账、尾款 0
    const order = fixtureWithOffset({ paidAmount: 2036, prepaymentOffset: 500 });
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows[0].balanceDue).toBe(0);
    expect(rows[0].settled).toBe('是');
  });

  it('抵扣金额列人均摊（offsetAmount）', () => {
    const order = fixtureWithOffset({ prepaymentOffset: 500 });
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows[0].offsetAmount).toBe(250); // 500 / 2人
  });
});

describe('《票务专用》ticketing 模版 — 27 列 + 格式', () => {
  it('TICKETING_COLUMNS 列名列序与旧模版 27 列完全一致', () => {
    expect(TICKETING_COLUMNS.map((c) => c.header)).toEqual(OLD_TICKETING_HEADERS);
  });

  const order = fixtureRoundTrip();
  const ctx = buildOrderContext(order);
  const rows = orderToTicketingRows(order, ctx);
  const [r1, r2] = rows;

  it('Title/PTC/Gender：MR / ADT / M（CHD 儿童）', () => {
    expect(r1.title).toBe('MR');
    expect(r1.ptc).toBe('ADT');
    expect(r1.gender).toBe('M');
    expect(r2.ptc).toBe('CHD');
  });

  it('PTC 按订单去程（最早 FLIGHT 行出发时间）自动推算，联动 Title：儿童缺 Title 按性别给 MISS', () => {
    // 订单去程 = 2026-07-13（fixtureRoundTrip 两段航班中较早一段），r2 生日 2019-06-15 → 实足 7 岁 = CHD。
    expect(r2.title).toBe('MISS');
  });

  it('Date of Birth / Passport Expiry：DDMonYY 航司格式', () => {
    expect(r1.dob).toBe('04Feb84');
    expect(r1.passportExpiry).toBe('11Dec34');
  });

  it('Passport Issue Country 列 = 签发地文本（非 ISO 码），缺省留空', () => {
    expect(r1.passportIssueCountry).toBe('河北');
    expect(r2.passportIssueCountry).toBe('');
  });

  it('Passport Nationality 列 = ISO alpha-3', () => {
    expect(r1.passportNationality).toBe('CHN');
  });

  it('姓名大写拆分', () => {
    expect(r1.lastName).toBe('WANG');
    expect(r1.firstName).toBe('LIANBO');
  });
});

// ── pnrName · 护照逗号剥离 ─────────────────────────────────────────────────
// 源 fullName "WEI, HAIYANG" 按空白拆名会把逗号留在姓里（"WEI," / "HAIYANG"），
// pnrName 必须剥离逗号+空白再拼，不得产出 "WEI,/HAIYANG"。fullName 回退分支同样规范逗号。
describe('pnrName — 护照逗号剥离', () => {
  it('lastName/firstName 拆分：正常 → LAST/FIRST 大写', () => {
    expect(pnrName({ lastName: 'WANG', firstName: 'LIANBO', fullName: 'x' })).toBe('WANG/LIANBO');
  });

  it('拆分字段残留逗号/空白 → 剥离后再拼（不产出 "WEI,/HAIYANG"）', () => {
    expect(pnrName({ lastName: 'WEI,', firstName: 'HAIYANG', fullName: 'x' })).toBe('WEI/HAIYANG');
    expect(pnrName({ lastName: ' WEI , ', firstName: ' HAIYANG ', fullName: 'x' })).toBe('WEI/HAIYANG');
  });

  it('fullName 回退：护照逗号格式 "WEI, HAIYANG" → "WEI/HAIYANG"', () => {
    expect(pnrName({ lastName: null, firstName: null, fullName: 'WEI, HAIYANG' })).toBe('WEI/HAIYANG');
  });

  it('fullName 回退：中文名无逗号 → 原样返回', () => {
    expect(pnrName({ lastName: null, firstName: null, fullName: '李四' })).toBe('李四');
  });
});

// ── nameWithTitle — 姓名 + 称谓（0711 反馈「订单导出缺 MR/MS」）───────────────
// 口径：成人（按出发日实足年龄 ≥12 或无生日数据）M→MR / F→MS；
// 儿童（2–<12）/ 婴儿（<2）M→MSTR / F→MISS；性别 X/未知 → 不加称谓；已有手录 title 优先。
describe('nameWithTitle — 姓名 + 称谓', () => {
  const depart = D('2026-07-13'); // 参照订单去程日

  it('成人男性 → 姓名后加 " MR"', () => {
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'M', dateOfBirth: D('1990-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MR');
  });

  it('成人女性 → 姓名后加 " MS"', () => {
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'F', dateOfBirth: D('1990-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MS');
  });

  it('儿童（2–<12 岁）男性 → 姓名后加 " MSTR"', () => {
    // 出发日 2026-07-13 − 生日 2018-01-01 → 实足 8 岁 = 儿童
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'M', dateOfBirth: D('2018-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MSTR');
  });

  it('儿童女性 → 姓名后加 " MISS"', () => {
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'F', dateOfBirth: D('2018-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MISS');
  });

  it('婴儿（<2 岁）男性 → 姓名后加 " MSTR"（同儿童规则）', () => {
    // 出发日 2026-07-13 − 生日 2025-01-01 → 实足 1 岁 = 婴儿
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'M', dateOfBirth: D('2025-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MSTR');
  });

  it('婴儿女性 → 姓名后加 " MISS"（同儿童规则）', () => {
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'F', dateOfBirth: D('2025-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MISS');
  });

  it('性别未知（X）→ 不加称谓，原样返回 pnrName 结果（无尾随空格）', () => {
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'X', dateOfBirth: D('1990-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI');
  });

  it('性别缺失（null）→ 不加称谓', () => {
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: null, dateOfBirth: D('1990-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI');
  });

  it('无生日数据 → 按成人处理（不受未传 passengerType 影响），男性仍给 MR', () => {
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'M', dateOfBirth: null };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MR');
  });

  it('已有手录 title → 优先直接用（原样大写），不再按年龄/性别派生', () => {
    // 生日按年龄本应派生为儿童 MSTR，但手录 title 优先生效。
    const p = {
      lastName: 'ZHAO',
      firstName: 'WEI',
      fullName: 'x',
      title: 'mrs',
      gender: 'M',
      dateOfBirth: D('2018-01-01'),
    };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MRS');
  });

  it('未传出发日 → 按当前日期近似估算年龄（老生日仍稳定判成人，不受测试运行时间影响）', () => {
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'M', dateOfBirth: D('1950-01-01') };
    expect(nameWithTitle(p)).toBe('ZHAO/WEI MR');
  });
});

// ── 《签证专用》visa 行 · 中文姓名取值 ──────────────────────────────────────
// 「中文姓名」列须优先 chineseName（缺失才回落 fullName），与《全岗可用》口径一致，
// 避免中文名列显示成英文名。
describe('《签证专用》visa 行 — 中文姓名取值', () => {
  const order = fixtureRoundTrip();
  const ctx = buildOrderContext(order);
  const rows = orderToVisaRows(order, ctx);

  it('优先 chineseName，缺省回落 fullName', () => {
    expect(rows[0].chineseName).toBe('王连波');
    expect(rows[1].chineseName).toBe('李四');
  });
});

// ── 《签证专用》visa 行 · 签发日期 ──────────────────────────────────────────
// 曾经硬编码 issueDate:''，签证名单「签发日期」列永远空白；现改接
// Passenger.passportIssueDate（同「有效日期」列口径，dd-mm-yyyy，缺省留空）。
describe('《签证专用》visa 行 — 签发日期', () => {
  const order = fixtureRoundTrip();
  const ctx = buildOrderContext(order);
  const rows = orderToVisaRows(order, ctx);

  it('有 passportIssueDate → DD-MM-YYYY', () => {
    expect(rows[0].issueDate).toBe('12-12-2024');
  });

  it('缺省 passportIssueDate → 留空（不编造）', () => {
    expect(rows[1].issueDate).toBe('');
  });
});

// ── 生日可空（换人清除后 dateOfBirth=null）→ 导出留空不 crash ────────────────
// Passenger.dateOfBirth 已改为可空；换人未提供新生日时后端置 null。导出（全岗/票务）
// 遇到 null 生日必须落空串（绝不编造、绝不抛错）。
describe('导出 · 生日为空（dateOfBirth=null）', () => {
  function fixtureNullDob(): OrderForTemplateExport {
    const order = fixtureRoundTrip();
    // 第一位乘客换人后无生日
    (order.passengers[0] as { dateOfBirth: Date | null }).dateOfBirth = null;
    return order;
  }

  it('《全岗可用》：null 生日 → 「乘客生日」列留空，不抛错', () => {
    const order = fixtureNullDob();
    const ctx = buildOrderContext(order);
    const rows = orderToFullRows(order, ctx);
    expect(rows[0].dateOfBirth).toBe('');
    // 其余乘客仍正常
    expect(rows[1].dateOfBirth).toBe('15-06-2019');
  });

  it('《票务专用》：null 生日 → DOB(PNR) 列留空，不抛错', () => {
    const order = fixtureNullDob();
    const ctx = buildOrderContext(order);
    const rows = orderToTicketingRows(order, ctx);
    expect(rows[0].dob).toBe('');
    expect(rows[1].dob).toBe('15Jun19');
  });
});

// ── 出发日期精确细筛在 buildOrderTemplateExportWorkbook 生效（0722 财务反馈）─────────
// fixtureRoundTrip：去程 2026-07-13、返程 2026-07-14 → 整单出发日 = 07-13。
// 取数 where 宽召回会把它带进「07-14」的窗口（返程段命中），导出层须按整单出发日剔除。
describe('buildOrderTemplateExportWorkbook 出发日精确细筛', () => {
  function fakeClient(orders: OrderForTemplateExport[]): PrismaClient {
    return { order: { findMany: vi.fn().mockResolvedValue(orders) } } as unknown as PrismaClient;
  }

  /** 加载 xlsx，返回指定 sheet 的数据行数（扣除表头）。*/
  async function dataRowCount(buf: Buffer, sheetName: string): Promise<number> {
    const wb = new ExcelJS.Workbook();
    // ExcelJS 的 xlsx.load 形参用旧版 Buffer 类型，与新版 @types/node 的 Buffer<ArrayBufferLike>
    // 泛型不完全兼容（仅类型层，运行时无碍；仓库其它测试同款）——按其形参类型收敛，避免 tsc 噪声。
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.getWorksheet(sheetName);
    return ws ? Math.max(0, ws.actualRowCount - 1) : 0;
  }

  it('按返程日 07-14 导出 → 整单出发日 07-13 的往返单被剔除（0 数据行）', async () => {
    const buf = await buildOrderTemplateExportWorkbook(
      { template: 'visa', travelFrom: '2026-07-14', travelTo: '2026-07-14' } as Parameters<
        typeof buildOrderTemplateExportWorkbook
      >[0],
      fakeClient([fixtureRoundTrip()]),
    );
    expect(await dataRowCount(buf, '签证专用')).toBe(0);
  });

  it('按出发日 07-13 导出 → 该往返单保留（2 位乘客 = 2 数据行）', async () => {
    const buf = await buildOrderTemplateExportWorkbook(
      { template: 'visa', travelFrom: '2026-07-13', travelTo: '2026-07-13' } as Parameters<
        typeof buildOrderTemplateExportWorkbook
      >[0],
      fakeClient([fixtureRoundTrip()]),
    );
    expect(await dataRowCount(buf, '签证专用')).toBe(2);
  });

  it('scheduleId（整班·全岗精确导出）→ 不做出发日细筛，原样保留', async () => {
    const buf = await buildOrderTemplateExportWorkbook(
      {
        template: 'visa',
        scheduleId: 'fs-out',
        travelFrom: '2026-07-14',
        travelTo: '2026-07-14',
      } as Parameters<typeof buildOrderTemplateExportWorkbook>[0],
      fakeClient([fixtureRoundTrip()]),
    );
    expect(await dataRowCount(buf, '签证专用')).toBe(2);
  });
});
