import { describe, it, expect } from 'vitest';
import { readExplicitRoomCount } from './room-count.js';

describe('readExplicitRoomCount', () => {
  it('数字（含 0 与半间）就是显式提供', () => {
    expect(readExplicitRoomCount(0)).toBe(0);
    expect(readExplicitRoomCount(1)).toBe(1);
    expect(readExplicitRoomCount(0.5)).toBe(0.5);
    expect(readExplicitRoomCount(2.5)).toBe(2.5);
  });

  it('纯数字字符串按数字读（历史 metadata 里存过字符串）', () => {
    expect(readExplicitRoomCount('0')).toBe(0);
    expect(readExplicitRoomCount('2')).toBe(2);
    expect(readExplicitRoomCount('0.5')).toBe(0.5);
  });

  // ↓ 这几个正是 Number(x) === 0 的陷阱：脏元数据会被当成「明确 0 间」
  it('空字符串不是 0 间，是「没填」', () => {
    expect(readExplicitRoomCount('')).toBeNull();
    expect(readExplicitRoomCount('   ')).toBeNull();
  });

  it('布尔不是 0 间，是「没填」', () => {
    expect(readExplicitRoomCount(false)).toBeNull();
    expect(readExplicitRoomCount(true)).toBeNull();
  });

  it('空数组不是 0 间，是「没填」', () => {
    expect(readExplicitRoomCount([])).toBeNull();
    expect(readExplicitRoomCount([1])).toBeNull();
  });

  it('非数字字符串 → 没填', () => {
    expect(readExplicitRoomCount('abc')).toBeNull();
    expect(readExplicitRoomCount('1间')).toBeNull();
    expect(readExplicitRoomCount('1e3')).toBeNull();
  });

  it('负数不是合法房量 → 没填', () => {
    expect(readExplicitRoomCount(-1)).toBeNull();
    expect(readExplicitRoomCount('-1')).toBeNull();
  });

  it('NaN / Infinity / null / undefined / 对象 → 没填', () => {
    expect(readExplicitRoomCount(Number.NaN)).toBeNull();
    expect(readExplicitRoomCount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(readExplicitRoomCount(null)).toBeNull();
    expect(readExplicitRoomCount(undefined)).toBeNull();
    expect(readExplicitRoomCount({})).toBeNull();
    expect(readExplicitRoomCount({ rooms: 1 })).toBeNull();
  });
});
