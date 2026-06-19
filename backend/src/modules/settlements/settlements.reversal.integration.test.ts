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

    // 负数补偿记录被绑定到该结算单（settlementId 不再 null）→ 下期不重复计入
    const bound = await prisma.commissionRecord.findFirst({
      where: { agentId: agent.id, status: CommissionStatus.REVERSED },
    });
    expect(bound?.settlementId).toBe(settlementId);
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

    // 生成结算：该 REVERSED 是同期翻状态的（amount 仍为正 50），computeSettlement 取相反数净掉
    const gen = await settlementService.generate({ period, agentId: agent.id, overwrite: false }, ADMIN);
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: gen.generated[0].settlementId } });
    expect(Number(s.commissionEarned)).toBe(0); // 已 REVERSED，无 ACCRUED
    expect(Number(s.netCommission)).toBe(-50); // 0 + (-50)
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('serializeSettlement · 暴露退款冲销摘要', () => {
  it('list / getById 带 reversalCount + reversalAmount（负数）', async () => {
    const ADMIN = await createAdminActor();
    const agent = await createAgentWithRule(0.05);
    const period = currentPeriod();
    const order = await createPaidPendingOrder(agent.id, 1000);

    // 造一条负数补偿记录（settlementId=null）→ 生成结算单后会被绑定
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
