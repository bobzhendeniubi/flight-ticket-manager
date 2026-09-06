// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PrepaymentTxType,
  Prisma,
  ReceiptSource,
  RefundStatus,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../lib/errors.js';
import { businessDateTime } from '../../../lib/business-time.js';
import { CANCELLABLE_STATUSES } from '../../../lib/cancellation.js';
import {
  assertOrderAcceptsFunds,
  assertOrderAllowsFundsDisposal,
  sumCompletedRefundsWithinTx,
} from '../../../lib/funds-guard.js';
import { createOpenReceiptWithinTx } from '../../receipts/receipts.service.js';
import { orderSerializeRoleCtx, serializeOrder } from './read.js';
import {
  actorCan,
  ORDER_FULL_INCLUDE,
  type OrderRequester,
  round2,
  SEAT_HOLDING_STATUSES,
  zhStatus,
} from './shared.js';
import type { OrderService } from '../orders.service.js';

// ════════════════════════════════════════════════════════════════════
// 代理余额账户 —— 多付存入 / 用余额抵尾款
// （取代「跨人抵扣」：多付不再直接抵给别的客户，而是进代理自己的预存余额账户；
//  少付从同一余额顶。ADMIN/STAFF 操作，全程事务安全 + 审计 + 余额不为负。）
// ════════════════════════════════════════════════════════════════════

/**
 * 多付处置的 Payment 台账对冲行（R6：堵死「处置后再进 PAID 把多付灌回」的造币循环）。
 *
 * 病灶：多付处置只把钱从 order.paidAmount 移走，Payment 台账里那几笔 SUCCEEDED 原封不动。
 * 而 _updateStatusWithinTx 的 PAID 分支会按台账 SUCCEEDED 合计把 paidAmount 抬回去
 * （`if (paymentsSum > currentPaid) paidAmount = paymentsSum`，用于网关回调补记）。
 * 于是订单每再进一次 PAID（如 CHANGE_REQUESTED→PAID 驳回改签，合法路径、无需 force），
 * 多付就凭空复活一次，可无限循环每轮白造一笔钱。
 *
 * 修法：处置的同时在台账登记等额流出——一条**负金额 SUCCEEDED** Payment。
 * 这样 SUCCEEDED 合计随之下降，PAID 分支的重写条件自然恒为假，而补记逻辑本身完好保留
 * （真有迟到的网关回调补记时仍然生效）。
 *
 * 为什么是「负金额 SUCCEEDED」而不是别的状态：
 *   · 只有 SUCCEEDED 进「实收」合计，要抵扣就必须同在 SUCCEEDED 里，否则合计纹丝不动；
 *   · paidAt 留空 → 导出的「最近一笔成功收款」（按 paidAt 过滤排序）不会把对冲行误当收款；
 *   · gatewayPayload.source='overpay-disposal' 是自识别标志，与认款行（source='reconciliation'）
 *     互不相干，不会被冲销/查重/认款回溯等路径误认。
 *   · 金额为负 → 手工收款查重（按等额匹配）、认款冲销（按 allocationId/等额匹配）天然不命中。
 */
export async function _recordOverpayDisposalPayment(
  svc: OrderService,
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    amountCny: number;
    method: PaymentMethod;
    disposal: 'AGENT_BALANCE' | 'RECEIPT_POOL';
    description: string;
  },
): Promise<void> {
  await tx.payment.create({
    data: {
      orderId: input.orderId,
      method: input.method,
      amount: new Prisma.Decimal(-round2(input.amountCny)),
      status: PaymentStatus.SUCCEEDED,
      paidAt: null,
      // 多付处置是内部记账（负额），不是新钱进账，创建即视同已核实，不进待核实队列。
      verifiedAt: new Date(),
      gatewayPayload: {
        source: 'overpay-disposal',
        disposal: input.disposal,
        amountCny: round2(input.amountCny),
        disposedAt: new Date().toISOString(),
        note: input.description,
      } as Prisma.InputJsonValue,
    },
  });
}

/**
 * 取最近一笔**真实收款**的支付方式（对冲行金额为负，必须排除，否则一路取到自己身上）。
 */
export async function _latestInboundPaymentMethod(svc: OrderService, tx: Prisma.TransactionClient, orderId: string): Promise<PaymentMethod> {
  const latest = await tx.payment.findFirst({
    where: { orderId, amount: { gt: 0 } },
    orderBy: { createdAt: 'desc' },
    select: { method: true },
  });
  return latest?.method ?? PaymentMethod.WECHAT_PAY;
}

/**
 * 多付存入代理余额。订单有代理且 paidAmount > total（多付）时：
 *   一个事务里：order.paidAmount 回压到 total（消掉多付），代理 prepaymentBalance += 多付额，
 *   写一条 PrepaymentTransaction（TOP_UP，钱进余额）+ 一条负金额对冲 Payment（见
 *   _recordOverpayDisposalPayment）+ 关联 orderId。
 * 无代理 / 无多付 → 拒绝。
 */
export async function creditOverpayToAgent(svc: OrderService, orderId: string, actor: { userId: string; role: UserRole }): Promise<{
    ok: true;
    orderId: string;
    orderNumber: string;
    agentId: string;
    creditedAmount: number;
    newPaidAmount: number;
    total: number;
    agentBalanceAfter: number;
  }> {
  if (!actorCan(actor, 'payments.overpay.handle')) {
    throw new ForbiddenError('仅运营/管理员可将多付存入代理余额');
  }

  return prisma.$transaction(async (tx) => {
    // FOR UPDATE 行锁：事务内读最新 paidAmount/total，避免与并发到账/抵扣用旧快照
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        orderNumber: string;
        agentId: string | null;
        total: Prisma.Decimal;
        adjustmentCny: number;
        paidAmount: Prisma.Decimal;
        prepaymentOffset: Prisma.Decimal;
        status: OrderStatus;
        deletedAt: Date | null;
      }>
    >`SELECT id, "orderNumber", "agentId", total, "adjustmentCny", "paidAmount", "prepaymentOffset", status, "deletedAt" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = rows[0];
    if (!order) throw new NotFoundError('订单不存在');
    // 资金处置闸：死单/软删单不许再动钱（避免账实分叉）
    assertOrderAllowsFundsDisposal(order, '将多付存入代理余额');
    if (!order.agentId) throw new BadRequestError('该订单无归属代理，无法存入代理余额');

    const total = Number(order.total);
    const paid = Number(order.paidAmount);
    // 已完成退款必须先从 paidAmount 里扣掉再算多付：退款完成不减 paidAmount（REFUNDED 只翻 Refund 状态），
    // 不扣就会把同一笔多付「先退给客户、再转存代理余额」取两次（公司净损失）。
    const refunded = await sumCompletedRefundsWithinTx(tx, orderId);
    // 多付 = 清账口径下的负尾款（含改期费/预存抵扣），与 serializeOrder.balanceDue<0 一字一致：
    //   overpay = (paidAmount − 已退款) + prepaymentOffset − (total + adjustmentCny)
    // 不能只按 paid−total，否则有改期费的单会把「还没收齐的改期费」误当多付存进代理余额。
    const clearingPoint = round2(total + order.adjustmentCny - Number(order.prepaymentOffset));
    const overpay = round2(paid - refunded - clearingPoint);
    if (overpay <= 0) {
      throw new BadRequestError('该订单没有多付金额（已付款扣除已退款 ≤ 应付），无可存入余额');
    }

    // 代理余额行锁 + 事务内累加（与 settlements PAID 抵扣同一并发安全口径）
    const agentRows = await tx.$queryRaw<Array<{ prepaymentBalance: Prisma.Decimal }>>`
      SELECT "prepaymentBalance" FROM "Agent" WHERE id = ${order.agentId} FOR UPDATE
    `;
    if (!agentRows[0]) throw new NotFoundError('代理不存在');
    const balanceAfter = round2(Number(agentRows[0].prepaymentBalance) + overpay);

    await tx.agent.update({
      where: { id: order.agentId },
      data: { prepaymentBalance: new Prisma.Decimal(balanceAfter) },
    });
    // 多付回压：paidAmount 只扣掉本次转存的 overpay（无退款时等于降回清账点，与旧行为一致）。
    // 不直接写 clearingPoint：那样会把「已退款但仍留在 paidAmount 里」的部分也一并抹掉，
    // 与系统其它处（退款不减 paidAmount）的口径冲突。
    await tx.order.update({
      where: { id: orderId },
      data: { paidAmount: new Prisma.Decimal(round2(paid - overpay)) },
    });
    await tx.prepaymentTransaction.create({
      data: {
        agentId: order.agentId,
        amount: new Prisma.Decimal(overpay), // 正数 = 入账
        balanceAfter: new Prisma.Decimal(balanceAfter),
        type: PrepaymentTxType.TOP_UP,
        orderId,
        description: `订单 ${order.orderNumber} 多付转存代理余额`,
        createdById: actor.userId,
      },
    });
    // R6：台账同步登记等额流出，否则订单再进一次 PAID 就会按 SUCCEEDED 合计把多付灌回（造币循环）。
    await svc._recordOverpayDisposalPayment(tx, {
      orderId,
      amountCny: overpay,
      method: await svc._latestInboundPaymentMethod(tx, orderId),
      disposal: 'AGENT_BALANCE',
      description: `订单 ${order.orderNumber} 多付转存代理余额`,
    });

    return {
      ok: true as const,
      orderId,
      orderNumber: order.orderNumber,
      agentId: order.agentId,
      creditedAmount: overpay,
      newPaidAmount: round2(paid - overpay),
      total,
      agentBalanceAfter: balanceAfter,
    };
  });
}

/**
 * 用代理余额抵订单尾款。订单有代理、代理余额 ≥ amount、amount ≤ 尾款（total − paidAmount，须 > 0）时：
 *   一个事务里：代理 prepaymentBalance -= amount，order.paidAmount += amount，
 *   写一条 PrepaymentTransaction（OFFSET，余额用在订单上）+ 关联 orderId；
 *   若抵扣后已全额覆盖且订单仍在 PENDING_PAYMENT，复用 _updateStatusWithinTx 推 PAID
 *   （同走佣金 / 履约任务生成那一套）。
 * 无代理 / 超抵（amount > 尾款）/ 余额不足 → 拒绝；余额不会为负。
 */
export async function applyAgentBalanceToOrder(
  svc: OrderService,
  orderId: string,
  amount: number,
  actor: { userId: string; role: UserRole },
): Promise<{
    ok: true;
    orderId: string;
    orderNumber: string;
    agentId: string;
    appliedAmount: number;
    newPaidAmount: number;
    total: number;
    fullyPaid: boolean;
    status: OrderStatus;
    agentBalanceAfter: number;
  }> {
  if (!actorCan(actor, 'payments.overpay.handle')) {
    throw new ForbiddenError('仅运营/管理员可用代理余额抵尾款');
  }
  const apply = round2(amount);
  if (apply <= 0) throw new BadRequestError('抵扣金额必须大于 0');

  const pendingFulfillmentTaskIds: string[] = [];
  const result = await prisma.$transaction(async (tx) => {
    // 订单行锁 + 事务内读最新尾款
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        orderNumber: string;
        agentId: string | null;
        total: Prisma.Decimal;
        adjustmentCny: number;
        paidAmount: Prisma.Decimal;
        prepaymentOffset: Prisma.Decimal;
        status: OrderStatus;
        deletedAt: Date | null;
      }>
    >`SELECT id, "orderNumber", "agentId", total, "adjustmentCny", "paidAmount", "prepaymentOffset", status, "deletedAt" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = rows[0];
    if (!order) throw new NotFoundError('订单不存在');
    // 资金闸：用代理余额抵扣 = 往订单里灌钱，死单/软删单一律拒绝（否则钱进死单无出口）。
    assertOrderAcceptsFunds(order);
    if (!order.agentId) throw new BadRequestError('该订单无归属代理，无法用代理余额抵扣');

    const total = Number(order.total);
    const paid = Number(order.paidAmount);
    // 尾款 = 清账口径（含改期费与预存抵扣），与 serializeOrder.balanceDue 一字一致——
    // 不能只按 total−paid，否则有改期费的单会误判"已结清"、代理余额抵扣被拒或抵不到位。
    const effectivePayable = round2(total + order.adjustmentCny);
    const prepaymentOffset = Number(order.prepaymentOffset);
    const remaining = round2(effectivePayable - paid - prepaymentOffset);
    if (remaining <= 0) throw new BadRequestError('该订单无尾款（已结清或多付），无需抵扣');
    if (apply > remaining + 0.001) {
      throw new BadRequestError(
        `抵扣金额 ¥${apply.toFixed(2)} 超过尾款 ¥${remaining.toFixed(2)}，已拒绝`,
      );
    }

    // 代理余额行锁：余额不足直接拒，绝不透支为负
    const agentRows = await tx.$queryRaw<Array<{ prepaymentBalance: Prisma.Decimal }>>`
      SELECT "prepaymentBalance" FROM "Agent" WHERE id = ${order.agentId} FOR UPDATE
    `;
    if (!agentRows[0]) throw new NotFoundError('代理不存在');
    const balance = Number(agentRows[0].prepaymentBalance);
    if (apply > balance + 0.001) {
      throw new BadRequestError(
        `代理余额 ¥${balance.toFixed(2)} 不足以抵扣 ¥${apply.toFixed(2)}，已拒绝`,
      );
    }
    const balanceAfter = round2(balance - apply);
    const newPaid = round2(paid + apply);
    // 清账阈值：paidAmount + prepaymentOffset >= total + adjustmentCny 才算收齐（自动转 PAID）。
    const fullyPaid = round2(newPaid + prepaymentOffset) + 0.001 >= effectivePayable;

    await tx.agent.update({
      where: { id: order.agentId },
      data: { prepaymentBalance: new Prisma.Decimal(balanceAfter) },
    });
    await tx.order.update({
      where: { id: orderId },
      data: { paidAmount: new Prisma.Decimal(newPaid) },
    });
    await tx.prepaymentTransaction.create({
      data: {
        agentId: order.agentId,
        amount: new Prisma.Decimal(-apply), // 负数 = 余额扣减（用在订单上）
        balanceAfter: new Prisma.Decimal(balanceAfter),
        type: PrepaymentTxType.OFFSET,
        orderId,
        description: `订单 ${order.orderNumber} 代理余额抵尾款`,
        createdById: actor.userId,
      },
    });

    // 抵满 + 仍待支付 → 复用 PAID 流转（含佣金 / 履约任务）
    let finalStatus: OrderStatus = order.status;
    if (fullyPaid && order.status === OrderStatus.PENDING_PAYMENT) {
      await svc._updateStatusWithinTx(
        tx,
        orderId,
        OrderStatus.PAID,
        { userId: actor.userId, role: actor.role, actorType: 'USER' },
        `代理余额抵尾款（¥${apply.toFixed(2)}）结清`,
        pendingFulfillmentTaskIds,
      );
      finalStatus = OrderStatus.PAID;
    }

    return {
      ok: true as const,
      orderId,
      orderNumber: order.orderNumber,
      agentId: order.agentId,
      appliedAmount: apply,
      newPaidAmount: newPaid,
      total,
      fullyPaid,
      status: finalStatus,
      agentBalanceAfter: balanceAfter,
    };
  });

  // 事务外 enqueue fulfillment（与 confirmManualPayment 一致）
  if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
    const { fulfillmentQueue } = await import('../../../queues/queue.js');
    for (const taskId of pendingFulfillmentTaskIds) {
      void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[orders] failed to enqueue fulfillment task:', e);
      });
    }
  }

  return result;
}

// ════════════════════════════════════════════════════════════════════
// 订单超额 → 挂账池（游客版「存代理余额」；对账时再认领/退款）
// ════════════════════════════════════════════════════════════════════
/**
 * 把订单的多付额转入挂账池。适用于任意订单（游客 OR 代理）——
 * 这是「超额放挂账池」的答案，对应代理单的 creditOverpayToAgent。
 *   一个事务里：订单行锁 → 多付 = paidAmount − total（> 0 才放行）→ paidAmount 回压到 total →
 *   建一笔 OPEN Receipt（source=ORDER_OVERPAY，金额=多付额，method 取最近一笔 Payment 否则 WECHAT_PAY，
 *   payerNote='订单超额 '+orderNo，orderHintId=orderId）。
 * 无多付（paidAmount ≤ total）→ 拒绝。原子。
 */
export async function overpayToPool(svc: OrderService, orderId: string, actor: { userId: string; role: UserRole }): Promise<{
    ok: true;
    orderId: string;
    orderNumber: string;
    movedAmount: number;
    newPaidAmount: number;
    total: number;
    receiptId: string;
    receiptNo: string;
  }> {
  if (!actorCan(actor, 'payments.overpay.handle')) {
    throw new ForbiddenError('仅运营/管理员可将订单超额转入挂账池');
  }

  return prisma.$transaction(async (tx) => {
    // 订单行锁 + 事务内读最新 paidAmount/total（与并发到账/抵扣同一并发安全口径）
    const rows = await tx.$queryRaw<
      Array<{ id: string; orderNumber: string; total: Prisma.Decimal; adjustmentCny: number; paidAmount: Prisma.Decimal; prepaymentOffset: Prisma.Decimal; status: OrderStatus; deletedAt: Date | null }>
    >`SELECT id, "orderNumber", total, "adjustmentCny", "paidAmount", "prepaymentOffset", status, "deletedAt" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = rows[0];
    if (!order) throw new NotFoundError('订单不存在');
    // 资金处置闸：死单/软删单不许再动钱。
    assertOrderAllowsFundsDisposal(order, '将多付转入挂账池');

    const total = Number(order.total);
    const paid = Number(order.paidAmount);
    // 已完成退款先扣（同 creditOverpayToAgent 口径），避免多付被退款+转挂账池取两次。
    const refunded = await sumCompletedRefundsWithinTx(tx, orderId);
    // 多付 = 清账口径下的负尾款（含改期费/预存抵扣），与 creditOverpayToAgent / serializeOrder.balanceDue<0 一字一致。
    const clearingPoint = round2(total + order.adjustmentCny - Number(order.prepaymentOffset));
    const overpay = round2(paid - refunded - clearingPoint);
    if (overpay <= 0) {
      throw new BadRequestError('该订单没有多付金额（已付款扣除已退款 ≤ 应付），无可转入挂账池');
    }

    // method 兜底：取最近一笔**真实收款**的 method（排除负金额对冲行），否则 WECHAT_PAY
    const method = await svc._latestInboundPaymentMethod(tx, orderId);

    // 多付回压：paidAmount 只扣掉本次转出的 overpay（无退款时等于降回清账点，与旧行为一致）。
    await tx.order.update({
      where: { id: orderId },
      data: { paidAmount: new Prisma.Decimal(round2(paid - overpay)) },
    });
    // R6：台账同步登记等额流出，否则订单再进一次 PAID 就会按 SUCCEEDED 合计把多付灌回（造币循环）。
    await svc._recordOverpayDisposalPayment(tx, {
      orderId,
      amountCny: overpay,
      method,
      disposal: 'RECEIPT_POOL',
      description: `订单 ${order.orderNumber} 多付转入挂账池`,
    });

    // 建一笔 OPEN 进账（挂账池），来源标记订单超额
    const receipt = await createOpenReceiptWithinTx(tx, {
      amountCny: overpay,
      method,
      source: ReceiptSource.ORDER_OVERPAY,
      payerNote: `订单超额 ${order.orderNumber}`,
      orderHintId: orderId,
      createdById: actor.userId,
    });

    return {
      ok: true as const,
      orderId,
      orderNumber: order.orderNumber,
      movedAmount: overpay,
      newPaidAmount: round2(paid - overpay),
      total,
      receiptId: receipt.id,
      receiptNo: receipt.receiptNo,
    };
  });
}

/**
 * 批量锁定/解锁订单结算价。不存在或已软删订单不更新并计入 skipped；
 * 每个有效订单独立更新，便于路由层按成功订单逐条写审计。
 *
 * 并发：整批在一个事务里、逐单先 `SELECT ... FOR UPDATE` 再改。与改应收的通道
 * （addPriceAdjustment / 代理自助改结算价）用的是同一把订单行锁，两边互斥：
 * 要么「先上锁 → 后面的改价被锁挡住」，要么「先改完价 → 再上锁」，
 * 不会出现「读到未锁 → 上锁落库 → 那笔改价随后覆盖应收」的中间态。
 */
export async function batchSetSettlementLock(svc: OrderService, ids: string[], lock: boolean, userId: string): Promise<{
    updated: number;
    skipped: number;
    results: Array<{
      id: string;
      orderNumber: string;
      beforeLocked: boolean;
      settlementLockedAt: Date | null;
    }>;
  }> {
  const results = await prisma.$transaction(
    async (tx) => {
      const applied: Array<{
        id: string;
        orderNumber: string;
        beforeLocked: boolean;
        settlementLockedAt: Date | null;
      }> = [];
      // 按 id 排序后再逐单加锁：两个并发批次若按各自的传入顺序抢锁，交叉的两单会互等成死锁。
      // 固定顺序后并发批次只会排队，不会互锁。（顺序只影响加锁次序，审计逐单写、与顺序无关。）
      for (const id of [...ids].sort()) {
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            orderNumber: string;
            settlementLocked: boolean;
            deletedAt: Date | null;
          }>
        >`SELECT id, "orderNumber", "settlementLocked", "deletedAt" FROM "Order" WHERE id = ${id} FOR UPDATE`;
        const order = rows[0];
        // 不存在 / 已软删 → 跳过（计入 skipped，口径不变）。
        if (!order || order.deletedAt) continue;
        const settlementLockedAt = lock ? new Date() : null;
        await tx.order.update({
          where: { id },
          data: {
            settlementLocked: lock,
            settlementLockedAt,
            settlementLockedBy: lock ? userId : null,
          },
        });
        applied.push({
          id,
          orderNumber: order.orderNumber,
          beforeLocked: order.settlementLocked,
          settlementLockedAt,
        });
      }
      return applied;
    },
    // 批量上限 500 单（schema），逐单两次往返；默认 5s 超时对大批量不够用。
    { timeout: 120_000, maxWait: 15_000 },
  );

  return { updated: results.length, skipped: ids.length - results.length, results };
}

/**
 * 批量锁定/解锁收款复核。口径与单单 POST /orders/:id/payments-lock 完全一致：
 * 锁的只是「人工录收款」这道口子（人工确认 / 批量确认在 paymentsLocked 时 409），
 * 网关到账 / 对账认款是真钱已落库，照旧不受影响 —— 批量不另立口径。
 *
 * 跳过而不整批失败：一次勾几十上百单，里面混着已经锁好的、已删的、点错的很正常。
 * 为一单不合条件就把整批回滚，运营只能靠肉眼挑出那一单再来一遍，实际更容易出错；
 * 逐单给出跳过原因、其余照做，才是可收敛的做法。（真锁不上的库级异常仍然整批抛。）
 *
 * 并发：整批一个事务，按 id 排序后逐单 `SELECT ... FOR UPDATE` —— 与 batchSetSettlementLock
 * 同一套加锁纪律（固定顺序 = 并发批次排队而不是交叉互等成死锁）。
 */
export async function batchSetPaymentsLock(svc: OrderService, orderIds: string[], locked: boolean, userId: string): Promise<{
    updated: number;
    skipped: number;
    results: Array<{
      orderId: string;
      orderNumber: string | null;
      ok: boolean;
      reason?: string;
      beforeLocked?: boolean;
      paymentsLockedAt?: Date | null;
    }>;
  }> {
  const results = await prisma.$transaction(
    async (tx) => {
      const acc: Array<{
        orderId: string;
        orderNumber: string | null;
        ok: boolean;
        reason?: string;
        beforeLocked?: boolean;
        paymentsLockedAt?: Date | null;
      }> = [];
      for (const orderId of [...orderIds].sort()) {
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            orderNumber: string;
            paymentsLocked: boolean;
            deletedAt: Date | null;
          }>
        >`SELECT id, "orderNumber", "paymentsLocked", "deletedAt" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        const order = rows[0];
        if (!order) {
          acc.push({ orderId, orderNumber: null, ok: false, reason: '订单不存在' });
          continue;
        }
        if (order.deletedAt) {
          acc.push({
            orderId,
            orderNumber: order.orderNumber,
            ok: false,
            reason: '订单在回收站，请先恢复',
          });
          continue;
        }
        // 已经是目标状态 → 跳过而不是重复写：重复写会凭空多一条审计，看上去像「又锁了一次」，
        // 对账时分不清哪次才是财务真正复核的那一刻。
        if (order.paymentsLocked === locked) {
          acc.push({
            orderId,
            orderNumber: order.orderNumber,
            ok: false,
            reason: locked ? '收款已是锁定状态' : '收款已是解锁状态',
          });
          continue;
        }
        const paymentsLockedAt = locked ? new Date() : null;
        await tx.order.update({
          where: { id: orderId },
          data: {
            paymentsLocked: locked,
            paymentsLockedAt,
            paymentsLockedBy: locked ? userId : null,
          },
        });
        acc.push({
          orderId,
          orderNumber: order.orderNumber,
          ok: true,
          beforeLocked: order.paymentsLocked,
          paymentsLockedAt,
        });
      }
      return acc;
    },
    // 批量上限 500 单（schema），逐单两次往返；默认 5s 超时对大批量不够用。
    { timeout: 120_000, maxWait: 15_000 },
  );

  const updated = results.filter((r) => r.ok).length;
  return { updated, skipped: results.length - updated, results };
}

/**
 * 换人退款：原订单只做一次退款申请，换人费由运营手填留存，其余净收款待财务批准后退回。
 * 接手订单号只作审计记录，不能把任何 Payment 或 paidAmount 转到另一张订单。
 */
export async function swapRefund(
  svc: OrderService,
  orderId: string,
  input: {
    swapFeeCny: number;
    replacementOrderNumber?: string;
    reason: string;
  },
  requester: OrderRequester,
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    netPaidCny: number;
    swapFeeCny: number;
    refundAmountCny: number;
    refundId: string;
  }> {
  if (!actorCan(requester, 'orders.passengers.write')) {
    throw new ForbiddenError('仅运营/管理员可做换人退款');
  }
  const reason = input.reason.trim();
  if (!reason) throw new BadRequestError('请填写换人退款原因');

  const pendingFulfillmentTaskIds: string[] = [];
  const releasedSeatClassIds: string[] = [];

  const result = await prisma.$transaction(async (tx) => {
    // 订单锁必须先于金额读取和所有写入，避免并发收款/退款申请看到同一笔旧净收款。
    const lockedRows = await tx.$queryRaw<
      Array<{
        id: string;
        orderNumber: string;
        paidAmount: Prisma.Decimal;
        status: OrderStatus;
        deletedAt: Date | null;
        internalNotes: string | null;
      }>
    >`
      SELECT id, "orderNumber", "paidAmount", status, "deletedAt", "internalNotes"
      FROM "Order"
      WHERE id = ${orderId}
      FOR UPDATE
    `;
    const locked = lockedRows[0];
    if (!locked) throw new NotFoundError('订单不存在');

    if (locked.deletedAt) {
      throw new BadRequestError('订单在回收站（已软删），不可换人退款；如需操作请先恢复');
    }
    if (!SEAT_HOLDING_STATUSES.includes(locked.status)) {
      throw new BadRequestError(
        `订单当前不在占座中的有效状态（当前为「${zhStatus(locked.status)}」），仅占座中的有效订单可做换人退款；如需操作请先恢复订单`,
      );
    }
    if (!CANCELLABLE_STATUSES.has(locked.status)) {
      throw new BadRequestError(
        `订单当前状态「${zhStatus(locked.status)}」不可做换人退款，仅有效的已支付/处理中/出票完成/改期申请中/已改期订单可操作；请按正常退款流程处理`,
      );
    }

    const pendingRefund = await tx.refund.count({
      where: {
        orderId,
        status: {
          in: [RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING],
        },
      },
    });
    if (pendingRefund > 0) {
      throw new ConflictError('该订单已有待处理退款申请，请先处理该单待办退款申请后再做换人退款');
    }

    const refundedTotal = await sumCompletedRefundsWithinTx(tx, orderId);
    const netPaidCny = round2(Number(locked.paidAmount.toString()) - refundedTotal);
    if (netPaidCny <= 0) {
      throw new BadRequestError(`该订单没有可退的已收款（净收款 ¥${netPaidCny.toFixed(2)}）`);
    }
    if (!Number.isInteger(input.swapFeeCny) || input.swapFeeCny < 0) {
      throw new BadRequestError('换人费必须是大于等于 0 的整数 CNY');
    }
    if (input.swapFeeCny > netPaidCny) {
      throw new BadRequestError(
        `换人费 ¥${input.swapFeeCny.toFixed(2)} 超过净收款 ¥${netPaidCny.toFixed(2)}，请填写不超过净收款的金额`,
      );
    }
    const refundAmountCny = round2(netPaidCny - input.swapFeeCny);

    const replacementOrderNumber = input.replacementOrderNumber?.trim() || undefined;
    if (replacementOrderNumber) {
      const replacement = await tx.order.findUnique({
        where: { orderNumber: replacementOrderNumber },
        select: { id: true, deletedAt: true },
      });
      if (!replacement || replacement.deletedAt) {
        throw new BadRequestError(
          '填写的新订单号不存在，请核对；如果新单还没录，可以先留空，之后再补',
        );
      }
      if (replacement.id === orderId) {
        throw new BadRequestError('新订单号不能填本单自己');
      }
    }

    const requestedAt = new Date();
    const refundReason =
      `换人退款（换人费 ¥${input.swapFeeCny}${replacementOrderNumber ? `，接手订单 ${replacementOrderNumber}` : ''}）：${reason}`;
    const refund = await tx.refund.create({
      data: {
        orderId,
        amount: new Prisma.Decimal(refundAmountCny),
        reason: refundReason,
        status: RefundStatus.REQUESTED,
        // 不写 quoteSnapshot：换人费是售后罚金，佣金冲销按无快照的整单全额冲销。
        gatewayPayload: {
          swapRefund: true,
          swapFeeCny: input.swapFeeCny,
          netPaidCny,
          refundAmountCny,
          replacementOrderNumber: replacementOrderNumber ?? null,
          requestedAt: requestedAt.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    await tx.order.update({
      where: { id: orderId },
      data: {
        swapRefundedAt: requestedAt,
        swapFeeCny: input.swapFeeCny,
        swapReplacementOrderNumber: replacementOrderNumber ?? null,
      },
    });

    await svc._updateStatusWithinTx(
      tx,
      orderId,
      OrderStatus.REFUND_REQUESTED,
      requester,
      reason,
      pendingFulfillmentTaskIds,
      undefined,
      releasedSeatClassIds,
    );

    const noteLine =
      `【换人退款】${businessDateTime(requestedAt)} 换人费 ¥${input.swapFeeCny}，应退 ¥${refundAmountCny}` +
      `${replacementOrderNumber ? `，接手订单 ${replacementOrderNumber}` : ''}。原因：${reason}`;
    const existingNotes = locked.internalNotes ?? '';
    const internalNotes = existingNotes.trim() ? `${existingNotes}\n${noteLine}` : noteLine;
    await tx.order.update({ where: { id: orderId }, data: { internalNotes } });

    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });
    return { order, netPaidCny, refundAmountCny, refundId: refund.id };
  });

  // 事务提交后再入队，避免 worker / 候补检查在提交前读不到新状态和座位账。
  if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
    const { fulfillmentQueue } = await import('../../../queues/queue.js');
    for (const taskId of pendingFulfillmentTaskIds) {
      void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[orders] failed to enqueue fulfillment task:', e);
      });
    }
  }

  // 换人退款会当场释放座位，也要清掉可能尚存的占座自动释放兜底任务。
  try {
    const { cancelSeatHoldRelease } = await import('../../../queues/queue.js');
    await cancelSeatHoldRelease(orderId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[orders] failed to cancel seat-hold job for', orderId, err);
  }

  if (releasedSeatClassIds.length > 0) {
    try {
      const { enqueueWaitlistCheck } = await import('../../../queues/queue.js');
      await Promise.all(
        [...new Set(releasedSeatClassIds)].map((seatClassId) => enqueueWaitlistCheck(seatClassId)),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[orders] failed to enqueue waitlist-check for', orderId, err);
    }
  }

  return {
    order: serializeOrder(result.order, orderSerializeRoleCtx(requester.role)),
    netPaidCny: result.netPaidCny,
    swapFeeCny: input.swapFeeCny,
    refundAmountCny: result.refundAmountCny,
    refundId: result.refundId,
  };
}

/**
 * 补填/修改换人退款接手订单号：只更新源订单的记录字段，不创建 Payment、不改任何订单的 paidAmount。
 */
export async function updateSwapReplacementOrderNumber(
  svc: OrderService,
  orderId: string,
  replacementOrderNumber: string | null,
  requester: OrderRequester,
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    beforeReplacementOrderNumber: string | null;
    replacementOrderNumber: string | null;
  }> {
  if (!actorCan(requester, 'orders.passengers.write')) {
    throw new ForbiddenError('仅运营/管理员可补填接手订单号');
  }

  const normalizedReplacementOrderNumber = replacementOrderNumber?.trim() || null;
  const result = await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<
      Array<{
        id: string;
        orderNumber: string;
        deletedAt: Date | null;
        swapReplacementOrderNumber: string | null;
      }>
    >`
      SELECT id, "orderNumber", "deletedAt", "swapReplacementOrderNumber"
      FROM "Order"
      WHERE id = ${orderId}
      FOR UPDATE
    `;
    const locked = lockedRows[0];
    if (!locked) throw new NotFoundError('订单不存在');
    if (locked.deletedAt) {
      throw new BadRequestError('订单在回收站（已软删），不可修改接手订单号；如需操作请先恢复');
    }

    if (normalizedReplacementOrderNumber) {
      const replacement = await tx.order.findUnique({
        where: { orderNumber: normalizedReplacementOrderNumber },
        select: { id: true, deletedAt: true },
      });
      if (!replacement || replacement.deletedAt) {
        throw new BadRequestError(
          '填写的新订单号不存在，请核对；如果新单还没录，可以先留空，之后再补',
        );
      }
      if (replacement.id === orderId) {
        throw new BadRequestError('新订单号不能填本单自己');
      }
    }

    await tx.order.update({
      where: { id: orderId },
      data: { swapReplacementOrderNumber: normalizedReplacementOrderNumber },
    });
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });
    return {
      order,
      beforeReplacementOrderNumber: locked.swapReplacementOrderNumber,
    };
  });

  return {
    order: serializeOrder(result.order, orderSerializeRoleCtx(requester.role)),
    beforeReplacementOrderNumber: result.beforeReplacementOrderNumber,
    replacementOrderNumber: normalizedReplacementOrderNumber,
  };
}

