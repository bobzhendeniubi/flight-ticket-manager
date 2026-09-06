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

  it('对象里的 undefined 键被丢掉（与 JSON.stringify 同口径）', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('顶层 undefined 已经不是合法入参：能返回 undefined 的指纹，比对起来永远判不相等', () => {
    // @ts-expect-error 入参收窄到「JSON.stringify 一定给得出字符串」的那些值（排除顶层 undefined）
    expect(canonicalJson(undefined)).toBeUndefined();
  });

  // C-28：Date 实例没有自有可枚举属性，不特殊处理会被静默序列化成 {}，
  // 两个不同的 Date 会被判成同一份指纹——这里验证已按 toISOString() 兜底，不再折叠成空对象。
  it('Date 实例序列化成 ISO 字符串，而不是折叠成 {}', () => {
    const d = new Date('2026-09-05T12:00:00.000Z');
    expect(canonicalJson(d)).toBe(JSON.stringify(d.toISOString()));
    expect(canonicalJson(d)).not.toBe('{}');
  });

  it('嵌套在对象里的不同 Date 值判不同（此前会因折叠成 {} 而被误判相同）', () => {
    const a = { at: new Date('2026-09-05T00:00:00.000Z') };
    const b = { at: new Date('2026-09-06T00:00:00.000Z') };
    expect(canonicalJson(a)).not.toBe(canonicalJson(b));
  });

  it('相同 Date 值（不同实例）判相同', () => {
    const a = { at: new Date('2026-09-05T00:00:00.000Z') };
    const b = { at: new Date('2026-09-05T00:00:00.000Z') };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});
