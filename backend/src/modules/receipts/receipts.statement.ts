/**
 * 二维码流水（收单平台对账单）解析 + 流水核对表导出。
 *
 * 业务：公司统一收款码的钱走收单平台，财务从平台导出流水 xlsx；
 * 本模块把流水行导入成 Receipt（source=STATEMENT_IMPORT，externalTxnId=交易流水号，唯一），
 * 之后「认款」沿用对账台现有认领（allocate）——已认/未认即 Receipt 状态，不另造概念。
 *
 * 解析容错（与名单导入 roster.ts 同纪律：宽容 ≠ 静默，可疑必 warning）：
 *   - 表头行自动定位（前 10 行内找含「交易流水号」的行），列序按表头名对号，不写死列号。
 *   - 仅「支付成功」行可导入；未支付/订单已关闭行保留在预览里但标记跳过。
 *   - 文件内流水号重复 → 后出现的行标记跳过（防平台导出叠加时段产生的重复）。
 *   - 金额/时间/流水号任一不可解析 → 该行标 invalid + warning，绝不猜值入库。
 *
 * 导出核对表：原流水字段 + 认款状态/认到订单/认款人/认款时间，供财务替代线下勾表。
 */
import ExcelJS from 'exceljs';
import { PaymentMethod } from '@prisma/client';

/** 单文件最多解析行数（收单平台单日流水远小于此；防误传超大文件拖垮内存）。 */
export const STATEMENT_MAX_ROWS = 2000;

/** 收单平台「支付成功」状态原文（其余状态一律不入池）。 */
const STATUS_SUCCESS = '支付成功';

/** 解析出的一行流水（未做 DB 去重——那步在 service 里对照现库）。 */
export interface StatementParsedRow {
  rowNumber: number;
  externalTxnId: string;
  /** 到账时间（+08:00 墙钟解释）；解析失败为 null（行会被标 invalid）。 */
  receivedAt: Date | null;
  amountCny: number | null;
  method: PaymentMethod;
  /** 平台原文（微信/支付宝/…），预览展示用。 */
  rawMethod: string;
  /** 平台交易状态原文（支付成功/未支付/订单已关闭/…）。 */
  rawStatus: string;
  /** 二维码备注 + 付款方备注合并（认款线索）。 */
  payerNote: string | null;
  /** 行内判定：ok=可导入；skipped_status=非支付成功；dup_in_file=文件内重复；invalid=字段解析失败。 */
  disposition: 'ok' | 'skipped_status' | 'dup_in_file' | 'invalid';
}

export interface StatementParseResult {
  rows: StatementParsedRow[];
  warnings: string[];
}

/** ExcelJS 单元格值 → 纯文本（富文本/公式结果/数字统一收敛）。 */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) {
      return v.richText.map((t) => t.text).join('');
    }
    if ('result' in v && v.result != null) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v && typeof v.text === 'string') return v.text;
  }
  return String(v);
}

/** 「微信」→ WECHAT_PAY；「支付宝」→ ALIPAY；其余（银行卡/云闪付等）→ BANK_CARD。 */
function mapMethod(raw: string): PaymentMethod {
  if (raw.includes('微信')) return PaymentMethod.WECHAT_PAY;
  if (raw.includes('支付宝')) return PaymentMethod.ALIPAY;
  return PaymentMethod.BANK_CARD;
}

/**
 * 交易时间 → Date。
 * 字符串 'YYYY-MM-DD HH:mm[:ss]' 按北京时（+08:00）墙钟解释（与订单时间过滤口径一致，
 * 见 orders.service BUSINESS_UTC_OFFSET）；ExcelJS 已转成 Date 的单元格按 UTC 墙钟字段
 * 重新锚定 +08:00（ExcelJS 把 Excel 序列日按 UTC 解，直接用会差 8 小时）。
 */
function parseTxnTime(v: ExcelJS.CellValue): Date | null {
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const mo = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    const h = String(v.getUTCHours()).padStart(2, '0');
    const mi = String(v.getUTCMinutes()).padStart(2, '0');
    const s = String(v.getUTCSeconds()).padStart(2, '0');
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`);
  }
  const text = cellText(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!m) return null;
  const parsed = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 金额单元格 → 数字（'1,558.00' 这类千分位也吃）。
 * 先四舍五入到分再校验 ≥ 0.01——防 0.001 这类分以下金额 round 成 0 后
 * 生成认不了款也退不了款的 0 元僵尸进账（审计发现#6）。
 */
function parseAmount(v: ExcelJS.CellValue): number | null {
  const n =
    typeof v === 'number' ? v : Number(cellText(v).replace(/[,，¥￥\s]/g, '') || Number.NaN);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  return rounded >= 0.01 ? rounded : null;
}

// 交易流水号长度界限（与 importStatementSchema 对齐；超界行标 invalid 而非等提交时整批被拒）
const TXN_ID_MIN = 4;
const TXN_ID_MAX = 64;
// 付款备注入库上限（与 schema payerNote max(500) 对齐；超长截断——备注是线索不是账，截断无资金影响）
const PAYER_NOTE_MAX = 500;

// 表头名 → 内部键（列序不写死，按名对号；平台改列顺序不影响解析）
const HEADER_KEYS = {
  txnId: '交易流水号',
  time: '交易时间',
  amount: '交易金额',
  method: '支付方式',
  status: '交易状态',
  qrRemark: '二维码备注',
  payerRemark: '支付付款方备注',
} as const;

type ColMap = Partial<Record<keyof typeof HEADER_KEYS, number>>;

/** 前 10 行内找含「交易流水号」的表头行，返回 { headerRowNumber, colMap }；找不到返回 null。 */
function locateHeader(ws: ExcelJS.Worksheet): { headerRowNumber: number; colMap: ColMap } | null {
  const scanMax = Math.min(ws.rowCount, 10);
  for (let r = 1; r <= scanMax; r += 1) {
    const row = ws.getRow(r);
    const colMap: ColMap = {};
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const text = cellText(cell.value).trim();
      for (const [key, header] of Object.entries(HEADER_KEYS) as Array<
        [keyof typeof HEADER_KEYS, string]
      >) {
        if (text === header) colMap[key] = colNumber;
      }
    });
    if (colMap.txnId != null && colMap.time != null && colMap.amount != null) {
      return { headerRowNumber: r, colMap };
    }
  }
  return null;
}

/** 解析收单平台流水 .xlsx（base64）→ { rows, warnings }。文件损坏/非 xlsx 抛错由路由层转 400。 */
export async function parseStatementXlsx(fileBase64: string): Promise<StatementParseResult> {
  const buf = Buffer.from(fileBase64, 'base64');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);

  const warnings: string[] = [];
  const rows: StatementParsedRow[] = [];
  const ws = wb.worksheets[0];
  if (!ws) {
    warnings.push('未找到任何工作表');
    return { rows, warnings };
  }

  const header = locateHeader(ws);
  if (!header) {
    warnings.push(
      '未找到表头行（需含「交易流水号 / 交易时间 / 交易金额」列），请确认是收单平台导出的流水原表',
    );
    return { rows, warnings };
  }
  const { headerRowNumber, colMap } = header;
  // 状态/方式列缺失不整文件拒（可能是平台改版），但必须显式警告——
  // 缺「交易状态」= 无法确认支付成功，所有行会被按非成功跳过；缺「支付方式」= 全部落银行卡。
  if (colMap.status == null) {
    warnings.push('未找到「交易状态」列：无法确认哪些行支付成功，所有行将标为不可导入');
  }
  if (colMap.method == null) {
    warnings.push('未找到「支付方式」列：无法区分微信/支付宝，导入行将统一记为银行卡');
  }

  const seenTxnIds = new Set<string>();
  let truncated = false;

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (truncated || rowNumber <= headerRowNumber) return;
    if (rows.length >= STATEMENT_MAX_ROWS) {
      truncated = true;
      warnings.push(`流水超过 ${STATEMENT_MAX_ROWS} 行，仅解析前 ${STATEMENT_MAX_ROWS} 行`);
      return;
    }

    const getCol = (key: keyof typeof HEADER_KEYS): ExcelJS.CellValue =>
      colMap[key] != null ? row.getCell(colMap[key]!).value : null;

    const txnId = cellText(getCol('txnId')).trim();
    const rawStatus = cellText(getCol('status')).trim();
    const rawMethod = cellText(getCol('method')).trim();
    const amountCny = parseAmount(getCol('amount'));
    const receivedAt = parseTxnTime(getCol('time'));
    const qrRemark = cellText(getCol('qrRemark')).trim();
    const payerRemark = cellText(getCol('payerRemark')).trim();
    const joinedNote = [qrRemark, payerRemark].filter(Boolean).join(' / ');
    // 超长截断而非拒行：备注是认款线索不是账目，截断无资金影响（与 schema max(500) 对齐）
    const payerNote = joinedNote ? joinedNote.slice(0, PAYER_NOTE_MAX) : null;

    // 整行空白（无流水号且无金额）→ 跳过不计
    if (!txnId && amountCny == null) return;

    let disposition: StatementParsedRow['disposition'] = 'ok';
    if (
      !txnId ||
      txnId.length < TXN_ID_MIN ||
      txnId.length > TXN_ID_MAX ||
      amountCny == null ||
      receivedAt == null
    ) {
      disposition = 'invalid';
      const why = !txnId
        ? '缺交易流水号'
        : txnId.length < TXN_ID_MIN || txnId.length > TXN_ID_MAX
          ? `交易流水号长度异常（${txnId.length} 字符）`
          : amountCny == null
            ? '金额不可解析（需 ≥ 0.01 元）'
            : '交易时间不可解析';
      warnings.push(`第 ${rowNumber} 行：${why}，不可导入`);
    } else if (rawStatus !== STATUS_SUCCESS) {
      // 平台状态原文非「支付成功」（未支付/订单已关闭/退款…）→ 不入池
      disposition = 'skipped_status';
    } else if (seenTxnIds.has(txnId)) {
      disposition = 'dup_in_file';
      warnings.push(`第 ${rowNumber} 行：交易流水号 ${txnId} 在文件内重复，已跳过`);
    }
    if (disposition === 'ok') seenTxnIds.add(txnId);

    rows.push({
      rowNumber,
      externalTxnId: txnId,
      receivedAt,
      amountCny,
      method: mapMethod(rawMethod),
      rawMethod,
      rawStatus,
      payerNote,
      disposition,
    });
  });

  return { rows, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// 流水核对表导出
// ─────────────────────────────────────────────────────────────────────────────

/** 核对表一行（service 拼好序列化数据，这里只管排版）。 */
export interface StatementExportEntry {
  receivedAt: Date;
  externalTxnId: string | null;
  receiptNo: string;
  amountCny: number;
  methodLabel: string;
  sourceLabel: string;
  statusLabel: string;
  allocatedCny: number;
  remainingCny: number;
  /** 「ORD001 ¥300.00；ORD002 ¥244.00」 */
  allocationsText: string;
  lastAllocatedAt: Date | null;
  allocatorNames: string;
  payerNote: string | null;
  refundNote: string | null;
}

/** Date → 'YYYY-MM-DD HH:mm'（北京时 +08:00 墙钟，与导入解析口径互逆）。 */
function fmtBeijing(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const y = t.getUTCFullYear();
  const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
  const day = String(t.getUTCDate()).padStart(2, '0');
  const h = String(t.getUTCHours()).padStart(2, '0');
  const mi = String(t.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day} ${h}:${mi}`;
}

const EXPORT_COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: '到账时间', key: 'receivedAt', width: 17 },
  { header: '交易流水号', key: 'externalTxnId', width: 28 },
  { header: '进账号', key: 'receiptNo', width: 24 },
  { header: '金额', key: 'amountCny', width: 12 },
  { header: '收款方式', key: 'methodLabel', width: 10 },
  { header: '来源', key: 'sourceLabel', width: 12 },
  { header: '认款状态', key: 'statusLabel', width: 12 },
  { header: '已认金额', key: 'allocatedCny', width: 12 },
  { header: '未认余额', key: 'remainingCny', width: 12 },
  { header: '认到订单', key: 'allocationsText', width: 40 },
  { header: '最近认款时间', key: 'lastAllocatedAt', width: 17 },
  { header: '认款人', key: 'allocatorNames', width: 14 },
  { header: '付款备注', key: 'payerNote', width: 24 },
  { header: '退款备注', key: 'refundNote', width: 20 },
];

/** 生成核对表工作簿（金额列数字格式 0.00，表头加粗冻结）。 */
export function buildStatementExportWorkbook(entries: StatementExportEntry[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('流水核对表');
  ws.columns = EXPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const e of entries) {
    const row = ws.addRow({
      receivedAt: fmtBeijing(e.receivedAt),
      externalTxnId: e.externalTxnId ?? '',
      receiptNo: e.receiptNo,
      amountCny: e.amountCny,
      methodLabel: e.methodLabel,
      sourceLabel: e.sourceLabel,
      statusLabel: e.statusLabel,
      allocatedCny: e.allocatedCny,
      remainingCny: e.remainingCny,
      allocationsText: e.allocationsText,
      lastAllocatedAt: e.lastAllocatedAt ? fmtBeijing(e.lastAllocatedAt) : '',
      allocatorNames: e.allocatorNames,
      payerNote: e.payerNote ?? '',
      refundNote: e.refundNote ?? '',
    });
    for (const key of ['amountCny', 'allocatedCny', 'remainingCny']) {
      row.getCell(key).numFmt = '0.00';
    }
  }
  return wb;
}

/** 核对表文件名（北京时当天）。 */
export function statementExportFilename(): string {
  const today = fmtBeijing(new Date()).slice(0, 10);
  return `流水核对表-${today}.xlsx`;
}
