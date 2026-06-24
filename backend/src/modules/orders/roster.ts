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

/**
 * 模版表头（与解析列序一一对应）—— 航司口径 + 我们的补充。
 * 顺序固定，列宽/说明写在模版里，解析时按列编号读取（不依赖表头文字）。
 */
const ROSTER_HEADERS = [
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
] as const;

/** 列索引（1-based，对应 ExcelJS row.getCell(n)）。*/
export const ROSTER_COL = {
  fullName: 1,         // 中文姓名
  pnrName: 2,          // 乘客姓名(PNR)：LAST/FIRST 或「/」分隔
  gender: 3,           // 性别
  dateOfBirth: 4,      // 出生日期
  nationality: 5,      // 国籍
  documentType: 6,     // 证件类型
  documentNumber: 7,   // 证件号
  issueDate: 8,        // 签发日期（签证签发日）
  expiryDate: 9,       // 有效日期（护照有效期）
  infantCompanion: 10, // 婴儿同行成人姓名（辅助备注）
  remarks: 11,         // 备注
} as const;

/** 解析出来的一行出行人（fullName 或 documentNumber 至少一项有值）。*/
export interface RosterRow {
  // 基础身份
  chineseName?: string;        // 中文姓名（列1，专用字段）
  fullName?: string;           // 兜底全名（同 chineseName 或 PNR 全名）
  lastName?: string;           // 从 PNR 解析出的姓
  firstName?: string;          // 从 PNR 解析出的名
  gender?: 'M' | 'F';
  dateOfBirth?: string;        // YYYY-MM-DD
  nationality?: string;        // 2-letter ISO（CN / XX 等）
  documentType?: string;       // PASSPORT | ID_CARD
  documentNumber?: string;     // 证件号
  passportIssueDate?: string;  // 护照签发日期 YYYY-MM-DD（列8）
  passportExpiry?: string;     // 有效日期 YYYY-MM-DD（列9）
  // 辅助
  infantCompanion?: string;
  remarks?: string;
  // 向后兼容（旧字段 alias）
  /** @deprecated 请用 documentNumber */
  passportNo?: string;
  /** @deprecated 请用 dateOfBirth */
  dob?: string;
  /** @deprecated 请用 passportIssueDate */
  visaIssueDate?: string;
}

export interface RosterParseResult {
  rows: RosterRow[];
  warnings: string[];
}

/**
 * 生成名单模版 .xlsx（表头 + 2 行示例），返回 Buffer。
 * 表头为航司口径 + 我们的补充共 11 列；示例行提示填写格式。
 */
export async function buildRosterTemplateWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '椰岛假期 · 旅游团名单模版';
  wb.created = new Date();
  const ws = wb.addWorksheet('名单');

  ws.columns = [
    { header: ROSTER_HEADERS[0], key: 'fullName',       width: 16 }, // 1 中文姓名
    { header: ROSTER_HEADERS[1], key: 'pnrName',        width: 28 }, // 2 乘客姓名(PNR)
    { header: ROSTER_HEADERS[2], key: 'gender',         width: 14 }, // 3 性别
    { header: ROSTER_HEADERS[3], key: 'dateOfBirth',    width: 16 }, // 4 出生日期
    { header: ROSTER_HEADERS[4], key: 'nationality',    width: 14 }, // 5 国籍
    { header: ROSTER_HEADERS[5], key: 'documentType',   width: 22 }, // 6 证件类型
    { header: ROSTER_HEADERS[6], key: 'documentNumber', width: 20 }, // 7 证件号
    { header: ROSTER_HEADERS[7], key: 'issueDate',      width: 16 }, // 8 签发日期
    { header: ROSTER_HEADERS[8], key: 'expiryDate',     width: 16 }, // 9 有效日期
    { header: ROSTER_HEADERS[9], key: 'infantCompanion',width: 20 }, // 10 婴儿同行
    { header: ROSTER_HEADERS[10], key: 'remarks',       width: 24 }, // 11 备注
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // 示例行（行2/行3）：提示格式，日期 YYYY-MM-DD 或 dd-MM-yyyy 均可
  ws.addRow({
    fullName: '张三',
    pnrName: 'ZHANG/SAN',
    gender: 'M',
    dateOfBirth: '1990-01-15',
    nationality: 'CN',
    documentType: '护照',
    documentNumber: 'E12345678',
    issueDate: '2020-03-10',
    expiryDate: '2030-03-09',
    infantCompanion: '',
    remarks: '',
  });
  ws.addRow({
    fullName: '李四',
    pnrName: 'LI/SI',
    gender: 'F',
    dateOfBirth: '15-07-1988',   // 演示 dd-MM-yyyy 格式也接受
    nationality: 'CN',
    documentType: '护照',
    documentNumber: 'E87654321',
    issueDate: '2019-06-20',
    expiryDate: '2029-06-19',
    infantCompanion: '',
    remarks: '',
  });

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
 * 通用日期单元格解析器 → 'YYYY-MM-DD' | null。
 *
 * 接受（自动判别，全部容错）：
 *   - Excel 日期序列格
 *   - YYYY-MM-DD / YYYY/M/D / YYYY.M.D（年在前）
 *   - dd-MM-yyyy / dd/MM/yyyy / dd.MM.yyyy（日在前，航司口径：01-07-1990 = 1990-07-01）
 *
 * 判别规则：首段数字 > 31 则视为"年在前"，否则视为"日在前"。
 * 无法解析 → null（不抛错，调用方收 warning）。
 */
export function parseDateCell(value: ExcelJS.CellValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return excelDateToIso(value);

  const text = cellText(value).trim();
  if (!text) return null;

  // ── 分隔符通配（-、/、.）────────────────────────────────────────────────
  const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(text);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);

  let year: number, month: number, day: number;

  if (a > 31) {
    // 年在前：YYYY-MM-DD
    year = a; month = b; day = c;
  } else if (c > 31) {
    // 日在前：dd-MM-YYYY（航司口径）
    day = a; month = b; year = c;
  } else {
    // 首段 ≤ 31、末段 ≤ 31：无法区分，兜底年在前（如 YY-MM-DD 罕见，不处理）
    year = a; month = b; day = c;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // 两位年扩展：0-68 → 2000s，69-99 → 1900s
  if (year < 100) year += year < 69 ? 2000 : 1900;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * @deprecated 旧名，保留向后兼容。请改用 parseDateCell。
 */
export function parseDobCell(value: ExcelJS.CellValue | undefined): string | null {
  return parseDateCell(value);
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
 * 解析 PNR 姓名列 → { lastName, firstName } | null。
 * 接受「LAST/FIRST」（航司口径）或「姓 名」（空格分隔）。
 * 无法拆分 → null（调用方自行降级到 fullName）。
 */
function parsePnrName(text: string): { lastName: string; firstName: string } | null {
  if (!text) return null;
  // 航司标准：LAST/FIRST（含 LAST/FIRSTMR 等称谓后缀）
  const slash = text.indexOf('/');
  if (slash > 0) {
    const last = text.slice(0, slash).trim();
    const first = text.slice(slash + 1).trim();
    if (last && first) return { lastName: last, firstName: first };
  }
  // 空格分隔（中文姓名："王 明"，或直接用中文全名）
  const parts = text.trim().split(/\s+/);
  if (parts.length >= 2) {
    return { lastName: parts[0], firstName: parts.slice(1).join(' ') };
  }
  return null;
}

/**
 * 国籍字段标准化 → 2-letter ISO（CN / XX 等）。
 * 接受 2-letter（直接用）、3-letter alpha-3（如 CHN → CN）。
 * 无法识别 → 原值（让调用方自行处置）。
 */
function normalizeNationality(text: string): string {
  const t = text.trim().toUpperCase();
  if (t.length === 2) return t; // 已是 2-letter
  // 常见 alpha-3 对照
  const alpha3ToAlpha2: Record<string, string> = {
    CHN: 'CN', USA: 'US', GBR: 'GB', DEU: 'DE', FRA: 'FR', JPN: 'JP',
    KOR: 'KR', AUS: 'AU', CAN: 'CA', HKG: 'HK', MAC: 'MO', TWN: 'TW',
    SGP: 'SG', MYS: 'MY', THA: 'TH', VNM: 'VN', IDN: 'ID', PHL: 'PH',
    IND: 'IN', RUS: 'RU', BRA: 'BR', MEX: 'MX', ZAF: 'ZA',
  };
  return alpha3ToAlpha2[t] ?? text.trim();
}

/**
 * 证件类型标准化 → 'PASSPORT' | 'ID_CARD' | 原值。
 */
function normalizeDocumentType(text: string): string {
  const t = text.trim().toUpperCase();
  if (t === '护照' || t === 'PASSPORT' || t === 'P') return 'PASSPORT';
  if (t === '身份证' || t === 'ID' || t === 'ID_CARD' || t === 'IDCARD' || t === 'NID') return 'ID_CARD';
  return text.trim();
}

/**
 * 解析名单 .xlsx（base64）→ { rows, warnings }。
 *
 * 支持 11 列新模版（中文姓名 | PNR 姓名 | 性别 | 出生日期 | 国籍 | 证件类型 |
 * 证件号 | 签发日期 | 有效日期 | 婴儿同行成人 | 备注）。
 * 向后兼容旧 4 列模版（姓名 | 护照号 | 出生日期 | 性别）：
 *   旧模版列1=姓名、列2=护照号，自动判别（列2 首格等于「护照号」/「PASSPORT NO」则走旧路径）。
 *
 * 容错规则：
 * - 第 1 行视为表头 → 跳过（若首格匹配已知表头字符串）。
 * - 整行空白 → 跳过，不计数、不 warning。
 * - 姓名或证件号都缺 → 收 warning 跳过。
 * - 日期/性别单格不可解析 → 收 warning，字段留空，保留该行。
 * - 超过 ROSTER_MAX_ROWS 行 → 截断并 warning。
 * - 文件损坏/非 xlsx → 抛错由路由层转 400。
 */
export async function parseRosterXlsx(fileBase64: string): Promise<RosterParseResult> {
  const buf = Buffer.from(fileBase64, 'base64');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);

  const ws = wb.worksheets[0];
  const warnings: string[] = [];
  const rows: RosterRow[] = [];
  if (!ws) {
    warnings.push('未找到任何工作表');
    return { rows, warnings };
  }

  // ── 判别新旧模版：检查第 1 行首格 ──────────────────────────────────────
  // 新模版：列1 = '中文姓名'（ROSTER_HEADERS[0]）
  // 旧模版：列1 = '姓名'，列2 = '护照号'
  const r1 = ws.getRow(1);
  const r1c1 = cellText(r1.getCell(1).value).trim();
  const r1c2 = cellText(r1.getCell(2).value).trim();
  const isOldTemplate =
    (r1c1 === '姓名' && (r1c2 === '护照号' || r1c2.toUpperCase() === 'PASSPORT NO')) ||
    (r1c1 === '姓名' && r1c2 === '');
  // 新模版：首格等于 ROSTER_HEADERS[0]（中文姓名）时跳过表头行
  const isNewTemplate = r1c1 === ROSTER_HEADERS[0] || r1c1 === '中文姓名';

  let dataRowCount = 0;
  let truncated = false;

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (truncated) return;

    // 跳过表头行
    if (rowNumber === 1 && (isOldTemplate || isNewTemplate)) return;

    if (isOldTemplate) {
      // ── 旧模版（4 列）: 姓名 | 护照号 | 出生日期 | 性别 ─────────────────
      const nameCell = cellText(row.getCell(1).value).trim();
      const passportNo = cellText(row.getCell(2).value).trim();
      const dobRaw = row.getCell(3).value;
      const genderRaw = row.getCell(4).value;

      const dobText = cellText(dobRaw).trim();
      const genderText = cellText(genderRaw).trim();
      if (!nameCell && !passportNo && !dobText && !genderText) return;

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

      const out: RosterRow = {
        fullName: nameCell,
        passportNo: passportNo || undefined,
        documentNumber: passportNo || undefined,
      };

      if (dobText) {
        const dob = parseDateCell(dobRaw);
        if (dob) { out.dob = dob; out.dateOfBirth = dob; }
        else warnings.push(`第 ${rowNumber} 行（${nameCell}）：出生日期「${dobText}」无法解析，已留空`);
      }

      if (genderText) {
        const gender = parseGenderCell(genderRaw);
        if (gender) out.gender = gender;
        else warnings.push(`第 ${rowNumber} 行（${nameCell}）：性别「${genderText}」无法识别，已留空`);
      }

      rows.push(out);
      return;
    }

    // ── 新模版（11 列）─────────────────────────────────────────────────────
    const fullNameText  = cellText(row.getCell(ROSTER_COL.fullName).value).trim();
    const pnrText       = cellText(row.getCell(ROSTER_COL.pnrName).value).trim();
    const genderRaw     = row.getCell(ROSTER_COL.gender).value;
    const dobRaw        = row.getCell(ROSTER_COL.dateOfBirth).value;
    const nationalityT  = cellText(row.getCell(ROSTER_COL.nationality).value).trim();
    const docTypeT      = cellText(row.getCell(ROSTER_COL.documentType).value).trim();
    const docNumT       = cellText(row.getCell(ROSTER_COL.documentNumber).value).trim();
    const issueDateRaw  = row.getCell(ROSTER_COL.issueDate).value;
    const expiryDateRaw = row.getCell(ROSTER_COL.expiryDate).value;
    const infantT       = cellText(row.getCell(ROSTER_COL.infantCompanion).value).trim();
    const remarksT      = cellText(row.getCell(ROSTER_COL.remarks).value).trim();

    // 整行空白 → 跳过
    if (
      !fullNameText && !pnrText && !docNumT &&
      !cellText(dobRaw).trim() && !cellText(genderRaw).trim()
    ) return;

    // 至少需要姓名或证件号其中一项
    const hasName = Boolean(fullNameText || pnrText);
    const hasDoc  = Boolean(docNumT);
    if (!hasName && !hasDoc) {
      warnings.push(`第 ${rowNumber} 行：姓名与证件号均为空，已跳过`);
      return;
    }

    if (dataRowCount >= ROSTER_MAX_ROWS) {
      truncated = true;
      warnings.push(`名单超过 ${ROSTER_MAX_ROWS} 行，仅解析前 ${ROSTER_MAX_ROWS} 行`);
      return;
    }
    dataRowCount += 1;

    const displayName = fullNameText || pnrText || docNumT;
    const out: RosterRow = {};

    if (fullNameText) {
      out.chineseName = fullNameText; // 列1专门给中文姓名
      out.fullName    = fullNameText; // fullName 兜底
    }

    // 解析 PNR 姓名 → lastName / firstName
    if (pnrText) {
      const pnr = parsePnrName(pnrText);
      if (pnr) {
        out.lastName  = pnr.lastName;
        out.firstName = pnr.firstName;
        // 若无中文姓名则用 PNR 全名兜底 fullName（chineseName 仍留 undefined）
        if (!out.fullName) out.fullName = pnrText;
      } else if (!out.fullName) {
        out.fullName = pnrText;
      }
    }

    // 性别
    const genderText = cellText(genderRaw).trim();
    if (genderText) {
      const gender = parseGenderCell(genderRaw);
      if (gender) out.gender = gender;
      else warnings.push(`第 ${rowNumber} 行（${displayName}）：性别「${genderText}」无法识别，已留空`);
    }

    // 出生日期
    const dobText = cellText(dobRaw).trim();
    if (dobText) {
      const dob = parseDateCell(dobRaw);
      if (dob) { out.dateOfBirth = dob; out.dob = dob; }
      else warnings.push(`第 ${rowNumber} 行（${displayName}）：出生日期「${dobText}」无法解析，已留空`);
    }

    // 国籍
    if (nationalityT) out.nationality = normalizeNationality(nationalityT);

    // 证件类型
    if (docTypeT) out.documentType = normalizeDocumentType(docTypeT);

    // 证件号
    if (docNumT) { out.documentNumber = docNumT; out.passportNo = docNumT; }

    // 签发日期（护照签发日期；同时保留已废弃的 visaIssueDate 别名）
    const issueText = cellText(issueDateRaw).trim();
    if (issueText) {
      const d = parseDateCell(issueDateRaw);
      if (d) {
        out.passportIssueDate = d;
        out.visaIssueDate     = d; // 向后兼容
      } else {
        warnings.push(`第 ${rowNumber} 行（${displayName}）：签发日期「${issueText}」无法解析，已留空`);
      }
    }

    // 有效日期
    const expiryText = cellText(expiryDateRaw).trim();
    if (expiryText) {
      const d = parseDateCell(expiryDateRaw);
      if (d) out.passportExpiry = d;
      else warnings.push(`第 ${rowNumber} 行（${displayName}）：有效日期「${expiryText}」无法解析，已留空`);
    }

    if (infantT) out.infantCompanion = infantT;
    if (remarksT) out.remarks = remarksT;

    rows.push(out);
  });

  return { rows, warnings };
}
