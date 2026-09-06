/**
 * 出票名单 → 「一个人 + 一个 PNR + 一个票号」的**行解析内核**（纯函数、零 IO，可单测）。
 *
 * 业务原样：航司/出票代理出完票发回来一份名单，形状完全不受我们控制 ——
 * 可能是微信里粘的几行文本，也可能是一张 xlsx。每行大致是
 *   「护照号 或 姓名, PNR, 票号」
 * 分隔符逗号（中英）、顿号、分号、竖线、Tab、空格混着来；票号可能带票面的连字符
 *（784-1234567890）；有的行只给票号不给 PNR。
 *
 * 两条分路，因为它们的**歧义程度根本不同**：
 *
 *   A. 行里有「强分隔符」（逗号/顿号/分号/竖线/Tab）→ **按列严格取位**：
 *      第 1 列 = 姓名或护照号，第 2 列 = PNR，第 3 列 = 票号（多出来的列忽略）。
 *      列是人为分好的，没有猜的余地；空列就是「这一格没填」。xlsx 上传走的也是这条
 *     （每行的单元格用 Tab 拼起来再进同一个解析器，不另写一套）。
 *
 *   B. 整行只有空格 → **从右往左认**：最后一段像票号就收作票号；再往左一段像 PNR
 *      **且含至少一个数字**才收作 PNR；剩下的全是姓名。
 *      那条「必须含数字」是有意的：PNR 与姓氏都可能是 5–8 位纯字母，
 *      「ZHANG XIAOMING 7841234567890」里的 XIAOMING 到底是名还是订座编码，
 *      纯空格行**分不出来**。此时宁可把它留在姓名里 —— 匹配不上会明晃晃落进「未匹配」
 *      让人去处理；猜错则是把某位客人的名字当成 PNR 存进单子里，事后极难查。
 *      名单里 PNR 是纯字母的，请改用逗号/Tab 分列，或直接传表格。
 *
 * 校验口径全部来自 ticket-number.ts（与单人回填端点同一份内核）。
 * 一行只要有一处不合规就整行落 error，**不半收**：收一半的行会写出一条「有票号没 PNR」
 * 的残缺记录，而票务根本不知道另一半被吞了。
 */

import ExcelJS from 'exceljs';
import {
  ETICKET_FORMAT_MESSAGE,
  PNR_FORMAT_MESSAGE,
  isValidEticketNumber,
  isValidPnr,
  normalizeEticketNumber,
  normalizePnr,
} from './ticket-number.js';

/** 单次最多解析多少行（防误传整本表格把接口拖死；与 no-show 名单同量级）。 */
export const TICKET_ROSTER_MAX_LINES = 500;

/** 上传表格大小上限（解码后字节数），与旧系统表格导入同口径。 */
export const TICKET_ROSTER_MAX_BYTES = 2 * 1024 * 1024;

/** 行分隔：\n / \r\n。 */
const LINE_SEPARATORS = /\r\n|\r|\n/;

/**
 * 「强分隔符」= 人为分列的记号：逗号（中英）、顿号、分号（中英）、竖线、Tab。
 * **空格不在内** —— 空格既可能是分列，也可能只是姓名里的那一个空格，两者不能混为一谈。
 */
const STRONG_SEPARATORS = /[,，、;；|\t]/u;

/** 纯空格行的分词（Tab 已被算作强分隔符，这里只剩空白）。 */
const WHITESPACE_SEPARATORS = /\s+/u;

/** 表头关键词：首行命中任一个就当表头跳过（数据行不可能长这样）。 */
const HEADER_KEYWORDS = [
  '姓名',
  '护照',
  '证件',
  '旅客',
  '乘客',
  '票号',
  '编码',
  'PNR',
  'NAME',
  'PASSPORT',
  'TICKET',
];

/** 一行解析出来的结果。error 非空 = 整行不可用（pnr/eticketNumber 一律为 null）。 */
export interface TicketRosterRow {
  /** 名单原文那一行 —— 票务要按原文核对，不能只回我们解析后的东西。 */
  line: string;
  /** 姓名或护照号原文（拿去做证件/人名匹配）。 */
  identity: string;
  /** 归一化后的 PNR；这一行没给就是 null。 */
  pnr: string | null;
  /** 归一化后的电子票号；这一行没给就是 null。 */
  eticketNumber: string | null;
  /** 面向操作人的中文原因；null = 这一行没问题。 */
  error: string | null;
}

export interface TicketRosterParseResult {
  rows: TicketRosterRow[];
  /** 去重后的总行数（**不受上限影响**，用来告诉票务「贴进来多少条」）。 */
  totalLines: number;
  /** 总行数超过上限 → 只处理了前 TICKET_ROSTER_MAX_LINES 条，剩下的这一次没看。 */
  truncated: boolean;
}

/** 解析级错误（整个文件不可用）→ 路由层转 400，message 直接面向操作人。 */
export class TicketRosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketRosterError';
  }
}

/** 首行像表头吗（xlsx 与粘贴文本共用）。 */
export function looksLikeHeaderLine(line: string): boolean {
  const upper = line.toUpperCase();
  return HEADER_KEYWORDS.some((kw) => upper.includes(kw));
}

/**
 * 一行 → identity / pnr / eticketNumber。
 * 详见文件头「两条分路」：有强分隔符按列取位，纯空格行从右往左认。
 */
export function parseTicketRosterLine(raw: string): TicketRosterRow {
  const line = String(raw ?? '').trim();
  const fail = (error: string): TicketRosterRow => ({
    line,
    identity: '',
    pnr: null,
    eticketNumber: null,
    error,
  });
  if (line === '') return fail('空行');

  let identity: string;
  let pnrRaw: string;
  let ticketRaw: string;

  if (STRONG_SEPARATORS.test(line)) {
    // A. 按列严格取位。空列保留位置（不能 filter 掉，否则「姓名,,票号」会塌成两列）。
    const cols = line.split(STRONG_SEPARATORS).map((c) => c.trim());
    identity = cols[0] ?? '';
    if (cols.length >= 3) {
      pnrRaw = cols[1] ?? '';
      ticketRaw = cols[2] ?? '';
    } else {
      // 只有两列：第 2 列是 PNR 还是票号，按它自己的长相判（10–17 位数字 = 票号）。
      const value = cols[1] ?? '';
      const asTicket = isValidEticketNumber(normalizeEticketNumber(value));
      pnrRaw = asTicket ? '' : value;
      ticketRaw = asTicket ? value : '';
    }
  } else {
    // B. 纯空格行：从右往左认。
    const tokens = line.split(WHITESPACE_SEPARATORS).filter((t) => t !== '');
    if (tokens.length < 2) {
      return fail('这一行只有一段内容；至少要有「姓名或护照号」+「PNR 或票号」');
    }
    ticketRaw = '';
    pnrRaw = '';
    if (isValidEticketNumber(normalizeEticketNumber(tokens[tokens.length - 1]))) {
      ticketRaw = tokens.pop() as string;
    }
    // PNR 必须含数字才敢从纯空格行里认（纯字母的 5–8 位与姓氏分不开，见文件头）。
    const pnrCandidate = tokens[tokens.length - 1];
    if (
      tokens.length >= 2 &&
      pnrCandidate !== undefined &&
      /\d/.test(pnrCandidate) &&
      isValidPnr(normalizePnr(pnrCandidate))
    ) {
      pnrRaw = tokens.pop() as string;
    }
    identity = tokens.join(' ');
  }

  if (identity === '') return fail('这一行没有姓名/护照号，认不出是谁');
  if (pnrRaw === '' && ticketRaw === '') {
    return fail('这一行既没有 PNR 也没有票号（纯字母的 PNR 请用逗号或 Tab 分列，或改用表格上传）');
  }

  let pnr: string | null = null;
  if (pnrRaw !== '') {
    const normalized = normalizePnr(pnrRaw);
    if (!isValidPnr(normalized)) return fail(`${PNR_FORMAT_MESSAGE}（这一行是「${pnrRaw}」）`);
    pnr = normalized;
  }

  let eticketNumber: string | null = null;
  if (ticketRaw !== '') {
    const normalized = normalizeEticketNumber(ticketRaw);
    if (!isValidEticketNumber(normalized)) {
      return fail(`${ETICKET_FORMAT_MESSAGE}（这一行是「${ticketRaw}」）`);
    }
    eticketNumber = normalized;
  }

  return { line, identity, pnr, eticketNumber, error: null };
}

/**
 * 整块名单文本 → 逐行解析（trim、去空行、按原文去重、跳表头、截断到上限）。
 *
 * 超上限时**不静默丢**：照样把总行数与截断标记回给调用方 —— 界面必须明说
 *「贴了 700 条、这次只处理前 500 条」，否则票务以为整班都回填完了。
 */
export function parseTicketRosterLines(
  text: string,
  limit: number = TICKET_ROSTER_MAX_LINES,
): TicketRosterParseResult {
  const seen = new Set<string>();
  const rows: TicketRosterRow[] = [];
  let totalLines = 0;
  let firstSeen = false;
  for (const rawLine of String(text ?? '').split(LINE_SEPARATORS)) {
    const line = rawLine.trim();
    if (line === '') continue;
    // 表头只可能出现在第一条非空行上；后面再出现同样的字样是真数据，照常解析。
    if (!firstSeen) {
      firstSeen = true;
      if (looksLikeHeaderLine(line)) continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    totalLines += 1;
    if (rows.length < limit) rows.push(parseTicketRosterLine(line));
  }
  return { rows, totalLines, truncated: totalLines > rows.length };
}

// ── xlsx 上传 ────────────────────────────────────────────────────────────

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** 单元格 → 文本（数字票号在 Excel 里常存成 number，String 出来正好）。 */
function cellText(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  // 日期单元格与本功能无关（票号名单里没有日期列）；当空处理，别把一个 ISO 串塞进姓名列。
  if (value instanceof Date) return '';
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

/**
 * 上传的 .xlsx（base64）→ 与粘贴文本**完全同形**的行文本（单元格用 Tab 拼）。
 *
 * 故意不做列名识别：出票名单没有统一模版，与其猜表头，不如把每行的前几格按位置拼成一行，
 * 再交给同一个 parseTicketRosterLine —— 表格与粘贴走一条路，
 * 「表格能收、粘贴收不进」这种前后不一致就不会出现。
 */
export async function parseTicketRosterXlsx(fileBase64: string): Promise<string[]> {
  const buf = Buffer.from(fileBase64, 'base64');
  if (buf.byteLength === 0) throw new TicketRosterError('文件内容为空，请重新选择文件');
  if (buf.byteLength > TICKET_ROSTER_MAX_BYTES) {
    throw new TicketRosterError('文件超过 2MB，请精简表格后再上传');
  }
  if (buf.byteLength >= 8 && buf.subarray(0, 8).equals(OLE_MAGIC)) {
    throw new TicketRosterError('这是旧版 .xls 文件，请在 Excel 里「另存为 .xlsx」后再上传');
  }
  // .xlsx 是 zip 容器，魔数 'PK'
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new TicketRosterError('不是有效的 .xlsx 文件，请确认文件格式');
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch {
    throw new TicketRosterError('表格文件无法解析，请确认为有效的 .xlsx 文件');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new TicketRosterError('表格中没有工作表');

  const lines: string[] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // 前 6 格足够容下「姓名 / 护照号 / PNR / 票号」外加两列杂项；再多的列与本功能无关。
    for (let i = 1; i <= 6; i += 1) cells.push(cellText(row.getCell(i).value).trim());
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) return;
    lines.push(cells.join('\t'));
  });
  if (lines.length === 0) throw new TicketRosterError('表格里没有可用的数据行');
  return lines;
}
