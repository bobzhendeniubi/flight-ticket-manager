/**
 * 前端报错上报：window error / unhandledrejection / ErrorBoundary → POST /client-errors。
 *
 * SHARED with sales-web/src/lib/clientErrorReporter.ts —— 两端逐字保持一致（app 取值由调用方传入）。
 *
 * 口径：
 *   - 同一 message 1 分钟内只报一次；单会话（本页面生命周期）最多 20 条；
 *   - 上报失败静默丢弃、不重试：上报本身绝不能再制造报错或拖慢页面；
 *   - 只报 message / stack / 路径 / 构建号 / UA：路径只取 pathname（不带 query / hash），
 *     不读任何表单；直接 fetch，不走 apiFetch、不加 Authorization、不带 cookie 与 referrer；
 *     文本里的 URL 参数、Bearer / JWT 令牌、证件号 / 手机号形态在发出前就抹掉。
 */

export type ClientErrorApp = 'admin' | 'sales';

export const CLIENT_ERROR_DEDUPE_MS = 60_000;
export const CLIENT_ERROR_SESSION_CAP = 20;
/** 后端 bodyLimit 是 8KB，这里留出余量。 */
export const CLIENT_ERROR_MAX_BODY_BYTES = 7 * 1024;
const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_CHARS = 3000;
const MAX_PATH_CHARS = 200;
const MAX_USER_AGENT_CHARS = 256;
const MAX_BUILD_VERSION_CHARS = 64;

export interface ClientErrorPayload {
  app: ClientErrorApp;
  message: string;
  stack?: string;
  path: string;
  buildVersion: string;
  userAgent?: string;
}

export interface ClientErrorReporterDeps {
  app: ClientErrorApp;
  buildVersion: string;
  /** 发出上报（JSON 字符串）；失败由调用方静默吞掉 */
  send: (body: string) => Promise<unknown>;
  now: () => number;
  getPath: () => string;
  getUserAgent: () => string;
}

export interface ClientErrorExtra {
  /** ErrorBoundary 的 React 组件栈 */
  componentStack?: string | null;
}

export interface ClientErrorReporter {
  /** 返回是否真的发出（被忽略名单 / 去重 / 会话上限挡下时为 false）。绝不抛错。 */
  report: (error: unknown, extra?: ClientErrorExtra) => boolean;
}

// ── 文本处理 ────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 去掉 query 与 hash：`/orders?search=x#top` → `/orders`。 */
export function stripQueryAndHash(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
// 带 `=` 的 query 段；后面紧跟调用栈的「:行:列」时保留行列号
const QUERY_WITH_PARAMS = /\?[^\s"'<>#()]*?=[^\s"'<>#()]*?((?::\d+){1,2})?(?=[\s"'<>#()]|$)/g;
const HASH_WITH_PARAMS = /#[^\s"'<>()]*=[^\s"'<>()]*/g;
// 证件号（1–2 位大写字母 + 6–10 位数字）/ 身份证号 / 大陆手机号：只留首位与尾 4 位
const DOCUMENT_NUMBER = /\b[A-Z]{1,2}\d{6,10}\b/g;
const CN_ID_NUMBER = /\b\d{17}[\dXx]\b/g;
const CN_MOBILE = /\b1[3-9]\d{9}\b/g;

function keepFirstAndLast4(token: string): string {
  return token.length <= 5 ? token : `${token.slice(0, 1)}${'*'.repeat(token.length - 5)}${token.slice(-4)}`;
}

/** 发出前抹掉令牌、URL 参数，遮住证件号 / 手机号（与后端 lib/log-sanitize.ts 同一口径）。 */
export function scrubSensitiveText(text: string): string {
  return text
    .replace(BEARER_TOKEN, 'Bearer [redacted]')
    .replace(JWT_LIKE, '[jwt]')
    .replace(QUERY_WITH_PARAMS, '$1')
    .replace(HASH_WITH_PARAMS, '')
    .replace(CN_ID_NUMBER, keepFirstAndLast4)
    .replace(DOCUMENT_NUMBER, keepFirstAndLast4)
    .replace(CN_MOBILE, keepFirstAndLast4);
}

// ── 异常归一 ────────────────────────────────────────────────────────────────

/** 接口错误（ApiError 形态：数字 status + 字符串 code）加个前缀，便于区分前端 bug 与接口拒绝。 */
function apiErrorPrefix(error: object): string {
  const { status, code } = error as { status?: unknown; code?: unknown };
  return typeof status === 'number' && typeof code === 'string' ? `[HTTP ${status} ${code}] ` : '';
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: `${apiErrorPrefix(error)}${error.message || error.name || 'Error'}`, stack: error.stack };
  }
  if (typeof error === 'string') return { message: error };
  if (error !== null && typeof error === 'object') {
    const { message, stack } = error as { message?: unknown; stack?: unknown };
    if (typeof message === 'string' && message) {
      return { message, stack: typeof stack === 'string' ? stack : undefined };
    }
    // reject 了一个普通对象：只报类型，绝不序列化内容（可能带表单值）
    return { message: `Non-Error rejection: ${Object.prototype.toString.call(error)}` };
  }
  return { message: `Non-Error rejection: ${String(error)}` };
}

const IGNORED_MESSAGES = [/ResizeObserver loop/i, /^Script error\.?$/i];
const EXTENSION_SOURCE = /(chrome|moz|safari(-web)?)-extension:\/\//i;

/** 已知噪音：浏览器 ResizeObserver 提示、跨域脚本无信息的 Script error、切页取消的请求、浏览器插件。 */
function shouldIgnore(error: unknown, message: string, stack: string | undefined): boolean {
  const name = error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  if (name === 'AbortError') return true;
  if (IGNORED_MESSAGES.some((pattern) => pattern.test(message))) return true;
  return stack !== undefined && EXTENSION_SOURCE.test(stack);
}

// ── 组包（控制在后端 8KB 上限以内）────────────────────────────────────────────

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** 序列化上报；超预算时先对半砍调用栈，仍超再砍消息与 UA。 */
export function buildClientErrorBody(payload: ClientErrorPayload): string {
  let current = payload;
  let body = JSON.stringify(current);
  while (byteLength(body) > CLIENT_ERROR_MAX_BODY_BYTES && current.stack) {
    const nextLength = Math.floor(current.stack.length / 2);
    current = { ...current, stack: nextLength > 0 ? current.stack.slice(0, nextLength) : undefined };
    body = JSON.stringify(current);
  }
  if (byteLength(body) > CLIENT_ERROR_MAX_BODY_BYTES) {
    current = { ...current, message: current.message.slice(0, 100), userAgent: undefined };
    body = JSON.stringify(current);
  }
  return body;
}

// ── 上报器 ──────────────────────────────────────────────────────────────────

export function createClientErrorReporter(deps: ClientErrorReporterDeps): ClientErrorReporter {
  const lastSentAtByMessage = new Map<string, number>();
  let sentCount = 0;

  function report(error: unknown, extra?: ClientErrorExtra): boolean {
    try {
      const described = describeError(error);
      if (shouldIgnore(error, described.message, described.stack)) return false;

      const message = truncate(scrubSensitiveText(described.message.trim() || 'Unknown error'), MAX_MESSAGE_CHARS);
      const now = deps.now();
      const lastSentAt = lastSentAtByMessage.get(message);
      if (lastSentAt !== undefined && now - lastSentAt < CLIENT_ERROR_DEDUPE_MS) return false;
      if (sentCount >= CLIENT_ERROR_SESSION_CAP) return false;

      const componentStack = extra?.componentStack ? `React component stack:${extra.componentStack}` : undefined;
      const rawStack = [described.stack, componentStack].filter(Boolean).join('\n');
      const body = buildClientErrorBody({
        app: deps.app,
        message,
        stack: rawStack ? truncate(scrubSensitiveText(rawStack), MAX_STACK_CHARS) : undefined,
        path: truncate(scrubSensitiveText(stripQueryAndHash(deps.getPath())), MAX_PATH_CHARS) || '/',
        buildVersion: truncate(deps.buildVersion, MAX_BUILD_VERSION_CHARS),
        userAgent: truncate(deps.getUserAgent(), MAX_USER_AGENT_CHARS),
      });

      sentCount += 1;
      lastSentAtByMessage.set(message, now);
      // 失败静默丢弃、不重试（上报通道本身出问题时不能再制造新的报错）
      deps.send(body).catch(() => undefined);
      return true;
    } catch {
      // 上报本身绝不能抛错打断页面
      return false;
    }
  }

  return { report };
}

/** 挂 error / unhandledrejection 监听；返回卸载函数（测试用）。 */
export function installGlobalErrorListeners(target: EventTarget, reporter: ClientErrorReporter): () => void {
  const onError = (event: Event): void => {
    const e = event as ErrorEvent;
    if (e.error != null) {
      reporter.report(e.error);
      return;
    }
    if (typeof e.message === 'string' && e.message) {
      const where = e.filename ? `\n    at ${stripQueryAndHash(e.filename)}:${e.lineno ?? 0}:${e.colno ?? 0}` : '';
      reporter.report({ message: e.message, stack: where ? `${e.message}${where}` : undefined });
    }
  };
  const onRejection = (event: Event): void => {
    reporter.report((event as PromiseRejectionEvent).reason);
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

// ── 单例接线：入口 init 一次，ErrorBoundary 调 reportClientError ─────────────────

let activeReporter: ClientErrorReporter | null = null;

export function initClientErrorReporting(options: {
  app: ClientErrorApp;
  endpoint: string;
  buildVersion: string;
}): void {
  if (activeReporter || typeof window === 'undefined') return;
  const reporter = createClientErrorReporter({
    app: options.app,
    buildVersion: options.buildVersion,
    send: (body) =>
      fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }),
    now: () => Date.now(),
    getPath: () => window.location.pathname,
    getUserAgent: () => navigator.userAgent,
  });
  installGlobalErrorListeners(window, reporter);
  activeReporter = reporter;
}

/** ErrorBoundary 等处主动上报；未 init（如单测）时什么都不做。 */
export function reportClientError(error: unknown, extra?: ClientErrorExtra): void {
  activeReporter?.report(error, extra);
}
