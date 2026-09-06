/**
 * AI OCR 配置管理端点（仅 ADMIN）
 *
 * GET  /settings/ai-ocr
 *   响应：{ provider, baseUrl, model, enabled, apiKeySet: boolean, apiKeyMasked: string|null }
 *   永不返回 apiKey 原文。
 *
 * PUT  /settings/ai-ocr
 *   body：{ apiKey?, baseUrl?, model?, enabled? }
 *   apiKey 空值/缺省 = 保留旧 key；非空 = 更新。写入 DB + 审计（审计不含 key）。
 *
 * POST /settings/ai-ocr/test
 *   用当前配置向 Qwen 发一个最小请求，返回 { ok: boolean, message }。
 *   永不 500 — 错误以 200 + { ok: false, message } 返回。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AuditTargetType } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { writeAudit, actorFromRequest } from '../../lib/audit.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { isFeatureFlagKey, listFeatureFlags, setFeatureFlag } from '../../lib/feature-flags.js';

// ── 工具函数 ────────────────────────────────────────────────

/** 把 key 打码：前 4 + **** + 末 4，或 null。*/
function maskKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 从 DB + env 拿当前配置（不含完整 key）供 GET 响应用。*/
async function readPublicConfig() {
  const row = await prisma.aiOcrConfig.findFirst();
  const envKeySet = Boolean(env.DASHSCOPE_API_KEY);
  const dbKeySet = Boolean(row?.apiKey);
  const apiKeySet = dbKeySet || envKeySet;
  const apiKeyMasked = dbKeySet
    ? maskKey(row!.apiKey)
    : envKeySet
      ? maskKey(env.DASHSCOPE_API_KEY)
      : null;

  return {
    provider: row?.provider ?? 'QWEN',
    baseUrl:
      row?.baseUrl ??
      env.QWEN_BASE_URL ??
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: row?.model ?? env.QWEN_VL_MODEL ?? 'qwen3-vl-plus',
    enabled: row?.enabled ?? true,
    apiKeySet,
    apiKeyMasked,
  };
}

// ── Zod schemas ──────────────────────────────────────────────

const updateBodySchema = z.object({
  apiKey: z.string().optional(), // 空字符串视为"不更新"
  // 宽容处理：trim；空/空白 → 不更新；缺 scheme 自动补 https://（用户常只粘主机名）
  baseUrl: z.preprocess((v) => {
    if (typeof v !== 'string') return v ?? undefined;
    const s = v.trim();
    if (s === '') return undefined;
    return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  }, z.string().url().optional()),
  model: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v),
    z.string().optional(),
  ),
  enabled: z.boolean().optional(),
});

// ── 路由 ────────────────────────────────────────────────────

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // AI 识别设置：仅 ADMIN。与下面功能开关虽同属 ADMIN_ONLY 受众，但口径上是两件独立的事，
  // 各自一个能力 id，别为了少写一行合并成同一个 preHandler 数组。
  const aiOcrManage = [app.authenticate, app.requireCapability('settings.ai_ocr.manage')];
  // feature flag 列表允许 STAFF 只读查看（运营需要知道某个开关有没有开，改还是只有 ADMIN）
  const featureFlagsRead = [app.authenticate, app.requireCapability('feature_flags.read')];
  const featureFlagsWrite = [app.authenticate, app.requireCapability('feature_flags.write')];

  // ── GET /settings/ai-ocr ────────────────────────────────
  app.get('/ai-ocr', { preHandler: aiOcrManage }, async () => {
    return readPublicConfig();
  });

  // ── PUT /settings/ai-ocr ────────────────────────────────
  app.put('/ai-ocr', { preHandler: aiOcrManage }, async (req) => {
    const body = updateBodySchema.parse(req.body);

    const existing = await prisma.aiOcrConfig.findFirst();

    // 只在 body 中显式传了非空 apiKey 时才覆盖
    const newApiKey =
      body.apiKey && body.apiKey.trim() !== ''
        ? body.apiKey.trim()
        : (existing?.apiKey ?? null);

    // 国际版 key 配大陆端点防呆（2026-08 事故根因）：百炼国际版 key 是 sk-ws- 前缀，
    // 打大陆端点必 401 且难定位。保存时直接拦下并给出正确地址。
    const effectiveBaseUrl =
      body.baseUrl !== undefined ? body.baseUrl : (existing?.baseUrl ?? null);
    const INTL_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    if (
      newApiKey?.startsWith('sk-ws-') &&
      (!effectiveBaseUrl || !effectiveBaseUrl.includes('dashscope-intl.'))
    ) {
      throw new BadRequestError(
        `该 API Key 是阿里云百炼国际版密钥（sk-ws- 开头），必须搭配国际版接口地址，否则识别会一直失败。` +
          `请把接口地址填为：${INTL_BASE_URL}`,
      );
    }

    const data = {
      provider: 'QWEN',
      apiKey: newApiKey,
      baseUrl: effectiveBaseUrl,
      model:
        body.model !== undefined ? body.model : (existing?.model ?? null),
      enabled:
        body.enabled !== undefined ? body.enabled : (existing?.enabled ?? true),
      updatedById:
        (req as { user?: { sub?: string } }).user?.sub ?? null,
    };

    const updated = existing
      ? await prisma.aiOcrConfig.update({ where: { id: existing.id }, data })
      : await prisma.aiOcrConfig.create({ data });

    // 审计：不含 key 原文
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_AI_OCR_CONFIG',
      targetType: AuditTargetType.SYSTEM,
      targetId: updated.id,
      targetLabel: 'AiOcrConfig',
      after: {
        provider: updated.provider,
        baseUrl: updated.baseUrl,
        model: updated.model,
        enabled: updated.enabled,
        apiKeySet: Boolean(updated.apiKey),
      },
    });

    return readPublicConfig();
  });

  // ── POST /settings/ai-ocr/test ──────────────────────────
  app.post('/ai-ocr/test', { preHandler: aiOcrManage }, async () => {
    const row = await prisma.aiOcrConfig.findFirst();
    const apiKey =
      (row?.enabled !== false && row?.apiKey) ||
      env.DASHSCOPE_API_KEY ||
      '';
    if (!apiKey) {
      return {
        ok: false,
        message: '尚未配置 API 密钥，请先保存密钥后再测试',
      };
    }
    const baseUrl =
      (row?.enabled !== false && row?.baseUrl) ||
      env.QWEN_BASE_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const model =
      (row?.enabled !== false && row?.model) ||
      env.QWEN_VL_MODEL ||
      'qwen3-vl-plus';

    // 发一个最小 text-only 请求（无图片，验证 key + 端点可达）
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 5,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          return {
            ok: false,
            message: 'API 密钥无效或已过期，请重新填写',
          };
        }
        if (resp.status === 429) {
          return {
            ok: false,
            message: '请求频率超限，但密钥有效（稍后重试）',
          };
        }
        const text = await resp.text().catch(() => '');
        return {
          ok: false,
          message: `服务返回 ${resp.status}：${text.slice(0, 120)}`,
        };
      }

      return { ok: true, message: `连接成功（${model}）` };
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return {
          ok: false,
          message: '连接超时（15 秒），请检查网络或 Base URL',
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `连接失败：${msg.slice(0, 200)}` };
    }
  });

  // ── GET /settings/feature-flags（ADMIN/STAFF 可看）──────────────────────
  app.get('/feature-flags', { preHandler: featureFlagsRead }, async () => {
    return { flags: await listFeatureFlags(prisma) };
  });

  // ── PUT /settings/feature-flags/:key（仅 ADMIN）──────────────────────────
  app.put('/feature-flags/:key', { preHandler: featureFlagsWrite }, async (req) => {
    const { key } = req.params as { key: string };
    if (!isFeatureFlagKey(key)) throw new NotFoundError(`未知的功能开关：${key}`);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);

    await setFeatureFlag(prisma, key, body.enabled, req.user.sub);

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_FEATURE_FLAG',
      targetType: AuditTargetType.SYSTEM,
      targetId: key,
      targetLabel: key,
      after: { enabled: body.enabled },
    });

    return { flags: await listFeatureFlags(prisma) };
  });
};
