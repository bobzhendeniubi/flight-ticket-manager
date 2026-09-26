/**
 * 错误处理器 · 失败日志（真实 Fastify + 抓 pino 输出）
 *
 * 覆盖：
 *   - 既有两行 msg（validation error / app error）不变，但一行就能看懂：
 *     method、路由模板、statusCode、userId、role
 *   - 分级：真正的 4xx → warn；access token 没带 / 过期的 401、409 REFRESH_TOKEN_RACE → info；
 *     签名不对的 401 → warn；5xx → error 带调用栈
 *   - zod 摘要只留「path: message」，不带 received；请求体里的证件号 / 密码绝不入日志
 *   - 路由直接 reply.status(4xx).send 的兜底（source:'reply'），每个失败请求只记一行
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
}));
vi.mock('../db/prisma.js', () => ({ prisma: prismaMock }));

import { env } from '../config/env.js';
import { authPlugin } from './auth.js';
import { registerErrorHandler } from './error-handler.js';
import { RefreshTokenRaceError } from '../modules/auth/auth.service.js';

type LogLine = Record<string, unknown> & { level: number; msg: string };

const FAILURE_MSGS = new Set([
  'validation error',
  'app error',
  'prisma known error (mapped by global handler)',
  'unhandled prisma error',
  'unhandled error',
  'route not found',
]);

let app: FastifyInstance;
let logLines: LogLine[] = [];
let rawLog = '';

const quoteSchema = z.object({ nationality: z.string().length(2) });

beforeAll(async () => {
  app = Fastify({
    logger: {
      level: 'trace',
      stream: {
        write(chunk: string) {
          rawLog += chunk;
          logLines.push(JSON.parse(chunk) as LogLine);
        },
      },
    },
  });
  await app.register(authPlugin);
  registerErrorHandler(app);

  app.post('/orders/quote', { preHandler: app.authenticate }, async (req) => {
    quoteSchema.parse(req.body);
    return { ok: true };
  });
  app.get(
    '/finances/summary',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async () => ({ ok: true }),
  );
  app.post('/auth/refresh', async () => {
    throw new RefreshTokenRaceError();
  });
  app.post('/payments/:id/confirm', async (_req, reply) =>
    reply.status(403).send({ error: '仅运营/管理员可确认收款' }),
  );
  app.get('/boom', async () => {
    throw new Error(
      '\nInvalid `prisma.passenger.create()` invocation\n{ data: { documentNumber: "E12345678" } }',
    );
  });
  app.post('/tiny', { bodyLimit: 64 }, async () => ({ ok: true }));
  app.get('/ok', async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  logLines = [];
  rawLog = '';
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({
    disabledAt: null,
    authVersion: 0,
    staffRole: null,
    mustChangePassword: false,
    agentProfile: { isActive: true },
  });
});

function failureLines(): LogLine[] {
  return logLines.filter((line) => FAILURE_MSGS.has(line.msg));
}

function onlyFailureLine(): LogLine {
  const lines = failureLines();
  expect(lines).toHaveLength(1);
  return lines[0];
}

function hs256Token(payload: Record<string, unknown>, secret: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const agentToken = () => app.jwt.sign({ sub: 'agent-user-1', role: UserRole.AGENT });

describe('validation error · 一行看懂 + 摘要 + 不漏请求体', () => {
  it('warn；带 method/route/statusCode/userId/role；issues 只有「path: message」', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders/quote?debug=1',
      headers: { authorization: `Bearer ${agentToken()}` },
      payload: { nationality: 'CHN', passportNumber: 'E12345678', password: 'hunter2-secret' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('请求校验未通过：nationality：String must contain exactly 2 character(s)');

    const line = onlyFailureLine();
    expect(line).toMatchObject({
      level: 40,
      msg: 'validation error',
      method: 'POST',
      route: '/orders/quote',
      statusCode: 400,
      userId: 'agent-user-1',
      role: 'AGENT',
      code: 'VALIDATION_ERROR',
      issueCount: 1,
      issues: ['nationality: String must contain exactly 2 character(s)'],
    });
    expect(typeof line.reqId).toBe('string');
    expect(JSON.stringify(line)).not.toContain('received');
    // 请求体（证件号、密码）与 query 都不进任何一行日志
    expect(rawLog).not.toContain('E12345678');
    expect(rawLog).not.toContain('hunter2-secret');
    expect(JSON.stringify(line)).not.toContain('debug=1');
  });
});

describe('app error · 分级与降噪', () => {
  it('requireRole 403 → warn，带 userId / role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/finances/summary',
      headers: { authorization: `Bearer ${agentToken()}` },
    });
    expect(res.statusCode).toBe(403);
    expect(onlyFailureLine()).toMatchObject({
      level: 40,
      msg: 'app error',
      method: 'GET',
      route: '/finances/summary',
      statusCode: 403,
      userId: 'agent-user-1',
      role: 'AGENT',
      code: 'FORBIDDEN',
      message: 'Requires role: ADMIN',
    });
  });

  it('没带 access token 的 401 → info（authFailure=missing）', async () => {
    const res = await app.inject({ method: 'GET', url: '/finances/summary' });
    expect(res.statusCode).toBe(401);
    expect(onlyFailureLine()).toMatchObject({
      level: 30,
      msg: 'app error',
      statusCode: 401,
      code: 'UNAUTHORIZED',
      authFailure: 'missing',
      userId: null,
      role: null,
    });
  });

  it('access token 过期的 401 → info（authFailure=expired）', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = hs256Token(
      { sub: 'agent-user-1', role: 'AGENT', iat: nowSec - 7200, exp: nowSec - 3600 },
      env.JWT_ACCESS_SECRET,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/finances/summary',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.statusCode).toBe(401);
    expect(onlyFailureLine()).toMatchObject({ level: 30, statusCode: 401, authFailure: 'expired' });
    // 令牌原文不进日志
    expect(rawLog).not.toContain(expired);
  });

  it('签名不对的 401 → 仍是 warn（authFailure=invalid）', async () => {
    const forged = hs256Token({ sub: 'x', role: 'ADMIN' }, 'not-the-real-secret-0123456789abcdef');
    const res = await app.inject({
      method: 'GET',
      url: '/finances/summary',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
    expect(onlyFailureLine()).toMatchObject({ level: 40, statusCode: 401, authFailure: 'invalid' });
  });

  it('409 REFRESH_TOKEN_RACE → info', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/refresh' });
    expect(res.statusCode).toBe(409);
    expect(onlyFailureLine()).toMatchObject({
      level: 30,
      msg: 'app error',
      route: '/auth/refresh',
      code: 'REFRESH_TOKEN_RACE',
    });
  });

  it('Fastify 自身的 4xx（请求体过大）此前不落日志，现在记 app error / warn', async () => {
    const res = await app.inject({ method: 'POST', url: '/tiny', payload: { note: 'x'.repeat(200) } });
    expect(res.statusCode).toBe(413);
    expect(onlyFailureLine()).toMatchObject({
      level: 40,
      msg: 'app error',
      route: '/tiny',
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
    expect(rawLog).not.toContain('x'.repeat(200));
  });
});

describe('路由直接 reply.status(4xx).send 的兜底', () => {
  it('记一行 app error（source=reply），只取错误体的 message', async () => {
    const res = await app.inject({ method: 'POST', url: '/payments/p_1/confirm' });
    expect(res.statusCode).toBe(403);
    expect(onlyFailureLine()).toMatchObject({
      level: 40,
      msg: 'app error',
      source: 'reply',
      route: '/payments/:id/confirm',
      statusCode: 403,
      code: null,
      message: '仅运营/管理员可确认收款',
    });
  });
});

describe('5xx · error 带栈', () => {
  it('unhandled error：error 级，栈只含调用帧，不带消息里的参数 dump', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });

    const line = onlyFailureLine();
    expect(line).toMatchObject({
      level: 50,
      msg: 'unhandled error',
      route: '/boom',
      statusCode: 500,
      message: 'Invalid `prisma.passenger.create()` invocation',
    });
    const err = line.err as { type: string; stack: string };
    expect(err.type).toBe('Error');
    expect(err.stack).toMatch(/^Error: Invalid `prisma\.passenger\.create\(\)` invocation\n\s+at /);
    expect(rawLog).not.toContain('E12345678');
  });
});

describe('其它', () => {
  it('未匹配路由 → info 的 route not found，path 去掉 query', async () => {
    const res = await app.inject({ method: 'GET', url: '/wp-login.php?token=abc' });
    expect(res.statusCode).toBe(404);
    const line = onlyFailureLine();
    expect(line).toMatchObject({ level: 30, msg: 'route not found', route: null, path: '/wp-login.php' });
    expect(JSON.stringify(line)).not.toContain('token=abc');
  });

  it('成功请求不记失败日志', async () => {
    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(failureLines()).toHaveLength(0);
  });
});
