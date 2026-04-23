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
    // 模拟一个可跳转的付款页。路径由 SANDBOX_PAY_URL_PATH env 控制（默认 /sandbox-pay）
    const fakeTxId = 'SBX' + Date.now() + crypto.randomBytes(4).toString('hex');
    const sandboxPath = process.env.SANDBOX_PAY_URL_PATH || '/sandbox-pay';
    return {
      paymentUrl: `${sandboxPath}?paymentId=${encodeURIComponent(input.paymentId)}&amount=${input.amountYuan}`,
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
// WeChat Pay v3 Adapter
// SDK: wechatpay-node-v3
// 前置：微信支付商户平台 → API 安全 → 配置 APIv3 密钥 + 商户证书
// ══════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { paymentConfig } from '../../config/env.js';

/** 懒加载 SDK 客户端，避免 sandbox 环境启动就崩（证书未配） */
let _wxClient: unknown;
async function getWxClient() {
  if (_wxClient) return _wxClient;
  const { wechat } = paymentConfig;
  if (!wechat.mchId || !wechat.appid || !wechat.apiV3Key || !wechat.serialNo || !wechat.privateKeyPath) {
    throw new Error('WeChat Pay env not fully configured: need WECHAT_APPID + WECHAT_MCH_ID + WECHAT_API_V3_KEY + WECHAT_SERIAL_NO + WECHAT_PRIVATE_KEY_PATH');
  }
  // dynamic import 防 sandbox 环境无 SDK 时启动失败
  const mod = (await import('wechatpay-node-v3')) as unknown as { default: new (opts: unknown) => unknown };
  const WxPay = mod.default;
  _wxClient = new WxPay({
    appid: wechat.appid,
    mchid: wechat.mchId,
    publicKey: wechat.platformCertPath ? readFileSync(wechat.platformCertPath) : undefined,
    privateKey: readFileSync(wechat.privateKeyPath),
    key: wechat.apiV3Key, // APIv3 密钥
    serial_no: wechat.serialNo,
  });
  return _wxClient;
}

export class WeChatPayAdapter implements PaymentAdapter {
  readonly method = PaymentMethod.WECHAT_PAY;

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const client = (await getWxClient()) as {
      transactions_native: (params: unknown) => Promise<{ code_url?: string; status: number; message?: string }>;
    };
    // Native 支付（PC 扫码）；APP / JSAPI / H5 可类似扩展
    const res = await client.transactions_native({
      description: input.title,
      out_trade_no: input.paymentId,
      notify_url: input.notifyUrl,
      amount: { total: Math.round(input.amountYuan * 100), currency: 'CNY' },
    });
    if (res.status !== 200 || !res.code_url) {
      throw new Error(`WeChat Pay createOrder failed: ${res.message ?? 'unknown'}`);
    }
    return {
      paymentUrl: res.code_url, // weixin://wxpay/bizpayurl?pr=xxx 二维码内容
      needsPolling: true, // 前端需要轮询支付状态
      raw: res,
    };
  }

  verifyCallback(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): CallbackVerifyResult {
    try {
      const h = (k: string) => {
        const v = headers[k.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      };
      const timestamp = h('wechatpay-timestamp');
      const nonce = h('wechatpay-nonce');
      const signature = h('wechatpay-signature');
      const serial = h('wechatpay-serial');

      if (!timestamp || !nonce || !signature || !serial) {
        return { valid: false, reason: 'missing WeChat signature headers' };
      }

      // 时间戳偏差 5 分钟内（防重放）
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - Number(timestamp)) > 300) {
        return { valid: false, reason: 'timestamp outside allowed window' };
      }

      // SDK 验签 + 解密资源
      // 注意：_wxClient 需在回调前至少被 createPayment 激活过一次，或独立 warmup
      // 生产可在 app 启动时 getWxClient() 预热
      // （这里如果 _wxClient 空，上层 handleCallback 会走 catch 分支）
      const client = _wxClient as {
        verifySign?: (args: { timestamp: string; nonce: string; body: string; signature: string; serial: string }) => boolean;
        decipher_gcm?: (ciphertext: string, associatedData: string, nonce: string, apiV3Key: string) => unknown;
      } | null;
      if (!client || !client.verifySign) {
        return { valid: false, reason: 'WeChat client not initialized (call createPayment once or warmup at startup)' };
      }

      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      const verified = client.verifySign({ timestamp, nonce, body: bodyStr, signature, serial });
      if (!verified) {
        return { valid: false, reason: 'signature verification failed' };
      }

      // 解密 resource.ciphertext 得到真实订单数据
      const b = body as { resource?: { ciphertext?: string; associated_data?: string; nonce?: string } };
      if (!b.resource?.ciphertext) {
        return { valid: false, reason: 'callback missing resource.ciphertext' };
      }
      const { apiV3Key } = paymentConfig.wechat;
      if (!apiV3Key || !client.decipher_gcm) {
        return { valid: false, reason: 'decryption unavailable' };
      }
      const decrypted = client.decipher_gcm(
        b.resource.ciphertext,
        b.resource.associated_data ?? '',
        b.resource.nonce ?? '',
        apiV3Key,
      ) as { out_trade_no?: string; transaction_id?: string; amount?: { total?: number }; success_time?: string };

      return {
        valid: true,
        paymentId: decrypted.out_trade_no,
        transactionId: decrypted.transaction_id,
        amountYuan: decrypted.amount?.total ? decrypted.amount.total / 100 : undefined,
        paidAt: decrypted.success_time ? new Date(decrypted.success_time) : new Date(),
        rawPayload: decrypted,
      };
    } catch (e) {
      return { valid: false, reason: e instanceof Error ? e.message : 'verify failed' };
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// Alipay Adapter
// SDK: alipay-sdk
// 前置：蚂蚁开放平台 → 创建应用 → 上传应用公钥 → 下载支付宝公钥
// ══════════════════════════════════════════════════════════════════
let _aliClient: unknown;
async function getAliClient() {
  if (_aliClient) return _aliClient;
  const { alipay } = paymentConfig;
  if (!alipay.appid || !alipay.privateKeyPath || !alipay.publicKeyPath) {
    throw new Error('Alipay env not fully configured: need ALIPAY_APPID + ALIPAY_PRIVATE_KEY_PATH + ALIPAY_PUBLIC_KEY_PATH');
  }
  const mod = (await import('alipay-sdk')) as unknown as { AlipaySdk: new (opts: unknown) => unknown };
  const { AlipaySdk } = mod;
  _aliClient = new AlipaySdk({
    appId: alipay.appid,
    privateKey: readFileSync(alipay.privateKeyPath, 'utf8'),
    alipayPublicKey: readFileSync(alipay.publicKeyPath, 'utf8'),
    signType: alipay.signType,
    gateway: alipay.gateway,
    timeout: 5000,
  });
  return _aliClient;
}

export class AlipayAdapter implements PaymentAdapter {
  readonly method = PaymentMethod.ALIPAY;

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const client = (await getAliClient()) as {
      pageExec?: (method: string, params: { bizContent: Record<string, unknown>; notifyUrl?: string; returnUrl?: string }) => string;
      pageExecute?: (method: string, http: string, params: Record<string, unknown>) => string;
    };
    // alipay.trade.page.pay（电脑网站支付）；APP / WAP 类似
    const bizContent = {
      out_trade_no: input.paymentId,
      total_amount: input.amountYuan.toFixed(2),
      subject: input.title,
      product_code: 'FAST_INSTANT_TRADE_PAY',
    };
    let paymentUrl: string;
    if (client.pageExec) {
      // alipay-sdk v4+ API
      paymentUrl = client.pageExec('alipay.trade.page.pay', {
        bizContent,
        notifyUrl: input.notifyUrl,
        returnUrl: input.returnUrl,
      });
    } else if (client.pageExecute) {
      // alipay-sdk v3 API 向后兼容
      paymentUrl = client.pageExecute('alipay.trade.page.pay', 'GET', {
        bizContent,
        notifyUrl: input.notifyUrl,
        returnUrl: input.returnUrl,
      });
    } else {
      throw new Error('Alipay SDK version not supported');
    }
    return {
      paymentUrl,
      needsPolling: true,
      raw: { bizContent },
    };
  }

  verifyCallback(
    _headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): CallbackVerifyResult {
    try {
      const client = _aliClient as {
        checkNotifySign?: (params: Record<string, string>) => boolean;
      } | null;
      if (!client || !client.checkNotifySign) {
        return { valid: false, reason: 'Alipay client not initialized' };
      }

      // 支付宝回调 body 是 application/x-www-form-urlencoded，fastify 已按 object 解析
      const params = body as Record<string, string>;
      const verified = client.checkNotifySign(params);
      if (!verified) {
        return { valid: false, reason: 'Alipay signature verification failed' };
      }

      // 业务校验：trade_status=TRADE_SUCCESS 或 TRADE_FINISHED
      if (params.trade_status !== 'TRADE_SUCCESS' && params.trade_status !== 'TRADE_FINISHED') {
        return { valid: false, reason: `ignoring trade_status=${params.trade_status}` };
      }

      return {
        valid: true,
        paymentId: params.out_trade_no,
        transactionId: params.trade_no,
        amountYuan: Number(params.total_amount),
        paidAt: params.gmt_payment ? new Date(params.gmt_payment) : new Date(),
        rawPayload: params,
      };
    } catch (e) {
      return { valid: false, reason: e instanceof Error ? e.message : 'verify failed' };
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// WeChat Miniapp JSAPI 支付
//
// 和 Native（扫码）不同：
//   - transactions_jsapi 需要 payer.openid
//   - 返回 prepay_id，需要再签一次才能给 wx.requestPayment
//
// 生产：真跑 transactions_jsapi + RSA 签名
// Sandbox（PAYMENT_MODE != 'live'）：返回 mock 参数，让前端流程跑通 —— 实际不会拉起付款面板
// ══════════════════════════════════════════════════════════════════
export async function createMiniappJsapiPayment(input: {
  paymentId: string;
  orderNumber: string;
  amountYuan: number;
  title: string;
  notifyUrl: string;
  openid: string;
}): Promise<{
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA' | 'MD5' | 'HMAC-SHA256';
  paySign: string;
}> {
  const mode = process.env.PAYMENT_MODE ?? 'sandbox';

  if (mode !== 'live') {
    // P1 fail-closed：生产环境绝对不允许回 mock 参数
    // 即使 PAYMENT_MODE 被意外设成 sandbox，也不能在 NODE_ENV=production 下放行
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'PAYMENT_MODE != "live" 但 NODE_ENV=production — 拒绝返回 mock 支付参数',
      );
    }
    // Sandbox / dev —— 返回假参数
    // 前端调 wx.requestPayment 会 fail，但后端订单状态机可以走 sandbox webhook 强推
    return {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: genNonce(),
      package: `prepay_id=sandbox_${input.paymentId}`,
      signType: 'RSA',
      paySign: 'SANDBOX_MOCK_SIGN',
    };
  }

  // Production — 真调 SDK
  const client = (await getWxClient()) as {
    transactions_jsapi: (params: unknown) => Promise<{ prepay_id?: string; status: number; message?: string }>;
    rsaSign?: (message: string) => string;
  };
  const res = await client.transactions_jsapi({
    description: input.title,
    out_trade_no: input.paymentId,
    notify_url: input.notifyUrl,
    amount: { total: Math.round(input.amountYuan * 100), currency: 'CNY' },
    payer: { openid: input.openid },
  });
  if (res.status !== 200 || !res.prepay_id) {
    throw new Error(`WeChat JSAPI prepay failed: ${res.message ?? 'no prepay_id'}`);
  }

  const { wechat } = paymentConfig;
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = genNonce();
  const pkg = `prepay_id=${res.prepay_id}`;
  // wx.requestPayment 签名串：appId\ntimeStamp\nnonceStr\npackage\n
  const signMessage = `${wechat.appid}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  if (!client.rsaSign) throw new Error('SDK 不支持 rsaSign；检查 wechatpay-node-v3 版本');
  const paySign = client.rsaSign(signMessage);
  return {
    timeStamp,
    nonceStr,
    package: pkg,
    signType: 'RSA',
    paySign,
  };
}

function genNonce(): string {
  return Math.random().toString(36).slice(2, 18) + Math.random().toString(36).slice(2, 18);
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
