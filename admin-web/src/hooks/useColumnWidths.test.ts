import { describe, expect, it } from 'vitest';
import {
  clampColumnWidth,
  DEFAULT_MIN_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  parseStoredColumnWidths,
  serializeColumnWidths,
} from './useColumnWidths';

const DEFAULTS = { orderNumber: 150, customer: 160, content: 560 } as const;

describe('clampColumnWidth', () => {
  it('低于下限夹到下限，默认下限 48', () => {
    expect(clampColumnWidth(10)).toBe(DEFAULT_MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(-200)).toBe(48);
  });

  it('可传自定义下限', () => {
    expect(clampColumnWidth(60, 80)).toBe(80);
  });

  it('高于上限夹到上限，小数取整', () => {
    expect(clampColumnWidth(99999)).toBe(MAX_COLUMN_WIDTH);
    expect(clampColumnWidth(120.6)).toBe(121);
  });

  it('NaN / Infinity 回落到下限', () => {
    expect(clampColumnWidth(Number.NaN)).toBe(48);
    expect(clampColumnWidth(Number.POSITIVE_INFINITY)).toBe(48);
  });
});

describe('parseStoredColumnWidths', () => {
  it('没有存储时用默认值', () => {
    expect(parseStoredColumnWidths(null, DEFAULTS)).toEqual(DEFAULTS);
    expect(parseStoredColumnWidths('', DEFAULTS)).toEqual(DEFAULTS);
  });

  it('坏 JSON / 非对象 / 数组回落默认值', () => {
    expect(parseStoredColumnWidths('{oops', DEFAULTS)).toEqual(DEFAULTS);
    expect(parseStoredColumnWidths('42', DEFAULTS)).toEqual(DEFAULTS);
    expect(parseStoredColumnWidths('null', DEFAULTS)).toEqual(DEFAULTS);
    expect(parseStoredColumnWidths('[200,300]', DEFAULTS)).toEqual(DEFAULTS);
  });

  it('只覆盖存过的列，其余保持默认', () => {
    expect(parseStoredColumnWidths('{"content":720}', DEFAULTS)).toEqual({ ...DEFAULTS, content: 720 });
  });

  it('未知列（已下线的列名）被忽略，不会混进结果', () => {
    const got = parseStoredColumnWidths('{"removedColumn":300,"customer":200}', DEFAULTS);
    expect(got).toEqual({ ...DEFAULTS, customer: 200 });
    expect(Object.keys(got)).not.toContain('removedColumn');
  });

  it('非数字值被忽略，过窄的值夹到最小宽', () => {
    const got = parseStoredColumnWidths('{"orderNumber":"wide","customer":5,"content":null}', DEFAULTS);
    expect(got).toEqual({ ...DEFAULTS, customer: 48 });
  });

  it('按传入的最小宽夹', () => {
    expect(parseStoredColumnWidths('{"customer":50}', DEFAULTS, 64).customer).toBe(64);
  });
});

describe('serializeColumnWidths', () => {
  it('全是默认值时返回 null（调用方删键）', () => {
    expect(serializeColumnWidths(DEFAULTS, DEFAULTS)).toBeNull();
  });

  it('只写与默认不同的列，读回来与原值一致', () => {
    const widths = { ...DEFAULTS, content: 800 };
    const raw = serializeColumnWidths(widths, DEFAULTS);
    expect(raw).toBe('{"content":800}');
    expect(parseStoredColumnWidths(raw, DEFAULTS)).toEqual(widths);
  });
});
