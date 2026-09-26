/**
 * clientErrorReporter · 前端报错上报的节流、脱敏与组包（node 环境，注入 send / 时钟 / 路径）。
 * SHARED with admin-web/src/lib/clientErrorReporter.test.ts —— 两端同一套用例。
 * 合成数据，无任何真实令牌 / 证件号。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildClientErrorBody,
  CLIENT_ERROR_DEDUPE_MS,
  CLIENT_ERROR_MAX_BODY_BYTES,
  CLIENT_ERROR_SESSION_CAP,
  createClientErrorReporter,
  installGlobalErrorListeners,
  scrubSensitiveText,
  stripQueryAndHash,
  type ClientErrorReporterDeps,
} from './clientErrorReporter';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';

function setup(overrides: Partial<ClientErrorReporterDeps> = {}) {
  let clock = 1_000_000;
  const sent: Array<Record<string, unknown>> = [];
  const send = vi.fn(async (body: string) => {
    sent.push(JSON.parse(body) as Record<string, unknown>);
  });
  const reporter = createClientErrorReporter({
    app: 'admin',
    buildVersion: 'c31dca6',
    send,
    now: () => clock,
    getPath: () => '/orders',
    getUserAgent: () => 'Mozilla/5.0 (test)',
    ...overrides,
  });
  return {
    reporter,
    send,
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('节流', () => {
  it('同一 message 1 分钟内只报一次，过了 1 分钟再报', () => {
    const { reporter, send, advance } = setup();
    expect(reporter.report(new Error('boom'))).toBe(true);
    expect(reporter.report(new Error('boom'))).toBe(false);
    advance(CLIENT_ERROR_DEDUPE_MS - 1);
    expect(reporter.report(new Error('boom'))).toBe(false);
    advance(1);
    expect(reporter.report(new Error('boom'))).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('不同 message 各自上报', () => {
    const { reporter, send } = setup();
    reporter.report(new Error('a'));
    reporter.report(new Error('b'));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it(`单会话最多 ${CLIENT_ERROR_SESSION_CAP} 条`, () => {
    const { reporter, send } = setup();
    for (let i = 0; i < CLIENT_ERROR_SESSION_CAP + 5; i += 1) reporter.report(new Error(`err-${i}`));
    expect(send).toHaveBeenCalledTimes(CLIENT_ERROR_SESSION_CAP);
  });
});

describe('失败静默、不重试', () => {
  it('send 返回 rejected promise：不抛、不重试', async () => {
    const send = vi.fn(() => Promise.reject(new Error('network down')));
    const { reporter } = setup({ send });
    expect(() => reporter.report(new Error('boom'))).not.toThrow();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('send 同步抛错：report 返回 false 且不抛', () => {
    const send = vi.fn(() => {
      throw new Error('fetch is not defined');
    });
    const { reporter } = setup({ send });
    expect(reporter.report(new Error('boom'))).toBe(false);
  });
});

describe('不带 query / token / 表单值', () => {
  it('path 只留 pathname；消息与栈里的令牌、URL 参数、证件号被抹掉；只有约定字段', () => {
    const { reporter, sent } = setup({ getPath: () => '/orders?search=张三&token=abc#tab=2' });
    const err = new Error(`GET https://api.example.test/orders?search=E12345678 failed, Bearer ${JWT}`);
    err.stack = `Error: boom\n    at f (https://admin.example.test/assets/index-abc.js?v=1:10:20)`;
    reporter.report(err);
    const [payload] = sent;
    expect(Object.keys(payload).sort()).toEqual(['app', 'buildVersion', 'message', 'path', 'stack', 'userAgent']);
    expect(payload.path).toBe('/orders');
    expect(payload.message).toBe('GET https://api.example.test/orders failed, Bearer [redacted]');
    expect(payload.stack).toContain('index-abc.js:10:20');
    const text = JSON.stringify(payload);
    for (const secret of [JWT, 'E12345678', 'token=abc', 'search=']) expect(text).not.toContain(secret);
  });

  it('reject 普通对象：只报类型，不序列化内容', () => {
    const { reporter, sent } = setup();
    reporter.report({ passportNumber: 'G87654321', password: 'hunter2-secret' });
    expect(sent[0].message).toBe('Non-Error rejection: [object Object]');
    expect(JSON.stringify(sent[0])).not.toContain('hunter2-secret');
  });

  it('接口错误带 [HTTP 状态 code] 前缀，但不带 details', () => {
    const { reporter, sent } = setup();
    const apiError = Object.assign(new Error('已送签乘客不能改自备签'), {
      status: 400,
      code: 'BAD_REQUEST',
      details: { documentNumber: 'E12345678' },
    });
    reporter.report(apiError);
    expect(sent[0].message).toBe('[HTTP 400 BAD_REQUEST] 已送签乘客不能改自备签');
    expect(JSON.stringify(sent[0])).not.toContain('E12345678');
  });

  it('ErrorBoundary 的组件栈拼进 stack', () => {
    const { reporter, sent } = setup();
    reporter.report(new Error('render crash'), { componentStack: '\n    at OrdersPage\n    at Layout' });
    expect(sent[0].stack).toContain('React component stack:\n    at OrdersPage');
  });
});

describe('忽略名单', () => {
  it('ResizeObserver 提示 / Script error / AbortError / 浏览器插件 → 不报', () => {
    const { reporter, send } = setup();
    expect(reporter.report(new Error('ResizeObserver loop completed with undelivered notifications.'))).toBe(false);
    expect(reporter.report('Script error.')).toBe(false);
    expect(reporter.report(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }))).toBe(false);
    const fromExtension = new Error('x is undefined');
    fromExtension.stack = 'Error: x\n    at chrome-extension://abcdef/content.js:1:1';
    expect(reporter.report(fromExtension)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('组包大小', () => {
  it('超长（含中文）调用栈被砍到 7KB 以内', () => {
    const body = buildClientErrorBody({
      app: 'admin',
      message: '崩溃'.repeat(150),
      stack: '栈'.repeat(3000),
      path: '/orders',
      buildVersion: 'c31dca6',
      userAgent: 'Mozilla/5.0',
    });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(CLIENT_ERROR_MAX_BODY_BYTES);
    expect(JSON.parse(body).message).toBe('崩溃'.repeat(150));
  });
});

describe('文本工具', () => {
  it('stripQueryAndHash / scrubSensitiveText', () => {
    expect(stripQueryAndHash('/a/b?x=1#y')).toBe('/a/b');
    expect(scrubSensitiveText('手机 13812345678 证件 E12345678')).toBe('手机 1******5678 证件 E****5678');
    expect(scrubSensitiveText("Unexpected token '?'")).toBe("Unexpected token '?'");
  });
});

describe('installGlobalErrorListeners', () => {
  it('error 事件与 unhandledrejection 都会上报；卸载后不再上报', () => {
    const target = new EventTarget();
    const report = vi.fn(() => true);
    const uninstall = installGlobalErrorListeners(target, { report });

    const errorEvent = new Event('error');
    const thrown = new Error('uncaught');
    Object.defineProperty(errorEvent, 'error', { value: thrown });
    target.dispatchEvent(errorEvent);

    const rejectionEvent = new Event('unhandledrejection');
    Object.defineProperty(rejectionEvent, 'reason', { value: 'rejected' });
    target.dispatchEvent(rejectionEvent);

    expect(report).toHaveBeenNthCalledWith(1, thrown);
    expect(report).toHaveBeenNthCalledWith(2, 'rejected');

    uninstall();
    target.dispatchEvent(errorEvent);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('error 事件没有 error 对象时，用 message + 去 query 的脚本位置', () => {
    const target = new EventTarget();
    const report = vi.fn(() => true);
    installGlobalErrorListeners(target, { report });
    const errorEvent = new Event('error');
    Object.defineProperties(errorEvent, {
      error: { value: null },
      message: { value: 'Uncaught ReferenceError: foo is not defined' },
      filename: { value: 'https://admin.example.test/assets/index-abc.js?v=2' },
      lineno: { value: 3 },
      colno: { value: 7 },
    });
    target.dispatchEvent(errorEvent);
    expect(report).toHaveBeenCalledWith({
      message: 'Uncaught ReferenceError: foo is not defined',
      stack: 'Uncaught ReferenceError: foo is not defined\n    at https://admin.example.test/assets/index-abc.js:3:7',
    });
  });
});
