/**
 * 结算单状态流转 · 并发 CAS 短路 · 单元测试（vitest，mock prisma，不碰 DB）
 *
 * 关注点（钱洞回归守卫）：转 PAID / VOIDED 的事务内，先对 Settlement 做原子 CAS
 *   （updateMany where:{id,status:期望值}）。当 CAS 落空（count=0，代表并发的第二个请求
 *   基于同一份「事务外读到的 APPROVED」快照进来，但第一个已推进）时：
 *     - 必须抛 ConflictError；
 *     - 绝不再翻 records —— 一笔钱只入账一次。
 *
 * 预付余额抵扣已停用（H1 修复）：PAID 分支不再读/扣 Agent.prepaymentBalance、不再写
 * PrepaymentTransaction(OFFSET)，即便结算单上的 prepaymentOffset 是历史遗留的非零值
 * （见下方 approvedSettlementRow 里刻意保留的 Decimal(50)，用来验证它被安全忽略）。
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

import { CommissionStatus, Prisma, SettlementStatus, UserRole } from '@prisma/client';
import { ConflictError } from '../../lib/errors.js';
import { prisma } from '../../db/prisma.js';
import { SettlementService } from './settlements.service.js';

const ADMIN = { userId: 'u-admin', role: UserRole.ADMIN };

// 事务内可能被触碰的所有副作用方法都挂 spy —— 用来断言「CAS 落空时它们一次都没被调」
// commissionRecord.aggregate：P0 复检用的"仍为 ACCRUED 的总额"查询，默认回填与
// approvedSettlementRow() 的 commissionEarned 一致（=50），代表"没有被外部冲销、可正常放行"。
function makeTxMock(casCount: number) {
  return {
    settlement: {
      updateMany: vi.fn().mockResolvedValue({ count: casCount }),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
    },
    commissionRecord: {
      updateMany: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(50) } }),
    },
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
    commissionEarned: new Prisma.Decimal(50),
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

  it('CAS 命中（count=1）时不抛 Conflict —— 正常流转继续走下去（PAID 分支不再碰预存款余额）', async () => {
    const service = new SettlementService();
    // 结算单上的 prepaymentOffset=50 是历史遗留值（H1 修复前生成）；PAID 分支必须安全忽略它。
    mockedPrisma.settlement.findUnique.mockResolvedValue(approvedSettlementRow());

    const tx = makeTxMock(1); // CAS 命中
    tx.commissionRecord.updateMany.mockResolvedValue({ count: 1 });
    tx.settlement.findUniqueOrThrow.mockResolvedValue(serializableSettlement());
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    await expect(
      service.updateStatus('s-1', SettlementStatus.PAID, ADMIN),
    ).resolves.toBeTruthy();

    // records 翻 SETTLED 照常发生
    expect(tx.commissionRecord.updateMany).toHaveBeenCalledTimes(1);
    // 预付余额抵扣已停用：绝不读余额、绝不扣余额、绝不写 OFFSET 流水
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.agent.update).not.toHaveBeenCalled();
    expect(tx.prepaymentTransaction.create).not.toHaveBeenCalled();
  });
});

describe('SettlementService.updateStatus · P0 转 PAID 前复检退款冲销（绑定记录已被外部翻 REVERSED）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('绑定记录里仍为 ACCRUED 的总额 < 生成时存的 commissionEarned → 400 拒付，且不翻 SETTLED', async () => {
    const service = new SettlementService();
    mockedPrisma.settlement.findUnique.mockResolvedValue(approvedSettlementRow()); // commissionEarned=50

    const tx = makeTxMock(1); // CAS 命中
    // 本单绑定记录里"仍为 ACCRUED"的总额只剩 0：说明原本计入 50 的那条已经被外部
    // （orders.service 的退款/取消流程）翻成了 REVERSED，但 settlementId 没被清空。
    tx.commissionRecord.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    await expect(
      service.updateStatus('s-1', SettlementStatus.PAID, ADMIN),
    ).rejects.toMatchObject({ message: expect.stringContaining('已冲销佣金') });

    // 复检先于翻 SETTLED：一旦拒付，绝不再碰 records
    expect(tx.commissionRecord.aggregate).toHaveBeenCalledWith({
      where: { settlementId: 's-1', status: CommissionStatus.ACCRUED },
      _sum: { amount: true },
    });
    expect(tx.commissionRecord.updateMany).not.toHaveBeenCalled();
  });

  it('绑定记录里仍为 ACCRUED 的总额 = commissionEarned（未被冲销）→ 正常放行，翻 SETTLED', async () => {
    const service = new SettlementService();
    mockedPrisma.settlement.findUnique.mockResolvedValue(approvedSettlementRow()); // commissionEarned=50

    const tx = makeTxMock(1);
    tx.commissionRecord.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(50) } });
    tx.commissionRecord.updateMany.mockResolvedValue({ count: 1 });
    tx.settlement.findUniqueOrThrow.mockResolvedValue(serializableSettlement());
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    await expect(
      service.updateStatus('s-1', SettlementStatus.PAID, ADMIN),
    ).resolves.toBeTruthy();

    expect(tx.commissionRecord.updateMany).toHaveBeenCalledWith({
      where: { settlementId: 's-1', status: CommissionStatus.ACCRUED },
      data: { status: CommissionStatus.SETTLED, settledAt: expect.any(Date) },
    });
  });

  it('负数补偿记录合法绑定（未曾计入 commissionEarned）不触发拒付——不是"只要绑了 REVERSED 就拒绝"', async () => {
    // 场景：本单 commissionEarned=50 全部来自仍是 ACCRUED 的记录；另有一条负数补偿记录
    // （从生成那一刻起就是 REVERSED，从未计入 commissionEarned）也绑在本单上——
    // 仍为 ACCRUED 的总额（50）与 commissionEarned（50）相等，不应被当成"过期"拦下。
    const service = new SettlementService();
    mockedPrisma.settlement.findUnique.mockResolvedValue(approvedSettlementRow());

    const tx = makeTxMock(1);
    tx.commissionRecord.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(50) } });
    tx.commissionRecord.updateMany.mockResolvedValue({ count: 1 });
    tx.settlement.findUniqueOrThrow.mockResolvedValue(serializableSettlement());
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    await expect(
      service.updateStatus('s-1', SettlementStatus.PAID, ADMIN),
    ).resolves.toBeTruthy();
  });
});

describe('SettlementService.updateStatus · VOIDED 解绑范围覆盖 ACCRUED 与 REVERSED（此前只解绑 ACCRUED）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('VOIDED 时 commissionRecord.updateMany 的 where 必须同时命中 ACCRUED 与 REVERSED', async () => {
    const service = new SettlementService();
    mockedPrisma.settlement.findUnique.mockResolvedValue(approvedSettlementRow());

    const tx = makeTxMock(1);
    tx.commissionRecord.updateMany.mockResolvedValue({ count: 2 });
    tx.settlement.findUniqueOrThrow.mockResolvedValue(serializableSettlement());
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    await service.updateStatus('s-1', SettlementStatus.VOIDED, ADMIN);

    expect(tx.commissionRecord.updateMany).toHaveBeenCalledWith({
      where: {
        settlementId: 's-1',
        status: { in: [CommissionStatus.ACCRUED, CommissionStatus.REVERSED] },
      },
      data: { settlementId: null, settledAt: null },
    });
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
