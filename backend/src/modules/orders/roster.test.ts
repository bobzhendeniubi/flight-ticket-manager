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
  parseDateCell,
  parseDateCellDetailed,
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
  // 日期列同 dob：允许 Date，用于构造「Excel 日期格」用例
  issueDate?: string | Date;
  expiryDate?: string | Date;
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

  it('日期列（出生日期/签发日期/证件有效期）单元格格式为文本 → Excel 不再自作主张转换', async () => {
    const buf = await buildRosterTemplateWorkbook();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];

    // 4 = 出生日期、8 = 签发日期、9 = 证件有效期
    for (const col of [4, 8, 9]) {
      expect(ws.getColumn(col).numFmt).toBe('@');
      // 示例行也要是文本格式（列级 style 在部分 Excel/WPS 版本里不回落到已有单元格）
      expect(ws.getRow(2).getCell(col).numFmt).toBe('@');
      expect(ws.getRow(3).getCell(col).numFmt).toBe('@');
    }
  });

  it('日期列表头写明 YYYY-MM-DD；示例行只示范这一种写法', async () => {
    const buf = await buildRosterTemplateWorkbook();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];

    expect(String(ws.getRow(1).getCell(4).value)).toBe('出生日期(YYYY-MM-DD)');
    expect(String(ws.getRow(1).getCell(8).value)).toBe('签发日期(YYYY-MM-DD)');
    expect(String(ws.getRow(1).getCell(9).value)).toBe('证件有效期(YYYY-MM-DD)');

    // 两行示例的日期全部是 YYYY-MM-DD —— 模版不再示范 dd-MM-yyyy，
    // 混用会造出「日、月都 ≤12」这种事后无法分辨的格子。
    for (const rowNumber of [2, 3]) {
      for (const col of [4, 8, 9]) {
        expect(String(ws.getRow(rowNumber).getCell(col).value)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
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

  it('Excel 日期格：仍然接受，但必须发 warning 并回显解析结果供核对', async () => {
    // Excel 按 locale 把 01-07-1990 存成日期格时，原始文本已永久丢失 →
    // 我们只能接受它的解释，但不能装作这没发生过。
    const b64 = await rowsToXlsxBase64([
      NEW_HEADER,
      newRow({ fullName: '张三', docNum: 'E1', dob: new Date(Date.UTC(1990, 6, 1)) }), // 1990-07-01
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows[0].dateOfBirth).toBe('1990-07-01');

    const w = warnings.find((x) => x.includes('出生日期'));
    expect(w).toBeDefined();
    expect(w).toContain('Excel');
    expect(w).toContain('1990-07-01'); // 回显解析结果，人才能核
    expect(w).toContain('日-月-年');
  });

  it('证件有效期是 Excel 日期格 → 同样发 warning（错的有效期＝拒登机）', async () => {
    const b64 = await rowsToXlsxBase64([
      NEW_HEADER,
      newRow({ fullName: '张三', docNum: 'E1', expiryDate: new Date(Date.UTC(2030, 2, 9)) }),
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows[0].passportExpiry).toBe('2030-03-09');
    expect(warnings.some((w) => w.includes('证件有效期') && w.includes('Excel'))).toBe(true);
  });

  it('三段全 ≤31 的日期（05-06-07）→ 拒收留空 + warning，绝不静默猜一个', async () => {
    // 旧行为：兜底当"年在前" + 两位年扩展 → 静默产出 2005-06-07，无任何提示。
    const b64 = await rowsToXlsxBase64([
      NEW_HEADER,
      newRow({ fullName: '张三', docNum: 'E1', dob: '05-06-07', expiryDate: '01-07-30' }),
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);

    expect(rows).toHaveLength(1);           // 行保留
    expect(rows[0].dateOfBirth).toBeUndefined();
    expect(rows[0].dob).toBeUndefined();
    expect(rows[0].passportExpiry).toBeUndefined();

    expect(warnings.some((w) => w.includes('出生日期') && w.includes('05-06-07'))).toBe(true);
    expect(warnings.some((w) => w.includes('证件有效期') && w.includes('01-07-30'))).toBe(true);
    // 明确不得出现旧的静默猜测结果
    expect(warnings.some((w) => w.includes('2005-06-07'))).toBe(false);
  });

  it('能自证的日期不发 warning：年在前 / 日在前（末段是四位年）', async () => {
    const b64 = await rowsToXlsxBase64([
      NEW_HEADER,
      newRow({ fullName: '张三', docNum: 'E1', dob: '1990-01-15' }),   // 首段 >31 → 年在前
      newRow({ fullName: '李四', docNum: 'E2', dob: '15-07-1988' }),   // 末段 >31 → 日在前
    ]);
    const { rows, warnings } = await parseRosterXlsx(b64);
    expect(rows[0].dateOfBirth).toBe('1990-01-15');
    expect(rows[1].dateOfBirth).toBe('1988-07-15');
    expect(warnings).toHaveLength(0);
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

  it('parseDateCellDetailed：只在能自证时才判年月日顺序', () => {
    // 首段 >31 → 只可能是年 → 年在前
    expect(parseDateCellDetailed('1990-01-15')).toEqual({ iso: '1990-01-15', doubt: null });
    expect(parseDateCellDetailed('90-01-15')).toEqual({ iso: '1990-01-15', doubt: null });
    // 末段 >31 → 只可能是年 → 日在前（航司口径）
    expect(parseDateCellDetailed('15-07-1988')).toEqual({ iso: '1988-07-15', doubt: null });
    expect(parseDateCellDetailed('15-07-88')).toEqual({ iso: '1988-07-15', doubt: null });
    // 两头都 ≤31 → 无法自证 → 拒收，不猜
    expect(parseDateCellDetailed('05-06-07')).toEqual({ iso: null, doubt: 'DAY_MONTH_AMBIGUOUS' });
    expect(parseDateCellDetailed('01-07-30')).toEqual({ iso: null, doubt: 'DAY_MONTH_AMBIGUOUS' });
    // 25-06-07：25 不可能是月，但「2025-06-07」和「25 Jun 2007」都成立 → 一样拒收
    expect(parseDateCellDetailed('25-06-07')).toEqual({ iso: null, doubt: 'DAY_MONTH_AMBIGUOUS' });
    // Excel 日期格 → 接受但标存疑
    expect(parseDateCellDetailed(new Date(Date.UTC(1990, 0, 15)))).toEqual({
      iso: '1990-01-15',
      doubt: 'EXCEL_DATE',
    });
    // 压根不是日期 → 无值也无"存疑"（是解析失败，不是歧义）
    expect(parseDateCellDetailed('garbage')).toEqual({ iso: null, doubt: null });
    expect(parseDateCellDetailed(null)).toEqual({ iso: null, doubt: null });
  });

  it('parseDateCell：歧义格回 null（薄封装，丢掉存疑信息）', () => {
    expect(parseDateCell('05-06-07')).toBeNull();
    expect(parseDateCell('1990-01-15')).toBe('1990-01-15');
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
