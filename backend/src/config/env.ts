import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(3600), // seconds
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  // CORS_ORIGINS (plural) — 逗号分隔列表；生产禁止 * 通配符
  // 向后兼容：优先读 CORS_ORIGINS，回退读 CORS_ORIGIN
  CORS_ORIGINS: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),

  // 公网基准 URL — 用于生成支付回调 notifyUrl / sandbox paymentUrl / 邮件/短信里的跳转链接
  // 生产必须显式设（例如 https://api.citur.com）；开发默认 http://localhost:4000
  APP_PUBLIC_URL: z.string().url().optional(),

  // 支付沙箱前端跳转页 — SandboxAdapter 生成的付款 URL 基准
  // 默认 /sandbox-pay（同域相对路径，前端 nginx 提供静态页或路由）
  SANDBOX_PAY_URL_PATH: z.string().default('/sandbox-pay'),

  // ═══════════════════════════════════════════════════════════
  // 支付网关：WeChat Pay v3
  // 生产 PAYMENT_MODE=live 时必填；sandbox 下可全空
  // ═══════════════════════════════════════════════════════════
  // 公众号/小程序/APP AppID（微信开放平台分配）
  WECHAT_APPID: z.string().optional(),
  // 商户号（mch_id，微信支付商户平台分配）
  WECHAT_MCH_ID: z.string().optional(),
  // API v3 密钥（微信支付商户平台 → API 安全 → 设置 APIv3 密钥，32 字符）
  WECHAT_API_V3_KEY: z.string().optional(),
  // 商户 API 证书序列号（cert serial no）
  WECHAT_SERIAL_NO: z.string().optional(),
  // 商户 API 私钥文件路径（apiclient_key.pem）
  WECHAT_PRIVATE_KEY_PATH: z.string().optional(),
  // 微信支付平台证书路径（平台证书，用于校验回调签名；可从平台下载或 SDK 自动拉取）
  WECHAT_PLATFORM_CERT_PATH: z.string().optional(),
  // 向后兼容：旧的 OAuth 流程 secret（扫码登录用，非支付）
  WECHAT_APP_SECRET: z.string().optional(),
  // ── 微信小程序登录（不同于公众号/APP）──
  // 在 https://mp.weixin.qq.com 申请小程序后，设置 → 开发设置 → AppID/AppSecret
  WECHAT_MP_APPID: z.string().optional(),
  WECHAT_MP_APPSECRET: z.string().optional(),

  // ═══════════════════════════════════════════════════════════
  // 支付网关：支付宝
  // ═══════════════════════════════════════════════════════════
  // 开放平台 App ID（16 位数字）
  ALIPAY_APPID: z.string().optional(),
  // 应用私钥路径（PKCS#1 或 PKCS#8 PEM）
  ALIPAY_PRIVATE_KEY_PATH: z.string().optional(),
  // 支付宝公钥路径（用于校验回调签名）
  ALIPAY_PUBLIC_KEY_PATH: z.string().optional(),
  // 签名算法（RSA2 推荐）
  ALIPAY_SIGN_TYPE: z.enum(['RSA', 'RSA2']).default('RSA2'),
  // 支付宝网关 URL（生产 / 沙箱不同）
  ALIPAY_GATEWAY: z.string().url().default('https://openapi.alipay.com/gateway.do'),

  // ═══════════════════════════════════════════════════════════
  // AWS（未来接 S3 上传证件照）
  // ═══════════════════════════════════════════════════════════
  AWS_REGION: z.string().optional(),
  S3_BUCKET_UPLOADS: z.string().optional(),

  // ═══════════════════════════════════════════════════════════
  // OpenAI API（AI 助手 chat）
  // 未配时 /ai/chat 走 mock；不影响其他功能
  // 默认模型 gpt-5-mini（便宜 + 支持 tool use）；可改 OPENAI_MODEL 切到 gpt-5 / gpt-4o / gpt-4.1-mini 等
  // ═══════════════════════════════════════════════════════════
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  OPENAI_BASE_URL: z.string().url().optional(), // 可指向 Azure / 代理

  // ═══════════════════════════════════════════════════════════
  // 邮件（SMTP，发送电子行程单）
  // 没配置时 worker 静默跳过邮件发送（只写日志）。
  // 沙箱推荐 Mailtrap / Ethereal；生产可用 Alibaba DirectMail / AWS SES。
  // ═══════════════════════════════════════════════════════════
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Citur Travel <no-reply@citur.com>'),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('❌ Invalid environment variables:');
    // eslint-disable-next-line no-console
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

const rawCorsOrigins = env.CORS_ORIGINS ?? env.CORS_ORIGIN ?? (env.NODE_ENV === 'production' ? '' : '*');
if (env.NODE_ENV === 'production' && (rawCorsOrigins === '*' || !rawCorsOrigins.trim())) {
  // eslint-disable-next-line no-console
  console.error('❌ CORS_ORIGINS must be set to explicit origins in production (wildcard denied)');
  process.exit(1);
}
export const corsOrigins =
  rawCorsOrigins === '*'
    ? true
    : rawCorsOrigins.split(',').map((s) => s.trim()).filter(Boolean);

/** 公网基准 URL — 用于生成 webhook callback、跳转链接 */
export const appPublicUrl: string =
  env.APP_PUBLIC_URL ??
  (env.NODE_ENV === 'production' ? '' : `http://localhost:${env.PORT}`);

if (env.NODE_ENV === 'production' && !appPublicUrl) {
  // eslint-disable-next-line no-console
  console.error('❌ APP_PUBLIC_URL must be set in production (used for payment webhooks)');
  process.exit(1);
}

/** PAYMENT_MODE=live 下验证支付渠道凭证齐全 */
const paymentMode = process.env.PAYMENT_MODE ?? 'sandbox';
if (paymentMode === 'live') {
  const wechatMissing = [
    'WECHAT_APPID',
    'WECHAT_MCH_ID',
    'WECHAT_API_V3_KEY',
    'WECHAT_SERIAL_NO',
    'WECHAT_PRIVATE_KEY_PATH',
  ].filter((k) => !env[k as keyof typeof env]);
  const alipayMissing = [
    'ALIPAY_APPID',
    'ALIPAY_PRIVATE_KEY_PATH',
    'ALIPAY_PUBLIC_KEY_PATH',
  ].filter((k) => !env[k as keyof typeof env]);
  // 允许只启用一家（例如只接微信）；但一家都没配等于 live 模式没意义
  if (wechatMissing.length > 0 && alipayMissing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      '❌ PAYMENT_MODE=live but no complete payment channel configured.\n' +
        `   WeChat missing: ${wechatMissing.join(', ')}\n` +
        `   Alipay missing: ${alipayMissing.join(', ')}`,
    );
    process.exit(1);
  }
}

/** 支付渠道配置便利访问器（adapter 用） */
export const paymentConfig = {
  mode: paymentMode as 'sandbox' | 'live',
  wechat: {
    appid: env.WECHAT_APPID,
    mchId: env.WECHAT_MCH_ID,
    apiV3Key: env.WECHAT_API_V3_KEY,
    serialNo: env.WECHAT_SERIAL_NO,
    privateKeyPath: env.WECHAT_PRIVATE_KEY_PATH,
    platformCertPath: env.WECHAT_PLATFORM_CERT_PATH,
  },
  alipay: {
    appid: env.ALIPAY_APPID,
    privateKeyPath: env.ALIPAY_PRIVATE_KEY_PATH,
    publicKeyPath: env.ALIPAY_PUBLIC_KEY_PATH,
    signType: env.ALIPAY_SIGN_TYPE,
    gateway: env.ALIPAY_GATEWAY,
  },
};
