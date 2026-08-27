import { describe, expect, it } from 'vitest';

import {
  BUSINESS_TZ,
  businessDateISO,
  businessDateTime,
  businessDateTimeSec,
  startOfBusinessDayUtc,
} from './business-time.js';

describe('business-time · 上海业务日', () => {
  it('业务时区固定为 Asia/Shanghai', () => {
    expect(BUSINESS_TZ).toBe('Asia/Shanghai');
  });

  it('UTC 17:00 属于上海次日，业务日边界是前一日 16:00Z', () => {
    const now = new Date('2026-08-24T17:00:00.000Z');

    expect(businessDateISO(now)).toBe('2026-08-25');
    expect(startOfBusinessDayUtc(now).toISOString()).toBe('2026-08-24T16:00:00.000Z');
  });

  it('UTC 15:59 仍属于上海当日', () => {
    const now = new Date('2026-08-24T15:59:00.000Z');

    expect(businessDateISO(now)).toBe('2026-08-24');
    expect(startOfBusinessDayUtc(now).toISOString()).toBe('2026-08-23T16:00:00.000Z');
  });

  it('上海月初 00:00 对应 UTC 前一日 16:00', () => {
    const now = new Date('2026-07-31T16:00:00.000Z');

    expect(businessDateISO(now)).toBe('2026-08-01');
    expect(startOfBusinessDayUtc(now).toISOString()).toBe('2026-07-31T16:00:00.000Z');
  });
});

describe('business-time · 系统时间戳按北京时间输出', () => {
  it('上午录入：UTC 03:00 → 北京时间 11:00', () => {
    expect(businessDateTime(new Date('2026-08-26T03:00:00.000Z'))).toBe('2026-08-26 11:00');
  });

  it('跨日：UTC 20:00 → 北京时间次日 04:00，日期进位', () => {
    expect(businessDateTime(new Date('2026-07-08T20:00:00.000Z'))).toBe('2026-07-09 04:00');
    expect(businessDateTimeSec(new Date('2026-07-08T20:30:15.000Z'))).toBe('2026-07-09 04:30:15');
  });

  it('跨月跨年：UTC 12-31 16:00 → 北京时间次年 01-01 00:00', () => {
    expect(businessDateTimeSec(new Date('2026-12-31T16:00:00.000Z'))).toBe('2027-01-01 00:00:00');
  });

  it('含秒版比不含秒版只多一个秒字段（同一格式约定）', () => {
    const at = new Date('2026-08-26T03:04:05.000Z');

    expect(businessDateTime(at)).toBe('2026-08-26 11:04');
    expect(businessDateTimeSec(at)).toBe('2026-08-26 11:04:05');
  });

  it('空值 → 留空（不编造）', () => {
    expect(businessDateTime(null)).toBe('');
    expect(businessDateTime(undefined)).toBe('');
    expect(businessDateTimeSec(null)).toBe('');
  });
});
