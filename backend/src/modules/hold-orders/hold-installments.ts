import { HoldAmountRule, type Prisma } from '@prisma/client';
import { BadRequestError } from '../../lib/errors.js';
import { localDateISO } from '../../lib/flight-time.js';

export interface HoldInstallmentTemplate {
  label: string;
  amountRule: HoldAmountRule;
  perPersonCny?: number;
  dueOffsetDays: number | null;
}

export interface HoldInstallmentOverride {
  label: string;
  perPersonCny?: number;
  dueDate: string;
}

export interface FoldedInstallment {
  seq: number;
  label: string;
  amountRule: HoldAmountRule;
  perPersonCny: number | null;
  amountCny: number;
  seatsBasis: number;
  dueDate: Date;
}

export const FALLBACK_HOLD_INSTALLMENTS: HoldInstallmentTemplate[] = [
  { label: '定金', amountRule: HoldAmountRule.PER_PERSON_FIXED, perPersonCny: 300, dueOffsetDays: null },
  { label: '二定', amountRule: HoldAmountRule.PER_PERSON_FIXED, perPersonCny: 300, dueOffsetDays: 15 },
  { label: '尾款', amountRule: HoldAmountRule.REMAINDER, dueOffsetDays: 7 },
];

export const FALLBACK_HOLD_CONFIG = {
  installments: FALLBACK_HOLD_INSTALLMENTS,
  overdueAction: 'REMIND_ONLY' as const,
  defaultFreeCancelRatio: 0.1,
};

export function dateInTimezone(date: Date, tz: string | null | undefined): string {
  return localDateISO(date, tz);
}

export function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dateOnly(dateString: string): Date {
  return new Date(`${dateString}T00:00:00Z`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestError(`${label}必须是非负整数`);
  }
}

/**
 * 计算收款模板，并把建单日以前（含建单日）的期折叠成首期。
 * 折叠在金额计算之后进行，所以 REMAINDER 始终按建单时总价一次算定。
 */
export function foldInstallments(input: {
  seats: number;
  perSeatPriceCny: number;
  createdAt: Date;
  departureTime: Date;
  departureTz: string | null | undefined;
  templates: ReadonlyArray<HoldInstallmentTemplate>;
}): FoldedInstallment[] {
  assertNonNegativeInteger(input.seats, '占位人数');
  assertNonNegativeInteger(input.perSeatPriceCny, '每人结算价');
  if (input.templates.length === 0) throw new BadRequestError('收款模板至少需要一期');

  const departureDate = dateInTimezone(input.departureTime, input.departureTz);
  const createdDate = dateInTimezone(input.createdAt, input.departureTz);
  const remainderCount = input.templates.filter((item) => item.amountRule === HoldAmountRule.REMAINDER).length;
  if (remainderCount !== 1) throw new BadRequestError('收款模板必须且只能有一期尾款');

  const fixedTotal = input.templates
    .filter((item) => item.amountRule === HoldAmountRule.PER_PERSON_FIXED)
    .reduce((sum, item) => {
      const perPerson = item.perPersonCny ?? -1;
      assertNonNegativeInteger(perPerson, `${item.label}每人金额`);
      return sum + perPerson * input.seats;
    }, 0);
  const remainder = input.seats * input.perSeatPriceCny - fixedTotal;
  if (remainder < 0) {
    throw new BadRequestError('收款模板定金总额超过占位总价，请改价或调整收款模板');
  }

  const raw = input.templates.map((item) => {
    const amountCny = item.amountRule === HoldAmountRule.REMAINDER
      ? remainder
      : (item.perPersonCny ?? 0) * input.seats;
    const dueDate = item.dueOffsetDays == null
      ? createdDate
      : addDays(departureDate, -item.dueOffsetDays);
    return {
      label: item.label.trim(),
      amountRule: item.amountRule,
      perPersonCny: item.amountRule === HoldAmountRule.PER_PERSON_FIXED ? item.perPersonCny ?? 0 : null,
      amountCny,
      dueDate,
    };
  });

  const expired = raw.filter((item) => item.dueDate <= createdDate);
  const future = raw.filter((item) => item.dueDate > createdDate);
  const merged: Array<typeof raw[number]> = [];
  if (expired.length > 0) {
    const allFixed = expired.every((item) => item.amountRule === HoldAmountRule.PER_PERSON_FIXED);
    merged.push({
      label: expired.map((item) => item.label).join('+'),
      amountRule: allFixed ? HoldAmountRule.PER_PERSON_FIXED : HoldAmountRule.REMAINDER,
      perPersonCny: allFixed ? expired.reduce((sum, item) => sum + (item.perPersonCny ?? 0), 0) : null,
      amountCny: expired.reduce((sum, item) => sum + item.amountCny, 0),
      dueDate: createdDate,
    });
  }
  merged.push(...future);
  return merged.map((item, index) => ({
    seq: index + 1,
    label: item.label,
    amountRule: item.amountRule,
    perPersonCny: item.perPersonCny,
    amountCny: item.amountCny,
    seatsBasis: input.seats,
    dueDate: dateOnly(item.dueDate),
  }));
}

/** 将前端谈定的截止日/固定单价转成已算定的期；金额始终由服务端重算。 */
export function buildInstallmentsFromOverride(input: {
  seats: number;
  perSeatPriceCny: number;
  createdAt: Date;
  departureTz: string | null | undefined;
  overrides: ReadonlyArray<HoldInstallmentOverride>;
}): FoldedInstallment[] {
  assertNonNegativeInteger(input.seats, '占位人数');
  assertNonNegativeInteger(input.perSeatPriceCny, '每人结算价');
  if (input.overrides.length === 0) throw new BadRequestError('收款计划至少需要一期');
  const rows = input.overrides.map((item, index) => {
    if (!item.label.trim()) throw new BadRequestError('收款期名称不能为空');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)) throw new BadRequestError('收款截止日格式应为 YYYY-MM-DD');
    const hasPerPerson = item.perPersonCny != null;
    if (index === input.overrides.length - 1 ? hasPerPerson : !hasPerPerson) {
      throw new BadRequestError(index === input.overrides.length - 1 ? '尾款必须是最后一期且不能填写每人金额' : '非尾款期必须填写每人金额');
    }
    if (hasPerPerson) assertNonNegativeInteger(item.perPersonCny!, `${item.label}每人金额`);
    return {
      label: item.label.trim(),
      amountRule: hasPerPerson ? HoldAmountRule.PER_PERSON_FIXED : HoldAmountRule.REMAINDER,
      perPersonCny: hasPerPerson ? item.perPersonCny! : null,
      amountCny: hasPerPerson ? item.perPersonCny! * input.seats : 0,
      dueDate: item.dueDate,
    };
  });
  const tailDueDate = rows[rows.length - 1].dueDate;
  if (rows.slice(0, -1).some((row) => row.dueDate > tailDueDate)) {
    throw new BadRequestError('收款期截止日必须逐期不晚于尾款截止日');
  }
  const fixedTotal = rows
    .filter((row) => row.amountRule === HoldAmountRule.PER_PERSON_FIXED)
    .reduce((sum, row) => sum + (row.perPersonCny ?? 0) * input.seats, 0);
  const contractTotal = input.seats * input.perSeatPriceCny;
  if (fixedTotal > contractTotal) {
    throw new BadRequestError('收款计划非尾款总额超过占位合同总价，请改价或调整收款计划');
  }
  rows[rows.length - 1].amountCny = contractTotal - fixedTotal;
  const createdDate = dateInTimezone(input.createdAt, input.departureTz);
  const expired = rows.filter((row) => row.dueDate <= createdDate);
  const future = rows.filter((row) => row.dueDate > createdDate);
  const merged = expired.length > 0
    ? [{
        label: expired.map((row) => row.label).join('+'),
        amountRule: expired.every((row) => row.amountRule === HoldAmountRule.PER_PERSON_FIXED)
          ? HoldAmountRule.PER_PERSON_FIXED
          : HoldAmountRule.REMAINDER,
        perPersonCny: expired.every((row) => row.amountRule === HoldAmountRule.PER_PERSON_FIXED)
          ? expired.reduce((sum, row) => sum + (row.perPersonCny ?? 0), 0)
          : null,
        amountCny: expired.reduce((sum, row) => sum + row.amountCny, 0),
        dueDate: createdDate,
      }, ...future]
    : rows;
  return merged.map((row, index) => ({ ...row, seq: index + 1, seatsBasis: input.seats, dueDate: dateOnly(row.dueDate) }));
}

export function installmentCreateData(rows: ReadonlyArray<FoldedInstallment>) {
  return rows.map((row) => ({
    seq: row.seq,
    label: row.label,
    amountRule: row.amountRule,
    perPersonCny: row.perPersonCny,
    amountCny: row.amountCny,
    seatsBasis: row.seatsBasis,
    dueDate: row.dueDate,
  })) satisfies Prisma.HoldInstallmentCreateManyHoldOrderInput[];
}
