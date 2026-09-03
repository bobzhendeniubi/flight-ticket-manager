/**
 * 关柜时刻工具 · 单元测试
 *
 * 覆盖：
 *   1. resolveCheckinCloseMinutes：班次配了用班次的；null/undefined/负数/非有限值回落系统默认
 *   2. checkinCloseAt：关柜时刻 = 起飞时刻 − 生效分钟数（真 UTC 瞬间，不折时区）
 *   3. isCheckinClosed：关柜前 false / 刚好到点 true / 关柜后 true
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHECKIN_CLOSE_MINUTES,
  checkinCloseAt,
  isCheckinClosed,
  resolveCheckinCloseMinutes,
} from './checkin-close.js';

const DEP = new Date('2026-09-10T07:40:00.000Z');

describe('resolveCheckinCloseMinutes', () => {
  it('班次配了 → 用班次自己的值', () => {
    expect(resolveCheckinCloseMinutes(90)).toBe(90);
    expect(resolveCheckinCloseMinutes(0)).toBe(0);
  });

  it('没配（null / undefined）→ 系统默认 45', () => {
    expect(resolveCheckinCloseMinutes(null)).toBe(DEFAULT_CHECKIN_CLOSE_MINUTES);
    expect(resolveCheckinCloseMinutes(undefined)).toBe(DEFAULT_CHECKIN_CLOSE_MINUTES);
    expect(DEFAULT_CHECKIN_CLOSE_MINUTES).toBe(45);
  });

  // 脏数据不该把关柜时刻推到起飞之后 —— 那比旧的「起飞才能标」口径还晚
  it('负数 / NaN / Infinity → 当成没配，回落默认', () => {
    expect(resolveCheckinCloseMinutes(-30)).toBe(DEFAULT_CHECKIN_CLOSE_MINUTES);
    expect(resolveCheckinCloseMinutes(Number.NaN)).toBe(DEFAULT_CHECKIN_CLOSE_MINUTES);
    expect(resolveCheckinCloseMinutes(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_CHECKIN_CLOSE_MINUTES,
    );
  });
});

describe('checkinCloseAt', () => {
  it('默认 45 分钟 → 07:40 起飞的班次 06:55 关柜（UTC 瞬间，不折时区）', () => {
    expect(checkinCloseAt(DEP, null).toISOString()).toBe('2026-09-10T06:55:00.000Z');
  });

  it('班次自配 90 分钟 → 06:10 关柜', () => {
    expect(checkinCloseAt(DEP, 90).toISOString()).toBe('2026-09-10T06:10:00.000Z');
  });

  it('配 0 分钟 → 关柜时刻就是起飞时刻（等价于旧口径）', () => {
    expect(checkinCloseAt(DEP, 0).getTime()).toBe(DEP.getTime());
  });
});

describe('isCheckinClosed', () => {
  const closeAt = new Date('2026-09-10T06:55:00.000Z').getTime();

  it('关柜前一分钟 → 还没关', () => {
    expect(isCheckinClosed(DEP, null, closeAt - 60_000)).toBe(false);
  });

  it('刚好到关柜点 → 算已关（含等号）', () => {
    expect(isCheckinClosed(DEP, null, closeAt)).toBe(true);
  });

  it('关柜后、起飞前的那 44 分钟里 → 已关柜，可标 no-show', () => {
    expect(isCheckinClosed(DEP, null, DEP.getTime() - 60_000)).toBe(true);
  });

  it('起飞后 → 当然已关柜', () => {
    expect(isCheckinClosed(DEP, null, DEP.getTime() + 3600_000)).toBe(true);
  });
});
