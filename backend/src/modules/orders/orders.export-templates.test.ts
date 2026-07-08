/**
 * 三模板筛选导出 · 单元测试（vitest）
 *
 * 只测纯映射：orderToFullRows / orderToTicketingRows / buildOrderContext + 列定义，
 * 逐列对齐旧系统模版（《全岗可用》57 列、《票务专用》27 列）：
 *   - 列名列序与旧模版一致
 *   - 日期格式：生日/签发/有效 = DD-MM-YYYY；录入时间含秒；DOB(PNR) = DDMonYY
 *   - 姓名斜线拼接；乘客类型/性别/证件类型按旧模版原样枚举/代码
 *   - Passport Issue Country 列填「签发地」文本（旧模版口径），非 ISO 码
 *   - 系统暂无数据的列一律留空（绝不编造）
 */
import { describe, it, expect, vi } from 'vitest';

// 模块链路（orders.export-templates → orders.service）顶层引用 prisma —— mock 掉
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  orderToFullRows,
  orderToTicketingRows,
  buildOrderContext,
  FULL_COLUMNS,
  TICKETING_COLUMNS,
  type OrderForTemplateExport,
} from './orders.export-templates.js';

const D = (s: string): Date => new Date(s.length <= 10 ? `${s}T00:00:00.000Z` : `${s}Z`);

/** 旧《全岗可用》模版 57 列表头（叶子列；末尾三列并入「订单成本」分组）。*/
const OLD_FULL_HEADERS = [
  '序号', '是否是原订单', '代理机构', '备注', '酒店类型', '中文名称', '乘客姓名',
  '飞行次数', '出发(往返)日期', '航班号', '订单类型', '定金', '定金到账金额',
  '定金到账时间', '定金到账渠道', '结算价格', '结算价到账金额', '结算价到账时间',
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
        dateOfBirth: D('1990-06-15'),
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

describe('《全岗可用》full 模版 — 列定义对齐旧 57 列', () => {
  it('FULL_COLUMNS 列名列序与旧模版 57 列完全一致', () => {
    expect(FULL_COLUMNS.map((c) => c.header)).toEqual(OLD_FULL_HEADERS);
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

  it('乘客姓名：LAST/FIRST 斜线拼接，缺省回落 fullName', () => {
    expect(r1.passengerName).toBe('WANG/LIANBO');
    expect(r2.passengerName).toBe('李四');
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
      expect(r.deposit).toBe('');
      expect(r.depositReceived).toBe('');
      expect(r.singleRoomDiff).toBe('');
      expect(r.offsetPerson).toBe('');
      expect(r.offsetOrder).toBe('');
      expect(r.refundChannel).toBe('');
      expect(r.invoiceStatusManual).toBe('');
      expect(r.visaNote).toBe('');
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
