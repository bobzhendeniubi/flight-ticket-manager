/**
 * 订单资金守卫 · 服务级单测（vitest，mock Prisma）
 *
 * 覆盖五条已坐实的资金/账目缺陷，每条都断言到**具体金额或具体错误文案**：
 *
 *  A. 多付处置后台账不对冲 → 订单再进一次 PAID 就把多付灌回（无上限造币循环）。
 *     守卫：处置时同步写一条负金额 SUCCEEDED Payment，SUCCEEDED 合计随之下降。
 *  B. 订单可落 REFUNDED 终态却零 Refund 记录 → 实收永久卡死（三道资金闸对 REFUNDED 全是黑名单）。
 *     守卫：转 REFUNDED 前断言存在 Refund（REQUESTED/COMPLETED），admin force 同样拦。
 *  C. 预存余额抵付的订单退款后余额永不回补（PrepaymentTxType.REFUND 是死枚举）。
 *     守卫：REFUNDED 流转按「现金优先」拆分，余额部分写 REFUND 流水并回补 Agent.prepaymentBalance。
 *     ⚠️ 抵扣额一律取 PrepaymentTransaction(OFFSET) 流水，**不是** Order.prepaymentOffset ——
 *     那一列没有任何生产代码写入（恒为 0），拿它当输入的测试是假绿：真实场景里余额永远补不回来。
 *  D. 团队议价结算价按航段各收一次 → 往返单每人多收一倍。
 *     守卫：整程价按航段分摊，各段之和恰好等于整程价。
 *  E. 套餐去程日取自客户端可伪造的 metadata.goDate → 散客可自助套利结算价立减。
 *     守卫：有同 bundle 航段时一律以真实航段出发本地日为准。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma, UserRole } from '@prisma/client';

const { mockPrisma, mockCreateOpenReceiptWithinTx } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    order: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    orderStatusEvent: { create: vi.fn() },
    agent: { update: vi.fn() },
    payment: { create: vi.fn(), findFirst: vi.fn(), aggregate: vi.fn(), updateMany: vi.fn() },
    prepaymentTransaction: { create: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
    refund: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    commissionRecord: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    fulfillmentTask: { updateMany: vi.fn() },
    flightSchedule: { findMany: vi.fn(), findUnique: vi.fn() },
    bundle: { findUnique: vi.fn(), findMany: vi.fn() },
  },
  mockCreateOpenReceiptWithinTx: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../receipts/receipts.service.js', () => ({
  createOpenReceiptWithinTx: mockCreateOpenReceiptWithinTx,
}));

import { OrderService, splitSettlementPriceAcrossLegs } from './orders.service.js';
import type { OrderItemInput } from './orders.schemas.js';
import { BadRequestError } from '../../lib/errors.js';

const service = new OrderService();
const ADMIN = { userId: 'u-admin', role: UserRole.ADMIN } as const;

const dec = (n: number) => new Prisma.Decimal(n);

type UpdateStatusTxArg = Parameters<OrderService['_updateStatusWithinTx']>[0];
const tx = mockPrisma as unknown as UpdateStatusTxArg;

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction(cb) → 直接把同一批 mock 当 tx 传进去（被测方法在事务内跑）
  mockPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(mockPrisma));
  mockPrisma.flightSchedule.findMany.mockResolvedValue([]);
  mockPrisma.commissionRecord.findMany.mockResolvedValue([]);
  mockPrisma.refund.findMany.mockResolvedValue([]);
  // 默认：本单没有任何余额流水（纯现金单）
  mockPrisma.prepaymentTransaction.findMany.mockResolvedValue([]);
  mockPrisma.prepaymentTransaction.aggregate.mockResolvedValue({ _sum: { amount: null } });
});

/**
 * 预存余额流水 mock：抵扣写负数 OFFSET、回补写正数 REFUND —— 与 applyAgentBalanceToOrder /
 * REFUNDED 流转真实落库的形状一致。测试必须从这里喂数据，**不能**去塞 Order.prepaymentOffset：
 * 那一列生产环境恒为 0，塞它等于把被测代码的输入换成一个现实中不存在的值。
 */
function balanceLedger(rows: Array<{ offset?: number; restored?: number; agentId?: string }>) {
  return rows.map((r) =>
    r.offset != null
      ? { agentId: r.agentId ?? 'agent-1', amount: dec(-r.offset), type: 'OFFSET' as const }
      : { agentId: r.agentId ?? 'agent-1', amount: dec(r.restored ?? 0), type: 'REFUND' as const },
  );
}

// ════════════════════════════════════════════════════════════════════════
// A. 多付处置 → Payment 台账必须同步对冲
// ════════════════════════════════════════════════════════════════════════
describe('多付处置 · Payment 台账对冲（堵死「再进一次 PAID 就把多付灌回」的造币循环）', () => {
  /**
   * 病灶：处置只降 order.paidAmount、不动台账 → PAID 分支按
   * `if (paymentsSum > currentPaid) paidAmount = paymentsSum` 把多付重新灌满，
   * 每再进一次 PAID（如 CHANGE_REQUESTED→PAID 驳回改签，合法路径无需 force）就白造一笔钱。
   */
  it('多付转存代理余额：写一条 −500 的 SUCCEEDED 对冲 Payment（paidAt 留空，带处置来源标记）', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'ord-1',
          orderNumber: 'FT-1',
          agentId: 'agent-1',
          total: dec(1000),
          adjustmentCny: 0,
          paidAmount: dec(1500),
          prepaymentOffset: dec(0),
          status: OrderStatus.PAID,
          deletedAt: null,
        },
      ])
      .mockResolvedValueOnce([{ prepaymentBalance: dec(200) }]);
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockPrisma.payment.findFirst.mockResolvedValue({ method: PaymentMethod.ALIPAY });

    const result = await service.creditOverpayToAgent('ord-1', ADMIN);

    expect(result.creditedAmount).toBe(500);
    expect(result.newPaidAmount).toBe(1000);
    expect(result.agentBalanceAfter).toBe(700);

    expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1);
    const created = mockPrisma.payment.create.mock.calls[0][0].data;
    // 等额负数：SUCCEEDED 合计从 1500 降到 1000，PAID 分支的重写条件自然恒为假
    expect(Number(created.amount.toString())).toBe(-500);
    expect(created.status).toBe(PaymentStatus.SUCCEEDED);
    expect(created.orderId).toBe('ord-1');
    // paidAt 留空 → 导出的「最近一笔成功收款」（按 paidAt 过滤）不会把对冲行误当收款
    expect(created.paidAt).toBeNull();
    expect(created.gatewayPayload.source).toBe('overpay-disposal');
    expect(created.gatewayPayload.disposal).toBe('AGENT_BALANCE');
    expect(created.gatewayPayload.amountCny).toBe(500);
    // 支付方式跟随最近一笔真实收款（对冲行自身被 amount>0 过滤排除，不会一路取到自己身上）
    expect(created.method).toBe(PaymentMethod.ALIPAY);
    expect(mockPrisma.payment.findFirst.mock.calls[0][0].where.amount).toEqual({ gt: 0 });
  });

  it('多付转挂账池：同样写一条 −300 的 SUCCEEDED 对冲 Payment（来源标 RECEIPT_POOL）', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        id: 'ord-2',
        orderNumber: 'FT-2',
        total: dec(700),
        adjustmentCny: 0,
        paidAmount: dec(1000),
        prepaymentOffset: dec(0),
        status: OrderStatus.PAID,
        deletedAt: null,
      },
    ]);
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockPrisma.payment.findFirst.mockResolvedValue(null); // 无历史收款 → 兜底 WECHAT_PAY
    mockCreateOpenReceiptWithinTx.mockResolvedValue({ id: 'rcpt-1', receiptNo: 'R-1' });

    const result = await service.overpayToPool('ord-2', ADMIN);

    expect(result.movedAmount).toBe(300);
    expect(result.newPaidAmount).toBe(700);

    const created = mockPrisma.payment.create.mock.calls[0][0].data;
    expect(Number(created.amount.toString())).toBe(-300);
    expect(created.status).toBe(PaymentStatus.SUCCEEDED);
    expect(created.method).toBe(PaymentMethod.WECHAT_PAY);
    expect(created.gatewayPayload.disposal).toBe('RECEIPT_POOL');
  });

  it('无多付时不写对冲行（拒绝在先，台账零副作用）', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        id: 'ord-3',
        orderNumber: 'FT-3',
        agentId: 'agent-1',
        total: dec(1000),
        adjustmentCny: 0,
        paidAmount: dec(1000),
        prepaymentOffset: dec(0),
        status: OrderStatus.PAID,
        deletedAt: null,
      },
    ]);
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });

    await expect(service.creditOverpayToAgent('ord-3', ADMIN)).rejects.toThrow(
      '该订单没有多付金额（已付款扣除已退款 ≤ 应付），无可存入余额',
    );
    expect(mockPrisma.payment.create).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// B/C. 转 REFUNDED 的账目完整性闸 + 预存余额回补
// ════════════════════════════════════════════════════════════════════════
function refundOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-r',
    orderNumber: 'FT-R',
    agentId: null,
    userId: null,
    status: OrderStatus.REFUND_REQUESTED,
    deletedAt: null,
    total: dec(1000),
    adjustmentCny: 0,
    paidAmount: dec(1000),
    prepaymentOffset: dec(0),
    items: [],
    ...overrides,
  };
}

describe('转 REFUNDED · 账目完整性闸（没有 Refund 记录一律拒绝）', () => {
  it('零 Refund 记录 → 拒绝，且状态/退款/履约任务全不落地', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(refundOrder());
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ paidAmount: dec(1000) }]);
    mockPrisma.refund.count.mockResolvedValue(0);

    await expect(
      service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []),
    ).rejects.toThrow(/没有任何退款记录，不能置为「已退款」/);

    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.refund.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.fulfillmentTask.updateMany).not.toHaveBeenCalled();
  });

  it('错误文案给出具体出路（POST /orders/:id/cancel），不是一句空泛报错', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(refundOrder());
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ paidAmount: dec(1000) }]);
    mockPrisma.refund.count.mockResolvedValue(0);

    await expect(
      service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []),
    ).rejects.toThrow(/POST \/orders\/ord-r\/cancel/);
  });

  /**
   * 账目完整性不是流程便利性：force 是用来跳状态机的，不是用来跳账的。
   * 这里从 PAID 直接 force 到 REFUNDED（状态机白名单里没有这条边），闸门照样拦。
   */
  it('admin force 同样拦（跳状态机可以，跳账不行）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(refundOrder({ status: OrderStatus.PAID }));
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ paidAmount: dec(1000) }]);
    mockPrisma.refund.count.mockResolvedValue(0);

    await expect(
      service._updateStatusWithinTx(
        tx,
        'ord-r',
        OrderStatus.REFUNDED,
        ADMIN,
        undefined,
        [],
        true, // force
      ),
    ).rejects.toThrow(BadRequestError);
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('已有 COMPLETED 退款记录 → 放行（补录/分批批准场景不误伤）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(refundOrder());
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ paidAmount: dec(1000) }]);
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: null } }) // 无 REQUESTED
      .mockResolvedValueOnce({ _sum: { amount: dec(800) } }); // 已完成 800
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({});

    await service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []);

    expect(mockPrisma.order.updateMany).toHaveBeenCalled();
  });
});

describe('转 REFUNDED · 资金守恒断言（实收 = paidAmount，余额抵扣已含在里面）', () => {
  /**
   * 口径要点：applyAgentBalanceToOrder 抵扣时**已经**把金额累加进 order.paidAmount，
   * 所以 paidAmount 就是「现金 + 余额抵扣」的合计。余额抵付单的正常退款本来就该放行。
   */
  it('全额余额抵付（实收 10000 全来自 OFFSET）、应退 8000 → 放行', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      refundOrder({ agentId: 'agent-1', paidAmount: dec(10_000) }),
    );
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ paidAmount: dec(10_000) }]) // 订单行锁
      .mockResolvedValueOnce([{ prepaymentBalance: dec(50) }]); // 代理余额行锁
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: dec(8_000) } }) // REQUESTED 合计
      .mockResolvedValueOnce({ _sum: { amount: null } }); // 已完成退款合计
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue(balanceLedger([{ offset: 10_000 }]));
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({});

    await service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []);

    expect(mockPrisma.refund.updateMany).toHaveBeenCalled();
  });

  it('应退超过实收 → 拒绝，报错把实收拆成「现金 + 余额抵扣」两段说清楚', async () => {
    // 实收 1500 = 现金 1000 + 余额抵扣 500（OFFSET 流水）
    mockPrisma.order.findUnique.mockResolvedValue(
      refundOrder({ agentId: 'agent-1', paidAmount: dec(1_500) }),
    );
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ paidAmount: dec(1_500) }]);
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: dec(1_600) } })
      .mockResolvedValueOnce({ _sum: { amount: null } });
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue(balanceLedger([{ offset: 500 }]));

    await expect(
      service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []),
    ).rejects.toThrow(
      /应退合计 ¥1600\.00 已超过实收 ¥1500\.00（现金 ¥1000\.00 \+ 预存余额抵扣 ¥500\.00）/,
    );
    expect(mockPrisma.refund.updateMany).not.toHaveBeenCalled();
  });

  /**
   * 反向守卫（防"修复"过头）：余额抵扣不能在 paidAmount 之外**再加一次**当退款额度——
   * 那等于凭空把上限抬到 2 倍实收。实收 1000（全余额抵付）应退 1500 必须拦。
   */
  it('余额抵扣不重复计入上限：实收 1000（全余额抵付）应退 1500 → 拒绝', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      refundOrder({ agentId: 'agent-1', paidAmount: dec(1_000) }),
    );
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ paidAmount: dec(1_000) }]);
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: dec(1_500) } })
      .mockResolvedValueOnce({ _sum: { amount: null } });
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue(balanceLedger([{ offset: 1_000 }]));

    await expect(
      service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []),
    ).rejects.toThrow(/已超过实收 ¥1000\.00（现金 ¥0\.00 \+ 预存余额抵扣 ¥1000\.00）/);
  });
});

describe('转 REFUNDED · 预存余额回补（PrepaymentTxType.REFUND 不再是死枚举）', () => {
  /**
   * ⚠️ 这一条是整组测试的支点：所有订单的 `prepaymentOffset` 都留在生产真值 0 上，
   * 抵扣额只从 OFFSET 流水来。旧版测试手工把 prepaymentOffset 塞成 10000 才"通过"，
   * 而生产里没有任何代码会写那一列 —— 于是线上余额一分也回不来，测试却是绿的。
   */
  it('全额余额抵付单退款 8000 → 余额 50 回补到 8050，写一条 +8000 的 REFUND 流水', async () => {
    // 实收 10000 全部来自余额抵扣：paidAmount=10000 且 OFFSET 流水 −10000，prepaymentOffset 保持 0
    mockPrisma.order.findUnique.mockResolvedValue(
      refundOrder({ agentId: 'agent-1', paidAmount: dec(10_000) }),
    );
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ paidAmount: dec(10_000) }])
      .mockResolvedValueOnce([{ prepaymentBalance: dec(50) }]);
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: dec(8_000) } })
      .mockResolvedValueOnce({ _sum: { amount: null } });
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue(balanceLedger([{ offset: 10_000 }]));
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({});

    await service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []);

    expect(mockPrisma.agent.update).toHaveBeenCalledTimes(1);
    const agentUpdate = mockPrisma.agent.update.mock.calls[0][0];
    expect(agentUpdate.where.id).toBe('agent-1');
    expect(Number(agentUpdate.data.prepaymentBalance.toString())).toBe(8_050);

    const txRow = mockPrisma.prepaymentTransaction.create.mock.calls[0][0].data;
    expect(txRow.type).toBe('REFUND');
    expect(Number(txRow.amount.toString())).toBe(8_000); // 正数 = 退回余额
    expect(Number(txRow.balanceAfter.toString())).toBe(8_050);
    expect(txRow.orderId).toBe('ord-r');
  });

  /**
   * 抵扣额只认流水：查 OFFSET 流水时必须按 orderId + type 过滤（别把 TOP_UP/ADJUSTMENT 也算进来，
   * 那会把代理的充值当成"本单抵扣"退给他）。
   */
  it('抵扣额只按本单的 OFFSET/REFUND 流水查（不掺充值与人工调账）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      refundOrder({ agentId: 'agent-1', paidAmount: dec(10_000) }),
    );
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ paidAmount: dec(10_000) }])
      .mockResolvedValueOnce([{ prepaymentBalance: dec(0) }]);
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: dec(1_000) } })
      .mockResolvedValueOnce({ _sum: { amount: null } });
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue(balanceLedger([{ offset: 10_000 }]));
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({});

    await service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []);

    const where = mockPrisma.prepaymentTransaction.findMany.mock.calls[0][0].where;
    expect(where.orderId).toBe('ord-r');
    expect(where.type).toEqual({ in: ['OFFSET', 'REFUND'] });
  });

  /**
   * 现金优先：实收 10000 = 现金 3000 + 余额抵 7000、应退 8000
   * → 现金退 3000、余额只回补 5000。两段之和必须恰好等于应退，绝不重复退。
   */
  it('现金/余额混合单：只把退不下现金的那部分（5000）回补余额', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      refundOrder({ agentId: 'agent-1', paidAmount: dec(10_000) }),
    );
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ paidAmount: dec(10_000) }])
      .mockResolvedValueOnce([{ prepaymentBalance: dec(0) }]);
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: dec(8_000) } })
      .mockResolvedValueOnce({ _sum: { amount: null } });
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue(balanceLedger([{ offset: 7_000 }]));
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({});

    await service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []);

    const txRow = mockPrisma.prepaymentTransaction.create.mock.calls[0][0].data;
    expect(Number(txRow.amount.toString())).toBe(5_000);
  });

  /**
   * 改期费从现金侧先消耗：实收 10000 = 现金 3000 + 余额抵 7000，改期费 1000、应退 8000
   * → 现金上限只剩 2000，余额侧要多补 1000（共 6000）。
   */
  it('改期费先吃现金：adjustmentCny 1000 → 现金退 2000、余额回补 6000', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      refundOrder({ agentId: 'agent-1', paidAmount: dec(10_000), adjustmentCny: 1_000 }),
    );
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ paidAmount: dec(10_000) }])
      .mockResolvedValueOnce([{ prepaymentBalance: dec(0) }]);
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: dec(8_000) } })
      .mockResolvedValueOnce({ _sum: { amount: null } });
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue(balanceLedger([{ offset: 7_000 }]));
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({});

    await service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []);

    const txRow = mockPrisma.prepaymentTransaction.create.mock.calls[0][0].data;
    expect(Number(txRow.amount.toString())).toBe(6_000);
  });

  it('幂等：本单已回补过的部分不重复回补（分批批准退款）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      refundOrder({ agentId: 'agent-1', paidAmount: dec(10_000) }),
    );
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ paidAmount: dec(10_000) }])
      .mockResolvedValueOnce([{ prepaymentBalance: dec(0) }]);
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: dec(3_000) } }) // 本次批准 3000
      .mockResolvedValueOnce({ _sum: { amount: dec(5_000) } }); // 此前已完成 5000
    // 流水：抵扣过 10000、此前已回补 5000
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue(
      balanceLedger([{ offset: 10_000 }, { restored: 5_000 }]),
    );
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({});

    await service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []);

    // 合计应回补 8000，已补 5000 → 本次只补 3000
    const txRow = mockPrisma.prepaymentTransaction.create.mock.calls[0][0].data;
    expect(Number(txRow.amount.toString())).toBe(3_000);
  });

  /**
   * 幂等的边界：已回补额度用满后**一分不再补**。
   * 现金退不下来的部分若已经全额回过余额，重复批准不能再写一条 REFUND。
   */
  it('幂等：已补满则完全不写流水、不动余额（重复批准无副作用）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      refundOrder({ agentId: 'agent-1', paidAmount: dec(10_000) }),
    );
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ paidAmount: dec(10_000) }]);
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: null } }) // 无新的 REQUESTED
      .mockResolvedValueOnce({ _sum: { amount: dec(8_000) } }); // 已完成 8000
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue(
      balanceLedger([{ offset: 10_000 }, { restored: 8_000 }]),
    );
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({});

    await service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []);

    expect(mockPrisma.prepaymentTransaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.agent.update).not.toHaveBeenCalled();
  });

  it('无代理的散客单：没有 OFFSET 流水 → 不写余额流水、不动任何余额', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(refundOrder());
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ paidAmount: dec(1_000) }]);
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: dec(800) } })
      .mockResolvedValueOnce({ _sum: { amount: null } });
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({});

    await service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []);

    expect(mockPrisma.prepaymentTransaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.agent.update).not.toHaveBeenCalled();
  });

  /**
   * 回补对象取流水上的代理，不是 order.agentId —— 抵扣掉的是当时那个代理账户的钱。
   * 混了两个代理（改归属闸被绕过的历史脏数据）时 fail-closed 交人工：
   * 把 A 的钱补给 B 比"补不上"更坏。
   */
  it('OFFSET 流水跨两个代理 → 拒绝自动回补，报错指向人工冲回', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      refundOrder({ agentId: 'agent-1', paidAmount: dec(10_000) }),
    );
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ paidAmount: dec(10_000) }]);
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: dec(8_000) } })
      .mockResolvedValueOnce({ _sum: { amount: null } });
    mockPrisma.prepaymentTransaction.findMany.mockResolvedValue(
      balanceLedger([
        { offset: 6_000, agentId: 'agent-1' },
        { offset: 4_000, agentId: 'agent-2' },
      ]),
    );

    await expect(
      service._updateStatusWithinTx(tx, 'ord-r', OrderStatus.REFUNDED, ADMIN, undefined, []),
    ).rejects.toThrow(/涉及多个代理账户，无法自动回补余额/);
    expect(mockPrisma.agent.update).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// D. 团队议价结算价按航段分摊
// ════════════════════════════════════════════════════════════════════════
describe('splitSettlementPriceAcrossLegs · 整程价按航段分摊（合计恒等于整程价）', () => {
  it('单程：原样返回整程价（与修正前行为一致）', () => {
    expect(splitSettlementPriceAcrossLegs(3_600, 1)).toEqual([3_600]);
  });

  it('往返：3600 → [1800, 1800]，合计 3600（而非每段各 3600）', () => {
    const shares = splitSettlementPriceAcrossLegs(3_600, 2);
    expect(shares).toEqual([1_800, 1_800]);
    expect(shares.reduce((s, v) => s + v, 0)).toBe(3_600);
  });

  it('除不尽：余数全给第一段，合计精确无漂移', () => {
    const shares = splitSettlementPriceAcrossLegs(1_000.01, 3);
    expect(shares).toEqual([333.35, 333.33, 333.33]);
    expect(Math.round(shares.reduce((s, v) => s + v, 0) * 100) / 100).toBe(1_000.01);
  });

  it('legCount 为 0 → 空数组（无航段可分摊，调用方回落整程价）', () => {
    expect(splitSettlementPriceAcrossLegs(3_600, 0)).toEqual([]);
  });
});

describe('priceAndValidateItems · 团队议价结算价：往返单每人只收一次', () => {
  type PriceFn = (
    items: OrderItemInput[],
    flightSettlementPriceCny?: number,
    passengers?: unknown,
    allowClientPricedGround?: boolean,
  ) => Promise<
    Array<{ kind: string; unitPrice: number; amount: number; metadata?: Record<string, unknown> }>
  >;
  const priceItems = (
    service as unknown as { priceAndValidateItems: PriceFn }
  ).priceAndValidateItems.bind(service);

  const leg = (id: string): OrderItemInput =>
    ({
      kind: 'FLIGHT',
      description: `CA100 ${id}`,
      quantity: 1,
      unitPrice: 0,
      flightScheduleId: id,
      flightCabin: 'ECONOMY',
    }) as unknown as OrderItemInput;

  /**
   * 缺陷 D 的核心守卫：修正前两条航段各写满 3600 → 每单 total 7200（每人多收一倍）。
   * 现有往返批量测试只断言座位数与行数，金额无守护，所以一直没被发现。
   */
  it('往返 2 段、结算价 3600/人、1 位乘客 → 订单总额 3600（不是 7200）', async () => {
    const priced = await priceItems([leg('sched-out'), leg('sched-back')], 3_600, undefined, true);

    expect(priced).toHaveLength(2);
    expect(priced.map((p) => p.amount)).toEqual([1_800, 1_800]);
    expect(priced.reduce((s, p) => s + p.amount, 0)).toBe(3_600);
  });

  it('往返 2 段、结算价 3600/人、每段 2 位乘客 → 订单总额 7200（3600 × 2 人）', async () => {
    const twoPax = { ...leg('sched-out'), quantity: 2 } as OrderItemInput;
    const twoPaxBack = { ...leg('sched-back'), quantity: 2 } as OrderItemInput;

    const priced = await priceItems([twoPax, twoPaxBack], 3_600, undefined, true);

    expect(priced.reduce((s, p) => s + p.amount, 0)).toBe(7_200);
  });

  it('单程、结算价 3600/人、2 位乘客 → 订单总额 7200（单程口径不受影响，防误伤）', async () => {
    const oneWay = { ...leg('sched-out'), quantity: 2 } as OrderItemInput;

    const priced = await priceItems([oneWay], 3_600, undefined, true);

    expect(priced).toHaveLength(1);
    expect(priced[0].unitPrice).toBe(3_600);
    expect(priced[0].amount).toBe(7_200);
  });

  it('分摊留痕：metadata 保留每人整程议价 + 本段分摊明细（金额可追溯）', async () => {
    const priced = await priceItems([leg('sched-out'), leg('sched-back')], 3_600, undefined, true);

    expect(priced[0].metadata).toMatchObject({
      priceOverride: 'TEAM_SETTLEMENT',
      settlementPriceCny: 3_600, // 谈定的每人整程价，不随分摊变化
      settlementLegIndex: 0,
      settlementLegCount: 2,
      settlementLegShareCny: 1_800,
    });
    expect(priced[1].metadata).toMatchObject({
      settlementLegIndex: 1,
      settlementLegShareCny: 1_800,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// E. 套餐去程出发日：以真实航段为准（客户端 goDate 不再决定取价）
// ════════════════════════════════════════════════════════════════════════
describe('resolveBundleItemDepartureLocalDate · 出发日以真实航段为权威（堵死结算价立减套利）', () => {
  type ResolveFn = (
    body: { items: OrderItemInput[] },
    bundleItem: OrderItemInput,
  ) => Promise<string | null>;
  const resolveDate = (
    service as unknown as { resolveBundleItemDepartureLocalDate: ResolveFn }
  ).resolveBundleItemDepartureLocalDate.bind(service);

  const bundleItem = (goDate?: string): OrderItemInput =>
    ({
      kind: 'BUNDLE',
      bundleId: 'bundle-1',
      description: '三亚 5 日',
      quantity: 1,
      unitPrice: 0,
      metadata: goDate ? { goDate } : {},
    }) as unknown as OrderItemInput;

  const flightLeg = (scheduleId: string): OrderItemInput =>
    ({
      kind: 'FLIGHT',
      bundleId: 'bundle-1',
      description: 'CA100',
      quantity: 1,
      unitPrice: 0,
      flightScheduleId: scheduleId,
      flightCabin: 'ECONOMY',
    }) as unknown as OrderItemInput;

  /**
   * 套利路径：散客把 metadata.goDate 改到一个有 RETAIL 立减的日期、同步下调 expectedTotalCny，
   * 因前后端同源校验通过而白拿立减。goDate 是客户端自由字段，绝不能当取价依据。
   */
  it('伪造的 goDate 被真实航段出发日覆盖（客户端改不动取价日期）', async () => {
    mockPrisma.flightSchedule.findMany.mockResolvedValue([
      { id: 'sched-out', departureTime: new Date('2026-09-14T02:00:00Z'), departureTz: 'UTC' },
      { id: 'sched-back', departureTime: new Date('2026-09-20T02:00:00Z'), departureTz: 'UTC' },
    ]);

    const got = await resolveDate(
      { items: [bundleItem('2026-11-11'), flightLeg('sched-out'), flightLeg('sched-back')] },
      bundleItem('2026-11-11'),
    );

    expect(got).toBe('2026-09-14'); // 最早航段的出发地本地日，而不是伪造的 2026-11-11
  });

  it('纯地面套餐（本单无同 bundle 航段）→ 仍回落行内 goDate（合法路径不误伤）', async () => {
    mockPrisma.flightSchedule.findMany.mockResolvedValue([]);

    const got = await resolveDate({ items: [bundleItem('2026-10-01')] }, bundleItem('2026-10-01'));

    expect(got).toBe('2026-10-01');
  });

  it('别的套餐的航段不串日期（只认同 bundleId 的航段）', async () => {
    mockPrisma.flightSchedule.findMany.mockResolvedValue([
      { id: 'sched-other', departureTime: new Date('2026-09-14T02:00:00Z'), departureTz: 'UTC' },
    ]);
    const otherBundleLeg = {
      ...flightLeg('sched-other'),
      bundleId: 'bundle-2',
    } as unknown as OrderItemInput;

    const got = await resolveDate(
      { items: [bundleItem('2026-10-01'), otherBundleLeg] },
      bundleItem('2026-10-01'),
    );

    expect(got).toBe('2026-10-01');
  });
});
