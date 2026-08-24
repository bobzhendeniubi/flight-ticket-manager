import { HoldAmountRule, HoldInstallmentStatus } from '@prisma/client';

export interface HoldLedgerReduction {
  forfeitCny?: number | null;
  surplusCny?: number | null;
}

export interface HoldLedgerConversion {
  carryCny?: number | null;
}

export interface HoldLedger {
  reductions?: ReadonlyArray<HoldLedgerReduction>;
  conversions?: ReadonlyArray<HoldLedgerConversion>;
}

export interface InstallmentForRebase {
  seq: number;
  amountRule: HoldAmountRule;
  perPersonCny: number | null;
  amountCny: number;
  status?: HoldInstallmentStatus;
  allocations?: ReadonlyArray<{ amountCny: unknown; reversedAt?: Date | null }>;
}

export interface InstallmentRebase {
  seq: number;
  amountCny: number;
  seatsBasis: number;
  status: HoldInstallmentStatus;
  creditAppliedCny: number;
}

export function activeReceivedCny(item: {
  amountCny: number;
  status?: HoldInstallmentStatus;
  allocations?: ReadonlyArray<{ amountCny: unknown; reversedAt?: Date | null }>;
}): number {
  if (!item.allocations) return item.status === HoldInstallmentStatus.PAID ? item.amountCny : 0;
  return item.allocations
    .filter((allocation) => !allocation.reversedAt)
    .reduce((sum, allocation) => sum + Math.round(Number(allocation.amountCny ?? 0)), 0);
}

export function holdLedgerTotals(ledger: HoldLedger): {
  forfeitCny: number;
  surplusCny: number;
  carryCny: number;
} {
  return {
    forfeitCny: (ledger.reductions ?? []).reduce((sum, row) => sum + (row.forfeitCny ?? 0), 0),
    surplusCny: (ledger.reductions ?? []).reduce((sum, row) => sum + (row.surplusCny ?? 0), 0),
    carryCny: (ledger.conversions ?? []).reduce((sum, row) => sum + (row.carryCny ?? 0), 0),
  };
}

/**
 * 清算账本的唯一「可归属实收」口径。
 * 总实收 = 没收累计 + 挂账累计 + 结转累计 + 可归属实收。
 */
export function attributableReceivedCny(totalReceived: number, ledger: HoldLedger): number {
  const totals = holdLedgerTotals(ledger);
  return totalReceived - totals.forfeitCny - totals.surplusCny - totals.carryCny;
}

/**
 * 占位单当前余座的人均可归属实收。减员与名单转正必须共用此函数，避免各自取整。
 */
export function perSeatAttributableCny(
  totalReceived: number,
  availableSeats: number,
  ledger: HoldLedger,
): number {
  return Math.max(0, Math.floor(attributableReceivedCny(totalReceived, ledger) / Math.max(1, availableSeats)));
}

function isPaid(item: InstallmentForRebase): boolean {
  return item.amountCny === 0 || activeReceivedCny(item) >= item.amountCny;
}

/**
 * 座位基数变化后的期款重算内核。减员和转正都只改变余座基数，具体业务动作各自处理
 * 没收/结转；因此两条路径共用这里的固定期与尾款重算。
 */
export function rebaseInstallmentsForRemainingSeats(
  installments: ReadonlyArray<InstallmentForRebase>,
  remainingSeats: number,
  remainingContractCny: number,
  attributableReceived: number,
  recordSurplus = true,
): { updates: InstallmentRebase[]; surplusCny: number } {
  const sorted = [...installments].sort((a, b) => a.seq - b.seq);
  const tail = [...sorted].sort((a, b) => b.seq - a.seq)[0];
  const updates: InstallmentRebase[] = [];
  let surplusCny = 0;
  let unpaidFixedTotal = 0;

  for (const item of sorted) {
    if (isPaid(item) || item.amountRule !== HoldAmountRule.PER_PERSON_FIXED) continue;
    const received = activeReceivedCny(item);
    const target = remainingSeats * (item.perPersonCny ?? 0);
    const nextAmount = Math.max(target, received);
    if (recordSurplus && received > target) surplusCny += received - target;
    updates.push({
      seq: item.seq,
      amountCny: nextAmount,
      seatsBasis: remainingSeats,
      status: nextAmount <= received ? HoldInstallmentStatus.PAID : HoldInstallmentStatus.PENDING,
      creditAppliedCny: 0,
    });
    if (nextAmount > received) unpaidFixedTotal += nextAmount - received;
  }

  if (tail && !isPaid(tail)) {
    const rawOutstanding = remainingContractCny - attributableReceived - unpaidFixedTotal;
    const outstanding = Math.max(0, rawOutstanding);
    const received = activeReceivedCny(tail);
    const nextAmount = received + outstanding;
    if (recordSurplus && rawOutstanding < 0) surplusCny += -rawOutstanding;
    updates.push({
      seq: tail.seq,
      amountCny: nextAmount,
      seatsBasis: remainingSeats,
      status: outstanding === 0 ? HoldInstallmentStatus.PAID : HoldInstallmentStatus.PENDING,
      creditAppliedCny: 0,
    });
  } else if (tail && recordSurplus) {
    surplusCny += Math.max(0, attributableReceived - remainingContractCny);
  }

  return { updates: updates.sort((a, b) => a.seq - b.seq), surplusCny };
}
