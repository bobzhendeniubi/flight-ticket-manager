/**
 * 签证资料整日打包 zip — 签证岗 0708 反馈：「同一天出发的所有订单，签证名单导出在同一张
 * 表格上，护照也一起下载」。原先按订单一份份导（10 单导 10 次再手工拼），易漏人。
 *
 * 入参：出发日 YYYY-MM-DD（与分房表 departDate 同口径：订单任一 FLIGHT 行班次落在该 UTC 日；
 *      无挂班次航班的订单回退到占房 item 的入住日 == 该日）。
 * 输出：单个 zip Buffer：
 *   签证专用_出发{departDate}.xlsx   —— 该日全部订单乘客合并，一行一人（《签证专用》模板 + 性别
 *                                       + 末列「有无护照图」，沿用送签表口径）
 *   {订单号}-{LASTNAME}_{FIRSTNAME}.{ext}  —— 全部乘客护照图（订单号前缀避免跨单撞名；无图乘客
 *                                            自然缺文件，xlsx 里有「有无护照图」标注）
 *
 * 护照图逐个 fetch → 立即写入 zip（不先把所有图读进一个数组），沿用 passport-zip.ts 的取图口径。
 * 该日无订单时仍产出仅含空表（带表头）的 xlsx，避免下载到非法 zip。
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { PrismaClient } from '@prisma/client';
import { OrderItemKind, OrderStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import {
  buildOrderContext,
  orderToVisaRows,
  pnrName,
  VISA_COLUMNS,
  type OrderForTemplateExport,
} from './orders.export-templates.js';
import { extFromUrl, fetchPhoto, sanitize } from './passport-zip.js';

/** 与财务/订单导出一致：草稿 / 已取消 / 已退款 / 支付超时 / 失败 不计入。*/
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

/** 'YYYY-MM-DD' → UTC 零点 Date，与 Prisma @db.Date 存取口径一致。*/
function toDateOnly(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

/** 合并签证名单的 xlsx 列 = 《签证专用》全列 + 末尾「有无护照图」（沿用送签表口径）。*/
const HAS_PHOTO_COLUMN = { header: '有无护照图', key: 'hasPhoto', width: 20 } as const;

/**
 * 按「出发日」选订单（与 orders.export-room-allocation.ts 的 queryRoomItemsByDepartDate 同口径），
 * 但选的是订单本身（不局限于占房 item）—— 纯机票单（无酒店）也要进签证名单。
 *   - 主口径：订单任一 FLIGHT 行所在班次 departureTime 落在该 UTC 日（[dayStart, 次日) 半开区间）。
 *   - 回落：订单没有任何挂了班次的 FLIGHT 行时，按其占房 item 的 hotelCheckIn == 该日选中。
 */
export async function queryOrdersByDepartDateForVisa(
  departDate: string,
  client: PrismaClient = defaultPrisma,
): Promise<OrderForTemplateExport[]> {
  const dayStart = toDateOnly(departDate);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return (await client.order.findMany({
    where: {
      deletedAt: null, // 排除已软删订单
      status: { in: COUNTED_STATUSES },
      OR: [
        {
          items: {
            some: {
              kind: OrderItemKind.FLIGHT,
              flightSchedule: { departureTime: { gte: dayStart, lt: dayEnd } },
            },
          },
        },
        {
          AND: [
            { items: { none: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } } } },
            { items: { some: { hotelRoomTypeId: { not: null }, hotelCheckIn: dayStart } } },
          ],
        },
      ],
    },
    // 名单按录入倒序（最新录入在最上），与三模板导出一致
    orderBy: { createdAt: 'desc' },
    include: {
      agent: { select: { companyName: true } },
      user: { select: { displayName: true, email: true } },
      passengers: true,
      payments: true,
      refunds: true,
      items: {
        include: {
          flightSchedule: {
            include: {
              flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
            },
          },
          hotelRoomType: { select: { name: true, hotel: { select: { name: true, code: true } } } },
          visa: { select: { code: true, visaName: true, visaType: true } },
          transfer: { select: { code: true } },
          bundle: { select: { code: true } },
          fulfillmentTasks: { select: { type: true, status: true } },
        },
      },
    },
  })) as OrderForTemplateExport[];
}

/**
 * 把该日全部订单的乘客合并成一张《签证专用》xlsx（一行一人，含性别、末列「有无护照图」）。
 * 纯映射，便于单测。空乘客订单自动跳过；全无数据也出带表头的空表。
 */
export async function buildVisaBundleXlsx(orders: OrderForTemplateExport[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '签证资料整日打包';
  wb.created = new Date();
  const ws = wb.addWorksheet('签证专用');

  const columns = [...VISA_COLUMNS, HAS_PHOTO_COLUMN];
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

  let stt = 0;
  for (const order of orders) {
    if (order.passengers.length === 0) continue;
    const ctx = buildOrderContext(order);
    const rows = orderToVisaRows(order, ctx);
    rows.forEach((row, i) => {
      stt += 1;
      // orderToVisaRows 逐 order.passengers 映射 → 第 i 行即第 i 位乘客，据此取其护照图有无
      const hasPhoto = order.passengers[i]?.passportPhotoUrl
        ? '有护照图'
        : '无护照图（手工录入）';
      ws.addRow({ stt, ...row, hasPhoto });
    });
  }

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/**
 * 构建签证资料整日 zip：合并签证名单 xlsx + 全部乘客护照图。
 * 护照图文件名：`{订单号}-{LASTNAME}_{FIRSTNAME}[_序号].{ext}`（订单号前缀避免跨单撞名；
 * 同单同名再加序号后缀）。无图/下载失败的乘客自然缺文件，README.txt 记录明细。
 */
export async function buildVisaBundleZip(
  params: { departDate: string },
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const orders = await queryOrdersByDepartDateForVisa(params.departDate, client);

  const zip = new JSZip();

  // 合并签证名单（始终附带，哪怕当日无单也出带表头的空表）
  const xlsxBuf = await buildVisaBundleXlsx(orders);
  zip.file(`签证专用_出发${params.departDate}.xlsx`, xlsxBuf);

  const usedNames = new Set<string>();
  const missing: string[] = [];
  const ok: string[] = [];
  let paxTotal = 0;

  for (const order of orders) {
    for (const p of order.passengers) {
      paxTotal += 1;
      // 文件名前缀：订单号 + 护照姓名（LAST_FIRST，回落 fullName），同单同名再补序号避免覆盖
      const nameSlug = sanitize(
        p.lastName || p.firstName ? `${p.lastName ?? ''}_${p.firstName ?? ''}` : p.fullName,
      ).toUpperCase();
      let base = `${sanitize(order.orderNumber)}-${nameSlug}`;
      if (usedNames.has(base)) {
        let n = 2;
        while (usedNames.has(`${base}_${n}`)) n += 1;
        base = `${base}_${n}`;
      }
      usedNames.add(base);

      const label = `${order.orderNumber} · ${pnrName(p)}`;
      if (!p.passportPhotoUrl) {
        missing.push(`${label} — 该乘客没传护照照片`);
        continue;
      }
      const buf = await fetchPhoto(p.passportPhotoUrl);
      if (!buf) {
        missing.push(`${label} — 下载失败 (${p.passportPhotoUrl})`);
        continue;
      }
      zip.file(`${base}.${extFromUrl(p.passportPhotoUrl)}`, buf);
      ok.push(label);
    }
  }

  const readme = [
    `签证资料整日打包`,
    `出发日：${params.departDate}`,
    `打包时间：${new Date().toISOString()}`,
    `订单数：${orders.length}`,
    `乘客总数：${paxTotal}`,
    `护照图成功：${ok.length}`,
    `护照图缺失/失败：${missing.length}`,
    '',
    ...(ok.length ? ['✓ 已打包护照图：', ...ok.map((s) => `  · ${s}`), ''] : []),
    ...(missing.length ? ['⚠ 缺护照图：', ...missing.map((s) => `  · ${s}`)] : []),
  ].join('\n');
  zip.file('README.txt', readme);

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return out;
}

/** 文件名：`签证资料_出发{departDate}.zip`。*/
export function visaBundleZipFilename(departDate: string): string {
  return `签证资料_出发${departDate}.zip`;
}
