/**
 * 整班机订单导出 — 一行/乘客（ops 用，不含成本/毛利）。
 *
 * 用户场景：运营要按某个航班班次（scheduleId）拉所有订单的明细，
 * 用于全班机的乘客 / 房型 / 签证 / 接送清单核对。
 * 与 finances.export.ts 不同：财务向是按时间段 + 含成本/毛利；这个是按班次 + 纯订单字段。
 */
import ExcelJS from 'exceljs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { toAlpha3 } from './nationality.js';
import { countIssuedPassengers } from './ticketing-cap.js';

/** 与财务导出一致：草稿 / 已取消 / 已退款 / 支付超时 / 失败 不计入。*/
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

const GENDER_LABEL: Record<string, string> = {
  MALE: '男',
  FEMALE: '女',
  OTHER: '其他',
};

interface OrderRow {
  orderNumber: string;
  status: string;
  agency: string;
  contactName: string;
  contactPhone: string;
  // 乘客
  chineseName: string;
  pnrName: string;
  gender: string;
  dateOfBirth: string;
  documentNumber: string;
  nationality: string;
  passportExpiry: string;
  // 航班
  flightNumbers: string;
  departDate: string;
  route: string;
  // 产品
  bundleName: string;
  hotelInfo: string;
  visaInfo: string;
  transferInfo: string;
  // 财务（无成本，只有客户付的金额）
  orderTotal: number;
  // 元信息
  recordedAt: string;
  notes: string;
}

const COLUMNS: Array<{ header: string; key: keyof OrderRow; width: number }> = [
  { header: '订单号', key: 'orderNumber', width: 20 },
  { header: '订单状态', key: 'status', width: 10 },
  { header: '代理', key: 'agency', width: 16 },
  { header: '联系人', key: 'contactName', width: 12 },
  { header: '联系电话', key: 'contactPhone', width: 14 },
  { header: '乘客中文名', key: 'chineseName', width: 14 },
  { header: 'PNR 姓名', key: 'pnrName', width: 20 },
  { header: '性别', key: 'gender', width: 6 },
  { header: '出生日期', key: 'dateOfBirth', width: 12 },
  { header: '护照号', key: 'documentNumber', width: 16 },
  { header: '国籍', key: 'nationality', width: 8 },
  { header: '护照有效期', key: 'passportExpiry', width: 12 },
  { header: '航班号', key: 'flightNumbers', width: 12 },
  { header: '出发日期', key: 'departDate', width: 12 },
  { header: '路线', key: 'route', width: 14 },
  { header: '套餐', key: 'bundleName', width: 18 },
  { header: '酒店房型', key: 'hotelInfo', width: 28 },
  { header: '签证', key: 'visaInfo', width: 20 },
  { header: '接送', key: 'transferInfo', width: 18 },
  { header: '订单金额', key: 'orderTotal', width: 12 },
  { header: '录入时间', key: 'recordedAt', width: 18 },
  { header: '备注', key: 'notes', width: 24 },
];

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
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
          };
        };
        hotelRoomType: { select: { name: true } };
        visa: { select: { visaName: true; visaType: true; country: true } };
        transfer: { select: { name: true } };
        bundle: { select: { name: true } };
      };
    };
  };
}>;

/** 把一张订单展开成 N 行（每位乘客一行）— 不含成本/毛利。*/
function orderToRows(order: OrderForExport): OrderRow[] {
  // ── 航班信息（可能去程+回程多段）──
  const flightNumbers: string[] = [];
  const departDates: Date[] = [];
  const routes: string[] = [];
  for (const it of order.items) {
    if (it.kind === 'FLIGHT' && it.flightSchedule) {
      flightNumbers.push(it.flightSchedule.flight.flightNumber);
      departDates.push(it.flightSchedule.departureTime);
      routes.push(
        `${it.flightSchedule.flight.originCode} → ${it.flightSchedule.flight.destinationCode}`,
      );
    }
  }
  departDates.sort((a, b) => a.getTime() - b.getTime());

  // ── 酒店：房型 + 入住起止 ──
  const hotelParts: string[] = [];
  for (const it of order.items) {
    if (it.kind === 'HOTEL' && it.hotelRoomType) {
      const range =
        it.hotelCheckIn && it.hotelCheckOut
          ? ` (${fmtDate(it.hotelCheckIn)} ~ ${fmtDate(it.hotelCheckOut)})`
          : '';
      hotelParts.push(`${it.hotelRoomType.name}${range}`);
    }
  }

  // ── 签证：优先 visaName，回落 visaType；附带国家 ──
  const visaParts: string[] = [];
  for (const it of order.items) {
    if (it.kind === 'VISA' && it.visa) {
      const name = it.visa.visaName ?? it.visa.visaType;
      const country = it.visa.country ? ` · ${it.visa.country}` : '';
      visaParts.push(`${name}${country}`);
    }
  }

  // ── 接送 ──
  const transferParts: string[] = [];
  for (const it of order.items) {
    if (it.kind === 'TRANSFER' && it.transfer) {
      transferParts.push(it.transfer.name);
    }
  }

  // ── 套餐 ──
  const bundleParts: string[] = [];
  for (const it of order.items) {
    if (it.kind === 'BUNDLE' && it.bundle) {
      bundleParts.push(it.bundle.name);
    }
  }

  const agency = order.agent?.companyName ?? order.agent?.contactName ?? '直销';
  const statusLabel = STATUS_LABEL[order.status] ?? order.status;
  const flightStr = Array.from(new Set(flightNumbers)).join(' / ');
  const routeStr = Array.from(new Set(routes)).join(' / ');
  const departStr = fmtDate(departDates[0]);
  const orderTotal = dec(order.total);
  const recordedAt = fmtDateTime(order.createdAt);

  return order.passengers.map<OrderRow>((p) => {
    const pnrName =
      p.lastName && p.firstName ? `${p.lastName}/${p.firstName}`.toUpperCase() : p.fullName;
    return {
      orderNumber: order.orderNumber,
      status: statusLabel,
      agency,
      contactName: order.contactName,
      contactPhone: order.contactPhone,
      chineseName: p.fullName,
      pnrName,
      gender: p.gender ? GENDER_LABEL[p.gender] ?? p.gender : '',
      dateOfBirth: fmtDate(p.dateOfBirth),
      documentNumber: p.documentNumber,
      nationality: toAlpha3(p.nationality),
      passportExpiry: fmtDate(p.passportExpiry),
      flightNumbers: flightStr,
      departDate: departStr,
      route: routeStr,
      bundleName: bundleParts.join(' + '),
      hotelInfo: hotelParts.join(' + '),
      visaInfo: visaParts.join(' + '),
      transferInfo: transferParts.join(' + '),
      orderTotal,
      recordedAt,
      notes: order.notes ?? '',
    };
  });
}

/**
 * 构建按班次的整班机订单导出 xlsx。
 * @param scheduleId 班次 ID（来自 FlightSchedule.id）
 * @param client    可选注入用于测试；缺省取默认 prisma
 */
export async function buildOrdersBySchedule(
  scheduleId: string,
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  // 开票进度（航司上限指示）：已开票乘客数 vs 班次 ticketingCap
  const [schedule, issuedCount] = await Promise.all([
    client.flightSchedule.findUnique({
      where: { id: scheduleId },
      select: { ticketingCap: true },
    }),
    countIssuedPassengers(client, scheduleId),
  ]);

  const orders = (await client.order.findMany({
    where: {
      status: { in: COUNTED_STATUSES },
      items: {
        some: {
          kind: 'FLIGHT',
          flightScheduleId: scheduleId,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      agent: { select: { companyName: true, contactName: true } },
      passengers: true,
      items: {
        include: {
          flightSchedule: {
            include: {
              flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
            },
          },
          hotelRoomType: { select: { name: true } },
          visa: { select: { visaName: true, visaType: true, country: true } },
          transfer: { select: { name: true } },
          bundle: { select: { name: true } },
        },
      },
    },
  })) as OrderForExport[];

  const rows: OrderRow[] = [];
  for (const o of orders) {
    if (o.passengers.length === 0) continue;
    rows.push(...orderToRows(o));
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · 整班机订单导出';
  wb.created = new Date();
  const ws = wb.addWorksheet('班机订单明细');
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  for (const r of rows) ws.addRow(r);

  // 开票进度指示行 — 插在表头上方；满额标红提醒运营停止开票
  let frozenRows = 1;
  if (schedule) {
    const cap = schedule.ticketingCap;
    ws.insertRow(1, [`开票进度：已开票 ${issuedCount} / 上限 ${cap} 张`]);
    ws.mergeCells(1, 1, 1, COLUMNS.length);
    ws.getRow(1).font = {
      bold: true,
      color: { argb: issuedCount >= cap ? 'FFCC0000' : 'FF555555' },
    };
    frozenRows = 2;
  }

  // 冻结指示行+表头 + 订单号列，便于横向滚动核对
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: frozenRows }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/**
 * 文件名：`订单明细_{flightNumber}_{departureDate}.xlsx`
 * 例：`订单明细_ZJ8888_2026-06-10.xlsx`
 */
export function ordersExportFilename(
  _scheduleId: string,
  flightInfo: { flightNumber: string; departureDate: string },
): string {
  return `订单明细_${flightInfo.flightNumber}_${flightInfo.departureDate}.xlsx`;
}
