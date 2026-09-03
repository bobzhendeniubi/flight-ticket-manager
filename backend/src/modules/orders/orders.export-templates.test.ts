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
  VISA_COLUMNS,
  TICKETING_COLUMNS,
  buildOrderTemplateExportWorkbook,
  pnrName,
  nameWithTitle,
  FULL_COLUMNS,
  TICKETING_COLUMNS,
  VISA_COLUMNS,
  type OrderForTemplateExport,
} from './orders.export-templates.js';
import type { TripStatsMap } from './orders.export-trip-stats.js';
import { docKey } from '../travelers/traveler-profiles.aggregate.js';

const D = (s: string): Date => new Date(s.length <= 10 ? `${s}T00:00:00.000Z` : `${s}Z`);

/**
 * 《全岗可用》模版 57 列表头（叶子列；末尾三列并入「订单成本」分组）。
 * 定金组四列已移除：系统无定金模型，四列恒空，且现行模版本身已删除该组。
 * 「纯拼音名」为旧模版之外新增：无 MR/MS 称谓的 LAST/FIRST，财务对数/名单匹配用。
 * 「订单状态」为新增：中文标签，数据岗筛选用，紧邻开票/签证状态列。
 * 「航段状态」为新增：no-show / 回程释放·恢复·作废，紧跟「订单类型」（同属行程口径列）。
 */
const FULL_HEADERS = [
  '序号', '是否是原订单', '代理机构', '备注', '酒店类型', '中文名称', '乘客姓名',
  '纯拼音名', '飞行次数', '出发(往返)日期', '航班号', '订单类型', '航段状态',
  '结算价格', '结算价到账金额', '结算价到账时间',
  '结算价到账渠道', '尾款金额', '单房差', '单房差到账金额', '签证金额', '签证到账金额',
  '抵扣金额', '抵扣到账金额', '抵扣人员', '抵扣订单', '是否清账', '退款金额', '退款时间',
  '退款渠道', '订单状态', '系统开票状态', '开票状态', '签证状态', '签证选项', '签证公司', '签证备注', '护照签发地',
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
        visa: { code: 'VN-EVISA', visaName: '越南电子签', visaType: 'E-visa', supplier: '越南领区签证代办' },
        transfer: null,
        bundle: null,
        fulfillmentTasks: [{ type: 'VISA_APPLICATION', status: 'IN_PROGRESS' }],
      },
    ],
  } as unknown as OrderForTemplateExport;
}

describe('《全岗可用》full 模版 — 列定义对齐 57 列', () => {
  it('FULL_COLUMNS 列名列序与模版 57 列完全一致', () => {
    expect(FULL_COLUMNS.map((c) => c.header)).toEqual(FULL_HEADERS);
  });

  it('不输出定金组列（系统无定金模型，现行模版已删该组）', () => {
    expect(FULL_COLUMNS.map((c) => c.header).filter((h) => h.startsWith('定金'))).toEqual([]);
  });

  it('「订单状态」列紧邻状态类列：位于退款渠道之后、系统开票状态之前', () => {
    const headers = FULL_COLUMNS.map((c) => c.header);
    expect(headers[headers.indexOf('退款渠道') + 1]).toBe('订单状态');
    expect(headers[headers.indexOf('订单状态') + 1]).toBe('系统开票状态');
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
    // 称谓不分年龄（0723 票务口径）：r1 男 → MR；r2 儿童、性别 F → 同样 MS。
    expect(r1.passengerName).toBe('WANG/LIANBO MR');
    expect(r2.passengerName).toBe('李四 MS');
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

  it('录入时间：YYYY-MM-DD HH:MM:SS（含秒，北京时间）', () => {
    // createdAt = 2026-07-08T15:17:21Z → 北京时间 23:17:21（容器 TZ 是 UTC，不折算会少 8 小时）
    expect(r1.recordedAt).toBe('2026-07-08 23:17:21');
  });

  it('录入时间跨日：UTC 20:00 → 北京时间次日 04:00，日期进位', () => {
    const o = { ...fixtureRoundTrip(), createdAt: D('2026-07-08T20:00:00.000') };
    const [row] = orderToFullRows(o, buildOrderContext(o));

    expect(row.recordedAt).toBe('2026-07-09 04:00:00');
  });

  it('结算价到账时间同样折北京时间（跨日进位）', () => {
    const base = fixtureRoundTrip();
    const o = {
      ...base,
      payments: [
        { status: 'SUCCEEDED', paidAt: D('2026-07-08T20:30:15.000'), method: 'BANK_TRANSFER' },
      ],
    } as unknown as OrderForTemplateExport;
    const [row] = orderToFullRows(o, buildOrderContext(o));

    expect(row.settleReceivedAt).toBe('2026-07-09 04:30:15');
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

  // ── 飞行次数 = 常旅客档案快照（不再是"暂无数据"占位）─────────────────────────────
  // 该列曾长期留空并挂着「系统暂无数据」的注释，常旅客档案上线后数据早就有了。
  // 口径与全岗总表 / 分房表完全一致：同一取数（loadExportTripStats）+ 同一渲染
  // （flightCountCell），同一位乘客在三张表里的数字必然相同。
  describe('飞行次数 = 常旅客档案快照（与全岗总表/分房表同口径）', () => {
    it('有档案的乘客出数字，匹配不上的（新客）留空 —— 不臆造 0', () => {
      const tripStats: TripStatsMap = new Map([
        [
          docKey('PASSPORT', 'EN7208993'),
          { tripCount: 7, pendingTripCount: 2, availableTrips: 5 },
        ],
      ]);
      const [a, b] = orderToFullRows(order, ctx, tripStats);
      expect(a.flightCount).toBe('7');
      // 档案里没有 E87654321 → 留空（0 会被读成"从没飞过"的结论）
      expect(b.flightCount).toBe('');
    });

    it('同单不同乘客各按本人证件取，不再恒等（旧口径下整列都是空）', () => {
      const tripStats: TripStatsMap = new Map([
        [docKey('PASSPORT', 'EN7208993'), { tripCount: 7, pendingTripCount: 0, availableTrips: 7 }],
        [docKey('PASSPORT', 'E87654321'), { tripCount: 1, pendingTripCount: 0, availableTrips: 1 }],
      ]);
      const [a, b] = orderToFullRows(order, ctx, tripStats);
      expect(a.flightCount).toBe('7');
      expect(b.flightCount).toBe('1');
    });

    it('档案里 tripCount=0（已建档但去程都还没起飞）→ 如实写 0，与"匹配不上"区分', () => {
      const tripStats: TripStatsMap = new Map([
        [docKey('PASSPORT', 'EN7208993'), { tripCount: 0, pendingTripCount: 3, availableTrips: 0 }],
      ]);
      const [a] = orderToFullRows(order, ctx, tripStats);
      expect(a.flightCount).toBe('0');
    });

    it('证件号大小写/空格变体 → 仍按 docKey 归一命中（与档案聚合同款归一）', () => {
      const variant = fixtureRoundTrip();
      (variant.passengers[0] as { documentNumber: string }).documentNumber = ' en7208993 ';
      const tripStats: TripStatsMap = new Map([
        [docKey('PASSPORT', 'EN7208993'), { tripCount: 7, pendingTripCount: 0, availableTrips: 7 }],
      ]);
      const [a] = orderToFullRows(variant, buildOrderContext(variant), tripStats);
      expect(a.flightCount).toBe('7');
    });

    it('缺省 tripStats（未传）→ 整列留空，绝不回落成航段数', () => {
      for (const r of orderToFullRows(order, ctx)) expect(r.flightCount).toBe('');
    });
  });

  it('签证状态/选项：填真值', () => {
    expect(r1.visaStatus).toBe('处理中');
    expect(r1.visaOption).toBe('越南电子签');
  });

  it('订单状态：OrderStatus 映射中文标签（PAID → 已支付）', () => {
    expect(r1.orderStatus).toBe('已支付');
    expect(r2.orderStatus).toBe('已支付');
  });
});

// ── 订单状态列 · 中文标签映射（数据岗反馈：《全岗可用》增订单状态列用于筛选）──────
// 覆盖 OrderStatus 全部 13 值 → 中文标签；未知值兜底原文（绝不留空、不抛错）。
describe('《全岗可用》full 模版 — 订单状态列中文标签', () => {
  const CASES: Array<[string, string]> = [
    ['DRAFT', '草稿'],
    ['PENDING_PAYMENT', '待支付'],
    ['PAID', '已支付'],
    ['PROCESSING', '处理中'],
    ['TICKETED', '出票完成'],
    ['COMPLETED', '已完成'],
    ['PAYMENT_TIMEOUT', '支付超时'],
    ['CANCELLED', '已取消'],
    ['REFUND_REQUESTED', '退款中'],
    ['REFUNDED', '已退款'],
    ['CHANGE_REQUESTED', '改期中'],
    ['CHANGED', '已改期'],
    ['FAILED', '失败'],
  ];

  it.each(CASES)('%s → %s', (status, label) => {
    const order = fixtureRoundTrip();
    (order as unknown as { status: string }).status = status;
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows[0].orderStatus).toBe(label);
  });

  it('未知状态 → 兜底原文（不留空、不抛错）', () => {
    const order = fixtureRoundTrip();
    (order as unknown as { status: string }).status = 'SOME_NEW_STATUS';
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows[0].orderStatus).toBe('SOME_NEW_STATUS');
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

  it('酒店类型：BUNDLE 行上关联的酒店也算，只出酒店名', () => {
    expect(r1.hotelInfo).toBe('岘港五星');
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

// ── 酒店类型跟房控实际数据（0722 财务反馈；0901 运营反馈只出酒店名不拼房型）─────────────
// 「酒店类型」列（仅酒店名）改乘客行级：乘客在分房组内时酒店名跟房控排房结果，
// 无分房组回退订单项口径 ctx.hotelInfo（现状值，绝不留空）。fixtureRoundTrip 订单项酒店=岘港四星（房型三床房，不出现在本列）。
describe('《全岗可用》full 模版 — 酒店类型跟房控实际数据（乘客行级）', () => {
  it('乘客有分房组 → 酒店类型取房控分房组酒店名；无分房组回退订单项酒店名', () => {
    const order = fixtureRoundTrip();
    (order as unknown as { roomAssignment: unknown }).roomAssignment = {
      roomGroups: [{ id: 'g1', hotelName: '岘港五星海景', roomType: '海景大床', passengerIds: ['p1'] }],
    };
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows[0].hotelInfo).toBe('岘港五星海景'); // p1 跟房控
    expect(rows[1].hotelInfo).toBe('岘港四星'); // p2 无分房组 → 回退订单项
  });

  it('分房组只填酒店名（房型空）→ 酒店类型只出酒店名，自由文本原样', () => {
    const order = fixtureRoundTrip();
    (order as unknown as { roomAssignment: unknown }).roomAssignment = {
      roomGroups: [{ id: 'g1', hotelName: '岘港A(自由文本/待定)', roomType: '', passengerIds: ['p1'] }],
    };
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows[0].hotelInfo).toBe('岘港A(自由文本/待定)');
  });

  it('无分房组（roomAssignment=null）→ 回退订单项口径，绝不留空', () => {
    const order = fixtureRoundTrip();
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows[0].hotelInfo).toBe('岘港四星');
    expect(rows[1].hotelInfo).toBe('岘港四星');
  });
});

describe('《签证专用》visa 行 — 酒店类型跟房控实际数据（乘客行级）', () => {
  it('乘客有分房组 → 酒店类型取房控分房组酒店名；无分房组回退订单项酒店名', () => {
    const order = fixtureRoundTrip();
    (order as unknown as { roomAssignment: unknown }).roomAssignment = {
      roomGroups: [{ id: 'g1', hotelName: '椰岛湾', roomType: '家庭房', passengerIds: ['p1'] }],
    };
    const rows = orderToVisaRows(order, buildOrderContext(order));
    expect(rows[0].hotelInfo).toBe('椰岛湾'); // p1 跟房控
    expect(rows[1].hotelInfo).toBe('岘港四星'); // p2 无分房组 → 回退订单项
  });

  it('无分房组 → 回退订单项口径，绝不留空', () => {
    const order = fixtureRoundTrip();
    const rows = orderToVisaRows(order, buildOrderContext(order));
    expect(rows[0].hotelInfo).toBe('岘港四星');
  });
});

// ── 「星级随机」未落位行的酒店类型列 ──────────────────────────────────────────
// 该行 hotelRoomTypeId 为空、只有 randomStarTier（还没落到具体酒店）。若只认 hotelRoomType，
// 这类单的「酒店类型」列整列空白；按 rooming list 口径标「X星随机（待落位）」，
// 文案与分房表共用同一入口（randomStarTierLabel）。
describe('酒店类型列 — 星级随机未落位行', () => {
  /** 把订单项换成一条未落位的随机档 HOTEL 行（保留两段航班）。*/
  function fixtureRandomTier(tier: number): OrderForTemplateExport {
    const order = fixtureRoundTrip();
    const o = order as unknown as { items: unknown[] };
    o.items = [
      ...order.items.filter((it) => it.kind === 'FLIGHT'),
      {
        kind: 'HOTEL',
        flightCabin: null,
        amount: 2000,
        description: '岘港随机酒店',
        metadata: null,
        hotelRoomTypeId: null,
        randomStarTier: tier,
        flightSchedule: null,
        hotelRoomType: null,
        visa: null,
        transfer: null,
        bundle: null,
        fulfillmentTasks: [],
      },
    ];
    return order;
  }

  it('《全岗可用》无房型无分房组 → 回退「X星随机（待落位）」，不留空', () => {
    const order = fixtureRandomTier(4);
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows[0].hotelInfo).toBe('四星随机（待落位）');
    expect(rows[1].hotelInfo).toBe('四星随机（待落位）');
  });

  it('《签证专用》同口径回退「X星随机（待落位）」', () => {
    const order = fixtureRandomTier(3);
    const rows = orderToVisaRows(order, buildOrderContext(order));
    expect(rows[0].hotelInfo).toBe('三星随机（待落位）');
  });

  it('有分房组（房控已排房）→ 仍以房控结果为准，不标待落位', () => {
    const order = fixtureRandomTier(5);
    (order as unknown as { roomAssignment: unknown }).roomAssignment = {
      roomGroups: [{ id: 'g1', hotelName: '椰岛湾', roomType: '家庭房', passengerIds: ['p1'] }],
    };
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows[0].hotelInfo).toBe('椰岛湾'); // p1 跟房控
    expect(rows[1].hotelInfo).toBe('五星随机（待落位）'); // p2 无分房组 → 回退未落位标识
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

  it('PTC 按订单去程（最早 FLIGHT 行出发时间）自动推算；Title 全年龄段按性别给 MR/MS，儿童女缺 Title 给 MS', () => {
    // 订单去程 = 2026-07-13（fixtureRoundTrip 两段航班中较早一段），r2 生日 2019-06-15 → 实足 7 岁 = CHD。
    expect(r2.title).toBe('MS');
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
// 口径（0723 票务确认）：不分年龄，全员按性别 M→MR / F→MS；
// 性别 X/未知 → 不加称谓；已有手录 title 优先。
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

  it('儿童（2–<12 岁）男性 → 同样按性别给 " MR"（不分年龄）', () => {
    // 出发日 2026-07-13 − 生日 2018-01-01 → 实足 8 岁 = 儿童，但称谓不分年龄
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'M', dateOfBirth: D('2018-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MR');
  });

  it('儿童女性 → 同样按性别给 " MS"（不分年龄）', () => {
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'F', dateOfBirth: D('2018-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MS');
  });

  it('婴儿（<2 岁）男性 → 同样按性别给 " MR"（不分年龄）', () => {
    // 出发日 2026-07-13 − 生日 2025-01-01 → 实足 1 岁 = 婴儿，但称谓不分年龄
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'M', dateOfBirth: D('2025-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MR');
  });

  it('婴儿女性 → 同样按性别给 " MS"（不分年龄）', () => {
    const p = { lastName: 'ZHAO', firstName: 'WEI', fullName: 'x', gender: 'F', dateOfBirth: D('2025-01-01') };
    expect(nameWithTitle(p, depart)).toBe('ZHAO/WEI MS');
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

  it('已有手录 title → 优先直接用（原样大写），不再按性别派生', () => {
    // 按性别本应派生为 MR，但手录 title 优先生效。
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

// ── 《签证专用》visa 行 · 姓名不带称谓（签证岗反馈：英文名不需要带性别）───────────
// 送签名单本有独立「性别」列 Giới tính，姓名列只填纯拼音名 LAST/FIRST，不再附 MR/MS。
// 《全岗可用》「乘客拼音名」（带称谓，航司口径）与「纯拼音名」两列、票务专用 Title 列均不受影响。
describe('《签证专用》visa 行 — 姓名不带称谓', () => {
  const order = fixtureRoundTrip();
  const rows = orderToVisaRows(order, buildOrderContext(order));

  it('姓名列 = 纯拼音名 LAST/FIRST，不带 MR/MS 称谓', () => {
    // r1 成人男性（全岗/票务口径会给 MR），签证名单不给称谓
    expect(rows[0].name).toBe('WANG/LIANBO');
    // r2 无拼音名 → 回落 fullName「李四」，同样不加称谓
    expect(rows[1].name).toBe('李四');
  });
});

// ── 《签证专用》visa 行 · 签证公司列（财务反馈：核对签证金额属于哪家供应商）──────
describe('《签证专用》visa 行 — 签证公司列', () => {
  it('VISA_COLUMNS 含「签证公司」，紧邻金额列（尾款金额之后）', () => {
    const headers = VISA_COLUMNS.map((c) => c.header);
    expect(headers).toContain('签证公司');
    expect(headers[headers.indexOf('尾款金额') + 1]).toBe('签证公司');
  });

  it('取订单 VISA 行关联产品的 supplier', () => {
    const order = fixtureRoundTrip();
    const rows = orderToVisaRows(order, buildOrderContext(order));
    expect(rows[0].visaSupplier).toBe('越南领区签证代办');
  });

  it('多签证产品 → supplier 去重逗号拼接', () => {
    const order = fixtureRoundTrip();
    (order.items as unknown[]).push({
      kind: 'VISA',
      flightCabin: null,
      amount: 0,
      description: '',
      metadata: null,
      hotelRoomTypeId: null,
      flightSchedule: null,
      hotelRoomType: null,
      visa: { code: 'VN-STICKER', visaName: '越南贴纸签', visaType: 'sticker', supplier: '岘港代办B' },
      transfer: null,
      bundle: null,
      fulfillmentTasks: [],
    });
    const rows = orderToVisaRows(order, buildOrderContext(order));
    expect(rows[0].visaSupplier).toBe('越南领区签证代办, 岘港代办B');
  });

  it('VISA 行 supplier 缺失 → 签证公司列留空（不编造）', () => {
    const order = fixtureRoundTrip();
    const visaItem = order.items.find((it) => (it as { kind: string }).kind === 'VISA') as {
      visa: { supplier: string | null };
    };
    visaItem.visa.supplier = null;
    const rows = orderToVisaRows(order, buildOrderContext(order));
    expect(rows[0].visaSupplier).toBe('');
  });
});

// ── 《票务专用》ticketing 工作簿 · 对齐航司 PNR 原版样例的朴素样式（票务反馈）──────
// 原版样例：单 sheet 27 列，表头默认字体、无填充、无居中换行；日期 DDMonYY。列名/列序本就
// 与样例一致，本批只去掉加粗/底色/居中换行等装饰；《签证专用》表头样式不受影响。
describe('《票务专用》ticketing 工作簿 — 朴素样式对齐原版样例', () => {
  function fakeClient(orders: OrderForTemplateExport[]): PrismaClient {
    return { order: { findMany: vi.fn().mockResolvedValue(orders) } } as unknown as PrismaClient;
  }

  async function loadTicketingSheet(): Promise<ExcelJS.Worksheet> {
    const buf = await buildOrderTemplateExportWorkbook(
      { template: 'ticketing' } as Parameters<typeof buildOrderTemplateExportWorkbook>[0],
      fakeClient([fixtureRoundTrip()]),
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.getWorksheet('票务专用');
    if (!ws) throw new Error('票务专用 sheet 不存在');
    return ws;
  }

  function headerRow(ws: ExcelJS.Worksheet): string[] {
    const headers: string[] = [];
    ws.getRow(1).eachCell((cell, col) => (headers[col - 1] = String(cell.value ?? '')));
    return headers;
  }

  it('表头 27 列，列名列序与原版样例完全一致', async () => {
    const ws = await loadTicketingSheet();
    expect(headerRow(ws)).toEqual(OLD_TICKETING_HEADERS);
  });

  it('表头朴素：不加粗、无底色填充（对齐样例简洁风）', async () => {
    const ws = await loadTicketingSheet();
    const cell = ws.getRow(1).getCell(1);
    expect(cell.font?.bold ?? false).toBe(false);
    const fill = cell.fill as { pattern?: string } | undefined;
    expect(fill?.pattern ?? 'none').not.toBe('solid');
  });

  it('日期列 DDMonYY 航司格式（Date of Birth / Passport Expiry Date）', async () => {
    const ws = await loadTicketingSheet();
    const headers = headerRow(ws);
    const dobCol = headers.indexOf('Date of Birth') + 1;
    const expiryCol = headers.indexOf('Passport Expiry Date') + 1;
    // 第 2 行 = 首位乘客（王连波：生日 1984-02-04、护照有效期 2034-12-11）
    expect(String(ws.getRow(2).getCell(dobCol).value)).toBe('04Feb84');
    expect(String(ws.getRow(2).getCell(expiryCol).value)).toBe('11Dec34');
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

// ── 飞行次数取数接进 buildOrderTemplateExportWorkbook（取数 → 渲染全链路）───────────
// 纯映射测试证明「给了快照就出数字」，这里证明导出**确实去拉了**快照 —— 早先该列留空
// 正是因为链路根本没接上（渲染层写死空串）。同时锁住批量口径：一次 findMany 覆盖全部乘客。
describe('buildOrderTemplateExportWorkbook 飞行次数取数', () => {
  interface ProfileRow {
    id: string;
    documentType: string;
    documentNumber: string;
    tripCount: number;
    pendingTripCount: number;
    refreshedAt: Date;
    mergedIntoId: string | null;
  }

  function profile(documentNumber: string, tripCount: number): ProfileRow {
    return {
      id: `tp-${documentNumber}`,
      documentType: 'PASSPORT',
      documentNumber,
      tripCount,
      pendingTripCount: 0,
      refreshedAt: D('2026-07-01T00:00:00.000'),
      mergedIntoId: null,
    };
  }

  /**
   * 假 client。order.findMany 会被调用两次且语义不同，按 where 形态分流：
   *   - 导出自己的取数（无 passengers 条件）→ 返回 orders；
   *   - 快照未命中乘客的现算兜底（带 passengers.some 条件）→ 返回 legacyOrders（默认空）。
   * legacyTickets = 现算兜底里老系统那半边。
   */
  function fakeClient(
    orders: OrderForTemplateExport[],
    profiles: ProfileRow[],
    live: { orders?: unknown[]; tickets?: unknown[] } = {},
  ): {
    client: PrismaClient;
    profileFindMany: ReturnType<typeof vi.fn>;
    orderFindMany: ReturnType<typeof vi.fn>;
    legacyFindMany: ReturnType<typeof vi.fn>;
  } {
    const profileFindMany = vi.fn().mockResolvedValue(profiles);
    const orderFindMany = vi.fn(async (args?: { where?: Record<string, unknown> }) =>
      args?.where?.passengers ? live.orders ?? [] : orders,
    );
    const legacyFindMany = vi.fn().mockResolvedValue(live.tickets ?? []);
    const client = {
      order: { findMany: orderFindMany },
      legacyTicket: { findMany: legacyFindMany },
      // count > 0 且 aggregate 给出刚重建过的新鲜时间戳 → 不触发首建/过期兜底（那两个是
      // 新环境 / 快照过期才走的分支，见 orders.export-trip-stats.ts）
      travelerProfile: {
        count: vi.fn().mockResolvedValue(42),
        aggregate: vi.fn().mockResolvedValue({ _max: { refreshedAt: new Date() } }),
        findMany: profileFindMany,
      },
      travelerBenefitRedemption: { groupBy: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    return { client, profileFindMany, orderFindMany, legacyFindMany };
  }

  /** 读《全岗可用》第 n 条数据行的「飞行次数」单元格（两行表头 → 数据从第 3 行起）。*/
  async function flightCountCells(buf: Buffer): Promise<unknown[]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.getWorksheet('全岗可用');
    if (!ws) throw new Error('全岗可用 sheet 不存在');
    const col = FULL_COLUMNS.findIndex((c) => c.key === 'flightCount') + 1;
    return [3, 4].map((row) => ws.getRow(row).getCell(col).value);
  }

  const fullQuery = {
    template: 'full',
    travelFrom: '2026-07-13',
    travelTo: '2026-07-13',
  } as Parameters<typeof buildOrderTemplateExportWorkbook>[0];

  it('有档案的乘客读快照数字；没档案的现算兜底补上老系统次数（此前整列恒空）', async () => {
    const { client } = fakeClient([fixtureRoundTrip()], [profile('EN7208993', 9)], {
      // 第二位乘客（E87654321）没有档案：新系统查不到订单，老系统有两条历史票
      tickets: [
        { documentNumberNorm: 'E87654321', outboundDate: D('2019-05-01T00:00:00.000') },
        { documentNumberNorm: 'E87654321', outboundDate: D('2020-06-01T00:00:00.000') },
      ],
    });
    const cells = await flightCountCells(await buildOrderTemplateExportWorkbook(fullQuery, client));
    expect(cells[0]).toBe('9');
    expect(cells[1]).toBe('2'); // 老客认得出来，不再是空单元格
  });

  it('没档案又查不到任何历史 → 现算出 0，那是算过的结论', async () => {
    const { client } = fakeClient([fixtureRoundTrip()], [profile('EN7208993', 9)]);
    const cells = await flightCountCells(await buildOrderTemplateExportWorkbook(fullQuery, client));
    expect(cells[1]).toBe('0');
  });

  it('批量取数：全部乘客一条 findMany 拉回，不在行循环里逐个查库', async () => {
    const { client, profileFindMany, orderFindMany, legacyFindMany } = fakeClient(
      [fixtureRoundTrip()],
      [],
    );
    await buildOrderTemplateExportWorkbook(fullQuery, client);
    expect(profileFindMany).toHaveBeenCalledTimes(1);
    const or = profileFindMany.mock.calls[0][0].where.OR as { documentNumber: { equals: string } }[];
    expect(or.map((c) => c.documentNumber.equals).sort()).toEqual(['E87654321', 'EN7208993']);
    // 两位乘客都没档案 → 现算兜底也是批量：导出自己的取数 1 次 + 兜底订单查询 1 次
    expect(orderFindMany).toHaveBeenCalledTimes(2);
    expect(legacyFindMany).toHaveBeenCalledTimes(1);
  });

  it('票务/签证模板无「飞行次数」列 → 压根不去拉档案', async () => {
    const { client, profileFindMany } = fakeClient([fixtureRoundTrip()], []);
    await buildOrderTemplateExportWorkbook(
      { template: 'ticketing' } as Parameters<typeof buildOrderTemplateExportWorkbook>[0],
      client,
    );
    expect(profileFindMany).not.toHaveBeenCalled();
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

// ── 签证状态按乘客（0901 运营反馈）────────────────────────────────────────────
// 与全岗总表（orders.export-master.ts）共用同一个纯函数，两张表口径不各写一份：
// 自备签的客人不再跟着整单写「需要」，某一位已送签也不再让全单都写成已送签。
describe('《全岗可用》full 模版 — 签证状态按乘客取值', () => {
  /**
   * 三人单（订单级「需要签证」）：
   *   p1 自备签、p2 已送签（CONFIRMED）、p3 待处理（PENDING）。
   */
  function fixtureMixedVisa(): OrderForTemplateExport {
    const order = fixtureRoundTrip();
    const o = order as unknown as {
      visaStatus: string | null;
      passengers: Array<Record<string, unknown>>;
    };
    o.visaStatus = 'NEEDED';
    const [a, b] = o.passengers;
    o.passengers = [
      { ...a, visaExempt: true, visaSubmissionStatus: 'PENDING' },
      { ...b, visaExempt: false, visaSubmissionStatus: 'CONFIRMED' },
      { ...b, id: 'p3', fullName: '王五', chineseName: '王五', documentNumber: 'E11112222',
        visaExempt: false, visaSubmissionStatus: 'PENDING' },
    ];
    return order;
  }

  it('需要签证的三人单：自备签 / 已送签 / 待处理 → 三行三个不同值', () => {
    const order = fixtureMixedVisa();
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows.map((r) => r.visaStatus)).toEqual(['自备签', '已送签', '需要']);
  });

  it('送签进度「材料准备」用签证台同一份文案', () => {
    const order = fixtureMixedVisa();
    (order.passengers[2] as unknown as { visaSubmissionStatus: string }).visaSubmissionStatus =
      'IN_PROGRESS';
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows[2].visaStatus).toBe('材料准备');
  });

  it('订单级「不需要签证」不再一票否决：有个人信息的按人显示，其余才回落订单级', () => {
    const order = fixtureMixedVisa();
    (order as unknown as { visaStatus: string }).visaStatus = 'NOT_NEEDED';
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows.map((r) => r.visaStatus)).toEqual(['自备签', '已送签', '不需要']);
  });

  it('订单级「已签证」同理：自备签/已送签逐人显示，无个人信息的才写「已签证」', () => {
    const order = fixtureMixedVisa();
    (order as unknown as { visaStatus: string }).visaStatus = 'HAS_VISA';
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows.map((r) => r.visaStatus)).toEqual(['自备签', '已送签', '已签证']);
  });

  it('老数据（乘客无送签字段）→ 整列沿用订单级/履约任务文案，与改动前一致', () => {
    const order = fixtureRoundTrip(); // 乘客不带 visaExempt / visaSubmissionStatus
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows.map((r) => r.visaStatus)).toEqual(['处理中', '处理中']);
  });

  it('《签证专用》模板不受影响：自备签乘客照旧整行排除', () => {
    const order = fixtureMixedVisa();
    const rows = orderToVisaRows(order, buildOrderContext(order));
    expect(rows.map((r) => r.chineseName)).toEqual(['李四', '王五']);
  });
});

// ── 结算价格按乘客（运营反馈）──────────────────────────────────────────────────
// 反馈：同单多人结算价各不相同，导出来却是订单总价平分。
// 口径：每人结算价 = 应收均摊 + 该乘客调价净额（权威算法 per-pax-share.ts，
// 与订单详情页「每人结算价」表、全岗总表同一份）。
describe('结算价格按乘客 — 《全岗可用》与《签证专用》', () => {
  /** 两位乘客各挂一条按乘客调价行（p1 −360、p2 −120）。*/
  function fixtureWithPerPaxAdjustments(): OrderForTemplateExport {
    const order = fixtureRoundTrip();
    const o = order as unknown as { total: number; items: Array<Record<string, unknown>> };
    o.total = 3792;
    o.items = [
      ...o.items,
      {
        id: 'adj1',
        kind: 'DISCOUNT',
        flightCabin: null,
        amount: -360,
        description: '价格调整：自备签',
        passengerId: 'p1',
        metadata: { priceAdjustment: true, reasonCode: 'MISC_FEE' },
        hotelRoomTypeId: null,
        flightSchedule: null,
        hotelRoomType: null,
        visa: null,
        transfer: null,
        bundle: null,
        fulfillmentTasks: [],
      },
      {
        id: 'adj2',
        kind: 'DISCOUNT',
        flightCabin: null,
        amount: -120,
        description: '价格调整：补收杂费',
        passengerId: 'p2',
        metadata: { priceAdjustment: true, reasonCode: 'MISC_FEE' },
        hotelRoomTypeId: null,
        flightSchedule: null,
        hotelRoomType: null,
        visa: null,
        transfer: null,
        bundle: null,
        fulfillmentTasks: [],
      },
    ];
    return order;
  }

  it('《全岗可用》：两人各自调价 → 结算价格逐人不同，合计恒等于应收总额', () => {
    const order = fixtureWithPerPaxAdjustments();
    const rows = orderToFullRows(order, buildOrderContext(order));
    // 基准每人 = (3792 + 480) / 2 = 2136；p1 = 2136 − 360 = 1776；p2 = 2136 − 120 = 2016
    expect(rows.map((r) => r.settlePrice)).toEqual([1776, 2016]);
    expect(rows.reduce((s, r) => s + r.settlePrice, 0)).toBe(3792);
  });

  it('《签证专用》与《全岗可用》同一个数：同一位乘客在两张表里不会打架', () => {
    const order = fixtureWithPerPaxAdjustments();
    const ctx = buildOrderContext(order);
    const full = orderToFullRows(order, ctx);
    const visa = orderToVisaRows(order, ctx);
    expect(visa.map((r) => r.settlePrice)).toEqual(full.map((r) => r.settlePrice));
  });

  it('无按乘客调价的单：与「总额÷人数」完全一致（不改现有数字）', () => {
    const order = fixtureRoundTrip();
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows.map((r) => r.settlePrice)).toEqual([1268, 1268]); // 2536 / 2
  });
});

// ── 航段状态列（no-show / 回程释放·恢复·作废）────────────────────────────────
describe('航段状态列 — 《全岗可用》与《签证专用》', () => {
  const RELEASED_AT = '2026-09-02T03:15:23.000Z';

  /** 把往返单的去程标 no-show、回程置成已释放态。 */
  function fixtureNoShowReleased(): OrderForTemplateExport {
    const order = fixtureRoundTrip();
    const items = order.items as unknown as Array<Record<string, unknown>>;
    items[0].metadata = { noShow: { at: RELEASED_AT, leg: 'OUTBOUND' } };
    items[1].metadata = { returnReleased: { at: RELEASED_AT, originalScheduleId: 'sch-ret' } };
    items[1].flightScheduleId = null;
    items[1].flightSchedule = null;
    return order;
  }

  it('列位置紧跟「订单类型」（同属行程口径列）', () => {
    const headers = FULL_COLUMNS.map((c) => c.header);
    expect(headers[headers.indexOf('订单类型') + 1]).toBe('航段状态');
  });

  it('正常单留空', () => {
    const order = fixtureRoundTrip();
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows.map((r) => r.legStatus)).toEqual(['', '']);
  });

  it('去程 no-show + 回程已释放 → 两个状态合成一格，每行乘客都带', () => {
    const order = fixtureNoShowReleased();
    const rows = orderToFullRows(order, buildOrderContext(order));
    expect(rows.map((r) => r.legStatus)).toEqual([
      '去程未登机 / 回程座位已释放',
      '去程未登机 / 回程座位已释放',
    ]);
  });

  it('回程已恢复且超售 → 带上超售座数', () => {
    const order = fixtureRoundTrip();
    const items = order.items as unknown as Array<Record<string, unknown>>;
    items[1].metadata = {
      returnReleased: { at: RELEASED_AT },
      returnRestored: { at: '2026-09-02T05:00:00.000Z', oversold: true, oversoldBy: 2 },
    };
    const [row] = orderToFullRows(order, buildOrderContext(order));
    expect(row.legStatus).toBe('回程已恢复（超售 2 座）');
  });

  it('《签证专用》同一口径，列在「出发日期」之后', () => {
    const visaHeaders = VISA_COLUMNS.map((c) => c.header);
    expect(visaHeaders[visaHeaders.indexOf('出发日期') + 1]).toBe('航段状态');

    const order = fixtureNoShowReleased();
    const rows = orderToVisaRows(order, buildOrderContext(order));
    expect(rows.every((r) => r.legStatus === '去程未登机 / 回程座位已释放')).toBe(true);
  });

  it('《票务专用》27 列航司格式一格不动：不加航段状态列', () => {
    expect(TICKETING_COLUMNS).toHaveLength(27);
    expect(TICKETING_COLUMNS.map((c) => c.header)).not.toContain('航段状态');
  });

  // 代理导出（路由解析出 agentScope 时）这一格必须是空的：状态文案会带超售座数，
  // 那是我方与航司之间的内部风控口径，交给代理等于把这一班卖穿了多少告诉同行。
  // 置空而不是删列 —— 列序是对外承诺过的，少一列会让下游全部错位。
  it('代理导出：《全岗可用》与《签证专用》该格置空，列本身仍在', () => {
    const order = fixtureNoShowReleased();
    const agentCtx = buildOrderContext(order, { redactLegStatus: true });
    expect(orderToFullRows(order, agentCtx).every((r) => r.legStatus === '')).toBe(true);
    expect(orderToVisaRows(order, agentCtx).every((r) => r.legStatus === '')).toBe(true);
    // 列定义不动（只置空格子）。
    expect(FULL_COLUMNS.map((c) => c.header)).toContain('航段状态');
    expect(VISA_COLUMNS.map((c) => c.header)).toContain('航段状态');
  });

  it('代理导出连超售座数一起藏掉（不给「回程已恢复（超售 2 座）」这种文案）', () => {
    const order = fixtureRoundTrip();
    const items = order.items as unknown as Array<Record<string, unknown>>;
    items[1].metadata = {
      returnReleased: { at: RELEASED_AT },
      returnRestored: { at: '2026-09-02T05:00:00.000Z', oversold: true, oversoldBy: 2 },
    };
    const [row] = orderToFullRows(order, buildOrderContext(order, { redactLegStatus: true }));
    expect(row.legStatus).toBe('');
  });
});
