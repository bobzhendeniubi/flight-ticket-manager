/**
 * 存量脏格式乘客姓名清洗 — 纯变更计算（无副作用）。
 *
 * 背景：normalizePassengerFullName（见 ./passenger-name.ts）已接入下单 / 换人入口，
 * 新录入数据不再脏；但历史库里仍留有脏格式（实锤 `ZHENG,/QINQIN`）。
 * 本文件只负责「给一行数据算出要不要改、改成什么」，真正扫库/写库/命令行参数解析
 * 在 backend/scripts/normalize-passenger-names.ts。
 *
 * 口径（与 orders.schemas.ts 的 swapPassengerBodySchema 同一套）：
 *  - Passenger.fullName / lastName / firstName 各自独立过 normalizePassengerFullName
 *    （lastName/firstName 只做单段规范化，不做斜线拼接）。
 *  - TravelerProfile.fullName 同样过 normalizePassengerFullName。
 *  - chineseName 等中文字段不在清洗范围内，本文件不涉及。
 *  - null / undefined / 空白字段跳过（不是脏数据，是没填）。
 */
import { normalizePassengerFullName } from './passenger-name.js';

export interface NameFieldChange {
  field: string;
  from: string;
  to: string;
}

export interface PassengerNameRow {
  id: string;
  fullName?: string | null;
  lastName?: string | null;
  firstName?: string | null;
}

export interface TravelerProfileNameRow {
  id: string;
  fullName?: string | null;
}

const PASSENGER_LATIN_NAME_FIELDS = ['fullName', 'lastName', 'firstName'] as const;

/**
 * 算单个字段的变更：null/undefined/纯空白跳过；规范化后不变也跳过。
 */
function computeFieldChange(
  field: string,
  raw: string | null | undefined,
): NameFieldChange | null {
  if (raw == null) return null;
  if (raw.trim() === '') return null;

  const normalized = normalizePassengerFullName(raw);
  if (normalized === raw) return null;

  return { field, from: raw, to: normalized };
}

/**
 * 算 Passenger 一行的姓名变更集（fullName/lastName/firstName，chineseName 不动）。
 */
export function computePassengerNameChanges(row: PassengerNameRow): NameFieldChange[] {
  const changes: NameFieldChange[] = [];
  for (const field of PASSENGER_LATIN_NAME_FIELDS) {
    const change = computeFieldChange(field, row[field]);
    if (change) changes.push(change);
  }
  return changes;
}

/**
 * 算 TravelerProfile 一行的姓名变更集（只有 fullName，chineseName 不动）。
 */
export function computeTravelerProfileNameChanges(
  row: TravelerProfileNameRow,
): NameFieldChange[] {
  const change = computeFieldChange('fullName', row.fullName);
  return change ? [change] : [];
}
