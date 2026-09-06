/**
 * 按人份额 —— **唯一写点**（审查根因 R1）。
 *
 * persistPassengerShares(tx, orderId)：在调用方的事务里（调用方已对 Order 行 FOR UPDATE）
 *   读订单 + 乘客 + 行 → 调既有 perPax* 算法（passenger-shares.computePassengerShareRows，算法不在这里）
 *   → 守恒断言（Σ 每人结算价 + 不摊条目 = 应收，逐分；不平抛错 → 调用方整事务回滚）
 *   → 删掉已不在单上的乘客的旧行 → 每位在单乘客 upsert 一行。
 * 挂在每条会改钱或改人的写路径末尾：内核路径（runOrderMutation persistShares: true）由内核统一挂；
 * 其余路径在各自 $transaction 的 return 之前调一次。幂等：同一状态重复调只会覆盖成同样的值。
 *
 * lazyPersistPassengerShares(orderId)：读侧顺手回填（老单 / 尚未回填）。自己开一个短事务，
 *   对 Order 行 FOR UPDATE **NOWAIT** —— 拿不到锁（正有写路径在改这张单）就放弃，绝不排队卡住读；
 *   任何错误都吞掉只记日志，**失败不影响读**（读侧本次仍用派生值）。
 *
 * backfillPassengerShares({ limit })：一次性回填（脚本 / ADMIN 端点共用）。分批、幂等：
 *   只挑「有乘客缺当前版本份额行」的活单（deletedAt 为空），逐单走 lazyPersistPassengerShares。
 *
 * ⚠️ 单测里的 mock 事务客户端没有 orderPassengerShare 委托：此时直接返回 null（视为本事务不落份额），
 *   不去碰任何别的 mock 方法（否则会吃掉业务代码排好队的 mockResolvedValueOnce）。真 Prisma 客户端恒有委托，
 *   生产路径不可能走到这一支；落库行为由 passenger-shares.integration.test.ts 在真库上钉死。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../../db/prisma.js';
import {
  PASSENGER_SHARE_ALGO_VERSION,
  PASSENGER_SHARES_INCLUDE,
  assertSharesReconcile,
  computePassengerShareRows,
  pickPersistedShares,
  type PassengerShareComputation,
  type PersistedShareLike,
} from '../passenger-shares.js';

export { PASSENGER_SHARES_INCLUDE };

/** 写点读订单的 select：恰好覆盖 ShareSourceOrder 需要的字段，不多不少。 */
export const SHARE_SOURCE_SELECT = {
  id: true,
  orderNumber: true,
  total: true,
  adjustmentCny: true,
  adjustments: true,
  passengers: { select: { id: true, visaExempt: true, singleRoom: true } },
  items: {
    select: {
      id: true,
      kind: true,
      amount: true,
      description: true,
      passengerId: true,
      metadata: true,
      bundle: { select: { items: true } },
    },
  },
} satisfies Prisma.OrderSelect;

export interface PersistSharesResult extends PassengerShareComputation {
  orderId: string;
  orderNumber: string;
  /** 被清掉的旧行数（乘客已拆走 / 不在单上） */
  removed: number;
}

type ShareDelegate = Prisma.TransactionClient['orderPassengerShare'];

/** mock 事务客户端没有本委托 → null（见文件头注释）。 */
function shareDelegateOf(tx: Prisma.TransactionClient): ShareDelegate | null {
  const delegate = (tx as Partial<Prisma.TransactionClient>).orderPassengerShare;
  return delegate && typeof delegate.upsert === 'function' ? delegate : null;
}

const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);

/**
 * 唯一写点。订单不存在（已被删 / mock 读不到）→ null，不抛：写路径末尾挂它不该改变动作本身的语义。
 * 守恒断言失败会抛 —— 那是本模块或算法的 bug，宁可让整笔写回滚也不留一套对不上账的份额。
 */
export async function persistPassengerShares(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<PersistSharesResult | null> {
  const delegate = shareDelegateOf(tx);
  if (!delegate) return null;

  const order = await tx.order.findUnique({ where: { id: orderId }, select: SHARE_SOURCE_SELECT });
  if (!order) return null;

  const comp = computePassengerShareRows(order);
  assertSharesReconcile(comp, `${order.orderNumber} 按人份额`);

  const currentIds = comp.rows.map((r) => r.passengerId);
  const { count: removed } = await delegate.deleteMany({
    where: { orderId, ...(currentIds.length > 0 ? { passengerId: { notIn: currentIds } } : {}) },
  });
  const computedAt = new Date();
  for (const r of comp.rows) {
    const values = {
      settlementCny: dec(r.settlementCny),
      baseCny: dec(r.baseCny),
      adjustmentCny: dec(r.adjustmentCny),
      visaCny: dec(r.visaCny),
      singleRoomDiffCny: dec(r.singleRoomDiffCny),
      discountCny: dec(r.discountCny),
      algoVersion: PASSENGER_SHARE_ALGO_VERSION,
      computedAt,
    };
    await delegate.upsert({
      where: { orderId_passengerId: { orderId, passengerId: r.passengerId } },
      create: { orderId, passengerId: r.passengerId, ...values },
      update: values,
    });
  }
  return { ...comp, orderId, orderNumber: order.orderNumber, removed };
}

export type LazyPersistOutcome = 'PERSISTED' | 'LOCKED' | 'MISSING' | 'FAILED';

/** Postgres 55P03 = lock_not_available（FOR UPDATE NOWAIT 撞上别人的锁）。 */
function isLockNotAvailable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    return meta?.code === '55P03';
  }
  return err instanceof Error && /lock_not_available|could not obtain lock|55P03/i.test(err.message);
}

/**
 * 读侧顺手回填：短事务 + NOWAIT 行锁；拿不到锁就让路，任何错误都不上抛。
 * 调用方本次读仍用派生值（DERIVED），下一次读就能读到库里的。
 */
export async function lazyPersistPassengerShares(
  orderId: string,
  client: PrismaClient = defaultPrisma,
): Promise<LazyPersistOutcome> {
  try {
    return await client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE NOWAIT
      `;
      if (rows.length === 0) return 'MISSING' as const;
      const res = await persistPassengerShares(tx, orderId);
      return res ? ('PERSISTED' as const) : ('MISSING' as const);
    });
  } catch (err) {
    if (isLockNotAvailable(err)) return 'LOCKED';
    // eslint-disable-next-line no-console
    console.warn('[passenger-shares] lazy backfill failed for', orderId, err instanceof Error ? err.message : err);
    return 'FAILED';
  }
}

/** 一次读最多顺手回填多少张单（导出几百张老单时不让第一次导出拖成几十秒；其余交回填脚本）。 */
export const LAZY_BACKFILL_MAX_PER_READ = 100;

/** 多张单的顺手回填（导出 / 对账单）：顺序逐单，上限之外的留给下次或回填脚本。 */
export async function lazyPersistPassengerSharesForOrders(
  orderIds: readonly string[],
  opts: { max?: number; client?: PrismaClient } = {},
): Promise<Record<LazyPersistOutcome, number>> {
  const max = opts.max ?? LAZY_BACKFILL_MAX_PER_READ;
  const tally: Record<LazyPersistOutcome, number> = { PERSISTED: 0, LOCKED: 0, MISSING: 0, FAILED: 0 };
  for (const id of [...new Set(orderIds)].slice(0, max)) {
    tally[await lazyPersistPassengerShares(id, opts.client)] += 1;
  }
  return tally;
}

export interface BackfillPassengerSharesResult {
  /** 本批扫到的候选单数（≤ limit） */
  scanned: number;
  persisted: number;
  /** 撞锁（正在被改的单，下次重跑） */
  locked: number;
  /** 订单已不存在 / 守恒断言失败等（看日志，下次重跑仍会挑出来） */
  failed: number;
  /** 本批之后仍缺份额的活单数（0 = 回填完成） */
  remaining: number;
}

/** 缺当前版本份额行的活单（有乘客却没有对应行），按建单时间升序取前 limit 张。 */
export async function findOrdersMissingShares(limit: number, client: PrismaClient = defaultPrisma): Promise<string[]> {
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT o.id
    FROM "Order" o
    WHERE o."deletedAt" IS NULL
      AND EXISTS (
        SELECT 1 FROM "Passenger" p
        LEFT JOIN "OrderPassengerShare" s
          ON s."orderId" = o.id AND s."passengerId" = p.id AND s."algoVersion" = ${PASSENGER_SHARE_ALGO_VERSION}
        WHERE p."orderId" = o.id AND s.id IS NULL
      )
    ORDER BY o."createdAt" ASC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

export async function countOrdersMissingShares(client: PrismaClient = defaultPrisma): Promise<number> {
  const rows = await client.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM "Order" o
    WHERE o."deletedAt" IS NULL
      AND EXISTS (
        SELECT 1 FROM "Passenger" p
        LEFT JOIN "OrderPassengerShare" s
          ON s."orderId" = o.id AND s."passengerId" = p.id AND s."algoVersion" = ${PASSENGER_SHARE_ALGO_VERSION}
        WHERE p."orderId" = o.id AND s.id IS NULL
      )
  `;
  return Number(rows[0]?.n ?? 0);
}

/**
 * 分批回填（幂等、可重跑）。每张单一个独立短事务（NOWAIT）：一张坏单 / 撞锁不影响其它单，
 * 失败的下次重跑再挑出来。
 */
export async function backfillPassengerShares(
  opts: { limit?: number; client?: PrismaClient; onProgress?: (done: number, total: number) => void } = {},
): Promise<BackfillPassengerSharesResult> {
  const client = opts.client ?? defaultPrisma;
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
  const ids = await findOrdersMissingShares(limit, client);
  let persisted = 0;
  let locked = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i++) {
    const outcome = await lazyPersistPassengerShares(ids[i], client);
    if (outcome === 'PERSISTED') persisted += 1;
    else if (outcome === 'LOCKED') locked += 1;
    else failed += 1;
    opts.onProgress?.(i + 1, ids.length);
  }
  const remaining = await countOrdersMissingShares(client);
  return { scanned: ids.length, persisted, locked, failed, remaining };
}

/**
 * 读侧「先读库，没有就派生并顺手落库」的落库半边：对一批已读出的订单，挑出库里没有完整份额的，
 * 顺手回填（NOWAIT，失败不影响读），再把刚落好的行读回来贴到订单对象上（新对象，不改入参）。
 * 调用方随后用 resolvePassengerShares 就会读到 PERSISTED；回填失败 / 撞锁的单照旧 DERIVED。
 * mock 客户端（单测）没有事务 / 委托 → 原样返回。
 */
export async function attachPersistedShares<
  T extends {
    id: string;
    passengers: ReadonlyArray<{ id: string }>;
    passengerShares?: ReadonlyArray<PersistedShareLike> | null;
  },
>(orders: T[], client: PrismaClient = defaultPrisma, opts: { max?: number } = {}): Promise<T[]> {
  const missing = orders.filter((o) => o.passengers.length > 0 && !pickPersistedShares(o)).map((o) => o.id);
  if (missing.length === 0) return orders;
  const shareClient = client as Partial<PrismaClient>;
  if (typeof shareClient.$transaction !== 'function' || typeof shareClient.orderPassengerShare?.findMany !== 'function') {
    return orders;
  }
  try {
    const tally = await lazyPersistPassengerSharesForOrders(missing, { client, max: opts.max });
    if (tally.PERSISTED === 0) return orders;
    const fresh = await client.orderPassengerShare.findMany({
      where: { orderId: { in: missing } },
      select: { orderId: true, ...PASSENGER_SHARES_INCLUDE.select },
    });
    const byOrder = new Map<string, PersistedShareLike[]>();
    for (const row of fresh) {
      const list = byOrder.get(row.orderId) ?? [];
      list.push(row);
      byOrder.set(row.orderId, list);
    }
    return orders.map((o) => (byOrder.has(o.id) ? { ...o, passengerShares: byOrder.get(o.id) } : o));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[passenger-shares] attach failed', err instanceof Error ? err.message : err);
    return orders;
  }
}
