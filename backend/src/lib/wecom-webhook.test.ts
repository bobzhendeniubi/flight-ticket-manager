import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { envMock } = vi.hoisted(() => ({ envMock: { WECOM_WEBHOOK_URL: undefined as string | undefined } }));
vi.mock('../config/env.js', () => ({ env: envMock }));

import { pushWecomMarkdown, truncateToByteLimit } from './wecom-webhook.js';

function client() {
  return { notificationLog: { create: vi.fn().mockResolvedValue({}) } };
}

beforeEach(() => {
  envMock.WECOM_WEBHOOK_URL = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('truncateToByteLimit', () => {
  it('未超限原样返回', () => {
    expect(truncateToByteLimit('短文本', 100)).toBe('短文本');
  });

  it('超限按字节截断并加省略提示，且不切断多字节字符', () => {
    const text = '中'.repeat(200); // 每个中文字符 UTF-8 占 3 字节 → 600 字节
    const result = truncateToByteLimit(text, 50);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(50);
    expect(result.endsWith('已截断）')).toBe(true);
    // 结果里不应出现替换字符（说明没有从多字节字符中间切断）
    expect(result).not.toContain('�');
  });
});

describe('pushWecomMarkdown · 未配置 URL', () => {
  it('返回 skipped:true，不发请求、不落日志', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const db = client();

    const result = await pushWecomMarkdown('hello', 'test-purpose', db as never);

    expect(result).toEqual({ skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.notificationLog.create).not.toHaveBeenCalled();
  });
});

describe('pushWecomMarkdown · 已配置 URL', () => {
  beforeEach(() => {
    envMock.WECOM_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test';
  });

  it('请求成功 → ok:true，落一行 SENT 日志', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const db = client();

    const result = await pushWecomMarkdown('# 标题\n正文', 'reminder-daily-summary', db as never);

    expect(result).toEqual({ skipped: false, ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      envMock.WECOM_WEBHOOK_URL,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: '# 标题\n正文' } }),
      }),
    );
    expect(db.notificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        channel: 'WECHAT',
        recipient: 'wecom-webhook',
        template: 'reminder-daily-summary',
        payload: '# 标题\n正文',
        status: 'SENT',
        lastError: null,
      }),
    });
  });

  it('HTTP 非 2xx → ok:false，落一行 FAILED 日志带错误信息', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const db = client();

    const result = await pushWecomMarkdown('hello', 'test-purpose', db as never);

    expect(result.skipped).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
    expect(db.notificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'FAILED', lastError: expect.stringContaining('500') }),
    });
  });

  it('fetch 抛异常（网络错误）→ ok:false，落一行 FAILED 日志', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const db = client();

    const result = await pushWecomMarkdown('hello', 'test-purpose', db as never);

    expect(result).toEqual({ skipped: false, ok: false, error: 'network down' });
    expect(db.notificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'FAILED', lastError: 'network down' }),
    });
  });

  it('NotificationLog 写入失败不影响推送结果的判断（fetch 仍算成功）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const db = { notificationLog: { create: vi.fn().mockRejectedValue(new Error('db down')) } };

    const result = await pushWecomMarkdown('hello', 'test-purpose', db as never);

    expect(result).toEqual({ skipped: false, ok: true });
  });

  it('超长文本发送前先截断（企业微信 4096 字节上限）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const db = client();
    const longText = 'a'.repeat(5000);

    await pushWecomMarkdown(longText, 'test-purpose', db as never);

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(Buffer.byteLength(sentBody.markdown.content, 'utf8')).toBeLessThanOrEqual(4096);
  });
});
