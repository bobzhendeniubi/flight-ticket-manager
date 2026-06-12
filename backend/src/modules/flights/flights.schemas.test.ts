/**
 * 行李规则 upsert body 校验 · 纯 zod 单测（vitest）
 *
 * 口径：PUT 整体替换；同一舱等不可重复；kg/件数可分别留空（null/缺省都行）。
 */
import { describe, it, expect } from 'vitest';
import { upsertBaggagePoliciesBodySchema } from './flights.schemas.js';

describe('upsertBaggagePoliciesBodySchema', () => {
  it('接受完整配置（kg + 件数 + 手提 + 备注）', () => {
    const parsed = upsertBaggagePoliciesBodySchema.parse([
      { cabin: 'ECONOMY', checkedKg: 23, checkedPieces: 1, carryOnKg: 7, note: '超件 ¥200/件' },
      { cabin: 'BUSINESS', checkedKg: 32, checkedPieces: 2, carryOnKg: 10 },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].checkedKg).toBe(23);
    expect(parsed[1].note).toBeUndefined();
  });

  it('kg 与件数可分别留空（null 或缺省）', () => {
    const parsed = upsertBaggagePoliciesBodySchema.parse([
      { cabin: 'ECONOMY', checkedKg: null, checkedPieces: 2 },
      { cabin: 'FIRST', checkedKg: 40 },
    ]);
    expect(parsed[0].checkedKg).toBeNull();
    expect(parsed[0].checkedPieces).toBe(2);
    expect(parsed[1].checkedPieces).toBeUndefined();
  });

  it('接受空数组（清空全部规则）', () => {
    expect(upsertBaggagePoliciesBodySchema.parse([])).toEqual([]);
  });

  it('拒绝同一舱等重复', () => {
    const result = upsertBaggagePoliciesBodySchema.safeParse([
      { cabin: 'ECONOMY', checkedKg: 23 },
      { cabin: 'ECONOMY', checkedKg: 30 },
    ]);
    expect(result.success).toBe(false);
  });

  it('拒绝非法舱等 / 负数 / 非整数 kg', () => {
    expect(upsertBaggagePoliciesBodySchema.safeParse([{ cabin: 'DELUXE', checkedKg: 23 }]).success).toBe(false);
    expect(upsertBaggagePoliciesBodySchema.safeParse([{ cabin: 'ECONOMY', checkedKg: -1 }]).success).toBe(false);
    expect(upsertBaggagePoliciesBodySchema.safeParse([{ cabin: 'ECONOMY', checkedKg: 23.5 }]).success).toBe(false);
  });
});
