import type { FastifyInstance, FastifyError, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import {
  buildFailureContextFields,
  classifyFailureLevel,
  errorMessageForLog,
  extractErrorFromPayload,
  formatValidationMessage,
  noteRequestFailure,
  readRequestFailureNote,
  sanitizeFailureMessage,
  serializeErrorForLog,
  summarizeIssuesForLog,
} from '../lib/request-failure-log.js';
import type { AccessTokenPayload } from './auth.js';

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

/**
 * 失败日志：一行说清「哪个接口、谁、什么状态码、为什么」。msg 沿用各分支原有取值
 * （validation error / app error / prisma known error (mapped by global handler) /
 * unhandled prisma error / unhandled error），按 msg 过滤的分析脚本照常可用；
 * 分级与字段口径见 lib/request-failure-log.ts。
 * `levelCode` 只参与分级（如 REFRESH_TOKEN_RACE 降为 info），不单独落字段。
 */
function logRequestFailure(
  req: FastifyRequest,
  statusCode: number,
  msg: string,
  detail: Record<string, unknown>,
  levelCode?: string | null,
): void {
  noteRequestFailure(req, { logged: true });
  const authFailure = readRequestFailureNote(req)?.authFailure;
  // req.user 只在 authenticate / optionalAuthenticate 验过 token 后才有（fastify-jwt 初始为 null）
  const user = req.user as AccessTokenPayload | null | undefined;
  const route = req.routeOptions?.url;
  const context = buildFailureContextFields(
    {
      method: req.method,
      route,
      rawUrl: req.url,
      userId: user?.sub ?? null,
      role: user?.role ?? null,
      staffRole: req.staffRole ?? null,
    },
    statusCode,
    authFailure,
  );
  const level = classifyFailureLevel({
    statusCode,
    code: levelCode,
    authFailure,
    unmatchedRoute: !route,
  });
  req.log[level]({ ...context, ...detail }, msg);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    // Zod validation errors
    if (err instanceof ZodError) {
      // 日志只留「path: message」摘要：zod 原始 issue 的 received 等字段可能带原值（如枚举收到的实参）
      logRequestFailure(req, 400, 'validation error', {
        code: 'VALIDATION_ERROR',
        issueCount: err.issues.length,
        issues: summarizeIssuesForLog(err.issues),
      });
      // 前端多处直接展示 error.message（如批量建单页），此前这里无论哪个字段没通过校验都
      // 只吐一句不可行动的 "Request validation failed"——运营看不出到底是哪个字段、哪个值
      // 有问题（如国籍传了未识别的 3 位码），只能猜。这里把具体 issue 的（路径 + 可读消息）
      // 拼进顶层 message；仍保留 details.fieldErrors 供需要结构化处理的调用方使用。
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: formatValidationMessage(err.issues),
          details: err.flatten(),
        },
      });
    }

    // Domain errors
    if (err instanceof AppError) {
      logRequestFailure(
        req,
        err.statusCode,
        'app error',
        {
          code: err.code,
          message: sanitizeFailureMessage(err.message),
          ...(err.statusCode >= 500 ? { err: serializeErrorForLog(err) } : {}),
        },
        err.code,
      );
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
    }

    // Fastify's own validation / 4xx errors already carry statusCode
    // （请求体过大 / JSON 不合法 / 限流 429 / reply.notFound 等；此前完全不落日志）
    const fe = err as FastifyError;
    if (fe.statusCode && fe.statusCode < 500) {
      const code = fe.code ?? 'BAD_REQUEST';
      logRequestFailure(req, fe.statusCode, 'app error', {
        code,
        message: sanitizeFailureMessage(fe.message ?? ''),
      });
      return reply.status(fe.statusCode).send({
        error: {
          code,
          message: fe.message,
        },
      });
    }

    // Prisma 已知错误码（C-17）：模块没自己 catch 时的安全网，见上方 PRISMA_ERROR_MAP 注释
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_ERROR_MAP[err.code];
      if (mapped) {
        logRequestFailure(req, mapped.statusCode, 'prisma known error (mapped by global handler)', {
          code: err.code,
        });
        return reply.status(mapped.statusCode).send({
          error: { code: mapped.code, message: mapped.message },
        });
      }
      // 其它 Prisma 错误码保持 500，但日志里带上 code 方便排查（此前完全看不出是不是 Prisma 抛的）
      logRequestFailure(req, 500, 'unhandled prisma error', {
        code: err.code,
        message: errorMessageForLog(err),
        err: serializeErrorForLog(err),
      });
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
    }

    logRequestFailure(req, 500, 'unhandled error', {
      message: errorMessageForLog(err),
      err: serializeErrorForLog(err),
    });
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
  });

  // 兜底：路由里直接 reply.status(4xx).send({ error: '…' }) 的拒绝不经过上面的错误处理器，
  // 此前完全不落日志（只能看到 request completed 的状态码）。这里补记同一口径的 app error，
  // 带 source:'reply' 区分；错误处理器 / 404 已记过的请求不重复记。只取错误体的 code / message。
  app.addHook('onSend', (req, reply, payload, done) => {
    if (reply.statusCode >= 400 && !readRequestFailureNote(req)?.logged) {
      try {
        const { code, message } = extractErrorFromPayload(payload);
        logRequestFailure(
          req,
          reply.statusCode,
          'app error',
          { source: 'reply', code, message: message === null ? null : sanitizeFailureMessage(message) },
          code,
        );
      } catch (logErr) {
        // 记日志失败绝不能影响响应本身
        req.log.warn({ err: logErr }, 'request failure log skipped');
      }
    }
    done(null, payload);
  });

  app.setNotFoundHandler((req, reply) => {
    // 未匹配路由（多为扫描器 / 前端调了已下线的接口）：info 级，path 已去掉 query
    logRequestFailure(req, 404, 'route not found', {});
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });
}
