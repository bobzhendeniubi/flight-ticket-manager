/**
 * 支付路由
 *   POST /payments                         创建支付（登录用户）
 *   POST /payments/webhook/:provider        支付网关回调（公共，靠签名验证）
 *   POST /payments/:id/sandbox-confirm      仅 sandbox 模式下用于测试回调
 *   POST /payments/:paymentId/transfer      ADMIN/STAFF 转移已成功收款
 *   GET  /payments/:id                      查询支付状态（登录用户）
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PaymentMethod, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  BadRequestError,
  NotFoundError,
} from '../../lib/errors.js';
import { PaymentsService } from './payments.service.js';
import {
  cnyAmountSchema,
  createPaymentBodySchema,
  sandboxConfirmBodySchema,
  transferManualPaymentBodySchema,
} from './payments.schemas.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { appPublicUrl } from '../../config/env.js';

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
    // baseUrl 必须从 env 读，不能用 req.headers.host（可被 Host header 伪造）
    // 用户侧看到的域名可能和后端公网域名不同；webhook 走后端真实公网 URL
    const baseUrl = `${appPublicUrl.replace(/\/$/, '')}/api`;
    // AGENT 角色需补 agentId 做权限校验
    let agentId: string | undefined;
    if (req.user.role === 'AGENT') {
      const agent = await prisma.agent.findUnique({
        where: { userId: req.user.sub },
        select: { id: true },
      });
      agentId = agent?.id;
    }
    const result = await service.createPayment(
      body,
      { userId: req.user.sub, role: req.user.role, agentId, actorType: 'USER' },
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

  // ── 人工确认收款（线下收款 → 后台标记 + 上传截图）ADMIN/STAFF ──
  // POST /payments/manual-confirm
  const manualConfirmSchema = z.object({
    orderId: z.string().min(1),
    // 金额到分为止（超两位小数直接 400）：落库是 Decimal(…,2)，静默四舍五入会凭空增减半分。
    amount: cnyAmountSchema.optional(),
    method: z.nativeEnum(PaymentMethod),
    proofUrl: z.string().max(6_000_000).optional(), // data URL（截图）
    note: z.string().max(500).optional(),
    idempotencyKey: z.string().min(8).max(64).optional(), // 同 key 重试只入账一次
    // 同额防呆软闸放行：近 10 分钟内该订单已有等额手工收款时，服务端返回 409 + code DUPLICATE_AMOUNT；
    // 前端弹二次确认后带 confirmDuplicate:true 重提，确认这是另一笔真实到账（超收硬闸不受此放行影响）。
    confirmDuplicate: z.boolean().optional(),
  });
  app.post('/manual-confirm', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== UserRole.ADMIN && req.user.role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可确认收款' });
    }
    const body = manualConfirmSchema.parse(req.body);
    const result = await service.confirmManualPayment(
      body.orderId,
      { amount: body.amount, method: body.method, proofUrl: body.proofUrl, note: body.note, idempotencyKey: body.idempotencyKey, confirmDuplicate: body.confirmDuplicate },
      { userId: req.user.sub, role: req.user.role },
    );
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CONFIRM_MANUAL_PAYMENT',
      targetType: 'ORDER',
      targetId: body.orderId,
      targetLabel: result.orderNumber,
      after: {
        amount: body.amount ?? null,
        method: body.method,
        fullyPaid: result.fullyPaid,
        hasProof: Boolean(body.proofUrl),
        // 超收拆分时录入金额 ≠ 记进订单的金额，这里同时留下两半的去向（服务层另有
        // SPLIT_OVERPAY_TO_POOL 一条 WARNING 明细）；未拆分时三个字段都是 null。
        creditedToOrder: result.overpaySplit?.creditedAmount ?? null,
        movedToPool: result.overpaySplit?.pooledAmount ?? null,
        poolReceiptNo: result.overpaySplit?.receiptNo ?? null,
      },
    });
    return result;
  });

  // ── 撤销手工确认收款（更正录入错误）ADMIN/STAFF ──
  // POST /payments/:paymentId/reverse
  const reverseManualPaymentSchema = z.object({
    reason: z.string().trim().min(4).max(200),
  });
  app.post('/:paymentId/reverse', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== UserRole.ADMIN && req.user.role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可撤销收款' });
    }
    const { paymentId } = req.params as { paymentId: string };
    const body = reverseManualPaymentSchema.parse(req.body);
    return service.reverseManualPayment(
      paymentId,
      { reason: body.reason },
      { userId: req.user.sub, role: req.user.role },
    );
  });

  // ── 已成功收款转移到另一订单 ADMIN/STAFF ──
  // POST /payments/:paymentId/transfer
  app.post('/:paymentId/transfer', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== UserRole.ADMIN && req.user.role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可转移收款' });
    }
    const { paymentId } = req.params as { paymentId: string };
    const body = transferManualPaymentBodySchema.parse(req.body);
    return service.transferManualPayment(
      paymentId,
      { targetOrderNumber: body.targetOrderNumber, reason: body.reason },
      { userId: req.user.sub, role: req.user.role },
    );
  });

  // ── 财务核实一笔人工录入的收款（到账双状态第二段）ADMIN/STAFF ──
  // POST /payments/:paymentId/verify
  app.post('/:paymentId/verify', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== UserRole.ADMIN && req.user.role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅财务/运营/管理员可核实到账' });
    }
    const { paymentId } = req.params as { paymentId: string };
    return service.verifyManualPayment(paymentId, { userId: req.user.sub, role: req.user.role });
  });

  // ── 待财务核实的订单收款清单（对账台异常队列）ADMIN/STAFF ──
  // GET /payments/unverified
  app.get('/unverified', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== UserRole.ADMIN && req.user.role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅财务/运营/管理员可查看待核实清单' });
    }
    return { items: await service.listUnverifiedPayments() };
  });

  // ── 批量确认收款（选多个订单一次到账）ADMIN/STAFF ──
  // POST /payments/batch-confirm
  const batchConfirmSchema = z.object({
    items: z
      .array(
        z.object({
          orderId: z.string().min(1),
          amount: cnyAmountSchema,
          method: z.nativeEnum(PaymentMethod).optional(),
          proofUrl: z.string().max(6_000_000).optional(),
          note: z.string().max(500).optional(),
        }),
      )
      .min(1)
      .max(100),
    sharedProofUrl: z.string().max(6_000_000).optional(),
    // 幂等：前端为「本次提交」生成一个稳定 batchId（表单打开时生成一次，成功后换新）。
    // 同一 batchId 重复提交（双击/网络重试/表单重发）时，每一行只入账一次——逐行幂等键
    // = `batch:{batchId}:{orderId}`（同一订单的第 2 行起带 `#n`，一单收两笔的场景不会被
    // 当成重放吞掉），复用单笔 manual-confirm 的唯一约束 + 回放逻辑。
    // 回放前会比请求指纹（订单/金额/方式）：同一把 key 换了内容 → 409，绝不假成功。
    batchId: z.string().min(8).max(64).optional(),
  });
  app.post('/batch-confirm', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== UserRole.ADMIN && req.user.role !== UserRole.STAFF) {
      return reply.status(403).send({ error: '仅运营/管理员可确认收款' });
    }
    const body = batchConfirmSchema.parse(req.body);
    const result = await service.batchConfirmManualPayment(
      { items: body.items, sharedProofUrl: body.sharedProofUrl, batchId: body.batchId },
      { userId: req.user.sub, role: req.user.role },
    );
    const okCount = result.results.filter((r) => r.ok).length;
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'BATCH_CONFIRM_MANUAL_PAYMENT',
      targetType: 'ORDER',
      targetLabel: `batch(${result.results.length})`,
      after: { total: result.results.length, ok: okCount, failed: result.results.length - okCount },
    });
    return result;
  });

  // ── 小程序 JSAPI 支付（生成 wx.requestPayment 参数） ─────
  app.post('/wechat/miniapp-prepay', { preHandler: [app.authenticate] }, async (req) => {
    const body = z.object({ orderId: z.string().min(1) }).parse(req.body);
    const baseUrl = `${appPublicUrl.replace(/\/$/, '')}/api`;
    let agentId: string | undefined;
    if (req.user.role === 'AGENT') {
      const agent = await prisma.agent.findUnique({
        where: { userId: req.user.sub },
        select: { id: true },
      });
      agentId = agent?.id;
    }
    const params = await service.createMiniappPayment(
      { orderId: body.orderId },
      { userId: req.user.sub, role: req.user.role, agentId, actorType: 'USER' },
      baseUrl,
    );

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'MINIAPP_PREPAY',
      targetType: 'ORDER',
      targetId: body.orderId,
      targetLabel: body.orderId,
    });

    return params;
  });

  // ── 查询支付状态 ────────────────────────────────────
  app.get('/:id', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const p = await prisma.payment.findUnique({
      where: { id },
      include: {
        order: { select: { id: true, orderNumber: true, userId: true, agentId: true, status: true } },
      },
    });
    if (!p) throw new NotFoundError('支付不存在');

    // 权限：客户只能看自己的；代理只能看自己+下级的；ADMIN/STAFF 全部
    if (req.user.role === 'CUSTOMER' && p.order.userId !== req.user.sub) {
      throw new NotFoundError('支付不存在');
    }
    if (req.user.role === 'AGENT') {
      const agent = await prisma.agent.findUnique({
        where: { userId: req.user.sub },
        select: { id: true },
      });
      if (!agent || !p.order.agentId) {
        throw new NotFoundError('支付不存在');
      }
      // 递归查可见代理集合
      const visible = new Set<string>([agent.id]);
      let frontier = [agent.id];
      while (frontier.length) {
        const kids = await prisma.agent.findMany({
          where: { parentAgentId: { in: frontier } },
          select: { id: true },
        });
        frontier = kids.map((k) => k.id).filter((id) => !visible.has(id));
        frontier.forEach((id) => visible.add(id));
      }
      if (!visible.has(p.order.agentId)) {
        throw new NotFoundError('支付不存在');
      }
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

  // ── 沙箱测试口 — 仅 development 环境 + ADMIN，生产一律 404 ─────
  app.post(
    '/sandbox-confirm',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req, reply) => {
      // 生产环境（NODE_ENV=production）一律 404 — 防止部署时 PAYMENT_MODE 忘改
      if (process.env.NODE_ENV === 'production') {
        throw new NotFoundError();
      }
      if ((process.env.PAYMENT_MODE ?? 'sandbox') === 'live') {
        throw new NotFoundError();
      }
      const body = sandboxConfirmBodySchema.parse(req.body);

      if (body.shouldFail) {
        await prisma.payment.update({
          where: { id: body.paymentId },
          data: { status: 'FAILED' },
        });
        return reply.send({ ok: false, message: 'marked FAILED' });
      }

      const fakeHeaders = { 'x-sandbox-secret': process.env.SANDBOX_WEBHOOK_SECRET ?? 'sandbox-test-secret' };
      const p = await prisma.payment.findUnique({ where: { id: body.paymentId } });
      if (!p) throw new NotFoundError('支付不存在');

      const result = await service.handleCallback(p.method, fakeHeaders, {
        paymentId: body.paymentId,
        transactionId: body.transactionId ?? p.transactionId,
        amountYuan: body.amountYuan ?? Number(p.amount),
      });

      return reply.send(result);
    },
  );
};
