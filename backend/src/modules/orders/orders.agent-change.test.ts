/**
 * 更改订单归属代理（T5）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. changeOrderAgentBodySchema：空串归一为 null（直客）；合法 id / null 通过。
 *   2. changeOrderAgent 权限：非 ADMIN/STAFF（CUSTOMER/AGENT）→ ForbiddenError（未触库）。
 *   3. changeOrderAgent 守卫：订单不存在 / 归属未变化 / 目标代理不存在 / 目标代理已停用。
 *
 * 「改归属成功 + warning（曾用余额抵扣）+ 审计 before/after」需真 DB 全链路 ——
 * 见 orders.agent-change.integration.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    agent: { findUnique: vi.fn() },
    prepaymentTransaction: { findFirst: vi.fn() },
    // 价格纠缠拆解走事务：锁单 → 读行 → 撤立减 → 重算 subtotal/total。
    orderItem: { findMany: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
    commissionRecord: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { Prisma } from '@prisma/client';

import { OrderService } from './orders.service.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { changeOrderAgentBodySchema } from './orders.schemas.js';

const service = new OrderService();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('changeOrderAgentBodySchema', () => {
  it('空串归一为 null（前端「直客」选项）', () => {
    const parsed = changeOrderAgentBodySchema.parse({ agentId: '' });
    expect(parsed.agentId).toBeNull();
  });

  it('null（转直客）通过', () => {
    expect(changeOrderAgentBodySchema.safeParse({ agentId: null }).success).toBe(true);
  });

  it('合法代理 id + reason 通过', () => {
    const parsed = changeOrderAgentBodySchema.parse({ agentId: 'agent-1', reason: '归属订正' });
    expect(parsed.agentId).toBe('agent-1');
    expect(parsed.reason).toBe('归属订正');
  });
});

describe('OrderService.changeOrderAgent · 权限（服务端按认证身份判）', () => {
  it.each(['CUSTOMER', 'AGENT'] as const)('%s 调用 → ForbiddenError，且未触库', async (role) => {
    await expect(
      service.changeOrderAgent('o1', { agentId: 'a1' }, { userId: 'u1', role }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });
});

describe('OrderService.changeOrderAgent · 守卫', () => {
  const actor = { userId: 'admin', role: 'ADMIN' as const };

  it('订单不存在 → NotFoundError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await expect(
      service.changeOrderAgent('missing', { agentId: 'a1' }, actor),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('归属未变化（同代理）→ BadRequestError，不更新', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1', agentId: 'a1' });
    await expect(
      service.changeOrderAgent('o1', { agentId: 'a1' }, actor),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('本为直客又转直客（null→null）→ BadRequestError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1', agentId: null });
    await expect(
      service.changeOrderAgent('o1', { agentId: null }, actor),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('目标代理不存在 → NotFoundError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1', agentId: null });
    mockPrisma.agent.findUnique.mockResolvedValue(null);
    await expect(
      service.changeOrderAgent('o1', { agentId: 'ghost' }, actor),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('目标代理已停用 → BadRequestError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1', agentId: null });
    mockPrisma.agent.findUnique.mockResolvedValue({
      id: 'a2',
      isActive: false,
      companyName: '某代理',
      contactName: '联系人',
    });
    await expect(
      service.changeOrderAgent('o1', { agentId: 'a2' }, actor),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 改归属的价格纠缠拆解
// 旧口径只改 agentId：原代理 A 的立减行、按 A 谈定的结算价原样留给 B，而佣金之后按 B 的
// 费率计提 —— 一单同时挂两家代理的价格口径。现在撤 A 的立减并重算应收，结算价只点名不动。
// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.changeOrderAgent · 价格纠缠拆解', () => {
  const actor = { userId: 'admin', role: 'ADMIN' as const };

  /** 规则命中的立减行（有 ruleId 快照）。*/
  const discountRow = (id: string, amountCny: number) => ({
    id,
    kind: 'DISCOUNT',
    description: `同业立减 ¥${amountCny}/人 × 1人`,
    amount: new Prisma.Decimal(-amountCny),
    metadata: { settlementDiscount: true, ruleId: 'rule-a', bundleId: 'bundle-a' },
  });

  /** 人工谈定的结算价差额行（不自动动，只点名）。*/
  const settlementRow = (id: string, amountCny: number) => ({
    id,
    kind: amountCny > 0 ? 'FEE' : 'DISCOUNT',
    description: '价格调整：代理结算价',
    amount: new Prisma.Decimal(amountCny),
    metadata: { settlementPrice: true, reasonCode: 'SETTLEMENT' },
  });

  type MountOptions = {
    items?: Array<Record<string, unknown>>;
    /** 撤销后重新聚合出来的 Σ items（模拟库里的新合计）。*/
    aggregateAfterCny?: number;
    paidAmountCny?: number;
    settlementLocked?: boolean;
    accruedCommissionCny?: number | null;
    status?: string;
  };

  function mount(opts: MountOptions = {}): void {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      orderNumber: 'ORD-1',
      agentId: 'a1',
      status: opts.status ?? 'PENDING_PAYMENT',
      deletedAt: null,
    });
    mockPrisma.agent.findUnique.mockResolvedValue({
      id: 'a2',
      isActive: true,
      companyName: '新代理',
      contactName: '联系人',
    });
    mockPrisma.prepaymentTransaction.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
    );
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'o1',
        subtotal: new Prisma.Decimal(1000),
        total: new Prisma.Decimal(1000),
        paidAmount: new Prisma.Decimal(opts.paidAmountCny ?? 0),
        settlementLocked: opts.settlementLocked ?? false,
      },
    ]);
    mockPrisma.orderItem.findMany.mockResolvedValue(opts.items ?? []);
    mockPrisma.orderItem.update.mockResolvedValue({});
    mockPrisma.orderItem.aggregate.mockResolvedValue({
      _sum: { amount: new Prisma.Decimal(opts.aggregateAfterCny ?? 1000) },
    });
    mockPrisma.commissionRecord.findMany.mockResolvedValue(
      opts.accruedCommissionCny == null
        ? []
        : [{ amount: new Prisma.Decimal(opts.accruedCommissionCny) }],
    );
    mockPrisma.auditLog.create.mockResolvedValue({});
    mockPrisma.order.update.mockResolvedValue({});
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'o1',
      orderNumber: 'ORD-1',
      status: 'PENDING_PAYMENT',
      subtotal: new Prisma.Decimal(1000),
      taxesAndFees: new Prisma.Decimal(0),
      discountTotal: new Prisma.Decimal(0),
      total: new Prisma.Decimal(1000),
      paidAmount: new Prisma.Decimal(opts.paidAmountCny ?? 0),
      prepaymentOffset: new Prisma.Decimal(0),
      adjustmentCny: 0,
      items: [],
      passengers: [],
    });
  }

  it('存在原代理立减行 → 撤销该行并重算 subtotal/total，warning 报出被撤金额与重新核价', async () => {
    mount({ items: [discountRow('item-d1', 100)], aggregateAfterCny: 1100 });

    const res = await service.changeOrderAgent('o1', { agentId: 'a2' }, actor);

    // 行被撤销（金额归零 + 打标），不是删行 —— 这条立减发生过，留着可查。
    const updateArgs = mockPrisma.orderItem.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'item-d1' });
    expect(Number(updateArgs.data.amount.toString())).toBe(0);
    expect(updateArgs.data.metadata).toMatchObject({
      settlementDiscountRevoked: true,
      revokedReason: 'AGENT_CHANGED',
      revokedAmountCny: 100,
    });
    expect(String(updateArgs.data.description)).toContain('已撤销');

    // 应收按重算结果写回，同一次 update 里把归属也改掉。
    const orderUpdate = mockPrisma.order.update.mock.calls[0][0];
    expect(orderUpdate.data.agentId).toBe('a2');
    expect(Number(orderUpdate.data.total.toString())).toBe(1100);

    expect(res.warning).toContain('已撤销原代理口径的立减 1 条');
    expect(res.warning).toContain('¥100');
    expect(res.warning).toContain('重新核价');
  });

  it('撤立减留一条 WARNING 审计（应收被系统改动过，要翻得出来）', async () => {
    mount({ items: [discountRow('item-d1', 100)], aggregateAfterCny: 1100 });

    await service.changeOrderAgent('o1', { agentId: 'a2' }, actor);

    const audit = mockPrisma.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.action === 'AGENT_CHANGED_DISCOUNT_REVOKED');
    expect(audit).toBeDefined();
    expect(audit!.severity).toBe('WARNING');
    expect(audit!.after).toMatchObject({ revokedCny: 100, agentId: 'a2' });
  });

  it('没有立减行 → 只改归属，不写 subtotal/total（金额没变就别平白改账）', async () => {
    mount({ items: [] });

    const res = await service.changeOrderAgent('o1', { agentId: 'a2' }, actor);

    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.orderItem.aggregate).not.toHaveBeenCalled();
    expect(mockPrisma.order.update.mock.calls[0][0].data).toEqual({ agentId: 'a2' });
    expect(res.warning).toBeNull();
  });

  it('手工 DISCOUNT 调价行（无 ruleId）不撤 —— 那是运营自己填的，不随代理走', async () => {
    mount({
      items: [
        {
          id: 'item-manual',
          kind: 'DISCOUNT',
          description: '价格调整：手工优惠',
          amount: new Prisma.Decimal(-50),
          metadata: { priceAdjustment: true, reasonCode: 'DISCOUNT' },
        },
      ],
    });

    const res = await service.changeOrderAgent('o1', { agentId: 'a2' }, actor);

    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
    expect(res.warning).toBeNull();
  });

  it('已撤销过的立减行不重复撤（行级幂等）', async () => {
    mount({
      items: [
        {
          ...discountRow('item-d1', 100),
          amount: new Prisma.Decimal(0),
          metadata: {
            settlementDiscount: true,
            ruleId: 'rule-a',
            settlementDiscountRevoked: true,
          },
        },
      ],
    });

    const res = await service.changeOrderAgent('o1', { agentId: 'a2' }, actor);

    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
    expect(res.warning).toBeNull();
  });

  it('存在结算价差额行 → 不自动改动，只在 warning 里点名请运营确认', async () => {
    mount({ items: [settlementRow('item-s1', -600)] });

    const res = await service.changeOrderAgent('o1', { agentId: 'a2' }, actor);

    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
    expect(res.warning).toContain('结算价差额行');
    expect(res.warning).toContain('未自动改动');
  });

  it('结算价已锁定 + 有立减行要撤 → ConflictError（撤立减会改应收，锁的语义在此成立）', async () => {
    mount({ items: [discountRow('item-d1', 100)], settlementLocked: true });

    await expect(
      service.changeOrderAgent('o1', { agentId: 'a2' }, actor),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
  });

  it('结算价已锁定但没有立减行 → 金额不变，照常改归属（不给日常操作平添拒绝）', async () => {
    mount({ items: [], settlementLocked: true });

    await expect(
      service.changeOrderAgent('o1', { agentId: 'a2' }, actor),
    ).resolves.toBeDefined();
  });

  it('撤立减后已收 > 新应收 → warning 指向既有多付处置（转余额/挂账/退款）', async () => {
    // 已收 1200；撤掉 ¥100 立减后应收回到 1100 → 多付 ¥100。
    mount({
      items: [discountRow('item-d1', 100)],
      aggregateAfterCny: 1100,
      paidAmountCny: 1200,
    });

    const res = await service.changeOrderAgent('o1', { agentId: 'a2' }, actor);

    expect(res.warning).toContain('多付 ¥100');
    expect(res.warning).toContain('多付处置');
  });

  it('已计提佣金 → warning 说明不回溯重算，请财务确认', async () => {
    mount({ items: [], accruedCommissionCny: 88 });

    const res = await service.changeOrderAgent('o1', { agentId: 'a2' }, actor);

    expect(res.warning).toContain('已计提佣金 ¥88');
    expect(res.warning).toContain('不回溯重算');
  });

  it('取消族订单 → 不动金额（撤立减会改应退额基数），仍改归属并在 warning 点名未撤的立减', async () => {
    mount({ items: [discountRow('item-d1', 100)], status: 'CANCELLED' });

    const res = await service.changeOrderAgent('o1', { agentId: 'a2' }, actor);

    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.order.update.mock.calls[0][0].data).toEqual({ agentId: 'a2' });
    expect(res.warning).toContain('不允许改动金额');
    expect(res.warning).toContain('¥100');
  });

  it('资金纠缠闸不变：曾用原代理预存余额抵扣 → 硬阻断，一行都不动', async () => {
    mount({ items: [discountRow('item-d1', 100)] });
    mockPrisma.prepaymentTransaction.findFirst.mockResolvedValue({ id: 'offset-1' });

    await expect(
      service.changeOrderAgent('o1', { agentId: 'a2' }, actor),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
