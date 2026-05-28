/**
 * 财务核对明细 xlsx 导出 — 一行/乘客
 *
 * 成本口径（统一人民币，无汇率）：
 *   机票成本(RMB)  = 该班次包机总成本 ÷ 总座位数（单座分摊）— 每位乘客占 1 座
 *   机场税(RMB)    = airportTaxDepCny + airportTaxArrCny
 *   房费(RMB)      = hotel.costPriceCny
 *   车费(RMB)      = transfer.costPriceCny
 *   签证成本(RMB)  = visa.costPriceCny
 * 机票成本按"包机单座成本"算（与航班毛利视图一致）；酒店/车费/签证按订单总额 ÷ 人数 均摊。
 * 收入按 order.total ÷ 人数 均摊到每位乘客。
 */
import ExcelJS from 'exceljs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';

const COUNTED_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.REFUND_REQUESTED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

const ORDER_KIND_LABEL: Record<string, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '接送',
  VISA: '签证',
  BUNDLE: '套餐',
  INSURANCE: '保险',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '已出票',
  COMPLETED: '已完成',
  REFUND_REQUESTED: '退款中',
  CHANGE_REQUESTED: '改期中',
  CHANGED: '已改期',
};

interface FinanceRow {
  agency: string;
  orderNumber: string;
  chineseName: string;
  passengerName: string;
  departDate: string;
  returnDate: string;
  flightNumbers: string;
  orderType: string;
  paxCount: number;
  status: string;
  settledStatus: string;
  recordedAt: string;
  flightCostCny: number; // 机票成本(RMB) — 包机单座分摊
  airportTaxCny: number;
  hotelName: string;
  hotelNights: number;
  hotelCostCny: number;
  transferCostCny: number;
  visaCostCny: number;
  unitCostTotal: number;
  unitRevenue: number;
  unitProfit: number;
  flightRevenue: number;
  hotelRevenue: number;
  visaRevenue: number;
  transferRevenue: number;
  totalRevenue: number;
  flightCost: number;
  hotelCost: number;
  visaCost: number;
  transferCost: number;
  totalCost: number;
  grossMargin: number;
  note: string;
}

const COLUMNS: Array<{ header: string; key: keyof FinanceRow; width: number }> = [
  { header: '代理机构', key: 'agency', width: 16 },
  { header: '订单号', key: 'orderNumber', width: 20 },
  { header: '中文名称', key: 'chineseName', width: 12 },
  { header: '乘客姓名', key: 'passengerName', width: 18 },
  { header: '出发日期', key: 'departDate', width: 12 },
  { header: '返程日期', key: 'returnDate', width: 12 },
  { header: '航班号', key: 'flightNumbers', width: 14 },
  { header: '订单类型', key: 'orderType', width: 14 },
  { header: '人数', key: 'paxCount', width: 6 },
  { header: '订单状态', key: 'status', width: 10 },
  { header: '是否清账', key: 'settledStatus', width: 8 },
  { header: '录入时间', key: 'recordedAt', width: 18 },
  { header: '机票成本(RMB)', key: 'flightCostCny', width: 14 },
  { header: '机场税成本(RMB)', key: 'airportTaxCny', width: 14 },
  { header: '入住酒店', key: 'hotelName', width: 18 },
  { header: '入住天数', key: 'hotelNights', width: 8 },
  { header: '房费(RMB)', key: 'hotelCostCny', width: 12 },
  { header: '车费(RMB)', key: 'transferCostCny', width: 12 },
  { header: '签证成本(RMB)', key: 'visaCostCny', width: 14 },
  { header: '客单成本合计', key: 'unitCostTotal', width: 14 },
  { header: '客单收入', key: 'unitRevenue', width: 12 },
  { header: '客单利润', key: 'unitProfit', width: 12 },
  { header: '机票收入', key: 'flightRevenue', width: 12 },
  { header: '酒店收入', key: 'hotelRevenue', width: 12 },
  { header: '签证收入', key: 'visaRevenue', width: 12 },
  { header: '车费收入', key: 'transferRevenue', width: 12 },
  { header: '总收入', key: 'totalRevenue', width: 12 },
  { header: '机票支出', key: 'flightCost', width: 12 },
  { header: '酒店支出', key: 'hotelCost', width: 12 },
  { header: '签证支出', key: 'visaCost', width: 12 },
  { header: '车费支出', key: 'transferCost', width: 12 },
  { header: '总成本', key: 'totalCost', width: 12 },
  { header: '毛利', key: 'grossMargin', width: 12 },
  { header: '备注', key: 'note', width: 20 },
];

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return '';
  return `${fmtDate(d)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

type OrderForExport = Prisma.OrderGetPayload<{
  include: {
    agent: { select: { companyName: true; contactName: true } };
    passengers: true;
    items: {
      include: {
        flightSchedule: {
          include: {
            flight: { select: { flightNumber: true; originCode: true; destinationCode: true } };
            seatClasses: { select: { capacity: true } };
          };
        };
        hotelRoomType: { select: { name: true; costPriceCny: true } };
        visa: { select: { costPriceCny: true } };
        transfer: { select: { costPriceCny: true } };
      };
    };
  };
}>;

/** 把一张订单展开成 N 行（每位乘客一行）*/
function orderToRows(order: OrderForExport): FinanceRow[] {
  const paxCount = Math.max(1, order.passengers.length);

  // ── 机票：包机单座分摊（charter / 总座位）+ 机场税(CNY)，可能去程+回程多段 ──
  let flightCostPerSeat = 0; // 每位乘客占 1 座的包机分摊成本
  let airportTaxCny = 0;
  const flightNumbers: string[] = [];
  const departDates: Date[] = [];
  for (const it of order.items) {
    if (it.kind === 'FLIGHT' && it.flightSchedule) {
      const totalSeats = it.flightSchedule.seatClasses.reduce((a, c) => a + c.capacity, 0);
      const charter = dec(it.flightSchedule.charterCostCny);
      if (totalSeats > 0 && charter > 0) {
        flightCostPerSeat += charter / totalSeats;
      }
      airportTaxCny +=
        dec(it.flightSchedule.airportTaxDepCny) + dec(it.flightSchedule.airportTaxArrCny);
      flightNumbers.push(it.flightSchedule.flight.flightNumber);
      departDates.push(it.flightSchedule.departureTime);
    }
  }
  departDates.sort((a, b) => a.getTime() - b.getTime());

  // ── 酒店 ──
  let hotelCostCnyOrder = 0;
  let hotelName = '';
  let hotelNights = 0;
  for (const it of order.items) {
    if (it.kind === 'HOTEL' && it.hotelRoomType) {
      const perNight = dec(it.hotelRoomType.costPriceCny);
      let nights = 1;
      if (it.hotelCheckIn && it.hotelCheckOut) {
        nights = Math.max(
          1,
          Math.round(
            (it.hotelCheckOut.getTime() - it.hotelCheckIn.getTime()) / (1000 * 60 * 60 * 24),
          ),
        );
      }
      hotelCostCnyOrder += perNight * nights * it.quantity;
      hotelName = it.hotelRoomType.name;
      hotelNights = nights;
    }
  }

  // ── 签证 / 车费 ──
  let visaCostCnyOrder = 0;
  let transferCostCnyOrder = 0;
  for (const it of order.items) {
    if (it.kind === 'VISA' && it.visa) {
      visaCostCnyOrder += dec(it.visa.costPriceCny) * it.quantity;
    }
    if (it.kind === 'TRANSFER' && it.transfer) {
      transferCostCnyOrder += dec(it.transfer.costPriceCny) * it.quantity;
    }
  }

  // ── 品类收入（按 OrderItem.amount 分类）──
  const revByKind: Record<string, number> = {};
  for (const it of order.items) {
    revByKind[it.kind] = (revByKind[it.kind] ?? 0) + dec(it.amount);
  }
  const flightRevenue = revByKind.FLIGHT ?? 0;
  const hotelRevenue = revByKind.HOTEL ?? 0;
  const visaRevenue = revByKind.VISA ?? 0;
  const transferRevenue = revByKind.TRANSFER ?? 0;
  const totalRevenue = dec(order.total);

  const kinds = Array.from(new Set(order.items.map((i) => ORDER_KIND_LABEL[i.kind] ?? i.kind)));
  const orderType = kinds.join('+');

  const agency = order.agent?.companyName ?? order.agent?.contactName ?? '直销';
  const settled = dec(order.paidAmount) >= totalRevenue && totalRevenue > 0 ? '是' : '否';

  const hotelPerPax = hotelCostCnyOrder / paxCount;
  const transferPerPax = transferCostCnyOrder / paxCount;
  const visaCnyPerPax = visaCostCnyOrder / paxCount;
  const revenuePerPax = totalRevenue / paxCount;

  // 机票成本：每位乘客占 1 座 → flightCostPerSeat；整单 = 单座成本 × 人数
  const flightCostOrder = (flightCostPerSeat + airportTaxCny) * paxCount;
  const totalCostOrder =
    flightCostOrder + hotelCostCnyOrder + transferCostCnyOrder + visaCostCnyOrder;

  const baseRows = order.passengers.map<FinanceRow>((p) => {
    const unitCostTotal =
      flightCostPerSeat + airportTaxCny + hotelPerPax + transferPerPax + visaCnyPerPax;
    return {
      agency,
      orderNumber: order.orderNumber,
      chineseName: p.fullName,
      passengerName:
        p.lastName && p.firstName ? `${p.lastName}/${p.firstName}`.toUpperCase() : p.fullName,
      departDate: fmtDate(departDates[0]),
      returnDate: departDates.length > 1 ? fmtDate(departDates[departDates.length - 1]) : '',
      flightNumbers: Array.from(new Set(flightNumbers)).join(' / '),
      orderType,
      paxCount,
      status: STATUS_LABEL[order.status] ?? order.status,
      settledStatus: settled,
      recordedAt: fmtDateTime(order.createdAt),
      flightCostCny: round2(flightCostPerSeat),
      airportTaxCny: round2(airportTaxCny),
      hotelName,
      hotelNights,
      hotelCostCny: round2(hotelPerPax),
      transferCostCny: round2(transferPerPax),
      visaCostCny: round2(visaCnyPerPax),
      unitCostTotal: round2(unitCostTotal),
      unitRevenue: round2(revenuePerPax),
      unitProfit: round2(revenuePerPax - unitCostTotal),
      flightRevenue: 0,
      hotelRevenue: 0,
      visaRevenue: 0,
      transferRevenue: 0,
      totalRevenue: 0,
      flightCost: 0,
      hotelCost: 0,
      visaCost: 0,
      transferCost: 0,
      totalCost: 0,
      grossMargin: 0,
      note: order.notes ?? '',
    };
  });

  // 订单级合计只写在第一位乘客行，避免按乘客重复累加
  if (baseRows.length > 0) {
    baseRows[0] = {
      ...baseRows[0],
      flightRevenue: round2(flightRevenue),
      hotelRevenue: round2(hotelRevenue),
      visaRevenue: round2(visaRevenue),
      transferRevenue: round2(transferRevenue),
      totalRevenue: round2(totalRevenue),
      flightCost: round2(flightCostOrder),
      hotelCost: round2(hotelCostCnyOrder),
      visaCost: round2(visaCostCnyOrder),
      transferCost: round2(transferCostCnyOrder),
      totalCost: round2(totalCostOrder),
      grossMargin: round2(totalRevenue - totalCostOrder),
    };
  }

  return baseRows;
}

export async function buildFinanceExportWorkbook(
  range: { from: string; to: string },
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const [y1, m1, d1] = range.from.split('-').map((x) => parseInt(x, 10));
  const [y2, m2, d2] = range.to.split('-').map((x) => parseInt(x, 10));
  const fromD = new Date(Date.UTC(y1, m1 - 1, d1, 0, 0, 0, 0));
  const toD = new Date(Date.UTC(y2, m2 - 1, d2, 23, 59, 59, 999));

  const orders = (await client.order.findMany({
    where: { createdAt: { gte: fromD, lte: toD }, status: { in: COUNTED_STATUSES } },
    orderBy: { createdAt: 'asc' },
    include: {
      agent: { select: { companyName: true, contactName: true } },
      passengers: true,
      items: {
        include: {
          flightSchedule: {
            include: {
              flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
              seatClasses: { select: { capacity: true } },
            },
          },
          hotelRoomType: { select: { name: true, costPriceCny: true } },
          visa: { select: { costPriceCny: true } },
          transfer: { select: { costPriceCny: true } },
        },
      },
    },
  })) as OrderForExport[];

  const rows: FinanceRow[] = [];
  for (const o of orders) {
    if (o.passengers.length === 0) continue;
    rows.push(...orderToRows(o));
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · 财务核对导出';
  wb.created = new Date();
  const ws = wb.addWorksheet('财务核对收入明细');
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  for (const r of rows) ws.addRow(r);

  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export function financeExportFilename(range: { from: string; to: string }): string {
  return `财务核对_${range.from}_${range.to}.xlsx`;
}
