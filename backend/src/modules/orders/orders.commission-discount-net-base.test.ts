/**
 * 佣金计提 · 计佣基数 = 实收净额（折扣要扣）+ 幂等闸按档 + 零计提落审计 · 服务级测试（vitest）
 *
 * 口径（财务已拍板）：返佣按「实际收到多少钱」算，计佣基数必须扣掉折扣。
 * 旧实现逐行按**毛额**计提，而 DISCOUNT 行（同业立减 / 录单让利 / 代理结算价负差，金额为负）
 * 不在 ORDER_ITEM_KIND_TO_PRODUCT_KIND 里 → 被 `if (!productKind) continue` 跳过 →
 * 折扣一分没扣，代理单系统性多付。真实样例：
 *   BUNDLE 450 + FLIGHT 去 800 + FLIGHT 回 1000 + DISCOUNT −1032
 *   订单实收 ¥1218，旧口径的计佣基数却是 ¥2250（多算 85%）。
 *
 * 分摊算法：折扣按**可计提行**的毛额比例分摊（FEE/INSURANCE/GUIDE/UPGRADE_CHANGE/OVERSALE
 * 既不计佣、也不进分母——FEE 是机建燃油这类代收代付，本就不打折）：
 *   G = Σ可计提行 amount；D = ΣDISCOUNT amount（负）；N = max(0, G+D)；每行基数 = amount × N/G。
 *
 * 另外两件一并钉住：
 *   · 幂等闸粒度 = (订单, productKind)。旧闸判「本单有没有任意一条记录」，套餐单只要机票腿
 *     建成了记录、BUNDLE 档因没配费率建不出，这单就被永久锁死，将来补提脚本一跑就把机票
 *     部分重复计提。按档判定后补提可安全重跑。
 *   · 代理单一条记录都没建 → 落一条 WARNING 审计（旧实现静默返回，财务事后无从发现）。
 *
 * 直接调用 _updateStatusWithinTx（不经公开的 updateStatus）：套路同
 * orders.commission-depart-rate.test.ts —— 该方法的文档写明"供 payments.handleCallback 等外部
 * 事务复用"，传自制 tx mock 是设计内用法。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AuditSeverity,
  AuditTargetType,
  CommissionStatus,
  OrderStatus,
  Prisma,
  ProductKind,
  UserRole,
} from '@prisma/client';

/** 冲销侧对已落库记录做 mul/negated，必须喂真 Decimal（不能用 decimalLike 桩）。 */
const Decimal = Prisma.Decimal;

const { mockPrisma, mockWriteAudit } = vi.hoisted(() => ({
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
    auditLog: { create: vi.fn() },
    agent: { findUnique: vi.fn() },
    commissionRule: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
  mockWriteAudit: vi.fn(),
}));
const mockTx = mockPrisma;

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
// 零计提审计直接断言在 writeAudit 的入参上（比反推 auditLog.create 的落库形状更贴近契约）。
vi.mock('../../lib/audit.js', () => ({
  writeAudit: mockWriteAudit,
  actorFromRequest: vi.fn(() => ({})),
  getAuditFailureCount: vi.fn(() => 0),
}));
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
const ACCRUAL_NOW = new Date('2026-08-25T10:00:00.000Z');

interface RuleRow {
  agentId: string;
  productKind: ProductKind;
  rate: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** 早已生效的规则：本文件关心的是基数与闸，不是生效日，故一律配成远早于计提当刻。 */
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
 * 这样「某一档查得到 / 查不到费率」是被 where 语义证明的，而不是测试自己摆好的。
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

/** 套餐订单行（无联查班次）。 */
function bundleRow(amount: number, id = 'item-bundle') {
  return { id, kind: 'BUNDLE', amount, flightSchedule: null };
}

/** 机票腿（带联查班次，供出发日派生）。 */
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

/** 不自成一档的行（DISCOUNT / FEE / INSURANCE …）。 */
function plainRow(kind: string, amount: number, id = `item-${kind.toLowerCase()}`) {
  return { id, kind, amount, flightSchedule: null };
}

function buildOrder() {
  return {
    id: 'ord1',
    orderNumber: 'FTM2026082562794',
    status: OrderStatus.PENDING_PAYMENT,
    userId: 'user1',
    agentId: 'agent1',
    paidAmount: decimalLike(0),
    total: decimalLike(1218),
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
 * accruedKinds = 幂等闸将读到的「本单已计提过的档」（默认空 = 一档都没跑过）。
 */
function arrangePaidTransition(
  commissionItems: ReadonlyArray<Record<string, unknown>>,
  accruedKinds: ReadonlyArray<ProductKind> = [],
) {
  const order = buildOrder();
  mockPrisma.order.findUnique
    .mockResolvedValueOnce(order) // _updateStatusWithinTx 自己的读
    .mockResolvedValueOnce({ visaStatus: null }); // createFulfillmentTasks 内部读
  mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
  mockPrisma.orderStatusEvent.create.mockResolvedValueOnce({});
  mockPrisma.commissionRecord.findMany.mockResolvedValueOnce(
    accruedKinds.map((productKind) => ({ productKind })),
  );
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

/** 本次落库的所有佣金记录 data。 */
function createdRecords(): Array<Record<string, unknown>> {
  return mockPrisma.commissionRecord.create.mock.calls.map((c) => c[0].data);
}

/** 某一档的所有记录（多航段会有多条 FLIGHT）。 */
function recordsOfKind(kind: ProductKind): Array<Record<string, unknown>> {
  return createdRecords().filter((d) => d.productKind === kind);
}

/** 分转整：金额比较一律走整数分，避免测试自身被浮点尾巴绊倒。 */
function sumCny(rows: ReadonlyArray<Record<string, unknown>>, field: string): number {
  return Math.round(rows.reduce((sum, d) => sum + Number(d[field]) * 100, 0)) / 100;
}

/** 某一档的计佣基数合计（逐行 round2 后相加）。 */
function baseSumOfKind(kind: ProductKind): number {
  return sumCny(recordsOfKind(kind), 'baseAmount');
}

function baseSumAll(): number {
  return sumCny(createdRecords(), 'baseAmount');
}

function commonBeforeEach() {
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
  mockWriteAudit.mockResolvedValue(undefined);
}

// ══════════════════════════════════════════════════════════════════════════
describe('createCommissionsForOrder · 计佣基数扣折扣（按实收算，不按毛额）', () => {
  beforeEach(commonBeforeEach);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('线上真实单形态：套餐 450 + 机票 800/1000 + 立减 −1032 → 基数合计 = 实收 1218，不是毛额 2250', async () => {
    // G=2250、D=−1032、N=1218、ratio=1218/2250=0.541333…
    //   BUNDLE  450 × ratio = 243.60
    //   FLIGHT  800 × ratio = 433.07（433.0666… → round2）
    //   FLIGHT 1000 × ratio = 541.33（541.3333… → round2）
    // 旧口径（毛额）会是 450 / 800 / 1000，合计 2250 —— 多算 85%。
    arrangePaidTransition([
      bundleRow(450),
      flightRow('leg-out', '2026-09-10T02:00:00.000Z', 800),
      flightRow('leg-ret', '2026-09-14T02:00:00.000Z', 1000),
      plainRow('DISCOUNT', -1032),
    ]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08), ruleFor(ProductKind.FLIGHT, 0.03)]),
    );

    await runPaidTransition();

    expect(baseSumOfKind(ProductKind.BUNDLE)).toBe(243.6);
    expect(baseSumOfKind(ProductKind.FLIGHT)).toBe(974.4);
    // 分摊守恒：三行基数合计 = 可计提净额 = 订单实收
    expect(baseSumAll()).toBe(1218);
    // 佣金各按自己档的费率算（套餐 8% / 机票 3%），不串档
    const bundle = recordsOfKind(ProductKind.BUNDLE);
    expect(bundle).toHaveLength(1);
    expect(Number(bundle[0].amount)).toBeCloseTo(19.49, 2); // 243.60 × 8%
    const flights = recordsOfKind(ProductKind.FLIGHT)
      .map((d) => Number(d.amount))
      .sort((a, b) => a - b);
    expect(flights).toEqual([12.99, 16.24]); // 433.07×3%=12.9921→12.99；541.33×3%=16.2399→16.24
  });

  it('无折扣的单 → 基数 = 毛额（存量语义一个字不变）', async () => {
    arrangePaidTransition([bundleRow(450), flightRow('leg-out', '2026-09-10T02:00:00.000Z', 1000)]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08), ruleFor(ProductKind.FLIGHT, 0.03)]),
    );

    await runPaidTransition();

    expect(baseSumOfKind(ProductKind.BUNDLE)).toBe(450);
    expect(baseSumOfKind(ProductKind.FLIGHT)).toBe(1000);
    expect(Number(recordsOfKind(ProductKind.BUNDLE)[0].amount)).toBe(36); // 450 × 8%
    expect(Number(recordsOfKind(ProductKind.FLIGHT)[0].amount)).toBe(30); // 1000 × 3%
  });

  it('折扣吃光可计提净额（N=0）→ 一条佣金记录都不建（不建 0 元记录、更不建负数）', async () => {
    arrangePaidTransition([bundleRow(450), plainRow('DISCOUNT', -450)]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
  });

  it('折扣超过可计提毛额（N 被 clamp 到 0）→ 同样不建记录，绝不出现负基数/负佣金', async () => {
    // 极端脏数据防御：立减 + 结算价负差叠加，理论上能把 G+D 摁成负数。
    arrangePaidTransition([bundleRow(450), plainRow('DISCOUNT', -600)]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
  });

  it('FEE 行既不计佣、也不进分摊分母（机建燃油代收代付，不参与打折）', async () => {
    // 同一张单：BUNDLE 400 + FEE 600 + DISCOUNT −100。
    //   正确口径：G=400（只有 BUNDLE）→ ratio=(400−100)/400=0.75 → 基数 300。
    //   若把 FEE 错误算进分母：G=1000 → ratio=0.9 → 基数 360 —— 折扣没扣干净、基数虚高。
    // 两个数差得足够远，FEE 一旦进分母立刻会被这条按住。
    arrangePaidTransition([bundleRow(400), plainRow('FEE', 600), plainRow('DISCOUNT', -100)]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    expect(baseSumOfKind(ProductKind.BUNDLE)).toBe(300);
    expect(Number(recordsOfKind(ProductKind.BUNDLE)[0].amount)).toBe(24); // 300 × 8%
    // FEE 也没有自成一档去查费率
    const queriedKinds = mockPrisma.commissionRule.findMany.mock.calls.map(
      (c) => c[0].where.productKind,
    );
    expect(queriedKinds).toEqual([ProductKind.BUNDLE]);
  });

  it('多级代理链路：净费率逻辑在净额基数下仍然正确（上级只拿差额，合计不超总费率）', async () => {
    // 链路 agent1（卖家 5%）→ agent2（上级 8%）；单：BUNDLE 1000 + DISCOUNT −200 → 基数 800。
    //   卖家    = 800 × 5%            = 40
    //   上级    = 800 × (8%−5%)=3%    = 24
    //   合计 64 = 800 × 8%（链路总费率），不因分摊而破。
    arrangePaidTransition([bundleRow(1000), plainRow('DISCOUNT', -200)]);
    mockPrisma.agent.findUnique
      .mockResolvedValueOnce({ parentAgentId: 'agent2' })
      .mockResolvedValueOnce({ parentAgentId: null });
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([
        ruleFor(ProductKind.BUNDLE, 0.05, 'agent1'),
        ruleFor(ProductKind.BUNDLE, 0.08, 'agent2'),
      ]),
    );

    await runPaidTransition();

    const byAgent = new Map(createdRecords().map((d) => [d.agentId as string, d]));
    expect(byAgent.size).toBe(2);
    // 两级拿到的是同一个净额基数（不是各自按毛额算）
    expect(Number(byAgent.get('agent1')!.baseAmount)).toBe(800);
    expect(Number(byAgent.get('agent2')!.baseAmount)).toBe(800);
    expect(Number(byAgent.get('agent1')!.amount)).toBeCloseTo(40, 2);
    expect(Number(byAgent.get('agent2')!.amount)).toBeCloseTo(24, 2);
    expect(Number(byAgent.get('agent1')!.chainDepth)).toBe(0);
    expect(Number(byAgent.get('agent2')!.chainDepth)).toBe(1);
    // 链路合计 = 基数 × 顶级费率（8%），净费率没被基数改动带偏
    const total = Number(byAgent.get('agent1')!.amount) + Number(byAgent.get('agent2')!.amount);
    expect(total).toBeCloseTo(64, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('createCommissionsForOrder · 幂等闸粒度 = (订单, productKind)', () => {
  beforeEach(commonBeforeEach);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('已有 FLIGHT 记录、无 BUNDLE 记录 → 重跑只补 BUNDLE，绝不重复建 FLIGHT', async () => {
    // 这正是套餐单的真实处境：付款时机票腿命中费率建了记录、BUNDLE 档没配费率建不出。
    // 旧的整单粒度闸会把这张单永久锁死（补提脚本一跑就把机票部分重复计提）。
    arrangePaidTransition(
      [bundleRow(450), flightRow('leg-out', '2026-09-10T02:00:00.000Z', 1000)],
      [ProductKind.FLIGHT], // 本单 FLIGHT 档已计提过
    );
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08), ruleFor(ProductKind.FLIGHT, 0.03)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    expect(recordsOfKind(ProductKind.FLIGHT)).toHaveLength(0); // 已计提过的档不重建
    expect(baseSumOfKind(ProductKind.BUNDLE)).toBe(450);
    // 已计提过的档连费率都不必查
    const queriedKinds = mockPrisma.commissionRule.findMany.mock.calls.map(
      (c) => c[0].where.productKind,
    );
    expect(queriedKinds).toEqual([ProductKind.BUNDLE]);
  });

  it('补提场景下折扣比例按整单算 —— 补的那一档拿到的基数与首次计提口径一致', async () => {
    // 同一张真实单，FLIGHT 已在首次计提时按净额建过记录；补 BUNDLE 时 ratio 必须仍按整单
    // （G=2250、D=−1032）算，得 243.60，而不是拿「剩下没计提的那部分」重算出别的比例。
    arrangePaidTransition(
      [
        bundleRow(450),
        flightRow('leg-out', '2026-09-10T02:00:00.000Z', 800),
        flightRow('leg-ret', '2026-09-14T02:00:00.000Z', 1000),
        plainRow('DISCOUNT', -1032),
      ],
      [ProductKind.FLIGHT],
    );
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08), ruleFor(ProductKind.FLIGHT, 0.03)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    expect(baseSumOfKind(ProductKind.BUNDLE)).toBe(243.6);
  });

  it('所有可计提档都已有记录 → 提前 return，不查链路、不查费率、不建记录', async () => {
    arrangePaidTransition([bundleRow(450)], [ProductKind.BUNDLE]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
    expect(mockPrisma.agent.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.commissionRule.findMany).not.toHaveBeenCalled();
    // 幂等命中不是异常，不该惊动财务
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('闸不区分 status：已冲销的档同样算跑过，force 复活不会二次计佣', async () => {
    // 幂等读取的是「这一档有没有任何记录」，与 status 无关。若把 REVERSED 当"没跑过"，
    // force 把一张退过款的单复活到 PAID，就会在负数冲销记录之上再计一遍正数，代理白拿一份。
    // 这里用「已有 BUNDLE 记录」表达该档已生成过（无论它当前是 ACCRUED 还是 REVERSED）。
    arrangePaidTransition([bundleRow(450)], [ProductKind.BUNDLE]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.findMany).toHaveBeenCalledWith({
      where: { orderId: 'ord1' }, // 没有 status 过滤 —— 任何状态的记录都算"这一档跑过"
      select: { productKind: true },
      distinct: ['productKind'],
    });
    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('createCommissionsForOrder · 零计提落审计（可见性）', () => {
  beforeEach(commonBeforeEach);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('代理单一条规则都没命中 → 落 WARNING 审计，带上订单号/代理/出发日/涉及档位', async () => {
    // 费率没配（新代理 / 新产品档）是最常见的零计提原因。旧实现静默返回：零日志、零审计、
    // 零告警，财务事后无从发现「这单为什么没佣金」。
    arrangePaidTransition([bundleRow(450), flightRow('leg-out', '2026-09-10T02:00:00.000Z', 1000)]);
    mockPrisma.commissionRule.findMany.mockImplementation(ruleStore([])); // 一条规则都没配

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    const entry = mockWriteAudit.mock.calls[0][0];
    expect(entry.action).toBe('COMMISSION_ACCRUAL_EMPTY');
    expect(entry.targetType).toBe(AuditTargetType.COMMISSION);
    expect(entry.severity).toBe(AuditSeverity.WARNING);
    expect(entry.targetId).toBe('ord1');
    expect(entry.targetLabel).toBe('FTM2026082562794');
    // 内容要能让人直接查：订单号、卖家代理与整条链路、出发日、涉及的档位
    expect(entry.after).toMatchObject({
      orderId: 'ord1',
      orderNumber: 'FTM2026082562794',
      sellerAgentId: 'agent1',
      agentChain: ['agent1'],
      departDate: '2026-09-10',
    });
    expect(new Set(entry.after.productKinds)).toEqual(
      new Set([ProductKind.BUNDLE, ProductKind.FLIGHT]),
    );
  });

  it('折扣吃光净额导致零计提 → 同样落审计，且毛额/折扣/净额三个数都在里面', async () => {
    arrangePaidTransition([bundleRow(450), plainRow('DISCOUNT', -450)]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08)]),
    );

    await runPaidTransition();

    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit.mock.calls[0][0].after).toMatchObject({
      grossCommissionableCny: 450,
      discountCny: -450,
      netCommissionableCny: 0,
    });
  });

  it('正常计出佣金的单 → 不落零计提审计（没有噪音告警）', async () => {
    arrangePaidTransition([bundleRow(450)]);
    mockPrisma.commissionRule.findMany.mockImplementation(
      ruleStore([ruleFor(ProductKind.BUNDLE, 0.08)]),
    );

    await runPaidTransition();

    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('冲销对称性 · 基数改净额后，退款冲销仍然把这笔佣金冲干净', () => {
  // 冲销侧读的是**已落库记录自身**的 baseAmount/amount，再乘一个比例，所以基数从毛额改净额
  // 天然对称——但必须钉住，否则"计提按净额、冲销按别的口径"会留下永久差额。
  // 冲销比例 ratio = 退款额 ÷ (退款额+退改费)，两者在报价里被同一个 feeScale 缩放过，
  // 比值与毛/净无关（见 lib/cancellation.ts computeRefundBreakdown 的注释），
  // 所以这里用真实例子里那条净额记录（基数 243.60 / 佣金 19.49）验证。
  beforeEach(() => {
    commonBeforeEach();
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockPrisma.refund.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.commissionRecord.update.mockResolvedValue({});
    mockPrisma.commissionRecord.create.mockResolvedValue({});
    mockPrisma.orderItem.findMany.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 计提侧按净额落库的那条套餐佣金（真实例子：基数 243.60、8% → 19.49）。 */
  function netBasedBundleRecord() {
    return {
      id: 'cr-bundle-net',
      agentId: 'agent1',
      orderId: 'ord1',
      productKind: ProductKind.BUNDLE,
      baseAmount: new Decimal(243.6),
      rate: new Decimal(0.08),
      amount: new Decimal(19.49),
      chainDepth: 0,
      status: CommissionStatus.ACCRUED,
    };
  }

  function arrangeApprovedRefund() {
    const order = {
      ...buildOrder(),
      status: OrderStatus.REFUND_REQUESTED,
      paidAmount: decimalLike(1218),
      items: [], // 无航段/无房：本用例只关心佣金冲销，不牵动座位与房量账
    };
    mockPrisma.order.findUnique.mockResolvedValue(order);
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.orderStatusEvent.create.mockResolvedValue({});
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({
      ...order,
      status: OrderStatus.REFUNDED,
    });
    mockPrisma.commissionRecord.findMany.mockResolvedValue([netBasedBundleRecord()]);
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

  it('全额退款 → 净额记录整条翻 REVERSED，代理净得 0（不留残值）', async () => {
    arrangeApprovedRefund();
    mockPrisma.refund.findMany.mockResolvedValue([
      {
        gatewayPayload: {
          quoteSnapshot: { items: [{ kind: 'BUNDLE', refundAmount: 243.6, feeAmount: 0 }] },
        },
      },
    ]);

    await runRefundApproval();

    expect(mockPrisma.commissionRecord.update).toHaveBeenCalledWith({
      where: { id: 'cr-bundle-net' },
      data: { status: CommissionStatus.REVERSED },
    });
    expect(mockPrisma.commissionRecord.create).not.toHaveBeenCalled();
  });

  it('部分退款（退 2/3、留 1/3 退改费）→ 冲销额是净额佣金的 2/3，不是毛额佣金的 2/3', async () => {
    // ratio = 162.4 / (162.4 + 81.2) = 2/3
    //   净额口径：19.49 × 2/3 = 12.99  ← 正确
    //   毛额口径（旧）：36 × 2/3 = 24   ← 会把从未计提过的钱冲掉，账面凭空多冲 11 元
    arrangeApprovedRefund();
    mockPrisma.refund.findMany.mockResolvedValue([
      {
        gatewayPayload: {
          quoteSnapshot: { items: [{ kind: 'BUNDLE', refundAmount: 162.4, feeAmount: 81.2 }] },
        },
      },
    ]);

    await runRefundApproval();

    expect(mockPrisma.commissionRecord.update).not.toHaveBeenCalled();
    expect(mockPrisma.commissionRecord.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.commissionRecord.create.mock.calls[0][0].data;
    expect(data.productKind).toBe(ProductKind.BUNDLE);
    expect(Number(data.amount)).toBeCloseTo(-12.99, 2); // 19.49 × 2/3
    expect(Number(data.baseAmount)).toBeCloseTo(-162.4, 2); // 243.60 × 2/3 = 本次实退的那部分基数
    expect(data.status).toBe(CommissionStatus.REVERSED);
    expect(data.settlementId).toBeNull();
    // 净得 = 19.49 − 12.99 = 6.50，正好对应留存的退改费那 1/3
    expect(19.49 + Number(data.amount)).toBeCloseTo(6.5, 2);
  });
});
