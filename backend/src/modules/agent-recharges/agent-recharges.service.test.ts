/**
 * AgentRechargesService · 服务级测试（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖 3 条最关键的不变量：
 *   1. confirm() 幂等：非 PENDING 的申请二次确认 → ConflictError（409），不重复加余额
 *   2. manualAdjust() 不许赊账：负向调整超过当前余额 → BadRequestError，余额不写
 *   3. list() 可见范围过滤：AGENT 只能看自己 + 后代代理的申请，越权查询别的 agentId → ForbiddenError
 *
 * 不覆盖（超出本次范围，真实事务行为交给 e2e 对 :4000 验证）：
 *   - 完整 confirm() happy path 的行锁并发语义 —— 需要真 DB 才能验证 FOR UPDATE 实际生效
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRechargeStatus, PrepaymentTxType, UserRole } from '@prisma/client';

// ── 在 import AgentRechargesService 之前 mock 依赖 ──
const { mockPrisma, mockGetDescendantAgentIds } = vi.hoisted(() => ({
  mockPrisma: {
    agent: {
      findUnique: vi.fn(),
    },
    agentRechargeRequest: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    paymentChannel: {
      findMany: vi.fn(),
    },
    // $transaction 有两种调用形态：
    //   1. 数组形态（list()）：prisma.$transaction([p1, p2]) → Promise.all 语义
    //   2. 回调形态（confirm/reject/manualAdjust）：prisma.$transaction(async (tx) => {...})
    // mock 实现同时兼容两种，回调形态里传入的 tx 就是 mockPrisma 本身（同一批 vi.fn()）。
    $transaction: vi.fn(),
  },
  mockGetDescendantAgentIds: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../lib/agent-tree.js', () => ({
  getDescendantAgentIds: mockGetDescendantAgentIds,
}));

import { AgentRechargesService } from './agent-recharges.service.js';

const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN };
const AGENT_ACTOR = (userId: string) => ({ userId, role: UserRole.AGENT });

function decimal(n: number) {
  return { toString: () => String(n), toNumber: () => n } as unknown as { toString(): string };
}

describe('AgentRechargesService', () => {
  const service = new AgentRechargesService();

  beforeEach(() => {
    vi.clearAllMocks();
    // 回调形态：直接把 mockPrisma 当 tx 传给回调（tx.$queryRaw / tx.agent.update 等都还是同一批 vi.fn()）
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma);
      }
      // 数组形态：并行 resolve（模拟 Promise.all）
      return Promise.all(arg as Promise<unknown>[]);
    });
    // confirm/reject 用到的 tx.$queryRaw / tx.agent.update / tx.prepaymentTransaction.create /
    // tx.agentRechargeRequest.update 都要挂在 mockPrisma 上（因为 tx === mockPrisma in tests）
    (mockPrisma as Record<string, unknown>).$queryRaw = vi.fn();
    (mockPrisma as Record<string, unknown>).agent = {
      ...mockPrisma.agent,
      update: vi.fn(),
    };
    (mockPrisma as Record<string, unknown>).prepaymentTransaction = { create: vi.fn() };
    (mockPrisma as Record<string, unknown>).agentRechargeRequest = {
      ...mockPrisma.agentRechargeRequest,
      update: vi.fn(),
    };
  });

  // ══════════════════════════════════════════════════════════════════════
  describe('confirm() · 幂等 + 不许赊账', () => {
    it('非 PENDING 的申请二次确认 → ConflictError，不加余额', async () => {
      // 行锁读到的申请已经是 CONFIRMED（第一次确认已经跑过）
      (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { id: 'req-1', agentId: 'agent-1', amountCny: decimal(500), status: AgentRechargeStatus.CONFIRMED },
      ]);

      await expect(service.confirm(ADMIN, 'req-1', {})).rejects.toThrow(/不可重复确认/);

      // 断言：余额更新 / 流水创建都没被调用过（拒绝发生在读到状态之后、写之前）
      expect((mockPrisma.agent as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
      expect(
        (mockPrisma.prepaymentTransaction as { create: ReturnType<typeof vi.fn> }).create,
      ).not.toHaveBeenCalled();
    });

    it('非 ADMIN/STAFF 调用 → ForbiddenError，事务都不开', async () => {
      await expect(service.confirm(AGENT_ACTOR('u1'), 'req-1', {})).rejects.toThrow(/仅运营\/管理员/);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('happy path：PENDING → CONFIRMED，balanceAfter = 原余额 + 到账额，写 TOP_UP 流水', async () => {
      (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          { id: 'req-1', agentId: 'agent-1', amountCny: decimal(500), status: AgentRechargeStatus.PENDING },
        ])
        .mockResolvedValueOnce([{ prepaymentBalance: decimal(1000) }]);

      (mockPrisma.prepaymentTransaction as { create: ReturnType<typeof vi.fn> }).create.mockResolvedValueOnce({
        id: 'tx-1',
      });
      (mockPrisma.agentRechargeRequest as { update: ReturnType<typeof vi.fn> }).update.mockResolvedValueOnce({
        id: 'req-1',
        agentId: 'agent-1',
        amountCny: decimal(500),
        confirmedAmountCny: decimal(500),
        proofImages: ['data:image/png;base64,x'],
        note: null,
        status: AgentRechargeStatus.CONFIRMED,
        reviewNote: null,
        submittedByUserId: 'u1',
        reviewedByUserId: 'admin-1',
        reviewedAt: new Date('2026-07-02T00:00:00Z'),
        prepaymentTxId: 'tx-1',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        updatedAt: new Date('2026-07-02T00:00:00Z'),
        agent: { id: 'agent-1', companyName: null, contactName: '测试代理' },
      });

      const result = await service.confirm(ADMIN, 'req-1', {});

      expect(result.agentBalanceAfter).toBe(1500);
      expect((mockPrisma.agent as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { prepaymentBalance: expect.objectContaining({}) },
      });
      const createCall = (mockPrisma.prepaymentTransaction as { create: ReturnType<typeof vi.fn> }).create.mock
        .calls[0][0];
      expect(createCall.data.type).toBe(PrepaymentTxType.TOP_UP);
      expect(createCall.data.agentId).toBe('agent-1');
      expect(createCall.data.createdById).toBe('admin-1');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  describe('manualAdjust() · 不许赊账（负向调整不能击穿 0）', () => {
    it('负向调整超过当前余额 → BadRequestError，不写余额/流水', async () => {
      (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { prepaymentBalance: decimal(100) },
      ]);

      await expect(
        service.manualAdjust(ADMIN, { agentId: 'agent-1', amount: -400, reason: '测试超扣' }),
      ).rejects.toThrow(/不许为负/);

      expect((mockPrisma.agent as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
      expect(
        (mockPrisma.prepaymentTransaction as { create: ReturnType<typeof vi.fn> }).create,
      ).not.toHaveBeenCalled();
    });

    it('负向调整恰好扣到 0 → 允许（边界值，不是 <0）', async () => {
      (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { prepaymentBalance: decimal(400) },
      ]);
      (mockPrisma.prepaymentTransaction as { create: ReturnType<typeof vi.fn> }).create.mockResolvedValueOnce({
        id: 'tx-2',
      });

      const result = await service.manualAdjust(ADMIN, {
        agentId: 'agent-1',
        amount: -400,
        reason: '扣到 0',
      });

      expect(result.balanceAfter).toBe(0);
      expect((mockPrisma.agent as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalled();
    });

    it('非 ADMIN/STAFF 调用 → ForbiddenError', async () => {
      await expect(
        service.manualAdjust(AGENT_ACTOR('u1'), { agentId: 'agent-1', amount: 100, reason: 'x' }),
      ).rejects.toThrow(/仅运营\/管理员/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  describe('list() · 可见范围过滤', () => {
    it('AGENT 查询范围外的 agentId → ForbiddenError', async () => {
      mockPrisma.agent.findUnique.mockResolvedValueOnce({ id: 'agent-self' });
      mockGetDescendantAgentIds.mockResolvedValueOnce(['agent-self', 'agent-child']);

      await expect(
        service.list(AGENT_ACTOR('u1'), { agentId: 'agent-other', page: 1, pageSize: 50 }),
      ).rejects.toThrow(/无权查看/);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('AGENT 不带 agentId → where.agentId 限定为自己+后代集合', async () => {
      mockPrisma.agent.findUnique.mockResolvedValueOnce({ id: 'agent-self' });
      mockGetDescendantAgentIds.mockResolvedValueOnce(['agent-self', 'agent-child']);
      mockPrisma.agentRechargeRequest.findMany.mockResolvedValueOnce([]);
      mockPrisma.agentRechargeRequest.count.mockResolvedValueOnce(0);

      await service.list(AGENT_ACTOR('u1'), { page: 1, pageSize: 50 });

      // $transaction 收到的第一个 promise 来自 findMany，校验它的 where 参数
      const findManyCallArgs = mockPrisma.agentRechargeRequest.findMany.mock.calls[0][0];
      expect(findManyCallArgs.where.agentId).toEqual({ in: ['agent-self', 'agent-child'] });
    });

    it('ADMIN 不传 agentId → 不加 agentId 过滤（看全部）', async () => {
      mockPrisma.agentRechargeRequest.findMany.mockResolvedValueOnce([]);
      mockPrisma.agentRechargeRequest.count.mockResolvedValueOnce(0);

      await service.list(ADMIN, { page: 1, pageSize: 50 });

      const findManyCallArgs = mockPrisma.agentRechargeRequest.findMany.mock.calls[0][0];
      expect(findManyCallArgs.where.agentId).toBeUndefined();
      // AGENT 专属的 descendantIds 查询不应该被 ADMIN 路径调用
      expect(mockGetDescendantAgentIds).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  describe('myChannels() · 不泄露其他代理的专属码', () => {
    it('有专属渠道 → 只返回专属渠道（不 fallback 到公司码）', async () => {
      mockPrisma.agent.findUnique.mockResolvedValueOnce({ id: 'agent-1' });
      mockPrisma.paymentChannel.findMany.mockResolvedValueOnce([{ id: 'ch-1', agentId: 'agent-1' }]);

      const result = await service.myChannels(AGENT_ACTOR('u1'));

      expect(result.source).toBe('DEDICATED');
      expect(result.channels).toHaveLength(1);
      // 第二次 findMany（公司码）不应该被调用，因为专属码已经命中
      expect(mockPrisma.paymentChannel.findMany).toHaveBeenCalledTimes(1);
    });

    it('无专属渠道 → fallback 到公司统一码（agentId: null）', async () => {
      mockPrisma.agent.findUnique.mockResolvedValueOnce({ id: 'agent-1' });
      mockPrisma.paymentChannel.findMany
        .mockResolvedValueOnce([]) // 专属码：空
        .mockResolvedValueOnce([{ id: 'ch-company', agentId: null }]); // 公司码

      const result = await service.myChannels(AGENT_ACTOR('u1'));

      expect(result.source).toBe('COMPANY');
      expect(result.channels).toEqual([{ id: 'ch-company', agentId: null }]);
      const secondCallArgs = mockPrisma.paymentChannel.findMany.mock.calls[1][0];
      expect(secondCallArgs.where.agentId).toBeNull();
    });

    it('非 AGENT 调用 → ForbiddenError', async () => {
      await expect(service.myChannels(ADMIN)).rejects.toThrow(/仅代理/);
    });
  });
});
