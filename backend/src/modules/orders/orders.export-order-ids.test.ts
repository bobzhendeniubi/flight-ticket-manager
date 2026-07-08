/**
 * 勾选导出「只导勾选的订单」· 单元测试（vitest）
 *
 * 覆盖两处：
 *   1) orderIdsQuerySchema / exportTemplatesQuerySchema — 逗号分隔 & 重复参数、去重、去空、上限校验。
 *   2) buildOrderFilterWhere — 给了 orderIds 就以 id 集合为准（忽略其余筛选）；无则按现有筛选。
 */
import { describe, it, expect, vi } from 'vitest';

// orders.service 顶层引用 prisma —— mock 掉，避免测试连库。
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  orderIdsQuerySchema,
  exportTemplatesQuerySchema,
  MAX_EXPORT_ORDER_IDS,
} from './orders.schemas.js';
import { buildOrderFilterWhere } from './orders.service.js';

describe('orderIdsQuerySchema — 勾选 id 规整', () => {
  it('逗号分隔字符串 → 去重后的数组', () => {
    expect(orderIdsQuerySchema.parse('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('重复参数（数组）→ 原样规整', () => {
    expect(orderIdsQuerySchema.parse(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('去空白 + 去重 + 丢空串', () => {
    expect(orderIdsQuerySchema.parse('  a , b ,a, ,')).toEqual(['a', 'b']);
  });

  it('未给 → undefined（不筛选）', () => {
    expect(orderIdsQuerySchema.parse(undefined)).toBeUndefined();
  });

  it('空串 / 全空白 → undefined（等价于没勾选）', () => {
    expect(orderIdsQuerySchema.parse('')).toBeUndefined();
    expect(orderIdsQuerySchema.parse('  , ,')).toBeUndefined();
  });

  it(`恰好 ${MAX_EXPORT_ORDER_IDS} 条 → 通过`, () => {
    const ids = Array.from({ length: MAX_EXPORT_ORDER_IDS }, (_, i) => `id-${i}`);
    expect(orderIdsQuerySchema.parse(ids)).toHaveLength(MAX_EXPORT_ORDER_IDS);
  });

  it(`超过 ${MAX_EXPORT_ORDER_IDS} 条 → 拒绝（防滥用上限）`, () => {
    const ids = Array.from({ length: MAX_EXPORT_ORDER_IDS + 1 }, (_, i) => `id-${i}`);
    expect(() => orderIdsQuerySchema.parse(ids)).toThrow();
  });
});

describe('exportTemplatesQuerySchema — orderIds 随三模板导出一起解析', () => {
  it('template + orderIds（逗号分隔）一起解析', () => {
    const q = exportTemplatesQuerySchema.parse({ template: 'full', orderIds: 'o1,o2' });
    expect(q.template).toBe('full');
    expect(q.orderIds).toEqual(['o1', 'o2']);
  });

  it('未给 orderIds → undefined（按筛选导出）', () => {
    const q = exportTemplatesQuerySchema.parse({ template: 'ticketing' });
    expect(q.orderIds).toBeUndefined();
  });
});

describe('buildOrderFilterWhere — 勾选导出 vs 筛选导出', () => {
  it('给了 orderIds：以 id 集合为准，忽略其余筛选（status/出行日期等）', () => {
    const where = buildOrderFilterWhere({
      orderIds: ['a', 'b'],
      status: 'PAID',
      travelFrom: '2026-07-01',
      travelTo: '2026-07-31',
      flightNumber: 'QH9589',
    } as Parameters<typeof buildOrderFilterWhere>[0]);
    // 只剩 id 集合（+软删排除），其余筛选一律不落到 where（导出=勾了哪些就导哪些）。
    expect(where).toEqual({ id: { in: ['a', 'b'] }, deletedAt: null });
  });

  it('空 orderIds 数组：视同没勾选，回落到现有筛选', () => {
    const where = buildOrderFilterWhere({
      orderIds: [],
      status: 'PAID',
    } as Parameters<typeof buildOrderFilterWhere>[0]);
    expect(where.id).toBeUndefined();
    expect(where.status).toBe('PAID');
  });

  it('未给 orderIds：按现有筛选（status + 出行日期）构造 where', () => {
    const where = buildOrderFilterWhere({
      status: 'PAID',
      travelFrom: '2026-07-01',
    } as Parameters<typeof buildOrderFilterWhere>[0]);
    expect(where.id).toBeUndefined();
    expect(where.status).toBe('PAID');
    // 出行日期落到 AND 子句
    expect(Array.isArray(where.AND)).toBe(true);
  });

  it('给了 orderIds：调用方仍可在 where.AND 追加 COUNTED_STATUSES 保护', () => {
    // 复刻各导出入口的叠加方式，确认 id 集合 + 状态保护共存。
    const where = buildOrderFilterWhere({
      orderIds: ['a'],
    } as Parameters<typeof buildOrderFilterWhere>[0]);
    const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
    and.push({ status: { in: ['PAID'] } as never });
    where.AND = and;
    expect(where.id).toEqual({ in: ['a'] });
    expect(where.AND).toEqual([{ status: { in: ['PAID'] } }]);
  });
});
