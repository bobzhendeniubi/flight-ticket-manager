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
import { OrderStatus, FulfillmentType } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { businessDateISO, businessDateTimeSec } from '../../lib/business-time.js';
import {
  buildOrderContext,
  orderToVisaRows,
  pnrName,
  VISA_COLUMNS,
  type OrderForTemplateExport,
} from './orders.export-templates.js';
import { extFromUrl, fetchPhoto, sanitize } from './passport-zip.js';

/** 签证名单口径：退款申请中的订单已释放应出行名单，不再导出。*/
const COUNTED_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/** 合并签证名单的 xlsx 列 = 《签证专用》全列 + 末尾「有无护照图」（沿用送签表口径）。*/
const HAS_PHOTO_COLUMN = { header: '有无护照图', key: 'hasPhoto', width: 20 } as const;

// ── 签证岗样表排版口径 ─────────────────────────────────────────────────────
// 样表特征：首列「序号」、全表细实线边框、表头灰底加粗、数据区隔行斑马纹、行高统一、内容居中
// （姓名/护照号等文本列左对齐、金额列右对齐）。仅影响签证批量合并名单导出，不动《签证专用》模板。
const SERIAL_HEADER = '序号'; // 首列表头：样表用「序号」（原 STT）
const HEADER_ROW_HEIGHT = 30; // 表头行更高，容纳越/中双语换行表头
const DATA_ROW_HEIGHT = 18; // 数据行统一行高
const HEADER_FILL_ARGB = 'FFEFEFEF'; // 表头灰底
const ZEBRA_FILL_ARGB = 'FFF3F6F9'; // 数据区隔行浅色
const BORDER_ARGB = 'FFBFBFBF'; // 细实线边框（浅灰）
const THIN_BORDER = {
  top: { style: 'thin' as const, color: { argb: BORDER_ARGB } },
  left: { style: 'thin' as const, color: { argb: BORDER_ARGB } },
  bottom: { style: 'thin' as const, color: { argb: BORDER_ARGB } },
  right: { style: 'thin' as const, color: { argb: BORDER_ARGB } },
};
/** 金额列右对齐；姓名/护照号等关键列左对齐；其余列居中（对齐样表口径）。*/
const AMOUNT_ALIGN_KEYS = new Set<string>(['settlePrice', 'paidAmount', 'balanceDue']);
const LEFT_ALIGN_KEYS = new Set<string>(['chineseName', 'name', 'passportNumber']);

function horizontalForKey(key: string): 'left' | 'right' | 'center' {
  if (AMOUNT_ALIGN_KEYS.has(key)) return 'right';
  if (LEFT_ALIGN_KEYS.has(key)) return 'left';
  return 'center';
}

/** 履约任务里带 notes 的窄类型（queryOrdersByIdsForVisa 已把 notes 补进 select，类型由 cast 收口）。*/
type VisaFulfillmentTask = { type: FulfillmentType; notes: string | null };

/**
 * 「签证备注」列取数：该单签证履约任务（VISA_APPLICATION）的备注文本。
 * 一单可能有多条签证任务，去重后换行拼接；无备注则留空（不造数）。
 */
function visaTaskNoteOf(order: OrderForTemplateExport): string {
  const notes = new Set<string>();
  for (const item of order.items) {
    const tasks = item.fulfillmentTasks as unknown as VisaFulfillmentTask[];
    for (const task of tasks) {
      const note = task.notes?.trim();
      if (task.type === FulfillmentType.VISA_APPLICATION && note) notes.add(note);
    }
  }
  return Array.from(notes).join('\n');
}

/**
 * 全表加细实线边框、行高统一、内容对齐；数据区隔行斑马纹（表头保留灰底/加粗）。
 * 用 getCell 逐格设样式（含空值单元格），确保「全表实线边框」不因空单元格而断线。
 */
function styleVisaSheet(ws: ExcelJS.Worksheet, columnKeys: string[]): void {
  const totalCols = columnKeys.length;
  const totalRows = ws.rowCount;
  for (let r = 1; r <= totalRows; r += 1) {
    const row = ws.getRow(r);
    const isHeader = r === 1;
    row.height = isHeader ? HEADER_ROW_HEIGHT : DATA_ROW_HEIGHT;
    const zebra = !isHeader && r % 2 === 1; // 数据行隔行填充（第 3、5、7… 行）
    for (let c = 1; c <= totalCols; c += 1) {
      const cell = row.getCell(c);
      cell.border = THIN_BORDER;
      cell.alignment = {
        vertical: 'middle',
        horizontal: isHeader ? 'center' : horizontalForKey(columnKeys[c - 1]),
        wrapText: isHeader,
      };
      if (zebra) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL_ARGB } };
      }
    }
  }
}

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
          visa: { select: { code: true, visaName: true, visaType: true, supplier: true } },
          transfer: { select: { code: true } },
          bundle: { select: { code: true } },
          // notes 用于「签证备注」列（visaTaskNoteOf）；类型经 `as OrderForTemplateExport[]` 收口
          fulfillmentTasks: { select: { type: true, status: true, notes: true } },
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
 * 按签证岗样表排版：首列「序号」（原 STT）、全表细实线边框、表头灰底加粗、数据区隔行斑马纹、
 * 行高统一、内容居中（姓名/护照号左对齐、金额列右对齐）。「签证备注」列取该单签证履约任务备注。
 * 纯映射，便于单测。空乘客订单自动跳过；全无数据也出带表头的空表。
 */
export async function buildVisaBundleXlsx(orders: OrderForTemplateExport[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '签证资料整日打包';
  wb.created = new Date();
  const ws = wb.addWorksheet('签证专用');

  const columns = [...VISA_COLUMNS, HAS_PHOTO_COLUMN];
  const columnKeys = columns.map((c) => c.key as string);
  // 首列表头 STT → 「序号」（签证岗样表口径）；其余列沿用《签证专用》表头
  ws.columns = columns.map((c) => ({
    header: c.key === 'stt' ? SERIAL_HEADER : c.header,
    key: c.key,
    width: c.width,
  }));
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } };

  let stt = 0;
  for (const order of orders) {
    if (order.passengers.length === 0) continue;
    const ctx = buildOrderContext(order);
    const rows = orderToVisaRows(order, ctx);
    // 「签证备注」列：该单签证履约任务备注。orderToVisaRows 固定把 visaNote 留空（见其注释），
    // 这里按单算出后在下方覆盖——一单内各乘客共用同一签证备注。
    const visaNote = visaTaskNoteOf(order);
    // orderToVisaRows 内部已排除自备签乘客（visaExempt=true，见该函数注释 P1-13）——
    // 护照图有无按位对齐同样要用过滤后的乘客列表，否则行数不等长会把图状态错位标给下一位乘客。
    const visaPassengers = order.passengers.filter((p) => p.visaExempt !== true);
    rows.forEach((row, i) => {
      stt += 1;
      const hasPhoto = visaPassengers[i]?.passportPhotoUrl
        ? '有护照图'
        : '无护照图（手工录入）';
      ws.addRow({ stt, ...row, visaNote, hasPhoto });
    });
  }

  styleVisaSheet(ws, columnKeys);
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

/** 文件名：`签证名单_{订单数}单_{YYYY-MM-DD}.xlsx`（日期＝北京业务日）。*/
export function visaRosterXlsxFilename(orderCount: number): string {
  const ymd = businessDateISO(new Date());
  return `签证名单_${orderCount}单_${ymd}.xlsx`;
}

/**
 * 护照图 zip（不含 xlsx 名单）：勾选订单里**需我方送签**的乘客护照图，按订单号前缀分组打包。
 *
 * 自备签乘客（visaExempt=true）不打包 —— 与签证名单 xlsx、签证台乘客列表同口径
 * （2026-08-31 签证岗口径：自备签的人护照包里也不要有，我方不需要）。被排掉的人在
 * README.txt 里点名，不静默少人。
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
  const exempted: string[] = [];
  let paxTotal = 0;

  for (const order of orders) {
    for (const p of order.passengers) {
      paxTotal += 1;
      // 自备签：客人自行办妥签证，我方不送 → 不打包护照图，只在 README 点名
      if (p.visaExempt === true) {
        exempted.push(`${order.orderNumber} · ${pnrName(p)}`);
        continue;
      }
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
    `打包时间：${businessDateTimeSec(new Date())}（北京时间）`,
    `勾选订单数：${orderIds.length}`,
    `已打包订单数：${orders.length}`,
    `乘客总数：${paxTotal}`,
    `自备签（不需送签，未打包）：${exempted.length}`,
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
    ...(exempted.length
      ? ['— 自备签，不需送签，未打包：', ...exempted.map((s) => `  · ${s}`), '']
      : []),
    ...(missing.length ? ['⚠ 缺护照图：', ...missing.map((s) => `  · ${s}`)] : []),
  ].join('\n');
  zip.file('README.txt', readme);

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return out;
}

/** 文件名：`签证护照_{订单数}单_{YYYY-MM-DD}.zip`（日期＝北京业务日）。*/
export function visaPassportsZipFilename(orderCount: number): string {
  const ymd = businessDateISO(new Date());
  return `签证护照_${orderCount}单_${ymd}.zip`;
}
