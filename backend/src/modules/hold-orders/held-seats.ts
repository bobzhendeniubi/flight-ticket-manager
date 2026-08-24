/**
 * 占位单库存聚合 — 占位单是「无名单库存实体」，只在 HOLDING / OVERDUE / FULLY_PAID
 * 状态占座。所有可售余量读点都通过本文件读取占位余座，统一口径为：
 *   Σ(seats − seatsConverted − seatsCancelled)
 *
 * db 同时接受全局 PrismaClient 与事务 Prisma.TransactionClient，保证建单、锁位、订单
 * CAS 能在同一事务连接内看到一致的占位库存。
 */
import { CabinClass, HoldOrderStatus } from '@prisma/client';
import type { Prisma, PrismaClient } from '@prisma/client';

export const SEAT_HOLDING_STATUSES: HoldOrderStatus[] = [
  HoldOrderStatus.HOLDING,
  HoldOrderStatus.OVERDUE,
  HoldOrderStatus.FULLY_PAID,
];

export type HoldSeatsDbClient = PrismaClient | Prisma.TransactionClient;

type HoldOrderDelegate = {
  aggregate: (args: unknown) => Promise<{ _sum: { seats: number | null; seatsConverted: number | null; seatsCancelled: number | null } }>;
  groupBy: (args: unknown) => Promise<Array<{ seatClassId: string; _sum: { seats: number | null; seatsConverted: number | null; seatsCancelled: number | null } }>>;
};

function holdOrderDelegate(db: HoldSeatsDbClient): HoldOrderDelegate | undefined {
  // 部分单元测试会传入只覆盖目标 delegate 的轻量事务桩；真实 PrismaClient/TransactionClient
  // 始终具备 holdOrder。缺失时按没有占位处理，避免非库存测试因 mock 形状被迫扩大。
  return (db as HoldSeatsDbClient & { holdOrder?: HoldOrderDelegate }).holdOrder;
}

function heldFromSums(sums: {
  seats: number | null;
  seatsConverted: number | null;
  seatsCancelled: number | null;
}): number {
  return (sums.seats ?? 0) - (sums.seatsConverted ?? 0) - (sums.seatsCancelled ?? 0);
}

export async function heldSeatsForSeatClass(
  db: HoldSeatsDbClient,
  seatClassId: string,
): Promise<number> {
  const delegate = holdOrderDelegate(db);
  if (!delegate) return 0;
  const sums = await delegate.aggregate({
    _sum: { seats: true, seatsConverted: true, seatsCancelled: true },
    where: { seatClassId, status: { in: SEAT_HOLDING_STATUSES } },
  });
  return heldFromSums(sums._sum);
}

export async function heldSeatsBySeatClass(
  db: HoldSeatsDbClient,
  seatClassIds: string[],
): Promise<Map<string, number>> {
  if (seatClassIds.length === 0) return new Map();

  const delegate = holdOrderDelegate(db);
  if (!delegate) return new Map();
  const rows = await delegate.groupBy({
    by: ['seatClassId'],
    where: { seatClassId: { in: seatClassIds }, status: { in: SEAT_HOLDING_STATUSES } },
    _sum: { seats: true, seatsConverted: true, seatsCancelled: true },
  });

  return new Map(
    (rows ?? []).map((row) => [
      row.seatClassId,
      heldFromSums(row._sum),
    ]),
  );
}

export async function heldSeatsForCabin(
  db: HoldSeatsDbClient,
  scheduleId: string,
  cabin: CabinClass,
): Promise<number> {
  const delegate = holdOrderDelegate(db);
  if (!delegate) return 0;
  const sums = await delegate.aggregate({
    _sum: { seats: true, seatsConverted: true, seatsCancelled: true },
    where: {
      seatClass: { scheduleId, cabin },
      status: { in: SEAT_HOLDING_STATUSES },
    },
  });
  return heldFromSums(sums._sum);
}
