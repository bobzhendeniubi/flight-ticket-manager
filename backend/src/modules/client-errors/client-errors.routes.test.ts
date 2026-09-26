/**
 * POST /client-errors · 前端报错上报（真实 Fastify + 进程内限流 + 抓 pino 输出，合成数据）
 *
 * 覆盖：匿名可达、zod 校验、截断、path 去 query、令牌 / 证件号脱敏、未知字段不入日志、
 * 8KB 请求体上限、按 IP 30 次 / 分钟限流。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { clientErrorRoutes } from './client-errors.routes.js';
import {
  CLIENT_ERROR_MESSAGE_MAX_CHARS,
  CLIENT_ERROR_RATE_LIMIT,
  CLIENT_ERROR_STACK_MAX_CHARS,
} from './client-errors.schemas.js';

type LogLine = Record<string, unknown> & { level: number; msg: string };

let app: FastifyInstance;
let logLines: LogLine[] = [];
let rawLog = '';
let ipSeq = 0;

beforeAll(async () => {
  app = Fastify({
    logger: {
      level: 'info',
      stream: {
        write(chunk: string) {
          rawLog += chunk;
          logLines.push(JSON.parse(chunk) as LogLine);
        },
      },
    },
  });
  // 与生产同一套：全局限流插件 + 路由级 config.rateLimit（不设 redis → 进程内 store）
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => `${req.ip}:${req.routeOptions?.url ?? req.url}`,
  });
  registerErrorHandler(app);
  await app.register(clientErrorRoutes, { prefix: '/client-errors' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  logLines = [];
  rawLog = '';
});

/** 每个用例换一个 IP，避免互相吃掉对方的限流额度。 */
function nextIp(): string {
  ipSeq += 1;
  return `198.51.100.${ipSeq}`;
}

const validReport = {
  app: 'admin',
  message: "Cannot read properties of undefined (reading 'passengers')",
  stack: "TypeError: Cannot read properties of undefined\n    at OrdersPage (https://admin.example.test/assets/index-abc123.js:1:2345)",
  path: '/orders',
  buildVersion: 'c31dca6',
  userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140.0',
};

function post(payload: unknown, remoteAddress = nextIp()) {
  return app.inject({ method: 'POST', url: '/client-errors', payload: payload as object, remoteAddress });
}

function clientErrorLines(): LogLine[] {
  return logLines.filter((line) => line.msg === 'client error');
}

describe('POST /client-errors', () => {
  it('匿名上报 → 204，落一行 warn（tag=client_error），字段齐全', async () => {
    const res = await post(validReport);
    expect(res.statusCode).toBe(204);
    const lines = clientErrorLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 40,
      tag: 'client_error',
      app: 'admin',
      message: validReport.message,
      stack: validReport.stack,
      path: '/orders',
      buildVersion: 'c31dca6',
      userAgent: validReport.userAgent,
    });
  });

  it('path 去掉 query / hash；文本里的令牌、URL 参数、证件号被抹掉；未知字段不入日志', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
    const res = await post({
      ...validReport,
      app: 'sales',
      path: '/checkout?coupon=ABC&phone=13812345678#step=2',
      message: `Request failed: GET https://api.example.test/orders?search=E12345678 with Bearer ${jwt}`,
      stack: `Error: boom\n    at x (https://store.example.test/assets/a.js?v=1:1:1) token=${jwt}`,
      formValues: { passportNumber: 'G87654321', password: 'hunter2-secret' },
    });
    expect(res.statusCode).toBe(204);
    const [line] = clientErrorLines();
    expect(line.path).toBe('/checkout');
    expect(line.message).toBe('Request failed: GET https://api.example.test/orders with Bearer [redacted]');
    expect(line).not.toHaveProperty('formValues');
    for (const secret of [jwt, '13812345678', 'E12345678', 'G87654321', 'hunter2-secret', 'coupon=ABC']) {
      expect(rawLog).not.toContain(secret);
    }
  });

  it('message / stack 超长 → 截断而不是拒收', async () => {
    const res = await post({ ...validReport, message: 'm'.repeat(1500), stack: 's'.repeat(6000) });
    expect(res.statusCode).toBe(204);
    const [line] = clientErrorLines();
    expect((line.message as string).length).toBeLessThanOrEqual(CLIENT_ERROR_MESSAGE_MAX_CHARS);
    expect((line.stack as string).length).toBeLessThanOrEqual(CLIENT_ERROR_STACK_MAX_CHARS);
  });

  it('没传 userAgent 时用请求头兜底', async () => {
    const { userAgent: _omit, ...rest } = validReport;
    const res = await app.inject({
      method: 'POST',
      url: '/client-errors',
      payload: rest,
      remoteAddress: nextIp(),
      headers: { 'user-agent': 'UA-from-header/1.0' },
    });
    expect(res.statusCode).toBe(204);
    expect(clientErrorLines()[0].userAgent).toBe('UA-from-header/1.0');
  });

  it.each([
    ['app 不在白名单', { ...validReport, app: 'miniprogram' }],
    ['缺 message', { ...validReport, message: '   ' }],
    ['缺 path', { ...validReport, path: undefined }],
    ['buildVersion 超长', { ...validReport, buildVersion: 'v'.repeat(65) }],
  ])('校验失败（%s）→ 400，不落 client error', async (_label, payload) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(clientErrorLines()).toHaveLength(0);
  });

  it('请求体超过 8KB → 413', async () => {
    const res = await post({ ...validReport, stack: 'x'.repeat(9 * 1024) });
    expect(res.statusCode).toBe(413);
    expect(clientErrorLines()).toHaveLength(0);
  });

  it(`同一 IP 每分钟 ${CLIENT_ERROR_RATE_LIMIT.max} 次，超出 → 429；换 IP 不受影响`, async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < CLIENT_ERROR_RATE_LIMIT.max + 1; i += 1) {
      const res = await post(validReport, ip);
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, CLIENT_ERROR_RATE_LIMIT.max).every((s) => s === 204)).toBe(true);
    expect(statuses[CLIENT_ERROR_RATE_LIMIT.max]).toBe(429);
    expect((await post(validReport)).statusCode).toBe(204);
  });
});
