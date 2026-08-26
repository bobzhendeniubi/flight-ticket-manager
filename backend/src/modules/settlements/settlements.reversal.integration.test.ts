/**
 * 结算单 · 退款佣金冲销对账 · 真 DB 集成测试（M1）
 *
 * 覆盖会计恒等修复：佣金冲销必须穿过 SETTLED 边界，且结算对账要"看得见"冲销。
 *
 *   (1) 订单 PAID → 佣金 ACCRUED → 结算（SETTLED）→ 订单 REFUNDED
 *        ⇒ 新建一条负数 REVERSED 补偿记录，原 SETTLED 快照不动；
 *          computeSettlement 把这笔负数净进 netCommission（跨期反冲）。
 *   (2) 订单 PAID → ACCRUED → 结算前取消（CANCELLED）
 *        ⇒ 记录直接 REVERSED、不计入（保留旧行为）。
 *   (3) serializeSettlement 暴露本期退款冲销摘要（reversalCount / reversalAmount）。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import {
  CommissionStatus,
  OrderStatus,
  Prisma,
  ProductKind,
  SettlementStatus,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from '../orders/orders.service.js';
import { SettlementService } from './settlements.service.js';

const orderService = new OrderService();
const settlementService = new SettlementService();

// ── Fixtures ──────────────────────────────────────────────────────────────
function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function currentPeriod(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function createAdminActor() {
  const admin = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: admin.id, role: UserRole.ADMIN, actorType: 'USER' as const };
}

/** 建一个代理（带 User）+ 一条 VISA 佣金规则（rate 0.05）。 */
async function createAgentWithRule(rate = 0.05) {
  const user = await prisma.user.create({
    data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT },
  });
  const agent = await prisma.agent.create({
    data: {
      userId: user.id,
      contactName: '测试代理',
      contactPhone: '13800138000',
      prepaymentBalance: new Prisma.Decimal(0),
    },
  });
  await prisma.commissionRule.create({
    data: {
      agentId: agent.id,
      productKind: ProductKind.VISA,
      rate: new Prisma.Decimal(rate),
      effectiveFrom: new Date(Date.now() - 86_400_000), // 昨天起生效
    },
  });
  return agent;
}

/** 建一个 PENDING_PAYMENT 订单（挂代理 + 一个 VISA 项），已全额到账。 */
async function createPaidPendingOrder(agentId: string, total = 1000) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-REV'),
      agentId,
      status: OrderStatus.PENDING_PAYMENT,
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(total),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: 'VISA',
            description: '测试签证项',
            quantity: 1,
            unitPrice: new Prisma.Decimal(total),
            amount: new Prisma.Decimal(total),
          },
        ],
      },
    },
  });
}

/**
 * 建一条全额退款申请（无 quoteSnapshot → 佣金按全额冲销）。
 * 订单转 REFUNDED 要求必须存在对应 Refund 记录（账目完整性闸：没有退款凭据就落终态，
 * 会造成实收挂在单上、佣金却已冲销的永久对不平），所以退款类用例都要先建这条。
 */
async function craftFullRefund(orderId: string, paidTotal: number) {
  await prisma.refund.create({
    data: {
      orderId,
      amount: new Prisma.Decimal(paidTotal),
      status: 'REQUESTED',
    },
  });
}

// ══════════════════════════════════════════════════════════════════════════
describe('结算佣金冲销 · 穿过 SETTLED 边界（跨期反冲）', () => {
  it('PAID→ACCRUED→结算(SETTLED)→REFUNDED ⇒ 新建负数补偿记录、原快照不动', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05); // 5%
    const order = await createPaidPendingOrder(agent.id, 1000); // 佣金 = 1000*0.05 = 50
    const period = currentPeriod();

    // 1) 推 PAID → 生成 ACCRUED 佣金
    await orderService.updateStatus(order.id, OrderStatus.PAID, ADMIN);
    const accrued = await prisma.commissionRecord.findMany({ where: { orderId: order.id } });
    expect(accrued).toHaveLength(1);
    expect(accrued[0].status).toBe(CommissionStatus.ACCRUED);
    expect(Number(accrued[0].amount)).toBe(50);
    const originalRecordId = accrued[0].id;

    // 2) 生成结算单 + 标 PAID → 佣金 SETTLED
    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const settlementId = gen.generated[0].settlementId;
    await settlementService.updateStatus(settlementId, SettlementStatus.PENDING_APPROVAL, ADMIN);
    await settlementService.updateStatus(settlementId, SettlementStatus.APPROVED, ADMIN);
    await settlementService.updateStatus(settlementId, SettlementStatus.PAID, ADMIN);

    const settledRecord = await prisma.commissionRecord.findUniqueOrThrow({
      where: { id: originalRecordId },
    });
    expect(settledRecord.status).toBe(CommissionStatus.SETTLED);
    expect(settledRecord.settlementId).toBe(settlementId);

    // 3) 退款：PAID → REFUND_REQUESTED → REFUNDED（座位释放，触发冲销）
    await craftFullRefund(order.id, 1000);
    await orderService.updateStatus(order.id, OrderStatus.REFUND_REQUESTED, ADMIN);
    await orderService.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN);

    // 原 SETTLED 快照绝不能被改动
    const afterRefundOriginal = await prisma.commissionRecord.findUniqueOrThrow({
      where: { id: originalRecordId },
    });
    expect(afterRefundOriginal.status).toBe(CommissionStatus.SETTLED);
    expect(afterRefundOriginal.settlementId).toBe(settlementId);
    expect(Number(afterRefundOriginal.amount)).toBe(50);

    // 新建了一条负数补偿记录：REVERSED / settlementId=null / amount=-50 / baseAmount=-1000
    const compRecords = await prisma.commissionRecord.findMany({
      where: { orderId: order.id, status: CommissionStatus.REVERSED },
    });
    expect(compRecords).toHaveLength(1);
    const comp = compRecords[0];
    expect(comp.settlementId).toBeNull();
    expect(Number(comp.amount)).toBe(-50);
    expect(Number(comp.baseAmount)).toBe(-1000);
    expect(comp.agentId).toBe(agent.id);
    expect(comp.chainDepth).toBe(settledRecord.chainDepth);
    expect(Number(comp.rate)).toBe(Number(settledRecord.rate));

    // 补偿记录尚未并入任何结算单 → 会被「下一次生成」捕获净掉
    expect(comp.settlementId).toBeNull();
  });

  it('computeSettlement 把同期未结算的负数补偿记录净进 netCommission（跨期反冲落地）', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05);
    const period = currentPeriod();
    const order = await createPaidPendingOrder(agent.id, 1000);

    // 造一条「负数补偿记录」（模拟跨期反冲落到本期），settlementId=null
    await prisma.commissionRecord.create({
      data: {
        agentId: agent.id,
        orderId: order.id,
        productKind: ProductKind.VISA,
        baseAmount: new Prisma.Decimal(-1000),
        rate: new Prisma.Decimal(0.05),
        amount: new Prisma.Decimal(-50),
        chainDepth: 0,
        status: CommissionStatus.REVERSED,
        settlementId: null,
      },
    });

    // 该期没有 ACCRUED，但有未结算的负数 REVERSED → 应被生成结算单并净进 net
    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const settlementId = gen.generated[0].settlementId;

    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(Number(s.commissionEarned)).toBe(0);
    expect(Number(s.netCommission)).toBe(-50); // 0 + (-50) 退款冲销
    expect(Number(s.payableToAgent)).toBe(0); // 钳 0，不倒找代理要钱

    // M3（负佣金追回不再蒸发）：net<0，这条负数补偿记录是造成负差额的唯一来源——
    // 本次不绑定（settlementId 仍为 null），留到下一次 generate 用新的 commissionEarned
    // 抵消，而不是像旧行为那样被无条件绑定、随 payableToAgent 钳 0 一起悄悄蒸发。
    const stillUnbound = await prisma.commissionRecord.findFirst({
      where: { agentId: agent.id, status: CommissionStatus.REVERSED },
    });
    expect(stillUnbound?.settlementId).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('结算佣金冲销 · 结算前取消（保留旧行为）', () => {
  it('PAID→ACCRUED→CANCELLED(结算前) ⇒ 记录 REVERSED、不新建补偿记录', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05);
    const order = await createPaidPendingOrder(agent.id, 1000);
    const period = currentPeriod();

    await orderService.updateStatus(order.id, OrderStatus.PAID, ADMIN);
    const accrued = await prisma.commissionRecord.findFirstOrThrow({ where: { orderId: order.id } });
    expect(accrued.status).toBe(CommissionStatus.ACCRUED);

    // 结算前取消：PAID → CANCELLED（ADMIN force 跳过状态机），座位释放触发冲销
    await orderService.updateStatus(order.id, OrderStatus.CANCELLED, ADMIN, '客户取消', true);

    // 原记录被翻 REVERSED（旧行为）；因还没 SETTLED，不应新建补偿记录
    const after = await prisma.commissionRecord.findMany({ where: { orderId: order.id } });
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(accrued.id); // 同一条被翻状态
    expect(after[0].status).toBe(CommissionStatus.REVERSED);
    expect(after[0].settlementId).toBeNull();

    // 生成结算：该 REVERSED 是同期翻状态的（amount 正 50）→ 已因状态≠ACCRUED 被排除在 earned 之外，
    // 不再二次扣减（否则会重复冲销、误伤同期其他订单）。本单同期取消既不计佣金也不倒欠：net = 0。
    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: gen.generated[0].settlementId } });
    expect(Number(s.commissionEarned)).toBe(0); // 已 REVERSED，无 ACCRUED
    expect(Number(s.netCommission)).toBe(0); // 同期翻状态不重复扣减
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('serializeSettlement · 暴露退款冲销摘要', () => {
  it('list / getById 带 reversalCount + reversalAmount（负数）', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05);
    const period = currentPeriod();
    const order = await createPaidPendingOrder(agent.id, 1000);

    // 本期另有一笔新赚的佣金（100），确保 net = 100 + (-50) = 50 ≥ 0——
    // M3 修复后，only net ≥ 0 时负数补偿记录才会本轮绑定（net<0 会结转下期，见 M3 用例），
    // 这里要验证的是"绑定后 reversalCount/reversalAmount 如何透出"，所以需要 net ≥ 0。
    const earnedOrder = await createPaidPendingOrder(agent.id, 2000);
    await orderService.updateStatus(earnedOrder.id, OrderStatus.PAID, ADMIN);

    // 造一条负数补偿记录（settlementId=null）→ net ≥ 0，生成结算单后会被绑定
    await prisma.commissionRecord.create({
      data: {
        agentId: agent.id,
        orderId: order.id,
        productKind: ProductKind.VISA,
        baseAmount: new Prisma.Decimal(-1000),
        rate: new Prisma.Decimal(0.05),
        amount: new Prisma.Decimal(-50),
        chainDepth: 0,
        status: CommissionStatus.REVERSED,
        settlementId: null,
      },
    });

    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const settlementId = gen.generated[0].settlementId;

    // getById
    const detail = (await settlementService.getById(settlementId, ADMIN)) as {
      reversalCount: number;
      reversalAmount: string;
    };
    expect(detail.reversalCount).toBe(1);
    expect(Number(detail.reversalAmount)).toBe(-50);

    // list
    const listed = (await settlementService.list({ period, page: 1, pageSize: 50 }, ADMIN)) as {
      settlements: Array<{ id: string; reversalCount: number; reversalAmount: string }>;
    };
    const row = listed.settlements.find((r) => r.id === settlementId);
    expect(row).toBeDefined();
    expect(row?.reversalCount).toBe(1);
    expect(Number(row?.reversalAmount)).toBe(-50);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('结算佣金冲销 · 同期其他订单不被误伤（修双重扣减）', () => {
  it('A 同期取消 + B 未退 ⇒ B 的佣金保留，net = 50（A 翻转记录不重复扣减）', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05);
    const period = currentPeriod();
    const orderA = await createPaidPendingOrder(agent.id, 1000); // 佣金 50
    const orderB = await createPaidPendingOrder(agent.id, 1000); // 佣金 50
    await orderService.updateStatus(orderA.id, OrderStatus.PAID, ADMIN);
    await orderService.updateStatus(orderB.id, OrderStatus.PAID, ADMIN);

    // A 同期取消：ACCRUED→REVERSED（amount 仍为正 50）
    await orderService.updateStatus(orderA.id, OrderStatus.CANCELLED, ADMIN, '客户取消', true);

    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: gen.generated[0].settlementId } });
    expect(Number(s.commissionEarned)).toBe(50); // 只 B（A 已 REVERSED 排除）
    expect(Number(s.netCommission)).toBe(50); // 修复前会错成 0（A 的 +50 翻转记录被重复扣减）
    expect(Number(s.payableToAgent)).toBe(50);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('结算佣金冲销 · 部分退款按实退金额比例（M1-D）', () => {
  // 造一条 REQUESTED Refund，带 quoteSnapshot（VISA 项按 feePercent 部分退款）。
  async function craftPartialRefund(orderId: string, feePercent: number, paidTotal: number) {
    const refundAmount = (paidTotal * (100 - feePercent)) / 100;
    const feeAmount = paidTotal - refundAmount;
    await prisma.refund.create({
      data: {
        orderId,
        amount: new Prisma.Decimal(refundAmount),
        status: 'REQUESTED',
        gatewayPayload: {
          quoteSnapshot: {
            totalFee: feeAmount,
            totalRefund: refundAmount,
            items: [{ itemId: 'x', kind: 'VISA', feePercent, feeAmount, refundAmount }],
          },
        },
      },
    });
  }

  it('部分退款 60% · 结算后 ⇒ 负数补偿 = −60% 佣金（原 SETTLED 不动）', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05);
    const order = await createPaidPendingOrder(agent.id, 1000); // 佣金 50
    const period = currentPeriod();
    await orderService.updateStatus(order.id, OrderStatus.PAID, ADMIN);

    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const sid = gen.generated[0].settlementId;
    await settlementService.updateStatus(sid, SettlementStatus.PENDING_APPROVAL, ADMIN);
    await settlementService.updateStatus(sid, SettlementStatus.APPROVED, ADMIN);
    await settlementService.updateStatus(sid, SettlementStatus.PAID, ADMIN);

    await craftPartialRefund(order.id, 40, 1000); // 退 60%、留 40% 手续费
    await orderService.updateStatus(order.id, OrderStatus.REFUND_REQUESTED, ADMIN);
    await orderService.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN);

    const comp = await prisma.commissionRecord.findMany({
      where: { orderId: order.id, status: CommissionStatus.REVERSED },
    });
    expect(comp).toHaveLength(1);
    expect(Number(comp[0].amount)).toBe(-30); // 50 × 0.6
    expect(Number(comp[0].baseAmount)).toBe(-600); // 1000 × 0.6
    expect(comp[0].settlementId).toBeNull();
  });

  it('部分退款 60% · 结算前 ⇒ 原 ACCRUED 保留 + 负数补偿 −30，net = 20', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05);
    const order = await createPaidPendingOrder(agent.id, 1000); // 佣金 50
    const period = currentPeriod();
    await orderService.updateStatus(order.id, OrderStatus.PAID, ADMIN);

    await craftPartialRefund(order.id, 40, 1000); // 退 60%
    await orderService.updateStatus(order.id, OrderStatus.REFUND_REQUESTED, ADMIN);
    await orderService.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN);

    const recs = await prisma.commissionRecord.findMany({ where: { orderId: order.id } });
    expect(recs).toHaveLength(2);
    const accruedRec = recs.find((r) => r.status === CommissionStatus.ACCRUED);
    const compRec = recs.find((r) => r.status === CommissionStatus.REVERSED);
    expect(Number(accruedRec?.amount)).toBe(50);
    expect(Number(compRec?.amount)).toBe(-30);

    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: gen.generated[0].settlementId } });
    expect(Number(s.commissionEarned)).toBe(50); // 原 ACCRUED 全额
    expect(Number(s.netCommission)).toBe(20); // 50 + (−30)；留存 40% 手续费对应佣金
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P0 · 转 PAID 前复检退款冲销
// ══════════════════════════════════════════════════════════════════════════
describe('结算单 · 转 PAID 前复检（P0：APPROVED 后才退款，绑定记录被原地翻 REVERSED）', () => {
  it('APPROVED 后退款把绑定的 ACCRUED 原地翻 REVERSED（settlementId 不清）→ 转 PAID 应 400 拒绝', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05);
    const order = await createPaidPendingOrder(agent.id, 1000); // 佣金 50
    const period = currentPeriod();

    await orderService.updateStatus(order.id, OrderStatus.PAID, ADMIN);
    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const settlementId = gen.generated[0].settlementId;
    await settlementService.updateStatus(settlementId, SettlementStatus.PENDING_APPROVAL, ADMIN);
    await settlementService.updateStatus(settlementId, SettlementStatus.APPROVED, ADMIN);

    // 审核通过之后才退款：订单佣金记录仍是 ACCRUED（尚未 PAID/SETTLED），
    // 全额冲销走「原地翻状态」分支（orders.service:5477-5480），settlementId 不会被清空——
    // 这正是 P0 描述的钱洞：结算单账面的 commissionEarned=50 已经过期。
    await craftFullRefund(order.id, 1000);
    await orderService.updateStatus(order.id, OrderStatus.REFUND_REQUESTED, ADMIN);
    await orderService.updateStatus(order.id, OrderStatus.REFUNDED, ADMIN);

    const flipped = await prisma.commissionRecord.findFirstOrThrow({ where: { orderId: order.id } });
    expect(flipped.status).toBe(CommissionStatus.REVERSED);
    expect(flipped.settlementId).toBe(settlementId); // 仍绑在本单上（bug 现状）
    expect(Number(flipped.amount)).toBe(50); // 原地翻转，金额未取反

    await expect(
      settlementService.updateStatus(settlementId, SettlementStatus.PAID, ADMIN),
    ).rejects.toMatchObject({ message: expect.stringContaining('已冲销佣金') });

    // 拒付必须整体回滚：结算单仍是 APPROVED，记录仍是 REVERSED（没被误标 SETTLED）
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(s.status).toBe(SettlementStatus.APPROVED);
    const after = await prisma.commissionRecord.findUniqueOrThrow({ where: { id: flipped.id } });
    expect(after.status).toBe(CommissionStatus.REVERSED);
  });

  it('负数补偿记录合法绑定（net≥0，从未计入 commissionEarned）不应被复检拦下 → 正常转 PAID', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05);
    const period = currentPeriod();

    // order2：本期新赚 100（保持 ACCRUED，正常绑定）
    const order2 = await createPaidPendingOrder(agent.id, 2000);
    await orderService.updateStatus(order2.id, OrderStatus.PAID, ADMIN);

    // 直接造一条负数补偿记录（模拟另一笔已结算订单的跨期退款追回），settlementId=null，
    // 从创建那一刻起就是 REVERSED——从未计入本单的 commissionEarned。
    await prisma.commissionRecord.create({
      data: {
        agentId: agent.id,
        orderId: order2.id,
        productKind: ProductKind.VISA,
        baseAmount: new Prisma.Decimal(-1000),
        rate: new Prisma.Decimal(0.05),
        amount: new Prisma.Decimal(-50),
        chainDepth: 0,
        status: CommissionStatus.REVERSED,
        settlementId: null,
      },
    });

    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const settlementId = gen.generated[0].settlementId;
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(Number(s.commissionEarned)).toBe(100); // 只有 order2 的 ACCRUED
    expect(Number(s.netCommission)).toBe(50); // 100 + (-50)，net ≥ 0 → 负数记录正常绑定

    // net ≥ 0：负数补偿记录本轮就绑定（不是 M3 结转场景）
    const comp = await prisma.commissionRecord.findFirstOrThrow({
      where: { agentId: agent.id, status: CommissionStatus.REVERSED },
    });
    expect(comp.settlementId).toBe(settlementId);

    await settlementService.updateStatus(settlementId, SettlementStatus.PENDING_APPROVAL, ADMIN);
    await settlementService.updateStatus(settlementId, SettlementStatus.APPROVED, ADMIN);
    // 复检不应拦下：这条 REVERSED 从生成起就没算进 commissionEarned，仍为 ACCRUED 的总额
    // （只有 order2 的 100）与 stored commissionEarned（100）相等。
    const paid = await settlementService.updateStatus(settlementId, SettlementStatus.PAID, ADMIN);
    expect((paid as { status: string }).status).toBe(SettlementStatus.PAID);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// VOIDED 解绑范围
// ══════════════════════════════════════════════════════════════════════════
describe('结算单 · VOIDED 解绑范围覆盖 ACCRUED 与 REVERSED（此前只解绑 ACCRUED，REVERSED 被永久绑死）', () => {
  it('作废时 ACCRUED 与 REVERSED 记录都应解绑（settlementId=null）；SETTLED 记录不受影响', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05);
    const period = currentPeriod();
    const order = await createPaidPendingOrder(agent.id, 1000);
    await orderService.updateStatus(order.id, OrderStatus.PAID, ADMIN);

    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const settlementId = gen.generated[0].settlementId;

    // 手工再绑一条负数补偿记录到本单，模拟"本单既有 ACCRUED 又有 REVERSED"的混合态
    const revRecord = await prisma.commissionRecord.create({
      data: {
        agentId: agent.id,
        orderId: order.id,
        productKind: ProductKind.VISA,
        baseAmount: new Prisma.Decimal(-1000),
        rate: new Prisma.Decimal(0.05),
        amount: new Prisma.Decimal(-10),
        chainDepth: 0,
        status: CommissionStatus.REVERSED,
        settlementId,
      },
    });
    const accruedRecord = await prisma.commissionRecord.findFirstOrThrow({
      where: { orderId: order.id, status: CommissionStatus.ACCRUED },
    });

    await settlementService.updateStatus(settlementId, SettlementStatus.PENDING_APPROVAL, ADMIN);
    await settlementService.updateStatus(settlementId, SettlementStatus.APPROVED, ADMIN);
    await settlementService.updateStatus(settlementId, SettlementStatus.VOIDED, ADMIN);

    const afterAccrued = await prisma.commissionRecord.findUniqueOrThrow({ where: { id: accruedRecord.id } });
    const afterReversed = await prisma.commissionRecord.findUniqueOrThrow({ where: { id: revRecord.id } });
    expect(afterAccrued.settlementId).toBeNull();
    expect(afterAccrued.status).toBe(CommissionStatus.ACCRUED);
    // 修复点：此前只解绑 ACCRUED，这条 REVERSED 会被永久绑死在废单上
    expect(afterReversed.settlementId).toBeNull();
    expect(afterReversed.status).toBe(CommissionStatus.REVERSED);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// M3 · 负佣金追回结转下期（不再蒸发）
// ══════════════════════════════════════════════════════════════════════════
describe('结算单 · 负佣金追回不再蒸发（M3：netCommission<0 时负差额结转，下次 generate 扫入吸收）', () => {
  it('本期净额为负 → 造成负差额的补偿记录不绑定，payableToAgent 钳 0，carryForwardAmount 透出', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05);
    const period = currentPeriod();

    // order1：本期新赚 20（小）
    const order1 = await createPaidPendingOrder(agent.id, 400);
    await orderService.updateStatus(order1.id, OrderStatus.PAID, ADMIN);

    // 一条大额负数补偿记录 -50（大于本期新赚的 20），settlementId=null
    const negRecord = await prisma.commissionRecord.create({
      data: {
        agentId: agent.id,
        orderId: order1.id,
        productKind: ProductKind.VISA,
        baseAmount: new Prisma.Decimal(-1000),
        rate: new Prisma.Decimal(0.05),
        amount: new Prisma.Decimal(-50),
        chainDepth: 0,
        status: CommissionStatus.REVERSED,
        settlementId: null,
      },
    });

    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const settlementId = gen.generated[0].settlementId;
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(Number(s.commissionEarned)).toBe(20);
    expect(Number(s.netCommission)).toBe(-30); // 20 + (-50)
    expect(Number(s.payableToAgent)).toBe(0); // 钳 0，本期不倒找代理要钱

    // 负差额部分（造成 net<0 的负数补偿记录）本次不绑定——留在"待处理"池子里
    const negAfterGen = await prisma.commissionRecord.findUniqueOrThrow({ where: { id: negRecord.id } });
    expect(negAfterGen.settlementId).toBeNull();
    // 正常的 earnedRecords 照常绑定，不受影响（别把正常正数记录误漏绑）
    const earnedAfterGen = await prisma.commissionRecord.findFirstOrThrow({
      where: { orderId: order1.id, status: CommissionStatus.ACCRUED },
    });
    expect(earnedAfterGen.settlementId).toBe(settlementId);

    // serializeSettlement 透出只读的结转摘要
    const detail = (await settlementService.getById(settlementId, ADMIN)) as { carryForwardAmount: string };
    expect(Number(detail.carryForwardAmount)).toBe(30);

    // 下一次 generate（哪怕仍是本期）用新的 commissionEarned 把结转的负数扫入吸收
    const order2 = await createPaidPendingOrder(agent.id, 1600); // 佣金 80
    await orderService.updateStatus(order2.id, OrderStatus.PAID, ADMIN);
    const gen2 = await settlementService.generate({ period, agentId: agent.id, overwrite: true }, ADMIN);
    expect(gen2.generated[0].settlementId).toBe(settlementId); // 同一张单被重算

    const s2 = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(Number(s2.commissionEarned)).toBe(100); // 20 + 80
    expect(Number(s2.netCommission)).toBe(50); // 100 + (-50)，这次 net ≥ 0
    expect(Number(s2.payableToAgent)).toBe(50);

    const negAfterGen2 = await prisma.commissionRecord.findUniqueOrThrow({ where: { id: negRecord.id } });
    expect(negAfterGen2.settlementId).toBe(settlementId); // 终于被绑定吸收

    const detail2 = (await settlementService.getById(settlementId, ADMIN)) as { carryForwardAmount: string };
    expect(Number(detail2.carryForwardAmount)).toBe(0);
  });
});
