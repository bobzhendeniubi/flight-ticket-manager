import { HoldInstallmentStatus, HoldOrderStatus } from '@prisma/client';

/** 占位单状态中文名的唯一来源。放在叶子模块，导出/服务/路由都从这里取，避免循环依赖。 */
export const HOLD_STATUS_LABEL: Record<HoldOrderStatus, string> = {
  [HoldOrderStatus.PENDING]: '待生效',
  [HoldOrderStatus.HOLDING]: '占座中',
  [HoldOrderStatus.OVERDUE]: '逾期占座',
  [HoldOrderStatus.FULLY_PAID]: '已全款',
  [HoldOrderStatus.CONVERTED]: '已转正',
  [HoldOrderStatus.RELEASED]: '已释放',
  [HoldOrderStatus.CANCELLED]: '已取消',
};

export interface DeriveHoldInstallment {
  amountCny: number;
  status?: HoldInstallmentStatus;
  dueDate: Date;
  allocatedCny?: number;
}

export interface DeriveHoldInput {
  status: HoldOrderStatus;
}

/**
 * 占座中的派生状态唯一入口。期状态以未撤销认款合计为准，status 只作为兼容旧数据的兜底。
 * todayByTz 已由调用方按班次 departureTz 计算，避免不同班次跨时区时混用服务器日期。
 */
export function deriveHoldStatus(
  _hold: DeriveHoldInput,
  installments: ReadonlyArray<DeriveHoldInstallment>,
  todayByTz: string,
): HoldOrderStatus {
  const isPaid = (item: DeriveHoldInstallment) =>
    item.amountCny === 0 || (item.allocatedCny ?? (item.status === HoldInstallmentStatus.PAID ? item.amountCny : 0)) >= item.amountCny;
  if (installments.length > 0 && installments.every(isPaid)) return HoldOrderStatus.FULLY_PAID;
  if (installments.some((item) => !isPaid(item) && item.dueDate.toISOString().slice(0, 10) < todayByTz)) {
    return HoldOrderStatus.OVERDUE;
  }
  return HoldOrderStatus.HOLDING;
}
