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
import { applyExportAgentScope, buildOrderFilterWhere } from './orders.service.js';

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

// ── 航段守卫（B7）测试工具 ────────────────────────────────────────────
// 「落对列」只证明 where 形状对；票务岗真正关心的是「捞对单」。这里从 where.AND 里取出
// 航段守卫子句，按 Prisma `items.some(...)` 的语义在内存里对样本订单求值，
// 断言「没有航段可开的单」不会出现在结果里 —— 而不是只看 where 长什么样。
type AnyWhere = Record<string, any>;

const andOf = (where: AnyWhere): AnyWhere[] =>
  Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];

/** where 里是否挂了「本单至少有一条带班次的 FLIGHT 行」这条结构守卫。 */
const hasFlightLegGuard = (where: AnyWhere): boolean =>
  andOf(where).some((c) => c?.items?.some?.kind === 'FLIGHT' && c.items.some.flightScheduleId?.not === null);

/** 样本订单（只带守卫求值需要的字段）。 */
type SampleItem = { kind: string; flightScheduleId: string | null };
const ORDER_ROUNDTRIP: SampleItem[] = [
  { kind: 'FLIGHT', flightScheduleId: 'sch_go' },
  { kind: 'FLIGHT', flightScheduleId: 'sch_back' },
];
const ORDER_ONEWAY: SampleItem[] = [{ kind: 'FLIGHT', flightScheduleId: 'sch_go' }];
const ORDER_HOTEL: SampleItem[] = [{ kind: 'HOTEL', flightScheduleId: null }];
const ORDER_VISA: SampleItem[] = [{ kind: 'VISA', flightScheduleId: null }];
/** 套餐单：BUNDLE 行 + 去回两条 FLIGHT 行（buildBatchItems 的 BUNDLE 分支就是这么造的）。 */
const ORDER_BUNDLE: SampleItem[] = [
  { kind: 'FLIGHT', flightScheduleId: 'sch_go' },
  { kind: 'FLIGHT', flightScheduleId: 'sch_back' },
  { kind: 'BUNDLE', flightScheduleId: null },
];

/** 按 where 的航段守卫判断该单会不会被捞出来（无守卫 = 全都捞 = 现状 bug）。 */
const wouldBeCaught = (where: AnyWhere, items: SampleItem[]): boolean =>
  andOf(where).every((c) => {
    const some = c?.items?.some;
    if (!some || some.kind !== 'FLIGHT') return true; // 非航段守卫子句，这里不求值
    return items.some(
      (i) => i.kind === some.kind && (some.flightScheduleId?.not === null ? i.flightScheduleId !== null : true),
    );
  });

describe('buildOrderFilterWhere — 六态开票筛选（invoiceLeg + invoiced）', () => {
  type W = Record<string, unknown>;
  const build = (q: Record<string, unknown>) =>
    buildOrderFilterWhere(q as Parameters<typeof buildOrderFilterWhere>[0]) as W;

  it('去程未开：invoiceLeg=outbound + invoiced=false → outboundInvoiced=false', () => {
    const where = build({ invoiceLeg: 'outbound', invoiced: false });
    expect(where.outboundInvoiced).toBe(false);
  });

  it('回程已开：invoiceLeg=return + invoiced=true → returnInvoiced=true（且带航段守卫）', () => {
    const where = build({ invoiceLeg: 'return', invoiced: true });
    expect(where.returnInvoiced).toBe(true);
    // 落对列 ≠ 捞对单：这条原先只断言落对了列，把「无航段单也被捞出」的 bug 固化了。
    // 补断言航段守卫同时在场（捞对单的断言见下方「航段守卫」describe）。
    expect(hasFlightLegGuard(where)).toBe(true);
  });

  it('系统已开：invoiceLeg=system + invoiced=true → systemInvoiced=true', () => {
    const where = build({ invoiceLeg: 'system', invoiced: true });
    expect(where.systemInvoiced).toBe(true);
  });

  // system 是「系统开票」维度，不是航段维度 —— 酒店单/签证单本来就该能进系统开票清单。
  // 给它加航段守卫会把这些单错杀（假阴性），比现在的假阳性更糟。
  it('系统维度不加航段守卫（酒店单/签证单本来就要系统开票，错杀比错捞更糟）', () => {
    const where = build({ invoiceLeg: 'system', invoiced: false });
    expect(hasFlightLegGuard(where)).toBe(false);
  });
});

describe('buildOrderFilterWhere — 航段守卫（B7：「回程未开」假阳性）', () => {
  const build = (q: Record<string, unknown>) =>
    buildOrderFilterWhere(q as Parameters<typeof buildOrderFilterWhere>[0]) as AnyWhere;

  // 票务岗原话（0713）：「实际需要开票的只有三个订单，但是导出 PNR excel 后表格中出现的是该团期
  // 全部订单」。根因之一：returnInvoiced/outboundInvoiced 缺省就是 false，没有航段的单
  //（酒店单/签证单）天然命中「未开」，被一起捞进清单 —— 它们根本没有票可开。
  describe('回程未开（invoiceLeg=return + invoiced=false）', () => {
    const where = () => build({ invoiceLeg: 'return', invoiced: false });

    it('落对列：returnInvoiced=false', () => {
      expect(where().returnInvoiced).toBe(false);
    });

    it('酒店单不得被捞出（没有航段 = 没有票可开）', () => {
      expect(wouldBeCaught(where(), ORDER_HOTEL)).toBe(false);
    });

    it('签证单不得被捞出（没有航段 = 没有票可开）', () => {
      expect(wouldBeCaught(where(), ORDER_VISA)).toBe(false);
    });

    it('往返单要被捞出（真有回程待开）', () => {
      expect(wouldBeCaught(where(), ORDER_ROUNDTRIP)).toBe(true);
    });

    it('套餐单要被捞出（BUNDLE 单同样带去回两条航段行，错杀它 = 丢真活）', () => {
      expect(wouldBeCaught(where(), ORDER_BUNDLE)).toBe(true);
    });
  });

  describe('去程未开（invoiceLeg=outbound + invoiced=false）—— 同一个假阳性，票务岗的主路径', () => {
    const where = () => build({ invoiceLeg: 'outbound', invoiced: false });

    it('落对列：outboundInvoiced=false', () => {
      expect(where().outboundInvoiced).toBe(false);
    });

    it('酒店单/签证单不得被捞出（outboundInvoiced 缺省 false，同样天然命中「未开」）', () => {
      expect(wouldBeCaught(where(), ORDER_HOTEL)).toBe(false);
      expect(wouldBeCaught(where(), ORDER_VISA)).toBe(false);
    });

    it('单程单要被捞出（去程维度上，单程单确实有去程待开）', () => {
      expect(wouldBeCaught(where(), ORDER_ONEWAY)).toBe(true);
    });
  });

  it('与出行日期组合时守卫仍在（票务岗「7/10 + 回程未开 → 导出」路径）', () => {
    const where = build({ travelFrom: '2026-07-10', travelTo: '2026-07-10', invoiceLeg: 'return', invoiced: false });
    expect(where.returnInvoiced).toBe(false);
    expect(hasFlightLegGuard(where)).toBe(true);
    expect(wouldBeCaught(where, ORDER_HOTEL)).toBe(false);
  });

  it('不给 invoiced 时不加守卫（筛选本身不生效，别平白多挂一条 items 条件）', () => {
    expect(hasFlightLegGuard(build({ invoiceLeg: 'return' }))).toBe(false);
    expect(hasFlightLegGuard(build({}))).toBe(false);
  });

  it('只给 invoiceLeg、缺 invoiced → 不生效（组合式，二者需同时给出）', () => {
    const where = build({ invoiceLeg: 'outbound' });
    expect(where.outboundInvoiced).toBeUndefined();
    expect(where.returnInvoiced).toBeUndefined();
    expect(where.systemInvoiced).toBeUndefined();
  });

  it('与出行日期组合（票务岗「7/10 + 去程未开」路径）：日期落 AND、航段落标量', () => {
    const where = build({ travelFrom: '2026-07-10', travelTo: '2026-07-10', invoiceLeg: 'outbound', invoiced: false });
    expect(where.outboundInvoiced).toBe(false);
    expect(Array.isArray(where.AND)).toBe(true);
  });
});

describe('applyExportAgentScope — 代理导出圈定（0831 代理反馈：导出与列表同权）', () => {
  it('scope=null/undefined（ADMIN/STAFF）→ 原样返回，不加过滤', () => {
    const where = buildOrderFilterWhere({ orderIds: ['a', 'b'] } as never);
    expect(applyExportAgentScope(where, null)).toBe(where);
    expect(applyExportAgentScope(where, undefined)).toBe(where);
  });

  it('勾选导出（orderIds 圈单）也叠 agentId in —— 越权勾选的单被交集排除', () => {
    const where = buildOrderFilterWhere({ orderIds: ['a', 'b'] } as never);
    const scoped = applyExportAgentScope(where, ['ag1', 'ag2']);
    expect(scoped.id).toEqual({ in: ['a', 'b'] });
    expect(scoped.AND).toContainEqual({ agentId: { in: ['ag1', 'ag2'] } });
  });

  it('筛选导出：保留既有 AND 条件，再叠 agentId in（不覆盖）', () => {
    const where = buildOrderFilterWhere({ kind: 'FLIGHT' } as never);
    const before = Array.isArray(where.AND) ? where.AND.length : where.AND ? 1 : 0;
    const scoped = applyExportAgentScope(where, ['ag1']);
    const and = scoped.AND as unknown[];
    expect(and).toHaveLength(before + 1);
    expect(and).toContainEqual({ agentId: { in: ['ag1'] } });
  });

  it('空 scope（AGENT 无 agentId 的脏账号）→ agentId in [] = 什么都导不出（fail-closed）', () => {
    const scoped = applyExportAgentScope({ deletedAt: null }, []);
    expect(scoped.AND).toContainEqual({ agentId: { in: [] } });
  });

  it('不可变：原 where 对象不被修改', () => {
    const where = { deletedAt: null } as const;
    applyExportAgentScope(where, ['ag1']);
    expect(where).toEqual({ deletedAt: null });
  });
});
