/**
 * 结算单状态流转 · 并发 CAS 短路 · 单元测试（vitest，mock prisma，不碰 DB）
 *
 * 关注点（钱洞回归守卫）：转 PAID / VOIDED 的事务内，先对 Settlement 做原子 CAS
 *   （updateMany where:{id,status:期望值}）。当 CAS 落空（count=0，代表并发的第二个请求
 *   基于同一份「事务外读到的 APPROVED」快照进来，但第一个已推进）时：
 *     - 必须抛 ConflictError；
 *     - 绝不再扣余额、绝不再写 OFFSET 流水、绝不再翻 records —— 一笔钱只入账/扣账一次。
 *
 * 真实 DB 层的行锁串行化（第二个 UPDATE 阻塞→重判→count=0）由并发集成测试覆盖，
 * 这里用 mock 把「CAS 落空」这一分支钉死为确定性用例。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// settlements.service 顶层 import prisma —— 先 mock 掉（本测试只验 CAS 分支，不连 DB）
vi.mock('../../db/prisma.js', () => ({
  prisma: {
    settlement: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { Prisma, SettlementStatus, UserRole } from '@prisma/client';
import { ConflictError } from '../../lib/errors.js';
import { prisma } from '../../db/prisma.js';
import { SettlementService } from './settlements.service.js';

const ADMIN = { userId: 'u-admin', role: UserRole.ADMIN };

// 事务内可能被触碰的所有副作用方法都挂 spy —— 用来断言「CAS 落空时它们一次都没被调」
function makeTxMock(casCount: number) {
  return {
    settlement: {
      updateMany: vi.fn().mockResolvedValue({ count: casCount }),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
    },
    commissionRecord: { updateMany: vi.fn() },
    agent: { update: vi.fn() },
    prepaymentTransaction: { create: vi.fn() },
    $queryRaw: vi.fn(),
  };
}

function approvedSettlementRow() {
  return {
    id: 's-1',
    status: SettlementStatus.APPROVED,
    agentId: 'a-1',
    period: '2026-07',
    prepaymentOffset: new Prisma.Decimal(50),
    notes: null,
    approvedAt: new Date('2026-07-01T00:00:00Z'),
    paidAt: null,
  };
}

const mockedPrisma = prisma as unknown as {
  settlement: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

describe('SettlementService.updateStatus · 并发 CAS 落空必须整体回滚、不动钱', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('APPROVED→PAID：第二个请求 CAS count=0 → 抛 Conflict，且不扣余额/不写 OFFSET/不翻 records', async () => {
    const service = new SettlementService();
    mockedPrisma.settlement.findUnique.mockResolvedValue(approvedSettlementRow());

    const tx = makeTxMock(0); // 模拟并发第二个：CAS 落空
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    await expect(
      service.updateStatus('s-1', SettlementStatus.PAID, ADMIN),
    ).rejects.toBeInstanceOf(ConflictError);

    // CAS 先于所有副作用：一次 CAS 尝试，随后立即抛错
    expect(tx.settlement.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.settlement.updateMany).toHaveBeenCalledWith({
      where: { id: 's-1', status: SettlementStatus.APPROVED },
      data: expect.objectContaining({ status: SettlementStatus.PAID }),
    });
    // 钱与账一动未动
    expect(tx.commissionRecord.updateMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.agent.update).not.toHaveBeenCalled();
    expect(tx.prepaymentTransaction.create).not.toHaveBeenCalled();
    expect(tx.settlement.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('APPROVED→VOIDED：CAS count=0 → 抛 Conflict，且不翻 records', async () => {
    const service = new SettlementService();
    mockedPrisma.settlement.findUnique.mockResolvedValue(approvedSettlementRow());

    const tx = makeTxMock(0);
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    await expect(
      service.updateStatus('s-1', SettlementStatus.VOIDED, ADMIN),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(tx.settlement.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.commissionRecord.updateMany).not.toHaveBeenCalled();
  });

  it('CAS 命中（count=1）时不抛 Conflict —— 正常流转继续走下去（PAID 分支扣一次余额）', async () => {
    const service = new SettlementService();
    mockedPrisma.settlement.findUnique.mockResolvedValue(approvedSettlementRow());

    const tx = makeTxMock(1); // CAS 命中
    tx.commissionRecord.updateMany.mockResolvedValue({ count: 1 });
    // Agent FOR UPDATE 读到足额余额（100 ≥ offset 50）
    tx.$queryRaw.mockResolvedValue([{ prepaymentBalance: new Prisma.Decimal(100) }]);
    tx.agent.update.mockResolvedValue({});
    tx.prepaymentTransaction.create.mockResolvedValue({});
    tx.settlement.findUniqueOrThrow.mockResolvedValue(serializableSettlement());
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    await expect(
      service.updateStatus('s-1', SettlementStatus.PAID, ADMIN),
    ).resolves.toBeTruthy();

    // 恰好一次扣减 + 恰好一条 OFFSET 流水（金额 = -offset）
    expect(tx.agent.update).toHaveBeenCalledTimes(1);
    expect(tx.prepaymentTransaction.create).toHaveBeenCalledTimes(1);
    const offsetArg = tx.prepaymentTransaction.create.mock.calls[0][0].data;
    expect(Number(offsetArg.amount)).toBe(-50);
    expect(Number(offsetArg.balanceAfter)).toBe(50); // 100 - 50，只扣一次
  });
});

describe('SettlementService.generate · overwrite 重算的 status CAS 防打回终态单（R9）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('overwrite 时该单已被并发推进到 APPROVED/PAID → CAS count=0 → 抛 Conflict，不解绑 records、不新建', async () => {
    const service = new SettlementService();
    // 事务外读到的快照是 DRAFT（可重算），故会进入 overwrite 分支
    mockedPrisma.settlement.findUnique.mockResolvedValue({
      id: 's-1',
      status: SettlementStatus.DRAFT,
      agentId: 'a-1',
      period: '2026-07',
    });
    // computeSettlement 读多张表 —— 直接 spy 掉，返回最小计算结果（不连 DB）
    vi.spyOn(
      service as unknown as { computeSettlement: (...a: unknown[]) => Promise<unknown> },
      'computeSettlement',
    ).mockResolvedValue({
      orderCount: 0,
      grossRevenue: 0,
      commissionEarned: 0,
      commissionPaidToChildren: 0,
      netCommission: 0,
      prepaymentOffset: 0,
      payableToAgent: 0,
      reversalCount: 0,
      reversalAmount: 0,
      recordIds: [],
    });

    const tx = makeTxMock(0); // 事务内 CAS 落空：并发已把单推到 APPROVED/PAID
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    await expect(
      service.generate({ period: '2026-07', agentId: 'a-1', overwrite: true }, ADMIN),
    ).rejects.toBeInstanceOf(ConflictError);

    // CAS 先于解绑：一次 CAS 尝试后立即抛错，绝不解绑 records、绝不新建
    expect(tx.settlement.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.settlement.updateMany).toHaveBeenCalledWith({
      where: {
        id: 's-1',
        status: { notIn: [SettlementStatus.APPROVED, SettlementStatus.PAID] },
      },
      data: expect.objectContaining({ status: SettlementStatus.DRAFT }),
    });
    expect(tx.commissionRecord.updateMany).not.toHaveBeenCalled();
    expect(tx.settlement.create).not.toHaveBeenCalled();
  });
});

// serializeSettlement 需要的最小合法形状（PAID 成功用例的返回值会被序列化）
function serializableSettlement() {
  return {
    id: 's-1',
    period: '2026-07',
    agentId: 'a-1',
    orderCount: 1,
    grossRevenue: new Prisma.Decimal(1000),
    commissionEarned: new Prisma.Decimal(50),
    commissionPaidToChildren: new Prisma.Decimal(0),
    netCommission: new Prisma.Decimal(50),
    prepaymentOffset: new Prisma.Decimal(50),
    payableToAgent: new Prisma.Decimal(0),
    status: SettlementStatus.PAID,
    generatedAt: new Date('2026-07-01T00:00:00Z'),
    approvedAt: new Date('2026-07-01T00:00:00Z'),
    paidAt: new Date('2026-07-02T00:00:00Z'),
    notes: null,
    agent: {
      id: 'a-1',
      companyName: '测试公司',
      contactName: '测试代理',
      tier: 1,
      user: { displayName: '测试', email: 'agent@test.com' },
    },
    commissions: [],
  };
}
