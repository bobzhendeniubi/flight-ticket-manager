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
import { businessDateTimeSec } from '../../lib/business-time.js';
import { fetchImageSafely } from '../../lib/safe-fetch.js';

export function sanitize(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
}

/** YYYY-MM-DD（null → ''），与导出模板同口径，按 UTC 取值避免时区漂移 */
export function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 按出发地 IANA 时区把出发时刻转成本地日 YYYY-MM-DD（tz 不识别时回退 UTC） */
export function fmtDepartureLocalDate(departure: Date | null, tz: string | null): string {
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

/**
 * 构建「送签表」工作簿 Buffer（每乘客一行，缺值留空，绝不编造）。
 *
 * 自备签乘客（visaExempt=true）不上这张表：客人已自行办妥签证，无需送签，与签证台过滤
 * 同口径（fulfillment.service.ts 的 listByOrder 同样排除 visaExempt=true 的乘客）——
 * 送签表是签证岗拿去申请的名单，混入自备签客人只会让签证岗多余核对/误送签。
 *
 * 送签表的这条排除口径**与包的 scope 无关**：不管谁下的包，这张表都是拿去递交的名单。
 * 护照图排不排自备签则看 scope（见 buildPassportPhotoZip）。
 */
async function buildVisaSheetBuffer(passengers: Passenger[]): Promise<Buffer> {
  // 出发日期 + 备注为订单级信息（全订单乘客共用）—— 只查一次；orderId 从未过滤的入参取，
  // 哪怕全员自备签也能查到订单上下文。
  const orderId = passengers[0]?.orderId;
  const { departureLocalDate, remark } = await loadVisaSheetContext(orderId);
  const visaPassengers = passengers.filter((p) => p.visaExempt !== true);

  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet('送签表');
  ws.columns = VISA_SHEET_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

  visaPassengers.forEach((p, i) => {
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

/**
 * 从图片来源推断文件扩展名（打包 zip 时用于命名）。
 *   - data URI（`data:image/<mime>;base64,...`，OCR/小程序直传常见落库形态）：
 *     按 MIME type 映射扩展名——原实现只匹配 URL 路径后缀，data URI 没有路径后缀可匹配，
 *     导致 PNG/WEBP/GIF 图一律被误标成 .jpg（图内容与后缀不符，部分看图软件打不开）。
 *   - 普通 URL：维持原口径，按路径末尾扩展名匹配。
 *   - 都匹配不到：兜底 .jpg（沿用原有行为）。
 */
export function extFromUrl(u: string): string {
  const dataUriMatch = u.match(/^data:image\/([a-z0-9.+-]+)/i);
  if (dataUriMatch) {
    const mime = dataUriMatch[1].toLowerCase();
    if (mime === 'png' || mime === 'webp' || mime === 'gif') return mime;
    if (mime === 'jpeg' || mime === 'jpg') return 'jpg';
    return 'jpg'; // 其余/未知 MIME（如 svg+xml）沿用兜底，不引入未知后缀
  }
  const m = u.match(/\.(jpe?g|png|webp|heic|gif)(?:\?|$)/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

/**
 * 护照图抓取。委托给 SSRF 安全实现（data-URL 本地解码；远程仅 https 且拒私网/元数据；
 * 无重定向；字节封顶）。所有 ZIP 构建共用此出口。
 */
export async function fetchPhoto(url: string): Promise<Buffer | null> {
  return fetchImageSafely(url);
}

/**
 * 护照包的两种用途 —— **按入口分，不按人分**。
 *
 * 签证岗与操作岗在系统里都是 STAFF（UserRole 只有 CUSTOMER/AGENT/STAFF/ADMIN 四档），
 * 服务端分不出谁是谁；同一个人也可能两种包都要。所以由**调用入口**声明要哪种包，
 * 谁点哪个按钮就拿哪种，不必记自己是什么岗。
 *
 *   'visa' —— 送签包（签证台行内「下载护照」/ 勾选批量）：只含**要我方送签**的乘客，
 *             自备签的人图和表都没有，被排掉的人在 README 点名。
 *   'all'  —— 全员资料包（订单详情「打包护照」，默认）：护照图打包整单乘客。
 *             包内送签表仍按送签口径排除自备签（2026-07-14 起如此，操作岗一直这么用）。
 */
export type PassportZipScope = 'visa' | 'all';

export async function buildPassportPhotoZip(args: {
  orderNumber: string;
  passengers: Passenger[];
  /** 省略 = 'all'（全员资料包），保持订单详情既有行为不变 */
  scope?: PassportZipScope;
}): Promise<Buffer> {
  const scope: PassportZipScope = args.scope ?? 'all';
  const zip = new JSZip();
  const folder = zip.folder(args.orderNumber) ?? zip;

  const missing: string[] = [];
  const ok: string[] = [];

  // scope='visa' 时自备签乘客不进护照包（与包内送签表同口径）；名字仍写进 README，
  // 让签证岗看得见"这人是自备签、不是漏了"。scope='all' 照旧全员打包。
  // 传给 buildVisaSheetBuffer 的**始终**是未过滤的入参（它自己按送签口径再过滤，并靠
  // 首个乘客拿订单上下文——全员自备签时也才查得到）。
  const exempted = args.passengers.filter((p) => p.visaExempt === true);
  const packable = scope === 'visa' ? args.passengers.filter((p) => p.visaExempt !== true) : args.passengers;

  for (const p of packable) {
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
    `打包时间：${businessDateTimeSec(new Date())}（北京时间）`,
    `包类型：${scope === 'visa' ? '送签包（仅需我方送签的乘客）' : '全员资料包（整单乘客护照图）'}`,
    `乘客总数：${args.passengers.length}`,
    ...(scope === 'visa'
      ? [`需我方送签：${packable.length}`, `自备签（不需送签，未打包）：${exempted.length}`]
      : [`其中自备签：${exempted.length}（护照图已打包；送签表按送签口径不含他们）`]),
    `成功打包：${ok.length}`,
    `缺失/失败：${missing.length}`,
    '',
    ...(ok.length ? ['✓ 已打包：', ...ok.map((s) => `  · ${s}`), ''] : []),
    ...(scope === 'visa' && exempted.length
      ? [
          '— 自备签，不需送签，未打包：',
          ...exempted.map(
            (p) => `  · ${sanitize(`${p.lastName ?? ''}_${p.firstName ?? p.fullName}`)}`,
          ),
          '',
        ]
      : []),
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
