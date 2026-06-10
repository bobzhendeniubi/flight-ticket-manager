/**
 * 一键导出 PNR Excel — 航司提交格式（25 列）
 *
 * 用户场景：运营拿订单里的乘客信息，按航司要求格式上传给 GDS / 出票系统。
 * 列定义对齐用户提供的样本文件 (20MAY QH9589 MFM-DAD 1P)。
 */
import ExcelJS from 'exceljs';
import type { Passenger } from '@prisma/client';
import { toAlpha3 } from './nationality.js';

/** 日期 → DDMmmYY 格式，如 24Oct95 / 12Dec34（航司标准）*/
export function formatPnrDate(d: Date | null | undefined): string {
  if (!d) return '';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = months[d.getUTCMonth()];
  const yr = String(d.getUTCFullYear()).slice(-2);
  return `${day}${mon}${yr}`;
}

/** PTC code: ADT (adult) / CHD (child) / INF (infant) */
function passengerTypeCode(t: string): string {
  return { ADULT: 'ADT', CHILD: 'CHD', INFANT: 'INF' }[t] ?? 'ADT';
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

export function passengerToRow(p: Passenger): PnrRow {
  // 优先用拆分字段；fullName 兜底（按空格切）
  const [autoLast, ...rest] = (p.fullName || '').trim().split(/\s+/);
  const autoFirst = rest.join(' ');
  const lastName = (p.lastName ?? autoLast ?? '').toUpperCase();
  const firstName = (p.firstName ?? autoFirst ?? '').toUpperCase();
  return {
    lastName,
    firstName,
    title: p.title ?? '',
    ptc: passengerTypeCode(p.passengerType),
    gender: p.gender ?? '',
    dob: formatPnrDate(p.dateOfBirth),
    passportLast: lastName,
    passportFirst: firstName,
    passportNumber: p.documentNumber ?? '',
    passportNationality: toAlpha3(p.nationality),
    passportIssueCountry: toAlpha3(p.passportIssueCountry),
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

export async function buildPnrWorkbook(order: { orderNumber: string; passengers: Passenger[] }): Promise<Buffer> {
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

  for (const p of order.passengers) {
    ws.addRow(passengerToRow(p));
  }

  wb.subject = `PNR ${order.orderNumber}`;

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export function pnrExportFilename(orderNumber: string): string {
  const today = new Date();
  const day = String(today.getDate()).padStart(2, '0');
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const mon = months[today.getMonth()];
  return `${day}${mon} ${orderNumber}.xlsx`;
}
