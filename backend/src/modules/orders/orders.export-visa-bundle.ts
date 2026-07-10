/**
 * 签证资料合并打包 zip — 签证岗反馈：勾选若干订单，把这些订单的签证名单导出在同一张表格上，
 * 护照也一起下载。原先按订单一份份导（10 单导 10 次再手工拼），易漏人。
 *
 * 入参：勾选的订单 id 列表。被勾选但状态不合格（草稿/取消/退款等，见 COUNTED_STATUSES）的订单
 *      跳过，并在 README.txt 里注明；查不到的 id 同样在 README 里注明。
 * 输出：单个 zip Buffer：
 *   签证专用_合并名单.xlsx   —— 勾选订单乘客合并，一行一人（《签证专用》模板 + 性别
 *                             + 末列「有无护照图」，沿用送签表口径）
 *   {订单号}-{LASTNAME}_{FIRSTNAME}.{ext}  —— 全部乘客护照图（订单号前缀避免跨单撞名；无图乘客
 *                                            自然缺文件，xlsx 里有「有无护照图」标注）
 *
 * 护照图逐个 fetch → 立即写入 zip（不先把所有图读进一个数组），沿用 passport-zip.ts 的取图口径。
 * 无合格订单时仍产出仅含空表（带表头）的 xlsx，避免下载到非法 zip。
 *
 * 排序：合并名单按「代理机构名 → 订单号 → 乘客原始顺序」分组（同代理相邻，便于按代理核对）；
 *      无代理的直客归为一组排在最后。STT 跨订单连续累加。
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { PrismaClient } from '@prisma/client';
import { OrderStatus } from '@prisma/client';
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

/** 合并签证名单的 xlsx 列 = 《签证专用》全列 + 末尾「有无护照图」（沿用送签表口径）。*/
const HAS_PHOTO_COLUMN = { header: '有无护照图', key: 'hasPhoto', width: 20 } as const;

/**
 * 按勾选的订单 id 列表取单（软删排除；状态过滤放到 buildVisaBundleZip，以便把「被勾选但状态
 * 不合格」的订单在 README 里点名跳过，而不是静默漏掉）。复用三模板导出的 include 形状。
 */
export async function queryOrdersByIdsForVisa(
  orderIds: string[],
  client: PrismaClient = defaultPrisma,
): Promise<OrderForTemplateExport[]> {
  if (orderIds.length === 0) return [];
  return (await client.order.findMany({
    where: {
      deletedAt: null, // 排除已软删订单
      id: { in: orderIds },
    },
    // 取回后在 sortOrdersForVisa 里按「代理→订单号」重排，这里的顺序不影响最终名单顺序
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
 * 合并名单排序：代理机构名 → 订单号 → （乘客原始顺序在 orderToVisaRows 里天然保留）。
 * 同代理相邻，便于按代理核对；无代理的直客（agent 为空）归为一组排在最后。
 * 不改乘客顺序 —— 仅重排订单，STT 由调用方跨订单连续累加。
 */
export function sortOrdersForVisa(orders: OrderForTemplateExport[]): OrderForTemplateExport[] {
  return [...orders].sort((a, b) => {
    const agA = a.agent?.companyName ?? '';
    const agB = b.agent?.companyName ?? '';
    // 直客（无代理名）排最后：一方为空则空的靠后
    if (agA !== agB) {
      if (!agA) return 1;
      if (!agB) return -1;
      return agA.localeCompare(agB, 'zh-Hans-CN');
    }
    return a.orderNumber.localeCompare(b.orderNumber);
  });
}

/**
 * 把订单的乘客合并成一张《签证专用》xlsx（一行一人，含性别、末列「有无护照图」）。
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
 * 构建签证资料合并 zip：勾选订单的合并签证名单 xlsx + 全部乘客护照图。
 * 护照图文件名：`{订单号}-{LASTNAME}_{FIRSTNAME}[_序号].{ext}`（订单号前缀避免跨单撞名；
 * 同单同名再加序号后缀）。无图/下载失败的乘客自然缺文件，README.txt 记录明细。
 *
 * 状态过滤在此处做：被勾选但状态不合格（草稿/取消/退款等）或查不到的订单跳过并在 README 点名。
 */
export async function buildVisaBundleZip(
  params: { orderIds: string[] },
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const fetched = await queryOrdersByIdsForVisa(params.orderIds, client);

  // 状态合格才进名单；不合格 / 查不到的另行在 README 点名，避免静默漏单
  const qualified = sortOrdersForVisa(
    fetched.filter((o) => COUNTED_STATUSES.includes(o.status)),
  );
  const skippedByStatus = fetched.filter((o) => !COUNTED_STATUSES.includes(o.status));
  const foundIds = new Set(fetched.map((o) => o.id));
  const notFoundIds = params.orderIds.filter((id) => !foundIds.has(id));

  const orders = qualified;

  const zip = new JSZip();

  // 合并签证名单（始终附带，哪怕无合格单也出带表头的空表）
  const xlsxBuf = await buildVisaBundleXlsx(orders);
  zip.file(`签证专用_合并名单.xlsx`, xlsxBuf);

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
    `签证资料合并打包`,
    `打包时间：${new Date().toISOString()}`,
    `勾选订单数：${params.orderIds.length}`,
    `已打包订单数：${orders.length}`,
    `乘客总数：${paxTotal}`,
    `护照图成功：${ok.length}`,
    `护照图缺失/失败：${missing.length}`,
    '',
    ...(orders.length
      ? ['已打包订单（含在合并名单）：', ...orders.map((o) => `  · ${o.orderNumber}`), '']
      : []),
    ...(skippedByStatus.length
      ? [
          '⚠ 已跳过（订单状态不合格，未计入名单）：',
          ...skippedByStatus.map((o) => `  · ${o.orderNumber}（${o.status}）`),
          '',
        ]
      : []),
    ...(notFoundIds.length
      ? ['⚠ 已跳过（订单不存在或已删除）：', ...notFoundIds.map((id) => `  · ${id}`), '']
      : []),
    ...(ok.length ? ['✓ 已打包护照图：', ...ok.map((s) => `  · ${s}`), ''] : []),
    ...(missing.length ? ['⚠ 缺护照图：', ...missing.map((s) => `  · ${s}`)] : []),
  ].join('\n');
  zip.file('README.txt', readme);

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return out;
}

/** 文件名：`签证资料_{订单数}单_{YYYYMMDD}导出.zip`（不再依赖出发日）。*/
export function visaBundleZipFilename(orderCount: number): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `签证资料_${orderCount}单_${ymd}导出.zip`;
}
