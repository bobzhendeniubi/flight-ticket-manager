/**
 * 前端报错上报（POST /client-errors）的请求体口径。
 *
 * 匿名可达：前端（运营后台 admin / 前台商城 sales）捕获到的未处理异常与渲染崩溃，
 * 只记一行 warn 日志、不入库。前端已做「同一 message 1 分钟只报一次 + 单会话 20 条 +
 * 不带 query / token / 表单值」，这里仍按「来路不可信」再兜一层：
 * 长度截断、path 去 query / hash、自由文本去令牌并遮证件号；未知字段一律丢弃（z.object 默认 strip）。
 */
import { z } from 'zod';
import { sanitizeLogText, truncateText, stripQueryAndHash } from '../../lib/log-sanitize.js';

/** 请求体上限：前端上报本身已控制在 ~7KB 内，超过 8KB 的直接 413。 */
export const CLIENT_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
/** 按 IP 限流（走全局 @fastify/rate-limit 的路由级配置，桶键 = IP + 路由）。 */
export const CLIENT_ERROR_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

export const CLIENT_ERROR_LOG_TAG = 'client_error';
export const CLIENT_ERROR_LOG_MSG = 'client error';

export const CLIENT_ERROR_MESSAGE_MAX_CHARS = 500;
export const CLIENT_ERROR_STACK_MAX_CHARS = 4000;
const PATH_MAX_CHARS = 300;
const USER_AGENT_MAX_CHARS = 300;
const BUILD_VERSION_MAX_CHARS = 64;

export const clientErrorBodySchema = z.object({
  app: z.enum(['admin', 'sales']),
  message: z
    .string()
    .trim()
    .min(1, 'message 不能为空')
    .transform((s) => sanitizeLogText(s, CLIENT_ERROR_MESSAGE_MAX_CHARS)),
  stack: z
    .string()
    .optional()
    .transform((s) => (s ? sanitizeLogText(s, CLIENT_ERROR_STACK_MAX_CHARS) : undefined)),
  path: z
    .string()
    .trim()
    .min(1, 'path 不能为空')
    .transform((p) => sanitizeLogText(stripQueryAndHash(p), PATH_MAX_CHARS)),
  buildVersion: z.string().trim().max(BUILD_VERSION_MAX_CHARS).optional(),
  userAgent: z
    .string()
    .optional()
    .transform((s) => (s ? truncateText(s.trim(), USER_AGENT_MAX_CHARS) : undefined)),
});

export type ClientErrorBody = z.infer<typeof clientErrorBodySchema>;

/** 请求头里的 UA 兜底（前端没传 userAgent 时），同样截断。 */
export function normalizeUserAgentHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ? truncateText(raw.trim(), USER_AGENT_MAX_CHARS) : null;
}
