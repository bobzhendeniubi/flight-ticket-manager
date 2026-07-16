/**
 * OrderService 资金窗口破口 · 真 DB 集成测试
 *
 * 覆盖三个「钱能凭空流出」的破口：
 *
 *   N1 退款审批中的资金窗口（收 1500 付 2000）
 *     单转 REFUND_REQUESTED 后 Refund 停在 REQUESTED（不计入已完成退款），
 *     此时多付处置闸放行 → 多付被转进代理余额、paidAmount 被压低；
 *     随后管理员批准退款，却按 Refund.amount 快照照付 → 净流出 > 净流入。
 *     两层防线：① 处置闸拉黑 REFUND_REQUESTED；② 批准退款时锁单重校应退额。
 *
 *   N2 改结算价无行锁 → total ≠ Σ items
 *     并发改同一单不同 item，各自用陈旧 items 快照重算 total，后写覆盖前写。
 *
 *   A15 补房差未接资金闸
 *     已取消/已退款/回收站单可被补房差抬高 total（total 正是应退额基数）→ 二次退款。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import {
  OrderItemKind,
  OrderStatus,
  Prisma,
  RefundStatus,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService, type OrderRequester } from './orders.service.js';
import { BadRequestError } from '../../lib/errors.js';

const service = new OrderService();

// ── Fixtures ───────────────────────────────────────────────────────────────
function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function adminActor(): Promise<OrderRequester> {
  const admin = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: admin.id, role: UserRole.ADMIN, actorType: 'USER' as const };
}

async function createAgent(balance = 0) {
  const user = await prisma.user.create({
    data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT },
  });
  return prisma.agent.create({
    data: {
      userId: user.id,
      contactName: '测试代理',
      contactPhone: '13800138000',
      prepaymentBalance: new Prisma.Decimal(balance),
    },
  });
}

/** 建单：可指定状态 / total / paidAmount / 归属代理 / 行。 */
async function createOrder(opts: {
  status?: OrderStatus;
  total?: number;
  paidAmount?: number;
  agentId?: string | null;
  items?: Array<{ kind: OrderItemKind; unitPrice: number; quantity: number }>;
}) {
  const total = opts.total ?? 1000;
  const items = opts.items ?? [
    { kind: OrderItemKind.FLIGHT, unitPrice: total, quantity: 1 },
  ];
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-FW'),
      status: opts.status ?? OrderStatus.PAID,
      agentId: opts.agentId ?? null,
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(opts.paidAmount ?? total),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: items.map((it) => ({
          kind: it.kind,
          description: `${it.kind} 行`,
          quantity: it.quantity,
          unitPrice: new Prisma.Decimal(it.unitPrice),
          amount: new Prisma.Decimal(it.unitPrice * it.quantity),
        })),
      },
    },
    include: { items: true },
  });
}

/**
 * 把订单推进到「退款审批中」：建一条 REQUESTED Refund + 状态置 REFUND_REQUESTED。
 * 这正是 requestCancellation 事务提交后留下的状态（Refund 停在 REQUESTED 等管理员批准），
 * 直接构造是为了绕开取消报价（cancellationPolicy）的费率依赖，只测资金窗口本身。
 */
async function enterRefundReview(orderId: string, refundAmount: number) {
  await prisma.refund.create({
    data: {
      orderId,
      amount: new Prisma.Decimal(refundAmount),
      status: RefundStatus.REQUESTED,
      gatewayPayload: {
        quoteSnapshot: { totalFee: 0, totalRefund: refundAmount, items: [] },
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.order.update({
    where: { id: orderId },
    data: { status: OrderStatus.REFUND_REQUESTED },
  });
}

// ── N1：退款审批中的资金窗口 ────────────────────────────────────────────────
describe('N1 · 退款审批中的资金窗口（收 1500 付 2000）', () => {
  it('止血层：REFUND_REQUESTED 的单不许把多付转存代理余额', async () => {
    const ADMIN = await adminActor();
    const agent = await createAgent(0);
    // total 1000 / paid 1500 —— 多付 500
    const order = await createOrder({ total: 1000, paidAmount: 1500, agentId: agent.id });
    // 客户申请取消 → Refund(REQUESTED, 1500) + 单转 REFUND_REQUESTED
    await enterRefundReview(order.id, 1500);

    await expect(service.creditOverpayToAgent(order.id, ADMIN)).rejects.toThrow(BadRequestError);

    // 钱一分没动：代理余额与 paidAmount 都保持原样
    const agentAfter = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(Number(agentAfter.prepaymentBalance)).toBe(0);
    const orderAfter = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(orderAfter.paidAmount)).toBe(1500);
  });

  it('止血层：REFUND_REQUESTED 的单不许把多付转入挂账池', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({ total: 1000, paidAmount: 1500 });
    await enterRefundReview(order.id, 1500);

    await expect(service.overpayToPool(order.id, ADMIN)).rejects.toThrow(BadRequestError);

    const orderAfter = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(orderAfter.paidAmount)).toBe(1500);
  });

  it('止血层：REFUND_REQUESTED 的单不许改结算价（退款前偷偷抬价操纵应退额）', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({ total: 1000, paidAmount: 1000 });
    await enterRefundReview(order.id, 1000);

    await expect(
      service.updateItemSettlementPrice(order.id, order.items[0].id, { unitPriceCny: 9999 }, ADMIN),
    ).rejects.toThrow(BadRequestError);

    const orderAfter = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(orderAfter.total)).toBe(1000);
  });

  /**
   * 治本层：即便资金已经（经任何路径）流出、paidAmount 被压低，
   * 批准退款那一刻也必须锁单重校应退额，不能按 Refund.amount 快照照付。
   *
   * 构造：paidAmount 1000（多付 500 已被转走）、Refund 快照仍是 1500。
   * 修复前：updateMany 照翻 COMPLETED → 公司实付 1500、实收 1000 → 亏 500。
   */
  it('治本层：批准退款时应退额 > 当前 paidAmount → 拒绝，Refund 不翻 COMPLETED', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({ total: 1000, paidAmount: 1000 });
    await enterRefundReview(order.id, 1500); // 快照 1500 > 实收 1000

    await expect(service.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN)).rejects.toThrow(
      BadRequestError,
    );

    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
    expect(refund.status).toBe(RefundStatus.REQUESTED);
    const orderAfter = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderAfter.status).toBe(OrderStatus.REFUND_REQUESTED);
  });

  it('治本层：多条 REQUESTED Refund 按合计校验（各自 ≤ paidAmount 但合计超收）', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({ total: 1000, paidAmount: 1000 });
    // 两条各 600：逐条看都 ≤ 1000，合计 1200 > 1000 —— updateMany 会一次全翻，必须按合计拦
    await enterRefundReview(order.id, 600);
    await prisma.refund.create({
      data: { orderId: order.id, amount: new Prisma.Decimal(600), status: RefundStatus.REQUESTED },
    });

    await expect(service.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN)).rejects.toThrow(
      BadRequestError,
    );

    const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds.every((r) => r.status === RefundStatus.REQUESTED)).toBe(true);
  });

  it('治本层：已完成退款计入合计（第二次退款吃掉剩余额度后不许再退）', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({ total: 1000, paidAmount: 1000 });
    // 已退过 800（退款完成不减 paidAmount，所以 paidAmount 仍是 1000）
    await prisma.refund.create({
      data: {
        orderId: order.id,
        amount: new Prisma.Decimal(800),
        status: RefundStatus.COMPLETED,
        processedAt: new Date(),
      },
    });
    await enterRefundReview(order.id, 300); // 800 + 300 = 1100 > 1000

    await expect(service.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN)).rejects.toThrow(
      BadRequestError,
    );
  });

  it('正常退款不受影响：应退额 ≤ paidAmount → 批准成功，Refund 翻 COMPLETED', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({ total: 1000, paidAmount: 1000 });
    await enterRefundReview(order.id, 800); // 扣 200 退改费后实退 800

    await service.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN);

    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
    expect(refund.status).toBe(RefundStatus.COMPLETED);
    expect(refund.processedAt).not.toBeNull();
  });

  it('全额退款（应退额 == paidAmount）是边界内，仍允许', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({ total: 1000, paidAmount: 1000 });
    await enterRefundReview(order.id, 1000);

    await service.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN);

    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
    expect(refund.status).toBe(RefundStatus.COMPLETED);
  });

  it('拒绝退款（REFUND_REQUESTED → PROCESSING）不受应退额校验影响', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({ total: 1000, paidAmount: 1000 });
    await enterRefundReview(order.id, 1500); // 超额快照也能被拒回退

    await service.updateStatus(order.id, OrderStatus.PROCESSING, ADMIN);

    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
    expect(refund.status).toBe(RefundStatus.REJECTED);
  });
});

// ── N2：改结算价并发 → total ≠ Σ items ──────────────────────────────────────
describe('N2 · 改结算价行锁', () => {
  /**
   * 真并发测试。局限与对策：
   *   单跑一轮不可靠 —— 连接池冷启动时两个事务会碰巧串行执行，无锁版本也能侥幸通过。
   *   实测（修复前，12 轮）：第 0 轮 OK，其余 11 轮全部 total=1100/1200 而 Σitems=300。
   *   故这里跑 8 轮并**每轮都断言**不变式：无锁版本必炸，有锁版本恒等。
   * 断言的是不变式（total == Σ items）而非某个具体 total 值：
   *   两个并发请求谁先谁后不确定，但无论何种交错，total 都必须等于 Σ items。
   */
  it('并发改同一单的两个不同 item → total 必须恒等于 Σ items（不丢改价）', async () => {
    const ADMIN = await adminActor();

    for (let i = 0; i < 8; i++) {
      const order = await createOrder({
        total: 2000,
        paidAmount: 0,
        items: [
          { kind: OrderItemKind.FLIGHT, unitPrice: 1000, quantity: 1 },
          { kind: OrderItemKind.FLIGHT, unitPrice: 1000, quantity: 1 },
        ],
      });
      const [itemA, itemB] = order.items;

      // 两个并发请求各改一行：A → 100，B → 200。期望 total = 300。
      // 无行锁时两者都从各自陈旧的 items 快照重算 newSubtotal，后写者覆盖前写者 →
      // total 丢掉一个 item 的改价（1100 或 1200），而 orderItem.amount 两条都已落库。
      await Promise.all([
        service.updateItemSettlementPrice(order.id, itemA.id, { unitPriceCny: 100 }, ADMIN),
        service.updateItemSettlementPrice(order.id, itemB.id, { unitPriceCny: 200 }, ADMIN),
      ]);

      const after = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });
      const sumItems = after.items.reduce((s, it) => s + Number(it.amount), 0);
      expect(sumItems).toBe(300);
      expect(Number(after.total), `第 ${i} 轮：total 与 Σ items 分叉`).toBe(sumItems);
      expect(Number(after.subtotal), `第 ${i} 轮：subtotal 与 Σ items 分叉`).toBe(sumItems);
    }
  });

  it('锁内重新聚合：改价用的是库里最新 items，而非事务开始前的快照', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({
      total: 2000,
      paidAmount: 0,
      items: [
        { kind: OrderItemKind.FLIGHT, unitPrice: 1000, quantity: 1 },
        { kind: OrderItemKind.FLIGHT, unitPrice: 1000, quantity: 1 },
      ],
    });
    const [itemA, itemB] = order.items;

    // 串行两次：第二次必须看到第一次的结果（100 + 200 = 300），而不是 1000 + 200 = 1200
    await service.updateItemSettlementPrice(order.id, itemA.id, { unitPriceCny: 100 }, ADMIN);
    await service.updateItemSettlementPrice(order.id, itemB.id, { unitPriceCny: 200 }, ADMIN);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(after.total)).toBe(300);
  });
});

// ── A15：补房差未接资金闸 ───────────────────────────────────────────────────
describe('A15 · 补房差资金闸', () => {
  const SUPPLEMENT = { perNightCny: 300, nights: 2 };

  it('已退款单补房差 → 拒绝（total 是应退额基数，抬高即二次退款）', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({
      status: OrderStatus.REFUNDED,
      items: [{ kind: OrderItemKind.BUNDLE, unitPrice: 1000, quantity: 1 }],
    });

    await expect(service.addRoomSupplement(order.id, SUPPLEMENT, ADMIN)).rejects.toThrow(
      BadRequestError,
    );

    const after = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(Number(after.total)).toBe(1000);
    expect(after.items).toHaveLength(1); // 没有新增 FEE 行
  });

  it('已取消单补房差 → 拒绝', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({
      status: OrderStatus.CANCELLED,
      items: [{ kind: OrderItemKind.BUNDLE, unitPrice: 1000, quantity: 1 }],
    });

    await expect(service.addRoomSupplement(order.id, SUPPLEMENT, ADMIN)).rejects.toThrow(
      BadRequestError,
    );
  });

  it('回收站（软删）单补房差 → 拒绝', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({
      status: OrderStatus.PAID,
      items: [{ kind: OrderItemKind.BUNDLE, unitPrice: 1000, quantity: 1 }],
    });
    await prisma.order.update({ where: { id: order.id }, data: { deletedAt: new Date() } });

    await expect(service.addRoomSupplement(order.id, SUPPLEMENT, ADMIN)).rejects.toThrow(
      BadRequestError,
    );
  });

  it('活跃单（PAID）补房差仍正常：新增 FEE 行 + total 增加', async () => {
    const ADMIN = await adminActor();
    const order = await createOrder({
      status: OrderStatus.PAID,
      items: [{ kind: OrderItemKind.BUNDLE, unitPrice: 1000, quantity: 1 }],
    });

    await service.addRoomSupplement(order.id, SUPPLEMENT, ADMIN);

    const after = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(Number(after.total)).toBe(1600);
    expect(after.items).toHaveLength(2);
  });
});
