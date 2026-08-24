import { HoldAmountRule, HoldInstallmentStatus } from '@prisma/client';
import { BadRequestError } from '../../lib/errors.js';
import {
  perSeatAttributableCny,
  holdLedgerTotals,
  rebaseInstallmentsForRemainingSeats,
  type HoldLedger,
} from './hold-settlement.js';

export interface ReductionHold {
  seats: number;
  seatsConverted: number;
  seatsCancelled: number;
  perSeatPriceCny: number;
  freeCancelRatio: unknown;
  freeCancelUsed: number;
  reductions?: ReadonlyArray<{ forfeitCny?: number; surplusCny?: number; createdAt?: Date }>;
  conversions?: ReadonlyArray<{ carryCny?: number; createdAt?: Date }>;
}

export interface ReductionInstallment {
  seq: number;
  amountRule: HoldAmountRule;
  perPersonCny: number | null;
  amountCny: number;
  seatsBasis?: number;
  status?: HoldInstallmentStatus;
  paidAt?: Date | null;
  allocations?: ReadonlyArray<{ amountCny: unknown; reversedAt?: Date | null }>;
}

export interface ReductionInstallmentUpdate {
  seq: number;
  amountCny: number;
  seatsBasis: number;
  status: HoldInstallmentStatus;
  creditAppliedCny: number;
}

export interface ReductionResult {
  seatsReduced: number;
  freeSeats: number;
  forfeitSeats: number;
  perSeatPaidCny: number;
  forfeitCny: number;
  creditCny: number;
  surplusCny: number;
  freeQuota: number;
  installmentUpdates: ReductionInstallmentUpdate[];
}

function integerMoney(value: unknown): number {
  return Math.round(Number(value ?? 0));
}

function activeReceived(item: ReductionInstallment): number {
  if (!item.allocations) return item.status === HoldInstallmentStatus.PAID ? item.amountCny : 0;
  return item.allocations
    .filter((allocation) => !allocation.reversedAt)
    .reduce((sum, allocation) => sum + integerMoney(allocation.amountCny), 0);
}

function isPaid(item: ReductionInstallment): boolean {
  return item.amountCny === 0 || activeReceived(item) >= item.amountCny;
}

/** Decimal(4,3) 转千分位整数，避免 0.29×50 的二进制浮点边界。 */
function ratioThousandths(value: unknown): number {
  if (value == null) return 0;
  const text = String(value).trim();
  const [wholeText, fractionText = ''] = text.split('.');
  const whole = Number.parseInt(wholeText || '0', 10);
  const fraction = Number.parseInt(`${fractionText}000`.slice(0, 3), 10) || 0;
  return Math.max(0, Math.min(1000, whole * 1000 + fraction));
}

/**
 * 减员清算纯函数。所有“已付”判断都基于未撤销认款，而不是期上的历史 status。
 * 守恒口径：实收 = 历史没收 + 本次没收 + 历史挂账 + 本次挂账 + 可归属实收；
 * 未付固定期与尾款均从可归属实收中推导，credit 只作为免损展示字段，不再二次冲减。
 */
export function computeReduction(
  hold: ReductionHold,
  installments: ReadonlyArray<ReductionInstallment>,
  seatsReduced: number,
): ReductionResult {
  const availableSeats = hold.seats - hold.seatsConverted - hold.seatsCancelled;
  if (!Number.isInteger(seatsReduced) || seatsReduced < 1 || seatsReduced > availableSeats) {
    throw new BadRequestError(`减员人数必须在 1 至 ${Math.max(0, availableSeats)} 之间`);
  }
  if (installments.length === 0) throw new BadRequestError('占位单没有收款期，无法清算');

  const totalReceived = installments.reduce((sum, item) => sum + activeReceived(item), 0);
  // credit 是免损座位已付金额转给余座后的内部重摊，不从总实收中再次扣除。
  // 连续减员时按当前余座重摊，避免把定金、尾款分别取整后得到 966+34 之类的错账。
  const ledger: HoldLedger = { reductions: hold.reductions, conversions: hold.conversions };
  const ledgerTotals = holdLedgerTotals(ledger);
  const perSeatPaid = perSeatAttributableCny(totalReceived, availableSeats, ledger);
  const freeQuota = Math.round(hold.seats * ratioThousandths(hold.freeCancelRatio) / 1000);
  const tail = [...installments].sort((a, b) => b.seq - a.seq)[0];
  const freeSeats = isPaid(tail) ? 0 : Math.min(seatsReduced, Math.max(0, freeQuota - hold.freeCancelUsed));
  const forfeitSeats = seatsReduced - freeSeats;
  const creditCny = freeSeats * perSeatPaid;
  const currentForfeitCny = forfeitSeats * perSeatPaid;
  const remainingSeats = availableSeats - seatsReduced;
  const remainingContractCny = remainingSeats * hold.perSeatPriceCny;

  // 除不尽余数不按期分项另加；最终尾款/固定期守恒差额统一归入本次 surplus，避免连续清算重复计同一余数。
  // 先扣除本次已经确认无法归属的余数/固定期超收，再按 D2 公式推导尾款。
  const attributableReceived = totalReceived - ledgerTotals.forfeitCny - ledgerTotals.surplusCny - ledgerTotals.carryCny - currentForfeitCny;
  const rebased = rebaseInstallmentsForRemainingSeats(
    installments,
    remainingSeats,
    remainingContractCny,
    attributableReceived,
    true,
  );

  return {
    seatsReduced,
    freeSeats,
    forfeitSeats,
    perSeatPaidCny: perSeatPaid,
    forfeitCny: currentForfeitCny,
    creditCny,
    surplusCny: rebased.surplusCny,
    freeQuota,
    installmentUpdates: rebased.updates,
  };
}
