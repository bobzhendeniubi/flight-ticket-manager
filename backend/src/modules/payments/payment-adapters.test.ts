/**
 * 支付适配器 · 单元测试（vitest）
 *
 * 覆盖：
 *   1. SandboxAdapter.createPayment — 返回 paymentUrl + transactionId
 *   2. SandboxAdapter.verifyCallback — 校验 x-sandbox-secret header
 *   3. getPaymentAdapter dispatch — sandbox/live mode 选对 adapter
 *   4. createMiniappJsapiPayment fail-closed guard — sandbox + prod env 必须拒绝
 *
 * 不测试 WeChatPay/Alipay live SDK 调用（需要真证书 + 真接口）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PaymentMethod } from '@prisma/client';
import {
  SandboxAdapter,
  getPaymentAdapter,
  createMiniappJsapiPayment,
} from './payment-adapters.js';

// ── env 备份 / 恢复 helper ─────────────────────────────────────
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {
    PAYMENT_MODE: process.env.PAYMENT_MODE,
    NODE_ENV: process.env.NODE_ENV,
    SANDBOX_PAY_URL_PATH: process.env.SANDBOX_PAY_URL_PATH,
    SANDBOX_WEBHOOK_SECRET: process.env.SANDBOX_WEBHOOK_SECRET,
  };
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('SandboxAdapter.createPayment', () => {
  it('返回 paymentUrl 含 paymentId + amount + transactionId 以 SBX 开头', async () => {
    const a = new SandboxAdapter(PaymentMethod.WECHAT_PAY);
    const r = await a.createPayment({
      paymentId: 'pay_abc123',
      orderNumber: 'ORD-001',
      amountYuan: 1500,
      title: 'Macau-Danang flight',
      notifyUrl: 'https://example.com/cb',
    });
    expect(r.paymentUrl).toContain('paymentId=pay_abc123');
    expect(r.paymentUrl).toContain('amount=1500');
    expect(r.transactionId).toMatch(/^SBX/);
    expect(r.needsPolling).toBe(false);
    expect(r.raw).toMatchObject({ provider: 'sandbox' });
  });

  it('paymentId 含特殊字符要 URL-encode', async () => {
    const a = new SandboxAdapter(PaymentMethod.ALIPAY);
    const r = await a.createPayment({
      paymentId: 'pay+abc/123',
      orderNumber: 'ORD-001',
      amountYuan: 100,
      title: 't',
      notifyUrl: 'x',
    });
    // %2B = +, %2F = /
    expect(r.paymentUrl).toMatch(/paymentId=pay%2Babc%2F123/);
  });

  it('SANDBOX_PAY_URL_PATH env 可覆盖默认路径', async () => {
    process.env.SANDBOX_PAY_URL_PATH = '/custom-pay';
    const a = new SandboxAdapter(PaymentMethod.WECHAT_PAY);
    const r = await a.createPayment({
      paymentId: 'p1',
      orderNumber: 'o1',
      amountYuan: 1,
      title: 't',
      notifyUrl: 'x',
    });
    expect(r.paymentUrl).toMatch(/^\/custom-pay\?/);
  });
});

describe('SandboxAdapter.verifyCallback', () => {
  const adapter = new SandboxAdapter(PaymentMethod.WECHAT_PAY);
  const validSecret = 'sandbox-test-secret';

  it('header 匹配 + body 完整 → valid=true 返回字段', () => {
    const r = adapter.verifyCallback(
      { 'x-sandbox-secret': validSecret },
      { paymentId: 'p1', transactionId: 'tx1', amountYuan: 100 },
    );
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.paymentId).toBe('p1');
      expect(r.transactionId).toBe('tx1');
      expect(r.amountYuan).toBe(100);
      expect(r.paidAt).toBeInstanceOf(Date);
    }
  });

  it('header secret 不匹配 → valid=false（防伪造回调）', () => {
    const r = adapter.verifyCallback(
      { 'x-sandbox-secret': 'wrong' },
      { paymentId: 'p1' },
    );
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toContain('mismatch');
  });

  it('缺 header → valid=false', () => {
    const r = adapter.verifyCallback({}, { paymentId: 'p1' });
    expect(r.valid).toBe(false);
  });

  it('header 对了但 body 缺 paymentId → valid=false', () => {
    const r = adapter.verifyCallback(
      { 'x-sandbox-secret': validSecret },
      { transactionId: 'tx1' },
    );
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toContain('paymentId');
  });

  it('SANDBOX_WEBHOOK_SECRET env 覆盖默认 secret', () => {
    process.env.SANDBOX_WEBHOOK_SECRET = 'custom-secret';
    const r = adapter.verifyCallback(
      { 'x-sandbox-secret': 'custom-secret' },
      { paymentId: 'p1' },
    );
    expect(r.valid).toBe(true);
  });
});

describe('getPaymentAdapter dispatch', () => {
  it('PAYMENT_MODE=sandbox（默认）→ SandboxAdapter', () => {
    delete process.env.PAYMENT_MODE;
    const a = getPaymentAdapter(PaymentMethod.WECHAT_PAY);
    expect(a).toBeInstanceOf(SandboxAdapter);
    expect(a.method).toBe(PaymentMethod.WECHAT_PAY);
  });

  it('PAYMENT_MODE=sandbox 显式 → SandboxAdapter', () => {
    process.env.PAYMENT_MODE = 'sandbox';
    expect(getPaymentAdapter(PaymentMethod.ALIPAY)).toBeInstanceOf(SandboxAdapter);
  });

  it('PAYMENT_MODE=live + WECHAT_PAY → 不是 SandboxAdapter（真适配器）', () => {
    process.env.PAYMENT_MODE = 'live';
    const a = getPaymentAdapter(PaymentMethod.WECHAT_PAY);
    expect(a).not.toBeInstanceOf(SandboxAdapter);
    expect(a.method).toBe(PaymentMethod.WECHAT_PAY);
  });

  it('PAYMENT_MODE=live + ALIPAY → 真适配器', () => {
    process.env.PAYMENT_MODE = 'live';
    const a = getPaymentAdapter(PaymentMethod.ALIPAY);
    expect(a).not.toBeInstanceOf(SandboxAdapter);
    expect(a.method).toBe(PaymentMethod.ALIPAY);
  });

  it('PAYMENT_MODE=live + BANK_CARD → 抛错（无 live adapter）', () => {
    process.env.PAYMENT_MODE = 'live';
    expect(() => getPaymentAdapter(PaymentMethod.BANK_CARD)).toThrow(/No live adapter/);
  });

  it('PAYMENT_MODE=live + AGENT_PREPAYMENT → 抛错', () => {
    process.env.PAYMENT_MODE = 'live';
    expect(() => getPaymentAdapter(PaymentMethod.AGENT_PREPAYMENT)).toThrow();
  });

  it('NODE_ENV=production + 非 live → 抛错（生产绝不启用沙箱验签，fail-closed）', () => {
    // 纵深防御：即使 PAYMENT_MODE 被误配成 sandbox，生产环境也必须拒绝沙箱适配器，
    // 否则匿名回调可用硬编码 secret 把订单刷成 PAID。
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'sandbox';
    expect(() => getPaymentAdapter(PaymentMethod.WECHAT_PAY)).toThrow(/PAYMENT_MODE 必须为 live/);
    // 未设 PAYMENT_MODE（默认 sandbox）同样拒绝
    delete process.env.PAYMENT_MODE;
    expect(() => getPaymentAdapter(PaymentMethod.WECHAT_PAY)).toThrow(/PAYMENT_MODE 必须为 live/);
  });

  it('NODE_ENV=production + live → 正常返回真适配器（生产正确配置不受影响）', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'live';
    const a = getPaymentAdapter(PaymentMethod.WECHAT_PAY);
    expect(a).not.toBeInstanceOf(SandboxAdapter);
  });
});

describe('createMiniappJsapiPayment — fail-closed guard（P1 安全）', () => {
  const baseInput = {
    paymentId: 'pay_jsapi_1',
    orderNumber: 'ORD-001',
    amountYuan: 100,
    title: 'Flight',
    notifyUrl: 'https://example.com/wxpay/cb',
    openid: 'oA1B2C3',
  };

  it('PAYMENT_MODE=sandbox + NODE_ENV=production → 拒绝（绝不能在生产返回 mock 参数）', async () => {
    process.env.PAYMENT_MODE = 'sandbox';
    process.env.NODE_ENV = 'production';
    await expect(createMiniappJsapiPayment(baseInput)).rejects.toThrow(/拒绝返回 mock/);
  });

  it('PAYMENT_MODE 未设 + NODE_ENV=production → 同样拒绝（默认 sandbox）', async () => {
    delete process.env.PAYMENT_MODE;
    process.env.NODE_ENV = 'production';
    await expect(createMiniappJsapiPayment(baseInput)).rejects.toThrow();
  });

  it('PAYMENT_MODE=sandbox + NODE_ENV=development → 返回 mock 参数（开发可用）', async () => {
    process.env.PAYMENT_MODE = 'sandbox';
    process.env.NODE_ENV = 'development';
    const r = await createMiniappJsapiPayment(baseInput);
    expect(r.signType).toBe('RSA');
    expect(r.paySign).toBe('SANDBOX_MOCK_SIGN');
    expect(r.package).toContain('prepay_id=sandbox_pay_jsapi_1');
    expect(r.timeStamp).toMatch(/^\d+$/);
    expect(r.nonceStr).toMatch(/.+/);
  });

  it('PAYMENT_MODE=sandbox + NODE_ENV=test → 返回 mock 参数', async () => {
    process.env.PAYMENT_MODE = 'sandbox';
    process.env.NODE_ENV = 'test';
    const r = await createMiniappJsapiPayment(baseInput);
    expect(r.paySign).toBe('SANDBOX_MOCK_SIGN');
  });
});
