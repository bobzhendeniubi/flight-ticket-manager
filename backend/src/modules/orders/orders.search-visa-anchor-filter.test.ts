/**
 * 搜索吃产品名 + 纯签证单取数衔接 · 单元测试（vitest）
 *
 * 两件事都发生在「取数 where」这一层，故合并一个文件：
 *   1) buildSearchTermClause —— 搜索词要能命中订单项名称（产品名/酒店名/签证名）。
 *      此前只认订单号/联系人/电话/乘客名/证件号/备注，按产品名搜一律空手而归。
 *   2) buildOrderFilterWhere 的出行日期分支 —— 纯签证单的日期锚点。
 *      · 有锚点（填了签证预计出行日期 visaIntendedDate）：列表与导出都按区间命中；
 *      · 无锚点（连日期都没填）：**仅导出**路径（includeAnchorless: true）把它取回，
 *        由 orders.export-depart-filter 按「无锚点保留」兜底；列表路径不取（否则无日期单会
 *        出现在每一个日期区间里，日期筛选失效）。
 *
 * 只断言 where 形状，不连库（orders.service 顶层引用 prisma → mock 掉）。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import { buildSearchTermClause, buildOrderFilterWhere } from './orders.service.js';
import { addGroundItemBodySchema } from './orders.schemas.js';

/** where.AND 归一成数组，便于逐条查找。 */
function andClauses(where: Record<string, unknown>): Array<Record<string, unknown>> {
  const and = where.AND;
  if (!and) return [];
  return (Array.isArray(and) ? and : [and]) as Array<Record<string, unknown>>;
}

describe('buildSearchTermClause · 搜索吃产品名（订单项 description）', () => {
  it('OR 里含 items.some.description 的模糊匹配（大小写不敏感）', () => {
    const clause = buildSearchTermClause('曼谷');
    expect(clause.OR).toContainEqual({
      items: { some: { description: { contains: '曼谷', mode: 'insensitive' } } },
    });
  });

  it('原有字段一个都没少（订单号/联系人/电话/备注/乘客子查询），只是多了一支', () => {
    const clause = buildSearchTermClause('abc');
    const or = clause.OR as Array<Record<string, unknown>>;
    expect(or).toContainEqual({ orderNumber: { contains: 'abc', mode: 'insensitive' } });
    expect(or).toContainEqual({ contactName: { contains: 'abc', mode: 'insensitive' } });
    expect(or).toContainEqual({ contactPhone: { contains: 'abc' } });
    expect(or).toContainEqual({ noteVisa: { contains: 'abc', mode: 'insensitive' } });
    expect(or.some((c) => 'passengers' in c)).toBe(true);
    expect(or).toHaveLength(11);
  });

  it('多词搜索：每个词各自成一个 OR 块、词间 AND（产品名与乘客名可分别命中同一单）', () => {
    const where = buildOrderFilterWhere({ search: '曼谷 王小明' });
    const searchBlocks = andClauses(where as Record<string, unknown>).filter((c) => 'OR' in c);
    expect(searchBlocks).toHaveLength(2);
    for (const block of searchBlocks) {
      const or = block.OR as Array<Record<string, unknown>>;
      expect(or.some((c) => 'items' in c)).toBe(true);
    }
  });
});

describe('buildOrderFilterWhere · 出行日期：签证预计出行日期是第三个锚点', () => {
  it('travelFrom/travelTo → items.some.OR 三支：航段出发时间 / 酒店入住日 / 签证预计出行日期', () => {
    const where = buildOrderFilterWhere({ travelFrom: '2026-09-15', travelTo: '2026-09-15' });
    const clause = andClauses(where as Record<string, unknown>).find((c) => 'items' in c);
    expect(clause).toBeDefined();
    const or = (clause!.items as { some: { OR: Array<Record<string, unknown>> } }).some.OR;
    expect(or).toHaveLength(3);
    expect(or.some((c) => 'flightSchedule' in c)).toBe(true);
    expect(or.some((c) => 'hotelCheckIn' in c)).toBe(true);
    expect(or.some((c) => 'visaIntendedDate' in c)).toBe(true);
  });

  it('签证锚点用的窗口与航班/酒店完全一致（±1 天放宽，不另起一套口径）', () => {
    const where = buildOrderFilterWhere({ travelFrom: '2026-09-15', travelTo: '2026-09-16' });
    const clause = andClauses(where as Record<string, unknown>).find((c) => 'items' in c);
    const or = (clause!.items as { some: { OR: Array<Record<string, unknown>> } }).some.OR;
    const visa = or.find((c) => 'visaIntendedDate' in c)!.visaIntendedDate;
    const hotel = or.find((c) => 'hotelCheckIn' in c)!.hotelCheckIn;
    expect(visa).toEqual(hotel);
    expect(visa).toEqual({
      gte: new Date('2026-09-14T00:00:00Z'),
      lte: new Date('2026-09-17T23:59:59Z'),
    });
  });

  it('不传出行日期 → 不产生 items 日期子句（其它筛选不受影响）', () => {
    const where = buildOrderFilterWhere({ status: 'PAID' });
    expect(andClauses(where as Record<string, unknown>).some((c) => 'items' in c)).toBe(false);
  });
});

describe('buildOrderFilterWhere · 无锚点的签证单：仅导出路径取回', () => {
  it('列表路径（默认）→ 只有「锚点落在窗口内」这一支，无锚点单取不回来', () => {
    const where = buildOrderFilterWhere({ travelFrom: '2026-09-15', travelTo: '2026-09-15' });
    const clauses = andClauses(where as Record<string, unknown>);
    expect(clauses.some((c) => 'OR' in c)).toBe(false);
    expect(clauses.some((c) => 'items' in c)).toBe(true);
  });

  it('导出路径（includeAnchorless）→ OR 上一支「无任何日期锚点 AND 涉签」', () => {
    const where = buildOrderFilterWhere(
      { travelFrom: '2026-09-15', travelTo: '2026-09-15' },
      { includeAnchorless: true },
    );
    const orClause = andClauses(where as Record<string, unknown>).find((c) => 'OR' in c);
    expect(orClause).toBeDefined();
    const branches = orClause!.OR as Array<Record<string, unknown>>;
    expect(branches).toHaveLength(2);

    // ① 有锚点且落在窗口内
    const anchored = branches.find(
      (b) => (b.items as { some?: unknown } | undefined)?.some !== undefined,
    );
    expect(anchored).toBeDefined();

    // ② 一个日期锚点都没有 **且** 确实是签证单（收窄：空单/接送单/资料不全的机酒单不豁免）
    const anchorless = branches.find((b) => 'AND' in b);
    expect(anchorless).toEqual({
      AND: [
        {
          items: {
            none: {
              OR: [
                { flightScheduleId: { not: null } },
                { hotelCheckIn: { not: null } },
                { visaIntendedDate: { not: null } },
              ],
            },
          },
        },
        {
          items: {
            some: {
              OR: [
                { kind: 'VISA' },
                { kind: 'BUNDLE', bundle: { items: { array_contains: [{ kind: 'VISA' }] } } },
              ],
            },
          },
        },
      ],
    });
  });

  it('无锚点豁免必须同时满足两条（none + some），不是「只要没日期就放行」', () => {
    const where = buildOrderFilterWhere(
      { travelFrom: '2026-09-15', travelTo: '2026-09-15' },
      { includeAnchorless: true },
    );
    const branches = (andClauses(where as Record<string, unknown>).find((c) => 'OR' in c)!.OR ??
      []) as Array<Record<string, unknown>>;
    const anchorless = branches.find((b) => 'AND' in b)!;
    const conds = anchorless.AND as Array<Record<string, unknown>>;
    // 单独的 items.none 分支（老口径）不复存在——它必须与「涉签」条件成对出现
    expect(branches.some((b) => (b.items as { none?: unknown } | undefined)?.none)).toBe(false);
    expect(conds).toHaveLength(2);
    expect((conds[0].items as { none?: unknown }).none).toBeDefined();
    expect((conds[1].items as { some?: unknown }).some).toBeDefined();
  });

  it('includeAnchorless 只作用于出行日期分支：没传日期时不产生任何多余子句', () => {
    const where = buildOrderFilterWhere({ status: 'PAID' }, { includeAnchorless: true });
    expect(andClauses(where as Record<string, unknown>)).toHaveLength(0);
  });

  it('勾选导出（orderIds）短路在前：includeAnchorless 不改变「勾了哪些就导哪些」', () => {
    const where = buildOrderFilterWhere(
      { orderIds: ['o1', 'o2'], travelFrom: '2026-09-15' },
      { includeAnchorless: true },
    );
    expect(where).toEqual({ id: { in: ['o1', 'o2'] }, deletedAt: null });
  });
});

// 补录签证行也要能填日期锚点——建单能填、补录填不了的话，「先建单后补签证」的纯签证单
// 照样派生不出出发日，上面那套取数改造对它无效。
describe('addGroundItemBodySchema · 补录签证行的预计出行日期', () => {
  it('接受 YYYY-MM-DD', () => {
    const parsed = addGroundItemBodySchema.parse({
      kind: 'VISA',
      visaId: 'visa_1',
      visaIntendedDate: '2026-09-15',
    });
    expect(parsed).toMatchObject({ kind: 'VISA', visaIntendedDate: '2026-09-15' });
  });

  it('可不填（行程未定）—— 兼容既有调用方', () => {
    const parsed = addGroundItemBodySchema.parse({ kind: 'VISA', visaId: 'visa_1' });
    expect((parsed as { visaIntendedDate?: string }).visaIntendedDate).toBeUndefined();
  });

  it('拒绝带时区的完整 ISO 串 / 其它写法（与建单同款正则，防折成前一天）', () => {
    for (const bad of ['2026-09-15T00:00:00+08:00', '2026/09/15', '15-09-2026']) {
      const r = addGroundItemBodySchema.safeParse({
        kind: 'VISA',
        visaId: 'visa_1',
        visaIntendedDate: bad,
      });
      expect(r.success).toBe(false);
    }
  });

  it('酒店分支不认这个字段（签证专属，不误开口子）', () => {
    const parsed = addGroundItemBodySchema.parse({
      kind: 'HOTEL',
      hotelRoomTypeId: 'rt_1',
      nights: 2,
      rooms: 1,
      visaIntendedDate: '2026-09-15',
    });
    expect(parsed).not.toHaveProperty('visaIntendedDate');
  });
});
