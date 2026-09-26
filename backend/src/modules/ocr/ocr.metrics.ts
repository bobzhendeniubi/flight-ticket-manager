/**
 * 护照 OCR 调用指标（可观测性）：每次调 Qwen-VL 落一行 info，msg=ocr passport call。
 *
 * 实测 3.5 天 672 次、p50 7.3s / p95 9.6s / max 14.4s，但看不出时间花在哪、token 多少。字段：
 *   tag                 固定 'ocr_call'，便于 grep
 *   model / ok          实际调用的模型 / 是否拿到可用结果
 *   totalMs             读配置 + 调模型 + 后处理（≈ 接口耗时减去鉴权与请求体解析）
 *   configMs            读 OCR 配置（DB）
 *   upstreamMs          发请求到拿到模型响应头（≈ 模型推理 + 网络往返）
 *   readMs              读模型响应体
 *   httpStatus          模型接口的 HTTP 状态
 *   promptTokens / completionTokens / totalTokens   取响应 usage，没有就是 null
 *   imageKb             上传图片的体积（base64 解码后估算），用来对照耗时
 *   errorKind / errorSummary   仅失败时：timeout / http / upstream / bad_output / network / other
 *
 * 绝不记录图片与识别结果。JSON 解析失败时 V8 的 SyntaxError 文案会带出模型输出片段
 * （可能是姓名 / 证件号），这类错误一律换成固定文案。
 */
import { firstNonEmptyLine, sanitizeLogText } from '../../lib/log-sanitize.js';

export const OCR_METRICS_TAG = 'ocr_call';
export const OCR_METRICS_MSG = 'ocr passport call';

const ERROR_SUMMARY_MAX_CHARS = 200;

export type OcrErrorKind = 'timeout' | 'http' | 'upstream' | 'bad_output' | 'network' | 'other';

export interface OcrUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

/**
 * callQwenOcr 边跑边填的采集器：只装计时、HTTP 状态与 token 计数，不装任何识别内容。
 * 用可变采集器而不是返回值：调用中途抛错时，已经测到的分段耗时也要能落进日志。
 */
export interface OcrCallTrace {
  upstreamMs?: number;
  readMs?: number;
  httpStatus?: number;
  usage?: OcrUsage;
  /** callQwenOcr 自己抛出的失败（模型接口非 2xx / 响应里带 error）打的标，便于归类 */
  errorKind?: OcrErrorKind;
}

export function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 取 OpenAI 兼容响应里的 usage；没有 usage 返回 undefined（日志里各项记 null）。 */
export function parseOcrUsage(json: unknown): OcrUsage | undefined {
  if (json === null || typeof json !== 'object') return undefined;
  const usage = (json as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  return {
    promptTokens: finiteOrNull(u.prompt_tokens),
    completionTokens: finiteOrNull(u.completion_tokens),
    totalTokens: finiteOrNull(u.total_tokens),
  };
}

/** data-URL 的图片体积估算（KB）：只看 base64 段长度，不解码、不留图片内容。 */
export function approxDataUrlKb(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const base64Length = comma === -1 ? dataUrl.length : dataUrl.length - comma - 1;
  return Math.round((base64Length * 3) / 4 / 1024);
}

function errorName(err: unknown): string {
  if (err === null || typeof err !== 'object') return '';
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function summarizeOcrError(
  err: unknown,
  trace: OcrCallTrace,
): { errorKind: OcrErrorKind; errorSummary: string } {
  const name = errorName(err);
  // AbortSignal.timeout(30s) 触发时 fetch 抛 TimeoutError（DOMException）
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { errorKind: 'timeout', errorSummary: 'AI 服务调用超时' };
  }
  // 模型输出 / 响应体不是合法 JSON：SyntaxError 文案带输出片段，不能落日志
  if (err instanceof SyntaxError) {
    return { errorKind: 'bad_output', errorSummary: '模型返回内容不是合法 JSON' };
  }
  const summary = sanitizeLogText(firstNonEmptyLine(errorMessage(err)), ERROR_SUMMARY_MAX_CHARS);
  if (trace.errorKind) return { errorKind: trace.errorKind, errorSummary: summary };
  if (name === 'TypeError' && /fetch failed/i.test(errorMessage(err))) {
    // undici 把真实原因放在 cause 上：多数带 code（ENOTFOUND / ECONNREFUSED…），少数只有 message
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    const detail =
      typeof cause?.code === 'string'
        ? cause.code
        : typeof cause?.message === 'string' && cause.message
          ? sanitizeLogText(firstNonEmptyLine(cause.message), 80)
          : null;
    return { errorKind: 'network', errorSummary: detail ? `fetch failed (${detail})` : 'fetch failed' };
  }
  return { errorKind: 'other', errorSummary: summary };
}

export function buildOcrMetricsFields(input: {
  model: string;
  ok: boolean;
  totalMs: number;
  configMs: number;
  imageKb: number;
  trace: OcrCallTrace;
  error?: unknown;
}): Record<string, unknown> {
  const { trace } = input;
  return {
    tag: OCR_METRICS_TAG,
    model: input.model,
    ok: input.ok,
    totalMs: input.totalMs,
    configMs: input.configMs,
    upstreamMs: trace.upstreamMs ?? null,
    readMs: trace.readMs ?? null,
    httpStatus: trace.httpStatus ?? null,
    promptTokens: trace.usage?.promptTokens ?? null,
    completionTokens: trace.usage?.completionTokens ?? null,
    totalTokens: trace.usage?.totalTokens ?? null,
    imageKb: input.imageKb,
    ...(input.ok ? {} : summarizeOcrError(input.error, trace)),
  };
}
