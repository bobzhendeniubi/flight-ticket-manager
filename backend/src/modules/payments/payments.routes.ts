/**
 * 支付路由
 *   POST /payments                         创建支付（登录用户）
 *   POST /payments/webhook/:provider        支付网关回调（公共，靠签名验证）
 *   POST /payments/:id/sandbox-confirm      仅 sandbox 模式下用于测试回调
 *   GET  /payments/:id                      查询支付状态（登录用户）
 */
import type { FastifyPluginAsync } from 'fastify';
import { PaymentMethod } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  BadRequestError,
  NotFoundError,
} from '../../lib/errors.js';
import { PaymentsService } from './payments.service.js';
import { createPaymentBodySchema, sandboxConfirmBodySchema } from './payments.schemas.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';

const PROVIDER_TO_METHOD: Record<string, PaymentMethod> = {
  wechat: PaymentMethod.WECHAT_PAY,
  alipay: PaymentMethod.ALIPAY,
  bankcard: PaymentMethod.BANK_CARD,
  prepayment: PaymentMethod.AGENT_PREPAYMENT,
};

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  const service = new PaymentsService();

  // ── 创建支付 ───────────────────────────────────────
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = createPaymentBodySchema.parse(req.body);
    const baseUrl = `${req.protocol}://${req.headers.host}/api`;
    const result = await service.createPayment(
      body,
      { userId: req.user.sub, role: req.user.role },
      baseUrl,
    );

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_PAYMENT',
      targetType: 'ORDER',
      targetId: result.orderId,
      targetLabel: result.orderNumber,
      after: { method: result.method, amount: result.amount, paymentId: result.paymentId },
    });

    return reply.status(201).send(result);
  });

  // ── 查询支付状态 ────────────────────────────────────
  app.get('/:id', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const p = await prisma.payment.findUnique({
      where: { id },
      include: { order: { select: { id: true, orderNumber: true, userId: true, status: true } } },
    });
    if (!p) throw new NotFoundError('支付不存在');

    // 权限：客户只能看自己的
    if (req.user.role === 'CUSTOMER' && p.order.userId !== req.user.sub) {
      throw new NotFoundError('支付不存在');
    }

    return {
      payment: {
        id: p.id,
        orderId: p.orderId,
        orderNumber: p.order.orderNumber,
        orderStatus: p.order.status,
        method: p.method,
        amount: p.amount.toString(),
        status: p.status,
        transactionId: p.transactionId,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
      },
    };
  });

  // ── 网关回调（生产）──────────────────────────────────
  // 路径如 POST /payments/webhook/wechat
  app.post('/webhook/:provider', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const method = PROVIDER_TO_METHOD[provider];
    if (!method) throw new BadRequestError(`未知支付渠道：${provider}`);

    const result = await service.handleCallback(method, req.headers, req.body);
    if (!result.ok) {
      void writeAudit({
        actor: { role: 'SYSTEM', label: `gateway:${provider}` },
        action: 'PAYMENT_CALLBACK_REJECTED',
        targetType: 'ORDER',
        targetLabel: provider,
        after: { reason: result.reason },
        severity: 'WARNING',
      });
      return reply.status(400).send({ error: { code: 'INVALID_CALLBACK', message: result.reason } });
    }

    void writeAudit({
      actor: { role: 'SYSTEM', label: `gateway:${provider}` },
      action: 'PAYMENT_SUCCEEDED',
      targetType: 'ORDER',
      targetId: result.orderId,
      after: { paymentId: result.paymentId, provider },
      severity: 'CRITICAL',
    });

    // 微信/支付宝习惯回 { code: 'SUCCESS' } 或 <xml>
    return reply.send({ code: 'SUCCESS' });
  });

  // ── 沙箱测试口（仅 PAYMENT_MODE != live 时启用）─────────
  app.post('/sandbox-confirm', async (req, reply) => {
    if ((process.env.PAYMENT_MODE ?? 'sandbox') === 'live') {
      throw new NotFoundError(); // 生产环境 404
    }
    const body = sandboxConfirmBodySchema.parse(req.body);

    if (body.shouldFail) {
      // 直接标 FAILED
      await prisma.payment.update({
        where: { id: body.paymentId },
        data: { status: 'FAILED' },
      });
      return reply.send({ ok: false, message: 'marked FAILED' });
    }

    // 注入 sandbox 签名让 adapter 通过验签
    const fakeHeaders = { 'x-sandbox-secret': process.env.SANDBOX_WEBHOOK_SECRET ?? 'sandbox-test-secret' };
    const p = await prisma.payment.findUnique({ where: { id: body.paymentId } });
    if (!p) throw new NotFoundError('支付不存在');

    const result = await service.handleCallback(p.method, fakeHeaders, {
      paymentId: body.paymentId,
      transactionId: body.transactionId ?? p.transactionId,
      amountYuan: body.amountYuan ?? Number(p.amount),
    });

    return reply.send(result);
  });
};
