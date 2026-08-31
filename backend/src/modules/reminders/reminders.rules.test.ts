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
  buildOrderCandidates,
  buildHoldInstallmentCandidates,
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
} from './reminders.rules.js';
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
