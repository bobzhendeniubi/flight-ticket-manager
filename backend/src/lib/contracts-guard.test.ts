/**
 * 契约包的守卫测试 —— 防止「又在后端手写一份 schema」。
 *
 * 背景：请求体 / 查询参数的 zod schema 已经全部搬进 @ftm/contracts，后端各模块的
 * *.schemas.ts 只剩一行 re-export。这个搬迁一旦没人看着，下一个新模块照旧会在后端
 * 自己写一份、前端照旧手抄一份类型，几个月后又是「老标签页撞新后端」。
 *
 * 所以立两道闸：
 *
 *   1. **模块 schema 文件必须是纯壳**。任何 modules/xxx/*.schemas.ts 只允许
 *      `export * from '@ftm/contracts/…'`，不许再长出定义。
 *
 *   2. **routes 里内联 schema 只减不增**（棘轮）。现状是 19 个 routes 文件里还有 56 处
 *      内联 z.object —— 多半是一次性的小入参（`{ disabled: boolean }` 这种），本轮没搬。
 *      基线冻在下面：数字变大就红，逼新入参去契约包里定义；数字变小也红，提示把基线
 *      一起改小，免得棘轮锈住。
 *
 * 两道闸都是静态文本检查，不 import 被测文件 —— 守的是「代码长什么样」，不是运行时行为。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULES_DIR = path.resolve(fileURLToPath(new URL('../modules', import.meta.url)));

/**
 * routes 文件里内联 zod 对象的基线（文件 → 处数）。
 *
 * 加新端点时**不要**往这张表里加数字：请求体请定义在 packages/contracts/src/<module>.ts，
 * routes 里 import 过来用。这张表只该往下走。
 */
const INLINE_SCHEMA_BASELINE: Record<string, number> = {
  'agent-statements/agent-statements.routes.ts': 1,
  'agents/agents.routes.ts': 1,
  'ai/ai.routes.ts': 1,
  'auth/auth.routes.ts': 1,
  'cancellation/cancellation.routes.ts': 2,
  'dashboard/dashboard.routes.ts': 2,
  'finances/finances.routes.ts': 13,
  'invoices/invoices.routes.ts': 4,
  'legacy/legacy.routes.ts': 3,
  'ocr/ocr.routes.ts': 1,
  'orders/order-cost-items.routes.ts': 1,
  'orders/orders.routes.ts': 6,
  'payments/payments.routes.ts': 5,
  'public/public.routes.ts': 1,
  'reports/reports.routes.ts': 2,
  'settings/settings.routes.ts': 2,
  'supplier-payables/supplier-invoices.routes.ts': 5,
  'supplier-payables/suppliers.routes.ts': 3,
  'users/users.routes.ts': 2,
};

/** 收集 modules 下匹配后缀的文件，返回相对 modules 目录的路径。 */
function collect(suffix: string): string[] {
  const found: string[] = [];
  for (const moduleName of fs.readdirSync(MODULES_DIR)) {
    const dir = path.join(MODULES_DIR, moduleName);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(suffix)) found.push(`${moduleName}/${file}`);
    }
  }
  return found.sort();
}

const read = (rel: string) => fs.readFileSync(path.join(MODULES_DIR, rel), 'utf8');

/** 去掉块注释、行注释与空行，只留真正的代码。 */
function codeOnly(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean);
}

describe('契约守卫 · 请求 schema 只许长在 @ftm/contracts 里', () => {
  const schemaFiles = collect('.schemas.ts');

  it('模块里确实还有 schema 文件（收集逻辑没失效）', () => {
    expect(schemaFiles.length).toBeGreaterThan(20);
  });

  for (const rel of schemaFiles) {
    it(`${rel} 是纯 re-export 壳，没有自己的定义`, () => {
      const lines = codeOnly(read(rel));
      expect(lines, `${rel} 空了？`).not.toHaveLength(0);
      for (const line of lines) {
        expect(
          line,
          `${rel} 里出现了非 re-export 的代码：\n  ${line}\n` +
            '请求体 / 查询参数请定义在 packages/contracts/src/<module>.ts，这里只留 export *。',
        ).toMatch(/^export \* from '@ftm\/contracts\/[a-z0-9-]+';$/);
      }
    });
  }
});

describe('契约守卫 · routes 内联 schema 棘轮（只减不增）', () => {
  const routeFiles = collect('.routes.ts');

  it('收集到的 routes 文件不是空的', () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  for (const rel of routeFiles) {
    const baseline = INLINE_SCHEMA_BASELINE[rel] ?? 0;
    it(`${rel} 内联 zod 对象不超过基线 ${baseline}`, () => {
      const actual = (read(rel).match(/z\.object\(/g) ?? []).length;
      expect(
        actual,
        actual > baseline
          ? `${rel} 新增了内联请求 schema（${baseline} → ${actual}）。\n` +
              '请把它定义在 packages/contracts/src/<module>.ts 里，routes 从那儿 import —— ' +
              '在后端就地手写，前端只能照着抄一遍，这正是要消灭的那条缝。'
          : `${rel} 的内联 schema 少了（${baseline} → ${actual}），是好事：` +
              '把 contracts-guard.test.ts 里的基线一起改小，棘轮才不会锈住。',
      ).toBe(baseline);
    });
  }

  it('基线表里没有已经不存在的文件（搬走 / 改名后要清理）', () => {
    const stale = Object.keys(INLINE_SCHEMA_BASELINE).filter((rel) => !routeFiles.includes(rel));
    expect(stale, `基线表里这些 routes 文件已经不在了：${stale.join(', ')}`).toEqual([]);
  });
});
