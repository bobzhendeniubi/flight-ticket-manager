/**
 * lib/exportCatalog · 导出中心目录的角色过滤 / 分组 / 最近导出记录回归。
 *
 * 这三件事是导出中心唯一有判断的部分（页面其余是控件与下载动作，靠 build 闸兜）：
 *   · 角色过滤漂了 → 代理会在导出中心看到禁代理的导出入口（点了才被后端 403，白跑一趟）；
 *   · 分组漏了空组过滤 → 代理页面出现 6 个空标题；
 *   · 最近导出解析不设防 → localStorage 被改坏（或换了结构）整页崩。
 */
import { describe, it, expect } from 'vitest';
import {
  EXPORT_ENTRIES,
  EXPORT_GROUPS,
  RECENT_EXPORTS_LIMIT,
  appendRecentExport,
  canAccessExport,
  groupExportEntries,
  parseRecentExports,
  visibleExportEntries,
  type ExportEntry,
  type RecentExport,
} from './exportCatalog';

const ADMIN = { role: 'ADMIN' } as const;
const STAFF = { role: 'STAFF' } as const;
const FINANCE_STAFF = { role: 'STAFF', staffRole: 'FINANCE' } as const;
const TICKETING_STAFF = { role: 'STAFF', staffRole: 'TICKETING' } as const;
const AGENT = { role: 'AGENT' } as const;
const CUSTOMER = { role: 'CUSTOMER' } as const;

function entryById(id: string): ExportEntry {
  const found = EXPORT_ENTRIES.find((e) => e.id === id);
  if (!found) throw new Error(`目录里没有 ${id}`);
  return found;
}

describe('目录自身的完整性', () => {
  it('登记了全部 18 个导出端点，id 不重复', () => {
    expect(EXPORT_ENTRIES).toHaveLength(18);
    const ids = EXPORT_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条都落在已声明的分组里，且都写了口径说明与原按钮位置', () => {
    const groupKeys = new Set(EXPORT_GROUPS.map((g) => g.key));
    for (const e of EXPORT_ENTRIES) {
      expect(groupKeys.has(e.group)).toBe(true);
      expect(e.desc.length).toBeGreaterThan(0);
      expect(e.origin.length).toBeGreaterThan(0);
      expect(e.endpoint.length).toBeGreaterThan(0);
    }
  });

  it('需要先勾选订单 / 按单出的 4 条只给跳转，不给参数控件', () => {
    const jumpIds = EXPORT_ENTRIES.filter((e) => e.jumpTo).map((e) => e.id).sort();
    expect(jumpIds).toEqual(
      ['order-passports', 'order-pnr', 'visa-passports', 'visa-roster'].sort(),
    );
    for (const e of EXPORT_ENTRIES) {
      if (e.jumpTo) expect(e.param).toBe('none');
    }
  });
});

describe('canAccessExport', () => {
  it('代理只看得到三模板 / 全岗总表 / 进单统计这三条', () => {
    const agentVisible = visibleExportEntries(AGENT).map((e) => e.id).sort();
    expect(agentVisible).toEqual(['orders-intake', 'orders-master', 'orders-templates'].sort());
  });

  it('代理可见的三条都写明了代理版裁列说明', () => {
    for (const e of visibleExportEntries(AGENT)) {
      expect(e.agentNote && e.agentNote.length > 0).toBe(true);
    }
  });

  it('明确禁代理的导出（整班机 / 分房表 / 签证名单 / 护照包）对代理不可见', () => {
    for (const id of [
      'orders-by-schedule',
      'room-allocation',
      'visa-roster',
      'visa-passports',
      'order-passports',
    ]) {
      expect(canAccessExport(entryById(id), AGENT)).toBe(false);
    }
  });

  it('财务类导出：ADMIN 与财务岗 STAFF 可见，其它岗 STAFF 不可见', () => {
    const financeOnly = entryById('finance-master');
    expect(canAccessExport(financeOnly, ADMIN)).toBe(true);
    expect(canAccessExport(financeOnly, FINANCE_STAFF)).toBe(true);
    expect(canAccessExport(financeOnly, TICKETING_STAFF)).toBe(false);
    // staffRole 还没从 /users/me 回来时按「不是财务岗」处理：少给入口，不谎报权限
    expect(canAccessExport(financeOnly, STAFF)).toBe(false);
    expect(canAccessExport(financeOnly, AGENT)).toBe(false);
  });

  it('CUSTOMER 一条都看不到', () => {
    expect(visibleExportEntries(CUSTOMER)).toEqual([]);
  });

  it('通用运营岗 STAFF 看得到除财务类以外的全部', () => {
    const ids = visibleExportEntries(STAFF).map((e) => e.id);
    expect(ids).toContain('roster-template');
    expect(ids).toContain('no-show-report');
    expect(ids).not.toContain('reports');
    expect(ids).not.toContain('finance-by-flight');
  });
});

describe('groupExportEntries', () => {
  it('ADMIN 看到全部 7 个分组，顺序与 EXPORT_GROUPS 一致', () => {
    const groups = groupExportEntries(ADMIN);
    expect(groups.map((g) => g.key)).toEqual(EXPORT_GROUPS.map((g) => g.key));
    expect(groups.reduce((n, g) => n + g.entries.length, 0)).toBe(EXPORT_ENTRIES.length);
  });

  it('代理只剩票务一组，空分组不返回（不出空标题）', () => {
    const groups = groupExportEntries(AGENT);
    expect(groups.map((g) => g.key)).toEqual(['ticketing']);
    expect(groups[0].entries).toHaveLength(3);
  });

  it('通用运营岗看不到财务组（该组三条全是财务类）', () => {
    expect(groupExportEntries(STAFF).map((g) => g.key)).not.toContain('finance');
    expect(groupExportEntries(FINANCE_STAFF).map((g) => g.key)).toContain('finance');
  });
});

describe('最近导出记录', () => {
  const sample = (n: number): RecentExport => ({
    id: 'orders-master',
    name: '全岗总表',
    filename: `全岗总表_${n}.xlsx`,
    summary: '出行 2026-09-01 ~ 2026-09-30',
    at: '2026-09-05T10:00:00.000Z',
  });

  it('新记录排最前', () => {
    const list = appendRecentExport([sample(1)], sample(2));
    expect(list.map((r) => r.filename)).toEqual(['全岗总表_2.xlsx', '全岗总表_1.xlsx']);
  });

  it('不改原数组（不可变）', () => {
    const original = [sample(1)];
    appendRecentExport(original, sample(2));
    expect(original).toHaveLength(1);
  });

  it('超过上限截断，只留最新的 20 条', () => {
    let list: RecentExport[] = [];
    for (let i = 0; i < 25; i += 1) list = appendRecentExport(list, sample(i));
    expect(list).toHaveLength(RECENT_EXPORTS_LIMIT);
    expect(list[0].filename).toBe('全岗总表_24.xlsx');
    expect(list[RECENT_EXPORTS_LIMIT - 1].filename).toBe('全岗总表_5.xlsx');
  });

  it('parseRecentExports：空 / 非 JSON / 非数组 一律回空数组', () => {
    expect(parseRecentExports(null)).toEqual([]);
    expect(parseRecentExports('')).toEqual([]);
    expect(parseRecentExports('{oops')).toEqual([]);
    expect(parseRecentExports('{"a":1}')).toEqual([]);
  });

  it('parseRecentExports：结构不对的条目被剔除，合法的保留', () => {
    const raw = JSON.stringify([sample(1), { id: 'x' }, null, 42, sample(2)]);
    const parsed = parseRecentExports(raw);
    expect(parsed.map((r) => r.filename)).toEqual(['全岗总表_1.xlsx', '全岗总表_2.xlsx']);
  });

  it('parseRecentExports：存超了也只读回上限条数', () => {
    const raw = JSON.stringify(Array.from({ length: 40 }, (_, i) => sample(i)));
    expect(parseRecentExports(raw)).toHaveLength(RECENT_EXPORTS_LIMIT);
  });
});
