import { describe, it, expect } from 'vitest';

import { localDateISO, localHHMM, localDateTime, localToUtc } from './flight-time.js';

describe('flight-time · UTC → 当地钟点', () => {
  it('澳门 +8：08:40Z 的班次当地是 16:40（公测反馈里显示成 08:40 的那一条）', () => {
    const dep = new Date('2026-09-01T08:40:00.000Z');
    expect(localHHMM(dep, 'Asia/Macau')).toBe('16:40');
    expect(localDateISO(dep, 'Asia/Macau')).toBe('2026-09-01');
    expect(localDateTime(dep, 'Asia/Macau')).toBe('2026-09-01 16:40');
  });

  it('越南 +7：同一瞬间比澳门早一小时', () => {
    const dep = new Date('2026-09-01T08:40:00.000Z');
    expect(localHHMM(dep, 'Asia/Ho_Chi_Minh')).toBe('15:40');
  });

  it('跨 UTC 日边界：当地凌晨 00:30 起飞，UTC 还是前一天', () => {
    const dep = new Date('2026-09-01T16:30:00.000Z'); // 澳门 2026-09-02 00:30
    expect(localHHMM(dep, 'Asia/Macau')).toBe('00:30');
    expect(localDateISO(dep, 'Asia/Macau')).toBe('2026-09-02');
    // 直接切 ISO 串会得到 2026-09-01 / 16:30——这正是被修掉的旧口径
    expect(dep.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('当地正午 12:00 不会被误判成 24 小时制边界', () => {
    expect(localHHMM(new Date('2026-09-01T04:00:00.000Z'), 'Asia/Macau')).toBe('12:00');
  });

  it('当地午夜 00:00 折算成 00:00 而非 24:00', () => {
    expect(localHHMM(new Date('2026-08-31T16:00:00.000Z'), 'Asia/Macau')).toBe('00:00');
  });

  it('时区串不识别 → 回退 UTC，不抛错', () => {
    const dep = new Date('2026-09-01T08:40:00.000Z');
    expect(localHHMM(dep, 'Not/AZone')).toBe('08:40');
    expect(localDateISO(dep, 'Not/AZone')).toBe('2026-09-01');
  });
});

describe('flight-time · 当地钟点 → UTC（批量改时刻落库口径）', () => {
  it('澳门当地 16:40 → 08:40Z', () => {
    expect(localToUtc('2026-09-01', '16:40', 'Asia/Macau').toISOString()).toBe(
      '2026-09-01T08:40:00.000Z',
    );
  });

  it('越南当地 16:40 → 09:40Z', () => {
    expect(localToUtc('2026-09-01', '16:40', 'Asia/Ho_Chi_Minh').toISOString()).toBe(
      '2026-09-01T09:40:00.000Z',
    );
  });

  it('当地凌晨 00:30 → UTC 落在前一天', () => {
    expect(localToUtc('2026-09-02', '00:30', 'Asia/Macau').toISOString()).toBe(
      '2026-09-01T16:30:00.000Z',
    );
  });

  it('与正向折算互为逆运算（往返一圈回到原值）', () => {
    for (const hhmm of ['00:00', '06:15', '12:00', '16:40', '23:59']) {
      const utc = localToUtc('2026-09-01', hhmm, 'Asia/Macau');
      expect(localHHMM(utc, 'Asia/Macau')).toBe(hhmm);
      expect(localDateISO(utc, 'Asia/Macau')).toBe('2026-09-01');
    }
  });

  it('时刻串解析不出来 → 抛错，不静默落一个 Invalid Date 进库', () => {
    expect(() => localToUtc('2026-09-01', 'abc', 'Asia/Macau')).toThrow();
    expect(() => localToUtc('', '16:40', 'Asia/Macau')).toThrow();
  });
});

describe('flight-time · tz 缺失时的兜底（调用方未联查 departureTz）', () => {
  it('tz 为空 → 按 UTC 折，绝不落到运行环境的默认时区', () => {
    const d = new Date('2026-07-10T00:00:00.000Z');
    for (const tz of [null, undefined, '']) {
      expect(localDateISO(d, tz)).toBe('2026-07-10');
      expect(localHHMM(d, tz)).toBe('00:00');
      expect(localDateTime(d, tz)).toBe('2026-07-10 00:00');
    }
  });
});
