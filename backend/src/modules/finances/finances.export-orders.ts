/**
 * 财务对账 xlsx 导出 — 一行一订单（订单毛利）
 *
 * 口径：直接复用 getOrderPnl（订单毛利 tab 同一算法），一行一订单。
 *   收入 = Order.total；非机票行成本取 OrderItem.totalCostCny，FLIGHT 行按班次实时口径计算；
 *   缺任一件 → 该单成本/毛利/毛利率留空，并在「缺成本项数」列标数量——照现有口径，绝不把缺失当 0。
 *   杂项成本 OrderCostItem 不并入本导出（与 getOrderPnl 列表口径一致，见「订单毛利」明细弹层）。
 *
 * 仅比列表多两列上下文：代理 + 出发日期（最早航段）——用二次查询按 orderId 补齐，
 * P&L 数值一律来自 getOrderPnl，保证与页面列表逐行对齐。
 */
import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { localDateISO } from '../../lib/flight-time.js';
import { getOrderPnl, type DateRange, type OrderPnlRow } from './finances.service.js';

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

// 导出取全量（区间内所有订单，不受列表 100 条上限影响）——财务对账需完整数据
const EXPORT_LIMIT = 100_000;

interface OrderExportRow {
  orderNumber: string;
  status: string;
  contactName: string;
  agency: string;
  departDate: string;
  itemCount: number;
  revenueCny: number;
  costCny: number | ''; // 缺成本 → 空（不造 0）
  grossMarginCny: number | '';
  marginPct: number | ''; // 百分比数值（如 0.23 → 23%），缺成本 → 空
  missingCostItemCount: number;
}

const COLUMNS: Array<{ header: string; key: keyof OrderExportRow; width: number }> = [
  { header: '订单号', key: 'orderNumber', width: 20 },
  { header: '订单状态', key: 'status', width: 10 },
  { header: '联系人', key: 'contactName', width: 14 },
  { header: '代理', key: 'agency', width: 16 },
  { header: '出发日期', key: 'departDate', width: 12 },
  { header: '订单项数', key: 'itemCount', width: 9 },
  { header: '收入(RMB)', key: 'revenueCny', width: 14 },
  { header: '成本(RMB)', key: 'costCny', width: 14 },
  { header: '毛利(RMB)', key: 'grossMarginCny', width: 14 },
  { header: '毛利率', key: 'marginPct', width: 10 },
  { header: '缺成本项数', key: 'missingCostItemCount', width: 10 },
];

interface OrderMeta {
  agency: string;
  departDate: string;
}

interface DepartureLeg {
  departureTime: Date;
  departureTz: string;
}

/**
 * 出发日期按**班次自己的 departureTz** 折算。
 * 班次时刻存 UTC，直接取 UTC 分量会让凌晨红眼班次（当地 00:00–08:00 起飞）早一天，
 * 财务对账和运营看到的出发日对不上。tz 缺失时 localDateISO 自动回退 UTC，
 * 不落到运行环境默认时区（同一份导出在开发机和线上必须一致）。
 */
function fmtDepartDate(sched: DepartureLeg | undefined): string {
  if (!sched) return '';
  return localDateISO(sched.departureTime, sched.departureTz);
}

/** 按 orderId 补齐代理 + 最早航段出发日期 */
async function loadOrderMeta(
  orderIds: string[],
  client: PrismaClient,
): Promise<Map<string, OrderMeta>> {
  const map = new Map<string, OrderMeta>();
  if (orderIds.length === 0) return map;
  const orders = await client.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      agent: { select: { companyName: true, contactName: true } },
      items: {
        where: { kind: 'FLIGHT' },
        // departureTz 必须一起取：出发日期要按班次当地时区折，不能切 UTC 分量
        select: { flightSchedule: { select: { departureTime: true, departureTz: true } } },
      },
    },
  });
  for (const o of orders) {
    const departs = o.items
      .map((it) => it.flightSchedule)
      .filter((s): s is DepartureLeg => s != null)
      .sort((a, b) => a.departureTime.getTime() - b.departureTime.getTime());
    map.set(o.id, {
      agency: o.agent?.companyName ?? o.agent?.contactName ?? '直销',
      departDate: fmtDepartDate(departs[0]),
    });
  }
  return map;
}

function toExportRow(pnl: OrderPnlRow, meta: OrderMeta | undefined): OrderExportRow {
  return {
    orderNumber: pnl.orderNumber,
    status: STATUS_LABEL[pnl.status] ?? pnl.status,
    contactName: pnl.contactName,
    agency: meta?.agency ?? '直销',
    departDate: meta?.departDate ?? '',
    itemCount: pnl.itemCount,
    revenueCny: pnl.totalCny,
    costCny: pnl.costCny ?? '',
    grossMarginCny: pnl.grossMarginCny ?? '',
    marginPct: pnl.marginPct ?? '',
    missingCostItemCount: pnl.missingCostItemCount,
  };
}

export async function buildFinanceExportByOrderWorkbook(
  range: DateRange,
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const pnlRows = await getOrderPnl(range, EXPORT_LIMIT, client);
  const metaMap = await loadOrderMeta(pnlRows.map((r) => r.orderId), client);
  const rows = pnlRows.map((r) => toExportRow(r, metaMap.get(r.orderId)));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · 财务对账导出';
  wb.created = new Date();
  const ws = wb.addWorksheet('订单毛利');
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  for (const r of rows) ws.addRow(r);

  // 毛利率列按百分比格式显示（数值仍是 0..1）
  ws.getColumn('marginPct').numFmt = '0.0%';

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export function financeExportByOrderFilename(range: DateRange): string {
  return `按订单毛利_${range.from}_${range.to}.xlsx`;
}
