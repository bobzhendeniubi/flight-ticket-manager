/**
 * 订单未冲销佣金净额口径。
 *
 * ACCRUED 佣金在订单全额冲销时采用原地翻牌：只把 status 改为 REVERSED，
 * 不改正数 amount，也不另建负数补偿行。因而正数 REVERSED 行是已冲销后的
 * 死行，必须剔除；负数 REVERSED 行则是 SETTLED/部分冲销产生的补偿，必须保留
 * 在所属代理的净额中。净额必须按代理分别计算，避免一个代理的孤立负数残行
 * 抵消另一个代理仍存活的正数佣金。否则取消代理单后，撤销收款/认款会被过期的
 * 正数佣金永久拦住，或被跨代理错误放行。
 */
import { CommissionStatus, Prisma } from '@prisma/client';

/** 金额保留 2 位小数（CNY，避免浮点累计误差）。 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 查询事务内订单尚未冲销的佣金净额。
 *
 * 正数 REVERSED 行代表 ACCRUED 原地翻牌后的死行；负数 REVERSED 行代表
 * SETTLED 或部分冲销的补偿，不能从所属代理的净额中删掉。不同代理的分组
 * 净额不可互相抵消；任一代理净额大于阈值，就代表佣金仍未冲销。
 */
export async function outstandingCommissionNetWithinTx(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<number> {
  const commissionGroups = await tx.commissionRecord.groupBy({
    by: ['agentId'],
    where: {
      orderId,
      OR: [
        { status: { not: CommissionStatus.REVERSED } },
        { amount: { lt: 0 } },
      ],
    },
    _sum: { amount: true },
  });

  const positiveGroupNet = commissionGroups.reduce((total, group) => {
    const groupNet = Number(group._sum.amount ?? 0);
    return groupNet > 0 ? total + groupNet : total;
  }, 0);

  return round2(positiveGroupNet);
}
