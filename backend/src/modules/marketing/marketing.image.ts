/**
 * 海报出图 —— DashScope 千问图像（qwen-image-2.0-pro）。
 *
 * 为什么选它：接口稳定且是**同步**接口，一次请求直接拿背景图，不用轮询异步任务。
 *
 * 两个关键参数，都不能想当然改：
 *   prompt_extend: false —— 关闭自动改写，让无字背景提示词保持确定。
 *   watermark:     false —— 海报要发给代理和客户，不能带平台水印。
 *
 * 返回的 OSS URL **24 小时后过期**，所以这里直接下载成 data URL 交给调用方合成并落库，
 * 绝不把外链存进数据库 —— 否则第二天所有历史海报全变裂图。
 */
import { fetchImageSafely } from '../../lib/safe-fetch.js';
import type { QwenConfig } from '../../lib/qwen-config.js';

/** 默认出图模型。背景质感与稳定性是选型第一优先级，不要随意更换。 */
export const DEFAULT_IMAGE_MODEL = 'qwen-image-2.0-pro';

/** 朋友圈 / 小红书竖版 3:4。海报模板按这个比例设计。 */
export const DEFAULT_POSTER_SIZE = '1080*1440';

/** 出图请求超时：同步接口实测 30~60s，给到 120s 留足余量。 */
const IMAGE_TIMEOUT_MS = 120_000;

export interface GenerateImageParams {
  cfg: QwenConfig;
  prompt: string;
  /** 形如 "1080*1440" */
  size?: string;
  model?: string;
}

export interface GenerateImageResult {
  /** data:image/png;base64,... —— 已转存，交给服务端叠字后落库 */
  imageDataUrl: string;
  model: string;
}

interface DashScopeImageResponse {
  output?: {
    choices?: Array<{
      message?: { content?: Array<{ image?: string }> };
    }>;
  };
  code?: string;
  message?: string;
}

/** 生成一张海报图。失败抛 Error（带 DashScope 的错误码/文案，便于运营看懂）。 */
export async function generatePosterImage(
  params: GenerateImageParams,
): Promise<GenerateImageResult> {
  const model = params.model ?? DEFAULT_IMAGE_MODEL;
  const size = params.size ?? DEFAULT_POSTER_SIZE;
  const url = `${params.cfg.nativeBaseUrl}/api/v1/services/aigc/multimodal-generation/generation`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  let body: DashScopeImageResponse;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content: [{ text: params.prompt }] }] },
        parameters: { size, watermark: false, prompt_extend: false },
      }),
      signal: controller.signal,
    });
    body = (await res.json()) as DashScopeImageResponse;
    if (!res.ok) {
      throw new Error(`出图接口 HTTP ${res.status}：${body?.message ?? '未知错误'}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('出图超时（超过 120 秒），请重试');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // DashScope 的业务错误是 HTTP 200 + code 字段，必须单独判，不能只看状态码
  if (body.code) {
    throw new Error(`出图失败：${body.code} ${body.message ?? ''}`.trim());
  }

  const remoteUrl = body.output?.choices?.[0]?.message?.content?.[0]?.image;
  if (!remoteUrl) {
    throw new Error('出图失败：返回结果里没有图片地址');
  }

  // 立刻转存 —— OSS 链接 24 小时过期
  const buf = await fetchImageSafely(remoteUrl);
  if (!buf) {
    throw new Error('出图成功但下载失败，请重试');
  }

  return {
    imageDataUrl: `data:image/png;base64,${buf.toString('base64')}`,
    model,
  };
}
