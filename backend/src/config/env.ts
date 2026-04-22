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

  WECHAT_APP_ID: z.string().optional(),
  WECHAT_APP_SECRET: z.string().optional(),

  AWS_REGION: z.string().optional(),
  S3_BUCKET_UPLOADS: z.string().optional(),
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
