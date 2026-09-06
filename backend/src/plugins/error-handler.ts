import type { FastifyInstance, FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';

/**
 * C-17：Prisma 已知错误码 → HTTP 状态码的兜底映射。
 * 各模块理论上该在业务层手工 catch 并转译成 AppError（如 finances.cost.service.ts
 * 的 deleteCostPeriod 对 P2025 → NotFoundError），但漏做手工 catch 的模块（如
 * order-cost-items 的先查后写窗口）会让裸 Prisma 错误直接冒到这里，此前只会落进
 * 500 兜底、前端看不出是并发冲突还是记录已被删除。这里只做兜底，不代替各模块自己
 * 更精确的 catch（后者能给出更贴合业务场景的文案）。
 */
const PRISMA_ERROR_MAP: Record<string, { statusCode: number; code: string; message: string }> = {
  // 唯一约束冲突（如并发下重复创建同一条记录）
  P2002: { statusCode: 409, code: 'CONFLICT', message: '记录已存在或与现有数据冲突' },
  // 更新/删除时记录已不存在（多为并发下被其他请求先一步删除）
  P2025: { statusCode: 404, code: 'NOT_FOUND', message: 'Not found' },
  // 事务冲突（如写冲突、事务超时），语义上可重试
  P2034: { statusCode: 409, code: 'CONFLICT', message: '事务冲突，请重试' },
};

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

    // Prisma 已知错误码（C-17）：模块没自己 catch 时的安全网，见上方 PRISMA_ERROR_MAP 注释
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_ERROR_MAP[err.code];
      if (mapped) {
        req.log.info({ code: err.code }, 'prisma known error (mapped by global handler)');
        return reply.status(mapped.statusCode).send({
          error: { code: mapped.code, message: mapped.message },
        });
      }
      // 其它 Prisma 错误码保持 500，但日志里带上 code 方便排查（此前完全看不出是不是 Prisma 抛的）
      req.log.error({ err, code: err.code }, 'unhandled prisma error');
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
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
