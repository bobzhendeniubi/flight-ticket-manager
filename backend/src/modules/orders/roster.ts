/**
 * 旅游团名单（roster）—— 模版下载 + 解析。
 *
 * 流程：导出名单模版（.xlsx）→ 把收单群里的名单填进模版 → 上传解析回出行人行，
 * 用于批量留位 / 批量建单。解析力求宽容：跳过空行、容错日期格式、单格不可解析
 * 只收集 warning 而绝不整文件抛错。
 *
 * 复用后端既有依赖 exceljs（与 orders.export-templates.ts / pnr-export.ts 同款）。
 *
 * 乘客类型（passengerType）：本模版没有出发日期/航班列（团期名单先于选定航班存在，
 * 一份名单可能配到不同航班），无法在这一层用 pnr-export.ts 的 derivePtcByAge 按
 * 「出生日期 + 出发日」推算。这里如实解析出 dateOfBirth 即可——调用方（批量创单表单）
 * 拿到出生日期后，结合当时已选定的航班出发日自行派生 passengerType；不要在没有出发日
 * 的情况下猜一个值填进来。
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
  '出生日期(YYYY-MM-DD)',
  '国籍(CN/CHN等)',
  '证件类型(护照/PASSPORT/身份证)',
  '证件号',
  '签发日期(YYYY-MM-DD)',
  '证件有效期(YYYY-MM-DD)',
  '婴儿同行成人姓名',
  '备注',
] as const;

/**
 * 日期列（1-based）：出生日期 / 签发日期 / 证件有效期。
 * 模版把这三列设成文本格式，从源头掐掉「Excel 按 locale 自作主张把 01-07-1990
 * 转成日期单元格」——一旦转了，原始文本永久丢失，解析侧再聪明也无从校正。
 */
const ROSTER_DATE_COLS = [4, 8, 9] as const;

/** Excel「文本」单元格格式代码。*/
const TEXT_NUMFMT = '@';

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

  // 日期列设为文本格式：Excel 对文本列不做 locale 日期转换，用户敲什么存什么。
  // 列级 numFmt 会写进 xlsx 的 <col style>，对用户之后新敲进这一列的单元格同样生效。
  for (const col of ROSTER_DATE_COLS) {
    ws.getColumn(col).numFmt = TEXT_NUMFMT;
  }

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // 示例行（行2/行3）：一律演示 YYYY-MM-DD —— 模版只教一种写法。
  // 解析侧仍兼容 dd-MM-yyyy（老文件要能用），但模版不再示范它：示范了就等于
  // 邀请两种写法混在同一列里，而「日、月都 ≤12」时没有任何办法事后分辨谁是谁。
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
    dateOfBirth: '1988-07-15',
    nationality: 'CN',
    documentType: '护照',
    documentNumber: 'E87654321',
    issueDate: '2019-06-20',
    expiryDate: '2029-06-19',
    infantCompanion: '',
    remarks: '',
  });

  // 逐格再设一次：列级 style 在部分 Excel/WPS 版本里不会回落到已有单元格上。
  for (const rowNumber of [2, 3]) {
    for (const col of ROSTER_DATE_COLS) {
      ws.getRow(rowNumber).getCell(col).numFmt = TEXT_NUMFMT;
    }
  }

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
 * 日期单元格的「存疑原因」——解析出了值不等于这个值可信。
 *
 *   EXCEL_DATE          Excel 已把原文转成日期单元格。我们拿到的是**被 Excel 按它的
 *                       locale 解释过的结果**，原始文本不在文件里了 → 无从校正，只能
 *                       接受并让人回头核。
 *   DAY_MONTH_AMBIGUOUS 三段数字都 ≤31（如 05-06-07），年/月/日顺序无法自证 → 不猜。
 */
export type DateCellDoubt = 'EXCEL_DATE' | 'DAY_MONTH_AMBIGUOUS';

export interface DateCellParse {
  /** 'YYYY-MM-DD'；无法解析或拒收 → null。 */
  iso: string | null;
  /** 非空 = 这一格存疑，调用方必须发 warning。 */
  doubt: DateCellDoubt | null;
}

/**
 * 通用日期单元格解析器（详版）→ { iso, doubt }。
 *
 * 接受（自动判别，全部容错）：
 *   - Excel 日期序列格 → 接受，但标 EXCEL_DATE（见上）
 *   - YYYY-MM-DD / YYYY/M/D / YYYY.M.D（年在前；首段 >31 可自证）
 *   - dd-MM-yyyy / dd/MM/yyyy / dd.MM.yyyy（日在前；末段 >31 可自证，如 15-07-1988）
 *
 * 判别规则：**只在能自证时才判**——
 *   首段 >31 → 只可能是年 → 年在前；
 *   末段 >31 → 只可能是年 → 日在前（航司口径）；
 *   两头都 ≤31 → 无法自证 → 拒收（iso=null + DAY_MONTH_AMBIGUOUS）。
 *
 * 拒收而非兜底猜测：错的证件有效期要到送签/值机柜台才暴露（拒登机），
 * 代价远高于「这一格没填」。留空会在下游被必填校验/空白单元格抓到，猜错不会。
 */
export function parseDateCellDetailed(value: ExcelJS.CellValue | undefined): DateCellParse {
  if (value === null || value === undefined) return { iso: null, doubt: null };
  // Excel 已经解释过了：原文丢失，只能接受 + 标存疑。
  if (value instanceof Date) return { iso: excelDateToIso(value), doubt: 'EXCEL_DATE' };

  const text = cellText(value).trim();
  if (!text) return { iso: null, doubt: null };

  // ── 分隔符通配（-、/、.）────────────────────────────────────────────────
  const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(text);
  if (!m) return { iso: null, doubt: null };

  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);

  let year: number, month: number, day: number;

  if (a > 31) {
    // 年在前：YYYY-MM-DD（首段 >31 → 只可能是年）
    year = a; month = b; day = c;
  } else if (c > 31) {
    // 日在前：dd-MM-YYYY（末段 >31 → 只可能是年）
    day = a; month = b; year = c;
  } else {
    // 两头都 ≤31：05-06-07 既可能是 2005-06-07 也可能是 2007-06-05 或 2005 年 7 月 6 日…
    // 从前兜底当"年在前"并静默入库；现在拒收。
    return { iso: null, doubt: 'DAY_MONTH_AMBIGUOUS' };
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return { iso: null, doubt: null };
  // 两位年扩展：0-68 → 2000s，69-99 → 1900s
  // 仅在年份已自证（>31）时才走到这里，如 '90-01-15' / '15-07-88'。
  if (year < 100) year += year < 69 ? 2000 : 1900;

  return {
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    doubt: null,
  };
}

/**
 * 通用日期单元格解析器 → 'YYYY-MM-DD' | null。
 * 丢掉存疑信息的薄封装；要发 warning 的调用方请用 parseDateCellDetailed。
 */
export function parseDateCell(value: ExcelJS.CellValue | undefined): string | null {
  return parseDateCellDetailed(value).iso;
}

/**
 * @deprecated 旧名，保留向后兼容。请改用 parseDateCell。
 */
export function parseDobCell(value: ExcelJS.CellValue | undefined): string | null {
  return parseDateCell(value);
}

/**
 * 读一个日期列 → 'YYYY-MM-DD' | null，并把「存疑 / 解析失败」写进 warnings。
 *
 * 空格 → null 且不发 warning（等同没填）。
 * 存疑的三种归宿：
 *   EXCEL_DATE          → 接受解析结果，但回显出来让人核（原文已被 Excel 吃掉）
 *   DAY_MONTH_AMBIGUOUS → 留空 + warning（不猜，理由见 parseDateCellDetailed）
 *   解析不了             → 留空 + warning
 */
function readDateField(
  raw: ExcelJS.CellValue | undefined,
  label: string,
  rowNumber: number,
  displayName: string,
  warnings: string[],
): string | null {
  const text = cellText(raw).trim();
  if (!text) return null; // 没填 → 不是错误

  const { iso, doubt } = parseDateCellDetailed(raw);

  if (doubt === 'EXCEL_DATE' && iso) {
    warnings.push(
      `第 ${rowNumber} 行（${displayName}）：${label}该单元格被 Excel 识别为日期，` +
        `已按 ${iso} 读取（年-月-日）。若原文是「日-月-年」请核对；` +
        `原始文本已被 Excel 覆盖，系统无法自行校正。` +
        `建议重新下载模版填写——模版的日期列已设为文本格式，不会再被转换。`,
    );
    return iso;
  }

  if (doubt === 'DAY_MONTH_AMBIGUOUS') {
    warnings.push(
      `第 ${rowNumber} 行（${displayName}）：${label}「${text}」各段数字均 ≤31，` +
        `无法判定年/月/日顺序，已留空（不猜）。请改用 YYYY-MM-DD 重填，如 1990-01-15。`,
    );
    return null;
  }

  if (!iso) {
    warnings.push(`第 ${rowNumber} 行（${displayName}）：${label}「${text}」无法解析，已留空`);
    return null;
  }

  return iso;
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
 * - 日期存疑（Excel 转过 / 年月日顺序无法自证）→ 一律 warning，见 readDateField。
 *   **容错 ≠ 静默**：宽容是指"不整文件抛错"，不是"猜一个看起来合理的值塞进去"。
 * - 超过 ROSTER_MAX_ROWS 行 → 截断并 warning。
 * - 文件损坏/非 xlsx → 抛错由路由层转 400。
 *
 * warnings 由 POST /orders/roster/parse 原样返回给后台（见 orders.routes.ts），
 * 后台在导入预览里展示 → 操作人逐条核。
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

      const dob = readDateField(dobRaw, '出生日期', rowNumber, nameCell, warnings);
      if (dob) { out.dob = dob; out.dateOfBirth = dob; }

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
    const dob = readDateField(dobRaw, '出生日期', rowNumber, displayName, warnings);
    if (dob) { out.dateOfBirth = dob; out.dob = dob; }

    // 国籍
    if (nationalityT) out.nationality = normalizeNationality(nationalityT);

    // 证件类型
    if (docTypeT) out.documentType = normalizeDocumentType(docTypeT);

    // 证件号
    if (docNumT) { out.documentNumber = docNumT; out.passportNo = docNumT; }

    // 签发日期（护照签发日期；同时保留已废弃的 visaIssueDate 别名）
    const issueDate = readDateField(issueDateRaw, '签发日期', rowNumber, displayName, warnings);
    if (issueDate) {
      out.passportIssueDate = issueDate;
      out.visaIssueDate     = issueDate; // 向后兼容
    }

    // 证件有效期 —— 错了要到送签/值机柜台才暴露，所以存疑一律不猜（见 readDateField）
    const expiry = readDateField(expiryDateRaw, '证件有效期', rowNumber, displayName, warnings);
    if (expiry) out.passportExpiry = expiry;

    if (infantT) out.infantCompanion = infantT;
    if (remarksT) out.remarks = remarksT;

    rows.push(out);
  });

  return { rows, warnings };
}
