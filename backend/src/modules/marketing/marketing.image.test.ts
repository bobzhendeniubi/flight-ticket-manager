import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchImageSafely } from '../../lib/safe-fetch.js';
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MAX_WAIT_MS,
  IMAGE_POLL_INTERVAL_MS,
  generatePosterImageAsync,
  isSynchronousImageModel,
  generatePosterImage,
} from './marketing.image.js';

vi.mock('../../lib/safe-fetch.js', () => ({ fetchImageSafely: vi.fn() }));

const cfg = {
  apiKey: 'test-key',
  compatibleBaseUrl: 'https://example.test/v1',
  nativeBaseUrl: 'https://example.test',
  vlModel: 'test-model',
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.mocked(fetchImageSafely).mockReset();
});

describe('海报生图模型路径分派', () => {
  it('默认 2.0-pro 走同步 multimodal 接口，一次返回图片', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({
      output: {
        choices: [{ message: { content: [{ image: 'https://oss.example/sync.png' }] } }],
      },
    }));
    vi.mocked(fetchImageSafely).mockResolvedValue(Buffer.from('sync-png'));

    const result = await generatePosterImage({ cfg, prompt: '整张海报', fetcher });

    expect(result).toEqual({ imageDataUrl: 'data:image/png;base64,c3luYy1wbmc=', model: DEFAULT_IMAGE_MODEL });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toContain('/multimodal-generation/generation');
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    expect(body.model).toBe(DEFAULT_IMAGE_MODEL);
    expect(body.input).toEqual({ messages: [{ role: 'user', content: [{ text: '整张海报' }] }] });
  });

  it('按模型名识别同步模型，3.0 和 wan 走异步模型', () => {
    expect(isSynchronousImageModel('qwen-image-2.0-pro')).toBe(true);
    expect(isSynchronousImageModel('qwen-image-max')).toBe(true);
    expect(isSynchronousImageModel('qwen-image-plus')).toBe(true);
    expect(isSynchronousImageModel('qwen-image-3.0-pro')).toBe(false);
    expect(isSynchronousImageModel('wan2.1-t2i-turbo')).toBe(false);
  });
});

describe('generatePosterImageAsync — DashScope 异步任务', () => {
  it('提交任务后按 5 秒轮询，成功下载图片', async () => {
    let elapsed = 0;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ output: { task_id: 'task-1', task_status: 'PENDING' } }))
      .mockResolvedValueOnce(response({ output: { task_id: 'task-1', task_status: 'SUCCEEDED', results: [{ url: 'https://oss.example/image.png' }] } }));
    const sleep = vi.fn(async (milliseconds: number) => { elapsed += milliseconds; });
    vi.mocked(fetchImageSafely).mockResolvedValue(Buffer.from('png'));

    const result = await generatePosterImage({
      cfg,
      prompt: '整张海报',
      model: 'qwen-image-3.0-pro',
      fetcher,
      sleep,
      now: () => elapsed,
    });

    expect(result).toEqual({ imageDataUrl: 'data:image/png;base64,cG5n', model: 'qwen-image-3.0-pro' });
    expect(sleep).toHaveBeenCalledWith(IMAGE_POLL_INTERVAL_MS);
    expect(fetchImageSafely).toHaveBeenCalledWith('https://oss.example/image.png');
    const postInit = fetcher.mock.calls[0]?.[1];
    expect(postInit?.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'X-DashScope-Async': 'enable',
    });
    const body = typeof postInit?.body === 'string' ? JSON.parse(postInit.body) as Record<string, unknown> : {};
    expect(body.model).toBe('qwen-image-3.0-pro');
    expect(body.input).toEqual({ prompt: '整张海报' });
    expect(body.parameters).toEqual({ size: '1080*1440', watermark: false, prompt_extend: false });
  });

  it('任务失败时抛出任务错误', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ output: { task_id: 'task-failed', task_status: 'PENDING' } }))
      .mockResolvedValueOnce(response({ output: { task_id: 'task-failed', task_status: 'FAILED', code: 'BadPrompt', message: '提示词不可用' } }));

    await expect(generatePosterImageAsync({
      cfg,
      prompt: '整张海报',
      fetcher,
      sleep: vi.fn(async () => undefined),
      now: () => 5_000,
    })).rejects.toThrow('BadPrompt');
  });

  it('超过 5 分钟仍未完成时超时', async () => {
    let elapsed = 0;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ output: { task_id: 'task-timeout', task_status: 'PENDING' } }))
      .mockImplementation(async () => response({ output: { task_id: 'task-timeout', task_status: 'PENDING' } }));
    const sleep = vi.fn(async (milliseconds: number) => { elapsed += milliseconds; });

    await expect(generatePosterImageAsync({
      cfg,
      prompt: '整张海报',
      fetcher,
      sleep,
      now: () => elapsed,
    })).rejects.toThrow('超过 5 分钟');
    expect(elapsed).toBeGreaterThanOrEqual(IMAGE_MAX_WAIT_MS);
  });
});
