import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, todayYmd, WINDOW_DAYS, windowDays } from './settlementCalendar';

afterEach(() => {
  vi.useRealTimers();
});

describe('settlementCalendar 日期窗口', () => {
  it('todayYmd 返回本地 YYYY-MM-DD 格式', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 10, 15, 23, 45));
    const value = todayYmd();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(value).toBe('2026-08-10');
  });

  it('todayYmd 年份不足四位时补零', () => {
    vi.useFakeTimers();
    const fixed = new Date(0);
    fixed.setFullYear(42, 7, 10);
    fixed.setHours(15, 23, 45, 0);
    vi.setSystemTime(fixed);
    expect(todayYmd()).toBe('0042-08-10');
  });

  it('windowDays 跨月连续展开 31 天', () => {
    const days = windowDays('2026-08-10', WINDOW_DAYS);
    expect(days).toHaveLength(WINDOW_DAYS);
    expect(days[0]).toBe('2026-08-10');
    expect(days.at(-1)).toBe('2026-09-09');
  });

  it('windowDays 跨年连续展开', () => {
    expect(windowDays('2026-12-30', 4)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('addDays 跨月和跨年移动日期', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('addDays 非法日期或步长返回空串', () => {
    expect(addDays('2026-02-30', 1)).toBe('');
    expect(addDays('not-a-date', 1)).toBe('');
    expect(addDays('2026-08-10', 1.5)).toBe('');
  });

  it('windowDays 非法日期或数量返回空数组', () => {
    expect(windowDays('2026-02-30', 3)).toEqual([]);
    expect(windowDays('2026-13-01', 3)).toEqual([]);
    expect(windowDays('not-a-date', 3)).toEqual([]);
    expect(windowDays('2026-08-10', 0)).toEqual([]);
    expect(windowDays('2026-08-10', -1)).toEqual([]);
    expect(windowDays('2026-08-10', 1.5)).toEqual([]);
  });
});
