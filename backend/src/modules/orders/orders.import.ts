/**
 * 旧系统表格导入（批量录单）—— 解析 + 匹配，纯预览不落库。
 *
 * 旧系统模版两种（按表头文字自动识别，列序容错：按表头名定位列，不死记列号）：
 *   单程 16 列：选择代理|航班号|航班日期(yyyy-MM-dd)|舱位|结算价格|中文姓名|乘客姓名|
 *              与婴儿乘客通行成人姓名|乘客性别|乘客生日(dd-MM-yyyy)|公民身份/国籍|
 *              证件类型|证件编号|签发日期(dd-MM-yyyy)|有效日期(dd-MM-yyyy)|备注
 *   往返 18 列：前 5 列换成 选择代理|去程航班号|去程航班日期|返程航班号|返程航班日期，其余同。
 *
 * 日期口径：航班日期 yyyy-MM-dd；生日/签发/有效日期 dd-MM-yyyy。两类都复用
 * roster.ts 的 parseDateCellDetailed（自动判别年前/日前 + Excel 日期单元格 + 歧义拒收）。
 *
 * .xls 取舍：exceljs 只读 .xlsx。旧 .xls（OLE 容器）按魔数识别后给明确中文 400
 * 提示「另存为 .xlsx」，不引入额外 .xls 解析依赖。
 *
 * 解析结果只作预览：前端把行灌进批量创单表格供人工复核，创建仍走 POST /orders/batch。
 */
import ExcelJS from 'exceljs';
import { localDateISO } from '../../lib/flight-time.js';
import { CabinClass, PassengerType } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { parseDateCellDetailed, parseGenderCell } from './roster.js';
import { SETTLEMENT_PRICE_CAP_CNY } from './orders.schemas.js';
import { derivePtcByAge } from './pnr-export.js';

// ── 上限 ──────────────────────────────────────────────────────────────────
/** 上传文件大小上限（解码后字节数）。*/
export const ORDER_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
/** 数据行上限：对齐批量创单 passengers ≤ 100。*/
export const ORDER_IMPORT_MAX_ROWS = 100;

/** 解析级错误（整文件不可用）→ 路由层转 400，message 直接面向操作人。*/
export class OrderImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderImportError';
  }
}

export type OrderImportTemplate = 'ONEWAY' | 'ROUNDTRIP';

export interface OrderImportLeg {
  /** 去程 outbound / 返程 inbound */
  kind: 'outbound' | 'inbound';
  flightNo: string;
  /** YYYY-MM-DD；解析失败 → null（行级错误已记）。*/
  date: string | null;
  /** 匹配到的班次（resolve 阶段填充；查无 → null + 行级错误）。*/
  scheduleId: string | null;
  flightId: string | null;
}

export interface OrderImportPassenger {
  chineseName?: string;
  /** 兜底全名：中文姓名优先，否则乘客姓名原文。*/
  fullName?: string;
  lastName?: string;
  firstName?: string;
  gender?: 'M' | 'F';
  dateOfBirth?: string;
  nationality?: string;
  documentType?: 'PASSPORT' | 'ID_CARD';
  documentNumber?: string;
  passportIssueDate?: string;
  passportExpiry?: string;
  infantCompanion?: string;
  note?: string;
  /**
   * 乘客类型：按「出生日期 + 出发日」推算（与 pnr-export.ts 的 derivePtcByAge 同一口径，
   * <2 岁婴儿 / 2–<12 岁儿童 / ≥12 岁成人），而非沿用表格里从未采集过的手录值——
   * 旧模版名单本就没有 passengerType 列，落库过去一直静默按成人处理（多收钱 + 虚占座）。
   * 出生日期缺失时不设，建单侧走 schema 默认值（成人）。
   */
  passengerType?: PassengerType;
}

export interface OrderImportRow {
  /** Excel 行号（1-based，含表头行）——报错定位用。*/
  rowNumber: number;
  agentText: string;
  cabinText: string;
  cabin: CabinClass | null;
  settlementPriceCny: number | null;
  legs: OrderImportLeg[];
  passenger: OrderImportPassenger;
  errors: string[];
  warnings: string[];
}

export interface OrderImportParseOutput {
  template: OrderImportTemplate;
  rows: OrderImportRow[];
  warnings: string[];
}

// ── 匹配（resolve）阶段 ────────────────────────────────────────────────────
export interface OrderImportAgentLite {
  id: string;
  companyName: string | null;
  contactName: string;
}

export interface OrderImportScheduleLite {
  id: string;
  flightId: string;
  flightNumber: string;
  /** 起飞日期（departureTime 的 UTC 日期，与后台班次下拉 slice(0,10) 同口径）。*/
  departureDate: string;
}

export interface OrderImportMatchDeps {
  listAgents(): Promise<OrderImportAgentLite[]>;
  findSchedules(pairs: Array<{ flightNo: string; date: string }>): Promise<OrderImportScheduleLite[]>;
}

export interface OrderImportAgentMatch {
  text: string;
  /** 唯一匹配 → 代理 id；歧义/无 → null，由前端在候选里选。*/
  agentId: string | null;
  candidates: Array<{ id: string; label: string }>;
}

export interface OrderImportBatchSummary {
  outbound: { flightNo: string; date: string; flightId: string | null; scheduleId: string | null } | null;
  inbound: { flightNo: string; date: string; flightId: string | null; scheduleId: string | null } | null;
  cabin: CabinClass | null;
  agent: OrderImportAgentMatch | null;
  settlementPriceCny: number | null;
}

export interface OrderImportResolvedResult {
  template: OrderImportTemplate;
  rows: OrderImportRow[];
  warnings: string[];
  batch: OrderImportBatchSummary;
}

// ── 单元格工具（roster.ts 同款逻辑；私有函数无法复用，这里保留最小副本）────
function cellText(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return parseDateCellDetailed(value).iso ?? '';
  }
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    if ('richText' in v && Array.isArray(v.richText)) {
      return v.richText.map((rt) => String((rt as { text?: unknown }).text ?? '')).join('');
    }
    if ('text' in v && v.text !== undefined) return String(v.text);
    if ('result' in v && v.result !== undefined) return String(v.result);
    return '';
  }
  return String(value).trim();
}

/** 国籍标准化 → 2 位码（CHN→CN 等常见 alpha-3 对照；识别不了返回原值）。*/
function normalizeNationality(text: string): string {
  const raw = text.trim();
  if (raw === '中国') return 'CN';
  const t = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(t)) return t;
  const alpha3: Record<string, string> = {
    CHN: 'CN', USA: 'US', GBR: 'GB', DEU: 'DE', FRA: 'FR', JPN: 'JP',
    KOR: 'KR', AUS: 'AU', CAN: 'CA', HKG: 'HK', MAC: 'MO', TWN: 'TW',
    SGP: 'SG', MYS: 'MY', THA: 'TH', VNM: 'VN', IDN: 'ID', PHL: 'PH',
    IND: 'IN', RUS: 'RU', BRA: 'BR', MEX: 'MX', ZAF: 'ZA',
  };
  return alpha3[t] ?? raw;
}

/** 乘客姓名（PNR）拆姓/名：LAST/FIRST 或空格分隔；拆不开 → null。*/
function parsePnrName(text: string): { lastName: string; firstName: string } | null {
  if (!text) return null;
  const slash = text.indexOf('/');
  if (slash > 0) {
    const last = text.slice(0, slash).trim();
    const first = text.slice(slash + 1).trim();
    if (last && first) return { lastName: last, firstName: first };
  }
  const parts = text.trim().split(/\s+/);
  if (parts.length >= 2) return { lastName: parts[0], firstName: parts.slice(1).join(' ') };
  return null;
}

/** 舱位文本 → 系统枚举。兼容中文/英文/舱位代码常见写法；对不上 → null。*/
export function matchCabinText(text: string): CabinClass | null {
  const t = text.trim().toUpperCase();
  if (!t) return null;
  const map: Record<string, CabinClass> = {
    // 经济舱
    经济舱: CabinClass.ECONOMY, 经济: CabinClass.ECONOMY, ECONOMY: CabinClass.ECONOMY,
    ECO: CabinClass.ECONOMY, Y: CabinClass.ECONOMY,
    // 超级经济舱
    超级经济舱: CabinClass.PREMIUM_ECONOMY, 高端经济舱: CabinClass.PREMIUM_ECONOMY,
    豪华经济舱: CabinClass.PREMIUM_ECONOMY, PREMIUM_ECONOMY: CabinClass.PREMIUM_ECONOMY,
    W: CabinClass.PREMIUM_ECONOMY,
    // 商务舱
    商务舱: CabinClass.BUSINESS, 商务: CabinClass.BUSINESS, BUSINESS: CabinClass.BUSINESS,
    C: CabinClass.BUSINESS, J: CabinClass.BUSINESS,
    // 头等舱
    头等舱: CabinClass.FIRST, 头等: CabinClass.FIRST, FIRST: CabinClass.FIRST, F: CabinClass.FIRST,
  };
  return map[t] ?? null;
}

/**
 * derivePtcByAge 返回航司 PNR 码（ADT/CHD/INF）；建单落库用的是系统枚举
 * （ADULT/CHILD/INFANT）。年龄阈值判断已在 derivePtcByAge 里做过，这里只做码值转换，
 * 不重复实现推算逻辑。
 */
function ptcToPassengerType(ptc: string): PassengerType {
  const map: Record<string, PassengerType> = {
    ADT: PassengerType.ADULT,
    CHD: PassengerType.CHILD,
    INF: PassengerType.INFANT,
  };
  return map[ptc] ?? PassengerType.ADULT;
}

/** 证件类型文本 → 枚举；对不上 → null（调用方按口径默认护照 + 警告）。*/
function matchDocumentType(text: string): 'PASSPORT' | 'ID_CARD' | null {
  const t = text.trim().toUpperCase();
  if (!t) return null;
  if (t === '护照' || t === 'PASSPORT' || t === 'P') return 'PASSPORT';
  if (t === '身份证' || t === '居民身份证' || t === 'ID' || t === 'ID_CARD' || t === 'IDCARD') return 'ID_CARD';
  return null;
}

/** 结算价格单元格 → 数字（兼容 ¥/元/千分位文本）；解析不了 → null。*/
function parsePriceCell(value: ExcelJS.CellValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = cellText(value).replace(/[¥￥,，\s]/g, '').replace(/元$/u, '');
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** 读日期字段：解析 + 把「Excel 转过 / 歧义 / 解析失败」写进行级提示。*/
function readDateCell(
  raw: ExcelJS.CellValue | undefined,
  label: string,
  errors: string[],
  warnings: string[],
  opts: { required: boolean },
): string | null {
  const text = cellText(raw).trim();
  if (!text && !(raw instanceof Date)) {
    if (opts.required) errors.push(`${label}未填`);
    return null;
  }
  const { iso, doubt } = parseDateCellDetailed(raw);
  if (doubt === 'EXCEL_DATE' && iso) {
    warnings.push(`${label}被 Excel 识别为日期单元格，已按 ${iso}（年-月-日）读取，请核对`);
    return iso;
  }
  if (doubt === 'DAY_MONTH_AMBIGUOUS') {
    errors.push(`${label}「${text}」各段数字均 ≤31，无法判定年/月/日顺序，请改成明确写法（如 15-07-1988 或 1988-07-15）`);
    return null;
  }
  if (!iso) {
    errors.push(`${label}「${text}」无法解析`);
    return null;
  }
  return iso;
}

// ── 表头识别 ──────────────────────────────────────────────────────────────
type ColKey =
  | 'agent' | 'outboundFlightNo' | 'outboundDate' | 'returnFlightNo' | 'returnDate'
  | 'cabin' | 'settlementPrice' | 'chineseName' | 'pnrName' | 'infantCompanion'
  | 'gender' | 'dob' | 'nationality' | 'docType' | 'docNumber'
  | 'issueDate' | 'expiryDate' | 'remarks';

/** 表头名（去掉括号里的格式说明后）→ 列语义。含少量宽容别名。*/
const HEADER_MAP: Record<string, ColKey> = {
  选择代理: 'agent',
  代理: 'agent',
  航班号: 'outboundFlightNo',
  航班日期: 'outboundDate',
  去程航班号: 'outboundFlightNo',
  去程航班日期: 'outboundDate',
  返程航班号: 'returnFlightNo',
  返程航班日期: 'returnDate',
  回程航班号: 'returnFlightNo',
  回程航班日期: 'returnDate',
  舱位: 'cabin',
  结算价格: 'settlementPrice',
  结算价: 'settlementPrice',
  中文姓名: 'chineseName',
  乘客姓名: 'pnrName',
  与婴儿乘客通行成人姓名: 'infantCompanion',
  乘客性别: 'gender',
  性别: 'gender',
  乘客生日: 'dob',
  出生日期: 'dob',
  '公民身份/国籍': 'nationality',
  国籍: 'nationality',
  证件类型: 'docType',
  证件编号: 'docNumber',
  证件号: 'docNumber',
  签发日期: 'issueDate',
  有效日期: 'expiryDate',
  备注: 'remarks',
};

/** 去掉表头里的格式说明：`航班日期(yyyy-MM-dd)` → `航班日期`；全/半角括号都认。*/
function normalizeHeader(text: string): string {
  return text.replace(/[（(].*$/u, '').replace(/\s+/g, '').trim();
}

// ── 解析 ──────────────────────────────────────────────────────────────────
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * 解析旧系统模版 .xlsx（base64）→ 模版类型 + 逐行标准化结果 + 行级错误。
 * 整文件不可用（超大 / .xls / 非 xlsx / 空表 / 表头对不上）→ 抛 OrderImportError（路由转 400）。
 */
export async function parseOrderImportXlsx(fileBase64: string): Promise<OrderImportParseOutput> {
  const buf = Buffer.from(fileBase64, 'base64');
  if (buf.byteLength === 0) throw new OrderImportError('文件内容为空，请重新选择文件');
  if (buf.byteLength > ORDER_IMPORT_MAX_BYTES) {
    throw new OrderImportError('文件超过 2MB，请精简表格后再上传');
  }
  if (buf.byteLength >= 8 && buf.subarray(0, 8).equals(OLE_MAGIC)) {
    throw new OrderImportError('这是旧版 .xls 文件，请在 Excel 里「另存为 .xlsx」后再上传');
  }
  // .xlsx 是 zip 容器，魔数 'PK'
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new OrderImportError('不是有效的 .xlsx 文件，请确认文件格式');
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch {
    throw new OrderImportError('表格文件无法解析，请确认为有效的 .xlsx 文件');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new OrderImportError('表格中没有工作表');

  // ── 表头定位（列序容错）────────────────────────────────────────────────
  const headerRow = ws.getRow(1);
  const cols = new Map<ColKey, number>();
  const unknownHeaders: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const name = normalizeHeader(cellText(cell.value));
    if (!name) return;
    const key = HEADER_MAP[name];
    if (key) {
      if (!cols.has(key)) cols.set(key, colNumber);
    } else {
      unknownHeaders.push(name);
    }
  });

  const template: OrderImportTemplate | null = cols.has('returnFlightNo')
    ? 'ROUNDTRIP'
    : cols.has('outboundFlightNo')
      ? 'ONEWAY'
      : null;
  if (!template) {
    throw new OrderImportError(
      '表头与旧系统模版对不上：未找到「航班号」或「去程航班号」列。请使用旧系统的单程（16 列）或往返（18 列）模版',
    );
  }

  const required: Array<[ColKey, string]> = [
    ['outboundDate', template === 'ROUNDTRIP' ? '去程航班日期' : '航班日期'],
    ...(template === 'ROUNDTRIP' ? ([['returnDate', '返程航班日期']] as Array<[ColKey, string]>) : []),
    ['docNumber', '证件编号'],
    ['dob', '乘客生日'],
  ];
  const missing = required.filter(([k]) => !cols.has(k)).map(([, label]) => label);
  if (!cols.has('chineseName') && !cols.has('pnrName')) missing.push('中文姓名/乘客姓名');
  if (missing.length > 0) {
    throw new OrderImportError(`表头缺少必需列：${missing.join('、')}，请使用旧系统模版`);
  }

  const warnings: string[] = [];
  if (unknownHeaders.length > 0) {
    warnings.push(`以下列无法识别，已忽略：${unknownHeaders.join('、')}`);
  }

  // ── 逐行解析 ──────────────────────────────────────────────────────────
  const rows: OrderImportRow[] = [];
  let truncated = false;
  const get = (row: ExcelJS.Row, key: ColKey): ExcelJS.CellValue | undefined =>
    cols.has(key) ? row.getCell(cols.get(key) as number).value : undefined;

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || truncated) return;

    // 整行空白 → 跳过（日期单元格也算有内容）
    let hasAny = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value instanceof Date || cellText(cell.value).trim()) hasAny = true;
    });
    if (!hasAny) return;

    if (rows.length >= ORDER_IMPORT_MAX_ROWS) {
      truncated = true;
      warnings.push(`表格超过 ${ORDER_IMPORT_MAX_ROWS} 行，仅解析前 ${ORDER_IMPORT_MAX_ROWS} 行（批量创单单批上限）`);
      return;
    }

    const errors: string[] = [];
    const rowWarnings: string[] = [];

    // 航段
    const legs: OrderImportLeg[] = [];
    const pushLeg = (kind: 'outbound' | 'inbound', noKey: ColKey, dateKey: ColKey, label: string): void => {
      const flightNo = cellText(get(row, noKey)).trim().toUpperCase();
      if (!flightNo) errors.push(`${label}航班号未填`);
      const date = readDateCell(get(row, dateKey), `${label}航班日期`, errors, rowWarnings, { required: true });
      legs.push({ kind, flightNo, date, scheduleId: null, flightId: null });
    };
    pushLeg('outbound', 'outboundFlightNo', 'outboundDate', template === 'ROUNDTRIP' ? '去程' : '');
    if (template === 'ROUNDTRIP') pushLeg('inbound', 'returnFlightNo', 'returnDate', '返程');

    // 舱位
    const cabinText = cellText(get(row, 'cabin')).trim();
    let cabin: CabinClass | null = null;
    if (cabinText) {
      cabin = matchCabinText(cabinText);
      if (!cabin) errors.push(`舱位「${cabinText}」无法识别（支持 经济舱/商务舱/Y/C 等写法）`);
    } else {
      rowWarnings.push('舱位未填，导入后默认经济舱，请核对');
    }

    // 结算价格
    const priceRaw = get(row, 'settlementPrice');
    let settlementPriceCny: number | null = null;
    const priceText = cellText(priceRaw).trim();
    if (priceText || typeof priceRaw === 'number') {
      const n = parsePriceCell(priceRaw);
      if (n === null) {
        rowWarnings.push(`结算价格「${priceText}」无法解析，已留空`);
      } else if (n < 0) {
        errors.push('结算价格不能为负');
      } else if (n > SETTLEMENT_PRICE_CAP_CNY) {
        errors.push(`结算价格超出上限（${SETTLEMENT_PRICE_CAP_CNY}）`);
      } else {
        settlementPriceCny = n;
      }
    }

    // 乘客
    const passenger: OrderImportPassenger = {};
    const chineseName = cellText(get(row, 'chineseName')).trim();
    const pnrText = cellText(get(row, 'pnrName')).trim();
    if (chineseName) {
      passenger.chineseName = chineseName;
      passenger.fullName = chineseName;
    }
    if (pnrText) {
      const pnr = parsePnrName(pnrText);
      if (pnr) {
        passenger.lastName = pnr.lastName;
        passenger.firstName = pnr.firstName;
      }
      if (!passenger.fullName) passenger.fullName = pnrText;
    }
    if (!passenger.fullName) errors.push('中文姓名与乘客姓名均为空');

    const genderRaw = get(row, 'gender');
    const genderText = cellText(genderRaw).trim();
    if (genderText) {
      const g = parseGenderCell(genderRaw);
      if (g) passenger.gender = g;
      else rowWarnings.push(`性别「${genderText}」无法识别，请导入后手动选择`);
    } else {
      rowWarnings.push('性别未填，批量创单前需补选');
    }

    const dob = readDateCell(get(row, 'dob'), '乘客生日', errors, rowWarnings, { required: true });
    if (dob) passenger.dateOfBirth = dob;

    const natText = cellText(get(row, 'nationality')).trim();
    if (natText) {
      const nat = normalizeNationality(natText);
      if (/^[A-Z]{2}$/.test(nat)) passenger.nationality = nat;
      else rowWarnings.push(`国籍「${natText}」无法识别为 2 位国家码，已按 CN 处理，请核对`);
    }

    const docTypeText = cellText(get(row, 'docType')).trim();
    if (docTypeText) {
      const dt = matchDocumentType(docTypeText);
      if (dt) passenger.documentType = dt;
      else {
        passenger.documentType = 'PASSPORT';
        rowWarnings.push(`证件类型「${docTypeText}」无法识别，已默认按护照处理，请核对`);
      }
    }

    const docNumber = cellText(get(row, 'docNumber')).trim();
    if (docNumber) passenger.documentNumber = docNumber;
    else errors.push('证件编号未填');

    const issueDate = readDateCell(get(row, 'issueDate'), '签发日期', errors, rowWarnings, { required: false });
    if (issueDate) passenger.passportIssueDate = issueDate;

    // 有效日期：批量创单必填 → 空/解析失败都算行级错误，让操作人当场补
    const expiryRaw = get(row, 'expiryDate');
    const expiry = readDateCell(expiryRaw, '有效日期', errors, rowWarnings, { required: false });
    if (expiry) passenger.passportExpiry = expiry;
    else if (!cellText(expiryRaw).trim() && !(expiryRaw instanceof Date)) {
      errors.push('有效日期未填（批量创单必填）');
    }

    const infant = cellText(get(row, 'infantCompanion')).trim();
    if (infant) passenger.infantCompanion = infant;
    const remarks = cellText(get(row, 'remarks')).trim();
    if (remarks) passenger.note = remarks;

    // 乘客类型：出生日期已知 → 按出生日期 + 出发日（去程航段）推算；未知 → 不设，
    // 沿用建单侧的默认值（成人）。出发日缺失/未匹配也没关系，derivePtcByAge 自身会
    // 在拿不到出发日时回退成人，不会抛错也不会误判。
    if (dob) {
      const outboundLegDate = legs.find((l) => l.kind === 'outbound')?.date ?? null;
      const dobDate = new Date(`${dob}T00:00:00Z`);
      const departureDate = outboundLegDate ? new Date(`${outboundLegDate}T00:00:00Z`) : null;
      passenger.passengerType = ptcToPassengerType(derivePtcByAge(dobDate, departureDate, 'ADULT'));
    }

    rows.push({
      rowNumber,
      agentText: cellText(get(row, 'agent')).trim(),
      cabinText,
      cabin,
      settlementPriceCny,
      legs,
      passenger,
      errors,
      warnings: rowWarnings,
    });
  });

  if (rows.length === 0) {
    throw new OrderImportError('表格中没有数据行（表头下方为空），请填入乘客后再上传');
  }

  return { template, rows, warnings };
}

// ── 匹配 ──────────────────────────────────────────────────────────────────
function agentLabel(a: OrderImportAgentLite): string {
  return a.companyName ? `${a.companyName} · ${a.contactName}` : a.contactName;
}

/** 代理文本模糊匹配：先精确（公司名/联系人），再互相包含；唯一命中才带 agentId。*/
export function matchAgentText(text: string, agents: OrderImportAgentLite[]): OrderImportAgentMatch {
  const t = text.replace(/\s+/g, '').toLowerCase();
  const norm = (s: string | null): string => (s ?? '').replace(/\s+/g, '').toLowerCase();
  const exact = agents.filter((a) => norm(a.companyName) === t || norm(a.contactName) === t);
  const pool = exact.length > 0
    ? exact
    : agents.filter((a) => {
        const cn = norm(a.companyName);
        const pn = norm(a.contactName);
        return (cn.length > 0 && (cn.includes(t) || t.includes(cn))) ||
               (pn.length > 0 && (pn.includes(t) || t.includes(pn)));
      });
  return {
    text,
    agentId: pool.length === 1 ? pool[0].id : null,
    candidates: pool.slice(0, 10).map((a) => ({ id: a.id, label: agentLabel(a) })),
  };
}

/** 生产用匹配依赖：查库找班次 + 拉在职代理。*/
export function buildOrderImportMatchDeps(): OrderImportMatchDeps {
  return {
    async listAgents() {
      return prisma.agent.findMany({
        where: { isActive: true },
        select: { id: true, companyName: true, contactName: true },
      });
    },
    async findSchedules(pairs) {
      if (pairs.length === 0) return [];
      const flightNos = [...new Set(pairs.map((p) => p.flightNo))];
      const dates = pairs.map((p) => p.date).sort();
      const min = new Date(`${dates[0]}T00:00:00Z`);
      const max = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
      max.setUTCDate(max.getUTCDate() + 1);
      const schedules = await prisma.flightSchedule.findMany({
        where: {
          departureTime: { gte: min, lt: max },
          flight: { flightNumber: { in: flightNos, mode: 'insensitive' } },
        },
        select: {
          id: true,
          flightId: true,
          departureTime: true,
          departureTz: true,
          flight: { select: { flightNumber: true } },
        },
      });
      return schedules.map((s) => ({
        id: s.id,
        flightId: s.flightId,
        flightNumber: s.flight.flightNumber.toUpperCase(),
        // 出发日按出发地当地日：运营在表格里填的是当地出发日期，按 UTC 折会让
        // 当地凌晨起飞的班次匹配不上（差一天）。
        departureDate: localDateISO(s.departureTime, s.departureTz),
      }));
    },
  };
}

/**
 * 匹配阶段：班次（航班号+日期 → scheduleId）、代理（文本 → 候选）、批次汇总。
 *
 * 批量创单一批只能用同一班次/舱位/代理/结算价 → 以首行为准生成 batch 汇总；
 * 与首行不一致的行标行级错误（请拆批），绝不静默把人塞进别的航班。
 *
 * opts.includeSettlement / includeAgent = false（代理身份上传）时：结算价与归属代理
 * 两列忽略并出提示（结算价由系统按代理价计算；归属自动为本代理）。
 */
export async function resolveOrderImport(
  parsed: OrderImportParseOutput,
  deps: OrderImportMatchDeps,
  opts: { includeSettlement: boolean; includeAgent: boolean },
): Promise<OrderImportResolvedResult> {
  const warnings = [...parsed.warnings];
  // 不改入参：逐行建新对象（errors/warnings/legs 均为新数组）
  const rows: OrderImportRow[] = parsed.rows.map((r) => ({
    ...r,
    legs: r.legs.map((l) => ({ ...l })),
    errors: [...r.errors],
    warnings: [...r.warnings],
    passenger: { ...r.passenger },
  }));

  // ── 班次匹配 ──────────────────────────────────────────────────────────
  const pairs = new Map<string, { flightNo: string; date: string }>();
  for (const row of rows) {
    for (const leg of row.legs) {
      if (leg.flightNo && leg.date) {
        pairs.set(`${leg.flightNo}|${leg.date}`, { flightNo: leg.flightNo, date: leg.date });
      }
    }
  }
  const schedules = await deps.findSchedules([...pairs.values()]);
  const byKey = new Map<string, OrderImportScheduleLite[]>();
  for (const s of schedules) {
    const key = `${s.flightNumber}|${s.departureDate}`;
    byKey.set(key, [...(byKey.get(key) ?? []), s]);
  }
  for (const row of rows) {
    for (const leg of row.legs) {
      if (!leg.flightNo || !leg.date) continue;
      const matched = byKey.get(`${leg.flightNo}|${leg.date}`) ?? [];
      if (matched.length === 0) {
        row.errors.push(`查无班次：${leg.flightNo} ${leg.date}（请确认航班号与日期，或先在航班管理里排班）`);
      } else if (matched.length === 1) {
        leg.scheduleId = matched[0].id;
        leg.flightId = matched[0].flightId;
      } else {
        leg.flightId = matched[0].flightId;
        row.warnings.push(`${leg.flightNo} ${leg.date} 当日有多个班次，请在页面上手动选择班次`);
      }
    }
  }

  // ── 代理匹配 ──────────────────────────────────────────────────────────
  let agentMatch: OrderImportAgentMatch | null = null;
  const agentTexts = [...new Set(rows.map((r) => r.agentText).filter(Boolean))];
  if (!opts.includeAgent) {
    if (agentTexts.length > 0) {
      warnings.push('「选择代理」列已忽略：代理录单自动归属本代理账号');
    }
  } else if (agentTexts.length > 0) {
    const agents = await deps.listAgents();
    agentMatch = matchAgentText(agentTexts[0], agents);
    if (agentMatch.agentId === null) {
      warnings.push(
        agentMatch.candidates.length === 0
          ? `代理「${agentMatch.text}」未匹配到系统代理，请手动选择归属代理`
          : `代理「${agentMatch.text}」匹配到多个候选（${agentMatch.candidates.map((c) => c.label).join('、')}），请手动选择`,
      );
    }
    if (agentTexts.length > 1) {
      warnings.push(
        `表格中出现多个代理（${agentTexts.join('、')}），本批只能归属一个代理，已按第一个处理，请把其余行拆到另一批`,
      );
    }
  }

  // ── 结算价 ────────────────────────────────────────────────────────────
  let batchSettlement: number | null = null;
  const prices = [...new Set(rows.map((r) => r.settlementPriceCny).filter((p): p is number => p !== null))];
  if (!opts.includeSettlement) {
    if (prices.length > 0) {
      warnings.push('「结算价格」列已忽略：代理录单结算价由系统按代理价计算');
      for (const row of rows) row.settlementPriceCny = null;
    }
  } else if (prices.length === 1) {
    batchSettlement = prices[0];
  } else if (prices.length > 1) {
    warnings.push(`表格中结算价格不一致（${prices.join('、')}），未自动填入，请核对后手动填写`);
  }

  // ── 批次汇总（以首行为准；不一致的行标错误）──────────────────────────
  const first = rows[0];
  const firstLeg = (kind: 'outbound' | 'inbound'): OrderImportLeg | undefined =>
    first.legs.find((l) => l.kind === kind);
  const toSummary = (leg: OrderImportLeg | undefined) =>
    leg && leg.flightNo && leg.date
      ? { flightNo: leg.flightNo, date: leg.date, flightId: leg.flightId, scheduleId: leg.scheduleId }
      : null;

  for (const row of rows.slice(1)) {
    for (const kind of ['outbound', 'inbound'] as const) {
      const a = firstLeg(kind);
      const b = row.legs.find((l) => l.kind === kind);
      if (!a || !b) continue;
      if ((b.flightNo && a.flightNo && b.flightNo !== a.flightNo) || (b.date && a.date && b.date !== a.date)) {
        row.errors.push(
          `${kind === 'outbound' ? '去程' : '返程'}（${b.flightNo} ${b.date ?? ''}）与第一行（${a.flightNo} ${a.date ?? ''}）不一致：一批只能用同一班次，请把该行拆到另一批导入`,
        );
      }
    }
    if (row.cabin && first.cabin && row.cabin !== first.cabin) {
      row.warnings.push(`舱位（${row.cabinText}）与第一行（${first.cabinText}）不一致，本批将按第一行舱位建单，请核对`);
    }
  }

  return {
    template: parsed.template,
    rows,
    warnings,
    batch: {
      outbound: toSummary(firstLeg('outbound')),
      inbound: parsed.template === 'ROUNDTRIP' ? toSummary(firstLeg('inbound')) : null,
      cabin: first.cabin,
      agent: agentMatch,
      settlementPriceCny: batchSettlement,
    },
  };
}
