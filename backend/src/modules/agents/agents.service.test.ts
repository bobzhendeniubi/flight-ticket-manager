/**
 * AgentService.updateAgent / setActive · 服务级测试（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖 0711 反馈「编辑错了不可更改，不知道哪里可以操作停用账号」新增的两个能力：
 *   1. updateAgent()：权限口径（ADMIN/STAFF 可改任意代理，AGENT 只能改自己）+
 *      只提交实际变化的字段（changedFields）+ 邮箱唯一性冲突
 *   2. setActive()：仅 ADMIN + 不能停用自己账号所属的代理（自锁保护）+ 幂等（状态未变不写库）
 *
 * 登录拦截（停用代理登录被拒）覆盖在 auth.service.test.ts，因为那是被拦截的实际入口。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettlementMode, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    agent: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { AgentService } from './agents.service.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

function decimal(n: number) {
  return { toString: () => String(n) } as unknown as { toString(): string };
}

/** updateAgent() 第一步 target 查询的返回形状：{ ...Agent字段, user: { id, email } } */
function fakeTarget(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'agent-1',
    userId: 'user-1',
    companyName: '旧公司名',
    contactName: '旧联系人',
    contactPhone: '13800000000',
    notes: null,
    isActive: true,
    user: { id: 'user-1', email: 'old@test.com' },
    ...overrides,
  };
}

/** getAgentDetail() 查询（含 AGENT_DETAIL_INCLUDE）的返回形状 */
function fakeDetailRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'agent-1',
    userId: 'user-1',
    tier: 1,
    parentAgentId: null,
    companyName: '旧公司名',
    contactName: '旧联系人',
    contactPhone: '13800000000',
    prepaymentBalance: decimal(0),
    settlementMode: SettlementMode.PER_ORDER,
    isActive: true,
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    parentAgent: null,
    user: {
      id: 'user-1',
      email: 'old@test.com',
      displayName: '旧联系人',
      lastLoginAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    _count: { childAgents: 0, orders: 0 },
    ...overrides,
  };
}

const ADMIN = { currentUserId: 'admin-1', currentRole: UserRole.ADMIN };
const STAFF = { currentUserId: 'staff-1', currentRole: UserRole.STAFF };
const AGENT_SELF = { currentUserId: 'user-1', currentRole: UserRole.AGENT };
const AGENT_OTHER = { currentUserId: 'user-2', currentRole: UserRole.AGENT };

describe('AgentService', () => {
  const service = new AgentService();

  beforeEach(() => {
    vi.clearAllMocks();
    // updateAgent() 内部事务用回调形态：直接把 mockPrisma 当 tx 传给回调
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockPrisma) => Promise<unknown>) =>
      cb(mockPrisma),
    );
  });

  // ══════════════════════════════════════════════════════════════════════
  describe('updateAgent() · 权限口径 + 只提交变化字段', () => {
    it('AGENT 编辑他人代理 → ForbiddenError，不查邮箱/不开事务', async () => {
      mockPrisma.agent.findUnique.mockResolvedValueOnce(fakeTarget());

      await expect(
        service.updateAgent({
          ...AGENT_OTHER,
          targetAgentId: 'agent-1',
          body: { contactPhone: '13900000000' },
        }),
      ).rejects.toThrow(/只能修改自己/);

      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('AGENT 编辑自己 → 允许，写入变化字段', async () => {
      mockPrisma.agent.findUnique
        .mockResolvedValueOnce(fakeTarget())
        .mockResolvedValueOnce(fakeDetailRow({ contactPhone: '13900000000' }));

      const result = await service.updateAgent({
        ...AGENT_SELF,
        targetAgentId: 'agent-1',
        body: { contactPhone: '13900000000' },
      });

      expect(result.changedFields).toEqual(['contactPhone']);
      expect(result.agent.contactPhone).toBe('13900000000');
      expect(mockPrisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { contactPhone: '13900000000' },
      });
      // 邮箱没变 → 不该动 User 表
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('STAFF 编辑任意代理（含改邮箱）→ 允许，Agent 与 User 一起改', async () => {
      mockPrisma.agent.findUnique
        .mockResolvedValueOnce(fakeTarget())
        .mockResolvedValueOnce(
          fakeDetailRow({ companyName: '新公司名', user: { ...fakeDetailRow().user, email: 'new@test.com' } }),
        );
      mockPrisma.user.findUnique.mockResolvedValueOnce(null); // 新邮箱未被占用

      const result = await service.updateAgent({
        ...STAFF,
        targetAgentId: 'agent-1',
        body: { companyName: '新公司名', email: 'new@test.com' },
      });

      expect(result.changedFields.sort()).toEqual(['companyName', 'email']);
      expect(mockPrisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { companyName: '新公司名' },
      });
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { email: 'new@test.com' },
      });
    });

    it('邮箱已被其他账号占用 → ConflictError，不写库', async () => {
      mockPrisma.agent.findUnique.mockResolvedValueOnce(fakeTarget());
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'user-999', email: 'new@test.com' });

      await expect(
        service.updateAgent({
          ...ADMIN,
          targetAgentId: 'agent-1',
          body: { email: 'new@test.com' },
        }),
      ).rejects.toThrow(/邮箱已被/);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('目标代理不存在 → NotFoundError', async () => {
      mockPrisma.agent.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.updateAgent({ ...ADMIN, targetAgentId: 'missing', body: { notes: 'x' } }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('提交的字段值与现状完全相同 → changedFields 为空，不开事务', async () => {
      mockPrisma.agent.findUnique.mockResolvedValueOnce(fakeTarget()).mockResolvedValueOnce(fakeDetailRow());

      const result = await service.updateAgent({
        ...ADMIN,
        targetAgentId: 'agent-1',
        body: { contactName: '旧联系人' }, // 与现状相同
      });

      expect(result.changedFields).toEqual([]);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  describe('setActive() · 仅 ADMIN + 自锁保护 + 幂等', () => {
    it('非 ADMIN 调用 → ForbiddenError，不查库', async () => {
      await expect(
        service.setActive({ ...STAFF, targetAgentId: 'agent-1', isActive: false }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockPrisma.agent.findUnique).not.toHaveBeenCalled();
    });

    it('目标代理不存在 → NotFoundError', async () => {
      mockPrisma.agent.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.setActive({ ...ADMIN, targetAgentId: 'missing', isActive: false }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('停用自己账号所属的代理 → ForbiddenError，不写库', async () => {
      mockPrisma.agent.findUnique.mockResolvedValueOnce({ id: 'agent-1', userId: 'admin-1', isActive: true });

      await expect(
        service.setActive({
          currentUserId: 'admin-1',
          currentRole: UserRole.ADMIN,
          targetAgentId: 'agent-1',
          isActive: false,
        }),
      ).rejects.toThrow(/不能停用自己/);

      expect(mockPrisma.agent.update).not.toHaveBeenCalled();
    });

    it('目标状态已经等于目标值（幂等）→ changed=false，不写库', async () => {
      mockPrisma.agent.findUnique
        .mockResolvedValueOnce({ id: 'agent-1', userId: 'user-1', isActive: false })
        .mockResolvedValueOnce(fakeDetailRow({ isActive: false }));

      const result = await service.setActive({ ...ADMIN, targetAgentId: 'agent-1', isActive: false });

      expect(result.changed).toBe(false);
      expect(mockPrisma.agent.update).not.toHaveBeenCalled();
    });

    it('正常停用 → changed=true，isActive 写为 false', async () => {
      mockPrisma.agent.findUnique
        .mockResolvedValueOnce({ id: 'agent-1', userId: 'user-1', isActive: true })
        .mockResolvedValueOnce(fakeDetailRow({ isActive: false }));

      const result = await service.setActive({ ...ADMIN, targetAgentId: 'agent-1', isActive: false });

      expect(result.changed).toBe(true);
      expect(result.agent.isActive).toBe(false);
      expect(mockPrisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { isActive: false },
      });
    });

    it('正常启用 → changed=true，isActive 写为 true', async () => {
      mockPrisma.agent.findUnique
        .mockResolvedValueOnce({ id: 'agent-1', userId: 'user-1', isActive: false })
        .mockResolvedValueOnce(fakeDetailRow({ isActive: true }));

      const result = await service.setActive({ ...ADMIN, targetAgentId: 'agent-1', isActive: true });

      expect(result.changed).toBe(true);
      expect(mockPrisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { isActive: true },
      });
    });
  });
});
