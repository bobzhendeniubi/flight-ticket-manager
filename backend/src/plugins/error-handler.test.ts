/**
 * error-handler 插件 · 单元测试（vitest）
 *
 * 覆盖（C-17）：全局错误处理器对 Prisma 已知错误码的兜底映射——
 *   P2002（唯一约束冲突）→ 409
 *   P2025（记录不存在）→ 404
 *   P2034（事务冲突）→ 409
 *   其它 Prisma 错误码 → 仍 500
 * 以及既有分支（ZodError → 400 / AppError → 其自身 statusCode / 未知错误 → 500）保持不变，
 * 防止本次改动误伤这些已有行为。
 */
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { registerErrorHandler } from './error-handler.js';
import { ConflictError } from '../lib/errors.js';

function prismaError(code: string, message = 'prisma error'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
}

async function buildApp(routeError: unknown): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.get('/boom', async () => {
    throw routeError;
  });
  await app.ready();
  return app;
}

describe('registerErrorHandler · Prisma 错误码映射（C-17）', () => {
  it('P2002（唯一约束冲突）→ 409，文案「记录已存在或与现有数据冲突」', async () => {
    const app = await buildApp(prismaError('P2002'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'CONFLICT', message: '记录已存在或与现有数据冲突' },
    });
  });

  it('P2025（记录不存在）→ 404', async () => {
    const app = await buildApp(prismaError('P2025'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  it('P2034（事务冲突）→ 409，文案「事务冲突，请重试」', async () => {
    const app = await buildApp(prismaError('P2034'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'CONFLICT', message: '事务冲突，请重试' } });
  });

  it('未映射的 Prisma 错误码（如 P2003）→ 仍 500，但不泄露内部信息', async () => {
    const app = await buildApp(prismaError('P2003', 'foreign key constraint failed'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });
});

describe('registerErrorHandler · 既有分支不受影响', () => {
  it('ZodError → 400 VALIDATION_ERROR', async () => {
    const schema = z.object({ name: z.string() });
    const app = await buildApp(
      (() => {
        try {
          schema.parse({});
          return new Error('unreachable');
        } catch (e) {
          return e;
        }
      })(),
    );
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('AppError（如 ConflictError）→ 其自身 statusCode，不落进 Prisma 分支', async () => {
    const app = await buildApp(new ConflictError('自定义冲突文案'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'CONFLICT', message: '自定义冲突文案' } });
  });

  it('普通 Error（非 Prisma）→ 500 INTERNAL_ERROR', async () => {
    const app = await buildApp(new Error('boom'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });
});
