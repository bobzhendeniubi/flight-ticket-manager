// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import {
  AuditSeverity,
  AuditTargetType,
  CabinClass,
  OrderItemKind,
  OrderStatus,
  Prisma,
  SeatLockStatus,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../lib/errors.js';
import { writeAudit } from '../../../lib/audit.js';
import { localHHMM, localDateISO } from '../../../lib/flight-time.js';
import { assertOrderAcceptsFunds } from '../../../lib/funds-guard.js';
import { getHotelOversellCapRooms } from '../../hotel-control/hotel-control.service.js';
import { determineFlightLegItems } from '../ticketing-cap.js';
import { heldSeatsForCabin } from '../../hold-orders/held-seats.js';
import type { BatchRescheduleBody } from '../orders.schemas.js';
import {
  assertHotelStaysFitWithinTx,
  assertRandomTierStaysFitWithinTx,
  buildStayNightDates,
  rewriteHotelStayDescription,
} from './bundle-pricing.js';
import {
  appendLegActionLog,
  assertLegActionTokenReplay,
  hasSeenLegActionToken,
  orchestrationFingerprint,
  readJsonObject,
  readOrchestrationLeg,
  rescheduleAllFingerprint,
  reschedulePassengersOrchestration,
  rescheduleTokenInFlightError,
  tokenPayloadMismatchError,
} from './leg-action-log.js';
import { orderSerializeRoleCtx, serializeOrder } from './read.js';
import {
  assertLegNotFlownForReschedule,
  computeBundleSeatSplit,
  isLegAlreadyFlown,
  releaseSeatFloored,
  takeSeatWithinTx,
} from './seat-inventory.js';
import {
  actorCan,
  AGENT_SELF_EDIT_REASON,
  ALLOWED_TRANSITIONS,
  appendAdjustment,
  buildUpgradedCabinDescription,
  CABIN_ZH_LABEL,
  computeAgentSelfEditWindow,
  computeCabinUpgradeDiffCny,
  formatDateOnly,
  ORDER_FULL_INCLUDE,
  RANDOM_TIER_INTERNAL_NO_CAP,
  round2,
  SEAT_HOLDING_STATUSES,
  syncOrderHasReturnLeg,
  syncOrderLegFlag,
  zhStatus,
} from './shared.js';
import type { SplitOrderResult } from './split.js';
import type { OrderService } from '../orders.service.js';

export type RescheduleCommittedContext = {
  orderItemId: string;
  oldScheduleId: string;
  oldCabin: import('@prisma/client').CabinClass;
  newScheduleId: string;
  newCabin: import('@prisma/client').CabinClass;
  statusChanged: boolean;
};

export const rescheduleCommittedContexts = new WeakMap<object, RescheduleCommittedContext>();

export function rescheduleCommittedContext(err: unknown): RescheduleCommittedContext | null {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return null;
  return rescheduleCommittedContexts.get(err) ?? null;
}

/**
 * 批量改航班（录入纠错，ADMIN/STAFF）。
 * 航段按订单 FLIGHT 行的班次 departureTime 升序解析，逐单复用单条改期事务；
 * 不传 feeCny / feeLabel，且已出票/已完成订单默认拦截，避免账面班次与真实机票分叉。
 * 每单独立捕获错误，单个班次售罄只影响当前订单。
 */
export async function batchReschedule(svc: OrderService, input: BatchRescheduleBody, actor: { userId: string; role: UserRole }): Promise<{
    succeeded: number;
    failed: number;
    results: Array<{
      id: string;
      orderNumber?: string;
      ok: boolean;
      error?: string;
      notice?: string;
      audit?: {
        orderNumber: string;
        orderItemId: string;
        fromScheduleId: string;
        fromCabin: import('@prisma/client').CabinClass;
        fromDeparture: Date | null;
        toScheduleId: string;
        toCabin: import('@prisma/client').CabinClass;
        toDeparture: Date | null;
        feeCny: number;
        statusChanged: boolean;
      };
    }>;
  }> {
  const results: Array<{
    id: string;
    orderNumber?: string;
    ok: boolean;
    error?: string;
    notice?: string;
    audit?: {
      orderNumber: string;
      orderItemId: string;
      fromScheduleId: string;
      fromCabin: import('@prisma/client').CabinClass;
      fromDeparture: Date | null;
      toScheduleId: string;
      toCabin: import('@prisma/client').CabinClass;
      toDeparture: Date | null;
      feeCny: number;
      statusChanged: boolean;
    };
  }> = [];
  let succeeded = 0;
  let failed = 0;

  for (const id of input.orderIds) {
    try {
      const { order, audit } = await svc.rescheduleOrderItem(
        id,
        {
          leg: input.leg,
          newScheduleId: input.newScheduleId,
          note: input.note,
          guard: { forbidTicketed: !input.allowTicketed, correction: true },
        },
        actor,
      );
      const orderNumber = (order as unknown as { orderNumber?: string }).orderNumber;
      results.push({ id, orderNumber, ok: true, audit });
      succeeded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      const context = rescheduleCommittedContext(err);
      let recovered = false;
      if (context) {
        try {
          const currentItem = await prisma.orderItem.findUnique({
            where: { id: context.orderItemId },
            select: {
              orderId: true,
              flightScheduleId: true,
              flightCabin: true,
              order: { select: { orderNumber: true } },
            },
          });
          if (
            currentItem?.orderId === id &&
            currentItem.flightScheduleId === input.newScheduleId
          ) {
            results.push({
              id,
              orderNumber: currentItem.order.orderNumber,
              ok: true,
              notice: '已生效（回包异常）',
              audit: {
                orderNumber: currentItem.order.orderNumber,
                orderItemId: context.orderItemId,
                fromScheduleId: context.oldScheduleId,
                fromCabin: context.oldCabin,
                fromDeparture: null,
                toScheduleId: context.newScheduleId,
                toCabin: currentItem.flightCabin ?? context.newCabin,
                toDeparture: null,
                feeCny: 0,
                statusChanged: context.statusChanged,
              },
            });
            succeeded += 1;
            recovered = true;
          }
        } catch {
          // 回读失败时按失败返回；原始事务外异常仍保留在 error 中。
        }
      }
      if (!recovered) {
        results.push({ id, ok: false, error: message });
        failed += 1;
      }
    }
  }

  return { succeeded, failed, results };
}

// ════════════════════════════════════════════════════════════════════
// 售后改单：改期（reschedule）/ 换人（passenger swap）
// 订单创建后原本不可改（只能取消重建）；这两个端点补「就地改」能力。
// 全程 ADMIN/STAFF（路由层断言）、事务安全、审计。
// 钱与库存口径：
//   - 改期不重算机票基础价（doc：只加改期费）；尾款用 total + adjustmentCny − paidAmount − prepaymentOffset。
//   - 座位「先放旧、再原子拿新」：拿新失败则整事务回滚，旧座不会被放掉（无泄漏、无超售）。
// ════════════════════════════════════════════════════════════════════

/**
 * 改期：把订单里某条 FLIGHT 行就地改到新班次/新舱位，并（可选）加改期费。
 *
 * body：{ orderItemId, newScheduleId, newCabin?, feeCny?, feeLabel?, note? }
 *   - orderItemId 必须属于本订单且 kind=FLIGHT，且有原班次/原舱位。
 *   - newCabin 缺省则沿用原舱位。
 *
 * 单事务内：
 *   1. 释放旧座（旧班次+旧舱位 sold −= quantity）
 *   2. 原子拿新座（新班次+新舱位 CAS：sold + qty + 他人锁位 + 占位余座 ≤ capacity）
 *      —— 新班次售罄则抛错，事务回滚 → 旧座保持原样（不泄漏）。
 *   3. 更新该行 flightScheduleId/flightCabin（amount/quantity 不变，机票基础价不重算）。
 *   3b. **换了班次即作废原票**：清空本单乘客的 pnr / eticketNumber，并把被改那一段的
 *       开票标记（去程 outboundInvoiced / 回程 returnInvoiced）翻回未开 —— 改期后旧票号
 *       必然作废，留着会让票务台以为已出票、导出与班次开票额度也照旧占着。
 *   4. 撤销未撤销的立减快照行并按原金额补差；feeCny≠0 另 push 一条 RESCHEDULE_FEE 流水
 *      （**差价可正可负**：同「换酒店差价 / 酒店改期差价」口径，改到便宜班次要能退差）。
 *   5. 当前若处于 CHANGE_REQUESTED（状态机允许 → CHANGED）则推进到 CHANGED；其余状态保持不变。
 *
 * 返回更新后的订单（serializeOrder）。
 */
export async function rescheduleOrderItem(
  svc: OrderService,
  orderId: string,
  input: {
    orderItemId?: string;
    /** 批量改期内部入口：在订单行锁内按真实航段定位订单行。 */
    leg?: 'OUTBOUND' | 'RETURN';
    newScheduleId: string;
    newCabin?: import('@prisma/client').CabinClass;
    feeCny?: number;
    feeLabel?: string;
    note?: string;
    /** 仅批量入口使用；省略时保持单条改期路由原有行为。 */
    guard?: { forbidTicketed?: boolean; correction?: boolean };
    /**
     * 内部专用旗子：**只**由 correctFlightSchedule 在过完「代理自助改单窗口」闸之后设置，
     * 用来绕过下面那句「仅运营/管理员可改期」。
     *
     * 为什么不是把那句闸整体放开：售后改期会收改期费、撤立减、推状态 —— 那是动钱的操作，
     * 代理永远碰不得。放开的只有纠错通道（correction=true，差价恒 0）这一条。
     * 请求体进不来这个字段：两条改期路由的 zod schema（z.object 默认剥未知键）都不含它。
     */
    selfServiceCorrection?: boolean;
    /**
     * 幂等键（按人改期的全员快路径传）：成功后在同一事务里往该航段行的 legActionLog
     * 追加一条 RESCHEDULE_ALL 流水，编排层下次拿同一个 token 重试时据此回放。
     *
     * 为什么 append 放在这里、而不是等它返回后另起一个事务补写：本方法整个是一个
     * `prisma.$transaction`，返回时座位与金额都已提交。事务外补写一旦失败（进程被杀、
     * 连接断开），就留下「钱已收、流水没留」的状态，下次重试认不出回放会再收一次差价。
     * 而且这一行的 metadata 正是本方法在改（flightChanged 标记），两处分开写必然互相覆盖。
     */
    requestToken?: string;
  },
  actor: { userId: string; role: UserRole },
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      fromScheduleId: string;
      fromCabin: import('@prisma/client').CabinClass;
      fromDeparture: Date | null;
      toScheduleId: string;
      toCabin: import('@prisma/client').CabinClass;
      toDeparture: Date | null;
      /**
       * 原/新班次的**当地**出发日（YYYY-MM-DD，按各自 departureTz 折算；查不到班次为 null）。
       * 审计里光有 UTC 瞬间读不出「改到哪一天」——班次时刻存 UTC，港澳台/东南亚航线折下来常差一天。
       */
      fromDepartureLocal: string | null;
      toDepartureLocal: string | null;
      feeCny: number;
      statusChanged: boolean;
      /** 随出发日平移自动同步的酒店行（未平移/无酒店行 = 空数组），日期为 YYYY-MM-DD。 */
      hotelDateSync: Array<{
        orderItemId: string;
        fromCheckIn: string;
        toCheckIn: string;
        fromCheckOut: string | null;
        toCheckOut: string | null;
      }>;
    };
  }> {
  // 代理自助纠错（correctFlightSchedule）已在上游过完归属 + 下单当天窗口闸，从此处放行；
  // 其余一切改期入口维持原样只认运营/管理员（自助旗子请求体注入不进来）。
  if (!actorCan(actor, 'orders.reschedule') && !input.selfServiceCorrection) {
    throw new ForbiddenError('仅运营/管理员可改期');
  }
  // 改期差价可正可负（与换酒店差价 / 酒店改期差价同一 adjustmentCny 机制）：改到更便宜的班次
  // 本来就该退客人钱，旧版 Math.max(0, …) 把负数钳成 0，运营只能另开收款单反向操作。
  // 上限仍由 schema 的 ±POST_SALE_FEE_CAP_CNY 把关。
  const feeCny = Math.trunc(input.feeCny ?? 0);

  const scratch = await prisma.$transaction(async (tx) => {
    // R2 并发串行（与超时 worker 配对）：先对本订单 Order 行 FOR UPDATE，再往下读 items / 搬座位。
    // 超时 worker（queues/worker.ts）释放座位时也先对同一 Order 行 FOR UPDATE 后才事务内读 items——
    // 两处抢同一把行锁 → 改期与超时释放严格串行：谁先拿锁谁先提交，另一方拿锁后读到已提交的最新
    // 状态/items（改期已换舱则 worker 读新舱、或状态已 CHANGED 而跳过释放；worker 先超时则改期读到
    // PAYMENT_TIMEOUT 被下方占座守卫拒绝）。杜绝旧版无共同串行点导致的「旧舱双放 + 新舱幽灵持有」交错。
    const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
    `;
    if (lockRows.length === 0) throw new NotFoundError('订单不存在');

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        adjustmentCny: true,
        adjustments: true,
        // 自助纠错的窗口复查要用（锁内的权威现势，见下方）。
        createdAt: true,
        outboundInvoiced: true,
        returnInvoiced: true,
        systemInvoiced: true,
        settlementLocked: true,
      },
    });
    if (!order) throw new NotFoundError('订单不存在');

    // ── 自助纠错：锁内复查窗口 + 票务现势（L3 / C2）──────────────────────────
    // 入口那道 assertAgentSelfEditAllowed 是**锁外**读的一次快照：从判完到这里之间，订单可能
    // 已被出票、开票、锁结算价，或者跨过了北京业务日的 24:00。拿刚 FOR UPDATE 锁住的这一行
    // 重跑同一份纯函数，口径与入口逐字一致（报错文案也是同一句）。
    // 「真·自助」= 带自助旗子**且**操作人是代理。运营走同一条纠错通道也带这面旗子（它只是用来
    // 绕开「仅运营/管理员可改期」那句闸），下面这批收紧一条都不该落到运营头上。
    const isAgentSelfService =
      input.selfServiceCorrection === true && actor.role === UserRole.AGENT;
    if (isAgentSelfService) {
      const window = computeAgentSelfEditWindow(order);
      if (!window.open) {
        throw new ForbiddenError(window.reason ?? AGENT_SELF_EDIT_REASON.NEXT_DAY);
      }
      // 换班次会把全单乘客的 PNR / 票号清空、并翻回被改航段的开票标记 —— 那是运营的售后动作。
      // 只要这单已经有人订上座或出了票，自助通道一律不碰，走改单申请由运营核对航司那边再改。
      const ticketedRows = await tx.passenger.findMany({
        where: { orderId },
        select: { pnr: true, eticketNumber: true },
      });
      const anyTicketed = ticketedRows.some(
        (p) => (p.pnr ?? '').trim() !== '' || (p.eticketNumber ?? '').trim() !== '',
      );
      if (anyTicketed) {
        throw new BadRequestError('已订座/已出票，请提交改单申请由运营处理');
      }
    }

    // ── 幂等键的守闸：**必须在订单行锁内再查一次**（并发安全）────────────────────
    // 编排层（按人改期的全员快路径）在事务外先查一遍 token 拦不住并发：同 token 的两次
    // 提交会双双读到「没见过」，随后被上面这把行锁串行执行两次 —— 座位搬两回、差价记两笔。
    // 所以说了算的这一次查放在拿到锁之后、任何座位/金额写入之前。
    //
    // 查的范围是本单**全部** FLIGHT 行，含 flightScheduleId 已被置空的行：no-show 释放 /
    // 取消航段会把班次清掉，只捞「有班次的行」就会漏掉那些行上留过的 token，
    // 同一个编号又能拿去改另一条活着的航段。
    //
    // 命中后一律 409、不在锁内回放：能走到这里说明编排层刚刚才判过「没见过」，
    // 也就是撞上了一次并发的同 token 提交 —— 这是真正的冲突，不是一次可以静默复用的重试。
    // 客户端刷新后原样重发即可：那时首刷已提交，编排层的回放分支会正常返回 200。
    if (input.requestToken) {
      const tokenRows = await tx.orderItem.findMany({
        where: { orderId, kind: OrderItemKind.FLIGHT },
        select: { id: true, metadata: true },
      });
      const lookup = hasSeenLegActionToken(tokenRows, input.requestToken);
      if (lookup.seen) {
        // 动作类型 / 入参指纹对不上 → 更精确的 TOKEN_PAYLOAD_MISMATCH。
        assertLegActionTokenReplay(lookup, ['RESCHEDULE_ALL'], rescheduleAllFingerprint(input));
        throw rescheduleTokenInFlightError(input.requestToken);
      }
    }

    // 占座状态守卫（HIGH）：改期要"放旧座 + 拿新座"，只有当订单当前**真的持有座位**时才成立。
    // 旧代码读了 order.status 却从不校验：对 CANCELLED/REFUNDED/软删单改期会——
    //   · 二次释放旧座（旧座早已释放，再放会把 sold 打成负数并永久卡账）；
    //   · 拿一份新座却挂在死单上永不释放（幽灵持有 → 超卖）。
    // 因此入口硬性要求：deletedAt=null 且 status ∈ 占座态，否则拒绝改期。
    if (order.deletedAt) {
      throw new BadRequestError('订单在回收站（已软删），不可改期；如需操作请先恢复');
    }
    if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      throw new BadRequestError(
        `订单当前状态（${zhStatus(order.status)}）不可改期：仅占座中的有效订单可改期（已取消/已退款/超时订单请勿改期）`,
      );
    }

    if (
      input.guard?.forbidTicketed &&
      (order.status === OrderStatus.TICKETED || order.status === OrderStatus.COMPLETED)
    ) {
      throw new BadRequestError('订单已出票/已完成，需勾选「同时修改已出票订单」后才能改');
    }

    const itemSelect = {
      id: true,
      orderId: true,
      kind: true,
      quantity: true,
      bundleId: true,
      flightScheduleId: true,
      flightCabin: true,
      metadata: true,
      flightSchedule: { select: { departureTime: true, departureTz: true } },
    } as const;
    const item = input.orderItemId
      ? await tx.orderItem.findUnique({ where: { id: input.orderItemId }, select: itemSelect })
      : await (() => {
          if (!input.leg) return Promise.resolve(null);
          return tx.orderItem.findMany({
            where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
            select: itemSelect,
            orderBy: [{ flightSchedule: { departureTime: 'asc' } }, { id: 'asc' }],
          }).then((items) => {
            const legs = determineFlightLegItems(items);
            return input.leg === 'OUTBOUND' ? legs.outbound : legs.return;
          });
        })();
    if (!item || item.orderId !== orderId) {
      if (input.leg) {
        // leg 定位落空有两种成因，别混成一句话：本来就没这一段（单程单），
        // 还是这一段的座位被释放掉了（no-show 释放 / 取消航段 → flightScheduleId 置空，
        // 于是退出了「有效航段」判定，leg 自然找不到它）。后者要指路到「恢复回程」。
        const releasedRow = await tx.orderItem.findFirst({
          where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: null },
          select: { id: true, metadata: true },
        });
        const wasReleased =
          releasedRow != null &&
          (readJsonObject(readJsonObject(releasedRow.metadata).returnReleased).at != null ||
            readJsonObject(readJsonObject(releasedRow.metadata).returnLegCancelled).at != null);
        if (input.leg === 'RETURN' && wasReleased) {
          throw new BadRequestError(RELEASED_LEG_NO_SCHEDULE_HINT('改期'));
        }
        throw new BadRequestError(input.leg === 'RETURN' ? '本单没有回程航段' : '本单没有去程航段');
      }
      throw new NotFoundError('订单项不存在或不属于该订单');
    }
    if (item.kind !== OrderItemKind.FLIGHT) {
      throw new BadRequestError('只能对机票行（FLIGHT）改期');
    }
    if (!item.flightScheduleId || !item.flightCabin) {
      // 是机票行，但座位已经被放回库存（no-show 释放 / 取消航段把 flightScheduleId 置空了）。
      // 改期的语义是「放旧座 + 拿新座」，这行现在一个座都没持有，放旧座会把 sold 打成负数。
      throw new BadRequestError(RELEASED_LEG_NO_SCHEDULE_HINT('改期'));
    }
    // ── 已标 no-show 的段不许改期（与取消航段闸 11 对称）────────────────────────
    // no-show 的口径是「客人没登机、钱与成本一分不动」。把这一段改期 = 把一次已经发生过的
    // 未登机搬到未来的班次上：座位真的被搬走占住，no-show 快照却还挂在同一行上，
    // 之后无论走恢复、取消还是退款都对不上账。要重新安排请另录一段航段。
    if (readJsonObject(readJsonObject(item.metadata).noShow).at != null) {
      throw new BadRequestError(
        '该段已标 no-show（客人未登机），不能改期；如需重新安排行程请另录一段航段。',
      );
    }
    // ── 已起飞的段不许改期（与取消航段闸 10 对称）──────────────────────────────
    // 改期要「放旧座」，而飞过的座位早被真实消耗掉了（口径同 isLegAlreadyFlown）：
    // 放回去等于让一个过去的班次凭空多出可卖余位，同时又在新班次占一份，两头都是错账。
    // 判定与文案抽到 assertLegNotFlownForReschedule：按人改期在拆单**之前**要跑同一份闸
    //（见 reschedulePassengers 步骤 3b），两处必须是同一份时刻口径、同一句人话。
    assertLegNotFlownForReschedule(item);

    const oldScheduleId = item.flightScheduleId;
    const oldCabin = item.flightCabin;
    const newScheduleId = input.newScheduleId;

    // ── 改期不许改舱（HIGH 修复：免费升舱后门）────────────────────────────
    // 改期端点只搬班次、不重算金额：amount/quantity 明写「不变」，feeCny 是手填的且可为 0，
    // 也不会生成 UPGRADE_CHANGE 行。若同时放开改舱，就等于「经济舱搬进商务舱、座位真的搬走、
    // 一分差价不收、账面无痕」—— 单笔漏收整笔升舱差价。
    // 升舱有独立端点（POST /orders/:id/items/:itemId/upgrade-cabin）：目标舱固定、差价由服务端
    // 按航班升舱差价源 × 人数权威计算、请求体不接受任何金额。职责收敛到那里，这里一律拒绝改舱。
    // 同舱改期（不传 newCabin，或传的就是原舱）是正常路径，不受影响。
    if (input.newCabin !== undefined && input.newCabin !== oldCabin) {
      throw new BadRequestError(
        '改期不能同时更改舱位：改期只搬班次、不重算差价。如需升舱请走「升舱」操作（差价由系统按航班差价源×人数自动计算）。',
      );
    }
    // 过闸后必然等于 oldCabin；保留原表达式，日后若放开改舱也只需改上面那道闸。
    const newCabin = input.newCabin ?? oldCabin;

    // 无变化（同班次同舱位）→ 不做座位搬移，避免无意义的放/拿
    const sameSeat = oldScheduleId === newScheduleId && oldCabin === newCabin;

    // ── 同班次同舱位还带着差价 = 自相矛盾的请求，直接拒 ──────────────────────
    // 不能改成「静默不收」：本方法返回的 audit 里带的是请求里的 feeCny，路由照它写审计
    // 「已收 ¥X」。悄悄清零就成了「审计说收了、账上没这笔钱」，事后对账对不上，而运营
    // 当场看到的还是一次成功。拒掉，审计里记的就永远是真实生效的金额。
    // 差价为 0 照旧放行（没搬座、也没钱可谈）；纠错通道（correction）本来就不动钱，不受约束。
    if (sameSeat && feeCny !== 0 && !input.guard?.correction) {
      throw new BadRequestError(
        '班次与舱位都没变，不能只收/退改期差价；要单独调整金额请走按乘客调价。',
      );
    }

    if (input.guard?.correction && !sameSeat && item.bundleId) {
      const discountRows = await tx.orderItem.findMany({
        where: { orderId, kind: OrderItemKind.DISCOUNT },
        select: { metadata: true },
      });
      const hasActiveSettlementDiscount = discountRows.some((discountRow) => {
        const rawMetadata = discountRow.metadata;
        const metadata =
          rawMetadata != null && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
            ? (rawMetadata as Record<string, unknown>)
            : {};
        return metadata.settlementDiscount === true && metadata.settlementDiscountRevoked !== true;
      });
      if (hasActiveSettlementDiscount) {
        throw new BadRequestError('本单含套餐立减，批量纠错会产生补差金额，请走单条改期逐单确认');
      }
    }

    // 新班次必须存在且有该舱位（友好报错；最终防超售仍靠下面的原子 CAS）
    const newSeatClass = await tx.flightSeatClass.findFirst({
      where: { scheduleId: newScheduleId, cabin: newCabin },
      select: { id: true },
    });
    if (!newSeatClass) {
      throw new BadRequestError('目标班次不存在该舱位，无法改期');
    }

    // 套餐升舱拆座：该行下单时可能把 businessUpgradeCount 个座拆到了商务舱。
    // 改期同样按原拆分「先放旧、再拿新」，否则商务/经济会错位泄漏。
    const meta = (item.metadata ?? {}) as Record<string, unknown> & { businessUpgradeCount?: unknown };
    const rawUpgrade = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;

    if (!sameSeat) {
      // ── 1. 释放旧座（按原拆分各退各舱）──
      // 用**有下限**版本 releaseSeatFloored（sold = GREATEST(0, sold − qty)），与状态机释放分支同口径：
      // 即便 businessUpgradeCount 被伪造导致想释放一个从未真正占用的舱位，也不会把 sold 打成负数卡账。
      const oldSplit = computeBundleSeatSplit(oldCabin, item.quantity, rawUpgrade);
      await releaseSeatFloored(tx, oldScheduleId, 'BUSINESS', oldSplit.business);
      await releaseSeatFloored(tx, oldScheduleId, oldCabin, oldSplit.sameCabin);

      // ── 2. 原子拿新座（同款 CAS；售罄 → 抛错，整事务回滚，旧座不会真被放掉）──
      // 拆座只对经济舱行成立；新舱位非经济舱则 split.business=0，全额拿新原舱。
      const newSplit = computeBundleSeatSplit(newCabin, item.quantity, rawUpgrade);
      await takeSeatWithinTx(tx, newScheduleId, 'BUSINESS', newSplit.business, null);
      await takeSeatWithinTx(tx, newScheduleId, newCabin, newSplit.sameCabin, null);
    }

    // 航变标记：仅当班次真的换了（换到另一趟班次）才在该行 metadata 打「航变」标，
    // 供后台（代理）与前台（直客）看见——同班次仅改舱位不算航变，不打标。
    // 记录原班次号/原起飞时间，前端可醒目标红并悬浮显示「原 XX 航班 原起飞 → 新起飞」。
    const scheduleChanged = oldScheduleId !== newScheduleId;
    let flightChangedMeta: Record<string, unknown> | null = null;
    if (scheduleChanged) {
      const oldSchedInfo = await tx.flightSchedule.findUnique({
        where: { id: oldScheduleId },
        select: {
          departureTime: true,
          departureTz: true,
          flight: { select: { flightNumber: true } },
        },
      });
      flightChangedMeta = {
        at: new Date().toISOString(),
        fromScheduleId: oldScheduleId,
        fromFlightNumber: oldSchedInfo?.flight?.flightNumber ?? null,
        fromDeparture: oldSchedInfo?.departureTime?.toISOString() ?? null,
        // 原班次出发地时区：航变提示要按它显示原起飞时刻。
        // 本次改动之前盖的旧标记没有这个字段，前端会回退到浏览器时区（见各自注释）。
        fromDepartureTz: oldSchedInfo?.departureTz ?? null,
        toScheduleId: newScheduleId,
      };
    }

    // ── 3. 更新订单行的班次/舱位（amount/quantity 不变：机票基础价不重算）──
    // metadata 一次写完：「航变标记」与「幂等流水」都挂在这一行上，分两次写必然互相覆盖。
    const nextMeta: Record<string, unknown> | null =
      flightChangedMeta || input.requestToken
        ? {
            ...meta,
            // 换班次 → 落「航变」标记（保留该行原有 metadata，如套餐升舱拆座计数）
            ...(flightChangedMeta ? { flightChanged: flightChangedMeta } : {}),
            // 幂等流水：与座位、金额同一个事务提交，绝不会出现「钱已收、流水没留」。
            ...(input.requestToken
              ? {
                  legActionLog: appendLegActionLog(meta, {
                    type: 'RESCHEDULE_ALL',
                    requestToken: input.requestToken,
                    at: new Date().toISOString(),
                    byUserId: actor.userId,
                    fingerprint: rescheduleAllFingerprint(input),
                  }),
                }
              : {}),
          }
        : null;
    await tx.orderItem.update({
      where: { id: item.id },
      data: {
        flightScheduleId: newScheduleId,
        flightCabin: newCabin,
        ...(nextMeta ? { metadata: nextMeta as Prisma.InputJsonValue } : {}),
      },
    });

    // 物化列 hasReturnLeg 自愈：改期只换班次、不增删航段，航段条数恒定，本调用理论上是个
    // 恒等写。仍然保留 —— 它把「改过期的单」顺手校准回真实结构（含迁移前的存量脏值），
    // 且未来若改期扩展成能加/删航段，维护点已经在这里，不会漏。
    await syncOrderHasReturnLeg(tx, orderId);
    await syncOrderLegFlag(tx, orderId);

    // ── 3b. 换班次即作废原票：清票号 + 翻回被改航段的开票标记 ────────────────────
    // 旧代码只搬座位、不动票务字段，于是改完期订单上仍挂着**原航班的** PNR / 票号，
    // 开票位也仍是「已开」——票务台看不出要重开，导出发给客人的还是作废票号，
    // 而那份开票额度还占着新班次的座位库存（额度按航段算，班次已经换人了）。
    // 只在真的换了班次时做（同班次改舱/无变化不动票）；纠错批量入口（correction）同样适用——
    // 那正是「录错班次」的场景，原票号更不该留。
    // 幂等：updateMany + 定值写，重复改期不会出问题。
    const hotelDateSync: Array<{
      orderItemId: string;
      fromCheckIn: string;
      toCheckIn: string;
      fromCheckOut: string | null;
      toCheckOut: string | null;
    }> = [];
    if (scheduleChanged) {
      await tx.passenger.updateMany({
        where: { orderId },
        data: { pnr: null, eticketNumber: null },
      });

      // 被改的是去程还是回程：按**改期前**的航段顺序判定（此刻订单行已写成新班次，
      // 再按 departureTime 排序可能已经换位），故用行 id 与改期前那份排序结果比对。
      const legItemsBefore = await tx.orderItem.findMany({
        where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
        select: {
          id: true,
          flightScheduleId: true,
          flightSchedule: { select: { departureTime: true, departureTz: true } },
        },
      });
      const rowsBefore = legItemsBefore.map((row) =>
        row.id === item.id
          ? { ...row, flightScheduleId: oldScheduleId, flightSchedule: item.flightSchedule }
          : row,
      );
      const legsBefore = determineFlightLegItems(rowsBefore);
      const invoiceReset =
        legsBefore.return?.id === item.id
          ? { returnInvoiced: false }
          : legsBefore.outbound?.id === item.id
            ? { outboundInvoiced: false }
            : null;
      if (invoiceReset) {
        await tx.order.update({ where: { id: orderId }, data: invoiceReset });
      }

      // ── 3c. 酒店入住日期随出发日平移（0830 公测反馈）────────────────────────
      // 改期只搬机票行，酒店行的 hotelCheckIn/hotelCheckOut 原地不动 → 分房表按入住日
      // 归 sheet，客人仍挂在旧日期下（导旧日期有他、导新日期没他）。口径：整单「最早航段
      // 的出发地当地日」平移了 N 天（≠0），同单全部占房行的入住/离店同步平移 N 天——
      // 晚数不变、行价/间数一律冻结（与酒店改期的甲案同哲学，晚数没变也无差价可谈）。
      // 只改回程不动最早出发日 → 不平移（离店是否顺延涉及晚数与差价，留给「酒店改期」人工办）。
      // 新日期房量装不下 → 抛错整事务回滚，改期不成立（先协调房再改）。
      // 纠错入口（correction）同样适用：录错班次连带盖错的入住日期一并归位。
      const earliestLocalDate = (
        rows: Array<{ flightSchedule: { departureTime: Date; departureTz?: string | null } | null }>,
      ): string | null => {
        const days = rows
          .filter((r) => r.flightSchedule?.departureTime)
          .map((r) => localDateISO(r.flightSchedule!.departureTime, r.flightSchedule!.departureTz));
        return days.length > 0 ? days.sort()[0] : null;
      };
      const departBefore = earliestLocalDate(rowsBefore);
      const departAfter = earliestLocalDate(legItemsBefore);
      const deltaDays =
        departBefore && departAfter
          ? Math.round(
              (new Date(`${departAfter}T00:00:00.000Z`).getTime() -
                new Date(`${departBefore}T00:00:00.000Z`).getTime()) /
                (24 * 60 * 60 * 1000),
            )
          : 0;
      if (deltaDays !== 0) {
        const hotelRows = (
          await tx.orderItem.findMany({
            where: {
              orderId,
              hotelCheckIn: { not: null },
              OR: [{ hotelRoomTypeId: { not: null } }, { randomStarTier: { not: null } }],
            },
            select: {
              id: true,
              description: true,
              hotelRoomTypeId: true,
              randomStarTier: true,
              hotelCheckIn: true,
              hotelCheckOut: true,
              roomsBilled: true,
            },
          })
        ) // 防御性复筛（与 where 同条件）：单测 mock 的 findMany 不认 where，会把机票行也吐回来
          .filter((r) => r.hotelCheckIn && (r.hotelRoomTypeId || r.randomStarTier != null));
        if (hotelRows.length > 0) {
          const shiftDay = (d: Date): Date => new Date(d.getTime() + deltaDays * 24 * 60 * 60 * 1000);
          const shifted = hotelRows.map((row) => ({
            row,
            newCheckIn: shiftDay(row.hotelCheckIn!),
            newCheckOut: row.hotelCheckOut ? shiftDay(row.hotelCheckOut) : null,
          }));
          // 新区间房量闸（与建单/改档同一对闸，自带同酒店/同档归并防「各判各的」漏判）：
          // excludeOrderId 排除本单现占房 = 先释放旧区间，再按新区间前瞻判定。
          const prospectiveStays = shifted.map((s) => ({
            hotelRoomTypeId: s.row.hotelRoomTypeId,
            hotelCheckIn: s.newCheckIn,
            hotelCheckOut: s.newCheckOut,
            roomsBilled: s.row.roomsBilled == null ? null : Number(s.row.roomsBilled.toString()),
            randomStarTier: s.row.randomStarTier,
          }));
          const orderPassengers = await tx.passenger.findMany({
            where: { orderId },
            select: { gender: true },
          });
          try {
            await assertHotelStaysFitWithinTx(
              tx,
              prospectiveStays,
              orderPassengers.map((p) => ({ gender: p.gender ?? undefined })),
              { excludeOrderId: orderId },
            );
            // 随机档超售上限（H3）：运营改期/纠错沿用内部录单的「需求池不闸单」口径；
            // 代理自助纠错必须吃与其它录单同一份上限（默认 3 间，可后台配）——
            // 自助只是把「录错的班次改对」，不该顺手把随机档的超售闸整个卸掉：
            // 平移日期挤爆某一天的随机档房量，最后是房控半夜加房。
            await assertRandomTierStaysFitWithinTx(tx, prospectiveStays, {
              excludeOrderId: orderId,
              maxOversellRooms: isAgentSelfService
                ? await getHotelOversellCapRooms(tx)
                : RANDOM_TIER_INTERNAL_NO_CAP,
            });
          } catch (err) {
            if (err instanceof BadRequestError) {
              throw new BadRequestError(
                `改期需同步酒店入住日期（随出发日平移 ${deltaDays > 0 ? '+' : ''}${deltaDays} 天），新日期房量不足，本次改期已整体取消：${err.message}`,
              );
            }
            throw err;
          }
          for (const s of shifted) {
            const nights = s.newCheckOut
              ? buildStayNightDates(s.newCheckIn, s.newCheckOut).length
              : 0;
            await tx.orderItem.update({
              where: { id: s.row.id },
              data: {
                hotelCheckIn: s.newCheckIn,
                ...(s.newCheckOut ? { hotelCheckOut: s.newCheckOut } : {}),
                // description 里的日期/晚数段就地改写（自由文本无该段则原样保留）
                ...(s.newCheckOut && nights > 0
                  ? {
                      description: rewriteHotelStayDescription(s.row.description, {
                        checkIn: formatDateOnly(s.newCheckIn),
                        checkOut: formatDateOnly(s.newCheckOut),
                        nights,
                      }),
                    }
                  : {}),
              },
            });
            hotelDateSync.push({
              orderItemId: s.row.id,
              fromCheckIn: formatDateOnly(s.row.hotelCheckIn!),
              toCheckIn: formatDateOnly(s.newCheckIn),
              fromCheckOut: s.row.hotelCheckOut ? formatDateOnly(s.row.hotelCheckOut) : null,
              toCheckOut: s.newCheckOut ? formatDateOnly(s.newCheckOut) : null,
            });
          }
        }
      }
    }

    // ── 4. 改期立减取消补差 + 手填改期费（两笔分别留流水）──
    // 改期后原立减不随新日期重新命中：只撤销订单上尚未撤销的快照行，
    // 并把等额补差记入 adjustmentCny。行级 revoked 标记保证同单二次改期幂等。
    // 走到这里 sameSeat 必然带着 feeCny === 0（有金额的已在上面被拒），无须再夹一层：
    // 审计记的 feeCny 与这里实际入账的金额永远是同一个数。
    let adjustmentDelta = input.guard?.correction ? 0 : feeCny;
    let adjustmentLog = order.adjustments;
    if (!sameSeat && !input.guard?.correction) {
      // 立减只挂在套餐地面价上：纯机票行改期与立减无关。
      if (item.bundleId) {
        const discountRows =
          (await tx.orderItem.findMany({
            where: { orderId, kind: OrderItemKind.DISCOUNT },
            select: { id: true, amount: true, metadata: true },
          })) ?? [];
        for (const discountRow of discountRows) {
          const rawMetadata = discountRow.metadata;
          const metadata =
            rawMetadata != null && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
              ? (rawMetadata as Record<string, unknown>)
              : {};
          if (metadata.settlementDiscount !== true || metadata.settlementDiscountRevoked === true) {
            continue;
          }
          const discountBundleId =
            typeof metadata.bundleId === 'string' ? metadata.bundleId : null;
          if (discountBundleId && discountBundleId !== item.bundleId) continue;
          if (!discountBundleId) {
            // eslint-disable-next-line no-console
            console.warn('[orders] settlement discount row missing bundleId snapshot; revoking defensively', {
              orderId,
              orderItemId: discountRow.id,
              targetBundleId: item.bundleId,
            });
          }
          const amountCny = Math.abs(Number(discountRow.amount) || 0);
          await tx.orderItem.update({
            where: { id: discountRow.id },
            data: {
              metadata: { ...metadata, settlementDiscountRevoked: true } as Prisma.InputJsonValue,
            },
          });
          if (amountCny <= 0) continue;
          adjustmentDelta += amountCny;
          adjustmentLog = appendAdjustment(adjustmentLog, {
            type: 'RESCHEDULE_DISCOUNT_REVOKE',
            label: `改期立减取消补差 ¥${amountCny}`,
            amountCny,
            at: new Date().toISOString(),
            by: actor.userId,
          }) as unknown as Prisma.JsonValue;
        }
      }
    }
    // feeCny 可正可负（改到贵班次补差 / 改到便宜班次退差），故判 !== 0 而不是 > 0。
    // 默认名从「改期费」改为「改期差价」——它现在两个方向都用。
    if (feeCny !== 0 && !input.guard?.correction) {
      adjustmentLog = appendAdjustment(adjustmentLog, {
        type: 'RESCHEDULE_FEE',
        label: input.feeLabel || '改期差价',
        amountCny: feeCny,
        at: new Date().toISOString(),
        by: actor.userId,
        note: input.note,
      }) as unknown as Prisma.JsonValue;
    }
    // 负差价把 adjustmentCny 往下压（应付随之减少）——不夹 0，与换酒店差价 / 酒店改期差价
    // 完全同一口径（那两处也是直接 order.adjustmentCny + feeCny）。夹 0 会让「改到便宜班次
    // 退差」在合计为负时悄悄吞掉一部分，客人对不上账。
    if (adjustmentDelta !== 0) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          adjustmentCny: order.adjustmentCny + adjustmentDelta,
          adjustments: adjustmentLog as unknown as Prisma.InputJsonValue,
        },
      });
    }

    // ── 5. 仅在状态机允许时推进到 CHANGED（不破坏状态机）──
    // 追加 scheduleChanged 条件：「已改期」是航段真的换过的派生（_updateStatusWithinTx 的
    // CHANGED 派生闸认的就是本函数落的 flightChanged 标记）。只收差价、不换班次的调用
    // 没有航变可言，也没落标记 —— 不推状态，否则会撞上自家的闸、把整笔改期回滚掉，
    // 运营只会看到一句「请先用改期把航段改到新班次」的自相矛盾报错。
    let statusChanged = false;
    if (
      scheduleChanged &&
      !input.guard?.correction &&
      order.status !== OrderStatus.CHANGED &&
      ALLOWED_TRANSITIONS[order.status].includes(OrderStatus.CHANGED)
    ) {
      await svc._updateStatusWithinTx(
        tx,
        orderId,
        OrderStatus.CHANGED,
        { userId: actor.userId, role: actor.role, actorType: 'USER' },
        input.note ? `改期（${input.note}）` : '改期',
        [], // 改期不产生履约任务
      );
      statusChanged = true;
    }

    // 把审计需要的「原/新」明细返回到 tx 外（出发时间另查）。
    // 直接 return 而非写模块级单例，避免并发改期互相覆盖。
    return {
      orderItemId: item.id,
      oldScheduleId,
      oldCabin,
      newScheduleId,
      newCabin,
      statusChanged,
      hotelDateSync,
    };
  });

  try {
    // 审计明细：原/新出发时间（事务外查，避免污染事务）
    const [fromSched, toSched, finalOrder] = await Promise.all([
      prisma.flightSchedule.findUnique({
        where: { id: scratch.oldScheduleId },
        select: { departureTime: true, departureTz: true },
      }),
      prisma.flightSchedule.findUnique({
        where: { id: scratch.newScheduleId },
        select: { departureTime: true, departureTz: true },
      }),
      prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_FULL_INCLUDE }),
    ]);

    return {
      // 对外脱敏：改期（AGENT/CUSTOMER 侧也有入口）的返回按操作者角色脱敏。
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      audit: {
        orderNumber: finalOrder.orderNumber,
        orderItemId: scratch.orderItemId,
        fromScheduleId: scratch.oldScheduleId,
        fromCabin: scratch.oldCabin,
        fromDeparture: fromSched?.departureTime ?? null,
        toScheduleId: scratch.newScheduleId,
        toCabin: scratch.newCabin,
        toDeparture: toSched?.departureTime ?? null,
        // 当地出发日：按各班次自己的 departureTz 折（口径同 lib/flight-time 唯一入口）。
        fromDepartureLocal: fromSched
          ? localDateISO(fromSched.departureTime, fromSched.departureTz)
          : null,
        toDepartureLocal: toSched
          ? localDateISO(toSched.departureTime, toSched.departureTz)
          : null,
        feeCny,
        statusChanged: scratch.statusChanged,
        hotelDateSync: scratch.hotelDateSync,
      },
    };
  } catch (err) {
    // 事务已经提交；为批量入口保留定位上下文，允许它回读确认实际已生效。
    if (err && (typeof err === 'object' || typeof err === 'function')) {
      rescheduleCommittedContexts.set(err, scratch);
    }
    throw err;
  }
}

/**
 * 售后升舱：把订单里某条**经济舱**机票行就地升到商务舱，并按单一差价源自动计费。
 *
 * 与「改期」的分工：改期解决**航变/换班次**（可顺带改舱位、差价手填进改期费）；本方法解决
 * **纯升舱**——不换班次、不手填金额，差价由服务端按 `Flight.businessUpgradeCnyPerLeg`
 * （¥/程/座，与建单加购升舱同一个配置源）× 该行人数权威计算，客户端传不进金额。
 *
 * 单事务内：
 *   1. Order 行 FOR UPDATE（与改期/超时释放/到账入账同一把行锁，座位与金额都要串行）。
 *   2. 守卫：资金闸（回收站/已取消/已退款/超时单拒绝）+ 收款复核锁 + 占座态 + 行合法性。
 *   3. 座位对称搬移：ECONOMY 放座（floored）→ BUSINESS 原子 CAS 扣座；商务舱不足 → 抛错整事务回滚。
 *   4. 该行 flightCabin→BUSINESS，description 刷新舱位字样（快照文本，避免列表仍显示「经济舱」）。
 *   5. 新增一条 kind=UPGRADE_CHANGE 行（升舱收入科目），amount = 差价；重算 order.subtotal/total。
 *   6. **订单状态不动**（升舱不是改签，不推 CHANGED）。
 *
 * 套餐单（该行带 bundleId / 建单时已拆过商务舱座）本次不支持：套餐升舱有自己的份数与拆座模型，
 * 走这里会把两套口径搅在一起。返回 400 引导人工处理。
 */
export async function upgradeOrderItemCabin(
  svc: OrderService,
  orderId: string,
  orderItemId: string,
  input: { note?: string },
  actor: { userId: string; role: UserRole; agentId?: string },
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      upgradeItemId: string;
      scheduleId: string;
      fromCabin: CabinClass;
      toCabin: CabinClass;
      quantity: number;
      upgradeCnyPerLeg: number;
      diffCny: number;
      subtotalBefore: number;
      subtotalAfter: number;
    };
  }> {
  // 代理自助升舱（下单当天、自家单）：过窗口闸后放行。差价本就由服务端按
  // 「航班升舱差价源 × 人数」权威计算、请求体连金额字段都没有，代理动不了钱。
  if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
    await svc.assertAgentSelfEditAllowed(orderId, actor);
  }

  const scratch = await prisma.$transaction(async (tx) => {
    // 与改期/补录地面项同一把 Order 行锁：座位搬移 + 订单总额重算都要与并发写严格串行。
    const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
    `;
    if (lockRows.length === 0) throw new NotFoundError('订单不存在');

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        deletedAt: true,
        paymentsLocked: true,
        subtotal: true,
        total: true,
        items: { select: { amount: true } },
        // 自助窗口的锁内复查要用（口径同入口 assertAgentSelfEditAllowed）。
        createdAt: true,
        outboundInvoiced: true,
        returnInvoiced: true,
        systemInvoiced: true,
        settlementLocked: true,
      },
    });
    if (!order) throw new NotFoundError('订单不存在');

    // ── 自助窗口锁内复查（L3）───────────────────────────────────────────────
    // 入口那次判定是锁外快照：从判完到拿锁之间订单可能已出票/已开票/已锁结算价，或者
    // 跨过了北京业务日 24:00。拿刚锁住的这一行重跑同一份纯函数，报错文案也是同一句。
    if (actor.role === UserRole.AGENT) {
      const window = computeAgentSelfEditWindow(order);
      if (!window.open) {
        throw new ForbiddenError(window.reason ?? AGENT_SELF_EDIT_REASON.NEXT_DAY);
      }
    }

    // 资金闸：升舱会抬 total，与补录地面项/调价同源守卫——回收站单、已取消/已退款/超时/草稿单一律拒绝。
    assertOrderAcceptsFunds(order);
    // 收款复核锁：金额要变，锁定态下拒绝（与人工录收款同口径，解锁需审计留痕）。
    if (order.paymentsLocked) {
      throw new ConflictError('收款已锁定（财务复核完成），请先解锁再升舱');
    }
    // 占座态守卫：升舱要「放经济舱座 + 拿商务舱座」，只有订单当前真的持有座位时才成立。
    if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      throw new BadRequestError(
        `订单当前状态（${zhStatus(order.status)}）不可升舱：仅占座中的有效订单可升舱`,
      );
    }

    const item = await tx.orderItem.findUnique({
      where: { id: orderItemId },
      select: {
        id: true,
        orderId: true,
        kind: true,
        description: true,
        quantity: true,
        flightScheduleId: true,
        flightCabin: true,
        bundleId: true,
        metadata: true,
        // 起飞判定要用（下面的「已起飞不许升舱」闸）；与改期端点的 itemSelect 同口径。
        flightSchedule: { select: { departureTime: true, departureTz: true } },
      },
    });
    if (!item || item.orderId !== orderId) {
      throw new NotFoundError('订单项不存在或不属于该订单');
    }
    if (item.kind !== OrderItemKind.FLIGHT) {
      throw new BadRequestError('只能对机票行（FLIGHT）升舱');
    }
    if (!item.flightScheduleId || !item.flightCabin) {
      // 机票行，但座位已经被放回库存（no-show 释放 / 取消航段）：升舱要「放经济舱座 + 拿商务舱座」，
      // 这行一个座都没持有，放旧座会把 sold 打成负数。
      throw new BadRequestError(RELEASED_LEG_NO_SCHEDULE_HINT('升舱'));
    }
    // ── 已标 no-show 的段不许升舱（与取消航段闸 11、改期同一道闸）──────────────
    // no-show = 客人没登机、钱与成本一分不动。给这一段升舱会真的搬座位、真的抬 total，
    // 而这段行程根本没有发生 —— 客人没上飞机却被收了升舱差价。
    if (readJsonObject(readJsonObject(item.metadata).noShow).at != null) {
      throw new BadRequestError(
        '该段已标 no-show（客人未登机），不能升舱；如需重新安排行程请另录一段航段。',
      );
    }
    // ── 已起飞的段不许升舱（与取消航段闸 10、改期同一道闸）──────────────────────
    // 升舱要「放经济舱座 + 拿商务舱座」，飞过的座位早被真实消耗掉（口径同 isLegAlreadyFlown）：
    // 放回去等于让过去的班次凭空多出可卖余位，还要对一段飞完的行程收升舱差价。
    if (isLegAlreadyFlown(item, Date.now())) {
      const sched = item.flightSchedule;
      const departAt = sched?.departureTime ?? null;
      const localWhen =
        departAt != null
          ? `${localDateISO(departAt, sched?.departureTz)} ${localHHMM(departAt, sched?.departureTz)}`
          : '时间未知';
      throw new BadRequestError(
        `该段已起飞（当地时间 ${localWhen} 出发），不能升舱。`,
      );
    }
    // 套餐机票腿：升舱份数/拆座由套餐加购模型管，售后升舱本次不覆盖。
    const meta = (item.metadata ?? {}) as Record<string, unknown> & { businessUpgradeCount?: unknown };
    const bundleUpgradeCount = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;
    if (item.bundleId || bundleUpgradeCount > 0) {
      throw new BadRequestError('套餐订单的机票行暂不支持一键升舱，请联系技术处理');
    }
    if (item.flightCabin !== CabinClass.ECONOMY) {
      throw new BadRequestError(
        `该行当前是${CABIN_ZH_LABEL[item.flightCabin] ?? item.flightCabin}，只有经济舱行可升舱到商务舱`,
      );
    }

    // 差价源：服务端权威取价（客户端传不进金额）。
    const schedule = await tx.flightSchedule.findUnique({
      where: { id: item.flightScheduleId },
      select: { id: true, flight: { select: { businessUpgradeCnyPerLeg: true } } },
    });
    const upgradeCnyPerLeg = schedule?.flight?.businessUpgradeCnyPerLeg ?? 0;
    if (upgradeCnyPerLeg <= 0) {
      throw new BadRequestError('该航班未配置商务舱差价，请先在航班管理维护');
    }
    const quantity = item.quantity;
    const diffCny = computeCabinUpgradeDiffCny(upgradeCnyPerLeg, quantity);

    // ── 座位对称搬移（同事务原子；任一步失败整单回滚，绝不出现「经济舱放了、商务舱没拿到」）──
    // 放座用 floored 版本（与状态机释放同口径，不会把 sold 打成负数）；拿座用 CAS（最终防超售）。
    await releaseSeatFloored(tx, item.flightScheduleId, CabinClass.ECONOMY, quantity);
    try {
      await takeSeatWithinTx(tx, item.flightScheduleId, CabinClass.BUSINESS, quantity, null);
    } catch (e) {
      // takeSeatWithinTx 的文案面向改期场景（「改期目标班次售罄」），这里换成升舱语境
      // ——错误类型不变（仍是 409），余位数字重新取一次，运营看到的就是本班次商务舱实况。
      if (e instanceof ConflictError) {
        const [businessSeat, lockedAgg] = await Promise.all([
          tx.flightSeatClass.findFirst({
            where: { scheduleId: item.flightScheduleId, cabin: CabinClass.BUSINESS },
            select: { capacity: true, sold: true },
          }),
          // 余位口径与 CAS 一致：他人未过期的 ACTIVE 锁位同样占着位子，不能算作「还剩」。
          tx.seatLock.aggregate({
            _sum: { qty: true },
            where: {
              seatClass: { scheduleId: item.flightScheduleId, cabin: CabinClass.BUSINESS },
              status: SeatLockStatus.ACTIVE,
              expiresAt: { gt: new Date() },
            },
          }),
        ]);
        const locked = lockedAgg._sum.qty ?? 0;
        const held = await heldSeatsForCabin(tx, item.flightScheduleId, CabinClass.BUSINESS);
        const remain = businessSeat
          ? Math.max(0, businessSeat.capacity - businessSeat.sold - locked - held)
          : 0;
        throw new ConflictError(
          `商务舱余位不足：升舱需要 ${quantity} 座，该班次商务舱仅剩 ${remain} 座`,
        );
      }
      throw e;
    }

    // ── 该行就地改舱 + 刷新描述快照（不改 amount：机票基础价不重算，差价单独成行）──
    const newDescription = buildUpgradedCabinDescription(item.description);
    await tx.orderItem.update({
      where: { id: item.id },
      data: {
        flightCabin: CabinClass.BUSINESS,
        description: newDescription,
        metadata: {
          ...meta,
          cabinUpgrade: {
            at: new Date().toISOString(),
            by: actor.userId,
            fromCabin: CabinClass.ECONOMY,
            toCabin: CabinClass.BUSINESS,
            upgradeCnyPerLeg,
            quantity,
            diffCny,
            note: input.note ?? null,
          },
        } as Prisma.InputJsonValue,
      },
    });

    // ── 差价成一条独立收入行（科目 UPGRADE_CHANGE = 升舱/改期收入）──
    const created = await tx.orderItem.create({
      data: {
        orderId,
        kind: OrderItemKind.UPGRADE_CHANGE,
        description: `升舱商务 ×${quantity}人`,
        quantity,
        unitPrice: new Prisma.Decimal(upgradeCnyPerLeg),
        amount: new Prisma.Decimal(diffCny),
        metadata: {
          source: 'CABIN_UPGRADE',
          sourceItemId: item.id,
          flightScheduleId: item.flightScheduleId,
          fromCabin: CabinClass.ECONOMY,
          toCabin: CabinClass.BUSINESS,
          upgradeCnyPerLeg,
          note: input.note ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    // ── 订单总额：与补录地面项同一口径（重算商品行合计，不走 adjustmentCny）──
    const subtotalBefore = round2(
      order.items.reduce((sum, row) => sum + Number(row.amount.toString()), 0),
    );
    const subtotalAfter = round2(subtotalBefore + diffCny);
    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: new Prisma.Decimal(subtotalAfter),
        total: new Prisma.Decimal(subtotalAfter),
      },
    });

    // 订单状态刻意不动：升舱不是改签，推 CHANGED 会污染改签流程与状态统计。
    return {
      orderNumber: order.orderNumber,
      orderItemId: item.id,
      upgradeItemId: created.id,
      scheduleId: item.flightScheduleId,
      fromCabin: CabinClass.ECONOMY,
      toCabin: CabinClass.BUSINESS,
      quantity,
      upgradeCnyPerLeg,
      diffCny,
      subtotalBefore,
      subtotalAfter,
    };
  });

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });
  return {
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
    audit: scratch,
  };
}

/**
 * 航班纠错（代理下单当天自助 / 运营任意时候）：把某条 FLIGHT 行改到正确的班次。
 *
 * 与「售后改期」的分工：改期是**行程真的变了**（航变/客人要改），要收改期费、撤立减、推状态；
 * 纠错是**录单当时就录错了**，本来就该是这个班次 —— 所以走 rescheduleOrderItem 的
 * correction 通道：差价恒 0、不撤立减、不推状态、不产生任何资金流水，只把座位从错的班次
 * 原子搬到对的班次（搬不动就整事务回滚，不泄漏、不超售）。
 *
 * 运营此前只有「批量纠错」一个入口（POST /orders/batch-reschedule），单张单要纠错只能借
 * 售后改期表单填 0 元 —— 本方法把单单纠错补齐，运营与代理共用同一条口径。
 *
 * 含套餐立减的单改班次仍旧拒绝（rescheduleOrderItem 内的既有闸，报「本单含套餐立减…」）：
 * 立减是按班次+晚数匹配出来的，换班次要重算补差 = 动钱，代理自助不能碰，得找运营。
 */
export async function correctFlightSchedule(
  svc: OrderService,
  orderId: string,
  itemId: string,
  newScheduleId: string,
  actor: { userId: string; role: UserRole; agentId?: string },
  options: { allowTicketed?: boolean } = {},
): ReturnType<OrderService['rescheduleOrderItem']> {
  await svc.assertAgentSelfEditAllowed(orderId, actor);
  const isOpsActor = actor.role === UserRole.ADMIN || actor.role === UserRole.STAFF;
  // 自助通道（代理）：同航班 + 同价才算「纠错」，否则是一次改价改产品的售后动作 → 走改单申请。
  if (!isOpsActor) {
    await svc.assertSelfServiceCorrectionIsFreeOfCharge(itemId, newScheduleId);
  }
  // 已出票单放行开关只认运营（L1）：代理带 allowTicketed 一律不认，仍旧被 forbidTicketed 拦住。
  const allowTicketed = isOpsActor && options.allowTicketed === true;
  return svc.rescheduleOrderItem(
    orderId,
    {
      orderItemId: itemId,
      newScheduleId,
      // 纠错永远不动钱：差价恒 0（请求体里根本没有金额字段，这里也不给任何注入口）。
      feeCny: 0,
      guard: { correction: true, forbidTicketed: !allowTicketed },
      selfServiceCorrection: true,
    },
    actor,
  );
}

/**
 * 纠错比价（只读，不写任何库）：本行现在的成交单价 vs 改到目标班次后**按建单口径**重算的单价。
 *
 * 用途有二：
 *   ① 自助纠错的同价闸（见 assertSelfServiceCorrectionIsFreeOfCharge）；
 *   ② 改单申请模块日后可以直接拿这个差额展示给运营（「代理想改到这一班，差 ¥X」），
 *      两处口径必须是同一份计算，不能各算各的。
 *
 * toPrice 走的就是建单给 FLIGHT 行定价的那条路（PricingService.calculatePrice 的
 * averageUnitPrice，按本行人数取平均），因此仓位阶梯 / 商务舱联动一并吃到。
 * 目标班次余位不够本行人数时 calculatePrice 会抛「余票仅 N 张」——那本来就是这次纠错做不成的
 * 真实原因（座位搬不过去），照原样抛给调用方，不在这里吞成一个假的价格。
 */
export async function quoteFlightCorrectionDelta(svc: OrderService, itemId: string, newScheduleId: string): Promise<{ fromPrice: number; toPrice: number; deltaCny: number; sameFlight: boolean }> {
  const item = await prisma.orderItem.findUnique({
    where: { id: itemId },
    select: {
      id: true,
      kind: true,
      quantity: true,
      unitPrice: true,
      flightScheduleId: true,
      flightCabin: true,
      flightSchedule: { select: { flightId: true } },
    },
  });
  if (!item) throw new NotFoundError('订单项不存在');
  if (item.kind !== OrderItemKind.FLIGHT || !item.flightScheduleId || !item.flightCabin) {
    throw new BadRequestError('该行不是持有座位的机票行，无法比价');
  }
  const target = await prisma.flightSchedule.findUnique({
    where: { id: newScheduleId },
    select: { id: true, flightId: true },
  });
  if (!target) throw new NotFoundError('目标班次不存在');

  const fromPrice = Number(item.unitPrice.toString());
  const pricing = await svc.pricing.calculatePrice(newScheduleId, item.flightCabin, item.quantity);
  const toPrice = pricing.averageUnitPrice;
  return {
    fromPrice,
    toPrice,
    deltaCny: round2(toPrice - fromPrice),
    sameFlight: item.flightSchedule?.flightId === target.flightId,
  };
}

/**
 * 自助纠错的「同航班 + 同价」硬闸（CRITICAL 修复）。
 *
 * 没有这道闸时，自助通道等于一个免费改产品的口子：纠错不重算金额（amount/quantity 明写不变），
 * 代理只要在窗口内把班次换成任意一趟更贵的航班，座位真的搬过去、一分差价都不收。
 * 纠错的定义是「本来就该录这一班」——所以只允许：
 *   · 同一 flightId 的别的日期/别的班次（录错出行日是最常见的录单错误）；
 *   · 且该班次同舱位按建单口径重算出来的单价与本行成交单价**完全相等**（差一分都不放）。
 * 任何一条不满足都不是纠错，是要动钱的售后改单 → 400 指路改单申请，由运营核价后执行。
 */
export async function assertSelfServiceCorrectionIsFreeOfCharge(svc: OrderService, itemId: string, newScheduleId: string): Promise<void> {
  const quote = await svc.quoteFlightCorrectionDelta(itemId, newScheduleId);
  if (!quote.sameFlight) {
    throw new BadRequestError('只能改到同一航班的其他日期，请提交改单申请由运营处理');
  }
  if (quote.deltaCny !== 0) {
    throw new BadRequestError(
      `目标班次价格与原班次不同（¥${quote.fromPrice} → ¥${quote.toPrice}），当日自助只能改同价班次，请提交改单申请由运营处理`,
    );
  }
}

// ════════════════════════════════════════════════════════════════════
// 按人改期（拆单 + 改期的组合闸口）：POST /orders/:id/reschedule-passengers
//
// 要解决的事：三人一单，只给其中一位客人改航班。
// 为什么不能就地改：一单一行程是全站硬约束 —— 去程/回程各一条 FLIGHT 行，开票占额、
// 座位统计、导出、hasReturnLeg 物化列全按「第 1 段=去程、第 2 段=回程」判。同一订单里
// 塞两条同航段不同班次的 FLIGHT 行，这些派生账会集体错乱。
// 于是走行业标准的 Split PNR：**先拆单、再对新单改期**。
//
// 两步刻意不套在同一个事务里（拆单与改期各自有自己的 $transaction、各自的行锁与守恒断言，
// 硬套嵌套会把两套锁序绞在一起）。因此存在「拆成了、改期没成」的中间态 —— 这是**可接受**的：
// 拆出来的新单本身是一张合法订单（钱与座位都守恒），不回滚；接口抛结构化 409 让运营到新单上
// 重试改期。同 requestToken 重试：拆单幂等回放 → 若新单已在目标班次则视为已完成（不重复收差价）。
// ════════════════════════════════════════════════════════════════════

/**
 * 按人改期：把选中乘客拆成新单后对新单改期；勾选全员则等价于整单改期（不拆单）。
 *
 * 金额：只透传 feeCny（改期差价，±上限由 schema 把关），份额/已收转移全由拆单服务端权威计算。
 * 座位：本方法自己不动座位 —— 拆单不动库存（两单加起来占同一批座），改期的「先放旧再原子拿新」
 *       守卫原样生效。
 */
export async function reschedulePassengers(
  svc: OrderService,
  orderId: string,
  input: {
    passengerIds: string[];
    orderItemId: string;
    newScheduleId: string;
    newCabin?: CabinClass;
    feeCny?: number;
    feeLabel?: string;
    note?: string;
    roomSplit?: Array<{ itemId: string; roomsBilledToMove: number }>;
    requestToken: string;
  },
  actor: { userId: string; role: UserRole },
): Promise<ReschedulePassengersResult> {
  if (!actorCan(actor, 'orders.reschedule')) {
    throw new ForbiddenError('仅运营/管理员可按人改期');
  }

  // ── 1. 读源单：乘客名册 + 带班次的机票行（判去程/回程用）──
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      passengers: { select: { id: true } },
      items: {
        // 不夹 flightScheduleId：全员分支要按 legActionLog 查这个 token 见过没有，
        // 而 no-show 释放 / 取消航段会把该行的班次置空 —— 只捞「有班次的行」就会漏掉
        // 那些行上留过的 token，同一个编号又能拿去改另一条活着的航段。
        // 判去程/回程的 determineFlightLegItems 自己就会滤掉无班次的行，不受影响。
        where: { kind: OrderItemKind.FLIGHT },
        select: {
          id: true,
          flightScheduleId: true,
          // metadata 供全员分支按 legActionLog 做 token 绑定的幂等回放判定。
          metadata: true,
          // departureTz 只为「已起飞」闸的人话文案（当地起飞时刻），与改期端点同一份折算。
          flightSchedule: { select: { departureTime: true, departureTz: true } },
        },
      },
    },
  });
  if (!order) throw new NotFoundError('订单不存在');

  const allPaxIds = new Set(order.passengers.map((p) => p.id));
  const movedIds = [...new Set(input.passengerIds)];
  if (movedIds.length === 0) throw new BadRequestError('请至少选择 1 位乘客');

  // ── 1b. 同 token 回放的入参比对，**排在乘客归属校验之前** ────────────────────
  //
  // 首次成功后被拆走的人已经不在源单上了：归属校验会抢先把「原样重试」判成
  // 400「所选乘客不属于本订单」，永远走不到拆单的幂等回放 —— 明明第一次已经拆成并改好了。
  // 反过来，换一批人（换成仍在源单的人）或换一个目标班次还沿用同一个 token，
  // splitOrder 按 (源单, token) 命中就静默回放上一轮那张新单，随后再对它改一次期：
  // 本次真正要动的人一个都没动，接口却返回 200，还可能重复计费。
  // 所以这里先按 (orderId, requestToken) 查拆单流水：
  //   · 命中且乘客集合与编排入参都一致 → 回放（跳过归属校验，走既有的新单改期判定）；
  //   · 命中但对不上 → 409，让前端换新请求编号重提；
  //   · 未命中 → 原有流程。
  const priorSplit = await prisma.orderSplitRecord.findUnique({
    where: {
      sourceOrderId_requestToken: { sourceOrderId: orderId, requestToken: input.requestToken },
    },
    select: {
      targetOrderId: true,
      targetOrder: { select: { orderNumber: true } },
      movedShareCny: true,
      movedPaidCny: true,
      passengerCount: true,
      snapshot: true,
    },
  });
  let replaySplit: SplitOrderResult | null = null;
  let replayLeg: 'OUTBOUND' | 'RETURN' | null = null;
  if (priorSplit) {
    const snapshot = readJsonObject(priorSplit.snapshot);
    const priorIdsRaw = snapshot.movedPassengerIds;
    const priorIds = Array.isArray(priorIdsRaw)
      ? priorIdsRaw.filter((v): v is string => typeof v === 'string').sort()
      : null;
    if (priorIds && JSON.stringify(priorIds) !== JSON.stringify([...movedIds].sort())) {
      throw tokenPayloadMismatchError(
        { reason: 'PASSENGERS', priorCount: priorIds.length, currentCount: movedIds.length },
        '这个请求编号已经用于另一批乘客，请刷新后用新的请求编号重试。',
      );
    }
    // 编排入参（目标航段行/班次/舱位/差价）比对。
    //
    // 老记录（本次改动之前落库的拆单流水）没留这一段 —— 一律 **fail-closed**，
    // 与本文件其它按 token 回放的动作（assertLegActionTokenReplay 的 LEGACY_SNAPSHOT
    // 分支）同一个口径。凭「乘客集合一致」就回放是不安全的：同一个 token 换个班次、
    // 换份差价重发，会照样回放上一轮那张新单、再对它改一次期，本次真正要改的没改，
    // 接口却返回 200。宁可让运营换个新请求编号重提一遍。
    const priorOrchestrationRaw = snapshot.orchestration;
    if (priorOrchestrationRaw == null || typeof priorOrchestrationRaw !== 'object') {
      throw tokenPayloadMismatchError(
        { reason: 'LEGACY_NO_FINGERPRINT' },
        '这条拆单记录没有留改期入参，无法确认是同一个请求，请用新的请求编号重试。',
      );
    }
    const priorOrchestration = readJsonObject(priorOrchestrationRaw);
    const current = reschedulePassengersOrchestration(input, null);
    // 键序无关地比：留档那份是从 JSONB 读回来的，键序未必还是当初写进去的样子，
    // 直接 JSON.stringify 两边比会把「原样重试」误判成「换了一份入参」。
    // 派生记录（leg）不参与比对 —— 它不是请求入参，正是这里还推不出来的那个值。
    if (orchestrationFingerprint(priorOrchestration) !== orchestrationFingerprint(current)) {
      throw tokenPayloadMismatchError(
        { reason: 'PAYLOAD', prior: priorOrchestration, current },
        '这个请求编号已经用于另一班次/另一份改期差价，请刷新后用新的请求编号重试。',
      );
    }
    // 首刷时派生出的航段：源单可能已经没有这一行了（整条机票行被搬走），
    // 回放要用它，不能再从当前源单推。
    replayLeg = readOrchestrationLeg(priorOrchestration.leg);
    replaySplit = {
      sourceOrderId: orderId,
      sourceOrderNumber: order.orderNumber,
      targetOrderId: priorSplit.targetOrderId,
      targetOrderNumber: priorSplit.targetOrder.orderNumber,
      movedShareCny: round2(Number(priorSplit.movedShareCny)),
      movedPaidCny: round2(Number(priorSplit.movedPaidCny)),
      passengerCount: priorSplit.passengerCount,
      replayed: true,
    };
  }

  // 回放命中时这批人已经不在源单上了，归属校验只会误伤；未命中才校验。
  if (!replaySplit) {
    const unknownIds = movedIds.filter((id) => !allPaxIds.has(id));
    if (unknownIds.length > 0) {
      throw new BadRequestError('所选乘客不属于本订单（可能已被换人/拆走），请刷新后重试');
    }
  }

  // ── 2. 把 orderItemId 解成航段（OUTBOUND / RETURN）──
  // 拆单后新单的订单行是**新 id**（整行搬走的行 id 不变、被拆的行是新建行），源单的行 id 在
  // 新单上不一定存在。所以这里在源单上一次性把「哪一段」定下来，改期时对新单按航段定位
  // （rescheduleOrderItem 的 leg 入口，与批量改航班同一条路径）。
  // 三段及以上的罕见单只认前两段（与开票六态、导出、hasReturnLeg 全站同口径）。
  //
  // 回放（1b 命中）时优先用快照里首刷派生出的那一段：首刷若把机票行**整条**搬去了新单
  // （比如成人全拆、源单只剩不占座的婴儿），源单已经没有这一行，按 orderItemId 推只能推空
  // —— 原样重试会在真正回放之前就吃 400，永远走不通。
  const sourceLegs = determineFlightLegItems(order.items);
  const derivedLeg: 'OUTBOUND' | 'RETURN' | null =
    sourceLegs.outbound?.id === input.orderItemId
      ? 'OUTBOUND'
      : sourceLegs.return?.id === input.orderItemId
        ? 'RETURN'
        : null;
  // 快照优先、现势兜底：回放要复现的是**首刷那一次**改的哪一段。源单在两次请求之间
  // 还可能被改过期（改晚了会让两条航段按出发时刻对调），这时按 orderItemId 现推出来的
  // 是另一段 —— 信现势就会拿错的那一段去改新单。快照没留（老记录）才回落到现势。
  const leg = replayLeg ?? derivedLeg;
  if (!leg) {
    throw new BadRequestError(
      '所选航段不是本订单的去程/回程机票行，无法按人改期，请刷新订单后重试',
    );
  }

  // ── 3. 全员勾选 → 没什么好拆的，直接走整单改期（与 PATCH /orders/:id/reschedule 同一条路径）──
  // 回放命中的请求一律走部分乘客那条路：首次已把人拆走，源单剩下的人可能比本次勾的还少，
  // 拿「勾的人数 ≥ 源单人数」去判会把一次重试误判成整单改期，对源单再改一次期。
  if (!replaySplit && movedIds.length >= allPaxIds.size) {
    // 3a. 幂等回放：**按 token 绑定**，不按「该行是否已经落在目标班次上」。
    //
    // 后者认不出请求编号：换一个新 token、换一份差价重发，只要班次恰好已经对上就照样
    // 回一个成功，本次真正要收的差价一分没收，运营看到的却是 200。
    // 现在与 no-show / 取消航段 / 恢复回程同一套机制：认这张单任一航段行 legActionLog 上
    // 见过的 token，动作类型必须是 RESCHEDULE_ALL、入参指纹必须一致，否则 409；
    // 老数据没有指纹一律 fail-closed（assertLegActionTokenReplay 内）。
    // 命中回放 → 返回当前订单，rescheduleSkipped=true，汇总审计不重复写。
    const tokenLookup = hasSeenLegActionToken(order.items, input.requestToken);
    if (tokenLookup.seen) {
      assertLegActionTokenReplay(tokenLookup, ['RESCHEDULE_ALL'], rescheduleAllFingerprint(input));
      const current = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: ORDER_FULL_INCLUDE,
      });
      return {
        order: serializeOrder(current, orderSerializeRoleCtx(actor.role)),
        newOrder: null,
        splitPerformed: false,
        audit: {
          orderNumber: order.orderNumber,
          newOrderId: null,
          newOrderNumber: null,
          passengerCount: movedIds.length,
          leg,
          orderItemId: input.orderItemId,
          toScheduleId: input.newScheduleId,
          feeCny: Math.trunc(input.feeCny ?? 0),
          splitReplayed: false,
          rescheduleSkipped: true,
          reschedule: null,
          split: null,
        },
      };
    }
    const { order: serialized, audit } = await svc.rescheduleOrderItem(
      orderId,
      {
        orderItemId: input.orderItemId,
        newScheduleId: input.newScheduleId,
        newCabin: input.newCabin,
        feeCny: input.feeCny,
        feeLabel: input.feeLabel,
        note: input.note,
        // 幂等键：改期与流水同一事务提交，下次同 token 重试据此回放（上面 3a）。
        requestToken: input.requestToken,
      },
      actor,
    );
    const result: ReschedulePassengersResult = {
      order: serialized,
      newOrder: null,
      splitPerformed: false,
      audit: {
        orderNumber: audit.orderNumber,
        newOrderId: null,
        newOrderNumber: null,
        passengerCount: movedIds.length,
        leg,
        orderItemId: input.orderItemId,
        toScheduleId: input.newScheduleId,
        feeCny: Math.trunc(input.feeCny ?? 0),
        splitReplayed: false,
        rescheduleSkipped: false,
        reschedule: audit,
        split: null,
      },
    };
    await svc._auditReschedulePassengers(result, actor, movedIds);
    return result;
  }

  // ── 3b. 已起飞的段：拆单**之前**就拦下（fail-closed）────────────────────────
  // 拆单不可回滚（新单是一张合法订单，撤不掉）。这道闸只跟「这一段飞没飞」有关、
  // 与勾了谁无关，晚到 rescheduleOrderItem 里才判就会留下一张多余的新单，
  // 而且新单同一航段照样已起飞，前端提示的「到新单上重试改期」永远走不通。
  // 判定与文案跟改期端点共用 assertLegNotFlownForReschedule（同一份时区折算）。
  const selectedLeg = leg === 'OUTBOUND' ? sourceLegs.outbound : sourceLegs.return;
  if (!replaySplit && selectedLeg) assertLegNotFlownForReschedule(selectedLeg);

  // ── 4. 部分乘客：先拆单（幂等，服务端权威算钱），失败则整体失败、什么都没发生 ──
  // 1b 已经命中并比对过入参时直接用那份回放结果，不必再进 splitOrder 兜一圈。
  const split =
    replaySplit ??
    (await svc.splitOrder(
      orderId,
      {
        passengerIds: movedIds,
        // roomSplit 可传可不传：不传时按人头自动派生（套餐单的住宿盖章就在套餐行上，
        // 运营在改期弹窗里根本看不到「酒店行」可填）。
        roomSplit: input.roomSplit,
        note: input.note,
        requestToken: input.requestToken,
        autoSplitRoomGroups: true,
        // 编排入参留档：下次同 token 重试时 1b 据此比对（换班次/换费用/换房数 → 409），
        // 并把这次派生出的航段一起留着，供源单已无该行时的回放使用。
        orchestration: reschedulePassengersOrchestration(input, leg),
      },
      actor,
    ));

  // ── 5. 对新单改期 ──
  // 幂等回放（同 token 重试）时先看新单是否已经落在目标班次上：已落 = 上一轮已改成，
  // 直接视为成功，绝不二次调用（否则 feeCny 会被再记一次流水，客人被重复收差价）。
  // 判定用「新单上任一机票行的班次 == 目标班次」而不是重新解航段：改到更晚的日期会让
  // 去/回程按出发时刻的排序对调，按航段回判会认错行。
  const targetFlightRows = await prisma.orderItem.findMany({
    where: {
      orderId: split.targetOrderId,
      kind: OrderItemKind.FLIGHT,
      flightScheduleId: { not: null },
    },
    select: { id: true, flightScheduleId: true },
  });
  const alreadyRescheduled =
    split.replayed && targetFlightRows.some((r) => r.flightScheduleId === input.newScheduleId);

  let rescheduleAudit: RescheduleOrderItemAudit | null = null;
  let newOrderSerialized: ReturnType<typeof serializeOrder> | null = null;
  if (!alreadyRescheduled) {
    try {
      const rescheduled = await svc.rescheduleOrderItem(
        split.targetOrderId,
        {
          leg,
          newScheduleId: input.newScheduleId,
          newCabin: input.newCabin,
          feeCny: input.feeCny,
          feeLabel: input.feeLabel,
          note: input.note,
        },
        actor,
      );
      newOrderSerialized = rescheduled.order;
      rescheduleAudit = rescheduled.audit;
    } catch (err) {
      // 拆单已提交、改期失败：**不回滚拆单**（新单是一张钱与座位都守恒的合法订单，
      // 回滚它反而要再搬一次钱）。抛结构化 409，前端据 code 提示「已拆出新单 X，
      // 改期未成功：原因；请到新单上重试改期」。同 requestToken 重试会走上面的回放分支。
      const reason = err instanceof Error ? err.message : '未知错误';
      throw new AppError(
        `已拆出新订单 ${split.targetOrderNumber}（${split.passengerCount} 人），但对新单改期未成功：${reason}。` +
          `拆单不会回滚，请到订单 ${split.targetOrderNumber} 上重试改期。`,
        {
          statusCode: 409,
          code: 'SPLIT_DONE_RESCHEDULE_FAILED',
          details: {
            splitPerformed: true,
            newOrderId: split.targetOrderId,
            newOrderNumber: split.targetOrderNumber,
            passengerCount: split.passengerCount,
            reason,
          },
        },
      );
    }
  }

  // ── 6. 回读两侧订单（改期返回的是新单；源单被拆过，须重读）──
  const [sourceRow, targetRow] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_FULL_INCLUDE }),
    newOrderSerialized
      ? Promise.resolve(null)
      : prisma.order.findUniqueOrThrow({
          where: { id: split.targetOrderId },
          include: ORDER_FULL_INCLUDE,
        }),
  ]);
  const roleCtx = orderSerializeRoleCtx(actor.role);
  const result: ReschedulePassengersResult = {
    order: serializeOrder(sourceRow, roleCtx),
    newOrder: newOrderSerialized ?? (targetRow ? serializeOrder(targetRow, roleCtx) : null),
    splitPerformed: true,
    audit: {
      orderNumber: order.orderNumber,
      newOrderId: split.targetOrderId,
      newOrderNumber: split.targetOrderNumber,
      passengerCount: split.passengerCount,
      leg,
      orderItemId: input.orderItemId,
      toScheduleId: input.newScheduleId,
      feeCny: Math.trunc(input.feeCny ?? 0),
      splitReplayed: split.replayed,
      rescheduleSkipped: alreadyRescheduled,
      reschedule: rescheduleAudit,
      split: { movedShareCny: split.movedShareCny, movedPaidCny: split.movedPaidCny },
    },
  };
  await svc._auditReschedulePassengers(result, actor, movedIds);
  return result;
}

/**
 * 按人改期的汇总审计（拆单的 SPLIT_ORDER×2 与改期的 RESCHEDULE_ORDER_ITEM 各自照记，
 * 这条只补「谁把哪几个人从哪张单挪到哪张单、改到哪个班次」的一览）。
 */
export async function _auditReschedulePassengers(
  svc: OrderService,
  result: ReschedulePassengersResult,
  actor: { userId: string; role: UserRole },
  movedPassengerIds: string[],
): Promise<void> {
  await writeAudit({
    actor: { userId: actor.userId, role: actor.role },
    action: 'RESCHEDULE_PASSENGERS',
    targetType: AuditTargetType.ORDER,
    targetId: result.audit.newOrderId ?? undefined,
    targetLabel: result.audit.newOrderNumber ?? result.audit.orderNumber,
    before: {
      sourceOrderNumber: result.audit.orderNumber,
      orderItemId: result.audit.orderItemId,
      leg: result.audit.leg,
      fromScheduleId: result.audit.reschedule?.fromScheduleId ?? null,
      movedPassengerIds,
    },
    after: {
      newOrderId: result.audit.newOrderId,
      newOrderNumber: result.audit.newOrderNumber,
      passengerCount: result.audit.passengerCount,
      toScheduleId: result.audit.toScheduleId,
      feeCny: result.audit.feeCny,
      splitPerformed: result.splitPerformed,
      splitReplayed: result.audit.splitReplayed,
      rescheduleSkipped: result.audit.rescheduleSkipped,
      movedShareCny: result.audit.split?.movedShareCny ?? null,
      movedPaidCny: result.audit.split?.movedPaidCny ?? null,
    },
    severity: AuditSeverity.CRITICAL,
  });
}

/**
 * 「这一段的座位已经放回库存了」的统一人话文案（改期 / 升舱共用）。
 * 之所以不复用「只能对机票行（FLIGHT）改期」那句：它会让运营以为自己点错了行，
 * 而真实原因是这行的 flightScheduleId 被 no-show 释放 / 取消航段置空了 —— 得给出下一步怎么做。
 */
export const RELEASED_LEG_NO_SCHEDULE_HINT = (action: string): string =>
  `该航段座位已释放（no-show 释放 / 取消航段），当前没有绑定班次，不能${action}；` +
  '如需重新安排，请先在订单详情点「恢复回程」。';

/** 单条改期的审计明细（按人改期把它原样透出，供路由记 RESCHEDULE_ORDER_ITEM）。 */
export type RescheduleOrderItemAudit = Awaited<
  ReturnType<OrderService['rescheduleOrderItem']>
>['audit'];

/** 按人改期的统一响应形状（POST /orders/:id/reschedule-passengers）。 */
export interface ReschedulePassengersResult {
  /** 源订单（部分乘客时 = 留守那张；全员改期时 = 改完期的本单）。 */
  order: ReturnType<typeof serializeOrder>;
  /** 拆出的新订单；全员改期（未拆单）时为 null。 */
  newOrder: ReturnType<typeof serializeOrder> | null;
  /** true = 走了拆单（部分乘客）；false = 全员改期，等价整单改期。 */
  splitPerformed: boolean;
  audit: {
    /** 源单号。 */
    orderNumber: string;
    newOrderId: string | null;
    newOrderNumber: string | null;
    passengerCount: number;
    leg: 'OUTBOUND' | 'RETURN';
    orderItemId: string;
    toScheduleId: string;
    feeCny: number;
    /** true = 同 requestToken 重试，拆单是幂等回放（本次没有拆出新单）。 */
    splitReplayed: boolean;
    /** true = 回放时新单已在目标班次，本次未再调用改期（不重复计改期差价）。 */
    rescheduleSkipped: boolean;
    /** 改期审计明细；rescheduleSkipped 时为 null。 */
    reschedule: RescheduleOrderItemAudit | null;
    /** 拆单搬走的份额与已收；未拆单时为 null。 */
    split: { movedShareCny: number; movedPaidCny: number } | null;
  };
}
