import type { FastifyInstance, FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    // Zod validation errors
    if (err instanceof ZodError) {
      req.log.info({ issues: err.issues }, 'validation error');
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
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
