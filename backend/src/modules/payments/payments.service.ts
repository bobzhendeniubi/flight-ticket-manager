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
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors.js';
import { getPaymentAdapter } from './payment-adapters.js';
import { OrderService } from '../orders/orders.service.js';

export interface PaymentRequester {
  userId: string;
  role: string;
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

    // 权限：客户只能付自己的单；ADMIN/STAFF 全部
    if (requester.role === 'CUSTOMER' && order.userId !== requester.userId) {
      throw new ForbiddenError('无权支付该订单');
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

    // 金额校验
    if (verification.amountYuan !== undefined && Math.abs(Number(payment.amount) - verification.amountYuan) > 0.01) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED, gatewayPayload: (verification.rawPayload ?? null) as Prisma.InputJsonValue },
      });
      return { ok: false, reason: `amount mismatch (expected ${payment.amount}, got ${verification.amountYuan})` };
    }

    // 订单状态：如果已 CANCELLED，资金要退回（暂先标 REFUNDED 不继续）
    if (payment.order.status === OrderStatus.CANCELLED || payment.order.status === OrderStatus.PAYMENT_TIMEOUT) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.REFUNDED, paidAt: new Date(), gatewayPayload: (verification.rawPayload ?? null) as Prisma.InputJsonValue },
      });
      throw new ConflictError(`订单已 ${payment.order.status}，资金将原路退回`);
    }

    // 标 Payment → SUCCEEDED，然后转 Order → PAID
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.SUCCEEDED,
        paidAt: verification.paidAt ?? new Date(),
        transactionId: verification.transactionId ?? payment.transactionId,
        gatewayPayload: (verification.rawPayload ?? null) as Prisma.InputJsonValue,
      },
    });

    // 订单流转：用 SYSTEM 身份操作
    if (payment.order.status === OrderStatus.PENDING_PAYMENT) {
      try {
        await this.orderService.updateStatus(
          payment.orderId,
          OrderStatus.PAID,
          { userId: 'system-payment-gateway', role: 'ADMIN' },
          `支付成功（${method}，txId=${verification.transactionId}）`,
        );
      } catch (e) {
        // 已扣款但订单无法转 PAID（罕见；可能是并发）：运营需要手工介入
        // eslint-disable-next-line no-console
        console.error('[payments] payment SUCCEEDED but order advance failed:', e);
      }
    }

    return { ok: true, paymentId: payment.id, orderId: payment.orderId };
  }
}

function adapterSlug(method: PaymentMethod): string {
  switch (method) {
    case PaymentMethod.WECHAT_PAY: return 'wechat';
    case PaymentMethod.ALIPAY: return 'alipay';
    case PaymentMethod.BANK_CARD: return 'bankcard';
    case PaymentMethod.AGENT_PREPAYMENT: return 'prepayment';
  }
}
