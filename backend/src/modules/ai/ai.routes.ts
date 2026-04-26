/**
 * AI 助手 API
 *
 * POST /ai/chat
 *   body: { messages: ChatMessage[], userMessage: string, passengers? }
 *   返回: { reply, proposals[], messages, debug, mocked }
 *
 * 不要求登录 —— 任何访客都能聊；下单时才需要登录（前端在「确认下单」时跳登录）
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { runChatTurn, type ChatMessage } from '../../lib/ai-assistant.js';

const chatBodySchema = z.object({
  // 历史 messages 让前端管理（无服务端 session 状态）
  // 形状很灵活（user / assistant / tool / system 四种 role），运行时校验由 OpenAI SDK 兜底
  messages: z.array(z.unknown()).max(40, '对话太长了，请清空重开'),
  userMessage: z.string().min(1).max(2000, '消息太长'),
});

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.post('/chat', async (req, reply) => {
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
