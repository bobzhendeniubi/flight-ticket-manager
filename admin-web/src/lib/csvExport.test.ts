/**
 * csvExport · 导出正确性 + CSV 公式注入防护回归（全部使用合成数据）。
 *
 * 覆盖三件事：
 *   1. CSV injection：客户名/联系人/备注是用户可填字段，以 = + - @ 开头的值在 Excel/WPS/Numbers
 *      会被当**公式执行**。必须加前置单引号降级为纯文本，值本身不能丢。
 *   2. 金额列输出裸数字（不加 ¥、不加千分位），否则 Excel 读成文本、无法求和。
 *   3. 文件名日期用**本地日**：toISOString() 取的是 UTC 日，本地 00:00–08:00 导出会写成前一天。
 */
import { describe, it, expect } from 'vitest';
import { buildCSV, csvNumber, localDateStamp } from './csvExport';

interface Row {
  name: string;
  amount: number;
  note: string;
}

const COLS = [
  { key: 'name' as const, label: '客户' },
  { key: 'amount' as const, label: '应收(元)', format: csvNumber },
  { key: 'note' as const, label: '备注' },
];

/** 去掉 BOM 后按行拆，方便断言。 */
function lines(csv: string): string[] {
  return csv.replace(/^﻿/, '').split('\n');
}

describe('buildCSV · CSV 公式注入防护', () => {
  it('给以 = 开头的用户可填字段加前置单引号，Excel 不再当公式执行', () => {
    // Arrange
    const rows: Row[] = [{ name: '=cmd|/C calc!A1', amount: 100, note: '' }];

    // Act
    const out = lines(buildCSV(rows, COLS));

    // Assert
    expect(out[1].startsWith("'=cmd")).toBe(true);
    expect(out[1]).not.toMatch(/^=/);
  });

  it.each(['+1+1', '-2+3', '@SUM(A1:A9)', '\tHIDDEN', '\rHIDDEN'])(
    '同样拦下以 %j 开头的值',
    (payload) => {
      const out = lines(buildCSV([{ name: payload, amount: 1, note: '' }], COLS));
      const firstCell = out[1].split(',')[0];
      expect(firstCell.startsWith("'")).toBe(true);
      // 值本身不丢：加了引号前缀后原文仍在
      expect(firstCell).toContain(payload);
    },
  );

  it('普通中文姓名不受影响，不会平白多出引号', () => {
    const out = lines(buildCSV([{ name: '张三', amount: 1, note: '' }], COLS));
    expect(out[1].split(',')[0]).toBe('张三');
  });

  it('负数金额被当成潜在公式加引号（安全兜底，非回归）', () => {
    // -50 是合法的退款/多付金额，csvNumber 输出 "-50"，仍以 - 开头 → 被加引号保护。
    // 这是有意的取舍：Excel 里 '-50 显示为 -50 文本。若将来要保留可求和的负数金额，
    // 应改用 xlsx 导出（后端三模板导出已是 xlsx），而不是放宽这条防护。
    const out = lines(buildCSV([{ name: 'A', amount: -50, note: '' }], COLS));
    expect(out[1].split(',')[1]).toBe("'-50");
  });

  it('含逗号/引号/换行的值仍走标准 CSV 引号包裹 + 引号翻倍', () => {
    const out = buildCSV([{ name: 'A', amount: 1, note: '备注,含"引号"' }], COLS);
    expect(out).toContain('"备注,含""引号"""');
  });

  it('表头与行数正确，且带 UTF-8 BOM', () => {
    const csv = buildCSV([{ name: 'A', amount: 1, note: 'x' }], COLS);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines(csv)[0]).toBe('客户,应收(元),备注');
    expect(lines(csv)).toHaveLength(2);
  });
});

describe('csvNumber · 金额列可求和', () => {
  it('输出裸数字，不带 ¥ 和千分位', () => {
    expect(csvNumber(1234.5)).toBe('1234.5');
    expect(csvNumber('12000.00')).toBe('12000');
  });

  it('非数字返回空串而不是 NaN', () => {
    expect(csvNumber(null)).toBe('');
    expect(csvNumber(undefined)).toBe('');
    expect(csvNumber('abc')).toBe('');
  });
});

describe('localDateStamp · 文件名日期用本地日', () => {
  it('本地 00:30 导出写成当天，而不是 UTC 的前一天', () => {
    // 合成本地时间 2026-08-20 00:30（东八区下 UTC 已是 08-19T16:30Z）
    const d = new Date(2026, 7, 20, 0, 30, 0);
    expect(localDateStamp(d)).toBe('2026-08-20');
  });

  it('月/日补零', () => {
    expect(localDateStamp(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05');
  });
});
