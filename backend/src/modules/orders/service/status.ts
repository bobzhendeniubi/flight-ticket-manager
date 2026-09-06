// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import {
  CabinClass,
  CommissionStatus,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  PaymentStatus,
  PrepaymentTxType,
  Prisma,
  ProductKind,
  RefundStatus,
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
  UnprocessableEntityError,
} from '../../../lib/errors.js';
import { sumCompletedRefundsWithinTx } from '../../../lib/funds-guard.js';
import {
  getHotelNightlyRemaining,
  getRandomTierAggregate,
} from '../../hotel-control/hotel-control.service.js';
import { normalizeCityCode } from '../../hotel-control/hotel-city.js';
import {
  assertOrderAllowsInvoicing,
  assertPassportExpiryForInvoicing,
  assertTicketingCap,
  countsTowardTicketingCap,
  determineFlightLegs,
} from '../ticketing-cap.js';
import { heldSeatsForCabin } from '../../hold-orders/held-seats.js';
import { FulfillmentStatus } from '@prisma/client';
import { buildStayNightDates } from './bundle-pricing.js';
import { createCommissionsForOrder } from './commission.js';
import { orderSerializeRoleCtx, serializeOrder } from './read.js';
import { computeBundleSeatSplit, isLegAlreadyFlown, releaseSeatFloored } from './seat-inventory.js';
import {
  actorCan,
  ALLOWED_TRANSITIONS,
  CABIN_ZH_LABEL,
  CHANGE_REQUESTABLE_STATUSES,
  FULFILLMENT_TERMINATING_STATUSES,
  ORDER_FULL_INCLUDE,
  type OrderRequester,
  round2,
  round2Decimal,
  SEAT_HOLDING_STATUSES,
  SEAT_RELEASING_STATUSES,
  zhStatus,
} from './shared.js';
import { createFulfillmentTasks } from './visa-sync.js';
import type { OrderService } from '../orders.service.js';

/**
 * 转正专用的正常收款状态收口。调用方无论是否实际生成结转 Payment 都必须调用：
 * carryCny=0 的零价订单同样按 effectivePayable <= paidAmount 推进 PAID。
 */
export async function advanceOrderToPaidIfClearedWithinTx(svc: OrderService, tx: Prisma.TransactionClient, orderId: string, requester: OrderRequester, pendingFulfillmentTaskIds: string[]): Promise<{ fullyPaid: boolean; status: OrderStatus }> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { status: true, total: true, adjustmentCny: true, paidAmount: true, prepaymentOffset: true },
  });
  if (!order) throw new NotFoundError('订单不存在');
  const effectivePayable = Number(order.total) + order.adjustmentCny;
  const paid = Number(order.paidAmount) + Number(order.prepaymentOffset);
  const fullyPaid = paid + 0.001 >= effectivePayable;
  if (fullyPaid && order.status === OrderStatus.PENDING_PAYMENT) {
    await svc._updateStatusWithinTx(
      tx,
      orderId,
      OrderStatus.PAID,
      requester,
      '占位单结转后订单已结清',
      pendingFulfillmentTaskIds,
    );
    return { fullyPaid: true, status: OrderStatus.PAID };
  }
  return { fullyPaid, status: order.status };
}

// ════════════════════════════════════════════════════════════════════
// 软删除（仅 ADMIN）
// ════════════════════════════════════════════════════════════════════
/**
 * 软删除订单：置 deletedAt，使订单从所有列表/导出/统计里消失，但整行数据保留可追溯。
 *
 * 前置守卫（CRITICAL）：只允许删「已释放座位」的订单——status ∈ SEAT_RELEASING_STATUSES
 *   (CANCELLED / PAYMENT_TIMEOUT / REFUNDED / FAILED / DRAFT)。仍占座的订单
 *   (SEAT_HOLDING_STATUSES) 拒删，提示先取消释放座位——绝不在删除里偷偷做释放
 *   （否则绕过状态机的座位账扣减，会把 sold 账做坏）。删除本身不触碰任何库存/座位账。
 *
 * 净收款守卫（CRITICAL）：状态守卫通过后，再查「净收款」= 已确认收款(order.paidAmount，
 *   增量维护的权威字段，覆盖人工确认收款/挂账认领/代理余额抵扣等全部入账路径) − 已完成退款
 *   (Refund.status=COMPLETED 之和；REQUESTED/APPROVED/PROCESSING/REJECTED 都不算——钱还在
 *   公司手上，没退出去)。净收款 > 0 → 拒删，防止「已取消但钱没退完」的订单被删掉后从所有
 *   列表消失、退款义务没人追。净收款 ≤ 0（零收款或已退平）才放行。
 *
 * 仅 ADMIN 可删（STAFF 不行）；返回删除前后的最小快照供路由层写审计。
 */
export async function softDeleteOrder(svc: OrderService, id: string, requester: OrderRequester) {
  if (!actorCan(requester, 'orders.delete')) {
    throw new ForbiddenError('仅内部员工可删除订单');
  }
  // 只找未删的订单（已删的再次删 → 视为不存在，幂等）
  const order = await prisma.order.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paidAmount: true,
      refunds: { where: { status: 'COMPLETED' }, select: { amount: true } },
    },
  });
  if (!order) throw new NotFoundError('订单不存在');

  if (SEAT_HOLDING_STATUSES.includes(order.status)) {
    throw new BadRequestError('该订单仍占用座位，请先取消订单释放座位，再删除');
  }
  // 双重保险：只有释放型状态才允许删（与守卫语义对称，防未来新增状态漏网）
  if (!SEAT_RELEASING_STATUSES.includes(order.status)) {
    throw new BadRequestError('该订单当前状态不允许删除');
  }

  const refundedTotal = order.refunds.reduce((sum, r) => sum + Number(r.amount), 0);
  const netReceived = round2(Number(order.paidAmount) - refundedTotal);
  if (netReceived > 0) {
    throw new BadRequestError(
      `该订单尚有已收款 ¥${netReceived.toFixed(2)} 未退，请先完成退款再删除`,
    );
  }

  const before = { id: order.id, orderNumber: order.orderNumber, status: order.status };
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { deletedAt: new Date() },
    select: { id: true, orderNumber: true, status: true, deletedAt: true },
  });
  return { before, after: updated };
}

/**
 * 恢复软删订单：deletedAt 置回 null，订单重新出现在所有列表/导出/统计。
 *
 * 不占座依据（CRITICAL）：软删本身从不改 status（见 softDeleteOrder），且只有
 * 已释放座位的订单（SEAT_RELEASING_STATUSES：CANCELLED/PAYMENT_TIMEOUT/REFUNDED/
 * FAILED/DRAFT）才被允许删除。因此凡在回收站里的订单，其状态都是释放型——恢复只是
 * 清 deletedAt 让它重新可见，绝不会凭空占座（不触碰任何库存/座位账），与删除对称。
 *
 * 仅 ADMIN 可恢复；返回 before/after 最小快照供路由层写审计。
 * 未删 / 不存在的订单 → NotFound（findFirst 只匹配 deletedAt 非空，幂等）。
 */
export async function restoreOrder(svc: OrderService, id: string, requester: OrderRequester) {
  if (!actorCan(requester, 'orders.delete')) {
    throw new ForbiddenError('仅内部员工可恢复订单');
  }
  const order = await prisma.order.findFirst({
    where: { id, deletedAt: { not: null } },
    select: { id: true, orderNumber: true, status: true, deletedAt: true },
  });
  if (!order) throw new NotFoundError('回收站中无此订单');

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { deletedAt: null },
    select: { id: true, orderNumber: true, status: true, deletedAt: true },
  });
  return { before: order, after: updated };
}

// ════════════════════════════════════════════════════════════════════
// 状态流转
// ════════════════════════════════════════════════════════════════════
export async function updateStatus(svc: OrderService, id: string, toStatus: OrderStatus, requester: OrderRequester, reason?: string, force?: boolean) {
  // 收集事务里创建的任务 id，提交后再入队（避免 worker 在 tx 提交前查不到）
  const pendingFulfillmentTaskIds: string[] = [];
  // 收集释放座位的舱位 id，提交后排队候补检查
  const releasedSeatClassIds: string[] = [];
  // 取消族恢复时被自动清除的开票标记提示（超出班次开票额度 → 清标记，要求票务台重开）
  const invoiceCapWarnings: string[] = [];

  const updated = await prisma.$transaction(async (tx) => {
    return svc._updateStatusWithinTx(
      tx,
      id,
      toStatus,
      requester,
      reason,
      pendingFulfillmentTaskIds,
      force,
      releasedSeatClassIds,
      invoiceCapWarnings,
    );
  });

  // 事务提交后 enqueue fulfillment jobs（若有）
  if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
    const { fulfillmentQueue } = await import('../../../queues/queue.js');
    for (const taskId of pendingFulfillmentTaskIds) {
      // 确定性 jobId = taskId 做去重，防重复 enqueue
      void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[orders] failed to enqueue fulfillment task:', e);
      });
    }
  }

  // 终态（PAID / CANCELLED / PAYMENT_TIMEOUT）都不再需要 seat-hold 兜底
  if (toStatus === 'PAID' || toStatus === 'CANCELLED' || toStatus === 'PAYMENT_TIMEOUT') {
    try {
      const { cancelSeatHoldRelease } = await import('../../../queues/queue.js');
      await cancelSeatHoldRelease(id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[orders] failed to cancel seat-hold job for', id, err);
    }
  }

  // 释放了座位 → 排队候补检查（best-effort，失败不阻塞状态流转）
  if (releasedSeatClassIds.length > 0) {
    try {
      const { enqueueWaitlistCheck } = await import('../../../queues/queue.js');
      await Promise.all(
        [...new Set(releasedSeatClassIds)].map((seatClassId) => enqueueWaitlistCheck(seatClassId)),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[orders] failed to enqueue waitlist-check for', id, err);
    }
  }

  // 对外脱敏按请求者角色：AGENT/CUSTOMER 自助改状态的返回也剥离内部字段（getOrder/listOrders 同口径）。
  // invoiceCapWarnings 只在「取消族恢复把开票标记清掉了」时出现，附在订单上带回给操作者
  //（没清就没有这个键，前端不必处理空数组）。
  const serialized = serializeOrder(updated, orderSerializeRoleCtx(requester.role));
  return invoiceCapWarnings.length > 0
    ? { ...serialized, invoiceCapWarnings: [...new Set(invoiceCapWarnings)] }
    : serialized;
}

/**
 * 批量状态流转（ADMIN/STAFF 后台用）。
 * 每个 id 独立 transaction，partial failure 不回滚成功项；返回 per-id 结果。
 */
export async function batchUpdateStatus(svc: OrderService, ids: string[], toStatus: OrderStatus, requester: OrderRequester, reason?: string, force?: boolean): Promise<{
    successCount: number;
    failureCount: number;
    results: Array<{
      id: string;
      success: boolean;
      orderNumber?: string;
      error?: string;
      /** 取消族恢复时被自动清除的开票标记提示（需票务台重开），无则不出现。 */
      warnings?: string[];
    }>;
  }> {
  const results: Array<{
    id: string;
    success: boolean;
    orderNumber?: string;
    error?: string;
    warnings?: string[];
  }> = [];
  let successCount = 0;
  let failureCount = 0;
  for (const id of ids) {
    try {
      const order = await svc.updateStatus(id, toStatus, requester, reason, force);
      // 逐单把「开票标记被清掉」的提示带回：批量恢复时这类单往往混在几十条里，
      // 不逐条回显就等于悄悄改了数据。
      const warnings = (order as { invoiceCapWarnings?: string[] }).invoiceCapWarnings;
      results.push({
        id,
        success: true,
        orderNumber: order.orderNumber,
        ...(warnings && warnings.length > 0 ? { warnings } : {}),
      });
      successCount += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      results.push({ id, success: false, error: message });
      failureCount += 1;
    }
  }
  return { successCount, failureCount, results };
}

// 旧的「订单级开票状态」写入口（setInvoiceStatus / PATCH /orders/:id/invoice-status）已删除
// （0716 H11b）：它是六态开票改造前的遗留，与现口径是两本账 ——
//   · 不走 assertOrderAllowsInvoicing（取消族/回收站单照样能标开票）；
//   · 写进的 Order.invoiceStatus 现在无人读：开票额度（ticketing-cap）、导出、财务口径
//     全部改看三个布尔位（outboundInvoiced / returnInvoiced / systemInvoiced）。
// 唯一写入口是 setInvoiceFlags（PATCH /orders/:id/invoice-flags）。数据列 invoiceStatus 保留
//（存量数据 + 换人 resetInvoice 仍会把它归零），只是不再有单独的写接口。

/**
 * 设置六态开票的三个布尔位（路由层限 ADMIN/STAFF）：去程 / 回程 / 系统 各自独立。
 *
 * 三道闸，都只在「从未开翻成已开」（false → true）时生效（翻回未开 / 无变化一律放行——
 * 死单纠错撤销错标记应当允许）：
 *   1. 订单状态闸（assertOrderAllowsInvoicing）：取消族（DRAFT/CANCELLED/PAYMENT_TIMEOUT/
 *      REFUNDED/FAILED）与软删单不许标开票 → 400。口径「能标开票」⟺「占额度」，
 *      与算额度复用同一份 COUNTED_STATUSES，两处不可能分叉。三个位都过这道闸。
 *   2. 护照有效期闸（assertPassportExpiryForInvoicing）：本航段涉及的乘客必须都有护照有效期
 *      → 缺 400，报文点名是谁缺。护照有效期「必填」只在建单路径生效，编辑/补录路径为了
 *      让存量空值旧单可编辑而放行空值 —— 这道闸是开票这一步的兜底，不改录入端。
 *      systemInvoiced 不对应航段、不校验。
 *   3. 班次开票上限（assertTicketingCap）：只校验正在翻开的那个航段对应的班次 → 超限 422。
 *      systemInvoiced 不占班次额度、不校验（但仍过状态闸）。
 *
 * 去程/回程班次由订单 FLIGHT 行按 departureTime 升序判定（determineFlightLegs）。
 * 校验 + 更新同包一个事务，缩小并发开票越限窗口。
 */
export async function setInvoiceFlags(svc: OrderService, id: string, flags: { outboundInvoiced?: boolean; returnInvoiced?: boolean; systemInvoiced?: boolean }): Promise<{
    id: string;
    orderNumber: string;
    outboundInvoiced: boolean;
    returnInvoiced: boolean;
    systemInvoiced: boolean;
  }> {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id },
      select: {
        orderNumber: true,
        status: true,
        deletedAt: true,
        outboundInvoiced: true,
        returnInvoiced: true,
        systemInvoiced: true,
        // passengerType 供座位口径（婴儿不占座）；姓名 + 护照有效期供开票护照闸报错文案。
        passengers: {
          select: {
            passengerType: true,
            fullName: true,
            chineseName: true,
            passportExpiry: true,
          },
        },
        items: {
          where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
          select: {
            flightScheduleId: true,
            flightSchedule: { select: { departureTime: true, departureTz: true } },
          },
        },
      },
    });
    if (!order) throw new NotFoundError('订单不存在');

    // 本单要占的开票**座位**数：婴儿有票无座，不占库存 —— 必须与计数侧
    //（countIssuedPassengers 同样跳过 INFANT）严格同口径。此前这里传的是含婴儿的总人数，
    // 于是每个带婴儿的订单都比它实际占的座多算一个，班次快满时会把合法开票误判成超限。
    const seatPassengerCount = order.passengers.filter(
      (p) => p.passengerType !== PassengerType.INFANT,
    ).length;

    // 开票标记状态闸：只挡「翻成已开」（false → true）——取消族/软删单不占班次额度，
    // 标了开票位对 191 上限完全隐形，却会进导出、让财务口径失真（见 assertOrderAllowsInvoicing）。
    // 翻回「未开」不挡：死单纠错撤销错标记应当允许（与资金闸「只挡进钱不挡退钱」同构）。
    const turningAnyFlagOn =
      (flags.outboundInvoiced === true && !order.outboundInvoiced) ||
      (flags.returnInvoiced === true && !order.returnInvoiced) ||
      (flags.systemInvoiced === true && !order.systemInvoiced);
    if (turningAnyFlagOn) assertOrderAllowsInvoicing(order);

    const { outboundScheduleId, returnScheduleId } = determineFlightLegs(order.items);

    // 去程：从 false → true 且有去程班次时校验护照有效期 + 该班次上限
    if (flags.outboundInvoiced === true && !order.outboundInvoiced && outboundScheduleId) {
      assertPassportExpiryForInvoicing(order.orderNumber, '去程', order.passengers);
      await assertTicketingCap(tx, [outboundScheduleId], seatPassengerCount);
    }
    // 回程：从 false → true 且有回程班次时校验护照有效期 + 该班次上限
    if (flags.returnInvoiced === true && !order.returnInvoiced && returnScheduleId) {
      assertPassportExpiryForInvoicing(order.orderNumber, '回程', order.passengers);
      await assertTicketingCap(tx, [returnScheduleId], seatPassengerCount);
    }

    return tx.order.update({
      where: { id },
      data: {
        ...(flags.outboundInvoiced !== undefined && { outboundInvoiced: flags.outboundInvoiced }),
        ...(flags.returnInvoiced !== undefined && { returnInvoiced: flags.returnInvoiced }),
        ...(flags.systemInvoiced !== undefined && { systemInvoiced: flags.systemInvoiced }),
      },
      select: {
        id: true,
        orderNumber: true,
        outboundInvoiced: true,
        returnInvoiced: true,
        systemInvoiced: true,
      },
    });
  });

  // ── TICKETED 派生·反向自动（2026-07-20 拍板「合一」）：航段标记翻齐 → 订单自动推进 ──
  // 票务台标完最后一段，订单从 PROCESSING 自动进「出票完成」，运营不用再手动改一次状态。
  // 只在 PROCESSING 时推（PAID 还没进处理、其它状态不该被开票动作牵着走）；
  // 推进失败绝不回滚开票标记（标记是事实，状态推进只是跟随），静默放过。
  try {
    const after = await prisma.order.findUnique({
      where: { id },
      select: {
        status: true,
        outboundInvoiced: true,
        returnInvoiced: true,
        items: {
          where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
          select: { flightScheduleId: true },
        },
      },
    });
    if (after && after.status === OrderStatus.PROCESSING) {
      const legCount = new Set(after.items.map((it) => it.flightScheduleId)).size;
      const legsDone =
        legCount >= 1 &&
        after.outboundInvoiced &&
        (legCount < 2 || after.returnInvoiced);
      if (legsDone) {
        await svc.updateStatus(
          id,
          OrderStatus.TICKETED,
          // 系统调用者的两个标识都给全（缺一不可，且互为兜底）：
          //   · actorType:'SYSTEM' —— _updateStatusWithinTx 判定系统调用者的**显式**依据；
          //   · userId 前缀 'system-' —— 同一处判定的字符串兜底口径（连字符，不是冒号）。
          // 判定为系统调用者后，OrderStatusEvent.actorUserId 才会写 null。写成非系统调用者
          // 会拿这个假 userId 去撞 actorUserId → User(id) 外键，P2003 回滚整个推进事务，
          // 而下方 catch 又把异常吞掉 —— 功能会静默失效（用户完全看不见）。
          { userId: 'system-auto-ticketed', role: UserRole.ADMIN, actorType: 'SYSTEM' },
          '航段开票标记齐全，自动推进「出票完成」（TICKETED 派生口径）',
        );
      }
    }
  } catch (err) {
    // 自动推进失败不影响开票标记本身（如并发状态变化），故不回滚、不抛出；
    // 但必须留痕 —— 静默吞掉会让「标齐后订单会自动推进」这句承诺失效而无人察觉。
    // eslint-disable-next-line no-console
    console.error('[orders] failed to auto-advance order to TICKETED for', id, err);
  }

  return updated;
}

/**
 * 批量设置六态开票的三个布尔位（票务岗批量操作，ADMIN/STAFF）。
 * 逐单复用 setInvoiceFlags（保持其班次开票上限校验语义不变），每单独立事务，
 * 单单失败（如超班次开票上限）不影响其余单；逐单结果 + 汇总一并返回，
 * 供路由层逐单写审计、前端展示成功/失败清单（失败列出订单号+原因）。
 */
export async function batchSetInvoiceFlags(svc: OrderService, ids: string[], flags: { outboundInvoiced?: boolean; returnInvoiced?: boolean; systemInvoiced?: boolean }): Promise<{
    succeeded: number;
    failed: number;
    results: Array<{
      id: string;
      orderNumber?: string;
      ok: boolean;
      error?: string;
      outboundInvoiced?: boolean;
      returnInvoiced?: boolean;
      systemInvoiced?: boolean;
    }>;
  }> {
  const results: Array<{
    id: string;
    orderNumber?: string;
    ok: boolean;
    error?: string;
    outboundInvoiced?: boolean;
    returnInvoiced?: boolean;
    systemInvoiced?: boolean;
  }> = [];
  let succeeded = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const order = await svc.setInvoiceFlags(id, flags);
      results.push({
        id,
        orderNumber: order.orderNumber,
        ok: true,
        outboundInvoiced: order.outboundInvoiced,
        returnInvoiced: order.returnInvoiced,
        systemInvoiced: order.systemInvoiced,
      });
      succeeded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      results.push({ id, ok: false, error: message });
      failed += 1;
    }
  }
  return { succeeded, failed, results };
}

/**
 * 事务内执行状态流转 —— 供 payments.handleCallback 等外部事务复用。
 * 调用方负责包 $transaction 且提交后 enqueue newTaskIdsOut 里的任务。
 */
export async function _updateStatusWithinTx(svc: OrderService, tx: Prisma.TransactionClient, id: string, toStatus: OrderStatus, requester: OrderRequester, reason: string | undefined, newTaskIdsOut: string[], force?: boolean, releasedSeatClassIdsOut?: string[], invoiceCapWarningsOut?: string[]) {
  const order = await tx.order.findUnique({
    where: { id },
    // 联查班次出发时刻：下面的「释放座位」分支要据此跳过已起飞的航段（见那里的注释）。
    include: { items: { include: { flightSchedule: { select: { departureTime: true } } } } },
  });
  if (!order) throw new NotFoundError('订单不存在');
  // 软删单（回收站）不设防的破口：findUnique 无 deletedAt 过滤时，ADMIN 可对回收站单
  // force→PAID 造"隐形占座单"（订单显示已支付并重新占座，却从所有列表/统计里消失）。
  // 状态流转入口一律拒绝已软删订单——要操作请先 restoreOrder 恢复。软删本身从不改 status
  // （见 softDeleteOrder），所以这里绝不会误伤任何正常流转。
  if (order.deletedAt) {
    throw new BadRequestError('订单在回收站（已软删），不可做状态流转；如需操作请先恢复');
  }
  await svc.assertCanTransition(order, toStatus, requester);

  const allowed = ALLOWED_TRANSITIONS[order.status];
  // ADMIN 可用 force=true 跳过状态机；其他角色或非 force 调用走标准检查
  const isAdminForce = force === true && actorCan(requester, 'orders.force_status');
  if (!allowed.includes(toStatus) && !isAdminForce) {
    // 高频误操作单独给指引：已收款的单不能一键取消——钱账要走退款通道，申请后机位立即释放。
    const cancelPaidHint =
      toStatus === 'CANCELLED' && allowed.includes('REFUND_REQUESTED')
        ? '。已收款订单不能直接取消：请改为「退款申请中」，提交申请后机位立即释放，财务处理完成后订单关闭'
        : '';
    throw new BadRequestError(
      `不允许从「${zhStatus(order.status)}」转移到「${zhStatus(toStatus)}」` +
        `（当前可转：${allowed.map(zhStatus).join('、') || '无'}）${cancelPaidHint}`,
    );
  }

  // ── TICKETED 派生闸（2026-07-20 拍板「合一」）：订单级「出票完成」不再是第二本账——
  // 它是航段开票标记的派生：有航段的单，去程（及往返单的回程）标记没打齐就不许推进。
  // 唯一真源在票务台的航段标记；标记翻齐会自动推进（见 setInvoiceFlags 尾部），
  // 这里的手动推进只在标记已齐时放行。纯地面单（无航段）无票可出，放行不拦。
  // ADMIN force 可跳过（应急通道，审计照记）。
  if (toStatus === OrderStatus.TICKETED && !isAdminForce) {
    const inv = await tx.order.findUnique({
      where: { id },
      select: {
        outboundInvoiced: true,
        returnInvoiced: true,
        items: {
          where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
          select: { flightScheduleId: true },
        },
      },
    });
    const legCount = new Set((inv?.items ?? []).map((it) => it.flightScheduleId)).size;
    if (legCount >= 1 && !inv?.outboundInvoiced) {
      throw new BadRequestError(
        '去程尚未标记开票，不能推进到「出票完成」。请先在票务台标记去程已开票——标齐后订单会自动推进。',
      );
    }
    if (legCount >= 2 && !inv?.returnInvoiced) {
      throw new BadRequestError(
        '回程尚未标记开票，不能推进到「出票完成」。请先在票务台标记回程已开票——标齐后订单会自动推进。',
      );
    }
  }

  // ── REFUND_REQUESTED 账目闸（与下方 →REFUNDED 的账目闸对称）────────────────────
  // 状态机把 PAID/PROCESSING/TICKETED/CHANGED/FAILED → REFUND_REQUESTED 全部放行且零校验，
  // 于是「退款申请中」可以是一张**没有任何 Refund 记录**的空壳：座位当场释放、订单从所有
  // 有效口径里消失，却既没有应退报价、也没有可批准的对象 —— 下一步 →REFUNDED 被账目闸拦死，
  // 退回 PROCESSING 又要重新抢座位，这单就此卡住，实收与佣金两头挂着谁也对不平。
  // 口径：进 REFUND_REQUESTED 必须已有一条**未终结**的 Refund（REQUESTED/APPROVED/PROCESSING）。
  // 唯一正门是 POST /orders/:id/cancel —— 它先按取消策略算出应退报价、建 Refund，再推本状态。
  // **admin force 同样拦**：与 →REFUNDED 一致，这是账目完整性，force 是用来跳状态机的，不是跳账的。
  if (toStatus === OrderStatus.REFUND_REQUESTED) {
    const pendingRefundCount = await tx.refund.count({
      where: {
        orderId: id,
        status: {
          in: [RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING],
        },
      },
    });
    if (!(pendingRefundCount > 0)) {
      throw new BadRequestError(
        `订单 ${order.orderNumber} 还没有待处理的退款申请，不能直接置为「退款申请中」——` +
          `那会让订单座位当场释放却没有任何应退金额可批准，最终既退不出去也回不来。` +
          `请改用订单详情页的「取消订单」：系统会按取消策略算出应退明细并生成退款申请，` +
          `再由财务批准退款。`,
      );
    }
  }

  // ── CHANGED 派生闸（与上方 TICKETED 派生闸同构）─────────────────────────────
  // 「已改期」不是一个可以手点的标签，而是**改期动作真的发生过**的派生：改期端点
  //（rescheduleOrderItem）搬完座位后会在被改的 FLIGHT 行 metadata 上落 flightChanged 标记，
  // 并在同一事务里推进本状态。手动 CHANGE_REQUESTED→CHANGED 若不校验，就会出现「订单写着
  // 已改期、航段还是原班次」——旅客照原班次出行、客服照新状态答复，且改期费/立减补差全部落空。
  // ADMIN force 可跳过（应急通道，审计照记；也用于放行改期标记出现之前的存量单）。
  if (toStatus === OrderStatus.CHANGED && !isAdminForce) {
    const flightRows = await tx.orderItem.findMany({
      where: { orderId: id, kind: OrderItemKind.FLIGHT },
      select: { metadata: true },
    });
    const hasFlightChangedMark = flightRows.some((row) => {
      const meta = row.metadata;
      if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return false;
      return (meta as Record<string, unknown>).flightChanged != null;
    });
    if (!hasFlightChangedMark) {
      throw new BadRequestError(
        `订单 ${order.orderNumber} 没有任何航段被改期过，不能置为「已改期」——` +
          `否则状态说已改、航段还是原班次，旅客会按原航班出行。` +
          `请先用订单详情页的「改期」把航段改到新班次（改完订单会自动进入「已改期」）。`,
      );
    }
  }

  const wasHolding = SEAT_HOLDING_STATUSES.includes(order.status);
  const isReleasing = SEAT_RELEASING_STATUSES.includes(toStatus);
  // 与 isReleasing 对称：目标状态是否落入"占座中"集合 —— 下面「非占座 → 占座」重新占座分支要用。
  // 覆盖 force 路径（如 PAYMENT_TIMEOUT →(force) PAID）：座位释放时已经还库存，
  // 拉回占座状态若不重新扣座，会出现"状态已占座、库存却没扣"的幽灵持有，导致超卖。
  const isNewHolding = SEAT_HOLDING_STATUSES.includes(toStatus);

  // 硬规则（即使 admin force 也不许）：已退款（REFUNDED）是终态，不允许"复活"回占座/已支付状态。
  // 强转虽已修佣金幂等 + 重新占座，但 Refund 记录会永久停在 COMPLETED、订单却回到 PAID，
  // 收款/退款账目对不上；要重开须走正规重新下单，而非把退款单强拉回有效状态。
  if (order.status === 'REFUNDED' && isNewHolding) {
    throw new BadRequestError(
      '订单已退款（终态），不能强制拉回占座/已支付状态；如需重开请重新下单',
    );
  }

  const isSystemActor = requester.actorType === 'SYSTEM' || requester.userId.startsWith('system-');

  // ── 批准退款前：锁单重校应退额（资金守恒断言）────────────────────────────
  // 下方「Refund 状态同步」会把本单所有 REQUESTED Refund 一次性 updateMany 成 COMPLETED，
  // 按的是**创建退款申请那一刻的 amount 快照**：既不重读 paidAmount、也不重新报价。
  // 若在「申请退款」与「批准退款」之间 paidAmount 被压低（典型：多付被转存代理余额/挂账池），
  // 快照就会大于实收 —— 照付即净流出 > 净流入（收 1500 付 2000）。
  // Order 行锁救不了：Refund 行从没被锁，完成时也没有任何复核。
  //
  // 这里加的是「退出去的钱不能多过收进来的钱」这条守恒断言：
  //   Σ(已完成退款) + Σ(本次将完成的 REQUESTED 退款) ≤ 当前 paidAmount
  // 已完成退款必须计入：退款完成不减 paidAmount（只翻 Refund 状态），
  // 不计入就会「分两次各退一半额度」把同一笔钱退两遍。
  //
  // 按**合计**而非逐条校验：updateMany 一次翻全部 REQUESTED，逐条看各自都可能 ≤ paidAmount，
  // 合计却超收（如 paid 1000、两条各 600）—— 逐条校验会放行，合计校验才拦得住。
  //
  // 为什么只断言、不在此处重新报价：报价是「申请那一刻对客户做出的承诺」，退改费按起飞前时长分档，
  // 批准晚了就重算会让客户平白少拿钱 —— 那是业务口径变更，需拍板，不该混进堵漏。
  // 断言则是客观的资金守恒，无需任何业务口径输入，且覆盖所有压低 paidAmount 的路径（不止多付转存）。
  // 触发时 fail-closed：抛错回滚，Refund 留在 REQUESTED 等人工按最新口径重新报价，绝不擅自少退。
  // 转 REFUNDED 时需要在事务后半段回补的代理预存余额（口径见下方注释）。null = 无需回补。
  let prepaymentRestore: { agentId: string; amountCny: number } | null = null;
  const rejectRequestedRefunds = async (): Promise<void> => {
    let requestedRefunds: Array<{ gatewayPayload: Prisma.JsonValue }> = [];
    if (order.status === OrderStatus.REFUND_REQUESTED) {
      requestedRefunds = (await tx.refund.findMany({
        where: { orderId: id, status: RefundStatus.REQUESTED },
        select: { gatewayPayload: true },
      })) ?? [];
    }
    await tx.refund.updateMany({
      where: { orderId: id, status: 'REQUESTED' },
      data: { status: 'REJECTED', processedAt: new Date() },
    });

    const hasSwapRefund = requestedRefunds.some((refund) => {
      const payload = refund.gatewayPayload;
      return payload !== null && typeof payload === 'object' && !Array.isArray(payload) &&
        (payload as Record<string, unknown>).swapRefund === true;
    });
    if (hasSwapRefund) {
      // 驳回后订单回到可处理状态，换人标记必须一并撤销，否则后续普通退款仍会被误标为换人退款。
      await tx.order.update({
        where: { id },
        data: {
          swapRefundedAt: null,
          swapFeeCny: null,
          swapReplacementOrderNumber: null,
        },
      });
    }
  };

  if (toStatus === 'REFUNDED') {
    // FOR UPDATE 行锁：与多付转存/挂账池/到账入账（均先对 Order 行 FOR UPDATE）串行——
    // 并发的多付处置要么排在本事务前（paidAmount 已降低 → 本断言拦下），
    // 要么排在后（订单已 REFUNDED → 处置闸拦下）。两头都堵死，无窗口可钻。
    const lockedRows = await tx.$queryRaw<Array<{ paidAmount: Prisma.Decimal }>>`
      SELECT "paidAmount" FROM "Order" WHERE id = ${id} FOR UPDATE
    `;
    const paidAmount = lockedRows[0]?.paidAmount ?? order.paidAmount;

    // ── 账目完整性闸：落 REFUNDED 必须有对应的 Refund 记录 ────────────────
    // 下方「Refund 状态同步」用的是 updateMany(status: REQUESTED)：若这张单从未走过
    // cancel 退款流程（典型：直接 PATCH status FAILED→REFUND_REQUESTED→REFUNDED，
    // 每一步都在状态机白名单里、无需 force），updateMany 影响 0 行，订单照样落 REFUNDED。
    // 后果是这笔钱被永久卡死：实收原封挂在单上、佣金却按全额冲销，而撤销认款 / 转挂账池 /
    // 软删全被资金闸封死（REFUNDED 在三道闸里都是黑名单），谁也对不平。
    // 所以一律要求先有 Refund（REQUESTED 或 COMPLETED）——**admin force 同样拦**：
    // 这是账目完整性，不是流程便利性，force 是用来跳状态机的，不是用来跳账的。
    const refundRecordCount = await tx.refund.count({
      where: { orderId: id, status: { in: [RefundStatus.REQUESTED, RefundStatus.COMPLETED] } },
    });
    if (refundRecordCount === 0) {
      throw new BadRequestError(
        `订单 ${order.orderNumber} 没有任何退款记录，不能置为「已退款」——` +
          `否则实收会永久挂在单上、既退不出去也冲销不掉（已退款是终态，三道资金闸全部封死）。` +
          `请改走退款流程：POST /orders/${id}/cancel 生成退款申请（含应退报价），再批准退款。`,
      );
    }

    const pendingAgg = await tx.refund.aggregate({
      where: { orderId: id, status: RefundStatus.REQUESTED },
      _sum: { amount: true },
    });
    const pendingSum = pendingAgg._sum.amount ?? new Prisma.Decimal(0);
    const completedSum = new Prisma.Decimal(await sumCompletedRefundsWithinTx(tx, id));
    const totalRefundOut = completedSum.add(pendingSum);
    const paidNum = round2(Number(paidAmount.toString()));
    const totalRefundOutCny = round2(Number(totalRefundOut.toString()));

    // ── 本单的预存余额抵扣额：按 PrepaymentTransaction 流水现算 ─────────────
    // 绝不读 Order.prepaymentOffset：那一列没有任何生产代码写入（恒为 0），照它算出来的
    // 「余额部分」恒为 0 —— 预存抵付过的单退款时余额永远回不来（钱在系统里凭空消失）。
    // 唯一真源是流水：applyAgentBalanceToOrder 每次抵扣写一条 OFFSET（负数），
    // 本分支每次回补写一条 REFUND（正数）。
    //   已抵扣毛额 offsetGross     = |Σ OFFSET.amount|
    //   已回补     alreadyRestored = Σ REFUND.amount（幂等基准：分批批准退款不重复回补）
    // 关键口径：抵扣当时已经把金额累加进 order.paidAmount（见 applyAgentBalanceToOrder），
    // 所以 paidAmount 是「现金 + 余额抵扣」的合计，不是纯现金 ——
    //   · 资金守恒基数就是 paidAmount 本身，绝不能再把 offsetGross 加一次（等于凭空放宽退款上限）；
    //   · 真·现金 realCash = max(0, paidAmount − offsetGross)，做现金/余额拆分时用它当现金侧上限。
    // realCash 按**毛额**而非净额算：回补不减 paidAmount，用净额会让已回补的部分在下一次
    // 分批批准时摇身变成「现金」，同一笔钱退两遍。
    // 无归属代理的单直接跳过查询：applyAgentBalanceToOrder 硬要求 order.agentId 才能抵扣，
    // 而有 OFFSET 时改归属被硬阻断（见 changeOrderAgent）—— agentId 为空 ⇒ 必然没有 OFFSET 流水。
    const balanceLedger = order.agentId
      ? await tx.prepaymentTransaction.findMany({
          where: {
            orderId: id,
            type: { in: [PrepaymentTxType.OFFSET, PrepaymentTxType.REFUND] },
          },
          select: { agentId: true, amount: true, type: true },
        })
      : [];
    const offsetRows = balanceLedger.filter((r) => r.type === PrepaymentTxType.OFFSET);
    const offsetGrossCny = round2(
      offsetRows.reduce((s, r) => s + Math.abs(Number(r.amount.toString())), 0),
    );
    const alreadyRestoredCny = round2(
      balanceLedger
        .filter((r) => r.type === PrepaymentTxType.REFUND)
        .reduce((s, r) => s + Number(r.amount.toString()), 0),
    );
    const realCashCny = Math.max(0, round2(paidNum - offsetGrossCny));

    if (totalRefundOutCny > paidNum + 0.001) {
      throw new BadRequestError(
        `订单 ${order.orderNumber} 应退合计 ¥${totalRefundOutCny.toFixed(2)} 已超过实收 ¥${paidNum.toFixed(2)}` +
          `（现金 ¥${realCashCny.toFixed(2)} + 预存余额抵扣 ¥${offsetGrossCny.toFixed(2)}），` +
          `不能批准退款（退出去的钱不能多过收进来的钱）。` +
          `常见原因：申请退款后多付已被转存代理余额或挂账池，或此前已退过款。` +
          `请财务核对实收与已退金额后，驳回本次申请并按最新口径重新发起。`,
      );
    }

    // ── 预存余额回补（PrepaymentTxType.REFUND，此前是从未被写入的死枚举）────
    // 拆分口径与 lib/cancellation.ts 的 splitRefundBetweenCashAndBalance 同源
    //（现金优先：改期费先从现金里消耗，应退先退现金、退不下的部分回余额）；
    // 差别只在这里的「现金」是扣掉余额抵扣后的 realCash，而那边收到的 paidAmount 是合计值。
    // 这里刻意内联而不是 import：orders.service.test.ts 用 vi.mock 整体替换了
    // '../../lib/cancellation.js'，静态引用会在该测试里变成 undefined。改这段务必同步改那边。
    const adjustmentCny = round2(Number(order.adjustmentCny ?? 0));
    const cashCapacityCny = Math.max(0, round2(realCashCny - adjustmentCny));
    const refundToCashCny = round2(Math.min(totalRefundOutCny, cashCapacityCny));
    // 这是**累计**应回补额（不是本次增量）：夹在 offsetGross 以内，绝不回补超过当初抵扣掉的余额。
    const refundToBalanceCny = round2(
      Math.min(offsetGrossCny, Math.max(0, round2(totalRefundOutCny - refundToCashCny))),
    );
    const restoreNowCny = round2(refundToBalanceCny - alreadyRestoredCny);
    if (restoreNowCny > 0) {
      // 回补对象取流水上的代理，而不是 order.agentId：抵扣掉的是当时那个代理账户的钱。
      // 有 OFFSET 时改归属已被硬阻断（见 changeOrderAgent），正常不会分叉；真分叉了就
      // fail-closed 交人工 —— 把 A 的钱补给 B 是比「补不上」更坏的错误。
      const restoreAgentIds = [...new Set(offsetRows.map((r) => r.agentId))];
      if (restoreAgentIds.length > 1) {
        throw new BadRequestError(
          `订单 ${order.orderNumber} 的预存余额抵扣涉及多个代理账户，无法自动回补余额。` +
            `请财务先手工冲回各代理的抵扣流水，再批准本次退款。`,
        );
      }
      prepaymentRestore = { agentId: restoreAgentIds[0], amountCny: restoreNowCny };
    }
  }

  // ── 原子 CAS：where 附加当前状态，防并发重复转移（如两个支付回调同时来）──
  const extraData: Record<string, unknown> = { status: toStatus };
  // 转 PAID 不再"因为转成 PAID 这个动作本身"就把 paidAmount 抬到 total（旧口径 = 隐式收款：
  // STAFF/ADMIN 经 PATCH status 把订单 PENDING_PAYMENT→PAID 即"已收全款"，实收与流水永久对不上）。
  // 新口径：paidAmount 只反映**真实到账证据**，取以下两者的较大值，绝不凭空补满额——
  //   1. 调用方已累加进 order.paidAmount 的到账（人工确认 / 挂账认领 / 代理余额抵扣；其中余额抵扣
  //      走 prepaymentTransaction，不进 Payment 台账，故必须认 order.paidAmount）。
  //   2. Payment 台账里 SUCCEEDED 合计（支付网关回调此刻已在同一事务把本笔 Payment 置 SUCCEEDED，
  //      但没有累加 order.paidAmount —— 靠这里按台账把 paidAmount 抬到实收，同时天然保留多付）。
  // 无任何证据（如 admin force→PAID 但没有收款流水）→ 保留 order.paidAmount 原值：订单可显示 PAID，
  // 但尾款/应收余额如实 > 0（财务报表可见"标记已付但未收齐"），绝不伪造已收。若确需"标记已付且无流水"，
  // 应做成显式的、带审计与警示的独立操作，不混进普通状态流转（本次不实现）。
  if (toStatus === 'PAID') {
    // R5（lost update 收口）：聚合 SUCCEEDED Payment 之前先对本 Order 行 FOR UPDATE，
    // 与人工确认 / 挂账认领 / 代理余额抵扣（均先对 Order 行 FOR UPDATE 后累加 paidAmount）串行——
    // 事务内读到最新 paidAmount（而非本函数开头 findUnique 的无锁旧快照），避免"读旧快照 → 写
    // paidAmount"覆盖并发到账。行锁一直持到本事务提交。
    const lockedRows = await tx.$queryRaw<Array<{ paidAmount: Prisma.Decimal }>>`
      SELECT "paidAmount" FROM "Order" WHERE id = ${id} FOR UPDATE
    `;
    const currentPaidNum = Number((lockedRows[0]?.paidAmount ?? order.paidAmount).toString());
    const paymentsAgg = await tx.payment.aggregate({
      _sum: { amount: true },
      where: { orderId: id, status: PaymentStatus.SUCCEEDED },
    });
    const paymentsSumNum = Number((paymentsAgg._sum.amount ?? new Prisma.Decimal(0)).toString());
    if (paymentsSumNum > currentPaidNum) {
      extraData.paidAmount = new Prisma.Decimal(paymentsSumNum);
    }
    // else：不写 paidAmount（保留已记录的到账，含多付与"无证据"两种情形）。
  }

  const casResult = await tx.order.updateMany({
    where: { id, status: order.status },
    data: extraData,
  });
  if (casResult.count !== 1) {
    throw new ConflictError(`订单状态已被并发修改（期望「${zhStatus(order.status)}」，请重试）`);
  }

  await tx.orderStatusEvent.create({
    data: {
      orderId: id,
      fromStatus: order.status,
      toStatus,
      actorUserId: isSystemActor ? null : requester.userId,
      reason,
    },
  });

  if (wasHolding && isReleasing) {
    const releaseSeat = async (
      scheduleId: string,
      cabin: import('@prisma/client').CabinClass,
      qty: number,
    ): Promise<void> => {
      if (qty <= 0) return;
      await releaseSeatFloored(tx, scheduleId, cabin, qty);
      // 收集释放座位的舱位 id —— 调用方提交事务后排队候补检查
      if (releasedSeatClassIdsOut) {
        const sc = await tx.flightSeatClass.findFirst({
          where: { scheduleId, cabin },
          select: { id: true },
        });
        if (sc) releasedSeatClassIdsOut.push(sc.id);
      }
    };

    const releaseAt = Date.now();
    for (const item of order.items) {
      if (item.kind !== 'FLIGHT' || !item.flightScheduleId || !item.flightCabin) continue;
      // ⚠ 已起飞的航段不放座：那些座位已经被真实消耗掉了（飞机飞走了），
      // 把它们「还」回 FlightSeatClass.sold 等于让一个过去的班次凭空多出可卖余位 ——
      // 而且这条路径最常被走到的正是「客人 no-show 之后订单被取消/退款」，一放就错。
      // 未来的航段照常释放（订单确实不再持有它们）。
      // 判定走共享 helper isLegAlreadyFlown，与下面的重新占座分支同一口径（两处必须对称）。
      if (isLegAlreadyFlown(item, releaseAt)) continue;
      // 套餐升舱拆座的镜像还原：经济舱行下单时拆了 businessUpgradeCount 个座到商务舱，
      // 退座时也要按同一拆分各退各舱（否则会少退商务舱、多退经济舱）。
      const meta = (item.metadata ?? {}) as { businessUpgradeCount?: unknown };
      const rawUpgrade = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;
      const split = computeBundleSeatSplit(item.flightCabin, item.quantity, rawUpgrade);
      await releaseSeat(item.flightScheduleId, 'BUSINESS', split.business);
      await releaseSeat(item.flightScheduleId, item.flightCabin, split.sameCabin);
    }
  } else if (!wasHolding && isNewHolding) {
    // 驳回退款申请会同时恢复酒店/套餐占房。订单状态 CAS 已在上面完成，
    // 因而同一事务里的房控查询会把本单重新计入；任一受管控晚变成负余量就整单回滚，
    // 避免只回座位却静默恢复成超售房单。
    if (order.status === OrderStatus.REFUND_REQUESTED && toStatus === OrderStatus.PROCESSING) {
      await svc.assertRefundRejectionHotelCapacity(tx, order.items);
    }

    // 释放分支的镜像：订单从「非占座」状态被拉回「占座中」状态（主要是 admin force 路径，
    // 如 PAYMENT_TIMEOUT/CANCELLED/FAILED →(force) PAID/PROCESSING）—— 座位早已在释放时
    // 还给库存，这里必须重新占座，否则订单变成"幽灵持有"：状态显示占座，FlightSeatClass.sold
    // 却没有对应扣减，余票会被超卖。用与 createOrder 完全相同的原子 CAS（含他人 ACTIVE 锁位口径
    // + 套餐升舱拆座），任何一段余位不足就整单抛错，事务回滚，订单状态不落地（不会出现"半占座"）。
    const retakeSeat = async (
      scheduleId: string,
      cabin: import('@prisma/client').CabinClass,
      qty: number,
      itemLabel: string,
    ): Promise<void> => {
      if (qty <= 0) return;
      if (typeof tx.$queryRaw === 'function') {
        await tx.$queryRaw`
          SELECT id FROM "FlightSeatClass"
          WHERE "scheduleId" = ${scheduleId} AND cabin = ${cabin}::"CabinClass"
          FOR UPDATE
        `;
      }
      // 锁位语义与下单/改期时一致：他人的 ACTIVE 未过期锁位占用余票（订单本人的锁位不挡自己；
      // 游客单 order.userId=null → 不排除任何人，所有 ACTIVE 锁位都占余票）
      const lockedAgg = await tx.seatLock.aggregate({
        _sum: { qty: true },
        where: {
          seatClass: { scheduleId, cabin },
          ...(order.userId ? { userId: { not: order.userId } } : {}),
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
        if (order.status === OrderStatus.REFUND_REQUESTED && toStatus === OrderStatus.PROCESSING) {
          throw new BadRequestError(
            `座位已被售出，无法驳回退款申请，请协调换班次或继续退款。${itemLabel}需要${qty}个座位，当前仅剩${available}个。`,
          );
        }
        throw new BadRequestError(
          `恢复为持有座位状态需重新占座：${itemLabel}（${CABIN_ZH_LABEL[cabin] ?? '当前舱位'}）余位不足，无法转换：需要 ${qty} 张，仅剩 ${available} 张`,
        );
      }
    };

    const retakeAt = Date.now();
    for (const item of order.items) {
      if (item.kind !== 'FLIGHT' || !item.flightScheduleId || !item.flightCabin) continue;
      // ⚠ 与上面放座分支**严格对称**：已起飞的航段当初释放时就没放（座位早被飞机带走了），
      // 这里也不能重新占回来 —— 一占就是给一个飞过去的班次凭空加一份 sold，
      // 那份 sold 此后没有任何路径会释放（订单再落取消族时同样被这道闸跳过），永久卡账。
      // 最常见的走法正是「客人去程 no-show → 单被取消 → 运营 force 拉回」这条。
      // 判定走共享 helper isLegAlreadyFlown，与上面放座分支同一口径（两处必须对称）。
      if (isLegAlreadyFlown(item, retakeAt)) continue;
      // 套餐升舱拆座：与下单/释放同一口径，按 businessUpgradeCount 分拆两舱各自占座
      // （否则会少占商务舱、多占经济舱，或漏占其中一段）。
      const meta = (item.metadata ?? {}) as { businessUpgradeCount?: unknown };
      const rawUpgrade = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;
      const split = computeBundleSeatSplit(item.flightCabin, item.quantity, rawUpgrade);
      await retakeSeat(item.flightScheduleId, 'BUSINESS', split.business, item.description);
      await retakeSeat(item.flightScheduleId, item.flightCabin, split.sameCabin, item.description);
    }
  }

  // ── 取消族恢复：复检班次开票额度（0716 H11）────────────────────────────────
  // 开票额度只统计 COUNTED_STATUSES 的订单（见 ticketing-cap.ts）。订单落取消族时它占的
  // 开票额度当场释放，那份额度随即可能被别的单开走；此后 force 把这张单拉回计数态，
  // 它带着的开票标记会**凭空补回来**，班次瞬间越过座位库存上限，而全流程无一处会察觉
  //（写标记的闸只在标记翻开时跑，状态流转从不看开票位）。
  // 口径：本单已在上方 CAS 成新状态、因而已计入 countIssuedPassengers，故按「新增 0 人」复检
  //（issued 已含本单）。超限则清掉该航段的开票标记 + 回警示语，让票务台按最新额度重新标 ——
  // 宁可要求重开，也不留一个把班次撑爆的隐形标记。
  if (!countsTowardTicketingCap(order.status) && countsTowardTicketingCap(toStatus)) {
    const inv = await tx.order.findUnique({
      where: { id },
      select: {
        outboundInvoiced: true,
        returnInvoiced: true,
        items: {
          where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
          select: {
            flightScheduleId: true,
            flightSchedule: { select: { departureTime: true } },
          },
        },
      },
    });
    if (inv && (inv.outboundInvoiced || inv.returnInvoiced)) {
      const { outboundScheduleId, returnScheduleId } = determineFlightLegs(inv.items);
      const legsToRecheck: Array<{
        scheduleId: string;
        field: 'outboundInvoiced' | 'returnInvoiced';
        label: string;
      }> = [];
      if (inv.outboundInvoiced && outboundScheduleId) {
        legsToRecheck.push({
          scheduleId: outboundScheduleId,
          field: 'outboundInvoiced',
          label: '去程',
        });
      }
      if (inv.returnInvoiced && returnScheduleId) {
        legsToRecheck.push({
          scheduleId: returnScheduleId,
          field: 'returnInvoiced',
          label: '回程',
        });
      }
      const clearedFlags: Partial<Record<'outboundInvoiced' | 'returnInvoiced', boolean>> = {};
      for (const leg of legsToRecheck) {
        try {
          await assertTicketingCap(tx, [leg.scheduleId], 0);
        } catch (err) {
          if (!(err instanceof UnprocessableEntityError)) throw err;
          clearedFlags[leg.field] = false;
          invoiceCapWarningsOut?.push(
            `订单 ${order.orderNumber} 恢复为「${zhStatus(toStatus)}」后，${leg.label}班次的开票额度已被占满，` +
              `已自动清除该航段的开票标记（${err.message}）。请票务台核对后重新标记开票。`,
          );
        }
      }
      if (Object.keys(clearedFlags).length > 0) {
        await tx.order.update({ where: { id }, data: clearedFlags });
      }
    }
  }

  if (toStatus === 'PAID') {
    // R4（双通道到账账目分叉收口）：订单转 PAID 后，把该订单其它仍 PENDING 的 Payment 作废——
    // 否则它们的回调后续到达仍会被标 SUCCEEDED，而此刻已过了 PAID 分支的聚合点，那笔钱在
    // paidAmount 上"消失"、多付不可见（无 creditOverpayToAgent/overpayToPool 处置入口）。
    // 枚举无 CANCELLED/SUPERSEDED，用 FAILED + gatewayPayload.supersededByPaid 标记作废：
    //   · 常见情形（客户只真付了一笔，其余 PENDING 是弃单/多次尝试）→ 作废即清理，其回调被拒。
    //   · 若被作废的那笔后来真收到网关回调（客户确实又付了一次）→ handleCallback 认此标记，
    //     把金额计入 paidAmount 形成可见多付（point 3），绝不让真实到账消失。
    // 幂等：只动 PENDING（本次驱动 PAID 的那笔在调用方已置 SUCCEEDED，天然被排除，不会误伤）。
    await tx.payment.updateMany({
      where: { orderId: order.id, status: PaymentStatus.PENDING },
      data: {
        status: PaymentStatus.FAILED,
        gatewayPayload: {
          supersededByPaid: true,
          supersededAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    if (order.agentId) {
      // 带上 orderNumber：零计提审计要能让人凭订单号直接查（函数内部再查一次会多一次事务内往返）。
      await createCommissionsForOrder(tx, order.id, order.agentId, order.orderNumber);
    }
    const newIds = await createFulfillmentTasks(tx, order.id);
    newTaskIdsOut.push(...newIds);
  }

  // REFUND_REQUESTED 只是先释放库存，不代表退款已批准：此时不能冲销佣金，
  // 否则驳回退款回到 PROCESSING 后无法恢复佣金。REFUND_REQUESTED → REFUNDED
  // 虽然座位账是「释放 → 释放」，仍需在真正批准退款时执行原有佣金冲销。
  const shouldReverseCommissions =
    isReleasing &&
    toStatus !== OrderStatus.REFUND_REQUESTED &&
    order.status !== OrderStatus.PENDING_PAYMENT &&
    (wasHolding || order.status === OrderStatus.REFUND_REQUESTED);
  if (shouldReverseCommissions) {
    // 退款/取消时按比例冲销佣金（保证会计恒等：座位退了，已退的那部分佣金不能继续欠代理）。
    //
    // 冲销口径（按实退金额比例，分 ProductKind）：
    //   - 仅在「批准退款」(REFUNDED) 时按比例冲销：读本次推进的 Refund 快照
    //     gatewayPayload.quoteSnapshot.items[]，按 productKind 聚合
    //     refundRatio = Σ退款额 / Σ(退款额+退改费)（= Σ退款额 / Σ该类已付金额），
    //     clamp 到 [0,1]。平台留存的退改费对应的那部分佣金保留（不冲销）。
    //   - 其余「释放型」流转（CANCELLED / PAYMENT_TIMEOUT / FAILED）以及无法解析快照的
    //     旧退款 → 整单全额冲销（ratio=1，旧行为不变，绝不少冲）。
    //
    // 两类记录分别处理，以免破坏「已结算快照」：
    //   - ACCRUED（尚未进结算单）：
    //       · 全额（ratio>=1）→ 直接置 REVERSED（旧行为，期内净额自然归零）。
    //       · 部分（0<ratio<1）→ 原 ACCRUED 保留全额 + 新建一条「负数补偿记录」
    //         （amount/baseAmount 取负 × ratio、REVERSED、settlementId=null）；
    //         结算时 earned(+全额) 与补偿(−比例额) 相抵，净 = 原额 ×(1−ratio)，
    //         留存退改费对应的佣金可见可对账。
    //   - SETTLED（代理已在某张结算单里被结过账）：历史快照是冻结的，绝不回改；
    //     新建一条「负数补偿记录」（amount/baseAmount = −原额 × ratio、REVERSED、
    //     settlementId=null），让下一期结算把这笔负数净掉（跨期反冲），既追回多付
    //     又不污染上一张已支付结算单。负数 + REVERSED + settlementId=null 即是
    //     补偿记录的自识别标志（schema 无 note/source 列，故不另加列）。
    const refundRatioByKind = await svc._computeRefundRatioByKind(tx, id, toStatus);

    const liveRecords = await tx.commissionRecord.findMany({
      where: {
        orderId: order.id,
        status: { in: [CommissionStatus.ACCRUED, CommissionStatus.SETTLED] },
      },
    });

    for (const rec of liveRecords) {
      const ratio = refundRatioByKind.get(rec.productKind) ?? 0;
      if (ratio <= 0) continue; // 该 ProductKind 未退（快照里没有）→ 不冲销

      if (ratio >= 1) {
        if (rec.status === CommissionStatus.ACCRUED) {
          // 全额 + 尚未结算 → 翻状态（旧行为，最省记录）
          await tx.commissionRecord.update({
            where: { id: rec.id },
            data: { status: CommissionStatus.REVERSED },
          });
          continue;
        }
        // 全额 + 已结算 → 负数补偿记录（M1-A 跨期反冲，整额）
        await tx.commissionRecord.create({
          data: {
            agentId: rec.agentId,
            orderId: rec.orderId,
            productKind: rec.productKind,
            baseAmount: rec.baseAmount.negated(),
            rate: rec.rate,
            amount: rec.amount.negated(),
            chainDepth: rec.chainDepth,
            status: CommissionStatus.REVERSED,
            settlementId: null,
          },
        });
        continue;
      }

      // 0 < ratio < 1 → 按比例：负数补偿记录（ACCRUED 与 SETTLED 同样处理；
      // ACCRUED 原记录保留全额，靠补偿记录净掉退款部分，留存退改费佣金不动）。
      const ratioDec = new Prisma.Decimal(ratio);
      const clawBase = round2Decimal(rec.baseAmount.mul(ratioDec));
      const clawAmount = round2Decimal(rec.amount.mul(ratioDec));
      if (clawAmount.lessThanOrEqualTo(0)) continue; // 防御：四舍五入后无金额可冲

      await tx.commissionRecord.create({
        data: {
          agentId: rec.agentId,
          orderId: rec.orderId,
          productKind: rec.productKind,
          baseAmount: clawBase.negated(),
          rate: rec.rate,
          amount: clawAmount.negated(),
          chainDepth: rec.chainDepth,
          status: CommissionStatus.REVERSED,
          settlementId: null,
        },
      });
    }
  }

  // 同步 Refund 状态：当订单走到终态 / 退款被拒回退时，关联的 REQUESTED Refund 应该相应推进，
  // 绝不能让它永久停在 REQUESTED。
  //   REFUNDED                       → Refund.COMPLETED + processedAt（管理员批准退款）
  //   CANCELLED                      → Refund.REJECTED（管理员拒绝退款，订单回滚到取消但不退）
  //   REFUND_REQUESTED → 其它态       → Refund.REJECTED（退款被拒回退，典型是 →PROCESSING）
  // （这是给 admin PATCH /orders/:id/status 兜底；前面 requestCancellation 创建的 Refund
  //  停在 REQUESTED 等待这一步推进）
  if (toStatus === 'REFUNDED') {
    await tx.refund.updateMany({
      where: { orderId: id, status: 'REQUESTED' },
      data: { status: 'COMPLETED', processedAt: new Date() },
    });

    // 预存余额回补：客户当初用代理余额抵付的那部分，退款完成时必须原路退回余额账户，
    // 否则这笔钱在系统里凭空消失（余额侧扣过一笔 OFFSET，却永远收不回来）。
    // 金额已在本函数前半段按「现金优先」口径算好并做过幂等去重（见 prepaymentRestore 处注释）。
    // 锁序与 applyAgentBalanceToOrder 一致（先 Order 后 Agent，两处都 FOR UPDATE）→ 不会死锁。
    if (prepaymentRestore) {
      const agentRows = await tx.$queryRaw<Array<{ prepaymentBalance: Prisma.Decimal }>>`
        SELECT "prepaymentBalance" FROM "Agent" WHERE id = ${prepaymentRestore.agentId} FOR UPDATE
      `;
      if (agentRows[0]) {
        const balanceAfter = round2(
          Number(agentRows[0].prepaymentBalance.toString()) + prepaymentRestore.amountCny,
        );
        await tx.agent.update({
          where: { id: prepaymentRestore.agentId },
          data: { prepaymentBalance: new Prisma.Decimal(balanceAfter) },
        });
        await tx.prepaymentTransaction.create({
          data: {
            agentId: prepaymentRestore.agentId,
            amount: new Prisma.Decimal(prepaymentRestore.amountCny), // 正数 = 退回余额
            balanceAfter: new Prisma.Decimal(balanceAfter),
            type: PrepaymentTxType.REFUND,
            orderId: id,
            description: `订单 ${order.orderNumber} 退款：余额抵扣部分 ¥${prepaymentRestore.amountCny.toFixed(2)} 退回预存余额`,
            createdById: requester.userId,
          },
        });
      }
    }
  } else if (toStatus === 'CANCELLED') {
    await rejectRequestedRefunds();
  } else if (order.status === 'REFUND_REQUESTED') {
    // 退款申请被拒 → 订单从 REFUND_REQUESTED 退回其它态（状态机允许 →PROCESSING；admin force 也可能
    // 拉到别处）。若不把停在 REQUESTED 的 Refund 置 REJECTED，会永久卡死：
    //   · requestCancellation 的幂等分支（order.refunds status=REQUESTED）会一直命中陈旧 Refund，
    //     客户再也无法发起新的取消申请；
    //   · 未来真退款时又会用这条陈旧快照算佣金冲销比例，账目错乱。
    await rejectRequestedRefunds();
  }

  // 履约任务终态化（取消族）：订单落 CANCELLED/REFUNDED/PAYMENT_TIMEOUT/FAILED 时，把该订单
  // 仍 PENDING/IN_PROGRESS 的履约任务一并置 CANCELLED（同事务）。否则任务只被列表查询过滤隐藏、
  // 仍是活动态：force 把订单拉回占座态即"复活"，且统计口径数不到已取消。
  //   · 与 resetVisa（换人重开签证任务，把 VISA 任务 PENDING 化）语义不冲突：那是"重开"，这里是"终态化"。
  //   · worker 已跳过 CONFIRMED/CANCELLED 任务，故即便 ENABLE_AUTO_FULFILLMENT 已入队 job，转 CANCELLED 后被跳过。
  if (FULFILLMENT_TERMINATING_STATUSES.includes(toStatus)) {
    await tx.fulfillmentTask.updateMany({
      where: {
        orderItem: { orderId: id },
        status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS] },
      },
      data: { status: FulfillmentStatus.CANCELLED, completedAt: new Date() },
    });
  }

  return tx.order.findUniqueOrThrow({
    where: { id },
    include: {
      items: true,
      passengers: true,
      payments: true,
      refunds: true,
      statusEvents: { orderBy: { createdAt: 'asc' } },
      agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
      user: { select: { id: true, displayName: true, email: true } },
    },
  });
}

/**
 * 驳回退款申请前校验本单 HOTEL/BUNDLE 行的逐晚房量。
 *
 * 这里复用 hotel-availability / bundle-availability 的床位余量口径：
 *   - 具体酒店：getHotelNightlyRemaining（酒店级包房周期 + 有效订单占房）；
 *   - 随机档/占位酒店：getRandomTierAggregate（同星级真酒店合计 − 未落位占用）。
 * 订单状态已在本事务内 CAS 为 PROCESSING，所以当前订单已经被计入 used；只需检查
 * 受管控夜晚是否出现负余量。未配置包房周期的日期按既有口径不拦截。
 */
export async function assertRefundRejectionHotelCapacity(svc: OrderService, tx: Prisma.TransactionClient, items: ReadonlyArray<{
      kind: OrderItemKind;
      hotelRoomTypeId: string | null;
      randomStarTier: number | null;
      hotelCheckIn: Date | null;
      hotelCheckOut: Date | null;
    }>): Promise<void> {
  const hotelRows = items.filter(
    (item) =>
      (item.kind === OrderItemKind.HOTEL || item.kind === OrderItemKind.BUNDLE) &&
      item.hotelCheckIn &&
      item.hotelCheckOut,
  );
  if (hotelRows.length === 0) return;

  const roomTypeIds = [
    ...new Set(
      hotelRows
        .map((item) => item.hotelRoomTypeId)
        .filter((id): id is string => id != null),
    ),
  ];
  const roomTypes =
    roomTypeIds.length > 0
      ? await tx.hotelRoomType.findMany({
          where: { id: { in: roomTypeIds } },
          select: {
            id: true,
            hotelId: true,
            hotel: { select: { randomTierPlaceholder: true, cityCode: true } },
          },
        })
      : [];
  const roomTypeById = new Map(roomTypes.map((roomType) => [roomType.id, roomType]));

  const shortage = (result: { remaining: number[]; block: number[]; hasBlock: boolean }): boolean =>
    result.hasBlock &&
    result.remaining.some((remaining, index) => (result.block[index] ?? 0) > 0 && remaining < 0);

  const checked = new Set<string>();
  for (const item of hotelRows) {
    const nightDates = buildStayNightDates(item.hotelCheckIn!, item.hotelCheckOut!);
    if (nightDates.length === 0) continue;

    let scopeKey: string;
    let result: { remaining: number[]; block: number[]; hasBlock: boolean };
    const roomType = item.hotelRoomTypeId ? roomTypeById.get(item.hotelRoomTypeId) : undefined;
    const randomTier = item.randomStarTier ?? roomType?.hotel.randomTierPlaceholder ?? null;
    if (randomTier != null) {
      // 城市：占位酒店行取占位酒店的；单独随机行没有酒店 → 存量默认城市（normalizeCityCode 的空值回落）
      const randomCity = normalizeCityCode(roomType?.hotel.cityCode);
      scopeKey = `random:${randomCity}:${randomTier}:${nightDates.join(',')}`;
      if (checked.has(scopeKey)) continue;
      checked.add(scopeKey);
      const aggregate = await getRandomTierAggregate(
        { tier: randomTier, cityCode: randomCity },
        nightDates,
        {},
        tx,
      );
      result = aggregate;
    } else if (roomType) {
      scopeKey = `hotel:${roomType.hotelId}:${nightDates.join(',')}`;
      if (checked.has(scopeKey)) continue;
      checked.add(scopeKey);
      result = await getHotelNightlyRemaining(roomType.hotelId, nightDates, tx);
    } else {
      // 异常历史行没有可解析的房型/随机档作用域；保持既有宽松口径，不臆造库存来源。
      continue;
    }

    if (shortage(result)) {
      throw new BadRequestError('房量已被售出，无法驳回退款申请，请协调换房或继续退款');
    }
  }
}

/**
 * 计算「本次释放型流转应冲销多少佣金」的比例（按 ProductKind）。
 *
 * 规则：
 *   - 非 REFUNDED（CANCELLED / PAYMENT_TIMEOUT / FAILED 等）→ 整单全额冲销：
 *     所有 ProductKind 一律返回 ratio=1（取消语义不变，不按比例）。
 *   - REFUNDED（批准退款）→ 按「实退金额」比例分类冲销：
 *     读本次被推进的 Refund（status=REQUESTED，下一步会被翻 COMPLETED）的
 *     gatewayPayload.quoteSnapshot.items[]，按 item.kind 聚合
 *       refundedByKind = Σ refundAmount
 *       revenueByKind  = Σ (refundAmount + feeAmount)   // = 该类已付金额
 *       ratio[kind]    = clamp(refundedByKind / revenueByKind, 0, 1)
 *     未出现在快照里的 ProductKind → Map 无键 → 调用方按 0 处理（不冲销）。
 *   - 无可解析快照（旧退款 / 脏数据）→ 退回整单全额冲销（所有键缺失但返回哨兵：
 *     这里用 fullReversalAllKinds=true 表示"对任何 kind 都 ratio=1"，绝不少冲）。
 *
 * 返回一个 Map<ProductKind, number>；为简化调用方，缺省键即 0。
 * 当需要"对所有 kind 都全额冲销"时，预填全部 ProductKind 为 1。
 *
 * ⚠️ 不变式：ALL_PRODUCT_KINDS 必须覆盖**所有会被计提的** ProductKind
 * （即 ORDER_ITEM_KIND_TO_PRODUCT_KIND 的全部值域）。少一个 kind，该类佣金
 * 就只进不出——退款/取消时 ratio 取不到值按 0 处理，静默不冲销，代理白拿。
 */
export async function _computeRefundRatioByKind(svc: OrderService, tx: Prisma.TransactionClient, orderId: string, toStatus: OrderStatus): Promise<Map<ProductKind, number>> {
  const ALL_PRODUCT_KINDS: ProductKind[] = [
    ProductKind.FLIGHT,
    ProductKind.HOTEL,
    ProductKind.TRANSFER,
    ProductKind.VISA,
    ProductKind.BUNDLE,
  ];
  const fullReversal = (): Map<ProductKind, number> =>
    new Map(ALL_PRODUCT_KINDS.map((k) => [k, 1] as const));

  // 非批准退款的释放（取消 / 超时 / 失败）→ 整单全额冲销，语义不变。
  if (toStatus !== 'REFUNDED') return fullReversal();

  // 读本次推进的 Refund（与下方 Refund 状态同步同一批：status=REQUESTED）。
  const pendingRefunds = await tx.refund.findMany({
    where: { orderId, status: 'REQUESTED' },
    select: { gatewayPayload: true },
  });

  const refundedByKind = new Map<string, number>();
  const revenueByKind = new Map<string, number>();
  let parsedAnyItem = false;

  for (const r of pendingRefunds) {
    // gatewayPayload 是未知 JSON —— 防御式解析，任何不符合预期的形状都跳过。
    const payload = r.gatewayPayload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const snapshot = (payload as Record<string, unknown>).quoteSnapshot;
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
    const items = (snapshot as Record<string, unknown>).items;
    if (!Array.isArray(items)) continue;

    for (const raw of items) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const it = raw as Record<string, unknown>;
      const kind = typeof it.kind === 'string' ? it.kind : null;
      const feeAmount = Number(it.feeAmount);
      const refundAmount = Number(it.refundAmount);
      if (!kind || !Number.isFinite(feeAmount) || !Number.isFinite(refundAmount)) continue;
      parsedAnyItem = true;
      refundedByKind.set(kind, (refundedByKind.get(kind) ?? 0) + refundAmount);
      revenueByKind.set(kind, (revenueByKind.get(kind) ?? 0) + refundAmount + feeAmount);
    }
  }

  // 无任何可解析快照项（旧退款 / 脏数据）→ 退回整单全额冲销，绝不少冲。
  if (!parsedAnyItem) return fullReversal();

  const ratioByKind = new Map<ProductKind, number>();
  for (const kindStr of revenueByKind.keys()) {
    // 只接受合法 ProductKind 字符串；其他（如 INSURANCE / FEE / DISCOUNT）无佣金记录，忽略。
    if (!ALL_PRODUCT_KINDS.includes(kindStr as ProductKind)) continue;
    const revenue = revenueByKind.get(kindStr) ?? 0;
    const refunded = refundedByKind.get(kindStr) ?? 0;
    const ratio = revenue > 0 ? Math.min(1, Math.max(0, refunded / revenue)) : 0;
    ratioByKind.set(kindStr as ProductKind, ratio);
  }
  return ratioByKind;
}

/**
 * 改签申请（前台客户本人 / 代理树内订单）。
 *
 * 规则：
 *   - 状态闸：仅 PAID / PROCESSING / TICKETED 可申请；否则 409 ORDER_NOT_CHANGEABLE。
 *   - 幂等：已是 CHANGE_REQUESTED 直接返回当前订单（200，不重复建提醒）。
 *   - 事务内：走 _updateStatusWithinTx（记 OrderStatusEvent、并发 CAS 保护）+
 *     创建 OperationalReminder（HIGH 优先级，运营待办台接单跟进）。
 */
// 返回类型交给推断：serializeOrder 是泛型，显式写 ReturnType<typeof serializeOrder> 会
// 塌缩到 OrderLike 约束（丢失 id/orderNumber 等具体字段），路由层审计取不到订单号。
export async function requestChange(svc: OrderService, orderId: string, reason: string, requester: OrderRequester) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, userId: true, agentId: true, orderNumber: true },
  });
  if (!order) throw new NotFoundError('订单不存在');
  await svc.assertCanView(order, requester);

  // 幂等：重复点「申请改签」不报错、不重复建提醒，返回当前订单。
  if (order.status === OrderStatus.CHANGE_REQUESTED) {
    return { order: await svc.getOrder(orderId, requester), idempotent: true };
  }
  if (!CHANGE_REQUESTABLE_STATUSES.includes(order.status)) {
    throw new AppError('当前订单状态不可申请改签', {
      statusCode: 409,
      code: 'ORDER_NOT_CHANGEABLE',
    });
  }

  // CHANGE_REQUESTED 与来源状态同属占座集合：无座位/佣金/履约副作用，无需事务后处理。
  const pendingTaskIds: string[] = [];
  const updated = await prisma.$transaction(async (tx) => {
    const u = await svc._updateStatusWithinTx(
      tx,
      orderId,
      OrderStatus.CHANGE_REQUESTED,
      requester,
      reason,
      pendingTaskIds,
    );
    await tx.operationalReminder.create({
      data: {
        orderId,
        createdById: requester.userId,
        title: `【改签申请】${order.orderNumber}`,
        body: reason,
        priority: 'HIGH',
      },
    });
    return u;
  });
  // 申请改签是 AGENT/CUSTOMER 自助动作，返回订单同样按角色脱敏（不回传内部备注/逐项拆价等）。
  return { order: serializeOrder(updated, orderSerializeRoleCtx(requester.role)), idempotent: false };
}

export async function assertCanTransition(svc: OrderService, order: { userId: string | null; agentId: string | null; status: OrderStatus }, toStatus: OrderStatus, requester: OrderRequester) {
  if (requester.role === 'ADMIN' || requester.role === 'STAFF') return;
  if (requester.role === 'CUSTOMER') {
    if (!order.userId || order.userId !== requester.userId) throw new ForbiddenError('无权操作该订单');
    // 客户允许的状态流转：
    //   1. PENDING_PAYMENT → CANCELLED （直接取消未支付订单）
    //   2. PAID / PROCESSING / TICKETED → REFUND_REQUESTED （申请取消已支付订单）
    //   3. PAID / PROCESSING / TICKETED → CHANGE_REQUESTED （前台自助改签申请）
    const allowed =
      (toStatus === 'CANCELLED' && order.status === 'PENDING_PAYMENT') ||
      ((toStatus === 'REFUND_REQUESTED' || toStatus === 'CHANGE_REQUESTED') &&
        (order.status === 'PAID' || order.status === 'PROCESSING' || order.status === 'TICKETED'));
    if (!allowed) {
      throw new ForbiddenError(
        `客户不可将订单「${zhStatus(order.status)}」改为「${zhStatus(toStatus)}」（仅允许取消待支付订单 / 申请已支付订单退款或改签）`,
      );
    }
    return;
  }
  if (requester.role === 'AGENT') {
    const ids = await svc.getDescendantAgentIds(requester.agentId);
    if (!order.agentId || !ids.includes(order.agentId)) {
      throw new ForbiddenError('无权操作该订单');
    }
    // 代理替自己树内客户申请退款 / 改签
    if ((toStatus === 'REFUND_REQUESTED' || toStatus === 'CHANGE_REQUESTED') &&
        (order.status === 'PAID' || order.status === 'PROCESSING' || order.status === 'TICKETED')) {
      return;
    }
    throw new ForbiddenError('代理仅可代客户申请取消或改签（其他状态流转请联系运营）');
  }
}

// ════════════════════════════════════════════════════════════════════
// 取消订单（客户/代理 主动申请）
// ════════════════════════════════════════════════════════════════════
/**
 * 申请取消订单：
 *   1. 算 cancellation quote
 *   2. 创建 Refund 行（amount=应退）；状态 REQUESTED 等管理员审批
 *   3. Order 状态 → REFUND_REQUESTED + 写 OrderStatusEvent
 *   4. （注意：这里不真退款 / 不冲销佣金；机位在进入退款申请中时立即释放，等 admin approve 后再完成退款账务）
 *
 * 失败场景：
 *   - 订单状态不可取消 → BadRequestError
 *   - 已存在 REQUESTED 状态的 Refund → 返回那条（幂等）
 */
export async function requestCancellation(svc: OrderService, id: string, reason: string | undefined, requester: OrderRequester) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: { refunds: { where: { status: 'REQUESTED' }, take: 1 } },
  });
  if (!order) throw new NotFoundError('订单不存在');
  await svc.assertCanView(order, requester);

  // 已有 pending 退款 → 幂等返回（先于可取消性判断，避免再点报错）
  if (order.refunds.length > 0) {
    const { computeCancellationQuote } = await import('../../../lib/cancellation.js');
    const existing = order.refunds[0];
    const updated = await prisma.order.findUniqueOrThrow({
      where: { id },
      include: ORDER_FULL_INCLUDE,
    });
    // 始终重算最新 quote（不用 snapshot），保证客户端拿到的 shape 一致 + 费率最新
    // 历史 snapshot 留在 refund.gatewayPayload.quoteSnapshot 供审计追溯
    const quote = await computeCancellationQuote(id);
    return { order: serializeOrder(updated, orderSerializeRoleCtx(requester.role)), refund: existing, quote, isNew: false };
  }

  // 计算 quote（包含可取消性判断）
  const { computeCancellationQuote } = await import('../../../lib/cancellation.js');
  const quote = await computeCancellationQuote(id);
  if (!quote.cancellable) {
    throw new BadRequestError(quote.cancellableReason ?? '订单不可取消');
  }

  // 事务：创建 Refund + 流转 Order 状态
  const releasedSeatClassIds: string[] = [];
  const result = await prisma.$transaction(async (tx) => {
    const refund = await tx.refund.create({
      data: {
        orderId: id,
        amount: new Prisma.Decimal(quote.totalRefund),
        reason: reason ?? null,
        status: 'REQUESTED',
        gatewayPayload: {
          quoteSnapshot: {
            totalFee: quote.totalFee,
            totalRefund: quote.totalRefund,
            items: quote.items.map((i) => ({
              itemId: i.itemId,
              kind: i.kind,
              feePercent: i.feePercent,
              feeAmount: i.feeAmount,
              refundAmount: i.refundAmount,
              reason: i.reason,
            })),
          },
        } as Prisma.InputJsonValue,
      },
    });

    const taskIds: string[] = [];
    await svc._updateStatusWithinTx(
      tx,
      id,
      OrderStatus.REFUND_REQUESTED,
      requester,
      reason ?? `申请取消（应退 ¥${quote.totalRefund}）`,
      taskIds,
      false,
      releasedSeatClassIds,
    );

    return { refund };
  });

  // 事务提交后再通知候补，避免 worker 在座位释放提交前读到旧 sold。
  if (releasedSeatClassIds.length > 0) {
    try {
      const { enqueueWaitlistCheck } = await import('../../../queues/queue.js');
      await Promise.all(
        [...new Set(releasedSeatClassIds)].map((seatClassId) => enqueueWaitlistCheck(seatClassId)),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[orders] failed to enqueue waitlist-check for', id, err);
    }
  }

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id },
    include: ORDER_FULL_INCLUDE,
  });
  // 申请取消是 AGENT/CUSTOMER 自助动作，返回订单按角色脱敏（与幂等分支同口径）。
  return { order: serializeOrder(finalOrder, orderSerializeRoleCtx(requester.role)), refund: result.refund, quote, isNew: true };
}

