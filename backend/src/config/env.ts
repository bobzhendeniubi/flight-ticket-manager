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
  // AI 对话（OpenAI 兼容协议）—— 当前指向阿里云 DashScope / Qwen
  //
  // ⚠️ 为什么不是 OpenAI 官方：生产服务器在香港，OpenAI 对该地区返回
  //    403 unsupported_country_region_territory，直连不可用。DashScope
  //    国际站香港可直连。对话助手使用 OPENAI_API_KEY；OCR 和营销海报
  //    使用 AiOcrConfig 表中的 key，表中没有可用 key 时才读 DASHSCOPE_API_KEY。
  //    如果将来要切回 OpenAI，必须先在支持地区架中转再改 OPENAI_BASE_URL。
  //
  // 变量名保留 OPENAI_* 前缀：走的就是 OpenAI 兼容协议，SDK 不变。
  // 未配 key 时 /ai/chat 走本地启发式 mock（mocked:true）；不影响其他功能。
  // ═══════════════════════════════════════════════════════════
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('qwen3-max'),
  // 空字符串（docker compose ${VAR:-} 默认值）当 undefined 处理后回退默认值
  OPENAI_BASE_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().default('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
  ),

  // ═══════════════════════════════════════════════════════════
  // 阿里云 DashScope / Qwen-VL（护照 OCR 等视觉能力，OpenAI 兼容端点）
  // 未配时 /ocr/passport 返回 { configured: false }，前端自动回退浏览器 Tesseract。
  // 在 DashScope 控制台（https://dashscope.console.aliyun.com）→ API-KEY 管理 申请。
  // ═══════════════════════════════════════════════════════════
  DASHSCOPE_API_KEY: z.string().optional(),
  QWEN_VL_MODEL: z.string().default('qwen3-vl-plus'),
  // 可指向其他兼容端点；空字符串（docker compose ${VAR:-} 默认值）当 undefined 处理后回退默认值
  QWEN_BASE_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().default('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
  ),

  // 营销海报中文字体。未配置时由合成层按容器/macOS 的固定候选路径探测。
  POSTER_FONT_PATH: z.string().optional(),
  // 海报生图模型：切换模型属于技术配置，修改 env 后重启服务生效。
  POSTER_IMAGE_MODEL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(1).default('qwen-image-2.0-pro'),
  ),
  // 海报配额按服务器本地日期统计；0 表示暂时禁止生成。
  POSTER_DAILY_LIMIT_PER_USER: z.coerce.number().int().min(0).default(10),
  POSTER_DAILY_LIMIT_TOTAL: z.coerce.number().int().min(0).default(50),

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

  // ═══════════════════════════════════════════════════════════
  // 航班库存：容量下调守卫
  // 允许把班次容量改到低于已售（航司减配 / 换机型的真实场景，见 flights.service），
  // 但超售张数（已售 − 目标容量）超过此上限就拒绝写入——防止手滑输错容量
  // （如把 186 敲成 18 → 超售 168）。运营确认真要放这么大的超售口子再调大此值。
  // ═══════════════════════════════════════════════════════════
  FLIGHT_MAX_OVERSELL_SEATS: z.coerce.number().int().min(0).default(5),

  // ═══════════════════════════════════════════════════════════
  // 酒店库存：账面超卖容忍上限（同 FLIGHT_MAX_OVERSELL_SEATS 哲学），管两个方向：
  //   1) 包房间数下调守卫 —— 允许把包房周期的 rooms（或缩小日期区间）改到低于当晚
  //      已占用的物理间数（真实退房场景），缺口超上限拒绝写入，防手滑把周期改小/删错。
  //      删除周期无豁免（零容忍）。
  //   2) 内部录单限额内超售 —— 销控售罄后运营仍可录单（当天临时向酒店加房是常态业务），
  //      每晚累计缺口 ≤ 上限放行并写 WARNING 审计、销控板显示负数；超上限拒单，
  //      防手滑（如大团录错日期一次打穿负十几间）。仅后台 ADMIN/STAFF 录单享有，
  //      前台散客/代理下单仍是硬闸。
  // ═══════════════════════════════════════════════════════════
  HOTEL_MAX_OVERSELL_ROOMS: z.coerce.number().int().min(0).default(3),
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

// 生产环境拒绝占位 JWT 密钥（防止 .env 模板原样上线）
if (
  env.NODE_ENV === 'production' &&
  (env.JWT_ACCESS_SECRET.includes('change_me') || env.JWT_REFRESH_SECRET.includes('change_me'))
) {
  // eslint-disable-next-line no-console
  console.error('❌ JWT secrets are placeholders; generate real ones: openssl rand -base64 48');
  process.exit(1);
}

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
