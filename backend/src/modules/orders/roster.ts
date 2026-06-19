/**
 * 旅游团名单（roster）—— 模版下载 + 解析。
 *
 * 流程：导出名单模版（.xlsx）→ 把收单群里的名单填进模版 → 上传解析回出行人行，
 * 用于批量留位 / 批量建单。解析力求宽容：跳过空行、容错日期格式、单格不可解析
 * 只收集 warning 而绝不整文件抛错。
 *
 * 复用后端既有依赖 exceljs（与 orders.export-templates.ts / pnr-export.ts 同款）。
 */
import ExcelJS from 'exceljs';

// 解析上限：一次最多收 500 行出行人（防超大文件 / 误传）
export const ROSTER_MAX_ROWS = 500;

/** 模版表头（与解析列序一一对应）。*/
const ROSTER_HEADERS = ['姓名', '护照号', '出生日期(YYYY-MM-DD)', '性别(M/F)'] as const;

/** 解析出来的一行出行人（姓名必填，其余可空）。*/
export interface RosterRow {
  name: string;
  passportNo?: string;
  dob?: string; // YYYY-MM-DD
  gender?: 'M' | 'F';
}

export interface RosterParseResult {
  rows: RosterRow[];
  warnings: string[];
}

/**
 * 生成名单模版 .xlsx（表头 + 1-2 行示例），返回 Buffer。
 * 示例行用占位姓名/护照，提示填写格式。
 */
export async function buildRosterTemplateWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '椰岛假期 · 旅游团名单模版';
  wb.created = new Date();
  const ws = wb.addWorksheet('名单');

  ws.columns = [
    { header: ROSTER_HEADERS[0], key: 'name', width: 18 },
    { header: ROSTER_HEADERS[1], key: 'passportNo', width: 20 },
    { header: ROSTER_HEADERS[2], key: 'dob', width: 22 },
    { header: ROSTER_HEADERS[3], key: 'gender', width: 12 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // 示例行：提示格式（出生日期 YYYY-MM-DD，性别 M/F）
  ws.addRow({ name: '张三', passportNo: 'E12345678', dob: '1990-01-15', gender: 'M' });
  ws.addRow({ name: '李四', passportNo: 'E87654321', dob: '1988-07-30', gender: 'F' });

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** 模版下载文件名：`名单模版_YYYY-MM-DD.xlsx`。*/
export function rosterTemplateFilename(): string {
  const d = new Date();
  const today = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
  return `名单模版_${today}.xlsx`;
}

// ── 单格解析工具（全部容错，不抛错）────────────────────────────────────────

/** 取单元格文本：兼容富文本 / 公式 / 超链接 / 数字。空 → ''。 */
function cellText(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // 日期单元格在 cellText 场景一般不应出现（dob 走专门解析）；兜底 ISO 日期
    return excelDateToIso(value) ?? '';
  }
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    if ('richText' in v && Array.isArray(v.richText)) {
      return v.richText.map((rt) => String((rt as { text?: unknown }).text ?? '')).join('');
    }
    if ('text' in v && v.text !== undefined) return String(v.text);
    if ('result' in v && v.result !== undefined) return String(v.result);
    if ('hyperlink' in v && 'text' in v) return String(v.text ?? '');
    return '';
  }
  return String(value).trim();
}

/** Excel Date → 'YYYY-MM-DD'（按 UTC 取年月日，避免时区漂移）。*/
function excelDateToIso(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

/**
 * 解析出生日期单元格 → 'YYYY-MM-DD' | null。
 * 接受：Excel 日期格 / 文本 YYYY-MM-DD / YYYY/M/D / YYYY.M.D。无法解析 → null。
 */
export function parseDobCell(value: ExcelJS.CellValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return excelDateToIso(value);

  const text = cellText(value).trim();
  if (!text) return null;

  // 已是 YYYY-MM-DD
  const dash = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  // YYYY/M/D 或 YYYY.M.D
  const slash = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(text);
  const m = dash ?? slash;
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 解析性别单元格 → 'M' | 'F' | null。接受 M/F、男/女、male/female（不区分大小写）。*/
export function parseGenderCell(value: ExcelJS.CellValue | undefined): 'M' | 'F' | null {
  const text = cellText(value).trim().toUpperCase();
  if (!text) return null;
  if (text === 'M' || text === '男' || text === 'MALE') return 'M';
  if (text === 'F' || text === '女' || text === 'FEMALE') return 'F';
  return null;
}

/**
 * 解析名单 .xlsx（base64）→ { rows, warnings }。
 * - 第 1 行视为表头（即使没表头，第 1 行也会按数据校验；姓名空则跳过）。
 * - 跳过整行空白行。
 * - 单格不可解析（出生日期/性别）只收 warning，仍保留该行（对应字段留空）。
 * - 超过 ROSTER_MAX_ROWS 行则截断并 warning。
 * - 整个文件解析失败（损坏/非 xlsx）→ 抛错由路由层转 400。
 */
export async function parseRosterXlsx(fileBase64: string): Promise<RosterParseResult> {
  const buf = Buffer.from(fileBase64, 'base64');
  const wb = new ExcelJS.Workbook();
  // exceljs 的 load() 类型声明为非泛型 Buffer；Node 22 的 Buffer.from 返回 Buffer<ArrayBuffer>，
  // 运行期完全兼容，仅做类型对齐。
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);

  const ws = wb.worksheets[0];
  const warnings: string[] = [];
  const rows: RosterRow[] = [];
  if (!ws) {
    warnings.push('未找到任何工作表');
    return { rows, warnings };
  }

  let dataRowCount = 0;
  let truncated = false;

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (truncated) return;
    // 第 1 行通常是表头：若首格等于模版表头「姓名」则跳过
    const nameCell = cellText(row.getCell(1).value).trim();
    if (rowNumber === 1 && nameCell === ROSTER_HEADERS[0]) {
      return;
    }

    const passportNo = cellText(row.getCell(2).value).trim();
    const dobRaw = row.getCell(3).value;
    const genderRaw = row.getCell(4).value;

    // 整行空白（姓名 + 护照 + 出生 + 性别都空）→ 跳过，不计数、不 warning
    const dobText = cellText(dobRaw).trim();
    const genderText = cellText(genderRaw).trim();
    if (!nameCell && !passportNo && !dobText && !genderText) return;

    // 姓名必填：缺名但其他有值 → 收 warning 跳过该行
    if (!nameCell) {
      warnings.push(`第 ${rowNumber} 行：缺少姓名，已跳过`);
      return;
    }

    if (dataRowCount >= ROSTER_MAX_ROWS) {
      truncated = true;
      warnings.push(`名单超过 ${ROSTER_MAX_ROWS} 行，仅解析前 ${ROSTER_MAX_ROWS} 行`);
      return;
    }
    dataRowCount += 1;

    const out: RosterRow = { name: nameCell };

    if (passportNo) out.passportNo = passportNo;

    if (dobText) {
      const dob = parseDobCell(dobRaw);
      if (dob) out.dob = dob;
      else warnings.push(`第 ${rowNumber} 行（${nameCell}）：出生日期「${dobText}」无法解析，已留空`);
    }

    if (genderText) {
      const gender = parseGenderCell(genderRaw);
      if (gender) out.gender = gender;
      else warnings.push(`第 ${rowNumber} 行（${nameCell}）：性别「${genderText}」无法识别，已留空`);
    }

    rows.push(out);
  });

  return { rows, warnings };
}
