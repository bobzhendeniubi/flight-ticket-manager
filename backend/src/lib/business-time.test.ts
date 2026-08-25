import { describe, expect, it } from 'vitest';

import { BUSINESS_TZ, businessDateISO, startOfBusinessDayUtc } from './business-time.js';

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
