import type { FastifyInstance, FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    // Zod validation errors
    if (err instanceof ZodError) {
      req.log.info({ issues: err.issues }, 'validation error');
      // 前端多处直接展示 error.message（如批量建单页），此前这里无论哪个字段没通过校验都
      // 只吐一句不可行动的 "Request validation failed"——运营看不出到底是哪个字段、哪个值
      // 有问题（如国籍传了未识别的 3 位码），只能猜。这里把具体 issue 的（路径 + 可读消息）
      // 拼进顶层 message；仍保留 details.fieldErrors 供需要结构化处理的调用方使用。
      const issueMessages = Array.from(
        new Set(
          err.issues.map((issue) => {
            const path = issue.path.join('.');
            return path ? `${path}：${issue.message}` : issue.message;
          }),
        ),
      );
      const MAX_ISSUES_IN_MESSAGE = 5;
      const shown = issueMessages.slice(0, MAX_ISSUES_IN_MESSAGE);
      const overflow =
        issueMessages.length > MAX_ISSUES_IN_MESSAGE
          ? `（等 ${issueMessages.length} 项问题）`
          : '';
      const message =
        shown.length > 0 ? `请求校验未通过：${shown.join('；')}${overflow}` : 'Request validation failed';
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message,
          details: err.flatten(),
        },
      });
    }

    // Domain errors
    if (err instanceof AppError) {
      req.log.info({ code: err.code, message: err.message }, 'app error');
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
    }

    // Fastify's own validation / 4xx errors already carry statusCode
    const fe = err as FastifyError;
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({
        error: {
          code: fe.code ?? 'BAD_REQUEST',
          message: fe.message,
        },
      });
    }

    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });
}
