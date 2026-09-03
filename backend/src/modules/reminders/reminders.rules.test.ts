/**
 * 规则化自动生成提醒 · 单元测试
 *
 * 覆盖：
 *   1. 出发时间推导：机票最早段（含班次时区取当地日期）优先，无机票回落酒店入住日
 *   2. 尾款口径：total + adjustmentCny − paidAmount − prepaymentOffset；金额去尾零
 *   3. 四条规则的窗口/优先级/文案（buildOrderCandidates / buildVisaCandidates 纯函数）
 *   4. ruleKey 幂等：generateRuleReminders 跑两遍，第二遍 created = 0
 */
import { describe, it, expect, vi } from 'vitest';
import { OrderStatus, Prisma, ReminderPriority, type PrismaClient } from '@prisma/client';
import {
  addDaysUtc,
  addMonthsUtc,
  buildNoShowReturnReleasedCandidates,
  buildOrderCandidates,
  buildHoldInstallmentCandidates,
  buildRandomTierShortfallCandidates,
  buildReceiptVerifyCandidates,
  buildVisaCandidates,
  buildVisaSubmissionCandidates,
  computeBalance,
  dateInTz,
  deriveDepartureDate,
  formatAmount,
  generateRuleReminders,
  hasRoomAssignment,
  utcDateStr,
  type RuleOrder,
  type RuleReleasedReturnLeg,
} from './reminders.rules.js';
import type { RandomTierShortfallReport } from '../hotel-control/hotel-control.shortfall.js';
import { HoldInstallmentStatus, HoldOrderStatus } from '@prisma/client';
import { businessDateISO } from '../../lib/business-time.js';

// ── 测试数据小工具 ─────────────────────────────────────────────────────────
const TODAY = '2026-07-09';

function flightItem(departISO: string, tz: string | null = null) {
  return {
    hotelCheckIn: null,
    flightSchedule: { departureTime: new Date(departISO), departureTz: tz },
  };
}

function hotelItem(checkIn: string) {
  return { hotelCheckIn: new Date(`${checkIn}T00:00:00Z`), flightSchedule: null };
}

describe('HOLD_INSTALLMENT_DUE 提醒规则', () => {
  it('三天内 HIGH、已逾期 CRITICAL，ruleKey 按期号和截止日幂等', () => {
    const candidates = buildHoldInstallmentCandidates({
      id: 'h1', holdNo: 'H20260824AB12', groupName: '春季团', status: HoldOrderStatus.HOLDING,
      installments: [
        { id: 'i1', label: '尾款', amountCny: 7000, status: HoldInstallmentStatus.PENDING, dueDate: new Date('2026-07-10T00:00:00Z') },
        { id: 'i2', label: '二定', amountCny: 3000, status: HoldInstallmentStatus.PENDING, dueDate: new Date('2026-07-05T00:00:00Z') },
        { id: 'i3', label: '已认', amountCny: 1, status: HoldInstallmentStatus.PAID, dueDate: new Date('2026-07-10T00:00:00Z') },
      ],
    }, TODAY);
    expect(candidates).toHaveLength(2);
    expect(candidates.find((item) => item.ruleKey.startsWith('HOLD_DUE:i1'))).toMatchObject({ priority: ReminderPriority.HIGH });
    expect(candidates.find((item) => item.ruleKey.startsWith('HOLD_DUE:i2'))).toMatchObject({ priority: ReminderPriority.CRITICAL, ruleKey: 'HOLD_DUE:i2:2026-07-05' });
  });
});

function fakeOrder(overrides: Partial<RuleOrder> = {}): RuleOrder {
  return {
    id: 'ord_1',
    orderNumber: 'FTM2026070900001',
    contactName: '测试联系人',
    status: OrderStatus.PAID,
    total: new Prisma.Decimal('5000'),
    paidAmount: new Prisma.Decimal('2000'),
    prepaymentOffset: new Prisma.Decimal('0'),
    adjustmentCny: 0,
    items: [flightItem('2026-07-15T02:00:00Z')],
    passengers: [],
    ...overrides,
  };
}

// ── 出发时间推导 ────────────────────────────────────────────────────────────
describe('deriveDepartureDate', () => {
  it('取最早一段机票的出发日', () => {
    const date = deriveDepartureDate([
      flightItem('2026-07-20T02:00:00Z'),
      flightItem('2026-07-15T08:00:00Z'),
    ]);
    expect(date).toBe('2026-07-15');
  });

  it('按班次时区取当地日期（UTC 前一天深夜 = 当地次日凌晨）', () => {
    // UTC 2026-07-14 17:30 = 北京时间 2026-07-15 01:30
    const date = deriveDepartureDate([flightItem('2026-07-14T17:30:00Z', 'Asia/Shanghai')]);
    expect(date).toBe('2026-07-15');
  });

  it('非法时区回落 UTC 日期', () => {
    const date = deriveDepartureDate([flightItem('2026-07-14T17:30:00Z', 'Not/AZone')]);
    expect(date).toBe('2026-07-14');
  });

  it('无机票回落最早酒店入住日；两者皆无为 null', () => {
    expect(deriveDepartureDate([hotelItem('2026-07-18'), hotelItem('2026-07-16')])).toBe(
      '2026-07-16',
    );
    expect(deriveDepartureDate([])).toBeNull();
  });

  it('有机票时机票优先（即使酒店入住更早）', () => {
    const date = deriveDepartureDate([hotelItem('2026-07-10'), flightItem('2026-07-15T02:00:00Z')]);
    expect(date).toBe('2026-07-15');
  });
});

// ── 尾款口径 + 金额格式 ─────────────────────────────────────────────────────
describe('computeBalance / formatAmount', () => {
  it('尾款 = total + adjustmentCny − paidAmount − prepaymentOffset', () => {
    const balance = computeBalance({
      total: new Prisma.Decimal('5000'),
      adjustmentCny: 300,
      paidAmount: new Prisma.Decimal('2000'),
      prepaymentOffset: new Prisma.Decimal('500'),
    });
    expect(balance.toString()).toBe('2800');
  });

  it('金额展示保留两位小数并去尾零', () => {
    expect(formatAmount(new Prisma.Decimal('1234.00'))).toBe('1234');
    expect(formatAmount(new Prisma.Decimal('1234.50'))).toBe('1234.5');
    expect(formatAmount(new Prisma.Decimal('1234.56'))).toBe('1234.56');
    // 两位之外四舍五入
    expect(formatAmount(new Prisma.Decimal('0.005'))).toBe('0.01');
  });
});

// ── 规则 1：催尾款 ──────────────────────────────────────────────────────────
describe('BALANCE_DUE', () => {
  it('14 天内出发且尾款 > 0 → 生成；≤3 天 CRITICAL，否则 HIGH', () => {
    const far = buildOrderCandidates(
      fakeOrder({ items: [flightItem('2026-07-20T02:00:00Z')] }), // 11 天后
      TODAY,
    ).filter((c) => c.rule === 'BALANCE_DUE');
    expect(far).toHaveLength(1);
    expect(far[0].ruleKey).toBe('BALANCE:ord_1:2026-07-20');
    expect(far[0].priority).toBe(ReminderPriority.HIGH);
    expect(far[0].title).toBe('【催尾款】FTM2026070900001 尾款¥3000');
    expect(far[0].dueAt).toBe(TODAY);

    const near = buildOrderCandidates(
      fakeOrder({ items: [flightItem('2026-07-11T02:00:00Z')] }), // 2 天后
      TODAY,
    ).filter((c) => c.rule === 'BALANCE_DUE');
    expect(near[0].priority).toBe(ReminderPriority.CRITICAL);
  });

  it('尾款为 0 / 出发超过 14 天 / 已过出发 / 状态不符 → 不生成', () => {
    const paidUp = fakeOrder({ paidAmount: new Prisma.Decimal('5000') });
    const tooFar = fakeOrder({ items: [flightItem('2026-07-30T02:00:00Z')] });
    const past = fakeOrder({ items: [flightItem('2026-07-08T02:00:00Z')] });
    const completed = fakeOrder({ status: OrderStatus.COMPLETED });
    for (const order of [paidUp, tooFar, past, completed]) {
      expect(
        buildOrderCandidates(order, TODAY).filter((c) => c.rule === 'BALANCE_DUE'),
      ).toHaveLength(0);
    }
  });

  it('adjustmentCny 计入尾款（售后费用未收也要催）', () => {
    const order = fakeOrder({
      paidAmount: new Prisma.Decimal('5000'), // 基础价已结清
      adjustmentCny: 200, // 但有 200 售后调整费未收
    });
    const [c] = buildOrderCandidates(order, TODAY).filter((x) => x.rule === 'BALANCE_DUE');
    expect(c.title).toContain('尾款¥200');
  });
});

// ── 规则 2：出行提醒 ────────────────────────────────────────────────────────
describe('DEPARTURE_SOON', () => {
  it('3 天内出发 → 生成；dueAt = 出发前一天', () => {
    const [c] = buildOrderCandidates(
      fakeOrder({ items: [flightItem('2026-07-12T02:00:00Z')] }), // 3 天后
      TODAY,
    ).filter((x) => x.rule === 'DEPARTURE_SOON');
    expect(c.ruleKey).toBe('DEPART:ord_1:2026-07-12');
    expect(c.title).toBe('【出行提醒】FTM2026070900001 2026-07-12出发');
    expect(c.priority).toBe(ReminderPriority.NORMAL);
    expect(c.dueAt).toBe('2026-07-11');
  });

  it('今天出发 → dueAt 不早于今天', () => {
    const [c] = buildOrderCandidates(
      fakeOrder({ items: [flightItem('2026-07-09T08:00:00Z')] }),
      TODAY,
    ).filter((x) => x.rule === 'DEPARTURE_SOON');
    expect(c.dueAt).toBe(TODAY);
  });

  it('待付/已完结不生成出行提醒；4 天后不生成', () => {
    const pending = fakeOrder({
      status: OrderStatus.PENDING_PAYMENT,
      items: [flightItem('2026-07-11T02:00:00Z')],
    });
    const completed = fakeOrder({
      status: OrderStatus.COMPLETED,
      items: [flightItem('2026-07-11T02:00:00Z')],
    });
    const tooFar = fakeOrder({ items: [flightItem('2026-07-13T02:00:00Z')] });
    for (const order of [pending, completed, tooFar]) {
      expect(
        buildOrderCandidates(order, TODAY).filter((c) => c.rule === 'DEPARTURE_SOON'),
      ).toHaveLength(0);
    }
  });
});

// ── 规则 3：护照有效期 ──────────────────────────────────────────────────────
describe('PASSPORT_EXPIRY', () => {
  const departure = '2026-07-20';
  const order = (expiry: string | null) =>
    fakeOrder({
      items: [flightItem(`${departure}T02:00:00Z`)],
      passengers: [
        {
          id: 'pax_1',
          fullName: '张三',
          passportExpiry: expiry ? new Date(`${expiry}T00:00:00Z`) : null,
        },
      ],
    });

  it('有效期 < 出发日 + 6 个月 → CRITICAL 提醒（按乘客出键）', () => {
    const [c] = buildOrderCandidates(order('2026-12-01'), TODAY).filter(
      (x) => x.rule === 'PASSPORT_EXPIRY',
    );
    expect(c.ruleKey).toBe('PPEXP:pax_1:2026-07-20');
    expect(c.priority).toBe(ReminderPriority.CRITICAL);
    expect(c.title).toBe('【护照有效期不足】FTM2026070900001 张三');
    expect(c.body).toContain('护照有效期 2026-12-01');
  });

  it('加月遇月末溢出 → 钳制到目标月最后一天（不顺延进下个月）', () => {
    expect(addMonthsUtc('2026-08-31', 6)).toBe('2027-02-28'); // 而非 03-03
    expect(addMonthsUtc('2026-03-31', 1)).toBe('2026-04-30');
    expect(addMonthsUtc('2027-08-31', 6)).toBe('2028-02-29'); // 闰年 2 月
    expect(addMonthsUtc('2026-01-15', 6)).toBe('2026-07-15'); // 非月末不受影响
  });

  it('有效期 ≥ 出发日 + 6 个月 / 有效期为空 → 不生成', () => {
    // 出发 2026-07-20 + 6 个月 = 2027-01-20
    expect(addMonthsUtc(departure, 6)).toBe('2027-01-20');
    for (const o of [order('2027-01-20'), order('2027-06-01'), order(null)]) {
      expect(
        buildOrderCandidates(o, TODAY).filter((c) => c.rule === 'PASSPORT_EXPIRY'),
      ).toHaveLength(0);
    }
  });

  it('已出发的订单不再提醒', () => {
    const past = fakeOrder({
      items: [flightItem('2026-07-01T02:00:00Z')],
      passengers: [
        { id: 'pax_1', fullName: '张三', passportExpiry: new Date('2026-08-01T00:00:00Z') },
      ],
    });
    expect(
      buildOrderCandidates(past, TODAY).filter((c) => c.rule === 'PASSPORT_EXPIRY'),
    ).toHaveLength(0);
  });
});

// ── 规则 4：签证缺件 ────────────────────────────────────────────────────────
describe('VISA_MISSING', () => {
  const task = (names: string[], departISO = '2026-07-20T02:00:00Z') => ({
    taskId: 'task_1',
    orderId: 'ord_1',
    orderNumber: 'FTM2026070900001',
    items: [flightItem(departISO)],
    missingPassengerNames: names,
  });

  it('缺件 → HIGH 提醒，人数入 ruleKey，正文列名单', () => {
    const [c] = buildVisaCandidates(task(['张三', '李四']), TODAY);
    expect(c.ruleKey).toBe('VISAMISS:task_1:2');
    expect(c.title).toBe('【签证缺件】FTM2026070900001 缺护照照片2人');
    expect(c.body).toContain('张三，李四');
    expect(c.priority).toBe(ReminderPriority.HIGH);
  });

  it('无缺件 / 已出发 → 不生成', () => {
    expect(buildVisaCandidates(task([]), TODAY)).toHaveLength(0);
    expect(buildVisaCandidates(task(['张三'], '2026-07-01T02:00:00Z'), TODAY)).toHaveLength(0);
  });
});

describe('RANDOM_TIER_SHORTFALL 随机档缺口提醒规则', () => {
  const tierRow = (overrides: Partial<RandomTierShortfallReport['days'][number]['tiers'][number]> = {}) => ({
    tier: 3 as const,
    label: '三星随机',
    hasBlock: true,
    block: 2,
    hotelUsed: 2,
    pendingUsed: 0,
    remaining: 0,
    shortfall: 0,
    roomsToRequest: 0,
    ...overrides,
  });

  it('shortfall > 0 按档次×日期生成，正文列出该档未来 7 天全部缺口；shortfall = 0 不生成', () => {
    const report: RandomTierShortfallReport = {
      from: TODAY,
      to: addDaysUtc(TODAY, 6),
      days: [
        { date: TODAY, tiers: [tierRow({ shortfall: 1, roomsToRequest: 1 })] },
        {
          date: addDaysUtc(TODAY, 1),
          tiers: [tierRow({ shortfall: 0.5, roomsToRequest: 1 })],
        },
      ],
    };

    const candidates = buildRandomTierShortfallCandidates(report, TODAY);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      rule: 'RANDOM_TIER_SHORTFALL',
      ruleKey: `RANDOMSHORTFALL:3:${TODAY}`,
      title: '三星随机 7/9 缺 1 间，需向地接加房',
      priority: ReminderPriority.HIGH,
    });
    expect(candidates[0].body).toContain('7/9 缺 1 间（需加 1 间）');
    expect(candidates[0].body).toContain('7/10 缺 0.5 间（需加 1 间）');
    expect(
      buildRandomTierShortfallCandidates(
        { ...report, days: report.days.map((day) => ({ ...day, tiers: [tierRow()] })) },
        TODAY,
      ),
    ).toEqual([]);
  });
});

// ── generateRuleReminders：幂等（跑两遍第二遍 created = 0）──────────────────
describe('generateRuleReminders 幂等', () => {
  /** 带内存态的 mock prisma：createMany 落进 store，findMany 按 ruleKey 查重 */
  function makeMockPrisma(orders: unknown[], visaTasks: unknown[], holds: unknown[] = []) {
    const store = new Set<string>();
    const mock = {
      order: { findMany: vi.fn(async () => orders) },
      fulfillmentTask: { findMany: vi.fn(async () => visaTasks) },
      holdOrder: { findMany: vi.fn(async () => holds) },
      operationalReminder: {
        findMany: vi.fn(async (args: { where: { ruleKey: { in: string[] } } }) =>
          args.where.ruleKey.in.filter((k) => store.has(k)).map((ruleKey) => ({ ruleKey })),
        ),
        createMany: vi.fn(async (args: { data: Array<{ ruleKey: string }> }) => {
          let count = 0;
          for (const row of args.data) {
            if (!store.has(row.ruleKey)) {
              store.add(row.ruleKey);
              count += 1;
            }
          }
          return { count };
        }),
      },
    };
    return { mock: mock as unknown as PrismaClient, raw: mock, store };
  }

  it('接入每日加房清单：未来 7 天有随机档缺口时生成随机档提醒', async () => {
    const { mock, raw } = makeMockPrisma([], []);
    const randomRaw = raw as typeof raw & {
      hotel: { findMany: ReturnType<typeof vi.fn> };
      hotelBlockPeriod: { findMany: ReturnType<typeof vi.fn> };
      orderItem: { findMany: ReturnType<typeof vi.fn> };
    };
    randomRaw.hotel = { findMany: vi.fn(async () => [{ id: 'hotel-3' }]) };
    randomRaw.hotelBlockPeriod = {
      findMany: vi.fn(async () => [{ dateFrom: new Date('2026-07-09T00:00:00Z'), dateTo: new Date('2026-07-15T00:00:00Z'), rooms: 1 }]),
    };
    randomRaw.orderItem = {
      findMany: vi.fn(async (args: unknown) => {
        const where = (args as { where?: { OR?: unknown } }).where;
        return where?.OR
          ? [{ hotelCheckIn: new Date('2026-07-09T00:00:00Z'), hotelCheckOut: new Date('2026-07-10T00:00:00Z'), roomsBilled: new Prisma.Decimal(2), metadata: null }]
          : [];
      }),
    };

    const result = await generateRuleReminders(
      mock,
      'user_sys',
      new Date('2026-07-09T06:00:00Z'),
    );

    expect(result).toMatchObject({
      created: 3,
      byRule: { RANDOM_TIER_SHORTFALL: 3 },
    });
  });

  // 相对今天构造，规则窗口不随真实日期漂移。必须与引擎同口径（北京业务日），
  // 否则 UTC 16:00 之后跑测试，用例算的「今天」会比引擎早一天。
  const today = businessDateISO(new Date());
  const departSoon = addDaysUtc(today, 2);
  const dbOrder = {
    id: 'ord_1',
    orderNumber: 'FTM2026070900001',
    contactName: '测试联系人',
    status: OrderStatus.PAID,
    total: new Prisma.Decimal('5000'),
    paidAmount: new Prisma.Decimal('2000'),
    prepaymentOffset: new Prisma.Decimal('0'),
    adjustmentCny: 0,
    items: [flightItem(`${departSoon}T02:00:00Z`)],
    passengers: [
      {
        id: 'pax_1',
        fullName: '张三',
        passportExpiry: new Date(`${addDaysUtc(today, 30)}T00:00:00Z`),
      },
    ],
  };
  const dbVisaTask = {
    id: 'task_1',
    orderItem: {
      order: {
        id: 'ord_1',
        orderNumber: 'FTM2026070900001',
        deletedAt: null,
        items: [flightItem(`${departSoon}T02:00:00Z`)],
        passengers: [{ fullName: '张三' }],
      },
    },
  };

  it('第一遍全部创建，第二遍 created=0 全 skipped', async () => {
    const { mock, raw } = makeMockPrisma([dbOrder], [dbVisaTask]);

    const first = await generateRuleReminders(mock, 'user_sys');
    // 四条规则各命中一条：催尾款(2天,CRITICAL) + 出行提醒 + 护照有效期(30天<6个月) + 签证缺件
    expect(first.created).toBe(4);
    expect(first.skipped).toBe(0);
    expect(first.byRule).toEqual({
      BALANCE_DUE: 1,
      DEPARTURE_SOON: 1,
      PASSPORT_EXPIRY: 1,
      VISA_MISSING: 1,
    });
    // createdById 透传 + ruleKey 落库
    const createArgs = (raw.operationalReminder.createMany.mock.calls[0] as unknown[])[0] as {
      data: Array<{ createdById: string; ruleKey: string; dueAt: Date }>;
    };
    expect(createArgs.data.every((d) => d.createdById === 'user_sys')).toBe(true);
    expect(createArgs.data.map((d) => d.ruleKey).sort()).toEqual([
      `BALANCE:ord_1:${departSoon}`,
      `DEPART:ord_1:${departSoon}`,
      `PPEXP:pax_1:${departSoon}`,
      'VISAMISS:task_1:1',
    ]);

    const second = await generateRuleReminders(mock, 'user_sys');
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(4);
    expect(second.byRule).toEqual({});
    // 第二遍已被查重过滤，不应再调 createMany
    expect(raw.operationalReminder.createMany).toHaveBeenCalledTimes(1);
  });

  it('无候选时不查重不写库', async () => {
    const { mock, raw } = makeMockPrisma([], []);
    const result = await generateRuleReminders(mock, 'user_sys');
    expect(result).toEqual({ created: 0, skipped: 0, byRule: {} });
    expect(raw.operationalReminder.findMany).not.toHaveBeenCalled();
    expect(raw.operationalReminder.createMany).not.toHaveBeenCalled();
  });

  it('占位单提醒按班次 departureTz 折算今天，而不是服务器 UTC 日期', async () => {
    const hold = {
      id: 'hold_tz',
      holdNo: 'H20260709TZ01',
      groupName: '时区团',
      status: HoldOrderStatus.HOLDING,
      flightSchedule: { departureTz: 'Pacific/Kiritimati' },
      installments: [{ id: 'hold_i1', label: '尾款', amountCny: 1000, status: HoldInstallmentStatus.PENDING, dueDate: new Date('2026-07-13T00:00:00Z') }],
    };
    const { mock } = makeMockPrisma([], [], [hold]);
    const result = await generateRuleReminders(mock, 'user_sys', new Date('2026-07-09T23:30:00Z'));
    expect(dateInTz(new Date('2026-07-09T23:30:00Z'), 'Pacific/Kiritimati')).toBe('2026-07-10');
    expect(result).toMatchObject({ created: 1, byRule: { HOLD_INSTALLMENT_DUE: 1 } });
  });

  it('签证缺件查询按签证台同口径排除自备签乘客（visaExempt: false），自备签乘客缺护照图不触发 VISA_MISSING', async () => {
    const { mock, raw } = makeMockPrisma([], []);
    await generateRuleReminders(mock, 'user_sys');
    const queryArgs = (raw.fulfillmentTask.findMany.mock.calls[0] as unknown[])[0] as {
      select: {
        orderItem: {
          select: { order: { select: { passengers: { where: Record<string, unknown> } } } };
        };
      };
    };
    const passengersWhere = queryArgs.select.orderItem.select.order.select.passengers.where;
    expect(passengersWhere).toEqual({
      visaExempt: false,
      OR: [{ passportPhotoUrl: null }, { passportPhotoUrl: '' }],
    });
  });

  // ── 「今天」= 北京业务日，不是 UTC 日 ────────────────────────────────────
  // UTC 20:00 时北京已是次日 04:00。按 UTC 切日的老口径会让整个北京 00:00–08:00
  // 时段用「昨天」跑规则：昨天已起飞的单还在被催尾款，14 天窗口边缘的单反而漏掉。
  describe('「今天」按北京业务日切', () => {
    /** 2026-07-09T20:00Z = 北京 2026-07-10 04:00（UTC 日仍是 07-09） */
    const beijingEarlyMorning = new Date('2026-07-09T20:00:00Z');

    function orderDeparting(departLocalDay: string) {
      return {
        id: 'ord_tz',
        orderNumber: 'FTM2026070900002',
        contactName: '测试联系人',
        status: OrderStatus.PAID,
        total: new Prisma.Decimal('5000'),
        paidAmount: new Prisma.Decimal('2000'),
        prepaymentOffset: new Prisma.Decimal('0'),
        adjustmentCny: 0,
        items: [flightItem(`${departLocalDay}T02:00:00Z`)],
        // 护照有效期给到很远，隔离出 BALANCE_DUE / DEPARTURE_SOON 两条规则
        passengers: [
          { id: 'pax_tz', fullName: '张三', passportExpiry: new Date('2030-01-01T00:00:00Z') },
        ],
      };
    }

    it('北京已跨到次日：昨天出发的单不再催尾款/发出行提醒', async () => {
      const { mock } = makeMockPrisma([orderDeparting('2026-07-09')], []);
      const result = await generateRuleReminders(mock, 'user_sys', beijingEarlyMorning);
      // 北京今天 = 07-10，出发日 07-09 已过 → days = -1，四条规则全不命中
      expect(result).toEqual({ created: 0, skipped: 0, byRule: {} });
    });

    it('北京已跨到次日：14 天窗口边缘的单照常催尾款，且 dueAt 记北京今天', async () => {
      const { mock, raw } = makeMockPrisma([orderDeparting('2026-07-24')], []);
      const result = await generateRuleReminders(mock, 'user_sys', beijingEarlyMorning);
      // 北京今天 07-10 → 距 07-24 正好 14 天，落在窗口内（按 UTC 的 07-09 算是 15 天会漏掉）
      expect(result.byRule).toEqual({ BALANCE_DUE: 1 });
      const createArgs = (raw.operationalReminder.createMany.mock.calls[0] as unknown[])[0] as {
        data: Array<{ ruleKey: string; dueAt: Date }>;
      };
      expect(createArgs.data[0].ruleKey).toBe('BALANCE:ord_tz:2026-07-24');
      expect(createArgs.data[0].dueAt.toISOString()).toBe('2026-07-10T00:00:00.000Z');
    });

    it('ruleKey 不含「今天」：同一张单跨过北京零点再扫一遍也不会重发', async () => {
      // 07-23 出发：北京 07-09 距 14 天、07-10 距 13 天，两次都在催尾款窗口内
      const { mock } = makeMockPrisma([orderDeparting('2026-07-23')], []);
      // 第一遍：北京 07-09 白天
      const before = await generateRuleReminders(mock, 'user_sys', new Date('2026-07-09T06:00:00Z'));
      expect(before).toMatchObject({ created: 1, byRule: { BALANCE_DUE: 1 } });
      // 第二遍：北京已到 07-10 —— today 变了，但键仍是出发日，命中查重
      const after = await generateRuleReminders(mock, 'user_sys', beijingEarlyMorning);
      expect(after).toMatchObject({ created: 0, skipped: 1 });
    });
  });
});

// ── 规则 6：临近出发未出票 ───────────────────────────────────────────────────
describe('TICKET_MISSING 出票提醒规则', () => {
  const paxNoTicket = { id: 'p1', fullName: '张三', passportExpiry: null, eticketNumber: null };

  it('出发 5 天内 + 有航段 + 乘客缺票号 → HIGH；2 天内升级 CRITICAL', () => {
    const high = buildOrderCandidates(
      fakeOrder({ items: [flightItem('2026-07-12T02:00:00Z')], passengers: [paxNoTicket] }),
      TODAY,
    ).filter((c) => c.rule === 'TICKET_MISSING');
    expect(high).toHaveLength(1);
    expect(high[0]).toMatchObject({
      priority: ReminderPriority.HIGH,
      ruleKey: 'TICKET:ord_1:2026-07-12',
    });
    expect(high[0].title).toContain('未出票');

    const critical = buildOrderCandidates(
      fakeOrder({ items: [flightItem('2026-07-10T02:00:00Z')], passengers: [paxNoTicket] }),
      TODAY,
    ).filter((c) => c.rule === 'TICKET_MISSING');
    expect(critical[0]).toMatchObject({ priority: ReminderPriority.CRITICAL });
  });

  it('票号齐 / 出发超窗 / 纯酒店单（无航段）→ 不触发', () => {
    const has = (order: RuleOrder) =>
      buildOrderCandidates(order, TODAY).some((c) => c.rule === 'TICKET_MISSING');
    expect(
      has(fakeOrder({ items: [flightItem('2026-07-12T02:00:00Z')], passengers: [{ ...paxNoTicket, eticketNumber: '999-1234567890' }] })),
    ).toBe(false);
    expect(
      has(fakeOrder({ items: [flightItem('2026-07-20T02:00:00Z')], passengers: [paxNoTicket] })),
    ).toBe(false);
    expect(
      has(fakeOrder({ items: [hotelItem('2026-07-12')], passengers: [paxNoTicket] })),
    ).toBe(false);
  });

  it('老口径没取 eticketNumber 字段（undefined）→ 不判该乘客（没查字段 ≠ 没出票）', () => {
    const order = fakeOrder({
      items: [flightItem('2026-07-12T02:00:00Z')],
      passengers: [{ id: 'p1', fullName: '张三', passportExpiry: null }],
    });
    expect(buildOrderCandidates(order, TODAY).some((c) => c.rule === 'TICKET_MISSING')).toBe(false);
  });
});

// ── 规则 8：临近入住未分房 ───────────────────────────────────────────────────
describe('ROOM_UNASSIGNED 分房提醒规则', () => {
  it('最早入住 3 天内 + 分房表空 → HIGH；1 天内升级 CRITICAL；ruleKey 按订单+首入住日', () => {
    const high = buildOrderCandidates(
      fakeOrder({ items: [hotelItem('2026-07-12')], roomAssignment: null }),
      TODAY,
    ).filter((c) => c.rule === 'ROOM_UNASSIGNED');
    expect(high).toHaveLength(1);
    expect(high[0]).toMatchObject({
      priority: ReminderPriority.HIGH,
      ruleKey: 'ROOMASSIGN:ord_1:2026-07-12',
    });

    const critical = buildOrderCandidates(
      fakeOrder({ items: [hotelItem('2026-07-10')], roomAssignment: null }),
      TODAY,
    ).filter((c) => c.rule === 'ROOM_UNASSIGNED');
    expect(critical[0]).toMatchObject({ priority: ReminderPriority.CRITICAL });
  });

  it('已分房 / 入住超窗 / 无酒店行 / 老口径没取字段 → 不触发', () => {
    const fires = (order: RuleOrder) =>
      buildOrderCandidates(order, TODAY).some((c) => c.rule === 'ROOM_UNASSIGNED');
    expect(
      fires(
        fakeOrder({
          items: [hotelItem('2026-07-12')],
          roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] },
        }),
      ),
    ).toBe(false);
    expect(fires(fakeOrder({ items: [hotelItem('2026-07-20')], roomAssignment: null }))).toBe(false);
    expect(fires(fakeOrder({ items: [flightItem('2026-07-12T02:00:00Z')], roomAssignment: null }))).toBe(false);
    expect(fires(fakeOrder({ items: [hotelItem('2026-07-12')] }))).toBe(false);
  });

  it('hasRoomAssignment：空表 / 全空组视同未分房', () => {
    expect(hasRoomAssignment(null)).toBe(false);
    expect(hasRoomAssignment({ roomGroups: [] })).toBe(false);
    expect(hasRoomAssignment({ roomGroups: [{ passengerIds: [] }] })).toBe(false);
    expect(hasRoomAssignment({ roomGroups: [{ passengerIds: ['p1'] }] })).toBe(true);
  });
});

// ── 规则 7：临近出发未送签 ───────────────────────────────────────────────────
describe('VISA_NOT_SUBMITTED 送签提醒规则', () => {
  const base = {
    orderId: 'ord_1',
    orderNumber: 'FTM2026070900001',
    items: [flightItem('2026-07-14T02:00:00Z')], // 距 TODAY 5 天，7 天窗口内
    pendingPassengerNames: ['张三', '李四'],
  };

  it('出发 7 天内有人未完成送签 → HIGH，点名乘客；3 天内升级 CRITICAL', () => {
    const high = buildVisaSubmissionCandidates(base, TODAY);
    expect(high).toHaveLength(1);
    expect(high[0]).toMatchObject({
      rule: 'VISA_NOT_SUBMITTED',
      priority: ReminderPriority.HIGH,
      ruleKey: 'VISASUBMIT:ord_1:2026-07-14',
    });
    expect(high[0].body).toContain('张三');

    const critical = buildVisaSubmissionCandidates(
      { ...base, items: [flightItem('2026-07-11T02:00:00Z')] },
      TODAY,
    );
    expect(critical[0]).toMatchObject({ priority: ReminderPriority.CRITICAL });
  });

  it('全员已送签 / 出发超窗 / 已出发 → 不触发', () => {
    expect(buildVisaSubmissionCandidates({ ...base, pendingPassengerNames: [] }, TODAY)).toEqual([]);
    expect(
      buildVisaSubmissionCandidates({ ...base, items: [flightItem('2026-07-20T02:00:00Z')] }, TODAY),
    ).toEqual([]);
    expect(
      buildVisaSubmissionCandidates({ ...base, items: [flightItem('2026-07-01T02:00:00Z')] }, TODAY),
    ).toEqual([]);
  });
});

// ── 规则 9：到账核实队列积压 ─────────────────────────────────────────────────
describe('RECEIPT_UNVERIFIED 到账核实提醒规则', () => {
  const receipt = (createdAtISO: string) => ({
    id: 'rcp_1',
    receiptNo: 'RCP2026070700001',
    amountCny: new Prisma.Decimal('8888.00'),
    createdAt: new Date(createdAtISO),
  });

  it('挂满 2 天 → HIGH；满 7 天升级 CRITICAL；ruleKey 只含 receipt id（不按天重发）', () => {
    // 北京 07-07 登记，TODAY 07-09 → 挂 2 天
    const high = buildReceiptVerifyCandidates(receipt('2026-07-07T04:00:00Z'), TODAY);
    expect(high).toHaveLength(1);
    expect(high[0]).toMatchObject({
      rule: 'RECEIPT_UNVERIFIED',
      priority: ReminderPriority.HIGH,
      ruleKey: 'CLAIMVERIFY:rcp_1',
    });
    expect(high[0].title).toContain('8888');

    const critical = buildReceiptVerifyCandidates(receipt('2026-07-01T04:00:00Z'), TODAY);
    expect(critical[0]).toMatchObject({ priority: ReminderPriority.CRITICAL });
  });

  it('挂账不足 2 天 → 不触发（给财务留正常处理时间）', () => {
    expect(buildReceiptVerifyCandidates(receipt('2026-07-08T04:00:00Z'), TODAY)).toEqual([]);
  });
});

// ── 规则 11：去程 no-show 后回程座位已释放，待跟进是否恢复 ─────────────────────
describe('NO_SHOW_RETURN_RELEASED 回程已释放提醒规则', () => {
  const NOW = new Date('2026-07-09T06:00:00Z');
  const RELEASED_AT = '2026-07-09T05:00:00.000Z';

  function releasedLeg(overrides: Partial<RuleReleasedReturnLeg> = {}): RuleReleasedReturnLeg {
    return {
      itemId: 'itm_ret',
      orderId: 'ord_1',
      orderNumber: 'FTM2026070900001',
      kind: 'FLIGHT',
      flightScheduleId: null,
      metadata: {
        returnReleased: {
          at: RELEASED_AT,
          originalScheduleId: 'sch_ret',
          releasedSeats: [{ scheduleId: 'sch_ret', cabin: 'ECONOMY', quantity: 2 }],
        },
      },
      outboundMetadata: { noShow: { at: RELEASED_AT, listDate: '2026-07-08' } },
      originalSchedule: { departureTime: new Date('2026-07-15T02:00:00Z'), departureTz: 'Asia/Shanghai' },
      ...overrides,
    };
  }

  it('已释放且回程未起飞 → HIGH 待办，标题带单号与座数，正文写去程日期/回程日期/恢复入口', () => {
    const out = buildNoShowReturnReleasedCandidates(releasedLeg(), TODAY, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 'NO_SHOW_RETURN_RELEASED',
      orderId: 'ord_1',
      priority: ReminderPriority.HIGH,
      dueAt: TODAY,
    });
    expect(out[0].title).toBe('【回程已释放待跟进】FTM2026070900001 2 座已放回库存');
    expect(out[0].body).toContain('2026-07-08');
    expect(out[0].body).toContain('2026-07-15');
    expect(out[0].body).toContain('恢复回程');
    expect(out[0].body).toContain('余位不足可超售');
  });

  it('ruleKey 带 returnReleased.at：释放→恢复→再释放能再次生成', () => {
    const first = buildNoShowReturnReleasedCandidates(releasedLeg(), TODAY, NOW);
    expect(first[0].ruleKey).toBe(`NOSHOW_RELEASED:itm_ret:${RELEASED_AT}`);

    // 第二次释放：at 更晚，且晚于中间那次恢复 → 新键，不会被上一条的唯一索引吃掉
    const secondAt = '2026-07-09T09:00:00.000Z';
    const second = buildNoShowReturnReleasedCandidates(
      releasedLeg({
        metadata: {
          returnReleased: {
            at: secondAt,
            originalScheduleId: 'sch_ret',
            releasedSeats: [{ scheduleId: 'sch_ret', cabin: 'ECONOMY', quantity: 2 }],
          },
          returnRestored: { at: '2026-07-09T07:00:00.000Z', oversold: false, oversoldBy: 0 },
        },
      }),
      TODAY,
      NOW,
    );
    expect(second).toHaveLength(1);
    expect(second[0].ruleKey).toBe(`NOSHOW_RELEASED:itm_ret:${secondAt}`);
    expect(second[0].ruleKey).not.toBe(first[0].ruleKey);
  });

  it('已恢复 / 已作废 → 一条都不生成', () => {
    // 已恢复：班次写回 + returnRestored 晚于 returnReleased
    expect(
      buildNoShowReturnReleasedCandidates(
        releasedLeg({
          flightScheduleId: 'sch_ret',
          metadata: {
            returnReleased: { at: RELEASED_AT, originalScheduleId: 'sch_ret', releasedSeats: [] },
            returnRestored: { at: '2026-07-09T08:00:00.000Z' },
          },
        }),
        TODAY,
        NOW,
      ),
    ).toEqual([]);

    // 已作废（起飞后自动作废终结）
    expect(
      buildNoShowReturnReleasedCandidates(
        releasedLeg({
          metadata: {
            returnReleased: { at: RELEASED_AT, originalScheduleId: 'sch_ret', releasedSeats: [] },
            returnVoidedFinal: { at: '2026-07-16T00:00:00.000Z' },
          },
        }),
        TODAY,
        NOW,
      ),
    ).toEqual([]);

  });

  it('回程已起飞仍停在已释放态 → 换成「请确认作废」待办（ruleKey 带 :DEPARTED，不承诺自动作废）', () => {
    // 系统里并没有「起飞后自动作废」的定时任务，所以起飞后既不能静默停止提醒
    //（这一段就永远没人收口了），也不能在文案里承诺一个不存在的机制。
    const out = buildNoShowReturnReleasedCandidates(
      releasedLeg({
        originalSchedule: {
          departureTime: new Date('2026-07-09T05:30:00Z'),
          departureTz: 'Asia/Shanghai',
        },
      }),
      TODAY,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].ruleKey).toBe(`NOSHOW_RELEASED:itm_ret:${RELEASED_AT}:DEPARTED`);
    expect(out[0].title).toBe('【回程已起飞仍未恢复】FTM2026070900001 2 座待收口');
    // 文案口径：自动作废 job 上线后，这条待办要如实说「系统会自动收口」，
    // 并给出「想提前收口就手工作废」的出路 —— 旧文案的「系统不会自动作废」已是错话。
    expect(out[0].body).toContain('起飞满 2 小时系统会自动作废收口');
    expect(out[0].body).toContain('手工作废');
    expect(out[0].body).not.toContain('系统不会自动作废');
    expect(out[0].priority).toBe(ReminderPriority.HIGH);
  });

  it('未起飞的常规待办不承诺「系统自动作废」', () => {
    const out = buildNoShowReturnReleasedCandidates(releasedLeg(), TODAY, NOW);
    expect(out[0].body).not.toContain('自动作废');
  });

  it('班次查不到 / 去程快照缺失时照样提醒，日期分别回落「日期未知」与释放当日', () => {
    const out = buildNoShowReturnReleasedCandidates(
      releasedLeg({ originalSchedule: null, outboundMetadata: null }),
      TODAY,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain('日期未知');
    expect(out[0].body).toContain('2026-07-09');
  });
});

describe('generateRuleReminders — 规则 11 单独取数，不动其它规则的查询', () => {
  const NOW = new Date('2026-07-09T06:00:00Z');

  /** 原回程班次的起飞时间（默认远在未来 → 走「待跟进」那一条）。 */
  const FUTURE_RET_DEPART = new Date('2026-07-15T02:00:00Z');

  function makePrisma(retDeparture: Date = FUTURE_RET_DEPART) {
    /** ruleKey → 当前状态（模拟 OperationalReminder 的 ruleKey 唯一索引 + status 列）。 */
    const store = new Map<string, string>();
    const orderItemFindMany = vi.fn(async (args: unknown) => {
      const where = (args as { where?: Record<string, unknown> }).where ?? {};
      if (where.flightScheduleId === null) {
        return [
          {
            id: 'itm_ret',
            orderId: 'ord_1',
            order: { orderNumber: 'FTM2026070900001' },
            metadata: {
              returnReleased: {
                at: '2026-07-09T05:00:00.000Z',
                originalScheduleId: 'sch_ret',
                releasedSeats: [{ scheduleId: 'sch_ret', cabin: 'ECONOMY', quantity: 3 }],
              },
            },
          },
        ];
      }
      if (where.orderId) {
        return [{ orderId: 'ord_1', metadata: { noShow: { listDate: '2026-07-08' } } }];
      }
      return [];
    });
    const mock = {
      order: { findMany: vi.fn(async () => []) },
      fulfillmentTask: { findMany: vi.fn(async () => []) },
      holdOrder: { findMany: vi.fn(async () => []) },
      orderItem: { findMany: orderItemFindMany },
      flightSchedule: {
        findMany: vi.fn(async () => [
          { id: 'sch_ret', departureTime: retDeparture, departureTz: 'Asia/Shanghai' },
        ]),
      },
      operationalReminder: {
        findMany: vi.fn(async (args: { where: { ruleKey: { in: string[] } } }) =>
          args.where.ruleKey.in.filter((k) => store.has(k)).map((ruleKey) => ({ ruleKey })),
        ),
        createMany: vi.fn(async (args: { data: Array<{ ruleKey: string }> }) => {
          let count = 0;
          for (const row of args.data) {
            if (!store.has(row.ruleKey)) {
              store.set(row.ruleKey, 'OPEN');
              count += 1;
            }
          }
          return { count };
        }),
        updateMany: vi.fn(
          async (args: {
            where: { ruleKey: { in: string[] }; status: { in: string[] } };
            data: { status: string };
          }) => {
            let count = 0;
            for (const key of args.where.ruleKey.in) {
              const current = store.get(key);
              if (current != null && args.where.status.in.includes(current)) {
                store.set(key, args.data.status);
                count += 1;
              }
            }
            return { count };
          },
        ),
      },
    };
    return { mock: mock as unknown as PrismaClient, raw: mock, store };
  }

  it('扫到已释放回程行 → 生成 1 条，且订单查询的 items where 保持原样', async () => {
    const { mock, raw } = makePrisma();
    const result = await generateRuleReminders(mock, 'user_sys', NOW);
    expect(result).toMatchObject({ created: 1, byRule: { NO_SHOW_RETURN_RELEASED: 1 } });

    // 其它规则的取数没被放宽：订单 items 仍只取「有班次或有入住日」的行，且不拉 metadata
    const orderArgs = raw.order.findMany.mock.calls[0][0] as {
      select: { items: { where: unknown; select: Record<string, unknown> } };
    };
    expect(orderArgs.select.items.where).toEqual({
      OR: [{ flightScheduleId: { not: null } }, { hotelCheckIn: { not: null } }],
    });
    expect(orderArgs.select.items.select).not.toHaveProperty('metadata');
  });

  it('扫单状态含 PENDING_PAYMENT：尾款没收齐、人又没登机的单最该跟进，不能漏', async () => {
    const { mock, raw } = makePrisma();
    await generateRuleReminders(mock, 'user_sys', NOW);
    // 规则 11 的取数是「flightScheduleId === null」那一支。
    const releasedCall = raw.orderItem.findMany.mock.calls.find(
      (c: unknown[]) =>
        (c[0] as { where?: { flightScheduleId?: unknown } }).where?.flightScheduleId === null,
    ) as [{ where: { order: { status: { in: string[] } } } }];
    const statuses = releasedCall[0].where.order.status.in;
    // no-show 与释放回程都不看订单收没收钱（本操作一分不动），故未付款单同样会出现在这一批里。
    expect(statuses).toContain('PENDING_PAYMENT');
    // 取消 / 退款 / 失败族仍然排除（那些单的座位早已按别的口径处置过）。
    for (const excluded of ['CANCELLED', 'REFUNDED', 'PAYMENT_TIMEOUT', 'FAILED']) {
      expect(statuses).not.toContain(excluded);
    }
  });

  it('第二遍全部 skipped（ruleKey 幂等）', async () => {
    const { mock } = makePrisma();
    await generateRuleReminders(mock, 'user_sys', NOW);
    const second = await generateRuleReminders(mock, 'user_sys', NOW);
    expect(second).toMatchObject({ created: 0, skipped: 1 });
  });

  // ── 起飞后换条时的收口：两条不能并存 ─────────────────────────────────────────
  // 起飞前那条写着「要保留就点『恢复回程』」，起飞后那条路已经走不通了。
  // 两条同时挂在待办列表里，运营会照旧条去点恢复，白折腾一轮才发现班次早飞了。
  it('先未起飞生成一条 → 推进时间再生成：旧条被置 SKIPPED，新的 :DEPARTED 条并存不了', async () => {
    const RELEASED_KEY = 'NOSHOW_RELEASED:itm_ret:2026-07-09T05:00:00.000Z';
    const DEPARTED_KEY = `${RELEASED_KEY}:DEPARTED`;

    // ① 起飞前（班次 7-15 起飞，现在 7-9）→ 只生成「待跟进」那一条。
    const before = makePrisma();
    const first = await generateRuleReminders(before.mock, 'user_sys', NOW);
    expect(first).toMatchObject({ created: 1 });
    expect(before.store.get(RELEASED_KEY)).toBe('OPEN');
    expect(before.store.has(DEPARTED_KEY)).toBe(false);
    // 没有被顶替的条目 → 一次多余的 updateMany 都不发。
    expect(before.raw.operationalReminder.updateMany).not.toHaveBeenCalled();

    // ② 时间推到起飞之后：同一份存量（旧条还 OPEN）再跑一遍。
    const after = makePrisma(new Date('2026-07-09T05:30:00Z'));
    after.store.set(RELEASED_KEY, 'OPEN');
    const second = await generateRuleReminders(after.mock, 'user_sys', NOW);

    // 新条建出来了，旧条被收口成 SKIPPED（而不是留着两条并存）。
    expect(second).toMatchObject({ created: 1, byRule: { NO_SHOW_RETURN_RELEASED: 1 } });
    expect(after.store.get(DEPARTED_KEY)).toBe('OPEN');
    expect(after.store.get(RELEASED_KEY)).toBe('SKIPPED');
    const args = after.raw.operationalReminder.updateMany.mock.calls[0][0] as {
      where: { ruleKey: { in: string[] }; status: { in: string[] } };
      data: { status: string; resolvedNote: string };
    };
    expect(args.where.ruleKey.in).toEqual([RELEASED_KEY]);
    // 运营已经手工处理过的（DONE / SKIPPED）不去覆盖他的结论。
    expect(args.where.status.in).toEqual(['OPEN', 'IN_PROGRESS']);
    expect(args.data.resolvedNote).toContain('已起飞');
  });

  it('重复跑第三遍：旧条已 SKIPPED 不再被动，新条也不重复建（幂等）', async () => {
    const RELEASED_KEY = 'NOSHOW_RELEASED:itm_ret:2026-07-09T05:00:00.000Z';
    const departed = makePrisma(new Date('2026-07-09T05:30:00Z'));
    departed.store.set(RELEASED_KEY, 'OPEN');
    await generateRuleReminders(departed.mock, 'user_sys', NOW);
    const third = await generateRuleReminders(departed.mock, 'user_sys', NOW);
    expect(third).toMatchObject({ created: 0, skipped: 1 });
    expect(departed.store.get(RELEASED_KEY)).toBe('SKIPPED');
  });
});
