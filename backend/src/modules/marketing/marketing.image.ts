/**
 * 海报出图 —— 按模型自动选择 DashScope 同步或异步接口。
 *
 * 2.0 系列及 max/plus 走同步 multimodal 接口，一次请求直接返回图片；
 * 其它模型保留 image-generation 异步任务和轮询实现。OSS 地址只有短期有效，
 * 所以拿到后立即下载成 data URL 落库。
 */
import { fetchImageSafely } from '../../lib/safe-fetch.js';
import type { QwenConfig } from '../../lib/qwen-config.js';

export const DEFAULT_IMAGE_MODEL = 'qwen-image-2.0-pro';
export const DEFAULT_POSTER_SIZE = '1080*1440';
export const IMAGE_POLL_INTERVAL_MS = 5_000;
export const IMAGE_MAX_WAIT_MS = 5 * 60_000;

const IMAGE_REQUEST_TIMEOUT_MS = 120_000;

export interface GenerateImageParams {
  cfg: QwenConfig;
  prompt: string;
  /** 形如 "1080*1440"。 */
  size?: string;
  model?: string;
  /** 测试可注入请求函数，不改变生产默认行为。 */
  fetcher?: typeof fetch;
  /** 测试可注入等待函数，不改变生产轮询间隔。 */
  sleep?: (milliseconds: number) => Promise<void>;
  /** 测试可注入时钟。 */
  now?: () => number;
}

export interface GenerateImageResult {
  /** data:image/png;base64,... —— 已转存，直接交给调用方落库。 */
  imageDataUrl: string;
  model: string;
}

interface ImageResult {
  url?: string;
}

interface ImageTaskOutput {
  task_id?: string;
  task_status?: string;
  code?: string;
  message?: string;
  results?: ImageResult[];
}

interface SyncImageOutput {
  image?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOutput(body: unknown): ImageTaskOutput {
  if (!isRecord(body)) return {};
  const output = body.output;
  if (!isRecord(output)) return {};
  const results = Array.isArray(output.results)
    ? output.results.filter(isRecord).map((item) => ({
        url: typeof item.url === 'string' ? item.url : undefined,
      }))
    : undefined;
  return {
    task_id: typeof output.task_id === 'string' ? output.task_id : undefined,
    task_status: typeof output.task_status === 'string' ? output.task_status : undefined,
    code: typeof output.code === 'string' ? output.code : undefined,
    message: typeof output.message === 'string' ? output.message : undefined,
    results,
  };
}

function readSyncImageOutput(body: unknown): SyncImageOutput {
  if (!isRecord(body)) return {};
  const output = body.output;
  if (!isRecord(output) || !Array.isArray(output.choices)) return {};
  const choice = output.choices.find(isRecord);
  if (!choice || !isRecord(choice.message)) return {};
  const content = choice.message.content;
  if (!Array.isArray(content)) return {};
  const imagePart = content.find((item) => isRecord(item) && typeof item.image === 'string');
  return {
    image: imagePart && typeof imagePart.image === 'string' ? imagePart.image : undefined,
  };
}

function bodyError(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const code = typeof body.code === 'string' ? body.code : '';
  const message = typeof body.message === 'string' ? body.message : '';
  return code || message ? `${code} ${message}`.trim() : null;
}

async function requestJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`出图接口 HTTP ${response.status}：${bodyError(body) ?? '未知错误'}`);
    }
    const error = bodyError(body);
    if (error) throw new Error(`出图失败：${error}`);
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('出图接口请求超时，请重试');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function taskFailure(output: ImageTaskOutput): Error {
  return new Error(`出图任务失败：${output.code ?? 'TASK_FAILED'} ${output.message ?? '未知错误'}`.trim());
}

function taskImageUrl(output: ImageTaskOutput): string | null {
  const url = output.results?.[0]?.url;
  return url?.trim() || null;
}

function taskStatus(output: ImageTaskOutput): string {
  return output.task_status?.trim().toUpperCase() ?? '';
}

async function waitForImageTask(
  params: GenerateImageParams,
  taskId: string,
  startedAt: number,
): Promise<string> {
  const fetcher = params.fetcher ?? fetch;
  const sleep = params.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const now = params.now ?? Date.now;

  while (true) {
    if (now() - startedAt >= IMAGE_MAX_WAIT_MS) {
      throw new Error('出图任务超时（超过 5 分钟），请重试');
    }
    await sleep(IMAGE_POLL_INTERVAL_MS);
    const body = await requestJson(
      fetcher,
      `${params.cfg.nativeBaseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${params.cfg.apiKey}` } },
    );
    const output = readOutput(body);
    const status = taskStatus(output);
    if (status === 'SUCCEEDED' || status === 'SUCCESS') {
      const imageUrl = taskImageUrl(output);
      if (!imageUrl) throw new Error('出图成功但返回结果里没有图片地址');
      return imageUrl;
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
      throw taskFailure(output);
    }
    if (now() - startedAt >= IMAGE_MAX_WAIT_MS) {
      throw new Error('出图任务超时（超过 5 分钟），请重试');
    }
  }
}

/** 判断模型是否使用同步 multimodal-generation 接口。 */
export function isSynchronousImageModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return /^qwen-image-2\.0-/u.test(normalized)
    || normalized === 'qwen-image-max'
    || normalized === 'qwen-image-plus';
}

/** 同步生成图片，并把临时图片地址转存为 data URL。 */
export async function generatePosterImageSync(
  params: GenerateImageParams,
): Promise<GenerateImageResult> {
  const model = (params.model ?? DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
  const size = params.size ?? DEFAULT_POSTER_SIZE;
  const fetcher = params.fetcher ?? fetch;
  const body = await requestJson(
    fetcher,
    `${params.cfg.nativeBaseUrl}/api/v1/services/aigc/multimodal-generation/generation`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: {
          messages: [{ role: 'user', content: [{ text: params.prompt }] }],
        },
        parameters: { size, watermark: false, prompt_extend: false },
      }),
    },
  );
  const imageUrl = readSyncImageOutput(body).image;
  if (!imageUrl) throw new Error('出图失败：返回结果里没有图片地址');
  const image = await fetchImageSafely(imageUrl);
  if (!image) throw new Error('出图成功但下载失败，请重试');

  return {
    imageDataUrl: `data:image/png;base64,${image.toString('base64')}`,
    model,
  };
}

/** 提交异步生图任务、轮询任务状态并把临时图片地址转存为 data URL。 */
export async function generatePosterImageAsync(
  params: GenerateImageParams,
): Promise<GenerateImageResult> {
  const model = (params.model ?? DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
  const size = params.size ?? DEFAULT_POSTER_SIZE;
  const fetcher = params.fetcher ?? fetch;
  const startedAt = (params.now ?? Date.now)();
  const body = await requestJson(
    fetcher,
    `${params.cfg.nativeBaseUrl}/api/v1/services/aigc/image-generation/generation`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.cfg.apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model,
        input: { prompt: params.prompt },
        parameters: { size, watermark: false, prompt_extend: false },
      }),
    },
  );
  const output = readOutput(body);
  const status = taskStatus(output);
  if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
    throw taskFailure(output);
  }

  const remoteUrl = status === 'SUCCEEDED' || status === 'SUCCESS'
    ? taskImageUrl(output)
    : null;
  const imageUrl = remoteUrl ?? await waitForImageTask(
    params,
    output.task_id ?? (() => { throw new Error('出图接口未返回任务 ID'); })(),
    startedAt,
  );
  const image = await fetchImageSafely(imageUrl);
  if (!image) throw new Error('出图成功但下载失败，请重试');

  return {
    imageDataUrl: `data:image/png;base64,${image.toString('base64')}`,
    model,
  };
}

/** 根据模型名分派同步或异步调用路径。 */
export async function generatePosterImage(
  params: GenerateImageParams,
): Promise<GenerateImageResult> {
  const model = (params.model ?? DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
  return isSynchronousImageModel(model)
    ? generatePosterImageSync({ ...params, model })
    : generatePosterImageAsync({ ...params, model });
}
