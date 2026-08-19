import { describe, expect, it, vi } from 'vitest';
import { SettlementDiscountKind, SettlementTier } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  deleteDiscountRule,
  resolveAgentSettlementDiscount,
  resolveRetailSettlementDiscount,
  upsertDiscountRules,
} from './settlement-discounts.service.js';

const baseRule = {
  id: 'rule-1',
  kind: SettlementDiscountKind.AGENT,
  agentId: 'agent-1',
  tier: SettlementTier.CITY_3STAR,
  nights: 3,
  startDate: new Date('2026-08-01T00:00:00.000Z'),
  endDate: new Date('2026-08-31T00:00:00.000Z'),
  discountPerPersonCny: 200,
  isActive: true,
  note: null,
  updatedBy: 'user-1',
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-20T00:00:00.000Z'),
};

function clientWithFindMany(findMany: ReturnType<typeof vi.fn>): PrismaClient {
  return { settlementDiscountRule: { findMany } } as unknown as PrismaClient;
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    kind: SettlementDiscountKind.AGENT,
    agentId: 'agent-1',
    tier: SettlementTier.CITY_3STAR,
    nights: 3,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    discountPerPersonCny: 200,
    ...overrides,
  };
}

describe('resolveAgentSettlementDiscount', () => {
  it('AGENT 专属优先于 AGENT_DEFAULT', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([baseRule])
      .mockResolvedValueOnce([
        {
          ...baseRule,
          id: 'default-1',
          kind: SettlementDiscountKind.AGENT_DEFAULT,
          agentId: null,
          discountPerPersonCny: 100,
        },
      ]);
    const hit = await resolveAgentSettlementDiscount(
      'agent-1',
      SettlementTier.CITY_3STAR,
      3,
      '2026-08-15',
      clientWithFindMany(findMany),
    );
    expect(hit).toEqual({
      ruleId: 'rule-1',
      kind: SettlementDiscountKind.AGENT,
      discountPerPersonCny: 200,
    });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('专属无命中时回落 AGENT_DEFAULT，都无命中返回 null', async () => {
    const findMany = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ...baseRule,
        id: 'default-1',
        kind: SettlementDiscountKind.AGENT_DEFAULT,
        agentId: null,
        discountPerPersonCny: 100,
      },
    ]);
    const client = clientWithFindMany(findMany);
    await expect(
      resolveAgentSettlementDiscount('agent-1', SettlementTier.CITY_3STAR, 3, '2026-08-15', client),
    ).resolves.toMatchObject({ ruleId: 'default-1', discountPerPersonCny: 100 });

    findMany.mockReset().mockResolvedValue([]);
    await expect(
      resolveAgentSettlementDiscount('agent-1', SettlementTier.CITY_3STAR, 3, '2026-08-15', client),
    ).resolves.toBeNull();
  });
});

describe('resolveRetailSettlementDiscount', () => {
  it('只读 RETAIL，不串入代理规则', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        ...baseRule,
        id: 'retail-1',
        kind: SettlementDiscountKind.RETAIL,
        agentId: null,
        discountPerPersonCny: 80,
      },
    ]);
    const hit = await resolveRetailSettlementDiscount(
      SettlementTier.CITY_3STAR,
      3,
      '2026-08-15',
      clientWithFindMany(findMany),
    );
    expect(hit).toMatchObject({
      ruleId: 'retail-1',
      kind: SettlementDiscountKind.RETAIL,
      discountPerPersonCny: 80,
    });
    expect(findMany.mock.calls[0][0].where.kind).toBe(SettlementDiscountKind.RETAIL);
    expect(findMany.mock.calls[0][0].where.agentId).toBeNull();
  });

  it('同层多条命中 → 取 updatedAt 最新的一条', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        ...baseRule,
        id: 'retail-old',
        kind: SettlementDiscountKind.RETAIL,
        agentId: null,
        discountPerPersonCny: 80,
        updatedAt: new Date('2026-08-10T00:00:00.000Z'),
      },
      {
        ...baseRule,
        id: 'retail-new',
        kind: SettlementDiscountKind.RETAIL,
        agentId: null,
        discountPerPersonCny: 120,
        updatedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    ]);
    await expect(
      resolveRetailSettlementDiscount(
        SettlementTier.CITY_3STAR,
        3,
        '2026-08-15',
        clientWithFindMany(findMany),
      ),
    ).resolves.toMatchObject({ ruleId: 'retail-new', discountPerPersonCny: 120 });
  });
});

describe('upsertDiscountRules window validation', () => {
  it('同批同组窗口重叠 → 整批拒绝', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = clientWithFindMany(findMany);
    await expect(
      upsertDiscountRules(
        [entry(), entry({ startDate: '2026-09-30', endDate: '2026-10-10' })],
        'user-1',
        client,
      ),
    ).rejects.toThrow('出发日期窗口重叠');
  });

  it('共享边界日（9-30）也视为窗口重叠', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await expect(
      upsertDiscountRules(
        [entry({ startDate: '2026-09-01', endDate: '2026-09-30' }), entry({ startDate: '2026-09-30', endDate: '2026-10-15' })],
        'user-1',
        clientWithFindMany(findMany),
      ),
    ).rejects.toThrow('出发日期窗口重叠');
  });

  it('同批停用旧规则并新建同窗口规则 → 按最终启用状态通过', async () => {
    const findMany = vi.fn().mockResolvedValue([{ ...baseRule, id: 'old-rule' }]);
    const update = vi.fn().mockResolvedValue({ ...baseRule, id: 'old-rule', isActive: false });
    const create = vi.fn().mockResolvedValue({ ...baseRule, id: 'new-rule' });
    const client = {
      settlementDiscountRule: { findMany, update, create },
      $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    } as unknown as PrismaClient;

    await expect(
      upsertDiscountRules(
        [
          entry({ id: 'old-rule', isActive: false }),
          entry({ startDate: '2026-09-01', endDate: '2026-09-30' }),
        ],
        'user-1',
        client,
      ),
    ).resolves.toHaveLength(2);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { notIn: ['old-rule'] } }),
    }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'old-rule' } }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('与库内既有启用规则窗口重叠 → 拒绝', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { ...baseRule, startDate: new Date('2026-09-10T00:00:00.000Z'), endDate: new Date('2026-09-20T00:00:00.000Z') },
    ]);
    await expect(
      upsertDiscountRules([entry({ startDate: '2026-09-01', endDate: '2026-09-15' })], 'user-1', clientWithFindMany(findMany)),
    ).rejects.toThrow('出发日期窗口重叠');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [{
          kind: SettlementDiscountKind.AGENT,
          agentId: 'agent-1',
          tier: SettlementTier.CITY_3STAR,
          nights: 3,
        }],
      }),
    }));
  });

  it('相同窗口但 tier 或 nights 不同 → 不冲突', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const update = vi.fn();
    const create = vi.fn().mockResolvedValue(baseRule);
    const client = {
      settlementDiscountRule: { findMany, update, create },
      $transaction: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;
    await expect(
      upsertDiscountRules(
        [
          entry(),
          entry({ tier: SettlementTier.CITY_4STAR }),
          entry({ nights: 4 }),
        ],
        'user-1',
        client,
      ),
    ).resolves.toEqual([]);
    expect(findMany.mock.calls[0][0].where.OR).toHaveLength(3);
  });

  it('数据库排他约束违例 → 转为运营可读的窗口重叠 BadRequestError', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = {
      settlementDiscountRule: {
        findMany,
        create: vi.fn().mockResolvedValue(baseRule),
        update: vi.fn(),
      },
      $transaction: vi.fn().mockRejectedValue({ code: 'P2010', meta: { code: '23P01' } }),
    } as unknown as PrismaClient;
    await expect(upsertDiscountRules([entry()], 'user-1', client)).rejects.toThrow(
      '启用立减规则的出发日期窗口重叠',
    );
  });

  it('AGENT 必须有 agentId，其他类型不能带 agentId', async () => {
    const client = clientWithFindMany(vi.fn().mockResolvedValue([]));
    await expect(
      upsertDiscountRules([entry({ agentId: undefined })], 'user-1', client),
    ).rejects.toThrow('必须选择代理');
    await expect(
      upsertDiscountRules(
        [entry({ kind: SettlementDiscountKind.RETAIL, agentId: 'agent-1' })],
        'user-1',
        client,
      ),
    ).rejects.toThrow('不能绑定代理');
  });

  it('并发删除已不存在的规则 → 返回 null，由路由走现有 NotFound 路径', async () => {
    const client = {
      settlementDiscountRule: {
        findUnique: vi.fn().mockResolvedValue(baseRule),
        delete: vi.fn().mockRejectedValue({ code: 'P2025' }),
      },
    } as unknown as PrismaClient;
    await expect(deleteDiscountRule('rule-1', client)).resolves.toBeNull();
  });
});
