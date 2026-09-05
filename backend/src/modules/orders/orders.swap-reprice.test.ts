/**
 * 换人重算结算价 · 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 业务口径（2026-09 拍板，复审修正后）：差价之所以存在，唯一原因是**结算价日历在下单之后动了**，
 * 所以要拿日历比日历 —— 基准是「这张单成交那天的日历每人价」（basisCny，建单时落在 SETTLEMENT 行
 * 的 calendarPerPaxCny 上），对手方是「换人当天的日历每人价」（newSettlementCny）：
 *   delta = 新 − 基准 → 挂该乘客名下的 SWAP_REPRICE 调价行（进 total）；
 *   diff  = max(0, 基准 − 新) → 旧客留下的差价，与换人费一起记在**被换下去的那个人**头上。
 * 这单上其它任何一笔钱都不许动。
 *
 * 守恒不变式（每个用例都断言）：
 *   应收_after = 应收_before + feeCny + (新 − 基准) + diff
 *   其中 应收 = total + adjustmentCny。跌价 → 只多收 fee；涨价 → 多收 fee + 涨幅。
 *
 * 覆盖：
 *   1. 跌价 / 涨价 / 日历没动 / 跳过重算 四种情形的守恒 + 落行内容。
 *   2. 基准不是「这个人的每人份额」：单房差/杂费/整单议价揉进份额里也不影响差额。
 *   3. 跳过分支：结算价已锁 / 未配日历 / 散客单 / 非日历成交（NOT_CALENDAR_PRICED）/
 *      差额超上限（DIFF_OVER_CAP）/ 含非经济舱航段。
 *   4. 连续换人：第二次以第一次的 newSettlementCny 为基准（不重复计同一段差）。
 *   5. 换人费闸：未换人（只改名字）带换人费 → 400。
 *   6. 换人费档位（getSwapFeeOptions）与换人预览（swapPreview，含代理越权 403 与有效订单守卫）。
 *   7. 每人份额收口 + 换人后拆单：被换人的钱整条留在源单，留守同行人仍是 1000。
 *   8. 存量单基准取自**建单日历审计**（LEGACY_AUDIT，含加项/自备签减免不产生幽灵差价）。
 *   9. 金额一律取整（Order.adjustmentCny 是 Int 列）。
 *  10. 立减对称：基准减过才减换人当天的立减（手工价单不被平白多减一笔）。
 *  11. 拆单子单不重算（NOT_CALENDAR_PRICED）；佣金基数漂移留一条 WARNING 审计。
 *  12. 定价键：改档 / 改期后今天查的是日历上的另一格 → PRICING_KEY_CHANGED（先比键、再比价），
 *      键没记（灰度基准戳 / 上次换人行）一律 fail-closed；重算行把今天这一格的键留痕供接力。
 *  13. 拆单子单的闸挡在三级基准来源最前面：带着上次换人行搬过去的乘客同样不重算。
 *  14. 佣金计提读失败要响亮（不吞成「没计提」），delegate 没铺 / 零记录才当没计提。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettlementTier, UserRole, type Prisma } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    passenger: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    agent: { findMany: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    commissionRecord: { findMany: vi.fn() },
    fulfillmentTask: { updateMany: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    settlementRate: { findUnique: vi.fn() },
    settlementDiscountRule: { findMany: vi.fn() },
    flightSettlementRate: { findUnique: vi.fn() },
    systemSetting: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import {
  DEFAULT_SWAP_FEE_OPTIONS_CNY,
  getSwapFeeOptions,
  OrderService,
} from './orders.service.js';
import { perPaxSettlementByPassenger } from './orders.export-templates.js';
import { computePerPaxShares, spreadableAdjustmentCny } from './per-pax-share.js';

const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const dec = (n: number) => ({ toString: () => String(n) }) as unknown as Prisma.Decimal;

/**
 * 建单那次取价落在基准戳上的**定价键**（成交时是日历上的哪一格）。
 * 与 BUNDLE_ROW 的档次/晚数、FLIGHT_ROW 折出来的出发地本地日一致 —— 换人当天先比这把键，
 * 键变了（改档 / 改期）就不重算（PRICING_KEY_CHANGED）。
 */
const BUNDLE_KEY = {
  source: 'BUNDLE_SETTLEMENT_CALENDAR',
  tier: SettlementTier.CITY_4STAR,
  nights: 4,
  departDate: '2026-10-01',
} as const;
/** 纯机票单的定价键：逐航段「航班号 × 该段出发地本地日」。 */
const FLIGHT_KEY = {
  source: 'FLIGHT_SETTLEMENT_CALENDAR',
  legs: [{ flightNumber: 'QH9588', departDate: '2026-10-01' }],
} as const;

/** 建单落的日历基准戳所在的那条整单 SETTLEMENT 行（金额 = 日历价与系统价的差额）。 */
const SETTLEMENT_ROW = (opts: {
  amountCny?: number;
  calendarPerPaxCny?: number | null;
  calendarDiscountPerPaxCny?: number;
  /** 建单当时真的减了代理立减吗（复审 H3 的对称位）；缺省跟随 calendarDiscountPerPaxCny > 0。*/
  calendarDiscountApplied?: boolean;
  /**
   * 基准戳上的定价键；缺省 = 套餐键（BUNDLE_KEY）。
   * 传 null 模拟「只有价没有键」的行（换人当天判不出改没改档 → fail-closed）。
   */
  calendarKey?: Record<string, unknown> | null;
  settlementTotalCny?: number;
  perPassenger?: boolean;
}) => ({
  id: 'itm_settlement',
  kind: 'FEE',
  amount: dec(opts.amountCny ?? 0),
  description: '价格调整：代理结算价',
  passengerId: null,
  metadata: {
    priceAdjustment: true,
    reasonCode: 'SETTLEMENT',
    settlementPrice: true,
    settlementTotalCny: opts.settlementTotalCny ?? 3000,
    ...(opts.perPassenger ? { perPassenger: true } : {}),
    ...(opts.calendarPerPaxCny != null
      ? {
          calendarPerPaxCny: opts.calendarPerPaxCny,
          calendarDiscountPerPaxCny: opts.calendarDiscountPerPaxCny ?? 0,
          calendarDiscountApplied:
            opts.calendarDiscountApplied ?? (opts.calendarDiscountPerPaxCny ?? 0) > 0,
          ...(opts.calendarKey === null
            ? {}
            : { calendarKey: opts.calendarKey ?? BUNDLE_KEY }),
        }
      : {}),
  },
  quantity: 1,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  flightCabin: null,
  flightScheduleId: null,
  hotelCheckIn: null,
  visaIntendedDate: null,
  bundle: null,
  flightSchedule: null,
});

/** 一条基础套餐行（3 人、配了日历键）。 */
const BUNDLE_ROW = (amountCny = 3000, metadata: Record<string, unknown> | null = null) => ({
  id: 'itm_bundle',
  kind: 'BUNDLE',
  amount: dec(amountCny),
  description: '海岛5日套餐',
  passengerId: null,
  metadata,
  quantity: 3,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  flightCabin: null,
  flightScheduleId: null,
  hotelCheckIn: null,
  visaIntendedDate: null,
  bundle: { settlementTier: SettlementTier.CITY_4STAR, settlementNights: 4 },
  flightSchedule: null,
});

/** 一条去程航段行（同时用于派生整单出发日）。 */
const FLIGHT_ROW = (overrides: Record<string, unknown> = {}) => ({
  id: 'itm_flight',
  kind: 'FLIGHT',
  amount: dec(0),
  description: '去程 QH9588',
  passengerId: null,
  metadata: null,
  quantity: 3,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  flightCabin: 'ECONOMY',
  flightScheduleId: 'sch1',
  hotelCheckIn: null,
  visaIntendedDate: null,
  bundle: null,
  flightSchedule: {
    departureTime: new Date('2026-10-01T02:00:00.000Z'),
    departureTz: 'Asia/Shanghai',
    flight: { flightNumber: 'QH9588' },
  },
  ...overrides,
});

/** 上一次换人留下的重算行（连续换人取它当基准）。 */
const PRIOR_SWAP_ROW = (opts: {
  passengerId: string;
  newSettlementCny: number;
  amountCny: number;
  /** 上一次减没减立减（复审 H3 的接力位）；给 undefined 模拟「没记这一位」的行。 */
  discountApplied?: boolean;
  /** 上一次换人取的是哪一格（定价键接力位）；传 null 模拟「没记这一位」的行。 */
  calendarKey?: Record<string, unknown> | null;
}) => ({
  id: 'itm_prior_swap',
  kind: opts.amountCny > 0 ? 'FEE' : 'DISCOUNT',
  amount: dec(opts.amountCny),
  description: '价格调整：换人重算结算价',
  passengerId: opts.passengerId,
  metadata: {
    priceAdjustment: true,
    reasonCode: 'SWAP_REPRICE',
    swapReprice: true,
    newSettlementCny: opts.newSettlementCny,
    calendarDetail: {
      basisSource: 'CALENDAR_STAMP',
      ...(opts.discountApplied === undefined ? {} : { discountApplied: opts.discountApplied }),
      ...(opts.calendarKey === null ? {} : { calendarKey: opts.calendarKey ?? BUNDLE_KEY }),
    },
  },
  quantity: 1,
  createdAt: new Date('2026-08-20T00:00:00.000Z'),
  flightCabin: null,
  flightScheduleId: null,
  hotelCheckIn: null,
  visaIntendedDate: null,
  bundle: null,
  flightSchedule: null,
});

/** serializeOrder 跑得通的最小整单（事务后那次 findUniqueOrThrow）。 */
const fakeFullOrder = () => ({
  id: 'ord1',
  orderNumber: 'FTM2026090100001',
  userId: 'u1',
  agentId: 'agent-1',
  status: 'PAID',
  subtotal: dec(3000),
  taxesAndFees: dec(0),
  discountTotal: dec(0),
  total: dec(3000),
  paidAmount: dec(0),
  prepaymentOffset: dec(0),
  currency: 'CNY',
  contactName: 'X',
  contactPhone: 'Y',
  contactEmail: null,
  paymentExpiresAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  items: [],
  passengers: [],
  payments: [],
  refunds: [],
  statusEvents: [],
  agent: null,
  user: { id: 'u1', displayName: null, email: null },
});

interface MountOpts {
  items?: Array<{ amount: Prisma.Decimal }>;
  totalCny?: number;
  adjustmentCny?: number;
  adjustments?: unknown;
  settlementLocked?: boolean;
  agentId?: string | null;
  ratePerPersonCny?: number | null;
  flightRatePerPersonCny?: number | null;
  passengers?: Array<{ id: string; passengerType?: string }>;
  /** 本单拆出去过几次（splitsOut，源单侧）。 */
  splitCount?: number;
  /** 本单是拆出来的新单（splitsIn，子单侧）—— 三级基准来源一律不认（M4 不变式）。 */
  splitsInCount?: number;
  /**
   * 建单那条 APPLY_SETTLEMENT_TOTAL 审计里的 after.settlementCalendar blob（存量单基准来源）。
   * true = 给一份最简单的合法套餐日历快照（1000/人）；也可以直接传一个 blob 自己摆形状。
   */
  calendarAudit?: boolean | Record<string, unknown>;
  /** 换人当天的代理立减命中（settlementDiscountRule.findMany 的返回）。 */
  discountRules?: Array<Record<string, unknown>>;
  /** 本单已计提的佣金记录（M2 的佣金基数漂移审计）。 */
  commissionRecords?: Array<{ amount: number }>;
  orderStatus?: string;
  deletedAt?: Date | null;
}

/** 一份「口径明确」的建单日历审计快照：一条套餐行、每人 1000。 */
const LEGACY_CALENDAR_AUDIT = (opts: {
  pricePerPersonCny?: number;
  autoDiscountPerPersonCny?: number | null;
} = {}) => ({
  source: 'SETTLEMENT_CALENDAR',
  departDate: '2026-10-01',
  lines: [
    {
      bundleId: 'b1',
      tier: SettlementTier.CITY_4STAR,
      nights: 4,
      departDate: '2026-10-01',
      // 每人价原样躺在这里 —— 存量单基准直接读它，不再拿含加项的结算总价 ÷ 人数。
      pricePerPersonCny: opts.pricePerPersonCny ?? 1000,
      pax: 3,
      addOnCny: 0,
      lineTotalCny: (opts.pricePerPersonCny ?? 1000) * 3,
    },
  ],
  // 建单只在**真减了立减**时才写这个键（复审 H3 据此判断基准减没减）。
  ...(opts.autoDiscountPerPersonCny != null
    ? {
        autoDiscount: {
          hits: [
            {
              ruleId: 'rule-1',
              kind: 'AGENT',
              perPersonCny: opts.autoDiscountPerPersonCny,
              pax: 3,
            },
          ],
          pax: 3,
          totalCny: opts.autoDiscountPerPersonCny * 3,
        },
      }
    : {}),
})

/**
 * 装一个够 swapPassenger 跑完整条链的事务（tx 与 prisma 共用同一批 vi.fn()）。
 * orderItem.aggregate 按「既有行 + 本次新建的行」真算 Σ amount —— 断言重算后的 total 才有意义。
 */
function mountSwap(opts: MountOpts) {
  const items =
    opts.items ??
    ([
      BUNDLE_ROW(2700),
      SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: 1000 }),
      FLIGHT_ROW(),
    ] as unknown as Array<{ amount: Prisma.Decimal }>);
  const createdRows: Array<{ amount: unknown }> = [];

  mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(mockPrisma));
  mockPrisma.$queryRaw.mockResolvedValue([
    {
      id: 'ord1',
      adjustmentCny: opts.adjustmentCny ?? 0,
      adjustments: opts.adjustments ?? null,
      status: opts.orderStatus ?? 'PAID',
      deletedAt: opts.deletedAt ?? null,
      visaStatus: null,
      outboundInvoiced: false,
      returnInvoiced: false,
      systemInvoiced: false,
      settlementLocked: opts.settlementLocked === true,
    },
  ]);
  // 快照（buildSwapBeforeSnapshot）、取价（resolveSwapRepriceQuote）与预览的有效订单守卫
  // （复审 L5：status/deletedAt）共用这一条读。
  mockPrisma.order.findUnique.mockResolvedValue({
    agentId: opts.agentId === undefined ? 'agent-1' : opts.agentId,
    total: dec(opts.totalCny ?? 3000),
    adjustmentCny: opts.adjustmentCny ?? 0,
    adjustments: opts.adjustments ?? null,
    settlementLocked: opts.settlementLocked === true,
    status: opts.orderStatus ?? 'PAID',
    deletedAt: opts.deletedAt ?? null,
    passengers: opts.passengers ?? [{ id: 'pax-1' }, { id: 'pax-2' }, { id: 'pax-3' }],
    _count: { splitsIn: opts.splitsInCount ?? 0, splitsOut: opts.splitCount ?? 0 },
    items,
  });
  mockPrisma.passenger.findUnique.mockResolvedValue({
    id: 'pax-1',
    orderId: 'ord1',
    fullName: 'OLD/PERSON',
    documentNumber: 'OLD111',
    visaExempt: false,
    passengerType: 'ADULT',
    pnr: null,
    eticketNumber: null,
    chineseName: null,
    dateOfBirth: null,
    passportExpiry: null,
  });
  mockPrisma.passenger.findFirst.mockResolvedValue(null);
  mockPrisma.passenger.findMany.mockResolvedValue([]);
  mockPrisma.passenger.update.mockResolvedValue({});
  mockPrisma.passenger.findUniqueOrThrow.mockResolvedValue({
    fullName: 'NEW/PERSON',
    documentNumber: 'NEW999',
  });
  mockPrisma.orderItem.count.mockResolvedValue(0);
  mockPrisma.orderItem.findMany.mockResolvedValue([]);
  mockPrisma.orderItem.create.mockImplementation(async (args: { data: { amount: unknown } }) => {
    createdRows.push({ amount: args.data.amount });
    return { id: 'itm_reprice', ...(args.data as Record<string, unknown>) };
  });
  // Σ amount = 既有行 + 本次新建行（真算，不写死）。
  mockPrisma.orderItem.aggregate.mockImplementation(async () => ({
    _sum: {
      amount:
        items.reduce((sum, it) => sum + Number(it.amount.toString()), 0) +
        createdRows.reduce((sum, r) => sum + Number(String(r.amount)), 0),
    },
  }));
  mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.settlementRate.findUnique.mockResolvedValue(
    opts.ratePerPersonCny == null
      ? null
      : {
          id: 'r1',
          tier: SettlementTier.CITY_4STAR,
          nights: 4,
          departDate: new Date('2026-10-01T00:00:00.000Z'),
          pricePerPersonCny: opts.ratePerPersonCny,
          note: null,
          updatedBy: null,
          updatedAt: new Date('2026-09-05T00:00:00.000Z'),
        },
  );
  mockPrisma.flightSettlementRate.findUnique.mockResolvedValue(
    opts.flightRatePerPersonCny == null
      ? null
      : {
          id: 'fr1',
          flightNumber: 'QH9588',
          departDate: new Date('2026-10-01T00:00:00.000Z'),
          pricePerPersonCny: opts.flightRatePerPersonCny,
          note: null,
          updatedBy: null,
          updatedAt: new Date('2026-09-05T00:00:00.000Z'),
        },
  );
  mockPrisma.auditLog.findFirst.mockResolvedValue(
    opts.calendarAudit
      ? {
          after: {
            settlementCalendar:
              opts.calendarAudit === true ? LEGACY_CALENDAR_AUDIT() : opts.calendarAudit,
          },
        }
      : null,
  );
  mockPrisma.auditLog.create.mockResolvedValue({});
  mockPrisma.settlementDiscountRule.findMany.mockResolvedValue(opts.discountRules ?? []);
  mockPrisma.commissionRecord.findMany.mockResolvedValue(opts.commissionRecords ?? []);
  mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(fakeFullOrder());
  return {
    beforeTotalCny: opts.totalCny ?? 3000,
    beforeAdjustmentCny: opts.adjustmentCny ?? 0,
  };
}

/** 真换人请求（证件号变化 + 新人护照有效期）。 */
const swapBody = (feeCny?: number) => ({
  fullName: 'NEW PERSON',
  documentNumber: 'NEW999',
  passportExpiry: '2032-01-01',
  ...(feeCny != null ? { feeCny } : {}),
});

/** 取最后一次 order.update 的 data（换人的钱与总额合并写那一次）。 */
function lastOrderUpdateData(): Record<string, unknown> {
  const call = mockPrisma.order.update.mock.calls.at(-1) as
    | [{ data: Record<string, unknown> }]
    | undefined;
  return call?.[0]?.data ?? {};
}

/**
 * 守恒断言：应收_after == 应收_before + feeCny + (新 − 基准) + diff。
 * 没写 total 的那几次（跳过重算）说明总额没动，沿用换人前的值。
 */
function expectConserved(input: {
  beforeTotalCny: number;
  beforeAdjustmentCny: number;
  feeCny: number;
  deltaCny: number;
  diffCny: number;
}): void {
  const data = lastOrderUpdateData();
  const afterTotal = data.total != null ? Number(data.total) : input.beforeTotalCny;
  const afterAdjustment =
    data.adjustmentCny != null ? Number(data.adjustmentCny) : input.beforeAdjustmentCny;
  expect(afterTotal + afterAdjustment).toBe(
    input.beforeTotalCny + input.beforeAdjustmentCny + input.feeCny + input.deltaCny + input.diffCny,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('swapPassenger · 换人重算结算价（套餐日历，日历比日历）', () => {
  it('日历跌价 1000→800：−200 调价行挂新客名下 + 旧客补 200 差价 + 换人费 450 都挂被换人名下', async () => {
    // 成交那天的日历基准 1000/人（SETTLEMENT 行的 calendarPerPaxCny）；换人当天日历 800/人。
    const before = mountSwap({ totalCny: 3000, ratePerPersonCny: 800 });

    const { audit } = await new OrderService().swapPassenger(
      'ord1',
      'pax-1',
      swapBody(450),
      ADMIN,
    );

    // ① 调价行：挂在该乘客名下、金额 = 新价 − **基准** = −200、系统原因码 SWAP_REPRICE。
    expect(mockPrisma.orderItem.create).toHaveBeenCalledTimes(1);
    const row = mockPrisma.orderItem.create.mock.calls[0][0].data;
    expect(row.passengerId).toBe('pax-1');
    expect(Number(row.amount)).toBe(-200);
    expect(row.metadata).toMatchObject({
      priceAdjustment: true,
      reasonCode: 'SWAP_REPRICE',
      swapReprice: true,
      basisCny: 1000,
      newSettlementCny: 800,
      calendarSource: 'BUNDLE_SETTLEMENT_CALENDAR',
    });
    expect(String(row.description)).toContain('换人重算结算价');

    // ② 售后费流水：换人费 450 + 换人差价 200，都记被换下去的人、都不参与均摊。
    const data = lastOrderUpdateData();
    expect(data.adjustmentCny).toBe(650);
    const entries = data.adjustments as Array<Record<string, unknown>>;
    expect(entries.find((e) => e.type === 'SWAP_FEE')).toMatchObject({
      amountCny: 450,
      label: '换人费',
      passengerName: 'OLD/PERSON',
      passengerDocument: 'OLD111',
      excludeFromPerPax: true,
    });
    expect(entries.find((e) => e.type === 'SWAP_PRICE_DIFF')).toMatchObject({
      label: '换人差价',
      amountCny: 200,
      passengerName: 'OLD/PERSON',
      passengerDocument: 'OLD111',
      excludeFromPerPax: true,
    });
    // ③ 台账留痕：调价行也进 adjustments（PRICE_ADJUSTMENT 型只记账，不进 adjustmentCny）。
    const ledger = entries.find((e) => e.type === 'PRICE_ADJUSTMENT');
    expect(ledger).toMatchObject({
      amountCny: -200,
      reasonCode: 'SWAP_REPRICE',
      passengerId: 'pax-1',
    });
    expect(String(ledger?.label)).toContain('换人重算结算价');
    expect(ledger?.excludeFromPerPax).toBeUndefined();

    // ④ 总额随调价行重算（Σ 行金额）；⑤ 守恒：跌价时只多收换人费。
    expect(Number(data.total)).toBe(2800);
    expect(Number(data.subtotal)).toBe(2800);
    expectConserved({ ...before, feeCny: 450, deltaCny: -200, diffCny: 200 });

    // ⑥ 审计带基准与换人费。
    expect(audit.after.reprice).toMatchObject({
      basisCny: 1000,
      newSettlementCny: 800,
      diffCny: 200,
      feeCny: 450,
      repriceSkipped: null,
      itemAmountCny: -200,
    });
  });

  it('日历涨价 1000→1200：调价行 +200，差价为 0（不生成 SWAP_PRICE_DIFF）', async () => {
    const before = mountSwap({ totalCny: 3000, ratePerPersonCny: 1200 });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    const row = mockPrisma.orderItem.create.mock.calls[0][0].data;
    expect(Number(row.amount)).toBe(200);
    const data = lastOrderUpdateData();
    const entries = data.adjustments as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.type === 'SWAP_PRICE_DIFF')).toBe(false);
    expect(entries.filter((e) => e.type === 'SWAP_FEE')).toHaveLength(1);
    expect(Number(data.total)).toBe(3200);
    // 涨价：多收换人费 + 涨幅。
    expectConserved({ ...before, feeCny: 450, deltaCny: 200, diffCny: 0 });
  });

  it('日历没动（最常见）→ 不落任何调价行、不收差价，只收换人费', async () => {
    const before = mountSwap({ totalCny: 3000, ratePerPersonCny: 1000 });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
    const entries = lastOrderUpdateData().adjustments as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.type === 'SWAP_PRICE_DIFF')).toBe(false);
    expectConserved({ ...before, feeCny: 450, deltaCny: 0, diffCny: 0 });
  });

  it('基准是日历价、不是这个人的每人份额：单房差/杂费/议价揉进份额也不影响差额', async () => {
    // 整单 3600（比 3×1000 的日历价多 600 的单房差/加项），日历仍是 1000→1000：
    // 若拿每人份额（1200）当基准，会算出 −200 的「纠正」并多收 200 差价 —— 那是错的。
    const before = mountSwap({
      totalCny: 3600,
      ratePerPersonCny: 1000,
      items: [
        BUNDLE_ROW(3300, { addOns: { total: 600, singleCount: 1 } }),
        SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: 1000 }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
    const entries = lastOrderUpdateData().adjustments as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.type === 'SWAP_PRICE_DIFF')).toBe(false);
    expectConserved({ ...before, feeCny: 450, deltaCny: 0, diffCny: 0 });
  });

  it('带每人立减的基准：基准 = 日历价 − 每人立减，与换人当天同一算法', async () => {
    // 成交时日历 1100、每人立减 100 → 基准 1000；换人当天日历 1000、无立减 → 差额 0。
    const before = mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 1000,
      items: [
        BUNDLE_ROW(2700),
        SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: 1100, calendarDiscountPerPaxCny: 100 }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(0), ADMIN);

    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
    expectConserved({ ...before, feeCny: 0, deltaCny: 0, diffCny: 0 });
  });

  it('连续换人：第二次以第一次重取的价（800）为基准，不重复计同一段差', async () => {
    // 建单基准戳 1000；上次换人把这一位重算到 800（落了 −200 的行）；这次日历 900。
    // 接力对了 → 基准 800、delta +100、无差价；接力错了（拿回建单的 1000）→ delta −100 + 差价 100。
    // 两条路的账完全不同，这个用例才真的钉得住「基准接力」。
    const before = mountSwap({
      totalCny: 2800,
      ratePerPersonCny: 900,
      items: [
        BUNDLE_ROW(2700),
        SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: 1000 }),
        PRIOR_SWAP_ROW({
          passengerId: 'pax-1',
          newSettlementCny: 800,
          amountCny: -200,
          discountApplied: false,
        }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    const row = mockPrisma.orderItem.create.mock.calls[0][0].data;
    expect(row.metadata).toMatchObject({ basisCny: 800, newSettlementCny: 900 });
    expect((row.metadata as Record<string, unknown>).calendarDetail).toMatchObject({
      basisSource: 'PRIOR_SWAP',
      // 立减口径也一路接力下去（上一次没减 → 这一次也不减）。
      discountApplied: false,
    });
    expect(Number(row.amount)).toBe(100);
    const entries = lastOrderUpdateData().adjustments as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.type === 'SWAP_PRICE_DIFF')).toBe(false);
    expectConserved({ ...before, feeCny: 450, deltaCny: 100, diffCny: 0 });
  });
});

describe('swapPassenger · 跳过重算的分支（宁可不重算，也不算错）', () => {
  const skipCases: Array<{
    name: string;
    mount: () => { beforeTotalCny: number; beforeAdjustmentCny: number };
    expectNoCalendarRead?: boolean;
  }> = [
    {
      name: '结算价已锁（财务已按这个应收对过账）',
      mount: () => mountSwap({ totalCny: 3000, ratePerPersonCny: 800, settlementLocked: true }),
      expectNoCalendarRead: true,
    },
    {
      name: '散客单（无 agentId）不走同业结算价日历',
      mount: () => mountSwap({ totalCny: 3000, ratePerPersonCny: 800, agentId: null }),
      expectNoCalendarRead: true,
    },
    {
      name: '该出发日期未维护结算价',
      mount: () => mountSwap({ totalCny: 3000, ratePerPersonCny: null }),
    },
    {
      name: '手工结算价成交（SETTLEMENT 行无日历基准戳）→ NOT_CALENDAR_PRICED',
      mount: () =>
        mountSwap({
          totalCny: 3000,
          ratePerPersonCny: 800,
          items: [
            BUNDLE_ROW(2700),
            SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: null }),
            FLIGHT_ROW(),
          ] as unknown as Array<{ amount: Prisma.Decimal }>,
        }),
      expectNoCalendarRead: true,
    },
    {
      name: '按每人结算价成交（有 perPassenger 覆盖行）→ NOT_CALENDAR_PRICED',
      mount: () =>
        mountSwap({
          totalCny: 3000,
          ratePerPersonCny: 800,
          items: [
            BUNDLE_ROW(2700),
            SETTLEMENT_ROW({ amountCny: 200, calendarPerPaxCny: 1000 }),
            SETTLEMENT_ROW({ amountCny: 100, perPassenger: true }),
            FLIGHT_ROW(),
          ] as unknown as Array<{ amount: Prisma.Decimal }>,
        }),
      expectNoCalendarRead: true,
    },
    {
      name: '本单没有结算价收敛行（日历差额恰为 0，没落 SETTLEMENT 行）→ NOT_CALENDAR_PRICED',
      mount: () =>
        mountSwap({
          totalCny: 3000,
          ratePerPersonCny: 800,
          items: [BUNDLE_ROW(3000), FLIGHT_ROW()] as unknown as Array<{ amount: Prisma.Decimal }>,
        }),
      expectNoCalendarRead: true,
    },
    {
      name: '差额超出调价上限 → DIFF_OVER_CAP，不静默落一笔巨额调价',
      mount: () => mountSwap({ totalCny: 3000, ratePerPersonCny: 500_000 }),
    },
    {
      name: '含非经济舱航段（机票日历不分舱位）',
      mount: () =>
        mountSwap({
          totalCny: 2400,
          flightRatePerPersonCny: 700,
          items: [
            SETTLEMENT_ROW({ amountCny: 0, calendarPerPaxCny: 800, calendarKey: FLIGHT_KEY }),
            FLIGHT_ROW({ flightCabin: 'BUSINESS' }),
          ] as unknown as Array<{ amount: Prisma.Decimal }>,
        }),
    },
  ];

  it.each(skipCases)('$name → 只收换人费、不动结算价', async ({ mount, expectNoCalendarRead }) => {
    const before = mount();

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
    const data = lastOrderUpdateData();
    expect(data.total).toBeUndefined(); // 没重算就不动总额
    expect(data.adjustmentCny).toBe(450);
    expectConserved({ ...before, feeCny: 450, deltaCny: 0, diffCny: 0 });
    if (expectNoCalendarRead) {
      expect(mockPrisma.settlementRate.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.flightSettlementRate.findUnique).not.toHaveBeenCalled();
    }
  });

  it('只改名字（证件号没变）→ 根本不是换人，不触发重算', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800 });

    await new OrderService().swapPassenger('ord1', 'pax-1', { fullName: 'TYPO FIXED' }, ADMIN);

    expect(mockPrisma.settlementRate.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
  });

  it('只改名字却带换人费 → 400「未换人不能收取换人费」，一分钱不动', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800 });

    await expect(
      new OrderService().swapPassenger(
        'ord1',
        'pax-1',
        { fullName: 'TYPO FIXED', feeCny: 450 },
        ADMIN,
      ),
    ).rejects.toThrow('未换人不能收取换人费');
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });
});

/**
 * 存量单（2026-09 基准戳之前建的单）的基准来源 = 建单那条 APPLY_SETTLEMENT_TOTAL 审计里的
 * after.settlementCalendar blob，跑的是与建单当场盖章同一个 resolveCalendarPerPaxBasis
 * （每人价原样写在 lines[].pricePerPersonCny 上）。
 *
 * 复审 H1/H2 撤掉的旧口径是「settlementTotalCny ÷ 占座人数」：那个总价含单房差/升舱/婴儿价/
 * 儿童折扣/指定酒店加价/自备签减免，除出来既不是日历价、还会带小数写进 Int 列。
 */
describe('swapPassenger · 存量单基准取自建单日历审计（LEGACY_AUDIT）', () => {
  const legacySettlementRow = (settlementTotalCny = 3000) =>
    [
      BUNDLE_ROW(2700),
      SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: null, settlementTotalCny }),
      FLIGHT_ROW(),
    ] as unknown as Array<{ amount: Prisma.Decimal }>;

  it('有日历取价审计 → 基准 = 审计里的每人价 1000（不是结算总价 ÷ 人数）', async () => {
    const before = mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 800,
      items: legacySettlementRow(),
      calendarAudit: true,
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    const row = mockPrisma.orderItem.create.mock.calls[0][0].data;
    expect(row.metadata).toMatchObject({ basisCny: 1000, newSettlementCny: 800 });
    expect((row.metadata as Record<string, unknown>).calendarDetail).toMatchObject({
      basisSource: 'LEGACY_AUDIT',
    });
    expectConserved({ ...before, feeCny: 450, deltaCny: -200, diffCny: 200 });
  });

  /**
   * T2（复审点名）：**含加项 + 含自备签减免**的存量单，日历一分没动 → 一分钱都不该动。
   * 旧口径会拿「含加项的结算总价 4790 ÷ 3 人 ≈ 1596.67」当基准，凭空算出 −596.67 的「跌价」：
   * 旧客白补一笔差价，自备签减免还会被换人通道的 SWAP_VISA_DEDUCT_REVERSAL 再撤一次（双收），
   * 而且 1596.67 这个小数直接写进 Order.adjustmentCny（Int 列）会把整个换人事务打回 500。
   */
  it('存量单带加项与自备签减免、日历没动 → 零差额（旧的 ÷ 人数派生会算出幽灵差价）', async () => {
    const before = mountSwap({
      // 3×1000 日历价 + 单房差 900 + 升舱 1200 − 自备签减免 300 − 儿童折扣 10 = 4790
      totalCny: 4790,
      ratePerPersonCny: 1000,
      items: [
        BUNDLE_ROW(4490, {
          addOns: {
            total: 1790,
            singleCount: 1,
            selfProvidedVisaCount: 1,
            selfVisaDeductCny: 300,
          },
        }),
        SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: null, settlementTotalCny: 4790 }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
      calendarAudit: true,
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    // 日历比日历：1000 → 1000，不落调价行、不收换人差价，只收换人费。
    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
    const data = lastOrderUpdateData();
    const entries = data.adjustments as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.type === 'SWAP_PRICE_DIFF')).toBe(false);
    expect(data.adjustmentCny).toBe(450);
    expectConserved({ ...before, feeCny: 450, deltaCny: 0, diffCny: 0 });
  });

  it('审计里带 autoDiscount → 基准 = 每人价 − 每人立减，且换人当天照样减立减', async () => {
    // 建单：日历 1100、立减 100 → 基准 1000。换人当天：日历 1100、立减规则仍在 → 1000。差额 0。
    const before = mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 1100,
      items: legacySettlementRow(),
      calendarAudit: LEGACY_CALENDAR_AUDIT({
        pricePerPersonCny: 1100,
        autoDiscountPerPersonCny: 100,
      }),
      discountRules: [
        {
          id: 'rule-1',
          kind: 'AGENT',
          agentId: 'agent-1',
          discountPerPersonCny: 100,
          updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      ],
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(0), ADMIN);

    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
    expectConserved({ ...before, feeCny: 0, deltaCny: 0, diffCny: 0 });
  });

  const legacySkipCases: Array<{ name: string; mount: () => unknown }> = [
    {
      name: '无日历取价审计（手工结算总价成交）',
      mount: () =>
        mountSwap({
          totalCny: 3000,
          ratePerPersonCny: 800,
          items: legacySettlementRow(),
          calendarAudit: false,
        }),
    },
    {
      name: '拆过单（建单日历快照与当前订单构成对不上）',
      mount: () =>
        mountSwap({
          totalCny: 3000,
          ratePerPersonCny: 800,
          items: legacySettlementRow(),
          calendarAudit: true,
          splitCount: 1,
        }),
    },
    {
      name: '审计里多条套餐行（分不清这个人算哪一条）',
      mount: () =>
        mountSwap({
          totalCny: 3000,
          ratePerPersonCny: 800,
          items: legacySettlementRow(),
          calendarAudit: {
            source: 'SETTLEMENT_CALENDAR',
            lines: [
              { pricePerPersonCny: 1000, pax: 2 },
              { pricePerPersonCny: 1200, pax: 1 },
            ],
          },
        }),
    },
    {
      name: '审计里没有每人价（老格式 / 空 lines）',
      mount: () =>
        mountSwap({
          totalCny: 3000,
          ratePerPersonCny: 800,
          items: legacySettlementRow(),
          calendarAudit: { source: 'SETTLEMENT_CALENDAR', lines: [] },
        }),
    },
  ];

  it.each(legacySkipCases)('$name → NOT_CALENDAR_PRICED，只收换人费', async ({ mount }) => {
    mount();
    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);
    expect(preview.repriceSkipped).toBe('NOT_CALENDAR_PRICED');
    expect(preview.basisCny).toBeNull();
  });

  it('含婴儿不再是障碍：审计里的每人价与人数无关，照常重算', async () => {
    // 旧口径要拿总价 ÷ 占座人数，婴儿不占座就分不清除数，只能放弃；
    // 新口径直接读每人价，婴儿这道闸随 DERIVED_FROM_TOTAL 一起撤了。
    const before = mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 800,
      items: legacySettlementRow(),
      calendarAudit: true,
      passengers: [
        { id: 'pax-1', passengerType: 'ADULT' },
        { id: 'pax-2', passengerType: 'ADULT' },
        { id: 'pax-3', passengerType: 'INFANT' },
      ],
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    const row = mockPrisma.orderItem.create.mock.calls[0][0].data;
    expect(row.metadata).toMatchObject({ basisCny: 1000, newSettlementCny: 800 });
    expectConserved({ ...before, feeCny: 450, deltaCny: -200, diffCny: 200 });
  });
});

/**
 * H1（复审 BLOCK）：基准 / 新价 / 差额 / 差价全线**整数**。
 * diff 直接写进 Order.adjustmentCny —— 那是 Int 列，一个小数就让整个换人事务 500 回滚；
 * 调价行金额也跟着整数，免得订单上冒出「−¥199.67」这种没人解释得清的行。
 */
describe('swapPassenger · 金额一律取整（Order.adjustmentCny 是 Int 列）', () => {
  it('脏数据带小数的基准戳与日历价 → 落库的每一个数都是整数', async () => {
    const before = mountSwap({
      totalCny: 3000,
      // 脏数据：日历价带小数（正常 SettlementRate.pricePerPersonCny 是 Int）
      ratePerPersonCny: 800.4,
      items: [
        BUNDLE_ROW(2700),
        // 脏数据：基准戳与每人立减都带小数 → 基准 = round(1050.55 − 49.5) = round(1001.05) = 1001
        SETTLEMENT_ROW({
          amountCny: 300,
          calendarPerPaxCny: 1050.55,
          calendarDiscountPerPaxCny: 49.5,
        }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    const row = mockPrisma.orderItem.create.mock.calls[0][0].data;
    // 基准 1001、新价 800 → delta −201、diff 201，全是整数。
    expect(row.metadata).toMatchObject({ basisCny: 1001, newSettlementCny: 800 });
    expect(Number(row.amount)).toBe(-201);
    expect(Number.isInteger(Number(row.amount))).toBe(true);

    const data = lastOrderUpdateData();
    const entries = data.adjustments as Array<Record<string, unknown>>;
    const diffEntry = entries.find((e) => e.type === 'SWAP_PRICE_DIFF');
    expect(diffEntry?.amountCny).toBe(201);
    // ★ 这一条是 H1 的正题：写进 Int 列的值必须是整数，否则 Prisma 直接抛。
    expect(data.adjustmentCny).toBe(651);
    expect(Number.isInteger(data.adjustmentCny as number)).toBe(true);
    expectConserved({ ...before, feeCny: 450, deltaCny: -201, diffCny: 201 });
  });
});

/**
 * H3（复审 BLOCK）：立减在建单侧与换人侧必须同口径。
 * 建单只在「没有任何手工价通道」时才自动命中立减（hasManualSettlementChannel），
 * 换人侧若无条件再算一次今天的立减，手工价单的基准没减、今天减了 —— 差额里凭空多出一整笔立减。
 */
describe('swapPassenger · 立减对称（基准减过才减今天的立减）', () => {
  it('手工价通道成交（基准未减立减）+ 今天有生效的默认立减 → 日历没动就是零差额', async () => {
    const before = mountSwap({
      totalCny: 3000,
      // 换人当天日历价 1000，与基准戳的裸价一致（日历确实没动）。
      ratePerPersonCny: 1000,
      items: [
        BUNDLE_ROW(2700),
        // 建单走的是手工价通道 → calendarDiscountApplied=false、每人立减 0。
        SETTLEMENT_ROW({
          amountCny: 300,
          calendarPerPaxCny: 1000,
          calendarDiscountPerPaxCny: 0,
          calendarDiscountApplied: false,
        }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
      // 今天库里有一条生效中的默认立减 ¥100/人 —— 修复前会被无条件减掉，
      // 算出「日历跌了 100」，旧客白补 100 差价、新客的调价行凭空 −100。
      discountRules: [
        {
          id: 'rule-default',
          kind: 'AGENT_DEFAULT',
          agentId: null,
          discountPerPersonCny: 100,
          updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      ],
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    // 不落调价行、不收换人差价，只收换人费。
    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
    const data = lastOrderUpdateData();
    const entries = data.adjustments as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.type === 'SWAP_PRICE_DIFF')).toBe(false);
    expect(data.adjustmentCny).toBe(450);
    // 立减规则压根不该被查（基准没减过就不减今天的）。
    expect(mockPrisma.settlementDiscountRule.findMany).not.toHaveBeenCalled();
    expectConserved({ ...before, feeCny: 450, deltaCny: 0, diffCny: 0 });
  });

  it('日历自动取价成交（基准减过立减）+ 今天同一条规则还在 → 照减，仍是零差额', async () => {
    const before = mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 1100,
      items: [
        BUNDLE_ROW(2700),
        SETTLEMENT_ROW({
          amountCny: 300,
          calendarPerPaxCny: 1100,
          calendarDiscountPerPaxCny: 100,
          calendarDiscountApplied: true,
        }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
      discountRules: [
        {
          id: 'rule-1',
          kind: 'AGENT',
          agentId: 'agent-1',
          discountPerPersonCny: 100,
          updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      ],
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
    expect(mockPrisma.settlementDiscountRule.findMany).toHaveBeenCalled();
    expectConserved({ ...before, feeCny: 450, deltaCny: 0, diffCny: 0 });
  });

  it('上一次换人的重算行没记立减口径 → 不接力、不重算（fail-closed）', async () => {
    mountSwap({
      totalCny: 2800,
      ratePerPersonCny: 800,
      items: [
        BUNDLE_ROW(2700),
        SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: 1000 }),
        PRIOR_SWAP_ROW({ passengerId: 'pax-1', newSettlementCny: 800, amountCny: -200 }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);
    expect(preview.repriceSkipped).toBe('NOT_CALENDAR_PRICED');
    expect(preview.basisCny).toBeNull();
  });
});

/**
 * M4（复审拍板：维持现状 + 补一条守门测试）：**拆出来的新单不重算**。
 * 结算价收敛行（SETTLEMENT）整条留在源单（split-move-strategies 的 movePriceAdjustment 对
 * 无 passengerId 的调价行返回 NONE），所以拆单子单上压根没有基准 —— 判不出就不算，只收换人费。
 */
describe('swapPreview · 拆出来的新单（M4）', () => {
  it('拆单子单（无结算价收敛行）→ NOT_CALENDAR_PRICED，界面据此提示走人工调价', async () => {
    mountSwap({
      totalCny: 2000,
      ratePerPersonCny: 800,
      splitCount: 1,
      passengers: [{ id: 'pax-1' }, { id: 'pax-2' }],
      items: [
        BUNDLE_ROW(1800),
        // 拆单平账行：有 priceAdjustment 标，但**没有** settlementPrice / 日历基准戳。
        {
          id: 'itm_split',
          kind: 'FEE',
          amount: dec(200),
          description: '价格调整：拆单平账',
          passengerId: null,
          metadata: { priceAdjustment: true, reasonCode: 'SPLIT' },
          quantity: 1,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          flightCabin: null,
          flightScheduleId: null,
          hotelCheckIn: null,
          visaIntendedDate: null,
          bundle: null,
          flightSchedule: null,
        },
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.repriceSkipped).toBe('NOT_CALENDAR_PRICED');
    expect(preview.basisCny).toBeNull();
    expect(preview.newSettlementCny).toBeNull();
    expect(preview.diffCny).toBe(0);
    // 换人费档位照常给：拆单子单换得了人，只是不自动重算结算价。
    expect(preview.feeOptions).toEqual([...DEFAULT_SWAP_FEE_OPTIONS_CNY]);
  });
});

/**
 * M2（复审）：换人重算改了 total，而佣金按计提当时的价格基数一次算死、不回溯 ——
 * 与「改结算价」「改归属」两条路同一个 action 留一条 WARNING，财务能用一个筛选条件全捞出来。
 */
describe('swapPassenger · 佣金基数漂移留痕（M2）', () => {
  it('已计提佣金 + 重算真的改了 total → 写 SETTLEMENT_PRICE_CHANGED_AFTER_COMMISSION', async () => {
    mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 800,
      commissionRecords: [{ amount: 88 }, { amount: 12 }],
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    const audits = mockPrisma.auditLog.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    const drift = audits.find(
      (d) => d.action === 'SETTLEMENT_PRICE_CHANGED_AFTER_COMMISSION',
    );
    expect(drift).toBeDefined();
    expect(drift?.severity).toBe('WARNING');
    expect(drift?.before).toMatchObject({ accruedCommissionCny: 100 });
    expect(drift?.after).toMatchObject({ commissionRecalculated: false, passengerId: 'pax-1' });
  });

  it('日历没动（total 没改）→ 不写这条审计，别给财务制造噪音', async () => {
    mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 1000,
      commissionRecords: [{ amount: 88 }],
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    const audits = mockPrisma.auditLog.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(
      audits.some((d) => d.action === 'SETTLEMENT_PRICE_CHANGED_AFTER_COMMISSION'),
    ).toBe(false);
  });

  it('没计提过佣金 → 不写这条审计', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800, commissionRecords: [] });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    const audits = mockPrisma.auditLog.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(
      audits.some((d) => d.action === 'SETTLEMENT_PRICE_CHANGED_AFTER_COMMISSION'),
    ).toBe(false);
  });
});

describe('swapPassenger · 换人重算结算价（纯机票日历）', () => {
  const flightOnlyItems = () =>
    [
      SETTLEMENT_ROW({ amountCny: 2400, calendarPerPaxCny: 800, calendarKey: FLIGHT_KEY }),
      FLIGHT_ROW(),
    ] as unknown as Array<{ amount: Prisma.Decimal }>;

  it('逐段按「航班号 × 该段出发地本地日」取价求和', async () => {
    // 基准 800/人；换人当天机票日历 700/人 → 调价行 −100、差价 100。
    const before = mountSwap({
      totalCny: 2400,
      ratePerPersonCny: null,
      flightRatePerPersonCny: 700,
      items: flightOnlyItems(),
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(550), ADMIN);

    const row = mockPrisma.orderItem.create.mock.calls[0][0].data;
    expect(Number(row.amount)).toBe(-100);
    expect(row.metadata).toMatchObject({
      calendarSource: 'FLIGHT_SETTLEMENT_CALENDAR',
      basisCny: 800,
      newSettlementCny: 700,
    });
    // 出发日按出发地当地日折（UTC 10-01 02:00 + 8h = 当地 10-01）。
    expect(mockPrisma.flightSettlementRate.findUnique).toHaveBeenCalledWith({
      where: {
        flightNumber_departDate: {
          flightNumber: 'QH9588',
          departDate: new Date('2026-10-01T00:00:00.000Z'),
        },
      },
    });
    expectConserved({ ...before, feeCny: 550, deltaCny: -100, diffCny: 100 });
  });
});

describe('每人份额收口：换完之后谁付多少', () => {
  it('新客 = 重取的日历价 800；同行人仍是 1000，一分钱不替被换人背', () => {
    // 换人后的订单现场：3000 的套餐行 + 一条挂在 pax-1 名下的 −200 调价行，
    // 售后费 650（换人费 450 + 换人差价 200）都带 excludeFromPerPax。
    const settle = perPaxSettlementByPassenger({
      total: dec(2800),
      adjustmentCny: 650,
      adjustments: [
        { type: 'SWAP_FEE', label: '换人费', amountCny: 450, excludeFromPerPax: true },
        { type: 'SWAP_PRICE_DIFF', label: '换人差价', amountCny: 200, excludeFromPerPax: true },
        // 台账留痕（PRICE_ADJUSTMENT）不带 excludeFromPerPax、也不在 adjustmentCny 里，
        // 对份额不产生任何影响 —— 这里放进来就是为了钉住「它不会被扣第二次」。
        {
          type: 'PRICE_ADJUSTMENT',
          label: '价格调整：换人重算结算价（−¥200）',
          amountCny: -200,
          reasonCode: 'SWAP_REPRICE',
        },
      ],
      passengers: [{ id: 'pax-1' }, { id: 'pax-2' }, { id: 'pax-3' }],
      items: [
        { id: 'i0', amount: dec(3000), description: '套餐', passengerId: null, metadata: null },
        {
          id: 'i1',
          amount: dec(-200),
          description: '价格调整：换人重算结算价（−¥200）',
          passengerId: 'pax-1',
          metadata: { priceAdjustment: true, reasonCode: 'SWAP_REPRICE' },
        },
      ],
    });
    expect(settle.get('pax-1')).toBe(800);
    expect(settle.get('pax-2')).toBe(1000);
    expect(settle.get('pax-3')).toBe(1000);
  });

  it('换人后拆单：被换人的钱整条留源单，留守同行人份额仍是 1000', () => {
    // 复审场景：T=3000、3 人、售后费 650 全是排除条目、拆出 2 人。
    const order = {
      total: 3000,
      adjustmentCny: 650,
      adjustments: [
        { type: 'SWAP_FEE', amountCny: 450, excludeFromPerPax: true },
        { type: 'SWAP_PRICE_DIFF', amountCny: 200, excludeFromPerPax: true },
      ],
    };
    const spreadable = spreadableAdjustmentCny(order);
    expect(spreadable).toBe(0);

    const { rows, payableCny } = computePerPaxShares({
      totalCny: order.total,
      adjustmentCny: spreadable,
      passengerIds: ['pax-1', 'pax-2', 'pax-3'],
      netByPassenger: new Map(),
    });
    expect(rows.map((r) => r.shareCny)).toEqual([1000, 1000, 1000]);

    // 拆出 pax-2 / pax-3：份额比 = 2000/3000，但**可摊**售后费是 0 → 一分钱都不随拆走。
    const movedShareCny = 2000;
    const shareRatio = movedShareCny / payableCny;
    const movedAdjustmentCny = Math.round(spreadable * shareRatio);
    expect(movedAdjustmentCny).toBe(0);

    const targetTotalCny = movedShareCny - movedAdjustmentCny;
    const keptAdjustmentCny = order.adjustmentCny - movedAdjustmentCny;
    const keptTotalCny = order.total - targetTotalCny;
    // 新单：2000 / 2 人 = 1000；源单：1000 + 排除条目 650 整条留下 → 留守 1 人仍是 1000。
    expect(targetTotalCny).toBe(2000);
    expect(keptTotalCny).toBe(1000);
    expect(keptAdjustmentCny).toBe(650);
    expect(
      computePerPaxShares({
        totalCny: keptTotalCny,
        adjustmentCny: spreadableAdjustmentCny({
          adjustmentCny: keptAdjustmentCny,
          adjustments: order.adjustments,
        }),
        passengerIds: ['pax-1'],
        netByPassenger: new Map(),
      }).rows[0].shareCny,
    ).toBe(1000);
    // 两侧 Σ adjustmentCny 恒等（拆单守恒断言的口径）。
    expect(movedAdjustmentCny + keptAdjustmentCny).toBe(order.adjustmentCny);
  });
});

describe('getSwapFeeOptions · 换人费档位', () => {
  beforeEach(() => {
    mockPrisma.systemSetting.findUnique.mockReset();
  });

  it('无配置 → 缺省两档', async () => {
    mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
    expect(await getSwapFeeOptions(mockPrisma as never)).toEqual([...DEFAULT_SWAP_FEE_OPTIONS_CNY]);
  });

  it('读配置（逗号分隔整数，允许空格）', async () => {
    mockPrisma.systemSetting.findUnique.mockResolvedValue({ value: '450, 550, 600' });
    expect(await getSwapFeeOptions(mockPrisma as never)).toEqual([450, 550, 600]);
  });

  it('脏值 / 读失败 → 回落缺省（档位只是预填建议，绝不因它拦住换人）', async () => {
    mockPrisma.systemSetting.findUnique.mockResolvedValue({ value: 'abc, -1, 1e9' });
    expect(await getSwapFeeOptions(mockPrisma as never)).toEqual([...DEFAULT_SWAP_FEE_OPTIONS_CNY]);
    mockPrisma.systemSetting.findUnique.mockRejectedValue(new Error('db down'));
    expect(await getSwapFeeOptions(mockPrisma as never)).toEqual([...DEFAULT_SWAP_FEE_OPTIONS_CNY]);
  });
});

describe('swapPreview · 换人预览（只读，与真换人同一取价内核）', () => {
  it('回包基准 / 旧份额 / 新日历价 / 差价 / 取价来源 / 锁状态 / 换人费档位', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800 });
    mockPrisma.systemSetting.findUnique.mockResolvedValue({ value: '450,550' });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview).toEqual({
      basisCny: 1000,
      oldShareCny: 1000,
      newSettlementCny: 800,
      diffCny: 200,
      calendarSource: 'BUNDLE_SETTLEMENT_CALENDAR',
      settlementLocked: false,
      feeOptions: [450, 550],
    });
  });

  it('取不到价 → newSettlementCny=null + repriceSkipped，界面据此提示走人工调价', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: null });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.newSettlementCny).toBeNull();
    expect(preview.diffCny).toBe(0);
    expect(preview.repriceSkipped).toBe('NO_CALENDAR');
    // 基准取得到（有日历基准戳），只是今天没价 —— 界面能照实说清是哪一头缺。
    expect(preview.basisCny).toBe(1000);
    expect(preview.oldShareCny).toBe(1000);
  });

  it('客户角色 → 403（预览是运营/代理之间的口径）', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800 });
    await expect(
      new OrderService().swapPreview('ord1', 'pax-1', {
        userId: 'c1',
        role: UserRole.CUSTOMER,
      }),
    ).rejects.toThrow('仅运营/代理可查看换人预览');
  });

  it('代理看别人家的单 → 403（归属闸与换人同一口径）', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800 });
    // 归属闸走 prisma.order.findUnique 读 agentId + 代理树（$queryRaw）。
    mockPrisma.order.findUnique.mockResolvedValueOnce({ id: 'ord1', agentId: 'agent-other' });
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'agent-mine' }]);

    await expect(
      new OrderService().swapPreview('ord1', 'pax-1', {
        userId: 'u-agent',
        role: UserRole.AGENT,
        agentId: 'agent-mine',
      }),
    ).rejects.toThrow();
    expect(mockPrisma.settlementRate.findUnique).not.toHaveBeenCalled();
  });

  it('乘客不属于本单 → 404', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800 });
    mockPrisma.passenger.findUnique.mockResolvedValue({ id: 'pax-1', orderId: 'other' });
    await expect(new OrderService().swapPreview('ord1', 'pax-1', ADMIN)).rejects.toThrow(
      '出行人不存在或不属于该订单',
    );
  });

  // ── 有效订单守卫：与真换人同一对闸、同一句话（复审 L5）────────────────────────
  // 预览若不判，回收站单/已取消单照样弹出一份「新价 800、旧客补 200」的报价，
  // 经办人填完点确认才被写入口拒掉 —— 白填一遍，还会以为这单本来就该这么算。
  it('回收站单 → 400，与真换人同一句话，且不去查日历', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800, deletedAt: new Date() });
    await expect(new OrderService().swapPreview('ord1', 'pax-1', ADMIN)).rejects.toThrow(
      '订单在回收站（已软删），不可换人；如需操作请先恢复',
    );
    expect(mockPrisma.settlementRate.findUnique).not.toHaveBeenCalled();
  });

  it('已取消单 → 400，与真换人同一句话，且不去查日历', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800, orderStatus: 'CANCELLED' });
    await expect(new OrderService().swapPreview('ord1', 'pax-1', ADMIN)).rejects.toThrow(
      '不可换人：仅占座中的有效订单可换人',
    );
    expect(mockPrisma.settlementRate.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * T1（复审点名）：换进来的新客保住**这一位自己的**按人加项净额。
 * 换人只在这位乘客名下加一条 SWAP_REPRICE 差额行，原来挂在他名下的单房差行原样留着 ——
 * 新客的每人结算价 = 均摊 + 单房差 + 日历差额，不是「被重置成日历价」。
 */
describe('每人份额收口 · 换进来的新客保住自己的加项（T1）', () => {
  it('单住的那一位换人：单房差 600 还在，只叠加日历差额 −200', () => {
    const settle = perPaxSettlementByPassenger({
      // 换人后：套餐 3000 + 单房差 600（挂 pax-1）+ 重算行 −200（挂 pax-1）= 3400
      total: dec(3400),
      adjustmentCny: 650,
      adjustments: [
        { type: 'SWAP_FEE', label: '换人费', amountCny: 450, excludeFromPerPax: true },
        { type: 'SWAP_PRICE_DIFF', label: '换人差价', amountCny: 200, excludeFromPerPax: true },
      ],
      passengers: [{ id: 'pax-1' }, { id: 'pax-2' }, { id: 'pax-3' }],
      items: [
        { id: 'i0', amount: dec(3000), description: '套餐', passengerId: null, metadata: null },
        {
          id: 'i1',
          amount: dec(600),
          description: '价格调整：单房差（+¥600）',
          passengerId: 'pax-1',
          metadata: { priceAdjustment: true, reasonCode: 'ROOM_SUPPLEMENT' },
        },
        {
          id: 'i2',
          amount: dec(-200),
          description: '价格调整：换人重算结算价（−¥200）',
          passengerId: 'pax-1',
          metadata: { priceAdjustment: true, reasonCode: 'SWAP_REPRICE' },
        },
      ],
    });
    // 新客：均摊 1000 + 单房差 600 − 日历跌价 200 = 1400（单房差一分没丢）。
    expect(settle.get('pax-1')).toBe(1400);
    // 同行人一分钱不替被换人背（换人费与换人差价都不摊）。
    expect(settle.get('pax-2')).toBe(1000);
    expect(settle.get('pax-3')).toBe(1000);
    // 全员合计 = 可摊应收（3400 + 0）。
    expect(
      (settle.get('pax-1') ?? 0) + (settle.get('pax-2') ?? 0) + (settle.get('pax-3') ?? 0),
    ).toBe(3400);
  });
});

/**
 * 定价键（PRICING_KEY_CHANGED）：改档 / 改期之后，「今天的日历价」查的已经是**另一格**。
 *
 * 换人重算的整套算式只有在「同一格的今昔两价」之间才成立 —— 那个差额才叫「日历动了多少」。
 * 套餐改档换了 bundleId（档次/晚数变了）、改期把出发日挪走（行价按设计冻结、差额另有调价行收），
 * 两者都已经各自收过一次钱；再拿新格的价去减老格的基准，等于把同一笔差额收第二遍。
 * 故基准戳连定价键一起盖章，换人当天**先比键、再比价**：键变了就不重算，只收换人费。
 */
describe('swapPreview · 定价键变了就不重算（PRICING_KEY_CHANGED）', () => {
  /** 改档后的现场：套餐行已重绑到五星（基准戳仍是成交那天的四星）。 */
  const upgradedBundleItems = () =>
    [
      {
        ...BUNDLE_ROW(2700),
        bundle: { settlementTier: SettlementTier.CITY_5STAR, settlementNights: 4 },
      },
      SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: 1000 }),
      FLIGHT_ROW(),
    ] as unknown as Array<{ amount: Prisma.Decimal }>;

  it('套餐改档（四星→五星）后换人 → PRICING_KEY_CHANGED，且根本不去查日历', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800, items: upgradedBundleItems() });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.repriceSkipped).toBe('PRICING_KEY_CHANGED');
    expect(preview.newSettlementCny).toBeNull();
    expect(preview.diffCny).toBe(0);
    // 基准本身取得到（基准戳还在），只是它跟今天这一格不是同一格 —— 界面能照实说清原因。
    expect(preview.basisCny).toBe(1000);
    // 比键在查价之前：键不对就不该再去日历上取一个用不上的价。
    expect(mockPrisma.settlementRate.findUnique).not.toHaveBeenCalled();
  });

  it('改档后真换人 → 只收换人费，不落重算行、不动结算价', async () => {
    const before = mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 800,
      items: upgradedBundleItems(),
    });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
    expectConserved({ ...before, feeCny: 450, deltaCny: 0, diffCny: 0 });
  });

  it('改期（出发日 10-01 → 11-01）后换人 → PRICING_KEY_CHANGED', async () => {
    mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 800,
      items: [
        BUNDLE_ROW(2700),
        SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: 1000 }),
        FLIGHT_ROW({
          flightSchedule: {
            departureTime: new Date('2026-11-01T02:00:00.000Z'),
            departureTz: 'Asia/Shanghai',
            flight: { flightNumber: 'QH9588' },
          },
        }),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.repriceSkipped).toBe('PRICING_KEY_CHANGED');
    expect(preview.basisCny).toBe(1000);
    expect(mockPrisma.settlementRate.findUnique).not.toHaveBeenCalled();
  });

  it('纯机票单改期（航段挪到 11-01）后换人 → PRICING_KEY_CHANGED，且不去查机票日历', async () => {
    mountSwap({
      totalCny: 2400,
      ratePerPersonCny: null,
      flightRatePerPersonCny: 700,
      items: [
        SETTLEMENT_ROW({ amountCny: 2400, calendarPerPaxCny: 800, calendarKey: FLIGHT_KEY }),
        FLIGHT_ROW({
          flightSchedule: {
            departureTime: new Date('2026-11-01T02:00:00.000Z'),
            departureTz: 'Asia/Shanghai',
            flight: { flightNumber: 'QH9588' },
          },
        }),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.repriceSkipped).toBe('PRICING_KEY_CHANGED');
    expect(preview.basisCny).toBe(800);
    expect(mockPrisma.flightSettlementRate.findUnique).not.toHaveBeenCalled();
  });

  it('键没变（还是同一格）→ 照常按日历重算，与加键之前一模一样', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800 });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.repriceSkipped).toBeUndefined();
    expect(preview.basisCny).toBe(1000);
    expect(preview.newSettlementCny).toBe(800);
    expect(preview.diffCny).toBe(200);
  });

  it('重算行把今天这一格的键留痕 → 下一次换人才比得出这之后有没有改档/改期', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800 });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    const row = mockPrisma.orderItem.create.mock.calls[0][0].data;
    expect(row.metadata.calendarDetail).toMatchObject({
      calendarKey: {
        source: 'BUNDLE_SETTLEMENT_CALENDAR',
        tier: SettlementTier.CITY_4STAR,
        nights: 4,
        departDate: '2026-10-01',
      },
    });
  });

  it('基准戳只有价、没有定价键（灰度行）→ 判不出改没改档，fail-closed 不重算', async () => {
    mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 800,
      items: [
        BUNDLE_ROW(2700),
        SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: 1000, calendarKey: null }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.repriceSkipped).toBe('NOT_CALENDAR_PRICED');
    expect(preview.basisCny).toBeNull();
  });

  it('上一次换人的重算行没记定价键 → 不接力、不重算（fail-closed）', async () => {
    mountSwap({
      totalCny: 2800,
      ratePerPersonCny: 800,
      items: [
        BUNDLE_ROW(2700),
        SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: 1000 }),
        PRIOR_SWAP_ROW({
          passengerId: 'pax-1',
          newSettlementCny: 800,
          amountCny: -200,
          discountApplied: false,
          calendarKey: null,
        }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.repriceSkipped).toBe('NOT_CALENDAR_PRICED');
    expect(preview.basisCny).toBeNull();
  });

  it('换过人之后又改了档 → 接力基准的键与今天对不上，同样 PRICING_KEY_CHANGED', async () => {
    mountSwap({
      totalCny: 2800,
      ratePerPersonCny: 800,
      items: [
        {
          ...BUNDLE_ROW(2700),
          bundle: { settlementTier: SettlementTier.CITY_5STAR, settlementNights: 4 },
        },
        SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: 1000 }),
        PRIOR_SWAP_ROW({
          passengerId: 'pax-1',
          newSettlementCny: 800,
          amountCny: -200,
          discountApplied: false,
        }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.repriceSkipped).toBe('PRICING_KEY_CHANGED');
    // 接力到的基准是上一次换人重取的 800（不是建单那次的 1000）。
    expect(preview.basisCny).toBe(800);
  });

  it('存量单（LEGACY_AUDIT）：建单快照那一格与今天不是同一格 → PRICING_KEY_CHANGED', async () => {
    mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 800,
      // 没有基准戳 → 回建单审计取基准；审计记的是四星，今天这单已经是五星。
      items: [
        {
          ...BUNDLE_ROW(2700),
          bundle: { settlementTier: SettlementTier.CITY_5STAR, settlementNights: 4 },
        },
        SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: null }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
      calendarAudit: true,
    });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.repriceSkipped).toBe('PRICING_KEY_CHANGED');
    expect(preview.basisCny).toBe(1000);
  });
});

/**
 * M4 不变式补漏：**拆出来的新单不重算**这条闸必须挡在三级基准来源的最前面。
 * 按人挂的调价行会随人搬家 —— 「换过人之后又被拆出去」的乘客带着他名下那条 SWAP_REPRICE 行
 * 进了新单，闸若只摆在存量单那一级门口，第 1 级（PRIOR_SWAP）照样接力、照样重算。
 */
describe('swapPreview · 拆单子单一律不重算（含带着上次换人行搬过去的乘客）', () => {
  it('子单里这位乘客带着 SWAP_REPRICE 行 → 仍不接力、不重算', async () => {
    mountSwap({
      totalCny: 2800,
      ratePerPersonCny: 800,
      splitsInCount: 1,
      passengers: [{ id: 'pax-1' }, { id: 'pax-2' }],
      items: [
        BUNDLE_ROW(2700),
        PRIOR_SWAP_ROW({
          passengerId: 'pax-1',
          newSettlementCny: 800,
          amountCny: -200,
          discountApplied: false,
        }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.repriceSkipped).toBe('NOT_CALENDAR_PRICED');
    expect(preview.basisCny).toBeNull();
    expect(mockPrisma.settlementRate.findUnique).not.toHaveBeenCalled();
  });

  it('子单里连基准戳都随源单行搬了过来 → 照样不重算', async () => {
    mountSwap({
      totalCny: 3000,
      ratePerPersonCny: 800,
      splitsInCount: 1,
      items: [
        BUNDLE_ROW(2700),
        SETTLEMENT_ROW({ amountCny: 300, calendarPerPaxCny: 1000 }),
        FLIGHT_ROW(),
      ] as unknown as Array<{ amount: Prisma.Decimal }>,
    });

    const preview = await new OrderService().swapPreview('ord1', 'pax-1', ADMIN);

    expect(preview.repriceSkipped).toBe('NOT_CALENDAR_PRICED');
    expect(preview.basisCny).toBeNull();
  });
});

/**
 * 佣金读失败不吞（sumAccruedCommissionCny）：它是「要不要留佣金基数漂移 WARNING」的唯一判据。
 * 把查询异常吞成 null 等于在真出错时静默宣布「本单没计提过佣金」—— 该留的审计不留，
 * 财务事后对不上账也翻不出是哪一步动的。delegate 压根没铺 / 一条都没有才返回 null。
 */
describe('佣金计提读取 · 查询失败要响亮（不吞成「没计提」）', () => {
  it('commissionRecord 查询抛错 → 整个换人事务跟着抛，不静默落一条无审计的重算', async () => {
    mountSwap({ totalCny: 3000, ratePerPersonCny: 800 });
    mockPrisma.commissionRecord.findMany.mockRejectedValue(new Error('db down'));

    await expect(
      new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN),
    ).rejects.toThrow('db down');
  });

  it('一条计提记录都没有 → null（当「没计提」，换人照常走完）', async () => {
    const before = mountSwap({ totalCny: 3000, ratePerPersonCny: 800, commissionRecords: [] });

    await new OrderService().swapPassenger('ord1', 'pax-1', swapBody(450), ADMIN);

    expectConserved({ ...before, feeCny: 450, deltaCny: -200, diffCny: 200 });
    // 没计提过 → 不留佣金基数漂移的 WARNING。
    const commissionAudits = mockPrisma.auditLog.create.mock.calls.filter(
      (call: [{ data: { action?: string } }]) =>
        call[0]?.data?.action === 'SETTLEMENT_PRICE_CHANGED_AFTER_COMMISSION',
    );
    expect(commissionAudits).toHaveLength(0);
  });
});
