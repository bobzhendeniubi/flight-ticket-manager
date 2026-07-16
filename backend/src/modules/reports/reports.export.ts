/**
 * 经营报表 xlsx 导出 — 4 个 sheet：
 *   1. 销售毛利·按产品线（dim=kind）
 *   2. 销售毛利·按渠道（dim=channel）
 *   3. 销售毛利·按代理（dim=agent）
 *   4. 应收与代理欠款（应收账龄明细 + 桶汇总 + 代理欠款，三块合一）
 *
 * 复用 reports.service 的聚合函数；金额列统一数字格式 '#,##0.00'。
 * 文件名只用 ASCII（reports-{from}_{to}.xlsx），中文展示名由前端决定。
 */
import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import {
  getAgentDebtsReport,
  getReceivablesReport,
  getSalesReport,
  type AgentDebtRow,
  type DateRange,
  type ReceivablesReport,
  type SalesReport,
} from './reports.service.js';

const MONEY_FMT = '#,##0.00';

const KIND_LABEL: Record<string, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '接送',
  VISA: '签证',
  BUNDLE: '套餐',
  INSURANCE: '保险',
  FEE: '税费/附加费',
  DISCOUNT: '折扣',
  GUIDE: '导游',
  UPGRADE_CHANGE: '升舱/改期',
  OVERSALE: '超售',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '出票完成',
  COMPLETED: '已完成',
  REFUND_REQUESTED: '退款中',
  CHANGE_REQUESTED: '改期中',
  CHANGED: '已改期',
};

const SALES_COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: '维度', key: 'label', width: 24 },
  { header: '订单数', key: 'orderCount', width: 10 },
  { header: '收入(RMB)', key: 'revenueCny', width: 14 },
  { header: '成本(RMB)', key: 'costCny', width: 14 },
  { header: '毛利(RMB)', key: 'grossMarginCny', width: 14 },
  { header: '毛利率', key: 'marginPct', width: 10 },
  { header: '成本缺失条目数', key: 'missingCostItemCount', width: 14 },
];

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
}

function addSalesSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  report: SalesReport,
  labelOf: (key: string, label: string) => string,
): void {
  const ws = wb.addWorksheet(sheetName);
  ws.columns = SALES_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeaderRow(ws.getRow(1));

  for (const r of report.rows) {
    ws.addRow({
      label: labelOf(r.key, r.label),
      orderCount: r.orderCount,
      revenueCny: r.revenueCny,
      costCny: r.costCny,
      grossMarginCny: r.grossMarginCny,
      marginPct: r.marginPct == null ? '' : r.marginPct,
      missingCostItemCount: r.missingCostItemCount,
    });
  }
  const totalRow = ws.addRow({
    label: '合计',
    orderCount: report.totals.orderCount,
    revenueCny: report.totals.revenueCny,
    costCny: report.totals.costCny,
    grossMarginCny: report.totals.grossMarginCny,
    marginPct: report.totals.marginPct == null ? '' : report.totals.marginPct,
    missingCostItemCount: report.totals.missingCostItemCount,
  });
  totalRow.font = { bold: true };

  for (const key of ['revenueCny', 'costCny', 'grossMarginCny']) {
    ws.getColumn(key).numFmt = MONEY_FMT;
  }
  ws.getColumn('marginPct').numFmt = '0.00%';
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

const RECEIVABLE_HEADERS = [
  '订单号',
  '联系人',
  '代理/直客',
  '订单状态',
  '应收合计(RMB)',
  '已收(RMB)',
  '应收余额(RMB)',
  '账龄(天)',
  '账龄桶',
];

const AGENT_DEBT_HEADERS = ['代理', '订单数', '应收余额(RMB)', '预存余额(RMB)'];

const RECEIVABLE_BUCKETS = ['0-7', '8-30', '31-60', '61+'] as const;

function addReceivablesSheet(
  wb: ExcelJS.Workbook,
  receivables: ReceivablesReport,
  agentDebts: AgentDebtRow[],
): void {
  const ws = wb.addWorksheet('应收与代理欠款');
  ws.columns = [
    { width: 20 },
    { width: 14 },
    { width: 18 },
    { width: 10 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 10 },
    { width: 10 },
  ];

  // ── 块 1：应收账龄明细 ──
  ws.addRow(['应收账龄明细']).font = { bold: true, size: 12 };
  styleHeaderRow(ws.addRow(RECEIVABLE_HEADERS));
  for (const r of receivables.rows) {
    const row = ws.addRow([
      r.orderNumber,
      r.contactName,
      r.agentLabel,
      STATUS_LABEL[r.status] ?? r.status,
      r.totalCny,
      r.paidCny,
      r.balanceCny,
      r.ageDays,
      r.bucket,
    ]);
    for (const col of [5, 6, 7]) row.getCell(col).numFmt = MONEY_FMT;
  }
  if (receivables.summary.truncated) {
    ws.addRow([`（明细超过上限，仅显示前 ${receivables.rows.length} 行；下方汇总为全量口径）`]);
  }

  // ── 块 2：账龄桶汇总 ──
  ws.addRow([]);
  ws.addRow(['账龄桶汇总']).font = { bold: true, size: 12 };
  styleHeaderRow(ws.addRow(['账龄桶', '笔数', '应收余额(RMB)']));
  let totalCount = 0;
  for (const bucket of RECEIVABLE_BUCKETS) {
    const b = receivables.summary.buckets[bucket];
    totalCount += b.count;
    const row = ws.addRow([bucket, b.count, b.amountCny]);
    row.getCell(3).numFmt = MONEY_FMT;
  }
  const totalRow = ws.addRow(['合计', totalCount, receivables.summary.totalBalanceCny]);
  totalRow.font = { bold: true };
  totalRow.getCell(3).numFmt = MONEY_FMT;

  // ── 块 3：代理欠款 ──
  ws.addRow([]);
  ws.addRow(['代理欠款']).font = { bold: true, size: 12 };
  styleHeaderRow(ws.addRow(AGENT_DEBT_HEADERS));
  for (const r of agentDebts) {
    const row = ws.addRow([r.agentLabel, r.orderCount, r.outstandingCny, r.prepaymentBalanceCny]);
    row.getCell(3).numFmt = MONEY_FMT;
    row.getCell(4).numFmt = MONEY_FMT;
  }
}

export async function buildReportsExportWorkbook(
  range: DateRange,
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const [byKind, byChannel, byAgent, receivables, agentDebts] = await Promise.all([
    getSalesReport(range, 'kind', client),
    getSalesReport(range, 'channel', client),
    getSalesReport(range, 'agent', client),
    getReceivablesReport(client),
    getAgentDebtsReport(client),
  ]);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · 经营报表导出';
  wb.created = new Date();

  addSalesSheet(wb, '销售毛利·按产品线', byKind, (key) => KIND_LABEL[key] ?? key);
  addSalesSheet(wb, '销售毛利·按渠道', byChannel, (_key, label) => label);
  addSalesSheet(wb, '销售毛利·按代理', byAgent, (_key, label) => label);
  addReceivablesSheet(wb, receivables, agentDebts);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** 文件名只用 ASCII（HTTP header 安全）；中文展示名由前端决定 */
export function reportsExportFilename(range: DateRange): string {
  return `reports-${range.from}_${range.to}.xlsx`;
}
