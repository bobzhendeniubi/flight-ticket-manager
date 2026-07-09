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
  buildVisaCandidates,
  computeBalance,
  deriveDepartureDate,
  formatAmount,
  generateRuleReminders,
  utcDateStr,
  type RuleOrder,
} from './reminders.rules.js';

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
  function makeMockPrisma(orders: unknown[], visaTasks: unknown[]) {
    const store = new Set<string>();
    const mock = {
      order: { findMany: vi.fn(async () => orders) },
      fulfillmentTask: { findMany: vi.fn(async () => visaTasks) },
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

  // 相对今天构造，规则窗口不随真实日期漂移
  const today = utcDateStr(new Date());
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
});
