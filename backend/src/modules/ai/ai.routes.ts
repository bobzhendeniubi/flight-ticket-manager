/**
 * AI 助手 API
 *
 * POST /ai/chat
 *   body: { messages: ChatMessage[], userMessage: string, passengers? }
 *   返回: { reply, proposals[], messages, debug, mocked }
 *
 * 匿名可聊（访客下单前就能问）—— 但每个 AI 回合会真实调用 OpenAI（烧 token/花钱），
 * 所以本路由额外挂一道**更严的按 IP 限流**（严于全局 100/min），防匿名刷爆账单。
 * 下单时才需要登录（前端在「确认下单」时跳登录）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { runChatTurn, type ChatMessage } from '../../lib/ai-assistant.js';

// AI 回合按 IP 限流：每分钟最多 10 次真实模型调用/IP（每次可能多轮 tool-use，成本高）。
const AI_CHAT_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

// 历史消息长度上限：user/assistant 是人读的文本；tool 是服务端塞回去的工具结果 JSON
//（一次航班搜索能返回几十个班次），所以两档分开给，宽到不误伤正常往返即可。
const MAX_TEXT_CHARS = 16_000;
const MAX_TOOL_RESULT_CHARS = 60_000;

// 客户端能回传的三种角色。system 不在其中：本接口匿名可达，放行 role:'system'
// 等于把系统提示词的写权交给调用方（业务规则、话术边界会被整条顶掉）——
// 一律**丢弃**而不是报错：服务端自己注入的 system 也在前端回传的 messages 里，报错会卡死正常的第二轮。
const REPLAYABLE_ROLES = new Set(['user', 'assistant', 'tool']);

// 形状校验按 role 分别做；passthrough 保留 tool_calls / refusal 等 SDK 自带字段，不破坏往返。
const historyMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string().max(MAX_TEXT_CHARS, '历史消息过长') }).passthrough(),
  z
    .object({
      role: z.literal('assistant'),
      // 带 tool_calls 的 assistant 消息 content 为 null
      content: z.string().max(MAX_TEXT_CHARS, '历史消息过长').nullable().optional(),
    })
    .passthrough(),
  z
    .object({
      role: z.literal('tool'),
      content: z.string().max(MAX_TOOL_RESULT_CHARS, '历史消息过长'),
      tool_call_id: z.string().min(1).max(200),
    })
    .passthrough(),
]);

const chatBodySchema = z.object({
  // 历史 messages 让前端管理（无服务端 session 状态）；先按角色白名单裁剪，再逐条校形状
  messages: z
    .array(z.unknown())
    .max(40, '对话太长了，请清空重开')
    .transform((raw) =>
      raw.filter(
        (m) =>
          Boolean(m) &&
          typeof m === 'object' &&
          REPLAYABLE_ROLES.has((m as { role?: unknown }).role as string),
      ),
    )
    .pipe(z.array(historyMessageSchema)),
  userMessage: z.string().min(1).max(2000, '消息太长'),
});

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.post('/chat', { config: { rateLimit: AI_CHAT_RATE_LIMIT } }, async (req, reply) => {
    const body = chatBodySchema.parse(req.body);

    try {
      const result = await runChatTurn(
        body.messages as ChatMessage[],
        body.userMessage,
      );
      return result;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ai/chat] error:', err);
      return reply.status(500).send({
        error: {
          code: 'AI_ERROR',
          message: err instanceof Error ? err.message : 'AI 助手暂时不可用',
        },
      });
    }
  });
};
