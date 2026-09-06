/**
 * 订单金额「黄金」夹具 —— 只供 order-money 特征测试使用（tsconfig.build 已排除，不进 dist）。
 *
 * 同一组订单喂给系统里每一个算钱的点（列表 DTO / 三模板 / 全岗总表 / 分房表 / 财务导出 /
 * 经营报表 / 财务概览 / 对账台候选 / 认款建议 / 结算单 / 仪表盘 / 代理对账单 / 提醒尾款 /
 * 行程单应付），把「今天各处算出来的数」钉死。合并口径函数时，这些数一个都不许变。
 *
 * 夹具覆盖面（每张单只放一个「特征」，好定位是哪条口径漂了）：
 *   F1 multiPax        多人 + 按乘客调价（正/负）+ 整单调价 + 立减快照行 + 单住 + 自备签
 *   F2 refundedPartial 售后费 adjustmentCny + 预存抵扣 prepaymentOffset + 已完成/在途退款各一笔（多付）
 *   F3 swapped         换人后：adjustments 里带 excludeFromPerPax 的换人费 + 补房差 FEE 行（挂人/不挂人）
 *   F4 refundedFull    退款族终态（REFUNDED）：已收 3000、已退 2700
 *   F5 visaMixed       独立签证行 + 自备签减免 DISCOUNT 行 + 待支付（有尾款）
 *   F6 oddCents        拆单后常见的除不尽金额（3333.33 / 2 人）
 *
 * 金额字段一律用 Prisma.Decimal（与真实查询返回同形），消费方各自 Number()/toString() 都能吃。
 */
import { Prisma } from '@prisma/client';

const Dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);
export const D = (s: string): Date => new Date(s.length <= 10 ? `${s}T00:00:00.000Z` : `${s}Z`);

export interface FixturePassenger {
  id: string;
  fullName: string;
  chineseName: string | null;
  lastName: string | null;
  firstName: string | null;
  title: string | null;
  gender: string | null;
  dateOfBirth: Date | null;
  passengerType: string;
  nationality: string | null;
  documentType: string;
  documentNumber: string;
  passportIssueDate: Date | null;
  passportIssuePlace: string | null;
  passportIssueCountry: string | null;
  passportExpiry: Date | null;
  placeOfBirth: string | null;
  visaExempt: boolean;
  visaSubmissionStatus: string | null;
  singleRoom: boolean;
  bedPref: string | null;
  pnr: string | null;
  ticketNumber: string | null;
  visaNumber: null;
  visaType: null;
  visaIssueDate: null;
  visaPlaceOfIssue: null;
  visaCountryOfApplication: null;
  visaExpiry: null;
  addressType: null;
  addressCountry: null;
  addressDetails: null;
  addressCity: null;
  addressState: null;
  addressZip: null;
}

export interface FixtureItem {
  id: string;
  orderId: string;
  kind: string;
  quantity: number;
  unitPrice: Prisma.Decimal;
  amount: Prisma.Decimal;
  description: string;
  passengerId: string | null;
  metadata: unknown;
  flightCabin: string | null;
  hotelRoomTypeId: string | null;
  randomStarTier: number | null;
  hotelCheckIn: Date | null;
  hotelCheckOut: Date | null;
  totalCostCny: Prisma.Decimal | null;
  unitCostCny: Prisma.Decimal | null;
  flightScheduleId: string | null;
  flightSchedule: {
    id: string;
    departureTime: Date;
    departureTz: string | null;
    flight: { flightNumber: string; originCode: string; destinationCode: string };
  } | null;
  hotelRoomType: { name: string; hotel: { name: string; code: string } } | null;
  visa: { supplier: string | null } | null;
  transfer: null;
  bundle: { items: unknown[] } | null;
  fulfillmentTasks: Array<{ type: string; status: string; notes: string | null }>;
}

export interface FixtureRefund {
  id: string;
  amount: Prisma.Decimal;
  status: string;
}

export interface FixtureOrder {
  id: string;
  orderNumber: string;
  status: string;
  agentId: string | null;
  userId: string | null;
  currency: string;
  subtotal: Prisma.Decimal;
  taxesAndFees: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  total: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  prepaymentOffset: Prisma.Decimal;
  adjustmentCny: number;
  adjustments: unknown[];
  swapFeeCny: number | null;
  swapRefundedAt: Date | null;
  swapReplacementOrderNumber: string | null;
  invoiceStatus: string;
  outboundInvoiced: boolean;
  returnInvoiced: boolean;
  systemInvoiced: boolean;
  visaStatus: string | null;
  contactName: string;
  contactPhone: string;
  guestName: string | null;
  notes: string | null;
  noteHotel: string | null;
  noteVisa: string | null;
  notePayment: string | null;
  noteSpecial: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  paymentExpiresAt: Date | null;
  roomAssignment: unknown;
  agent: { id: string; companyName: string | null; contactName: string; contactPhone: string | null } | null;
  user: { displayName: string; email: string } | null;
  payments: unknown[];
  refunds: FixtureRefund[];
  costItems: Array<{ category: string; amountCny: Prisma.Decimal }>;
  passengers: FixturePassenger[];
  items: FixtureItem[];
}

function pax(over: Partial<FixturePassenger> & { id: string; fullName: string }): FixturePassenger {
  return {
    chineseName: null,
    lastName: over.fullName.toUpperCase(),
    firstName: 'X',
    title: null,
    gender: 'M',
    dateOfBirth: D('1990-01-15'),
    passengerType: 'ADULT',
    nationality: 'CN',
    documentType: 'PASSPORT',
    documentNumber: `E${over.id.toUpperCase()}0001`,
    passportIssueDate: D('2020-06-15'),
    passportIssuePlace: '四川',
    passportIssueCountry: 'CN',
    passportExpiry: D('2030-06-14'),
    placeOfBirth: '四川',
    visaExempt: false,
    visaSubmissionStatus: null,
    singleRoom: false,
    bedPref: null,
    pnr: null,
    ticketNumber: null,
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
    ...over,
  };
}

function item(
  orderId: string,
  over: Partial<FixtureItem> & { id: string; kind: string; amount: number },
): FixtureItem {
  const { amount, ...rest } = over;
  const quantity = over.quantity ?? 1;
  return {
    orderId,
    quantity,
    unitPrice: Dec(Math.round((amount / quantity) * 100) / 100),
    amount: Dec(amount),
    description: '',
    passengerId: null,
    metadata: null,
    flightCabin: null,
    hotelRoomTypeId: null,
    randomStarTier: null,
    hotelCheckIn: null,
    hotelCheckOut: null,
    totalCostCny: null,
    unitCostCny: null,
    flightScheduleId: null,
    flightSchedule: null,
    hotelRoomType: null,
    visa: null,
    transfer: null,
    bundle: null,
    fulfillmentTasks: [],
    ...rest,
  };
}

function leg(orderId: string, id: string, date: string, out: boolean): FixtureItem {
  return item(orderId, {
    id,
    kind: 'FLIGHT',
    amount: 0,
    flightCabin: 'ECONOMY',
    flightScheduleId: `fs-${id}`,
    flightSchedule: {
      id: `fs-${id}`,
      departureTime: D(`${date}T02:00:00.000`),
      departureTz: out ? 'Asia/Macau' : 'Asia/Ho_Chi_Minh',
      flight: out
        ? { flightNumber: 'QH9589', originCode: 'MFM', destinationCode: 'DAD' }
        : { flightNumber: 'QH9588', originCode: 'DAD', destinationCode: 'MFM' },
    },
  });
}

function order(over: Partial<FixtureOrder> & { id: string; orderNumber: string; total: number }): FixtureOrder {
  const { total, ...rest } = over;
  return {
    status: 'PAID',
    agentId: null,
    userId: null,
    currency: 'CNY',
    subtotal: Dec(total),
    taxesAndFees: Dec(0),
    discountTotal: Dec(0),
    total: Dec(total),
    paidAmount: Dec(0),
    prepaymentOffset: Dec(0),
    adjustmentCny: 0,
    adjustments: [],
    swapFeeCny: null,
    swapRefundedAt: null,
    swapReplacementOrderNumber: null,
    invoiceStatus: 'NONE',
    outboundInvoiced: false,
    returnInvoiced: false,
    systemInvoiced: false,
    visaStatus: 'E_VISA',
    contactName: '联系人',
    contactPhone: '13800000000',
    guestName: null,
    notes: null,
    noteHotel: null,
    noteVisa: null,
    notePayment: null,
    noteSpecial: null,
    createdAt: D('2026-08-20T01:00:00.000'),
    updatedAt: D('2026-08-20T01:00:00.000'),
    deletedAt: null,
    paymentExpiresAt: null,
    roomAssignment: null,
    agent: null,
    user: { displayName: '录单员', email: 'op@ftm.local' },
    payments: [],
    refunds: [],
    costItems: [],
    passengers: [],
    items: [],
    ...rest,
  };
}

const AGENT_A = { id: 'agent-a', companyName: '甲代理', contactName: '甲', contactPhone: '13900000001' };
const AGENT_B = { id: 'agent-b', companyName: '乙代理', contactName: '乙', contactPhone: '13900000002' };

/** F1 多人 + 按乘客调价 + 整单调价 + 立减快照 + 单住 + 自备签。total = 10000 − 1032 + 800 − 100 − 50 = 9618 */
export function fixtureMultiPax(): FixtureOrder {
  const id = 'f1';
  return order({
    id,
    orderNumber: 'FTM2026082000001',
    status: 'PAID',
    agentId: AGENT_A.id,
    agent: AGENT_A,
    total: 9618,
    paidAmount: Dec(5000),
    createdAt: D('2026-08-20T01:00:00.000'),
    passengers: [
      pax({ id: 'p1', fullName: '张三', chineseName: '张三', singleRoom: true }),
      pax({ id: 'p2', fullName: '李四', chineseName: '李四', gender: 'F' }),
      pax({ id: 'p3', fullName: '王五', chineseName: '王五', visaExempt: true }),
      pax({ id: 'p4', fullName: '赵六', chineseName: '赵六' }),
    ],
    items: [
      leg(id, 'f1-out', '2026-09-10', true),
      leg(id, 'f1-ret', '2026-09-14', false),
      item(id, {
        id: 'f1-bundle',
        kind: 'BUNDLE',
        quantity: 4,
        amount: 10000,
        description: '岘港四星 4 晚套餐',
        metadata: { visaListSnapshotCny: 240, addOns: { singleSupplementTotal: 300 } },
        bundle: { items: [] },
      }),
      item(id, {
        id: 'f1-disc',
        kind: 'DISCOUNT',
        amount: -1032,
        description: '同业立减',
        metadata: { settlementDiscount: true },
      }),
      item(id, {
        id: 'f1-adj-p2',
        kind: 'FEE',
        amount: 800,
        description: '补签证',
        passengerId: 'p2',
        metadata: { priceAdjustment: true, reasonCode: 'MISC_FEE' },
      }),
      item(id, {
        id: 'f1-adj-p3',
        kind: 'DISCOUNT',
        amount: -100,
        description: '自备签优惠',
        passengerId: 'p3',
        metadata: { priceAdjustment: true, reasonCode: 'DISCOUNT' },
      }),
      item(id, {
        id: 'f1-adj-whole',
        kind: 'DISCOUNT',
        amount: -50,
        description: '整单优惠',
        metadata: { priceAdjustment: true, reasonCode: 'DISCOUNT' },
      }),
    ],
  });
}

/** F2 售后费 300 + 预存抵扣 500 + 已完成退款 1000 / 在途退款 200；paid 6300 ⇒ 多付。 */
export function fixtureRefundedPartial(): FixtureOrder {
  const id = 'f2';
  return order({
    id,
    orderNumber: 'FTM2026082000002',
    status: 'PROCESSING',
    agentId: AGENT_A.id,
    agent: AGENT_A,
    total: 6000,
    paidAmount: Dec(6300),
    prepaymentOffset: Dec(500),
    adjustmentCny: 300,
    adjustments: [{ type: 'CHANGE_FEE', label: '改期费', amountCny: 300, at: '2026-08-21T00:00:00.000Z', by: 'u1' }],
    createdAt: D('2026-08-21T01:00:00.000'),
    refunds: [
      { id: 'f2-r1', amount: Dec(1000), status: 'COMPLETED' },
      { id: 'f2-r2', amount: Dec(200), status: 'REQUESTED' },
    ],
    passengers: [
      pax({ id: 'p5', fullName: '孙七', chineseName: '孙七' }),
      pax({ id: 'p6', fullName: '周八', chineseName: '周八', gender: 'F' }),
    ],
    items: [
      leg(id, 'f2-out', '2026-09-11', true),
      leg(id, 'f2-ret', '2026-09-15', false),
      item(id, { id: 'f2-bundle', kind: 'BUNDLE', quantity: 2, amount: 6000, description: '岘港三星 4 晚套餐', bundle: { items: [] } }),
    ],
  });
}

/** F3 换人后：换人费 450（excludeFromPerPax）+ 改期费 200；补房差 FEE 400 挂 p8、200 不挂人。 */
export function fixtureSwapped(): FixtureOrder {
  const id = 'f3';
  return order({
    id,
    orderNumber: 'FTM2026082000003',
    status: 'TICKETED',
    agentId: AGENT_B.id,
    agent: AGENT_B,
    total: 8100,
    paidAmount: Dec(8750),
    adjustmentCny: 650,
    adjustments: [
      { type: 'SWAP_FEE', label: '换人费', amountCny: 450, at: '2026-08-22T00:00:00.000Z', by: 'u1', excludeFromPerPax: true },
      { type: 'CHANGE_FEE', label: '改期费', amountCny: 200, at: '2026-08-23T00:00:00.000Z', by: 'u1' },
    ],
    createdAt: D('2026-08-22T01:00:00.000'),
    passengers: [
      pax({ id: 'p7', fullName: '吴九', chineseName: '吴九', singleRoom: true }),
      pax({ id: 'p8', fullName: '郑十', chineseName: '郑十', singleRoom: true, gender: 'F' }),
      pax({ id: 'p9', fullName: '钱一', chineseName: '钱一' }),
    ],
    items: [
      leg(id, 'f3-out', '2026-09-12', true),
      leg(id, 'f3-ret', '2026-09-16', false),
      item(id, { id: 'f3-bundle', kind: 'BUNDLE', quantity: 3, amount: 7500, description: '岘港四星 4 晚套餐', bundle: { items: [] } }),
      item(id, {
        id: 'f3-roomdiff-p8',
        kind: 'FEE',
        amount: 400,
        description: '补收单房差',
        passengerId: 'p8',
        metadata: { priceAdjustment: true, reasonCode: 'ROOM_DIFF' },
      }),
      item(id, {
        id: 'f3-roomdiff-pool',
        kind: 'FEE',
        amount: 200,
        description: '补收单房差（老行）',
        metadata: { priceAdjustment: true, reasonCode: 'ROOM_DIFF' },
      }),
    ],
  });
}

/** F4 退款族终态：已收 3000、已完成退款 2700。 */
export function fixtureRefundedFull(): FixtureOrder {
  const id = 'f4';
  return order({
    id,
    orderNumber: 'FTM2026082000004',
    status: 'REFUNDED',
    total: 3000,
    paidAmount: Dec(3000),
    createdAt: D('2026-08-23T01:00:00.000'),
    refunds: [{ id: 'f4-r1', amount: Dec(2700), status: 'COMPLETED' }],
    passengers: [pax({ id: 'p10', fullName: '冯二', chineseName: '冯二' })],
    items: [
      leg(id, 'f4-out', '2026-09-13', true),
      item(id, { id: 'f4-bundle', kind: 'BUNDLE', quantity: 1, amount: 3000, description: '岘港三星 4 晚套餐', bundle: { items: [] } }),
    ],
  });
}

/** F5 独立签证行 480（2 人）+ 自备签减免 −360 + 机票 3000；待支付、付了 1000。 */
export function fixtureVisaMixed(): FixtureOrder {
  const id = 'f5';
  return order({
    id,
    orderNumber: 'FTM2026082000005',
    status: 'PENDING_PAYMENT',
    agentId: AGENT_B.id,
    agent: AGENT_B,
    total: 3120,
    paidAmount: Dec(1000),
    createdAt: D('2026-08-24T01:00:00.000'),
    passengers: [
      pax({ id: 'p11', fullName: '陈三', chineseName: '陈三' }),
      pax({ id: 'p12', fullName: '褚四', chineseName: '褚四', gender: 'F' }),
      pax({ id: 'p13', fullName: '卫五', chineseName: '卫五', visaExempt: true }),
    ],
    items: [
      item(id, {
        id: 'f5-flight',
        kind: 'FLIGHT',
        quantity: 3,
        amount: 3000,
        flightCabin: 'ECONOMY',
        flightScheduleId: 'fs-f5-out',
        flightSchedule: {
          id: 'fs-f5-out',
          departureTime: D('2026-09-20T02:00:00.000'),
          departureTz: 'Asia/Macau',
          flight: { flightNumber: 'QH9589', originCode: 'MFM', destinationCode: 'DAD' },
        },
      }),
      item(id, { id: 'f5-visa', kind: 'VISA', quantity: 2, amount: 480, description: '越南电子签', visa: { supplier: '越签通' } }),
      item(id, { id: 'f5-selfvisa', kind: 'DISCOUNT', amount: -360, description: '自备签减免', metadata: { selfVisaDeduct: true } }),
    ],
  });
}

/** F6 除不尽：3333.33 / 2 人，已付清。 */
export function fixtureOddCents(): FixtureOrder {
  const id = 'f6';
  return order({
    id,
    orderNumber: 'FTM2026082000006',
    status: 'COMPLETED',
    agentId: AGENT_A.id,
    agent: AGENT_A,
    total: 3333.33,
    paidAmount: Dec(3333.33),
    createdAt: D('2026-08-25T01:00:00.000'),
    passengers: [
      pax({ id: 'p14', fullName: '蒋六', chineseName: '蒋六' }),
      pax({ id: 'p15', fullName: '沈七', chineseName: '沈七', gender: 'F' }),
    ],
    items: [
      leg(id, 'f6-out', '2026-09-21', true),
      item(id, { id: 'f6-bundle', kind: 'BUNDLE', quantity: 2, amount: 3333.33, description: '拆单后套餐', bundle: { items: [] } }),
    ],
  });
}

export function allFixtures(): FixtureOrder[] {
  return [
    fixtureMultiPax(),
    fixtureRefundedPartial(),
    fixtureSwapped(),
    fixtureRefundedFull(),
    fixtureVisaMixed(),
    fixtureOddCents(),
  ];
}

/** 已完成退款行（各查询侧 `refunds: { where: { status: 'COMPLETED' } }` 的等价形态）。 */
export function completedRefunds(o: FixtureOrder): Array<{ amount: Prisma.Decimal }> {
  return o.refunds.filter((r) => r.status === 'COMPLETED').map((r) => ({ amount: r.amount }));
}
