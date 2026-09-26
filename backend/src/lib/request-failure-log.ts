/**
 * 请求失败日志（可观测性）的纯函数部分：分级、上下文字段、zod 摘要、5xx 栈、错误响应体取码。
 * Fastify 接线在 plugins/error-handler.ts。
 *
 * 背景：错误处理器原本就会记 msg=app error / validation error 两行（info），但只有 code+message
 * 或 zod 原始 issues，必须靠 reqId 回查 incoming request / request completed 才知道是哪个接口、
 * 什么状态码、谁在调；zod 原始 issue 还会带 received 原值。这里把每一行补成「一行就能看懂」：
 *   method、route（路由模板 req.routeOptions.url，不含 query 与实参）、statusCode、userId、role
 *   （+ staffRole / authFailure / 未匹配路由时的 path），并按真实严重度分级：
 *   · 5xx → error（带截断后的调用栈）
 *   · 401 且是 access token 缺失 / 过期、409 REFRESH_TOKEN_RACE（多标签页并发续期）→ info（正常现象）
 *   · 其余 4xx → warn
 * 各行 msg 保持原样，下游按 msg 过滤的分析脚本不受影响。
 *
 * 绝不记录请求体 / 响应体：直接 reply.status(4xx).send 的兜底只从错误响应体里取 error.code /
 * error.message 两个字段；所有自由文本都经 sanitizeLogText（去令牌、遮证件号、≤200 字）。
 */
import type { ZodIssue } from 'zod';
import {
  firstNonEmptyLine,
  sanitizeLogText,
  stripQueryAndHash,
  truncateText,
} from './log-sanitize.js';

export type FailureLogLevel = 'error' | 'warn' | 'info';

/** 401 的令牌问题分类：没带 / 过期（正常续期流程）/ 签名或格式不对（值得看一眼）。 */
export type AuthFailureReason = 'missing' | 'expired' | 'invalid';

/** 日志里错误消息的上限（字符）。 */
export const FAILURE_MESSAGE_MAX_CHARS = 200;
/** 给客户端的校验失败 message 最多拼几条 issue（与此前行为一致）。 */
export const MAX_ISSUES_IN_MESSAGE = 5;
/** 日志里的校验 issue 摘要最多几条。 */
export const MAX_ISSUES_IN_LOG = 10;
const MAX_STACK_FRAMES = 15;
const MAX_UNMATCHED_PATH_CHARS = 120;
/** 兜底解析错误响应体的上限：错误体都很小，超过这个量级的不是错误 JSON，不去解析。 */
const MAX_ERROR_PAYLOAD_CHARS = 16 * 1024;

// ── 按请求挂的旁注 ────────────────────────────────────────────────────────────
// 鉴权钩子（令牌问题分类）与错误处理器（本请求已记过）要把信息递给后面的 onSend 兜底；
// 用 WeakMap 按请求对象挂，请求结束随 GC 回收，不必给 FastifyRequest 加装饰器。
interface FailureNote {
  authFailure?: AuthFailureReason;
  logged?: boolean;
}
const failureNotes = new WeakMap<object, FailureNote>();

export function noteRequestFailure(req: object, patch: FailureNote): void {
  failureNotes.set(req, { ...failureNotes.get(req), ...patch });
}

export function readRequestFailureNote(req: object): FailureNote | undefined {
  return failureNotes.get(req);
}

/** @fastify/jwt 校验失败的错误码 → 令牌问题分类（只影响日志分级，401 响应不变）。 */
export function classifyJwtVerifyFailure(err: unknown): AuthFailureReason {
  const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (code === 'FST_JWT_NO_AUTHORIZATION_IN_HEADER') return 'missing';
  if (code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED') return 'expired';
  return 'invalid';
}

// ── 分级 ──────────────────────────────────────────────────────────────────────

export function classifyFailureLevel(input: {
  statusCode: number;
  code?: string | null;
  authFailure?: AuthFailureReason;
  /** 请求没匹配到任何路由（req.routeOptions.url 为空） */
  unmatchedRoute?: boolean;
}): FailureLogLevel {
  if (input.statusCode >= 500) return 'error';
  // 令牌过期 / 没带：前端静默续期后重试的正常流程，不刷 warn（签名不对的仍按 warn）
  if (input.statusCode === 401 && (input.authFailure === 'missing' || input.authFailure === 'expired')) {
    return 'info';
  }
  // 多标签页同一秒并发续期，输掉轮换的那个拿 409，属正常现象
  if (input.statusCode === 409 && input.code === 'REFRESH_TOKEN_RACE') return 'info';
  // 未匹配路由的 404 多是扫描器探测，不刷 warn
  if (input.statusCode === 404 && input.unmatchedRoute) return 'info';
  return 'warn';
}

// ── 上下文字段 ────────────────────────────────────────────────────────────────

export interface FailureRequestContext {
  method: string;
  /** req.routeOptions.url —— 路由模板；没匹配到路由时为 undefined */
  route: string | undefined;
  /** req.url —— 只在没匹配到路由时用来给出 path（去掉 query / hash） */
  rawUrl: string;
  userId: string | null;
  role: string | null;
  staffRole: string | null;
}

export function buildFailureContextFields(
  ctx: FailureRequestContext,
  statusCode: number,
  authFailure?: AuthFailureReason,
): Record<string, unknown> {
  return {
    method: ctx.method,
    route: ctx.route ?? null,
    ...(ctx.route
      ? {}
      : { path: truncateText(stripQueryAndHash(ctx.rawUrl), MAX_UNMATCHED_PATH_CHARS) }),
    statusCode,
    userId: ctx.userId,
    role: ctx.role,
    ...(ctx.staffRole ? { staffRole: ctx.staffRole } : {}),
    ...(authFailure ? { authFailure } : {}),
  };
}

/** 日志里的错误消息：多行只取首个非空行 → 去令牌 / 遮证件号 → ≤200 字。 */
export function sanitizeFailureMessage(message: string): string {
  return sanitizeLogText(firstNonEmptyLine(message), FAILURE_MESSAGE_MAX_CHARS);
}

// ── zod 校验失败 ──────────────────────────────────────────────────────────────

function issuePath(issue: ZodIssue): string {
  return issue.path.join('.');
}

/**
 * 给客户端的顶层 message：「请求校验未通过：path：可读消息；…（等 N 项问题）」。
 * 前端多处直接展示 error.message，行为与此前内联在错误处理器里的实现完全一致。
 */
export function formatValidationMessage(issues: readonly ZodIssue[]): string {
  const issueMessages = Array.from(
    new Set(
      issues.map((issue) => {
        const path = issuePath(issue);
        return path ? `${path}：${issue.message}` : issue.message;
      }),
    ),
  );
  const shown = issueMessages.slice(0, MAX_ISSUES_IN_MESSAGE);
  const overflow =
    issueMessages.length > MAX_ISSUES_IN_MESSAGE ? `（等 ${issueMessages.length} 项问题）` : '';
  return shown.length > 0 ? `请求校验未通过：${shown.join('；')}${overflow}` : 'Request validation failed';
}

/** 枚举不匹配的默认文案会回显收到的实参（「…, received 'xxx'」）：日志里去掉原值，只留期望值。 */
function issueMessageForLog(issue: ZodIssue): string {
  if (issue.code === 'invalid_enum_value') {
    return issue.message.replace(/,\s*received\s+'[\s\S]*'$/, '');
  }
  return issue.message;
}

/**
 * 日志里的 issue 摘要：只留「path: message」字符串（去重、最多 10 条、每条 ≤200 字），
 * 丢掉 received / expected / options / keys 等可能带原值的字段。
 */
export function summarizeIssuesForLog(issues: readonly ZodIssue[]): string[] {
  const lines = issues.map((issue) => {
    const path = issuePath(issue) || '(root)';
    return sanitizeLogText(`${path}: ${issueMessageForLog(issue)}`, FAILURE_MESSAGE_MAX_CHARS);
  });
  return Array.from(new Set(lines)).slice(0, MAX_ISSUES_IN_LOG);
}

// ── 5xx 调用栈 ────────────────────────────────────────────────────────────────

/**
 * 5xx 日志里的 err 字段：类型 + 错误码 + 只含调用栈帧的 stack（首行是「类型: 截断后的消息」）。
 *
 * 不用 pino 默认的 err 序列化：Prisma 校验错误的 message / stack 会把整段调用参数原样带出
 * （乘客证件号、甚至整张护照图的 base64），一行日志能到几 MB。
 * 故意不带 message 字段：pino 的 err 序列化器只接管「带字符串 message」的对象，不带就原样输出；
 * 消息放在同一行的顶层 message 字段（与 app error 行一致），见 errorMessageForLog。
 */
export interface SerializedLogError {
  type: string;
  code?: string;
  stack?: string;
  /** Prisma 已知错误的 meta（字段名 / 约束名 / 模型名），值已脱敏截断 */
  meta?: Record<string, string | number | boolean | string[]>;
}

/** Prisma 客户端报错首行的固定形状；生产格式的真正原因在最后一行（中间是调用参数块）。 */
const PRISMA_INVOCATION_HEADER = /^Invalid `[^`]+` invocation/;
/** 看起来像调用参数 dump 的行（JSON 片段 / data URL）：取末行原因时一律不要。 */
const ARGUMENT_DUMP_LINE = /^[{}[\]"'+]|base64/;
const MAX_META_ENTRIES = 5;
const MAX_META_TEXT_CHARS = 100;

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? '';
}

/** 首个非空行；Prisma 调用报错再拼上末行的真正原因（只取原因行，参数块一行不要）。 */
function messageHeadline(raw: string): string {
  const first = firstNonEmptyLine(raw);
  if (!PRISMA_INVOCATION_HEADER.test(first)) return first;
  const reason = lastNonEmptyLine(raw);
  if (reason === first || ARGUMENT_DUMP_LINE.test(reason)) return first;
  return `${first} … ${reason}`;
}

/** 底层原因（fetch failed 的 ENOTFOUND 之类）：有错误码取错误码，否则取 cause 消息首行。 */
function causeHint(err: Error): string | null {
  const cause = (err as { cause?: unknown }).cause;
  if (cause == null) return null;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) return code;
  return cause instanceof Error ? firstNonEmptyLine(cause.message ?? '') || null : null;
}

/** 异常消息 → 日志里的 message（首行 / Prisma 末行原因 / 底层原因 → 去令牌、遮证件号、≤200 字）。 */
export function errorMessageForLog(err: unknown): string {
  if (!(err instanceof Error)) return sanitizeFailureMessage(String(err));
  const headline = messageHeadline(err.message ?? '');
  const cause = causeHint(err);
  return sanitizeLogText(cause ? `${headline}（cause: ${cause}）` : headline, FAILURE_MESSAGE_MAX_CHARS);
}

/** Prisma 已知错误的 meta 只留标量 / 字符串数组，逐个脱敏截断，最多 5 项（不整包原样进日志）。 */
function summarizeMetaForLog(meta: unknown): SerializedLogError['meta'] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined;
  const out: NonNullable<SerializedLogError['meta']> = {};
  for (const [key, value] of Object.entries(meta).slice(0, MAX_META_ENTRIES)) {
    if (typeof value === 'string') out[key] = sanitizeLogText(value, MAX_META_TEXT_CHARS);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[key] = value.slice(0, MAX_META_ENTRIES).map((v) => sanitizeLogText(v, MAX_META_TEXT_CHARS));
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function serializeErrorForLog(err: unknown): SerializedLogError {
  if (!(err instanceof Error)) return { type: typeof err };
  const type = err.name || err.constructor?.name || 'Error';
  const rawCode = (err as { code?: unknown }).code;
  const frames = (err.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, MAX_STACK_FRAMES);
  const meta = summarizeMetaForLog((err as { meta?: unknown }).meta);
  return {
    type,
    ...(typeof rawCode === 'string' ? { code: rawCode } : {}),
    ...(meta ? { meta } : {}),
    ...(frames.length > 0 ? { stack: [`${type}: ${errorMessageForLog(err)}`, ...frames].join('\n') } : {}),
  };
}

// ── 路由直接 reply.status(4xx).send 的兜底：只从错误体里取 code / message ────────

export interface PayloadError {
  code: string | null;
  message: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 兼容本项目里出现过的三种错误体：
 *   { error: { code, message } }（错误处理器 / 新代码）
 *   { error: '中文提示' }（部分老路由直接 send 字符串）
 *   { statusCode, code?, error: 'Bad Request', message }（Fastify 默认格式）
 * 只取 code / message 两个字段，其余（details 等）一律不碰。
 */
export function extractErrorFromPayload(payload: unknown): PayloadError {
  const empty: PayloadError = { code: null, message: null };
  const text =
    typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : null;
  if (text === null || text.length === 0 || text.length > MAX_ERROR_PAYLOAD_CHARS) return empty;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return empty;
  }
  if (body === null || typeof body !== 'object') return empty;
  const record = body as Record<string, unknown>;
  const errorField = record.error;
  if (errorField !== null && typeof errorField === 'object') {
    const nested = errorField as Record<string, unknown>;
    return { code: asString(nested.code), message: asString(nested.message) };
  }
  return {
    code: asString(record.code),
    message: asString(record.message) ?? asString(errorField),
  };
}
