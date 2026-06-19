/**
 * 旅游团名单（roster）模版生成 + 解析 · 单元测试（vitest，纯内存 xlsx，不依赖 DB）。
 *
 * 覆盖：
 *   - buildRosterTemplateWorkbook 生成合法 xlsx（可被 exceljs 重新读回，表头 + 示例行）
 *   - parseRosterXlsx 从小型内存 xlsx → rows（表头跳过、护照/出生/性别解析）
 *   - 容错：空行跳过、日期多格式、单格不可解析只收 warning、缺名跳过
 *   - 上限截断（ROSTER_MAX_ROWS）
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildRosterTemplateWorkbook,
  parseRosterXlsx,
  rosterTemplateFilename,
  parseDobCell,
  parseGenderCell,
  ROSTER_MAX_ROWS,
} from './roster.js';

/** 把行数组写成一个内存 xlsx → base64（首行可选当表头）。*/
async function rowsToXlsxBase64(rows: Array<Array<string | Date | number | null>>): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('名单');
  for (const r of rows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

describe('roster 模版生成', () => {
  it('生成合法 xlsx：可重新读回，含表头 + 2 行示例', async () => {
    const buf = await buildRosterTemplateWorkbook();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    expect(ws).toBeTruthy();
    // 表头四列
    expect(String(ws.getRow(1).getCell(1).value)).toBe('姓名');
    expect(String(ws.getRow(1).getCell(2).value)).toBe('护照号');
    expect(String(ws.getRow(1).getCell(3).value)).toContain('出生日期');
    expect(String(ws.getRow(1).getCell(4).value)).toContain('性别');
    // 示例行存在
    expect(String(ws.getRow(2).getCell(1).value)).toBe('张三');
  });

  it('文件名形如 名单模版_YYYY-MM-DD.xlsx', () => {
    expect(rosterTemplateFilename()).toMatch(/^名单模版_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});

describe('roster 解析', () => {
  it('表头 + 两行数据 → 解析出两行（表头被跳过）', async () => {
    const b64 = await rowsToXlsxBase64([
      ['姓名', '护照号', '出生日期(YYYY-MM-DD)', '性别(M/F)'],
      ['张三', 'E12345678', '1990-01-15', 'M'],
      ['李四', 'E87654321', '1988-07-30', 'F'],
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows).toEqual([
      { name: '张三', passportNo: 'E12345678', dob: '1990-01-15', gender: 'M' },
      { name: '李四', passportNo: 'E87654321', dob: '1988-07-30', gender: 'F' },
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('空行被跳过；只有姓名也可解析（其余留空）', async () => {
    const b64 = await rowsToXlsxBase64([
      ['姓名', '护照号', '出生日期(YYYY-MM-DD)', '性别(M/F)'],
      ['王五', null, null, null],
      [null, null, null, null], // 整行空 → 跳过
      ['赵六', 'E55555555', null, null],
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows).toEqual([
      { name: '王五' },
      { name: '赵六', passportNo: 'E55555555' },
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('YYYY/M/D 日期格式可解析；不可解析的日期只收 warning（不丢行）', async () => {
    const b64 = await rowsToXlsxBase64([
      ['姓名', '护照号', '出生日期(YYYY-MM-DD)', '性别(M/F)'],
      ['张三', 'E1', '1990/1/5', 'M'],
      ['李四', 'E2', '不是日期', 'F'],
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows[0]).toEqual({ name: '张三', passportNo: 'E1', dob: '1990-01-05', gender: 'M' });
    // 第二行保留，dob 留空，收一条 warning
    expect(rows[1]).toEqual({ name: '李四', passportNo: 'E2', gender: 'F' });
    expect(warnings.some((w) => w.includes('出生日期'))).toBe(true);
  });

  it('Excel 日期格（Date 单元格）按 UTC 解析为 YYYY-MM-DD', async () => {
    const b64 = await rowsToXlsxBase64([
      ['姓名', '护照号', '出生日期(YYYY-MM-DD)', '性别(M/F)'],
      ['张三', 'E1', new Date(Date.UTC(1992, 11, 25)), 'M'], // 1992-12-25
    ]);
    const { rows } = await parseRosterXlsx(b64);
    expect(rows[0].dob).toBe('1992-12-25');
  });

  it('无法识别的性别只收 warning（不丢行）', async () => {
    const b64 = await rowsToXlsxBase64([
      ['姓名', '护照号', '出生日期(YYYY-MM-DD)', '性别(M/F)'],
      ['张三', 'E1', '1990-01-01', '不明'],
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows[0]).toEqual({ name: '张三', passportNo: 'E1', dob: '1990-01-01' });
    expect(warnings.some((w) => w.includes('性别'))).toBe(true);
  });

  it('缺姓名但其他有值 → 收 warning 跳过该行', async () => {
    const b64 = await rowsToXlsxBase64([
      ['姓名', '护照号', '出生日期(YYYY-MM-DD)', '性别(M/F)'],
      [null, 'E1', '1990-01-01', 'M'],
      ['张三', 'E2', '1991-02-02', 'F'],
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows).toEqual([{ name: '张三', passportNo: 'E2', dob: '1991-02-02', gender: 'F' }]);
    expect(warnings.some((w) => w.includes('缺少姓名'))).toBe(true);
  });

  it('无表头（第一行就是数据）也能解析', async () => {
    const b64 = await rowsToXlsxBase64([
      ['张三', 'E1', '1990-01-01', 'M'],
      ['李四', 'E2', '1991-02-02', 'F'],
    ]);
    const { rows } = await parseRosterXlsx(b64);
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('张三');
  });

  it(`超过 ${ROSTER_MAX_ROWS} 行 → 截断 + warning`, async () => {
    const data: Array<Array<string | null>> = [['姓名', '护照号', '出生日期(YYYY-MM-DD)', '性别(M/F)']];
    for (let i = 0; i < ROSTER_MAX_ROWS + 5; i++) {
      data.push([`乘客${i}`, `E${i}`, '1990-01-01', 'M']);
    }
    const b64 = await rowsToXlsxBase64(data);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows).toHaveLength(ROSTER_MAX_ROWS);
    expect(warnings.some((w) => w.includes(`${ROSTER_MAX_ROWS}`))).toBe(true);
  });
});

describe('roster 单格解析工具', () => {
  it('parseDobCell：多格式', () => {
    expect(parseDobCell('1990-01-15')).toBe('1990-01-15');
    expect(parseDobCell('1990/1/5')).toBe('1990-01-05');
    expect(parseDobCell('1990.12.31')).toBe('1990-12-31');
    expect(parseDobCell('garbage')).toBeNull();
    expect(parseDobCell('1990-13-01')).toBeNull(); // 非法月份
    expect(parseDobCell(null)).toBeNull();
  });

  it('parseGenderCell：M/F、男/女、male/female', () => {
    expect(parseGenderCell('M')).toBe('M');
    expect(parseGenderCell('f')).toBe('F');
    expect(parseGenderCell('男')).toBe('M');
    expect(parseGenderCell('女')).toBe('F');
    expect(parseGenderCell('Male')).toBe('M');
    expect(parseGenderCell('female')).toBe('F');
    expect(parseGenderCell('?')).toBeNull();
    expect(parseGenderCell(null)).toBeNull();
  });
});
