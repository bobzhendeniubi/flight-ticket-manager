/**
 * CSV 导出 — 简易实现，无需 xlsx 库
 * Excel 可以直接打开 UTF-8 BOM + CSV
 */

/** 本地日期 YYYY-MM-DD。用 toISOString() 会取 UTC 日，本地 00:00–08:00 导出会写成前一天。 */
export function localDateStamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface CsvColumn<T> {
  key: keyof T;
  label: string;
  format?: (v: unknown) => string;
}

/**
 * 纯函数：把行 + 列定义拼成 CSV 文本（含 UTF-8 BOM）。
 * 与下载动作分开，是为了能对转义/公式注入防护写回归测试（下载那段依赖 DOM，测不了）。
 */
export function buildCSV<T>(rows: T[], columns: Array<CsvColumn<T>>): string {
  const header = columns.map((c) => escapeCSV(c.label)).join(',');
  const body = rows
    .map((row) =>
      columns
        .map((c) => {
          const v = row[c.key];
          const formatted = c.format ? c.format(v) : String(v ?? '');
          return escapeCSV(formatted);
        })
        .join(','),
    )
    .join('\n');
  return '﻿' + header + '\n' + body; // UTF-8 BOM for Excel Chinese support
}

export function exportToCSV<T>(
  filename: string,
  rows: T[],
  columns: Array<CsvColumn<T>>,
): void {
  if (rows.length === 0) {
    alert('没有数据可导出');
    return;
  }

  const csv = buildCSV(rows, columns);

  // Download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}-${localDateStamp()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// CSV 公式注入（CSV injection）：Excel / WPS / Numbers 会把以 = + - @ 开头的单元格当**公式**执行，
// 而客户名/联系人/备注这些字段是用户可填的 —— `=cmd|'/C calc'!A1` 这类内容打开表格就会弹出执行提示。
// 防法（OWASP 口径）：给这些开头的值加一个前置单引号，表格按纯文本显示，值本身不丢。
// 制表符/回车开头同样能触发（前导空白被吃掉后再判定），一并覆盖。
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * 导出为「可求和的数字」用这个：不加 ¥、不加千分位，Excel 才会当数值读。
 * 缺值（null/undefined/空串）输出空单元格 —— 不能落成 0：0 是有含义的金额（已结清），
 * 把「没这个数」写成 0 会让求和与人工核对都对不上。
 */
export function csvNumber(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
}

function escapeCSV(val: string): string {
  const safe = FORMULA_TRIGGER.test(val) ? `'${val}` : val;
  // 如果包含逗号、引号、换行，要引号包起来，内部引号翻倍
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
