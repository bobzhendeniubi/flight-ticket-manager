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

const chatBodySchema = z.object({
  // 历史 messages 让前端管理（无服务端 session 状态）
  // 形状很灵活（user / assistant / tool / system 四种 role），运行时校验由 OpenAI SDK 兜底
  messages: z.array(z.unknown()).max(40, '对话太长了，请清空重开'),
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
