/**
 * 一键打包护照图片 zip — 签证组 / 票务组用
 *
 * 输入：订单 + 该订单的所有乘客（含 passportPhotoUrl）
 * 输出：zip Buffer，结构：
 *   FTM2026...../{LASTNAME}_{passportNumber}.{ext}   （仅有图乘客）
 *   FTM2026...../README.txt                          （列出哪些乘客缺照片）
 *   FTM2026...../送签表.xlsx                         （始终附带：每位乘客一行）
 *
 * 缺失照片不报错 —— 写到 README.txt，并在送签表里每位乘客一行（无图乘客标「无护照图（手工录入）」），
 * 保证「手工录入、没护照图」的订单也能下载到可用资料表。空订单（无乘客）由路由层返回 400。
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { OrderItemKind, FulfillmentType, type Passenger } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

function sanitize(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
}

/** YYYY-MM-DD（null → ''），与导出模板同口径，按 UTC 取值避免时区漂移 */
function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 按出发地 IANA 时区把出发时刻转成本地日 YYYY-MM-DD（tz 不识别时回退 UTC） */
function fmtDepartureLocalDate(departure: Date | null, tz: string | null): string {
  if (!departure) return '';
  if (!tz) return fmtDate(departure);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(departure);
  } catch {
    return fmtDate(departure);
  }
}

/**
 * 订单级送签补充信息（全订单乘客共用一份）：
 *   departureLocalDate — 最早一段机票的本地出发日（按出发地时区）；纯签证单无航班 → ''
 *   remark             — 备注：优先签证任务备注，回落订单签证备注/客户备注
 */
async function loadVisaSheetContext(
  orderId: string | undefined,
): Promise<{ departureLocalDate: string; remark: string }> {
  if (!orderId) return { departureLocalDate: '', remark: '' };

  const [earliestFlight, order, visaTask] = await Promise.all([
    // 最早一段机票 → 客人出发日期
    prisma.orderItem.findFirst({
      where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
      select: { flightSchedule: { select: { departureTime: true, departureTz: true } } },
      orderBy: { flightSchedule: { departureTime: 'asc' } },
    }),
    // 订单级备注回落
    prisma.order.findUnique({
      where: { id: orderId },
      select: { notes: true, noteVisa: true },
    }),
    // 签证履约任务备注（优先）
    prisma.fulfillmentTask.findFirst({
      where: { type: FulfillmentType.VISA_APPLICATION, orderItem: { orderId } },
      select: { notes: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const sched = earliestFlight?.flightSchedule ?? null;
  const departureLocalDate = fmtDepartureLocalDate(
    sched?.departureTime ?? null,
    sched?.departureTz ?? null,
  );
  const remark = visaTask?.notes?.trim() || order?.noteVisa?.trim() || order?.notes?.trim() || '';

  return { departureLocalDate, remark };
}

/**
 * 护照姓名（LAST/FIRST 斜线格式）——
 * 优先用已拆分的 lastName/firstName；手工录入未拆分时从 fullName 尽力拆（不编造，拆不出就整体呈现）。
 * 保证「手工录入、没护照图」的乘客在送签表里也有可读姓名，不留空白。
 */
function passportSlashName(p: Passenger): string {
  const last = (p.lastName ?? '').trim();
  const first = (p.firstName ?? '').trim();
  if (last || first) {
    return [last.toUpperCase(), first.toUpperCase()].filter(Boolean).join('/');
  }
  const full = (p.fullName ?? '').trim();
  if (!full) return '';
  if (full.includes('/')) return full.toUpperCase();
  const parts = full.split(/\s+/);
  if (parts.length >= 2) {
    const [ln, ...rest] = parts;
    return `${ln.toUpperCase()}/${rest.join(' ').toUpperCase()}`;
  }
  return full.toUpperCase();
}

/** 送签表列定义（每乘客一行）— 表头中文，覆盖签证岗所需护照/签证字段 */
const VISA_SHEET_COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: '序号', key: 'seq', width: 6 },
  { header: '护照姓名(LAST/FIRST)', key: 'passportName', width: 24 },
  { header: '中文名', key: 'chineseName', width: 12 },
  { header: '性别', key: 'gender', width: 6 },
  { header: '出生日期', key: 'dateOfBirth', width: 14 },
  { header: '国籍', key: 'nationality', width: 10 },
  { header: '证件号', key: 'documentNumber', width: 18 },
  { header: '护照签发日', key: 'passportIssueDate', width: 14 },
  { header: '护照有效期', key: 'passportExpiry', width: 14 },
  { header: '签证号', key: 'visaNumber', width: 16 },
  { header: '签证类型', key: 'visaType', width: 14 },
  { header: '签证出签日', key: 'visaIssueDate', width: 14 },
  { header: '签证生效日', key: 'visaEffectiveDate', width: 14 },
  { header: '签证有效期', key: 'visaExpiry', width: 14 },
  { header: '客人出发日期', key: 'departureDate', width: 14 },
  { header: '备注', key: 'remark', width: 24 },
  { header: '是否有护照图', key: 'hasPhoto', width: 20 },
];

/** 构建「送签表」工作簿 Buffer（每乘客一行，缺值留空，绝不编造） */
async function buildVisaSheetBuffer(passengers: Passenger[]): Promise<Buffer> {
  // 出发日期 + 备注为订单级信息（全订单乘客共用）—— 只查一次
  const orderId = passengers[0]?.orderId;
  const { departureLocalDate, remark } = await loadVisaSheetContext(orderId);

  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet('送签表');
  ws.columns = VISA_SHEET_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

  passengers.forEach((p, i) => {
    ws.addRow({
      seq: i + 1,
      passportName: passportSlashName(p),
      chineseName: p.chineseName ?? '',
      gender: p.gender ?? '',
      dateOfBirth: fmtDate(p.dateOfBirth),
      nationality: p.nationality ?? '',
      documentNumber: p.documentNumber,
      passportIssueDate: fmtDate(p.passportIssueDate),
      passportExpiry: fmtDate(p.passportExpiry),
      visaNumber: p.visaNumber ?? '',
      visaType: p.visaType ?? '',
      visaIssueDate: fmtDate(p.visaIssueDate),
      visaEffectiveDate: fmtDate(p.visaEffectiveDate),
      visaExpiry: fmtDate(p.visaExpiry),
      departureDate: departureLocalDate,
      remark,
      hasPhoto: p.passportPhotoUrl ? '有护照图' : '无护照图（手工录入）',
    });
  });

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function extFromUrl(u: string): string {
  const m = u.match(/\.(jpe?g|png|webp|heic|gif)(?:\?|$)/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

async function fetchPhoto(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

export async function buildPassportPhotoZip(args: {
  orderNumber: string;
  passengers: Passenger[];
}): Promise<Buffer> {
  const zip = new JSZip();
  const folder = zip.folder(args.orderNumber) ?? zip;

  const missing: string[] = [];
  const ok: string[] = [];

  for (const p of args.passengers) {
    const slug = sanitize(`${p.lastName ?? ''}_${p.firstName ?? p.fullName}_${p.documentNumber}`);
    if (!p.passportPhotoUrl) {
      missing.push(`${slug}  — 该乘客没传护照照片`);
      continue;
    }
    const buf = await fetchPhoto(p.passportPhotoUrl);
    if (!buf) {
      missing.push(`${slug}  — 下载失败 (${p.passportPhotoUrl})`);
      continue;
    }
    folder.file(`${slug}.${extFromUrl(p.passportPhotoUrl)}`, buf);
    ok.push(slug);
  }

  const readme = [
    `订单：${args.orderNumber}`,
    `打包时间：${new Date().toISOString()}`,
    `乘客总数：${args.passengers.length}`,
    `成功打包：${ok.length}`,
    `缺失/失败：${missing.length}`,
    '',
    ...(ok.length ? ['✓ 已打包：', ...ok.map((s) => `  · ${s}`), ''] : []),
    ...(missing.length ? ['⚠ 缺照片：', ...missing.map((s) => `  · ${s}`)] : []),
  ].join('\n');
  folder.file('README.txt', readme);

  // 送签表.xlsx — 每乘客一行，签证岗据此填申请表（缺值留空）
  const visaSheetBuf = await buildVisaSheetBuffer(args.passengers);
  folder.file('送签表.xlsx', visaSheetBuf);

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return out;
}

export function passportZipFilename(orderNumber: string): string {
  return `${orderNumber}-passports.zip`;
}
