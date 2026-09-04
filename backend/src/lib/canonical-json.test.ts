import { describe, it, expect } from 'vitest';
import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it('对象键序打乱后得到同一个串', () => {
    const a = { orderItemId: 'leg-out', newScheduleId: 'sch-new', newCabin: null, feeCny: 300 };
    const b = { feeCny: 300, newCabin: null, newScheduleId: 'sch-new', orderItemId: 'leg-out' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('值不同仍然判不同', () => {
    expect(canonicalJson({ a: 1, b: 2 })).not.toBe(canonicalJson({ b: 2, a: 3 }));
  });

  it('数组保序（顺序不同 = 不同）', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
    expect(canonicalJson([1, 2, 3])).toBe(canonicalJson([1, 2, 3]));
  });

  it('嵌套对象逐层排序', () => {
    const a = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const b = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('数组里的对象也逐个排序，但数组本身不重排', () => {
    const a = [{ x: 1, y: 2 }, { p: 3 }];
    const b = [{ y: 2, x: 1 }, { p: 3 }];
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson([{ x: 1 }, { p: 3 }])).not.toBe(canonicalJson([{ p: 3 }, { x: 1 }]));
  });

  it('null / 数字 / 字符串 / 布尔照常', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(1)).toBe('1');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(false)).toBe('false');
  });

  it('undefined 与 JSON.stringify 同口径：顶层 undefined、对象里的 undefined 键都被丢掉', () => {
    expect(canonicalJson(undefined)).toBe(JSON.stringify(undefined));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});
