/**
 * 一键导出 PNR Excel — 航司提交格式（25 列）
 *
 * 用户场景：运营拿订单里的乘客信息，按航司要求格式上传给 GDS / 出票系统。
 * 列定义对齐用户提供的样本文件 (20MAY QH9589 MFM-DAD 1P)。
 */
import ExcelJS from 'exceljs';
import { businessDateISO } from '../../lib/business-time.js';
import { localDateISO } from '../../lib/flight-time.js';
import type { Passenger } from '@prisma/client';
import { toAlpha3 } from './nationality.js';
import { splitPassengerFullName } from '../../lib/passenger-name.js';

/** 日期 → DDMmmYY 格式，如 24Oct95 / 12Dec34（航司标准）*/
export function formatPnrDate(d: Date | null | undefined): string {
  if (!d) return '';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = months[d.getUTCMonth()];
  const yr = String(d.getUTCFullYear()).slice(-2);
  return `${day}${mon}${yr}`;
}

/** PTC code: ADT (adult) / CHD (child) / INF (infant) —— 录入 passengerType 直译，仅作年龄无法推算时的回退口径。*/
function passengerTypeCode(t: string): string {
  return { ADULT: 'ADT', CHILD: 'CHD', INFANT: 'INF' }[t] ?? 'ADT';
}

/** 实足年龄（周岁）：at 相对 dob 按公历年/月/日比较，不满整年不进位。*/
function ageInYearsAt(dob: Date, at: Date): number {
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = at.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/** age → PTC 码：<2 岁 INF、2–<12 岁 CHD、≥12 岁 ADT；负数（生日晚于出发日，数据异常）→ null 交调用方回退。*/
function ptcFromAge(age: number): string | null {
  if (age < 0) return null;
  if (age < 2) return 'INF';
  if (age < 12) return 'CHD';
  return 'ADT';
}

/**
 * PTC 按「出发日 − 出生日期」实足年龄推算（航司口径）：<2 岁 INF、2–<12 岁 CHD、≥12 岁 ADT。
 * 出生日期缺失、或出发日取不到（纯地面单/无航班行）→ 回退录入的 passengerType，不阻断导出。
 *
 * 注意（C-6）：departureDate 必须是「出发地当地日」（可用 UTC 零点表示，如
 * earliestFlightDeparture 折算后的返回值），不能是裸的航班出发瞬时——红眼航班当地日与 UTC 日
 * 不同，用瞬时会在生日恰逢出发当天时把年龄多算/少算一天，边界误判 PTC。
 */
export function derivePtcByAge(
  dob: Date | null | undefined,
  departureDate: Date | null | undefined,
  fallbackPassengerType: string,
): string {
  if (!dob || !departureDate) return passengerTypeCode(fallbackPassengerType);
  const ptc = ptcFromAge(ageInYearsAt(dob, departureDate));
  return ptc ?? passengerTypeCode(fallbackPassengerType);
}

/**
 * PTC 推算的当地日版本（C-6 新 helper）：直接接收已折算好的「出发地当地日」字符串
 * （YYYY-MM-DD，如 earliestFlightDepartureLocalDate 的返回值），而不是要求调用方先把
 * 本地日包回一个 UTC 零点 Date 再传给 derivePtcByAge——语义更直白，供后续调用方
 * （如 orders.service.ts 的乘客类型服务端权威派生）逐步切换到「先拿本地日字符串」的写法。
 * 生日/当地出发日缺失 → 回退录入的 passengerType，与 derivePtcByAge 同口径。
 */
export function derivePtcByLocalDate(
  dob: Date | null | undefined,
  departureLocalDate: string | null | undefined,
  fallbackPassengerType: string,
): string {
  if (!dob || !departureLocalDate) return passengerTypeCode(fallbackPassengerType);
  const departureDate = new Date(`${departureLocalDate}T00:00:00.000Z`);
  const ptc = ptcFromAge(ageInYearsAt(dob, departureDate));
  return ptc ?? passengerTypeCode(fallbackPassengerType);
}

/**
 * Title 自动生成（航司系统只认 MR/MS，人名后带称谓，不分年龄段、无儿童称谓）：
 * 手录 Title 优先原样保留；未录入时按性别派生 —— 男 → MR、女 → MS，所有年龄段一致（含儿童/婴儿）；性别缺失留空。
 */
function deriveTitle(title: string | null | undefined, gender: string | null | undefined): string {
  if (title) return title;
  if (gender === 'M') return 'MR';
  if (gender === 'F') return 'MS';
  return '';
}

/**
 * 订单 FLIGHT 行里最早的出发时间（票务岗口径的"去程"）；无 FLIGHT 行（纯地面单）→ null。
 *
 * C-6 修复：返回值折算成「出发地当地日的 UTC 零点」而不是裸瞬时——下游全部通过
 * getUTCDate()/getUTCMonth()/getUTCFullYear() 读日期分量（PNR 文件名、derivePtcByAge 年龄
 * 判定、进单统计出发日分组列），红眼航班当地凌晨起飞时瞬时的 UTC 分量会落在前一天，
 * 这里统一折算一次，调用方全部不用改代码就能拿到当地日。联查了 departureTz 才折算；
 * 旧调用方（未在 select 里带 departureTz）保持裸 UTC 回退，行为不变（见 orders.service.ts
 * 待跟进的三处调用，需要它们各自的 select 补上 departureTz 才能吃到这个修复）。
 * 只需要日期字符串（不需要包回 Date）的场景改用 earliestFlightDepartureLocalDate。
 */
export function earliestFlightDeparture(
  items:
    | Array<{
        kind: string;
        flightSchedule?: { departureTime: Date; departureTz?: string | null } | null;
      }>
    | null
    | undefined,
): Date | null {
  let earliest: { at: Date; tz: string | null } | null = null;
  for (const it of items ?? []) {
    if (it.kind !== 'FLIGHT' || !it.flightSchedule) continue;
    const at = it.flightSchedule.departureTime;
    if (earliest === null || at < earliest.at) {
      earliest = { at, tz: it.flightSchedule.departureTz ?? null };
    }
  }
  if (!earliest) return null;
  if (!earliest.tz) return earliest.at;
  const localDate = localDateISO(earliest.at, earliest.tz);
  return new Date(`${localDate}T00:00:00.000Z`);
}

/**
 * 整单「出发日」YYYY-MM-DD —— 最早 FLIGHT 行的**出发地当地日**。
 * 跟运营在班次日历/订单列表上看到的日期是同一个口径；按 UTC 折会让当地凌晨起飞的
 * 红眼班次落到前一天，分房表按出发日筛选就会漏单。未联查 tz 时回退 UTC 日。
 */
export function earliestFlightDepartureLocalDate(
  items:
    | Array<{
        kind: string;
        flightSchedule?: { departureTime: Date; departureTz?: string | null } | null;
      }>
    | null
    | undefined,
): string | null {
  let earliest: { at: Date; tz: string | null } | null = null;
  for (const it of items ?? []) {
    if (it.kind !== 'FLIGHT' || !it.flightSchedule) continue;
    const at = it.flightSchedule.departureTime;
    if (earliest === null || at < earliest.at) {
      earliest = { at, tz: it.flightSchedule.departureTz ?? null };
    }
  }
  if (!earliest) return null;
  return earliest.tz ? localDateISO(earliest.at, earliest.tz) : earliest.at.toISOString().slice(0, 10);
}

export interface PnrRow {
  lastName: string;
  firstName: string;
  title: string;
  ptc: string;
  gender: string;
  dob: string;
  passportLast: string;
  passportFirst: string;
  passportNumber: string;
  passportNationality: string;
  passportIssueCountry: string;
  passportExpiry: string;
  visaNumber: string;
  visaType: string;
  visaIssueDate: string;
  placeOfBirth: string;
  visaPlaceOfIssue: string;
  visaCountryOfApplication: string;
  visaExpiry: string;
  addressType: string;
  addressCountry: string;
  addressDetails: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
}

export const PNR_COLUMNS: Array<{ header: string; key: keyof PnrRow }> = [
  { header: 'Last Name', key: 'lastName' },
  { header: 'First Name and Middle Name', key: 'firstName' },
  { header: 'Title', key: 'title' },
  { header: 'PTC', key: 'ptc' },
  { header: 'Gender', key: 'gender' },
  { header: 'Date of Birth', key: 'dob' },
  { header: 'Passport Last Name', key: 'passportLast' },
  { header: 'Passport First Name', key: 'passportFirst' },
  { header: 'Passport Number', key: 'passportNumber' },
  { header: 'Passport Nationality', key: 'passportNationality' },
  { header: 'Passport Issue Country', key: 'passportIssueCountry' },
  { header: 'Passport Expiry Date', key: 'passportExpiry' },
  { header: 'Visa Number', key: 'visaNumber' },
  { header: 'Visa Type', key: 'visaType' },
  { header: 'Visa Issue Date', key: 'visaIssueDate' },
  { header: 'Place of Birth', key: 'placeOfBirth' },
  { header: 'Visa Place of Issue', key: 'visaPlaceOfIssue' },
  { header: 'Visa Country of Application', key: 'visaCountryOfApplication' },
  { header: 'Visa Expiry Date', key: 'visaExpiry' },
  { header: 'Address Type', key: 'addressType' },
  { header: 'Address Country', key: 'addressCountry' },
  { header: 'Address Details', key: 'addressDetails' },
  { header: 'Address City', key: 'addressCity' },
  { header: 'Address State', key: 'addressState' },
  { header: 'Address Zip Code', key: 'addressZip' },
];

export function passengerToRow(p: Passenger, departureDate?: Date | null): PnrRow {
  // 优先用拆分字段；姓名缺失（含空串，`||` 语义）兜底按 fullName 拆分——支持空格或斜线：
  // OCR/OTA/老数据常见 "CHEN/HAOLIANG" 斜线格式，若只按空格切，整串会掉进 Last Name。
  const { lastName: autoLast, firstName: autoFirst } = splitPassengerFullName(p.fullName);
  const lastName = (p.lastName || autoLast || '').toUpperCase();
  const firstName = (p.firstName || autoFirst || '').toUpperCase();
  const ptc = derivePtcByAge(p.dateOfBirth, departureDate, p.passengerType);
  const title = deriveTitle(p.title, p.gender);
  return {
    lastName,
    firstName,
    title,
    ptc,
    gender: p.gender ?? '',
    dob: formatPnrDate(p.dateOfBirth),
    passportLast: lastName,
    passportFirst: firstName,
    passportNumber: p.documentNumber ?? '',
    passportNationality: toAlpha3(p.nationality),
    // 旧开票模版此列填「签发地」文本（如「河北」「曼谷」），非 ISO 国家码 —— 对齐旧口径。
    passportIssueCountry: p.passportIssuePlace ?? '',
    passportExpiry: formatPnrDate(p.passportExpiry),
    visaNumber: p.visaNumber ?? '',
    visaType: p.visaType ?? '',
    visaIssueDate: formatPnrDate(p.visaIssueDate),
    placeOfBirth: p.placeOfBirth ?? '',
    visaPlaceOfIssue: p.visaPlaceOfIssue ?? '',
    visaCountryOfApplication: p.visaCountryOfApplication ?? '',
    visaExpiry: formatPnrDate(p.visaExpiry),
    addressType: p.addressType ?? '',
    addressCountry: p.addressCountry ?? '',
    addressDetails: p.addressDetails ?? '',
    addressCity: p.addressCity ?? '',
    addressState: p.addressState ?? '',
    addressZip: p.addressZip ?? '',
  };
}

export interface PnrOrderInput {
  orderNumber: string;
  passengers: Passenger[];
  // FLIGHT 行（含关联班次出发时间+时区）—— 用于按「出发地当地日 − 出生日期」自动推 PTC；
  // departureTz 缺失时 earliestFlightDeparture 回退裸 UTC（C-6：联查了时区才能折算当地日）。
  // 纯地面单（无机票行）传空/不传，PTC 回退录入的 passengerType。
  items?: Array<{ kind: string; flightSchedule?: { departureTime: Date; departureTz?: string | null } | null }>;
}

export async function buildPnrWorkbook(order: PnrOrderInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · PNR Export';
  wb.created = new Date();

  const ws = wb.addWorksheet('Sheet0');
  ws.columns = PNR_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: 18 }));

  // 表头加粗 + 浅灰底
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle' };

  const departureDate = earliestFlightDeparture(order.items);
  for (const p of order.passengers) {
    ws.addRow(passengerToRow(p, departureDate));
  }

  wb.subject = `PNR ${order.orderNumber}`;

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/**
 * 导出文件名 `{DD}{MON} {orderNumber}.xlsx`（如 `13JUL WT2026...`）。
 * DD/MON 取该订单去程航班出发日（票务岗口径，UTC 与列内日期一致）；
 * 取不到出发日（纯地面单/无航班行）→ 回退今天，保持原格式。
 *
 * 回退分支按**北京业务日**取（原先用服务器本地分量，容器 TZ=UTC，北京 00:00–08:00
 * 导出会落到前一天，票务拿到的文件名比实际早一天）。
 */
export function pnrExportFilename(orderNumber: string, departureDate?: Date | null): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  let day: string;
  let mon: string;
  if (departureDate) {
    day = String(departureDate.getUTCDate()).padStart(2, '0');
    mon = months[departureDate.getUTCMonth()];
  } else {
    const [, m, d] = businessDateISO(new Date()).split('-');
    day = d;
    mon = months[Number(m) - 1];
  }
  return `${day}${mon} ${orderNumber}.xlsx`;
}
