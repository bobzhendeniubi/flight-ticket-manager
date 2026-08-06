/**
 * 进单统计导出 — 公测反馈（票务）：「能否导出当日进单哪个日期、团期，进了多少人」。
 *
 * 与订单列表共用同一套筛选（buildOrderFilterWhere，尤其 from/to 下单时间窗口），把命中的订单
 * 按「出发日期 × 产品/团期」聚合，一行一组，列：出发日期、产品/团期、订单数、人数；末行总计。
 *
 *   · 出发日期：订单最早 FLIGHT 行出发日（去程）；纯地面单回落最早入住日；都取不到 → 「未设出发日」。
 *   · 产品/团期：套餐订单 = 套餐编码 + 名称（团期口径）；非套餐机票 = 「机票 {航班号}」（多航段按出发时间
 *     升序去重拼接，如「机票 QH9589+QH9588」；无航班号回退「机票」）；其它品类 = 按品类（酒店/签证/接送/保险）。
 *   · 人数 = 组内各订单乘客数之和；订单数 = 组内订单条数。
 *
 * 与其它导出一致，只统计「计数状态」的订单（草稿/已取消/已退款/超时/失败不计入）。
 */
import ExcelJS from 'exceljs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderItemKind, OrderStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { buildOrderFilterWhere, type OrderListFilters } from './orders.service.js';
import { earliestFlightDeparture } from './pnr-export.js';

/** 与财务/其它导出一致：草稿 / 已取消 / 已退款 / 支付超时 / 失败 不计入。*/
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

/** 非套餐订单按品类归组的中文标签。*/
const KIND_LABEL: Record<string, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  VISA: '签证',
  TRANSFER: '接送',
  INSURANCE: '保险',
  BUNDLE: '套餐',
};

const NO_DEPART_LABEL = '未设出发日';

/** YYYY-MM-DD（UTC date-only，与三模板导出的 fmtDate 同口径）*/
function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ── 取数 ────────────────────────────────────────────────────────────────
export type OrderForIntakeExport = Prisma.OrderGetPayload<{
  include: {
    passengers: { select: { id: true } };
    items: {
      select: {
        kind: true;
        hotelCheckIn: true;
        flightSchedule: {
          select: { departureTime: true; flight: { select: { flightNumber: true } } };
        };
        bundle: { select: { code: true; name: true } };
      };
    };
  };
}>;

/** 订单最早入住日（纯地面单在没有航段出发日时的回落）；无 → null。*/
function earliestHotelCheckIn(items: OrderForIntakeExport['items']): Date | null {
  const dates = items
    .map((it) => it.hotelCheckIn)
    .filter((d): d is Date => Boolean(d));
  if (dates.length === 0) return null;
  return dates.reduce((min, d) => (d < min ? d : min));
}

/** 订单出发日期（去程优先，回落入住日）；都无 → ''（归到「未设出发日」）。*/
export function intakeDepartDate(order: OrderForIntakeExport): string {
  const flight = earliestFlightDeparture(order.items);
  if (flight) return fmtDate(flight);
  const hotel = earliestHotelCheckIn(order.items);
  return hotel ? fmtDate(hotel) : '';
}

/** FLIGHT 订单项按出发时间升序去重的航班号列表（如 ['QH9589', 'QH9588']）；缺航班号的行跳过。*/
function flightNumbersByDeparture(items: OrderForIntakeExport['items']): string[] {
  const legs = items
    .filter((it) => it.kind === OrderItemKind.FLIGHT && it.flightSchedule?.flight?.flightNumber)
    .map((it) => ({
      flightNumber: it.flightSchedule!.flight!.flightNumber,
      departureTime: it.flightSchedule!.departureTime,
    }))
    .sort((a, b) => a.departureTime.getTime() - b.departureTime.getTime());
  const seen = new Set<string>();
  const numbers: string[] = [];
  for (const leg of legs) {
    if (!seen.has(leg.flightNumber)) {
      seen.add(leg.flightNumber);
      numbers.push(leg.flightNumber);
    }
  }
  return numbers;
}

/** 订单产品/团期标签：套餐 = 编码+名称；非套餐机票 = 「机票 {航班号}」；其它品类 = 品类。*/
export function intakeProductLabel(order: OrderForIntakeExport): string {
  const bundleItem = order.items.find((it) => it.kind === OrderItemKind.BUNDLE && it.bundle);
  if (bundleItem?.bundle) {
    const { code, name } = bundleItem.bundle;
    return code ? `${code} ${name}` : name;
  }
  // 非套餐：取首个订单项品类（订单通常单一品类；机票单程/往返都归「机票」）。
  const first = order.items[0];
  if (!first) return '';
  if (first.kind === OrderItemKind.FLIGHT) {
    const numbers = flightNumbersByDeparture(order.items);
    return numbers.length > 0 ? `机票 ${numbers.join('+')}` : '机票';
  }
  return KIND_LABEL[first.kind] ?? first.kind;
}

export interface IntakeRow {
  departDate: string; // 出发日期（''→「未设出发日」）
  product: string; // 产品/团期
  orderCount: number; // 订单数
  paxCount: number; // 人数
}

/**
 * 把订单聚合成「出发日期 × 产品/团期」的进单统计行（纯函数，供单测）。
 * 排序：出发日期升序（「未设出发日」殿后），同日期内产品名升序。
 */
export function aggregateIntakeRows(orders: OrderForIntakeExport[]): IntakeRow[] {
  const map = new Map<string, IntakeRow>();
  for (const order of orders) {
    const departDate = intakeDepartDate(order);
    const product = intakeProductLabel(order);
    const key = `${departDate} ${product}`;
    const cur = map.get(key) ?? { departDate, product, orderCount: 0, paxCount: 0 };
    cur.orderCount += 1;
    cur.paxCount += order.passengers.length;
    map.set(key, cur);
  }
  return Array.from(map.values()).sort((a, b) => {
    // 「未设出发日」（空串）排到最后；其余按日期字符串升序（ISO 日期字典序即时间序）。
    if (a.departDate !== b.departDate) {
      if (a.departDate === '') return 1;
      if (b.departDate === '') return -1;
      return a.departDate < b.departDate ? -1 : 1;
    }
    return a.product < b.product ? -1 : a.product > b.product ? 1 : 0;
  });
}

const INTAKE_COLUMNS: Array<{ header: string; key: keyof IntakeRow; width: number }> = [
  { header: '出发日期', key: 'departDate', width: 14 },
  { header: '产品/团期', key: 'product', width: 32 },
  { header: '订单数', key: 'orderCount', width: 10 },
  { header: '人数', key: 'paxCount', width: 10 },
];

// ── 主入口 ──────────────────────────────────────────────────────────────
export async function buildIntakeExportWorkbook(
  query: OrderListFilters,
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  // 与列表完全一致的筛选 + 强制排除不计数状态（已取消/超时/失败等）。
  const where = buildOrderFilterWhere(query);
  const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  and.push({ status: { in: COUNTED_STATUSES } });
  where.AND = and;

  const orders = (await client.order.findMany({
    where,
    include: {
      passengers: { select: { id: true } },
      items: {
        select: {
          kind: true,
          hotelCheckIn: true,
          flightSchedule: {
            select: { departureTime: true, flight: { select: { flightNumber: true } } },
          },
          bundle: { select: { code: true, name: true } },
        },
      },
    },
  })) as OrderForIntakeExport[];

  const rows = aggregateIntakeRows(orders);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · 进单统计导出';
  wb.created = new Date();
  const ws = wb.addWorksheet('进单统计');
  ws.columns = INTAKE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

  let totalOrders = 0;
  let totalPax = 0;
  for (const r of rows) {
    totalOrders += r.orderCount;
    totalPax += r.paxCount;
    ws.addRow({
      departDate: r.departDate || NO_DEPART_LABEL,
      product: r.product,
      orderCount: r.orderCount,
      paxCount: r.paxCount,
    });
  }
  // 末行总计
  const totalRow = ws.addRow({
    departDate: '总计',
    product: '',
    orderCount: totalOrders,
    paxCount: totalPax,
  });
  totalRow.font = { bold: true };
  totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/**
 * 文件名：`进单统计_{起}_{止}.xlsx`。from/to 可带时间（datetime-local），文件名里把非法字符
 * （冒号）换成短横，避免下载文件名异常；不传区间时用「全部」。
 */
export function intakeExportFilename(from?: string, to?: string): string {
  const safe = (s: string): string => s.replace(/:/gu, '-');
  const range = from || to ? `${safe(from ?? '起始')}_${safe(to ?? '至今')}` : '全部';
  return `进单统计_${range}.xlsx`;
}
