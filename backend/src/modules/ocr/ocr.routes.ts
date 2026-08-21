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
import { normalizeVisaDate } from './visa-date.js';

const DEFAULT_MODEL = 'qwen3-vl-plus';

type OcrErrorCode =
  | 'OCR_UPSTREAM_AUTH'
  | 'OCR_RATE_LIMITED'
  | 'OCR_UPSTREAM_ERROR'
  | 'OCR_INVALID_RESPONSE'
  | 'OCR_REQUEST_FAILED';

class OcrRouteError extends Error {
  constructor(
    readonly code: OcrErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OcrRouteError';
  }
}

function upstreamOcrError(status: number): OcrRouteError {
  if (status === 401 || status === 403) {
    return new OcrRouteError('OCR_UPSTREAM_AUTH', 'AI 识别服务认证失败，请联系运营检查 AI 配置');
  }
  if (status === 429) {
    return new OcrRouteError('OCR_RATE_LIMITED', '请求频率超限，请稍后再试');
  }
  return new OcrRouteError('OCR_UPSTREAM_ERROR', 'AI 识别服务暂时不可用，请稍后再试');
}

function parseOcrContent(content: string): Record<string, unknown> {
  const cleaned = content.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('OCR response is not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new OcrRouteError('OCR_INVALID_RESPONSE', 'AI 识别返回格式异常，请重试');
  }
}

interface OcrApiResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function readOcrResponse(resp: Response): Promise<OcrApiResponse> {
  try {
    return (await resp.json()) as OcrApiResponse;
  } catch {
    throw new OcrRouteError('OCR_INVALID_RESPONSE', 'AI 识别返回格式异常，请重试');
  }
}

function toOcrFailure(err: unknown): { code: OcrErrorCode; message: string } {
  if (err instanceof OcrRouteError) {
    return { code: err.code, message: err.message };
  }
  return { code: 'OCR_REQUEST_FAILED', message: 'AI 识别暂时失败，请稍后再试' };
}

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
  const systemPrompt =
    '你是护照 OCR 引擎。严格输出 JSON，不要任何注释或 markdown 代码块。' +
    '字段：lastName, firstName, fullName, chineseName, documentNumber, ' +
    'dateOfBirth(YYYY-MM-DD), gender(必须识别，只输出 M/F/X 之一：男=M 女=F 无法判定=X), ' +
    'nationality(ISO-3166 alpha-3), ' +
    'passportIssueCountry(ISO-3166 alpha-3), passportExpiry(YYYY-MM-DD), ' +
    'passportIssueDate(YYYY-MM-DD), passportIssuePlace(签发地点/签发机关文本，如"广东省广州市"), ' +
    'placeOfBirth。' +
    '另外输出 mrzLine1、mrzLine2：护照底部机读区(MRZ)两行原文，逐字符抄录（含填充符 <，每行 44 字符），' +
    '无法读到机读区则填 null。' +
    '再输出 fieldConfidence：一个对象，键为上述各字段名，值为 0-100 的整数识别置信度（越高越确信）。' +
    '性别识别：优先读 MRZ 第二行第 21 位（M/F）；MRZ 缺失或模糊时读目视区「性别/Sex」栏（男/M→M，女/F→F）。' +
    '找不到的字段填 null。优先用 MRZ 机读区提取机读字段，中文姓名/签发日期/签发地点/出生地用目视区。';

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
    throw upstreamOcrError(resp.status);
  }

  const json = await readOcrResponse(resp);

  if (json.error?.message) {
    throw upstreamOcrError(resp.status);
  }

  const content = json.choices?.[0]?.message?.content ?? '';
  return parseOcrContent(content);
}

/** 调用 Qwen-VL 识别签证页。签证字段使用独立提示词，避免影响护照识别。 */
async function callQwenVisaOcr(
  imageDataUrl: string,
  cfg: { apiKey: string; baseUrl: string; model: string },
): Promise<Record<string, unknown>> {
  const systemPrompt =
    '你是签证页 OCR 引擎。严格输出 JSON，不要任何注释或 markdown 代码块。' +
    '字段只有 visaIssueDate、visaEffectiveDate、visaExpiry、visaNumber。' +
    '三个日期字段尽量抄录签证页原文，日期可为 DD/MM/YYYY、DD-MM-YYYY、YYYY-MM-DD、' +
    'YYYY/MM/DD 或 DD MON YYYY（MON 为 JAN 到 DEC 的英文缩写）。' +
    '看不清、找不到或无法确认的字段必须填 null，绝不猜测；不要返回空字符串。';

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
    throw upstreamOcrError(resp.status);
  }

  const json = await readOcrResponse(resp);

  if (json.error?.message) {
    throw upstreamOcrError(resp.status);
  }

  const content = json.choices?.[0]?.message?.content ?? '';
  return parseOcrContent(content);
}

interface VisaOcrSuggested {
  visaIssueDate: string | null;
  visaEffectiveDate: string | null;
  visaExpiry: string | null;
  visaNumber: string | null;
}

/** 空值标记不进入表单；其他文本保留给人工核对。 */
function trimVisaText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(?:null|n\/a|na|unknown|none)$/i.test(trimmed)) return null;
  if (/^(?:未识别|无法识别|看不清|不详|无)$/u.test(trimmed)) return null;
  return trimmed;
}

/** 将模型的宽松输出整理为前端可直接展示的签证建议。 */
function normalizeVisaOcrSuggested(raw: Record<string, unknown>): VisaOcrSuggested {
  const rawDate = (key: string): string | null => {
    const value = trimVisaText(raw[key]);
    return normalizeVisaDate(value);
  };

  return {
    visaIssueDate: rawDate('visaIssueDate'),
    visaEffectiveDate: rawDate('visaEffectiveDate'),
    visaExpiry: rawDate('visaExpiry'),
    visaNumber: trimVisaText(raw.visaNumber),
  };
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
        const failure = toOcrFailure(err);
        req.log.warn(
          { errorCode: failure.code, model: cfg.model },
          'OCR 上游服务失败',
        );
        return {
          configured: true,
          engine: 'qwen',
          model: cfg.model,
          errorCode: failure.code,
          error: failure.message,
          suggested: null,
        };
      }
    },
  );

  // PII 约束：不记录 imageDataUrl、API key；识别结果不写审计。
  app.post(
    '/visa',
    {
      preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)],
    },
    async (req) => {
      const body = ocrBodySchema.parse(req.body);

      const cfg = await resolveOcrConfig();
      if (!cfg) {
        return { configured: false };
      }

      try {
        const raw = await callQwenVisaOcr(body.imageDataUrl, cfg);
        return {
          configured: true,
          model: cfg.model,
          suggested: normalizeVisaOcrSuggested(raw),
        };
      } catch (err) {
        const failure = toOcrFailure(err);
        req.log.warn(
          { errorCode: failure.code, model: cfg.model },
          'OCR 上游服务失败',
        );
        return {
          configured: true,
          model: cfg.model,
          errorCode: failure.code,
          error: failure.message,
          suggested: null,
        };
      }
    },
  );
};
