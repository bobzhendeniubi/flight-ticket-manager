/**
 * 结算单 · 并发钱洞防护 · 真 DB 集成测试
 *
 * 覆盖 codex+fable 交叉审计发现的三条同类并发路径（均因「状态事务外读、事务内无 status CAS」）：
 *
 *   R1-PAID  两个并发 APPROVED→PAID：修复前第二个事务会按同一 prepaymentOffset 再扣一次余额、
 *            再写一条 OFFSET、二次标 PAID。修后事务内先对 Settlement 做原子 CAS，只一次成功。
 *   R1-VOID  并发 APPROVED→PAID 与 APPROVED→VOIDED 交错：修前可能 PAID 已扣 offset+records SETTLED，
 *            VOIDED 又把 records 解绑回 ACCRUED → 下期重复计入双付。修后 CAS 互斥 + VOID 解绑押 status。
 *   R9       generate(overwrite) 与审批赛跑：修前 overwrite 无条件把单打回 DRAFT + 解绑 records，
 *            并发已 APPROVED/PAID 会被静默重置成账面孤儿。修后 overwrite 用 status CAS 拒绝重算终态单。
 *
 * 铁律：一笔钱最多入账/扣账一次；已扣 offset 的 records 绝不被解绑回 unlinked。
 *
 * 跑：
 *   1. docker compose -f ../docker-compose.test.yml up -d
 *   2. npm run test:integration   （或 npx vitest run src/modules/settlements）
 */
import { describe, it, expect } from 'vitest';
import {
  CommissionStatus,
  PrepaymentTxType,
  Prisma,
  ProductKind,
  SettlementStatus,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { SettlementService } from './settlements.service.js';

const settlementService = new SettlementService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function currentPeriod(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * 造一张结算单（默认 APPROVED）：代理预存 100，本单抵扣 50，绑定一条 ACCRUED 佣金（50）。
 * 若并发双扣，余额会被扣到 0 且冒出两条 OFFSET —— 正是这些测试要挡下的。
 */
async function seedSettlement(status: SettlementStatus = SettlementStatus.APPROVED) {
  const admin = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  const agentUser = await prisma.user.create({
    data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT },
  });
  const agent = await prisma.agent.create({
    data: {
      userId: agentUser.id,
      contactName: '并发测试代理',
      contactPhone: '13800138000',
      prepaymentBalance: new Prisma.Decimal(100),
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: uniq('TEST-CONC'),
      agentId: agent.id,
      status: 'PAID',
      subtotal: new Prisma.Decimal(1000),
      total: new Prisma.Decimal(1000),
      paidAmount: new Prisma.Decimal(1000),
      contactName: 'Test User',
      contactPhone: '13800138000',
    },
  });
  const settlement = await prisma.settlement.create({
    data: {
      period: currentPeriod(),
      agentId: agent.id,
      orderCount: 1,
      grossRevenue: new Prisma.Decimal(1000),
      commissionEarned: new Prisma.Decimal(50),
      netCommission: new Prisma.Decimal(50),
      prepaymentOffset: new Prisma.Decimal(50),
      payableToAgent: new Prisma.Decimal(0),
      status,
      approvedAt: status === SettlementStatus.APPROVED ? new Date() : null,
    },
  });
  const record = await prisma.commissionRecord.create({
    data: {
      agentId: agent.id,
      orderId: order.id,
      productKind: ProductKind.VISA,
      baseAmount: new Prisma.Decimal(1000),
      rate: new Prisma.Decimal(0.05),
      amount: new Prisma.Decimal(50),
      chainDepth: 0,
      status: CommissionStatus.ACCRUED,
      settlementId: settlement.id,
    },
  });
  return {
    admin: { userId: admin.id, role: UserRole.ADMIN },
    agentId: agent.id,
    settlementId: settlement.id,
    recordId: record.id,
    period: settlement.period,
  };
}

// ══════════════════════════════════════════════════════════════════════════
describe('R1-PAID · 并发转 PAID 只成功一次、余额只扣一次（CAS 防双扣）', () => {
  it('两个并发 APPROVED→PAID：恰一成功一失败，余额扣 50 一次，只一条 OFFSET，records SETTLED', async () => {
    const { admin, agentId, settlementId, recordId } = await seedSettlement();

    const results = await Promise.allSettled([
      settlementService.updateStatus(settlementId, SettlementStatus.PAID, admin),
      settlementService.updateStatus(settlementId, SettlementStatus.PAID, admin),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // 只有一个能推进
    expect(rejected).toHaveLength(1); // 另一个被挡下（CAS 落空 / 状态已非 APPROVED）

    const finalS = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(finalS.status).toBe(SettlementStatus.PAID);

    // 余额只被扣一次：100 - 50 = 50（双扣会变成 0）
    const finalAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(Number(finalAgent.prepaymentBalance)).toBe(50);

    // 只有一条 OFFSET 流水，金额 = -50（双扣会有两条）
    const offsets = await prisma.prepaymentTransaction.findMany({
      where: { agentId, type: PrepaymentTxType.OFFSET },
    });
    expect(offsets).toHaveLength(1);
    expect(Number(offsets[0].amount)).toBe(-50);
    expect(Number(offsets[0].balanceAfter)).toBe(50);

    const rec = await prisma.commissionRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(rec.status).toBe(CommissionStatus.SETTLED);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('R1-VOID · 并发 PAID 与 VOIDED 交错：绝不出现「已扣 offset 又把 records 解绑回 ACCRUED」', () => {
  it('APPROVED→PAID 与 APPROVED→VOIDED 并发：恰一成功，账/记录一致（无双付孤儿）', async () => {
    const { admin, agentId, settlementId, recordId } = await seedSettlement();

    const results = await Promise.allSettled([
      settlementService.updateStatus(settlementId, SettlementStatus.PAID, admin),
      settlementService.updateStatus(settlementId, SettlementStatus.VOIDED, admin),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const finalS = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    const rec = await prisma.commissionRecord.findUniqueOrThrow({ where: { id: recordId } });
    const finalAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    const offsets = await prisma.prepaymentTransaction.findMany({
      where: { agentId, type: PrepaymentTxType.OFFSET },
    });

    if (finalS.status === SettlementStatus.PAID) {
      // PAID 赢：offset 扣一次、records SETTLED 且仍绑定
      expect(rec.status).toBe(CommissionStatus.SETTLED);
      expect(rec.settlementId).toBe(settlementId);
      expect(Number(finalAgent.prepaymentBalance)).toBe(50);
      expect(offsets).toHaveLength(1);
    } else {
      // VOIDED 赢：绝不扣 offset、records 解绑回 ACCRUED、余额原样
      expect(finalS.status).toBe(SettlementStatus.VOIDED);
      expect(rec.status).toBe(CommissionStatus.ACCRUED);
      expect(rec.settlementId).toBeNull();
      expect(Number(finalAgent.prepaymentBalance)).toBe(100);
      expect(offsets).toHaveLength(0);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('R9 · generate(overwrite) 与审批赛跑：终态单绝不被静默打回 DRAFT / 解绑 records', () => {
  it('generate(overwrite) 与 PENDING_APPROVAL→APPROVED 并发：records 始终绑定在本单且 ACCRUED', async () => {
    const { admin, settlementId, recordId, period } = await seedSettlement(
      SettlementStatus.PENDING_APPROVAL,
    );
    const agentId = (
      await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } })
    ).agentId;

    const results = await Promise.allSettled([
      settlementService.generate({ period, agentId, overwrite: true }, admin),
      settlementService.updateStatus(settlementId, SettlementStatus.APPROVED, admin),
    ]);
    // 至少一个成功（两者互斥推进；赢家提交，输家 CAS 落空被拒）
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    const finalS = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    const rec = await prisma.commissionRecord.findUniqueOrThrow({ where: { id: recordId } });

    // 关键不变量：无论谁赢，佣金记录都必须仍绑定在本结算单、且为 ACCRUED。
    // 修复前的孤儿态 = 状态 APPROVED 但 records 已被 generate 解绑（settlementId=null）。
    expect(rec.settlementId).toBe(settlementId);
    expect(rec.status).toBe(CommissionStatus.ACCRUED);
    expect([SettlementStatus.DRAFT, SettlementStatus.APPROVED]).toContain(finalS.status);
  });

  it('generate(overwrite) 对已 APPROVED 的当期单直接跳过（不进事务、不解绑 records）', async () => {
    const { admin, settlementId, recordId, period } = await seedSettlement(
      SettlementStatus.APPROVED,
    );
    const agentId = (
      await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } })
    ).agentId;

    const res = await settlementService.generate({ period, agentId, overwrite: true }, admin);
    const row = res.generated.find((g) => g.settlementId === settlementId);
    expect(row?.action).toBe('skipped'); // 事务外的终态跳过分支

    const finalS = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    const rec = await prisma.commissionRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(finalS.status).toBe(SettlementStatus.APPROVED); // 未被打回 DRAFT
    expect(rec.settlementId).toBe(settlementId); // 未被解绑
  });
});
