/**
 * CSV 导出 — 简易实现，无需 xlsx 库
 * Excel 可以直接打开 UTF-8 BOM + CSV
 */

export function exportToCSV<T>(
  filename: string,
  rows: T[],
  columns: Array<{ key: keyof T; label: string; format?: (v: unknown) => string }>,
): void {
  if (rows.length === 0) {
    alert('没有数据可导出');
    return;
  }

  // Header row
  const header = columns.map((c) => escapeCSV(c.label)).join(',');

  // Data rows
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

  const csv = '\uFEFF' + header + '\n' + body; // UTF-8 BOM for Excel Chinese support

  // Download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeCSV(val: string): string {
  // 如果包含逗号、引号、换行，要引号包起来，内部引号翻倍
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}
