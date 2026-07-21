/**
 * 代理名单格式绑定 + 识别词条 · 服务级测试（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. schema 口径：rosterFormat 只认三个常量或 null；rosterKeywords trim/去空/去重/上限 10 条/单条 ≤20 字
 *   2. updateAgent()：rosterFormat / rosterKeywords 字段透传（写库 + 回显 + changedFields）
 *   3. 词条全局查重：词条已被另一家代理注册 → BadRequestError(400)，报错含词条与占用方
 *   4. createChildAgent()：新建时字段透传 + 查重拦截
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    agent: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../lib/password.js', () => ({ hashPassword: vi.fn(async () => 'hashed-pw') }));

import { AgentService } from './agents.service.js';
import { BadRequestError } from '../../lib/errors.js';
import { createChildAgentBodySchema, updateAgentBodySchema } from './agents.schemas.js';

function decimal(n: number) {
  return { toString: () => String(n) } as unknown as { toString(): string };
}

/** updateAgent() 第一步 target 查询的返回形状 */
function fakeTarget(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'agent-1',
    userId: 'user-1',
    companyName: '甲公司',
    contactName: '甲联系人',
    contactPhone: '13800000000',
    notes: null,
    isActive: true,
    rosterFormat: null,
    rosterKeywords: [],
    user: { id: 'user-1', email: 'a@test.com' },
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
    parentAgent: null,
    companyName: '甲公司',
    contactName: '甲联系人',
    contactPhone: '13800000000',
    prepaymentBalance: decimal(0),
    settlementMode: 'PER_ORDER',
    isActive: true,
    notes: null,
    rosterFormat: 'COLON_MULTILINE_DMY',
    rosterKeywords: ['测试词条A'],
    createdAt: new Date('2026-07-20T00:00:00Z'),
    user: {
      id: 'user-1',
      email: 'a@test.com',
      displayName: '甲',
      lastLoginAt: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
    },
    _count: { childAgents: 0, orders: 0 },
    ...overrides,
  };
}

describe('roster schema 口径', () => {
  it('rosterFormat 只认三个常量或 null，非法值被拒', () => {
    for (const v of ['COLON_MULTILINE_YMD', 'INLINE_NUMBERED', 'COLON_MULTILINE_DMY', null]) {
      expect(updateAgentBodySchema.safeParse({ rosterFormat: v }).success).toBe(true);
    }
    expect(updateAgentBodySchema.safeParse({ rosterFormat: 'SOMETHING_ELSE' }).success).toBe(false);
  });

  it('rosterKeywords trim、去空、去重', () => {
    const parsed = updateAgentBodySchema.parse({
      rosterKeywords: ['  词条一  ', '', '   ', '词条二', '词条一'],
    });
    expect(parsed.rosterKeywords).toEqual(['词条一', '词条二']);
  });

  it('rosterKeywords 上限 10 条、单条 ≤20 字符', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `词条${i}`);
    expect(updateAgentBodySchema.safeParse({ rosterKeywords: eleven }).success).toBe(false);
    expect(
      updateAgentBodySchema.safeParse({ rosterKeywords: ['一'.repeat(21)] }).success,
    ).toBe(false);
    expect(
      updateAgentBodySchema.safeParse({ rosterKeywords: ['一'.repeat(20)] }).success,
    ).toBe(true);
  });
});

describe('AgentService · updateAgent 名单格式字段', () => {
  let service: AgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AgentService();
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) =>
      fn(mockPrisma),
    );
  });

  it('rosterFormat / rosterKeywords 透传写库并计入 changedFields', async () => {
    mockPrisma.agent.findUnique
      .mockResolvedValueOnce(fakeTarget()) // target 查询
      .mockResolvedValueOnce(fakeDetailRow()); // 回显详情
    mockPrisma.agent.findFirst.mockResolvedValue(null); // 查重：无人占用

    const result = await service.updateAgent({
      currentUserId: 'admin-1',
      currentRole: UserRole.ADMIN,
      targetAgentId: 'agent-1',
      body: { rosterFormat: 'COLON_MULTILINE_DMY', rosterKeywords: ['测试词条A'] },
    });

    expect(mockPrisma.agent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'agent-1' },
        data: expect.objectContaining({
          rosterFormat: 'COLON_MULTILINE_DMY',
          rosterKeywords: ['测试词条A'],
        }),
      }),
    );
    expect(result.changedFields).toEqual(
      expect.arrayContaining(['rosterFormat', 'rosterKeywords']),
    );
    expect(result.agent.rosterFormat).toBe('COLON_MULTILINE_DMY');
    expect(result.agent.rosterKeywords).toEqual(['测试词条A']);
  });

  it('词条已被另一家代理注册 → BadRequestError，报错含词条与占用方', async () => {
    mockPrisma.agent.findUnique.mockResolvedValueOnce(fakeTarget());
    mockPrisma.agent.findFirst.mockResolvedValue({
      id: 'agent-2',
      companyName: '乙公司',
      contactName: '乙联系人',
      rosterKeywords: ['撞车词条'],
    });

    await expect(
      service.updateAgent({
        currentUserId: 'admin-1',
        currentRole: UserRole.ADMIN,
        targetAgentId: 'agent-1',
        body: { rosterKeywords: ['撞车词条'] },
      }),
    ).rejects.toThrowError(BadRequestError);
    // 查重失败不落库
    expect(mockPrisma.agent.update).not.toHaveBeenCalled();

    mockPrisma.agent.findUnique.mockResolvedValueOnce(fakeTarget());
    await expect(
      service.updateAgent({
        currentUserId: 'admin-1',
        currentRole: UserRole.ADMIN,
        targetAgentId: 'agent-1',
        body: { rosterKeywords: ['撞车词条'] },
      }),
    ).rejects.toThrow(/撞车词条.*乙公司/);
  });

  it('查重排除自己：改自己已注册的词条不算冲突（findFirst 带 id not 条件）', async () => {
    mockPrisma.agent.findUnique
      .mockResolvedValueOnce(fakeTarget({ rosterKeywords: ['旧词条'] }))
      .mockResolvedValueOnce(fakeDetailRow({ rosterKeywords: ['旧词条', '新词条'] }));
    mockPrisma.agent.findFirst.mockResolvedValue(null);

    await service.updateAgent({
      currentUserId: 'admin-1',
      currentRole: UserRole.ADMIN,
      targetAgentId: 'agent-1',
      body: { rosterKeywords: ['旧词条', '新词条'] },
    });

    expect(mockPrisma.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: 'agent-1' },
          rosterKeywords: { hasSome: ['旧词条', '新词条'] },
        }),
      }),
    );
  });

  it('词条未变化时不触发查重、不写该字段', async () => {
    mockPrisma.agent.findUnique
      .mockResolvedValueOnce(fakeTarget({ rosterKeywords: ['原样词条'] }))
      .mockResolvedValueOnce(fakeDetailRow());

    const result = await service.updateAgent({
      currentUserId: 'admin-1',
      currentRole: UserRole.ADMIN,
      targetAgentId: 'agent-1',
      body: { rosterKeywords: ['原样词条'], notes: '只改备注' },
    });

    expect(mockPrisma.agent.findFirst).not.toHaveBeenCalled();
    expect(result.changedFields).toEqual(['notes']);
  });
});

describe('AgentService · createChildAgent 名单格式字段', () => {
  let service: AgentService;

  const createBody = createChildAgentBodySchema.parse({
    email: 'child@test.com',
    password: 'password123',
    displayName: '丙',
    contactName: '丙联系人',
    contactPhone: '13900000000',
    rosterFormat: 'INLINE_NUMBERED',
    rosterKeywords: ['新家词条'],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AgentService();
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) =>
      fn(mockPrisma),
    );
    mockPrisma.user.findUnique.mockResolvedValue(null); // 邮箱未注册
    mockPrisma.user.create.mockResolvedValue({
      id: 'user-3',
      email: 'child@test.com',
      displayName: '丙',
    });
    mockPrisma.agent.create.mockResolvedValue({
      id: 'agent-3',
      userId: 'user-3',
      tier: 1,
      parentAgentId: null,
      contactName: '丙联系人',
      rosterFormat: 'INLINE_NUMBERED',
      rosterKeywords: ['新家词条'],
    });
  });

  it('新建代理透传 rosterFormat / rosterKeywords', async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(null);

    await service.createChildAgent({
      currentUserId: 'admin-1',
      currentRole: UserRole.ADMIN,
      parentAgentId: null,
      body: createBody,
    });

    expect(mockPrisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rosterFormat: 'INLINE_NUMBERED',
          rosterKeywords: ['新家词条'],
        }),
      }),
    );
  });

  it('新建时词条撞车 → BadRequestError，不建号', async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      id: 'agent-2',
      companyName: null,
      contactName: '乙联系人',
      rosterKeywords: ['新家词条'],
    });

    await expect(
      service.createChildAgent({
        currentUserId: 'admin-1',
        currentRole: UserRole.ADMIN,
        parentAgentId: null,
        body: createBody,
      }),
    ).rejects.toThrow(/新家词条.*乙联系人/);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.agent.create).not.toHaveBeenCalled();
  });
});
