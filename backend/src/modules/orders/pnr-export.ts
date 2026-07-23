/**
 * 一键导出 PNR Excel — 航司提交格式（25 列）
 *
 * 用户场景：运营拿订单里的乘客信息，按航司要求格式上传给 GDS / 出票系统。
 * 列定义对齐用户提供的样本文件 (20MAY QH9589 MFM-DAD 1P)。
 */
import ExcelJS from 'exceljs';
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

/**
 * PTC 按「出发日 − 出生日期」实足年龄推算（航司口径）：<2 岁 INF、2–<12 岁 CHD、≥12 岁 ADT。
 * 出生日期缺失、或出发日取不到（纯地面单/无航班行）→ 回退录入的 passengerType，不阻断导出。
 */
export function derivePtcByAge(
  dob: Date | null | undefined,
  departureDate: Date | null | undefined,
  fallbackPassengerType: string,
): string {
  if (!dob || !departureDate) return passengerTypeCode(fallbackPassengerType);
  const age = ageInYearsAt(dob, departureDate);
  if (age < 0) return passengerTypeCode(fallbackPassengerType); // 生日晚于出发日：数据异常，回退录入值
  if (age < 2) return 'INF';
  if (age < 12) return 'CHD';
  return 'ADT';
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

/** 订单 FLIGHT 行里最早的出发时间（票务岗口径的"去程"）；无 FLIGHT 行（纯地面单）→ null。*/
export function earliestFlightDeparture(
  items: Array<{ kind: string; flightSchedule?: { departureTime: Date } | null }> | null | undefined,
): Date | null {
  const departures = (items ?? [])
    .filter((it) => it.kind === 'FLIGHT' && it.flightSchedule)
    .map((it) => it.flightSchedule!.departureTime);
  if (departures.length === 0) return null;
  return departures.reduce((min, d) => (d < min ? d : min));
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
  // FLIGHT 行（含关联班次出发时间）—— 用于按「出发日 − 出生日期」自动推 PTC；
  // 纯地面单（无机票行）传空/不传，PTC 回退录入的 passengerType。
  items?: Array<{ kind: string; flightSchedule?: { departureTime: Date } | null }>;
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
 */
export function pnrExportFilename(orderNumber: string, departureDate?: Date | null): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  let day: string;
  let mon: string;
  if (departureDate) {
    day = String(departureDate.getUTCDate()).padStart(2, '0');
    mon = months[departureDate.getUTCMonth()];
  } else {
    const today = new Date();
    day = String(today.getDate()).padStart(2, '0');
    mon = months[today.getMonth()];
  }
  return `${day}${mon} ${orderNumber}.xlsx`;
}
