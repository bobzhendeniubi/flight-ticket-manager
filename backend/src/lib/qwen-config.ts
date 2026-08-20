/**
 * DashScope / Qwen 配置解析（生图 + 海报回读校验共用）。
 *
 * 读取优先级：AiOcrConfig 单例表 > env。后台「AI 识别设置」页写的就是这张表，
 * 运营改完立刻生效、不用重启容器 —— 所以海报生图和回读校验也读同一份，
 * 免得后台换了 key 而营销中心还在用旧的 env 值。
 *
 * 端点口径（踩过的坑）：sk-ws- 开头是国际版 key，必须配国际站
 * dashscope-intl.aliyuncs.com，配大陆站直接 401；反之亦然。
 *
 * 生图走 DashScope 原生 REST（/api/v1/services/aigc/...），不是 OpenAI 兼容层，
 * 所以这里同时给出 compatibleBaseUrl（视觉理解）和 nativeBaseUrl（文生图）。
 */
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';

const DEFAULT_VL_MODEL = 'qwen3-vl-plus';
const DEFAULT_COMPAT_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const FALLBACK_NATIVE_BASE = 'https://dashscope-intl.aliyuncs.com';

export interface QwenConfig {
  apiKey: string;
  /** OpenAI 兼容端点，供视觉理解（回读校验）用 */
  compatibleBaseUrl: string;
  /** DashScope 原生端点根（无尾斜杠），供文生图用 */
  nativeBaseUrl: string;
  /** 视觉理解模型（护照 OCR / 海报回读校验同款） */
  vlModel: string;
}

/**
 * 把兼容端点推导成原生端点根：
 *   https://dashscope-intl.aliyuncs.com/compatible-mode/v1 → https://dashscope-intl.aliyuncs.com
 * 用 URL origin 提取，避免把 /compatible-mode 误拼进生图路径。
 */
function toNativeBase(compatibleBaseUrl: string): string {
  try {
    return new URL(compatibleBaseUrl).origin;
  } catch {
    return FALLBACK_NATIVE_BASE;
  }
}

/** 解析可用的 Qwen 配置；没有 key 时返回 null（调用方据此降级，不抛错）。 */
export async function resolveQwenConfig(): Promise<QwenConfig | null> {
  const dbCfg = await prisma.aiOcrConfig.findFirst();
  const usable = dbCfg?.enabled !== false;

  const apiKey = (usable && dbCfg?.apiKey) || env.DASHSCOPE_API_KEY || '';
  if (!apiKey) return null;

  const compatibleBaseUrl =
    (usable && dbCfg?.baseUrl) || env.QWEN_BASE_URL || DEFAULT_COMPAT_BASE;

  const vlModel = (usable && dbCfg?.model) || env.QWEN_VL_MODEL || DEFAULT_VL_MODEL;

  return {
    apiKey,
    compatibleBaseUrl,
    nativeBaseUrl: toNativeBase(compatibleBaseUrl),
    vlModel,
  };
}
