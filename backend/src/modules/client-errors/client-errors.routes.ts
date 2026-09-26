/**
 * 前端报错上报端点
 *
 * POST /client-errors
 *   body : { app: 'admin'|'sales', message, stack?, path, buildVersion?, userAgent? }（≤8KB）
 *   auth : 匿名（前端崩溃时未必还有可用登录态；上报本身也绝不带 token）
 *   限流 : 按 IP 30 次 / 分钟
 *   返回 : 204
 *
 * 只落一行 warn 日志（tag=client_error，msg=client error），不入库。
 * 字段口径与脱敏见 client-errors.schemas.ts。
 */
import type { FastifyPluginAsync } from 'fastify';
import {
  CLIENT_ERROR_BODY_LIMIT_BYTES,
  CLIENT_ERROR_LOG_MSG,
  CLIENT_ERROR_LOG_TAG,
  CLIENT_ERROR_RATE_LIMIT,
  clientErrorBodySchema,
  normalizeUserAgentHeader,
} from './client-errors.schemas.js';

export const clientErrorRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/',
    {
      bodyLimit: CLIENT_ERROR_BODY_LIMIT_BYTES,
      config: { rateLimit: CLIENT_ERROR_RATE_LIMIT },
    },
    async (req, reply) => {
      const body = clientErrorBodySchema.parse(req.body);
      req.log.warn(
        {
          tag: CLIENT_ERROR_LOG_TAG,
          app: body.app,
          message: body.message,
          stack: body.stack ?? null,
          path: body.path,
          buildVersion: body.buildVersion ?? null,
          userAgent: body.userAgent ?? normalizeUserAgentHeader(req.headers['user-agent']),
        },
        CLIENT_ERROR_LOG_MSG,
      );
      return reply.status(204).send();
    },
  );
};
