/**
 * travelers.schemas 单测（vitest，纯 zod，不接 prisma）。
 *
 * 覆盖 listTravelerProfilesQuerySchema.search 的 LOW 修复：
 *   - 旧上限是总长 120——13 个九位护照号加换行就有 129 字符，会被老上限拒掉；
 *     新上限 2000 应该放行这种正常多人搜索输入。
 *   - 真正防滥用改靠 term 数上限（≤50）：51 个 term 应该被拒，且报错文案说清「一次最多 50 个」。
 */
import { describe, it, expect } from 'vitest';
import { listTravelerProfilesQuerySchema } from './travelers.schemas.js';

describe('listTravelerProfilesQuerySchema.search', () => {
  it('放行 120+ 字符的多行搜索（13 个九位护照号 + 换行 = 129 字符）', () => {
    const passports = Array.from({ length: 13 }, (_, i) => `E${String(100000000 + i)}`);
    const raw = passports.join('\n');
    expect(raw.length).toBeGreaterThan(120);

    const result = listTravelerProfilesQuerySchema.safeParse({ search: raw });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.search).toBe(raw);
    }
  });

  it('拒绝超过 50 个 term 的搜索，报错文案说清上限', () => {
    const terms = Array.from({ length: 51 }, (_, i) => `E${String(100000000 + i)}`);
    const raw = terms.join('\n');

    const result = listTravelerProfilesQuerySchema.safeParse({ search: raw });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(';');
      expect(message).toContain('一次最多搜索 50 个');
    }
  });

  it('50 个 term（边界值）仍然放行', () => {
    const terms = Array.from({ length: 50 }, (_, i) => `E${String(100000000 + i)}`);
    const raw = terms.join('\n');

    const result = listTravelerProfilesQuerySchema.safeParse({ search: raw });
    expect(result.success).toBe(true);
  });

  it('不传 search（可选字段）直接放行', () => {
    const result = listTravelerProfilesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
