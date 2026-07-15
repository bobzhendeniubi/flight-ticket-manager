import { describe, it, expect } from 'vitest';
import { parseTd3Mrz } from './mrz.js';

/**
 * ICAO Doc 9303 官方 TD3 样例。
 * Line1 用 padEnd 补足 44 位填充符，避免手数填充位出错。
 */
const SAMPLE_LINE1 = 'P<UTOERIKSSON<<ANNA<MARIA'.padEnd(44, '<');
const SAMPLE_LINE2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';

describe('parseTd3Mrz — ICAO 官方样例', () => {
  it('解析字段并且所有校验位通过', () => {
    const r = parseTd3Mrz(SAMPLE_LINE1, SAMPLE_LINE2);
    expect(r).not.toBeNull();
    expect(r!.valid).toBe(true);
    expect(r!.surname).toBe('ERIKSSON');
    expect(r!.givenNames).toBe('ANNA MARIA');
    expect(r!.passportNumber).toBe('L898902C3');
    expect(r!.nationality).toBe('UTO');
    expect(r!.dateOfBirth).toBe('1974-08-12'); // 74 > 当前两位年 → 19xx
    expect(r!.sex).toBe('F');
    expect(r!.expiryDate).toBe('2012-04-15'); // 有效期一律 20xx
    expect(r!.checks).toEqual({
      passportNumber: true,
      dateOfBirth: true,
      expiryDate: true,
      personalNumber: true,
      composite: true,
    });
  });

  it('篡改护照号一位后校验失败（valid:false）', () => {
    // 把护照号第 9 位 '3' 改成 '4'，不改校验位 → passportNumber 校验失败
    const tampered = 'L898902C4' + SAMPLE_LINE2.slice(9);
    const r = parseTd3Mrz(SAMPLE_LINE1, tampered);
    expect(r).not.toBeNull();
    expect(r!.valid).toBe(false);
    expect(r!.checks.passportNumber).toBe(false);
  });

  it('篡改出生日期一位后 birth 校验失败', () => {
    // 出生日期段 740812(14-19) 改成 750812，不改校验位
    const tampered =
      SAMPLE_LINE2.slice(0, 13) + '750812' + SAMPLE_LINE2.slice(19);
    const r = parseTd3Mrz(SAMPLE_LINE1, tampered);
    expect(r!.valid).toBe(false);
    expect(r!.checks.dateOfBirth).toBe(false);
  });
});

describe('parseTd3Mrz — 容错', () => {
  it('行长非 44 返回 null', () => {
    expect(parseTd3Mrz(SAMPLE_LINE1.slice(0, 43), SAMPLE_LINE2)).toBeNull();
    expect(parseTd3Mrz(SAMPLE_LINE1, SAMPLE_LINE2.slice(0, 40))).toBeNull();
  });

  it('含非法字符返回 null', () => {
    const illegal = SAMPLE_LINE2.slice(0, 43) + '!';
    expect(parseTd3Mrz(SAMPLE_LINE1, illegal)).toBeNull();
  });

  it('非字符串入参返回 null 而不抛错', () => {
    // @ts-expect-error 故意传非法类型验证不抛异常
    expect(parseTd3Mrz(null, undefined)).toBeNull();
  });

  it('出生年两位 > 当前两位年 → 19xx', () => {
    const r = parseTd3Mrz(SAMPLE_LINE1, SAMPLE_LINE2);
    expect(r!.dateOfBirth.startsWith('19')).toBe(true);
  });
});
