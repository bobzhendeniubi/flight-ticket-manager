/**
 * 佣金计提 · 套餐（BUNDLE）纳入返佣 · 服务级测试（vitest）
 *
 * 背景：ProductKind 此前只有 FLIGHT/HOTEL/TRANSFER/VISA，而订单行 OrderItemKind 是有 BUNDLE 的。
 * 计提侧的 ORDER_ITEM_KIND_TO_PRODUCT_KIND 查不到 BUNDLE → `if (!productKind) continue` 把套餐行
 * 静默跳过，套餐的地面+加项收入一分佣金不计，且不报任何错。套餐是主力产品线，漏计会成片发生。
 *
 * 口径（运营已拍板）：
 *   · 套餐是**独立一档费率**，与机票并列、各配各的 —— 不是复用机票档。
 *   · 计佣基数 = 套餐订单行自身的 amount（套餐行本就是一个整体金额），不去拆套餐的组件。
 *   · 套餐单会拆成 FLIGHT 腿（机票收入）+ BUNDLE 行（地面+加项），两行金额相加即全包价，
 *     互不重叠，所以两者同时计提**不是**重复计佣。
 *
 * 另外钉住冲销侧的对称性：只让 BUNDLE 能计提、却没把它加进冲销的 ALL_PRODUCT_KINDS，
 * 套餐佣金就会「只进不出」—— 退款/取消时取不到 ratio 按 0 处理，静默不冲销。
 *
 * 直接调用 _updateStatusWithinTx（不经公开的 updateStatus）：套路同 orders.commission-depart-rate.test.ts
 * —— 该方法的文档写明"供 payments.handleCallback 等外部事务复用"，传自制 tx mock 是设计内用法。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommissionStatus, OrderStatus, Prisma, ProductKind, UserRole } from '@prisma/client';

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
    // 批准退款时会查本单的预存余额抵扣流水（OFFSET/REFUND）来决定回补多少余额；
    // 本文件只关心佣金冲销，默认喂空流水（= 该单从未用代理余额抵付）。
    prepaymentTransaction: { findMany: vi.fn() },
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
  negated: () => decimalLike(-n),
});

const adminRequester: OrderRequester = { userId: 'admin1', role: UserRole.ADMIN, actorType: 'USER' };

/** 计提当刻固定住，让「无出发日 → 回退当刻」的分支有确定的比较基准。 */
const ACCRUAL_NOW = new Date('2026-08-24T10:00:00.000Z');

interface RuleRow {
  agentId: string;
  productKind: ProductKind;
  rate: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** 早已生效的规则：本文件关心的是「哪一档」，不是生效日，故一律配成远早于计提当刻。 */
function ruleFor(productKind: ProductKind, rate: number, agentId = 'agent1'): RuleRow {
  return {
    agentId,
    productKind,
    rate,
    effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
    effectiveTo: null,
  };
}

/**
 * 迷你 Prisma：真的按被测代码传进来的 where 过滤固定规则集，而不是让 mock 直接吐回预设结果。
 * 只有这样，「BUNDLE 行取到的是 BUNDLE 档而不是 FLIGHT 档」才是被 where 语义证明的。
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

/** 套餐订单行：无联查班次（纯地面套餐），计佣基数就是这一行的 amount。 */
function bundleRow(amount: number, id = 'item-bundle') {
  return { id, kind: 'BUNDLE', amount, flightSchedule: null };
}

/** 套餐单里的机票腿（与 BUNDLE 行同属一张单，走 FLIGHT 档）。 */
function flightRow(id: string, departureTimeUtc: string, amount: number) {
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

/** 不计佣的收入/冲减行（保险 / 机建燃油 / 立减）。 */
function nonCommissionRow(kind: string, amount: number) {
  return { id: `item-${kind.toLowerCase()}`, kind, amount, flightSchedule: null };
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

/** 把一次 PENDING_PAYMENT → PAID 的流转所需 mock 全部搭好。 */
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

/** 本次计提落库的佣金记录，按 productKind 归档（每档最多一条：本文件都是单级代理）。 */
function createdRecordsByKind() {
  return new Map<string, Record<string, unknown>>(
    mockPrisma.commissionRecord.create.mock.calls.map((c) => [c[0].data.productKind, c[0].data]),
  );
}

// ══════════════════════════════════════════════════════════════════════════
describe('createCommissionsForOrder · 套餐（BUNDLE）纳入返佣计提', () => {
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
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue([]); // 无余额抵扣流水
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('代理买套餐 → 按套餐档计佣金（此前整行被静默跳过，一分不计）', async () => {
    arrangePaidTransition([bundleRow(450)]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.commissionRecord.create.mock.calls[0][0].data;
    expect(data.productKind).toBe(ProductKind.BUNDLE);
    expect(data.agentId).toBe('agent1');
    // 计佣基数 = 套餐行自身的 amount，不拆组件
    expect(Number(data.baseAmount)).toBe(450);
    expect(Number(data.amount)).toBe(36); // 450 × 8%
    expect(Number(data.rate)).toBeCloseTo(0.08, 6);
    expect(data.status).toBe(CommissionStatus.ACCRUED);
  });

  it('计提时按 BUNDLE 查费率 —— 查的不是 FLIGHT 档', async () => {
    // 把「取哪一档」钉成对 commissionRule.findMany 的契约：只配 FLIGHT 档、不配 BUNDLE 档时，
    // 套餐行必须查 BUNDLE 档、查不到 → 不计佣。若实现偷懒复用机票档，这里会冒出一条 45 元记录。
    arrangePaidTransition([bundleRow(450)]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.FLIGHT, 0.1)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRule.findMany.mock.calls[0][0].where.productKind).toBe(
      ProductKind.BUNDLE,
    );
    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
  });

  it('套餐档与机票档费率不同 → 套餐行走套餐档、同单机票腿走机票档，各算各的', async () => {
    // 真实套餐单的形态：BUNDLE 行（地面+加项）+ FLIGHT 腿（机票收入），两行金额相加即全包价。
    // 两档费率**故意配成不同**，若哪一行串了档，金额会立刻对不上。
    arrangePaidTransition([bundleRow(450), flightRow('leg-out', '2026-09-01T02:00:00.000Z', 1000)]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08), ruleFor(ProductKind.FLIGHT, 0.03)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(2);
    const byKind = createdRecordsByKind();
    // 套餐行：450 × 8% = 36（走套餐档；若错走机票档 3% 会是 13.5）
    expect(Number(byKind.get(ProductKind.BUNDLE)!.baseAmount)).toBe(450);
    expect(Number(byKind.get(ProductKind.BUNDLE)!.amount)).toBe(36);
    // 机票腿：1000 × 3% = 30（走机票档，不受套餐档影响）
    expect(Number(byKind.get(ProductKind.FLIGHT)!.baseAmount)).toBe(1000);
    expect(Number(byKind.get(ProductKind.FLIGHT)!.amount)).toBe(30);
  });

  it('只配套餐档、没配机票档 → 机票腿不计佣，套餐行照计（两档互不兜底）', async () => {
    arrangePaidTransition([bundleRow(450), flightRow('leg-out', '2026-09-01T02:00:00.000Z', 1000)]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.commissionRecord.create.mock.calls[0][0].data.productKind).toBe(
      ProductKind.BUNDLE,
    );
  });

  it('FEE / DISCOUNT / INSURANCE 行仍然不自成一档计佣金（这次放开没有误伤）', async () => {
    // 这三类要么是代收代付（机建燃油）、要么是冲减（立减）、要么另有口径（保险），
    // 都不自成一档产生佣金记录。把它们和套餐行放同一张单里，证明放开的只有 BUNDLE 这一档。
    // 注意 DISCOUNT 仍然**影响基数**：计佣基数按实收算，立减要从可计提净额里扣掉
    // （见 orders.commission-discount-net-base.test.ts）。这里 G=450、D=−100 → 基数 350。
    arrangePaidTransition([
      bundleRow(450),
      nonCommissionRow('FEE', 300),
      nonCommissionRow('DISCOUNT', -100),
      nonCommissionRow('INSURANCE', 200),
    ]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([
        ruleFor(ProductKind.BUNDLE, 0.08),
        ruleFor(ProductKind.FLIGHT, 0.1),
        ruleFor(ProductKind.HOTEL, 0.1),
        ruleFor(ProductKind.TRANSFER, 0.1),
        ruleFor(ProductKind.VISA, 0.1),
      ]),
    );

    await runPaidTransition();

    // 只有套餐那一行计佣：FEE/DISCOUNT/INSURANCE 连费率都不该去查
    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.commissionRecord.create.mock.calls[0][0].data.productKind).toBe(
      ProductKind.BUNDLE,
    );
    // 基数 = 450 × (450−100)/450 = 350（FEE 300 / INSURANCE 200 不进分母，不稀释比例）
    expect(Number(mockPrisma.commissionRecord.create.mock.calls[0][0].data.baseAmount)).toBe(350);
    expect(Number(mockPrisma.commissionRecord.create.mock.calls[0][0].data.amount)).toBe(28);
    const queriedKinds = mockPrisma.commissionRule.findMany.mock.calls.map(
      (c) => c[0].where.productKind,
    );
    expect(queriedKinds).toEqual([ProductKind.BUNDLE]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('套餐佣金的冲销对称性 · 取消订单必须把 BUNDLE 佣金一并冲掉', () => {
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
    mockPrisma.refund.count.mockResolvedValue(0);
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockPrisma.refund.findMany.mockResolvedValue([]);
    mockPrisma.refund.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.agent.findUnique.mockResolvedValue({ parentAgentId: null });
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue([]); // 无余额抵扣流水
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * 退款申请中 → 已退款（批准退款）：这是已收款订单唯一能走到的释放型终态
   *（PAID 不允许直接转已取消，状态机会拦），也是佣金冲销真正发生的那一步。
   */
  function arrangeApprovedRefund(commissionRecords: ReadonlyArray<Record<string, unknown>>) {
    const order = {
      ...buildOrder(),
      orderNumber: 'ORD-BUNDLE-1',
      status: OrderStatus.REFUND_REQUESTED,
      paidAmount: decimalLike(450),
      items: [], // 无航段/无房：本用例只关心佣金冲销，不牵动座位与房量账
    };
    mockPrisma.order.findUnique.mockResolvedValue(order);
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValue({});
    mockPrisma.orderItem.findMany.mockResolvedValue([]);
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({
      ...order,
      status: OrderStatus.REFUNDED,
    });
    mockPrisma.commissionRecord.findMany.mockResolvedValue(commissionRecords);
    mockPrisma.commissionRecord.update.mockResolvedValue({});
    mockPrisma.commissionRecord.create.mockResolvedValue({});
    // 「已退款」是终态，前置闸要求单上确有退款记录，否则实收会永久挂着。
    mockPrisma.refund.count.mockResolvedValue(1);
    return order;
  }

  function runRefundApproval() {
    return new OrderService()._updateStatusWithinTx(
      tx,
      'ord1',
      OrderStatus.REFUNDED,
      adminRequester,
      undefined,
      [],
      false,
      [],
    );
  }

  /** 一条已计提、尚未进结算单的套餐佣金（用真 Decimal：冲销侧会对它做 mul/negated）。 */
  function accruedBundleRecord() {
    return {
      id: 'cr-bundle',
      agentId: 'agent1',
      orderId: 'ord1',
      productKind: ProductKind.BUNDLE,
      baseAmount: new Prisma.Decimal(450),
      rate: new Prisma.Decimal(0.08),
      amount: new Prisma.Decimal(36),
      chainDepth: 0,
      status: CommissionStatus.ACCRUED,
    };
  }

  it('批准全额退款（无可解析快照）→ 套餐佣金整额冲销，不是静默留着', async () => {
    // 无快照 → 走 fullReversal()：它预填的 ALL_PRODUCT_KINDS 必须含 BUNDLE，
    // 否则这条套餐佣金取不到 ratio、按 0 处理，订单退了代理照样白拿。
    arrangeApprovedRefund([accruedBundleRecord()]);
    // 旧退款 / 脏数据：退款记录在，但没有可解析的报价快照 → 实现退回「整单全额冲销，绝不少冲」。
    mockPrisma.refund.findMany.mockResolvedValue([{ gatewayPayload: null }]);

    await runRefundApproval();

    expect(mockPrisma.commissionRecord.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.commissionRecord.update.mock.calls[0][0]).toEqual({
      where: { id: 'cr-bundle' },
      data: { status: CommissionStatus.REVERSED },
    });
    // 未结算的整额冲销走翻状态，不该另建负数补偿记录
    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
  });

  it('批准部分退款（退 300 / 退改费 150）→ 套餐佣金按 2/3 建负数补偿记录', async () => {
    // 这条最能证伪「BUNDLE 没进 ALL_PRODUCT_KINDS」：快照可解析时，不在名单里的 kind 会被
    // includes() 直接过滤掉 → ratio 缺键 → 按 0 处理 → 一分都不冲。
    arrangeApprovedRefund([accruedBundleRecord()]);
    mockPrisma.refund.findMany.mockResolvedValue([
      {
        gatewayPayload: {
          quoteSnapshot: {
            items: [{ kind: 'BUNDLE', refundAmount: 300, feeAmount: 150 }],
          },
        },
      },
    ]);

    await runRefundApproval();

    // ratio = 300 / (300+150) = 2/3 → 冲销 36 × 2/3 = 24，留存退改费对应的 12
    expect(mockPrisma.commissionRecord.update).not.toHaveBeenCalled();
    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.commissionRecord.create.mock.calls[0][0].data;
    expect(data.productKind).toBe(ProductKind.BUNDLE);
    expect(Number(data.amount)).toBeCloseTo(-24, 2);
    expect(Number(data.baseAmount)).toBeCloseTo(-300, 2);
    expect(data.status).toBe(CommissionStatus.REVERSED);
    expect(data.settlementId).toBeNull();
  });
});
