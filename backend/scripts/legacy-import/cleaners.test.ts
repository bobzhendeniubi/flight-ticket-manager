import { describe, expect, it } from 'vitest';
import {
  cleanDate,
  cleanGender,
  cleanMoney,
  cleanRemark,
  cleanPassengerType,
} from './cleaners.js';

describe('legacy cleaners', () => {
  it('parses legacy date formats and records quality issues', () => {
    expect(cleanDate('24-08-2026', 'birth').value?.toISOString()).toBe('2026-08-24T00:00:00.000Z');
    expect(cleanDate('2026-08-24', 'birth').value?.toISOString()).toBe('2026-08-24T00:00:00.000Z');
    const excel = cleanDate('45986', 'birth');
    expect(excel.value?.toISOString()).toBe('2025-11-25T00:00:00.000Z');
    expect(excel.issues).toContain('birth:excel-serial');
    expect(cleanDate('1982', 'birth')).toEqual({ value: null, issues: ['birth:invalid'] });
    expect(cleanDate('24-08-2026\t', 'expiry').issues).toContain('expiry:trimmed');
    expect(cleanDate('10.1982', 'birth')).toEqual({ value: null, issues: ['birth:invalid'] });
  });

  it('cleans money without accepting arbitrary strings', () => {
    expect(cleanMoney('', 'finalPrice').value).toBeNull();
    expect(cleanMoney('-12.50', 'finalPrice').value).toBe('-12.50');
    expect(cleanMoney('12.5', 'finalPrice').value).toBe('12.5');
    expect(cleanMoney('12 CNY', 'finalPrice').issues).toContain('finalPrice:invalid');
  });

  it('normalizes gender and fills it from a title', () => {
    expect(cleanGender('', 'mr')).toBe('M');
    expect(cleanGender(null, 'MS')).toBe('F');
    expect(cleanGender(' f ', 'MR')).toBe('F');
    expect(cleanGender('', '')).toBeNull();
    expect(cleanPassengerType('')).toBe('ADULT');
  });

  it('scrubs injected patterns while retaining ordinary remarks', () => {
    expect(cleanRemark('客户要求靠窗；虚构同事甲跟进', [/虚构同事甲/gu])).toBe('客户要求靠窗；[内部]跟进');
    expect(cleanRemark('客户要求靠窗；虚构同事甲跟进')).toBe('客户要求靠窗；虚构同事甲跟进');
    expect(cleanRemark('客户要求靠窗；测试甲跟进')).toBe('客户要求靠窗；测试甲跟进');
    expect(cleanRemark('')).toBeNull();
  });

  it('protects a longer customer name before scrubbing a shorter injected token', () => {
    expect(cleanRemark('客户张示例例已确认；示例另行备注', [/示例/gu], ['张示例例']))
      .toBe('客户张示例例已确认；[内部]另行备注');
  });

  it('does not treat a token already present in the remark as a placeholder', () => {
    const existingToken = '\u0000legacy-protected-0\u0000';
    expect(cleanRemark(`原文${existingToken}；张示例例`, [/示例/gu], ['张示例例']))
      .toBe(`原文${existingToken}；张示例例`);
  });
});
