/**
 * SettlementRequestsService · 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 这条通道的立身之本是「钱只由服务端按一条调价通道动」，两条支路各盯一组不变量：
 *   自助直通（代理 + 自家单 + 未锁价）
 *     1. 落 APPROVED（决定人=本人）+ 在同一个事务里调调价内核 + selfApplied=true
 *     2. 已锁价 → 回落 PENDING，钱一分不动（照旧等运营）
 *     3. 已进结算单 / 已开票 / 改后低于已收款 → 拒，且不落任何记录
 *     4. 调价内核抛错 → 错误原样透出，整个事务回滚（不再手工删记录）
 *     4b. 连提两次 → 第二次读到的是已经改过的应收，只落一次差额（不会叠加两遍）
 *     4c. 库里留着「APPROVED 但差额行没落」的自助记录 → 409，不按旧应收再算一份
 *   共通
 *     5. 非归属代理提交 → 403（不能替别家的单议价）
 *     6. 同单已有 PENDING → 409（一单一议，不许排队压价）
 *     7. 差额超单笔调整上限 → 400；申请价与当前应收一致 → 400
 *     8. 运营提交 → 照旧只落 PENDING
 *     9. 确认 → 走既有调价通道生成差额行，行 id 落 appliedAdjustmentItemId
 *    10. 确认时调价通道抛错（结算锁/已开票等）→ 错误原样透出，申请回到 PENDING
 *    11. 驳回 → 只改状态，订单一分钱不动；非 PENDING 再处理 → 409（幂等）
 *   指定乘客范围（作用范围 = 某一位乘客，口径 = 调整净额）
 *    12. 自助直通 → 差额行挂这位乘客名下，金额就是填的净额；姓名快照落库
 *    13. 乘客不属于本单 → 400，不落记录不动钱
 *    14. 已锁价 → 照旧落 PENDING，净额存下来等运营
 *    15. 确认 → 差额读那笔固定净额（期间应收被别的操作改过也不反推），作用范围透传
 *    16. 净额缺失的脏数据 → 拒绝确认，不猜金额
 *
 * 不覆盖（需真 DB）：FOR UPDATE 行锁的实际串行化效果、部分唯一索引的并发兜底。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus, Prisma, SettlementRequestStatus, UserRole } from '@prisma/client';

const { mockPrisma, mockGetDescendantAgentIds } = vi.hoisted(() => ({
  mockPrisma: {
    agent: { findUnique: vi.fn() },
    order: { findUnique: vi.fn() },
    // 自助直通的「已进结算单」闸查的是本单佣金行有没有被某期结算单收走。
    commissionRecord: { findFirst: vi.fn() },
    // 「指定乘客」范围要先确认这位乘客属于本单。
    passenger: { findUnique: vi.fn() },
    settlementRequest: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
    // 回调形态（create/approve/reject）：把 mockPrisma 自己当 tx 传进去；
    // 数组形态（list）：Promise.all 语义。
    $transaction: vi.fn(),
  },
  mockGetDescendantAgentIds: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../lib/agent-tree.js', () => ({ getDescendantAgentIds: mockGetDescendantAgentIds }));

import type { OrderService } from '../orders/orders.service.js';
import {
  SettlementRequestsService,
  AGENT_SELF_SETTLEMENT_REASON_TEXT,
  SETTLEMENT_REQUEST_REASON_TEXT,
  receivableCny,
} from './settlement-requests.service.js';

const AGENT_USER = { userId: 'agent-user-1', role: UserRole.AGENT };
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN };

const AT = new Date('2026-09-01T00:00:00.000Z');

/** 应收 13500 的在售订单（归属 agent-1）。 */
function orderFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'FTM2026090100001',
    agentId: 'agent-1',
    status: OrderStatus.PENDING_PAYMENT,
    deletedAt: null,
    total: new Prisma.Decimal(13500),
    adjustmentCny: 0,
    // 自助直通那一支要看的四列（缺省 = 未锁价 / 未收款 / 未开票 → 可自助）。
    settlementLocked: false,
    paidAmount: new Prisma.Decimal(0),
    outboundInvoiced: false,
    returnInvoiced: false,
    systemInvoiced: false,
    ...overrides,
  };
}

function requestFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    orderId: 'order-1',
    agentId: 'agent-1',
    requestedById: 'agent-user-1',
    requestedTotalCny: new Prisma.Decimal(12800),
    systemTotalCny: new Prisma.Decimal(13500),
    // 缺省 = 整单申请；「指定乘客」的用例各自覆盖这三列。
    passengerId: null,
    passengerName: null,
    requestedAdjustmentCny: null,
    note: '同行价',
    status: SettlementRequestStatus.PENDING,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    appliedAdjustmentItemId: null,
    createdAt: AT,
    agent: { id: 'agent-1', companyName: '示例商旅', contactName: '联系人' },
    order: {
      orderNumber: 'FTM2026090100001',
      total: new Prisma.Decimal(13500),
      adjustmentCny: 0,
      _count: { passengers: 2 },
    },
    ...overrides,
  };
}

/**
 * 假的调价通道：钱只应该经由这两个入口动。
 *   · addPriceAdjustment —— 运营确认（外壳自己开事务）
 *   · _addPriceAdjustmentWithinTx —— 代理自助直通（差额行必须挂在提交那一个事务里，与 APPROVED 同生共死）
 */
function fakeOrders(
  addPriceAdjustment: ReturnType<typeof vi.fn>,
  applyWithinTx: ReturnType<typeof vi.fn>,
): OrderService {
  return {
    addPriceAdjustment,
    _addPriceAdjustmentWithinTx: applyWithinTx,
  } as unknown as OrderService;
}

let addPriceAdjustment: ReturnType<typeof vi.fn>;
let applyWithinTx: ReturnType<typeof vi.fn>;
let service: SettlementRequestsService;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.commissionRecord.findFirst.mockResolvedValue(null);
  mockPrisma.passenger.findUnique.mockResolvedValue({
    id: 'pax-1',
    orderId: 'order-1',
    fullName: 'ZHANG/SAN',
    chineseName: '张三',
  });
  // create() 统一回读落库后的那一行（自助直通改完价后应收已变，序列化要按新数说话）。
  mockPrisma.settlementRequest.create.mockResolvedValue({ id: 'req-1' });
  mockPrisma.settlementRequest.findUniqueOrThrow.mockResolvedValue(requestFixture());
  addPriceAdjustment = vi.fn();
  applyWithinTx = vi.fn();
  service = new SettlementRequestsService(fakeOrders(addPriceAdjustment, applyWithinTx));
});

describe('receivableCny · 应收口径', () => {
  it('应收 = total + adjustmentCny（售后费用一起算）', () => {
    expect(receivableCny({ total: new Prisma.Decimal(13500), adjustmentCny: 0 })).toBe(13500);
    expect(receivableCny({ total: new Prisma.Decimal('13500.50'), adjustmentCny: 300 })).toBe(
      13800.5,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('create() · 未锁价自助直通 / 锁价落 PENDING', () => {
  it('代理为自己名下未锁价的单提交 → 落 APPROVED（决定人=本人）并当场生效', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);
    applyWithinTx.mockResolvedValue({ itemId: 'item-9' });
    mockPrisma.settlementRequest.findUniqueOrThrow.mockResolvedValue(
      requestFixture({
        status: SettlementRequestStatus.APPROVED,
        decidedById: 'agent-user-1',
        decidedAt: AT,
        appliedAdjustmentItemId: 'item-9',
        note: '代理自助：同行价',
      }),
    );

    const result = await service.create(AGENT_USER, 'order-1', {
      requestedTotalCny: 12800,
      note: '同行价',
    });

    const createArgs = mockPrisma.settlementRequest.create.mock.calls[0][0];
    expect(createArgs.data.orderId).toBe('order-1');
    expect(createArgs.data.agentId).toBe('agent-1');
    expect(createArgs.data.requestedById).toBe('agent-user-1');
    expect(createArgs.data.status).toBe(SettlementRequestStatus.APPROVED);
    // 自助直通没有第二个人经手：决定人如实写成提交人本人。
    expect(createArgs.data.decidedById).toBe('agent-user-1');
    expect(createArgs.data.decidedAt).toBeInstanceOf(Date);
    // 说明带「代理自助」前缀，队列里一眼看出这条不是等运营处理的。
    expect(createArgs.data.note).toBe('代理自助：同行价');
    // 申请时的应收快照 = 13500
    expect(Number(createArgs.data.systemTotalCny.toString())).toBe(13500);
    expect(Number(createArgs.data.requestedTotalCny.toString())).toBe(12800);

    // 钱只经由既有调价通道动，且必须在提交那一个事务里落（tx 原样传下去）：
    // 差额 = 12800 − 13500 = −700 → DISCOUNT。
    expect(applyWithinTx).toHaveBeenCalledTimes(1);
    expect(addPriceAdjustment).not.toHaveBeenCalled();
    const [tx, orderId, adjustment, actor] = applyWithinTx.mock.calls[0];
    expect(tx).toBe(mockPrisma);
    expect(orderId).toBe('order-1');
    expect(adjustment).toEqual({
      amountCny: -700,
      reasonCode: 'DISCOUNT',
      reasonText: AGENT_SELF_SETTLEMENT_REASON_TEXT,
    });
    expect(actor).toEqual({ userId: 'agent-user-1', role: UserRole.AGENT });

    // 生成的差额行 id 回写申请
    expect(mockPrisma.settlementRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { appliedAdjustmentItemId: 'item-9' },
    });
    expect(result.selfApplied).toBe(true);
    expect(result.appliedDiffCny).toBe('-700.00');
    expect(result.status).toBe(SettlementRequestStatus.APPROVED);
    expect(result.orderNumber).toBe('FTM2026090100001');
    expect(result.agentName).toBe('示例商旅');
    expect(result.passengerCount).toBe(2);
  });

  it('申请价高于应收 → 差额为正，走 MISC_FEE 补收', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);
    applyWithinTx.mockResolvedValue({ itemId: 'item-10' });

    const result = await service.create(AGENT_USER, 'order-1', { requestedTotalCny: 14000 });

    expect(applyWithinTx.mock.calls[0][2]).toMatchObject({
      amountCny: 500,
      reasonCode: 'MISC_FEE',
    });
    expect(result.appliedDiffCny).toBe('500.00');
  });

  it('结算价已锁定 → 照旧落 PENDING 等运营，订单金额一分不动', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture({ settlementLocked: true }));
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);

    const result = await service.create(AGENT_USER, 'order-1', {
      requestedTotalCny: 12800,
      note: '同行价',
    });

    const createArgs = mockPrisma.settlementRequest.create.mock.calls[0][0];
    expect(createArgs.data.status).toBe(SettlementRequestStatus.PENDING);
    expect(createArgs.data.decidedById).toBeNull();
    // 锁价支路不加前缀：这条要交给运营看，说明就是代理原话。
    expect(createArgs.data.note).toBe('同行价');
    expect(applyWithinTx).not.toHaveBeenCalled();
    expect(result.selfApplied).toBe(false);
    expect(result.appliedDiffCny).toBeNull();
    expect(result.status).toBe(SettlementRequestStatus.PENDING);
    expect(Number(result.diffCny)).toBe(-700);
  });

  it('运营代提 → 照旧落 PENDING（自助直通只给代理本人）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);

    const result = await service.create(ADMIN, 'order-1', { requestedTotalCny: 12800 });

    expect(mockPrisma.settlementRequest.create.mock.calls[0][0].data.status).toBe(
      SettlementRequestStatus.PENDING,
    );
    expect(applyWithinTx).not.toHaveBeenCalled();
    expect(result.selfApplied).toBe(false);
  });

  it('本单佣金已进结算单 → 拒，不落记录也不动钱', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);
    mockPrisma.commissionRecord.findFirst.mockResolvedValue({ id: 'cr-1' });

    await expect(
      service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 }),
    ).rejects.toThrow(/已进入结算单/);
    expect(mockPrisma.settlementRequest.create).not.toHaveBeenCalled();
    expect(applyWithinTx).not.toHaveBeenCalled();
  });

  it.each(['outboundInvoiced', 'returnInvoiced', 'systemInvoiced'])(
    '已开票（%s）→ 拒「已开票的订单请联系运营改价」',
    async (flag) => {
      mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
      mockPrisma.order.findUnique.mockResolvedValue(orderFixture({ [flag]: true }));
      mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);

      await expect(
        service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 }),
      ).rejects.toThrow('已开票的订单请联系运营改价');
      expect(mockPrisma.settlementRequest.create).not.toHaveBeenCalled();
      expect(applyWithinTx).not.toHaveBeenCalled();
    },
  );

  it('已收款且改后应收低于已收款 → 拒（不凭空造出应退款）', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(
      orderFixture({ paidAmount: new Prisma.Decimal(13000) }),
    );
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);

    await expect(
      service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 }),
    ).rejects.toThrow('订单已收款，改后金额低于已收款，请联系运营处理');
    expect(mockPrisma.settlementRequest.create).not.toHaveBeenCalled();
  });

  it('已收款但改后应收不低于已收款 → 照常自助生效', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(
      orderFixture({ paidAmount: new Prisma.Decimal(12800) }),
    );
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);
    applyWithinTx.mockResolvedValue({ itemId: 'item-11' });

    const result = await service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 });
    expect(result.selfApplied).toBe(true);
    expect(applyWithinTx).toHaveBeenCalledTimes(1);
  });

  it('自助改价时调价通道抛错 → 错误原样透出，整个事务回滚（不再手工删记录）', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);
    applyWithinTx.mockRejectedValue(new Error('结算价已锁定，请先解锁再修改'));

    await expect(
      service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 }),
    ).rejects.toThrow(/结算价已锁定/);

    // 申请记录与差额行同在一个事务里 → 抛错即整体回滚，不需要（也不该）事后补一刀删除；
    // 「已生效但没动钱」这种中间态在库里根本不会出现。
    expect(mockPrisma.settlementRequest.deleteMany).not.toHaveBeenCalled();
    // 差额行没落地 → 不该有「回写差额行 id」这一次
    expect(mockPrisma.settlementRequest.update).not.toHaveBeenCalled();
  });

  it('同一单连提两次同样的自助改价 → 差额只落一次（第二次读到的是改过的应收）', async () => {
    // 「事务里改价」的立身之本：差额行与 APPROVED 记录共用同一把订单行锁，第一笔提交后
    // 应收已经是新的，第二笔再进来算出来的差额是 0 → 400，而不是照旧按 13500 再减一次 700。
    const state = { total: 13500 };
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockImplementation(async () =>
      orderFixture({ total: new Prisma.Decimal(state.total) }),
    );
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);
    // 事务串行化（模拟订单行锁）：一个事务跑完下一个才开始。
    let queue: Promise<unknown> = Promise.resolve();
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
      const run = queue.then(() => (arg as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma));
      queue = run.catch(() => undefined);
      return run;
    });
    // 调价内核在同一个事务里把应收改掉（真内核干的就是这件事）。
    applyWithinTx.mockImplementation(async (_tx, _orderId, adjustment) => {
      state.total = Math.round((state.total + adjustment.amountCny) * 100) / 100;
      return { itemId: `item-${state.total}` };
    });

    const results = await Promise.allSettled([
      service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 }),
      service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 400 });
    // 关键断言：差额只落了一次，应收停在 12800 而不是 12100。
    expect(applyWithinTx).toHaveBeenCalledTimes(1);
    expect(state.total).toBe(12800);
  });

  it('差额行落在提交那一个事务里 —— 事务回调返回时钱已经动过', async () => {
    // 上一条测的是结果，这条测的是时序：差额行要是等事务提交后再落，订单行锁早就放了，
    // 下一个并发请求会读到还没变的应收 —— C-1 那笔「800 提两次变 600」就是这么来的。
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);
    applyWithinTx.mockResolvedValue({ itemId: 'item-12' });
    let appliedWhenTxEnded = -1;
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
      const result = await (arg as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma);
      appliedWhenTxEnded = applyWithinTx.mock.calls.length;
      return result;
    });

    await service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 });

    expect(appliedWhenTxEnded).toBe(1);
    // 差额行 id 也在同一个事务里回写（不留「APPROVED 但没挂行」的中间态）。
    expect(mockPrisma.settlementRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { appliedAdjustmentItemId: 'item-12' },
    });
  });

  it('库里留着「APPROVED 但差额行没落」的自助记录 → 409，不按旧应收再算一份', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    // 第一次查（有没有 PENDING）→ 无；第二次查（有没有没落地的自助 APPROVED）→ 有。
    mockPrisma.settlementRequest.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'req-stuck' });

    await expect(
      service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mockPrisma.settlementRequest.create).not.toHaveBeenCalled();
    expect(applyWithinTx).not.toHaveBeenCalled();
  });

  it('代理对别家名下的单提交 → 403', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-2' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture({ agentId: 'agent-1' }));

    await expect(service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 })).rejects.toThrow(
      /只能对自己名下的订单/,
    );
    expect(mockPrisma.settlementRequest.create).not.toHaveBeenCalled();
    expect(applyWithinTx).not.toHaveBeenCalled();
  });

  it('同一订单已有待确认申请 → 409（自助支路同样拒，免得留下没人处理的 PENDING）', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.settlementRequest.findFirst.mockResolvedValue({ id: 'req-existing' });

    await expect(
      service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mockPrisma.settlementRequest.create).not.toHaveBeenCalled();
    expect(applyWithinTx).not.toHaveBeenCalled();
  });

  it('差额超出单笔调整上限 → 400', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(
      // 应收 200000，申请 0 → 差额 −200000，超 ±100000 上限
      orderFixture({ total: new Prisma.Decimal(200000) }),
    );

    await expect(
      service.create(AGENT_USER, 'order-1', { requestedTotalCny: 0 }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.settlementRequest.create).not.toHaveBeenCalled();
  });

  it('申请价与当前应收一致 → 400「与当前应收一致，无需申请」', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());

    await expect(service.create(AGENT_USER, 'order-1', { requestedTotalCny: 13500 })).rejects.toThrow(
      /与当前应收一致/,
    );
  });

  it('已取消等非占座状态的单 → 400，不接受议价', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture({ status: OrderStatus.CANCELLED }));

    await expect(
      service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('软删的单 → 404', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture({ deletedAt: AT }));

    await expect(
      service.create(AGENT_USER, 'order-1', { requestedTotalCny: 12800 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('approve() · 钱只在这一步动，且只走既有调价通道', () => {
  it('确认 → 按当前应收算差额、生成差额行，行 id 落 appliedAdjustmentItemId', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        requestedTotalCny: new Prisma.Decimal(12800),
        status: SettlementRequestStatus.PENDING,
        requestedById: 'agent-user-1',
      },
    ]);
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    addPriceAdjustment.mockResolvedValue({
      order: { id: 'order-1' },
      audit: { itemId: 'item-1' },
    });
    mockPrisma.settlementRequest.findUniqueOrThrow.mockResolvedValue(
      requestFixture({
        status: SettlementRequestStatus.APPROVED,
        decidedById: 'admin-1',
        decidedAt: AT,
        appliedAdjustmentItemId: 'item-1',
      }),
    );

    const result = await service.approve(ADMIN, 'req-1', { note: '按同行价确认' });

    // 差额 = 12800 − 13500 = −700 → 负数走 DISCOUNT，说明文本固定
    expect(addPriceAdjustment).toHaveBeenCalledTimes(1);
    const [orderId, adjustment, actor] = addPriceAdjustment.mock.calls[0];
    expect(orderId).toBe('order-1');
    expect(adjustment).toEqual({
      amountCny: -700,
      reasonCode: 'DISCOUNT',
      reasonText: SETTLEMENT_REQUEST_REASON_TEXT,
    });
    expect(actor).toEqual({ userId: 'admin-1', role: UserRole.ADMIN });

    // 生成的差额行 id 回写申请
    expect(mockPrisma.settlementRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { appliedAdjustmentItemId: 'item-1' },
    });
    expect(result.request.appliedAdjustmentItemId).toBe('item-1');
    expect(result.audit.diffCny).toBe(-700);
  });

  it('申请价高于应收 → 差额为正，走 MISC_FEE 补收', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        requestedTotalCny: new Prisma.Decimal(14000),
        status: SettlementRequestStatus.PENDING,
        requestedById: 'agent-user-1',
      },
    ]);
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    addPriceAdjustment.mockResolvedValue({ order: {}, audit: { itemId: 'item-2' } });
    mockPrisma.settlementRequest.findUniqueOrThrow.mockResolvedValue(
      requestFixture({
        status: SettlementRequestStatus.APPROVED,
        appliedAdjustmentItemId: 'item-2',
      }),
    );

    await service.approve(ADMIN, 'req-1', {});

    expect(addPriceAdjustment.mock.calls[0][1]).toMatchObject({
      amountCny: 500,
      reasonCode: 'MISC_FEE',
    });
  });

  it('确认时应收已被别的操作调到申请价（差额 0）→ 直接 APPROVED，不生成空行', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        requestedTotalCny: new Prisma.Decimal(13500),
        status: SettlementRequestStatus.PENDING,
        requestedById: 'agent-user-1',
      },
    ]);
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.settlementRequest.findUniqueOrThrow.mockResolvedValue(
      requestFixture({ status: SettlementRequestStatus.APPROVED }),
    );

    const result = await service.approve(ADMIN, 'req-1', {});

    expect(addPriceAdjustment).not.toHaveBeenCalled();
    expect(result.audit.diffCny).toBe(0);
    expect(result.audit.itemId).toBeNull();
  });

  it('调价通道抛错（结算锁/已开票等）→ 错误原样透出，申请回到 PENDING', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        requestedTotalCny: new Prisma.Decimal(12800),
        status: SettlementRequestStatus.PENDING,
        requestedById: 'agent-user-1',
      },
    ]);
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    addPriceAdjustment.mockRejectedValue(new Error('该订单结算价已锁定，不可调价'));

    await expect(service.approve(ADMIN, 'req-1', {})).rejects.toThrow(/结算价已锁定/);

    expect(mockPrisma.settlementRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'req-1',
        status: SettlementRequestStatus.APPROVED,
        appliedAdjustmentItemId: null,
      },
      data: {
        status: SettlementRequestStatus.PENDING,
        decidedById: null,
        decidedAt: null,
        decisionNote: null,
      },
    });
    // 占位那一次 update 是有的（PENDING → APPROVED），但差额行没落地，
    // 就不该有「回写差额行 id」这一次。
    const wroteItemId = mockPrisma.settlementRequest.update.mock.calls.some((call) => {
      const data = (call[0] as { data?: Record<string, unknown> } | undefined)?.data;
      return Boolean(data && 'appliedAdjustmentItemId' in data);
    });
    expect(wroteItemId).toBe(false);
  });

  it('已处理过的申请再确认 → 409，不重复调价', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        requestedTotalCny: new Prisma.Decimal(12800),
        status: SettlementRequestStatus.APPROVED,
        requestedById: 'agent-user-1',
      },
    ]);

    await expect(service.approve(ADMIN, 'req-1', {})).rejects.toMatchObject({ statusCode: 409 });
    expect(addPriceAdjustment).not.toHaveBeenCalled();
  });

  it('代理不能自己确认自己的申请 → 403', async () => {
    await expect(service.approve(AGENT_USER, 'req-1', {})).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(addPriceAdjustment).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════
// 作用范围 = 指定乘客：代理填的是「只给这个人加/减多少」的调整净额，不是新总价
// ══════════════════════════════════════════════════════════════════════
describe('指定乘客范围 · 调整净额口径', () => {
  it('自助直通 → 差额行挂这位乘客名下，金额就是填的净额（不按新总价反推）', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);
    applyWithinTx.mockResolvedValue({ itemId: 'item-7' });
    mockPrisma.settlementRequest.findUniqueOrThrow.mockResolvedValue(
      requestFixture({
        status: SettlementRequestStatus.APPROVED,
        decidedById: 'agent-user-1',
        decidedAt: AT,
        appliedAdjustmentItemId: 'item-7',
        requestedTotalCny: new Prisma.Decimal(13000),
        passengerId: 'pax-1',
        passengerName: '张三',
        requestedAdjustmentCny: new Prisma.Decimal(-500),
      }),
    );

    const result = await service.create(AGENT_USER, 'order-1', {
      passengerId: 'pax-1',
      adjustmentCny: -500,
      note: '这位客人退一段',
    });

    // 落库：净额原样存，整单应收派生一份留痕（13500 − 500 = 13000），姓名存快照。
    const createArgs = mockPrisma.settlementRequest.create.mock.calls[0][0];
    expect(createArgs.data.passengerId).toBe('pax-1');
    expect(createArgs.data.passengerName).toBe('张三');
    expect(Number(createArgs.data.requestedAdjustmentCny.toString())).toBe(-500);
    expect(Number(createArgs.data.requestedTotalCny.toString())).toBe(13000);
    expect(Number(createArgs.data.systemTotalCny.toString())).toBe(13500);

    // 钱照旧只经由既有调价通道动（且在提交那一个事务里），并带上作用范围。
    const [tx, orderId, adjustment] = applyWithinTx.mock.calls[0];
    expect(tx).toBe(mockPrisma);
    expect(orderId).toBe('order-1');
    expect(adjustment).toEqual({
      amountCny: -500,
      reasonCode: 'DISCOUNT',
      reasonText: AGENT_SELF_SETTLEMENT_REASON_TEXT,
      passengerId: 'pax-1',
    });

    // 序列化：差额 = 这笔净额本身（不是「申请价 − 当前应收」）。
    expect(result.selfApplied).toBe(true);
    expect(result.passengerId).toBe('pax-1');
    expect(result.passengerName).toBe('张三');
    expect(result.requestedAdjustmentCny).toBe('-500.00');
    expect(result.diffCny).toBe('-500.00');
  });

  it('指定的乘客不属于本单 → 400，且不落任何记录、不动钱', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'pax-9',
      orderId: 'order-other',
      fullName: 'LI/SI',
      chineseName: null,
    });

    await expect(
      service.create(AGENT_USER, 'order-1', { passengerId: 'pax-9', adjustmentCny: -500 }),
    ).rejects.toThrow('指定的乘客不存在或不属于本订单');
    expect(mockPrisma.settlementRequest.create).not.toHaveBeenCalled();
    expect(applyWithinTx).not.toHaveBeenCalled();
  });

  it('已锁价的单按人改价 → 照旧落 PENDING，净额存下来等运营确认，钱一分不动', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture({ settlementLocked: true }));
    mockPrisma.settlementRequest.findFirst.mockResolvedValue(null);
    mockPrisma.settlementRequest.findUniqueOrThrow.mockResolvedValue(
      requestFixture({
        requestedTotalCny: new Prisma.Decimal(14300),
        passengerId: 'pax-1',
        passengerName: '张三',
        requestedAdjustmentCny: new Prisma.Decimal(800),
      }),
    );

    const result = await service.create(AGENT_USER, 'order-1', {
      passengerId: 'pax-1',
      adjustmentCny: 800,
    });

    const createArgs = mockPrisma.settlementRequest.create.mock.calls[0][0];
    expect(createArgs.data.status).toBe(SettlementRequestStatus.PENDING);
    expect(Number(createArgs.data.requestedAdjustmentCny.toString())).toBe(800);
    expect(applyWithinTx).not.toHaveBeenCalled();
    expect(result.selfApplied).toBe(false);
    expect(result.appliedDiffCny).toBeNull();
  });

  it('运营确认 → 差额读申请里那笔固定净额，不按当下应收反推，作用范围原样透传', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        // 派生留痕：提交时 13500 + 800；这一列在指定乘客的申请里不参与算差额。
        requestedTotalCny: new Prisma.Decimal(14300),
        status: SettlementRequestStatus.PENDING,
        requestedById: 'agent-user-1',
        passengerId: 'pax-1',
        requestedAdjustmentCny: new Prisma.Decimal(800),
      },
    ]);
    // 申请挂着期间别的操作把应收从 13500 抬到了 14000：按总价反推会算成 +300（把别人头上的
    // 300 抹到这位乘客身上），按净额则照旧 +800。
    mockPrisma.order.findUnique.mockResolvedValue(
      orderFixture({ total: new Prisma.Decimal(14000) }),
    );
    addPriceAdjustment.mockResolvedValue({ order: {}, audit: { itemId: 'item-8' } });
    mockPrisma.settlementRequest.findUniqueOrThrow.mockResolvedValue(
      requestFixture({
        status: SettlementRequestStatus.APPROVED,
        appliedAdjustmentItemId: 'item-8',
        passengerId: 'pax-1',
        passengerName: '张三',
        requestedAdjustmentCny: new Prisma.Decimal(800),
      }),
    );

    const result = await service.approve(ADMIN, 'req-1', {});

    expect(addPriceAdjustment.mock.calls[0][1]).toEqual({
      amountCny: 800,
      reasonCode: 'MISC_FEE',
      reasonText: SETTLEMENT_REQUEST_REASON_TEXT,
      passengerId: 'pax-1',
    });
    expect(result.audit.diffCny).toBe(800);
    expect(result.audit.passengerId).toBe('pax-1');
  });

  it('指定乘客的申请缺净额（脏数据）→ 拒绝确认，不猜金额', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        requestedTotalCny: new Prisma.Decimal(14300),
        status: SettlementRequestStatus.PENDING,
        requestedById: 'agent-user-1',
        passengerId: 'pax-1',
        requestedAdjustmentCny: null,
      },
    ]);
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());

    await expect(service.approve(ADMIN, 'req-1', {})).rejects.toThrow(/缺少调整净额/);
    expect(addPriceAdjustment).not.toHaveBeenCalled();
  });
});

describe('reject() · 只改状态', () => {
  it('驳回待确认申请 → REJECTED + 决定人/时间/备注，订单一分钱不动', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        status: SettlementRequestStatus.PENDING,
        requestedById: 'agent-user-1',
      },
    ]);
    mockPrisma.settlementRequest.update.mockResolvedValue(
      requestFixture({
        status: SettlementRequestStatus.REJECTED,
        decidedById: 'admin-1',
        decidedAt: AT,
        decisionNote: '低于成本价',
      }),
    );

    const result = await service.reject(ADMIN, 'req-1', { note: '低于成本价' });

    const updateArgs = mockPrisma.settlementRequest.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe(SettlementRequestStatus.REJECTED);
    expect(updateArgs.data.decidedById).toBe('admin-1');
    expect(updateArgs.data.decisionNote).toBe('低于成本价');
    expect(addPriceAdjustment).not.toHaveBeenCalled();
    expect(result.request.status).toBe(SettlementRequestStatus.REJECTED);
    expect(result.audit.requestedById).toBe('agent-user-1');
  });

  it('已处理过的申请再驳回 → 409', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        status: SettlementRequestStatus.REJECTED,
        requestedById: 'agent-user-1',
      },
    ]);

    await expect(service.reject(ADMIN, 'req-1', {})).rejects.toMatchObject({ statusCode: 409 });
    expect(mockPrisma.settlementRequest.update).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('list() · 可见范围', () => {
  it('代理只看得到自家 + 下级的申请', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockGetDescendantAgentIds.mockResolvedValue(['agent-1', 'agent-3']);
    mockPrisma.settlementRequest.findMany.mockResolvedValue([requestFixture()]);
    mockPrisma.settlementRequest.count.mockResolvedValue(1);

    const result = await service.list(AGENT_USER, {
      status: SettlementRequestStatus.PENDING,
      page: 1,
      pageSize: 50,
    });

    expect(mockPrisma.settlementRequest.findMany.mock.calls[0][0].where).toEqual({
      status: SettlementRequestStatus.PENDING,
      agentId: { in: ['agent-1', 'agent-3'] },
    });
    expect(result.pagination).toEqual({ page: 1, pageSize: 50, total: 1 });
    // 队列每条都要能一眼看出「申请价 / 当前应收 / 差多少」
    expect(Number(result.requests[0].currentTotalCny)).toBe(13500);
    expect(Number(result.requests[0].diffCny)).toBe(-700);
  });

  it('运营看全部（不加代理过滤）', async () => {
    mockPrisma.settlementRequest.findMany.mockResolvedValue([]);
    mockPrisma.settlementRequest.count.mockResolvedValue(0);

    await service.list(ADMIN, { page: 1, pageSize: 50 });

    expect(mockPrisma.settlementRequest.findMany.mock.calls[0][0].where).toEqual({});
  });
});
