/**
 * 代理对账单 xlsx —— 一行一订单 + 合计行 + 预存款段。
 *
 * 风格照抄既有财务导出（finances.export-orders.ts）：ExcelJS、灰底粗体表头、冻结表头、
 * 金额列统一 #,##0.00（单位：元，不做任何换算），文件名带主体与月份。
 *
 * 与财务侧那几张表的**根本区别**：这张表要交到代理手上。因此列集合是白名单，
 * 只有代理自家的账目与行程，**没有**成本、护照/证件、内部风控（航段超售）等字段；
 * STATEMENT_COLUMNS 是唯一的列定义处，单测按 AGENT_HIDDEN_EXPORT_KEYS 逐 key 断言，
 * 日后加列时哪怕手滑写了 orderCost 也会当场红。
 */
import ExcelJS from 'exceljs';
import type { AgentStatement, AgentStatementRow } from './agent-statements.service.js';

/** 列定义（key 与 AgentStatementRow 同名，脱敏单测按此集合逐 key 校验）。 */
export const STATEMENT_COLUMNS: Array<{
  header: string;
  key: keyof AgentStatementRow;
  width: number;
  /** true = 金额列，数字格式与合计行按此处理 */
  money?: boolean;
}> = [
  { header: '订单号', key: 'orderNumber', width: 20 },
  { header: '归属代理', key: 'ownerAgentLabel', width: 18 },
  { header: '出发日期', key: 'departDate', width: 12 },
  { header: '下单日期', key: 'orderDate', width: 12 },
  { header: '出行人数', key: 'paxCount', width: 9 },
  { header: '套餐/产品', key: 'productSummary', width: 26 },
  { header: '应收(元)', key: 'payableCny', width: 13, money: true },
  { header: '已收(元)', key: 'receivedCny', width: 13, money: true },
  { header: '余额(元)', key: 'balanceCny', width: 13, money: true },
  { header: '每人结算价(元)', key: 'settlementPerPaxCny', width: 15, money: true },
  { header: '每人结算价区间', key: 'settlementPerPaxRange', width: 20 },
  { header: '立减(元)', key: 'settlementDiscountCny', width: 12, money: true },
  { header: '佣金计提(元)', key: 'commissionOwnerCny', width: 14, money: true },
  { header: '其中本级分成(元)', key: 'commissionSubjectCny', width: 16, money: true },
  { header: '订单状态', key: 'statusLabel', width: 12 },
];

const MONEY_FMT = '#,##0.00';
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } } as const;

/** 表头占用的行数（标题 / 范围 / 口径注脚 / 列头），冻结与合计行定位都用它。 */
export const STATEMENT_HEADER_ROWS = 4;

function agentLabel(statement: AgentStatement): string {
  return statement.agent.companyName ?? statement.agent.contactName;
}

export function agentStatementFilename(statement: AgentStatement): string {
  return `对账单_${agentLabel(statement)}_${statement.month}.xlsx`;
}

export async function buildAgentStatementWorkbook(statement: AgentStatement): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '椰岛假期 · 代理对账单';
  wb.created = new Date();

  const ws = wb.addWorksheet(`${statement.month} 对账单`);
  ws.columns = STATEMENT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  // ── 抬头三行：主体 / 统计范围 / 口径注脚 ──
  // 注脚是**必须**的：这张表按出发日归月，与月度结算单的下单日归期口径不同，
  // 不写清楚就会有人拿它去对结算单，两个数对不上再回头扯半天。
  ws.spliceRows(1, 0, [], [], []);
  ws.getCell('A1').value = `${agentLabel(statement)} · ${statement.month} 对账单`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = `统计范围：本代理及其全部下级 · 共 ${statement.rows.length} 张订单`;
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF666666' } };
  ws.getCell('A3').value = statement.notice;
  ws.getCell('A3').font = { size: 10, color: { argb: 'FF996600' } };

  const headerRow = ws.getRow(STATEMENT_HEADER_ROWS);
  headerRow.font = { bold: true };
  headerRow.fill = HEADER_FILL;
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  for (const r of statement.rows) ws.addRow(r);

  // ── 合计行 ──
  // 每人结算价是「人均」口径，跨订单相加没有意义 —— 该格留空，而不是造一个谁也解释不了的数。
  const totalRow = ws.addRow({
    orderNumber: '合计',
    paxCount: statement.totals.paxCount,
    payableCny: statement.totals.payableCny,
    receivedCny: statement.totals.receivedCny,
    balanceCny: statement.totals.balanceCny,
    settlementDiscountCny: statement.totals.settlementDiscountCny,
    commissionOwnerCny: statement.totals.commissionOwnerCny,
    commissionSubjectCny: statement.totals.commissionSubjectCny,
  } as Partial<Record<keyof AgentStatementRow, string | number>>);
  totalRow.font = { bold: true };
  totalRow.fill = HEADER_FILL;

  for (const c of STATEMENT_COLUMNS) {
    if (c.money) ws.getColumn(c.key).numFmt = MONEY_FMT;
  }
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: STATEMENT_HEADER_ROWS }];

  // ── 预存款段（另起一张表）──
  // 单独成表而不是接在主表末尾：预存余额是**主体代理自己**的池子（下级余额是下级的钱），
  // 与上面「含下级」的订单明细不是同一个统计范围，混在一张表里必然被读成合计的一部分。
  const ws2 = wb.addWorksheet('预存款');
  ws2.columns = [
    { header: '项目', key: 'label', width: 22 },
    { header: '金额(元)', key: 'amount', width: 16 },
    { header: '说明', key: 'note', width: 46 },
  ];
  const head2 = ws2.getRow(1);
  head2.font = { bold: true };
  head2.fill = HEADER_FILL;
  const p = statement.prepayment;
  ws2.addRow({ label: '期初余额', amount: p.openingCny, note: `${statement.month} 月初结转` });
  ws2.addRow({ label: '本月充值', amount: p.topUpCny, note: '认款到账、多付回存、退款回补等入账' });
  ws2.addRow({ label: '本月抵扣', amount: p.offsetCny, note: '抵付订单尾款等出账（正数表示流出）' });
  ws2.addRow({ label: '期末余额', amount: p.closingCny, note: '期初 + 本月充值 − 本月抵扣' });
  ws2.getRow(5).font = { bold: true };
  ws2.getCell('A7').value = '预存余额仅统计本代理自己的账户，不含下级代理。';
  ws2.getCell('A7').font = { size: 10, color: { argb: 'FF666666' } };
  ws2.getColumn('amount').numFmt = MONEY_FMT;

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
