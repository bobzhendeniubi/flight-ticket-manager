/**
 * 结算单生成 · 单元测试（vitest，mock prisma，不碰 DB）
 *
 * 两条不变量：
 *   1. 营收栏与佣金栏取同一批订单 —— 本期计佣的那批直销单（CommissionRecord 在订单转 PAID
 *      那一刻创建），不再按 Order.createdAt 圈月：否则 7 月下单 8 月才付的单会营收进 7 月、
 *      佣金进 8 月，同一张月结单两栏对不上。
 *   2. 批量生成时单个代理撞唯一键（period_agentId）只跳过这一条，后面的代理照常生成 ——
 *      别让一次重复点击把整批掐断。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/prisma.js', () => ({
  prisma: {
    settlement: { findUnique: vi.fn(), findMany: vi.fn() },
    commissionRecord: { findMany: vi.fn() },
    order: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('../../lib/agent-tree.js', () => ({ getDescendantAgentIds: vi.fn() }));

import { CommissionStatus, Prisma, SettlementStatus, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import { SettlementService } from './settlements.service.js';

const ADMIN = { userId: 'u-admin', role: UserRole.ADMIN };

const mockedPrisma = prisma as unknown as {
  settlement: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  commissionRecord: { findMany: ReturnType<typeof vi.fn> };
  order: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

/** 事务替身：create 落一张新单，updateMany 一律成功。 */
function makeTx(createImpl?: ReturnType<typeof vi.fn>) {
  return {
    settlement: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn(),
      create:
        createImpl ??
        vi.fn().mockImplementation(async ({ data }: { data: { agentId: string } }) => ({
          id: `s-${data.agentId}`,
          status: SettlementStatus.DRAFT,
        })),
    },
    commissionRecord: { updateMany: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getDescendantAgentIds as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  mockedPrisma.settlement.findUnique.mockResolvedValue(null);
  mockedPrisma.settlement.findMany.mockResolvedValue([]);
  mockedPrisma.order.findMany.mockResolvedValue([]);
});

describe('generate() · 营收栏与佣金栏取同一批订单', () => {
  it('营收按「本期计佣的直销单」汇总，不按下单月圈 —— 跨月付款的单两栏落同一张月结单', async () => {
    const service = new SettlementService();
    // 本期（2026-08）计佣的两笔记录：其中 order-july 是 7 月下单、8 月才转 PAID 的单。
    mockedPrisma.commissionRecord.findMany.mockImplementation(
      async ({ where }: { where: { status: CommissionStatus } }) =>
        where.status === CommissionStatus.ACCRUED
          ? [
              { id: 'cr-1', amount: new Prisma.Decimal(100), orderId: 'order-july' },
              { id: 'cr-2', amount: new Prisma.Decimal(50), orderId: 'order-aug' },
            ]
          : [],
    );
    mockedPrisma.order.findMany.mockResolvedValue([
      { id: 'order-july', total: new Prisma.Decimal(8000) },
      { id: 'order-aug', total: new Prisma.Decimal(2000) },
    ]);
    const tx = makeTx();
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    await service.generate({ period: '2026-08', agentId: 'a-1' } as never, ADMIN);

    // 订单是按「本期计佣记录的 orderId」捞的，不再带 createdAt 区间。
    const orderWhere = mockedPrisma.order.findMany.mock.calls[0][0].where;
    expect(orderWhere.id).toEqual({ in: ['order-july', 'order-aug'] });
    expect(orderWhere.agentId).toBe('a-1');
    expect(orderWhere.createdAt).toBeUndefined();

    // 营收 = 8000 + 2000，与佣金 150 出自同一批单。
    const created = tx.settlement.create.mock.calls[0][0].data;
    expect(Number(created.grossRevenue.toString())).toBe(10000);
    expect(created.orderCount).toBe(2);
    expect(Number(created.commissionEarned.toString())).toBe(150);
  });

  it('本期一条计佣记录都没有 → 营收 0，且不去捞订单（没有可对账的单）', async () => {
    const service = new SettlementService();
    mockedPrisma.commissionRecord.findMany.mockResolvedValue([]);
    const tx = makeTx();
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    await service.generate({ period: '2026-08', agentId: 'a-1' } as never, ADMIN);

    expect(mockedPrisma.order.findMany).not.toHaveBeenCalled();
    const created = tx.settlement.create.mock.calls[0][0].data;
    expect(Number(created.grossRevenue.toString())).toBe(0);
    expect(created.orderCount).toBe(0);
  });
});

describe('generate() · 批量生成撞唯一键只跳过这一条', () => {
  it('第一个代理被并发抢先建了当期单（P2002）→ 标 skipped-concurrent，后面的代理照常生成', async () => {
    const service = new SettlementService();
    // 第一次 findMany = 候选代理（当期有 ACCRUED 记录的），之后是逐个代理的计佣/冲销查询。
    mockedPrisma.commissionRecord.findMany
      .mockImplementationOnce(async () => [{ agentId: 'a-1' }, { agentId: 'a-2' }])
      .mockImplementation(
        async ({ where }: { where: { status: CommissionStatus; agentId?: string } }) =>
          where.status === CommissionStatus.ACCRUED
            ? [{ id: `cr-${where.agentId}`, amount: new Prisma.Decimal(30), orderId: 'order-1' }]
            : [],
      );
    mockedPrisma.order.findMany.mockResolvedValue([
      { id: 'order-1', total: new Prisma.Decimal(1000) },
    ]);
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const create = vi
      .fn()
      .mockRejectedValueOnce(p2002)
      .mockResolvedValue({ id: 's-a-2', status: SettlementStatus.DRAFT });
    const tx = makeTx(create);
    mockedPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
    mockedPrisma.settlement.findUnique
      .mockResolvedValueOnce(null) // a-1 幂等查：当期还没有
      .mockResolvedValueOnce({ id: 's-winner', status: SettlementStatus.DRAFT }) // 撞唯一键后回读
      .mockResolvedValueOnce(null); // a-2 幂等查

    const result = await service.generate({ period: '2026-08' } as never, ADMIN);

    expect(result.generated).toEqual([
      {
        agentId: 'a-1',
        settlementId: 's-winner',
        status: SettlementStatus.DRAFT,
        action: 'skipped-concurrent',
      },
      { agentId: 'a-2', settlementId: 's-a-2', status: SettlementStatus.DRAFT, action: 'created' },
    ]);
  });
});
