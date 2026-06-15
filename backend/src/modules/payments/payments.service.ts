/**
 * 支付服务 —— 对订单创建 Payment 记录 + 对接网关 + 回调后自动转 Order 为 PAID。
 *
 * 关键流程：
 *   1. 客户点支付 → POST /payments → 创建 Payment(PENDING) + 调 adapter 生成付款链接
 *   2. 客户扫码/跳转 → 第三方完成扣款
 *   3. 第三方回调 → /payments/webhook/:provider → 验签 → 标 SUCCEEDED
 *   4. SUCCEEDED 时自动：Order → PAID（走 orders.service 同一套状态机，生成佣金/履约任务）
 *
 * 失败 / 超时：
 *   - 回调校验失败：不改 Payment 状态，返回 400
 *   - 金额不匹配：标记 FAILED，审计告警
 *   - 订单已 CANCELLED：标记 REFUNDED（资金原路退回）
 */
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors.js';
import { getPaymentAdapter } from './payment-adapters.js';
import { OrderService } from '../orders/orders.service.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';

export interface PaymentRequester {
  userId: string;
  role: string;
  /** 当前登录代理的 agentId（如果是 AGENT） */
  agentId?: string;
  /** 系统操作（支付回调）vs 真实用户 */
  actorType?: 'USER' | 'SYSTEM';
}

export class PaymentsService {
  private readonly orderService = new OrderService();

  /**
   * 创建支付：订单必须是 PENDING_PAYMENT 状态；同一订单已有活跃 Payment 会被复用（幂等）。
   */
  async createPayment(
    body: { orderId: string; method: PaymentMethod; returnUrl?: string },
    requester: PaymentRequester,
    baseUrl: string,
  ) {
    const order = await prisma.order.findUnique({ where: { id: body.orderId } });
    if (!order) throw new NotFoundError('订单不存在');

    // 权限：客户只能付自己的单；代理只能付自己+下级的单；ADMIN/STAFF 全部
    if (requester.role === 'CUSTOMER' && order.userId !== requester.userId) {
      throw new ForbiddenError('无权支付该订单');
    }
    if (requester.role === 'AGENT') {
      if (!order.agentId) throw new ForbiddenError('无权支付该订单（非代理单）');
      const descendantIds = await getDescendantAgentIds(requester.agentId);
      if (!descendantIds.includes(order.agentId)) {
        throw new ForbiddenError('无权支付该订单');
      }
    }

    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestError(`订单状态 ${order.status}，无法发起支付`);
    }

    // 幂等：找当前活跃 Payment
    const existing = await prisma.payment.findFirst({
      where: { orderId: order.id, status: PaymentStatus.PENDING, method: body.method },
      orderBy: { createdAt: 'desc' },
    });

    const adapter = getPaymentAdapter(body.method);

    let payment;
    if (existing) {
      payment = existing;
    } else {
      payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          method: body.method,
          amount: order.total,
          status: PaymentStatus.PENDING,
        },
      });
    }

    // 调 adapter 生成支付 URL
    const result = await adapter.createPayment({
      paymentId: payment.id,
      orderNumber: order.orderNumber,
      amountYuan: Number(order.total),
      title: `世途旅行 订单 ${order.orderNumber}`,
      notifyUrl: `${baseUrl}/payments/webhook/${adapterSlug(body.method)}`,
      returnUrl: body.returnUrl,
    });

    // 把 transactionId / 原始响应存下来
    if (result.transactionId) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          transactionId: result.transactionId,
          gatewayPayload: (result.raw ?? null) as Prisma.InputJsonValue,
        },
      });
    }

    return {
      paymentId: payment.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      method: body.method,
      amount: order.total.toString(),
      status: payment.status,
      paymentUrl: result.paymentUrl,
      needsPolling: result.needsPolling,
      transactionId: result.transactionId ?? null,
    };
  }

  /**
   * 处理网关回调（验签后）→ 标 Payment 为 SUCCEEDED → Order 转 PAID。
   * verifyCallback 内容由 adapter 完成；这里只处理业务后续。
   */
  async handleCallback(
    method: PaymentMethod,
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<{ ok: true; paymentId: string; orderId: string } | { ok: false; reason: string }> {
    const adapter = getPaymentAdapter(method);
    const verification = adapter.verifyCallback(headers, body);
    if (!verification.valid) {
      return { ok: false, reason: verification.reason ?? 'invalid signature' };
    }
    if (!verification.paymentId) {
      return { ok: false, reason: 'no paymentId in callback' };
    }

    const payment = await prisma.payment.findUnique({
      where: { id: verification.paymentId },
      include: { order: true },
    });
    if (!payment) {
      return { ok: false, reason: 'payment not found' };
    }

    // 幂等：已处理的回调直接返回成功（第三方会重试）
    if (payment.status === PaymentStatus.SUCCEEDED) {
      return { ok: true, paymentId: payment.id, orderId: payment.orderId };
    }

    if (payment.status !== PaymentStatus.PENDING) {
      return { ok: false, reason: `payment already ${payment.status}` };
    }

    // 金额校验（不匹配直接拒，不落 FAILED —— 外部可能重试）
    if (verification.amountYuan !== undefined && Math.abs(Number(payment.amount) - verification.amountYuan) > 0.01) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED, gatewayPayload: (verification.rawPayload ?? null) as Prisma.InputJsonValue },
      });
      return { ok: false, reason: `amount mismatch (expected ${payment.amount}, got ${verification.amountYuan})` };
    }

    // 订单已 CANCELLED/PAYMENT_TIMEOUT：资金要退回
    if (payment.order.status === OrderStatus.CANCELLED || payment.order.status === OrderStatus.PAYMENT_TIMEOUT) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.REFUNDED,
          paidAt: new Date(),
          gatewayPayload: (verification.rawPayload ?? null) as Prisma.InputJsonValue,
        },
      });
      throw new ConflictError(`订单已 ${payment.order.status}，资金将原路退回`);
    }

    // ── 原子事务：Payment SUCCEEDED + Order PAID + 佣金 + 履约任务 一起成功或一起回滚 ──
    const pendingFulfillmentTaskIds: string[] = [];
    try {
      await prisma.$transaction(async (tx) => {
        // 1. Payment → SUCCEEDED (CAS 防并发)
        const casPayment = await tx.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: {
            status: PaymentStatus.SUCCEEDED,
            paidAt: verification.paidAt ?? new Date(),
            transactionId: verification.transactionId ?? payment.transactionId,
            gatewayPayload: (verification.rawPayload ?? null) as Prisma.InputJsonValue,
          },
        });
        if (casPayment.count !== 1) {
          throw new ConflictError('payment status changed during callback');
        }

        // 2. Order → PAID（若仍在 PENDING_PAYMENT；共用同一事务）
        if (payment.order.status === OrderStatus.PENDING_PAYMENT) {
          await this.orderService._updateStatusWithinTx(
            tx,
            payment.orderId,
            OrderStatus.PAID,
            { userId: 'system-payment-gateway', role: 'ADMIN', actorType: 'SYSTEM' },
            `支付成功（${method}，txId=${verification.transactionId}）`,
            pendingFulfillmentTaskIds,
          );
        }
      });
    } catch (e) {
      // 事务回滚：Payment 仍 PENDING，不会出现"已扣款但订单未推进"的状态分叉
      // eslint-disable-next-line no-console
      console.error('[payments] atomic callback transaction failed:', e);
      throw e; // 让网关看到 5xx 以便重试；或上游视情况兜底
    }

    // 事务外 enqueue fulfillment（jobId 用 taskId 做去重）
    if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
      const { fulfillmentQueue } = await import('../../queues/queue.js');
      for (const taskId of pendingFulfillmentTaskIds) {
        void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[payments] failed to enqueue fulfillment task:', e);
        });
      }
    }

    return { ok: true, paymentId: payment.id, orderId: payment.orderId };
  }

  /**
   * 人工确认收款（线下收款 → 后台标记）。ADMIN/STAFF 用。
   * 建 Payment(SUCCEEDED, proofUrl) → 累加 paidAmount → 全额则 Order→PAID
   * （同一事务，复用 _updateStatusWithinTx 生成佣金/履约任务）。
   */
  async confirmManualPayment(
    orderId: string,
    input: { amount?: number; method: PaymentMethod; proofUrl?: string; note?: string; idempotencyKey?: string },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    ok: true;
    paymentId: string;
    paidAmount: number;
    total: number;
    fullyPaid: boolean;
    orderNumber: string;
    status: OrderStatus;
  }> {
    // 幂等回放：同一 idempotencyKey 已入账（双击/网络重试）→ 返回当时结果，绝不二次累计
    if (input.idempotencyKey) {
      const existing = await prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, orderId: true },
      });
      if (existing) {
        const o = await prisma.order.findUniqueOrThrow({
          where: { id: existing.orderId },
          select: { orderNumber: true, total: true, paidAmount: true, status: true },
        });
        const t = Number(o.total);
        const p = Number(o.paidAmount);
        return { ok: true, paymentId: existing.id, paidAmount: p, total: t, fullyPaid: p + 0.001 >= t, orderNumber: o.orderNumber, status: o.status };
      }
    }

    const pendingFulfillmentTaskIds: string[] = [];
    let paymentId = '';
    let newPaid = 0;
    let total = 0;
    let fullyPaid = false;
    let orderNumber = '';
    let statusBefore: OrderStatus = OrderStatus.PENDING_PAYMENT;

    try {
      await prisma.$transaction(async (tx) => {
      // FOR UPDATE 行锁 + 事务内读余额：并发确认不会用旧快照双计 paidAmount
      const rows = await tx.$queryRaw<
        Array<{ id: string; orderNumber: string; total: Prisma.Decimal; paidAmount: Prisma.Decimal; status: OrderStatus }>
      >`SELECT id, "orderNumber", total, "paidAmount", status FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = rows[0];
      if (!order) throw new NotFoundError('订单不存在');

      total = Number(order.total);
      const already = Number(order.paidAmount);
      const remaining = Math.max(0, total - already);
      const amount = input.amount ?? remaining;
      if (amount <= 0) throw new BadRequestError('收款金额必须大于 0');
      if (amount > remaining + 0.001) {
        throw new BadRequestError(`收款金额超过应收余额（应收 ¥${remaining.toFixed(2)}）`);
      }
      newPaid = already + amount;
      fullyPaid = newPaid + 0.001 >= total;
      orderNumber = order.orderNumber;
      statusBefore = order.status;

      const payment = await tx.payment.create({
        data: {
          orderId,
          method: input.method,
          amount: new Prisma.Decimal(amount),
          status: PaymentStatus.SUCCEEDED,
          paidAt: new Date(),
          idempotencyKey: input.idempotencyKey ?? null,
          proofUrl: input.proofUrl ?? null,
          gatewayPayload: {
            manual: true,
            note: input.note ?? null,
            confirmedBy: actor.userId,
          } as Prisma.InputJsonValue,
        },
      });
      paymentId = payment.id;
      await tx.order.update({
        where: { id: orderId },
        data: { paidAmount: new Prisma.Decimal(newPaid) },
      });
      if (fullyPaid && order.status === OrderStatus.PENDING_PAYMENT) {
        await this.orderService._updateStatusWithinTx(
          tx,
          orderId,
          OrderStatus.PAID,
          { userId: actor.userId, role: actor.role, actorType: 'USER' },
          `人工确认收款（${input.method}，¥${amount.toFixed(2)}）`,
          pendingFulfillmentTaskIds,
        );
      }
      });
    } catch (e) {
      // 并发同 key 撞唯一索引（P2002）→ 另一请求已入账，走幂等回放
      if (input.idempotencyKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.confirmManualPayment(orderId, input, actor);
      }
      throw e;
    }

    if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
      const { fulfillmentQueue } = await import('../../queues/queue.js');
      for (const taskId of pendingFulfillmentTaskIds) {
        void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[payments] failed to enqueue fulfillment task:', e);
        });
      }
    }

    return {
      ok: true,
      paymentId,
      paidAmount: newPaid,
      total,
      fullyPaid,
      orderNumber,
      status: fullyPaid ? OrderStatus.PAID : statusBefore,
    };
  }

  /**
   * 微信小程序 JSAPI 支付 — 生成 wx.requestPayment 所需参数。
   *
   * 和 createPayment(method=WECHAT_PAY) 的区别：Native 走 transactions_native → 扫码
   * 这里走 transactions_jsapi → 返回 prepay_id + 签名后的客户端参数
   *
   * 开发模式（无 WECHAT_APPID 或 user 没 openid）：
   *   - 返回 mock 参数，前端在 DevTools 里 wx.requestPayment 会失败但不会崩
   *   - 本机测试走 sandbox webhook 强推 PAID
   */
  async createMiniappPayment(
    body: { orderId: string },
    requester: PaymentRequester,
    baseUrl: string,
  ): Promise<{
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: 'RSA' | 'MD5' | 'HMAC-SHA256';
    paySign: string;
  }> {
    const order = await prisma.order.findUnique({ where: { id: body.orderId } });
    if (!order) throw new NotFoundError('订单不存在');

    // 只有订单本人 / 代理链上层 / staff 可付
    if (requester.role === 'CUSTOMER' && order.userId !== requester.userId) {
      throw new ForbiddenError('无权支付该订单');
    }
    if (requester.role === 'AGENT') {
      if (!order.agentId) throw new ForbiddenError('无权支付该订单');
      const descendantIds = await getDescendantAgentIds(requester.agentId);
      if (!descendantIds.includes(order.agentId)) {
        throw new ForbiddenError('无权支付该订单');
      }
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestError(`订单状态 ${order.status}，无法发起支付`);
    }

    // 需要用户的 openid（wx.login 注册时写入）。游客单（userId=null）无微信归属，
    // 不能走小程序 JSAPI 支付（游客付款走其他通道）。
    if (!order.userId) {
      throw new BadRequestError('游客订单不支持小程序 JSAPI 支付，请走收款码或登录后支付');
    }
    const user = await prisma.user.findUnique({ where: { id: order.userId } });
    const openid = user?.wechatOpenId;
    if (!openid) {
      throw new BadRequestError('该用户未绑定微信 openid，不能走小程序 JSAPI 支付');
    }

    // 幂等：同订单已有 PENDING wx 支付就复用
    let payment = await prisma.payment.findFirst({
      where: { orderId: order.id, status: PaymentStatus.PENDING, method: PaymentMethod.WECHAT_PAY },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          method: PaymentMethod.WECHAT_PAY,
          amount: order.total,
          status: PaymentStatus.PENDING,
        },
      });
    }

    const { createMiniappJsapiPayment } = await import('./payment-adapters.js');
    return createMiniappJsapiPayment({
      paymentId: payment.id,
      orderNumber: order.orderNumber,
      amountYuan: Number(order.total),
      title: `世途旅行 订单 ${order.orderNumber}`,
      notifyUrl: `${baseUrl}/payments/webhook/wechat`,
      openid,
    });
  }
}

// getDescendantAgentIds — 已抽到 lib/agent-tree.ts

function adapterSlug(method: PaymentMethod): string {
  switch (method) {
    case PaymentMethod.WECHAT_PAY: return 'wechat';
    case PaymentMethod.ALIPAY: return 'alipay';
    case PaymentMethod.BANK_CARD: return 'bankcard';
    case PaymentMethod.AGENT_PREPAYMENT: return 'prepayment';
  }
}

