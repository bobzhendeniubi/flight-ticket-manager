/**
 * request-failure-log · 失败日志纯函数：分级、令牌问题分类、zod 摘要、5xx 栈、错误体取码。
 * 合成数据，无任何真实证件号 / 令牌。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  buildFailureContextFields,
  classifyFailureLevel,
  classifyJwtVerifyFailure,
  errorMessageForLog,
  extractErrorFromPayload,
  formatValidationMessage,
  MAX_ISSUES_IN_LOG,
  noteRequestFailure,
  readRequestFailureNote,
  serializeErrorForLog,
  summarizeIssuesForLog,
} from './request-failure-log.js';

function zodIssues(schema: z.ZodTypeAny, value: unknown): z.ZodIssue[] {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error('expected validation failure');
  return parsed.error.issues;
}

describe('classifyFailureLevel · 分级与降噪', () => {
  it('5xx → error', () => {
    expect(classifyFailureLevel({ statusCode: 500 })).toBe('error');
    expect(classifyFailureLevel({ statusCode: 503, code: 'X' })).toBe('error');
  });

  it('真正的 4xx → warn', () => {
    expect(classifyFailureLevel({ statusCode: 400, code: 'BAD_REQUEST' })).toBe('warn');
    expect(classifyFailureLevel({ statusCode: 403, code: 'FORBIDDEN' })).toBe('warn');
    expect(classifyFailureLevel({ statusCode: 409, code: 'CONFLICT' })).toBe('warn');
    expect(classifyFailureLevel({ statusCode: 429, code: 'BAD_REQUEST' })).toBe('warn');
  });

  it('401 access token 没带 / 过期 → info；签名不对或未分类的 401 → warn', () => {
    expect(classifyFailureLevel({ statusCode: 401, authFailure: 'missing' })).toBe('info');
    expect(classifyFailureLevel({ statusCode: 401, authFailure: 'expired' })).toBe('info');
    expect(classifyFailureLevel({ statusCode: 401, authFailure: 'invalid' })).toBe('warn');
    // 如 refresh token 失效 / 账号停用：不是 access token 过期，仍按 warn
    expect(classifyFailureLevel({ statusCode: 401, code: 'UNAUTHORIZED' })).toBe('warn');
  });

  it('409 REFRESH_TOKEN_RACE（多标签页并发续期）→ info', () => {
    expect(classifyFailureLevel({ statusCode: 409, code: 'REFRESH_TOKEN_RACE' })).toBe('info');
  });

  it('未匹配路由的 404 → info；业务 404 → warn', () => {
    expect(classifyFailureLevel({ statusCode: 404, unmatchedRoute: true })).toBe('info');
    expect(classifyFailureLevel({ statusCode: 404, code: 'NOT_FOUND' })).toBe('warn');
  });
});

describe('classifyJwtVerifyFailure', () => {
  it('按 @fastify/jwt 错误码分类', () => {
    expect(classifyJwtVerifyFailure({ code: 'FST_JWT_NO_AUTHORIZATION_IN_HEADER' })).toBe('missing');
    expect(classifyJwtVerifyFailure({ code: 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED' })).toBe('expired');
    expect(classifyJwtVerifyFailure({ code: 'FST_JWT_AUTHORIZATION_TOKEN_INVALID' })).toBe('invalid');
    expect(classifyJwtVerifyFailure(new Error('boom'))).toBe('invalid');
    expect(classifyJwtVerifyFailure(null)).toBe('invalid');
  });
});

describe('noteRequestFailure / readRequestFailureNote', () => {
  it('按请求对象累积旁注，互不串', () => {
    const reqA = {};
    const reqB = {};
    noteRequestFailure(reqA, { authFailure: 'expired' });
    noteRequestFailure(reqA, { logged: true });
    expect(readRequestFailureNote(reqA)).toEqual({ authFailure: 'expired', logged: true });
    expect(readRequestFailureNote(reqB)).toBeUndefined();
  });
});

describe('zod 摘要', () => {
  const schema = z.object({
    nationality: z.string().length(2),
    gender: z.enum(['M', 'F']),
    passengers: z.array(z.object({ name: z.string() })),
  });

  it('日志摘要只留「path: message」字符串，不带 received 等原值字段', () => {
    const issues = zodIssues(schema, { nationality: 'CHN', gender: 'E12345678', passengers: [{}] });
    const summary = summarizeIssuesForLog(issues);
    expect(summary).toContain('nationality: String must contain exactly 2 character(s)');
    expect(summary).toContain('passengers.0.name: Required');
    expect(summary.every((line) => typeof line === 'string')).toBe(true);
    // 枚举的默认消息会回显收到的实参：日志里去掉原值，只留期望值
    expect(summary).toContain("gender: Invalid enum value. Expected 'M' | 'F'");
    expect(JSON.stringify(summary)).not.toContain('E12345678');
    expect(JSON.stringify(summary)).not.toContain('received');
  });

  it('根级 issue 用 (root) 标注；去重并最多 10 条', () => {
    expect(summarizeIssuesForLog(zodIssues(z.string(), 1))).toEqual([
      '(root): Expected string, received number',
    ]);
    const many = zodIssues(
      z.object(Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, z.string()]))),
      {},
    );
    expect(summarizeIssuesForLog(many)).toHaveLength(MAX_ISSUES_IN_LOG);
  });

  it('给客户端的 message 与此前口径一致（全角冒号 / 分号，超 5 条带总数）', () => {
    const issues = zodIssues(schema, { nationality: 'CHN', gender: 'M', passengers: [] });
    expect(formatValidationMessage(issues)).toBe(
      '请求校验未通过：nationality：String must contain exactly 2 character(s)',
    );
    const many = zodIssues(
      z.object(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}`, z.string()]))),
      {},
    );
    expect(formatValidationMessage(many)).toMatch(/（等 7 项问题）$/);
    expect(formatValidationMessage([])).toBe('Request validation failed');
  });
});

describe('buildFailureContextFields', () => {
  const base = { method: 'POST', rawUrl: '/orders/quote?x=1', userId: 'u_1', role: 'AGENT', staffRole: null };

  it('命中路由：只给路由模板，不给原始 url', () => {
    const fields = buildFailureContextFields({ ...base, route: '/orders/quote' }, 400);
    expect(fields).toEqual({
      method: 'POST',
      route: '/orders/quote',
      statusCode: 400,
      userId: 'u_1',
      role: 'AGENT',
    });
  });

  it('未匹配路由：route=null + 去掉 query 的 path；有岗位 / 令牌分类时带上', () => {
    const fields = buildFailureContextFields(
      { ...base, route: undefined, rawUrl: '/wp-login.php?token=abc', staffRole: 'FINANCE' },
      404,
      'expired',
    );
    expect(fields).toMatchObject({ route: null, path: '/wp-login.php', staffRole: 'FINANCE', authFailure: 'expired' });
    expect(JSON.stringify(fields)).not.toContain('token=abc');
  });
});

describe('serializeErrorForLog / errorMessageForLog · 5xx 栈', () => {
  it('只留类型 + 调用栈帧（首行是截断后的消息），不带多行消息里的参数 dump', () => {
    const err = new Error(
      '\nInvalid `prisma.passenger.create()` invocation\n{ data: { documentNumber: "E12345678", photo: "data:image/png;base64,AAAA" } }',
    );
    const out = serializeErrorForLog(err);
    expect(out.type).toBe('Error');
    expect(out.stack).toMatch(/^Error: Invalid `prisma\.passenger\.create\(\)` invocation\n\s+at /);
    expect(errorMessageForLog(err)).toBe('Invalid `prisma.passenger.create()` invocation');
    const text = JSON.stringify(out);
    expect(text).not.toContain('E12345678');
    expect(text).not.toContain('base64');
  });

  it('不带 message 字段（交给 pino 时不会被默认 err 序列化器改写）', () => {
    expect(serializeErrorForLog(new Error('boom'))).not.toHaveProperty('message');
  });

  it('消息 ≤200 字、保留字符串 code；非 Error 也能序列化', () => {
    const err = Object.assign(new Error('x'.repeat(500)), { code: 'P2003' });
    expect(errorMessageForLog(err).length).toBeLessThanOrEqual(200);
    expect(serializeErrorForLog(err).code).toBe('P2003');
    expect(serializeErrorForLog('plain string')).toEqual({ type: 'string' });
    expect(errorMessageForLog('plain string')).toBe('plain string');
  });
});

describe('extractErrorFromPayload · 路由直接 send 的错误体', () => {
  it('{ error: { code, message } }', () => {
    const payload = JSON.stringify({ error: { code: 'CONFLICT', message: '冲突', details: { secret: 1 } } });
    expect(extractErrorFromPayload(payload)).toEqual({ code: 'CONFLICT', message: '冲突' });
  });

  it('{ error: "中文提示" }（老路由直接 send 字符串）', () => {
    expect(extractErrorFromPayload(JSON.stringify({ error: '仅运营/管理员可确认收款' }))).toEqual({
      code: null,
      message: '仅运营/管理员可确认收款',
    });
  });

  it('Fastify 默认格式取 message 而不是 HTTP 状态文案', () => {
    const payload = JSON.stringify({ statusCode: 400, code: 'FST_X', error: 'Bad Request', message: 'body/x 必填' });
    expect(extractErrorFromPayload(payload)).toEqual({ code: 'FST_X', message: 'body/x 必填' });
  });

  it('非 JSON / 空 / 超大 / Buffer 都安全返回', () => {
    expect(extractErrorFromPayload('<html>502</html>')).toEqual({ code: null, message: null });
    expect(extractErrorFromPayload('')).toEqual({ code: null, message: null });
    expect(extractErrorFromPayload(undefined)).toEqual({ code: null, message: null });
    expect(extractErrorFromPayload('x'.repeat(20_000))).toEqual({ code: null, message: null });
    expect(extractErrorFromPayload(Buffer.from(JSON.stringify({ error: 'buf' })))).toEqual({
      code: null,
      message: 'buf',
    });
  });
});

// 生产（NODE_ENV=production）下 Prisma 5.22 的报错形状固定是「\nInvalid `x.y()` invocation:\n\n\n<原因>」，
// 真正原因在最后一行；中间（校验错误）是整段调用参数，含证件号 / 照片——只能要首尾两行。
describe('errorMessageForLog / serializeErrorForLog · Prisma 报错取到真正原因', () => {
  it('事务超时：首行 + 末行原因都在', () => {
    const err = new Error(
      '\nInvalid `tx.order.update()` invocation:\n\n\nTransaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5020 ms passed since the start of the transaction.',
    );
    const msg = errorMessageForLog(err);
    expect(msg).toContain('Invalid `tx.order.update()` invocation');
    expect(msg).toContain('The timeout for this transaction was 5000 ms');
    expect(msg.length).toBeLessThanOrEqual(200);
  });

  it('校验错误：中间的参数块（证件号 / 照片）不进日志，只留首行与末行原因', () => {
    const err = new Error(
      '\nInvalid `prisma.passenger.update()` invocation:\n\n{\n  data: {\n    documentNumber: "E12345678",\n    passportPhotoUrl: "data:image/jpeg;base64,/9j/AAAA",\n+   nationality: String\n  }\n}\n\nArgument `nationality` is missing.',
    );
    const text = `${errorMessageForLog(err)} ${JSON.stringify(serializeErrorForLog(err))}`;
    expect(errorMessageForLog(err)).toContain('Argument `nationality` is missing.');
    expect(text).not.toContain('12345678');
    expect(text).not.toContain('base64');
  });

  it('有 cause 时带上底层错误码（fetch failed 看得到 ENOTFOUND）', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND dashscope.example'), { code: 'ENOTFOUND' });
    expect(errorMessageForLog(new Error('fetch failed', { cause }))).toContain('ENOTFOUND');
  });

  it('Prisma 已知错误带 meta（字段名 / 约束名），值照样脱敏', () => {
    const err = Object.assign(new Error('Unique constraint failed on the fields: (`orderNumber`)'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: { target: ['orderNumber'], modelName: 'Order', cause: 'Record E12345678 not found' },
    });
    const out = serializeErrorForLog(err);
    expect(out.code).toBe('P2002');
    expect(out.meta).toEqual({ target: ['orderNumber'], modelName: 'Order', cause: 'Record E****5678 not found' });
  });
});
