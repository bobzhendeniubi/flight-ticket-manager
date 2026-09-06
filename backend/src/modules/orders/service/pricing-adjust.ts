// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import { AuditSeverity, OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../lib/errors.js';
import { writeAudit } from '../../../lib/audit.js';
import { occupancyOfPassengers } from '../split-move-strategies.js';
import {
  assertOrderAllowsFundsDisposal,
  assertOrderAllowsPriceAdjustment,
} from '../../../lib/funds-guard.js';
import { PRICE_ADJUSTMENT_CAP_CNY } from '../orders.schemas.js';
import type {
  BatchPriceAdjustmentBody,
  OrderPriceAdjustmentBody,
  UpdateItemSettlementPriceBody,
} from '../orders.schemas.js';
import { orderSerializeRoleCtx, serializeOrder } from './read.js';
import {
  actorCan,
  appendAdjustment,
  buildPriceAdjustmentItem,
  ORDER_FULL_INCLUDE,
  round2,
  sumAccruedCommissionCny,
  zhStatus,
} from './shared.js';
import type { OrderService } from '../orders.service.js';

/**
 * B4 改结算价（路由层限 ADMIN/STAFF）：建单后订正某条 FLIGHT / HOTEL 行的结算价。
 * 仅允许 kind ∈ {FLIGHT, HOTEL}；事务内把 item.unitPrice 设为新价、按该 kind 的计价口径
 * 重算 amount，再用所有订单行重算 order.subtotal/total（taxesAndFees/discountTotal 不动）。
 *
 * 计价口径（与建单一致，见 computeGroundItemAmounts）：
 *   - FLIGHT：unitPrice = 每张票价，amount = unitPrice × quantity（quantity=张数）。
 *   - HOTEL ：unitPrice = 每间每晚价，amount = unitPrice × quantity × roomsBilled
 *             （quantity=晚数，roomsBilled 可为 0.5 拼房；缺省按 1 间）。
 *             漏乘房数会让多间/拼房的单订酒店单直接算错金额，故必须带上这个乘数。
 *
 * 这是「基础价订正」，不走 adjustmentCny（那是售后费用，改期费/换人费才用）。
 * 尾款（serializeOrder 的 balanceDue = total + adjustmentCny − paidAmount − prepaymentOffset）随 total 自然更新。
 * 不动 quantity / flightScheduleId / flightCabin / 库存（扣座与本订正无关）。
 * 返回 serializeOrder（含审计用的 before/after，由路由层 writeAudit 落库）。
 */
export async function updateItemSettlementPrice(svc: OrderService, orderId: string, itemId: string, input: UpdateItemSettlementPriceBody, actor: { userId: string; role: UserRole }): Promise<{
    order: ReturnType<typeof serializeOrder>;
    /** B12：已付款单改价的资金后果提示（多付/新尾款）+ 已计提佣金提示；均无后果时 null。*/
    warning: string | null;
    audit: {
      orderNumber: string;
      orderItemId: string;
      before: { unitPrice: string; amount: string; subtotal: string; total: string };
      after: { unitPrice: string; amount: string; subtotal: string; total: string };
      reason?: string;
    };
  }> {
  if (!actorCan(actor, 'orders.settlement_price.write')) {
    throw new ForbiddenError('仅运营/管理员可改结算价');
  }
  const unitPriceCny = input.unitPriceCny;

  const scratch = await prisma.$transaction(async (tx) => {
    // FOR UPDATE 行锁：改结算价要「读所有 items → 重算 subtotal/total → 写回 Order」，
    // 无锁时两个并发请求改同一单的**不同 item**，会各自从自己的陈旧 items 快照重算，
    // 后写者覆盖前写者 → order.total 丢掉一个 item 的改价，而 orderItem.amount 两条都已落库
    // → total ≠ Σ items（而 total 正是取消手续费/应退额的基数）。
    // 与多付转存 / 挂账池 / 到账入账（均先对 Order 行 FOR UPDATE）同一把锁，天然互斥。
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        orderNumber: string;
        status: OrderStatus;
        deletedAt: Date | null;
        subtotal: Prisma.Decimal;
        total: Prisma.Decimal;
        paidAmount: Prisma.Decimal;
        outboundInvoiced: boolean;
        returnInvoiced: boolean;
        systemInvoiced: boolean;
        settlementLocked: boolean;
      }>
    >`SELECT id, "orderNumber", status, "deletedAt", subtotal, total, "paidAmount", "outboundInvoiced", "returnInvoiced", "systemInvoiced", "settlementLocked" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = rows[0];
    if (!order) throw new NotFoundError('订单不存在');
    if (order.settlementLocked) {
      throw new ConflictError('结算价已锁定，请先解锁再修改');
    }
    // 资金处置闸：结算价直接改 item.amount 与 order.total（也是取消手续费基数），
    // 死单/软删单不许改——否则可在退款前偷偷抬价操纵应退额，或改回收站单的应收。
    assertOrderAllowsFundsDisposal(order, '修改结算价');
    // 开票闸（B12）：任一维度已开票后改结算价，发票金额与订单金额必然脱钩——
    // 发票是已交付下游的凭证，改价必须先冲开票状态（票务台改回未开）、改完价再重开。
    if (order.outboundInvoiced || order.returnInvoiced || order.systemInvoiced) {
      throw new BadRequestError(
        '该订单已有开票记录（去程/回程/系统任一已开），改结算价会使发票与订单金额不一致。' +
          '请先在票务台把对应开票状态改回「未开」，改价后再重新开票。',
      );
    }

    // 锁**之后**才读 items：锁之前读到的快照可能已被并发改价写脏，拿它重算等于锁了个寂寞。
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: {
        id: true,
        kind: true,
        quantity: true,
        unitPrice: true,
        amount: true,
        // HOTEL 行的 amount 乘数（每间每晚价 × 晚数 × 房数）；FLIGHT 行为 null，不参与计算。
        roomsBilled: true,
      },
    });
    const target = items.find((it) => it.id === itemId);
    if (!target) {
      throw new NotFoundError('订单项不存在或不属于该订单');
    }
    if (target.kind !== OrderItemKind.FLIGHT && target.kind !== OrderItemKind.HOTEL) {
      throw new BadRequestError('只能对机票行（FLIGHT）或酒店行（HOTEL）改结算价');
    }

    const beforeUnitPrice = target.unitPrice.toString();
    const beforeAmount = target.amount.toString();
    // 房数乘数：仅 HOTEL 行有（roomsBilled 可为 0.5 拼房，缺省按 1 间——与建单同口径）。
    const roomsMultiplier =
      target.kind === OrderItemKind.HOTEL && target.roomsBilled != null
        ? Number(target.roomsBilled.toString())
        : 1;
    const newAmount = round2(unitPriceCny * target.quantity * roomsMultiplier);

    await tx.orderItem.update({
      where: { id: itemId },
      data: {
        unitPrice: new Prisma.Decimal(unitPriceCny),
        amount: new Prisma.Decimal(newAmount),
      },
    });

    // 锁内从库**重新聚合**最新 items 算 subtotal/total —— 不用锁之前那份内存快照。
    // 本次 orderItem.update 已落在同一事务里，故聚合结果天然含新 amount；
    // 同时也吃到了「本事务拿到锁之前、其它事务已提交」的所有改动（并发改另一行 / 补房差新增 FEE 行），
    // 不会像旧的内存快照 reduce 那样把它们算回旧值再写回去（后写覆盖前写）。
    const sumAgg = await tx.orderItem.aggregate({
      where: { orderId },
      _sum: { amount: true },
    });
    const newSubtotal = Number((sumAgg._sum.amount ?? new Prisma.Decimal(0)).toString());
    const newTotal = round2(newSubtotal); // 当前无 taxes/discount，total = subtotal

    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: new Prisma.Decimal(round2(newSubtotal)),
        total: new Prisma.Decimal(newTotal),
      },
      select: { subtotal: true, total: true },
    });

    // 佣金后果提示：佣金在订单转 PAID 时按当时的价格基数一次性计提，改结算价**不重算佣金**，
    // 且计提幂等键按（订单, productKind）不区分状态 —— 补提也会被判成"已提过"而永久锁死。
    // 本次只做可见性：把「已计提多少」明明白白摆到操作者面前 + 留一条 WARNING 审计，
    // 让财务自己决定要不要人工调整。真正的重算/幂等键收口是独立议题，不在此处顺手改。
    // 口径与换人重算 / 改归属共用（sumAccruedCommissionCny）：一条都没有 → null。
    const accruedCommissionCny = await sumAccruedCommissionCny(tx, orderId);
    const commissionWarning =
      accruedCommissionCny !== null
        ? `本单已计提佣金 ¥${accruedCommissionCny}，价格基数已变更，请财务确认是否调整。`
        : null;

    // 已付资金后果（B12）：改价后 total 变、paidAmount 不变 —— 把差额算清楚交给运营处置，
    // 不再让「total ≠ 已收」静默存在。多付走既有多付处置（转余额/挂账/退款），欠款去催收。
    const paid = Number(order.paidAmount.toString());
    let warning: string | null = null;
    if (paid > 0) {
      const gap = round2(newTotal - paid);
      if (gap < 0) {
        warning =
          `该单已收 ¥${paid}，改价后应收 ¥${newTotal}，形成多付 ¥${Math.abs(gap)}。` +
          '请在订单资金区做多付处置（转代理余额 / 转挂账池 / 退款）。';
      } else if (gap > 0 && (order.status === OrderStatus.PAID || order.status === OrderStatus.PROCESSING || order.status === OrderStatus.TICKETED || order.status === OrderStatus.COMPLETED)) {
        warning =
          `该单状态为已付款族（${zhStatus(order.status)}）但改价后新增尾款 ¥${gap}（已收 ¥${paid} / 应收 ¥${newTotal}）。` +
          '请补收该差额或确认本次改价金额无误。';
      }
    }
    // 佣金提示与资金提示并列返回：两件事互不覆盖（可能同时成立）。
    warning = [warning, commissionWarning].filter(Boolean).join(' ') || null;

    return {
      orderNumber: order.orderNumber,
      beforeUnitPrice,
      beforeAmount,
      beforeSubtotal: order.subtotal.toString(),
      beforeTotal: order.total.toString(),
      afterUnitPrice: unitPriceCny,
      afterAmount: newAmount,
      afterSubtotal: updated.subtotal.toString(),
      afterTotal: updated.total.toString(),
      warning,
      accruedCommissionCny,
    };
  });

  // 改价撞上已计提佣金 → 单独留一条 WARNING 审计（路由层那条改价审计是 INFO 级，
  // 淹没在日常改价里翻不出来）。await 而非 fire-and-forget：与录单调价/结算总价同口径，
  // 佣金基数漂移是财务要复核的事，落审计后再返回。
  if (scratch.accruedCommissionCny !== null) {
    await writeAudit({
      actor: { userId: actor.userId, role: actor.role },
      action: 'SETTLEMENT_PRICE_CHANGED_AFTER_COMMISSION',
      targetType: 'ORDER',
      targetId: orderId,
      targetLabel: scratch.orderNumber,
      before: { total: scratch.beforeTotal, accruedCommissionCny: scratch.accruedCommissionCny },
      after: {
        total: scratch.afterTotal,
        orderItemId: itemId,
        // 佣金不随改价重算，这条审计就是「基数已变、佣金没动」的留痕。
        commissionRecalculated: false,
        reason: input.reason ?? null,
      },
      severity: AuditSeverity.WARNING,
    });
  }

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });

  return {
    // 对外脱敏：改结算价的返回也按操作者角色脱敏（ADMIN/STAFF 全量，其余剥离内部字段 + 逐项拆价）。
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
    warning: scratch.warning,
    audit: {
      orderNumber: scratch.orderNumber,
      orderItemId: itemId,
      before: {
        unitPrice: scratch.beforeUnitPrice,
        amount: scratch.beforeAmount,
        subtotal: scratch.beforeSubtotal,
        total: scratch.beforeTotal,
      },
      after: {
        unitPrice: String(scratch.afterUnitPrice),
        amount: String(scratch.afterAmount),
        subtotal: scratch.afterSubtotal,
        total: scratch.afterTotal,
      },
      reason: input.reason,
    },
  };
}

/**
 * 批量事后调价（ADMIN/STAFF）。主用场景：一批单选了指定酒店却漏收「指定酒店加价（每人 ¥X）」，
 * 事后按人补上；也可用于整单口径的统一补收/优惠。
 *
 * 两种口径：
 *   PER_ORDER —— 每单挂一笔 amountCny（与单单事后调价完全一致）。
 *   PER_PAX   —— amountCny 是每人的钱，落库金额 = amountCny × 占座人数。
 *
 * 占座人数口径直接复用 occupancyOfPassengers（= 成人 + 占座儿童，婴儿不计）：与「指定酒店加价
 * × occupancy.seatPax」「每人操作费 × seatPax」同一个数。婴儿不占座也不占床，指定酒店那笔加价
 * 本来就没收他的钱，补收当然也不该按他收 —— 用出行总人数会当场多收一个婴儿的钱。
 *
 * 跳过而不整批失败（同 batchSetPaymentsLock）：锁价单、死单、回收站单、点错的 id 逐单跳过并
 * 带回原因，其余照做。闸门判断不在这里重写一遍，一律由 _addPriceAdjustmentWithinTx 抛出后接住，
 * 口径只有一份。只接住这三类业务异常，库级异常照旧整批抛（事务已脏，不能继续做后面的单）。
 */
export async function batchAddPriceAdjustment(svc: OrderService, orderIds: string[], input: Omit<BatchPriceAdjustmentBody, 'orderIds'>, actor: { userId: string; role: UserRole }): Promise<{
    updated: number;
    skipped: number;
    results: Array<{
      orderId: string;
      orderNumber: string | null;
      ok: boolean;
      reason?: string;
      appliedAmountCny: number | null;
      /** PER_PAX 时的每人金额（PER_ORDER 为 null）——审计与回执要能还原「怎么乘出来的」。 */
      unitAmountCny: number | null;
      /** PER_PAX 时的占座人数（PER_ORDER 为 null）。 */
      seatPax: number | null;
      itemId?: string;
      before?: { subtotal: string; total: string };
      after?: { subtotal: string; total: string };
    }>;
  }> {
  if (!actorCan(actor, 'orders.price_adjust')) {
    throw new ForbiddenError('仅运营/管理员可调整订单价格');
  }
  const { mode, amountCny, reasonCode, reasonText } = input;

  const results = await prisma.$transaction(
    async (tx) => {
      const acc: Array<{
        orderId: string;
        orderNumber: string | null;
        ok: boolean;
        reason?: string;
        appliedAmountCny: number | null;
        unitAmountCny: number | null;
        seatPax: number | null;
        itemId?: string;
        before?: { subtotal: string; total: string };
        after?: { subtotal: string; total: string };
      }> = [];
      // 与 batchSetSettlementLock 同一套加锁纪律：固定 id 顺序，并发批次排队而不是交叉死锁。
      for (const orderId of [...orderIds].sort()) {
        const rows = await tx.$queryRaw<
          Array<{ id: string; orderNumber: string }>
        >`SELECT id, "orderNumber" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        const found = rows[0];
        if (!found) {
          acc.push({
            orderId,
            orderNumber: null,
            ok: false,
            reason: '订单不存在',
            appliedAmountCny: null,
            unitAmountCny: null,
            seatPax: null,
          });
          continue;
        }
        const orderNumber = found.orderNumber;

        let applied = amountCny;
        // 按人口径的两个还原位：每人多少 × 几个人。整单口径恒 null（这笔本来就没有「每人」）。
        let unitAmountCny: number | null = null;
        let paxCount: number | null = null;
        if (mode === 'PER_PAX') {
          const passengers = await tx.passenger.findMany({
            where: { orderId },
            select: { passengerType: true },
          });
          const { seatPax } = occupancyOfPassengers(passengers);
          if (seatPax === 0) {
            acc.push({
              orderId,
              orderNumber,
              ok: false,
              reason: '本单没有占座客人（婴儿不占座），按人调价无从计算',
              appliedAmountCny: null,
              unitAmountCny: amountCny,
              seatPax: 0,
            });
            continue;
          }
          applied = amountCny * seatPax;
          unitAmountCny = amountCny;
          paxCount = seatPax;
          // 乘出来的钱可能顶破单笔调整上限 —— 那是单单入口会当场拒绝的金额，批量也不该悄悄写进去。
          if (Math.abs(applied) > PRICE_ADJUSTMENT_CAP_CNY) {
            acc.push({
              orderId,
              orderNumber,
              ok: false,
              reason: `按 ${seatPax} 人合计 ¥${applied}，超出单笔调整上限（±${PRICE_ADJUSTMENT_CAP_CNY}）`,
              appliedAmountCny: null,
              unitAmountCny: amountCny,
              seatPax,
            });
            continue;
          }
        }

        try {
          const scratch = await svc._addPriceAdjustmentWithinTx(
            tx,
            orderId,
            { amountCny: applied, reasonCode, reasonText },
            actor,
            // 按人口径把单价写进行描述：落库的是合计，事后光看「+¥1400」还原不出每人多少。
            paxCount != null && unitAmountCny != null
              ? { unitNote: `每人 ¥${Math.abs(unitAmountCny)} × ${paxCount} 人` }
              : undefined,
          );
          acc.push({
            orderId,
            orderNumber: scratch.orderNumber,
            ok: true,
            appliedAmountCny: applied,
            unitAmountCny,
            seatPax: paxCount,
            itemId: scratch.itemId,
            before: { subtotal: scratch.beforeSubtotal, total: scratch.beforeTotal },
            after: { subtotal: scratch.afterSubtotal, total: scratch.afterTotal },
          });
        } catch (err) {
          // 只接住业务闸门抛的三类（锁价 / 死单·回收站 / 找不到单）——它们都在任何写库之前抛出，
          // 事务是干净的，可以继续做后面的单。其余（库级错误）事务已脏，必须整批抛。
          if (
            err instanceof ConflictError ||
            err instanceof BadRequestError ||
            err instanceof NotFoundError
          ) {
            acc.push({
              orderId,
              orderNumber,
              ok: false,
              reason: err.message,
              appliedAmountCny: null,
              unitAmountCny,
              seatPax: paxCount,
            });
            continue;
          }
          throw err;
        }
      }
      return acc;
    },
    // 批量上限 500 单（schema），逐单多次往返 + 重算 total；默认 5s 超时远远不够。
    { timeout: 120_000, maxWait: 15_000 },
  );

  const updated = results.filter((r) => r.ok).length;
  return { updated, skipped: results.length - updated, results };
}

// ════════════════════════════════════════════════════════════════════
// 事后调价（POST /orders/:id/price-adjustment · 0722 公测反馈「按乘客调价」）
//
// 一张多人订单内，给「整单」或「指定乘客」挂一笔结算价差额（正=补收、负=优惠）+原因，走
// 与录单调价完全同一路径：追加一条独立 priceAdjustment OrderItem（kind FEE/DISCOUNT），
// 金额随该行进入 subtotal/total（订单总额 = 系统价 + Σ调整）。passengerId 非空 = 只作用于
// 该乘客的应收份额（金额明细逐人可解释）；空 = 整单调价（现行为不变）。
//
// 服务端权威定价底线：绝不改任何既有明细行价格，只加差额行 + 审计留痕（reasonCode/经手/时间）。
// 资金闸：assertOrderAllowsPriceAdjustment —— 已退款/退款申请中/支付超时/草稿单不许再改
// total（防二次退款/快照算错）；已取消单放行（运营反馈：换人/取消手续费本来就是靠调价定格，
// 事后改这个数字不涉及收款，钱不动，见 funds-guard.ts 该函数上方注释）。
// 并发：FOR UPDATE 锁订单行后再读 items 重算 total（与补房差同款，杜绝丢失更新）。
// ════════════════════════════════════════════════════════════════════
export async function addPriceAdjustment(svc: OrderService, orderId: string, input: OrderPriceAdjustmentBody, actor: { userId: string; role: UserRole }, options?: { viaAgentSelfSettlement?: boolean }): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      itemId: string;
      amountCny: number;
      reasonCode: string;
      passengerId: string | null;
      passengerName: string | null;
      before: { subtotal: string; total: string };
      after: { subtotal: string; total: string };
    };
  }> {
  const isOps = actorCan(actor, 'orders.price_adjust');
  const isAgentSelfSettlement =
    actor.role === UserRole.AGENT && options?.viaAgentSelfSettlement === true;
  if (!isOps && !isAgentSelfSettlement) {
    throw new ForbiddenError('仅运营/管理员可调整订单价格');
  }
  const { amountCny, reasonCode } = input;

  // 事务内核抽到 _addPriceAdjustmentWithinTx：批量调价要在同一个事务里逐单复用同一套闸门与
  // 算账口径（锁价闸 / 资金闸 / 差额行 / 重算 total），口径只留一份，单单入口行为一字未改。
  const scratch = await prisma.$transaction((tx) =>
    svc._addPriceAdjustmentWithinTx(tx, orderId, input, actor),
  );

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });

  return {
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
    audit: {
      orderNumber: scratch.orderNumber,
      itemId: scratch.itemId,
      amountCny,
      reasonCode,
      passengerId: input.passengerId ?? null,
      passengerName: scratch.passengerName,
      before: { subtotal: scratch.beforeSubtotal, total: scratch.beforeTotal },
      after: { subtotal: scratch.afterSubtotal, total: scratch.afterTotal },
    },
  };
}

/**
 * 事务内执行一笔事后调价 —— 单单事后调价（addPriceAdjustment）与批量调价
 * （batchAddPriceAdjustment）共用的内核。调用方负责包 $transaction 与鉴权。
 *
 * 闸门口径全部留在这里（结算价锁 → 资金闸 → 乘客归属），批量入口逐单捕获这些异常改成
 * 「跳过 + 原因」，绝不另写一套判断，避免两条入口的口径漂移。
 */
export async function _addPriceAdjustmentWithinTx(svc: OrderService, tx: Prisma.TransactionClient, orderId: string, input: OrderPriceAdjustmentBody, actor: { userId: string; role: UserRole }, options?: { unitNote?: string }) {
  const { amountCny, reasonCode, reasonText } = input;
  const row = buildPriceAdjustmentItem({
    amountCny,
    reasonCode,
    reasonText,
    unitNote: options?.unitNote,
  });
  // 行锁：先锁订单行串行化并发调价，避免两个并发请求各读旧 items、各加一条差额行、
  // 各按「旧合计 + 一次差额」写 total → 丢失更新（两条行，total 只含一条）。
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      deletedAt: true,
      subtotal: true,
      total: true,
      adjustments: true,
      settlementLocked: true,
      items: { select: { id: true, amount: true } },
    },
  });
  if (!order) throw new NotFoundError('订单不存在');
  // 结算价锁闸：锁定 = 财务已按这个应收对过账，之后任何改应收的动作都要先解锁（与改结算价 /
  // 改自备签 / 取消单腿同一句口径）。此前这条通道是唯一绕过锁的改价路径——运营的事后调价、
  // 议价申请确认都能在锁着的单上直接改 total，锁形同虚设。放在资金闸之前：
  // 「已锁定」比「死单」更早能给出可操作的下一步（先解锁）。
  if (order.settlementLocked) {
    throw new ConflictError('结算价已锁定，请先解锁再修改');
  }
  // 资金闸：调价新增/降低差额行会改 order.total —— total 是应退额与取消手续费的计算基数。
  // 已退款/退款申请中/支付超时/草稿单若还能调价，可被算出二次退款或算错退款快照；
  // 已取消单放行——它的 total 就是取消/换人手续费，运营改这个数字不产生任何收款/退款事实。
  assertOrderAllowsPriceAdjustment(order);

  // passengerId 归属校验：非空必须属于本单，否则 400（不接受跨单/不存在的乘客）。
  let passengerName: string | null = null;
  if (input.passengerId) {
    const pax = await tx.passenger.findUnique({
      where: { id: input.passengerId },
      select: { id: true, orderId: true, fullName: true },
    });
    if (!pax || pax.orderId !== orderId) {
      throw new BadRequestError('指定的乘客不存在或不属于本订单');
    }
    passengerName = pax.fullName;
  }

  // ── 1. 追加一条 priceAdjustment 差额行（passengerId 非空 = 该乘客名下；空 = 整单）──
  // 纯价格调整行（优惠/补收/调价）无采购成本 → totalCostCny 显式落 0（row 已带 0），不留 NULL。
  const created = await tx.orderItem.create({
    data: {
      orderId,
      kind: row.kind,
      description: row.description,
      quantity: 1,
      unitPrice: new Prisma.Decimal(row.unitPrice),
      amount: new Prisma.Decimal(row.amount),
      totalCostCny: new Prisma.Decimal(row.totalCostCny),
      metadata: row.metadata as Prisma.InputJsonValue,
      passengerId: input.passengerId ?? null,
    },
  });

  // ── 2. 用所有既有行 + 新行重算 subtotal/total（当前无 taxes/discount，total = subtotal）──
  const newSubtotal = round2(
    order.items.reduce((sum, it) => sum + Number(it.amount.toString()), 0) + amountCny,
  );
  const newTotal = newSubtotal;

  // ── 3. 审计流水（appendAdjustment；仅记录用，钱走上面的 total，不进 adjustmentCny）──
  const log = appendAdjustment(order.adjustments, {
    type: 'PRICE_ADJUSTMENT',
    label: row.description,
    amountCny,
    at: new Date().toISOString(),
    by: actor.userId,
    reasonCode,
    note: reasonText?.trim() || undefined,
    ...(input.passengerId ? { passengerId: input.passengerId } : {}),
  });

  await tx.order.update({
    where: { id: orderId },
    data: {
      subtotal: new Prisma.Decimal(newSubtotal),
      total: new Prisma.Decimal(newTotal),
      adjustments: log,
    },
  });

  return {
    orderNumber: order.orderNumber,
    itemId: created.id,
    passengerName,
    beforeSubtotal: order.subtotal.toString(),
    beforeTotal: order.total.toString(),
    afterSubtotal: newSubtotal.toString(),
    afterTotal: newTotal.toString(),
  };
}

