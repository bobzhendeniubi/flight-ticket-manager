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
import { OrderStatus, Prisma, ReminderPriority, ReminderStatus, type PrismaClient } from '@prisma/client';
import {
  addDaysUtc,
  addMonthsUtc,
  AUTO_RESOLVED_NOTE,
  buildNoShowReturnReleasedCandidates,
  buildOrderCandidates,
  buildHoldInstallmentCandidates,
  buildRandomTierShortfallCandidates,
  buildReceiptVerifyCandidates,
  buildUpgradeRedeemCandidates,
  buildVisaCandidates,
  buildVisaSubmissionCandidates,
  computeBalance,
  dateInTz,
  deriveDepartureDate,
  formatAmount,
  generateRuleReminders,
  hasRoomAssignment,
  ROOM_REMINDER_STATE_MACHINE_SINCE,
  resolveProfileMasterId,
  upgradeRedeemLegStartMs,
  upgradeRedeemRuleKey,
  utcDateStr,
  type RuleOrder,
  type RuleReleasedReturnLeg,
  type RuleUpgradeRedeemPassenger,
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

  it('无机票无酒店回落最早签证预计出行日期（纯签证单锚点）；有机票/酒店时它不插手', () => {
    const visaItem = (d: string) => ({
      hotelCheckIn: null,
      flightSchedule: null,
      visaIntendedDate: new Date(`${d}T00:00:00Z`),
    });
    expect(deriveDepartureDate([visaItem('2026-09-06'), visaItem('2026-09-04')])).toBe('2026-09-04');
    expect(deriveDepartureDate([hotelItem('2026-07-16'), visaItem('2026-07-01')])).toBe('2026-07-16');
    expect(deriveDepartureDate([visaItem('2026-07-01'), flightItem('2026-07-15T02:00:00Z')])).toBe(
      '2026-07-15',
    );
    // 未填（null / 缺省）不算锚点
    expect(
      deriveDepartureDate([{ hotelCheckIn: null, flightSchedule: null, visaIntendedDate: null }]),
    ).toBeNull();
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
// 分房提醒（规则 8 与 8b）的候选生成本身也受 ROOM_REMINDER_STATE_MACHINE_SINCE 上线日期闸
// 限制（B8 二次修复，见 buildOrderCandidates）——不能沿用文件级 TODAY（2026-07-09，早于默认
// 闸值 2026-09-15），否则这里测的候选生成逻辑全部会被闸掉、断言不到任何候选。改用相对 SINCE
// 的本地「今天」与入住日，天数偏移与原测试保持一致（3 天窗口边界=HIGH，1 天内=CRITICAL，
// 11 天=超窗不触发）。
const ROOM_TODAY = ROOM_REMINDER_STATE_MACHINE_SINCE;
const roomCheckInHigh = addDaysUtc(ROOM_TODAY, 3);
const roomCheckInCritical = addDaysUtc(ROOM_TODAY, 1);
const roomCheckInOverWindow = addDaysUtc(ROOM_TODAY, 11);

describe('ROOM_UNASSIGNED 分房提醒规则', () => {
  it('最早入住 3 天内 + 分房表空 → HIGH；1 天内升级 CRITICAL；ruleKey 按订单+首入住日', () => {
    const high = buildOrderCandidates(
      fakeOrder({ items: [hotelItem(roomCheckInHigh)], roomAssignment: null }),
      ROOM_TODAY,
    ).filter((c) => c.rule === 'ROOM_UNASSIGNED');
    expect(high).toHaveLength(1);
    expect(high[0]).toMatchObject({
      priority: ReminderPriority.HIGH,
      ruleKey: `ROOMASSIGN:ord_1:${roomCheckInHigh}`,
    });

    const critical = buildOrderCandidates(
      fakeOrder({ items: [hotelItem(roomCheckInCritical)], roomAssignment: null }),
      ROOM_TODAY,
    ).filter((c) => c.rule === 'ROOM_UNASSIGNED');
    expect(critical[0]).toMatchObject({ priority: ReminderPriority.CRITICAL });
  });

  it('已分房 / 入住超窗 / 无酒店行 / 老口径没取字段 → 不触发', () => {
    const fires = (order: RuleOrder) =>
      buildOrderCandidates(order, ROOM_TODAY).some((c) => c.rule === 'ROOM_UNASSIGNED');
    expect(
      fires(
        fakeOrder({
          items: [hotelItem(roomCheckInHigh)],
          roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] },
        }),
      ),
    ).toBe(false);
    expect(fires(fakeOrder({ items: [hotelItem(roomCheckInOverWindow)], roomAssignment: null }))).toBe(false);
    expect(
      fires(fakeOrder({ items: [flightItem(`${roomCheckInHigh}T02:00:00Z`)], roomAssignment: null })),
    ).toBe(false);
    expect(fires(fakeOrder({ items: [hotelItem(roomCheckInHigh)] }))).toBe(false);
  });

  it('hasRoomAssignment：空表 / 全空组视同未分房', () => {
    expect(hasRoomAssignment(null)).toBe(false);
    expect(hasRoomAssignment({ roomGroups: [] })).toBe(false);
    expect(hasRoomAssignment({ roomGroups: [{ passengerIds: [] }] })).toBe(false);
    expect(hasRoomAssignment({ roomGroups: [{ passengerIds: ['p1'] }] })).toBe(true);
  });
});

// ── 规则 8b：跨单分房落地后新增——部分未分房 ─────────────────────────────────
describe('ROOM_PARTIALLY_UNASSIGNED 部分未分房提醒规则', () => {
  const twoPax = [
    { id: 'p1', fullName: '张三', passportExpiry: null },
    { id: 'p2', fullName: '李四', passportExpiry: null },
  ];

  it('已分房但仍有人不在任何房组 → HIGH，点名遗漏乘客；ruleKey 按订单+首入住日+PARTIAL 后缀', () => {
    const candidates = buildOrderCandidates(
      fakeOrder({
        items: [hotelItem(roomCheckInHigh)],
        roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] }, // 只分了 p1，p2 还没进房组
        passengers: twoPax,
      }),
      ROOM_TODAY,
    ).filter((c) => c.rule === 'ROOM_PARTIALLY_UNASSIGNED');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      priority: ReminderPriority.HIGH,
      ruleKey: `ROOMASSIGN:ord_1:${roomCheckInHigh}:PARTIAL`,
    });
    expect(candidates[0]!.body).toContain('李四');
    expect(candidates[0]!.body).not.toContain('张三'); // 已分房的人不点名
  });

  it('入住 1 天内升级 CRITICAL（与 ROOM_UNASSIGNED 同一套窗口/优先级判定）', () => {
    const critical = buildOrderCandidates(
      fakeOrder({
        items: [hotelItem(roomCheckInCritical)],
        roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] },
        passengers: twoPax,
      }),
      ROOM_TODAY,
    ).filter((c) => c.rule === 'ROOM_PARTIALLY_UNASSIGNED');
    expect(critical[0]).toMatchObject({ priority: ReminderPriority.CRITICAL });
  });

  it('共享房组（带 sharedRoomId）的 passengerIds 一样算已覆盖——不用另查 SharedRoomMember', () => {
    const fires = buildOrderCandidates(
      fakeOrder({
        items: [hotelItem(roomCheckInHigh)],
        roomAssignment: {
          roomGroups: [
            { passengerIds: ['p1'], sharedRoomId: 'sr1' },
            { passengerIds: ['p2'] },
          ],
        },
        passengers: twoPax,
      }),
      ROOM_TODAY,
    ).some((c) => c.rule === 'ROOM_PARTIALLY_UNASSIGNED');
    expect(fires).toBe(false);
  });

  it('占位联系人（documentNumber=N/A）不算「该有房间的人」，不会被点名遗漏', () => {
    const fires = buildOrderCandidates(
      fakeOrder({
        items: [hotelItem(roomCheckInHigh)],
        roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] },
        passengers: [...twoPax, { id: 'p3', fullName: '占位联系人', passportExpiry: null, documentNumber: 'N/A' }],
      }),
      ROOM_TODAY,
    ).some((c) => c.rule === 'ROOM_PARTIALLY_UNASSIGNED');
    // p2 仍未分房，规则本该触发——这条断言确认 p3（占位）不会让判定提前通过/也不会被误点名
    expect(fires).toBe(true);
  });

  it('全员已分房 / 整单未分房（走 ROOM_UNASSIGNED）/ 入住超窗 / 老口径没取字段 → 不触发', () => {
    const fires = (order: RuleOrder) =>
      buildOrderCandidates(order, ROOM_TODAY).some((c) => c.rule === 'ROOM_PARTIALLY_UNASSIGNED');
    expect(
      fires(
        fakeOrder({
          items: [hotelItem(roomCheckInHigh)],
          roomAssignment: { roomGroups: [{ passengerIds: ['p1', 'p2'] }] },
          passengers: twoPax,
        }),
      ),
    ).toBe(false);
    // 整单一个人都没分：只报 ROOM_UNASSIGNED，不会同时又报一条部分未分房
    expect(
      fires(fakeOrder({ items: [hotelItem(roomCheckInHigh)], roomAssignment: null, passengers: twoPax })),
    ).toBe(false);
    expect(
      fires(
        fakeOrder({
          items: [hotelItem(roomCheckInOverWindow)],
          roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] },
          passengers: twoPax,
        }),
      ),
    ).toBe(false);
    expect(fires(fakeOrder({ items: [hotelItem(roomCheckInHigh)], passengers: twoPax }))).toBe(false);
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

// ── B-14 / C-7-4：触发条件消失后自动核销存量提醒 ────────────────────────────
describe('generateRuleReminders — 触发条件消失后自动核销（B-14/C-7-4）', () => {
  const NOW2 = new Date('2026-07-09T06:00:00Z');
  const departSoon2 = addDaysUtc(businessDateISO(NOW2), 2);

  /** ruleKey → 行状态（模拟 OperationalReminder 唯一索引 + status 列，支持按 id 关闭）。 */
  function makeMockPrisma(
    order: Record<string, unknown> | null,
    preexisting: Array<{ id: string; ruleKey: string; status: ReminderStatus }>,
    /** 模拟并发：自动核销读出存量之后、写回之前，运营手工处理掉某一条 */
    manualResolveAfterScan?: { id: string; status: ReminderStatus; resolvedNote: string },
  ) {
    const rows = new Map<string, { id: string; ruleKey: string; status: ReminderStatus; resolvedNote?: string }>(
      preexisting.map((r) => [r.id, { ...r }]),
    );
    const mock = {
      order: { findMany: vi.fn(async () => (order ? [order] : [])) },
      fulfillmentTask: { findMany: vi.fn(async () => []) },
      holdOrder: { findMany: vi.fn(async () => []) },
      operationalReminder: {
        findMany: vi.fn(
          async (args: {
            where: { ruleKey?: { in: string[] }; status?: { in: ReminderStatus[] } };
          }) => {
            const ruleKeyIn = args.where.ruleKey?.in ?? [];
            const statusIn = args.where.status?.in;
            const matched = [...rows.values()].filter(
              (r) => ruleKeyIn.includes(r.ruleKey) && (!statusIn || statusIn.includes(r.status)),
            );
            if (manualResolveAfterScan && statusIn) {
              const row = rows.get(manualResolveAfterScan.id);
              if (row) {
                row.status = manualResolveAfterScan.status;
                row.resolvedNote = manualResolveAfterScan.resolvedNote;
              }
            }
            return matched;
          },
        ),
        createMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(
          async (args: {
            where: { id: { in: string[] }; status?: { in: ReminderStatus[] } };
            data: { status: ReminderStatus; resolvedNote?: string };
          }) => {
            let count = 0;
            for (const id of args.where.id.in) {
              const row = rows.get(id);
              if (!row) continue;
              // 真 SQL 的 WHERE 会把状态条件一起带上——mock 必须照做，否则测不出覆盖人工结论
              if (args.where.status && !args.where.status.in.includes(row.status)) continue;
              row.status = args.data.status;
              if (args.data.resolvedNote !== undefined) row.resolvedNote = args.data.resolvedNote;
              count += 1;
            }
            return { count };
          },
        ),
      },
    };
    return { mock: mock as unknown as PrismaClient, raw: mock, rows };
  }

  function baseOrder(overrides: Record<string, unknown>) {
    return {
      id: 'ord_x',
      orderNumber: 'FTM2026070900099',
      contactName: '测试联系人',
      status: OrderStatus.PAID,
      total: new Prisma.Decimal('5000'),
      paidAmount: new Prisma.Decimal('2000'),
      prepaymentOffset: new Prisma.Decimal('0'),
      adjustmentCny: 0,
      items: [flightItem(`${departSoon2}T02:00:00Z`)],
      passengers: [],
      ...overrides,
    };
  }

  it('BALANCE_DUE：尾款已付清（balance<=0）→ 存量 OPEN 提醒自动标记 DONE，备注「条件已解除」', async () => {
    const order = baseOrder({ paidAmount: new Prisma.Decimal('5000') }); // 付清
    const ruleKey = `BALANCE:ord_x:${departSoon2}`;
    const { mock, rows } = makeMockPrisma(order, [
      { id: 'r1', ruleKey, status: ReminderStatus.OPEN },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW2);

    expect(rows.get('r1')).toMatchObject({ status: ReminderStatus.DONE });
  });

  it('F8｜读出存量后运营手工完成 → 自动核销不覆盖人工结论（id + status 原子更新，全规则共用）', async () => {
    const order = baseOrder({ paidAmount: new Prisma.Decimal('5000') }); // 付清 → 本该自动核销
    const ruleKey = `BALANCE:ord_x:${departSoon2}`;
    const { mock, rows } = makeMockPrisma(
      order,
      [{ id: 'r1', ruleKey, status: ReminderStatus.OPEN }],
      { id: 'r1', status: ReminderStatus.SKIPPED, resolvedNote: '客人改走公司月结，不用催' },
    );

    await generateRuleReminders(mock, 'user_sys', NOW2);

    expect(rows.get('r1')).toMatchObject({
      status: ReminderStatus.SKIPPED,
      resolvedNote: '客人改走公司月结，不用催',
    });
  });

  it('尾款仍未付清 → 存量提醒保持 OPEN，不误关', async () => {
    const order = baseOrder({}); // paidAmount 2000 < total 5000，仍欠款
    const ruleKey = `BALANCE:ord_x:${departSoon2}`;
    const { mock, rows } = makeMockPrisma(order, [
      { id: 'r1', ruleKey, status: ReminderStatus.OPEN },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW2);

    expect(rows.get('r1')).toMatchObject({ status: ReminderStatus.OPEN });
  });

  it('运营已手工处理过（SKIPPED）→ 不覆盖既有结论', async () => {
    const order = baseOrder({ paidAmount: new Prisma.Decimal('5000') });
    const ruleKey = `BALANCE:ord_x:${departSoon2}`;
    const { mock, rows } = makeMockPrisma(order, [
      { id: 'r1', ruleKey, status: ReminderStatus.SKIPPED },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW2);

    expect(rows.get('r1')).toMatchObject({ status: ReminderStatus.SKIPPED });
  });

  it('TICKET_MISSING：全员票号已回填 → 自动核销', async () => {
    const order = baseOrder({
      passengers: [
        { id: 'pax_1', fullName: '张三', passportExpiry: null, eticketNumber: '999-1234567890' },
      ],
    });
    const ruleKey = `TICKET:ord_x:${departSoon2}`;
    const { mock, rows } = makeMockPrisma(order, [
      { id: 'r1', ruleKey, status: ReminderStatus.OPEN },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW2);

    expect(rows.get('r1')).toMatchObject({ status: ReminderStatus.DONE });
  });

  it('ROOM_UNASSIGNED：分房表已填人 → 自动核销', async () => {
    const order = baseOrder({
      items: [hotelItem(departSoon2)],
      roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] },
    });
    const ruleKey = `ROOMASSIGN:ord_x:${departSoon2}`;
    const { mock, rows } = makeMockPrisma(order, [
      { id: 'r1', ruleKey, status: ReminderStatus.OPEN },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW2);

    expect(rows.get('r1')).toMatchObject({ status: ReminderStatus.DONE });
  });

  it('ROOM_PARTIALLY_UNASSIGNED：遗漏的人补分房表后 → 存量 :PARTIAL 提醒自动核销（整单键不受影响）', async () => {
    const order = baseOrder({
      items: [hotelItem(departSoon2)],
      // 补分之前只有 p1，:PARTIAL 提醒存量 OPEN；这一轮补齐了 p2，两个键都该解除
      roomAssignment: { roomGroups: [{ passengerIds: ['p1', 'p2'] }] },
      passengers: [
        { id: 'p1', fullName: '张三', passportExpiry: null },
        { id: 'p2', fullName: '李四', passportExpiry: null },
      ],
    });
    const wholeKey = `ROOMASSIGN:ord_x:${departSoon2}`;
    const partialKey = `ROOMASSIGN:ord_x:${departSoon2}:PARTIAL`;
    const { mock, rows } = makeMockPrisma(order, [
      { id: 'r1', ruleKey: wholeKey, status: ReminderStatus.OPEN },
      { id: 'r2', ruleKey: partialKey, status: ReminderStatus.OPEN },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW2);

    expect(rows.get('r1')).toMatchObject({ status: ReminderStatus.DONE });
    expect(rows.get('r2')).toMatchObject({ status: ReminderStatus.DONE });
  });

  it('ROOM_PARTIALLY_UNASSIGNED：仍有人没补分房表 → :PARTIAL 提醒保持 OPEN，不误关', async () => {
    const order = baseOrder({
      items: [hotelItem(departSoon2)],
      roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] }, // p2 还没分
      passengers: [
        { id: 'p1', fullName: '张三', passportExpiry: null },
        { id: 'p2', fullName: '李四', passportExpiry: null },
      ],
    });
    const partialKey = `ROOMASSIGN:ord_x:${departSoon2}:PARTIAL`;
    const { mock, rows } = makeMockPrisma(order, [
      { id: 'r2', ruleKey: partialKey, status: ReminderStatus.OPEN },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW2);

    expect(rows.get('r2')).toMatchObject({ status: ReminderStatus.OPEN });
  });

  it('PASSPORT_EXPIRY：护照已续期（有效期覆盖到出发+6个月之后）→ 自动核销', async () => {
    const order = baseOrder({
      passengers: [
        {
          id: 'pax_1',
          fullName: '张三',
          passportExpiry: new Date(`${addMonthsUtc(departSoon2, 12)}T00:00:00Z`),
        },
      ],
    });
    const ruleKey = `PPEXP:pax_1:${departSoon2}`;
    const { mock, rows } = makeMockPrisma(order, [
      { id: 'r1', ruleKey, status: ReminderStatus.OPEN },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW2);

    expect(rows.get('r1')).toMatchObject({ status: ReminderStatus.DONE });
  });

  it('VISA_NOT_SUBMITTED：签证任务仍在办但全员已确认送签（0 待送签）→ 自动核销', async () => {
    const visaOrder = {
      id: 'ord_visa',
      orderNumber: 'FTM2026070900097',
      deletedAt: null,
      items: [flightItem(`${departSoon2}T02:00:00Z`)],
      passengers: [{ fullName: '张三' }],
    };
    const ruleKey = `VISASUBMIT:ord_visa:${departSoon2}`;
    const { mock, raw, rows } = makeMockPrisma(null, [
      { id: 'r1', ruleKey, status: ReminderStatus.OPEN },
    ]);
    (raw as unknown as { fulfillmentTask: { findMany: ReturnType<typeof vi.fn> } }).fulfillmentTask = {
      findMany: vi.fn(async () => [{ id: 'task_1', orderItem: { order: visaOrder } }]),
    };
    (raw as unknown as { passenger: { findMany: ReturnType<typeof vi.fn> } }).passenger = {
      // 无人待送签 = 全员已确认
      findMany: vi.fn(async () => []),
    };

    await generateRuleReminders(mock, 'user_sys', NOW2);

    expect(rows.get('r1')).toMatchObject({ status: ReminderStatus.DONE });
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
    // 出发日锚点三级：机票班次 / 酒店入住 / 签证预计出行日期（纯签证单）；规则 11 不往这里塞 metadata
    expect(orderArgs.select.items.where).toEqual({
      OR: [
        { flightScheduleId: { not: null } },
        { hotelCheckIn: { not: null } },
        { visaIntendedDate: { not: null } },
      ],
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

// ── B8：跨单分房「未分房/部分未分房」提醒状态机 ─────────────────────────────
describe('B8：跨单分房分房提醒状态机（重开 / 旧日期键清理 / 上线日期闸）', () => {
  interface FakeReminderRow {
    id: string;
    ruleKey: string;
    status: ReminderStatus;
    resolvedNote: string | null;
  }

  /**
   * 支持 ruleKey.in / ruleKey.startsWith 两种查法（通用创建流程用 in，B8 状态机用
   * startsWith）。order 传 null 模拟「本轮主扫描一个在途单都没查到」（如唯一一单已取消，
   * 被 SCAN_STATUSES 过滤剔除）；cancelledOrDeletedOrderIds 模拟情形 4 的清理查询
   * （`order.findMany({ where: { id: { in }, OR: [...] } })`）命中的订单 id 白名单——
   * 按调用方是否传了 where.id.in 区分这条查询和主扫描查询，不去抠 OR 条件本身的语义。
   */
  function makeMock(
    order: RuleOrder | null,
    preexisting: FakeReminderRow[],
    opts: { cancelledOrDeletedOrderIds?: string[] } = {},
  ) {
    const rows = new Map(preexisting.map((r) => [r.id, { ...r }]));
    const cancelledOrDeletedIds = new Set(opts.cancelledOrDeletedOrderIds ?? []);
    let seq = 0;
    const mock = {
      order: {
        findMany: vi.fn(async (args?: { where?: { id?: { in?: string[] } } }) => {
          const idIn = args?.where?.id?.in;
          if (idIn) {
            return idIn.filter((id) => cancelledOrDeletedIds.has(id)).map((id) => ({ id }));
          }
          return order ? [order] : [];
        }),
      },
      fulfillmentTask: { findMany: vi.fn(async () => []) },
      holdOrder: { findMany: vi.fn(async () => []) },
      operationalReminder: {
        findMany: vi.fn(
          async (args: {
            where: {
              ruleKey?: { in?: string[]; startsWith?: string };
              status?: { in: ReminderStatus[] };
            };
          }) => {
            const where = args.where;
            let list = [...rows.values()];
            if (where.ruleKey?.in) {
              const keys = where.ruleKey.in;
              list = list.filter((r) => keys.includes(r.ruleKey));
            }
            if (where.ruleKey?.startsWith) {
              const prefix = where.ruleKey.startsWith;
              list = list.filter((r) => r.ruleKey.startsWith(prefix));
            }
            if (where.status?.in) {
              const statuses = where.status.in;
              list = list.filter((r) => statuses.includes(r.status));
            }
            return list.map((r) => ({ ...r }));
          },
        ),
        createMany: vi.fn(
          async (args: { data: Array<{ ruleKey: string }>; skipDuplicates?: boolean }) => {
            let count = 0;
            for (const d of args.data) {
              seq += 1;
              rows.set(`new_${seq}`, {
                id: `new_${seq}`,
                ruleKey: d.ruleKey,
                status: ReminderStatus.OPEN,
                resolvedNote: null,
              });
              count += 1;
            }
            return { count };
          },
        ),
        updateMany: vi.fn(
          async (args: {
            where: { id: { in: string[] } };
            data: { status: ReminderStatus; resolvedNote?: string | null };
          }) => {
            let count = 0;
            for (const id of args.where.id.in) {
              const row = rows.get(id);
              if (row) {
                Object.assign(row, args.data);
                count += 1;
              }
            }
            return { count };
          },
        ),
        update: vi.fn(
          async (args: { where: { id: string }; data: Partial<FakeReminderRow> }) => {
            const row = rows.get(args.where.id);
            if (row) Object.assign(row, args.data);
            return row;
          },
        ),
      },
    };
    return { mock: mock as unknown as PrismaClient, rows };
  }

  // 上线窗口内：入住日选在 ROOM_REMINDER_STATE_MACHINE_SINCE 之后一天。
  const inScopeCheckIn = addDaysUtc(ROOM_REMINDER_STATE_MACHINE_SINCE, 1);
  const NOW_IN_SCOPE = new Date(`${addDaysUtc(inScopeCheckIn, -1)}T06:00:00Z`); // 距入住 1 天

  it('已有 PARTIAL 提醒，分房被整组清空 → 旧 PARTIAL 关闭（不再永远挂着）', async () => {
    const order = fakeOrder({
      items: [hotelItem(inScopeCheckIn)],
      passengers: [
        { id: 'p1', fullName: '张三', passportExpiry: null, documentNumber: 'E1' },
        { id: 'p2', fullName: '李四', passportExpiry: null, documentNumber: 'E2' },
      ],
      // 整组清空：roomGroups 存在但没有任何成员 —— hasRoomAssignment 判定为「未分房」。
      roomAssignment: { roomGroups: [] },
    });
    const partialKey = `ROOMASSIGN:ord_1:${inScopeCheckIn}:PARTIAL`;
    const { mock, rows } = makeMock(order, [
      { id: 'r1', ruleKey: partialKey, status: ReminderStatus.OPEN, resolvedNote: null },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW_IN_SCOPE);

    expect(rows.get('r1')?.status).toBe(ReminderStatus.DONE);
  });

  it('自动核销后条件复发（重新缺人）→ 重开旧提醒，不建重复行', async () => {
    const order = fakeOrder({
      items: [hotelItem(inScopeCheckIn)],
      passengers: [
        { id: 'p1', fullName: '张三', passportExpiry: null, documentNumber: 'E1' },
        { id: 'p2', fullName: '李四', passportExpiry: null, documentNumber: 'E2' },
      ],
      // 现状：只有 p1 在房组里，p2 又被移出——PARTIAL 状态复发。
      roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] },
    });
    const partialKey = `ROOMASSIGN:ord_1:${inScopeCheckIn}:PARTIAL`;
    const { mock, rows } = makeMock(order, [
      {
        id: 'r1',
        ruleKey: partialKey,
        status: ReminderStatus.DONE,
        resolvedNote: AUTO_RESOLVED_NOTE, // 上一轮「全分好了」自动核销
      },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW_IN_SCOPE);

    expect(rows.get('r1')?.status).toBe(ReminderStatus.OPEN);
    expect(rows.get('r1')?.resolvedNote).toBeNull();
    // 没有为同一个 ruleKey 建第二条（唯一索引本来就不允许，这里断言状态机没有尝试建重复行）。
    expect([...rows.values()].filter((r) => r.ruleKey === partialKey)).toHaveLength(1);
  });

  it('人工核销/跳过的提醒——条件复发也不重开，尊重运营判断', async () => {
    const order = fakeOrder({
      items: [hotelItem(inScopeCheckIn)],
      passengers: [
        { id: 'p1', fullName: '张三', passportExpiry: null, documentNumber: 'E1' },
        { id: 'p2', fullName: '李四', passportExpiry: null, documentNumber: 'E2' },
      ],
      roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] },
    });
    const partialKey = `ROOMASSIGN:ord_1:${inScopeCheckIn}:PARTIAL`;
    const { mock, rows } = makeMock(order, [
      {
        id: 'r1',
        ruleKey: partialKey,
        status: ReminderStatus.SKIPPED,
        resolvedNote: '运营已知情，暂不处理', // 人工核销/跳过，不是自动核销
      },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW_IN_SCOPE);

    expect(rows.get('r1')?.status).toBe(ReminderStatus.SKIPPED);
    expect(rows.get('r1')?.resolvedNote).toBe('运营已知情，暂不处理');
  });

  it('入住日期改了——旧日期键关闭，不再永远挂着孤儿提醒', async () => {
    const newCheckIn = addDaysUtc(inScopeCheckIn, 1);
    // 「压根没有分房表」触发 ROOM_UNASSIGNED（整单未分房），用旧日期的 ROOMASSIGN 整单键
    // 模拟改期前留下的孤儿提醒。
    const order = fakeOrder({
      items: [hotelItem(newCheckIn)], // 改期后的新入住日
      passengers: [{ id: 'p1', fullName: '张三', passportExpiry: null, documentNumber: 'E1' }],
      roomAssignment: { roomGroups: [] },
    });
    const staleKey = `ROOMASSIGN:ord_1:${inScopeCheckIn}`; // 改期前的旧日期键
    const { mock, rows } = makeMock(order, [
      { id: 'r1', ruleKey: staleKey, status: ReminderStatus.OPEN, resolvedNote: null },
    ]);

    await generateRuleReminders(mock, 'user_sys', NOW_IN_SCOPE);

    expect(rows.get('r1')?.status).toBe(ReminderStatus.DONE);
    // 新日期键应该被通用创建流程建出来。
    const newRow = [...rows.values()].find((r) => r.ruleKey === `ROOMASSIGN:ord_1:${newCheckIn}`);
    expect(newRow?.status).toBe(ReminderStatus.OPEN);
  });

  it('上线日期闸：入住日在 ROOM_REMINDER_STATE_MACHINE_SINCE 之前——不重开，维持旧行为', async () => {
    // TODAY（2026-07-09）远早于状态机上线日，用它模拟「存量单」。
    const beforeCutoverCheckIn = addDaysUtc(TODAY, 1);
    const order = fakeOrder({
      items: [hotelItem(beforeCutoverCheckIn)],
      passengers: [
        { id: 'p1', fullName: '张三', passportExpiry: null, documentNumber: 'E1' },
        { id: 'p2', fullName: '李四', passportExpiry: null, documentNumber: 'E2' },
      ],
      roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] }, // PARTIAL 复发
    });
    const partialKey = `ROOMASSIGN:ord_1:${beforeCutoverCheckIn}:PARTIAL`;
    const { mock, rows } = makeMock(order, [
      { id: 'r1', ruleKey: partialKey, status: ReminderStatus.DONE, resolvedNote: AUTO_RESOLVED_NOTE },
    ]);

    await generateRuleReminders(mock, 'user_sys', new Date(`${TODAY}T06:00:00Z`));

    // 上线日期闸生效：不重开，维持存量单的旧行为（等运营在待办列表里手动处理，或等它下次
    // 自然进入通用创建流程——通用流程同样因为 ruleKey 已存在而不会重建）。
    expect(rows.get('r1')?.status).toBe(ReminderStatus.DONE);
  });

  it('上线日期闸：入住日在 SINCE 之前——新建也被拦下，不止拦重开（B8 二次修复）', async () => {
    // 从未存在过的 ROOMASSIGN ruleKey（没有任何 preexisting 行）——通用创建流程本会把它
    // 当全新候选建出来，必须靠 buildOrderCandidates 自己按 SINCE 过滤才能拦住。用「不欠
    // 尾款、没有机票段」把其它规则（BALANCE_DUE 等）都关掉，只留 ROOM_UNASSIGNED 一条
    // 候选可能触发，断言才干净。
    const beforeCutoverCheckIn = addDaysUtc(TODAY, 1);
    const order = fakeOrder({
      items: [hotelItem(beforeCutoverCheckIn)],
      passengers: [{ id: 'p1', fullName: '张三', passportExpiry: null, documentNumber: 'E1' }],
      paidAmount: new Prisma.Decimal('5000'), // 付清，不触发 BALANCE_DUE
      roomAssignment: null, // 压根没有分房表 → 满足条件的话该触发 ROOM_UNASSIGNED
    });
    const { mock, rows } = makeMock(order, []);

    await generateRuleReminders(mock, 'user_sys', new Date(`${TODAY}T06:00:00Z`));

    expect([...rows.values()].some((r) => r.ruleKey.startsWith('ROOMASSIGN:'))).toBe(false);
  });

  it('上线日期闸：入住日在 SINCE（含）之后——新建正常', async () => {
    const order = fakeOrder({
      items: [hotelItem(inScopeCheckIn)],
      passengers: [{ id: 'p1', fullName: '张三', passportExpiry: null, documentNumber: 'E1' }],
      paidAmount: new Prisma.Decimal('5000'),
      roomAssignment: null,
    });
    const { mock, rows } = makeMock(order, []);

    await generateRuleReminders(mock, 'user_sys', NOW_IN_SCOPE);

    const created = [...rows.values()].find((r) => r.ruleKey === `ROOMASSIGN:ord_1:${inScopeCheckIn}`);
    expect(created?.status).toBe(ReminderStatus.OPEN);
  });

  it('取消单的旧 ROOMASSIGN 提醒（整单键 + :PARTIAL）被状态机关闭（B8 二次修复）', async () => {
    // 本轮主扫描只查到另一张仍在途、已全部分好房的单（ord_1，不该产生任何新候选）——
    // existing 里还挂着一张已取消订单（ord_cancelled）以前开的 OPEN/IN_PROGRESS 提醒，
    // 它压根不在这轮 orders 里，情形 1–3 的循环访问不到它，必须靠情形 4 的单独清理
    // 查询关掉。
    const order = fakeOrder({
      items: [hotelItem(inScopeCheckIn)],
      passengers: [{ id: 'p1', fullName: '张三', passportExpiry: null, documentNumber: 'E1' }],
      roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] }, // 已分好，本身不产生候选
    });
    const wholeKey = `ROOMASSIGN:ord_cancelled:${inScopeCheckIn}`;
    const partialKey = `ROOMASSIGN:ord_cancelled:${inScopeCheckIn}:PARTIAL`;
    const { mock, rows } = makeMock(
      order,
      [
        { id: 'r1', ruleKey: wholeKey, status: ReminderStatus.OPEN, resolvedNote: null },
        { id: 'r2', ruleKey: partialKey, status: ReminderStatus.IN_PROGRESS, resolvedNote: null },
      ],
      { cancelledOrDeletedOrderIds: ['ord_cancelled'] },
    );

    await generateRuleReminders(mock, 'user_sys', NOW_IN_SCOPE);

    expect(rows.get('r1')?.status).toBe(ReminderStatus.DONE);
    expect(rows.get('r2')?.status).toBe(ReminderStatus.DONE);
  });

  it('existing 里有别的订单缺席的旧提醒，但它不在取消/软删白名单里——维持原状（不误关）', async () => {
    // 对照组：同样「这轮 orders 里没有它」，但 order.findMany 的清理查询判它不是取消/
    // 软删（比如恰好是本轮分页/并发缺席）——不该被一并关掉，只有真正取消/软删才关。
    const order = fakeOrder({
      items: [hotelItem(inScopeCheckIn)],
      passengers: [{ id: 'p1', fullName: '张三', passportExpiry: null, documentNumber: 'E1' }],
      roomAssignment: { roomGroups: [{ passengerIds: ['p1'] }] },
    });
    const wholeKey = `ROOMASSIGN:ord_other:${inScopeCheckIn}`;
    const { mock, rows } = makeMock(
      order,
      [{ id: 'r1', ruleKey: wholeKey, status: ReminderStatus.OPEN, resolvedNote: null }],
      { cancelledOrDeletedOrderIds: [] }, // 白名单不含 ord_other
    );

    await generateRuleReminders(mock, 'user_sys', NOW_IN_SCOPE);

    expect(rows.get('r1')?.status).toBe(ReminderStatus.OPEN);
  });
});

// ── 规则 12：次数升级待核销 ─────────────────────────────────────────────────

describe('UPGRADE_REDEEM_PENDING 次数升级待核销', () => {
  const NOW12 = new Date('2026-07-09T06:00:00Z');

  function leg(
    itemId: string,
    departISO: string,
    flightNumber: string | null = 'QH9588',
    tz: string | null = 'Asia/Shanghai',
  ) {
    return { itemId, departureTime: new Date(departISO), departureTz: tz, flightNumber };
  }

  function markedPax(overrides: Partial<RuleUpgradeRedeemPassenger> = {}): RuleUpgradeRedeemPassenger {
    return {
      passengerId: 'pax_1',
      fullName: '张三',
      orderId: 'ord_1',
      orderNumber: 'FTM2026070900001',
      upgradeRedeemLeg: 'OUTBOUND',
      flights: [leg('item_out', '2026-07-08T02:00:00Z')],
      profileId: 'prof_1',
      redeemedAfterLeg: false,
      ...overrides,
    };
  }

  it('那一程还没起飞 → 不生成（扣早了要冲正）', () => {
    const out = buildUpgradeRedeemCandidates(
      markedPax({ flights: [leg('item_out', '2026-07-15T02:00:00Z')] }),
      TODAY,
      NOW12,
    );
    expect(out).toHaveLength(0);
  });

  it('那一程已起飞且档案上没有这程之后的核销 → 生成一条，key = 乘客 + 航段行（不含日期/档案 id）', () => {
    const out = buildUpgradeRedeemCandidates(markedPax(), TODAY, NOW12);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 'UPGRADE_REDEEM_PENDING',
      ruleKey: 'UPGRADEREDEEM:pax_1:item_out',
      orderId: 'ord_1',
      priority: ReminderPriority.HIGH,
      dueAt: TODAY,
    });
    expect(out[0].ruleKey).toBe(upgradeRedeemRuleKey('pax_1', 'item_out'));
    expect(out[0].title).toContain('次数升级待核销');
    expect(out[0].title).toContain('张三');
    expect(out[0].title).toContain('QH9588');
    expect(out[0].title).toContain('2026-07-08');
    expect(out[0].body).toContain('去程');
  });

  it('档案 id 不进 ruleKey：建档前后同一把键，只有正文提示不同', () => {
    const withProfile = buildUpgradeRedeemCandidates(markedPax(), TODAY, NOW12);
    const without = buildUpgradeRedeemCandidates(markedPax({ profileId: null }), TODAY, NOW12);
    expect(without[0].ruleKey).toBe(withProfile[0].ruleKey);
    expect(without[0].body).toContain('建档');
    expect(withProfile[0].body).not.toContain('建档');
  });

  it('这一程之后已经核销过 → 不再提醒', () => {
    const out = buildUpgradeRedeemCandidates(markedPax({ redeemedAfterLeg: true }), TODAY, NOW12);
    expect(out).toHaveLength(0);
  });

  it('双程（BOTH）按回程判：去程飞了回程没飞不催，回程飞完才催，key/文案取回程那一行', () => {
    const both = markedPax({
      upgradeRedeemLeg: 'BOTH',
      flights: [
        leg('item_out', '2026-07-05T02:00:00Z', 'QH9588'),
        leg('item_ret', '2026-07-12T02:00:00Z', 'QH9589'),
      ],
    });
    expect(buildUpgradeRedeemCandidates(both, TODAY, NOW12)).toHaveLength(0);
    const after = buildUpgradeRedeemCandidates(both, '2026-07-13', new Date('2026-07-13T06:00:00Z'));
    expect(after).toHaveLength(1);
    expect(after[0].ruleKey).toBe('UPGRADEREDEEM:pax_1:item_ret');
    expect(after[0].title).toContain('QH9589');
    expect(after[0].body).toContain('往返');
  });

  it('标了回程却只有单程航段（或回程已释放）→ 目标航段不存在，不提醒', () => {
    const out = buildUpgradeRedeemCandidates(
      markedPax({ upgradeRedeemLeg: 'RETURN', flights: [leg('item_out', '2026-07-08T02:00:00Z')] }),
      TODAY,
      NOW12,
    );
    expect(out).toHaveLength(0);
  });

  it('NONE：不兑换的乘客永远不进这条规则', () => {
    expect(buildUpgradeRedeemCandidates(markedPax({ upgradeRedeemLeg: 'NONE' }), TODAY, NOW12)).toHaveLength(0);
  });
});

describe('upgradeRedeemLegStartMs 核销时间下界按起飞地时区折（F5）', () => {
  it('北京：当地零点 = 前一天 16:00Z，北京 07:00 核销落在下界之后（不再误催）', () => {
    const start = upgradeRedeemLegStartMs({ legDate: '2026-09-20', departureTz: 'Asia/Shanghai' });
    expect(new Date(start).toISOString()).toBe('2026-09-19T16:00:00.000Z');
    // 北京 2026-09-20 07:00 = 2026-09-19T23:00Z，在下界之后 → 算「这一程之后已核销」
    expect(Date.parse('2026-09-19T23:00:00Z') >= start).toBe(true);
    // 前一天北京 23:00 = 2026-09-20T15:00Z 之前，仍在下界之前 → 不算
    expect(Date.parse('2026-09-19T15:00:00Z') >= start).toBe(false);
  });

  it('越南（UTC+7）：当地零点 = 前一天 17:00Z', () => {
    const start = upgradeRedeemLegStartMs({ legDate: '2026-09-20', departureTz: 'Asia/Ho_Chi_Minh' });
    expect(new Date(start).toISOString()).toBe('2026-09-19T17:00:00.000Z');
  });

  it('tz 为空 / 不识别 → 回退 UTC 零点（与 flight-time 其它函数同一个回退口径）', () => {
    expect(new Date(upgradeRedeemLegStartMs({ legDate: '2026-09-20', departureTz: null })).toISOString()).toBe(
      '2026-09-20T00:00:00.000Z',
    );
    expect(new Date(upgradeRedeemLegStartMs({ legDate: '2026-09-20', departureTz: 'UTC' })).toISOString()).toBe(
      '2026-09-20T00:00:00.000Z',
    );
  });
});

describe('resolveProfileMasterId 沿合并链解析主档案（F6）', () => {
  function ref(id: string, mergedIntoId: string | null) {
    return { id, documentType: 'PASSPORT', documentNumber: id.toUpperCase(), mergedIntoId };
  }

  it('A→B→C 连续合并 → 解析到 C（只跳一次会停在 B，永远查错档案）', () => {
    const byId = new Map([
      ['a', ref('a', 'b')],
      ['b', ref('b', 'c')],
      ['c', ref('c', null)],
    ]);
    expect(resolveProfileMasterId('a', byId)).toBe('c');
    expect(resolveProfileMasterId('b', byId)).toBe('c');
    expect(resolveProfileMasterId('c', byId)).toBe('c');
  });

  it('环（脏数据）→ 就地停，不死循环', () => {
    const byId = new Map([
      ['a', ref('a', 'b')],
      ['b', ref('b', 'a')],
    ]);
    expect(resolveProfileMasterId('a', byId)).toBe('b');
  });

  it('下一跳没加载进内存 → 用那个指针目标 id（外键保证它存在）', () => {
    const byId = new Map([['a', ref('a', 'b')]]);
    expect(resolveProfileMasterId('a', byId)).toBe('b');
  });
});

describe('generateRuleReminders — 规则 12 取数、时区、档案链与收敛', () => {
  const NOW12 = new Date('2026-07-09T06:00:00Z');

  interface ReminderRow {
    id: string;
    ruleKey: string;
    status: ReminderStatus;
    resolvedNote?: string | null;
    title?: string;
    body?: string;
    priority?: string;
    dueAt?: Date | null;
    resolvedAt?: Date | null;
  }

  function markedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'pax_1',
      fullName: '张三',
      orderId: 'ord_1',
      documentType: 'PASSPORT',
      documentNumber: ' e12345678 ',
      upgradeRedeemLeg: 'OUTBOUND',
      order: {
        orderNumber: 'FTM2026070900001',
        items: [
          {
            id: 'item_out',
            flightSchedule: {
              departureTime: new Date('2026-07-08T02:00:00Z'),
              departureTz: 'Asia/Shanghai',
              flight: { flightNumber: 'QH9588' },
            },
          },
        ],
      },
      ...overrides,
    };
  }

  function makePrisma(opts: {
    passengers?: Array<Record<string, unknown>>;
    profiles?: Array<{ id: string; documentType: string; documentNumber: string; mergedIntoId: string | null }>;
    redemptions?: Array<{ profileId: string; tripsUsed: number; createdAt: Date }>;
    preexisting?: ReminderRow[];
    /** 模拟并发：reconcile 读出存量之后、写回之前，运营手工处理掉某一条 */
    manualResolveAfterScan?: { id: string; status: ReminderStatus; resolvedNote: string };
  } = {}) {
    const store = new Set<string>();
    const rows = new Map<string, ReminderRow>((opts.preexisting ?? []).map((r) => [r.id, { ...r }]));
    const profiles = opts.profiles ?? [
      { id: 'prof_ptr', documentType: 'PASSPORT', documentNumber: 'E12345678', mergedIntoId: 'prof_master' },
      { id: 'prof_master', documentType: 'PASSPORT', documentNumber: 'E20000000', mergedIntoId: null },
    ];
    const mock = {
      order: { findMany: vi.fn(async () => []) },
      fulfillmentTask: { findMany: vi.fn(async () => []) },
      holdOrder: { findMany: vi.fn(async () => []) },
      passenger: {
        findMany: vi.fn(async (args: { where: { id?: { in: string[] } } }) => {
          const list = opts.passengers ?? [markedRow()];
          const idIn = args.where?.id?.in;
          return idIn ? list.filter((p) => idIn.includes(p.id as string)) : list;
        }),
      },
      travelerProfile: {
        findMany: vi.fn(
          async (args: {
            where: {
              id?: { in: string[] };
              OR?: Array<{ documentType: string; documentNumber: { equals: string } }>;
            };
          }) => {
            if (args.where.id?.in) {
              const wanted = args.where.id.in;
              return profiles.filter((p) => wanted.includes(p.id));
            }
            const wantedDocs = (args.where.OR ?? []).map(
              (o) => `${o.documentType}|${o.documentNumber.equals.trim().toUpperCase()}`,
            );
            return profiles.filter((p) =>
              wantedDocs.includes(`${p.documentType}|${p.documentNumber.trim().toUpperCase()}`),
            );
          },
        ),
      },
      travelerBenefitRedemption: {
        // 带上 args 形参，好让 mock.calls[0][0] 有类型（断言查的是哪些 profileId）
        findMany: vi.fn(async (_args: { where: { profileId: { in: string[] } } }) => opts.redemptions ?? []),
      },
      operationalReminder: {
        findMany: vi.fn(
          async (args: {
            where: {
              ruleKey?: { in?: string[]; startsWith?: string };
              status?: ReminderStatus | { in: ReminderStatus[] };
              resolvedNote?: { in: string[] };
            };
          }) => {
            // 真 SQL 的 status 既可能是标量也可能是 IN，两种都要照做
            const statusOk = (row: ReminderRow) => {
              const s = args.where.status;
              if (s === undefined) return true;
              return typeof s === 'string' ? row.status === s : s.in.includes(row.status);
            };
            const noteOk = (row: ReminderRow) =>
              !args.where.resolvedNote || args.where.resolvedNote.in.includes(row.resolvedNote ?? '');
            const prefix = args.where.ruleKey?.startsWith;
            if (prefix) {
              const matched = [...rows.values()].filter(
                (r) => r.ruleKey.startsWith(prefix) && statusOk(r) && noteOk(r),
              );
              // 读出之后、写回之前运营手工处理（F8 交错执行）
              const manual = opts.manualResolveAfterScan;
              if (manual) {
                const row = rows.get(manual.id);
                if (row) {
                  row.status = manual.status;
                  row.resolvedNote = manual.resolvedNote;
                }
              }
              return matched.map((r) => ({
                id: r.id,
                ruleKey: r.ruleKey,
                title: r.title ?? '',
                body: r.body ?? '',
              }));
            }
            const keyIn = args.where.ruleKey?.in;
            if (keyIn) {
              const matched = [...rows.values()].filter(
                (r) => keyIn.includes(r.ruleKey) && statusOk(r) && noteOk(r),
              );
              // 带条件的是收敛的重开查询，返回行本身；不带条件的是 createMany 前的查重，
              // 它刻意不看 status（DONE 行同样要挡住 createMany），还要算上本轮已建的键
              return args.where.status || args.where.resolvedNote
                ? matched
                : [...matched, ...keyIn.filter((k) => store.has(k)).map((ruleKey) => ({ ruleKey }))];
            }
            return [];
          },
        ),
        // 建出来的条也落进 rows：ruleKey 唯一索引在真库里是硬约束，多轮调用的回归用例
        // （自动核销 → 条件复发 → 重开）全靠 rows 判「是不是还只有那一条」。
        createMany: vi.fn(
          async (args: {
            data: Array<{
              ruleKey: string;
              title: string;
              body: string;
              priority: string;
              dueAt: Date;
            }>;
          }) => {
            let count = 0;
            for (const row of args.data) {
              const exists =
                store.has(row.ruleKey) || [...rows.values()].some((r) => r.ruleKey === row.ruleKey);
              if (exists) continue; // skipDuplicates
              store.add(row.ruleKey);
              const id = `rem_new_${rows.size + 1}`;
              rows.set(id, {
                id,
                ruleKey: row.ruleKey,
                status: ReminderStatus.OPEN,
                resolvedNote: null,
                resolvedAt: null,
                title: row.title,
                body: row.body,
                priority: row.priority,
                dueAt: row.dueAt,
              });
              count += 1;
            }
            return { count };
          },
        ),
        updateMany: vi.fn(
          async (args: {
            where: {
              id: string | { in: string[] };
              status?: ReminderStatus | { in: ReminderStatus[] };
              resolvedNote?: { in: string[] };
            };
            data: Partial<ReminderRow>;
          }) => {
            const ids = typeof args.where.id === 'string' ? [args.where.id] : args.where.id.in;
            let count = 0;
            for (const id of ids) {
              const row = rows.get(id);
              if (!row) continue;
              // 真 SQL 的 WHERE 会把状态/备注条件一起带上——mock 必须照做，
              // 否则测不出「不覆盖人工结论」
              const s = args.where.status;
              if (s !== undefined) {
                const ok = typeof s === 'string' ? row.status === s : s.in.includes(row.status);
                if (!ok) continue;
              }
              if (
                args.where.resolvedNote &&
                !args.where.resolvedNote.in.includes(row.resolvedNote ?? '')
              ) {
                continue;
              }
              Object.assign(row, args.data);
              count += 1;
            }
            return { count };
          },
        ),
      },
    };
    return { mock: mock as unknown as PrismaClient, raw: mock, store, rows };
  }

  it('标了次数升级且已起飞 → 生成一条稳定键；证件号大小写/空格不影响匹配', async () => {
    const { mock, raw, store } = makePrisma();
    const result = await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(result).toMatchObject({ created: 1, byRule: { UPGRADE_REDEEM_PENDING: 1 } });
    expect([...store]).toEqual(['UPGRADEREDEEM:pax_1:item_out']);
    // 只查标过次数升级的乘客，且状态集含 COMPLETED（起飞后订单常已完结）
    const where = raw.passenger.findMany.mock.calls[0][0] as { where: { order: { status: { in: string[] } } } };
    expect(where.where.order.status.in).toContain('COMPLETED');
  });

  it('F6｜档案 A→B→C 连续合并 → 按最终主档案 C 查核销台账（只跳一跳会永远误催）', async () => {
    const { mock, raw } = makePrisma({
      profiles: [
        { id: 'prof_a', documentType: 'PASSPORT', documentNumber: 'E12345678', mergedIntoId: 'prof_b' },
        { id: 'prof_b', documentType: 'PASSPORT', documentNumber: 'E20000000', mergedIntoId: 'prof_c' },
        { id: 'prof_c', documentType: 'PASSPORT', documentNumber: 'E30000000', mergedIntoId: null },
      ],
      redemptions: [{ profileId: 'prof_c', tripsUsed: 1, createdAt: new Date('2026-07-08T09:00:00Z') }],
    });
    const result = await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(raw.travelerBenefitRedemption.findMany.mock.calls[0][0].where.profileId.in).toEqual(['prof_c']);
    // C 上已有这一程之后的核销 → 不再催
    expect(result.byRule.UPGRADE_REDEEM_PENDING).toBeUndefined();
  });

  it('F5｜北京 07:00 核销、10:00 起飞 → 算已核销，不生成（下界按 departureTz 折）', async () => {
    // 起飞：北京 2026-07-08 10:00 = 02:00Z；核销：北京 07:00 = 2026-07-07T23:00Z
    const { mock } = makePrisma({
      redemptions: [{ profileId: 'prof_master', tripsUsed: 1, createdAt: new Date('2026-07-07T23:00:00Z') }],
    });
    const result = await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(result.byRule.UPGRADE_REDEEM_PENDING).toBeUndefined();
  });

  it('F5｜起飞前一天北京 23:00 的核销（当地零点之前）不算这一程 → 照常生成', async () => {
    // 北京 2026-07-07 23:00 = 2026-07-07T15:00Z，早于起飞当地日零点 2026-07-07T16:00Z
    const { mock, store } = makePrisma({
      redemptions: [{ profileId: 'prof_master', tripsUsed: 1, createdAt: new Date('2026-07-07T15:00:00Z') }],
    });
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect([...store]).toContain('UPGRADEREDEEM:pax_1:item_out');
  });

  it('F4｜撤销次数升级标记 / 订单取消 → 本轮扫不到这位乘客，旧待办自动核销', async () => {
    const { mock, rows } = makePrisma({
      passengers: [],
      preexisting: [{ id: 'rem_1', ruleKey: 'UPGRADEREDEEM:pax_1:item_out', status: ReminderStatus.OPEN }],
    });
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.get('rem_1')!.status).toBe(ReminderStatus.DONE);
    expect(rows.get('rem_1')!.resolvedNote).toContain('标记已撤销');
  });

  it('F4｜改期换了航段行 → 旧行的待办自动核销，新行的键接手', async () => {
    const { mock, rows, store } = makePrisma({
      preexisting: [{ id: 'rem_old', ruleKey: 'UPGRADEREDEEM:pax_1:item_old', status: ReminderStatus.OPEN }],
    });
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.get('rem_old')!.status).toBe(ReminderStatus.DONE);
    expect(rows.get('rem_old')!.resolvedNote).toContain('航段已变更');
    expect([...store]).toContain('UPGRADEREDEEM:pax_1:item_out');
  });

  it('F4｜已核销 → 不生成，且存量待办自动核销（备注写明已核销）', async () => {
    const { mock, rows } = makePrisma({
      redemptions: [{ profileId: 'prof_master', tripsUsed: 1, createdAt: new Date('2026-07-08T12:00:00Z') }],
      preexisting: [{ id: 'rem_1', ruleKey: 'UPGRADEREDEEM:pax_1:item_out', status: ReminderStatus.OPEN }],
    });
    const result = await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(result.byRule.UPGRADE_REDEEM_PENDING).toBeUndefined();
    expect(rows.get('rem_1')!.status).toBe(ReminderStatus.DONE);
    expect(rows.get('rem_1')!.resolvedNote).toContain('已核销');
  });

  it('F4｜旧格式键（带起飞日 + 档案 id）→ 一并收敛，新键接手', async () => {
    const { mock, rows, store } = makePrisma({
      preexisting: [
        { id: 'rem_legacy', ruleKey: 'UPGRADEREDEEM:pax_1:2026-07-08:prof_master', status: ReminderStatus.OPEN },
        { id: 'rem_noprof', ruleKey: 'UPGRADEREDEEM:pax_1:2026-07-08:NOPROFILE', status: ReminderStatus.IN_PROGRESS },
      ],
    });
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.get('rem_legacy')!.status).toBe(ReminderStatus.DONE);
    expect(rows.get('rem_noprof')!.status).toBe(ReminderStatus.DONE);
    expect(rows.get('rem_legacy')!.resolvedNote).toContain('键已升级');
    expect([...store]).toContain('UPGRADEREDEEM:pax_1:item_out');
  });

  it('F8｜读出存量后运营手工跳过 → 自动核销不覆盖人工结论（id + status 原子更新）', async () => {
    const { mock, rows } = makePrisma({
      passengers: [],
      preexisting: [{ id: 'rem_1', ruleKey: 'UPGRADEREDEEM:pax_1:item_out', status: ReminderStatus.OPEN }],
      manualResolveAfterScan: {
        id: 'rem_1',
        status: ReminderStatus.SKIPPED,
        resolvedNote: '客人这次不扣次数，已和财务确认',
      },
    });
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.get('rem_1')!.status).toBe(ReminderStatus.SKIPPED);
    expect(rows.get('rem_1')!.resolvedNote).toBe('客人这次不扣次数，已和财务确认');
  });

  it('本规则这一轮没跑（delegate 不全）→ 收敛整个跳过，不误关存量', async () => {
    const { mock, raw, rows } = makePrisma({
      preexisting: [{ id: 'rem_1', ruleKey: 'UPGRADEREDEEM:pax_1:item_out', status: ReminderStatus.OPEN }],
    });
    delete (raw as { travelerBenefitRedemption?: unknown }).travelerBenefitRedemption;
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.get('rem_1')!.status).toBe(ReminderStatus.OPEN);
  });

  it('起飞前不生成任何东西，也不去查档案/台账', async () => {
    const { mock, raw } = makePrisma({
      passengers: [
        markedRow({
          order: {
            orderNumber: 'FTM2026070900001',
            items: [
              {
                id: 'item_out',
                flightSchedule: {
                  departureTime: new Date('2026-07-20T02:00:00Z'),
                  departureTz: 'Asia/Shanghai',
                  flight: { flightNumber: 'QH9588' },
                },
              },
            ],
          },
        }),
      ],
    });
    const result = await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(result).toMatchObject({ created: 0 });
    expect(raw.travelerProfile.findMany).not.toHaveBeenCalled();
    expect(raw.travelerBenefitRedemption.findMany).not.toHaveBeenCalled();
  });

  it('起飞前的那条：上一轮留下的旧待办这一轮就被收敛掉（不永久挂着）', async () => {
    const { mock, rows } = makePrisma({
      passengers: [
        markedRow({
          order: {
            orderNumber: 'FTM2026070900001',
            items: [
              {
                id: 'item_out',
                flightSchedule: {
                  departureTime: new Date('2026-07-20T02:00:00Z'),
                  departureTz: 'Asia/Shanghai',
                  flight: { flightNumber: 'QH9588' },
                },
              },
            ],
          },
        }),
      ],
      preexisting: [{ id: 'rem_1', ruleKey: 'UPGRADEREDEEM:pax_1:item_out', status: ReminderStatus.OPEN }],
    });
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.get('rem_1')!.status).toBe(ReminderStatus.DONE);
    expect(rows.get('rem_1')!.resolvedNote).toContain('尚未起飞');
  });

  // ── N1：自动核销之后条件复发 → 同键重开（稳定键 + ruleKey 唯一索引 + 查重不带 status
  //    三者叠加，不重开就等于这把键永久失声）。三条真实路径各一条回归，都是原地不换键。
  //    每条都跑完整的「建 → 自动核销 → 条件复发」三轮，收尾断言 rows.size===1：重开的是
  //    原来那条，不是又建了一条新的。

  /** 只有一段机票行的乘客快照（行 id / 起飞时刻 / 航班号可变，用来模拟原地改期）。 */
  function markedWithLeg(itemId: string, departureTime: Date, flightNumber = 'QH9588') {
    return markedRow({
      order: {
        orderNumber: 'FTM2026070900001',
        items: [
          {
            id: itemId,
            flightSchedule: { departureTime, departureTz: 'Asia/Shanghai', flight: { flightNumber } },
          },
        ],
      },
    });
  }

  it('N1①｜已飞航段改期到未来（自动核销）→ 新日期也飞完 → 同键重开，只有一条', async () => {
    const passengers = [markedWithLeg('item_out', new Date('2026-07-08T02:00:00Z'))];
    const { mock, rows } = makePrisma({ passengers });

    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.size).toBe(1);
    const id = [...rows.keys()][0];
    expect(rows.get(id)!.status).toBe(ReminderStatus.OPEN);

    // 原地改期到未来：rescheduleOrderItem 对机票行是 update，行 id 不变 → 键不变
    passengers[0] = markedWithLeg('item_out', new Date('2026-07-20T02:00:00Z'));
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.get(id)!.status).toBe(ReminderStatus.DONE);
    expect(rows.get(id)!.resolvedNote).toContain('尚未起飞');

    // 新日期飞完 —— 这时候必须重新喊一声，否则可用次数虚高没人知道
    await generateRuleReminders(mock, 'user_sys', new Date('2026-07-21T06:00:00Z'));
    expect(rows.size).toBe(1);
    expect(rows.get(id)!.status).toBe(ReminderStatus.OPEN);
    expect(rows.get(id)!.resolvedNote).toBeNull();
    expect(rows.get(id)!.resolvedAt).toBeNull();
    // 重开顺带刷成现势文案（新起飞日）
    expect(rows.get(id)!.title).toContain('2026-07-20');
  });

  it('N1②｜订单取消（自动核销）→ 恢复占位 → 同键重开，只有一条', async () => {
    const marked = markedWithLeg('item_out', new Date('2026-07-08T02:00:00Z'));
    const passengers: Array<Record<string, unknown>> = [marked];
    const { mock, rows } = makePrisma({ passengers });

    await generateRuleReminders(mock, 'user_sys', NOW12);
    const id = [...rows.keys()][0];
    expect(rows.get(id)!.status).toBe(ReminderStatus.OPEN);

    // 取消：订单状态出了扫描集，本轮扫不到这位乘客
    passengers.length = 0;
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.get(id)!.status).toBe(ReminderStatus.DONE);
    expect(rows.get(id)!.resolvedNote).toContain('已取消');

    // restore-cancelled 恢复占位：同一位乘客、同一行，键一模一样
    passengers.push(marked);
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.size).toBe(1);
    expect(rows.get(id)!.status).toBe(ReminderStatus.OPEN);
    expect(rows.get(id)!.resolvedNote).toBeNull();
  });

  it('N1③｜台账已核销（自动核销）→ 财务冲正（追加负数补偿行）→ 同键重开，只有一条', async () => {
    // 台账 append-only：冲正不动原行，另追加一条 tripsUsed = −原值 的补偿行
    //（traveler-benefits.service.ts 的 reverse()），时间戳是冲正那一刻，同样落在起飞之后。
    const redemptions: Array<{ profileId: string; tripsUsed: number; createdAt: Date }> = [];
    const { mock, rows } = makePrisma({ redemptions });

    // 第一轮：这一程之后台账上还没有流水 → 建出提醒
    await generateRuleReminders(mock, 'user_sys', NOW12);
    const id = [...rows.keys()][0];
    expect(rows.get(id)!.status).toBe(ReminderStatus.OPEN);

    // 运营去档案里扣了一次 → 净额 +1 → 自动核销
    redemptions.push({
      profileId: 'prof_master',
      tripsUsed: 1,
      createdAt: new Date('2026-07-08T12:00:00Z'),
    });
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.get(id)!.status).toBe(ReminderStatus.DONE);
    expect(rows.get(id)!.resolvedNote).toContain('已核销');

    // 财务冲正：原行原样留着，追加负数补偿行 → 净额回到 0 → 这一程又变回「该扣没扣」
    redemptions.push({
      profileId: 'prof_master',
      tripsUsed: -1,
      createdAt: new Date('2026-07-09T03:00:00Z'),
    });
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.size).toBe(1);
    expect(rows.get(id)!.status).toBe(ReminderStatus.OPEN);
    expect(rows.get(id)!.resolvedNote).toBeNull();
  });

  it('净额口径｜正 1 + 负 1 + 又正 1 → 仍算已核销，不再催', async () => {
    // 冲正之后重新扣了一次（改正档位/金额后重核销）：净额 +1，不该再喊
    const { mock, store } = makePrisma({
      redemptions: [
        { profileId: 'prof_master', tripsUsed: 1, createdAt: new Date('2026-07-08T12:00:00Z') },
        { profileId: 'prof_master', tripsUsed: -1, createdAt: new Date('2026-07-09T03:00:00Z') },
        { profileId: 'prof_master', tripsUsed: 1, createdAt: new Date('2026-07-09T04:00:00Z') },
      ],
    });
    const result = await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(result.byRule.UPGRADE_REDEEM_PENDING).toBeUndefined();
    expect([...store]).toEqual([]);
  });

  it('净额口径｜取数不再按 tripsUsed > 0 过滤（负数补偿行必须一起查出来）', async () => {
    const { mock, raw } = makePrisma();
    await generateRuleReminders(mock, 'user_sys', NOW12);
    const args = raw.travelerBenefitRedemption.findMany.mock.calls[0][0] as unknown as {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    };
    expect(args.where.tripsUsed).toBeUndefined();
    expect(args.select.tripsUsed).toBe(true);
  });

  it('N1｜人工核销（备注是运营自己写的）→ 条件仍在也不重开，且不重复建', async () => {
    const { mock, rows, store } = makePrisma({
      preexisting: [
        {
          id: 'rem_1',
          ruleKey: 'UPGRADEREDEEM:pax_1:item_out',
          status: ReminderStatus.DONE,
          resolvedNote: '这次跟客人说好不扣次数，已和财务确认',
        },
      ],
    });
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.size).toBe(1);
    expect(rows.get('rem_1')!.status).toBe(ReminderStatus.DONE);
    expect(rows.get('rem_1')!.resolvedNote).toBe('这次跟客人说好不扣次数，已和财务确认');
    expect([...store]).toEqual([]); // 唯一索引挡住，也没有悄悄建出第二条
  });

  it('N2｜航段原地改期到另一个已飞日期 → OPEN 条的标题/正文就地刷新（键不变）', async () => {
    const passengers = [markedWithLeg('item_out', new Date('2026-07-08T02:00:00Z'), 'QH9588')];
    const { mock, rows } = makePrisma({ passengers });

    await generateRuleReminders(mock, 'user_sys', NOW12);
    const id = [...rows.keys()][0];
    expect(rows.get(id)!.title).toContain('QH9588');
    expect(rows.get(id)!.title).toContain('2026-07-08');

    // 同一行换了班次和日期（仍在过去）→ 键相同，文案必须跟着走
    passengers[0] = markedWithLeg('item_out', new Date('2026-07-06T02:00:00Z'), 'QH9999');
    await generateRuleReminders(mock, 'user_sys', NOW12);
    expect(rows.size).toBe(1);
    expect(rows.get(id)!.status).toBe(ReminderStatus.OPEN);
    expect(rows.get(id)!.title).toContain('QH9999');
    expect(rows.get(id)!.title).toContain('2026-07-06');
    expect(rows.get(id)!.body).toContain('QH9999');
  });
});
