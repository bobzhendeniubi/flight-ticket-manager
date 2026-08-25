/**
 * 佣金计提 · 费率比对基准 = 订单出发日（不是计提当刻）· 服务级测试（vitest）
 *
 * 口径（财务）：佣金按**出发日**算——「2026-09-01 及以后起飞的订单才开始计佣金」这类规则，
 * 靠给 CommissionRule 配 effectiveFrom=2026-09-01 落地。所以 createCommissionsForOrder 查费率时
 * 必须拿**本单出发日**去比 effectiveFrom/effectiveTo，而不是 new Date()（计提当刻 ≈ 收款时刻）。
 *   · 8/30 起飞的单，即使今天（9/1 之前）就付款，也不该吃到 9/1 才生效的那档 → 不计佣。
 *   · 今天付款、9 月才飞的单，要按 9 月那档算 → 计佣。这条正是本次改动的意义所在。
 * 整单出发日 = deriveOrderDepartDate（订单列表「出发日期」列同一函数）：取最早航段的当地出发日，
 * 无航段回退最早入住日。往返单按去程（最早）判。
 * 改签不重算：佣金在唯一触达点计提一次即写死，事后出发日变了也不追溯（函数开头的幂等闸保证）。
 *
 * 直接调用 _updateStatusWithinTx（不经公开的 updateStatus）：套路同 orders.status-seats.test.ts
 * —— 该方法的文档就写明"供 payments.handleCallback 等外部事务复用"，传自制 tx mock 是设计内用法；
 * updateStatus 外层会真的连 Redis，不适合无 DB/无 Redis 的纯 mock 单测。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrderStatus, ProductKind, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    orderStatusEvent: { create: vi.fn() },
    orderItem: { findMany: vi.fn() },
    hotelRoomType: { findMany: vi.fn() },
    flightSeatClass: { updateMany: vi.fn(), findFirst: vi.fn() },
    seatLock: { aggregate: vi.fn() },
    holdOrder: { aggregate: vi.fn() },
    refund: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    payment: { aggregate: vi.fn(), updateMany: vi.fn() },
    fulfillmentTask: { updateMany: vi.fn() },
    commissionRecord: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    // 零计提审计（writeAudit）走全局 prisma，而全局 prisma 在本文件被整体 mock 掉了；
    // 不给出 auditLog 桩，写审计会在 writeAudit 内部抛错被吞掉并刷 console.error。
    auditLog: { create: vi.fn() },
    agent: { findUnique: vi.fn() },
    commissionRule: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));
const mockTx = mockPrisma;

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../hotel-control/hotel-control.service.js', () => ({
  assertHotelPhysicalFit: vi.fn(),
  assertRandomTierFit: vi.fn(),
  checkHotelPhysicalFit: vi.fn(),
  getHotelNightlyRemaining: vi.fn(),
  getRandomTierAggregate: vi.fn(),
  randomStarTierLabel: vi.fn(),
}));

import { OrderService, type OrderRequester } from './orders.service.js';

type UpdateStatusTxArg = Parameters<OrderService['_updateStatusWithinTx']>[0];
const tx = mockTx as unknown as UpdateStatusTxArg;

// ── fixtures ──────────────────────────────────────────────────────────────

const decimalLike = (n: number) => ({
  toString: () => String(n),
  greaterThan: (o: { toString: () => string }) => n > Number(o.toString()),
});

const adminRequester: OrderRequester = { userId: 'admin1', role: UserRole.ADMIN, actorType: 'USER' };

/** 计提当刻固定在 2026-08-24（9/1 切换前）——旧口径（比 now）永远匹配不上 9/1 那档，对比才有意义。 */
const ACCRUAL_NOW = new Date('2026-08-24T10:00:00.000Z');

interface RuleRow {
  agentId: string;
  productKind: ProductKind;
  rate: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** 9/1 起生效的佣金规则（财务的「9/1 及以后起飞才计佣」就是这么配的）。 */
const RULE_FROM_SEP1: RuleRow = {
  agentId: 'agent1',
  productKind: ProductKind.FLIGHT,
  rate: 0.1,
  // 上海零点锚：PUT /agents/:id/commission-rules 传 '2026-09-01' 落的就是这个时刻
  // （上海 = UTC+8 → 2026-09-01 00:00 CST = 2026-08-31T16:00Z）。这里刻意写死常量而不调
  // localToUtc，否则测试与实现同源、变成循环论证。
  effectiveFrom: new Date('2026-08-31T16:00:00.000Z'),
  effectiveTo: null,
};

/**
 * 迷你 Prisma：真的按被测代码传进来的 where 过滤固定规则集，而不是让 mock 直接吐回预设结果。
 * 只有这样，「8/30 的单匹配不到 9/1 那档」才是被 where 语义证明的，而不是测试自己摆好的。
 */
function ruleStore(rules: ReadonlyArray<RuleRow>) {
  return (args: {
    where: {
      agentId: { in: string[] };
      productKind: ProductKind;
      effectiveFrom: { lte: Date };
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: Date } }];
    };
  }) => {
    const { agentId, productKind, effectiveFrom, OR } = args.where;
    const fromLte = effectiveFrom.lte;
    const toGte = OR[1].effectiveTo.gte;
    const hit = rules
      .filter(
        (r) =>
          agentId.in.includes(r.agentId) &&
          r.productKind === productKind &&
          r.effectiveFrom.getTime() <= fromLte.getTime() &&
          (r.effectiveTo === null || r.effectiveTo.getTime() >= toGte.getTime()),
      )
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
    return Promise.resolve(hit);
  };
}

/** 一条 FLIGHT 订单行（含联查回来的班次出发时刻/时区——createCommissionsForOrder 靠它派生出发日）。 */
function flightRow(id: string, departureTimeUtc: string, amount = 1000) {
  return {
    id,
    kind: 'FLIGHT',
    amount,
    flightSchedule: {
      departureTime: new Date(departureTimeUtc),
      departureTz: 'Asia/Shanghai',
    },
  };
}

function buildOrder() {
  return {
    id: 'ord1',
    status: OrderStatus.PENDING_PAYMENT,
    userId: 'user1',
    agentId: 'agent1',
    paidAmount: decimalLike(0),
    total: decimalLike(1000),
    // order.items 只喂状态机（PENDING_PAYMENT→PAID 是「占座→占座」，不动库存）；
    // 佣金那边读的是 orderItem.findMany，两处独立。
    items: [
      {
        id: 'item1',
        kind: 'HOTEL',
        quantity: 1,
        flightScheduleId: null,
        flightCabin: null,
        metadata: null,
      },
    ],
  };
}

/**
 * 把一次 PENDING_PAYMENT → PAID 的流转所需 mock 全部搭好。
 * commissionItems = createCommissionsForOrder 将读到的订单行（含 flightSchedule）。
 */
function arrangePaidTransition(commissionItems: ReadonlyArray<Record<string, unknown>>) {
  const order = buildOrder();
  mockPrisma.order.findUnique
    .mockResolvedValueOnce(order) // _updateStatusWithinTx 自己的读
    .mockResolvedValueOnce({ visaStatus: null }); // createFulfillmentTasks 内部读
  mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
  mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
  // 首次计提，幂等闸放行：闸按 productKind 判定，读的是「本单已计提过哪些档」（空 = 一档都没跑过）。
  mockPrisma.commissionRecord.findMany.mockResolvedValueOnce([]);
  mockPrisma.orderItem.findMany
    .mockResolvedValueOnce(commissionItems) // createCommissionsForOrder 的读
    .mockResolvedValueOnce([]); // createFulfillmentTasks 的读
  mockPrisma.commissionRecord.create.mockResolvedValue({});
  mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({ ...order, status: OrderStatus.PAID });
  return order;
}

function runPaidTransition() {
  return new OrderService()._updateStatusWithinTx(
    tx,
    'ord1',
    OrderStatus.PAID,
    adminRequester,
    undefined,
    [],
    false,
    [],
  );
}

/** 本次计提实际发给 commissionRule.findMany 的 where（费率比对基准就藏在这里）。 */
function firstRuleQueryWhere() {
  return mockPrisma.commissionRule.findMany.mock.calls[0][0].where;
}

// ══════════════════════════════════════════════════════════════════════════
describe('createCommissionsForOrder · 费率按订单出发日比对（不是计提当刻）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(ACCRUAL_NOW);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.holdOrder.aggregate.mockResolvedValue({
      _sum: { seats: null, seatsConverted: null, seatsCancelled: null },
    });
    mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.agent.findUnique.mockResolvedValue({ parentAgentId: null }); // 默认单级代理
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('读订单行时必须联查班次 departureTime/departureTz —— 缺了会静默退化成只看入住日', async () => {
    // 这是本改动最容易踩空的一点：deriveOrderDepartDate 只吃已联查的行数据、不另发查询，
    // 扁平 findMany 会让纯机票单派生出 null，费率静默比错且不报错。故把联查本身钉成契约。
    arrangePaidTransition([flightRow('item1', '2026-09-01T02:00:00.000Z')]);
    mockPrisma.commissionRule.findMany.mockImplementation(ruleStore([RULE_FROM_SEP1]));

    await runPaidTransition();

    expect(mockPrisma.orderItem.findMany.mock.calls[0][0]).toEqual({
      where: { orderId: 'ord1' },
      include: { flightSchedule: { select: { departureTime: true, departureTz: true } } },
    });
  });

  it('规则 9/1 起生效、出发日 2026-08-30 → 不计佣金', async () => {
    arrangePaidTransition([flightRow('item1', '2026-08-30T02:00:00.000Z')]); // 上海时间 8/30 10:00
    mockPrisma.commissionRule.findMany.mockImplementation(ruleStore([RULE_FROM_SEP1]));

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
    // 比的确实是出发日那一天，不是计提当刻
    const where = firstRuleQueryWhere();
    // 窗口按**上海**日边界，不是 UTC：上海 8/30 00:00 = 2026-08-29T16:00Z，
    // 上海 8/30 23:59:59.999 = 2026-08-30T15:59:59.999Z。
    expect(where.effectiveFrom.lte.toISOString()).toBe('2026-08-30T15:59:59.999Z');
    expect(where.OR[1].effectiveTo.gte.toISOString()).toBe('2026-08-29T16:00:00.000Z');
  });

  it('规则 9/1 起生效、出发日 2026-09-01 → 计佣金（边界含当天）', async () => {
    arrangePaidTransition([flightRow('item1', '2026-09-01T02:00:00.000Z')]); // 上海时间 9/1 10:00
    mockPrisma.commissionRule.findMany.mockImplementation(ruleStore([RULE_FROM_SEP1]));

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.commissionRecord.create.mock.calls[0][0].data;
    expect(data.agentId).toBe('agent1');
    expect(Number(data.amount)).toBe(100); // 1000 × 10%
  });

  it('北京时间 9/1 凌晨 01:00 起飞（UTC 还停在 8/31）→ 仍算 9/1 起飞，计佣金', async () => {
    // 财务口径的「9 月 1 日」是北京时间。此刻 UTC 日历还是 8/31，若日窗口按 UTC 锚，
    // 这批红眼航班会被算成 8/31、整批吃不到 9/1 的费率。这是 9/1 切换当天的真实风险点。
    arrangePaidTransition([flightRow('item1', '2026-08-31T17:00:00.000Z')]); // 上海时间 9/1 01:00
    mockPrisma.commissionRule.findMany.mockImplementation(ruleStore([RULE_FROM_SEP1]));

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    // 窗口锚在上海 9/1，不是 UTC 9/1
    const where = firstRuleQueryWhere();
    expect(where.OR[1].effectiveTo.gte.toISOString()).toBe('2026-08-31T16:00:00.000Z');
  });

  it('往返单：去程 2026-08-30、回程 2026-09-02 → 按最早的去程判 → 不计佣金', async () => {
    arrangePaidTransition([
      flightRow('leg-out', '2026-08-30T02:00:00.000Z'),
      flightRow('leg-back', '2026-09-02T02:00:00.000Z'),
    ]);
    mockPrisma.commissionRule.findMany.mockImplementation(ruleStore([RULE_FROM_SEP1]));

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
    // 去程日，不是回程日
    expect(firstRuleQueryWhere().effectiveFrom.lte.toISOString()).toBe('2026-08-30T15:59:59.999Z');
  });

  it('计提当刻在 9/1 之前、出发日在 9/1 之后 → 计佣金（本次改动的意义所在）', async () => {
    // 旧口径比 new Date()（此刻 = 2026-08-24）永远匹配不上 9/1 那档 → 一分钱都不会计。
    expect(new Date().toISOString()).toBe(ACCRUAL_NOW.toISOString()); // 前提自检：确实停在 8/24
    arrangePaidTransition([flightRow('item1', '2026-09-20T02:00:00.000Z')]);
    mockPrisma.commissionRule.findMany.mockImplementation(ruleStore([RULE_FROM_SEP1]));

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    expect(Number(mockPrisma.commissionRecord.create.mock.calls[0][0].data.amount)).toBe(100);
  });

  it('出发日派生不出来（无航段无酒店）→ 回退到计提当刻，绝不静默跳过计提', async () => {
    // 纯手工费/保险类单子：宁可按现行费率照算，也不能让代理凭空少一笔应收。
    const ruleFromLastYear: RuleRow = {
      ...RULE_FROM_SEP1,
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
    };
    arrangePaidTransition([{ id: 'item1', kind: 'FLIGHT', amount: 1000, flightSchedule: null }]);
    mockPrisma.commissionRule.findMany.mockImplementation(ruleStore([ruleFromLastYear]));

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    const where = firstRuleQueryWhere();
    expect(where.effectiveFrom.lte.toISOString()).toBe(ACCRUAL_NOW.toISOString());
    expect(where.OR[1].effectiveTo.gte.toISOString()).toBe(ACCRUAL_NOW.toISOString());
  });

  it('多级代理链路的净费率（本级 − 下级）不受本次改动影响', async () => {
    // agent1（直销代理）10%，其上级 agent0 15% → agent1 拿 10%、agent0 只拿差额 5%，合计 15%。
    arrangePaidTransition([flightRow('item1', '2026-09-01T02:00:00.000Z')]);
    mockPrisma.agent.findUnique
      .mockReset()
      .mockResolvedValueOnce({ parentAgentId: 'agent0' })
      .mockResolvedValueOnce({ parentAgentId: null });
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([RULE_FROM_SEP1, { ...RULE_FROM_SEP1, agentId: 'agent0', rate: 0.15 }]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(2);
    const byAgent = new Map<string, Record<string, unknown>>(
      mockPrisma.commissionRecord.create.mock.calls.map((c) => [c[0].data.agentId, c[0].data]),
    );
    expect(Number(byAgent.get('agent1')!.amount)).toBe(100); // 1000 × 10%
    expect(Number(byAgent.get('agent1')!.rate)).toBeCloseTo(0.1, 6);
    expect(byAgent.get('agent1')!.chainDepth).toBe(0);
    expect(Number(byAgent.get('agent0')!.amount)).toBe(50); // 1000 × (15% − 10%)
    expect(Number(byAgent.get('agent0')!.rate)).toBeCloseTo(0.05, 6);
    expect(byAgent.get('agent0')!.chainDepth).toBe(1);
  });

  it('多级链路同样按出发日比：8/30 起飞 → 整条链路一条佣金都不生成', async () => {
    arrangePaidTransition([flightRow('item1', '2026-08-30T02:00:00.000Z')]);
    mockPrisma.agent.findUnique
      .mockReset()
      .mockResolvedValueOnce({ parentAgentId: 'agent0' })
      .mockResolvedValueOnce({ parentAgentId: null });
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([RULE_FROM_SEP1, { ...RULE_FROM_SEP1, agentId: 'agent0', rate: 0.15 }]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
  });
});
