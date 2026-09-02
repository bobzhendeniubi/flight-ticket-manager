/**
 * 渠道筛选（直客 / 代理）· 单元测试（vitest）
 *
 * 只测 where 构建，不碰 DB。两条口径必须钉死：
 *   1. channel 与 agentId 同时给出时 agentId 优先（更细的那一档）；
 *   2. channel 走 AND 子句、不写 where.agentId —— 否则 listOrders 里代理角色的 RBAC 基准
 *      （where.agentId = { in: 可见集合 }）会被覆盖，代理请求 channel=direct 就能看到全站直客单。
 *      这是越权，不是显示问题，所以按「结构」断言而不只是断言结果条数。
 */
import { describe, it, expect, vi } from 'vitest';

// orders.service 顶层引用 prisma —— mock 掉，本文件只测纯函数。
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { Prisma } from '@prisma/client';
import { buildOrderFilterWhere } from './orders.service.js';
import { listOrdersQuerySchema } from './orders.schemas.js';

type Where = Prisma.OrderWhereInput & { AND?: Prisma.OrderWhereInput[] };

const build = (q: Record<string, unknown>): Where =>
  buildOrderFilterWhere(q as Parameters<typeof buildOrderFilterWhere>[0]) as Where;

describe('listOrdersQuerySchema · channel', () => {
  it('只认 direct / agent 两个值', () => {
    expect(listOrdersQuerySchema.parse({ channel: 'direct' }).channel).toBe('direct');
    expect(listOrdersQuerySchema.parse({ channel: 'agent' }).channel).toBe('agent');
    expect(() => listOrdersQuerySchema.parse({ channel: 'both' })).toThrow();
  });

  it('不给就是不筛（undefined，而不是被塞个默认值）', () => {
    expect(listOrdersQuerySchema.parse({}).channel).toBeUndefined();
  });
});

describe('buildOrderFilterWhere · 渠道筛选', () => {
  it('channel=direct → AND 里挂 agentId: null（直客/散客单）', () => {
    const where = build({ channel: 'direct' });
    expect(where.AND).toContainEqual({ agentId: null });
    // 关键：不能写在 where.agentId 上，那会与 RBAC 基准互相覆盖。
    expect(where.agentId).toBeUndefined();
  });

  it('channel=agent → AND 里挂 agentId: { not: null }（代理单）', () => {
    const where = build({ channel: 'agent' });
    expect(where.AND).toContainEqual({ agentId: { not: null } });
    expect(where.agentId).toBeUndefined();
  });

  it('同时给了 agentId → agentId 优先，channel 完全忽略（不留任何 agentId 子句）', () => {
    const where = build({ channel: 'direct', agentId: 'agt-1' });
    expect(where.agentId).toBe('agt-1');
    expect(where.AND ?? []).not.toContainEqual({ agentId: null });
    expect(where.AND ?? []).not.toContainEqual({ agentId: { not: null } });
  });

  it('不给 channel → 一条 agentId 子句都不加（行为与改动前逐字一致）', () => {
    const where = build({ status: 'PAID' });
    expect(where.agentId).toBeUndefined();
    expect(where.AND ?? []).not.toContainEqual({ agentId: null });
    expect(where.AND ?? []).not.toContainEqual({ agentId: { not: null } });
  });

  it('与其它 items 维度组合时互不覆盖（渠道 + 产品类型 + 出行日期同时成立）', () => {
    const where = build({ channel: 'agent', kind: 'BUNDLE', travelFrom: '2026-09-03' });
    expect(where.AND).toContainEqual({ agentId: { not: null } });
    expect(where.AND).toContainEqual({ items: { some: { kind: 'BUNDLE' } } });
    // 出行日期那一支也还在（不逐字比对它的内部结构，只确认没被挤掉）。
    expect((where.AND ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('勾选导出（orderIds）短路一切筛选，channel 也不例外', () => {
    const where = build({ channel: 'direct', orderIds: ['o1', 'o2'] });
    expect(where).toEqual({ id: { in: ['o1', 'o2'] }, deletedAt: null });
  });
});

/**
 * 代理角色的 RBAC 叠加（listOrders 里 where.agentId = { in: 可见集合 } 那一步）——
 * 这里把两者放在一起，证明 channel=direct 对代理是空集而不是越权。
 * 真实叠加发生在 OrderService.resolveListOrdersWhere 内，形状与此完全一致。
 */
describe('渠道筛选 × 代理 RBAC：代理选「直客」得到空集，而不是看到全站直客单', () => {
  it('AND(agentId: null) 与 where.agentId in [...] 同时成立 = 交集为空，两个条件都还在', () => {
    const where = build({ channel: 'direct' });
    where.agentId = { in: ['agt-self', 'agt-child'] }; // listOrders 对 AGENT 的 RBAC 基准

    // channel 没有把 RBAC 那一层挤掉：可见集合仍在 where.agentId 上。
    expect(where.agentId).toEqual({ in: ['agt-self', 'agt-child'] });
    // 直客条件也还在 AND 里：Prisma 会把两者 AND 起来 → agentId 既要为 null 又要在集合内 = 空集。
    expect(where.AND).toContainEqual({ agentId: null });
  });
});
