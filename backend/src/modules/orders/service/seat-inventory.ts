// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import { CabinClass, Prisma, SeatLockStatus } from '@prisma/client';
import { BadRequestError, ConflictError } from '../../../lib/errors.js';
import { localHHMM, localDateISO } from '../../../lib/flight-time.js';
import { heldSeatsForCabin } from '../../hold-orders/held-seats.js';
import { CABIN_ZH_LABEL } from './shared.js';

/**
 * 恢复回程时逐舱位的超售三值（快照 returnRestored.seatDetail[] 与审计 after 直接落这个形状）。
 * 写成 type 而非 interface：它要作为 metadata 快照的一部分赋给 Prisma.InputJsonValue，
 * 只有类型别名才拿得到隐式索引签名（口径同 ReleasedSeatEntry）。
 */
export type OversellSeatDetail = {
  cabin: CabinClass;
  /** 本次要占回该舱几座。 */
  quantity: number;
  /** 占座**前**该舱超售几座（= sold − capacity，负数表示还有物理空位；锁位/占位不算超售）。 */
  before: number;
  /** 占座**后**该舱超售几座。 */
  after: number;
  /** 本次**新增**的超售座数 = max(0, after) − max(0, before)，恒 ≥ 0。 */
  increment: number;
};

/**
 * 恢复回程的超售口径（预检与执行共用同一份算法，两边不再各算各的）。
 *
 * ── 「超售」的唯一口径 = 纯 `sold vs capacity` ────────────────────────────────
 *   before    = sold − capacity      占座**前**这一舱真的多卖了几座（负数 = 还有物理空位）
 *   after     = before + quantity    占座**后**多卖几座
 *   increment = max(0,after) − max(0,before)   本次**新增**几座超售，恒 ≥ 0
 *
 * ⚠ 这里**不减锁位、不减占位单余座**。那两样是「暂时不让别人卖」的软占用，不是已经卖出去的
 * 座位：航司那边的实际卖出数只有 sold。旧写法用 available（= capacity − sold − 锁位 − 占位）
 * 反推 before，于是一班明明还有 20 个物理空位、只是被锁位/占位单占满时，恢复 2 座会被报成
 *「超售 2 座、班次累计超 2 座」，还可能直接顶到 FLIGHT_NOSHOW_MAX_OVERSELL_SEATS 上限被拒 ——
 * 而这一班一座都没超卖。审计与房控看到的「超售座数」也跟着虚高，风控判断失真。
 * 锁位/占位只参与另一件事：**这次是走 CAS 正常占座还是走超售直加**（那里仍用 available，
 * 见 restoreReturnLeg 的占座循环）—— 别人锁着的位子确实不能当成有座直接抢。
 *
 * ⚠ 增量与累计是两个数，混用过一次就再也看不出班次被卖到了什么程度：
 *   · `oversellBy`   = Σ increment —— **本次新增**几座超售，前端二次确认与「本次 +k」用它；
 *   · `oversoldAfter`= Σ max(0, after) —— 恢复**之后**该班这些舱一共超出几座，风控与上限判定用它。
 *
 * 多舱位（升舱拆座）一律**求和**而不是取最大值：经济舱超 2 + 商务舱超 1 就是这一班超了 3 座。
 */
export function computeOversellDelta(
  needs: ReadonlyArray<{ cabin: CabinClass; quantity: number; capacity: number; sold: number }>,
): { detail: OversellSeatDetail[]; oversellBy: number; oversoldAfter: number } {
  const detail: OversellSeatDetail[] = needs.map((need) => {
    const before = need.sold - need.capacity;
    const after = before + need.quantity;
    return {
      cabin: need.cabin,
      quantity: need.quantity,
      before,
      after,
      increment: Math.max(0, after) - Math.max(0, before),
    };
  });
  return {
    detail,
    oversellBy: detail.reduce((n, d) => n + d.increment, 0),
    oversoldAfter: detail.reduce((n, d) => n + Math.max(0, d.after), 0),
  };
}

/**
 * 逐舱「本次会挤掉多少别人的软预留」。
 *
 * 缺口 = quantity − max(0, available)：available 已经把他人锁位与占位余座扣掉了，夹 0 是因为
 * available 为负（班次已超售）时物理空位本来就是 0，负数再往上加会把缺口算大。
 * 缺口里能由软预留兜住的那部分就是被挤掉的预留，上限自然是该舱现有的 reserved；
 * 剩下的部分才是真·物理超售（口径见 computeOversellDelta 的 increment，与本函数各算各的）。
 *
 * 为什么要单独算：sold 没超 capacity 时超售口径是 0，但座位确确实实是从别人锁着的位子里抢来的 ——
 * 只看超售数就会得出「这次恢复零风险」，而对面那张锁位单下一秒下单就会失败，且审计里查不到原因。
 */
export function computeDisplacedReserved(
  need: { quantity: number; available: number; reserved: number },
): number {
  const shortfall = Math.max(0, need.quantity - Math.max(0, need.available));
  return Math.max(0, Math.min(shortfall, need.reserved));
}

/** 恢复回程时逐舱的「挤占软预留」明细（快照与审计 after 直接落这个形状）。 */
export type DisplacedReservationDetail = {
  cabin: CabinClass;
  /** 本次要占回该舱几座。 */
  quantity: number;
  /** 其中挤掉了几座别人的软预留（他人 ACTIVE 锁位 + 占位单余座）。 */
  displacedReserved: number;
  /** 其中有几座是真·物理超售（= computeOversellDelta 的 increment）。 */
  physicalIncrement: number;
};

/**
 * 某班次某舱位的座位现状；该舱位没有配置时返回 null（调用方据此给 blocker）。
 *
 * 三个数各有各的用处，**不能互相替代**：
 *   · capacity / sold —— 「超售了几座」的唯一口径（见 computeOversellDelta）。锁位与占位单
 *     是软占用，不是卖出去的座位，绝不参与超售计算。
 *   · available —— 「现在还能不能直接卖一座」。口径与 takeSeatWithinTx 的 CAS 条件逐项对齐：
 *     capacity − sold − 他人 ACTIVE 锁位 − 占位余座。**不夹 0**，已超售的班次如实返回负数，
 *     否则前端会以为还有位。恢复回程据它决定走 CAS 占座还是走超售直加。
 *   · reserved —— 软预留（他人 ACTIVE 锁位 + 占位单余座）。这批座位**没卖出去**，所以不进
 *     超售口径；但硬占它就是把别人锁着的位子抢走，必须单独算出来、单独留痕（见恢复回程的
 *     RESTORE_RETURN_LEG_DISPLACED_RESERVATION 审计）。
 */
export async function cabinSeatStateWithinTx(
  db: Prisma.TransactionClient,
  scheduleId: string,
  cabin: CabinClass,
): Promise<{ capacity: number; sold: number; available: number; reserved: number } | null> {
  const sc = await db.flightSeatClass.findFirst({
    where: { scheduleId, cabin },
    select: { capacity: true, sold: true },
  });
  if (!sc) return null;
  const lockedAgg = await db.seatLock.aggregate({
    _sum: { qty: true },
    where: {
      seatClass: { scheduleId, cabin },
      status: SeatLockStatus.ACTIVE,
      expiresAt: { gt: new Date() },
    },
  });
  const held = await heldSeatsForCabin(db, scheduleId, cabin);
  const reserved = (lockedAgg._sum.qty ?? 0) + held;
  return {
    capacity: sc.capacity,
    sold: sc.sold,
    available: sc.capacity - sc.sold - reserved,
    reserved,
  };
}

/**
 * 给某班某舱的 FlightSeatClass 行上 FOR UPDATE 行锁（幂等，同事务内重复上锁无副作用）。
 *
 * 「锁后重算」是超售上限唯一站得住的实现方式：拿锁之前读到的余位随时可能被并发下单吃掉，
 * 上限判定必须发生在锁内、基于锁后重读的 capacity/sold/locked/held。
 * 单测的 tx mock 不带 $queryRaw，故做存在性判断后再调（缺省视为无需上锁）。
 */
export async function lockSeatClassWithinTx(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  cabin: CabinClass,
): Promise<void> {
  if (typeof tx.$queryRaw !== 'function') return;
  await tx.$queryRaw`
    SELECT id FROM "FlightSeatClass"
    WHERE "scheduleId" = ${scheduleId} AND cabin = ${cabin}::"CabinClass"
    FOR UPDATE
  `;
}

/**
 * 超售式占座：先 FOR UPDATE 拿行锁，再无条件 `sold += qty`（**不带余位条件**）。
 *
 * 只在「no-show 释放过的回程要恢复、原班次已卖光、运营显式确认超售」这一条路径上使用。
 * 与 takeSeatWithinTx 的区别就是没有 CAS 条件 —— 所以调用方必须已经：
 *   1) 校验过缺口 ≤ FLIGHT_NOSHOW_MAX_OVERSELL_SEATS；
 *   2) 拿到运营的 allowOversell 确认；
 *   3) 准备好记 CRITICAL 审计。
 * 三条缺一不可，别把它当成普通占座入口复用。
 */
export async function oversellSeatWithinTx(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  cabin: CabinClass,
  qty: number,
): Promise<void> {
  if (qty <= 0) return;
  await lockSeatClassWithinTx(tx, scheduleId, cabin);
  const affected = await tx.$executeRaw`
    UPDATE "FlightSeatClass"
    SET sold = sold + ${qty}, "updatedAt" = NOW()
    WHERE "scheduleId" = ${scheduleId} AND cabin = ${cabin}::"CabinClass"
  `;
  if (affected !== 1) {
    throw new ConflictError(`原班次的 ${cabin} 舱位不存在，无法恢复回程座位。`);
  }
}

// ── 售后改单：座位搬移 + 费用流水（事务内复用 createOrder/状态机的同款口径）──

/**
 * 事务内原子「拿座」（CAS，最终防超售）—— 与 createOrder 的 decrementSeat 同款保证。
 *   UPDATE ... SET sold = sold + qty
 *   WHERE sold + qty + 他人ACTIVE锁位 + 占位余座 ≤ capacity
 * affected ≠ 1（售罄/并发抢占/无此舱位）→ 抛 ConflictError，调用方的事务随之回滚。
 *
 * @param excludeUserId 排除其本人锁位不挡自己（下单场景用）；改期由运营操作 → 传 null（所有他人锁位都占余票）。
 */
export async function takeSeatWithinTx(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  cabin: import('@prisma/client').CabinClass,
  qty: number,
  excludeUserId: string | null,
): Promise<void> {
  if (qty <= 0) return;
  if (typeof tx.$queryRaw === 'function') {
    await tx.$queryRaw`
      SELECT id FROM "FlightSeatClass"
      WHERE "scheduleId" = ${scheduleId} AND cabin = ${cabin}::"CabinClass"
      FOR UPDATE
    `;
  }
  const lockedAgg = await tx.seatLock.aggregate({
    _sum: { qty: true },
    where: {
      seatClass: { scheduleId, cabin },
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
      status: SeatLockStatus.ACTIVE,
      expiresAt: { gt: new Date() },
    },
  });
  const lockedByOthers = lockedAgg._sum.qty ?? 0;
  const heldQty = await heldSeatsForCabin(tx, scheduleId, cabin);
  const affected = await tx.$executeRaw`
    UPDATE "FlightSeatClass"
    SET sold = sold + ${qty}, "updatedAt" = NOW()
    WHERE "scheduleId" = ${scheduleId}
      AND cabin = ${cabin}::"CabinClass"
      AND sold + ${qty} + ${lockedByOthers} + ${heldQty} <= capacity
  `;
  if (affected !== 1) {
    const sc = await tx.flightSeatClass.findFirst({
      where: { scheduleId, cabin },
      select: { capacity: true, sold: true },
    });
    const available = sc
      ? Math.max(0, sc.capacity - sc.sold - lockedByOthers - heldQty)
      : 0;
    throw new ConflictError(
      `${cabin} 余票不足：需要 ${qty} 张，仅剩 ${available} 张（改期目标班次售罄/并发抢占）`,
    );
  }
}

/**
 * 该航段行「已经飞了」吗（座位账口径的唯一判定）。
 *
 * 状态机 `_updateStatusWithinTx` 的**放座分支与重新占座分支共用本函数**，两处必须严格对称：
 *   · 放座侧：飞过的座位已被真实消耗，还回 sold 等于让过去的班次凭空多出可卖余位；
 *   · 占座侧：既然当初没放，就绝不能再占回来 —— 占了就是给飞过去的班次凭空加一份 sold，
 *     此后没有任何路径会释放它（再落取消族仍被这道闸跳过），永久卡账。
 * 只有一边加判定 = 释放与占座不守恒，正是「no-show → 取消 → force 拉回」这条最常见路径。
 *
 * departureTime 存的是真 UTC 瞬间（departureTz 只用于展示折算），故直接与传入时刻比较。
 * 没有班次时间（未联查 / 座位已释放的行）一律按「没飞」处理，交给各自分支的其它闸判断。
 */
export function isLegAlreadyFlown(
  item: { flightSchedule?: { departureTime: Date | null } | null },
  atMs: number,
): boolean {
  const departAt = item.flightSchedule?.departureTime ?? null;
  return departAt != null && departAt.getTime() <= atMs;
}

/**
 * 「该段已起飞 → 不能改期」的统一判定与文案。
 *
 * 改期要「放旧座」，飞过的座位早被真实消耗掉：放回去等于让过去的班次凭空多出可卖余位，
 * 同时又在新班次占一份，两头都是错账。判定口径走共享 helper isLegAlreadyFlown，
 * 时区折算走 lib/flight-time.ts（与全站展示同一口径）。
 *
 * 两处调用必须是同一份闸：
 *   · rescheduleOrderItem（PATCH /orders/:id/reschedule 与航段入口的执行段）；
 *   · reschedulePassengers 拆单前的前置闸 —— 拆单不可回滚，晚一步就会留下一张多余新单，
 *     而且新单同一航段照样已起飞，「到新单重试」永远走不通。
 */
export function assertLegNotFlownForReschedule(item: {
  flightSchedule?: { departureTime: Date | null; departureTz?: string | null } | null;
}): void {
  if (!isLegAlreadyFlown(item, Date.now())) return;
  const sched = item.flightSchedule;
  const departAt = sched?.departureTime ?? null;
  const localWhen =
    departAt != null
      ? `${localDateISO(departAt, sched?.departureTz)} ${localHHMM(departAt, sched?.departureTz)}`
      : '时间未知';
  throw new BadRequestError(
    `该段已起飞（当地时间 ${localWhen} 出发），不能改期；` +
      '客人没登机请走「标记 no-show」处理。',
  );
}

/**
 * 释放座位——下限钳制在 0（HIGH 修复第二层防线）。
 *
 * `sold = GREATEST(0, sold - qty)`（原子 SQL）取代普通 `decrement`：即便 businessUpgradeCount
 * 被伪造导致某个分支想释放一个从未真正占用过的舱位（见 sanitizeFlightItemMetadata 的注释——那是
 * 第一层防线，从源头不让伪造值落库），这里也不会把 sold 打成负数并永久卡住（旧版 decrement 没有
 * 下限，负数会一直累积，直到人工去 DB 手动修）。
 *
 * 供状态机释放分支（_updateStatusWithinTx）和 30 分钟超时 worker（queues/worker.ts）复用——两处
 * 都要按 computeBundleSeatSplit 拆分释放，口径必须一致。
 */
export async function releaseSeatFloored(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  cabin: import('@prisma/client').CabinClass,
  qty: number,
): Promise<void> {
  if (qty <= 0) return;
  await tx.$executeRaw`
    UPDATE "FlightSeatClass"
    SET sold = GREATEST(0, sold - ${qty}), "updatedAt" = NOW()
    WHERE "scheduleId" = ${scheduleId}
      AND cabin = ${cabin}::"CabinClass"
  `;
}

/**
 * 释放座位 —— **严格版**：放几座就必须真有几座可放，否则整单回滚。
 *
 * 与 releaseSeatFloored（`GREATEST(0, sold − qty)`）的分工：
 *   · 取消航段 / 状态机释放 / 超时 worker 走 floored 版 —— 那些路径是「尽力把座位还回去」，
 *     账面对不上时宁可少还也不能把 sold 打成负数卡死，是 best-effort 语义。
 *   · no-show 释放走**本函数** —— 它的下游是「照释放快照原样占回来」的恢复回程：
 *     释放时 floored 少放了 k 座（sold 本来就不够），快照里却照样记着「放了 N 座」，
 *     恢复时就会按 N 座占回去，凭空把 sold 抬高 k —— 座位账从此永久对不上，且没有任何报错。
 *     所以这里 fail-closed：`sold >= qty` 命中才更新，没命中就抛错让整个事务回滚，
 *     快照与实际释放量因此恒等。
 *
 * 舱位行不存在同样抛（affected === 0）：既然要按快照占回来，行都没了就不该假装释放成功。
 */
export async function releaseSeatStrictWithinTx(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  cabin: import('@prisma/client').CabinClass,
  qty: number,
): Promise<void> {
  if (qty <= 0) return;
  // 与 oversellSeatWithinTx / 恢复回程同一把行锁：并发下 sold 的读改写严格串行。
  await lockSeatClassWithinTx(tx, scheduleId, cabin);
  const affected = await tx.$executeRaw`
    UPDATE "FlightSeatClass"
    SET sold = sold - ${qty}, "updatedAt" = NOW()
    WHERE "scheduleId" = ${scheduleId}
      AND cabin = ${cabin}::"CabinClass"
      AND sold >= ${qty}
  `;
  if (affected !== 1) {
    throw new ConflictError(
      `库存账对不上：该舱（${CABIN_ZH_LABEL[cabin] ?? cabin}）sold 少于要释放的 ${qty} 座，` +
        '或该舱位配置已不存在，已回滚，本次一座未放。请先核对该班次库存。',
    );
  }
}

/**
 * 套餐升舱「拆座」模型（纯函数，扣座/退座共用，最终防超售）。
 *
 * 一个航段（FLIGHT 行）下单 `quantity` 人，其中 `businessUpgradeCount` 人选了升舱商务：
 *   - 升舱的人占用真实商务舱座位：BUSINESS += min(businessUpgradeCount, quantity)
 *   - 其余的人留在本行原舱位：原舱 += quantity − 上述商务数
 * 净占座仍 = quantity（不超售商务舱、不持有幽灵经济舱座位）。
 * 只有经济舱航段（cabin === 'ECONOMY'）才会被拆；其他舱位 businessUpgradeCount 视为 0。
 * businessUpgradeCount 缺省/0 → economy=quantity、business=0，与旧版行为完全一致（向后兼容）。
 *
 * 导出仅供单测使用。
 */
export function computeBundleSeatSplit(
  cabin: import('@prisma/client').CabinClass,
  quantity: number,
  businessUpgradeCount: number | undefined,
): { sameCabin: number; business: number } {
  const upgrade =
    cabin === 'ECONOMY'
      ? Math.min(Math.max(0, Math.trunc(businessUpgradeCount ?? 0)), quantity)
      : 0;
  return { sameCabin: quantity - upgrade, business: upgrade };
}
