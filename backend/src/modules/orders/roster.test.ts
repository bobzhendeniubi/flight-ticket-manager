/**
 * 旅游团名单（roster）模版生成 + 解析 · 单元测试（vitest，纯内存 xlsx，不依赖 DB）。
 *
 * 覆盖：
 *   - buildRosterTemplateWorkbook 生成合法 xlsx（可被 exceljs 重新读回，11 列表头 + 示例行）
 *   - parseRosterXlsx 从小型内存 xlsx → rows（表头跳过、PNR/出生/性别/证件号解析）
 *   - 容错：空行跳过、日期多格式、单格不可解析只收 warning、缺名缺证件号跳过
 *   - 向后兼容：旧 4 列模版（姓名 | 护照号 | 出生日期 | 性别）仍可解析
 *   - 上限截断（ROSTER_MAX_ROWS）
 *
 * 注：新模版 11 列，列序见 ROSTER_COL：
 *   1 中文姓名 | 2 PNR | 3 性别 | 4 出生日期 | 5 国籍 | 6 证件类型 | 7 证件号 |
 *   8 签发日期 | 9 有效日期 | 10 婴儿同行 | 11 备注
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

// 新模版表头（11 列，与 ROSTER_COL 列序一致）。用于构造解析测试用例。
const NEW_HEADER = [
  '中文姓名',
  '乘客姓名(PNR，LAST/FIRST 或用/分隔)',
  '性别(M/F/男/女)',
  '出生日期',
  '国籍(CN/CHN等)',
  '证件类型(护照/PASSPORT/身份证)',
  '证件号',
  '签发日期',
  '有效日期',
  '婴儿同行成人姓名',
  '备注',
];

/** 构造一条新模版数据行（11 列）；缺省补 null。*/
function newRow(opts: {
  fullName?: string;
  pnr?: string;
  gender?: string;
  dob?: string | Date;
  nationality?: string;
  docType?: string;
  docNum?: string;
  issueDate?: string;
  expiryDate?: string;
  infant?: string;
  remarks?: string;
}): Array<string | Date | number | null> {
  return [
    opts.fullName ?? null,
    opts.pnr ?? null,
    opts.gender ?? null,
    opts.dob ?? null,
    opts.nationality ?? null,
    opts.docType ?? null,
    opts.docNum ?? null,
    opts.issueDate ?? null,
    opts.expiryDate ?? null,
    opts.infant ?? null,
    opts.remarks ?? null,
  ];
}

describe('roster 模版生成', () => {
  it('生成合法 xlsx：可重新读回，含 11 列表头 + 2 行示例', async () => {
    const buf = await buildRosterTemplateWorkbook();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    expect(ws).toBeTruthy();
    // 表头（新模版 11 列，关键列校验）
    expect(String(ws.getRow(1).getCell(1).value)).toContain('中文姓名');
    expect(String(ws.getRow(1).getCell(2).value)).toContain('PNR');
    expect(String(ws.getRow(1).getCell(3).value)).toContain('性别');
    expect(String(ws.getRow(1).getCell(4).value)).toContain('出生日期');
    expect(String(ws.getRow(1).getCell(7).value)).toContain('证件号');
    // 示例行存在（列1 中文姓名）
    expect(String(ws.getRow(2).getCell(1).value)).toBe('张三');
  });

  it('文件名形如 名单模版_YYYY-MM-DD.xlsx', () => {
    expect(rosterTemplateFilename()).toMatch(/^名单模版_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});

describe('roster 解析（新模版 11 列）', () => {
  it('表头 + 两行数据 → 解析出两行（表头被跳过）', async () => {
    const b64 = await rowsToXlsxBase64([
      NEW_HEADER,
      newRow({ fullName: '张三', gender: 'M', dob: '1990-01-15', docNum: 'E12345678' }),
      newRow({ fullName: '李四', gender: 'F', dob: '1988-07-30', docNum: 'E87654321' }),
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      fullName: '张三',
      documentNumber: 'E12345678',
      dateOfBirth: '1990-01-15',
      gender: 'M',
    });
    expect(rows[1]).toMatchObject({
      fullName: '李四',
      documentNumber: 'E87654321',
      dateOfBirth: '1988-07-30',
      gender: 'F',
    });
    expect(warnings).toHaveLength(0);
  });

  it('空行被跳过；只有姓名也可解析（其余留空）', async () => {
    const b64 = await rowsToXlsxBase64([
      NEW_HEADER,
      newRow({ fullName: '王五' }),
      newRow({}), // 整行空 → 跳过
      newRow({ fullName: '赵六', docNum: 'E55555555' }),
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ fullName: '王五' });
    expect(rows[1]).toMatchObject({ fullName: '赵六', documentNumber: 'E55555555' });
    expect(warnings).toHaveLength(0);
  });

  it('YYYY/M/D 日期格式可解析；不可解析的日期只收 warning（不丢行）', async () => {
    const b64 = await rowsToXlsxBase64([
      NEW_HEADER,
      newRow({ fullName: '张三', docNum: 'E1', dob: '1990/1/5', gender: 'M' }),
      newRow({ fullName: '李四', docNum: 'E2', dob: '不是日期', gender: 'F' }),
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows[0]).toMatchObject({ fullName: '张三', documentNumber: 'E1', dateOfBirth: '1990-01-05', gender: 'M' });
    // 第二行保留，dob 留空，收一条 warning
    expect(rows[1]).toMatchObject({ fullName: '李四', documentNumber: 'E2', gender: 'F' });
    expect(rows[1].dateOfBirth).toBeUndefined();
    expect(warnings.some((w) => w.includes('出生日期'))).toBe(true);
  });

  it('Excel 日期格（Date 单元格）按 UTC 解析为 YYYY-MM-DD', async () => {
    const b64 = await rowsToXlsxBase64([
      NEW_HEADER,
      newRow({ fullName: '张三', docNum: 'E1', dob: new Date(Date.UTC(1992, 11, 25)), gender: 'M' }), // 1992-12-25
    ]);
    const { rows } = await parseRosterXlsx(b64);
    expect(rows[0].dateOfBirth).toBe('1992-12-25');
  });

  it('无法识别的性别只收 warning（不丢行）', async () => {
    const b64 = await rowsToXlsxBase64([
      NEW_HEADER,
      newRow({ fullName: '张三', docNum: 'E1', dob: '1990-01-01', gender: '不明' }),
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows[0]).toMatchObject({ fullName: '张三', documentNumber: 'E1', dateOfBirth: '1990-01-01' });
    expect(rows[0].gender).toBeUndefined();
    expect(warnings.some((w) => w.includes('性别'))).toBe(true);
  });

  it('姓名与证件号均为空 → 收 warning 跳过该行', async () => {
    const b64 = await rowsToXlsxBase64([
      NEW_HEADER,
      newRow({ gender: 'M', dob: '1990-01-01' }), // 无姓名、无证件号 → 跳过
      newRow({ fullName: '张三', docNum: 'E2', dob: '1991-02-02', gender: 'F' }),
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fullName: '张三', documentNumber: 'E2', dateOfBirth: '1991-02-02', gender: 'F' });
    expect(warnings.some((w) => w.includes('姓名') && w.includes('证件号'))).toBe(true);
  });

  it('PNR 姓名（LAST/FIRST）拆分为 lastName / firstName', async () => {
    const b64 = await rowsToXlsxBase64([
      NEW_HEADER,
      newRow({ pnr: 'ZHANG/SAN', docNum: 'E1' }),
    ]);
    const { rows } = await parseRosterXlsx(b64);
    expect(rows[0].lastName).toBe('ZHANG');
    expect(rows[0].firstName).toBe('SAN');
  });

  it(`超过 ${ROSTER_MAX_ROWS} 行 → 截断 + warning`, async () => {
    const data: Array<Array<string | Date | number | null>> = [NEW_HEADER];
    for (let i = 0; i < ROSTER_MAX_ROWS + 5; i++) {
      data.push(newRow({ fullName: `乘客${i}`, docNum: `E${i}`, dob: '1990-01-01', gender: 'M' }));
    }
    const b64 = await rowsToXlsxBase64(data);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows).toHaveLength(ROSTER_MAX_ROWS);
    expect(warnings.some((w) => w.includes(`${ROSTER_MAX_ROWS}`))).toBe(true);
  });
});

describe('roster 解析（旧模版 4 列，向后兼容）', () => {
  it('旧表头 + 两行 → 解析出两行（emit fullName + documentNumber 别名）', async () => {
    const b64 = await rowsToXlsxBase64([
      ['姓名', '护照号', '出生日期(YYYY-MM-DD)', '性别(M/F)'],
      ['张三', 'E12345678', '1990-01-15', 'M'],
      ['李四', 'E87654321', '1988-07-30', 'F'],
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      fullName: '张三',
      documentNumber: 'E12345678',
      dateOfBirth: '1990-01-15',
      gender: 'M',
    });
    expect(warnings).toHaveLength(0);
  });

  it('旧模版缺姓名 → 收 warning 跳过该行', async () => {
    const b64 = await rowsToXlsxBase64([
      ['姓名', '护照号', '出生日期(YYYY-MM-DD)', '性别(M/F)'],
      [null, 'E1', '1990-01-01', 'M'],
      ['张三', 'E2', '1991-02-02', 'F'],
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fullName: '张三', documentNumber: 'E2' });
    expect(warnings.some((w) => w.includes('缺少姓名'))).toBe(true);
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
