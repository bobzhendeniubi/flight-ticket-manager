/**
 * 签证资料导出 — 签证岗反馈：勾选若干订单，把这些订单的签证名单导出在同一张表格上，
 * 护照也一起下载。原先按订单一份份导（10 单导 10 次再手工拼），易漏人。
 *
 * 0713 签证岗反馈 V1：合并 zip 一起打包不方便（多一步解压），有些只需要表或只需要护照，
 * 希望能拆开分别下载。故拆成两个独立导出：
 *   buildVisaRosterXlsx   —— 仅合并签证名单 xlsx（勾选订单乘客合并，一行一人）
 *   buildVisaPassportsZip —— 仅护照图 zip（不再打包 xlsx），缺图/跳过明细走 README.txt
 *
 * 入参：勾选的订单 id 列表。被勾选但状态不合格（草稿/取消/退款等，见 COUNTED_STATUSES）的订单
 *      跳过：名单里静默不出现；护照包在 README.txt 里点名（查不到的 id 同样点名）。
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
 * 按勾选的订单 id 列表取单（软删排除；状态过滤放到 partitionOrdersForVisa，以便把「被勾选但状态
 * 不合格」的订单在护照包 README 里点名跳过，而不是静默漏掉）。复用三模板导出的 include 形状。
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
 * 状态过滤 + 排序（合并名单/护照包共用）：勾选订单里状态不合格（草稿/取消/退款等）的挑出来，
 * 查不到的 id 也一并列出，交给调用方各自决定怎么呈现（名单静默不含；护照包在 README 点名）。
 */
function partitionOrdersForVisa(
  orderIds: string[],
  fetched: OrderForTemplateExport[],
): {
  qualified: OrderForTemplateExport[];
  skippedByStatus: OrderForTemplateExport[];
  notFoundIds: string[];
} {
  const qualified = sortOrdersForVisa(
    fetched.filter((o) => COUNTED_STATUSES.includes(o.status)),
  );
  const skippedByStatus = fetched.filter((o) => !COUNTED_STATUSES.includes(o.status));
  const foundIds = new Set(fetched.map((o) => o.id));
  const notFoundIds = orderIds.filter((id) => !foundIds.has(id));
  return { qualified, skippedByStatus, notFoundIds };
}

/**
 * 签证名单 xlsx（不含护照图）：按勾选订单 id 取单 → 状态过滤 → 排序 → 合并成一张《签证专用》表。
 * 状态不合格 / 查不到的订单静默不计入（名单本身只需要合格单；跳过明细见护照包端的 README）。
 * 无合格订单时仍产出带表头的空表，避免下载到内容为空但打不开的文件。
 */
export async function buildVisaRosterXlsx(
  orderIds: string[],
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const fetched = await queryOrdersByIdsForVisa(orderIds, client);
  const { qualified } = partitionOrdersForVisa(orderIds, fetched);
  return buildVisaBundleXlsx(qualified);
}

/** 文件名：`签证名单_{订单数}单_{YYYY-MM-DD}.xlsx`。*/
export function visaRosterXlsxFilename(orderCount: number): string {
  const ymd = new Date().toISOString().slice(0, 10);
  return `签证名单_${orderCount}单_${ymd}.xlsx`;
}

/**
 * 护照图 zip（不含 xlsx 名单）：勾选订单的全部乘客护照图，按订单号前缀分组打包。
 * 文件名：`{订单号}-{LASTNAME}_{FIRSTNAME}[_序号].{ext}`（订单号前缀避免跨单撞名；
 * 同单同名再加序号后缀）。护照图逐个 fetch → 立即写入 zip，沿用 passport-zip.ts 的取图口径。
 *
 * 状态过滤在此处做：被勾选但状态不合格（草稿/取消/退款等）或查不到的订单跳过，
 * 连同缺图/下载失败的乘客一起记入 README.txt，避免静默漏单/漏人。
 */
export async function buildVisaPassportsZip(
  orderIds: string[],
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const fetched = await queryOrdersByIdsForVisa(orderIds, client);
  const { qualified: orders, skippedByStatus, notFoundIds } = partitionOrdersForVisa(
    orderIds,
    fetched,
  );

  const zip = new JSZip();

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
    `签证护照打包`,
    `打包时间：${new Date().toISOString()}`,
    `勾选订单数：${orderIds.length}`,
    `已打包订单数：${orders.length}`,
    `乘客总数：${paxTotal}`,
    `护照图成功：${ok.length}`,
    `护照图缺失/失败：${missing.length}`,
    '',
    ...(orders.length
      ? ['已打包订单：', ...orders.map((o) => `  · ${o.orderNumber}`), '']
      : []),
    ...(skippedByStatus.length
      ? [
          '⚠ 已跳过（订单状态不合格）：',
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

/** 文件名：`签证护照_{订单数}单_{YYYY-MM-DD}.zip`。*/
export function visaPassportsZipFilename(orderCount: number): string {
  const ymd = new Date().toISOString().slice(0, 10);
  return `签证护照_${orderCount}单_${ymd}.zip`;
}
