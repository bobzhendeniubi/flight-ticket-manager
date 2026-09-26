/**
 * 护照 OCR 识别端点
 *
 * POST /ocr/passport
 *   body : { imageDataUrl: string }  — data:image/...;base64,... (≤6MB)
 *   auth : ADMIN / STAFF / AGENT —— 代理录单同样需要护照识别（公测反馈）
 *
 * 配置优先级：AiOcrConfig（DB 单例）> 环境变量（DASHSCOPE_API_KEY / QWEN_BASE_URL / QWEN_VL_MODEL）
 * 无可用 key → 200 { configured: false }
 * AI 识别失败 → 200 { configured: true, engine: 'qwen', error: '...', suggested: null }，绝不 500。
 *
 * PII 约束：不记录 imageDataUrl；不记录 API key；识别结果不写 audit。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { dataUrlImageSchema } from '../../lib/proof-url.js';
import { applyOcrPostProcessing, type RawOcrFields } from './ocr.postprocess.js';
import { PASSPORT_OCR_PROMPT } from './ocr.prompt.js';

const DEFAULT_MODEL = 'qwen3-vl-plus';

const ocrBodySchema = z.object({
  imageDataUrl: dataUrlImageSchema,
});

/** 从 DB 单例 + env 解析出可用的 OCR 配置，DB 优先。*/
async function resolveOcrConfig(): Promise<{
  apiKey: string;
  baseUrl: string;
  model: string;
} | null> {
  const dbCfg = await prisma.aiOcrConfig.findFirst();

  const apiKey =
    (dbCfg?.enabled !== false && dbCfg?.apiKey) || env.DASHSCOPE_API_KEY || '';
  if (!apiKey) return null;

  const baseUrl =
    (dbCfg?.enabled !== false && dbCfg?.baseUrl) ||
    env.QWEN_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1';

  const model =
    (dbCfg?.enabled !== false && dbCfg?.model) ||
    env.QWEN_VL_MODEL ||
    DEFAULT_MODEL;

  return { apiKey, baseUrl, model };
}

/** 调用 Qwen-VL OpenAI 兼容端点识别护照。返回 suggested 字段对象或抛出 Error。*/
async function callQwenOcr(
  imageDataUrl: string,
  cfg: { apiKey: string; baseUrl: string; model: string },
): Promise<Record<string, unknown>> {
  // 提示词见 ocr.prompt.ts（不写会被照抄的示例值；签发地点 ≠ 签发机关）
  const systemPrompt = PASSPORT_OCR_PROMPT;

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: systemPrompt },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
    // 30 秒超时
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const hint = text.slice(0, 200);
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('API 密钥无效或无权限，请在设置页更新密钥');
    }
    if (resp.status === 429) {
      throw new Error('请求频率超限，请稍后再试');
    }
    throw new Error(`AI 服务返回 ${resp.status}：${hint}`);
  }

  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (json.error?.message) {
    throw new Error(`AI 错误：${json.error.message}`);
  }

  const content = json.choices?.[0]?.message?.content ?? '';
  // 去掉可能的 markdown 代码块包裹
  const cleaned = content.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();

  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  return parsed;
}

export const ocrRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/passport',
    {
      preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)],
    },
    async (req) => {
      const body = ocrBodySchema.parse(req.body);

      const cfg = await resolveOcrConfig();
      if (!cfg) {
        return { configured: false };
      }

      try {
        const raw = await callQwenOcr(body.imageDataUrl, cfg);
        const { suggested, verify } = applyOcrPostProcessing(
          raw as RawOcrFields,
        );
        return {
          configured: true,
          engine: 'qwen',
          model: cfg.model,
          suggested,
          verify,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'AI 识别失败，请重试或手动填写';
        return {
          configured: true,
          engine: 'qwen',
          model: cfg.model,
          error: message,
          suggested: null,
        };
      }
    },
  );
};
