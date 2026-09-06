import { describe, expect, it, vi } from 'vitest';
import { SettlementDiscountKind, SettlementTier } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  deleteDiscountRule,
  resolveAgentSettlementDiscount,
  resolveRetailSettlementDiscount,
  upsertDiscountRules,
} from './settlement-discounts.service.js';

const ROUTE = 'MFM-DAD';

const baseRule = {
  id: 'rule-1',
  routeKey: ROUTE,
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
    routeKey: ROUTE,
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
      ROUTE,
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
      resolveAgentSettlementDiscount('agent-1', ROUTE, SettlementTier.CITY_3STAR, 3, '2026-08-15', client),
    ).resolves.toMatchObject({ ruleId: 'default-1', discountPerPersonCny: 100 });

    findMany.mockReset().mockResolvedValue([]);
    await expect(
      resolveAgentSettlementDiscount('agent-1', ROUTE, SettlementTier.CITY_3STAR, 3, '2026-08-15', client),
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
      ROUTE,
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
    expect(findMany.mock.calls[0][0].where.routeKey).toBe(ROUTE);
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
        ROUTE,
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
          routeKey: ROUTE,
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

  it('身份列守卫：票务岗改晚数保存 → 拒绝，文案提示改用新增规则', async () => {
    const findMany = vi.fn().mockResolvedValue([baseRule]);
    const client = clientWithFindMany(findMany);
    await expect(
      upsertDiscountRules([entry({ id: 'rule-1', nights: 4 })], 'user-1', client),
    ).rejects.toThrow('晚数从「3晚」改为「4晚」——不同晚数请用「新增规则」另建一条');
  });

  it('身份列守卫：改档次 → 拒绝，文案提示改用新增规则', async () => {
    const findMany = vi.fn().mockResolvedValue([baseRule]);
    const client = clientWithFindMany(findMany);
    await expect(
      upsertDiscountRules(
        [entry({ id: 'rule-1', tier: SettlementTier.CITY_4STAR })],
        'user-1',
        client,
      ),
    ).rejects.toThrow('档次从「CITY_3STAR」改为「CITY_4STAR」——不同档次请用「新增规则」另建一条');
  });

  it('身份列守卫：改归属代理 → 拒绝，文案提示改用新增规则', async () => {
    const findMany = vi.fn().mockResolvedValue([baseRule]);
    const client = clientWithFindMany(findMany);
    await expect(
      upsertDiscountRules([entry({ id: 'rule-1', agentId: 'agent-2' })], 'user-1', client),
    ).rejects.toThrow('归属代理从「agent-1」改为「agent-2」——不同归属请用「新增规则」另建一条');
  });

  it('身份列守卫：运营只改金额或结束日期 → 放行，正常走 update', async () => {
    const findMany = vi.fn().mockResolvedValue([baseRule]);
    const update = vi.fn().mockResolvedValue({ ...baseRule, discountPerPersonCny: 300 });
    const client = {
      settlementDiscountRule: { findMany, update, create: vi.fn() },
      $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    } as unknown as PrismaClient;

    await expect(
      upsertDiscountRules(
        [entry({ id: 'rule-1', discountPerPersonCny: 300, endDate: '2026-09-15' })],
        'user-1',
        client,
      ),
    ).resolves.toHaveLength(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rule-1' },
        data: expect.objectContaining({ discountPerPersonCny: 300 }),
      }),
    );
  });

  it('身份列守卫：id 在库里不存在 → 报可读错误，提示刷新页面', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = clientWithFindMany(findMany);
    await expect(
      upsertDiscountRules([entry({ id: 'gone-rule' })], 'user-1', client),
    ).rejects.toThrow('对应的立减规则（id: gone-rule）已不存在，可能已被他人删除——请刷新页面后重新编辑再保存');
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

describe('立减规则按航线隔离', () => {
  it('同代理同档同晚同窗口、不同航线 → 不算重叠，各自落库', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const create = vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...baseRule, ...data, id: `new-${data.routeKey}` }));
    const client = {
      settlementDiscountRule: { findMany, update: vi.fn(), create },
      $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    } as unknown as PrismaClient;

    const rows = await upsertDiscountRules(
      [entry({ routeKey: 'MFM-DAD' }), entry({ routeKey: 'MFM-CXR' })],
      'user-1',
      client,
    );

    expect(rows.map((r) => r.routeKey)).toEqual(['MFM-DAD', 'MFM-CXR']);
    // 库内重叠查询按「航线 × 类型 × 代理 × 档次 × 晚数」分组，两条航线是两组
    const or = findMany.mock.calls.at(-1)?.[0].where.OR as Array<{ routeKey: string }>;
    expect(or.map((g) => g.routeKey).sort()).toEqual(['MFM-CXR', 'MFM-DAD']);
    expect(create.mock.calls.map((c) => c[0].data.routeKey)).toEqual(['MFM-DAD', 'MFM-CXR']);
  });

  it('库内既有另一条航线的同组同窗口启用规则 → 不冲突；同航线才冲突', async () => {
    const otherRoute = { ...baseRule, id: 'rule-cxr', routeKey: 'MFM-CXR' };
    const findMany = vi.fn().mockResolvedValue([otherRoute]);
    const create = vi.fn().mockResolvedValue(baseRule);
    const client = {
      settlementDiscountRule: { findMany, update: vi.fn(), create },
      $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    } as unknown as PrismaClient;

    // 与 rule-cxr 同窗口（8 月）但航线是 MFM-DAD → 放行
    await expect(
      upsertDiscountRules([entry({ startDate: '2026-08-01', endDate: '2026-08-31' })], 'user-1', client),
    ).resolves.toHaveLength(1);

    // 同航线同窗口 → 拒
    findMany.mockResolvedValue([{ ...otherRoute, routeKey: 'MFM-DAD' }]);
    await expect(
      upsertDiscountRules([entry({ startDate: '2026-08-01', endDate: '2026-08-31' })], 'user-1', client),
    ).rejects.toThrow('出发日期窗口重叠');
  });

  it('命中只在本航线内找：代理专属 / 兜底 / 散客的 where 都带 routeKey', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = clientWithFindMany(findMany);

    await resolveAgentSettlementDiscount('agent-1', 'MFM-CXR', SettlementTier.CITY_3STAR, 3, '2026-08-15', client);
    await resolveRetailSettlementDiscount('MFM-CXR', SettlementTier.CITY_3STAR, 3, '2026-08-15', client);

    // 专属 + 兜底 + 散客 = 三次查询，每次都限定在 MFM-CXR，没有一次退回默认航线
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls.map((c) => c[0].where.routeKey)).toEqual(['MFM-CXR', 'MFM-CXR', 'MFM-CXR']);
  });

  it('身份列守卫：改已有规则的航线 → 拒绝，文案提示改用新增规则', async () => {
    const findMany = vi.fn().mockResolvedValue([baseRule]);
    const client = clientWithFindMany(findMany);
    await expect(
      upsertDiscountRules([entry({ id: 'rule-1', routeKey: 'MFM-CXR' })], 'user-1', client),
    ).rejects.toThrow('航线从「MFM-DAD」改为「MFM-CXR」——不同航线请用「新增规则」另建一条');
  });
});
