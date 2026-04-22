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
