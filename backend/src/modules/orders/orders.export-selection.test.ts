/**
 * 导出选单（共享 helper）· 单元测试（vitest）
 *
 * 覆盖三块：
 *   1. exportMasterQuerySchema —— 全岗总表的 query 解析。重点是 from/to 的语义已改为**下单时间**
 *      （出行日期改用 travelFrom/travelTo），以及 channel / 返程日期 / 航班日期四组新筛选真的收得进来。
 *   2. buildExportOrderWhere —— 取数 where：列表同款筛选 + 有效状态 + 无锚点签证单召回 + agentScope。
 *      这四条任何一条丢了都是线上事故（少导单 / 越权导别家单），逐条断言。
 *   3. filterExportOrders —— 内存精筛：出行/返程/航班日期、航班号×日期绑定、单程/往返，
 *      以及 orderIds（勾选导出）与 scheduleId（整班导出）两个短路。
 */
import { describe, it, expect, vi } from 'vitest';

// orders.service 顶层引用 prisma —— mock 掉，本文件只测纯函数。
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { Prisma } from '@prisma/client';
import { exportMasterQuerySchema } from './orders.schemas.js';
import {
  buildExportOrderWhere,
  describeOrderFilters,
  filterExportOrders,
  serializableOrderFilters,
  EXPORT_COUNTED_STATUSES,
  type ExportSelectionFilters,
} from './orders.export-selection.js';

type Where = Prisma.OrderWhereInput & { AND?: Prisma.OrderWhereInput[] };

const f = (q: Record<string, unknown>): ExportSelectionFilters => q as ExportSelectionFilters;

// ── fixtures：一张往返单（9/3 去 QH9588，9/6 回 QH9589）+ 一张单程单（9/5 去 QH9588）──
const leg = (day: string, flightNumber: string, id: string) => ({
  kind: 'FLIGHT' as const,
  flightScheduleId: id,
  hotelCheckIn: null,
  visaIntendedDate: null,
  bundle: null,
  flightSchedule: {
    departureTime: new Date(`${day}T01:00:00Z`), // 澳门当地 09:00，与 UTC 同日
    departureTz: 'Asia/Macau',
    flight: { flightNumber },
  },
});

const roundTrip = {
  id: 'o-rt',
  items: [leg('2026-09-03', 'QH9588', 'sch-1'), leg('2026-09-06', 'QH9589', 'sch-2')],
};
const oneWay = { id: 'o-ow', items: [leg('2026-09-05', 'QH9588', 'sch-3')] };
/** 一个日期锚点都没有的纯签证单（导出要保留、列表要剔除）。*/
const anchorlessVisa = {
  id: 'o-visa',
  items: [
    {
      kind: 'VISA' as const,
      flightScheduleId: null,
      hotelCheckIn: null,
      visaIntendedDate: null,
      bundle: null,
    },
  ],
};

const ids = (rows: ReadonlyArray<{ id: string }>): string[] => rows.map((r) => r.id);

// ══════════════════════════════════════════════════════════════════════
describe('exportMasterQuerySchema · 全岗总表 query 解析', () => {
  it('收得下与三模板同名同义的整套筛选（含新增的渠道 / 返程 / 航班日期）', () => {
    const q = exportMasterQuerySchema.parse({
      status: 'PAID',
      agentId: 'agt-1',
      channel: 'agent',
      kind: 'BUNDLE',
      search: '王',
      from: '2026-09-01',
      to: '2026-09-02',
      travelFrom: '2026-09-03',
      travelTo: '2026-09-04',
      returnFrom: '2026-09-06',
      returnTo: '2026-09-07',
      flightDateFrom: '2026-09-03',
      flightDateTo: '2026-09-03',
      flightNumber: 'QH9588',
      passengerName: '李',
      recordedBy: '散客',
      invoiceLeg: 'outbound',
      invoiced: 'false',
      visaFulfillmentStatus: 'signed',
      visaRequirement: 'NEEDED',
      tripType: 'roundtrip',
      role: 'ticketing',
      orderIds: 'o1,o2',
    });

    expect(q.channel).toBe('agent');
    expect(q.returnFrom).toBe('2026-09-06');
    expect(q.flightDateTo).toBe('2026-09-03');
    expect(q.tripType).toBe('roundtrip');
    expect(q.role).toBe('ticketing');
    expect(q.orderIds).toEqual(['o1', 'o2']);
    // ?invoiced=false 必须解析成 false（非空字符串皆真的坑）。
    expect(q.invoiced).toBe(false);
  });

  it('from/to 现在是下单时间，接受带时分的 datetime-local 口径', () => {
    const q = exportMasterQuerySchema.parse({ from: '2026-09-01T09:30', to: '2026-09-01T18:00' });
    expect(q.from).toBe('2026-09-01T09:30');
    // 出行日期是另一维，仍只收纯日期。
    expect(() => exportMasterQuerySchema.parse({ travelFrom: '2026-09-01T09:30' })).toThrow();
  });

  it('什么都不给 = 不筛（全部字段 undefined，不塞默认值）', () => {
    const q = exportMasterQuerySchema.parse({});
    expect(q.from).toBeUndefined();
    expect(q.travelFrom).toBeUndefined();
    expect(q.channel).toBeUndefined();
    expect(q.orderIds).toBeUndefined();
  });

  it('role 只认三个岗位视图（agent 视图由路由按登录身份强制，不从 query 收）', () => {
    expect(exportMasterQuerySchema.parse({ role: 'visa' }).role).toBe('visa');
    expect(() => exportMasterQuerySchema.parse({ role: 'agent' })).toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('buildExportOrderWhere · 取数 where', () => {
  const and = (w: Where): Prisma.OrderWhereInput[] => (w.AND as Prisma.OrderWhereInput[]) ?? [];

  it('叠有效状态（释放型状态一律不导）', () => {
    const where = buildExportOrderWhere(f({})) as Where;
    expect(and(where)).toContainEqual({ status: { in: EXPORT_COUNTED_STATUSES } });
    expect(EXPORT_COUNTED_STATUSES).not.toContain('CANCELLED');
    expect(EXPORT_COUNTED_STATUSES).not.toContain('REFUNDED');
    expect(EXPORT_COUNTED_STATUSES).not.toContain('REFUND_REQUESTED');
  });

  it('列表同款筛选原样带进来（软删排除 / 渠道 / 下单时间 / 产品类型）', () => {
    const where = buildExportOrderWhere(
      f({ channel: 'direct', kind: 'VISA', from: '2026-09-01' }),
    ) as Where;
    expect(where.deletedAt).toBeNull();
    expect(and(where)).toContainEqual({ agentId: null });
    expect(and(where)).toContainEqual({ items: { some: { kind: 'VISA' } } });
    expect(where.createdAt).toBeDefined(); // from 走下单时间，不是出行日期
  });

  it('includeAnchorless：出行日期筛选下，无锚点签证单也召回（导出专属口径，别丢）', () => {
    const where = buildExportOrderWhere(f({ travelFrom: '2026-09-03' })) as Where;
    // 出行日期那一支被包成 OR(有锚点命中窗口, 无锚点签证单)。
    const hasOrBranch = and(where).some(
      (c) => Array.isArray((c as { OR?: unknown[] }).OR) && (c as { OR: unknown[] }).OR.length === 2,
    );
    expect(hasOrBranch).toBe(true);
  });

  it('agentScope：代理导出被 AND 圈到自己+下级（勾选导出也逃不掉）', () => {
    const where = buildExportOrderWhere(f({ orderIds: ['o1'] }), {
      agentScope: ['agt-self', 'agt-child'],
    }) as Where;
    expect(where.id).toEqual({ in: ['o1'] });
    expect(and(where)).toContainEqual({ agentId: { in: ['agt-self', 'agt-child'] } });
  });

  it('agentScope=null（ADMIN/STAFF）→ 不加任何代理限制', () => {
    const where = buildExportOrderWhere(f({}), { agentScope: null }) as Where;
    expect(and(where).some((c) => 'agentId' in c)).toBe(false);
  });

  it('extraAnd：票务模板「只导含机票的订单」这类附加条件能叠上', () => {
    const where = buildExportOrderWhere(f({}), {
      extraAnd: [{ items: { some: { kind: 'FLIGHT' } } }],
    }) as Where;
    expect(and(where)).toContainEqual({ items: { some: { kind: 'FLIGHT' } } });
    expect(and(where)).toContainEqual({ status: { in: EXPORT_COUNTED_STATUSES } });
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('filterExportOrders · 内存精筛', () => {
  const rows = [roundTrip, oneWay, anchorlessVisa];

  it('出行日期：只留整单出发日在区间内的（无锚点签证单按导出口径保留）', () => {
    const kept = filterExportOrders(rows, f({ travelFrom: '2026-09-03', travelTo: '2026-09-03' }));
    expect(ids(kept).sort()).toEqual(['o-rt', 'o-visa']);
  });

  it('返程日期：只对确实买了回程票的单有意义，单程单不命中', () => {
    const kept = filterExportOrders(rows, f({ returnFrom: '2026-09-06', returnTo: '2026-09-06' }));
    expect(ids(kept)).toEqual(['o-rt']);
  });

  it('航班日期：航段级维度，任一带班次的航段当天起飞即命中（不分去回）', () => {
    expect(
      ids(filterExportOrders(rows, f({ flightDateFrom: '2026-09-06', flightDateTo: '2026-09-06' }))),
    ).toEqual(['o-rt']);
    expect(
      ids(filterExportOrders(rows, f({ flightDateFrom: '2026-09-05', flightDateTo: '2026-09-05' }))),
    ).toEqual(['o-ow']);
  });

  it('航班日期 + 航班号：必须**同一段**同时满足（「9/3 的 QH9588」）', () => {
    // 9/6 那段是 QH9589，所以「9/6 的 QH9588」一条都不该有。
    const kept = filterExportOrders(
      rows,
      f({ flightDateFrom: '2026-09-06', flightDateTo: '2026-09-06', flightNumber: 'QH9588' }),
    );
    expect(kept).toHaveLength(0);
  });

  it('出行日期 + 航班号 → 收口到**去程段**（不把回程才坐该航班的单带上）', () => {
    // 往返单 9/3 出发、去程 QH9588 → 命中。
    expect(
      ids(filterExportOrders([roundTrip], f({ travelFrom: '2026-09-03', flightNumber: 'QH9588' }))),
    ).toEqual(['o-rt']);
    // 换成回程号 QH9589：去程段不是它 → 不命中（这正是「列表 N 条、导出多于 N 条」的老病根）。
    expect(
      filterExportOrders([roundTrip], f({ travelFrom: '2026-09-03', flightNumber: 'QH9589' })),
    ).toHaveLength(0);
  });

  it('返程日期 + 航班号 → 收口到**回程段**', () => {
    expect(
      ids(filterExportOrders([roundTrip], f({ returnFrom: '2026-09-06', flightNumber: 'QH9589' }))),
    ).toEqual(['o-rt']);
    expect(
      filterExportOrders([roundTrip], f({ returnFrom: '2026-09-06', flightNumber: 'QH9588' })),
    ).toHaveLength(0);
  });

  it('航班号单独给出时不绑定航段（维持任一段命中的宽口径）', () => {
    expect(ids(filterExportOrders(rows, f({ flightNumber: 'QH9589' })))).toEqual([
      'o-rt',
      'o-ow',
      'o-visa',
    ]);
  });

  it('行程类型：oneway 只留单程、roundtrip 只留往返', () => {
    expect(ids(filterExportOrders(rows, f({ tripType: 'roundtrip' })))).toEqual(['o-rt']);
    // 纯签证单没有回程腿，按 determineFlightLegs 也算「无回程」→ 落进 oneway 侧（既有口径，不改）。
    expect(ids(filterExportOrders(rows, f({ tripType: 'oneway' })))).toEqual(['o-ow', 'o-visa']);
  });

  it('回程维度的开票导出：单程单被剔除（它压根没有回程票可开）', () => {
    expect(ids(filterExportOrders(rows, f({ invoiceLeg: 'return' })))).toEqual(['o-rt']);
    // 去程维度不受影响。
    expect(ids(filterExportOrders(rows, f({ invoiceLeg: 'outbound' })))).toEqual([
      'o-rt',
      'o-ow',
      'o-visa',
    ]);
  });

  it('多维度同时给出 = 取交集（返程日期 + 往返）', () => {
    expect(
      ids(filterExportOrders(rows, f({ returnFrom: '2026-09-06', tripType: 'roundtrip' }))),
    ).toEqual(['o-rt']);
    // 返程日期 + 单程 = 自相矛盾 → 诚实空集，而不是某一边静默失效。
    expect(
      filterExportOrders(rows, f({ returnFrom: '2026-09-06', tripType: 'oneway' })),
    ).toHaveLength(0);
  });

  it('勾选导出（orderIds）短路一切精筛：勾了哪些就是哪些', () => {
    const kept = filterExportOrders(
      rows,
      f({ orderIds: ['o-rt'], travelFrom: '2099-01-01', tripType: 'oneway' }),
    );
    expect(ids(kept)).toEqual(['o-rt', 'o-ow', 'o-visa']);
  });

  it('整班导出（scheduleId）短路日期类精筛，但单程/往返照常生效', () => {
    expect(
      ids(filterExportOrders(rows, f({ scheduleId: 'sch-1', travelFrom: '2099-01-01' }))),
    ).toEqual(['o-rt', 'o-ow', 'o-visa']);
    expect(
      ids(filterExportOrders(rows, f({ scheduleId: 'sch-1', tripType: 'roundtrip' }))),
    ).toEqual(['o-rt']);
  });

  it('一个筛选都不给 → 原样返回（浅拷贝，不改调用方的数组）', () => {
    const kept = filterExportOrders(rows, f({}));
    expect(ids(kept)).toEqual(['o-rt', 'o-ow', 'o-visa']);
    expect(kept).not.toBe(rows);
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('审计留痕：筛选摘要', () => {
  it('人读摘要按标签拼出实际筛选条件', () => {
    const label = describeOrderFilters(
      f({ from: '2026-09-01', travelFrom: '2026-09-03', channel: 'agent', flightNumber: 'QH9588' }),
    );
    expect(label).toContain('下单起=2026-09-01');
    expect(label).toContain('出行起=2026-09-03');
    expect(label).toContain('渠道=agent');
    expect(label).toContain('航班号=QH9588');
  });

  it('一个筛选都没给 = 「全部」（诚实：确实导了全库）', () => {
    expect(describeOrderFilters(f({}))).toBe('全部');
  });

  it('invoiced=false 不被 falsy 吞掉（「未开票」是个真筛选）', () => {
    expect(describeOrderFilters(f({ invoiceLeg: 'outbound', invoiced: false }))).toContain(
      '已开票=否',
    );
    expect(serializableOrderFilters(f({ invoiced: false })).invoiced).toBe(false);
  });

  it('结构化留痕：没筛的字段落 null，筛了的落字符串', () => {
    const after = serializableOrderFilters(f({ travelFrom: '2026-09-03' }));
    expect(after.travelFrom).toBe('2026-09-03');
    expect(after.from).toBeNull();
    expect(after.channel).toBeNull();
    expect(after.invoiced).toBeNull();
  });
});
