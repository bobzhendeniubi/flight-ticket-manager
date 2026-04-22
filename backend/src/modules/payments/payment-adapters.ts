/**
 * 支付网关适配器接口 — 统一 WeChat Pay / Alipay / Sandbox 的调用差异。
 *
 * 真实环境切换：
 *   - WeChatPayAdapter：对接微信 JSAPI / Native 下单（需 mch_id + appId + apiKey）
 *   - AlipayAdapter：对接支付宝当面付（需 alipay_appid + public_key + private_key）
 *   - SandboxAdapter：开发 / 测试用，立即生成"成功"态
 *
 * 所有 adapter 都要提供：
 *   createPayment  - 生成支付链接 / 二维码
 *   verifyCallback - 校验回调签名
 */
import crypto from 'node:crypto';
import { PaymentMethod } from '@prisma/client';

export interface CreatePaymentInput {
  paymentId: string;        // 我们的 Payment.id（作为 out_trade_no）
  orderNumber: string;       // 订单号（展示）
  amountYuan: number;        // CNY 金额（元）
  title: string;             // 商品描述
  notifyUrl: string;         // 回调 URL（收款方通知我方）
  returnUrl?: string;        // 前端跳转 URL（h5）
}

export interface CreatePaymentResult {
  /** 给前端用的支付 URL 或二维码内容 */
  paymentUrl: string;
  /** 支付方的流水号（未成功前可能为空） */
  transactionId?: string;
  /** 是否需要前端轮询（沙箱立即成功所以 false） */
  needsPolling: boolean;
  raw?: unknown;             // 原始响应
}

export interface CallbackVerifyResult {
  valid: boolean;
  paymentId?: string;        // out_trade_no
  transactionId?: string;
  amountYuan?: number;
  paidAt?: Date;
  rawPayload?: unknown;
  reason?: string;           // 校验失败原因
}

export interface PaymentAdapter {
  readonly method: PaymentMethod;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyCallback(headers: Record<string, string | string[] | undefined>, body: unknown): CallbackVerifyResult;
}

// ══════════════════════════════════════════════════════════════════
// Sandbox Adapter — 立即 "成功"，用于开发联调
// ══════════════════════════════════════════════════════════════════
export class SandboxAdapter implements PaymentAdapter {
  readonly method: PaymentMethod;
  constructor(method: PaymentMethod) {
    this.method = method;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    // 模拟一个可跳转的付款页
    const fakeTxId = 'SBX' + Date.now() + crypto.randomBytes(4).toString('hex');
    return {
      paymentUrl: `/sandbox-pay?paymentId=${encodeURIComponent(input.paymentId)}&amount=${input.amountYuan}`,
      transactionId: fakeTxId,
      needsPolling: false,
      raw: { provider: 'sandbox', fakeTxId },
    };
  }

  verifyCallback(headers: Record<string, string | string[] | undefined>, body: unknown) {
    // Sandbox 回调：body = { paymentId, transactionId, amountYuan }
    // 校验 header 里的 "x-sandbox-secret" 必须匹配 env.SANDBOX_WEBHOOK_SECRET
    const h = headers['x-sandbox-secret'];
    const secret = process.env.SANDBOX_WEBHOOK_SECRET ?? 'sandbox-test-secret';
    if (h !== secret) {
      return { valid: false, reason: 'x-sandbox-secret mismatch' };
    }
    const b = body as { paymentId?: string; transactionId?: string; amountYuan?: number };
    if (!b?.paymentId) return { valid: false, reason: 'missing paymentId' };
    return {
      valid: true,
      paymentId: b.paymentId,
      transactionId: b.transactionId,
      amountYuan: b.amountYuan,
      paidAt: new Date(),
      rawPayload: body,
    };
  }
}

// ══════════════════════════════════════════════════════════════════
// WeChat Pay Adapter (骨架 — 待真实 SDK 接入)
// ══════════════════════════════════════════════════════════════════
export class WeChatPayAdapter implements PaymentAdapter {
  readonly method = PaymentMethod.WECHAT_PAY;

  async createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    // TODO: 接入 wechatpay-node-v3
    // const wxpay = new WxPay({ appid, mchid, privateKey, publicKey });
    // const result = await wxpay.transactions_native({ description: input.title, out_trade_no: input.paymentId, notify_url: input.notifyUrl, amount: { total: input.amountYuan * 100, currency: 'CNY' } });
    throw new Error('WeChat Pay adapter not yet implemented — configure WECHAT_* env vars and install wechatpay-node-v3');
  }

  verifyCallback(_headers: Record<string, string | string[] | undefined>, _body: unknown): CallbackVerifyResult {
    // TODO: wxpay.verifySign(headers, body)
    return { valid: false, reason: 'WeChat Pay callback verifier not yet implemented' };
  }
}

// ══════════════════════════════════════════════════════════════════
// Alipay Adapter (骨架)
// ══════════════════════════════════════════════════════════════════
export class AlipayAdapter implements PaymentAdapter {
  readonly method = PaymentMethod.ALIPAY;

  async createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    // TODO: 接入 alipay-sdk
    // const alipay = new AlipaySdk({ appId, privateKey, alipayPublicKey });
    // const url = alipay.pageExecute('alipay.trade.page.pay', 'GET', { bizContent: ... });
    throw new Error('Alipay adapter not yet implemented — configure ALIPAY_* env vars and install alipay-sdk');
  }

  verifyCallback(_headers: Record<string, string | string[] | undefined>, _body: unknown): CallbackVerifyResult {
    return { valid: false, reason: 'Alipay callback verifier not yet implemented' };
  }
}

// ══════════════════════════════════════════════════════════════════
// Registry — 根据 env.PAYMENT_MODE 切换
// ══════════════════════════════════════════════════════════════════
export function getPaymentAdapter(method: PaymentMethod): PaymentAdapter {
  const mode = process.env.PAYMENT_MODE ?? 'sandbox';
  if (mode === 'live') {
    switch (method) {
      case PaymentMethod.WECHAT_PAY: return new WeChatPayAdapter();
      case PaymentMethod.ALIPAY: return new AlipayAdapter();
      default:
        // BANK_CARD / AGENT_PREPAYMENT 走手动流程或代理余额抵扣
        throw new Error(`No live adapter for ${method} — use AGENT_PREPAYMENT manually`);
    }
  }
  // sandbox (dev)
  return new SandboxAdapter(method);
}
